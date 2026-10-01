import { describe, expect, it } from 'vitest';
import { releaseTalentRows } from '../../src/content/release';
import { combatCatalog } from '../../src/content/definitions';
import { all, apply, heal, mechanics, paidActive, self, status, trigger } from '../../src/content/definitions/helpers';
import { legalTalentCandidates, previewNextOffer } from '../../src/core/expeditions/offers';
import { evaluateReleaseEligibility, releaseEligibilityInputHash } from '../../src/core/expeditions/release-eligibility';
import type { ReleaseEligibilityContext } from '../../src/core/expeditions/release-eligibility';
import type { ExpeditionCatalog, ExpeditionState } from '../../src/core/expeditions/types';
import { catalog, context, evaluate, holders, loadout, only, own, party, previousMedicineCatalog, progressed, replaceSkill } from './fixtures';

describe('all 36 new release-card distinctions', () => {
  const expected = [
    ['kairen-liuhen', 'entity:1'], ['dingfeng-shuanghen', null], ['hujian-jieli', 'entity:1'],
    ['pochen-duanliu', 'entity:1'], ['zhechao-hushen', 'entity:1'], ['jiehen-xuming', 'entity:1'],
    ['jianhuo-tonglu', 'entity:1'], ['jianwen-huiliu', 'entity:4'], ['guanfeng-yinlei', 'entity:1'],
    ['yiyao-xudu', 'entity:3'], ['duhou-huigen', 'entity:3'], ['jingdan-shenghua', 'entity:6'],
    ['yaohua-jingmai', 'entity:6'], ['juyao-chengquan', 'entity:6'], ['jinhuo-liuzhan', 'entity:4'], ['yuying-hudeng', 'entity:3'],
    ['huomai-shujian', null], ['dudu-chengwen', 'entity:4'], ['suijia-huixi', 'entity:2'],
    ['dingbu-ningshi', 'entity:1'], ['shouyu-liuzhen', 'entity:1'], ['cangjin-duanhe', 'entity:2'],
    ['cangjin-yangmai', 'entity:2'], ['pofu-shouyuan', 'entity:1'], ['tongjia-jiuyuan', null],
    ['dunjia-runsheng', 'entity:2'], ['huzhen-dianfeng', null], ['hufu-yangwen', 'entity:4'],
    ['jiefeng-qingwen', 'entity:4'], ['liangyi-jiewen', 'entity:4'], ['duanwen-jiezhou', 'entity:4'],
    ['zhanwen-yuanshu', 'entity:4'], ['sanzhuan-zhishen', 'entity:4'], ['yifa-hudeng', null],
    ['sanyao-jingzhen', null], ['shidu-qiwen', 'entity:4'],
  ] as const;
  // One shared computation: this is a capability matrix, not a seed/RNG or balance test.
  const state = progressed(), result = evaluate(state);
  it.each(expected)('finds the real equipped-skill witness for %s', (slug, holder) => {
    // jingdan itself is already owned in progressed(), so test its acquisition before the grant.
    const rows = slug === 'jingdan-shenghua' ? evaluate(party()).candidates : result.candidates;
    const card = rows.find(card => card.definitionId === `talent.${slug}`);
    expect(card, JSON.stringify(result.diagnostics.filter(note => note.definitionId === `talent.${slug}`))).toBeDefined();
    if (holder) expect(card!.holderIds).toContain(holder); else expect(card!.holderIds).toEqual([]);
  });
  it('accounts for every addition after the explicit candidate.2 Medicine timing repair', () => {
    expect(expected.map(([slug]) => `talent.${slug}`).sort()).toEqual(releaseTalentRows.map(row => row.definition.id).sort());
    expect(result.candidates.some(card => card.definitionId === 'talent.juyao-chengquan')).toBe(true);
  });
  it('retains the prior 200-tick candidate as an explicit negative fixture', () => {
    expect(holders(state, 'juyao-chengquan', previousMedicineCatalog)).toBeUndefined();
    expect(evaluate(state, previousMedicineCatalog).diagnostics).toContainEqual(expect.objectContaining({ definitionId: 'talent.juyao-chengquan', holderId: 'entity:6', code: 'MISSING_MEDICINE' }));
    expect(catalog.contentVersion).toBe('0.2.0-release-candidate.2');
    expect(catalog.talents.find(entry => entry.id === 'talent.jingdan-shenghua')!.mechanics.triggers[0]!.effects[0]).toMatchObject({ duration: { ticks: 400 } });
  });
});

