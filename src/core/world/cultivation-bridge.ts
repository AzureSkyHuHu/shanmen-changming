import { liveProductionAt } from '../economy/automatic-production';
import type { ProductionReceiptContext } from '../economy/automatic-types';
import { appendWorldEvents, worldEventCursor, worldEventsSince } from './history-access';
import { applyCultivationCommand, previewBreakthrough, stepCultivationMonths, synchronizeCultivationAges } from '../cultivation/cultivation';
import type { BreakthroughPreparation, BreakthroughPreview, CultivationCommand, CultivationCommandResult, CultivationError, CultivationFrame } from '../cultivation/types';
import { cancelProduction } from '../economy/production';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../kernel/clock';
import { assertNonNegativeInteger, checkedAdd } from '../kernel/numeric';
import type { CultivationWorld, WorldState } from './types';

export const cultivationFrame = (world: WorldState): CultivationFrame => ({ cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences });
export const hasCultivationDecision = (world: CultivationWorld): boolean => world.cultivation.pendingDeaths.length > 0 || world.cultivation.attempts.some((a) => a.phase === 'DecisionReady');
export function withCultivationPause<T extends CultivationWorld>(world: T): T {
  const pending = hasCultivationDecision(world);
  return world.clock.pauseReasons.includes('cultivation') === pending ? world : { ...world, clock: setPauseReason(world.clock, 'cultivation', pending) };
}
export function isCultivationWorkerAvailable(world: CultivationWorld, discipleId: string): boolean {
  const profile = world.cultivation.disciples.find((d) => d.discipleId === discipleId);
  return !!profile && profile.activityOwner === null && profile.lifeState === 'alive' && profile.trainingMode === 'duty' && profile.activeAttemptId === null && profile.teaching === null
    && !world.cultivation.disciples.some((teacher) => teacher.teaching?.studentId === discipleId);
}
/** One-way compatibility projection; jobs release through their existing transactional API. */
export function reconcileCultivationWorld<T extends CultivationWorld>(world: T, receiptContext?: ProductionReceiptContext): T {
  let next: T = { ...world, disciples: world.disciples.map((d) => {
    const profile = world.cultivation.disciples.find((p) => p.discipleId === d.id);
    if (!profile) throw new Error('World disciple has no cultivation authority');
    return { ...d, ageMonths: profile.ageMonths, lifeState: profile.lifeState,
      canWork: profile.lifeState !== 'alive' ? false : profile.ageMonths !== d.ageMonths ? profile.ageMonths >= 16 * 12 : d.canWork };
  }) };
  for (const transactionId of [...next.activeProductionTransactionIds]) {
    const transaction = liveProductionAt(next as unknown as WorldState, transactionId)?.transaction;
    if (!transaction) throw new Error('Missing live production transaction');
    if (isCultivationWorkerAvailable(next, transaction.workerId)) continue;
    const cancelled = cancelProduction(next as unknown as WorldState, transactionId, receiptContext);
    if (!cancelled.ok) throw new Error('Cultivation could not release conflicting production ownership');
    next = cancelled.world as unknown as T;
  }
  return withCultivationPause(next);
}
function publishFrame(world: WorldState, frame: CultivationFrame, receiptContext?: ProductionReceiptContext): WorldState {
  const newEvents = frame.cultivation.events.slice(world.cultivation.events.length).map((event) => ({
    eventId: event.eventId, kind: event.kind, tick: world.clock.simulationTick, rootActionId: event.rootActionId, parentEventId: null,
    payload: { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month },
  }));
  return reconcileCultivationWorld(appendWorldEvents({ ...world, cultivation: frame.cultivation, inventory: frame.inventory, randomStreams: frame.randomStreams,
    sequences: frame.sequences }, newEvents), receiptContext);
}
export function previewWorldBreakthrough(world: WorldState, discipleId: string, preparation?: BreakthroughPreparation): BreakthroughPreview {
  return previewBreakthrough(cultivationFrame(world), discipleId, preparation);
}
export type WorldCultivationResult = { ok: true; world: WorldState; result: CultivationCommandResult; eventIds: string[] }
  | { ok: false; code: CultivationError };
export function dispatchWorldCultivation(world: WorldState, command: CultivationCommand, receiptContext?: ProductionReceiptContext): WorldCultivationResult {
  if (world.clock.mode !== 'management' && !(command.kind === 'death.finalize' && command.cause === 'combat')) return { ok: false, code: 'DISCIPLE_UNAVAILABLE' };
  const transition = applyCultivationCommand(cultivationFrame(world), command);
  if (!transition.ok) return { ok: false, code: transition.code };
  const next = publishFrame(world, transition.frame, receiptContext);
  return { ok: true, world: next, result: transition.result, eventIds: worldEventsSince(next, worldEventCursor(world)).map((event) => event.eventId) };
}

/** Called after each management tick's clock update, before any job can deliver outputs. */
export function advanceWorldCultivation(world: WorldState): WorldState {
  if (world.clock.mode !== 'management') return world;
  if (world.cultivation.disciples.length !== world.disciples.length) throw new Error('World/cultivation disciple identity mismatch');
  const ages: Record<string, number> = {};
  let changedAge = false;
  for (const d of world.disciples) {
    const profile = world.cultivation.disciples.find((p) => p.discipleId === d.id);
    if (!profile || profile.ageMonths !== d.ageMonths || profile.lifeState !== d.lifeState) throw new Error('World age/life projection is not authoritative');
    const lifetimeTicks = checkedAdd(world.clock.calendarTick, -d.birthCalendarTick);
    assertNonNegativeInteger(lifetimeTicks, 'disciple lifetime ticks');
    if (profile.lifeState !== 'alive') continue;
    ages[d.id] = Math.floor(lifetimeTicks / CALENDAR_TICKS_PER_MONTH);
    if (ages[d.id] !== profile.ageMonths) changedAge = true;
  }
  const calendarMonth = Math.floor(world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH);
  if (calendarMonth !== world.cultivation.calendarMonth) {
    if (calendarMonth !== world.cultivation.calendarMonth + 1) throw new Error('Cultivation calendar skipped a complete month');
    const step = stepCultivationMonths(cultivationFrame(world), 1, { ages });
    if (step.processedMonths !== 1) throw new Error(`Cultivation month failed: ${step.stopped}`);
    return publishFrame(world, step.frame);
  }
  if (!changedAge) return world;
  const synced = synchronizeCultivationAges(cultivationFrame(world), ages);
  if (!synced.ok) throw new Error(`Cultivation birthday failed: ${synced.code}`);
  return publishFrame(world, synced.frame);
}
