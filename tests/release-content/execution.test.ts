import { describe, expect, it } from 'vitest';
import type { BattleState, BattleEntityInput } from '../../src/core/combat';
import { cleanupBattleScope, createBattle, installCombatSource, issueCommand, prepareCombatCatalog, removeCombatSource, restoreBattle, serializeBattle, shieldUnits, statusStacks, stepBattle } from '../../src/core/combat';
import type { ActiveAction, CombatContentCatalog, EffectPrimitive, SkillDefinition } from '../../src/core/combat/definitions/types';
import { always, apply, base, damage, heal, mechanics, requiredCapabilities, self, shield } from '../../src/content/definitions/helpers';
import { releaseCombatCatalog, releaseTalentRows } from '../../src/content/release';

const A = 'entity:1', B = 'entity:2', C = 'entity:3', E = 'entity:4';
const basic = { coefficientBps: 10000, cooldownTicks: 1, castTicks: 0, rangeUnits: 600, school: 'sword' } as const;
const arena = { origin: { x: 0, y: 0 }, widthCells: 32, heightCells: 16, cellSizeUnits: 20, blockedCells: [] };
function testSkill(slug: string, effects: readonly EffectPrimitive[], extra: Partial<ActiveAction> = {}): SkillDefinition {
  return { ...base(`skill.release-test-${slug}`, 10, requiredCapabilities(mechanics(), effects), { cost: 1, cooldownTicks: 1, castTicks: extra.castTicks ?? 0 }),
    kind: 'skill', school: 'body', activation: 'active', lifecycleScope: 'character', tags: ['active'], ultimate: false, mechanics: mechanics(),
    action: { spiritCostUnits: 1, cooldownTicks: 1, castTicks: 0, rangeUnits: 600, targetTeam: 'enemy', target: { kind: 'intent' }, condition: always, effects,
      commitPolicy: 'castEndRevalidate', missRefundPolicy: 'none', launchedSourceDeathPolicy: 'resolveCommitted', ...extra } };
}
const seedSkills = [
  testSkill('marks', [apply('status.sword-mark', 3, 400)]),
  testSkill('poison', [apply('status.poison', 3, 400)]),
  testSkill('runes', [apply('status.rune', 3, 200, self)], { targetTeam: 'self' }),
  testSkill('medicine', [apply('status.medicine', 2, 200, self)], { targetTeam: 'self' }),
  testSkill('shock', [apply('status.shock', 1, 400)]),
  testSkill('stagger', [apply('status.stagger', 1, 100)]),
  testSkill('brief-control', [apply('status.stagger', 1, 2)]),
  testSkill('shield', [shield(3000, 400)], { targetTeam: 'self' }),
  testSkill('slow', [damage(1000)], { castTicks: 300 }),
];
const catalog: CombatContentCatalog = prepareCombatCatalog({ ...releaseCombatCatalog, skills: [...releaseCombatCatalog.skills, ...seedSkills] });
function entity(id: string, x: number, overrides: Partial<BattleEntityInput> = {}): BattleEntityInput {
  return { id, team: id === E ? 'enemy' : 'ally', position: { x, y: 40 }, stats: { attack: 100, maxHealth: id === E ? 10000 : 1000 },
    health: id === B ? 500 : id === E ? 10000 : 1000, maximumSpirit: 1000, spirit: 500, basic, ...overrides };
}
function start(overrides: Partial<BattleEntityInput> = {}): BattleState {
  return createBattle(catalog, { seed: 'release-content-execution', contentMode: 'experimental', arena,
    entities: [entity(A, 40, overrides), entity(B, 80), entity(C, 120), entity(E, 160)], logCapacity: 3000 });
}
const add = (state: BattleState, id: string, holder = A, boundHolderId?: string) => installCombatSource(state, catalog, holder, id.startsWith('talent.') || id.startsWith('skill.') ? id : `talent.${id}`, boundHolderId ? { boundHolderId } : {});
function cast(state: BattleState, slug: string, actor = A, target = E): BattleState {
  const id = slug.startsWith('skill.') ? slug : `skill.${slug}`;
  if (!state.entities[actor]!.skills.includes(id)) state = add(state, id, actor);
  const wait = Math.max(0, (state.entities[actor]!.cooldowns[id] ?? 0) - state.tick);
  if (wait) state = stepBattle(state, catalog, wait);
  const next = issueCommand(state, catalog, { kind: 'cast', actorId: actor, skillId: id, targetId: target });
  const skill = catalog.skills.find(value => value.id === id)!;
  return skill.activation === 'active' && skill.action.castTicks > 0 && skill.action.castTicks < 300 ? stepBattle(next, catalog, skill.action.castTicks) : next;
}
const seed = (state: BattleState, slug: string, actor = A, target = E) => cast(state, `release-test-${slug}`, actor, target);
function hit(state: BattleState, actor = A, target = E): BattleState {
  const wait = Math.max(0, (state.entities[actor]!.cooldowns['runtime.basic'] ?? 0) - state.tick);
  return issueCommand(wait ? stepBattle(state, catalog, wait) : state, catalog, { kind: 'basic', actorId: actor, targetId: target });
}
const count = (state: BattleState, id: string, who = A) => statusStacks(state, catalog, who, `status.${id}`);
const focus = (state: BattleState) => issueCommand(state, catalog, { kind: 'focus', actorId: A, targetId: E });
const guard = (state: BattleState) => issueCommand(state, catalog, { kind: 'guard', actorId: A, targetId: B });
const restore = (state: BattleState) => restoreBattle(serializeBattle(state), catalog);
function installed(slug: string, state = start(), bound?: string): BattleState { return restore(add(state, slug, A, bound)); }
function forceState(slug: string): BattleState {
  let state = seed(start(), 'shield', A, A); state = add(add(state, 'skill.xujin'), 'fanzhen'); state = installed(slug, state);
  state = hit(state, E, A); expect(state.force.reduce((sum, value) => sum + value.units, 0)).toBe(40); return hit(state);
}
type Scenario = (slug: string) => BattleState;
const scenarios: Record<string, Scenario> = {
  'kairen-liuhen': slug => { const state = cast(installed(slug), 'liuhen-jian'); expect(count(state, 'sword-mark', E)).toBe(2); return state; },
  'dingfeng-shuanghen': slug => { const state = hit(installed(slug, seed(start(), 'stagger'))); expect(count(state, 'sword-mark', E)).toBe(2); return state; },
  'hujian-jieli': slug => { let state = cast(installed(slug), 'baoyue', B, B); expect(state.augments.some(value => value.recipientIds.includes(A))).toBe(true); state = cast(state, 'liuhen-jian'); expect(count(state, 'sword-mark', E)).toBe(2); return state; },
  'pochen-duanliu': slug => { let state = installed(slug, seed(start(), 'marks')); state = seed(state, 'slow', E, A); state = cast(state, 'guifeng'); expect(state.entities[E]!.currentActionId).toBeNull(); expect(state.log.some(event => event.reason === 'interrupted')).toBe(true); return state; },
  'zhechao-hushen': slug => { const state = cast(installed(slug, seed(start(), 'marks')), 'guifeng'); expect(shieldUnits(state, A)).toBe(70); return state; },
  'jiehen-xuming': slug => { const state = hit(installed(slug, seed(start({ health: 500 }), 'marks'))); expect(state.entities[A]!.health).toBe(570); expect(count(state, 'sword-mark', E)).toBe(2); return state; },
  'jianhuo-tonglu': slug => { const state = cast(installed(slug, seed(start(), 'marks')), 'guifeng'); expect(count(state, 'poison', E)).toBe(1); return state; },
  'jianwen-huiliu': slug => { let state = add(seed(start(), 'marks'), 'skill.fumai', B); state = cast(installed(slug, state, B), 'guifeng'); expect(count(state, 'rune', B)).toBe(1); expect(count(state, 'rune', A)).toBe(0); return state; },
  'guanfeng-yinlei': slug => { const state = hit(installed(slug, seed(start(), 'shock'))); expect(count(state, 'shock', E)).toBe(0); expect(state.entities[E]!.health).toBe(9855); return state; },
  'yiyao-xudu': slug => { const state = hit(installed(slug, seed(start(), 'medicine', A, A))); expect(count(state, 'medicine')).toBe(1); expect(count(state, 'poison', E)).toBe(2); return state; },
  'duhou-huigen': slug => { const state = cast(installed(slug, seed(start({ health: 500 }), 'poison')), 'fenzhang', B); expect(state.entities[A]!.health).toBe(560); return state; },
  'jingdan-shenghua': slug => { const state = cast(installed(slug), 'qingxin', A, B); expect(count(state, 'medicine')).toBe(1); return state; },
  'yaohua-jingmai': slug => { let state = seed(seed(start(), 'medicine', A, A), 'poison', E, B); state = cast(installed(slug, state), 'huichun', A, B); expect(count(state, 'poison', B)).toBe(0); expect(count(state, 'medicine')).toBe(1); return state; },
  'juyao-chengquan': slug => { let state = cast(installed(slug, seed(start(), 'medicine', A, A)), 'huichun', A, B); expect(count(state, 'medicine')).toBe(0); expect(state.zones).toHaveLength(1); state = stepBattle(restore(state), catalog, 20); expect(state.entities[B]!.health).toBe(675); return state; },
  'jinhuo-liuzhan': slug => { let state = cast(installed(slug, seed(start(), 'poison')), 'fenzhang'); expect(state.zones).toHaveLength(1); const hp = state.entities[E]!.health; state = stepBattle(restore(state), catalog, 20); expect(state.entities[E]!.health).toBe(hp - 20); return state; },
  'yuying-hudeng': slug => { const state = cast(installed(slug), 'huichun', A, C); expect(shieldUnits(state, C)).toBe(75); return state; },
  'huomai-shujian': slug => { const state = cast(installed(slug, focus(start())), 'huichun', A, B); expect(count(state, 'sword-mark', E)).toBe(1); return state; },
  'dudu-chengwen': slug => { const state = cast(installed(slug, seed(start(), 'poison')), 'fenzhang'); expect(count(state, 'rune')).toBe(1); return state; },
  'suijia-huixi': slug => { let state = installed(slug, seed(start(), 'shield', A, A)); state = hit(hit(state, E, A), E, A); const spirit = state.entities[A]!.spirit; state = hit(state, E, A); expect(shieldUnits(state, A)).toBe(0); expect(state.entities[A]!.spirit).toBe(spirit + 6); return state; },
  'dingbu-ningshi': slug => { const state = stepBattle(installed(slug, seed(start(), 'brief-control', E, A)), catalog, 2); expect(shieldUnits(state, A)).toBe(90); return state; },
  'shouyu-liuzhen': slug => { const state = guard(installed(slug)); expect(shieldUnits(state, A)).toBe(60); return state; },
  'cangjin-duanhe': slug => { const state = forceState(slug); expect(count(state, 'stagger', E)).toBe(1); expect(state.force).toHaveLength(0); return state; },
  'cangjin-yangmai': slug => { const state = forceState(slug); expect(state.entities[B]!.health).toBe(565); return state; },
  'pofu-shouyuan': slug => { const state = hit(installed(slug, start({ health: 50 })), E, A); expect(state.entities[A]!.health).toBe(80); expect(count(state, 'stagger')).toBe(1); return state; },
  'tongjia-jiuyuan': slug => { let state = start(); for (let index = 0; index < 4; index++) state = hit(state, E, B); state = hit(installed(slug, state), E, B); expect(state.entities[B]!.life).toBe('Recovered'); expect(state.entities[B]!.health).toBe(100); expect(state.entities[B]!.recoveryUntilTick).toBe(state.tick + 40); expect(count(state, 'stagger')).toBe(1); return state; },
  'dunjia-runsheng': slug => { const state = hit(installed(slug, seed(start(), 'shield', A, A)), E, A); expect(state.entities[B]!.health).toBe(525); return state; },
  'huzhen-dianfeng': slug => { const state = guard(installed(slug, focus(start()))); expect(count(state, 'sword-mark', E)).toBe(2); return state; },
  'hufu-yangwen': slug => { const state = cast(installed(slug, seed(start(), 'shield', A, A)), 'yinlei'); expect(count(state, 'rune')).toBe(1); return state; },
  'jiefeng-qingwen': slug => { const state = stepBattle(installed(slug, seed(start(), 'brief-control', E, A)), catalog, 2); expect(count(state, 'rune')).toBe(2); return state; },
  'liangyi-jiewen': slug => { let state = cast(installed(slug), 'yinlei'); state = cast(state, 'liuhen-jian', B); expect(count(state, 'rune')).toBe(2); return state; },
  'duanwen-jiezhou': slug => { let state = installed(slug, seed(start(), 'runes', A, A)); state = seed(state, 'slow', E, A); state = hit(state); expect(count(state, 'rune')).toBe(2); expect(state.entities[E]!.currentActionId).toBeNull(); return state; },
  'zhanwen-yuanshu': slug => { const state = cast(installed(slug, seed(start(), 'runes', A, A)), 'yinlei'); expect(count(state, 'rune')).toBe(1); expect(state.augments.some(value => value.adjustment.kind === 'rangeUnits' && value.adjustment.value === 200)).toBe(true); return state; },
  'sanzhuan-zhishen': slug => { const state = cast(installed(slug, seed(start(), 'runes', A, A)), 'yinlei'); expect(count(state, 'rune')).toBe(0); expect(state.summons).toHaveLength(1); expect(state.entities[state.summons[0]!.entityId]!.health).toBe(250); return state; },
  'yifa-hudeng': slug => { let state = cast(installed(slug), 'liuhen-jian'); state = cast(state, 'huichun', B, B); expect(shieldUnits(state, B)).toBe(50); return state; },
  'sanyao-jingzhen': slug => { let state = installed(slug, seed(start(), 'poison', E, B)); state = cast(state, 'liuhen-jian'); state = cast(state, 'huichun', B, A); state = cast(state, 'yinlei', C); expect(count(state, 'poison', B)).toBe(0); return state; },
  'shidu-qiwen': slug => { const state = hit(installed(slug, seed(start(), 'poison'))); expect(count(state, 'poison', E)).toBe(2); expect(count(state, 'rune')).toBe(1); return state; },
};

