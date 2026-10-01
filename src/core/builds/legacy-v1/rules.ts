// Frozen v7 build-v1 protocol from commit 98e7026. Change only with an explicit legacy compatibility fix.
import type { School } from '../../combat/definitions/types';
import type { BattleEntityInput } from '../../combat/runtime/types';
import type { EquipmentDefinition, MilestoneRuleId, SkillLearningRule } from './types';

export const BUILD_RULES_VERSION = 1 as const;
export const MAX_ALLOCATED_POINTS = 5;
export const MAX_BUILD_COMMANDS = 1024;
export const MAX_BUILD_DISCIPLES = 36;
export const MAX_BUILD_EQUIPMENT = 512;
export const MILESTONE_RULE_IDS: readonly MilestoneRuleId[] = Object.freeze(['realm.qi', 'realm.foundation', 'realm.golden-core', 'realm.nascent-soul', 'expedition.first-victory']);
export const BUILD_SCHOOLS: readonly School[] = Object.freeze(['sword', 'body', 'alchemy', 'talisman']);
export const EQUIPMENT_SLOTS = ['weapon', 'robe', 'artifact'] as const;
export const EQUIPMENT_DEFINITIONS: readonly EquipmentDefinition[] = Object.freeze([
  ...BUILD_SCHOOLS.map(school => Object.freeze({ id: `equipment.training-${school}`, slot: 'weapon' as const, school, tags: Object.freeze([school]) as readonly School[], flatStats: Object.freeze({ attack: 3 }), maximumSpiritBonus: 0 })),
  Object.freeze({ id: 'equipment.training-robe', slot: 'robe', school: null, tags: Object.freeze([]), flatStats: Object.freeze({ maxHealth: 20, armor: 1 }), maximumSpiritBonus: 0 }),
  Object.freeze({ id: 'equipment.training-artifact', slot: 'artifact', school: null, tags: Object.freeze([]), flatStats: Object.freeze({}), maximumSpiritBonus: 20 }),
]);
export const STARTER_SKILLS: Readonly<Record<School, readonly [string, string, string]>> = Object.freeze({
  sword: Object.freeze(['skill.liuhen-jian', 'skill.guifeng', 'skill.jianxin'] as const),
  body: Object.freeze(['skill.baoyue', 'skill.zhenbu', 'skill.xujin'] as const),
  alchemy: Object.freeze(['skill.qingwu', 'skill.huichun', 'skill.yaoli'] as const),
  talisman: Object.freeze(['skill.yinlei', 'skill.fenzhang', 'skill.fumai'] as const),
});
/** Explicit provisional progression, separate from authored combat mechanics. No random reward is required. */
const SCHOOL_LESSONS = [
  ['liuhen-jian', 'guifeng', 'guanri-jianjue', 'wanjian-chaozong', 'jianxin', 'cangfeng'],
  ['baoyue', 'zhenbu', 'yuanhu', 'budong-shan', 'pangu', 'xujin'],
  ['qingwu', 'huichun', 'qingxin', 'yaowang-ding', 'yaoli', 'yuxi'],
  ['yinlei', 'fenzhang', 'zhikui', 'zhenyue-fu', 'fumai', 'xunyi'],
] as const;
export const SKILL_LEARNING_RULES: readonly SkillLearningRule[] = Object.freeze(SCHOOL_LESSONS.flatMap(slugs => slugs.map((slug, index) => Object.freeze({
  skillId: `skill.${slug}`, creditCost: index === 3 ? 3 : index === 2 || index === 5 ? 2 : 1,
  requiredSkillIds: Object.freeze(index === 0 ? [] : index === 3 ? [`skill.${slugs[0]}`, `skill.${slugs[1]}`] : [`skill.${slugs[0]}`]),
  requiredNodeIds: Object.freeze([] as string[]),
}))));
export function basicDefinition(school: School): NonNullable<BattleEntityInput['basic']> {
  return { school, coefficientBps: 10_000, cooldownTicks: 20, castTicks: 0, rangeUnits: school === 'body' ? 160 : 600 };
}
export function basicId(school: School): string { return `basic.${school}`; }
export function equipmentDefinition(id: string): EquipmentDefinition | undefined { return EQUIPMENT_DEFINITIONS.find(definition => definition.id === id); }
export function skillLearningRule(id: string): SkillLearningRule | undefined { return SKILL_LEARNING_RULES.find(rule => rule.skillId === id); }
