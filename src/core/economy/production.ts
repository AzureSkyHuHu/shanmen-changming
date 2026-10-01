import type { CommandRejection, DomainEvent } from '../kernel/contracts';
import { appendEvent } from '../kernel/events';
import { allocateId } from '../kernel/ids';
import { compareStable } from '../kernel/serialization';
import type { WorldState } from '../world/types';
import { commitReservation, releaseReservation, reserveResources } from './inventory';
import { getRecipe } from './recipes';
import type { ProductionTransaction } from './types';

export type ProductionResult = { ok: true; world: WorldState; transactionId: string; eventIds: string[] } | { ok: false; rejection: CommandRejection };

export function startProduction(world: WorldState, commandId: string, recipeId: string, workerId: string): ProductionResult {
  const recipe = getRecipe(recipeId);
  if (!recipe) return { ok: false, rejection: { code: 'UNKNOWN_RECIPE' } };
  const worker = world.disciples.find((disciple) => disciple.id === workerId);
  if (!worker) return { ok: false, rejection: { code: 'UNKNOWN_WORKER' } };
  if (world.clock.mode !== 'management' || !worker.canWork || worker.lifeState !== 'alive' || worker.traveling || worker.assignmentTransactionId !== null || !world.buildings.some((building) => building.blueprintId === recipe.workstation && building.operational)) {
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
  };
  const next: WorldState = {
    ...world, sequences: reservation.sequences, inventory: reserved.inventory,
    reservations: { ...world.reservations, [reservation.id]: reserved.reservation },
    transactions: { ...world.transactions, [transaction.id]: order },
    disciples: world.disciples.map((disciple) => disciple.id === workerId ? { ...disciple, assignmentTransactionId: transaction.id } : disciple),
  };
  const emitted = appendEvent(next, { kind: 'production.started', rootActionId: action.id, parentEventId: null, payload: { transactionId: transaction.id, recipeId, workerId } });
  return { ok: true, world: emitted.world, transactionId: transaction.id, eventIds: [emitted.event.eventId] };
}

function endProduction(world: WorldState, transaction: ProductionTransaction, state: 'Committed' | 'Cancelled', kind: DomainEvent['kind']): ProductionResult {
  const emitted = appendEvent(world, { kind, rootActionId: transaction.rootActionId, parentEventId: null, payload: { transactionId: transaction.transactionId, recipeId: transaction.recipeId, workerId: transaction.workerId } });
  return {
    ok: true, transactionId: transaction.transactionId, eventIds: [emitted.event.eventId],
    world: {
      ...emitted.world,
      transactions: { ...emitted.world.transactions, [transaction.transactionId]: { ...transaction, state, completedTick: world.clock.simulationTick, resultEventId: emitted.event.eventId, blockedReason: null } },
      disciples: world.disciples.map((disciple) => disciple.assignmentTransactionId === transaction.transactionId ? { ...disciple, assignmentTransactionId: null } : disciple),
    },
  };
}

export function cancelProduction(world: WorldState, transactionId: string): ProductionResult {
  const transaction = Object.hasOwn(world.transactions, transactionId) ? world.transactions[transactionId] : undefined;
  if (!transaction) return { ok: false, rejection: { code: 'UNKNOWN_TRANSACTION' } };
  if (transaction.state === 'Cancelled') return { ok: true, world, transactionId, eventIds: transaction.resultEventId ? [transaction.resultEventId] : [] };
  if (transaction.state === 'Committed') return { ok: false, rejection: { code: 'TRANSACTION_FINISHED' } };
  const reservation = world.reservations[transaction.reservationId];
  if (!reservation) return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  const released = releaseReservation(world.inventory, reservation);
  if (!released.ok) return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  return endProduction({ ...world, inventory: released.inventory, reservations: { ...world.reservations, [reservation.reservationId]: released.reservation } }, transaction, 'Cancelled', 'production.cancelled');
}

export function completeProduction(world: WorldState, transactionId: string): ProductionResult {
  const transaction = Object.hasOwn(world.transactions, transactionId) ? world.transactions[transactionId] : undefined;
  if (!transaction) return { ok: false, rejection: { code: 'UNKNOWN_TRANSACTION' } };
  if (transaction.state === 'Committed') return { ok: true, world, transactionId, eventIds: transaction.resultEventId ? [transaction.resultEventId] : [] };
  if (transaction.state === 'Cancelled') return { ok: false, rejection: { code: 'TRANSACTION_FINISHED' } };
  if (transaction.activeTicks < transaction.requiredTicks) return { ok: false, rejection: { code: 'WORKER_UNAVAILABLE' } };
  const reservation = world.reservations[transaction.reservationId];
  const recipe = getRecipe(transaction.recipeId);
  if (!reservation || !recipe) return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  const committed = commitReservation(world.inventory, reservation, recipe.outputs);
  if (!committed.ok) return { ok: false, rejection: { code: committed.rejection.code === 'INVALID_RESOURCE_LINE' ? 'INVALID_COMMAND' : committed.rejection.code, ...(committed.rejection.resourceId ? { resourceId: committed.rejection.resourceId } : {}) } };
  return endProduction({ ...world, inventory: committed.inventory, reservations: { ...world.reservations, [reservation.reservationId]: committed.reservation } }, transaction, 'Committed', 'production.committed');
}

/** Stable transaction order is part of simulation v0.1.0, including capacity races. */
export function tickProduction(world: WorldState): WorldState {
  if (world.clock.mode !== 'management') return world;
  let next = world;
  for (const id of Object.keys(world.transactions).sort(compareStable)) {
    const transaction = next.transactions[id]!;
    if (transaction.state !== 'Running' && transaction.state !== 'Blocked') continue;
    const worker = next.disciples.find((disciple) => disciple.id === transaction.workerId);
    const recipe = getRecipe(transaction.recipeId);
    if (!worker || !recipe) throw new Error('Production references a missing worker or recipe');
    if (!worker.canWork || worker.lifeState !== 'alive' || worker.traveling || !next.buildings.some((building) => building.blueprintId === recipe.workstation && building.operational)) continue;
    if (worker.assignmentTransactionId !== id) throw new Error('Production worker assignment mismatch');
    const activeTicks = Math.min(transaction.activeTicks + 1, transaction.requiredTicks);
    next = { ...next, transactions: { ...next.transactions, [id]: { ...transaction, activeTicks } } };
    if (activeTicks < transaction.requiredTicks) continue;
    const completion = completeProduction(next, id);
    if (completion.ok) next = completion.world;
    else if (completion.rejection.code === 'CAPACITY_EXCEEDED') {
      if (transaction.state !== 'Blocked') {
        next = appendEvent(next, { kind: 'production.blocked', rootActionId: transaction.rootActionId, parentEventId: null, payload: { transactionId: id, reason: 'CAPACITY_EXCEEDED' } }).world;
      }
      next = { ...next, transactions: { ...next.transactions, [id]: { ...next.transactions[id]!, state: 'Blocked', blockedReason: 'CAPACITY_EXCEEDED' } } };
    } else throw new Error(`Cannot commit production: ${completion.rejection.code}`);
  }
  return next;
}
