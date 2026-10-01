import { combatCatalog } from '../../src/content/definitions';
import { applyBuildAuthorityCommand, applyBuildCommand, createBuildFrame, MILESTONE_RULE_IDS } from '../../src/core/builds';
import type { BuildAuthorityCommand, BuildCatalog, BuildCommand, BuildStateFrame } from '../../src/core/builds';
import { prepareCombatCatalog } from '../../src/core/combat/runtime';
export const catalog = prepareCombatCatalog(combatCatalog);
export function fresh(): BuildStateFrame {
  return createBuildFrame({ disciples: [{ discipleId: 'entity:1', school: 'sword' }, { discipleId: 'entity:2', school: 'body' }, { discipleId: 'entity:3', school: 'alchemy' }, { discipleId: 'entity:4', school: 'talisman' }], contentMode: 'experimental' }, catalog);
}
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
export function player(frame: BuildStateFrame, body: Body<BuildCommand>, id = `command:${frame.builds.revision + 1}`, content: BuildCatalog = catalog) {
  return applyBuildCommand(frame, { ...body, commandId: id, expectedRevision: frame.builds.revision } as BuildCommand, content);
}
export function authority(frame: BuildStateFrame, body: Body<BuildAuthorityCommand>, id = `command:${frame.builds.revision + 1}`) {
  return applyBuildAuthorityCommand(frame, { ...body, commandId: id, expectedRevision: frame.builds.revision } as BuildAuthorityCommand, catalog);
}
export function granted(count = 5, discipleId = 'entity:1', initial: BuildStateFrame = fresh()): BuildStateFrame {
  let frame = initial;
  for (const ruleId of MILESTONE_RULE_IDS.slice(0, count)) {
    const result = authority(frame, { kind: 'milestone.award', discipleId, ruleId, milestoneId: `milestone/${discipleId}/${ruleId}` });
    if (!result.ok) throw new Error(result.code); frame = result.frame;
  }
  return frame;
}
