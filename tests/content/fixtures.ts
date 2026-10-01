import { combatCatalog } from '../../src/content/definitions/index.ts';

/** Intentional corruptions of real authored content, not separate permissive test schemas. */
export function brokenFixture(path: readonly (string | number)[], value: unknown): unknown {
  const copy: unknown = structuredClone(combatCatalog);
  let target = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  target[path[path.length - 1]!] = value;
  return copy;
}
export const brokenFixtures = {
  negativeCost: () => brokenFixture(['skills', 0, 'action', 'spiritCostUnits'], -1),
  fractionalTicks: () => brokenFixture(['skills', 0, 'action', 'cooldownTicks'], 1.5),
  excessiveProcDepth: () => brokenFixture(['skills', 10, 'mechanics', 'triggers', 0, 'proc', 'maxDepth'], 9),
  excessiveDerivedEffects: () => brokenFixture(['skills', 10, 'mechanics', 'triggers', 0, 'proc', 'maxDerivedEffects'], 65),
  arbitraryOperation: () => brokenFixture(['skills', 0, 'action', 'effects', 0, 'kind'], 'executeScript'),
  arbitraryCodeField: () => brokenFixture(['skills', 0, 'action', 'effects', 0, 'script'], 'throw new Error("must not execute")'),
  arbitraryConditionField: () => brokenFixture(['skills', 0, 'action', 'condition'], { kind: 'compare', field: 'actor.constructor', operator: 'eq', value: 0 }),
  arbitrarySelector: () => brokenFixture(['skills', 0, 'action', 'target'], { kind: 'query', expression: 'all()' }),
  duplicateDefinition: () => brokenFixture(['skills', 1, 'id'], 'skill.liuhen-jian'),
  danglingStatus: () => brokenFixture(['skills', 0, 'action', 'effects', 1, 'statusId'], 'status.missing'),
  invalidStackCount: () => brokenFixture(['skills', 0, 'action', 'effects', 1, 'stacks'], 4),
  forwardConsumeResult: () => brokenFixture(['skills', 1, 'action', 'effects', 2, 'amount', 'resultKey'], 'missingResult'),
  treeCycle: () => brokenFixture(['treeNodes', 0, 'prerequisites'], ['node.sword.guichao']),
  skippedTier: () => brokenFixture(['treeNodes', 2, 'prerequisites'], []),
  impossibleTreeBudget: () => brokenFixture(['trees', 0, 'maximumPoints'], 2),
  wrongLifecycle: () => brokenFixture(['talents', 0, 'lifecycleScope'], 'character'),
  wrongTeamStack: () => brokenFixture(['talents', 1, 'teamStackPolicy'], 'notApplicable'),
  noStarter: () => brokenFixture(['builds', 0, 'starterSkillIds'], ['skill.jianxin']),
  hiddenCapability: () => brokenFixture(['skills', 0, 'requiredCapabilities'], []),
  copyValueDrift: () => brokenFixture(['skills', 0, 'descriptionParameters', 'cost'], 999),
  invalidPeriodicDuration: () => brokenFixture(['statuses', 1, 'duration'], { kind: 'ticks', ticks: 20 }),
  negativeMultiplier: () => {
    const copy = brokenFixture(['skills', 4, 'mechanics', 'onInstall', 0, 'modifier', 'operation'], 'multiplyBps');
    const skill = (copy as { skills: { mechanics: { onInstall: { modifier: { value: number } }[] } }[] }).skills[4]!;
    skill.mechanics.onInstall[0]!.modifier.value = -1;
    return copy;
  },
};
