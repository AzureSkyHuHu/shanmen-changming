import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentIdentity, RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import { resolveBuildContentContext } from '../../src/content/registry/build-context';
import { applyBuildAuthorityCommandV2, applyBuildCommandV2, buildCombatLoadoutV2, createBuildFrameV2,
  getBuildProgressV2, restoreBuildsV2, serializeBuildsV2, upgradeLegacyBuildFrameV1, validateBuildFrameV2 } from '../../src/core/builds/v2';
import { validateLegacyBuildFrameV1 } from '../../src/core/builds/legacy-v1';
import type { BuildAuthorityCommandV2, BuildContentContext, BuildFrameV2, BuildStateFrameV2 } from '../../src/core/builds/v2-types';
import type { BuildCommand, BuildFrame } from '../../src/core/builds/types';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';

const context = resolveBuildContentContext(contentIdentity(RELEASE_V8_CANDIDATE), { allowCandidate: true })!;
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
function fresh(): BuildStateFrameV2 {
  return createBuildFrameV2({ disciples: [{ discipleId: 'entity:1', school: 'sword' }, { discipleId: 'entity:2', school: 'body' },
    { discipleId: 'entity:3', school: 'alchemy' }, { discipleId: 'entity:4', school: 'talisman' }], contentMode: 'experimental' }, context);
}
function authority(frame: BuildStateFrameV2, body: Body<BuildAuthorityCommandV2>, commandId = `authority/${frame.builds.revision + 1}`) {
  return applyBuildAuthorityCommandV2(frame, { ...body, commandId, expectedRevision: frame.builds.revision } as BuildAuthorityCommandV2, context);
}
function act(frame: BuildStateFrameV2, body: Body<BuildAuthorityCommandV2>, commandId?: string): BuildStateFrameV2 {
  const result = authority(frame, body, commandId); expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.code); return result.frame;
}
function player(frame: BuildStateFrameV2, body: Body<BuildCommand>) {
  return applyBuildCommandV2(frame, { ...body, commandId: `player/${frame.builds.revision + 1}`, expectedRevision: frame.builds.revision } as BuildCommand, context);
}
function roundtrip(frame: BuildStateFrameV2): BuildStateFrameV2 { return restoreBuildsV2(serializeBuildsV2(frame, context), context); }
function source(name: string) {
  const text = readFileSync(new URL(`../integration/fixtures/${name}`, import.meta.url), 'utf8');
  const envelope = JSON.parse(text) as { payload: { builds: BuildFrame['builds']; sequences: BuildFrame['sequences'] } };
  return { text, frame: { builds: envelope.payload.builds, sequences: envelope.payload.sequences } };
}
function knowledge(frame: BuildStateFrameV2, discipleId = 'entity:3', acquisitionId = `archive/${discipleId}`) {
  return act(frame, { kind: 'skill.grantKnowledge', discipleId, skillId: 'skill.qingxin', acquisitionId,
    provenance: { kind: 'archive', knowledgeId: 'knowledge.clear-heart' } });
}

