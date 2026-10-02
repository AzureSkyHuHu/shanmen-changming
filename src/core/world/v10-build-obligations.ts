import { managementV10BuildContext } from '../../content/sect-v10/world-content';
import { REALMS } from '../cultivation/types';
import type { BuildHistoryObligationFacts } from '../save-budget/build-obligations';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';

/** Actual version-owned inputs only; returned sizing facts confer no admission. */
export type V10BuildObligationSource = Pick<WorldStateV10, 'contentIdentity' | 'cultivation' | 'builds' | 'legacy'>;
/** Structural facts shared by internal v10 record inspection and read-only capacity queries.
 * No legacy World wrapper, caller-supplied authority or persisted budget is involved. */
export function deriveV10BuildObligationFacts(world: V10BuildObligationSource): BuildHistoryObligationFacts {
  const profiles = new Map(world.cultivation.disciples.map(profile => [profile.discipleId, profile]));
  const awardIds = new Set<string>();
  for (const profile of profiles.values()) for (const realm of REALMS.slice(1, REALMS.indexOf(profile.realm) + 1)) {
    if (!world.builds.awards.some(award => award.discipleId === profile.discipleId && award.ruleId === `realm.${realm}`)) awardIds.add(`realm/${profile.discipleId}/${realm}`);
  }
  for (const attempt of world.cultivation.attempts) if (['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase)
    && attempt.preview.targetRealm && !world.builds.awards.some(award => award.discipleId === attempt.discipleId && award.ruleId === `realm.${attempt.preview.targetRealm}`)) awardIds.add(`realm/${attempt.discipleId}/${attempt.preview.targetRealm}`);
  return { historyCount: world.builds.history.length,
    maximumCommands: managementV10BuildContext(world.contentIdentity).rules.maximumCommands,
    disciples: world.builds.disciples.map(build => ({ discipleId: build.discipleId, lifeState: profiles.get(build.discipleId)!.lifeState, heirId: profiles.get(build.discipleId)!.heirId })),
    retiredDiscipleIds: world.builds.retiredDisciples.map(build => build.discipleId),
    equipment: world.builds.equipment.map(item => ({ itemInstanceId: item.instanceId, ownerDiscipleId: item.owner.kind === 'disciple' ? item.owner.discipleId : null })),
    pendingEstates: world.legacy.estates.filter(estate => estate.settledMonth === null).map(estate => ({ discipleId: estate.discipleId, beneficiaryId: estate.beneficiaryId })),
    teachingIds: [], realmMilestoneIds: [...awardIds], activeRun: null };
}
