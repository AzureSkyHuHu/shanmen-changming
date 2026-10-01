import type { CombatContentCatalog, CombatDefinition } from '../../core/combat/definitions/types.ts';
import { skills } from './skills.ts';
import { statuses, summons } from './statuses.ts';
import { treeNodes, trees } from './trees.ts';
import { builds, talents } from './talents.ts';
export { skills, statuses, summons, treeNodes, trees, builds, talents };

/** Authoring foundation only. No executable capability is certified by this catalog. */
export const combatCatalog: CombatContentCatalog = {
  schemaVersion: 1, contentVersion: '0.1.0-combat-foundation', requiredSimulationVersion: 'combat-protocol-1',
  scope: 'combat-definition-foundation', ticksPerSecond: 20, targetTalentCount: 48,
  skills, statuses, summons, treeNodes, trees, builds, talents,
};
export function allCombatDefinitions(catalog: CombatContentCatalog): readonly CombatDefinition[] {
  return [...catalog.skills, ...catalog.statuses, ...catalog.summons, ...catalog.treeNodes, ...catalog.trees, ...catalog.talents, ...catalog.builds];
}
