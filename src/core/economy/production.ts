import { acknowledgeAutomaticCancellation, classifyAutomaticHandle, isAutomaticJobId, isAutomaticTransaction, liveProductionAt,
  recordAutomaticNotice, retireAutomaticProduction } from './automatic-production';
import type { AutomaticWorld as ProductionWorld } from './automatic-production';
import type { ProductionReceiptContext, ProductionWork } from './automatic-types';
import { archiveTerminalProduction, lookupProduction } from '../world/history-access';
import { emptyNavigation, isWalkable, sameCell } from '../agents/navigation';
import type { WorkPathBudget } from '../agents/work-navigation';
import { runProductionPhases, type ProductionContext, type ProductionSite } from './production-context';
import type { CommandRejection, DomainEvent } from '../kernel/contracts';
import { isPaused } from '../kernel/clock';
import { appendEvent } from '../kernel/events';
import { allocateId } from '../kernel/ids';
import { MAX_DISCIPLES, type GridPosition, type WorldBuilding, type WorldState } from '../world/types';
import { commitReservation, releaseReservation, reserveResources } from './inventory';
import { getRecipe } from './recipes';
import type { ProductionTransaction } from './types';

export type ProductionResult<W extends ProductionWorld = WorldState> = { ok: true; world: W; transactionId: string; eventIds: string[] } | { ok: false; rejection: CommandRejection };

export function startProduction<W extends ProductionWorld>(world: W, commandId: string, recipeId: string, workerId: string): ProductionResult<W> {
  const recipe = getRecipe(recipeId);
  if (!recipe) return { ok: false, rejection: { code: 'UNKNOWN_RECIPE' } };
  const worker = world.disciples.find((disciple) => disciple.id === workerId);
  if (!worker) return { ok: false, rejection: { code: 'UNKNOWN_WORKER' } };
  if (world.activeProductionTransactionIds.length >= MAX_DISCIPLES || world.clock.mode !== 'management' || !worker.canWork || worker.lifeState !== 'alive' || worker.traveling || worker.assignmentTransactionId !== null || !world.buildings.some((building) => building.blueprintId === recipe.workstation && building.operational)) {
    return { ok: false, rejection: { code: 'WORKER_UNAVAILABLE' } };
  }
  const action = allocateId(world.sequences, 'action');
  const transaction = allocateId(action.sequences, 'instance');
  const reservation = allocateId(transaction.sequences, 'instance');
  const reserved = reserveResources(world.inventory, recipe.inputs, reservation.id, transaction.id);
  if (!reserved.ok) return { ok: false, rejection: { code: reserved.rejection.code === 'INVALID_RESOURCE_LINE' ? 'INVALID_COMMAND' : reserved.rejection.code, ...(reserved.rejection.resourceId ? { resourceId: reserved.rejection.resourceId } : {}) } };
  const order: ProductionTransaction = {
    transactionId: transaction.id, rootActionId: action.id, commandId, recipeId, workerId,
    reservationId: reservation.id, state: 'Running', activeTicks: 0, requiredTicks: recipe.workTicks,
    startedTick: world.clock.simulationTick, completedTick: null, resultEventId: null, blockedReason: null,
    phase: 'WaitingForStation', worksiteId: null, storageId: null, navigation: emptyNavigation(),
  };
  const next: W = {
    ...world, sequences: reservation.sequences, inventory: reserved.inventory,
    reservations: { ...world.reservations, [reservation.id]: reserved.reservation },
    transactions: { ...world.transactions, [transaction.id]: order },
    activeProductionTransactionIds: [...world.activeProductionTransactionIds, transaction.id],
    disciples: world.disciples.map((disciple) => disciple.id === workerId ? { ...disciple, assignmentTransactionId: transaction.id } : disciple),
  };
  const emitted = appendEvent(next, { kind: 'production.started', rootActionId: action.id, parentEventId: null, payload: { transactionId: transaction.id, recipeId, workerId } });
  return { ok: true, world: emitted.world, transactionId: transaction.id, eventIds: [emitted.event.eventId] };
}