describe('cross-holder and true-effect negatives', () => {
  it('never treats a poison consumer, passive Medicine label or ally’s Medicine as an owned starter', () => {
    expect(holders(only(party(), 'entity:4'), 'jinhuo-liuzhan')).toBeUndefined();
    expect(holders(only(party(), 'entity:4'), 'shidu-qiwen')).toBeUndefined();
    expect(holders(only(party(), 'entity:3'), 'duhou-huigen')).toBeUndefined();
    const wrongHolder = own(party(), 'wenyao-yuxing', 'entity:6');
    expect(holders(wrongHolder, 'yiyao-xudu')).toBeUndefined();
    expect(holders(party(), 'yaohua-jingmai')).toBeUndefined();
  });
  it('requires same-holder cleanse prerequisite, both actual active slots, and enough combined spirit', () => {
    const wrongHolder = own(party(), 'jingdan-shenghua', 'entity:3');
    expect(holders(wrongHolder, 'yaohua-jingmai')).toBeUndefined();
    let state = own(party(), 'jingdan-shenghua', 'entity:6');
    expect(holders(state, 'yaohua-jingmai')).toEqual(['entity:6']);
    state = { ...state, members: state.members.map(member => member.discipleId === 'entity:6' ? { ...member, spirit: 20 } : member) };
    expect(holders(state, 'yaohua-jingmai')).toBeUndefined(); // 20 cleanse + 18 heal cannot be paid from 20
    const noHeal = loadout(own(party(), 'jingdan-shenghua', 'entity:6'), 'entity:6', ['skill.qingxin', 'skill.qingwu']);
    expect(holders(noHeal, 'yaohua-jingmai')).toBeUndefined();
  });
  it('does not borrow another disciple’s self-only shield, and accepts a reachable genuine ally shield', () => {
    let state = only(party(), 'entity:2', 'entity:4');
    expect(holders(state, 'hufu-yangwen')).toBeUndefined();
    expect(holders(state, 'suijia-huixi')).toEqual(['entity:2']);
    expect(holders(state, 'dunjia-runsheng')).toEqual(['entity:2']);
    state = loadout(state, 'entity:2', ['skill.baoyue', 'skill.yuanhu']);
    expect(holders(state, 'hufu-yangwen')).toEqual(['entity:4']);
    const facts = context(state);
    const outOfReach = { ...facts, reachablePairs: facts.reachablePairs.filter(pair => ![pair.firstId, pair.secondId].includes('entity:2') || ![pair.firstId, pair.secondId].includes('entity:4')) };
    expect(holders(state, 'hufu-yangwen', catalog, outOfReach)).toBeUndefined();
  });
  it('Ward to Edge needs the recipient’s actual mark-applying paid sword active', () => {
    const state = loadout(party(), 'entity:1', ['skill.guanri-jianjue', 'skill.guifeng']);
    expect(holders(state, 'kairen-liuhen')).toEqual(['entity:1']);
    expect(holders(state, 'hujian-jieli')).toBeUndefined();
    const noShields = only(party(), 'entity:1', 'entity:3', 'entity:4');
    expect(holders(noShields, 'hujian-jieli')).toBeUndefined();
  });
  it('healing/Guard mark engines can start marks for a real consumer, without assuming preexisting marks', () => {
    const state = loadout(party(), 'entity:1', ['skill.guifeng', 'skill.guanri-jianjue']);
    expect(holders(state, 'huomai-shujian')).toEqual([]);
    expect(holders(state, 'huzhen-dianfeng')).toEqual([]);
    expect(holders(state, 'pochen-duanliu')).toBeUndefined();
    const noConsumer = loadout(state, 'entity:1', ['skill.liuhen-jian', 'skill.guanri-jianjue']);
    expect(holders(noConsumer, 'huomai-shujian')).toBeUndefined();
    expect(holders(noConsumer, 'huzhen-dianfeng')).toBeUndefined();
  });
  it('lightning damage and friendly control-resistance buffs are not Shock or hostile Stagger', () => {
    const lightningOnly = replaceSkill(catalog, 'skill.yinlei', skill => skill.activation === 'active' ? { ...skill, action: { ...skill.action,
      effects: skill.action.effects.filter(effect => effect.kind !== 'applyStatus') } } : skill);
    expect(holders(party(), 'guanfeng-yinlei', lightningOnly)).toBeUndefined();
    const state = only(party(), 'entity:1', 'entity:6');
    expect(holders(state, 'dingfeng-shuanghen')).toBeUndefined(); // qingxin gives control resistance, never Stagger
  });
  it('producer and Basic/consumer must reach the same hostile target', () => {
    const state = only(party(), 'entity:1', 'entity:4');
    const base = context(state);
    const facts: ReleaseEligibilityContext = { ...base, enemies: [...base.enemies, { id: 'enemy:2', controlResistanceBps: 0 }],
      reachablePairs: [
        { firstId: 'entity:1', secondId: 'enemy:1', distanceUnits: 50 },
        { firstId: 'entity:4', secondId: 'enemy:2', distanceUnits: 50 },
      ] };
    expect(holders(state, 'guanfeng-yinlei', catalog, facts)).toEqual(['entity:4']);
    expect(holders(state, 'jiehen-xuming', catalog, facts)).toEqual(['entity:1']);
    expect(holders(state, 'jianwen-huiliu', catalog, facts)).toEqual(['entity:4']); // the bridge itself has no distance restriction
  });
  it('control immunity and missing hostile control are respected, while owned self-control is a real seed', () => {
    const state = only(party(), 'entity:2');
    let facts = context(state);
    facts = { ...facts, enemies: [{ id: 'enemy:1', controlResistanceBps: 10000 }], members: facts.members.map(fact => ({ ...fact, controlEnemyIds: [] })) };
    expect(holders(state, 'dingfeng-shuanghen', catalog, facts)).toBeUndefined();
    expect(holders(state, 'dingbu-ningshi', catalog, facts)).toBeUndefined();
    const withEmergency = own(state, 'pofu-shouyuan', 'entity:2');
    const refreshed = { ...facts, identity: { ...facts.identity, inputHash: releaseEligibilityInputHash(withEmergency) } };
    expect(holders(withEmergency, 'dingbu-ningshi', catalog, refreshed)).toEqual(['entity:2']);
  });
  it('proc-only healing cannot satisfy direct-heal conversion, but a paid healing field can satisfy paid-cast listeners', () => {
    const state = loadout(only(party(), 'entity:1', 'entity:3'), 'entity:3', ['skill.qingwu', 'skill.yaowang-ding']);
    expect(holders(state, 'yuying-hudeng')).toBeUndefined();
    expect(holders(state, 'huomai-shujian')).toBeUndefined();
    expect(holders(state, 'yifa-hudeng')).toEqual([]);
    expect(holders(only(state, 'entity:3'), 'yifa-hudeng')).toBeUndefined();
  });
  it('does not count healing aimed at hostile targets when the runtime rejects that target team', () => {
    const hostileHeal = replaceSkill(catalog, 'skill.yinlei', skill => skill.activation === 'active' ? { ...skill, tags: [...skill.tags, 'heal'],
      action: { ...skill.action, effects: [heal(10000)] } } : skill);
    const state = only(party(), 'entity:4');
    expect(holders(state, 'yuying-hudeng', hostileHeal)).toBeUndefined();
    expect(holders(state, 'huomai-shujian', hostileHeal)).toBeUndefined();
  });
  it('Force requires owned production, real reachable protection, hostile damage and a real release', () => {
    const state = own(only(party(), 'entity:1', 'entity:2'), 'fanzhen', 'entity:2');
    expect(holders(state, 'cangjin-duanhe')).toEqual(['entity:2']);
    const withoutPassive = loadout(state, 'entity:2', ['skill.baoyue', 'skill.zhenbu'], 'skill.pangu');
    expect(holders(withoutPassive, 'cangjin-duanhe')).toBeUndefined();
    const noShield = loadout(state, 'entity:2', ['skill.zhenbu', 'skill.yuanhu']);
    // yuanhu can legally target its own holder, so removing baoyue alone must not remove this witness.
    expect(holders(noShield, 'cangjin-duanhe')).toEqual(['entity:2']);
    const facts = context(state);
    const noDamage = { ...facts, members: facts.members.map(fact => ({ ...fact, directDamageEnemyIds: [] })) };
    expect(holders(state, 'cangjin-duanhe', catalog, noDamage)).toBeUndefined();
    expect(holders(only(state, 'entity:2'), 'cangjin-yangmai')).toBeUndefined();
  });
  it('Guard/focus and real Downed recipients are explicit, and team source holder is distinct from bound recipient', () => {
    const state = party(), facts = context(state);
    expect(holders(state, 'jianwen-huiliu', catalog, facts)).toEqual(['entity:4']);
    expect(facts.teamSourceHolders.find(row => row.definitionId === 'talent.jianwen-huiliu')?.discipleId).toBe('entity:1');
    const noGuard = { ...facts, focusEnemyIds: [], members: facts.members.map(fact => ({ ...fact, guardAllowed: false, defeatRule: 'immediate' as const })) };
    expect(holders(state, 'shouyu-liuzhen', catalog, noGuard)).toBeUndefined();
    expect(holders(state, 'huzhen-dianfeng', catalog, noGuard)).toBeUndefined();
    expect(holders(state, 'tongjia-jiuyuan', catalog, noGuard)).toBeUndefined();
    expect(holders(only(state, 'entity:1'), 'tongjia-jiuyuan')).toBeUndefined();
  });
  it('school-count and caster-count rotations use living paid equipped skills, with feasible cast readiness', () => {
    const state = only(party(), 'entity:1', 'entity:3');
    expect(holders(state, 'liangyi-jiewen')).toContain('entity:1');
    expect(holders(state, 'sanyao-jingzhen')).toBeUndefined();
    const sameSchool = only(party(), 'entity:3', 'entity:6');
    expect(holders(sameSchool, 'liangyi-jiewen')).toBeUndefined();
    const shortWindow = { ...context(party()), horizonTicks: 7 };
    expect(holders(party(), 'liangyi-jiewen', catalog, shortWindow)).toBeUndefined();
    const noSpirit = { ...party(), members: party().members.map(member => ({ ...member, spirit: 0 })) };
    expect(holders(noSpirit, 'sanyao-jingzhen')).toBeUndefined();
  });
  it('Rune payoffs require own reachable Rune production, real talisman active and legal decoy opportunity', () => {
    const state = only(party(), 'entity:1', 'entity:4');
    expect(holders(state, 'duanwen-jiezhou')).toEqual(['entity:4']);
    expect(holders(state, 'sanzhuan-zhishen')).toEqual(['entity:4']);
    const noRunes = loadout(state, 'entity:4', ['skill.yinlei', 'skill.fenzhang'], 'skill.xunyi');
    expect(holders(noRunes, 'duanwen-jiezhou')).toBeUndefined();
    const facts = context(state);
    expect(holders(state, 'sanzhuan-zhishen', catalog, { ...facts, members: facts.members.map(fact => ({ ...fact, decoyPlacementPossible: false })) })).toBeUndefined();
  });
});

