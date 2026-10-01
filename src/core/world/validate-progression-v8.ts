import { validateBuildFrameV2 } from '../builds/v2';
import { validateWorldExpeditionV8 } from '../expeditions/v8-world-validation';
import { REALMS } from '../cultivation/types';
import { getWorldBuildContentContext } from './content-access';
import { validateWorldCampaign } from './validate-campaign';
import type { WorldStateV8 } from './v8-types';
export function validateWorldProgressionV8(world: WorldStateV8): string[] {
  try {
    const context = getWorldBuildContentContext(world); if (!context) return ['Missing current build context'];
    validateBuildFrameV2({ builds: world.builds, sequences: world.sequences }, context);
    if (world.builds.disciples.length !== world.disciples.length || world.builds.disciples.some(build => !world.disciples.some(actor => actor.id === build.discipleId))) return ['Build identities differ from World'];
    for (const build of world.builds.disciples) {
      const profile = world.cultivation.disciples.find(actor => actor.discipleId === build.discipleId);
      if (!profile || (profile.activityOwner === null ? build.lock !== null : !build.lock || build.lock.runId !== profile.activityOwner.runId || build.lock.lockId !== profile.activityOwner.lockId)) return ['Build/activity ownership differs'];
    }
    for (const profile of [...world.cultivation.disciples, ...world.cultivation.archivedDisciples]) {
      const expected = REALMS.slice(1, REALMS.indexOf(profile.realm) + 1);
      const awarded = world.builds.awards.filter(award => award.discipleId === profile.discipleId && award.ruleId.startsWith('realm.'));
      if (expected.some(realm => !awarded.some(award => award.ruleId === `realm.${realm}`))
        || awarded.some(award => !expected.some(realm => award.ruleId === `realm.${realm}`))) return ['Realm milestones differ from authoritative progression'];
    }
    const campaign = validateWorldCampaign(world); if (campaign.length) return campaign;
    return validateWorldExpeditionV8(world);
  } catch (error) { return [error instanceof Error ? error.message : 'Invalid current progression state']; }
}
