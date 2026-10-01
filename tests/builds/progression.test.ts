import { describe, expect, it } from 'vitest';
import { applyBuildAuthorityCommand, applyBuildCommand, buildCombatLoadout, createBuildFrame, EQUIPMENT_DEFINITIONS, getBuildChoices, getBuildProgress, isBuildAuthorityCommand, isBuildCommand, MILESTONE_RULE_IDS, SKILL_LEARNING_RULES, STARTER_SKILLS } from '../../src/core/builds';
import type { BuildAuthorityCommand, BuildCommand, BuildFrame } from '../../src/core/builds';
import { cloneJson } from '../../src/core/kernel/serialization';
import { createBattle, issueCommand, stepBattle } from '../../src/core/combat/runtime';
import { authority, catalog, fresh, granted, player } from './helpers';

const a = ['node.sword.liuhen', 'node.sword.yangfeng', 'node.sword.guichao'];
const b = ['node.sword.ruiyi', 'node.sword.chuanyun', 'node.sword.guanri'];
const allocation = (nodeIds: string[]) => ({ kind: 'tree.respec' as const, discipleId: 'entity:1', nodeIds });

describe('permanent trees and source transactions', () => {
  it('retains all four authored trees and 36 exact one-point, prerequisite-gated nodes', () => {
    expect(catalog.trees).toHaveLength(4); expect(catalog.treeNodes).toHaveLength(36);
    for (const tree of catalog.trees) {
      expect(tree.maximumPoints).toBe(5); expect(tree.nodeIds).toHaveLength(9);
      for (const node of catalog.treeNodes.filter(node => node.treeId === tree.id)) {
        expect(node.pointCost).toBe(1); expect(node.prerequisites).toHaveLength(node.tier - 1);
      }
    }
  });
  it('requires earned points, branch prerequisites, one school, uniqueness, and at most five points', () => {
    expect(player(fresh(), allocation(a.slice(0, 1)))).toMatchObject({ ok: false, code: 'INSUFFICIENT_POINTS' });
    const frame = granted();
    expect(player(frame, allocation(a.slice(1)))).toMatchObject({ ok: false, code: 'MISSING_PREREQUISITE' });
    expect(player(frame, allocation([...a, ...b]))).toMatchObject({ ok: false, code: 'POINT_LIMIT' });
    expect(player(frame, allocation([a[0]!, a[0]!]))).toMatchObject({ ok: false, code: 'INVALID_ALLOCATION' });
    expect(player(frame, allocation(['node.body.houtu']))).toMatchObject({ ok: false, code: 'INVALID_ALLOCATION' });
    expect(player(frame, allocation(['node.sword.unknown']))).toMatchObject({ ok: false, code: 'UNKNOWN_DEFINITION' });
    const result = player(frame, allocation([...a, ...b.slice(0, 2)].reverse()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getBuildProgress(result.frame, 'entity:1', catalog)).toMatchObject({ earnedPoints: 5, allocatedPoints: 5, availablePoints: 0 });
    expect(result.operations).toHaveLength(5);
    expect(result.operations.every(operation => operation.kind === 'source.install' && operation.source.lifecycleScope === 'character' && operation.source.sourceEntityId === 'entity:1')).toBe(true);
  });
  it('removes sources reverse-topologically, installs in prerequisite order with fresh global IDs', () => {
    const first = player(granted(), allocation(a)); if (!first.ok) throw new Error(first.code);
    const oldIds = first.operations.map(operation => operation.source.sourceInstanceId);
    const second = player(first.frame, allocation(b)); if (!second.ok) throw new Error(second.code);
    expect(second.operations.map(operation => [operation.kind, operation.source.sourceDefinitionId])).toEqual([
      ...[...a].reverse().map(id => ['source.remove', id]), ...b.map(id => ['source.install', id]),
    ]);
    const newIds = second.operations.filter(operation => operation.kind === 'source.install').map(operation => operation.source.sourceInstanceId);
    expect(newIds.every(id => !oldIds.includes(id))).toBe(true);
    expect(second.frame.builds.disciples[0]!.sources.filter(source => source.kind === 'treeNode').map(source => source.sourceInstanceId)).toEqual(newIds);
    const cleared = player(second.frame, allocation([])); if (!cleared.ok) throw new Error(cleared.code);
    expect(getBuildProgress(cleared.frame, 'entity:1', catalog).availablePoints).toBe(5);
    expect(cleared.frame.builds.disciples[0]!.sources.some(source => oldIds.includes(source.sourceInstanceId) || newIds.includes(source.sourceInstanceId))).toBe(false);
  });
  it('makes same-allocation command harmless without replacing source IDs', () => {
    const first = player(granted(), allocation(a)); if (!first.ok) throw new Error(first.code);
    const next = player(first.frame, allocation([...a].reverse())); if (!next.ok) throw new Error(next.code);
    expect(next.operations).toEqual([]); expect(next.frame.sequences).toEqual(first.frame.sequences);
  });
  it('rolls back all removals/installs, receipts and sequence consumption on allocation overflow', () => {
    const initial = player(granted(), allocation(a)); if (!initial.ok) throw new Error(initial.code);
    const before: BuildFrame = cloneJson(initial.frame) as BuildFrame;
    before.sequences.nextInstance = Number.MAX_SAFE_INTEGER - 1;
    const snapshot = cloneJson(before);
    const next = player(before, allocation(b));
    expect(next).toMatchObject({ ok: false, code: 'OVERFLOW' });
    expect(next.frame).toBe(before); expect(before).toEqual(snapshot);
  });
});

describe('milestone authority and bounded permanent learning', () => {
  it('separates public player commands from milestone and equipment authority commands', () => {
    const command = { commandId: 'award:1', expectedRevision: 0, kind: 'milestone.award', discipleId: 'entity:1', milestoneId: 'realm-completion:1', ruleId: 'realm.qi' } as const;
    expect(isBuildAuthorityCommand(command)).toBe(true); expect(isBuildCommand(command)).toBe(false);
    expect(applyBuildCommand(fresh(), command as unknown as BuildCommand, catalog)).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  });
  it('deduplicates both milestone fact IDs and rule IDs, rejecting changed event payloads', () => {
    const start = fresh();
    const one = authority(start, { kind: 'milestone.award', discipleId: 'entity:1', milestoneId: 'fact:1', ruleId: 'realm.qi' }); if (!one.ok) throw new Error(one.code);
    const duplicate = authority(one.frame, { kind: 'milestone.award', discipleId: 'entity:1', milestoneId: 'fact:1', ruleId: 'realm.qi' }); if (!duplicate.ok) throw new Error(duplicate.code);
    expect(duplicate.frame.builds.awards).toHaveLength(1);
    expect(authority(duplicate.frame, { kind: 'milestone.award', discipleId: 'entity:2', milestoneId: 'fact:1', ruleId: 'realm.qi' })).toMatchObject({ ok: false, code: 'MILESTONE_CONFLICT' });
    expect(authority(duplicate.frame, { kind: 'milestone.award', discipleId: 'entity:1', milestoneId: 'fact:1', ruleId: 'realm.foundation' })).toMatchObject({ ok: false, code: 'MILESTONE_CONFLICT' });
    expect(authority(duplicate.frame, { kind: 'milestone.award', discipleId: 'entity:1', milestoneId: 'fact:2', ruleId: 'realm.qi' })).toMatchObject({ ok: false, code: 'MILESTONE_ALREADY_AWARDED' });
    const max = granted(); expect(max.builds.awards).toHaveLength(MILESTONE_RULE_IDS.length);
    expect(getBuildProgress(max, 'entity:1', catalog)).toMatchObject({ earnedPoints: 5, earnedLearningCredits: 10 });
    expect(authority(max, { kind: 'milestone.award', discipleId: 'entity:1', milestoneId: 'fact:new', ruleId: 'invented' as 'realm.qi' })).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  });
  it('requires bounded credits and prerequisite knowledge and preserves learned skills across respec', () => {
    expect(player(fresh(), { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.cangfeng' })).toMatchObject({ ok: false, code: 'INSUFFICIENT_LEARNING_CREDITS' });
    const frame = granted();
    expect(player(frame, { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.qingxin' })).toMatchObject({ ok: false, code: 'MISSING_PREREQUISITE' });
    const learned = player(frame, { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.cangfeng' }); if (!learned.ok) throw new Error(learned.code);
    expect(learned.operations).toEqual([]);
    expect(getBuildProgress(learned.frame, 'entity:1', catalog).spentLearningCredits).toBe(2);
    expect(player(learned.frame, { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.cangfeng' })).toMatchObject({ ok: false, code: 'ALREADY_LEARNED' });
    const respec = player(learned.frame, allocation(a)); if (!respec.ok) throw new Error(respec.code);
    const clear = player(respec.frame, allocation([])); if (!clear.ok) throw new Error(clear.code);
    expect(clear.frame.builds.disciples[0]!.learnedSkills).toEqual(learned.frame.builds.disciples[0]!.learnedSkills);
    expect(clear.frame.builds.disciples[0]!.sources.filter(source => source.kind === 'skill')).toHaveLength(3);
    expect(clear.frame.builds.disciples[0]!.sources.some(source => source.sourceDefinitionId === 'skill.cangfeng')).toBe(false);
    // Learned records depend on the learner and acquisition, never a teacher's living source.
    expect(clear.frame.builds.disciples[0]!.learnedSkills.every(skill => !('teacherId' in skill))).toBe(true);
  });
  it('has a declared learning rule for every existing skill and no zero-cost elective study', () => {
    expect(SKILL_LEARNING_RULES.map(rule => rule.skillId).sort()).toEqual(catalog.skills.map(skill => skill.id).sort());
    expect(SKILL_LEARNING_RULES.every(rule => rule.creditCost > 0 && rule.creditCost <= 3)).toBe(true);
  });
});

describe('loadout support, slots and ownership', () => {
  it('provides four complete supported starter loadouts with no random talent', () => {
    const frame = fresh();
    for (const disciple of frame.builds.disciples) {
      const loadout = buildCombatLoadout(frame, disciple.discipleId, catalog);
      expect([...loadout.activeSkillIds, loadout.passiveSkillId]).toEqual(STARTER_SKILLS[disciple.school]);
      expect(loadout.characterSourceIds).toEqual([]);
      expect(loadout.stats).toEqual({ attack: 15, maxHealth: 120, armor: 1 }); expect(loadout.maximumSpirit).toBe(120);
      let battle = createBattle(catalog, { seed: 'starter', contentMode: 'experimental', entities: [
        { id: 'entity:1', team: 'allies', position: { x: 0, y: 0 }, skills: [...loadout.activeSkillIds, loadout.passiveSkillId], sources: loadout.characterSourceIds, basic: loadout.basic, stats: loadout.stats },
        { id: 'entity:2', team: 'enemies', position: { x: 20, y: 0 }, stats: { attack: 1, maxHealth: 100 } },
      ] });
      battle = issueCommand(battle, catalog, { kind: 'basic', actorId: 'entity:1', targetId: 'entity:2' });
      battle = stepBattle(battle, catalog, 1);
      expect(battle.entities['entity:2']!.health).toBeLessThan(100);
      expect(Object.values(battle.sources).some(source => source.sourceDefinitionId.startsWith('talent.'))).toBe(false);
    }
  });
  it('rejects unverified catalog play unless experimental mode was explicitly chosen', () => {
    expect(() => createBuildFrame({ disciples: [{ discipleId: 'entity:1', school: 'sword' }], contentMode: 'verified' }, catalog)).toThrow();
  });
  it('surfaces genuinely unsupported chain-stagger adjustments and never silently substitutes skills', () => {
    const blocked = { ...catalog, skills: catalog.skills.map(skill => skill.id === 'skill.yuanhu' && skill.activation === 'active' ? { ...skill, action: { ...skill.action, effects: [{ kind: 'augmentNextAction' as const, target: { kind: 'self' as const }, condition: { kind: 'always' as const }, tags: ['active' as const], uses: 1, duration: { kind: 'ticks' as const, ticks: 10 }, adjustment: { kind: 'additionalChainTargets' as const, value: 1, staggerTicks: 16 } }] } } : skill) };
    const frame = createBuildFrame({ disciples: [{ discipleId: 'entity:1', school: 'sword' }, { discipleId: 'entity:2', school: 'body' }], contentMode: 'experimental' }, blocked); const choice = getBuildChoices(frame, 'entity:1', blocked).skills.find(item => item.definitionId === 'skill.yuanhu')!;
    expect(choice.available).toBe(false); expect(choice.reasons.some(reason => reason.includes('Unsupported'))).toBe(true);
    expect(player(frame, { kind: 'skill.learn', discipleId: 'entity:2', skillId: 'skill.yuanhu' }, 'unsupported-yuanhu', blocked)).toMatchObject({ ok: false, code: 'UNSUPPORTED_CONTENT' });
  });
  it('keeps learned skills separate from equipped slots and validates replacements atomically', () => {
    const learned = player(granted(), { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.cangfeng' }); if (!learned.ok) throw new Error(learned.code);
    const old = cloneJson(learned.frame.builds.disciples[0]!.loadout);
    const next = player(learned.frame, { kind: 'loadout.set', discipleId: 'entity:1', loadout: { ...old, passiveSkillId: 'skill.cangfeng' } }); if (!next.ok) throw new Error(next.code);
    expect(next.operations.filter(operation => operation.kind === 'source.remove')).toHaveLength(6);
    expect(next.operations.filter(operation => operation.kind === 'source.install')).toHaveLength(6);
    expect(next.frame.builds.disciples[0]!.learnedSkills.some(skill => skill.skillId === 'skill.jianxin')).toBe(true);
    const loadout = cloneJson(next.frame.builds.disciples[0]!.loadout);
    expect(player(next.frame, { kind: 'loadout.set', discipleId: 'entity:1', loadout: { ...loadout, activeSkillIds: ['skill.liuhen-jian', 'skill.jianxin'] } })).toMatchObject({ ok: false, code: 'INVALID_LOADOUT' });
    expect(player(next.frame, { kind: 'loadout.set', discipleId: 'entity:1', loadout: { ...loadout, activeSkillIds: ['skill.liuhen-jian', 'skill.guanri-jianjue'] } })).toMatchObject({ ok: false, code: 'INVALID_LOADOUT' });
    expect(player(next.frame, { kind: 'loadout.set', discipleId: 'entity:1', loadout: { ...loadout, basicId: 'basic.body' } })).toMatchObject({ ok: false, code: 'INVALID_LOADOUT' });
  });
  it('equips a supported ultimate in one of exactly two active slots', () => {
    const frame = granted(5, 'entity:2');
    const learned = player(frame, { kind: 'skill.learn', discipleId: 'entity:2', skillId: 'skill.budong-shan' }); if (!learned.ok) throw new Error(learned.code);
    const old = learned.frame.builds.disciples.find(disciple => disciple.discipleId === 'entity:2')!.loadout;
    const equipped = player(learned.frame, { kind: 'loadout.set', discipleId: 'entity:2', loadout: { ...old, activeSkillIds: ['skill.baoyue', 'skill.budong-shan'] } }); if (!equipped.ok) throw new Error(equipped.code);
    expect(buildCombatLoadout(equipped.frame, 'entity:2', catalog).activeSkillIds).toEqual(['skill.baoyue', 'skill.budong-shan']);
    expect(equipped.frame.builds.disciples[1]!.learnedSkills.some(skill => skill.skillId === 'skill.zhenbu')).toBe(true);
    expect(getBuildProgress(equipped.frame, 'entity:2', catalog).spentLearningCredits).toBe(3);
    expect(player(equipped.frame, { kind: 'loadout.set', discipleId: 'entity:2', loadout: { ...old, passiveSkillId: 'skill.budong-shan' } })).toMatchObject({ ok: false, code: 'INVALID_LOADOUT' });
  });
  it('declares prototype equipment stats, checks exclusive instances, and deduplicates acquisition facts', () => {
    expect(EQUIPMENT_DEFINITIONS).toHaveLength(6);
    const frame = fresh(); const loadout = cloneJson(frame.builds.disciples[0]!.loadout);
    const foreignRobe = frame.builds.disciples[1]!.loadout.equipment.robeId;
    expect(player(frame, { kind: 'loadout.set', discipleId: 'entity:1', loadout: { ...loadout, equipment: { ...loadout.equipment, robeId: foreignRobe } } })).toMatchObject({ ok: false, code: 'ITEM_NOT_OWNED' });
    const swapped = { ...loadout, equipment: { ...loadout.equipment, robeId: loadout.equipment.artifactId, artifactId: loadout.equipment.robeId } };
    expect(player(frame, { kind: 'loadout.set', discipleId: 'entity:1', loadout: swapped })).toMatchObject({ ok: false, code: 'INVALID_LOADOUT' });
    const one = authority(frame, { kind: 'equipment.grant', discipleId: 'entity:1', acquisitionId: 'loot:1', definitionId: 'equipment.training-robe' }); if (!one.ok) throw new Error(one.code);
    const twice = authority(one.frame, { kind: 'equipment.grant', discipleId: 'entity:1', acquisitionId: 'loot:1', definitionId: 'equipment.training-robe' }); if (!twice.ok) throw new Error(twice.code);
    expect(twice.frame.builds.equipment).toHaveLength(13);
    expect(authority(twice.frame, { kind: 'equipment.grant', discipleId: 'entity:2', acquisitionId: 'loot:1', definitionId: 'equipment.training-robe' })).toMatchObject({ ok: false, code: 'ACQUISITION_CONFLICT' });
  });
});

describe('expedition locks and command boundaries', () => {
  it('locks every player mutation and releases only with exact run/lock pairing', () => {
    const frame = granted();
    const locks = [{ discipleId: 'entity:1', lockId: 'lock:1' }];
    const locked = authority(frame, { kind: 'expedition.lock', runId: 'run:1', locks }); if (!locked.ok) throw new Error(locked.code);
    expect(player(locked.frame, allocation(a))).toMatchObject({ ok: false, code: 'EXPEDITION_LOCKED' });
    expect(player(locked.frame, { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.cangfeng' })).toMatchObject({ ok: false, code: 'EXPEDITION_LOCKED' });
    expect(player(locked.frame, { kind: 'loadout.set', discipleId: 'entity:1', loadout: cloneJson(locked.frame.builds.disciples[0]!.loadout) })).toMatchObject({ ok: false, code: 'EXPEDITION_LOCKED' });
    expect(authority(locked.frame, { kind: 'expedition.unlock', runId: 'run:2', locks })).toMatchObject({ ok: false, code: 'LOCK_MISMATCH' });
    const unlocked = authority(locked.frame, { kind: 'expedition.unlock', runId: 'run:1', locks }); if (!unlocked.ok) throw new Error(unlocked.code);
    expect(player(unlocked.frame, allocation(a)).ok).toBe(true);
  });
  it('rolls back earlier party locks when any later member fails validation', () => {
    const frame = fresh(); const prior = cloneJson(frame);
    const result = authority(frame, { kind: 'expedition.lock', runId: 'run:1', locks: [{ discipleId: 'entity:1', lockId: 'lock:1' }, { discipleId: 'entity:999', lockId: 'lock:2' }] });
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_DISCIPLE' }); expect(result.frame).toBe(frame); expect(frame).toEqual(prior);
  });
  it('deduplicates exact commands before revision checks and emits no duplicate source effects', () => {
    const frame = granted(); const command: BuildCommand = { ...allocation(a), commandId: 'command:respec', expectedRevision: frame.builds.revision };
    const first = applyBuildCommand(frame, command, catalog); if (!first.ok) throw new Error(first.code);
    const repeat = applyBuildCommand(first.frame, cloneJson(command), catalog);
    expect(repeat).toMatchObject({ ok: true, replayed: true, operations: [] }); expect(repeat.frame).toBe(first.frame);
    expect(applyBuildCommand(first.frame, { ...command, nodeIds: b }, catalog)).toMatchObject({ ok: false, code: 'COMMAND_CONFLICT' });
    expect(applyBuildCommand(first.frame, { ...command, commandId: 'new:1' }, catalog)).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
  });
  it('does not share caller-owned arrays or command references', () => {
    const frame = granted(); const ids = [...a]; const next = player(frame, allocation(ids)); if (!next.ok) throw new Error(next.code);
    ids.length = 0; expect(next.frame.builds.disciples[0]!.allocatedNodeIds).toHaveLength(3);
    expect(Object.isFrozen(next.frame)).toBe(true); expect(Object.isFrozen(next.operations[0]!.source)).toBe(true);
    const loadout = buildCombatLoadout(next.frame, 'entity:1', catalog); loadout.activeSkillIds[0] = 'corrupted';
    expect(next.frame.builds.disciples[0]!.loadout.activeSkillIds[0]).toBe('skill.liuhen-jian');
  });
  it('rejects malformed authority payloads, unknown fields, sparse arrays, accessors and arbitrary code', () => {
    const frame = fresh();
    const valid: BuildAuthorityCommand = { kind: 'milestone.award', commandId: 'award:1', expectedRevision: 0, discipleId: 'entity:1', milestoneId: 'fact:1', ruleId: 'realm.qi' };
    for (const bad of [{ ...valid, amount: 100 }, { ...valid, expectedRevision: NaN }, { ...valid, kind: 'eval', code: 'attack=999' }, null]) {
      expect(applyBuildAuthorityCommand(frame, bad as BuildAuthorityCommand, catalog).ok).toBe(false);
    }
    const getter = Object.defineProperty({}, 'kind', { enumerable: true, get: () => { throw new Error('Must not invoke'); } });
    expect(isBuildCommand(getter)).toBe(false);
    expect(isBuildCommand({ ...allocation(new Array(1)), commandId: 'bad:1', expectedRevision: 0 })).toBe(false);
  });
});
