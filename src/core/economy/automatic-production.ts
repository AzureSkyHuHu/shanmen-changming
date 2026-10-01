import { emptyNavigation } from '../agents/navigation';
import { isPaused } from '../kernel/clock';
import { planAutomaticWork } from '../sect-economy/planner';
import type { AutomaticProductionIntent, AutomaticWorkContext } from '../sect-economy/types';
import { isCultivationWorkerAvailable } from '../world/cultivation-bridge';
import { MAX_DISCIPLES } from '../world/types';
import { reserveResources } from './inventory';
import { getRecipe } from './recipes';
import { appendEvent } from '../kernel/events';
import { allocateId } from '../kernel/ids';
import { checkedAdd } from '../kernel/numeric';
import { cloneJson } from '../kernel/serialization';
import { AUTO_WORK_DECISION_TICKS } from '../sect-economy/types';
import { lookupCommandReceipt } from '../world/history-access';
import type { WorldState } from '../world/types';
import type { AutomaticJobId, AutomaticLiveJob, AutomaticProductionNotice, AutomaticProductionState, AutomaticTerminalPin,
  AutomaticTransaction, ProductionOrigin, ProductionReceiptContext, ProductionWork } from './automatic-types';
import type { Reservation } from './types';

/** Temporary intersection also keeps this unreferenced module testable before the v7 World switch. */
export type AutomaticWorld = WorldState & { automaticProduction: AutomaticProductionState };
export const AUTOMATIC_JOURNAL_LIMIT = 64;
export function createAutomaticProductionState(activationReviewRequired = false): AutomaticProductionState {
  return { schemaVersion: 1, nextCycle: 1, activationReviewRequired, live: {}, journal: [], pins: {} };
}
export function automaticCycle(value: unknown): number | null {
  if (typeof value !== 'string' || !/^auto-job\/[1-9][0-9]*$/.test(value)) return null;
  const cycle = Number(value.slice(9));
  return Number.isSafeInteger(cycle) && cycle > 0 ? cycle : null;
}
export function isAutomaticJobId(value: unknown): value is AutomaticJobId { return automaticCycle(value) !== null; }
export function isAutomaticTransaction(transaction: ProductionWork): transaction is AutomaticTransaction {
  return isAutomaticJobId(transaction.transactionId) && 'origin' in transaction;
}
export type AutomaticHandle = { kind: 'live'; job: AutomaticLiveJob } | { kind: 'pinned'; pin: AutomaticTerminalPin }
  | { kind: 'retired'; cycle: number } | { kind: 'unknown' };
