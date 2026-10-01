import type { ActiveAction, CombatTag, EffectPrimitive, Mechanics, School, SkillDefinition, TargetSelector } from '../../core/combat/definitions/types.ts';
import { all, always, apply, area, augment, base, compare, consume, damage, enemyShield, flag, heal, intent, mechanics, modifier, paidActive, requiredCapabilities, restore, rule, self, shield, status, ticks, trigger } from './helpers.ts';

function active(id: string, school: School, tags: readonly CombatTag[], cost: number, cooldown: number, cast: number, effects: readonly EffectPrimitive[], target: TargetSelector = intent, ultimate = false, m = mechanics()): SkillDefinition {
  const action: ActiveAction = { spiritCostUnits: cost, cooldownTicks: cooldown, castTicks: cast, rangeUnits: target.kind === 'self' ? 0 : tags.includes('melee') ? 160 : 600, targetTeam: target.kind === 'self' ? 'self' : ['yuanhu', 'huichun', 'qingxin', 'yaowang-ding'].includes(id) ? 'ally' : 'enemy', target, condition: always, effects, commitPolicy: 'castEndRevalidate', missRefundPolicy: 'none', launchedSourceDeathPolicy: 'resolveCommitted' };
  return { ...base(`skill.${id}`, 10, requiredCapabilities(m, effects), { cost, cooldownTicks: cooldown, castTicks: cast }), kind: 'skill', school, activation: 'active', lifecycleScope: 'character', tags: [school, 'active', ...tags, ...(ultimate ? ['ultimate' as const] : [])], ultimate, action, mechanics: m };
}
function passive(id: string, school: School, tags: readonly CombatTag[], m: Mechanics): SkillDefinition {
  return { ...base(`skill.${id}`, 10, requiredCapabilities(m)), kind: 'skill', school, activation: 'passive', lifecycleScope: 'character', tags: [school, 'passive', ...tags], mechanics: m };
}
const consumedDamage: EffectPrimitive = { ...damage(0), kind: 'damage', amount: { kind: 'consumed', resultKey: 'swordMarks', stat: 'attack', coefficientPerStackBps: 5000, flatPerStackUnits: 0 } };
const poisonExplosion: EffectPrimitive = { ...damage(0, 'fire'), kind: 'damage', amount: { kind: 'consumed', resultKey: 'poisonStacks', stat: 'attack', coefficientPerStackBps: 6000, flatPerStackUnits: 0 } };

