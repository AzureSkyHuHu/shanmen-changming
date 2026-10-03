import { canonicalUtf8ByteLength } from '../save-budget';
import { isManagementV10Identity, MANAGEMENT_V10_CONTENT_VERSION } from '../../content/sect-v10/world-content';
import { inspectV10LifecycleRecords, type V10LifecycleRecordEvidence } from '../world/v10-lifecycle-records';
import { inspectV10SectOwnerClosure } from '../world/v10-sect-records';
import { captureFrozenV10RecordData } from '../world/v10-frozen-record-capture';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { ownSectFields } from '../sect-expansion/layout';
import { isManagementV9Identity, MANAGEMENT_V9_CONTENT_VERSION } from '../../content/sect-v9/world-content';
import { inspectV9LifecycleRecords, type V9LifecycleRecordEvidence } from '../world/v9-lifecycle-records';
import { inspectV9SectOwnerClosure } from '../world/v9-sect-bridge';
import type { WorldStateV9 } from '../world/v9-types';
import { inspectWorldEconomyRecords, closeLegacyWorldEconomyReservations } from './world-economy-records';
import type { CommandV8 } from './contracts-v8';
import { isCommandV8 } from './command-shape-v8';
import { isPlayerCampaignCommand } from '../world/campaign-queries';
import type { Command } from './contracts';
import { LEGACY_V7_CONTENT } from '../../content/registry';
import { getWorldContent } from '../world/content-access';
import { inspectWorldProgressionV8 } from '../world/validate-progression-v8';
import { validateCultivationFrameV3 } from '../cultivation/v3';
import type { CultivationState as CultivationStateV3 } from '../cultivation/v3';
import type { WorldStateV8 } from '../world/v8-types';
import { isAutomaticJobId } from '../economy/automatic-production';
import type { AutomaticProductionState } from '../economy/automatic-types';
import { validateAutomaticProductionShape, validateAutomaticProductionReferences } from '../world/validate-automatic';
import { iterateArchivedCommandReceipts, iterateArchivedEvents, restoreHistoryArchive, type HistoryArchive } from '../history';
import { RECENT_WORLD_EVENTS, RECENT_WORLD_RECEIPTS } from '../world/history-access';
import { validateSectEconomyState } from '../sect-economy/state';
import { projectLegacyWorldV4Controller } from './migrate-v4';
import { CULTIVATION_EVENT_KINDS, type CultivationState } from '../cultivation/types';
import { validateWorldProgression } from '../world/validate-progression';
import { validateCultivationFrame, validateLegacyCultivationFrameV1 } from '../cultivation/validation';
import { RESOURCE_IDS, type ResourceLine } from '../economy/types';
import { LEGACY_V4_RECIPE_IDS } from '../economy/recipes';
import { CONTENT_VERSION, SIMULATION_VERSION } from '../world/create-world';
import { MAX_DISCIPLES, type WorldState } from '../world/types';
import { CALENDAR_TICKS_PER_MONTH, PAUSE_REASONS } from './clock';
import { isCommand } from './commands';
import { isNonNegativeInteger } from './numeric';
import { RANDOM_ALGORITHM, RANDOM_STREAM_NAMES } from './random';
import { canonicalStringify } from './serialization';

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
/** Internal record inspection only. This is intentionally absent from kernel public exports,
 * save parsers and application admission; it proves no whole-save or exit capacity. */
export function inspectUnregisteredWorldV9Records(value: WorldStateV9): string[] {
  try {
    canonicalUtf8ByteLength(value);
    if (!ownSectFields(value, ['seed', 'simulationVersion', 'contentVersion', 'clock', 'randomStreams', 'sequences', 'map', 'disciples', 'buildings',
      'sectEconomy', 'history', 'automaticProduction', 'inventory', 'reservations', 'transactions', 'activeProductionTransactionIds', 'commandReceipts',
      'pendingCommands', 'events', 'unlocks', 'diagnostics', 'cultivation', 'builds', 'expedition', 'contentIdentity', 'campaign', 'legacy', 'runtimeProtocol', 'sectExpansion', 'cultivationClock'])) return ['Invalid internal v9 root fields'];
    return validateWorldSchema(value, 9);
  } catch (error) { return [error instanceof Error ? error.message : 'Invalid internal v9 records']; }
}
/** Fixed internal v10 RECORD root only. No codec, runtime or application barrel exports
 * this inspection. A successful result proves neither full envelope fit nor future capacity. */
