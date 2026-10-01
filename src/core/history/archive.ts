import { emptyNavigation } from '../agents/navigation';
import type { ProductionTransaction, Reservation } from '../economy/types';
import type { CommandReceipt, DomainEvent } from '../kernel/contracts';
import { canonicalStringify, cloneJson, hashText, type JsonValue } from '../kernel/serialization';
import {
  HISTORY_PAGE_SIZE, HISTORY_STRING_POOL_SIZE, MAX_HISTORY_EXPANDED_CHARACTERS, MAX_HISTORY_EXPANDED_NODES, MAX_HISTORY_RECORDS_PER_TABLE,
  type ArchivedProduction, type HistoryAppendBatch, type HistoryArchive, type HistoryTable, type HistoryVisitors, type PackedHistoryRow,
} from './types';

type ObjectValue = Record<string, unknown>;
type StringToken = string | number;
type Buckets = readonly ReadonlyMap<string, PackedHistoryRow>[];
interface Indexes { production: Buckets; reservations: Buckets; commandReceipts: Buckets; events: Buckets; expandedCharacters: number; expandedNodes: number }
const INDEX_BUCKETS = 256;
const indexes = new WeakMap<HistoryArchive, Indexes>();
const sealed = new WeakSet<HistoryArchive>();
const transactionKeys = ['transactionId', 'rootActionId', 'commandId', 'recipeId', 'workerId', 'reservationId', 'state', 'activeTicks', 'requiredTicks', 'startedTick', 'completedTick', 'resultEventId', 'blockedReason', 'phase', 'worksiteId', 'storageId', 'navigation'];
const reservationKeys = ['reservationId', 'ownerTransactionId', 'lines', 'state'];
const eventKeys = ['eventId', 'kind', 'tick', 'rootActionId', 'parentEventId', 'payload'];
const resultKeys = ['commandId', 'status', 'transactionId', 'eventIds', 'rejection'];
const productionKinds = ['production.started', 'production.committed', 'production.cancelled', 'production.blocked'] as const;

const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: unknown, keys: readonly string[]): value is ObjectValue => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;
function invalid(message: string): never { throw new TypeError(`Invalid history: ${message}`); }
function idNumber(value: unknown, kind: string): number {
  if (typeof value !== 'string' || !new RegExp(`^${kind}:[1-9][0-9]*$`).test(value)) invalid(`invalid ${kind} ID`);
  const number = Number(value.slice(kind.length + 1));
  if (!integer(number) || number < 1) invalid(`unsafe ${kind} ID`);
  return number;
}
function id(value: unknown, kind: string): string {
  if (!integer(value) || value < 1) invalid(`invalid packed ${kind} ID`);
  return `${kind}:${value}`;
}
const optionalIdNumber = (value: unknown, kind: string): number | null => value === null ? null : idNumber(value, kind);
const optionalId = (value: unknown, kind: string): string | null => value === null ? null : id(value, kind);
function packableId(value: unknown, kind: string): boolean { try { idNumber(value, kind); return true; } catch { return false; } }

