import { SECT_CARE_LIMITS } from '../sect-expansion/care-types';
import { managementV9BuildContext } from '../../content/sect-v9/world-content';
import { MAX_CULTIVATION_HISTORY } from '../cultivation/rules';
import { REALMS } from '../cultivation/types';
import { assessBuildHistoryObligations, type BuildHistoryObligationFacts } from '../save-budget/build-obligations';
import { deriveProgressionReservations } from '../save-budget/progression-bounds';
import { assessHistoryExpansion, assessHistorySlots, manualProductionByteObligations } from '../save-budget/retention';
import { assessProgressionNumeric } from './progression-numeric';
import type { WorldStateV9 } from './v9-types';

/** Structural facts shared by internal v9 record inspection and read-only capacity queries.
 * No legacy World wrapper, caller-supplied authority or persisted budget is involved. */
export function deriveV9BuildObligationFacts(world: WorldStateV9): BuildHistoryObligationFacts {
  const profiles = new Map(world.cultivation.disciples.map(profile => [profile.discipleId, profile]));
  const awardIds = new Set<string>();
  for (const profile of profiles.values()) for (const realm of REALMS.slice(1, REALMS.indexOf(profile.realm) + 1)) {
    if (!world.builds.awards.some(award => award.discipleId === profile.discipleId && award.ruleId === `realm.${realm}`)) awardIds.add(`realm/${profile.discipleId}/${realm}`);
  }
  for (const attempt of world.cultivation.attempts) if (['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase)
    && attempt.preview.targetRealm && !world.builds.awards.some(award => award.discipleId === attempt.discipleId && award.ruleId === `realm.${attempt.preview.targetRealm}`)) awardIds.add(`realm/${attempt.discipleId}/${attempt.preview.targetRealm}`);
  return { historyCount: world.builds.history.length,
    maximumCommands: managementV9BuildContext(world.contentIdentity).rules.maximumCommands,
    disciples: world.builds.disciples.map(build => ({ discipleId: build.discipleId, lifeState: profiles.get(build.discipleId)!.lifeState, heirId: profiles.get(build.discipleId)!.heirId })),
    retiredDiscipleIds: world.builds.retiredDisciples.map(build => build.discipleId),
    equipment: world.builds.equipment.map(item => ({ itemInstanceId: item.instanceId, ownerDiscipleId: item.owner.kind === 'disciple' ? item.owner.discipleId : null })),
    pendingEstates: world.legacy.estates.filter(estate => estate.settledMonth === null).map(estate => ({ discipleId: estate.discipleId, beneficiaryId: estate.beneficiaryId })),
    teachingIds: [], realmMilestoneIds: [...awardIds], activeRun: null };
}

/** Known finite record/counter obligations only. Deliberately NOT whole-save bytes,
 * reader-union admission, perpetual time/cancellation growth or an exit certificate. */
export function inspectV9KnownRecordHeadroom(world: WorldStateV9): string[] {
  const care = world.sectExpansion.care; const activeCare = care.jobs.filter(job => !job.terminal).length;
  // Starts preallocate their only job/reservation IDs. Completion adds a fixed effect in
  // that existing job; forced cancellation adds at most one already-reserved receipt.
  if (care.jobs.length > SECT_CARE_LIMITS.records || care.receipts.length + activeCare > SECT_CARE_LIMITS.receipts
    || care.revision > Number.MAX_SAFE_INTEGER - activeCare) return ['Care terminal record/revision headroom exhausted'];
  const facts = deriveV9BuildObligationFacts(world);
  const build = assessBuildHistoryObligations(facts); if (!build.fits) return ['Build terminal record capacity exhausted'];
  const progression = deriveProgressionReservations({ world, buildFacts: facts });
  const numeric = assessProgressionNumeric(world, progression);
  if (!progression.supported || !numeric.supported || !numeric.fits) return ['Unbounded progression record/counter obligation'];
  const extra = progression.totals;
  const automatic = Object.keys(world.automaticProduction.live).length;
  const manual = manualProductionByteObligations(world, world.map);
  const slots = assessHistorySlots(world, automatic, manual.count, []);
  const expansion = assessHistoryExpansion(world, world.map, automatic, manual.archiveBytes, 0, slots);
  if (!slots.fits || !expansion.fits) return ['Production cancellation record capacity exhausted'];
  for (const key of ['production', 'commandReceipts', 'events'] as const) {
    if (slots.current[key] + slots.reserved[key] + (key === 'production' ? 0 : extra.archiveRows[key]) > slots.limitPerTable) return ['Combined terminal archive rows exhausted'];
  }
  if (expansion.currentCharacters + expansion.reservedCharacters + extra.archiveDecodedCharacters > expansion.characterLimit
    || expansion.currentNodes + expansion.reservedNodes + extra.archiveDecodedNodes > expansion.nodeLimit) return ['Combined terminal archive reader capacity exhausted'];
  for (const key of Object.keys(extra.cultivationRows) as (keyof typeof extra.cultivationRows)[]) {
    if (world.cultivation[key].length + extra.cultivationRows[key] > MAX_CULTIVATION_HISTORY) return ['Cultivation terminal records exhausted'];
  }
  const reserve = { ...extra.sequenceReserve, nextEvent: extra.sequenceReserve.nextEvent + slots.reserved.events + automatic };
  for (const key of Object.keys(reserve) as (keyof typeof reserve)[]) {
    if (world.sequences[key] > Number.MAX_SAFE_INTEGER - reserve[key]) return ['Terminal ID headroom exhausted'];
  }
  if (world.cultivation.revision > Number.MAX_SAFE_INTEGER - extra.counterReserve.cultivationRevisions - activeCare
    || world.clock.simulationTick > Number.MAX_SAFE_INTEGER - Math.max(20, extra.counterReserve.calendarTicks)) return ['Terminal clock/revision headroom exhausted'];
  return [];
}
