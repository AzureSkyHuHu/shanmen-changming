import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import { isManagementV9Identity } from '../../content/sect-v9/world-content';
import { MAX_CULTIVATION_HISTORY } from '../cultivation/rules';
import { RESOURCE_IDS } from '../economy/types';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { inspectUnregisteredWorldV9Records } from '../kernel/validation';
import { assessAutomaticWorkBudget, SAVE_FILE_LIMIT_BYTES, type AutomaticSaveBudgetAssessment } from '../save-budget/admission';
import { assessBuildHistoryObligations, type BuildHistoryObligationAssessment } from '../save-budget/build-obligations';
import { createCanonicalByteCounter } from '../save-budget/canonical-bytes';
import { measureWorldSaveBytes } from '../save-budget/envelope';
import { deriveProgressionReservations, measureProgressionRecord, type ProgressionReservationAssessment } from '../save-budget/progression-bounds';
import { deriveSectReservationsV9, type SectObligationAssessmentV9 } from '../save-budget/sect-obligations-v9';
import { CONSTRUCTION_LIMITS } from '../sect-expansion/construction-types';
import { SECT_CARE_LIMITS } from '../sect-expansion/care-types';
import { CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND, SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND, SECT_RESEARCH_DESCRIPTOR_NODE_BOUND, SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND } from '../sect-expansion/descriptor-bounds';
import { SECT_MAINTENANCE_LIMITS } from '../sect-expansion/maintenance-types';
import { SECT_PRODUCTION_LIMITS } from '../sect-expansion/production-types';
import { SECT_RESEARCH_LIMITS } from '../sect-expansion/research-types';
import { assessProgressionNumeric, type ProgressionNumericAssessment } from './progression-numeric';
import { deriveV9BuildObligationFacts } from './v9-record-headroom';
import { projectV9SectFrame } from './v9-sect-bridge';
import { V9_CULTIVATION_CLOCK_LIMIT, type V9CultivationClockTransition } from './v9-cultivation-clock-types';
import type { WorldStateV9 } from './v9-types';

const MAX = Number.MAX_SAFE_INTEGER;
// Existing build-v2/cultivation-v3 snapshot readers use these independent limits.
// They are not inferred from UTF-8 bytes. The node ceiling is builds/shared.ts's
// assertJson default; cultivation-v3 has no aggregate descriptor node ceiling.
const DOMAIN_READER_CHARACTER_LIMIT = 4_000_000;
const BUILD_READER_NODE_LIMIT = 300_000;
function sum(...values: number[]): number { return values.reduce((total, value) => total > MAX - value ? Infinity : total + value, 0); }
export interface ManagementCapacityV9 {
  scope: 'unregistered-v9-immediate-recovery-and-record-peaks';
  /** Sizing evidence never constitutes a save/import/command admission. */
  admitted: false; importAuthorized: false; eventualCompletionSupported: false;
  measuredEnvelopeBytes: number | null; actualFits: boolean; supported: boolean; fits: boolean;
  reason: 'ready' | 'invalid-source' | 'unproved-obligation' | 'wire-cap' | 'future-capacity';
  current: Record<string, number>; reserved: Record<string, number>; costs: Record<string, number>; limits: Record<string, number>;
  deficits: { dimension: string; current: number; reserved: number; cost: number; limit: number; excess: number }[];
  base: AutomaticSaveBudgetAssessment | null; build: BuildHistoryObligationAssessment | null;
  progression: ProgressionReservationAssessment | null; numeric: ProgressionNumericAssessment | null; sect: SectObligationAssessmentV9 | null;
  clock: ManagementClockReservationV9 | null;
  sourceRecordIssues: string[]; unknowns: string[]; excludedProofs: readonly string[];
}
export interface ManagementClockReservationV9 {
  supported: boolean; currentRows: number; reservedRows: number;
  /** Finite accepted progression horizon only. No indefinite waiting is included. */
  calendarTicks: number; monthRows: number; ageSyncRows: number; lifecycleTriggerRows: number;
  additionalActions: number; additionalCultivationRevisions: number;
  bytes: number; decodedCharacters: number; decodedNodes: number;
  currentDecodedNodes: number; structuralNodeLimit: number;
  perTransition: { bytes: number; decodedCharacters: number; decodedNodes: number };
  progressionOwnerIds: string[]; lifecycleOwnerIds: string[]; unknowns: string[];
}
function periodicBoundariesAfter(tick: number, horizon: number, residue: number): number {
  const offset = ((residue - tick % CALENDAR_TICKS_PER_MONTH) + CALENDAR_TICKS_PER_MONTH) % CALENDAR_TICKS_PER_MONTH;
  const first = offset === 0 ? CALENDAR_TICKS_PER_MONTH : offset;
  return horizon < first ? 0 : 1 + Math.floor((horizon - first) / CALENDAR_TICKS_PER_MONTH);
}
/** The .3 bridge emits one row and one action/revision per actual month or
 * off-month birthday group; simultaneous birthdays and month ticks coalesce.
 * Progression already reserves one expiry action for each alive lifecycle owner
 * and one action/revision per committed teaching/seclusion month. Only additional
 * off-month groups in that finite horizon need additional scalar headroom here.
 * A lifecycle trigger row does not reserve the arbitrary months leading to it. */