export function classifyAutomaticHandle(world: AutomaticWorld, id: string): AutomaticHandle {
  const cycle = automaticCycle(id);
  if (cycle === null) return { kind: 'unknown' };
  const key = id as AutomaticJobId;
  if (Object.hasOwn(world.automaticProduction.live, key)) return { kind: 'live', job: cloneJson(world.automaticProduction.live[key]!) };
  if (Object.hasOwn(world.automaticProduction.pins, key)) return { kind: 'pinned', pin: cloneJson(world.automaticProduction.pins[key]!) };
  return cycle < world.automaticProduction.nextCycle ? { kind: 'retired', cycle } : { kind: 'unknown' };
}
export interface LiveProductionRecord { transaction: ProductionWork; reservation: Reservation; origin: ProductionOrigin }
/** Internal borrowed read; reducers never mutate returned records. No historical map is expanded. */
export function liveProductionAt(world: AutomaticWorld, id: string): LiveProductionRecord | undefined {
  if (isAutomaticJobId(id)) {
    const job = Object.hasOwn(world.automaticProduction.live, id) ? world.automaticProduction.live[id] : undefined;
    return job ? { ...job, origin: job.transaction.origin } : undefined;
  }
  const transaction = Object.hasOwn(world.transactions, id) ? world.transactions[id] : undefined;
  const reservation = transaction && world.reservations[transaction.reservationId];
  return transaction && reservation ? { transaction, reservation, origin: { kind: 'command', commandId: transaction.commandId } } : undefined;
}
export function lookupLiveProduction(world: AutomaticWorld, id: string): LiveProductionRecord | undefined {
  const record = liveProductionAt(world, id); return record ? cloneJson(record) : undefined;
}
export function recordAutomaticNotice(world: AutomaticWorld, notice: Omit<AutomaticProductionNotice, 'eventId' | 'tick'>): AutomaticWorld {
  const allocated = allocateId(world.sequences, 'event');
  return { ...world, sequences: allocated.sequences, automaticProduction: { ...world.automaticProduction,
    journal: [...world.automaticProduction.journal, { ...notice, eventId: allocated.id, tick: world.clock.simulationTick }].slice(-AUTOMATIC_JOURNAL_LIMIT) } };
}
export function pendingAutomaticTargets(world: AutomaticWorld): Set<AutomaticJobId> {
  const targets = new Set<AutomaticJobId>();
  for (const command of world.pendingCommands) {
    if (command.kind === 'production.cancel' && isAutomaticJobId(command.payload.transactionId)
      && !lookupCommandReceipt(world, command.commandId)) targets.add(command.payload.transactionId);
  }
  return targets;
}
/** Call only after a due batch/queue change, never scan perpetual pins on every working tick. */
export function cleanupAutomaticPendingPins(world: AutomaticWorld): AutomaticWorld {
  const targets = pendingAutomaticTargets(world);
  let pins = world.automaticProduction.pins;
  for (const [id, pin] of Object.entries(pins)) if (pin.retention === 'pending-command' && !targets.has(id as AutomaticJobId)) {
    if (pins === world.automaticProduction.pins) pins = { ...pins };
    delete pins[id as AutomaticJobId];
  }
  return pins === world.automaticProduction.pins ? world : { ...world, automaticProduction: { ...world.automaticProduction, pins } };
}
function cancellationEvent(world: AutomaticWorld, id: AutomaticJobId, pin: AutomaticTerminalPin): { world: AutomaticWorld; eventId: string } {
  const emitted = appendEvent(world, { kind: 'production.cancelled', rootActionId: pin.rootActionId, parentEventId: null,
    payload: { transactionId: id, recipeId: pin.recipeId, workerId: pin.workerId, settledTick: pin.completedTick } });
  return { world: emitted.world as AutomaticWorld, eventId: emitted.event.eventId };
}
/** Metadata retirement only. Production already settled inventory and released live worker/seat ownership. */
export function retireAutomaticProduction(world: AutomaticWorld, transaction: AutomaticTransaction, state: 'Committed' | 'Cancelled',
  receiptContext?: ProductionReceiptContext): { world: AutomaticWorld; eventIds: string[] } {
  const id = transaction.transactionId;
  const pair = world.automaticProduction.live[id];
  if (!pair || pair.transaction.origin.cycle !== transaction.origin.cycle
    || pair.reservation.state !== (state === 'Committed' ? 'committed' : 'released')) throw new TypeError('Automatic retirement lacks settled live ownership');
  if (receiptContext && state !== 'Cancelled') throw new TypeError('Only cancellation has a public automatic terminal result');
  const pin: AutomaticTerminalPin = { cycle: transaction.origin.cycle, state, workerId: transaction.workerId, recipeId: transaction.recipeId,
    rootActionId: transaction.rootActionId, completedTick: world.clock.simulationTick, resultEventId: null,
    retention: receiptContext ? 'exact-receipt' : 'pending-command' };
  const live = { ...world.automaticProduction.live }; delete live[id];
  let next: AutomaticWorld = { ...world, automaticProduction: { ...world.automaticProduction, live } };
  let eventIds: string[] = [];
  if (receiptContext) {
    const emitted = cancellationEvent(next, id, pin); next = emitted.world;
    pin.resultEventId = emitted.eventId; eventIds = [emitted.eventId];
    next = { ...next, sectEconomy: { ...next.sectEconomy, nextDecisionTick: Math.max(next.sectEconomy.nextDecisionTick,
      checkedAdd(next.clock.simulationTick, AUTO_WORK_DECISION_TICKS)) } };
  } else next = recordAutomaticNotice(next, { cycle: pin.cycle, workerId: pin.workerId, recipeId: pin.recipeId, kind: state === 'Committed' ? 'committed' : 'cancelled', reason: null });
  if (receiptContext || pendingAutomaticTargets(next).has(id)) next = { ...next, automaticProduction: { ...next.automaticProduction,
    pins: { ...next.automaticProduction.pins, [id]: pin } } };
  return { world: next, eventIds };
}
/** A prior temporary cancelled fact can acquire its first durable acknowledgment; no resources are touched. */
export function acknowledgeAutomaticCancellation(world: AutomaticWorld, id: AutomaticJobId): { world: AutomaticWorld; eventIds: string[] } | null {
  const pin = world.automaticProduction.pins[id];
  if (!pin || pin.state !== 'Cancelled') return null;
  if (pin.retention === 'exact-receipt') return { world, eventIds: [pin.resultEventId!] };
  const emitted = cancellationEvent(world, id, pin);
  return { world: { ...emitted.world, automaticProduction: { ...emitted.world.automaticProduction,
    pins: { ...emitted.world.automaticProduction.pins, [id]: { ...pin, retention: 'exact-receipt', resultEventId: emitted.eventId } } } }, eventIds: [emitted.eventId] };
}

