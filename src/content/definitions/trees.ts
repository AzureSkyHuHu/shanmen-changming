import type { Mechanics, School, TreeDefinition, TreeNodeDefinition } from '../../core/combat/definitions/types.ts';
import { all, always, apply, area, augment, base, compare, consume, consumed, damage, enemyShield, eventTarget, flag, mechanics, modifier, otherAlly, paidActive, requiredCapabilities, restore, rule, self, shield, ticks, trigger } from './helpers.ts';

type NodeInput = readonly [slug: string, mechanics: Mechanics];
type Branches = readonly [readonly [NodeInput, NodeInput, NodeInput], readonly [NodeInput, NodeInput, NodeInput], readonly [NodeInput, NodeInput, NodeInput]];
const rules = (...items: Mechanics['actionRules']): Mechanics => mechanics([], [], items);
const positiveConsume = (id: string) => all(consumed(id), compare('event.consumedStacks', 'gt', 0));

const sword: Branches = [
  [
    ['liuhen', rules(rule('stableMark', ['swordMark'], { kind: 'statusStacks', statusId: 'status.sword-mark', value: 1 }))],
    ['yangfeng', rules(rule('longMark', ['swordMark'], { kind: 'statusDurationTicks', value: 40 }))],
    ['guichao', mechanics([], [trigger('tideRefund', 'status.consumed', all(consumed('status.sword-mark'), compare('event.consumedStacks', 'gte', 3)), [restore(3)], 80)])],
  ],
  [
    ['ruiyi', mechanics([modifier('keenCritical', 'criticalChanceBps', 400, ['sword'], 'addFlat')])],
    ['chuanyun', rules(rule('farInterrupt', ['sword', 'ranged', 'interrupt'], { kind: 'interruptStrength', value: 1 }))],
    ['guanri', rules(rule('piercingPower', ['sword', 'penetration'], { kind: 'bonusDamageBps', value: 1500 }), rule('piercingDelay', ['sword', 'penetration'], { kind: 'castTimeTicks', value: 8 }))],
  ],
  [
    ['shoujian', mechanics([{ ...modifier('shieldComposure', 'controlResistanceBps', 1000, [], 'addFlat'), modifier: { ...modifier('shieldComposure', 'controlResistanceBps', 1000, [], 'addFlat').modifier, condition: compare('actor.shieldUnits', 'gt', 0) } }])],
    ['tongpao', mechanics([], [trigger('comradeRhythm', 'command.guard', always, [augment(['sword'], { kind: 'castTimeTicks', value: -4 })], 100)])],
    ['jianzhen', mechanics([], [trigger('shieldMark', 'shield.absorbed', enemyShield, [apply('status.sword-mark', 1, 160, { kind: 'focus' })], 80)])],
  ],
];
const body: Branches = [
  [
    ['houtu', mechanics([modifier('earthHealth', 'maxHealth', 500)])],
    ['baoyue', rules(rule('shieldContinuation', ['shield'], { kind: 'statusDurationTicks', value: 20 }))],
    ['panshan', mechanics([], [trigger('mountainLastStand', 'life.beforeDowned', always, [{ kind: 'preventDowned', target: self, condition: always, healthFloorBps: 1200 }], 800, 1)])],
  ],
  [
    ['tingjin', mechanics([], [trigger('listenForce', 'shield.absorbed', enemyShield, [{ kind: 'storeForce', target: self, condition: always, coefficientBps: 2000, maximumHealthBps: 1500 }])])],
    ['fanshi', mechanics([], [trigger('releaseOnBasic', 'action.committed', flag('event.isBasic'), [{ kind: 'releaseForce', target: eventTarget, condition: always, coefficientBps: 7000, maximumHealthBps: 1500, damageType: 'physical', tags: ['proc', 'physical'] }])])],
    ['huixiang', mechanics([], [{ ...trigger('groupRecoil', 'force.released', always, [damage(2500, 'physical', area('enemy', 220), true)], 160, 3), proc: { ...trigger('groupRecoil', 'force.released', always, []).proc, internalCooldownTicks: 160, maximumActivations: 3, allowIndirectFamilies: ['releaseOnBasic', 'forceCounter'] } }])],
  ],
  [
    ['yuanshou', rules(rule('guardReach', ['guard'], { kind: 'rangeUnits', value: 120 }))],
    ['dingbu', mechanics([], [trigger('steadyAfterControl', 'control.ended', always, [apply('status.control-resistance', 1, 120, self)], 80)])],
    ['gongshou', mechanics([], [trigger('sharedProtection', 'command.guard', always, [shield(600, 60, otherAlly)], 160, 3)])],
  ],
];
const alchemy: Branches = [
  [
    ['qingya', rules(rule('stablePoison', ['poison'], { kind: 'statusDurationTicks', value: 20 }))],
    ['bianxing', rules(rule('poisonWindow', ['poison'], { kind: 'statusDurationTicks', value: 40 }))],
    ['gonglu', mechanics([], [trigger('medicineAfterPoison', 'status.consumed', all(positiveConsume('status.poison'), flag('event.ownedStatus')), [apply('status.medicine', 1, 200, self)], 60, 999, 'allies')])],
  ],
  [
    ['huiqi', mechanics([modifier('healingEfficiency', 'healingBps', 600, [], 'addFlat')])],
    ['humai', mechanics([], [trigger('overhealShield', 'healing.resolved', compare('event.overhealing', 'gt', 0), [{ kind: 'shield', target: eventTarget, condition: always, amount: { kind: 'event', field: 'overhealing', coefficientBps: 2500, capStat: 'maxHealth', capBps: 500 }, lifecycleScope: 'encounter', duration: ticks(80), stackPolicy: 'refreshSource', rounding: 'floor' }], 60)])],
    ['xuming', mechanics([], [trigger('crisisRescue', 'life.downed', always, [{ kind: 'rescue', target: eventTarget, condition: always, healthBps: 1500, recoveryLockTicks: 40 }], 1000, 1, 'allies')])],
  ],
  [
    ['qingshi', rules(rule('cleanseMore', ['cleanse'], { kind: 'dispelCount', value: 1 }))],
    ['tiaoxi', mechanics([], [trigger('cleanseStability', 'action.committed', all(paidActive, { kind: 'hasTag', subject: 'eventSource', tag: 'cleanse' }), [apply('status.control-resistance', 1, 80, eventTarget)], 80)])],
    ['yaoheng', mechanics([], [trigger('poisonHealingRhythm', 'action.committed', all(paidActive, { kind: 'hasTag', subject: 'eventSource', tag: 'poison' }), [augment(['heal'], { kind: 'costReductionBps', value: 1500, minimumCostUnits: 1 })], 120)])],
  ],
];
const talisman: Branches = [
  [
    ['yinhu', rules(rule('arcReach', ['lightning'], { kind: 'rangeUnits', value: 100 }))],
    ['ganying', rules(rule('shockDuration', ['lightning'], { kind: 'statusDurationTicks', value: 40 }))],
    ['leiwang', rules(rule('lightningChain', ['lightning'], { kind: 'additionalChainTargets', value: 1, staggerTicks: 0 }), rule('chainTradeoff', ['lightning'], { kind: 'bonusDamageBps', value: -2000 }))],
  ],
  [
    ['qiwen', mechanics([], [trigger('firstRune', 'action.committed', paidActive, [apply('status.rune', 1, 200, self)], 60)])],
    ['zhuanyi', mechanics([], [trigger('otherSchoolRune', 'action.committed', all(paidActive, flag('event.differentSchool')), [apply('status.rune', 1, 200, self)], 80, 999, 'allies')])],
    ['sanyao', mechanics([], [trigger('runeEconomy', 'action.committed', all(paidActive, { kind: 'hasStatus', subject: 'actor', statusId: 'status.rune', minimumStacks: 3 }), [consume('status.rune', 3, 'spentRunes', self, 3), augment(['active'], { kind: 'costReductionBps', value: 2000, minimumCostUnits: 1 })], 160)])],
  ],
  [
    ['zhishen', mechanics([modifier('paperHealth', 'maxHealth', 1500, ['summon'])])],
    ['fuzhen', rules(rule('bindingDuration', ['control'], { kind: 'statusDurationTicks', value: 10 }))],
    ['zhenyue', rules(rule('mountainRadius', ['control', 'area'], { kind: 'areaRadiusUnits', value: 80 }), rule('mountainDelay', ['control', 'area'], { kind: 'castTimeTicks', value: 10 }))],
  ],
];
const schoolBranches: readonly (readonly [School, Branches])[] = [['sword', sword], ['body', body], ['alchemy', alchemy], ['talisman', talisman]];
export const treeNodes: readonly TreeNodeDefinition[] = schoolBranches.flatMap(([school, branches]) => branches.flatMap((nodes, branchIndex) => nodes.map(([slug, m], tierIndex): TreeNodeDefinition => ({
  ...base(`node.${school}.${slug}`, 12, requiredCapabilities(m)), kind: 'treeNode', lifecycleScope: 'character', treeId: `tree.${school}`, school, tags: [school], branch: (['a', 'b', 'c'] as const)[branchIndex]!, tier: (tierIndex + 1) as 1 | 2 | 3, pointCost: 1,
  prerequisites: nodes.slice(0, tierIndex).map(([previous]) => `node.${school}.${previous}`), excludes: [], mechanics: m,
}))));
export const trees: readonly TreeDefinition[] = schoolBranches.map(([school]) => ({
  ...base(`tree.${school}`, 12, [], { maximumPoints: 5 }), kind: 'tree', school, lifecycleScope: 'character', tags: [school], maximumPoints: 5, nodeIds: treeNodes.filter((node) => node.school === school).map((node) => node.id),
}));
