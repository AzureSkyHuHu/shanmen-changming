import { MAX_CULTIVATION_HISTORY } from '../cultivation/rules';
import { RESOURCE_IDS } from '../economy/types';
import { checkedAdd } from '../kernel/numeric';
import { assessAutomaticWorkBudget, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import type { AutomaticSaveBudgetAssessment } from '../save-budget';
import { deriveProgressionReservations, measureProgressionRecord, verifyProgressionReservationDischarges } from '../save-budget/progression-bounds';
import type { ProgressionReservationAssessment } from '../save-budget/progression-bounds';
import type { BuildHistoryObligationAssessment } from '../save-budget/build-obligations';
import { worldAutomaticBudgetInput } from './automatic-work-bridge';
import { assessWorldBuildHistoryObligations, worldBuildHistoryObligationFacts } from './progression-obligations';
import { assessProgressionNumeric } from './progression-numeric';
import type { ProgressionNumericAssessment } from './progression-numeric';
import type { WorldStateV8 } from './v8-types';

export type ProgressionCapacityReason = 'ready' | 'wire-cap' | 'future-capacity' | 'unproved-obligation';
export interface WorldProgressionCapacity {
  /** Deliberately excludes active-run continuation until its separate owner budget exists. */
  scope: 'management-progression'; supported: boolean; actualFits: boolean; fits: boolean;
  reason: ProgressionCapacityReason; automaticStartAllowance: 0 | 1 | 2;
  base: AutomaticSaveBudgetAssessment; progression: ProgressionReservationAssessment;
  build: BuildHistoryObligationAssessment; numeric: ProgressionNumericAssessment;
  /** Complete current+reserved cost in each covered hard-cap dimension. */
  costs: Record<string, number>; limits: Record<string, number>; unknowns: string[];
}
const MAX = Number.MAX_SAFE_INTEGER;
// Overflow is an explicit capacity deficit, never a thrown numeric admission.
const sum = (...values: number[]): number => values.reduce((total, value) => total > MAX - value ? Number.POSITIVE_INFINITY : total + value, 0);
/** Typed terminal record growth is additional to the existing production/journal
 * reserve. Subtotals are never charged twice; decoded archive nodes already carry
 * their codec surcharge. No output from this query is saved as authority. */
export function assessWorldProgressionCapacity(world: WorldStateV8, maximumNewAutomaticStarts = 0): WorldProgressionCapacity {
  const base = assessAutomaticWorkBudget({ ...worldAutomaticBudgetInput(world, maximumNewAutomaticStarts), save: { saveVersion: 8 } });
  const facts = worldBuildHistoryObligationFacts(world); const build = assessWorldBuildHistoryObligations(world);
  const progression = deriveProgressionReservations({ world, buildFacts: facts }); const extra = progression.totals;
  const numeric = assessProgressionNumeric(world, progression); const unknowns = [...progression.unknowns];
  if (base.unsupportedPendingKinds.length) unknowns.push('Pending command effects are not bounded');
  if (world.expedition.run && world.expedition.run.phase !== 'Ended') unknowns.push('Active run, battle, terminal proof and return-clearance obligations require their separate budget');
  if (!numeric.supported) unknowns.push(...numeric.diagnostics);
  const costs: Record<string, number> = {
    wireBytes: sum(base.encodedBytes, base.reservedBytes, extra.bytes),
    archiveProductionRows: sum(base.archiveSlots.current.production, base.archiveSlots.reserved.production),
    archiveReceiptRows: sum(base.archiveSlots.current.commandReceipts, base.archiveSlots.reserved.commandReceipts, extra.archiveRows.commandReceipts),
    archiveEventRows: sum(base.archiveSlots.current.events, base.archiveSlots.reserved.events, extra.archiveRows.events),
    archiveCharacters: sum(base.archiveExpansion.currentCharacters, base.archiveExpansion.reservedCharacters, extra.archiveDecodedCharacters),
    archiveNodes: sum(base.archiveExpansion.currentNodes, base.archiveExpansion.reservedNodes, extra.archiveDecodedNodes),
    buildCommands: sum(world.builds.history.length, extra.buildRows),
  };
  const limits: Record<string, number> = { wireBytes: SAVE_FILE_LIMIT_BYTES,
    archiveProductionRows: base.archiveSlots.limitPerTable, archiveReceiptRows: base.archiveSlots.limitPerTable, archiveEventRows: base.archiveSlots.limitPerTable,
    archiveCharacters: base.archiveExpansion.characterLimit, archiveNodes: base.archiveExpansion.nodeLimit, buildCommands: build.maximumCommands };
  for (const name of Object.keys(extra.cultivationRows) as (keyof typeof extra.cultivationRows)[]) {
    costs[`cultivation.${name}`] = sum(world.cultivation[name].length, extra.cultivationRows[name]); limits[`cultivation.${name}`] = MAX_CULTIVATION_HISTORY;
  }
  // The ordinary build reader limits its complete JSON tree to 300k values. Apply
  // all covered domain growth conservatively to each standalone reader; this is
  // intentionally an upper envelope, not an allocation of bytes between domains.
  const builds = measureProgressionRecord({ format: 'shanmen-builds', version: 2, checksum: '00000000', frame: { builds: world.builds, sequences: world.sequences } });
  const culture = measureProgressionRecord({ format: 'shanmen-cultivation', version: 3, checksum: '00000000', frame: {
    cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences } });
  const maximumInventory = { ...world.inventory };
  for (const resourceId of RESOURCE_IDS) maximumInventory[resourceId] = { ...world.inventory[resourceId], owned: MAX, reserved: MAX, capacity: MAX };
  const inventoryCharacters = Math.max(0, measureProgressionRecord(maximumInventory).decodedCharacters - measureProgressionRecord(world.inventory).decodedCharacters);
  costs.buildReaderCharacters = sum(builds.decodedCharacters, extra.domainDecodedCharacters); limits.buildReaderCharacters = 4_000_000;
  costs.buildReaderNodes = sum(builds.decodedNodes, extra.domainDecodedNodes); limits.buildReaderNodes = 300_000;
  costs.cultivationReaderCharacters = sum(culture.decodedCharacters, extra.domainDecodedCharacters, inventoryCharacters); limits.cultivationReaderCharacters = 4_000_000;
  const sequenceReserve = { ...extra.sequenceReserve };
  // Production terminal metadata uses one event; a temporary automatic notice
  // followed by its first public cancellation acknowledgement can use a second.
  sequenceReserve.nextEvent = sum(sequenceReserve.nextEvent, base.archiveSlots.reserved.events, Object.keys(world.automaticProduction.live).length);
  for (const command of world.pendingCommands) {
    if (world.commandReceipts[command.commandId]) continue;
    if (command.kind === 'production.start') { sequenceReserve.nextAction = sum(sequenceReserve.nextAction, 1); sequenceReserve.nextInstance = sum(sequenceReserve.nextInstance, 2); }
    else if (command.kind === 'inventory.discard') sequenceReserve.nextAction = sum(sequenceReserve.nextAction, 1);
  }
  for (const key of Object.keys(sequenceReserve) as (keyof typeof sequenceReserve)[]) {
    costs[`sequence.${key}`] = sum(world.sequences[key], sequenceReserve[key]); limits[`sequence.${key}`] = MAX;
  }
  costs.buildRevision = sum(world.builds.revision, extra.buildRows); limits.buildRevision = MAX;
  costs.cultivationRevision = sum(world.cultivation.revision, extra.counterReserve.cultivationRevisions); limits.cultivationRevision = MAX;
  costs.calendarMonth = sum(world.cultivation.calendarMonth, extra.counterReserve.calendarMonths); limits.calendarMonth = MAX;
  costs.calendarTick = sum(world.clock.calendarTick, extra.counterReserve.calendarTicks); limits.calendarTick = MAX;
  costs.simulationTick = sum(world.clock.simulationTick, extra.counterReserve.calendarTicks); limits.simulationTick = MAX;
  costs.eventsDraws = sum(world.randomStreams.events.draws, numeric.rawEventDrawsRequired); limits.eventsDraws = MAX;
  const supported = progression.supported && numeric.supported && unknowns.length === 0;
  const fits = supported && base.actualFits && numeric.fits && Object.keys(costs).every(key => costs[key]! <= limits[key]!);
  const room = (key: string) => Math.max(0, limits[key]! - costs[key]!);
  const automaticStartAllowance = fits ? Math.max(0, Math.min(base.autoStartAllowance,
    Math.floor(room('wireBytes') / base.perNewJobBytes), room('archiveReceiptRows'), room('archiveEventRows'),
    Math.floor(room('archiveCharacters') / base.archiveExpansion.perNewAutomaticJob), Math.floor(room('archiveNodes') / base.archiveExpansion.perNewAutomaticJob),
    room('sequence.nextAction'), Math.floor(room('sequence.nextEvent') / 3), room('sequence.nextInstance'))) : 0;
  return { scope: 'management-progression', supported, actualFits: base.actualFits, fits,
    reason: !base.actualFits ? 'wire-cap' : !supported ? 'unproved-obligation' : !fits ? 'future-capacity' : 'ready',
    automaticStartAllowance: automaticStartAllowance as 0 | 1 | 2, base, progression, build, numeric, costs, limits, unknowns };
}

export type WorldProgressionAdmission = { ok: true; assessment: WorldProgressionCapacity }
  | { ok: false; code: 'SAVE_CAPACITY_EXCEEDED' | 'SAVE_OBLIGATION_UNBOUNDED'; assessment: WorldProgressionCapacity };
/** Existing-obligation release requires a recognized real transition and the
 * complete validated before/after boundary. A vanished plan alone is insufficient. */
export function verifyWorldProgressionTransition(before: WorldStateV8, after: WorldStateV8, kind: 'new' | 'reserved-progress' = 'new'): WorldProgressionAdmission {
  const assessment = assessWorldProgressionCapacity(after);
  if (assessment.fits) return { ok: true, assessment };
  if (kind === 'reserved-progress' && assessment.supported && assessment.actualFits) {
    const previous = assessWorldProgressionCapacity(before);
    const released = verifyProgressionReservationDischarges({ world: before, assessment: previous.progression }, { world: after, assessment: assessment.progression });
    const progressed = before.cultivation.attempts.some(attempt => ['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase)
      && after.cultivation.attempts.some(next => next.attemptId === attempt.attemptId && (next.completedMonths > attempt.completedMonths || next.phase !== attempt.phase)))
      || before.cultivation.disciples.some(profile => profile.teaching && after.cultivation.disciples.some(next => next.discipleId === profile.discipleId
        && next.teaching?.teachingId === profile.teaching!.teachingId && next.teaching.completedMonths > profile.teaching!.completedMonths));
    if (previous.supported && released.supported && (released.discharged.length > 0 || progressed)
      && Object.keys(assessment.costs).every(key => assessment.costs[key]! <= previous.costs[key]!)) return { ok: true, assessment };
  }
  return { ok: false, code: assessment.supported ? 'SAVE_CAPACITY_EXCEEDED' : 'SAVE_OBLIGATION_UNBOUNDED', assessment };
}