/** JSON string length without allocating its potentially much larger escaped form. */
function quotedLength(value: string): number {
  if (value.length > MAX_HISTORY_EXPANDED_CHARACTERS) invalid('string exceeds limit');
  let length = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) length += 2;
    else if (code < 32) length += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { length += 2; index += 1; } else length += 6;
    } else length += code >= 0xdc00 && code <= 0xdfff ? 6 : 1;
    if (length > MAX_HISTORY_EXPANDED_CHARACTERS) invalid('escaped string exceeds limit');
  }
  return length;
}
/** Data descriptors only: never invoke accessors while checking or cloning untrusted objects. */
function inspectJson(value: unknown, maxDepth: number, copy: boolean): { nodes: number; characters: number; value: unknown } {
  const active = new WeakSet<object>();
  let nodes = 0; let characters = 0;
  const account = (length: number): void => { characters += length; if (characters > MAX_HISTORY_EXPANDED_CHARACTERS) invalid('JSON text exceeds limit'); };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > MAX_HISTORY_EXPANDED_NODES || depth > maxDepth) invalid('JSON structure exceeds limit');
    if (item === null) { account(4); return null; }
    if (typeof item === 'boolean') { account(item ? 4 : 5); return item; }
    if (typeof item === 'string') { account(quotedLength(item)); return item; }
    if (typeof item === 'number' && Number.isFinite(item)) { account(JSON.stringify(item).length); return item === 0 ? 0 : item; }
    const array = Array.isArray(item);
    if (!array && !object(item)) invalid('non-JSON value');
    if (array && Object.getPrototypeOf(item) !== Array.prototype) invalid('non-plain array');
    if (active.has(item)) invalid('cyclic JSON value');
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) invalid('non-JSON symbol key');
    const length = array ? Object.getOwnPropertyDescriptor(item, 'length')?.value as unknown : 0;
    if (array && (!integer(length) || keys.length !== length + 1)) invalid('non-JSON array');
    active.add(item);
    const result: unknown[] | Record<string, unknown> | undefined = copy ? (array ? [] : {}) : undefined;
    const entries = array ? (length as number) : keys.length;
    account(2 + Math.max(0, entries - 1));
    for (let index = 0; index < entries; index += 1) {
      const key = array ? String(index) : keys[index] as string;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid('accessor or non-JSON property');
      if (!array) account(quotedLength(key) + 1);
      const child = visit(descriptor.value, depth + 1);
      if (copy) {
        if (array) (result as unknown[])[index] = child;
        else Object.defineProperty(result!, key, { value: child, enumerable: true, writable: true, configurable: true });
      }
    }
    active.delete(item);
    return copy ? result : undefined;
  };
  const result = visit(value, 0);
  return { nodes, characters, value: result };
}
/** Bound hostile values before canonicalization. No input is frozen or mutated. */
function assertJson(value: unknown, maxDepth = 48): number { return inspectJson(value, maxDepth, false).nodes; }
/** Only codec-created records from already inspected plain-data wire input enter here.
 * Keep exact expansion/depth limits without repeating descriptor/cycle checks per decoded field. */
function measureDecodedJson(value: unknown): { nodes: number; characters: number } {
  let nodes = 0; let characters = 0;
  const add = (length: number) => { characters += length; if (characters > MAX_HISTORY_EXPANDED_CHARACTERS) invalid('decoded JSON text exceeds limit'); };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_HISTORY_EXPANDED_NODES || depth > 48) invalid('decoded JSON structure exceeds limit');
    if (item === null) { add(4); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'string') { add(quotedLength(item)); return; }
    if (typeof item === 'number' && Number.isFinite(item)) { add(JSON.stringify(item).length); return; }
    if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      for (let index = 0; index < item.length; index++) visit(item[index], depth + 1);
      return;
    }
    if (!object(item)) invalid('non-JSON decoded value');
    const keys = Object.keys(item);
    add(2 + Math.max(0, keys.length - 1));
    for (const key of keys) { add(quotedLength(key) + 1); visit(item[key], depth + 1); }
  };
  visit(value, 0);
  return { nodes, characters };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function stringAt(strings: readonly string[], value: unknown): string {
  if (typeof value === 'string') return value;
  if (!integer(value) || value >= strings.length) invalid('string pool reference');
  return strings[value]!;
}
function pool(strings: string[]): (value: string) => StringToken {
  const known = new Map(strings.map((value, index) => [value, index]));
  return value => {
    const prior = known.get(value); if (prior !== undefined) return prior;
    if (strings.length === HISTORY_STRING_POOL_SIZE) return value;
    const index = strings.length; strings.push(value); known.set(value, index); return index;
  };
}
function emptyBuckets(): Buckets { return Array.from({ length: INDEX_BUCKETS }, () => new Map<string, PackedHistoryRow>()); }
function get(buckets: Buckets, key: string): PackedHistoryRow | undefined { return buckets[hashText(key) % INDEX_BUCKETS]!.get(key); }
function put(buckets: Buckets, key: string, row: PackedHistoryRow): Buckets {
  const bucket = hashText(key) % INDEX_BUCKETS;
  const next = [...buckets]; const entries = new Map(next[bucket]); entries.set(key, row); next[bucket] = entries; return next;
}
function emptyTable(): HistoryTable { return { count: 0, pages: [] }; }
function appendRow(table: HistoryTable, row: PackedHistoryRow): HistoryTable {
  if (table.count >= MAX_HISTORY_RECORDS_PER_TABLE) invalid('record count exceeds limit');
  const pages = [...table.pages];
  const tail = pages.at(-1);
  if (!tail || tail.length === HISTORY_PAGE_SIZE) pages.push(freeze([row]));
  else pages[pages.length - 1] = freeze([...tail, row]);
  return freeze({ count: table.count + 1, pages });
}
function* rows(table: HistoryTable): Generator<PackedHistoryRow> { for (const page of table.pages) yield* page; }
function same(left: unknown, right: unknown): boolean { return canonicalStringify(left) === canonicalStringify(right); }

