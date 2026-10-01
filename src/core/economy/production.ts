import { acknowledgeAutomaticCancellation, classifyAutomaticHandle, isAutomaticJobId, isAutomaticTransaction, liveProductionAt,
  recordAutomaticNotice, retireAutomaticProduction } from './automatic-production';
import type { AutomaticWorld as ProductionWorld } from './automatic-production';
import type { ProductionReceiptContext, ProductionWork } from './automatic-types';
import { archiveTerminalProduction, lookupProduction } from '../world/history-access';
import { BLOCKED_PATH_RETRY_TICKS, cardinalDistance, emptyNavigation, findCardinalPath, isWalkable, MAX_PATH_REQUESTS_PER_TICK, MOVEMENT_TICKS_PER_CELL, sameCell } from '../agents/navigation';
import type { CommandRejection, DomainEvent } from '../kernel/contracts';
import { isPaused } from '../kernel/clock';
import { appendEvent } from '../kernel/events';
import { allocateId } from '../kernel/ids';
import { checkedAdd } from '../kernel/numeric';
import { compareStable } from '../kernel/serialization';
import { MAX_DISCIPLES, type GridPosition, type WorldBuilding, type WorldState } from '../world/types';
import { commitReservation, releaseReservation, reserveResources } from './inventory';
import { getRecipe } from './recipes';
import type { ProductionBlockedReason, ProductionTransaction } from './types';

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
function block<W extends ProductionWorld>(world: W, transaction: ProductionWork, reason: ProductionBlockedReason): W {
  const next = transaction.blockedReason !== reason
    ? isAutomaticTransaction(transaction)
      ? recordAutomaticNotice(world, { cycle: transaction.origin.cycle, workerId: transaction.workerId, recipeId: transaction.recipeId, kind: 'blocked', reason })
      : appendEvent(world, { kind: 'production.blocked', rootActionId: transaction.rootActionId, parentEventId: null, payload: { transactionId: transaction.transactionId, reason } }).world
    : world;
  return updateOrder(next, { ...transaction, state: 'Blocked', blockedReason: reason });
}
function running(transaction: ProductionWork): ProductionWork { return { ...transaction, state: 'Running', blockedReason: null }; }

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

interface PathBudget { remaining: number }
/** Returns at a full movement boundary; arrival never awards work in the same tick. */
function travel<W extends ProductionWorld>(world: W, transaction: ProductionWork, target: GridPosition, budget: PathBudget): W {
  const worker = world.disciples.find((disciple) => disciple.id === transaction.workerId)!;
  let navigation = transaction.navigation;
  const targetChanged = navigation.target === null || !sameCell(navigation.target, target);
  const versionChanged = navigation.routeVersion !== world.map.navVersion;
  const first = navigation.path[0];
  const invalidStep = first !== undefined && (!isWalkable(world.map, first) || cardinalDistance(worker.position, first) !== 1);
  if (targetChanged || versionChanged || invalidStep) navigation = { ...emptyNavigation(), target: { x: target.x, y: target.y } };
  if (!isWalkable(world.map, worker.position) || !isWalkable(world.map, target)) {
    return block(world, { ...transaction, navigation: { ...navigation, path: [], routeVersion: world.map.navVersion, movementTicks: 0, retryAtTick: checkedAdd(world.clock.simulationTick, BLOCKED_PATH_RETRY_TICKS) } }, 'PATH_BLOCKED');
  }
  if (sameCell(worker.position, target)) {
    return updateOrder(world, { ...running(transaction), phase: transaction.phase === 'TravellingToWork' ? 'Working' : 'AwaitingDelivery', navigation: emptyNavigation() });
  }
  if (navigation.path.length === 0) {
    if (world.clock.simulationTick < navigation.retryAtTick) return block(world, { ...transaction, navigation }, 'PATH_BLOCKED');
    if (budget.remaining === 0) return updateOrder(world, { ...(transaction.blockedReason === 'PATH_BLOCKED' ? transaction : running(transaction)), navigation });
    budget.remaining -= 1;
    const path = findCardinalPath(world.map, worker.position, target);
    navigation = { ...navigation, target: { x: target.x, y: target.y }, routeVersion: world.map.navVersion, path: path ?? [], movementTicks: 0, retryAtTick: path ? 0 : checkedAdd(world.clock.simulationTick, BLOCKED_PATH_RETRY_TICKS) };
    if (!path) return block(world, { ...transaction, navigation }, 'PATH_BLOCKED');
  }
  const movementTicks = navigation.movementTicks + 1;
  if (movementTicks < MOVEMENT_TICKS_PER_CELL) return updateOrder(world, { ...running(transaction), navigation: { ...navigation, movementTicks } }, true);
  const position = navigation.path[0]!;
  const path = navigation.path.slice(1);
  const arrived = sameCell(position, target);
  return updateOrder(world, { ...running(transaction), phase: arrived ? transaction.phase === 'TravellingToWork' ? 'Working' : 'AwaitingDelivery' : transaction.phase, navigation: arrived ? emptyNavigation() : { ...navigation, path, movementTicks: 0 } }, !arrived, position);
}
function candidates(world: ProductionWorld, blueprintId: string, position: GridPosition): WorldBuilding[] {
  return world.buildings.filter((building) => building.blueprintId === blueprintId && building.operational).sort((left, right) => cardinalDistance(position, left) - cardinalDistance(position, right) || compareStable(left.id, right.id));
}

