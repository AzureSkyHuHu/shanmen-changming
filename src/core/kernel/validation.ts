import { RESOURCE_IDS, type ResourceLine } from '../economy/types';
import { getRecipe } from '../economy/recipes';
import { CONTENT_VERSION, SIMULATION_VERSION } from '../world/create-world';
import { MAX_DISCIPLES, type WorldState } from '../world/types';
import { CALENDAR_TICKS_PER_MONTH, PAUSE_REASONS } from './clock';
import { isCommand } from './commands';
import { isNonNegativeInteger } from './numeric';
import { RANDOM_ALGORITHM, RANDOM_STREAM_NAMES } from './random';
import { canonicalStringify } from './serialization';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const list = (value: unknown): value is unknown[] => Array.isArray(value);
const finiteInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const unique = (values: unknown[]): boolean => new Set(values).size === values.length;
const idNumber = (id: unknown, kind: string): number | null => {
  if (typeof id !== 'string' || !new RegExp(`^${kind}:[1-9][0-9]*$`).test(id)) return null;
  const value = Number(id.slice(kind.length + 1));
  return Number.isSafeInteger(value) ? value : null;
};
const linesValid = (value: unknown): value is ResourceLine[] => list(value) && value.every((line) => object(line) && RESOURCE_IDS.includes(line.resourceId as ResourceLine['resourceId']) && isNonNegativeInteger(line.quantity) && line.quantity > 0) && unique(value.map((line) => (line as ObjectValue).resourceId));

