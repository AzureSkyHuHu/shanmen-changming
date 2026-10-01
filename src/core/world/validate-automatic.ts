import { automaticCycle, AUTOMATIC_JOURNAL_LIMIT } from '../economy/automatic-production';
import type { AutomaticProductionState } from '../economy/automatic-types';
import { getRecipe } from '../economy/recipes';
import { PRODUCTION_BLOCKED_REASONS } from '../economy/types';
import { isNonNegativeInteger } from '../kernel/numeric';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value: ObjectValue, expected: readonly string[]) => Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
const id = (value: unknown, kind: string, next: number) => typeof value === 'string' && new RegExp(`^${kind}:[1-9][0-9]*$`).test(value)
  && Number.isSafeInteger(Number(value.slice(kind.length + 1))) && Number(value.slice(kind.length + 1)) < next;
const transactionKeys = ['transactionId', 'rootActionId', 'origin', 'recipeId', 'workerId', 'reservationId', 'state', 'activeTicks', 'requiredTicks', 'startedTick',
  'completedTick', 'resultEventId', 'blockedReason', 'phase', 'worksiteId', 'storageId', 'navigation'];

/** New v7 records are exact-schema data; legacy manual extensions remain on their own path. */
export function validateAutomaticProductionShape(value: unknown, context: { tick: number; nextAction: number; nextEvent: number; nextEntity: number }): string[] {
  const fail = (message: string) => [message];
  if (!object(value) || !keys(value, ['schemaVersion', 'nextCycle', 'activationReviewRequired', 'live', 'journal', 'pins']) || value.schemaVersion !== 1
    || !isNonNegativeInteger(value.nextCycle) || value.nextCycle < 1 || typeof value.activationReviewRequired !== 'boolean'
    || !object(value.live) || !object(value.pins) || !Array.isArray(value.journal) || value.journal.length > AUTOMATIC_JOURNAL_LIMIT) return fail('Invalid automatic production state');
  const roots = new Set<string>();
  for (const [key, pair] of Object.entries(value.live)) {
    const cycle = automaticCycle(key);
    if (cycle === null || cycle >= value.nextCycle || Object.hasOwn(value.pins, key) || !object(pair) || !keys(pair, ['transaction', 'reservation'])
      || !object(pair.transaction) || !keys(pair.transaction, transactionKeys) || pair.transaction.transactionId !== key
      || !object(pair.transaction.origin) || !keys(pair.transaction.origin, ['kind', 'cycle']) || pair.transaction.origin.kind !== 'sect-plan'
      || pair.transaction.origin.cycle !== cycle || !['Running', 'Blocked'].includes(pair.transaction.state as string)
      || !object(pair.reservation) || !keys(pair.reservation, ['reservationId', 'ownerTransactionId', 'state', 'lines'])) return fail('Invalid automatic live ownership');
    if (!id(pair.transaction.rootActionId, 'action', context.nextAction) || roots.has(pair.transaction.rootActionId as string)) return fail('Invalid automatic action ownership');
    roots.add(pair.transaction.rootActionId as string);
  }
  for (const [key, pin] of Object.entries(value.pins)) {
    const cycle = automaticCycle(key);
    if (cycle === null || cycle >= value.nextCycle || !object(pin) || !keys(pin, ['cycle', 'state', 'workerId', 'recipeId', 'rootActionId', 'completedTick', 'resultEventId', 'retention'])
      || pin.cycle !== cycle || !['Committed', 'Cancelled'].includes(pin.state as string) || !id(pin.workerId, 'entity', context.nextEntity)
      || typeof pin.recipeId !== 'string' || !getRecipe(pin.recipeId) || !id(pin.rootActionId, 'action', context.nextAction)
      || !isNonNegativeInteger(pin.completedTick) || pin.completedTick > context.tick || !['pending-command', 'exact-receipt'].includes(pin.retention as string)
      || (pin.retention === 'exact-receipt' ? pin.state !== 'Cancelled' || !id(pin.resultEventId, 'event', context.nextEvent) : pin.resultEventId !== null)) return fail('Invalid automatic terminal pin');
    if (roots.has(pin.rootActionId as string)) return fail('Invalid automatic action ownership');
    roots.add(pin.rootActionId as string);
  }
  let previousEvent = 0; let previousTick = 0;
  for (const notice of value.journal) {
    if (!object(notice) || !keys(notice, ['eventId', 'tick', 'cycle', 'workerId', 'recipeId', 'kind', 'reason'])
      || !id(notice.eventId, 'event', context.nextEvent) || !isNonNegativeInteger(notice.tick) || notice.tick > context.tick || notice.tick < previousTick
      || !isNonNegativeInteger(notice.cycle) || notice.cycle < 1 || notice.cycle >= value.nextCycle || !id(notice.workerId, 'entity', context.nextEntity)
      || typeof notice.recipeId !== 'string' || !getRecipe(notice.recipeId) || !['started', 'blocked', 'committed', 'cancelled'].includes(notice.kind as string)
      || (notice.kind === 'blocked' ? !PRODUCTION_BLOCKED_REASONS.includes(notice.reason as never) : notice.reason !== null)) return fail('Invalid automatic notice');
    const number = Number((notice.eventId as string).slice(6));
    if (number <= previousEvent) return fail('Automatic notice order is not monotone');
    previousEvent = number; previousTick = notice.tick;
  }
  return [];
}

/** Proofs are collected while the main validator streams durable events and receipts once. */
export function validateAutomaticProductionReferences(state: AutomaticProductionState, context: {
  durableEventIds: ReadonlySet<string>; cancellationEvents: ReadonlyMap<string, ObjectValue>;
  justifiedPins: ReadonlySet<string>; pendingTargets: ReadonlySet<string>;
}): string[] {
  for (const notice of state.journal) if (context.durableEventIds.has(notice.eventId)) return ['Automatic notice collides with durable event'];
  for (const [key, pin] of Object.entries(state.pins)) {
    if (pin.retention === 'pending-command') {
      if (!context.pendingTargets.has(key)) return ['Automatic temporary pin has no queued command'];
      continue;
    }
    const event = context.cancellationEvents.get(key);
    if (!context.justifiedPins.has(key) || !event || event.eventId !== pin.resultEventId || event.rootActionId !== pin.rootActionId
      || event.parentEventId !== null || !object(event.payload) || !keys(event.payload, ['transactionId', 'recipeId', 'workerId', 'settledTick']) || event.payload.transactionId !== key || event.payload.recipeId !== pin.recipeId
      || event.payload.workerId !== pin.workerId || event.payload.settledTick !== pin.completedTick
      || typeof event.tick !== 'number' || event.tick < pin.completedTick) return ['Automatic exact pin lacks matching receipt and event'];
  }
  for (const key of context.cancellationEvents.keys()) if (!Object.hasOwn(state.pins, key)) return ['Orphan automatic cancellation event'];
  return [];
}
