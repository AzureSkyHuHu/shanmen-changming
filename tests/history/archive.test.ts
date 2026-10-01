import { describe, expect, test } from 'vitest';
import { emptyNavigation } from '../../src/core/agents/navigation';
import type { ProductionTransaction, Reservation } from '../../src/core/economy/types';
import type { CommandReceipt, DomainEvent } from '../../src/core/kernel/contracts';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import {
  appendArchivedCommandReceipt, appendArchivedEvent, appendArchivedProduction, appendHistoryBatch, createHistoryArchive,
  HISTORY_PAGE_SIZE, HISTORY_STRING_POOL_SIZE, lookupArchivedCommandReceipt, lookupArchivedEvent, lookupArchivedProduction,
  readArchivedEvents, restoreHistoryArchive, validateHistoryArchive, visitArchivedRecords, type ArchivedProduction,
  iterateArchivedProduction, iterateArchivedCommandReceipts, iterateArchivedEvents, getHistoryArchiveUsage,
} from '../../src/core/history';

function production(number = 1, state: 'Committed' | 'Cancelled' = 'Committed'): ArchivedProduction {
  const transactionId = `instance:${number * 2 - 1}`; const reservationId = `instance:${number * 2}`;
  const transaction: ProductionTransaction = { transactionId, reservationId, rootActionId: `action:${number}`,
    commandId: `command.${number}`, recipeId: 'craft.plank', workerId: 'entity:2', state,
    activeTicks: state === 'Committed' ? 160 : 43, requiredTicks: 160, startedTick: 4, completedTick: 200,
    resultEventId: `event:${number * 2}`, blockedReason: null, phase: state === 'Committed' ? 'Done' : 'Cancelled',
    worksiteId: 'entity:9', storageId: 'entity:12', navigation: emptyNavigation() };
  const reservation: Reservation = { reservationId, ownerTransactionId: transactionId,
    state: state === 'Committed' ? 'committed' : 'released', lines: [{ resourceId: 'wood', quantity: 3 }] };
  return { transaction, reservation };
}
function receipt(number = 1): CommandReceipt {
  return { commandId: `command.${number}`, fingerprint: canonicalStringify({ kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }),
    result: { commandId: `command.${number}`, status: 'accepted', transactionId: `instance:${number * 2 - 1}`,
      eventIds: [`event:${number * 2 - 1}`], rejection: null } };
}
function event(number = 1, kind: DomainEvent['kind'] = 'production.started'): DomainEvent {
  return { eventId: `event:${number}`, kind, tick: 4, rootActionId: 'action:1', parentEventId: null,
    payload: kind === 'production.blocked' ? { transactionId: 'instance:1', reason: 'PATH_BLOCKED' }
      : { transactionId: 'instance:1', recipeId: 'craft.plank', workerId: 'entity:2' } };
}
function completeArchive(number = 1) {
  return appendHistoryBatch(createHistoryArchive(), { production: [production(number)], commandReceipts: [receipt(number)],
    events: [event(number * 2 - 1), event(number * 2, 'production.committed')] });
}

