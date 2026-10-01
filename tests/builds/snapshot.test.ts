import { describe, expect, it } from 'vitest';
import { applyBuildAuthorityCommand, buildCombatLoadout, createBuildFrame, restoreBuilds, serializeBuilds, validateBuildFrame } from '../../src/core/builds';
import type { BuildFrame } from '../../src/core/builds';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';
import { authority, catalog, fresh, granted, player } from './helpers';

function envelope(frame: unknown): string { return canonicalStringify({ format: 'shanmen-builds', version: 1, frame, checksum: stableHash(frame) }); }
function allocated() {
  const result = player(granted(), { kind: 'tree.respec', discipleId: 'entity:1', nodeIds: ['node.sword.liuhen', 'node.sword.yangfeng'] });
  if (!result.ok) throw new Error(result.code); return result.frame;
}

describe('build snapshot replay and hostile save validation', () => {
  it('accepts an empty archived roster without consuming IDs, points or equipment', () => {
    const sequences = { nextEntity: 17, nextEvent: 33, nextAction: 12, nextInstance: 41 };
    const frame = createBuildFrame({ disciples: [], contentMode: 'experimental', sequences }, catalog);
    expect(frame.sequences).toEqual(sequences);
    expect(frame.builds.disciples).toEqual([]); expect(frame.builds.equipment).toEqual([]); expect(frame.builds.awards).toEqual([]);
    expect(restoreBuilds(serializeBuilds(frame, catalog), catalog)).toEqual(frame);
    expect(player(frame, { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.liuhen-jian' })).toMatchObject({ ok: false, code: 'UNKNOWN_DISCIPLE' });
    expect(authority(frame, { kind: 'expedition.lock', runId: 'run:1', locks: [] })).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
  });

  it('roundtrips the full permanent state and continues with exactly the same IDs', () => {
    const frame = allocated(); const text = serializeBuilds(frame, catalog);
    const restored = restoreBuilds(text, catalog);
    expect(restored).toEqual(frame); expect(Object.isFrozen(restored.builds.disciples[0]!.learnedSkills)).toBe(true);
    const command = { kind: 'skill.learn' as const, discipleId: 'entity:1', skillId: 'skill.cangfeng' };
    const direct = player(frame, command); const resumed = player(restored, command);
    expect(resumed).toEqual(direct);
  });
  it('replays external monotonic sequence advances without resetting global world IDs', () => {
    const external: BuildFrame = cloneJson(fresh()) as BuildFrame;
    external.sequences.nextEntity = 100; external.sequences.nextEvent = 300; external.sequences.nextInstance = 500;
    const result = authority(external, { kind: 'equipment.grant', discipleId: 'entity:1', acquisitionId: 'loot:external', definitionId: 'equipment.training-robe' });
    if (!result.ok) throw new Error(result.code);
    expect(result.receipt.resultId).toBe('instance:500');
    expect(result.frame.sequences).toMatchObject({ nextEntity: 100, nextEvent: 300, nextInstance: 501 });
    const final: BuildFrame = cloneJson(result.frame) as BuildFrame; final.sequences.nextAction = 10;
    expect(restoreBuilds(serializeBuilds(final, catalog), catalog)).toEqual(final);
  });
  it('detects rehashed source ownership, point, item, knowledge, lock and receipt forgery', () => {
    const locked = authority(allocated(), { kind: 'expedition.lock', runId: 'run:1', locks: [{ discipleId: 'entity:1', lockId: 'lock:1' }] });
    if (!locked.ok) throw new Error(locked.code);
    const mutations: ((frame: BuildFrame) => void)[] = [
      frame => { frame.builds.disciples[0]!.sources[0] = { ...frame.builds.disciples[0]!.sources[0]!, sourceEntityId: 'entity:2' }; },
      frame => { frame.builds.disciples[0]!.sources[0] = { ...frame.builds.disciples[0]!.sources[0]!, sourceInstanceId: frame.builds.disciples[1]!.sources[0]!.sourceInstanceId }; },
      frame => { frame.builds.disciples[0]!.allocatedNodeIds.push('node.sword.guichao'); },
      frame => { frame.builds.awards[0]!.treePoints = 99 as 1; },
      frame => { frame.builds.disciples[0]!.learnedSkills.push({ skillId: 'skill.missing', origin: 'study', creditCost: 0, acquisitionId: 'free:1' }); },
      frame => { frame.builds.disciples[0]!.learnedSkills = frame.builds.disciples[0]!.learnedSkills.filter(skill => skill.skillId !== 'skill.liuhen-jian'); },
      frame => { frame.builds.disciples[0]!.loadout.equipment.robeId = frame.builds.disciples[1]!.loadout.equipment.robeId; },
      frame => { frame.builds.equipment[0]!.ownerDiscipleId = 'entity:2'; },
      frame => { frame.builds.disciples[0]!.lock!.runId = 'run:other'; },
      frame => { frame.builds.receipts[0]!.fingerprint = 'forged'; },
      frame => { frame.builds.receipts[frame.builds.receipts.length - 1]!.operations.push({ kind: 'source.install', source: frame.builds.disciples[0]!.sources[0]! }); },
      frame => { frame.builds.history[0]!.authority = false; },
      frame => { frame.builds.history[1]!.sequencesBefore.nextInstance = 1; },
      frame => { frame.sequences.nextInstance = 1; },
    ];
    for (const mutate of mutations) {
      const frame = cloneJson(locked.frame) as BuildFrame; mutate(frame);
      expect(() => restoreBuilds(envelope(frame), catalog)).toThrow();
      expect(() => validateBuildFrame(frame, catalog)).toThrow();
    }
  });
  it('rejects corrupted envelopes, unknown version/fields, non-JSON and changed content', () => {
    const frame = fresh(); const snapshot = JSON.parse(serializeBuilds(frame, catalog)) as Record<string, unknown>;
    for (const change of [{ ...snapshot, checksum: 'broken' }, { ...snapshot, version: 2 }, { ...snapshot, extra: 'unexpected' }]) {
      expect(() => restoreBuilds(JSON.stringify(change), catalog)).toThrow();
    }
    expect(() => restoreBuilds('null', catalog)).toThrow(); expect(() => restoreBuilds('not-json', catalog)).toThrow();
    expect(() => restoreBuilds(JSON.stringify({ ...snapshot, frame: { ...(snapshot.frame as object), extra: 1 } }), catalog)).toThrow();
    const changed = { ...catalog, contentVersion: 'changed' };
    expect(() => restoreBuilds(serializeBuilds(frame, catalog), changed)).toThrow();
    expect(() => validateBuildFrame({ ...frame, data: () => 1 }, catalog)).toThrow();
    const circular: Record<string, unknown> = {}; circular['self'] = circular;
    expect(() => validateBuildFrame(circular, catalog)).toThrow();
  });
  it('refuses mutable forged frames before mutation and preserves their original object', () => {
    const frame = cloneJson(fresh()) as BuildFrame;
    frame.builds.disciples[0]!.sources[0] = { ...frame.builds.disciples[0]!.sources[0]!, createdSequence: -1 };
    const previous = cloneJson(frame);
    const result = applyBuildAuthorityCommand(frame, { kind: 'milestone.award', commandId: 'award:forged', expectedRevision: 0, discipleId: 'entity:1', milestoneId: 'fact:forged', ruleId: 'realm.qi' }, catalog);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_STATE' }); expect(result.frame).toBe(frame); expect(frame).toEqual(previous);
    expect(() => buildCombatLoadout(frame, 'entity:1', catalog)).toThrow();
  });
  it('rejects history command-ID conflicts even when final checksums are recomputed', () => {
    const frame = cloneJson(allocated()) as BuildFrame;
    frame.builds.history[1]!.command.commandId = frame.builds.history[0]!.command.commandId;
    expect(() => restoreBuilds(envelope(frame), catalog)).toThrow();
  });
  it('keeps permanent knowledge after removing every allocation and after independent teacher state changes', () => {
    let frame = granted(5, 'entity:2', granted());
    const study = player(frame, { kind: 'skill.learn', discipleId: 'entity:1', skillId: 'skill.cangfeng' }); if (!study.ok) throw new Error(study.code);
    frame = study.frame; const studentKnowledge = cloneJson(frame.builds.disciples[0]!.learnedSkills);
    // The world owns teaching/death facts. No foreign teacher source is installed on a learner.
    const teacherRespec = player(frame, { kind: 'tree.respec', discipleId: 'entity:2', nodeIds: ['node.body.houtu'] }); if (!teacherRespec.ok) throw new Error(teacherRespec.code);
    const teacherCleanup = player(teacherRespec.frame, { kind: 'tree.respec', discipleId: 'entity:2', nodeIds: [] }); if (!teacherCleanup.ok) throw new Error(teacherCleanup.code);
    expect(restoreBuilds(serializeBuilds(teacherCleanup.frame, catalog), catalog).builds.disciples[0]!.learnedSkills).toEqual(studentKnowledge);
  });
});
