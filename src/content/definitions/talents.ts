import type { BuildDefinition, CombatTag, Mechanics, TalentDefinition } from '../../core/combat/definitions/types.ts';
import { all, always, apply, area, augment, base, compare, consume, consumed, damage, enemyShield, eventTarget, flag, lowestAlly, mechanics, otherAlly, paidActive, requiredCapabilities, restore, self, shield, status, trigger } from './helpers.ts';

function talent(slug: string, build: string, holderScope: 'personal' | 'team', role: TalentDefinition['offerRole'], sources: readonly CombatTag[], m: Mechanics, section: 14 | 15, binding: TalentDefinition['recipientBinding'] = holderScope === 'team' ? 'team' : 'holder'): TalentDefinition {
  return { ...base(`talent.${slug}`, section, requiredCapabilities(m)), kind: 'talent', lifecycleScope: 'run', holderScope, category: ['xigui-jianmai', 'cuofeng', 'fanzhen', 'zoumai-chengfu'].includes(slug) ? 'school' : 'crossSchool', buildId: `build.${build}`, offerRole: role, maximumRank: 1, prerequisites: [], excludes: [], requiredSourceTags: sources, providesSourceTags: [], tags: sources, teamStackPolicy: holderScope === 'team' ? 'highestValueSharedBudget' : 'notApplicable', recipientBinding: binding, mechanics: m };
}
const fullMarks = all(consumed('status.sword-mark'), compare('event.consumedStacks', 'gte', 3));
const poisonConsumed = all(consumed('status.poison'), compare('event.consumedStacks', 'gt', 0));
/** The 12 actual named §14–15 examples. The other 36 target cards remain unauthored. */
export const talents: readonly TalentDefinition[] = [
  talent('xigui-jianmai', 'huichao-jianzhen', 'personal', 'core', ['swordMark'], mechanics([], [trigger('swordRefund', 'status.consumed', fullMarks, [restore(5)], 60)]), 14),
  talent('shouzhong-shengfeng', 'huichao-jianzhen', 'team', 'bridge', ['shield'], mechanics([], [trigger('sharedShieldMark', 'shield.absorbed', enemyShield, [apply('status.sword-mark', 1, 160, { kind: 'focus' })], 60, 999, 'team')]), 14),
  talent('cuofeng', 'huichao-jianzhen', 'personal', 'support', ['swordMark'], mechanics([], [
    trigger('readyCrossedEdge', 'status.consumed', all(consumed('status.sword-mark'), compare('event.consumedStacks', 'gt', 0)), [apply('status.crossed-edge', 1, 160, self)]),
    trigger('crossedEdgeStrike', 'action.committed', all(flag('event.isBasic'), status('status.crossed-edge')), [consume('status.crossed-edge', 1, 'spentEdge', self), damage(3000, 'physical', eventTarget, true)]),
  ]), 14),
  talent('wenyao-yuxing', 'yaohuo-gonglu', 'personal', 'core', ['poison', 'heal', 'medicine'], mechanics([], [trigger('ownedPoisonMedicine', 'status.consumed', all(poisonConsumed, flag('event.ownedStatus'), flag('event.isActive'), flag('event.differentCaster')), [apply('status.medicine', 1, 200, self)], 0, 999, 'allies')]), 14),
  talent('yaoyan-yanmian', 'yaohuo-gonglu', 'personal', 'support', ['poison'], mechanics([], [{ ...trigger('renewPoison', 'status.consumed', all(poisonConsumed, flag('event.targetAlive'), flag('event.isActive')), [apply('status.poison', 1, 160, eventTarget)], 80), proc: { ...trigger('renewPoison', 'status.consumed', always, []).proc, internalCooldownTicks: 80, perTarget: true } }]), 14),
  talent('yuhuo-zhaolu', 'yaohuo-gonglu', 'team', 'bridge', ['poison', 'fire'], mechanics([], [trigger('fireProtectsAlly', 'status.consumed', all(poisonConsumed, flag('event.isActive')), [shield(500, 80, lowestAlly)], 0, 999, 'team')]), 14),
  talent('fanzhen', 'xuanjia-huixiang', 'personal', 'core', ['storedForce'], mechanics([], [trigger('forceCounter', 'action.committed', flag('event.isBasic'), [{ kind: 'releaseForce', target: eventTarget, condition: always, coefficientBps: 8000, maximumHealthBps: 1500, damageType: 'physical', tags: ['proc', 'physical'] }])]), 15),
  talent('humai', 'xuanjia-huixiang', 'personal', 'support', ['storedForce'], mechanics([], [{ ...trigger('forceAllyShield', 'force.released', always, [shield(600, 80, otherAlly)], 80), proc: { ...trigger('forceAllyShield', 'force.released', always, []).proc, internalCooldownTicks: 80, allowIndirectFamilies: ['forceCounter', 'releaseOnBasic'] } }]), 15),
  talent('bingjian-shouyu', 'xuanjia-huixiang', 'team', 'bridge', ['guard'], mechanics([], [trigger('guardParty', 'command.guard', always, [shield(600, 60, area('ally', 400))], 160, 999, 'team')]), 15),
  talent('yifa-tongming', 'sanyao-liuzhuan', 'team', 'core', ['rune'], mechanics([], [trigger('distinctCasterRune', 'action.committed', all(paidActive, flag('event.differentCaster')), [apply('status.rune', 1, 200, { kind: 'boundHolder' })], 40, 999, 'team')]), 15, 'selectedTalisman'),
  talent('zoumai-chengfu', 'sanyao-liuzhuan', 'personal', 'support', ['rune'], mechanics([], [trigger('runeChainReady', 'action.committed', all(paidActive, status('status.rune', 3)), [consume('status.rune', 3, 'spentRunes', self, 3), augment(['talisman', 'active'], { kind: 'additionalChainTargets', value: 1, staggerTicks: 16 })], 80)]), 15),
  talent('sanyao-hepai', 'sanyao-liuzhuan', 'team', 'bridge', ['active'], mechanics([], [
    trigger('recordPartyCasts', 'action.committed', paidActive, [{ kind: 'recordCast', target: self, condition: always, windowTicks: 120, maximumRecords: 3, distinctBy: 'caster' }], 0, 999, 'team'),
    { ...trigger('threeCasterDiscount', 'castHistory.recorded', compare('event.distinctCasterCount', 'gte', 3), [augment(['active'], { kind: 'costReductionBps', value: 2000, minimumCostUnits: 1 }, 100, 3, area('ally', 800))], 160), proc: { ...trigger('threeCasterDiscount', 'castHistory.recorded', always, []).proc, internalCooldownTicks: 160, allowIndirectFamilies: ['recordPartyCasts'] } },
  ]), 15),
];
const buildRows = [
  ['huichao-jianzhen', 14, ['liuhen-jian', 'guifeng', 'baoyue']],
  ['yaohuo-gonglu', 14, ['qingwu', 'fenzhang', 'huichun', 'yaoli']],
  ['xuanjia-huixiang', 15, ['baoyue', 'zhenbu', 'yuanhu', 'xujin', 'huichun']],
  ['sanyao-liuzhuan', 15, ['liuhen-jian', 'yinlei', 'huichun', 'fumai']],
] as const;
export const builds: readonly BuildDefinition[] = buildRows.map(([slug, section, starters]) => ({ ...base(`build.${slug}`, section, []), kind: 'build', starterSkillIds: starters.map((id) => `skill.${id}`), talentIds: talents.filter((entry) => entry.buildId === `build.${slug}`).map((entry) => entry.id) }));