describe('independent lossless history codec (World v6 integration pending)', () => {
  test('empty archive is plain finite JSON and roundtrips', () => {
    const archive = createHistoryArchive();
    expect(validateHistoryArchive(archive)).toEqual([]);
    expect(restoreHistoryArchive(JSON.parse(JSON.stringify(archive)))).toEqual(archive);
    expect(lookupArchivedProduction(archive, 'instance:1')).toBeNull();
    expect(lookupArchivedCommandReceipt(archive, 'missing')).toBeNull();
    expect(lookupArchivedEvent(archive, 'event:1')).toBeNull();
  });

  test.each(['Committed', 'Cancelled'] as const)('terminal %s roundtrip preserves every transaction/reservation field', state => {
    const record = production(1, state);
    const archive = appendArchivedProduction(createHistoryArchive(), record.transaction, record.reservation);
    const restored = restoreHistoryArchive(cloneJson(archive));
    expect(lookupArchivedProduction(restored, record.transaction.transactionId)).toEqual(record);
    expect(validateHistoryArchive(restored)).toEqual([]);
  });

  test('start and terminal event identities remain distinct', () => {
    const archive = completeArchive();
    expect(lookupArchivedCommandReceipt(archive, 'command.1')?.result.eventIds).toEqual(['event:1']);
    expect(lookupArchivedProduction(archive, 'instance:1')?.transaction.resultEventId).toBe('event:2');
  });

  test.each(['production.started', 'production.committed', 'production.cancelled', 'production.blocked'] as const)('production event codec roundtrips %s', kind => {
    const value = { ...event(2, kind), parentEventId: 'event:1' };
    const archive = appendArchivedEvent(createHistoryArchive(), value);
    expect(lookupArchivedEvent(restoreHistoryArchive(cloneJson(archive)), 'event:2')).toEqual(value);
  });

  test('arbitrary command fingerprint bytes and historical rejection are exact', () => {
    const value: CommandReceipt = { commandId: 'old.rejected', fingerprint: '{ "kind" : "production.start", "payload": {"workerId":"entity:2","recipeId":"craft.plank"} }',
      result: { commandId: 'old.rejected', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'INSUFFICIENT_INVENTORY', resourceId: 'wood' } } };
    const archive = appendArchivedCommandReceipt(createHistoryArchive(), value);
    expect(lookupArchivedCommandReceipt(restoreHistoryArchive(cloneJson(archive)), value.commandId)).toEqual(value);
    expect(lookupArchivedCommandReceipt(archive, value.commandId)?.fingerprint).toBe(value.fingerprint);
  });

  test('unknown legacy extension fields survive raw fallbacks without mutation', () => {
    const record = production(1, 'Cancelled');
    const extended = { transaction: { ...record.transaction, audit: { 中文: ['retained', 0, false] }, navigation: { ...record.transaction.navigation, oldFlag: true } },
      reservation: { ...record.reservation, lines: [{ ...record.reservation.lines[0]!, source: 'old-definition' }], oldOwner: 'preserved' } };
    const commandReceipt = { ...receipt(), extra: ['outside'], result: { ...receipt().result, extraResult: { old: 7 } } };
    const domainEvent = { ...event(), oldField: 4, payload: { ...event().payload, extra: { retained: true } } };
    const before = canonicalStringify({ extended, commandReceipt, domainEvent });
    const archive = appendHistoryBatch(createHistoryArchive(), { production: [extended], commandReceipts: [commandReceipt], events: [domainEvent] });
    expect(archive.production.pages[0]![0]![0]).toBe(1);
    const restored = restoreHistoryArchive(cloneJson(archive));
    expect(lookupArchivedProduction(restored, 'instance:1')).toEqual(extended);
    expect(lookupArchivedCommandReceipt(restored, 'command.1')).toEqual(commandReceipt);
    expect(lookupArchivedEvent(restored, 'event:1')).toEqual(domainEvent);
    expect(canonicalStringify({ extended, commandReceipt, domainEvent })).toBe(before);
    expect(Object.isFrozen(extended.transaction)).toBe(false);
  });

  test('valid terminal legacy text identities that cannot pack use fallback', () => {
    const record = production(1, 'Cancelled');
    record.transaction.workerId = 'retired-worker'; record.transaction.worksiteId = 'entity:999999999999999999999999';
    const archive = appendArchivedProduction(createHistoryArchive(), record.transaction, record.reservation);
    expect(lookupArchivedProduction(archive, record.transaction.transactionId)).toEqual(record);
  });

  test('nested cultivation/build/expedition result fields survive generic receipts', () => {
    const value = receipt();
    value.result.transactionId = null;
    value.result.expeditionResult = { kind: 'expedition.retreat', runId: 'run:3', phase: 'Ended', relatedId: null };
    const archive = appendArchivedCommandReceipt(createHistoryArchive(), value);
    expect(lookupArchivedCommandReceipt(restoreHistoryArchive(cloneJson(archive)), value.commandId)).toEqual(value);
  });

  test('query results are detached from compact and fallback authority', () => {
    const archive = completeArchive();
    const queried = lookupArchivedProduction(archive, 'instance:1')!;
    queried.transaction.activeTicks = 0; queried.reservation.lines[0]!.quantity = 700;
    const result = lookupArchivedCommandReceipt(archive, 'command.1')!; result.result.eventIds.push('event:999');
    const oldEvent = lookupArchivedEvent(archive, 'event:1')!; (oldEvent.payload as Record<string, unknown>).recipeId = 'changed';
    expect(lookupArchivedProduction(archive, 'instance:1')).toEqual(production());
    expect(lookupArchivedCommandReceipt(archive, 'command.1')).toEqual(receipt());
    expect(lookupArchivedEvent(archive, 'event:1')).toEqual(event());
  });

  test('identical append is a no-op; conflicting reuse never changes prior archive', () => {
    const archive = completeArchive(); const before = canonicalStringify(archive);
    expect(appendHistoryBatch(archive, { production: [production()], commandReceipts: [receipt()], events: [event()] })).toBe(archive);
    const conflict = production(); conflict.transaction.completedTick = conflict.transaction.completedTick! + 1;
    expect(() => appendArchivedProduction(archive, conflict.transaction, conflict.reservation)).toThrow(/conflicting/);
    expect(() => appendArchivedCommandReceipt(archive, { ...receipt(), fingerprint: '{}' })).toThrow(/conflicting/);
    expect(() => appendArchivedEvent(archive, { ...event(), tick: 5 })).toThrow(/conflicting/);
    expect(canonicalStringify(archive)).toBe(before);
  });

  test('archive branches retain independent indexes and shared sealed pages', () => {
    const parent = completeArchive();
    const left = appendArchivedEvent(parent, event(3)); const right = appendArchivedEvent(parent, { ...event(3), tick: 99 });
    expect(lookupArchivedEvent(parent, 'event:3')).toBeNull();
    expect(lookupArchivedEvent(left, 'event:3')?.tick).toBe(4);
    expect(lookupArchivedEvent(right, 'event:3')?.tick).toBe(99);
    expect(left.production).toBe(parent.production);
    expect(left.commandReceipts).toBe(parent.commandReceipts);
  });

  test('batch failure leaves earlier proposed additions unapplied', () => {
    const archive = completeArchive(); const before = canonicalStringify(archive);
    expect(() => appendHistoryBatch(archive, { production: [production(2)], events: [{ ...event(), tick: 55 }] })).toThrow(/conflicting/);
    expect(canonicalStringify(archive)).toBe(before);
    expect(lookupArchivedProduction(archive, 'instance:3')).toBeNull();
  });

  test('restore is identity-idempotent only for owned input and never caches mutable caller input', () => {
    const archive = completeArchive();
    expect(restoreHistoryArchive(archive)).toBe(archive);
    const callerOwned = cloneJson(archive);
    const restored = restoreHistoryArchive(callerOwned);
    expect(restored).not.toBe(callerOwned);
    expect(Object.isFrozen(callerOwned)).toBe(false);
    (callerOwned.events.pages[0]![0] as unknown as unknown[])[2] = 999;
    expect(lookupArchivedEvent(restored, 'event:1')?.tick).toBe(4);
    expect(lookupArchivedEvent(callerOwned, 'event:1')?.tick).toBe(999);
  });

  test('restore rejects object/array accessors without invoking getters', () => {
    let reads = 0;
    const root = cloneJson(completeArchive());
    Object.defineProperty(root, 'schemaVersion', { enumerable: true, get() { reads += 1; return 1; } });
    expect(() => restoreHistoryArchive(root)).toThrow(/accessor/);
    const nested = cloneJson(completeArchive());
    Object.defineProperty(nested.events.pages[0]![0]!, '2', { enumerable: true, get() { reads += 1; return 4; } });
    expect(() => restoreHistoryArchive(nested)).toThrow(/accessor/);
    expect(reads).toBe(0);
    expect(Object.isFrozen(root)).toBe(false);
  });

  test('bounded plain clone keeps escaped text/prototype-named data and rejects nonplain data', () => {
    const payload = JSON.parse('{"__proto__":{"retained":true}}') as Record<string, any>;
    payload.text = 'quote:" slash:\\ controls:\n\u0000 lone:\ud800 pair:😀';
    const value = { ...event(), payload };
    const archive = appendArchivedEvent(createHistoryArchive(), value);
    const restored = restoreHistoryArchive(cloneJson(archive));
    expect(lookupArchivedEvent(restored, value.eventId)).toEqual(value);
    expect(Object.getPrototypeOf(lookupArchivedEvent(restored, value.eventId)!.payload)).toBe(Object.prototype);
    const foreign = cloneJson(archive);
    (foreign as unknown as Record<string, unknown>).unexpected = new Date(0);
    expect(() => restoreHistoryArchive(foreign)).toThrow(/non-JSON/);
    const withCycle = cloneJson(archive) as unknown as Record<string, unknown>;
    withCycle.self = withCycle;
    expect(() => restoreHistoryArchive(withCycle)).toThrow(/cyclic/);
  });

  test('page rollover preserves old page identity and original event order', () => {
    const values = Array.from({ length: HISTORY_PAGE_SIZE }, (_, index) => event(1_000 - index));
    const full = appendHistoryBatch(createHistoryArchive(), { events: values });
    const after = appendArchivedEvent(full, event(1_001));
    expect(after.events.pages).toHaveLength(2);
    expect(after.events.pages[0]).toBe(full.events.pages[0]);
    expect(readArchivedEvents(after, HISTORY_PAGE_SIZE - 2, 3)).toEqual([...values.slice(-2), event(1_001)]);
    expect(readArchivedEvents(after, 10_000, 2)).toEqual([]);
    expect(() => readArchivedEvents(after, -1, 2)).toThrow();
  });

  test('linear visitors provide detached records and event ordinals', () => {
    const archive = completeArchive(); const seen: unknown[] = [];
    visitArchivedRecords(archive, { production: value => seen.push(value), commandReceipt: value => seen.push(value), event: (value, ordinal) => seen.push([ordinal, value.eventId]) });
    expect(seen).toEqual([production(), receipt(), [0, 'event:1'], [1, 'event:2']]);
  });

  test('streaming generators preserve order, detached outputs and safe early termination', () => {
    const archive = appendHistoryBatch(completeArchive(), { production: [production(2)], commandReceipts: [receipt(2)], events: [event(3)] });
    const before = canonicalStringify(archive);
    const jobs = iterateArchivedProduction(archive);
    const first = jobs.next();
    expect(first.done).toBe(false); expect(first.value).toEqual(production());
    first.value!.transaction.activeTicks = 0;
    first.value!.reservation.lines[0]!.quantity = 999;
    jobs.return?.();
    expect([...iterateArchivedProduction(archive)]).toEqual([production(), production(2)]);
    const results = [...iterateArchivedCommandReceipts(archive)];
    expect(results).toEqual([receipt(), receipt(2)]);
    results[0]!.result.eventIds.push('event:900');
    const notices = [...iterateArchivedEvents(archive)];
    expect(notices).toEqual([event(), event(2, 'production.committed'), event(3)]);
    (notices[0]!.payload as Record<string, unknown>).recipeId = 'changed';
    expect(canonicalStringify(archive)).toBe(before);
    expect(restoreHistoryArchive(archive)).toBe(archive);
  });

  test('generators restore unsealed input safely and detach raw fallback records', () => {
    const extended = { ...event(), payload: { nested: { old: true } } };
    const archive = appendArchivedEvent(createHistoryArchive(), extended);
    const callerOwned = cloneJson(archive);
    const iterator = iterateArchivedEvents(callerOwned);
    const first = iterator.next();
    expect(first.value).toEqual(extended);
    (first.value!.payload.nested as Record<string, unknown>).old = false;
    expect(iterator.next().done).toBe(true);
    expect(lookupArchivedEvent(archive, 'event:1')).toEqual(extended);
    expect(lookupArchivedEvent(callerOwned, 'event:1')).toEqual(extended);
    expect(Object.isFrozen(callerOwned)).toBe(false);
    expect([...iterateArchivedProduction(createHistoryArchive())]).toEqual([]);
    expect([...iterateArchivedCommandReceipts(createHistoryArchive())]).toEqual([]);
  });

  test('string pool stops at a fixed size; further fingerprints remain lossless literals', () => {
    const values = Array.from({ length: HISTORY_STRING_POOL_SIZE + 5 }, (_, index) => ({ ...receipt(index + 1), fingerprint: `{"different":${index}}` }));
    const archive = appendHistoryBatch(createHistoryArchive(), { commandReceipts: values });
    expect(archive.strings).toHaveLength(HISTORY_STRING_POOL_SIZE);
    const restored = restoreHistoryArchive(cloneJson(archive));
    for (const value of values) expect(lookupArchivedCommandReceipt(restored, value.commandId)).toEqual(value);
  });

  test('rejects live transactions and inconsistent terminal reservation ownership', () => {
    const record = production();
    expect(() => appendArchivedProduction(createHistoryArchive(), { ...record.transaction, state: 'Running' }, record.reservation)).toThrow();
    expect(() => appendArchivedProduction(createHistoryArchive(), record.transaction, { ...record.reservation, state: 'reserved' })).toThrow();
    expect(() => appendArchivedProduction(createHistoryArchive(), record.transaction, { ...record.reservation, ownerTransactionId: 'instance:999' })).toThrow();
  });

  test('rejects terminal/reservation ID collisions across records', () => {
    const archive = completeArchive(); const next = production(2);
    next.transaction.reservationId = 'instance:1'; next.reservation.reservationId = 'instance:1';
    expect(() => appendArchivedProduction(archive, next.transaction, next.reservation)).toThrow(/collision/);
  });

  test('wire corruption, unsafe IDs, duplicate records and malformed pool refs are rejected', () => {
    const valid = completeArchive();
    const edits: Array<(value: any) => void> = [
      value => { value.codecVersion = 2; },
      value => { value.extra = true; },
      value => { value.production.count = 3; },
      value => { value.production.pages[0][0][1] = Number.MAX_SAFE_INTEGER + 1; },
      value => { value.production.pages[0][0][4] = 999; },
      value => { value.production.pages[0][0][7] = 5; },
      value => { value.events.pages[0][0][5] = 99; },
      value => { value.events.pages[0][1] = value.events.pages[0][0]; },
      value => { value.commandReceipts.pages[0][0][2] = -1; },
      value => { value.strings.push(value.strings[0]); },
    ];
    for (const edit of edits) {
      const corrupt = cloneJson(valid); edit(corrupt);
      expect(validateHistoryArchive(corrupt).length).toBeGreaterThan(0);
      expect(() => restoreHistoryArchive(corrupt)).toThrow();
    }
    expect(validateHistoryArchive(valid)).toEqual([]);
  });

  test('rejects cycles/non-JSON/deep extensions; shared acyclic references remain valid', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(validateHistoryArchive(cycle).length).toBeGreaterThan(0);
    expect(() => appendArchivedEvent(createHistoryArchive(), { ...event(), payload: { nonFinite: Infinity } })).toThrow();
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 55; depth += 1) nested = { nested };
    expect(() => appendArchivedEvent(createHistoryArchive(), { ...event(), payload: nested as DomainEvent['payload'] })).toThrow();
    const shared = { hello: 'world' };
    const value = { ...event(), payload: { left: shared, right: shared } };
    const archive = appendArchivedEvent(createHistoryArchive(), value);
    expect(lookupArchivedEvent(archive, value.eventId)).toEqual(value);
    const sparse = new Array(2) as unknown[]; sparse[1] = 1;
    expect(() => appendArchivedEvent(createHistoryArchive(), { ...event(), payload: { sparse } as DomainEvent['payload'] })).toThrow(/array/);
  });

  test('deep but admitted raw record remains valid after envelope page nesting', () => {
    let nested: Record<string, unknown> = { value: 'kept' };
    for (let depth = 0; depth < 43; depth += 1) nested = { nested };
    const value = { ...event(), payload: nested as DomainEvent['payload'] };
    const archive = appendArchivedEvent(createHistoryArchive(), value);
    expect(validateHistoryArchive(archive)).toEqual([]);
    expect(lookupArchivedEvent(restoreHistoryArchive(cloneJson(archive)), value.eventId)).toEqual(value);
  });

  test('10k synthetic terminal job bundles encode below the proposed 3 MiB production budget', () => {
    const records = Array.from({ length: 10_000 }, (_, index) => production(index + 1));
    const receipts = records.map((_, index) => receipt(index + 1));
    const events = records.flatMap((record, index) => [
      { ...event(index * 2 + 1), rootActionId: record.transaction.rootActionId, payload: { ...event().payload, transactionId: record.transaction.transactionId } },
      { ...event(index * 2 + 2, 'production.committed'), tick: 200, rootActionId: record.transaction.rootActionId, payload: { ...event().payload, transactionId: record.transaction.transactionId } },
    ]);
    const archive = appendHistoryBatch(createHistoryArchive(), { production: records, commandReceipts: receipts, events });
    const archiveBytes = new TextEncoder().encode(canonicalStringify(archive)).byteLength;
    const legacyCollections = {
      transactions: Object.fromEntries(records.map(record => [record.transaction.transactionId, record.transaction])),
      reservations: Object.fromEntries(records.map(record => [record.reservation.reservationId, record.reservation])),
      commandReceipts: Object.fromEntries(receipts.map(value => [value.commandId, value])), events,
    };
    const expandedBytes = new TextEncoder().encode(canonicalStringify(legacyCollections)).byteLength;
    console.log(`HISTORY_CODEC_SIZE ${JSON.stringify({ kind: 'synthetic-terminal-bundles', jobs: records.length,
      archiveBytes, expandedLegacyCollectionBytes: expandedBytes, encodedFraction: archiveBytes / expandedBytes,
      poolStrings: archive.strings.length, productionPages: archive.production.pages.length,
      receiptPages: archive.commandReceipts.pages.length, eventPages: archive.events.pages.length })}`);
    expect(archiveBytes).toBeLessThan(3 * 1024 * 1024);
    expect(validateHistoryArchive(archive)).toEqual([]);
    expect(lookupArchivedProduction(archive, 'instance:19999')).toEqual(records.at(-1));
    expect(lookupArchivedCommandReceipt(archive, 'command.10000')).toEqual(receipts.at(-1));
    expect(lookupArchivedEvent(archive, 'event:20000')).toEqual(events.at(-1));
  }, 30_000);
});

test('exposes authenticated detached archive usage without materializing its history', () => {
  const empty = createHistoryArchive();
  expect(getHistoryArchiveUsage(empty)).toEqual({ productionCount: 0, commandReceiptCount: 0, eventCount: 0, expandedCharacters: 0, expandedNodes: 0 });
  const record = production();
  const archive = appendArchivedProduction(empty, record.transaction, record.reservation);
  const usage = getHistoryArchiveUsage(archive);
  expect(usage).toMatchObject({ productionCount: 1, commandReceiptCount: 0, eventCount: 0, expandedCharacters: canonicalStringify(record).length });
  expect(usage.expandedNodes).toBeGreaterThan(32);
  const originalNodes = usage.expandedNodes;
  Object.assign(usage, { expandedNodes: 0 });
  expect(getHistoryArchiveUsage(archive).expandedNodes).toBe(originalNodes);
  expect(getHistoryArchiveUsage(restoreHistoryArchive(cloneJson(archive)))).toEqual(getHistoryArchiveUsage(archive));
});