/** Full validation for the implemented starter schema. Future domains need explicit schema/version changes. */
export function validateWorldState(value: unknown): string[] {
  const errors: string[] = [];
  const fail = (message: string): string[] => [message];
  if (!object(value)) return fail('World must be an object');
  if (!text(value.seed) || value.simulationVersion !== SIMULATION_VERSION || value.contentVersion !== CONTENT_VERSION) return fail('Unsupported world identity/version');
  const clock = value.clock;
  if (!object(clock) || !isNonNegativeInteger(clock.simulationTick) || !isNonNegativeInteger(clock.calendarTick) || !isNonNegativeInteger(clock.encounterTick) || clock.calendarTick + clock.encounterTick !== clock.simulationTick || !['management', 'combat'].includes(clock.mode as string) || ![1, 3].includes(clock.speed as number) || !list(clock.pauseReasons) || !unique(clock.pauseReasons) || !clock.pauseReasons.every((reason) => PAUSE_REASONS.includes(reason as typeof PAUSE_REASONS[number]))) return fail('Invalid clock');
  const simulationTick = clock.simulationTick;
  const sequences = value.sequences;
  if (!object(sequences) || !['nextEntity', 'nextEvent', 'nextAction', 'nextInstance'].every((key) => isNonNegativeInteger(sequences[key]) && (sequences[key] as number) > 0)) return fail('Invalid sequences');
  const randomStreams = value.randomStreams;
  if (!object(randomStreams) || !RANDOM_STREAM_NAMES.every((name) => {
    const stream = randomStreams[name];
    return object(stream) && stream.algorithm === RANDOM_ALGORITHM && isNonNegativeInteger(stream.state) && stream.state > 0 && stream.state <= 0xffffffff && isNonNegativeInteger(stream.draws);
  })) return fail('Invalid random streams');
  const map = value.map;
  if (!object(map) || !isNonNegativeInteger(map.width) || !isNonNegativeInteger(map.height) || map.width === 0 || map.height === 0 || map.width > 256 || map.height > 256 || map.seed !== value.seed || map.generationVersion !== 1 || !list(map.tiles) || map.tiles.length !== map.width * map.height) return fail('Invalid world map');
  const inMap = (position: unknown): boolean => object(position) && isNonNegativeInteger(position.x) && isNonNegativeInteger(position.y) && position.x < (map.width as number) && position.y < (map.height as number);
  if (!map.tiles.every((tile) => object(tile) && inMap(tile) && ['grass', 'path', 'forest', 'stone', 'water'].includes(tile.terrain as string) && typeof tile.walkable === 'boolean') || !unique(map.tiles.map((tile) => `${(tile as ObjectValue).x}:${(tile as ObjectValue).y}`))) return fail('Invalid map tiles');
  if (!list(value.disciples) || value.disciples.length > MAX_DISCIPLES || !list(value.buildings)) return fail('Invalid entity collections');
  const entityIds: string[] = [];
  for (const disciple of value.disciples) {
    if (!object(disciple) || idNumber(disciple.id, 'entity') === null || !text(disciple.nameKey) || !isNonNegativeInteger(disciple.ageMonths) || !finiteInteger(disciple.birthCalendarTick) || !inMap(disciple.position) || !['alive', 'dead'].includes(disciple.lifeState as string) || typeof disciple.canWork !== 'boolean' || typeof disciple.traveling !== 'boolean' || !isNonNegativeInteger(disciple.aptitude) || disciple.aptitude > 100 || !(disciple.assignmentTransactionId === null || text(disciple.assignmentTransactionId))) return fail('Invalid disciple');
    const lifetimeTicks = clock.calendarTick - disciple.birthCalendarTick;
    if (!isNonNegativeInteger(lifetimeTicks)) return fail('Invalid disciple birth calendar tick');
    const chronologicalAgeMonths = Math.floor(lifetimeTicks / CALENDAR_TICKS_PER_MONTH);
    // Living ages must match their birth timestamp. Dead disciples retain age at death.
    if (disciple.lifeState === 'alive' ? disciple.ageMonths !== chronologicalAgeMonths : disciple.ageMonths > chronologicalAgeMonths) return fail('Disciple age does not match birth calendar tick');
    entityIds.push(disciple.id as string);
  }
  for (const building of value.buildings) {
    if (!object(building) || idNumber(building.id, 'entity') === null || !text(building.nameKey) || !text(building.blueprintId) || !inMap(building) || typeof building.operational !== 'boolean') return fail('Invalid building');
    entityIds.push(building.id as string);
  }
  if (!unique(entityIds) || entityIds.some((id) => idNumber(id, 'entity')! >= (sequences.nextEntity as number))) return fail('Invalid entity IDs or sequence continuity');
  const inventory = value.inventory;
  if (!object(inventory) || !RESOURCE_IDS.every((id) => {
    const entry = inventory[id];
    return object(entry) && entry.resourceId === id && isNonNegativeInteger(entry.owned) && isNonNegativeInteger(entry.reserved) && isNonNegativeInteger(entry.capacity) && entry.reserved <= entry.owned && entry.owned <= entry.capacity;
  })) return fail('Invalid inventory');
  if (!object(value.reservations) || !object(value.transactions) || !object(value.commandReceipts) || !list(value.pendingCommands) || !value.pendingCommands.every(isCommand)) return fail('Invalid ledgers or command queue');
  const reservedTotals = Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Record<string, number>;
  const instanceIds: string[] = [];
  const originatingCommandIds = new Set<string>();
  for (const [key, reservation] of Object.entries(value.reservations)) {
    if (!object(reservation) || reservation.reservationId !== key || idNumber(key, 'instance') === null || !text(reservation.ownerTransactionId) || !['reserved', 'committed', 'released'].includes(reservation.state as string) || !linesValid(reservation.lines)) return fail('Invalid reservation');
    instanceIds.push(key);
    if (reservation.state === 'reserved') for (const line of reservation.lines) reservedTotals[line.resourceId] = reservedTotals[line.resourceId]! + line.quantity;
  }
  for (const id of RESOURCE_IDS) if (reservedTotals[id] !== (inventory[id] as ObjectValue).reserved) return fail('Reservation totals do not match inventory');
  for (const [key, transaction] of Object.entries(value.transactions)) {
    if (!object(transaction) || transaction.transactionId !== key || idNumber(key, 'instance') === null || idNumber(transaction.rootActionId, 'action') === null || !text(transaction.commandId) || !text(transaction.recipeId) || !getRecipe(transaction.recipeId) || !text(transaction.workerId) || !text(transaction.reservationId) || !['Running', 'Blocked', 'Committed', 'Cancelled'].includes(transaction.state as string) || !isNonNegativeInteger(transaction.activeTicks) || !isNonNegativeInteger(transaction.requiredTicks) || transaction.requiredTicks !== getRecipe(transaction.recipeId)!.workTicks || transaction.activeTicks > transaction.requiredTicks || !isNonNegativeInteger(transaction.startedTick) || transaction.startedTick > clock.simulationTick || !(transaction.completedTick === null || isNonNegativeInteger(transaction.completedTick) && transaction.completedTick >= transaction.startedTick && transaction.completedTick <= clock.simulationTick) || !(transaction.resultEventId === null || text(transaction.resultEventId)) || ![null, 'CAPACITY_EXCEEDED'].includes(transaction.blockedReason as null | string)) return fail('Invalid production transaction');
    instanceIds.push(key);
    if (idNumber(transaction.rootActionId, 'action')! >= (sequences.nextAction as number)) return fail('Invalid action sequence continuity');
    const reservation = value.reservations[transaction.reservationId];
    const worker = value.disciples.find((disciple) => object(disciple) && disciple.id === transaction.workerId);
    if (!object(reservation) || reservation.ownerTransactionId !== key || !object(worker)) return fail('Invalid transaction references');
    const active = transaction.state === 'Running' || transaction.state === 'Blocked';
    if (active && (reservation.state !== 'reserved' || worker.assignmentTransactionId !== key || transaction.completedTick !== null || transaction.resultEventId !== null)) return fail('Invalid active transaction ownership');
    if (!active && (transaction.completedTick === null || transaction.resultEventId === null || reservation.state !== (transaction.state === 'Committed' ? 'committed' : 'released'))) return fail('Invalid completed transaction settlement');
    if (transaction.state === 'Committed' && transaction.activeTicks !== transaction.requiredTicks) return fail('Incomplete transaction marked committed');
    if ((transaction.state === 'Blocked') !== (transaction.blockedReason === 'CAPACITY_EXCEEDED')) return fail('Invalid blocked reason');
    const recipe = getRecipe(transaction.recipeId)!;
    if (canonicalStringify(reservation.lines) !== canonicalStringify(recipe.inputs)) return fail('Reservation does not match locked recipe inputs');
    if (originatingCommandIds.has(transaction.commandId)) return fail('Duplicate transaction originating command ID');
    originatingCommandIds.add(transaction.commandId);
    const receipt = Object.hasOwn(value.commandReceipts, transaction.commandId) ? value.commandReceipts[transaction.commandId] : undefined;
    const expectedFingerprint = canonicalStringify({ kind: 'production.start', payload: { recipeId: transaction.recipeId, workerId: transaction.workerId } });
    if (!object(receipt) || receipt.commandId !== transaction.commandId || receipt.fingerprint !== expectedFingerprint || !object(receipt.result) || receipt.result.commandId !== transaction.commandId || receipt.result.status !== 'accepted' || receipt.result.transactionId !== key || receipt.result.rejection !== null) return fail('Transaction is missing its matching originating command receipt');
  }
  if (!unique(instanceIds) || instanceIds.some((id) => idNumber(id, 'instance')! >= (sequences.nextInstance as number))) return fail('Invalid instance sequence continuity');
  for (const [reservationId, reservation] of Object.entries(value.reservations)) {
    if (!object(reservation) || typeof reservation.ownerTransactionId !== 'string' || !Object.hasOwn(value.transactions, reservation.ownerTransactionId)) return fail('Orphaned reservation');
    const owner = value.transactions[reservation.ownerTransactionId];
    if (!object(owner) || owner.reservationId !== reservationId) return fail('Reservation ownership is not bidirectional');
    const expectedState = owner.state === 'Committed' ? 'committed' : owner.state === 'Cancelled' ? 'released' : 'reserved';
    if (reservation.state !== expectedState) return fail('Reservation state does not match its owning transaction');
  }
  for (const disciple of value.disciples) {
    if (object(disciple) && disciple.assignmentTransactionId !== null) {
      const transaction = value.transactions[disciple.assignmentTransactionId as string];
      if (!object(transaction) || transaction.workerId !== disciple.id || !['Running', 'Blocked'].includes(transaction.state as string)) return fail('Invalid disciple assignment');
    }
  }
  if (!list(value.events)) return fail('Invalid events');
  const eventIds: string[] = [];
  for (const event of value.events) {
    if (!object(event) || idNumber(event.eventId, 'event') === null || !['production.started', 'production.committed', 'production.cancelled', 'production.blocked'].includes(event.kind as string) || !isNonNegativeInteger(event.tick) || event.tick > clock.simulationTick || idNumber(event.rootActionId, 'action') === null || !(event.parentEventId === null || text(event.parentEventId)) || !object(event.payload)) return fail('Invalid event');
    eventIds.push(event.eventId as string);
    if (idNumber(event.eventId, 'event')! >= (sequences.nextEvent as number) || idNumber(event.rootActionId, 'action')! >= (sequences.nextAction as number)) return fail('Invalid event sequence continuity');
  }
  if (!unique(eventIds)) return fail('Duplicate event IDs');
  for (const transaction of Object.values(value.transactions)) if (object(transaction) && transaction.resultEventId !== null && !eventIds.includes(transaction.resultEventId as string)) return fail('Missing settlement event');
  for (const event of value.events) if (object(event) && event.parentEventId !== null && !eventIds.includes(event.parentEventId as string)) return fail('Missing parent event');
  for (const [key, receipt] of Object.entries(value.commandReceipts)) {
    if (!object(receipt) || receipt.commandId !== key || typeof receipt.fingerprint !== 'string' || receipt.fingerprint.length === 0 || receipt.fingerprint.length > 2048 || !object(receipt.result) || receipt.result.commandId !== key || !['accepted', 'rejected'].includes(receipt.result.status as string) || !list(receipt.result.eventIds) || !receipt.result.eventIds.every((id) => typeof id === 'string' && eventIds.includes(id))) return fail('Invalid command receipt');
    const result = receipt.result;
    if (result.status === 'accepted' && (typeof result.transactionId !== 'string' || !Object.hasOwn(value.transactions, result.transactionId) || result.rejection !== null)) return fail('Invalid accepted receipt');
    if (result.status === 'rejected' && (result.transactionId !== null || !object(result.rejection) || !text(result.rejection.code))) return fail('Invalid rejected receipt');
  }
  if (!list(value.unlocks) || !value.unlocks.every(text) || !unique(value.unlocks) || !list(value.diagnostics) || !value.diagnostics.every((diagnostic) => object(diagnostic) && diagnostic.code === 'INVARIANT_FAILURE' && isNonNegativeInteger(diagnostic.tick) && diagnostic.tick <= simulationTick && typeof diagnostic.message === 'string')) return fail('Invalid unlocks or diagnostics');
  return errors;
}

export function isWorldState(value: unknown): value is WorldState { return validateWorldState(value).length === 0; }
