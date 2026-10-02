/** Frozen pre-extraction validator from candidate3bd4de6f57036e9d03f5164277a7891ac5a8a25e.
 * Source validation.ts SHA-256: 5280c93af12dd7351db1cf37d53652cb8146073061992cb960cd9aac1ccf474a
 * Only relative import paths were redirected. Do not delegate to the extracted record/closure
 * functions: this whole first-error algorithm is the compatibility oracle, not production code.
 */
import type { CommandV8 } from '../../../src/core/kernel/contracts-v8';
import { isCommandV8 } from '../../../src/core/kernel/command-shape-v8';
import { isPlayerCampaignCommand } from '../../../src/core/kernel/../world/campaign-queries';
import type { Command } from '../../../src/core/kernel/contracts';
import { LEGACY_V7_CONTENT } from '../../../src/core/kernel/../../content/registry';
import { getWorldContent } from '../../../src/core/kernel/../world/content-access';
import { inspectWorldProgressionV8 } from '../../../src/core/kernel/../world/validate-progression-v8';
import { validateCultivationFrameV3, expandDeceasedCultivator } from '../../../src/core/kernel/../cultivation/v3';
import type { CultivationState as CultivationStateV3 } from '../../../src/core/kernel/../cultivation/v3';
import type { WorldStateV8 } from '../../../src/core/kernel/../world/v8-types';
import { automaticCycle, isAutomaticJobId } from '../../../src/core/kernel/../economy/automatic-production';
import type { AutomaticProductionState } from '../../../src/core/kernel/../economy/automatic-types';
import { validateAutomaticProductionShape, validateAutomaticProductionReferences } from '../../../src/core/kernel/../world/validate-automatic';
import { iterateArchivedProduction, iterateArchivedCommandReceipts, iterateArchivedEvents, restoreHistoryArchive, type HistoryArchive } from '../../../src/core/kernel/../history';
import { RECENT_WORLD_EVENTS, RECENT_WORLD_RECEIPTS } from '../../../src/core/kernel/../world/history-access';
import { validateSectEconomyState } from '../../../src/core/kernel/../sect-economy/state';
import { projectLegacyWorldV4Controller } from '../../../src/core/kernel/migrate-v4';
import { CULTIVATION_EVENT_KINDS, type CultivationState } from '../../../src/core/kernel/../cultivation/types';
import { validateWorldProgression, buildOwnedInstanceIds } from '../../../src/core/kernel/../world/validate-progression';
import { validateCultivationFrame, validateLegacyCultivationFrameV1 } from '../../../src/core/kernel/../cultivation/validation';
import { cardinalDistance, MOVEMENT_TICKS_PER_CELL } from '../../../src/core/kernel/../agents/navigation';
import { PRODUCTION_BLOCKED_REASONS, PRODUCTION_PHASES, RESOURCE_IDS, type ResourceLine } from '../../../src/core/kernel/../economy/types';
import { getRecipe, LEGACY_V4_RECIPE_IDS } from '../../../src/core/kernel/../economy/recipes';
import { CONTENT_VERSION, SIMULATION_VERSION } from '../../../src/core/kernel/../world/create-world';
import { MAX_DISCIPLES, type WorldState } from '../../../src/core/kernel/../world/types';
import { CALENDAR_TICKS_PER_MONTH, PAUSE_REASONS } from '../../../src/core/kernel/clock';
import { isCommand } from '../../../src/core/kernel/commands';
import { isNonNegativeInteger } from '../../../src/core/kernel/numeric';
import { RANDOM_ALGORITHM, RANDOM_STREAM_NAMES } from '../../../src/core/kernel/random';
import { canonicalStringify } from '../../../src/core/kernel/serialization';

type ObjectValue = Record<string, unknown>;
const LEGACY_RECIPE_IDS: ReadonlySet<string> = new Set(LEGACY_V4_RECIPE_IDS);
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const list = (value: unknown): value is unknown[] => Array.isArray(value);
const finiteInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const unique = (values: unknown[]): boolean => new Set(values).size === values.length;
const ID_PATTERNS = { entity: /^entity:[1-9][0-9]*$/, instance: /^instance:[1-9][0-9]*$/, action: /^action:[1-9][0-9]*$/, event: /^event:[1-9][0-9]*$/ };
const idNumber = (id: unknown, kind: keyof typeof ID_PATTERNS): number | null => {
  if (typeof id !== 'string' || !ID_PATTERNS[kind].test(id)) return null;
  const value = Number(id.slice(kind.length + 1));
  return Number.isSafeInteger(value) ? value : null;
};
const linesValid = (value: unknown): value is ResourceLine[] => list(value) && value.every((line) => object(line) && RESOURCE_IDS.includes(line.resourceId as ResourceLine['resourceId']) && isNonNegativeInteger(line.quantity) && line.quantity > 0) && unique(value.map((line) => (line as ObjectValue).resourceId));