function assertProduction(record: unknown): asserts record is ArchivedProduction {
  if (!exact(record, ['transaction', 'reservation']) || !object(record.transaction) || !object(record.reservation)) invalid('production pair');
  const t = record.transaction; const r = record.reservation;
  idNumber(t.transactionId, 'instance'); idNumber(t.reservationId, 'instance'); idNumber(t.rootActionId, 'action'); idNumber(t.resultEventId, 'event');
  if (!text(t.commandId) || !text(t.recipeId) || !text(t.workerId) || !['Committed', 'Cancelled'].includes(t.state as string)
    || !integer(t.activeTicks) || !integer(t.requiredTicks) || t.activeTicks > t.requiredTicks || !integer(t.startedTick)
    || !integer(t.completedTick) || t.completedTick < t.startedTick || t.blockedReason !== null
    || t.phase !== (t.state === 'Committed' ? 'Done' : 'Cancelled')
    || (t.state === 'Committed' && t.activeTicks !== t.requiredTicks)
    || !(t.worksiteId === null || text(t.worksiteId)) || !(t.storageId === null || text(t.storageId))) invalid('terminal transaction');
  const navigation = t.navigation;
  if (!object(navigation) || !Array.isArray(navigation.path) || navigation.path.length !== 0 || navigation.target !== null
    || navigation.routeVersion !== null || navigation.movementTicks !== 0 || navigation.retryAtTick !== 0) invalid('terminal navigation');
  if (r.reservationId !== t.reservationId || r.ownerTransactionId !== t.transactionId || r.reservationId === r.ownerTransactionId
    || r.state !== (t.state === 'Committed' ? 'committed' : 'released') || !Array.isArray(r.lines)) invalid('terminal reservation ownership');
  const resourceIds = new Set<string>();
  for (const line of r.lines) {
    if (!object(line) || !text(line.resourceId) || !integer(line.quantity) || line.quantity === 0 || resourceIds.has(line.resourceId)) invalid('reservation line');
    resourceIds.add(line.resourceId);
  }
}
function assertReceipt(receipt: unknown): asserts receipt is CommandReceipt {
  if (!object(receipt) || !text(receipt.commandId) || !text(receipt.fingerprint, 16_384) || !object(receipt.result)) invalid('command receipt');
  const result = receipt.result;
  if (result.commandId !== receipt.commandId || !['accepted', 'rejected'].includes(result.status as string) || !Array.isArray(result.eventIds)) invalid('command result');
  for (const eventId of result.eventIds) idNumber(eventId, 'event');
  if (!(result.transactionId === null || text(result.transactionId))) invalid('receipt transaction reference');
  if (result.status === 'accepted' ? result.rejection !== null : result.transactionId !== null || !object(result.rejection) || !text(result.rejection.code)) invalid('receipt rejection');
}
function assertEvent(event: unknown): asserts event is DomainEvent {
  if (!object(event) || !text(event.kind) || !integer(event.tick) || !object(event.payload)) invalid('event');
  idNumber(event.eventId, 'event'); idNumber(event.rootActionId, 'action');
  if (event.parentEventId !== null && !text(event.parentEventId)) invalid('parent event');
}
function encodeProduction(record: ArchivedProduction, intern: (value: string) => StringToken): PackedHistoryRow {
  const t = record.transaction; const r = record.reservation;
  const canonical = exact(t, transactionKeys) && exact(r, reservationKeys) && same(t.navigation, emptyNavigation())
    && r.lines.every(line => exact(line, ['resourceId', 'quantity']))
    && packableId(t.workerId, 'entity')
    && [t.worksiteId, t.storageId].every(value => value === null || packableId(value, 'entity'));
  if (!canonical) return freeze([1, t.transactionId, cloneJson(record) as unknown as JsonValue]);
  return freeze([0, idNumber(t.transactionId, 'instance'), idNumber(t.rootActionId, 'action'), t.commandId,
    intern(t.recipeId), idNumber(t.workerId, 'entity'), idNumber(t.reservationId, 'instance'), t.state === 'Committed' ? 0 : 1,
    t.activeTicks, t.requiredTicks, t.startedTick, t.completedTick!, idNumber(t.resultEventId, 'event'),
    optionalIdNumber(t.worksiteId, 'entity'), optionalIdNumber(t.storageId, 'entity'),
    r.lines.map(line => [intern(line.resourceId), line.quantity])]);
}
function decodeProduction(row: PackedHistoryRow, strings: readonly string[]): ArchivedProduction {
  if (row[0] === 1) {
    if (row.length !== 3 || !object(row[2]) || !object(row[2].transaction) || row[1] !== row[2].transaction.transactionId) invalid('raw production row');
    return cloneJson(row[2]) as unknown as ArchivedProduction;
  }
  if (row[0] !== 0 || row.length !== 16 || ![0, 1].includes(row[7] as number) || typeof row[3] !== 'string' || !Array.isArray(row[15])) invalid('packed production row');
  const transactionId = id(row[1], 'instance'); const reservationId = id(row[6], 'instance');
  const lines = row[15].map(line => {
    if (!Array.isArray(line) || line.length !== 2) invalid('packed reservation line');
    return { resourceId: stringAt(strings, line[0]), quantity: line[1] };
  });
  return { transaction: { transactionId, rootActionId: id(row[2], 'action'), commandId: row[3], recipeId: stringAt(strings, row[4]),
    workerId: id(row[5], 'entity'), reservationId, state: row[7] === 0 ? 'Committed' : 'Cancelled', activeTicks: row[8], requiredTicks: row[9],
    startedTick: row[10], completedTick: row[11], resultEventId: id(row[12], 'event'), blockedReason: null, phase: row[7] === 0 ? 'Done' : 'Cancelled',
    worksiteId: optionalId(row[13], 'entity'), storageId: optionalId(row[14], 'entity'), navigation: emptyNavigation() },
  reservation: { reservationId, ownerTransactionId: transactionId, state: row[7] === 0 ? 'committed' : 'released', lines } } as ArchivedProduction;
}
function encodeReceipt(receipt: CommandReceipt, intern: (value: string) => StringToken): PackedHistoryRow {
  const result = receipt.result;
  if (!exact(receipt, ['commandId', 'fingerprint', 'result']) || !exact(result, resultKeys)
    || (result.transactionId !== null && !packableId(result.transactionId, 'instance'))) return freeze([1, receipt.commandId, cloneJson(receipt) as unknown as JsonValue]);
  return freeze([0, receipt.commandId, intern(receipt.fingerprint), result.status === 'accepted' ? 0 : 1,
    optionalIdNumber(result.transactionId, 'instance'), result.eventIds.map(eventId => idNumber(eventId, 'event')),
    cloneJson(result.rejection) as unknown as JsonValue]);
}
function decodeReceipt(row: PackedHistoryRow, strings: readonly string[]): CommandReceipt {
  if (row[0] === 1) {
    if (row.length !== 3 || !object(row[2]) || row[1] !== row[2].commandId) invalid('raw receipt row');
    return cloneJson(row[2]) as unknown as CommandReceipt;
  }
  if (row[0] !== 0 || row.length !== 7 || typeof row[1] !== 'string' || ![0, 1].includes(row[3] as number) || !Array.isArray(row[5])) invalid('packed receipt row');
  return { commandId: row[1], fingerprint: stringAt(strings, row[2]), result: { commandId: row[1], status: row[3] === 0 ? 'accepted' : 'rejected',
    transactionId: optionalId(row[4], 'instance'), eventIds: row[5].map(value => id(value, 'event')), rejection: cloneJson(row[6]) } } as CommandReceipt;
}
function encodeEvent(event: DomainEvent, intern: (value: string) => StringToken): PackedHistoryRow {
  const kind = productionKinds.indexOf(event.kind as typeof productionKinds[number]); const payload = event.payload;
  if (!exact(event, eventKeys) || kind < 0 || (event.parentEventId !== null && !packableId(event.parentEventId, 'event'))
    || !exact(payload, kind === 3 ? ['transactionId', 'reason'] : ['transactionId', 'recipeId', 'workerId'])
    || !packableId(payload.transactionId, 'instance')
    || (kind === 3 ? typeof payload.reason !== 'string' : typeof payload.recipeId !== 'string' || !packableId(payload.workerId, 'entity'))) {
    return freeze([1, event.eventId, cloneJson(event) as unknown as JsonValue]);
  }
  const common: JsonValue[] = [0, idNumber(event.eventId, 'event'), event.tick, idNumber(event.rootActionId, 'action'),
    optionalIdNumber(event.parentEventId, 'event'), kind, idNumber(payload.transactionId, 'instance')];
  return freeze(kind === 3 ? [...common, intern(payload.reason as string)]
    : [...common, intern(payload.recipeId as string), idNumber(payload.workerId, 'entity')]);
}
function decodeEvent(row: PackedHistoryRow, strings: readonly string[]): DomainEvent {
  if (row[0] === 1) {
    if (row.length !== 3 || !object(row[2]) || row[1] !== row[2].eventId) invalid('raw event row');
    return cloneJson(row[2]) as unknown as DomainEvent;
  }
  if (row[0] !== 0 || !integer(row[5]) || row[5] > 3 || row.length !== (row[5] === 3 ? 8 : 9)) invalid('packed event row');
  const transactionId = id(row[6], 'instance');
  return { eventId: id(row[1], 'event'), kind: productionKinds[row[5]]!, tick: row[2], rootActionId: id(row[3], 'action'),
    parentEventId: optionalId(row[4], 'event'), payload: row[5] === 3 ? { transactionId, reason: stringAt(strings, row[7]) }
      : { transactionId, recipeId: stringAt(strings, row[7]), workerId: id(row[8], 'entity') } } as DomainEvent;
}

