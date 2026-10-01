import { appendHistoryBatch, createHistoryArchive, lookupArchivedCommandReceipt, lookupArchivedEvent, lookupArchivedProduction,
  readArchivedEvents, restoreHistoryArchive } from '../history';
import type { ProductionTransaction } from '../economy/types';
import type { CommandReceipt, DomainEvent } from '../kernel/contracts';
import { cloneJson, compareStable } from '../kernel/serialization';
import type { WorldState } from './types';

export const RECENT_WORLD_EVENTS = 64;
export const RECENT_WORLD_RECEIPTS = 64;

/** Only frozen migration intermediates may use the pre-archive representation. */
function hasHistory(world: WorldState): boolean {
  if (world.history !== undefined) return true;
  if (!['0.1.1', '0.2.0', '0.3.0', '0.4.0', '0.5.0'].includes(world.simulationVersion)) throw new TypeError('Missing World history authority');
  return false;
}
export function restoreWorldHistory(world: WorldState): WorldState {
  const history = restoreHistoryArchive(world.history);
  return history === world.history ? world : { ...world, history };
}
/** All mutable gameplay branches are detached; only authenticated immutable archive pages are shared. */
export function cloneWorldWithSharedHistory(world: WorldState): WorldState {
  const owned = restoreWorldHistory(world);
  const { history, ...mutable } = owned;
  return { ...cloneJson(mutable), history };
}
export function lookupProduction(world: WorldState, transactionId: string): ProductionTransaction | undefined {
  const live = Object.hasOwn(world.transactions, transactionId) ? world.transactions[transactionId] : undefined;
  return live ? cloneJson(live) : hasHistory(world) ? lookupArchivedProduction(world.history, transactionId)?.transaction : undefined;
}
export function lookupCommandReceipt(world: WorldState, commandId: string): CommandReceipt | undefined {
  const live = Object.hasOwn(world.commandReceipts, commandId) ? world.commandReceipts[commandId] : undefined;
  return live ? cloneJson(live) : hasHistory(world) ? lookupArchivedCommandReceipt(world.history, commandId) ?? undefined : undefined;
}
export function lookupEvent(world: WorldState, eventId: string): DomainEvent | undefined {
  const live = world.events.find((event) => event.eventId === eventId);
  return live ? cloneJson(live) : hasHistory(world) ? lookupArchivedEvent(world.history, eventId) ?? undefined : undefined;
}
export function worldEventCursor(world: WorldState): number { return (hasHistory(world) ? world.history.events.count : 0) + world.events.length; }
export function worldEventsSince(world: WorldState, cursor: number): DomainEvent[] {
  const total = worldEventCursor(world);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > total) throw new RangeError('Invalid World event cursor');
  const archived = hasHistory(world) ? world.history.events.count : 0;
  const prefix = cursor < archived ? readArchivedEvents(world.history, cursor, archived - cursor) : [];
  return [...prefix, ...cloneJson(world.events.slice(Math.max(0, cursor - archived)))];
}
export function recentWorldEvents(world: WorldState, limit = RECENT_WORLD_EVENTS): DomainEvent[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > RECENT_WORLD_EVENTS) throw new RangeError('Invalid recent event limit');
  return worldEventsSince(world, Math.max(0, worldEventCursor(world) - limit));
}

/** Event order is original append order, including valid legacy arrays with non-sorted IDs. */
export function appendWorldEvents(world: WorldState, additions: readonly DomainEvent[]): WorldState {
  if (!additions.length) return world;
  const events = [...world.events, ...additions];
  if (!hasHistory(world) || events.length <= RECENT_WORLD_EVENTS) return { ...world, events };
  const split = events.length - RECENT_WORLD_EVENTS;
  const history = appendHistoryBatch(world.history, { events: events.slice(0, split) });
  return { ...world, history, events: events.slice(split) };
}
/** The tail is deterministic by ID, not insertion order (canonical save reorders object keys). */
export function recordWorldReceipt(world: WorldState, receipt: CommandReceipt): WorldState {
  if (lookupCommandReceipt(world, receipt.commandId)) throw new TypeError('Command receipt identity already owned');
  const commandReceipts = { ...world.commandReceipts, [receipt.commandId]: cloneJson(receipt) };
  const ids = Object.keys(commandReceipts).sort(compareStable);
  if (!hasHistory(world) || ids.length <= RECENT_WORLD_RECEIPTS) return { ...world, commandReceipts };
  const retired = ids.slice(0, ids.length - RECENT_WORLD_RECEIPTS);
  const history = appendHistoryBatch(world.history, { commandReceipts: retired.map((id) => commandReceipts[id]!) });
  for (const id of retired) delete commandReceipts[id];
  return { ...world, history, commandReceipts };
}
/** Called in the same pure transition that already settled inventory and emitted its result. */
export function archiveTerminalProduction(world: WorldState, transactionId: string): WorldState {
  if (!hasHistory(world)) return world;
  const transaction = world.transactions[transactionId];
  const reservation = transaction && world.reservations[transaction.reservationId];
  if (!transaction || !reservation || !['Committed', 'Cancelled'].includes(transaction.state)) throw new TypeError('Cannot archive unsettled production');
  const history = appendHistoryBatch(world.history, { production: [{ transaction, reservation }] });
  const transactions = { ...world.transactions }; const reservations = { ...world.reservations };
  delete transactions[transactionId]; delete reservations[reservation.reservationId];
  return { ...world, history, transactions, reservations };
}

/** Source was fully validated as v5. Only representation changes, never IDs/resources/event order. */
export function migrateWorldHistory(value: unknown): WorldState {
  const world = cloneJson(value) as WorldState;
  if (Object.hasOwn(world, 'history')) throw new TypeError('Unexpected legacy archive');
  let history = createHistoryArchive();
  const terminal = Object.values(world.transactions).filter((transaction) => transaction.state === 'Committed' || transaction.state === 'Cancelled')
    .sort((a, b) => compareStable(a.transactionId, b.transactionId));
  const receipts = Object.keys(world.commandReceipts).sort(compareStable).slice(0, Math.max(0, Object.keys(world.commandReceipts).length - RECENT_WORLD_RECEIPTS));
  const eventSplit = Math.max(0, world.events.length - RECENT_WORLD_EVENTS);
  history = appendHistoryBatch(history, { production: terminal.map((transaction) => ({ transaction, reservation: world.reservations[transaction.reservationId]! })),
    commandReceipts: receipts.map((id) => world.commandReceipts[id]!), events: world.events.slice(0, eventSplit) });
  for (const transaction of terminal) { delete world.transactions[transaction.transactionId]; delete world.reservations[transaction.reservationId]; }
  for (const id of receipts) delete world.commandReceipts[id];
  return { ...world, simulationVersion: '0.6.0', history, events: world.events.slice(eventSplit) };
}