/** Bounded read projection: live jobs only, shared manual and automatic output promises. */
export function automaticWorkContext(world: AutomaticWorld, autoStartAllowance: number): AutomaticWorkContext {
  return { simulationTick: world.clock.simulationTick, mode: world.clock.mode, paused: isPaused(world.clock), inventory: world.inventory,
    workers: world.disciples.map((disciple) => ({ workerId: disciple.id, available: disciple.canWork && disciple.lifeState === 'alive'
      && !disciple.traveling && disciple.assignmentTransactionId === null && isCultivationWorkerAvailable(world, disciple.id) })),
    activeJobs: world.activeProductionTransactionIds.map((id) => {
      const record = liveProductionAt(world, id);
      if (!record) throw new TypeError('Missing live production obligation');
      return { workerId: record.transaction.workerId, recipeId: record.transaction.recipeId, state: record.transaction.state };
    }),
    operationalWorkstations: world.buildings.filter((building) => building.operational)
      .flatMap((building) => ['forest', 'herb-garden', 'kitchen', 'workshop'].includes(building.blueprintId)
        ? [building.blueprintId as AutomaticWorkContext['operationalWorkstations'][number]] : []),
    storageAvailable: world.buildings.some((building) => building.blueprintId === 'storage' && building.operational), autoStartAllowance };
}
export type AutomaticAdmission = { ok: true; world: AutomaticWorld; transactionId: AutomaticJobId }
  | { ok: false; reason: 'PLAN_CHANGED' | 'LIVE_LIMIT' | 'RESOURCE_CHANGED' };
/** Internal authority only. This is deliberately absent from Command and kernel exports. */
export function startAutomaticProduction(world: AutomaticWorld, intent: AutomaticProductionIntent): AutomaticAdmission {
  if (world.activeProductionTransactionIds.length >= MAX_DISCIPLES) return { ok: false, reason: 'LIVE_LIMIT' };
  if (world.automaticProduction.activationReviewRequired) return { ok: false, reason: 'PLAN_CHANGED' };
  // Re-evaluate the authored worker's complete priority list against current stock,
  // availability and promises, including any earlier admission in this decision.
  const selection = planAutomaticWork({ ...world.sectEconomy, nextDecisionTick: world.clock.simulationTick,
    plans: world.sectEconomy.plans.filter((plan) => plan.workerId === intent.workerId) }, automaticWorkContext(world, 1));
  if (!selection.intents.some((proposed) => proposed.workerId === intent.workerId && proposed.recipeId === intent.recipeId)) return { ok: false, reason: 'PLAN_CHANGED' };
  const cycle = world.automaticProduction.nextCycle;
  const nextCycle = checkedAdd(cycle, 1);
  const transactionId: AutomaticJobId = `auto-job/${cycle}`;
  const recipe = getRecipe(intent.recipeId)!;
  const action = allocateId(world.sequences, 'action');
  const reservation = allocateId(action.sequences, 'instance');
  const reserved = reserveResources(world.inventory, recipe.inputs, reservation.id, transactionId);
  if (!reserved.ok) return { ok: false, reason: 'RESOURCE_CHANGED' };
  const transaction: AutomaticTransaction = { transactionId, origin: { kind: 'sect-plan', cycle }, rootActionId: action.id,
    recipeId: intent.recipeId, workerId: intent.workerId, reservationId: reservation.id,
    state: 'Running', activeTicks: 0, requiredTicks: recipe.workTicks, startedTick: world.clock.simulationTick,
    completedTick: null, resultEventId: null, blockedReason: null, phase: 'WaitingForStation', worksiteId: null, storageId: null,
    navigation: emptyNavigation() };
  const next: AutomaticWorld = { ...world, sequences: reservation.sequences, inventory: reserved.inventory,
    automaticProduction: { ...world.automaticProduction, nextCycle, live: { ...world.automaticProduction.live,
      [transactionId]: { transaction, reservation: reserved.reservation } } },
    activeProductionTransactionIds: [...world.activeProductionTransactionIds, transactionId],
    disciples: world.disciples.map((disciple) => disciple.id === intent.workerId ? { ...disciple, assignmentTransactionId: transactionId } : disciple) };
  return { ok: true, transactionId, world: recordAutomaticNotice(next, { cycle, workerId: intent.workerId,
    recipeId: intent.recipeId, kind: 'started', reason: null }) };
}