function validateAndIndex(value: unknown, clonedPlainJson = false): { archive: HistoryArchive; index: Indexes } {
  // The wire envelope adds page/row nesting around already bounded record values.
  if (!clonedPlainJson) assertJson(value, 56);
  if (!exact(value, ['schemaVersion', 'codecVersion', 'strings', 'production', 'commandReceipts', 'events'])
    || value.schemaVersion !== 1 || value.codecVersion !== 1 || !Array.isArray(value.strings) || value.strings.length > HISTORY_STRING_POOL_SIZE
    || !value.strings.every(item => typeof item === 'string') || new Set(value.strings).size !== value.strings.length) invalid('archive envelope');
  for (const key of ['production', 'commandReceipts', 'events']) {
    const table = value[key];
    if (!exact(table, ['count', 'pages']) || !integer(table.count) || table.count > MAX_HISTORY_RECORDS_PER_TABLE || !Array.isArray(table.pages)
      || table.pages.length !== Math.ceil(table.count / HISTORY_PAGE_SIZE)) invalid('table shape');
    for (let index = 0; index < table.pages.length; index += 1) {
      const page = table.pages[index];
      if (!Array.isArray(page) || page.length !== (index === table.pages.length - 1 ? ((table.count - 1) % HISTORY_PAGE_SIZE) + 1 : HISTORY_PAGE_SIZE)
        || !page.every(Array.isArray)) invalid('page shape');
    }
  }
  const archive = value as unknown as HistoryArchive;
  const index: Indexes = { production: emptyBuckets(), reservations: emptyBuckets(), commandReceipts: emptyBuckets(), events: emptyBuckets(), expandedCharacters: 0, expandedNodes: 0 };
  const account = (record: unknown) => {
    const measured = measureDecodedJson(record);
    index.expandedCharacters += measured.characters;
    index.expandedNodes += measured.nodes + 32;
    if (index.expandedCharacters > MAX_HISTORY_EXPANDED_CHARACTERS || index.expandedNodes > MAX_HISTORY_EXPANDED_NODES) invalid('decoded history exceeds limit');
  };
  // Build mutable local bucket maps once; these maps never escape this module.
  const add = (buckets: Buckets, key: string, row: PackedHistoryRow) => {
    const bucket = buckets[hashText(key) % INDEX_BUCKETS] as Map<string, PackedHistoryRow>;
    if (bucket.has(key)) invalid('duplicate record ID'); bucket.set(key, row);
  };
  for (const row of rows(archive.production)) {
    const record = decodeProduction(row, archive.strings); assertProduction(record); account(record);
    add(index.production, record.transaction.transactionId, row); add(index.reservations, record.reservation.reservationId, row);
  }
  for (const key of index.production.flatMap(bucket => [...bucket.keys()])) if (get(index.reservations, key)) invalid('transaction/reservation ID collision');
  for (const row of rows(archive.commandReceipts)) { const record = decodeReceipt(row, archive.strings); assertReceipt(record); account(record); add(index.commandReceipts, record.commandId, row); }
  for (const row of rows(archive.events)) { const record = decodeEvent(row, archive.strings); assertEvent(record); account(record); add(index.events, record.eventId, row); }
  return { archive, index };
}
function own(archive: HistoryArchive): HistoryArchive { return sealed.has(archive) ? archive : restoreHistoryArchive(archive); }
function indexFor(archive: HistoryArchive): Indexes { return indexes.get(archive) ?? invalid('unowned archive'); }
function seal(archive: HistoryArchive, index: Indexes): HistoryArchive { freeze(archive); sealed.add(archive); indexes.set(archive, index); return archive; }