function updateOrder<W extends ProductionWorld>(world: W, transaction: ProductionWork, traveling = false, position?: GridPosition): W {
  const next = isAutomaticTransaction(transaction)
    ? { ...world, automaticProduction: { ...world.automaticProduction, live: { ...world.automaticProduction.live,
      [transaction.transactionId]: { transaction, reservation: world.automaticProduction.live[transaction.transactionId]!.reservation } } } }
    : { ...world, transactions: { ...world.transactions, [transaction.transactionId]: transaction } };
  return { ...next, disciples: world.disciples.map((disciple) => disciple.id === transaction.workerId ? { ...disciple, traveling, ...(position ? { position: { ...position } } : {}) } : disciple) };
}
function releaseStation<W extends ProductionWorld>(world: W, id: string): W {
  return { ...world, buildings: world.buildings.map((building) => building.stationTransactionId === id ? { ...building, stationTransactionId: null } : building) };
}
function endProduction<W extends ProductionWorld>(world: W, transaction: ProductionWork, state: 'Committed' | 'Cancelled', kind: DomainEvent['kind'], receiptContext?: ProductionReceiptContext): ProductionResult<W> {
  if (isAutomaticTransaction(transaction)) {
    const released = { ...releaseStation(world, transaction.transactionId),
      activeProductionTransactionIds: world.activeProductionTransactionIds.filter((id) => id !== transaction.transactionId),
      disciples: world.disciples.map((disciple) => disciple.assignmentTransactionId === transaction.transactionId ? { ...disciple, assignmentTransactionId: null, traveling: false } : disciple) };
    const retired = retireAutomaticProduction(released, transaction, state, receiptContext);
    return { ok: true, transactionId: transaction.transactionId, ...retired };
  }
  const emitted = appendEvent(world, { kind, rootActionId: transaction.rootActionId, parentEventId: null, payload: { transactionId: transaction.transactionId, recipeId: transaction.recipeId, workerId: transaction.workerId } });
  return {
    ok: true, transactionId: transaction.transactionId, eventIds: [emitted.event.eventId],
    world: archiveTerminalProduction({
      ...releaseStation(emitted.world, transaction.transactionId),
      activeProductionTransactionIds: world.activeProductionTransactionIds.filter((id) => id !== transaction.transactionId),
      transactions: { ...emitted.world.transactions, [transaction.transactionId]: { ...transaction, state, phase: state === 'Committed' ? 'Done' : 'Cancelled', navigation: emptyNavigation(), completedTick: world.clock.simulationTick, resultEventId: emitted.event.eventId, blockedReason: null } },
      // Cancellation stops in the last real cell; it never warps the worker home.
      disciples: world.disciples.map((disciple) => disciple.assignmentTransactionId === transaction.transactionId ? { ...disciple, assignmentTransactionId: null, traveling: false } : disciple),
    }, transaction.transactionId),
  };
}

export function cancelProduction<W extends ProductionWorld>(world: W, transactionId: string, receiptContext?: ProductionReceiptContext): ProductionResult<W> {
  if (isAutomaticJobId(transactionId)) {
    const handle = classifyAutomaticHandle(world, transactionId);
    if (handle.kind === 'retired') return { ok: false, rejection: { code: 'AUTO_JOB_RETIRED' } };
    if (handle.kind === 'pinned') {
      if (handle.pin.state === 'Committed') return { ok: false, rejection: { code: 'TRANSACTION_FINISHED' } };
      const acknowledged = receiptContext ? acknowledgeAutomaticCancellation(world, transactionId)! : { world, eventIds: handle.pin.resultEventId ? [handle.pin.resultEventId] : [] };
      return { ok: true, transactionId, ...acknowledged };
    }
  }
  const transaction = liveProductionAt(world, transactionId)?.transaction ?? lookupProduction(world, transactionId);
  if (!transaction) return { ok: false, rejection: { code: 'UNKNOWN_TRANSACTION' } };
  if (transaction.state === 'Cancelled') return { ok: true, world, transactionId, eventIds: transaction.resultEventId ? [transaction.resultEventId] : [] };
  if (transaction.state === 'Committed') return { ok: false, rejection: { code: 'TRANSACTION_FINISHED' } };
  const reservation = isAutomaticTransaction(transaction) ? world.automaticProduction.live[transaction.transactionId]?.reservation : world.reservations[transaction.reservationId];
  if (!reservation || reservation.ownerTransactionId !== transactionId) return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  const released = releaseReservation(world.inventory, reservation);
  if (!released.ok) return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  const settled = isAutomaticTransaction(transaction)
    ? { ...world, inventory: released.inventory, automaticProduction: { ...world.automaticProduction, live: { ...world.automaticProduction.live,
      [transaction.transactionId]: { transaction, reservation: released.reservation } } } }
    : { ...world, inventory: released.inventory, reservations: { ...world.reservations, [reservation.reservationId]: released.reservation } };
  return endProduction(settled, transaction, 'Cancelled', 'production.cancelled', receiptContext);
}