function deriveManagementClockReservationV9(world: WorldStateV9, progression: ProgressionReservationAssessment): ManagementClockReservationV9 {
  const witness: V9CultivationClockTransition = { kind: 'age-sync', tick: MAX, beforeRevision: MAX - 1, rootActionId: `action:${MAX - 1}` };
  const maximum = measureProgressionRecord(witness);
  const emptyNodes = measureProgressionRecord({ transitions: [] }).decodedNodes;
  const current = measureProgressionRecord(world.cultivationClock);
  const result: ManagementClockReservationV9 = { supported: false, currentRows: world.cultivationClock.transitions.length, reservedRows: 0,
    calendarTicks: 0, monthRows: 0, ageSyncRows: 0, lifecycleTriggerRows: 0, additionalActions: 0, additionalCultivationRevisions: 0,
    bytes: 0, decodedCharacters: 0, decodedNodes: 0, currentDecodedNodes: current.decodedNodes,
    structuralNodeLimit: emptyNodes + V9_CULTIVATION_CLOCK_LIMIT * maximum.decodedNodes,
    perTransition: { bytes: maximum.bytes + 1, decodedCharacters: maximum.decodedCharacters + 1, decodedNodes: maximum.decodedNodes },
    progressionOwnerIds: [], lifecycleOwnerIds: [], unknowns: [] };
  if (!progression.supported) { result.unknowns.push('Clock row reservation requires a supported progression derivation'); return result; }
  const horizon = progression.totals.counterReserve.calendarTicks;
  if (!Number.isSafeInteger(horizon) || horizon < 0 || horizon % CALENDAR_TICKS_PER_MONTH !== 0) {
    result.unknowns.push('Clock row reservation has no finite whole-month progression horizon'); return result;
  }
  result.calendarTicks = horizon;
  result.progressionOwnerIds = progression.owners.filter(owner => owner.counterReserve.calendarTicks > 0).map(owner => `${owner.kind}:${owner.id}`);
  result.monthRows = periodicBoundariesAfter(world.clock.calendarTick, horizon, 0);
  if (result.monthRows !== progression.totals.counterReserve.calendarMonths) {
    result.unknowns.push('Clock month rows differ from already-funded progression months'); return result;
  }
  const residues = new Set<number>();
  for (const actor of world.disciples) {
    const profile = world.cultivation.disciples.find(profile => profile.discipleId === actor.id);
    if (!profile) { result.unknowns.push('Clock obligation lacks an active cultivation identity'); return result; }
    if (profile.lifeState !== 'alive') continue;
    const residue = ((actor.birthCalendarTick % CALENDAR_TICKS_PER_MONTH) + CALENDAR_TICKS_PER_MONTH) % CALENDAR_TICKS_PER_MONTH;
    if (residue !== 0) residues.add(residue);
  }
  for (const residue of residues) result.ageSyncRows += periodicBoundariesAfter(world.clock.calendarTick, horizon, residue);
  result.lifecycleOwnerIds = progression.owners.filter(owner => owner.kind === 'disciple-lifecycle'
    && world.cultivation.disciples.some(profile => profile.discipleId === owner.id && profile.lifeState === 'alive')).map(owner => owner.id);
  // Per-owner terminal trigger rows may coalesce with each other or a horizon
  // row. Keep that deliberate conservative duplicate: no terminal discharge or
  // equality of future death times is assumed by this read-only query.
  result.lifecycleTriggerRows = result.lifecycleOwnerIds.length;
  result.reservedRows = result.monthRows + result.ageSyncRows + result.lifecycleTriggerRows;
  result.additionalActions = result.ageSyncRows; result.additionalCultivationRevisions = result.ageSyncRows;
  result.bytes = result.reservedRows * result.perTransition.bytes;
  result.decodedCharacters = result.reservedRows * result.perTransition.decodedCharacters;
  result.decodedNodes = result.reservedRows * result.perTransition.decodedNodes;
  if (![result.reservedRows, result.bytes, result.decodedCharacters, result.decodedNodes].every(value => Number.isSafeInteger(value) && value >= 0)) {
    result.unknowns.push('Clock reservation exceeds finite safe range'); return result;
  }
  result.supported = true; return result;
}
/** Read-only internal query, intentionally not re-exported from kernel, save-budget
 * or registered World APIs. It accepts no capability flags or supplied byte counts.
 * Current bytes are the complete v9 envelope, with worst legal escaped metadata.
 * Recovery rows/receipts, terminal records and live peaks are separately derived.
 * Optional maintenance/new work is future growth, not an infinite commitment.
 * A future runtime gate must preserve these reserves before allowing each tick or
 * command; this query does not install that gate or prove its release semantics. */
