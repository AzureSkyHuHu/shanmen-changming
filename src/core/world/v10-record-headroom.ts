import { isManagementV10Identity } from '../../content/sect-v10/world-content';
import { MAX_CULTIVATION_HISTORY } from '../cultivation/rules';
import { assessBuildHistoryObligations } from '../save-budget/build-obligations';
import { createCanonicalByteCounter } from '../save-budget/canonical-bytes';
import { derivePhaseAwareManagementClockReservation } from '../save-budget/management-clock-reservation';
import { deriveProgressionReservationsTimeV9 } from '../save-budget/progression-time-v9';
import { assessHistoryExpansion, assessHistorySlots, manualProductionByteObligations } from '../save-budget/retention';
import { deriveSectReservationsV10 } from '../save-budget/sect-obligations-v10';
import { CONSTRUCTION_LIMITS } from '../sect-expansion/construction-types';
import { SECT_CARE_LIMITS } from '../sect-expansion/care-types';
import { SECT_MAINTENANCE_LIMITS } from '../sect-expansion/maintenance-types';
import { SECT_PRODUCTION_LIMITS } from '../sect-expansion/production-types';
import { SECT_RESEARCH_LIMITS } from '../sect-expansion/research-types';
import { MANAGEMENT_V10_PROTOCOL, SECT_UPGRADE_LIMITS_V10, type WorldStateV10 } from '../sect-expansion/upgrade-types';
import { assessProgressionNumeric } from './progression-numeric';
import { V9_CULTIVATION_CLOCK_LIMIT } from './v9-cultivation-clock-types';
import { deriveV10BuildObligationFacts } from './v10-build-obligations';

/** Fixed structural derivations shared by the two internal queries. No supplied
 * budget, callback, alternate content context or purported certificate is accepted.
 * The complete-record root remains separate so it may call the narrow check without
 * recursively invoking whole-World validation or whole-envelope sizing. */
export function deriveV10RecordReservations(world: WorldStateV10) {
  createCanonicalByteCounter().measure(world);
  const protocol = MANAGEMENT_V10_PROTOCOL;
  if (world.simulationVersion !== protocol.simulationVersion || world.runtimeProtocol !== protocol.runtimeProtocol
    || world.contentVersion !== protocol.contentVersion || !isManagementV10Identity(world.contentIdentity)
    || world.sectExpansion.schemaVersion !== protocol.sectSchemaVersion) throw new TypeError('Unsupported v10 record identity');
  const facts = deriveV10BuildObligationFacts(world);
  const build = assessBuildHistoryObligations(facts);
  const progression = deriveProgressionReservationsTimeV9({ world, buildFacts: facts });
  const numeric = assessProgressionNumeric(world, progression);
  const sect = deriveSectReservationsV10(world);
  const clock = derivePhaseAwareManagementClockReservation(world, progression);
  return { build, progression, numeric, sect, clock };
}

/** Known finite record/counter obligations ONLY. An empty issue list is neither
 * current-save fit nor fully funded continuation, terminal discharge, import or
 * runtime admission. The caller must authenticate its complete actual v10 source.
 * This helper intentionally has no dependency on the complete-record root. */