describe('bounded dependency graph and explicit one-followup Rune routes', () => {
  it('does not let mutually conditional statuses justify themselves', () => {
    let cyclic = replaceSkill(catalog, 'skill.fumai', skill => ({ ...skill, mechanics: mechanics([], [
      trigger('cycleRune', 'action.committed', all(paidActive, status('status.medicine')), [apply('status.rune', 1, 200, self)]),
      trigger('cycleMedicine', 'action.committed', all(paidActive, status('status.rune')), [apply('status.medicine', 1, 200, self)]),
    ]) }));
    const state = only(party(), 'entity:4');
    expect(holders(state, 'duanwen-jiezhou', cyclic)).toBeUndefined();
    cyclic = replaceSkill(cyclic, 'skill.fumai', skill => ({ ...skill, mechanics: { ...skill.mechanics, onInstall: [apply('status.rune', 1, 200, self)] } }));
    expect(holders(state, 'duanwen-jiezhou', cyclic)).toEqual(['entity:4']);
  });
  it('does not treat consumed-only poison recycling as a starter', () => {
    const state = own(only(party(), 'entity:4'), 'yaoyan-yanmian', 'entity:4');
    expect(holders(state, 'jinhuo-liuzhan')).toBeUndefined();
    expect(holders(state, 'dudu-chengwen')).toBeUndefined();
  });
  it('offers a real Rune enabler with a bounded, explicitly diagnosed future consumer', () => {
    const state = only(party(), 'entity:2', 'entity:4');
    const result = evaluate(state);
    expect(result.candidates.find(card => card.definitionId === 'talent.jiefeng-qingwen')?.holderIds).toContain('entity:4');
    expect(result.followupRequired).toContainEqual(expect.objectContaining({ definitionId: 'talent.jiefeng-qingwen', holderId: 'entity:4', consumerDefinitionIds: expect.arrayContaining(['talent.duanwen-jiezhou']) }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'FOLLOWUP_REQUIRED', definitionId: 'talent.jiefeng-qingwen', holderId: 'entity:4' }));
    expect(state.talentInstances).toEqual([]);
  });
  it('rejects a missing, excluded, rank-capped or prerequisite-blocked future consumer without recursive future chains', () => {
    const state = only(party(), 'entity:2');
    const enabler = catalog.talents.find(card => card.id === 'talent.jiefeng-qingwen')!;
    const consumer = catalog.talents.find(card => card.id === 'talent.duanwen-jiezhou')!;
    const subset: ExpeditionCatalog = { ...catalog, talents: [enabler, consumer] };
    expect(holders(state, 'jiefeng-qingwen', subset)).toEqual(['entity:2']);
    expect(holders(state, 'jiefeng-qingwen', { ...subset, talents: [enabler] })).toBeUndefined();
    expect(holders(state, 'jiefeng-qingwen', { ...subset, talents: [enabler, { ...consumer, prerequisites: ['talent.liangyi-jiewen'] }] })).toBeUndefined();
    const ownedConsumer = own(state, 'duanwen-jiezhou', 'entity:2');
    expect(evaluate(ownedConsumer, subset).followupRequired).toEqual([]); // an owned reachable consumer is immediate
    const denied: ExpeditionCatalog = { ...subset, talents: [enabler, { ...consumer, excludes: ['skill.xujin'] }] };
    expect(holders(state, 'jiefeng-qingwen', denied)).toBeUndefined();
    // A permanent Rune-spending node that is not equipped cannot count in a locked run.
    expect(holders(state, 'jiefeng-qingwen', { ...subset, talents: [enabler] })).toBeUndefined();
  });
  it('does not allow unowned producer and consumer prerequisites to unlock each other', () => {
    const state = only(party(), 'entity:4');
    const selected: ExpeditionCatalog = { ...catalog, talents: catalog.talents.filter(entry => ['talent.jiefeng-qingwen', 'talent.duanwen-jiezhou'].includes(entry.id))
      .map(entry => ({ ...entry, prerequisites: [entry.id === 'talent.jiefeng-qingwen' ? 'talent.duanwen-jiezhou' : 'talent.jiefeng-qingwen'] })) };
    expect(evaluate(state, selected).candidates).toEqual([]);
  });
  it('does not invent higher-stack marks/poison when casts cannot refresh before expiry', () => {
    const slow = replaceSkill(catalog, 'skill.qingwu', skill => skill.activation === 'active' ? { ...skill, action: { ...skill.action, cooldownTicks: 160 } } : skill);
    expect(holders(party(), 'jinhuo-liuzhan', slow)).toBeUndefined();
    expect(holders(party(), 'dudu-chengwen', slow)).toBeUndefined();
    // Effective permanent duration rules are real supporting inputs.
    const state: ExpeditionState = { ...party(), members: party().members.map(member => member.discipleId === 'entity:3'
      ? { ...member, loadout: { ...member.loadout, characterSourceIds: ['node.alchemy.qingya', 'node.alchemy.bianxing'] } } : member) };
    expect(holders(state, 'jinhuo-liuzhan', slow)).toEqual(['entity:4']);
  });
  it('does not count unequipped skills, unsupported nodes, or an illegal third active slot', () => {
    const state = only(party(), 'entity:4');
    const forged: ExpeditionState = { ...state, members: state.members.map(member => ({ ...member, loadout: { ...member.loadout, characterSourceIds: ['skill.qingwu'] } })) };
    expect(evaluate(forged).candidates).toEqual([]);
    expect(evaluate(forged).diagnostics.some(note => note.code === 'INVALID_LOADOUT')).toBe(true);
    const extra = { ...state, members: state.members.map(member => ({ ...member, loadout: { ...member.loadout, activeSkillIds: ['skill.yinlei', 'skill.fenzhang', 'skill.qingwu'] } })) } as unknown as ExpeditionState;
    expect(evaluate(extra).candidates).toEqual([]);
  });
});