describe('36 real release talent programs', () => {
  it.each(releaseTalentRows)('$definition.id executes observable mechanics and survives save/restore', row => {
    const slug = row.definition.id.slice('talent.'.length); expect(scenarios[slug]).toBeDefined();
    const result = scenarios[slug]!(slug); const restored = restore(result); expect(restored).toEqual(result);
    expect(result.triggerLedger.some(value => value.activations > 0 && Object.values(result.sources).some(source => source.sourceDefinitionId === row.definition.id && (source.sourceInstanceId === value.sourceInstanceId || source.sharedBudgetId === value.sourceInstanceId)))).toBe(true);
    const clean = cleanupBattleScope(restored, catalog, 'run');
    expect(Object.values(clean.sources).filter(value => value.lifecycleScope !== 'character')).toEqual([]);
    expect(clean.shields).toHaveLength(0); expect(clean.statuses).toHaveLength(0); expect(clean.zones).toHaveLength(0); expect(clean.summons).toHaveLength(0);
    expect(restore(clean)).toEqual(clean);
  });
  it('no new card grants a benefit merely from installation or an irrelevant command', () => {
    for (const row of releaseTalentRows) {
      let state = start(); if (row.definition.recipientBinding === 'selectedTalisman') state = add(state, 'skill.fumai', B);
      state = installed(row.definition.id, state, row.definition.recipientBinding === 'selectedTalisman' ? B : undefined); state = focus(state);
      expect(state.statistics.healthLost).toBe(0); expect(state.statistics.effectiveHealing).toBe(0); expect(state.shields).toHaveLength(0); expect(state.statuses).toHaveLength(0); expect(state.augments).toHaveLength(0);
    }
  });
  it('removes source-owned rune augments and active fields when their run card is uninstalled', () => {
    for (const slug of ['zhanwen-yuanshu', 'juyao-chengquan', 'sanzhuan-zhishen']) {
      let state = scenarios[slug]!(slug); const source = Object.values(state.sources).find(value => value.executionKind === 'installed' && value.sourceDefinitionId === `talent.${slug}`)!;
      state = removeCombatSource(state, catalog, source.sourceInstanceId); expect(state.augments).toHaveLength(0); expect(state.zones).toHaveLength(0); expect(state.summons).toHaveLength(0); expect(restore(state)).toEqual(state);
    }
  });
});