export function inspectV10KnownRecordHeadroom(world: WorldStateV10): string[] {
  try {
    const { build, progression, numeric, sect, clock } = deriveV10RecordReservations(world);
    const issues: string[] = [];
    if (!build.fits) issues.push('Build terminal record capacity exhausted');
    if (!progression.supported || !numeric.supported || !numeric.fits || !sect.supported || !clock.supported) {
      issues.push('Unproved v10 finite record/counter obligation');
    }
    const extra = progression.totals; const local = sect.totals; const records = world.sectExpansion;
    const remaining = (current: number, reserved: number, limit: number): boolean =>
      Number.isSafeInteger(current) && current >= 0 && Number.isSafeInteger(reserved) && reserved >= 0 && current <= limit - reserved;
    const automatic = Object.keys(world.automaticProduction.live).length;
    const manual = manualProductionByteObligations(world, world.map);
    const slots = assessHistorySlots(world, automatic, manual.count, []);
    const expansion = assessHistoryExpansion(world, world.map, automatic, manual.archiveBytes, 0, slots);
    if (!slots.fits || !expansion.fits) issues.push('Production terminal archive capacity exhausted');
    for (const key of ['production', 'commandReceipts', 'events'] as const) if (!remaining(slots.current[key],
      slots.reserved[key] + (key === 'production' ? 0 : extra.archiveRows[key]), slots.limitPerTable)) issues.push(`Combined ${key} archive rows exhausted`);
    if (!remaining(expansion.currentCharacters, expansion.reservedCharacters + extra.archiveDecodedCharacters, expansion.characterLimit)
      || !remaining(expansion.currentNodes, expansion.reservedNodes + extra.archiveDecodedNodes, expansion.nodeLimit)) issues.push('Combined terminal archive reader capacity exhausted');
    for (const key of Object.keys(extra.cultivationRows) as (keyof typeof extra.cultivationRows)[]) {
      if (!remaining(world.cultivation[key].length, extra.cultivationRows[key], MAX_CULTIVATION_HISTORY)) issues.push(`Cultivation ${key} terminal records exhausted`);
    }
    for (const key of ['history', 'receipts', 'retiredDisciples', 'awards'] as const) {
      if (!remaining(world.builds[key].length, extra.buildCollections[key], 16_384)) issues.push(`Build ${key} reader rows exhausted`);
    }
    const knownIdentities = new Set([...world.disciples.map(actor => actor.id), ...world.legacy.archivedIdentities.map(actor => actor.discipleId)]).size;
    for (const key of ['estates', 'archivedIdentities'] as const) if (!remaining(world.legacy[key].length, extra.legacyRows[key], knownIdentities)) {
      issues.push(`Legacy ${key} destinations exceed actual identities`);
    }
    const sectRows: readonly (readonly [string, number, number, number])[] = [
      ['construction jobs', records.construction.jobs.length, local.rows.constructionJobs, CONSTRUCTION_LIMITS.records],
      ['construction receipts', records.construction.receipts.length, local.rows.constructionReceipts, CONSTRUCTION_LIMITS.receipts],
      ['construction buildings', world.buildings.length + records.construction.buildings.length, local.rows.constructionBuildings, CONSTRUCTION_LIMITS.buildings],
      ['production receipts', records.production.receipts.length, local.rows.productionReceipts, SECT_PRODUCTION_LIMITS.receipts],
      ['research receipts', records.research.receipts.length, local.rows.researchReceipts, SECT_RESEARCH_LIMITS.receipts],
      ['care receipts', records.care.receipts.length, local.rows.careReceipts, SECT_CARE_LIMITS.receipts],
      ['paired claims', records.reservations.length, local.rows.pairedClaims, SECT_MAINTENANCE_LIMITS.pairedClaims],
    ];
    for (const [label, current, reserved, limit] of sectRows) if (!remaining(current, reserved, limit)) issues.push(`Sect ${label} terminal rows exhausted`);
    if (!remaining(world.cultivationClock.transitions.length, clock.reservedRows, V9_CULTIVATION_CLOCK_LIMIT)) issues.push('Cultivation clock rows exhausted');
    const liveUpgrades = records.upgrade.jobs.filter(job => job.terminal === null).length;
    if (!remaining(records.upgrade.jobs.length, 0, SECT_UPGRADE_LIMITS_V10.records)
      || !remaining(records.upgrade.receipts.length, liveUpgrades, SECT_UPGRADE_LIMITS_V10.receipts)
      || !remaining(records.upgrade.revision, liveUpgrades, Number.MAX_SAFE_INTEGER)) issues.push('Upgrade terminal record/revision headroom exhausted');
    const reserve = { ...extra.sequenceReserve,
      nextAction: extra.sequenceReserve.nextAction + clock.additionalActions,
      nextEvent: extra.sequenceReserve.nextEvent + slots.reserved.events + automatic };
    for (const key of Object.keys(reserve) as (keyof typeof reserve)[]) if (!remaining(world.sequences[key], reserve[key], Number.MAX_SAFE_INTEGER)) issues.push(`Terminal ${key} headroom exhausted`);
    const counters: readonly (readonly [number, number])[] = [
      [world.builds.revision, extra.buildRows],
      [world.cultivation.revision, extra.counterReserve.cultivationRevisions + local.counters.cultivationRevision + clock.additionalCultivationRevisions],
      [world.cultivation.calendarMonth, extra.counterReserve.calendarMonths],
      [world.clock.calendarTick, clock.calendarTicks], [world.clock.simulationTick, clock.calendarTicks],
      [records.construction.revision, local.counters.constructionRevision + clock.calendarTicks],
      [records.production.revision, local.counters.productionRevision + clock.calendarTicks],
      [records.research.revision, local.counters.researchRevision + clock.calendarTicks],
      [records.care.revision, local.counters.careRevision],
      [records.construction.nextId, local.counters.constructionNextId], [world.map.navVersion, local.counters.navVersion],
    ];
    if (counters.some(([current, reserved]) => !remaining(current, reserved, Number.MAX_SAFE_INTEGER))) issues.push('Terminal clock/domain counter headroom exhausted');
    for (const actor of world.disciples) if (!remaining(world.clock.calendarTick - actor.birthCalendarTick, clock.calendarTicks, Number.MAX_SAFE_INTEGER)) {
      issues.push(`Birthday subtraction headroom exhausted: ${actor.id}`);
    }
    return issues;
  } catch {
    // Never read an arbitrary caller-thrown error object.
    return ['Unsupported v10 known-record headroom source'];
  }
}