describe('casualties, identity, ordering and frozen legacy boundary', () => {
  it('retains dead bound sources without phantom skills; an explicit legal rebind changes the capability recipient', () => {
    let state = own(party(), 'yifa-tongming', null, 'entity:4');
    const secondTalisman = { ...state.members.find(member => member.discipleId === 'entity:4')!, discipleId: 'entity:7' };
    state = { ...state, members: [...state.members, { ...secondTalisman, loadout: { ...secondTalisman.loadout, passiveSkillId: 'skill.xunyi' } }] };
    state = { ...state, members: state.members.map(member => member.discipleId === 'entity:4' ? { ...member, alive: false, permanentDeathId: 'death:4' } : member) };
    const result = evaluate(state);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'INACTIVE_BOUND_RECIPIENT', holderId: 'entity:4' }));
    expect(result.candidates.find(card => card.definitionId === 'talent.duanwen-jiezhou')).toBeUndefined();
    expect(state.talentInstances).toHaveLength(1);
    const oldContext = context(state);
    const rebound = { ...state, talentInstances: state.talentInstances.map(instance => ({ ...instance, boundHolderId: 'entity:7' })) };
    expect(evaluateReleaseEligibility(rebound, catalog, oldContext).candidates).toEqual([]);
    expect(evaluate(rebound).diagnostics.some(note => note.code === 'INACTIVE_BOUND_RECIPIENT')).toBe(false);
    expect(holders(rebound, 'duanwen-jiezhou')).toEqual(['entity:7']);
    expect(rebound.members.find(member => member.discipleId === 'entity:4')!.alive).toBe(false);
  });
  it('recomputes poison/control/rotation after loss of the actual producer', () => {
    const state = party(), dead: ExpeditionState = { ...state, members: state.members.map(member => ['entity:2', 'entity:3', 'entity:6'].includes(member.discipleId) ? { ...member, alive: false, permanentDeathId: `death/${member.discipleId}` } : member) };
    expect(holders(dead, 'jinhuo-liuzhan')).toBeUndefined();
    expect(holders(dead, 'dingfeng-shuanghen')).toBeUndefined();
    expect(holders(only(dead, 'entity:1', 'entity:4'), 'sanyao-jingzhen')).toBeUndefined();
  });
  it('fails closed with specific missing/stale context and ambiguous team-anchor diagnostics', () => {
    const state = party(), base = context(state);
    expect(evaluateReleaseEligibility(state, catalog).diagnostics.some(note => note.code === 'MISSING_CONTEXT')).toBe(true);
    expect(evaluate(state, catalog, { ...base, identity: { ...base.identity, catalogHash: 'wrong' } }).candidates).toEqual([]);
    expect(evaluate(state, catalog, { ...base, members: base.members.slice(1) }).diagnostics.some(note => note.code === 'MISSING_MEMBER_FACTS')).toBe(true);
    expect(evaluate(state, catalog, { ...base, teamSourceHolders: [] }).diagnostics.some(note => note.code === 'INVALID_CONTEXT')).toBe(true);
    expect(evaluate(state, catalog, { ...base, teamSourceHolders: [...base.teamSourceHolders, base.teamSourceHolders[0]!] }).candidates).toEqual([]);
    const changedInstallOrder = { ...state, members: [...state.members].reverse() };
    expect(releaseEligibilityInputHash(changedInstallOrder)).not.toBe(releaseEligibilityInputHash(state));
    expect(evaluate(changedInstallOrder, catalog, base).diagnostics.some(note => note.code === 'CONTEXT_IDENTITY_MISMATCH')).toBe(true);
  });
  it('keeps ordinary candidates when no equipped talisman recipient can supply selected-binding anchors', () => {
    const state = only(party(), 'entity:1', 'entity:2'); const facts = context(state);
    const selected = new Set(catalog.talents.filter(talent => talent.recipientBinding === 'selectedTalisman').map(talent => talent.id));
    const withoutImpossibleAnchors = { ...facts, teamSourceHolders: facts.teamSourceHolders.filter(source => !selected.has(source.definitionId)) };
    const result = evaluate(state, catalog, withoutImpossibleAnchors);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.some(candidate => selected.has(candidate.definitionId))).toBe(false);
    expect(result.diagnostics.some(note => note.code === 'INVALID_CONTEXT')).toBe(false);
    expect(result.diagnostics.some(note => note.code === 'NO_LIVING_RECIPIENT' && selected.has(note.definitionId ?? ''))).toBe(true);
    const missingOrdinaryAnchor = { ...withoutImpossibleAnchors, teamSourceHolders: withoutImpossibleAnchors.teamSourceHolders.slice(1) };
    expect(evaluate(state, catalog, missingOrdinaryAnchor).diagnostics.some(note => note.code === 'INVALID_CONTEXT')).toBe(true);
    const partyWithTalisman = party(); const full = context(partyWithTalisman);
    expect(evaluate(partyWithTalisman, catalog, { ...full, teamSourceHolders: full.teamSourceHolders.filter(source => !selected.has(source.definitionId)) })
      .diagnostics.some(note => note.code === 'INVALID_CONTEXT')).toBe(true);
  });
  it('enforces rank, symmetric exclusions and selected recipient using only the selected catalog', () => {
    const state = own(party(), 'kairen-liuhen', 'entity:1');
    expect(holders(state, 'kairen-liuhen')).toBeUndefined();
    const incompatible: ExpeditionCatalog = { ...catalog, talents: catalog.talents.map(entry => entry.id === 'talent.kairen-liuhen' ? { ...entry, excludes: ['talent.hujian-jieli'] } : entry) };
    expect(holders(state, 'hujian-jieli', incompatible)).toBeUndefined();
    expect(holders(party(), 'zoumai-chengfu')).toBeUndefined();
    expect(evaluate(party()).diagnostics.some(note => note.code === 'UNSUPPORTED_EXTRA_TARGET_STAGGER')).toBe(true);
  });
  it('reports short/empty pools and a descriptor-only supply alternative without inventing cards', () => {
    const state = only(party(), 'entity:1');
    const subset = { ...catalog, talents: catalog.talents.filter(entry => entry.id === 'talent.kairen-liuhen') };
    const result = evaluate(state, subset);
    expect(result.candidates.map(card => card.definitionId)).toEqual(['talent.kairen-liuhen']);
    expect(result.missingChoiceCount).toBe(2);
    expect(result.supplyFallback).toEqual({ available: true, supplies: [{ resourceId: 'meal', quantity: 2 }], grantsReward: false });
    const empty = evaluate({ ...state, members: [] }, subset);
    expect(empty.candidates).toEqual([]); expect(empty.missingChoiceCount).toBe(3);
  });
  it('is deterministic, frozen, pure and does not change the live twelve-card offer stream', () => {
    const state = party(), before = JSON.stringify(state), oldPool = legalTalentCandidates(state, catalog), oldOffer = previewNextOffer(state, catalog);
    const result = evaluate(state);
    const reordered = { ...catalog, talents: [...catalog.talents].reverse(), skills: [...catalog.skills].reverse() };
    expect(evaluate(state, reordered)).toEqual(result);
    expect(evaluate(state)).toEqual(result);
    expect(Object.isFrozen(result.candidates)).toBe(true); expect(JSON.stringify(state)).toBe(before);
    expect(legalTalentCandidates(state, catalog)).toEqual(oldPool); expect(previewNextOffer(state, catalog)).toEqual(oldOffer);
    expect(oldPool.every(card => combatCatalog.talents.some(original => original.id === card.definitionId))).toBe(true);
  });
});