export function inspectUnregisteredWorldV10Records(input: unknown): string[] {
  try {
    const value = captureFrozenV10RecordData(input);
    if (!ownSectFields(value, ['seed', 'simulationVersion', 'contentVersion', 'clock', 'randomStreams', 'sequences', 'map', 'disciples', 'buildings',
      'sectEconomy', 'history', 'automaticProduction', 'inventory', 'reservations', 'transactions', 'activeProductionTransactionIds', 'commandReceipts',
      'pendingCommands', 'events', 'unlocks', 'diagnostics', 'cultivation', 'builds', 'expedition', 'contentIdentity', 'campaign', 'legacy', 'runtimeProtocol', 'sectExpansion', 'cultivationClock'])) return ['Invalid internal v10 root fields'];
    return validateWorldSchema(value, 10);
  } catch { return ['Invalid internal v10 records']; }
}
function validateWorldSchema(value: unknown, version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10): string[] {
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
  if (version !== 9 && version !== 10 && (Object.hasOwn(value, 'sectExpansion') || Object.hasOwn(value, 'runtimeProtocol') || Object.hasOwn(value, 'cultivationClock'))) return fail('Legacy World contains reserved v9 fields');
  if (!text(value.seed) || value.simulationVersion !== (version === 10 ? '0.10.0' : version === 9 ? '0.9.0' : hasCampaign ? '0.8.0' : legacy ? '0.1.1' : version === 2 ? '0.2.0' : current ? '0.7.0' : version === 6 ? '0.6.0' : version === 5 ? '0.5.0' : version === 4 ? '0.4.0' : '0.3.0')) return fail('Unsupported world identity/version');
  if (version === 10) { if (value.runtimeProtocol !== 'management-v10-alchemy-upgrade.1' || value.contentVersion !== MANAGEMENT_V10_CONTENT_VERSION || !isManagementV10Identity(value.contentIdentity)) return fail('Unsupported internal v10 content identity'); }
  else if (version === 9) { if (value.contentVersion !== MANAGEMENT_V9_CONTENT_VERSION || !isManagementV9Identity(value.contentIdentity)) return fail('Unsupported internal v9 content identity'); }
  else if (hasCampaign) { try { getWorldContent(value as unknown as WorldStateV8); } catch { return fail('Unsupported World content identity'); } }
  else if (value.contentVersion !== LEGACY_V7_CONTENT.worldContentVersion) return fail('Unsupported world content version');
  const clock = value.clock;
  if (!object(clock) || !isNonNegativeInteger(clock.simulationTick) || !isNonNegativeInteger(clock.calendarTick) || !isNonNegativeInteger(clock.encounterTick) || clock.calendarTick + clock.encounterTick !== clock.simulationTick || !['management', 'combat'].includes(clock.mode as string) || ![1, 3].includes(clock.speed as number) || !list(clock.pauseReasons) || !unique(clock.pauseReasons) || !clock.pauseReasons.every((reason) => PAUSE_REASONS.includes(reason as typeof PAUSE_REASONS[number]) && (hasAutomatic || reason !== 'save-capacity') && (hasCultivation || reason !== 'cultivation') && (hasProgression || reason !== 'expedition'))) return fail('Invalid clock');
  if (version === 10 && (clock.mode !== 'management' || clock.encounterTick !== 0 || clock.calendarTick !== clock.simulationTick)) return fail('Invalid v10 management clock');
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
  if (version === 10 && value.pendingCommands.length !== 0) return fail('The internal v10 queue is not registered');
  if (version === 9 && value.pendingCommands.length !== 0) return fail('The internal v9 queue is not registered');
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
  let v9Lifecycle: V9LifecycleRecordEvidence | null = null;
  let v10Lifecycle: V10LifecycleRecordEvidence | null = null;
  let v10RecordSource: WorldStateV10 | null = null;
  let campaignPaymentIds: string[] = [];
  let campaignActionRootIds: string[] = [];
  let archive: HistoryArchive | null = null;
  if (hasCampaign) { try { archive = restoreHistoryArchive(value.history); } catch { return fail('Invalid history archive'); } }
  if (hasProgression) {
    if (!object(value.builds) || !object(value.expedition)) return fail('Missing build/expedition authority');
    let progressionErrors: string[];
    try {
      if (version === 10) {
        // The token authenticates object identity AND canonical data. Construct this
        // archive-restored source once, then reuse it in the six-owner closure below.
        v10RecordSource = { ...value, history: archive } as unknown as WorldStateV10;
        v10Lifecycle = inspectV10LifecycleRecords(v10RecordSource);
        progressionErrors = [];
      } else if (version === 9) {
        v9Lifecycle = inspectV9LifecycleRecords({ ...value, history: archive } as unknown as WorldStateV9);
        progressionErrors = [];
      } else if (hasCampaign) {
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
  const economyInspection = inspectWorldEconomyRecords({ source: value,
    protocol: legacy ? 'initial-production' : hasAutomatic ? 'automatic-production' : hasEconomy ? 'sect-economy-production' : hasProgression ? 'build-production' : 'navigation-production',
    map, clock, sequences, inventory, cultivation, automatic, archive, archivedIdentities, campaignPaymentIds });
  if (!economyInspection.ok) return economyInspection.errors;
  const economyRecords = economyInspection.records;
  const economyClosureErrors = version === 10
    ? inspectV10SectOwnerClosure(v10RecordSource!, economyRecords, v10Lifecycle!)
    : version === 9
    // Reuse this call's authenticated immutable archive, as the lifecycle stage
    // does above. Sect-only receipt IDs still require World collision lookups;
    // querying the raw source would restore the whole archive for every miss.
    ? inspectV9SectOwnerClosure({ ...value, history: archive } as unknown as WorldStateV9, economyRecords, v9Lifecycle!)
    : closeLegacyWorldEconomyReservations(economyRecords);
  if (economyClosureErrors.length) return economyClosureErrors;
  const { transactionIds, manualRootActions, settlementEventIds, liveReceipts, liveEvents } = economyRecords;
  const originatingCommands = new Map(economyRecords.originatingCommands);
  function* receipts(): Generator<[string, unknown]> {
    yield* Object.entries(liveReceipts);
    if (archive) for (const entry of iterateArchivedCommandReceipts(archive)) yield [entry.commandId, entry];
  }
  function* events(): Generator<unknown> {
    if (archive) yield* iterateArchivedEvents(archive);
    if (list(liveEvents)) yield* liveEvents;
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
    if (version === 10 && event.kind === 'campaign.committed') return fail('Internal v10 campaign events are closed');
    if (version === 9 && event.kind === 'campaign.committed') return fail('Internal v9 campaign events are closed');
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
    if (version === 10 && object(sourceCommand) && ['campaign.command', 'expedition.command'].includes(String(sourceCommand.kind))) return fail('Internal v10 campaign/departure receipts are closed');
    if (version === 9 && object(sourceCommand) && ['campaign.command', 'expedition.command'].includes(String(sourceCommand.kind))) return fail('Internal v9 campaign/departure receipts are closed');
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