/** Only storage arrival may commit. Calling this function cannot skip work or travel. */
export function completeProduction<W extends ProductionWorld>(world: W, transactionId: string): ProductionResult<W> {
  const transaction = liveProductionAt(world, transactionId)?.transaction ?? lookupProduction(world, transactionId);
  if (!transaction) return { ok: false, rejection: { code: 'UNKNOWN_TRANSACTION' } };
  if (transaction.state === 'Committed') return { ok: true, world, transactionId, eventIds: transaction.resultEventId ? [transaction.resultEventId] : [] };
  if (transaction.state === 'Cancelled') return { ok: false, rejection: { code: 'TRANSACTION_FINISHED' } };
  const worker = world.disciples.find((disciple) => disciple.id === transaction.workerId);
  const storage = world.buildings.find((building) => building.id === transaction.storageId && building.blueprintId === 'storage' && building.operational);
  if (isPaused(world.clock) || world.clock.mode !== 'management' || transaction.activeTicks !== transaction.requiredTicks || transaction.phase !== 'AwaitingDelivery' || !worker || worker.assignmentTransactionId !== transactionId || worker.lifeState !== 'alive' || !worker.canWork || worker.traveling || !storage || !sameCell(worker.position, storage) || !isWalkable(world.map, worker.position)) return { ok: false, rejection: { code: 'WORKER_UNAVAILABLE' } };
  const reservation = isAutomaticTransaction(transaction) ? world.automaticProduction.live[transaction.transactionId]?.reservation : world.reservations[transaction.reservationId];
  const recipe = getRecipe(transaction.recipeId);
  if (!reservation || reservation.ownerTransactionId !== transactionId || !recipe) return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  const committed = commitReservation(world.inventory, reservation, recipe.outputs);
  if (!committed.ok) return { ok: false, rejection: { code: committed.rejection.code === 'INVALID_RESOURCE_LINE' ? 'INVALID_COMMAND' : committed.rejection.code, ...(committed.rejection.resourceId ? { resourceId: committed.rejection.resourceId } : {}) } };
  const settled = isAutomaticTransaction(transaction)
    ? { ...world, inventory: committed.inventory, automaticProduction: { ...world.automaticProduction, live: { ...world.automaticProduction.live,
      [transaction.transactionId]: { transaction, reservation: committed.reservation } } } }
    : { ...world, inventory: committed.inventory, reservations: { ...world.reservations, [reservation.reservationId]: committed.reservation } };
  return endProduction(settled, transaction, 'Committed', 'production.committed');
}

/** Fixed legacy binding. v7/v8 keep their original catalog, point positions and
 * authoritative settlement; none of these callbacks are save or command data. */
function legacyProductionContext<W extends ProductionWorld>(): ProductionContext<W, ProductionWork> {
  const site = (building: WorldBuilding): ProductionSite => ({ id: building.id,
    position: { x: building.x, y: building.y }, ownerTransactionId: building.stationTransactionId });
  return {
    view: world => ({ simulationTick: world.clock.simulationTick, management: world.clock.mode === 'management',
      paused: isPaused(world.clock), map: world.map, activeTransactionIds: world.activeProductionTransactionIds }),
    job: (world, id) => liveProductionAt(world, id)!.transaction,
    recipe: (_world, recipeId) => getRecipe(recipeId),
    worker: (world, workerId) => world.disciples.find(disciple => disciple.id === workerId),
    workSites: (world, recipe) => world.buildings.filter(building => building.blueprintId === recipe.workstation && building.operational).map(site),
    storageSites: world => world.buildings.filter(building => building.blueprintId === 'storage' && building.operational).map(site),
    writeProgress: updateOrder,
    claimSite: (world, siteId, transactionId) => ({ ...world, buildings: world.buildings.map(building => building.id === siteId ? { ...building, stationTransactionId: transactionId } : building) }),
    releaseSites: releaseStation,
    blockedNotice: (world, transaction, reason) => isAutomaticTransaction(transaction)
      ? recordAutomaticNotice(world, { cycle: transaction.origin.cycle, workerId: transaction.workerId, recipeId: transaction.recipeId, kind: 'blocked', reason })
      : appendEvent(world, { kind: 'production.blocked', rootActionId: transaction.rootActionId, parentEventId: null, payload: { transactionId: transaction.transactionId, reason } }).world,
    cancel: cancelProduction,
    complete: completeProduction,
  };
}

/** Serialized phases own reservations and seats. Ordinary transit cells can be shared; work seats cannot.
 * A versioned tick orchestrator may share one budget across modules; legacy callers retain four requests per tick. */
export function tickProduction<W extends ProductionWorld>(world: W, sharedPathBudget?: WorkPathBudget): W {
  return runProductionPhases(world, legacyProductionContext<W>(), sharedPathBudget);
}