/** Serialized phases own reservations and seats. Ordinary transit cells can be shared; work seats cannot. */
export function tickProduction<W extends ProductionWorld>(world: W): W {
  if (world.clock.mode !== 'management' || isPaused(world.clock)) return world;
  let next = world;
  const budget = { remaining: MAX_PATH_REQUESTS_PER_TICK };
  const ids = [...world.activeProductionTransactionIds].sort((left, right) => liveProductionAt(world, left)!.transaction.startedTick - liveProductionAt(world, right)!.transaction.startedTick || compareStable(left, right));
  for (const id of ids) {
    let transaction = liveProductionAt(next, id)!.transaction;
    if (transaction.state !== 'Running' && transaction.state !== 'Blocked') continue;
    const worker = next.disciples.find((disciple) => disciple.id === transaction.workerId);
    const recipe = getRecipe(transaction.recipeId);
    if (!recipe) throw new Error('Production references a missing recipe');
    if (!worker || worker.lifeState === 'dead') {
      const cancelled = cancelProduction(next, id);
      if (!cancelled.ok) throw new Error('Cannot release unavailable worker reservation');
      next = cancelled.world;
      continue;
    }
    if (worker.assignmentTransactionId !== id) throw new Error('Production worker assignment mismatch');
    if (!worker.canWork) {
      next = releaseStation(next, id);
      transaction = { ...transaction, phase: transaction.activeTicks === transaction.requiredTicks ? 'TravellingToStorage' : 'WaitingForStation', worksiteId: null, navigation: emptyNavigation() };
      next = block(next, transaction, 'WORKER_UNAVAILABLE');
      continue;
    }
    if (transaction.activeTicks === transaction.requiredTicks && transaction.phase !== 'TravellingToStorage' && transaction.phase !== 'AwaitingDelivery') {
      next = releaseStation(next, id);
      transaction = { ...running(transaction), phase: 'TravellingToStorage', navigation: emptyNavigation() };
    }
    if (transaction.phase === 'WaitingForStation') {
      const sites = candidates(next, recipe.workstation, worker.position);
      const station = sites.find((building) => building.stationTransactionId === null || building.stationTransactionId === id);
      if (!station) { next = block(next, transaction, sites.length ? 'WAITING_FOR_STATION' : 'WORKSTATION_UNAVAILABLE'); continue; }
      next = { ...next, buildings: next.buildings.map((building) => building.id === station.id ? { ...building, stationTransactionId: id } : building) };
      transaction = { ...running(transaction), phase: 'TravellingToWork', worksiteId: station.id, navigation: emptyNavigation() };
    }
    if (transaction.phase === 'TravellingToWork' || transaction.phase === 'Working') {
      const station = next.buildings.find((building) => building.id === transaction.worksiteId && building.blueprintId === recipe.workstation && building.operational && building.stationTransactionId === id);
      if (!station) {
        next = releaseStation(next, id);
        next = block(next, { ...transaction, phase: 'WaitingForStation', worksiteId: null, navigation: emptyNavigation() }, 'WORKSTATION_UNAVAILABLE');
        continue;
      }
      if (transaction.phase === 'TravellingToWork' || !sameCell(worker.position, station) || !isWalkable(next.map, station)) {
        next = travel(next, { ...transaction, phase: 'TravellingToWork' }, station, budget);
        continue;
      }
      const activeTicks = Math.min(transaction.activeTicks + 1, transaction.requiredTicks);
      transaction = { ...running(transaction), activeTicks };
      if (activeTicks === transaction.requiredTicks) {
        next = releaseStation(next, id);
        transaction = { ...transaction, phase: 'TravellingToStorage', navigation: emptyNavigation() };
      }
      next = updateOrder(next, transaction);
      continue;
    }
    if (transaction.phase === 'TravellingToStorage' || transaction.phase === 'AwaitingDelivery') {
      const storage = next.buildings.find((building) => building.id === transaction.storageId && building.blueprintId === 'storage' && building.operational) ?? candidates(next, 'storage', worker.position)[0];
      if (!storage) { next = block(next, { ...transaction, phase: 'TravellingToStorage', storageId: null, navigation: emptyNavigation() }, 'STORAGE_UNAVAILABLE'); continue; }
      const changedStorage = transaction.storageId !== storage.id;
      transaction = { ...transaction, storageId: storage.id, ...(changedStorage ? { phase: 'TravellingToStorage', navigation: emptyNavigation() } : {}) };
      if (transaction.phase === 'TravellingToStorage' || !sameCell(worker.position, storage) || !isWalkable(next.map, storage)) {
        next = travel(next, { ...transaction, phase: 'TravellingToStorage' }, storage, budget);
        continue;
      }
      next = updateOrder(next, transaction);
      const completion = completeProduction(next, id);
      if (completion.ok) next = completion.world;
      else if (completion.rejection.code === 'CAPACITY_EXCEEDED') next = block(next, transaction, 'CAPACITY_EXCEEDED');
      else throw new Error(`Cannot commit production: ${completion.rejection.code}`);
    }
  }
  return next;
}
