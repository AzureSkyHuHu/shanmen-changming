import { validateLegacyBuildFrameV1 as validateBuildFrame } from '../builds/legacy-v1';
import { LEGACY_V7_CONTENT } from '../../content/registry';
import { validateLegacyWorldExpeditionV1 as validateWorldExpedition } from '../expeditions/legacy-world-validation';
import { REALMS } from '../cultivation/types';
import type { LegacyWorldStateV7 as WorldState } from './legacy-types';
const EXPEDITION_COMBAT_CATALOG = LEGACY_V7_CONTENT.combat;

/** Version-neutral collection projection; source validity remains with its selected root. */
export interface BuildInstanceOwnershipSource {
  readonly builds: {
    readonly equipment: readonly { readonly instanceId: string }[];
    readonly disciples: readonly { readonly sources: readonly { readonly sourceInstanceId: string }[] }[];
    readonly receipts: readonly { readonly operations: readonly { readonly source: { readonly sourceInstanceId: string } }[] }[];
  };
}
/** Include removed source instances retained by the immutable build receipt history. */
export function buildOwnedInstanceIds(world: BuildInstanceOwnershipSource): string[] {
  return [...new Set([...world.builds.equipment.map((item) => item.instanceId),
    ...world.builds.disciples.flatMap((d) => d.sources.map((source) => source.sourceInstanceId)),
    ...world.builds.receipts.flatMap((receipt) => receipt.operations.map((operation) => operation.source.sourceInstanceId))])];
}
export function validateWorldProgression(world: WorldState): string[] {
  try { validateBuildFrame({ builds: world.builds, sequences: world.sequences }, EXPEDITION_COMBAT_CATALOG); }
  catch { return ['Invalid permanent build frame']; }
  if (world.builds.disciples.length !== world.disciples.length || world.builds.disciples.some((d) => !world.disciples.some((actor) => actor.id === d.discipleId))) return ['Build identities differ from World'];
  for (const d of world.builds.disciples) {
    const profile = world.cultivation.disciples.find((actor) => actor.discipleId === d.discipleId)!;
    if (profile.activityOwner === null ? d.lock !== null : !d.lock || d.lock.runId !== profile.activityOwner.runId || d.lock.lockId !== profile.activityOwner.lockId) return ['Build/activity ownership differs'];
    const rank = REALMS.indexOf(profile.realm);
    const expectedRealms = REALMS.slice(1, rank + 1);
    const awarded = world.builds.awards.filter((award) => award.discipleId === d.discipleId && award.ruleId.startsWith('realm.'));
    if (expectedRealms.some((realm) => !awarded.some((award) => award.ruleId === `realm.${realm}`))
      || awarded.some((award) => !expectedRealms.some((realm) => award.ruleId === `realm.${realm}`))) return ['Realm milestone awards differ from authoritative progression'];
  }
  return validateWorldExpedition(world);
}
