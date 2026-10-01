import { describe, expect, it } from 'vitest';
import { applyBuildAuthorityCommand, applyBuildCommand, buildCombatLoadout, createBuildFrame, getBuildProgress } from '../../src/core/builds';
import type { BuildStateFrame, BuildTransition } from '../../src/core/builds';
import { cleanupBattleScope, createBattle, installCombatSource, issueCommand, restoreBattle, serializeBattle, statusStacks, stepBattle } from '../../src/core/combat';
import type { BattleState } from '../../src/core/combat';
import type { CombatContentCatalog } from '../../src/core/combat/definitions/types';
import { createExpedition } from '../../src/core/expeditions';
import type { ExpeditionMemberInput } from '../../src/core/expeditions/types';
import { catalog, context, evaluate, holders, loadout, own, party, previousMedicineCatalog } from './fixtures';
import { options } from '../expeditions/fixtures';

const A = 'entity:1', B = 'entity:2', E = 'entity:3';
const accepted = (result: BuildTransition): BuildStateFrame => { if (!result.ok) throw new Error(`${result.code}: ${result.reasons.join(',')}`); return result.frame; };

/** Actual permanent-build commands, ordinary training gear, no allocated tree points.
 * Milestones are domain-authority fixtures, not a claim that this test completes a campaign. */
function learnedLoadout(selected: CombatContentCatalog, useYaoli = false) {
  let frame = createBuildFrame({ disciples: [{ discipleId: A, school: 'alchemy' }, { discipleId: B, school: 'sword' }], contentMode: 'experimental' }, selected);
  for (const [index, ruleId] of (['realm.qi', 'expedition.first-victory'] as const).entries()) {
    frame = accepted(applyBuildAuthorityCommand(frame, { commandId: `witness:award:${index}`, expectedRevision: frame.builds.revision,
      kind: 'milestone.award', discipleId: A, milestoneId: `witness:milestone:${index}`, ruleId }, selected));
  }
  for (const skillId of ['skill.qingxin', 'skill.yuxi']) frame = accepted(applyBuildCommand(frame, { commandId: `witness:learn:${skillId}`,
    expectedRevision: frame.builds.revision, kind: 'skill.learn', discipleId: A, skillId }, selected));
  frame = accepted(applyBuildCommand(frame, { commandId: 'witness:equip', expectedRevision: frame.builds.revision,
    kind: 'loadout.set', discipleId: A, loadout: { ...frame.builds.disciples[0]!.loadout,
      activeSkillIds: ['skill.qingxin', 'skill.huichun'], passiveSkillId: useYaoli ? 'skill.yaoli' : 'skill.yuxi' } }, selected));
  expect(getBuildProgress(frame, A, selected)).toMatchObject({ earnedLearningCredits: 4, spentLearningCredits: 4, allocatedPoints: 0 });
  const loadout = buildCombatLoadout(frame, A, selected), ally = buildCombatLoadout(frame, B, selected);
  expect(loadout.activeSkillIds).toEqual(['skill.qingxin', 'skill.huichun']);
  expect(loadout.passiveSkillId).toBe(useYaoli ? 'skill.yaoli' : 'skill.yuxi');
  expect(loadout.maximumSpirit).toBe(120); expect(loadout.stats.attack).toBe(15);
  return { frame, loadout, ally };
}