export function assessManagementCapacityV9(world: WorldStateV9): ManagementCapacityV9 {
  const result: ManagementCapacityV9 = { scope: 'unregistered-v9-immediate-recovery-and-record-peaks', admitted: false, importAuthorized: false,
    eventualCompletionSupported: false, measuredEnvelopeBytes: null, actualFits: false, supported: false, fits: false, reason: 'unproved-obligation',
    current: {}, reserved: {}, costs: {}, limits: {}, deficits: [], base: null, build: null, progression: null, numeric: null, sect: null,
    clock: null, sourceRecordIssues: [], unknowns: [], excludedProofs: [
      'Public v9 codec, Session, content and UI registration; public import authority',
      'Real runtime admission and reserved cancellation-release monotonicity',
      'Guaranteed eventual completion through arbitrary blocking, waiting, optional commands or maintenance renewals',
      'Elapsed tick and revision growth before natural lifespan death and indefinitely blocked work',
      'Cryptographic authenticity or complete historical injury replay; .3 structural clock evidence never makes sizing an import authority',
      'Expedition, campaign, battle, return and exit proofs: departures remain closed and no v8 exit proof is borrowed',
    ] };
  const dimension = (name: string, current: number, reserved: number, limit: number): void => {
    if (![current, reserved, limit].every(value => Number.isSafeInteger(value) && value >= 0)) throw new TypeError(`Invalid capacity dimension ${name}`);
    result.current[name] = current; result.reserved[name] = reserved; result.costs[name] = sum(current, reserved); result.limits[name] = limit;
  };
  try {
    // Fresh descriptor walk before ALL supplied-property reads. No cache of a
    // mutable World, supplied counter, or mutable caller metadata can affect it.
    const counter = createCanonicalByteCounter(); counter.measure(world);
    const measured = measureWorldSaveBytes(world, { saveVersion: 9, counter });
    result.measuredEnvelopeBytes = measured; result.actualFits = measured <= SAVE_FILE_LIMIT_BYTES;
    if (world.simulationVersion !== '0.9.0' || world.runtimeProtocol !== 'fresh-management-v9-unregistered.3' || !isManagementV9Identity(world.contentIdentity)) {
      throw new TypeError('Requires internal management-v9 .3 identity');
    }
    result.sourceRecordIssues = inspectUnregisteredWorldV9Records(world);
    // Preserve inspectable deficits for shape-correct record-pressure fixtures.
    // Invalid provenance still sets supported=false regardless of byte fit.
    if (world.pendingCommands.length || world.clock.mode !== 'management' || world.expedition.run !== null) result.unknowns.push('Persisted queues and departures are outside the internal v9 scope');
    const automatic = Object.keys(world.automaticProduction.live).length;
    const base = assessAutomaticWorkBudget({ world, map: world.map, liveAutomaticJobCount: automatic,
      pendingCommands: world.pendingCommands, maximumNewStarts: 0, journalBytes: counter.measure(world.automaticProduction.journal), save: { saveVersion: 9, counter } });
    result.base = base;
    if (base.encodedBytes !== measured) throw new TypeError('Whole-envelope measurement differs');
    const facts = deriveV9BuildObligationFacts(world); const build = assessBuildHistoryObligations(facts); result.build = build;
    const progression = deriveProgressionReservations({ world, buildFacts: facts }); result.progression = progression;
    const numeric = assessProgressionNumeric(world, progression); result.numeric = numeric;
    const sect = deriveSectReservationsV9(world); result.sect = sect;
    result.unknowns.push(...progression.unknowns, ...sect.unknowns);
    if (!numeric.supported) result.unknowns.push(...numeric.diagnostics);
    if (base.unsupportedPendingKinds.length) result.unknowns.push('Unsupported pending command effects');
    const clock = deriveManagementClockReservationV9(world, progression); result.clock = clock; result.unknowns.push(...clock.unknowns);
    const extra = progression.totals; const local = sect.totals; const records = world.sectExpansion;
    // Equation: whole envelope ONCE + existing production/journal/general margin
    // + progression ONCE + sect ONCE + new .3 clock rows ONCE. Existing clock
    // rows are already inside measured; build rows/bytes are progression subtotals.
    dimension('wireBytes', measured, sum(base.reservedBytes, extra.bytes, local.bytes, clock.bytes), SAVE_FILE_LIMIT_BYTES);
    dimension('archiveProductionRows', base.archiveSlots.current.production, base.archiveSlots.reserved.production, base.archiveSlots.limitPerTable);
    dimension('archiveReceiptRows', base.archiveSlots.current.commandReceipts, sum(base.archiveSlots.reserved.commandReceipts, extra.archiveRows.commandReceipts), base.archiveSlots.limitPerTable);
    dimension('archiveEventRows', base.archiveSlots.current.events, sum(base.archiveSlots.reserved.events, extra.archiveRows.events), base.archiveSlots.limitPerTable);
    dimension('archiveCharacters', base.archiveExpansion.currentCharacters, sum(base.archiveExpansion.reservedCharacters, extra.archiveDecodedCharacters), base.archiveExpansion.characterLimit);
    dimension('archiveNodes', base.archiveExpansion.currentNodes, sum(base.archiveExpansion.reservedNodes, extra.archiveDecodedNodes), base.archiveExpansion.nodeLimit);
    dimension('cultivationClockTransitions', world.cultivationClock.transitions.length, clock.reservedRows, V9_CULTIVATION_CLOCK_LIMIT);
    // No codec or new reader is registered. This is the exact structural node
    // envelope implied by the existing .3 row cap and its four-scalar row schema,
    // not an invented parser limit or a second charge to whole-save bytes.
    dimension('cultivationClockStructuralNodes', clock.currentDecodedNodes, clock.decodedNodes, clock.structuralNodeLimit);
    dimension('buildCommands', world.builds.history.length, extra.buildRows, build.maximumCommands);
    for (const name of Object.keys(extra.cultivationRows) as (keyof typeof extra.cultivationRows)[]) dimension(`cultivation.${name}`, world.cultivation[name].length, extra.cultivationRows[name], MAX_CULTIVATION_HISTORY);
    // The terminal destination is bounded independently from death/archive rows.
    // Each currently owned unique relic can eventually reach sect custody once;
    // do not count it again for each intermediate heir in the transfer chain.
    const inSect = new Set(world.cultivation.sectRelicIds);
    const eventualSectRelics = new Set(world.cultivation.disciples.flatMap(profile => profile.relicIds).filter(id => !inSect.has(id)));
    dimension('cultivation.sectRelicIds', world.cultivation.sectRelicIds.length, eventualSectRelics.size, MAX_CULTIVATION_HISTORY);
    dimension('cultivation.attempts', world.cultivation.attempts.length, 0, MAX_CULTIVATION_HISTORY);
    dimension('cultivation.legacyIdentities', world.cultivation.legacyIdentities.length, 0, MAX_CULTIVATION_HISTORY);
    // Sect receipts remain in their local domain. They never add World receipt or
    // event archive rows, including real system/v9/death/* cancellations.
    dimension('sect.blueprints', records.construction.blueprints.length, 0, CONSTRUCTION_LIMITS.records);
    dimension('sect.plannedBlueprints', records.construction.blueprints.filter(bp => bp.status === 'planned').length, 0, CONSTRUCTION_LIMITS.blueprints);
    dimension('sect.constructionJobs', records.construction.jobs.length, local.rows.constructionJobs, CONSTRUCTION_LIMITS.records);
    dimension('sect.buildings', world.buildings.length + records.construction.buildings.length, local.rows.constructionBuildings, CONSTRUCTION_LIMITS.buildings);
    dimension('sect.constructionReceipts', records.construction.receipts.length, local.rows.constructionReceipts, CONSTRUCTION_LIMITS.receipts);
    dimension('sect.productionJobs', records.production.jobs.length, 0, SECT_PRODUCTION_LIMITS.records);
    dimension('sect.productionReceipts', records.production.receipts.length, local.rows.productionReceipts, SECT_PRODUCTION_LIMITS.receipts);
    dimension('sect.researchJobs', records.research.jobs.length, 0, SECT_RESEARCH_LIMITS.records);
    dimension('sect.researchReceipts', records.research.receipts.length, local.rows.researchReceipts, SECT_RESEARCH_LIMITS.receipts);
    dimension('sect.careJobs', records.care.jobs.length, 0, SECT_CARE_LIMITS.records);
    dimension('sect.careReceipts', records.care.receipts.length, local.rows.careReceipts, SECT_CARE_LIMITS.receipts);
    dimension('sect.pairedClaims', records.reservations.length, local.rows.pairedClaims, SECT_MAINTENANCE_LIMITS.pairedClaims);
    dimension('sect.maintenancePayments', records.maintenance.payments.length, 0, SECT_MAINTENANCE_LIMITS.payments);
    const activeConstruction = records.construction.jobs.filter(job => !job.terminal).length;
    const activeProduction = records.production.jobs.filter(job => !job.terminal).length;
    const activeResearch = records.research.jobs.filter(job => !job.terminal).length;
    const activeCare = records.care.jobs.filter(job => !job.terminal).length;
    dimension('activeWorkers', world.activeProductionTransactionIds.length + activeConstruction + activeProduction + activeResearch + activeCare, 0, CONSTRUCTION_LIMITS.activeJobs);
    dimension('sect.activeConstruction', activeConstruction, 0, CONSTRUCTION_LIMITS.activeJobs);
    dimension('sect.activeProduction', activeProduction, 0, SECT_PRODUCTION_LIMITS.activeJobs);
    dimension('sect.activeResearch', activeResearch, 0, SECT_RESEARCH_LIMITS.activeJobs);
    const builds = measureProgressionRecord({ format: 'shanmen-builds', version: 2, checksum: '00000000', frame: { builds: world.builds, sequences: world.sequences } });
    const culture = measureProgressionRecord({ format: 'shanmen-cultivation', version: 3, checksum: '00000000', frame: { cultivation: world.cultivation,
      inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences } });
    const inventory = { ...world.inventory }; for (const id of RESOURCE_IDS) inventory[id] = { ...inventory[id], owned: MAX, reserved: MAX, capacity: MAX };
    const inventoryCharacters = Math.max(0, measureProgressionRecord(inventory).decodedCharacters - measureProgressionRecord(world.inventory).decodedCharacters);
    dimension('buildReaderCharacters', builds.decodedCharacters, extra.domainDecodedCharacters, DOMAIN_READER_CHARACTER_LIMIT);
    dimension('buildReaderNodes', builds.decodedNodes, extra.domainDecodedNodes, BUILD_READER_NODE_LIMIT);
    dimension('cultivationReaderCharacters', culture.decodedCharacters, sum(extra.domainDecodedCharacters, inventoryCharacters, sect.shared.decodedCharacters), DOMAIN_READER_CHARACTER_LIMIT);
    const frame = projectV9SectFrame(world);
    const constructionNodes = measureProgressionRecord(frame.construction).decodedNodes;
    const productionNodes = measureProgressionRecord({ schemaVersion: 1, construction: frame.construction, production: frame.production }).decodedNodes;
    const researchNodes = measureProgressionRecord({ schemaVersion: 1, construction: frame.construction, production: frame.production, research: frame.research }).decodedNodes;
    const maintenanceNodes = measureProgressionRecord({ schemaVersion: 1, construction: frame.construction, production: frame.production, research: frame.research, maintenance: frame.maintenance }).decodedNodes;
    // Conservative union envelope for each real nested descriptor reader. Care's
    // own job/receipt nodes do not enter these readers, but its paired claims do;
    // charging the full local delta safely covers every such overlapping subset.
    dimension('constructionReaderNodes', constructionNodes, local.decodedNodes, CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND);
    dimension('productionReaderNodes', productionNodes, local.decodedNodes, SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND);
    dimension('researchReaderNodes', researchNodes, local.decodedNodes, SECT_RESEARCH_DESCRIPTOR_NODE_BOUND);
    dimension('maintenanceReaderNodes', maintenanceNodes, local.decodedNodes, SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND);
    // Row-local visit/span limits are independent of wire bytes. The reserved
    // amount reports the still-growable finite record representation, not work.
    for (const job of records.construction.jobs) dimension(`construction.${job.jobId}.spans`, job.workSpans.length,
      job.terminal ? 0 : Math.max(0, (getConstructionWorkTicks(job.blueprintId, world)) - job.workSpans.length), getConstructionWorkTicks(job.blueprintId, world));
    for (const job of records.production.jobs) dimension(`production.${job.transactionId}.spans`, job.workSpans.length,
      job.terminal ? 0 : Math.max(0, job.requiredTicks - job.workSpans.length), SECT_PRODUCTION_LIMITS.maximumWorkTicks);
    for (const job of records.research.jobs) {
      dimension(`research.${job.jobId}.visits`, job.visits.length, job.terminal ? 0 : Math.max(0, SECT_RESEARCH_LIMITS.visits - job.visits.length), SECT_RESEARCH_LIMITS.visits);
      dimension(`research.${job.jobId}.spans`, job.workSpans.length, job.terminal ? 0 : Math.max(0, job.requiredTicks - job.workSpans.length), SECT_RESEARCH_LIMITS.maximumWorkTicks);
    }
    for (const job of records.care.jobs) {
      dimension(`care.${job.jobId}.visits`, job.visits.length, job.terminal ? 0 : Math.max(0, SECT_CARE_LIMITS.visits - job.visits.length), SECT_CARE_LIMITS.visits);
      dimension(`care.${job.jobId}.spans`, job.workSpans.length, job.terminal ? 0 : Math.max(0, SECT_CARE_LIMITS.workTicks - job.workSpans.length), SECT_CARE_LIMITS.workTicks);
    }
    const sequenceReserve = { ...extra.sequenceReserve, nextAction: sum(extra.sequenceReserve.nextAction, clock.additionalActions), nextEvent: sum(extra.sequenceReserve.nextEvent, base.archiveSlots.reserved.events, automatic) };
    for (const key of Object.keys(sequenceReserve) as (keyof typeof sequenceReserve)[]) dimension(`sequence.${key}`, world.sequences[key], sequenceReserve[key], MAX);
    dimension('buildRevision', world.builds.revision, extra.buildRows, MAX);
    dimension('cultivationRevision', world.cultivation.revision, sum(extra.counterReserve.cultivationRevisions, local.counters.cultivationRevision, clock.additionalCultivationRevisions), MAX);
    dimension('calendarMonth', world.cultivation.calendarMonth, extra.counterReserve.calendarMonths, MAX);
    dimension('calendarTick', world.clock.calendarTick, extra.counterReserve.calendarTicks, MAX);
    dimension('simulationTick', world.clock.simulationTick, extra.counterReserve.calendarTicks, MAX);
    dimension('eventsDraws', world.randomStreams.events.draws, numeric.rawEventDrawsRequired, MAX);
    dimension('sect.constructionRevision', records.construction.revision, local.counters.constructionRevision, MAX);
    dimension('sect.productionRevision', records.production.revision, local.counters.productionRevision, MAX);
    dimension('sect.researchRevision', records.research.revision, local.counters.researchRevision, MAX);
    dimension('sect.careRevision', records.care.revision, local.counters.careRevision, MAX);
    dimension('sect.constructionNextId', records.construction.nextId, local.counters.constructionNextId, MAX);
    dimension('sect.productionNextId', records.production.nextId, 0, MAX);
    dimension('sect.researchNextId', records.research.nextId, 0, MAX);
    dimension('sect.careNextId', records.care.nextId, 0, MAX);
    dimension('sect.maintenanceNextId', records.maintenance.nextId, 0, MAX);
    dimension('navVersion', world.map.navVersion, local.counters.navVersion, MAX);
    result.supported = result.sourceRecordIssues.length === 0 && result.unknowns.length === 0 && progression.supported && numeric.supported && sect.supported && clock.supported;
    result.deficits = Object.keys(result.costs).filter(name => result.costs[name]! > result.limits[name]!).map(name => ({ dimension: name,
      current: result.current[name]!, reserved: result.reserved[name]!, cost: result.costs[name]!, limit: result.limits[name]!, excess: result.costs[name]! - result.limits[name]! }));
    result.fits = result.supported && result.actualFits && base.obligationsFit && build.fits && numeric.fits && result.deficits.length === 0;
    result.reason = !result.actualFits ? 'wire-cap' : result.sourceRecordIssues.length ? 'invalid-source' : !result.supported ? 'unproved-obligation' : !result.fits ? 'future-capacity' : 'ready';
  } catch (error) {
    result.supported = false; result.fits = false; result.reason = 'invalid-source';
    result.unknowns.push(error instanceof Error ? error.message : 'Unsupported v9 capacity source');
  }
  return result;
}

function getConstructionWorkTicks(blueprintId: string, world: WorldStateV9): number {
  const bp = world.sectExpansion.construction.blueprints.find(bp => bp.blueprintId === blueprintId);
  const workTicks = bp && getSectBuildingDefinition(bp.definitionId)?.levels[0]?.workTicks;
  if (workTicks === undefined) throw new TypeError('Unknown construction work limit'); return workTicks;
}
