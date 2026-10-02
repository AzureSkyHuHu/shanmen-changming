import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import { isManagementV10Identity } from '../../content/sect-v10/world-content';
import { MAX_CULTIVATION_HISTORY, MAX_CULTIVATORS } from '../cultivation/rules';
import { inspectUnregisteredWorldV10Records } from '../kernel/validation';
import { assessAutomaticWorkBudget, SAVE_FILE_LIMIT_BYTES, type AutomaticSaveBudgetAssessment } from '../save-budget/admission';
import { type BuildHistoryObligationAssessment } from '../save-budget/build-obligations';
import { createCanonicalByteCounter } from '../save-budget/canonical-bytes';
import { measureWorldSaveBytes } from '../save-budget/envelope';
import { measureProgressionRecord, type ProgressionReservationAssessment } from '../save-budget/progression-bounds';
import { type SectObligationAssessmentV10 } from '../save-budget/sect-obligations-v10';
import { CONSTRUCTION_LIMITS } from '../sect-expansion/construction-types';
import { SECT_CARE_LIMITS } from '../sect-expansion/care-types';
import { CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND } from '../sect-expansion/descriptor-bounds';
import { SECT_UPGRADE_DESCRIPTOR_NODE_BOUND_V10 } from '../sect-expansion/descriptor-bounds-v10';
import { SECT_MAINTENANCE_LIMITS } from '../sect-expansion/maintenance-types';
import { SECT_PRODUCTION_LIMITS } from '../sect-expansion/production-types';
import { SECT_RESEARCH_LIMITS } from '../sect-expansion/research-types';
import { type ProgressionNumericAssessment } from './progression-numeric';
import { deriveV10RecordReservations } from './v10-record-headroom';
import { captureV10RecordData } from './v10-sect-records';
import { projectV10SectFrame } from './v10-sect-frame';
import { V9_CULTIVATION_CLOCK_LIMIT } from './v9-cultivation-clock-types';
import { type ManagementClockReservation } from '../save-budget/management-clock-reservation';
import { MANAGEMENT_V10_PROTOCOL, SECT_UPGRADE_LIMITS_V10, type WorldStateV10 } from '../sect-expansion/upgrade-types';
import { RANDOM_STREAM_NAMES } from '../kernel/random';

const MAX = Number.MAX_SAFE_INTEGER;
// Existing build-v2/cultivation-v3 snapshot readers use these independent limits.
// They are not inferred from UTF-8 bytes. The node ceiling is builds/shared.ts's
// assertJson default; cultivation-v3 has no aggregate descriptor node ceiling.
const DOMAIN_READER_CHARACTER_LIMIT = 4_000_000;
const BUILD_READER_NODE_LIMIT = 300_000;
const BUILD_READER_ARRAY_LIMIT = 16_384;
function sum(...values: number[]): number { return values.reduce((total, value) => total > MAX - value ? Infinity : total + value, 0); }
export interface ManagementCapacityV10 {
  scope: 'v10-immediate-recovery-and-record-peaks';
  /** Sizing evidence never constitutes a save/import/command admission. */
  admitted: false; importAuthorized: false; eventualCompletionSupported: false;
  /** Neither structural fits nor current wire fit proves an executable route. */
  fullyFundedContinuation: false; terminalDischargeProved: false;
  measuredEnvelopeBytes: number | null; actualFits: boolean; supported: boolean; fits: boolean;
  reason: 'ready' | 'invalid-source' | 'unproved-obligation' | 'wire-cap' | 'future-capacity';
  current: Record<string, number>; reserved: Record<string, number>; costs: Record<string, number>; limits: Record<string, number>;
  deficits: { dimension: string; current: number; reserved: number; cost: number; limit: number; excess: number }[];
  base: AutomaticSaveBudgetAssessment | null; build: BuildHistoryObligationAssessment | null;
  progression: ProgressionReservationAssessment | null; numeric: ProgressionNumericAssessment | null; sect: SectObligationAssessmentV10 | null;
  clock: ManagementClockReservationV10 | null;
  sourceRecordIssues: string[]; unknowns: string[]; excludedProofs: readonly string[];
}
export type ManagementClockReservationV10 = ManagementClockReservation;
/** Whole actual fixed-v10 record/envelope sizing only. Every call captures its own
 * descriptor-only source; caller inputs and returned diagnostics confer no authority.
 * No codec, runtime gate, continuation route or discharge certificate is installed. */