function runSequence(selected: CombatContentCatalog, useYaoli = false) {
  const learned = learnedLoadout(selected, useYaoli);
  const inputs: ExpeditionMemberInput[] = [learned.loadout, learned.ally].map((loadout, index) => ({
    discipleId: index === 0 ? A : B, available: true, alive: true, loadout,
    health: loadout.stats.maxHealth, spirit: loadout.maximumSpirit, injury: 0, durability: 100,
  }));
  const run = createExpedition(options({ members: inputs }), selected);
  expect(holders(run, 'jingdan-shenghua', selected)).toEqual([A]);
  expect(holders(run, 'juyao-chengquan', selected)).toBeUndefined();
  // A pure admission fixture records the first selected run source. The frozen live offer
  // dispatcher intentionally does not admit release cards yet.
  const withProducer = own(run, 'jingdan-shenghua', A);
  const secondChoice = evaluate(withProducer, selected, context(withProducer, selected));
  let battle = createBattle(selected, { seed: 'medicine-repair-real-loadout', contentMode: 'experimental', logCapacity: 512,
    arena: { origin: { x: 0, y: 0 }, widthCells: 20, heightCells: 12, cellSizeUnits: 20, blockedCells: [] }, entities: [
      { id: A, team: 'allies', position: { x: 40, y: 40 }, stats: learned.loadout.stats, basic: learned.loadout.basic,
        maximumSpirit: learned.loadout.maximumSpirit, spirit: learned.loadout.maximumSpirit,
        skills: [...learned.loadout.activeSkillIds, learned.loadout.passiveSkillId], sources: learned.loadout.characterSourceIds },
      { id: B, team: 'allies', position: { x: 80, y: 40 }, stats: learned.ally.stats, health: 20, basic: learned.ally.basic,
        maximumSpirit: learned.ally.maximumSpirit, spirit: learned.ally.maximumSpirit,
        skills: [...learned.ally.activeSkillIds, learned.ally.passiveSkillId], sources: learned.ally.characterSourceIds },
      { id: E, team: 'enemies', position: { x: 160, y: 40 }, stats: { attack: 1, maxHealth: 100 } },
    ] });
  battle = installCombatSource(battle, selected, A, 'talent.jingdan-shenghua');
  // Also install the proposed payoff for negative runtime observations. This does not claim
  // that an eligibility rejection is an accepted acquisition.
  battle = installCombatSource(battle, selected, A, 'talent.juyao-chengquan');
  const cast = (state: BattleState, skillId: string): BattleState => {
    const skill = selected.skills.find(skill => skill.id === skillId)!;
    if (skill.activation !== 'active') throw new Error('Expected equipped active');
    const wait = Math.max(0, (state.entities[A]!.cooldowns[skillId] ?? 0) - state.tick);
    if (wait) state = stepBattle(state, selected, wait);
    state = issueCommand(state, selected, { kind: 'cast', actorId: A, skillId, targetId: B });
    return stepBattle(state, selected, skill.action.castTicks);
  };
  expect(battle.statuses).toEqual([]);
  battle = cast(battle, 'skill.qingxin');
  expect(battle.tick).toBe(12); expect(statusStacks(battle, selected, A, 'status.medicine')).toBe(1);
  battle = cast(battle, 'skill.qingxin');
  expect(battle.tick).toBe(304);
  const stacksBeforeHeal = statusStacks(battle, selected, A, 'status.medicine');
  const restored = restoreBattle(serializeBattle(battle), selected); expect(restored).toEqual(battle);
  battle = cast(restored, 'skill.huichun');
  expect(battle.tick).toBe(320); expect(battle.entities[A]!.spirit).toBe(62);
  const zonesAfterHeal = battle.zones.length;
  battle = stepBattle(battle, selected, 61);
  expect(battle.entities[A]!.skills).toHaveLength(3);
  expect(battle.entities[A]!.skills).not.toContain('skill.qingwu'); // known prerequisite is not a third active
  expect(battle.log.filter(event => event.kind === 'action.committed').map(event => event.sourceDefinitionId)).toEqual(['skill.qingxin', 'skill.qingxin', 'skill.huichun']);
  return { battle, secondChoice, stacksBeforeHeal, zonesAfterHeal };
}

describe('candidate.2 Medicine duration repair: actual paid-cast witness', () => {
  it('uses learned Qingxin + Huichun + Yuxi to acquire the enabler/payoff direction and pay for exactly three real healing pulses', () => {
    const selected = catalog, result = runSequence(selected);
    expect(result.secondChoice.candidates.find(card => card.definitionId === 'talent.juyao-chengquan')?.holderIds).toEqual([A]);
    expect(result.stacksBeforeHeal).toBe(2); expect(result.zonesAfterHeal).toBe(1);
    expect(statusStacks(result.battle, selected, A, 'status.medicine')).toBe(0);
    expect(result.battle.entities[B]!.health).toBe(51); // 20 + floor(15*1.5) + three floor(15*.25) pulses
    const pulses = result.battle.log.filter(event => event.kind === 'healing.resolved' && event.sourceDefinitionId === 'talent.juyao-chengquan' && event.targetId === B);
    expect(pulses.map(event => event.tick)).toEqual([340, 360, 380]);
    expect(result.battle.zones).toEqual([]);
    const cleaned = cleanupBattleScope(result.battle, selected, 'run');
    expect(Object.values(cleaned.sources).some(source => source.lifecycleScope === 'run')).toBe(false);
  });
  it('preserves the previous 200-tick candidate fixture, which loses its first stack before the second paid cleanse', () => {
    const result = runSequence(previousMedicineCatalog);
    expect(result.secondChoice.candidates.some(card => card.definitionId === 'talent.juyao-chengquan')).toBe(false);
    expect(result.stacksBeforeHeal).toBe(1); expect(result.zonesAfterHeal).toBe(0);
    expect(result.battle.entities[B]!.health).toBe(42);
  });
  it('proves the starter Yaoli passive preempts both Medicine stacks even after the duration repair', () => {
    const result = runSequence(catalog, true);
    expect(result.stacksBeforeHeal).toBe(2); expect(result.zonesAfterHeal).toBe(0);
    expect(result.secondChoice.diagnostics).toContainEqual(expect.objectContaining({ code: 'RESOURCE_PREEMPTED', definitionId: 'talent.juyao-chengquan', holderId: A }));
    expect(result.secondChoice.candidates.some(card => card.definitionId === 'talent.juyao-chengquan')).toBe(false);
  });
  it('rejects the one-stack Medicine payoff under Yaoli as well, rather than advertising a permanently starved trigger', () => {
    const state = own(loadout(party(), 'entity:6', ['skill.qingxin', 'skill.huichun'], 'skill.yaoli'), 'jingdan-shenghua', 'entity:6');
    expect(holders(state, 'yaohua-jingmai')).toBeUndefined();
    expect(evaluate(state).diagnostics).toContainEqual(expect.objectContaining({ code: 'RESOURCE_PREEMPTED', definitionId: 'talent.yaohua-jingmai', holderId: 'entity:6' }));
  });
});
