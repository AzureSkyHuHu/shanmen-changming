import { expandDeceasedCultivator, type CultivationState as CultivationStateV3 } from '../cultivation/v3';
import type { CultivationState } from '../cultivation/types';
import { cardinalDistance, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import { automaticCycle } from '../economy/automatic-production';
import type { AutomaticProductionState } from '../economy/automatic-types';
import { PRODUCTION_BLOCKED_REASONS, PRODUCTION_PHASES, RESOURCE_IDS, type ResourceId, type ResourceLine } from '../economy/types';
import { getRecipe, LEGACY_V4_RECIPE_IDS } from '../economy/recipes';
import { iterateArchivedProduction, type HistoryArchive } from '../history';
import { buildOwnedInstanceIds } from '../world/validate-progression';
import { isNonNegativeInteger } from './numeric';
import { canonicalStringify } from './serialization';

type ObjectValue = Record<string, unknown>;
const LEGACY_RECIPE_IDS: ReadonlySet<string> = new Set(LEGACY_V4_RECIPE_IDS);
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const list = (value: unknown): value is unknown[] => Array.isArray(value);
const unique = (values: unknown[]): boolean => new Set(values).size === values.length;
const ID_PATTERNS = { instance: /^instance:[1-9][0-9]*$/, action: /^action:[1-9][0-9]*$/ };
const idNumber = (id: unknown, kind: keyof typeof ID_PATTERNS): number | null => {
  if (typeof id !== 'string' || !ID_PATTERNS[kind].test(id)) return null;
  const value = Number(id.slice(kind.length + 1));
  return Number.isSafeInteger(value) ? value : null;
};
const linesValid = (value: unknown): value is ResourceLine[] => list(value) && value.every((line) => object(line) && RESOURCE_IDS.includes(line.resourceId as ResourceLine['resourceId']) && isNonNegativeInteger(line.quantity) && line.quantity > 0) && unique(value.map((line) => (line as ObjectValue).resourceId));

/** Internal record grammar, independent of a World/save identity. These names describe
 * the fixed old production rules; selecting one never authenticates a World version. */
export type WorldEconomyRecordProtocol = 'initial-production' | 'navigation-production' | 'build-production' | 'sect-economy-production' | 'automatic-production';
/** @internal Only a selected World root may assemble this after its existing prefix checks.
 * This is neither an unknown-to-World parser nor an admission/publication certificate.
 * Domain cultivation/progression and archive restoration must already have succeeded.
 * Keep source reads lazy: the frozen public validators retain their descriptor semantics.
 * Inspect and close synchronously on one unchanged candidate; never cache stage tokens. */
export interface WorldEconomyRecordContext {
  readonly source: ObjectValue;
  readonly protocol: WorldEconomyRecordProtocol;
  readonly map: ObjectValue;
  readonly clock: ObjectValue;
  readonly sequences: ObjectValue;
  readonly inventory: ObjectValue;
  readonly cultivation: CultivationState | CultivationStateV3 | null;
  readonly automatic: AutomaticProductionState | null;
  readonly archive: HistoryArchive | null;
  readonly archivedIdentities: readonly unknown[];
  readonly campaignPaymentIds: readonly string[];
}
const inspectedRecords: unique symbol = Symbol('inspected World economy records');
const closedOwnerLinks: unique symbol = Symbol('closed World economy owner links');
export interface WorldEconomyRecords {
  readonly [inspectedRecords]: true;
  /** Record arithmetic only. Owner links and whole-World totals are separate obligations. */
  readonly reservedTotals: Readonly<Record<ResourceId, number>>;
  readonly originatingCommands: ReadonlyMap<string, { readonly transactionId: string; readonly fingerprint: string }>;
  readonly transactionIds: ReadonlySet<string>;
  readonly manualRootActions: ReadonlySet<string>;
  readonly settlementEventIds: ReadonlySet<string>;
  readonly liveReceipts: ObjectValue;
  readonly liveEvents: unknown;
}
export interface WorldEconomyOwnerClaims {
  readonly [closedOwnerLinks]: true;
  /** Derived only from inspected old reservations and their exact owner links. This is
   * not proof that inventory.reserved is closed against every selected World domain. */
  readonly reservedTotals: Readonly<Record<ResourceId, number>>;
}
export type WorldEconomyRecordResult = { readonly ok: true; readonly records: WorldEconomyRecords }
  | { readonly ok: false; readonly errors: string[] };
export type WorldEconomyOwnerResult = { readonly ok: true; readonly claims: WorldEconomyOwnerClaims }
  | { readonly ok: false; readonly errors: string[] };
interface OwnerClosureEvidence {
  readonly context: WorldEconomyRecordContext;
  readonly liveTransactions: ObjectValue;
  readonly liveReservations: ObjectValue;
  readonly transactionIds: Set<string>;
  readonly reservedTotals: Readonly<Record<ResourceId, number>>;
}
// In-memory stage tokens cannot be reconstructed from JSON, caller totals or type assertions.
const ownerEvidence = new WeakMap<WorldEconomyRecords, OwnerClosureEvidence>();
function evidenceFor(records: WorldEconomyRecords): OwnerClosureEvidence {
  const evidence = ownerEvidence.get(records);
  if (!evidence) throw new TypeError('World economy records were not inspected');
  return evidence;
}

/** @internal Structural/semantic production record pass in frozen first-error order.
 * Success deliberately does NOT validate a World: exact reservation closure, events,
 * receipts, other domains and selected-version capacity still belong to its root. */
export function inspectWorldEconomyRecords(context: WorldEconomyRecordContext): WorldEconomyRecordResult {
  const { map, clock, sequences, cultivation, automatic, archive, archivedIdentities, campaignPaymentIds } = context;
  // These collection shapes were checked by the selected root before domain validation.
  const value = context.source as ObjectValue & { transactions: ObjectValue; reservations: ObjectValue; commandReceipts: ObjectValue; disciples: unknown[]; buildings: unknown[] };
  const legacy = context.protocol === 'initial-production';
  const hasAutomatic = context.protocol === 'automatic-production';
  const hasEconomy = context.protocol === 'sect-economy-production' || hasAutomatic;
  const hasProgression = context.protocol === 'build-production' || hasEconomy;
  const fail = (message: string): WorldEconomyRecordResult => ({ ok: false, errors: [message] });
  const inMap = (position: unknown): boolean => object(position) && isNonNegativeInteger(position.x) && isNonNegativeInteger(position.y) && position.x < (map.width as number) && position.y < (map.height as number);
  const liveTransactions: ObjectValue = { ...value.transactions };
  const liveReservations: ObjectValue = { ...value.reservations };
  if (automatic) for (const [key, pair] of Object.entries(automatic.live)) {
    if (Object.hasOwn(liveTransactions, key) || Object.hasOwn(liveReservations, pair.reservation.reservationId)) return fail('Automatic live ledger collision');
    liveTransactions[key] = pair.transaction; liveReservations[pair.reservation.reservationId] = pair.reservation;
  }
  const liveReceipts = value.commandReceipts;
  // Decode each immutable production pair only once. Semantic references below
  // retain IDs/fingerprints, never an expanded archive map.
  function* productionPairs(): Generator<[string, unknown, unknown, boolean]> {
    for (const [key, transaction] of Object.entries(liveTransactions)) {
      const reservation = object(transaction) && typeof transaction.reservationId === 'string'
        ? liveReservations[transaction.reservationId] : undefined;
      yield [key, transaction, reservation, false];
    }
    if (archive) for (const entry of iterateArchivedProduction(archive)) {
      yield [entry.transaction.transactionId, entry.transaction, entry.reservation, true];
    }
  }
  const liveEvents = value.events;
  const reservedTotals = Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Record<ResourceId, number>;
  const instanceIds: string[] = [...campaignPaymentIds];
  const originatingCommands = new Map<string, { transactionId: string; fingerprint: string }>();
  const transactionIds = new Set<string>();
  const manualRootActions = new Set<string>();
  const settlementEventIds = new Set<string>();
  const recipeInputFingerprints = new Map<string, string>();
  const validateReservation = (key: string, reservation: unknown): boolean => {
    if (!object(reservation) || reservation.reservationId !== key || idNumber(key, 'instance') === null || !text(reservation.ownerTransactionId) || !['reserved', 'committed', 'released'].includes(reservation.state as string) || !linesValid(reservation.lines)) return false;
    instanceIds.push(key);
    if (reservation.state === 'reserved') for (const line of reservation.lines) reservedTotals[line.resourceId] = reservedTotals[line.resourceId]! + line.quantity;
    return true;
  };
  for (const [key, reservation] of Object.entries(liveReservations)) {
    if (!validateReservation(key, reservation)) return fail('Invalid reservation');
  }
  if (cultivation) {
    for (const a of cultivation.attempts) {
      instanceIds.push(a.attemptId, a.reservation.reservationId);
      if (a.sample) instanceIds.push(a.sample.sampleId);
      if (a.reservation.state === 'reserved') for (const line of a.reservation.lines) reservedTotals[line.resourceId] = reservedTotals[line.resourceId]! + line.quantity;
    }
    for (const d of [...cultivation.disciples, ...(cultivation.schemaVersion === 3 ? cultivation.archivedDisciples.map(expandDeceasedCultivator) : [])]) {
      instanceIds.push(...d.talents.map((talent) => talent.sourceInstanceId));
      if (d.teaching) instanceIds.push(d.teaching.teachingId);
      instanceIds.push(...d.knowledge.flatMap((knowledge) => knowledge.teachingId ? [knowledge.teachingId] : []));
    }
    instanceIds.push(...[...cultivation.pendingDeaths, ...cultivation.deaths].map((death) => death.deathId).filter((id) => id.startsWith('instance:')));
  }
  if (hasProgression) instanceIds.push(...buildOwnedInstanceIds(value as unknown as Parameters<typeof buildOwnedInstanceIds>[0]));
  for (const [key, transaction, reservation, archived] of productionPairs()) {
    if (archived && (!object(reservation) || typeof reservation.reservationId !== 'string' || !validateReservation(reservation.reservationId, reservation))) return fail('Invalid reservation');
    const autoCycle = hasAutomatic ? automaticCycle(key) : null;
    if (!object(transaction) || transaction.transactionId !== key || (autoCycle === null && idNumber(key, 'instance') === null) || idNumber(transaction.rootActionId, 'action') === null || (autoCycle === null && !text(transaction.commandId)) || !text(transaction.recipeId) || !getRecipe(transaction.recipeId) || (!hasEconomy && !LEGACY_RECIPE_IDS.has(transaction.recipeId)) || !text(transaction.workerId) || !text(transaction.reservationId) || !['Running', 'Blocked', 'Committed', 'Cancelled'].includes(transaction.state as string) || !isNonNegativeInteger(transaction.activeTicks) || !isNonNegativeInteger(transaction.requiredTicks) || transaction.requiredTicks !== getRecipe(transaction.recipeId)!.workTicks || transaction.activeTicks > transaction.requiredTicks || !isNonNegativeInteger(transaction.startedTick) || transaction.startedTick > (clock.simulationTick as number) || !(transaction.completedTick === null || isNonNegativeInteger(transaction.completedTick) && transaction.completedTick >= transaction.startedTick && transaction.completedTick <= (clock.simulationTick as number)) || !(transaction.resultEventId === null || text(transaction.resultEventId)) || !(transaction.blockedReason === null || (legacy ? ['CAPACITY_EXCEEDED'] : PRODUCTION_BLOCKED_REASONS).includes(transaction.blockedReason as never))) return fail('Invalid production transaction');
    if (autoCycle === null) { instanceIds.push(key); manualRootActions.add(transaction.rootActionId as string); }
    if (idNumber(transaction.rootActionId, 'action')! >= (sequences.nextAction as number)) return fail('Invalid action sequence continuity');
    const activeWorker = value.disciples.find((disciple) => object(disciple) && disciple.id === transaction.workerId);
    const archivedWorker = archived && archivedIdentities.find((disciple) => object(disciple) && disciple.discipleId === transaction.workerId);
    const worker = activeWorker ?? (object(archivedWorker) ? { id: archivedWorker.discipleId, lifeState: 'dead' } : undefined);
    if (!object(reservation) || reservation.reservationId !== transaction.reservationId || reservation.ownerTransactionId !== key || (!object(worker) && (legacy || transaction.state !== 'Cancelled'))) return fail('Invalid transaction references');
    const active = transaction.state === 'Running' || transaction.state === 'Blocked';
    if (!legacy && (value.activeProductionTransactionIds as string[]).includes(key) !== active) return fail('Active production index does not match transactions');
    if (active && (reservation.state !== 'reserved' || (!object(worker) || worker.assignmentTransactionId !== key) || transaction.completedTick !== null || transaction.resultEventId !== null)) return fail('Invalid active transaction ownership');
    if (!active && (transaction.completedTick === null || transaction.resultEventId === null || reservation.state !== (transaction.state === 'Committed' ? 'committed' : 'released'))) return fail('Invalid completed transaction settlement');
    if (transaction.state === 'Committed' && transaction.activeTicks !== transaction.requiredTicks) return fail('Incomplete transaction marked committed');
    if ((transaction.state === 'Blocked') !== (transaction.blockedReason !== null)) return fail('Invalid blocked reason');
    if (!legacy) {
      if (!PRODUCTION_PHASES.includes(transaction.phase as never) || !(transaction.worksiteId === null || text(transaction.worksiteId)) || !(transaction.storageId === null || text(transaction.storageId))) return fail('Invalid production phase or sites');
      const navigation = transaction.navigation;
      if (!object(navigation) || !list(navigation.path) || navigation.path.length > (map.width as number) * (map.height as number) || !navigation.path.every(inMap) || !(navigation.target === null || inMap(navigation.target)) || !(navigation.routeVersion === null || isNonNegativeInteger(navigation.routeVersion) && navigation.routeVersion <= (map.navVersion as number)) || !isNonNegativeInteger(navigation.movementTicks) || navigation.movementTicks >= MOVEMENT_TICKS_PER_CELL || !isNonNegativeInteger(navigation.retryAtTick)) return fail('Invalid saved navigation');
      const travelingPhase = ['TravellingToWork', 'TravellingToStorage'].includes(transaction.phase as string);
      if (!travelingPhase && (navigation.path.length > 0 || navigation.target !== null || navigation.routeVersion !== null || navigation.movementTicks !== 0 || navigation.retryAtTick !== 0)) return fail('Non-travel job retains a route');
      if (navigation.path.length > 0) {
        if (!object(worker) || !object(worker.position) || navigation.target === null || navigation.routeVersion === null) return fail('Route lacks origin, target or version');
        let previous = worker.position as unknown as { x: number; y: number };
        const routeCells = new Set<string>();
        for (const cell of navigation.path) {
          const position = cell as { x: number; y: number };
          const cellKey = `${position.x}:${position.y}`;
          if (cardinalDistance(previous, position) !== 1 || routeCells.has(cellKey)) return fail('Route contains a non-cardinal step or cycle');
          if (navigation.routeVersion === map.navVersion && !(map.tiles as ObjectValue[]).some((tile) => tile.x === position.x && tile.y === position.y && tile.walkable)) return fail('Current route crosses an impassable cell');
          routeCells.add(cellKey);
          previous = position;
        }
        const target = navigation.target as { x: number; y: number };
        if (previous.x !== target.x || previous.y !== target.y) return fail('Route does not end at its target');
      } else if (navigation.movementTicks !== 0) return fail('Empty route retains movement progress');
      if (transaction.state === 'Committed' ? transaction.phase !== 'Done' : transaction.state === 'Cancelled' ? transaction.phase !== 'Cancelled' : ['Done', 'Cancelled'].includes(transaction.phase as string)) return fail('Transaction state and phase disagree');
      if (['TravellingToStorage', 'AwaitingDelivery', 'Done'].includes(transaction.phase as string) && transaction.activeTicks !== transaction.requiredTicks) return fail('Delivery before completed work');
      if (['TravellingToWork', 'Working'].includes(transaction.phase as string)) {
        if (transaction.worksiteId === null) return fail('Working job lacks assigned station');
        const station = value.buildings.find((building) => object(building) && building.id === transaction.worksiteId);
        if (object(station) && (station.stationTransactionId !== key || station.blueprintId !== getRecipe(transaction.recipeId)!.workstation)) return fail('Worksite seat is not owned by transaction');
        if (transaction.phase === 'Working' && object(station) && object(worker) && object(worker.position) && (worker.position.x !== station.x || worker.position.y !== station.y)) return fail('Work progress is not located at assigned station');
      }
      if (transaction.phase === 'AwaitingDelivery') {
        if (transaction.storageId === null) return fail('Delivery job lacks assigned storage');
        const storage = value.buildings.find((building) => object(building) && building.id === transaction.storageId);
        if (object(storage) && (storage.blueprintId !== 'storage' || !object(worker) || !object(worker.position) || worker.position.x !== storage.x || worker.position.y !== storage.y)) return fail('Delivery is not located at assigned storage');
      }
      if (active && object(worker) && worker.traveling && (!travelingPhase || transaction.state === 'Blocked' || navigation.path.length === 0)) return fail('Worker movement disagrees with job route');
      if (transaction.blockedReason === 'CAPACITY_EXCEEDED' && transaction.phase !== 'AwaitingDelivery') return fail('Capacity block before storage arrival');
    }
    const recipe = getRecipe(transaction.recipeId)!;
    let recipeInputs = recipeInputFingerprints.get(recipe.recipeId);
    if (recipeInputs === undefined) { recipeInputs = canonicalStringify(recipe.inputs); recipeInputFingerprints.set(recipe.recipeId, recipeInputs); }
    if (canonicalStringify(reservation.lines) !== recipeInputs) return fail('Reservation does not match locked recipe inputs');
    if (autoCycle === null) {
      const commandId = transaction.commandId as string;
      if (originatingCommands.has(commandId)) return fail('Duplicate transaction originating command ID');
      originatingCommands.set(commandId, { transactionId: key,
        fingerprint: canonicalStringify({ kind: 'production.start', payload: { recipeId: transaction.recipeId, workerId: transaction.workerId } }) });
    }
    transactionIds.add(key);
    if (transaction.resultEventId !== null) settlementEventIds.add(transaction.resultEventId as string);
  }
  if (automatic && [...Object.values(automatic.live).map((pair) => pair.transaction.rootActionId), ...Object.values(automatic.pins).map((pin) => pin.rootActionId)].some((root) => manualRootActions.has(root))) return fail('Automatic action collides with manual production');
  if (!unique(instanceIds) || instanceIds.some((id) => idNumber(id, 'instance') === null || idNumber(id, 'instance')! >= (sequences.nextInstance as number))) return fail('Invalid instance sequence continuity');
  const totals = Object.freeze(reservedTotals);
  const records: WorldEconomyRecords = Object.freeze({ [inspectedRecords]: true as const, reservedTotals: totals,
    originatingCommands: new Map(originatingCommands), transactionIds: new Set(transactionIds),
    manualRootActions: new Set(manualRootActions), settlementEventIds: new Set(settlementEventIds), liveReceipts, liveEvents });
  ownerEvidence.set(records, { context, liveTransactions, liveReservations, transactionIds, reservedTotals: totals });
  return { ok: true, records };
}

/** @internal Close every old reverse reservation/worker/station edge without accepting any
 * external totals or owner allowances. A future selected World root must derive authenticated
 * claims from each new domain and close the shared inventory itself before publication. */
export function closeWorldEconomyOwnerLinks(records: WorldEconomyRecords): WorldEconomyOwnerResult {
  const { context, liveTransactions, liveReservations, transactionIds, reservedTotals } = evidenceFor(records);
  const value = context.source as ObjectValue & { disciples: unknown[]; buildings: unknown[] };
  const legacy = context.protocol === 'initial-production';
  const fail = (message: string): WorldEconomyOwnerResult => ({ ok: false, errors: [message] });
  // Archive pairs were checked together above. Only independent live reservations
  // need the reverse edge check; a terminal archived owner cannot own a live row.
  for (const [reservationId, reservation] of Object.entries(liveReservations)) {
    if (!object(reservation) || typeof reservation.ownerTransactionId !== 'string' || !transactionIds.has(reservation.ownerTransactionId)) return fail('Orphaned reservation');
    const owner = liveTransactions[reservation.ownerTransactionId];
    if (!object(owner) || owner.reservationId !== reservationId) return fail('Reservation ownership is not bidirectional');
    const expectedState = owner.state === 'Committed' ? 'committed' : owner.state === 'Cancelled' ? 'released' : 'reserved';
    if (reservation.state !== expectedState) return fail('Reservation state does not match its owning transaction');
  }
  for (const disciple of value.disciples) {
    if (object(disciple) && disciple.assignmentTransactionId !== null) {
      const transaction = liveTransactions[disciple.assignmentTransactionId as string];
      if (!object(transaction) || transaction.workerId !== disciple.id || !['Running', 'Blocked'].includes(transaction.state as string)) return fail('Invalid disciple assignment');
    }
  }
  if (!legacy && (value.activeProductionTransactionIds as string[]).some((id) => !Object.hasOwn(liveTransactions, id))) return fail('Active production index references a missing job');
  if (!legacy) for (const building of value.buildings) {
    if (!object(building) || building.stationTransactionId === null) continue;
    const transaction = liveTransactions[building.stationTransactionId as string];
    if (!object(transaction) || transaction.worksiteId !== building.id || !['Running', 'Blocked'].includes(transaction.state as string) || !['TravellingToWork', 'Working'].includes(transaction.phase as string)) return fail('Station ownership is not bidirectional');
  }
  return { ok: true, claims: Object.freeze({ [closedOwnerLinks]: true as const, reservedTotals }) };
}

/** Exact v1-v8 inventory equation first, then reverse owner edges, just as before extraction.
 * No callback, extra-total argument or extension flag exists on this strict legacy boundary. */
export function closeLegacyWorldEconomyReservations(records: WorldEconomyRecords): string[] {
  const { context, reservedTotals } = evidenceFor(records);
  for (const id of RESOURCE_IDS) if (reservedTotals[id] !== (context.inventory[id] as ObjectValue).reserved) return ['Reservation totals do not match inventory'];
  const owners = closeWorldEconomyOwnerLinks(records);
  return owners.ok ? [] : owners.errors;
}