/** 24 exact named §10 candidates. All numbers are unbalanced tuning baselines. */
export const skills: readonly SkillDefinition[] = [
  active('liuhen-jian', 'sword', ['damage', 'swordMark', 'melee'], 10, 80, 8, [damage(9000), apply('status.sword-mark', 1, 160)]),
  active('guifeng', 'sword', ['damage', 'swordMark', 'melee'], 16, 140, 14, [consume('status.sword-mark', 3, 'swordMarks'), damage(10_000), consumedDamage]),
  active('guanri-jianjue', 'sword', ['damage', 'ranged', 'beam', 'penetration', 'interrupt'], 20, 200, 24, [{ ...damage(17_000), armorPenetrationBps: 3000 }, { kind: 'interrupt', target: intent, condition: always, strength: 2 }]),
  active('wanjian-chaozong', 'sword', ['damage', 'area'], 65, 900, 40, [{ kind: 'zone', target: intent, condition: always, radiusUnits: 240, intervalTicks: 20, duration: ticks(100), effects: [damage(4500, 'physical', area('enemy', 240, 'intent'))] }], intent, true),
  passive('jianxin', 'sword', [], mechanics([modifier('swordCritical', 'criticalChanceBps', 600, ['sword'], 'addFlat')])),
  passive('cangfeng', 'sword', [], mechanics([], [], [rule('patientEdge', ['active'], { kind: 'bonusDamageBps', value: 2000 }, compare('event.idleTicks', 'gte', 80))])),
  active('baoyue', 'body', ['shield'], 14, 160, 10, [shield(2200, 120)], self),
  active('zhenbu', 'body', ['damage', 'control', 'melee', 'area'], 18, 200, 16, [damage(7000, 'physical', area('enemy', 140)), apply('status.stagger', 1, 24, area('enemy', 140))], self),
  active('yuanhu', 'body', ['shield', 'guard', 'movement'], 22, 280, 8, [{ kind: 'move', target: intent, condition: always, mode: 'toAlly', maximumDistanceUnits: 600 }, shield(1600, 80, intent)]),
  active('budong-shan', 'body', ['shield', 'guard', 'area'], 70, 1000, 30, [shield(2600, 120, area('ally', 600)), apply('status.guarded', 1, 100, area('ally', 600))], self, true),
  passive('pangu', 'body', ['control'], mechanics([], [trigger('steadfastBone', 'control.ended', always, [apply('status.control-resistance', 1, 160, self)], 20)])),
  passive('xujin', 'body', ['shield', 'storedForce'], mechanics([], [trigger('bankForce', 'shield.absorbed', enemyShield, [{ kind: 'storeForce', target: self, condition: always, coefficientBps: 4000, maximumHealthBps: 1500 }])])),
  active('qingwu', 'alchemy', ['poison', 'area', 'damage'], 12, 120, 14, [apply('status.poison', 1, 160, area('enemy', 200, 'intent'))]),
  active('huichun', 'alchemy', ['heal'], 18, 160, 16, [heal(15_000)]),
  active('qingxin', 'alchemy', ['cleanse'], 20, 280, 12, [{ kind: 'dispel', target: intent, condition: always, category: 'debuff', count: 1 }, apply('status.control-resistance', 1, 100)]),
  active('yaowang-ding', 'alchemy', ['heal', 'area'], 60, 800, 36, [{ kind: 'zone', target: intent, condition: always, radiusUnits: 240, intervalTicks: 20, duration: ticks(140), effects: [heal(3500, area('ally', 240, 'intent'))] }], intent, true),
  passive('yaoli', 'alchemy', ['heal', 'medicine'], mechanics([], [trigger('medicineBloom', 'action.committed', all(paidActive, { kind: 'hasTag', subject: 'eventSource', tag: 'heal' }, status('status.medicine')), [consume('status.medicine', 2, 'medicineStacks', self), { kind: 'heal', target: intent, condition: always, amount: { kind: 'consumed', resultKey: 'medicineStacks', stat: 'attack', coefficientPerStackBps: 3000, flatPerStackUnits: 0 }, rounding: 'floor' }])])),
  passive('yuxi', 'alchemy', ['heal'], mechanics([], [trigger('lastBreath', 'life.beforeDowned', always, [{ kind: 'preventDowned', target: self, condition: always, healthFloorBps: 1000 }], 600, 1)])),
  active('yinlei', 'talisman', ['lightning', 'damage', 'ranged'], 14, 120, 18, [damage(12_000, 'lightning'), apply('status.shock', 1, 100)]),
  active('fenzhang', 'talisman', ['fire', 'damage', 'poison'], 18, 160, 20, [consume('status.poison', 3, 'poisonStacks'), damage(7000, 'fire'), poisonExplosion]),
  active('zhikui', 'talisman', ['summon'], 25, 360, 24, [{ kind: 'summon', target: self, condition: always, summonId: 'summon.paper-decoy', maximumPerCaster: 1, duration: ticks(160) }], self),
  active('zhenyue-fu', 'talisman', ['control', 'area'], 75, 1100, 50, [apply('status.stagger', 1, 60, area('enemy', 280, 'intent')), damage(8000, 'physical', area('enemy', 280, 'intent'))], intent, true),
  passive('fumai', 'talisman', ['rune'], mechanics([], [trigger('runeMeridian', 'action.committed', paidActive, [apply('status.rune', 1, 200, self)], 20)])),
  passive('xunyi', 'talisman', ['rune'], mechanics([], [
    trigger('recordSchools', 'action.committed', paidActive, [{ kind: 'recordCast', target: self, condition: always, windowTicks: 160, maximumRecords: 3, distinctBy: 'school' }], 0, 999, 'allies'),
    { ...trigger('schoolRotation', 'castHistory.recorded', compare('event.distinctSchoolCount', 'gte', 3), [augment(['active'], { kind: 'costReductionBps', value: 2000, minimumCostUnits: 1 })], 160), proc: { ...trigger('schoolRotation', 'castHistory.recorded', always, []).proc, internalCooldownTicks: 160, allowIndirectFamilies: ['recordSchools'] } },
  ])),
];