export function assessManagementCapacityV10(input: WorldStateV10): ManagementCapacityV10 {
  const result: ManagementCapacityV10 = { scope: 'v10-immediate-recovery-and-record-peaks', admitted: false, importAuthorized: false,
    eventualCompletionSupported: false, fullyFundedContinuation: false, terminalDischargeProved: false,
    measuredEnvelopeBytes: null, actualFits: false, supported: false, fits: false, reason: 'unproved-obligation',
    current: {}, reserved: {}, costs: {}, limits: {}, deficits: [], base: null, build: null, progression: null, numeric: null, sect: null,
    clock: null, sourceRecordIssues: [], unknowns: [], excludedProofs: [
      'Public v10 codec, Session, content and UI registration; public import authority',
      'Executable finite teaching continuation/reachable recovery with the sixth owner; record sizing alone does not prove it',
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
    // First reject ordinary getters/non-JSON, then isolate all typed reads. The
    // preliminary measurement permits an over-cap diagnostic if capture refuses.
    const counter = createCanonicalByteCounter(); counter.measure(input);
    result.measuredEnvelopeBytes = measureWorldSaveBytes(input, { saveVersion: 10, counter });
    result.actualFits = result.measuredEnvelopeBytes <= SAVE_FILE_LIMIT_BYTES;
    const world = captureV10RecordData(input) as WorldStateV10;
    const measured = measureWorldSaveBytes(world, { saveVersion: 10, counter });
    result.measuredEnvelopeBytes = measured; result.actualFits = measured <= SAVE_FILE_LIMIT_BYTES;
    const protocol = MANAGEMENT_V10_PROTOCOL;
    if (world.simulationVersion !== protocol.simulationVersion || world.runtimeProtocol !== protocol.runtimeProtocol
      || world.contentVersion !== protocol.contentVersion || !isManagementV10Identity(world.contentIdentity)) throw new TypeError('Requires exact management v10 identity');
    result.sourceRecordIssues = inspectUnregisteredWorldV10Records(world);
    // Invalid synthetic pressure inputs may still have useful sizing diagnostics;
    // they can never produce supported/fits=true, regardless of their byte count.
    if (world.pendingCommands.length || world.clock.mode !== 'management' || world.expedition.run !== null) result.unknowns.push('Persisted queues and departures are outside the fixed v10 scope');
    const automatic = Object.keys(world.automaticProduction.live).length;
    const base = assessAutomaticWorkBudget({ world, map: world.map, liveAutomaticJobCount: automatic,
      pendingCommands: world.pendingCommands, maximumNewStarts: 0, journalBytes: counter.measure(world.automaticProduction.journal), save: { saveVersion: 10, counter } });
    result.base = base;
    if (base.encodedBytes !== measured) throw new TypeError('Whole-envelope measurement differs');
    const { build, progression, numeric, sect, clock } = deriveV10RecordReservations(world);
    result.build = build; result.progression = progression; result.numeric = numeric; result.sect = sect; result.clock = clock;
    result.unknowns.push(...progression.unknowns, ...sect.unknowns, ...clock.unknowns);
    if (!numeric.supported) result.unknowns.push(...numeric.diagnostics);
    if (base.unsupportedPendingKinds.length) result.unknowns.push('Unsupported pending command effects');
    const extra = progression.totals; const local = sect.totals; const records = world.sectExpansion;
    // Equation: whole envelope ONCE + existing production/journal/general margin
    // + progression ONCE + sect ONCE + phase-aware clock rows ONCE. Existing clock
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
    dimension('cultivation.disciples', world.cultivation.disciples.length, 0, MAX_CULTIVATORS);
    // These destinations have no independent invented 100000-row allowance.
    // Each actual identity can retire/settle once; the destination must still pass
    // the separate real build/cultivation reader limits below.
    const knownIdentities = new Set([...world.disciples.map(actor => actor.id), ...world.legacy.archivedIdentities.map(actor => actor.discipleId)]).size;
    dimension('legacy.archivedIdentities', world.legacy.archivedIdentities.length, extra.legacyRows.archivedIdentities, knownIdentities);
    dimension('legacy.estates', world.legacy.estates.length, extra.legacyRows.estates, knownIdentities);
    const buildArrayGrowth: Record<string, number> = {
      'builds.history': extra.buildCollections.history, 'builds.receipts': extra.buildCollections.receipts,
      'builds.retiredDisciples': extra.buildCollections.retiredDisciples, 'builds.awards': extra.buildCollections.awards,
    };
    // assertJson imposes this on EVERY array, including immutable origin/history
    // children. The pinned v10 facts have no future permanent teaching grants;
    // retirement copies existing bounded learnedSkills/sources rather than growing
    // them. New history/receipt command arrays have fixed small typed schemas.
    const arrays = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        dimension(`buildArray.${path}`, value.length, buildArrayGrowth[path] ?? 0, BUILD_READER_ARRAY_LIMIT);
        value.forEach((child, index) => arrays(child, `${path}.${index}`));
      } else for (const [key, child] of Object.entries(value)) arrays(child, `${path}.${key}`);
    };
    arrays(world.builds, 'builds');
    // Sect receipts remain local, including real system/v10/death/* cancellation.
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
    dimension('sect.upgradeJobs', records.upgrade.jobs.length, local.rows.upgradeJobs, SECT_UPGRADE_LIMITS_V10.records);
    dimension('sect.upgradeReceipts', records.upgrade.receipts.length, local.rows.upgradeReceipts, SECT_UPGRADE_LIMITS_V10.receipts);
    const activeConstruction = records.construction.jobs.filter(job => !job.terminal).length;
    const activeProduction = records.production.jobs.filter(job => !job.terminal).length;
    const activeResearch = records.research.jobs.filter(job => !job.terminal).length;
    const activeCare = records.care.jobs.filter(job => !job.terminal).length;
    const activeUpgrade = records.upgrade.jobs.filter(job => !job.terminal).length;
    dimension('activeWorkers', world.activeProductionTransactionIds.length + activeConstruction + activeProduction + activeResearch + activeCare + activeUpgrade, 0, CONSTRUCTION_LIMITS.activeJobs);
    dimension('sect.activeConstruction', activeConstruction, 0, CONSTRUCTION_LIMITS.activeJobs);
    dimension('sect.activeProduction', activeProduction, 0, SECT_PRODUCTION_LIMITS.activeJobs);
    dimension('sect.activeResearch', activeResearch, 0, SECT_RESEARCH_LIMITS.activeJobs);
    dimension('sect.activeUpgrade', activeUpgrade, 0, SECT_UPGRADE_LIMITS_V10.activeJobs);
    const builds = measureProgressionRecord({ format: 'shanmen-builds', version: 2, checksum: '00000000', frame: { builds: world.builds, sequences: world.sequences } });
    const culture = measureProgressionRecord({ format: 'shanmen-cultivation', version: 3, checksum: '00000000', frame: { cultivation: world.cultivation,
      inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences } });
    dimension('buildReaderCharacters', builds.decodedCharacters, extra.domainDecodedCharacters, DOMAIN_READER_CHARACTER_LIMIT);
    dimension('buildReaderNodes', builds.decodedNodes, extra.domainDecodedNodes, BUILD_READER_NODE_LIMIT);
    // Shared sect width ALREADY includes the full inventory scalar delta.
    dimension('cultivationReaderCharacters', culture.decodedCharacters, sum(extra.domainDecodedCharacters, sect.shared.decodedCharacters), DOMAIN_READER_CHARACTER_LIMIT);
    const frame = projectV10SectFrame(world);
    const constructionNodes = measureProgressionRecord(frame.construction).decodedNodes;
    // The fixed v10 root invokes the construction reader on this full paired
    // book, and the upgrade reader on ALL six domains. Old aggregate production,
    // research and maintenance readers are not invoked and are not fake gates.
    const constructionGrowth = sect.owners.reduce((total, owner) => total + Math.max(0, ...owner.branches.map(branch =>
      branch.records.filter(record => record.label.startsWith('construction.') || record.label === 'paired-ledger'
        || record.label === 'World.worker.position+traveling').reduce((nodes, record) => nodes + record.decodedNodes, 0))), 0);
    dimension('constructionReaderNodes', constructionNodes, constructionGrowth, CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND);
    dimension('sectV10ReaderNodes', measureProgressionRecord(frame).decodedNodes, local.decodedNodes, SECT_UPGRADE_DESCRIPTOR_NODE_BOUND_V10);
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
    for (const job of records.upgrade.jobs) {
      for (const [field, limit] of [['siteVisits', SECT_UPGRADE_LIMITS_V10.siteVisits], ['workSpans', SECT_UPGRADE_LIMITS_V10.workSpans],
        ['checkpoints', SECT_UPGRADE_LIMITS_V10.checkpoints]] as const) dimension(`upgrade.${job.jobId}.${field}`, job[field].length,
        job.terminal ? 0 : Math.max(0, limit - job[field].length), limit);
    }
    // Real local readers bound route arrays by map cells, independently of bytes.
    for (const [kind, jobs] of [['construction', records.construction.jobs], ['production', records.production.jobs],
      ['research', records.research.jobs], ['care', records.care.jobs], ['upgrade', records.upgrade.jobs]] as const) {
      for (const job of jobs) dimension(`${kind}.${'jobId' in job ? job.jobId : job.transactionId}.navigationCells`, job.navigation.path.length,
        job.terminal ? 0 : Math.max(0, world.map.width * world.map.height - job.navigation.path.length), world.map.width * world.map.height);
    }
    const sequenceReserve = { ...extra.sequenceReserve, nextAction: sum(extra.sequenceReserve.nextAction, clock.additionalActions), nextEvent: sum(extra.sequenceReserve.nextEvent, base.archiveSlots.reserved.events, automatic) };
    for (const key of Object.keys(sequenceReserve) as (keyof typeof sequenceReserve)[]) dimension(`sequence.${key}`, world.sequences[key], sequenceReserve[key], MAX);
    dimension('buildRevision', world.builds.revision, extra.buildRows, MAX);
    dimension('cultivationRevision', world.cultivation.revision, sum(extra.counterReserve.cultivationRevisions, local.counters.cultivationRevision, clock.additionalCultivationRevisions), MAX);
    dimension('calendarMonth', world.cultivation.calendarMonth, extra.counterReserve.calendarMonths, MAX);
    dimension('calendarTick', world.clock.calendarTick, extra.counterReserve.calendarTicks, MAX);
    dimension('simulationTick', world.clock.simulationTick, extra.counterReserve.calendarTicks, MAX);
    dimension('eventsDraws', world.randomStreams.events.draws, numeric.rawEventDrawsRequired, MAX);
    for (const name of RANDOM_STREAM_NAMES) {
      dimension(`rng.${name}.draws`, world.randomStreams[name].draws, name === 'events' ? numeric.rawEventDrawsRequired : 0, MAX);
      dimension(`rng.${name}.state`, world.randomStreams[name].state, 0, 0xffffffff);
    }
    for (const actor of world.disciples) {
      // Check subtraction itself, not just each individually safe operand.
      dimension(`birthday.${actor.id}.elapsedTicks`, world.clock.calendarTick - actor.birthCalendarTick, clock.calendarTicks, MAX);
      dimension(`birthday.${actor.id}.ageMonths`, actor.ageMonths, extra.counterReserve.calendarMonths + clock.ageSyncRows, MAX);
    }
    for (const actor of world.legacy.archivedIdentities) dimension(`birthday.${actor.discipleId}.archivedElapsedTicks`,
      world.clock.calendarTick - actor.birthCalendarTick, clock.calendarTicks, MAX);
    dimension('sect.constructionRevision', records.construction.revision, sum(local.counters.constructionRevision, clock.calendarTicks), MAX);
    dimension('sect.productionRevision', records.production.revision, sum(local.counters.productionRevision, clock.calendarTicks), MAX);
    dimension('sect.researchRevision', records.research.revision, sum(local.counters.researchRevision, clock.calendarTicks), MAX);
    dimension('sect.careRevision', records.care.revision, local.counters.careRevision, MAX);
    dimension('sect.upgradeRevision', records.upgrade.revision, local.counters.upgradeRevisions, MAX);
    dimension('sect.constructionNextId', records.construction.nextId, local.counters.constructionNextId, MAX);
    dimension('sect.productionNextId', records.production.nextId, 0, MAX);
    dimension('sect.researchNextId', records.research.nextId, 0, MAX);
    dimension('sect.careNextId', records.care.nextId, 0, MAX);
    dimension('sect.maintenanceNextId', records.maintenance.nextId, 0, MAX);
    dimension('sect.upgradeNextId', records.upgrade.nextId, local.counters.upgradeNextId, MAX);
    dimension('navVersion', world.map.navVersion, local.counters.navVersion, MAX);
    result.supported = result.sourceRecordIssues.length === 0 && result.unknowns.length === 0 && progression.supported && numeric.supported && sect.supported && clock.supported;
    result.deficits = Object.keys(result.costs).filter(name => result.current[name]! > result.limits[name]! - result.reserved[name]!).map(name => ({ dimension: name,
      current: result.current[name]!, reserved: result.reserved[name]!, cost: result.costs[name]!, limit: result.limits[name]!,
      // Subtraction preserves an exact one-short diagnosis even when summing two
      // safe operands would overflow safe numeric capacity (cost is then Infinity).
      excess: result.reserved[name]! - (result.limits[name]! - result.current[name]!) }));
    result.fits = result.supported && result.actualFits && base.obligationsFit && build.fits && numeric.fits && result.deficits.length === 0;
    result.reason = !result.actualFits ? 'wire-cap' : result.sourceRecordIssues.length ? 'invalid-source' : !result.supported ? 'unproved-obligation' : !result.fits ? 'future-capacity' : 'ready';
  } catch {
    result.supported = false; result.fits = false; result.reason = result.measuredEnvelopeBytes !== null && !result.actualFits ? 'wire-cap' : 'invalid-source';
    result.unknowns.push('Unsupported bounded v10 capacity source');
  }
  return result;
}

function getConstructionWorkTicks(blueprintId: string, world: WorldStateV10): number {
  const bp = world.sectExpansion.construction.blueprints.find(bp => bp.blueprintId === blueprintId);
  const workTicks = bp && getSectBuildingDefinition(bp.definitionId)?.levels[0]?.workTicks;
  if (workTicks === undefined) throw new TypeError('Unknown construction work limit'); return workTicks;
}