export function createHistoryArchive(): HistoryArchive {
  return seal({ schemaVersion: 1, codecVersion: 1, strings: [], production: emptyTable(), commandReceipts: emptyTable(), events: emptyTable() },
    { production: emptyBuckets(), reservations: emptyBuckets(), commandReceipts: emptyBuckets(), events: emptyBuckets(), expandedCharacters: 0, expandedNodes: 0 });
}
/** Structural/codec validation only. World owns content, clock and cross-domain references. */
export function validateHistoryArchive(value: unknown): string[] {
  try { validateAndIndex(value); return []; } catch (error) { return [error instanceof Error ? error.message : 'Invalid history archive']; }
}
/** Import once to obtain owned immutable pages and indexed O(1) record queries. */
export function restoreHistoryArchive(value: unknown): HistoryArchive {
  if (value !== null && typeof value === 'object' && sealed.has(value as HistoryArchive)) return value as HistoryArchive;
  const cloned = inspectJson(value, 56, true).value;
  const checked = validateAndIndex(cloned, true);
  return seal(checked.archive, checked.index);
}
/** Batch migration avoids publishing intermediate archives. Inputs remain caller-owned. */
export function appendHistoryBatch(input: HistoryArchive, batch: HistoryAppendBatch): HistoryArchive {
  const archive = own(input); let index = indexFor(archive);
  const strings = [...archive.strings]; const intern = pool(strings);
  let production = archive.production; let commandReceipts = archive.commandReceipts; let events = archive.events;
  const account = (record: unknown) => {
    const measured = inspectJson(record, 48, false);
    const expandedCharacters = index.expandedCharacters + measured.characters;
    const expandedNodes = index.expandedNodes + measured.nodes + 32;
    if (expandedCharacters > MAX_HISTORY_EXPANDED_CHARACTERS || expandedNodes > MAX_HISTORY_EXPANDED_NODES) invalid('decoded history exceeds limit');
    index = { ...index, expandedCharacters, expandedNodes };
  };
  for (const record of batch.production ?? []) {
    assertJson(record); assertProduction(record);
    const key = record.transaction.transactionId; const reservationId = record.reservation.reservationId;
    const existing = get(index.production, key);
    if (existing) { if (!same(decodeProduction(existing, strings), record)) invalid('conflicting production ID'); continue; }
    if (get(index.reservations, reservationId) || get(index.production, reservationId) || get(index.reservations, key)) invalid('production ownership collision');
    account(record);
    const row = encodeProduction(record, intern); production = appendRow(production, row);
    index = { ...index, production: put(index.production, key, row), reservations: put(index.reservations, reservationId, row) };
  }
  for (const receipt of batch.commandReceipts ?? []) {
    assertJson(receipt); assertReceipt(receipt);
    const existing = get(index.commandReceipts, receipt.commandId);
    if (existing) { if (!same(decodeReceipt(existing, strings), receipt)) invalid('conflicting command ID'); continue; }
    account(receipt);
    const row = encodeReceipt(receipt, intern); commandReceipts = appendRow(commandReceipts, row);
    index = { ...index, commandReceipts: put(index.commandReceipts, receipt.commandId, row) };
  }
  for (const event of batch.events ?? []) {
    assertJson(event); assertEvent(event);
    const existing = get(index.events, event.eventId);
    if (existing) { if (!same(decodeEvent(existing, strings), event)) invalid('conflicting event ID'); continue; }
    account(event);
    const row = encodeEvent(event, intern); events = appendRow(events, row);
    index = { ...index, events: put(index.events, event.eventId, row) };
  }
  if (production === archive.production && commandReceipts === archive.commandReceipts && events === archive.events) return archive;
  return seal({ schemaVersion: 1, codecVersion: 1, strings, production, commandReceipts, events }, index);
}
export function appendArchivedProduction(archive: HistoryArchive, transaction: ProductionTransaction, reservation: Reservation): HistoryArchive {
  return appendHistoryBatch(archive, { production: [{ transaction, reservation }] });
}
export function appendArchivedCommandReceipt(archive: HistoryArchive, receipt: CommandReceipt): HistoryArchive { return appendHistoryBatch(archive, { commandReceipts: [receipt] }); }
export function appendArchivedEvent(archive: HistoryArchive, event: DomainEvent): HistoryArchive { return appendHistoryBatch(archive, { events: [event] }); }
export function lookupArchivedProduction(input: HistoryArchive, transactionId: string): ArchivedProduction | null {
  const archive = own(input); const row = get(indexFor(archive).production, transactionId); return row ? decodeProduction(row, archive.strings) : null;
}
/** Constant-time on owned archives; imported mutable data is authenticated before accounting.
 * Expanded characters are canonical UTF-16 units; nodes include 32 safety units per record. */