describe('additive versioned permanent build v2', () => {
  it.each(['save-v7-active-automatic.json', 'save-v7-active-battle.json', 'save-v7-awaiting-choice.json', 'save-v7-ended-clear.json'])(
    'strictly upgrades genuine %s while preserving its original sources, prefix, locks and bytes', filename => {
      const fixture = source(filename); const before = cloneJson(fixture.frame);
      const manifest = JSON.parse(readFileSync(new URL('../integration/fixtures/save-v7-campaign-provenance.json', import.meta.url), 'utf8')) as {
        fixtures: { filename: string; sha256: string }[] };
      expect(createHash('sha256').update(fixture.text).digest('hex')).toBe(manifest.fixtures.find(item => item.filename === filename)!.sha256);
      validateLegacyBuildFrameV1(fixture.frame, context.legacy.catalog);
      const upgraded = upgradeLegacyBuildFrameV1(fixture.frame, context);
      expect(upgraded.sequences).toEqual(before.sequences); expect(upgraded.builds.disciples).toEqual(before.builds.disciples);
      expect(upgraded.builds.origin).toEqual(before.builds.origin); expect(upgraded.builds.history).toEqual(before.builds.history);
      expect(upgraded.builds.receipts).toEqual(before.builds.receipts); expect(upgraded.builds.awards).toEqual(before.builds.awards);
      expect(upgraded.builds.migration?.prefixLength).toBe(before.builds.history.length);
      expect(roundtrip(upgraded)).toEqual(upgraded); expect(fixture.frame).toEqual(before);
      expect(readFileSync(new URL(`../integration/fixtures/${filename}`, import.meta.url), 'utf8')).toBe(fixture.text);
    });

  it('retries a legacy receipt exactly, then unlocks a migrated encounter without rewriting the saved lockHash', () => {
    const fixture = source('save-v7-active-battle.json'); const frame = upgradeLegacyBuildFrameV1(fixture.frame, context);
    const oldEntry = fixture.frame.builds.history.find(entry => entry.command.kind === 'expedition.lock')!;
    const retried = applyBuildAuthorityCommandV2(frame, oldEntry.command as BuildAuthorityCommandV2, context);
    expect(retried).toMatchObject({ ok: true, replayed: true, operations: [] });
    if (!retried.ok) throw new Error(retried.code);
    expect(retried.frame).toBe(frame); expect(retried.receipt).toEqual(fixture.frame.builds.receipts.find(receipt => receipt.commandId === oldEntry.command.commandId));
    const locks = frame.builds.disciples.filter(d => d.lock).map(d => ({ discipleId: d.discipleId, lockId: d.lock!.lockId }));
    const runId = frame.builds.disciples.find(d => d.lock)!.lock!.runId;
    const unlocked = act(frame, { kind: 'expedition.unlock', runId, locks });
    expect(unlocked.builds.disciples.every(d => !d.lock)).toBe(true); expect(unlocked.sequences).toEqual(frame.sequences);
    expect(unlocked.builds.history.slice(0, frame.builds.history.length)).toEqual(frame.builds.history);
    expect(roundtrip(unlocked)).toEqual(unlocked);
  });

  it('uses explicit starter skills, not recommended candidate support skills, and enrolls only one fresh identity', () => {
    const before = fresh(); const frame = act(before, { kind: 'disciple.enroll', acquisitionId: 'recruit/1', discipleId: 'entity:50', school: 'alchemy' });
    expect(frame.builds.origin).toEqual(before.builds.origin); expect(frame.builds.disciples.slice(0, 4)).toEqual(before.builds.disciples);
    const recruit = frame.builds.disciples.find(d => d.discipleId === 'entity:50')!;
    expect(recruit.learnedSkills.map(skill => skill.skillId)).toEqual(context.rules.starterSkills.alchemy);
    expect(recruit.learnedSkills.some(skill => skill.skillId === 'skill.qingxin')).toBe(false);
    expect(frame.sequences.nextInstance - before.sequences.nextInstance).toBe(9);
    expect(frame.builds.equipment.slice(-3).every(item => item.acquisitionId.startsWith('recruit/1/'))).toBe(true);
    expect(getBuildProgressV2(frame, recruit.discipleId, context).earnedPoints).toBe(0); expect(roundtrip(frame)).toEqual(frame);
    expect(authority(frame, { kind: 'disciple.enroll', acquisitionId: 'recruit/other', discipleId: recruit.discipleId, school: 'alchemy' })).toMatchObject({ ok: false, code: 'IDENTITY_REUSED' });
  });

  it('grants paid archive knowledge without spending study credits or installing a skill source', () => {
    const before = fresh(); const frame = knowledge(before); const member = frame.builds.disciples[2]!;
    expect(getBuildProgressV2(frame, member.discipleId, context).spentLearningCredits).toBe(0);
    expect(member.sources).toEqual(before.builds.disciples[2]!.sources); expect(frame.sequences).toEqual(before.sequences);
    expect(member.learnedSkills.at(-1)).toMatchObject({ origin: 'archive', creditCost: 0, acquisitionId: 'archive/entity:3' });
    expect(authority(frame, { kind: 'skill.grantKnowledge', discipleId: member.discipleId, skillId: 'skill.qingxin', acquisitionId: 'archive/duplicate',
      provenance: { kind: 'archive', knowledgeId: 'knowledge.clear-heart' } })).toMatchObject({ ok: false, code: 'ALREADY_LEARNED' });
    expect(authority(frame, { kind: 'skill.grantKnowledge', discipleId: 'entity:1', skillId: 'skill.qingxin', acquisitionId: 'wrong-school',
      provenance: { kind: 'archive', knowledgeId: 'knowledge.clear-heart' } })).toMatchObject({ ok: false, code: 'UNKNOWN_DEFINITION' });
    const equipped = player(frame, { kind: 'loadout.set', discipleId: member.discipleId,
      loadout: { ...member.loadout, activeSkillIds: ['skill.qingxin', 'skill.huichun'] } });
    expect(equipped.ok).toBe(true); if (!equipped.ok) throw new Error(equipped.code);
    expect(equipped.operations.filter(operation => operation.kind === 'source.install' && operation.source.sourceDefinitionId === 'skill.qingxin')).toHaveLength(1);
    expect(roundtrip(equipped.frame)).toEqual(equipped.frame);
  });

  it('requires real teacher knowledge and retains learned knowledge after teacher retirement', () => {
    let frame = act(fresh(), { kind: 'disciple.enroll', acquisitionId: 'student/1', discipleId: 'entity:50', school: 'alchemy' });
    const body: Body<BuildAuthorityCommandV2> = { kind: 'skill.grantKnowledge', discipleId: 'entity:50', skillId: 'skill.qingxin', acquisitionId: 'teaching/1',
      provenance: { kind: 'teaching', knowledgeId: 'knowledge.clear-heart', teacherId: 'entity:3', teachingId: 'instance:1000' } };
    expect(authority(frame, body)).toMatchObject({ ok: false, code: 'INVALID_PROVENANCE' });
    frame = knowledge(frame); frame = act(frame, body);
    const learned = frame.builds.disciples.find(d => d.discipleId === 'entity:50')!.learnedSkills;
    frame = act(frame, { kind: 'disciple.retire', discipleId: 'entity:3', deathId: 'instance:2000' });
    expect(frame.builds.disciples.find(d => d.discipleId === 'entity:50')!.learnedSkills).toEqual(learned);
    expect(frame.builds.retiredDisciples[0]!.learnedSkills.some(skill => skill.skillId === 'skill.qingxin')).toBe(true);
    expect(roundtrip(frame)).toEqual(frame);
  });

  it('requires unlock before retirement and transfers the same acquired item without touching a locked heir loadout', () => {
    let frame = act(fresh(), { kind: 'equipment.grant', discipleId: 'entity:1', definitionId: 'equipment.trail-robe', acquisitionId: 'campaign/equipment/1' });
    const item = frame.builds.equipment.at(-1)!;
    frame = act(frame, { kind: 'expedition.lock', runId: 'run:1', locks: [{ discipleId: 'entity:1', lockId: 'lock:1' }, { discipleId: 'entity:2', lockId: 'lock:2' }] });
    const locked = frame;
    expect(authority(frame, { kind: 'disciple.retire', discipleId: 'entity:1', deathId: 'instance:1000' })).toMatchObject({ ok: false, code: 'EXPEDITION_LOCKED' });
    frame = act(frame, { kind: 'expedition.unlock', runId: 'run:1', locks: [{ discipleId: 'entity:1', lockId: 'lock:1' }] });
    const retired = authority(frame, { kind: 'disciple.retire', discipleId: 'entity:1', deathId: 'instance:1000' });
    expect(retired.ok).toBe(true); if (!retired.ok) throw new Error(retired.code);
    expect(retired.operations.every(operation => operation.kind === 'source.remove')).toBe(true); frame = retired.frame;
    frame = act(frame, { kind: 'equipment.transfer', transferId: 'estate/1000/item', itemInstanceId: item.instanceId,
      fromOwner: { kind: 'disciple', discipleId: 'entity:1' }, toOwner: { kind: 'disciple', discipleId: 'entity:2' }, reason: { kind: 'death', deathId: 'instance:1000' } });
    expect(frame.builds.equipment.find(entry => entry.instanceId === item.instanceId)).toEqual({ ...item, owner: { kind: 'disciple', discipleId: 'entity:2' } });
    expect(frame.builds.disciples.find(d => d.discipleId === 'entity:2')).toEqual(locked.builds.disciples.find(d => d.discipleId === 'entity:2'));
    expect(authority(frame, { kind: 'disciple.enroll', acquisitionId: 'reused', discipleId: 'entity:1', school: 'sword' })).toMatchObject({ ok: false, code: 'IDENTITY_REUSED' });
    expect(roundtrip(frame)).toEqual(frame);
  });

  it('holds unclaimed estate ownership then assigns without duplicating equipment bonuses', () => {
    let frame = fresh(); const item = frame.builds.equipment.find(entry => entry.definitionId === 'equipment.training-robe')!;
    expect(authority(frame, { kind: 'equipment.transfer', transferId: 'invalid/equipped', itemInstanceId: item.instanceId,
      fromOwner: item.owner, toOwner: { kind: 'sect-estate' }, reason: { kind: 'death', deathId: 'death:1' } })).toMatchObject({ ok: false, code: 'ITEM_ALREADY_EQUIPPED' });
    frame = act(frame, { kind: 'disciple.retire', discipleId: 'entity:1', deathId: 'death:1' });
    frame = act(frame, { kind: 'equipment.transfer', transferId: 'estate/death1/robe', itemInstanceId: item.instanceId,
      fromOwner: item.owner, toOwner: { kind: 'sect-estate' }, reason: { kind: 'death', deathId: 'death:1' } });
    const before = buildCombatLoadoutV2(frame, 'entity:2', context);
    frame = act(frame, { kind: 'equipment.transfer', transferId: 'estate/assign1', itemInstanceId: item.instanceId,
      fromOwner: { kind: 'sect-estate' }, toOwner: { kind: 'disciple', discipleId: 'entity:2' }, reason: { kind: 'estate-assignment', assignmentId: 'assign:1' } });
    expect(buildCombatLoadoutV2(frame, 'entity:2', context)).toEqual(before);
    const member = frame.builds.disciples.find(d => d.discipleId === 'entity:2')!;
    const equipped = player(frame, { kind: 'loadout.set', discipleId: 'entity:2', loadout: { ...member.loadout, equipment: { ...member.loadout.equipment, robeId: item.instanceId } } });
    expect(equipped.ok).toBe(true); if (!equipped.ok) throw new Error(equipped.code);
    expect(buildCombatLoadoutV2(equipped.frame, 'entity:2', context).stats).toEqual(before.stats);
    expect(roundtrip(equipped.frame)).toEqual(equipped.frame);
  });

  it('rejects forged prefix boundaries, receipts, owners and authority metadata even with recomputed checksums', () => {
    const frame = cloneJson(upgradeLegacyBuildFrameV1(source('save-v7-ended-clear.json').frame, context)) as BuildFrameV2;
    const mutations: ((value: BuildFrameV2) => void)[] = [
      value => { value.builds.migration!.prefixLength = 0; },
      value => { value.builds.migration!.identity.registryId = context.identity.registryId; },
      value => { value.builds.equipment[0]!.owner = { kind: 'sect-estate' }; },
      value => { value.builds.receipts[0]!.resultId = 'forged'; },
      value => { value.builds.origin.disciples[0]!.school = 'alchemy'; },
      value => { value.builds.rulesHash = '00000000'; },
      value => { value.builds.history[0]!.authority = false; },
    ];
    for (const change of mutations) {
      const candidate = cloneJson(frame); change(candidate);
      const text = canonicalStringify({ format: 'shanmen-builds', version: 2, frame: candidate, checksum: stableHash(candidate) });
      expect(() => restoreBuildsV2(text, context)).toThrow();
    }
  });

  it('keeps rejected commands and sequence overflow atomic, and excludes authority commands from the player gateway', () => {
    const initial = fresh(); const overflowing: BuildFrameV2 = { builds: cloneJson(initial.builds) as BuildFrameV2['builds'], sequences: { ...initial.sequences, nextInstance: Number.MAX_SAFE_INTEGER } };
    const before = cloneJson(overflowing);
    expect(authority(overflowing, { kind: 'disciple.enroll', discipleId: 'entity:50', school: 'sword', acquisitionId: 'overflow' })).toMatchObject({ ok: false, code: 'OVERFLOW', frame: before });
    expect(overflowing).toEqual(before);
    const authorityOnly = { kind: 'disciple.enroll', commandId: 'player-forgery', expectedRevision: 0, discipleId: 'entity:50', school: 'sword', acquisitionId: 'fake' };
    expect(applyBuildCommandV2(initial, authorityOnly as unknown as BuildCommand, context)).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    const extra = { kind: 'disciple.retire', commandId: 'extra', expectedRevision: 0, discipleId: 'entity:1', deathId: 'death:1', extra: true };
    expect(applyBuildAuthorityCommandV2(initial, extra as BuildAuthorityCommandV2, context)).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    let getterCalled = false;
    const getter = Object.defineProperty({}, 'kind', { enumerable: true, get() { getterCalled = true; return 'disciple.retire'; } });
    expect(applyBuildAuthorityCommandV2(initial, getter as BuildAuthorityCommandV2, context).ok).toBe(false); expect(getterCalled).toBe(false);
  });

  it('binds actual rules and legacy catalogs, validates mutable callers afresh and permits an empty archive', () => {
    const frame = fresh(); const changed: BuildContentContext = { ...context, rules: { ...context.rules, maximumCommands: 1000 } };
    expect(() => validateBuildFrameV2(frame, changed)).toThrow();
    const badLegacy: BuildContentContext = { ...context, legacy: { ...context.legacy, catalog: context.catalog } };
    expect(() => upgradeLegacyBuildFrameV1(source('save-v7-ended-clear.json').frame, badLegacy)).toThrow();
    const empty = createBuildFrameV2({ disciples: [], contentMode: 'experimental', sequences: { nextEntity: 20, nextEvent: 30, nextAction: 10, nextInstance: 40 } }, context);
    expect(roundtrip(empty)).toEqual(empty); expect(empty.sequences.nextInstance).toBe(40);
    const mutable = cloneJson(frame) as BuildFrameV2; validateBuildFrameV2(mutable, context);
    mutable.builds.disciples[0]!.sources[0] = { ...mutable.builds.disciples[0]!.sources[0]!, sourceEntityId: 'entity:2' };
    expect(() => validateBuildFrameV2(mutable, context)).toThrow();
  });
});
