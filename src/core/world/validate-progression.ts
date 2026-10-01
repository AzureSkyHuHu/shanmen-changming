import { validateBuildFrame } from '../builds/builds';
import { EXPEDITION_COMBAT_CATALOG } from '../expeditions/encounter-catalog';
import { validateWorldExpedition } from '../expeditions/world-adapter';
import { REALMS } from '../cultivation/types';
import type { WorldState } from './types';

/** Include removed source instances retained by the immutable build receipt history. */
export function buildOwnedInstanceIds(world: WorldState): string[] {
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
