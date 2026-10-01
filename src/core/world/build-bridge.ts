import { createAutomaticProductionState } from '../economy/automatic-production';
import { createHistoryArchive } from '../history';
import { applyBuildAuthorityCommand, applyBuildCommand, createBuildFrame } from '../builds/builds';
import { BUILD_SCHOOLS } from '../builds/rules';
import type { BuildAuthorityCommand, BuildCommand, BuildData, BuildError, BuildReceipt, MilestoneRuleId } from '../builds/types';
import { EXPEDITION_COMBAT_CATALOG } from '../expeditions/encounter-catalog';
import { initializeWorldExpedition } from '../expeditions/world-adapter';
import { REALMS } from '../cultivation/types';
import { createSectEconomyState } from '../sect-economy/state';
import { cloneJson, compareStable } from '../kernel/serialization';
import type { CultivationWorld, WorldState } from './types';

export interface WorldBuildResult { commandId: string; kind: BuildCommand['kind']; revision: number; resultId: string | null }
export type WorldBuildTransition = { ok: true; world: WorldState; result: WorldBuildResult; eventIds: string[] }
  | { ok: false; code: BuildError };

/** These slash-separated authority IDs cannot be accepted by the kernel's player command ID grammar. */
export function reconcileWorldRealmMilestones(world: WorldState): WorldState {
  let next = world;
  for (const profile of [...world.cultivation.disciples].sort((a, b) => compareStable(a.discipleId, b.discipleId))) {
    const rank = REALMS.indexOf(profile.realm);
    for (const realm of REALMS.slice(1, rank + 1)) {
      const ruleId = `realm.${realm}` as MilestoneRuleId;
      if (next.builds.awards.some((award) => award.discipleId === profile.discipleId && award.ruleId === ruleId)) continue;
      const command: BuildAuthorityCommand = { kind: 'milestone.award', commandId: `system/realm/${profile.discipleId}/${realm}`,
        expectedRevision: next.builds.revision, milestoneId: `realm/${profile.discipleId}/${realm}`, discipleId: profile.discipleId, ruleId };
      const result = applyBuildAuthorityCommand({ builds: next.builds, sequences: next.sequences }, command, EXPEDITION_COMBAT_CATALOG);
      if (!result.ok) throw new Error(`Realm milestone settlement failed: ${result.code}`);
      next = { ...next, builds: cloneJson(result.frame.builds) as BuildData, sequences: { ...result.frame.sequences } };
    }
  }
  return next;
}

/** Fresh world / explicit schema migration only. Never use this to reset an existing build ledger. */
export function attachWorldProgression(world: CultivationWorld): WorldState {
  const sorted = [...world.disciples].sort((a, b) => compareStable(a.id, b.id));
  const frame = createBuildFrame({ disciples: sorted.map((d, index) => ({ discipleId: d.id, school: BUILD_SCHOOLS[index % BUILD_SCHOOLS.length]! })),
    contentMode: 'experimental', sequences: world.sequences }, EXPEDITION_COMBAT_CATALOG);
  return reconcileWorldRealmMilestones({ ...world, builds: cloneJson(frame.builds) as BuildData, sequences: { ...frame.sequences }, expedition: initializeWorldExpedition(),
    sectEconomy: createSectEconomyState(world.clock.simulationTick), history: createHistoryArchive(), automaticProduction: createAutomaticProductionState() });
}

export function dispatchWorldBuild(world: WorldState, command: BuildCommand): WorldBuildTransition {
  const profile = world.cultivation.disciples.find((d) => d.discipleId === command.discipleId);
  if (!profile) return { ok: false, code: 'UNKNOWN_DISCIPLE' };
  if (profile.activityOwner !== null) return { ok: false, code: 'EXPEDITION_LOCKED' };
  if (profile.lifeState !== 'alive' || world.clock.mode !== 'management') return { ok: false, code: 'INVALID_STATE' };
  const result = applyBuildCommand({ builds: world.builds, sequences: world.sequences }, command, EXPEDITION_COMBAT_CATALOG);
  if (!result.ok) return { ok: false, code: result.code };
  const receipt = result.receipt as BuildReceipt;
  return { ok: true, world: { ...world, builds: cloneJson(result.frame.builds) as BuildData, sequences: { ...result.frame.sequences } }, eventIds: [],
    result: { commandId: command.commandId, kind: command.kind, revision: receipt.revision, resultId: receipt.resultId } };
}