export function getHistoryArchiveUsage(input: HistoryArchive): Readonly<{ productionCount: number; commandReceiptCount: number; eventCount: number; expandedCharacters: number; expandedNodes: number }> {
  const archive = own(input); const index = indexFor(archive);
  return { productionCount: archive.production.count, commandReceiptCount: archive.commandReceipts.count, eventCount: archive.events.count,
    expandedCharacters: index.expandedCharacters, expandedNodes: index.expandedNodes };
}
export function lookupArchivedCommandReceipt(input: HistoryArchive, commandId: string): CommandReceipt | null {
  const archive = own(input); const row = get(indexFor(archive).commandReceipts, commandId); return row ? decodeReceipt(row, archive.strings) : null;
}
export function lookupArchivedEvent(input: HistoryArchive, eventId: string): DomainEvent | null {
  const archive = own(input); const row = get(indexFor(archive).events, eventId); return row ? decodeEvent(row, archive.strings) : null;
}
/** Original append order, independent of tick/ID sorting. Offset is an archive ordinal. */
export function readArchivedEvents(input: HistoryArchive, offset = 0, limit = HISTORY_PAGE_SIZE): DomainEvent[] {
  if (!integer(offset) || !integer(limit) || limit > MAX_HISTORY_RECORDS_PER_TABLE) invalid('event page request');
  const archive = own(input); const end = Math.min(archive.events.count, offset + limit); const result: DomainEvent[] = [];
  for (let ordinal = offset; ordinal < end; ordinal += 1) {
    const row = archive.events.pages[Math.floor(ordinal / HISTORY_PAGE_SIZE)]![ordinal % HISTORY_PAGE_SIZE]!;
    result.push(decodeEvent(row, archive.strings));
  }
  return result;
}
/** Streaming detached records, preserving archive append order and owned-page indexes. */
export function* iterateArchivedProduction(input: HistoryArchive): IterableIterator<ArchivedProduction> {
  const archive = own(input);
  for (const row of rows(archive.production)) yield decodeProduction(row, archive.strings);
}
export function* iterateArchivedCommandReceipts(input: HistoryArchive): IterableIterator<CommandReceipt> {
  const archive = own(input);
  for (const row of rows(archive.commandReceipts)) yield decodeReceipt(row, archive.strings);
}
export function* iterateArchivedEvents(input: HistoryArchive): IterableIterator<DomainEvent> {
  const archive = own(input);
  for (const row of rows(archive.events)) yield decodeEvent(row, archive.strings);
}
/** Linear streaming semantic-validation seam; never reconstruct a combined full history map. */
export function visitArchivedRecords(input: HistoryArchive, visitors: HistoryVisitors): void {
  const archive = own(input);
  if (visitors.production) for (const row of rows(archive.production)) visitors.production(decodeProduction(row, archive.strings));
  if (visitors.commandReceipt) for (const row of rows(archive.commandReceipts)) visitors.commandReceipt(decodeReceipt(row, archive.strings));
  if (visitors.event) { let ordinal = 0; for (const row of rows(archive.events)) visitors.event(decodeEvent(row, archive.strings), ordinal++); }
}