/** Full validation for the implemented starter schema. Future domains need explicit schema/version changes. */
export function validateWorldState(value: unknown): string[] { return validateWorldSchema(value, 7); }
/** Frozen v1 invariants, invoked only after the legacy envelope checksum is checked. */
export function validateLegacyWorldStateV1(value: unknown): string[] { return validateWorldSchema(value, 1); }
export function validateLegacyWorldStateV2(value: unknown): string[] { return validateWorldSchema(value, 2); }
export function validateLegacyWorldStateV3(value: unknown): string[] { return validateWorldSchema(value, 3); }
export function validateLegacyWorldStateV4(value: unknown): string[] { return validateWorldSchema(value, 4); }
export function validateLegacyWorldStateV5(value: unknown): string[] { return validateWorldSchema(value, 5); }
export function validateLegacyWorldStateV6(value: unknown): string[] { return validateWorldSchema(value, 6); }
export function validateLegacyWorldStateV7(value: unknown): string[] { return validateWorldSchema(value, 7); }
/** Additive v8 boundary; not selected by current save/create APIs until admission is ready. */
export function validateWorldStateV8(value: unknown): string[] { return validateWorldSchema(value, 8); }
function validateWorldSchema(value: unknown, version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): string[] {
  const legacy = version === 1;
  const current = version === 7;
  const hasHistory = version >= 6;
  const hasAutomatic = version >= 7;
  const hasEconomy = version >= 5;
  const hasProgression = version >= 4;
  const hasCultivation = version >= 3;
  const hasCampaign = version >= 8;
  const isVersionCommand = (command: unknown): command is CommandV8 => hasCampaign ? isCommandV8(command) : isCommand(command);
  const errors: string[] = [];
  const fail = (message: string): string[] => [message];
  if (!object(value)) return fail('World must be an object');
  if (!text(value.seed) || value.simulationVersion !== (hasCampaign ? '0.8.0' : legacy ? '0.1.1' : version === 2 ? '0.2.0' : current ? '0.7.0' : version === 6 ? '0.6.0' : version === 5 ? '0.5.0' : version === 4 ? '0.4.0' : '0.3.0')) return fail('Unsupported world identity/version');
  if (hasCampaign) { try { getWorldContent(value as unknown as WorldStateV8); } catch { return fail('Unsupported World content identity'); } }
  else if (value.contentVersion !== LEGACY_V7_CONTENT.worldContentVersion) return fail('Unsupported world content version');
  const clock = value.clock;
  if (!object(clock) || !isNonNegativeInteger(clock.simulationTick) || !isNonNegativeInteger(clock.calendarTick) || !isNonNegativeInteger(clock.encounterTick) || clock.calendarTick + clock.encounterTick !== clock.simulationTick || !['management', 'combat'].includes(clock.mode as string) || ![1, 3].includes(clock.speed as number) || !list(clock.pauseReasons) || !unique(clock.pauseReasons) || !clock.pauseReasons.every((reason) => PAUSE_REASONS.includes(reason as typeof PAUSE_REASONS[number]) && (hasAutomatic || reason !== 'save-capacity') && (hasCultivation || reason !== 'cultivation') && (hasProgression || reason !== 'expedition'))) return fail('Invalid clock');
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
  if (!legacy && !isNonNegativeInteger(map.navVersion)) return fail('Invalid navigation map version');
  const inMap = (position: unknown): boolean => object(position) && isNonNegativeInteger(position.x) && isNonNegativeInteger(position.y) && position.x < (map.width as number) && position.y < (map.height as number);
  if (!map.tiles.every((tile) => object(tile) && inMap(tile) && ['grass', 'path', 'forest', 'stone', 'water'].includes(tile.terrain as string) && typeof tile.walkable === 'boolean') || !unique(map.tiles.map((tile) => `${(tile as ObjectValue).x}:${(tile as ObjectValue).y}`))) return fail('Invalid map tiles');
  if (!list(value.disciples) || value.disciples.length > MAX_DISCIPLES || !list(value.buildings)) return fail('Invalid entity collections');
  const entityIds: string[] = [];
  for (const disciple of value.disciples) {
    if (!object(disciple) || idNumber(disciple.id, 'entity') === null || !text(disciple.nameKey) || !isNonNegativeInteger(disciple.ageMonths) || !finiteInteger(disciple.birthCalendarTick) || !inMap(disciple.position) || !(hasCultivation ? ['alive', 'pendingDeath', 'dead'] : ['alive', 'dead']).includes(disciple.lifeState as string) || typeof disciple.canWork !== 'boolean' || typeof disciple.traveling !== 'boolean' || !isNonNegativeInteger(disciple.aptitude) || disciple.aptitude > 100 || !(disciple.assignmentTransactionId === null || text(disciple.assignmentTransactionId))) return fail('Invalid disciple');
    const lifetimeTicks = clock.calendarTick - disciple.birthCalendarTick;
    if (!isNonNegativeInteger(lifetimeTicks)) return fail('Invalid disciple birth calendar tick');
    const chronologicalAgeMonths = Math.floor(lifetimeTicks / CALENDAR_TICKS_PER_MONTH);
    // Living ages must match their birth timestamp. Dead disciples retain age at death.
    if (disciple.lifeState !== 'dead' ? disciple.ageMonths !== chronologicalAgeMonths : disciple.ageMonths > chronologicalAgeMonths) return fail('Disciple age does not match birth calendar tick');
    entityIds.push(disciple.id as string);
    if (hasCampaign && (typeof disciple.presentationId !== 'string' || !/^disciple-[0-3]$/.test(disciple.presentationId))) return fail('Invalid persistent disciple presentation');
  }
  const archivedIdentities = hasCampaign && object(value.legacy) && list(value.legacy.archivedIdentities) ? value.legacy.archivedIdentities : [];
  if (hasCampaign) {
    if (!object(value.legacy) || !list(value.legacy.archivedIdentities)) return fail('Missing deceased identity registry');
    for (const identity of archivedIdentities) {
      if (!object(identity) || idNumber(identity.discipleId, 'entity') === null || !finiteInteger(identity.birthCalendarTick)
        || !isNonNegativeInteger(identity.ageMonths) || Math.floor((clock.calendarTick - identity.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH) < identity.ageMonths) return fail('Invalid deceased chronology');
      entityIds.push(identity.discipleId as string);
    }
  }
  for (const building of value.buildings) {
    if (!object(building) || idNumber(building.id, 'entity') === null || !text(building.nameKey) || !text(building.blueprintId) || !inMap(building) || typeof building.operational !== 'boolean') return fail('Invalid building');
    if (!legacy && !(building.stationTransactionId === null || text(building.stationTransactionId))) return fail('Invalid station ownership');
    entityIds.push(building.id as string);
  }
  if (!unique(entityIds) || entityIds.some((id) => idNumber(id, 'entity')! >= (sequences.nextEntity as number))) return fail('Invalid entity IDs or sequence continuity');
  const inventory = value.inventory;
  if (!object(inventory) || !RESOURCE_IDS.every((id) => {
    const entry = inventory[id];
    return object(entry) && entry.resourceId === id && isNonNegativeInteger(entry.owned) && isNonNegativeInteger(entry.reserved) && isNonNegativeInteger(entry.capacity) && entry.reserved <= entry.owned && entry.owned <= entry.capacity;
  })) return fail('Invalid inventory');
  if (!object(value.reservations) || !object(value.transactions) || !object(value.commandReceipts) || !list(value.pendingCommands) || !value.pendingCommands.every((command) => isVersionCommand(command) && (hasAutomatic || (command.kind !== 'inventory.discard' && (command.kind !== 'production.cancel' || !isAutomaticJobId(command.payload.transactionId)))) && (hasCultivation || command.kind !== 'cultivation.command') && (hasProgression || (command.kind !== 'build.command' && command.kind !== 'expedition.command')) && (hasEconomy || (command.kind !== 'sect-economy.command' && (command.kind !== 'production.start' || LEGACY_RECIPE_IDS.has(command.payload.recipeId)))))) return fail('Invalid ledgers or command queue');
  if (!legacy && (!list(value.activeProductionTransactionIds) || !unique(value.activeProductionTransactionIds) || !value.activeProductionTransactionIds.every(text) || value.activeProductionTransactionIds.length > MAX_DISCIPLES)) return fail('Invalid active production index');
  let cultivation: CultivationState | CultivationStateV3 | null = null;
  if (hasCultivation) {
    if (!object(value.cultivation)) return fail('Missing cultivation authority');
    const cultivationErrors = (hasCampaign ? validateCultivationFrameV3 : hasProgression ? validateCultivationFrame : validateLegacyCultivationFrameV1)({ cultivation: value.cultivation, inventory, randomStreams, sequences });
    if (cultivationErrors.length) return fail(`Invalid cultivation: ${cultivationErrors[0]}`);
    cultivation = value.cultivation as unknown as CultivationState | CultivationStateV3;
    if (cultivation.calendarMonth !== Math.floor(clock.calendarTick / CALENDAR_TICKS_PER_MONTH) || cultivation.disciples.length !== value.disciples.length) return fail('Cultivation calendar/entity projection mismatch');
    for (const profile of cultivation.disciples) {
      const projected = value.disciples.find((d) => object(d) && d.id === profile.discipleId);
      if (!object(projected) || projected.ageMonths !== profile.ageMonths || projected.lifeState !== profile.lifeState || projected.aptitude !== profile.aptitude
        || (profile.lifeState !== 'alive' && projected.canWork !== false)) return fail('Cultivation age/life authority disagrees with World projection');
      const busy = (hasProgression && profile.activityOwner !== null) || profile.lifeState !== 'alive' || profile.trainingMode !== 'duty' || profile.activeAttemptId !== null || profile.teaching !== null
        || cultivation.disciples.some((teacher) => teacher.teaching?.studentId === profile.discipleId);
      if (busy && projected.assignmentTransactionId !== null) return fail('Cultivation role retains a production assignment');
    }
    const needsDecision = cultivation.pendingDeaths.length > 0 || cultivation.attempts.some((a) => a.phase === 'DecisionReady');
    if (clock.pauseReasons.includes('cultivation') !== needsDecision) return fail('Cultivation decision pause ownership mismatch');
  } else if (Object.hasOwn(value, 'cultivation')) return fail('Legacy world contains an unexpected cultivation schema');
  let campaignPaymentIds: string[] = [];
  let campaignActionRootIds: string[] = [];
  let archive: HistoryArchive | null = null;
  if (hasCampaign) { try { archive = restoreHistoryArchive(value.history); } catch { return fail('Invalid history archive'); } }
  if (hasProgression) {
    if (!object(value.builds) || !object(value.expedition)) return fail('Missing build/expedition authority');
    let progressionErrors: string[];
    try {
      if (hasCampaign) {
        const inspection = inspectWorldProgressionV8({ ...value, history: archive } as unknown as WorldStateV8);
        progressionErrors = inspection.errors; campaignPaymentIds = inspection.paymentInstanceIds; campaignActionRootIds = inspection.actionRootIds;
      } else progressionErrors = validateWorldProgression(version === 4 ? projectLegacyWorldV4Controller(value) : value as unknown as WorldState);
    }
    catch { return fail('Invalid legacy combat controller'); }
    if (progressionErrors.length) return fail(progressionErrors[0]!);
  } else if (Object.hasOwn(value, 'builds') || Object.hasOwn(value, 'expedition')) return fail('Legacy world contains an unsupported progression schema');
  if (hasEconomy) {
    const economyErrors = validateSectEconomyState(value.sectEconomy, value.disciples.map((disciple) => (disciple as ObjectValue).id as string), simulationTick);
    if (economyErrors.length) return fail(economyErrors[0]!);
  } else if (Object.hasOwn(value, 'sectEconomy')) return fail('Legacy world contains an unsupported sect economy schema');
  if (hasHistory) {
    try { archive = archive ?? restoreHistoryArchive(value.history); } catch { return fail('Invalid history archive'); }
    if (Object.keys(value.transactions).length > MAX_DISCIPLES || Object.keys(value.commandReceipts).length > RECENT_WORLD_RECEIPTS
      || !list(value.events) || value.events.length > RECENT_WORLD_EVENTS) return fail('Unbounded live history collections');
    if (Object.values(value.transactions).some((transaction) => !object(transaction) || !['Running', 'Blocked'].includes(transaction.state as string))
      || Object.values(value.reservations).some((reservation) => !object(reservation) || reservation.state !== 'reserved')) return fail('Terminal records retained in live production');
  } else if (Object.hasOwn(value, 'history')) return fail('Legacy world contains an unsupported history schema');
  let automatic: AutomaticProductionState | null = null;
  if (hasAutomatic) {
    const automaticErrors = validateAutomaticProductionShape(value.automaticProduction, { tick: simulationTick,
      nextAction: sequences.nextAction as number, nextEvent: sequences.nextEvent as number, nextEntity: sequences.nextEntity as number });
    if (automaticErrors.length) return fail(automaticErrors[0]!);
    automatic = value.automaticProduction as AutomaticProductionState;
    if (automatic.activationReviewRequired && (value.sectEconomy as ObjectValue).enabled) return fail('Unreviewed automatic plan is enabled');
    if (Object.keys(value.transactions).some((key) => idNumber(key, 'instance') === null)) return fail('Manual ledger contains automatic ownership');
    if (Object.keys(value.transactions).length + Object.keys(automatic.live).length > MAX_DISCIPLES) return fail('Combined production live limit exceeded');
  } else if (Object.hasOwn(value, 'automaticProduction')) return fail('Legacy world contains automatic production');
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
  function* receipts(): Generator<[string, unknown]> {
    yield* Object.entries(liveReceipts);
    if (archive) for (const entry of iterateArchivedCommandReceipts(archive)) yield [entry.commandId, entry];
  }
  const liveEvents = value.events;
  function* events(): Generator<unknown> {
    if (archive) yield* iterateArchivedEvents(archive);
    if (list(liveEvents)) yield* liveEvents;
  }
  const reservedTotals = Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Record<string, number>;
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
  if (hasProgression) instanceIds.push(...buildOwnedInstanceIds(value as unknown as WorldState));
  for (const [key, transaction, reservation, archived] of productionPairs()) {
    if (archived && (!object(reservation) || typeof reservation.reservationId !== 'string' || !validateReservation(reservation.reservationId, reservation))) return fail('Invalid reservation');
    const autoCycle = hasAutomatic ? automaticCycle(key) : null;
    if (!object(transaction) || transaction.transactionId !== key || (autoCycle === null && idNumber(key, 'instance') === null) || idNumber(transaction.rootActionId, 'action') === null || (autoCycle === null && !text(transaction.commandId)) || !text(transaction.recipeId) || !getRecipe(transaction.recipeId) || (!hasEconomy && !LEGACY_RECIPE_IDS.has(transaction.recipeId)) || !text(transaction.workerId) || !text(transaction.reservationId) || !['Running', 'Blocked', 'Committed', 'Cancelled'].includes(transaction.state as string) || !isNonNegativeInteger(transaction.activeTicks) || !isNonNegativeInteger(transaction.requiredTicks) || transaction.requiredTicks !== getRecipe(transaction.recipeId)!.workTicks || transaction.activeTicks > transaction.requiredTicks || !isNonNegativeInteger(transaction.startedTick) || transaction.startedTick > clock.simulationTick || !(transaction.completedTick === null || isNonNegativeInteger(transaction.completedTick) && transaction.completedTick >= transaction.startedTick && transaction.completedTick <= clock.simulationTick) || !(transaction.resultEventId === null || text(transaction.resultEventId)) || !(transaction.blockedReason === null || (legacy ? ['CAPACITY_EXCEEDED'] : PRODUCTION_BLOCKED_REASONS).includes(transaction.blockedReason as never))) return fail('Invalid production transaction');
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
  for (const id of RESOURCE_IDS) if (reservedTotals[id] !== (inventory[id] as ObjectValue).reserved) return fail('Reservation totals do not match inventory');
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
  if (!list(value.events)) return fail('Invalid events');
  const eventIds = new Set<string>();
  const parentEventIds = new Set<string>();
  const nonCampaignRoots = new Set<string>();
  const cultivationMirrors = new Map<string, ObjectValue>();
  const automaticCancellationEvents = new Map<string, ObjectValue>();
  const automaticPinEventIds = new Map<string, string>();
  const justifiedAutomaticPins = new Set<string>();
  const discardEvents = new Map<string, ObjectValue>();
  const justifiedDiscardEvents = new Set<string>();
  for (const event of events()) {
    if (!object(event) || idNumber(event.eventId, 'event') === null || ![...['production.started', 'production.committed', 'production.cancelled', 'production.blocked'], ...(hasAutomatic ? ['inventory.discarded'] : []), ...(hasCampaign ? ['campaign.committed'] : []), ...(hasCultivation ? CULTIVATION_EVENT_KINDS : [])].includes(event.kind as string) || !isNonNegativeInteger(event.tick) || event.tick > clock.simulationTick || idNumber(event.rootActionId, 'action') === null || !(event.parentEventId === null || text(event.parentEventId)) || !object(event.payload)) return fail('Invalid event');
    if (event.kind !== 'campaign.committed') nonCampaignRoots.add(event.rootActionId as string);
    if (hasAutomatic && isAutomaticJobId(event.payload.transactionId)) {
      const jobId = event.payload.transactionId;
      if (event.kind !== 'production.cancelled' || automaticCancellationEvents.has(jobId)) return fail('Invalid durable automatic event');
      automaticCancellationEvents.set(jobId, event); automaticPinEventIds.set(event.eventId as string, jobId);
    }
    if (event.kind === 'inventory.discarded') {
      if (typeof event.payload.commandId !== 'string' || !RESOURCE_IDS.includes(event.payload.resourceId as ResourceLine['resourceId'])
        || !isNonNegativeInteger(event.payload.quantity) || event.payload.quantity < 1 || discardEvents.has(event.payload.commandId)
        || Object.keys(event.payload).length !== 3) return fail('Invalid inventory discard event');
      discardEvents.set(event.payload.commandId, event);
    }
    if (eventIds.has(event.eventId as string)) return fail('Duplicate event IDs');
    eventIds.add(event.eventId as string);
    if (event.parentEventId !== null) parentEventIds.add(event.parentEventId as string);
    if (CULTIVATION_EVENT_KINDS.includes(event.kind as never)) cultivationMirrors.set(event.eventId as string, event);
    if (idNumber(event.eventId, 'event')! >= (sequences.nextEvent as number) || idNumber(event.rootActionId, 'action')! >= (sequences.nextAction as number)) return fail('Invalid event sequence continuity');
  }
  const expeditionActionRoots = new Set(hasCampaign ? [
    (value as unknown as WorldStateV8).expedition.run?.runId, ...(value as unknown as WorldStateV8).expedition.history.map(run => run.runId),
    ...(value as unknown as WorldStateV8).campaign.settledRunEvidence.map(proof => proof.run.runId),
  ].filter((id): id is string => typeof id === 'string' && /^run:[1-9][0-9]*$/.test(id)).map(id => id.replace('run:', 'action:')) : []);
  if (campaignActionRootIds.some(id => expeditionActionRoots.has(id) || nonCampaignRoots.has(id) || manualRootActions.has(id)
    || automatic && [...Object.values(automatic.live).map(pair => pair.transaction.rootActionId), ...Object.values(automatic.pins).map(pin => pin.rootActionId)].includes(id))) return fail('Campaign action collides with another authority');
  for (const id of settlementEventIds) if (!eventIds.has(id)) return fail('Missing settlement event');
  for (const id of parentEventIds) if (!eventIds.has(id)) return fail('Missing parent event');
  if (cultivation) {
    for (const domainEvent of cultivation.events) {
      const mirrored = cultivationMirrors.get(domainEvent.eventId);
      if (!object(mirrored) || mirrored.kind !== domainEvent.kind || mirrored.rootActionId !== domainEvent.rootActionId
        || canonicalStringify(mirrored.payload) !== canonicalStringify({ discipleId: domainEvent.discipleId, relatedId: domainEvent.relatedId, month: domainEvent.month })) return fail('Cultivation event projection mismatch');
    }
    const domainEventIds = new Set(cultivation.events.map((event) => event.eventId));
    for (const id of cultivationMirrors.keys()) if (!domainEventIds.has(id)) return fail('Orphan cultivation event');
  }
  const cultivationReceipts = new Map(cultivation?.receipts.map((receipt) => [receipt.commandId, receipt]) ?? []);
  const buildReceipts = new Map(hasProgression ? (value as unknown as WorldState).builds.receipts.map((receipt) => [receipt.commandId, receipt]) : []);
  const expeditionRunIds = new Set(hasProgression ? [(value as unknown as WorldState).expedition.run?.runId,
    ...(value as unknown as WorldState).expedition.history.map((run) => run.runId)] : []);
  const receiptIds = new Set<string>();
  for (const [key, receipt] of receipts()) {
    if (receiptIds.has(key)) return fail('Duplicate command receipt IDs');
    receiptIds.add(key);
    if (!object(receipt) || receipt.commandId !== key || typeof receipt.fingerprint !== 'string' || receipt.fingerprint.length === 0 || receipt.fingerprint.length > (hasCultivation ? 16384 : 2048) || !object(receipt.result) || receipt.result.commandId !== key || !['accepted', 'rejected'].includes(receipt.result.status as string) || !list(receipt.result.eventIds) || !receipt.result.eventIds.every((id) => typeof id === 'string' && eventIds.has(id))) return fail('Invalid command receipt');
    const result = receipt.result;
    if (!hasCampaign && object(result.rejection) && ['IDENTITY_REUSED','INVALID_PROVENANCE','ALREADY_RETIRED','TRANSFER_CONFLICT'].includes(String(result.rejection.buildCode))) return fail('Legacy receipt contains unsupported build result');
    const origin = originatingCommands.get(key);
    if (origin) {
      if (receipt.fingerprint !== origin.fingerprint || result.status !== 'accepted' || result.transactionId !== origin.transactionId || result.rejection !== null) return fail('Transaction is missing its matching originating command receipt');
      originatingCommands.delete(key);
    }
    let sourceCommand: unknown;
    try { sourceCommand = JSON.parse(receipt.fingerprint); } catch { return fail('Malformed command fingerprint'); }
    if (!hasCampaign && object(sourceCommand) && sourceCommand.kind === 'campaign.command') return fail('Legacy receipt contains unsupported campaign content');
    const isCultivation = hasCultivation && object(sourceCommand) && sourceCommand.kind === 'cultivation.command';
    if (result.status === 'accepted') {
      if (!hasAutomatic && object(sourceCommand) && sourceCommand.kind === 'inventory.discard') return fail('Legacy accepted receipt uses unsupported content');
      if (!hasEconomy && object(sourceCommand) && (sourceCommand.kind === 'sect-economy.command'
        || (sourceCommand.kind === 'production.start' && (!object(sourceCommand.payload) || typeof sourceCommand.payload.recipeId !== 'string'
          || !LEGACY_RECIPE_IDS.has(sourceCommand.payload.recipeId))))) return fail('Legacy accepted receipt uses unsupported content');
      if (hasCampaign && object(sourceCommand) && sourceCommand.kind === 'campaign.command') {
        if (!object(sourceCommand.payload) || Object.keys(sourceCommand.payload).length !== 1 || !isPlayerCampaignCommand(sourceCommand.payload.command)
          || sourceCommand.payload.command.commandId !== key || result.transactionId !== null || result.rejection !== null || !object(result.campaignResult)) return fail('Invalid accepted campaign receipt');
        // Full bidirectional payment/event/domain proof was checked in progression inspection.
      } else if (hasAutomatic && object(sourceCommand) && sourceCommand.kind === 'inventory.discard') {
        const event = discardEvents.get(key);
        if (!isCommand({ ...sourceCommand, commandId: key, sequence: 0, issuedTick: 0 }) || !object(sourceCommand.payload)
          || result.transactionId !== null || result.rejection !== null || !object(result.discardResult)
          || canonicalStringify(result.discardResult) !== canonicalStringify(sourceCommand.payload)
          || !event || canonicalStringify(result.eventIds) !== canonicalStringify([event.eventId])
          || !object(event.payload) || event.payload.resourceId !== sourceCommand.payload.resourceId || event.payload.quantity !== sourceCommand.payload.quantity) return fail('Invalid accepted inventory discard receipt');
        justifiedDiscardEvents.add(key);
      } else if (isCultivation) {
        if (!object(sourceCommand) || !isCommand({ ...sourceCommand, commandId: key, sequence: 0, issuedTick: 0 }) || !object(sourceCommand.payload)) return fail('Invalid cultivation originating command');
        const domainReceipt = cultivationReceipts.get(key);
        if (result.transactionId !== null || result.rejection !== null || !domainReceipt
          || domainReceipt.fingerprint !== canonicalStringify(sourceCommand.payload.command)
          || !object(result.cultivationResult) || canonicalStringify(result.cultivationResult) !== canonicalStringify(domainReceipt.result)) return fail('Invalid accepted cultivation receipt');
      } else if (hasProgression && object(sourceCommand) && sourceCommand.kind === 'build.command') {
        if (!isCommand({ ...sourceCommand, commandId: key, sequence: 0, issuedTick: 0 }) || !object(sourceCommand.payload) || !object(sourceCommand.payload.command)
          || result.transactionId !== null || result.rejection !== null || !object(result.buildResult)) return fail('Invalid accepted build receipt');
        const buildReceipt = buildReceipts.get(key);
        if (!buildReceipt || buildReceipt.authority || buildReceipt.fingerprint !== canonicalStringify({ command: sourceCommand.payload.command, authority: false })
          || canonicalStringify(result.buildResult) !== canonicalStringify({ commandId: key, kind: sourceCommand.payload.command.kind, revision: buildReceipt.revision, resultId: buildReceipt.resultId })) return fail('Build receipt projection mismatch');
      } else if (hasProgression && object(sourceCommand) && sourceCommand.kind === 'expedition.command') {
        if (!(hasCampaign ? isCommandV8 : isCommand)({ ...sourceCommand, commandId: key, sequence: 0, issuedTick: 0 }) || !object(sourceCommand.payload) || !object(sourceCommand.payload.command)
          || result.transactionId !== null || result.rejection !== null || !object(result.expeditionResult)
          || result.expeditionResult.kind !== sourceCommand.payload.command.kind) return fail('Invalid accepted expedition receipt');
        const recordedRunId = result.expeditionResult.runId;
        if (recordedRunId !== null && (typeof recordedRunId !== 'string' || !expeditionRunIds.has(recordedRunId))) return fail('Expedition receipt has no run identity');
      } else if (hasEconomy && object(sourceCommand) && sourceCommand.kind === 'sect-economy.command') {
        if (!isCommand({ ...sourceCommand, commandId: key, sequence: 0, issuedTick: 0 }) || !object(sourceCommand.payload) || !object(sourceCommand.payload.command)
          || result.transactionId !== null || result.rejection !== null || !list(result.eventIds) || result.eventIds.length !== 0 || !object(result.economyResult)) return fail('Invalid accepted work plan receipt');
        const command = sourceCommand.payload.command;
        const workerId = command.kind === 'plan.set' && object(command.plan) ? command.plan.workerId : null;
        if (canonicalStringify(result.economyResult) !== canonicalStringify({ kind: command.kind, workerId })
          || (workerId !== null && !value.disciples.some((disciple) => object(disciple) && disciple.id === workerId)
            && !archivedIdentities.some(disciple => object(disciple) && disciple.discipleId === workerId))) return fail('Work plan receipt projection mismatch');
      } else if (automatic && isAutomaticJobId(result.transactionId)) {
        const pin = automatic.pins[result.transactionId];
        if (!pin || pin.retention !== 'exact-receipt' || !object(sourceCommand) || !isCommand({ ...sourceCommand, commandId: key, sequence: 0, issuedTick: 0 }) || sourceCommand.kind !== 'production.cancel'
          || !object(sourceCommand.payload) || sourceCommand.payload.transactionId !== result.transactionId || result.rejection !== null
          || canonicalStringify(result.eventIds) !== canonicalStringify([pin.resultEventId])) return fail('Invalid accepted automatic cancellation receipt');
        justifiedAutomaticPins.add(result.transactionId);
      } else if (typeof result.transactionId !== 'string' || !transactionIds.has(result.transactionId) || result.rejection !== null) return fail('Invalid accepted receipt');
      if (automatic && object(sourceCommand) && object(sourceCommand.payload) && object(sourceCommand.payload.command)) {
        const command = sourceCommand.payload.command;
        for (const eventId of result.eventIds as string[]) {
          const pinId = automaticPinEventIds.get(eventId); const pin = pinId && automatic.pins[pinId as keyof typeof automatic.pins];
          if (!pin || !pinId) continue;
          const cultivationOwner = sourceCommand.kind === 'cultivation.command' && (command.discipleId === pin.workerId
            || (command.kind === 'teaching.begin' && command.studentId === pin.workerId));
          const departureOwner = sourceCommand.kind === 'expedition.command' && command.kind === 'expedition.depart'
            && object(command.request) && list(command.request.squadIds) && command.request.squadIds.includes(pin.workerId);
          if (cultivationOwner || departureOwner) justifiedAutomaticPins.add(pinId);
        }
      }
    }
    if (result.status === 'rejected' && (result.transactionId !== null || !object(result.rejection) || !text(result.rejection.code))) return fail('Invalid rejected receipt');
  }
  if (discardEvents.size !== justifiedDiscardEvents.size) return fail('Orphan inventory discard event');
  if (automatic) {
    const pendingTargets = new Set((value.pendingCommands as Command[]).flatMap((command) => command.kind === 'production.cancel'
      && isAutomaticJobId(command.payload.transactionId) && !receiptIds.has(command.commandId) ? [command.payload.transactionId] : []));
    const errors = validateAutomaticProductionReferences(automatic, { durableEventIds: eventIds, cancellationEvents: automaticCancellationEvents,
      justifiedPins: justifiedAutomaticPins, pendingTargets });
    if (errors.length) return fail(errors[0]!);
  }
  if (originatingCommands.size > 0) return fail('Transaction is missing its matching originating command receipt');
  if (!list(value.unlocks) || !value.unlocks.every(text) || !unique(value.unlocks) || !list(value.diagnostics) || !value.diagnostics.every((diagnostic) => object(diagnostic) && diagnostic.code === 'INVARIANT_FAILURE' && isNonNegativeInteger(diagnostic.tick) && diagnostic.tick <= simulationTick && typeof diagnostic.message === 'string')) return fail('Invalid unlocks or diagnostics');
  return errors;
}

export function isWorldState(value: unknown): value is WorldState { return validateWorldState(value).length === 0; }