describe('obtainable loadouts, tradeoffs and shared budgets', () => {
  it('runs a complete medicine-to-poison engine using the actual starter poison and detonation skills', () => {
    let state = add(add(add(start({ health: 500 }), 'skill.yaoli'), 'wenyao-yuxing'), 'yiyao-xudu');
    state = cast(state, 'qingwu'); expect(count(state, 'poison', E)).toBe(1);
    state = cast(state, 'fenzhang', B); expect(count(state, 'medicine')).toBe(1);
    state = hit(state); expect(count(state, 'medicine')).toBe(0); expect(count(state, 'poison', E)).toBe(2);
    expect(state.entities[A]!.spirit).toBe(488); expect(state.entities[B]!.spirit).toBe(482);
  });
  it('runs actual Baoyue → enemy absorption → Stored Force → ally healing, without seeded force', () => {
    let state = add(add(add(start(), 'skill.xujin'), 'fanzhen'), 'cangjin-yangmai');
    state = cast(state, 'baoyue', A, A); expect(shieldUnits(state, A)).toBe(220);
    state = hit(state, E, A); expect(state.force[0]?.units).toBe(40);
    state = hit(state); expect(state.force).toHaveLength(0); expect(state.entities[B]!.health).toBe(565);
  });
  it('uses real paid talisman/sword rotation to build and spend three Runes into a decoy', () => {
    let state = add(add(add(start(), 'skill.fumai'), 'liangyi-jiewen'), 'sanzhuan-zhishen');
    state = cast(state, 'yinlei'); expect(count(state, 'rune')).toBe(1);
    state = cast(state, 'liuhen-jian', B); expect(count(state, 'rune')).toBe(3);
    state = cast(state, 'fenzhang'); expect(state.summons).toHaveLength(1); expect(count(state, 'rune')).toBe(0);
    expect(state.log.filter(event => event.kind === 'action.committed')).toHaveLength(3);
  });
  it('cannot obtain a field or cleanse for free after another source spends the same Medicine', () => {
    for (const fieldFirst of [false, true]) {
      let state = seed(seed(start(), 'medicine', A, A), 'poison', E, B);
      state = add(add(state, fieldFirst ? 'juyao-chengquan' : 'yaohua-jingmai'), fieldFirst ? 'yaohua-jingmai' : 'juyao-chengquan');
      state = cast(state, 'huichun', A, B);
      expect(state.zones).toHaveLength(fieldFirst ? 1 : 0); expect(count(state, 'medicine')).toBe(fieldFirst ? 0 : 1);
      expect(count(state, 'poison', B)).toBe(fieldFirst ? 3 : 0);
    }
  });
  it('same-name team sources do not multiply Guard marks or reset the shared cooldown', () => {
    let state = add(add(focus(start()), 'huzhen-dianfeng'), 'huzhen-dianfeng', C);
    state = guard(state); expect(count(state, 'sword-mark', E)).toBe(2);
    state = issueCommand(state, catalog, { kind: 'guard', actorId: C, targetId: B }); expect(count(state, 'sword-mark', E)).toBe(2);
    const ledgers = state.triggerLedger.filter(value => value.triggerId === 'guardMarksFocus');
    expect(ledgers.reduce((sum, value) => sum + value.activations, 0)).toBe(1);
    const first = Object.values(state.sources).find(value => value.sourceDefinitionId === 'talent.huzhen-dianfeng' && value.holderId === A)!;
    state = removeCombatSource(state, catalog, first.sourceInstanceId);
    state = issueCommand(state, catalog, { kind: 'guard', actorId: C, targetId: B });
    expect(state.triggerLedger.filter(value => value.triggerId === 'guardMarksFocus').reduce((sum, value) => sum + value.activations, 0)).toBe(1);
  });
  it('last stand and rescue each have only one use, even after restoring mid-encounter', () => {
    let last = scenarios['pofu-shouyuan']!('pofu-shouyuan'); last = hit(restore(last), E, A);
    expect(last.entities[A]!.life).toBe('Downed');
    let rescue = scenarios['tongjia-jiuyuan']!('tongjia-jiuyuan'); rescue = hit(restore(rescue), E, B);
    expect(rescue.entities[B]!.life).toBe('Downed'); expect(rescue.statistics.recovered).toBe(1);
  });
  it('three-school cleansing cannot be completed by repeating one school or by unpaid basics', () => {
    let state = installed('sanyao-jingzhen', seed(start(), 'poison', E, B));
    state = cast(state, 'liuhen-jian'); state = cast(state, 'liuhen-jian', B); state = cast(state, 'liuhen-jian', C); state = hit(state);
    expect(count(state, 'poison', B)).toBe(3); expect(state.triggerLedger.some(value => value.triggerId === 'threeSchoolsCleanse')).toBe(false);
  });
  it('direct-only overflow conversion does not turn a proc heal into a shield/heal loop', () => {
    let state = add(add(start(), 'duhou-huigen'), 'yuying-hudeng');
    state = seed(state, 'poison'); state = cast(state, 'fenzhang', B);
    expect(state.statistics.overhealing).toBe(60); expect(shieldUnits(state, A)).toBe(0); expect(state.statistics.truncatedProcs).toBe(0);
  });
});
