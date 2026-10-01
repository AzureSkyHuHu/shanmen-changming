import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createInventory } from '../../src/core/economy/inventory';
import { createRandomStreams } from '../../src/core/kernel/random';
import { cloneJson, canonicalStringify, stableHash } from '../../src/core/kernel/serialization';
import { createCultivationState, createCultivator } from '../../src/core/cultivation';
import type { CultivationFrame as LegacyFrame } from '../../src/core/cultivation';
import { applyCultivationAuthorityCommandV3, applyCultivationCommandV3, createCultivationStateV3, stepCultivationMonthsV3,
  validateCultivationFrameV3, upgradeCultivationFrameV2, serializeCultivationV3, restoreCultivationV3 } from '../../src/core/cultivation/v3';
import type { CultivationAuthorityCommandV3, CultivationCommand, CultivationFrame, CultivationEnrollmentProfile, Cultivator } from '../../src/core/cultivation/v3';

const profile: CultivationEnrollmentProfile = { ageMonths: 216, realm: 'mortal', lifespanMonths: 960, cultivation: 0,
  understanding: 35, foundation: 40, mindset: 65, injury: 0, aptitude: 55 };
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
function fresh(members: Cultivator[] = [createCultivator('entity:1'), createCultivator('entity:2')]): CultivationFrame {
  return { cultivation: createCultivationStateV3(members), inventory: createInventory(), randomStreams: createRandomStreams('cultivation-v3'),
    sequences: { nextEntity: 100, nextEvent: 1, nextAction: 1, nextInstance: 1 } };
}
function authority(frame: CultivationFrame, command: Body<CultivationAuthorityCommandV3>, commandId = `system/growth/${frame.cultivation.revision + 1}`) {
  return applyCultivationAuthorityCommandV3(frame, { ...command, commandId, expectedRevision: frame.cultivation.revision } as CultivationAuthorityCommandV3);
}
function act(frame: CultivationFrame, command: Body<CultivationAuthorityCommandV3>): CultivationFrame {
  const result = authority(frame, command); expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code); return result.frame;
}
function player(frame: CultivationFrame, input: Body<CultivationCommand>) {
  const result = applyCultivationCommandV3(frame, { ...input, commandId: `player:${frame.cultivation.revision + 1}`, expectedRevision: frame.cultivation.revision } as CultivationCommand);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code); return result;
}
function reload(frame: CultivationFrame) { return restoreCultivationV3(serializeCultivationV3(frame)); }
function grant(frame: CultivationFrame, discipleId = 'entity:1') {
  const acquisitionId = `campaign/lesson/knowledge.clear-heart/${discipleId}`;
  return act(frame, { kind: 'knowledge.grant', discipleId, knowledgeId: 'knowledge.clear-heart', acquisitionId, claimId: acquisitionId });
}
function finalizeExpired(frame: CultivationFrame, discipleId: string): CultivationFrame {
  const pending = frame.cultivation.pendingDeaths.find(death => death.discipleId === discipleId)!;
  return player(frame, { kind: 'death.finalize', discipleId, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true }).frame;
}

describe('additive cultivation v3 authority and retired identities', () => {
  it.each(['save-v7-active-automatic.json', 'save-v7-active-battle.json', 'save-v7-awaiting-choice.json', 'save-v7-ended-clear.json'])(
    'preserves the authentic v2 domain in %s without advancing IDs, RNG or time', filename => {
      const text = readFileSync(new URL(`../integration/fixtures/${filename}`, import.meta.url), 'utf8');
      const { payload } = JSON.parse(text) as { payload: LegacyFrame };
      const before: LegacyFrame = { cultivation: payload.cultivation, inventory: payload.inventory, sequences: payload.sequences, randomStreams: payload.randomStreams };
      const upgraded = upgradeCultivationFrameV2(before);
      expect(validateCultivationFrameV3(upgraded)).toEqual([]); expect(reload(upgraded)).toEqual(upgraded);
      const { schemaVersion: _version, legacyIdentities: _identities, legacyStateExtras: _extras, archivedDisciples: _archive, authorityReceipts: _receipts, ...preserved } = upgraded.cultivation;
      const { schemaVersion: _oldVersion, ...legacy } = before.cultivation;
      expect(preserved).toEqual(legacy); expect(upgraded.inventory).toEqual(before.inventory);
      expect(upgraded.sequences).toEqual(before.sequences); expect(upgraded.randomStreams).toEqual(before.randomStreams);
    });

  it('preserves permitted legacy metadata and unknown knowledge explicitly without inventing a grant', () => {
    const member = createCultivator('entity:1', { knowledgeIds: ['knowledge.legacy-only'] });
    const legacy = { ...fresh(), cultivation: { ...createCultivationState([member]), legacyAudit: { note: 'preserve' } } };
    const upgraded = upgradeCultivationFrameV2(legacy);
    expect(upgraded.cultivation.legacyStateExtras).toEqual({ legacyAudit: { note: 'preserve' } });
    expect(upgraded.cultivation.authorityReceipts).toEqual([]); expect(upgraded.cultivation.legacyIdentities[0]!.knowledge).toEqual(member.knowledge);
    expect(reload(upgraded)).toEqual(upgraded);
  });

  it('enrolls a fresh fixed profile exactly once, with no resource or random/sequence side effects', () => {
    const before = fresh(); const command: CultivationAuthorityCommandV3 = { commandId: 'system/enroll/1', expectedRevision: 0,
      kind: 'disciple.enroll', acquisitionId: 'campaign/recruit/1', discipleId: 'entity:50', profile };
    const result = applyCultivationAuthorityCommandV3(before, command);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code);
    expect(result.frame.cultivation.disciples.at(-1)).toMatchObject({ discipleId: 'entity:50', ...profile, lifeState: 'alive', teaching: null, activityOwner: null });
    expect(result.frame.inventory).toEqual(before.inventory); expect(result.frame.randomStreams).toEqual(before.randomStreams); expect(result.frame.sequences).toEqual(before.sequences);
    expect(applyCultivationAuthorityCommandV3(reload(result.frame), command)).toMatchObject({ ok: true, replayed: true });
    expect(authority(result.frame, { kind: 'disciple.enroll', acquisitionId: 'campaign/recruit/2', discipleId: 'entity:50', profile })).toMatchObject({ ok: false, code: 'IDENTITY_REUSED' });
    expect(applyCultivationAuthorityCommandV3(result.frame, { ...command, profile: { ...profile, aptitude: 60 } })).toMatchObject({ ok: false, code: 'COMMAND_CONFLICT' });
  });

  it('requires receipt-backed knowledge and two actual teaching months, then retains an archived teacher reference', () => {
    let frame = grant(fresh([createCultivator('entity:1', { ageMonths: 956 }), createCultivator('entity:2')]));
    frame = player(frame, { kind: 'teaching.begin', discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.clear-heart' }).frame;
    frame = stepCultivationMonthsV3(frame, 1).frame; expect(frame.cultivation.disciples[1]!.knowledge).toEqual([]);
    frame = stepCultivationMonthsV3(reload(frame), 1).frame;
    expect(frame.cultivation.disciples[1]!.knowledge[0]).toMatchObject({ knowledgeId: 'knowledge.clear-heart', teacherId: 'entity:1' });
    const taught = cloneJson(frame.cultivation.disciples[1]!.knowledge);
    frame = stepCultivationMonthsV3(frame, 2).frame; frame = finalizeExpired(frame, 'entity:1');
    frame = act(frame, { kind: 'disciple.archive', discipleId: 'entity:1', deathId: frame.cultivation.deaths[0]!.deathId });
    expect(frame.cultivation.disciples).toHaveLength(1); expect(frame.cultivation.archivedDisciples).toHaveLength(1);
    expect(frame.cultivation.disciples[0]!.knowledge).toEqual(taught); expect(reload(frame)).toEqual(frame);
    const archived = cloneJson(frame.cultivation.archivedDisciples);
    expect(stepCultivationMonthsV3(frame, 3).frame.cultivation.archivedDisciples).toEqual(archived);
    expect(authority(frame, { kind: 'disciple.enroll', acquisitionId: 'reused', discipleId: 'entity:1', profile })).toMatchObject({ ok: false, code: 'IDENTITY_REUSED' });
  });

  it('processes expiry before teaching completion and never awards interrupted learning', () => {
    let frame = grant(fresh([createCultivator('entity:1', { ageMonths: 958 }), createCultivator('entity:2')]));
    frame = player(frame, { kind: 'teaching.begin', discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.clear-heart' }).frame;
    frame = stepCultivationMonthsV3(frame, 2).frame;
    expect(frame.cultivation.pendingDeaths).toHaveLength(1); expect(frame.cultivation.disciples[1]!.knowledge).toEqual([]);
    expect(frame.cultivation.events.filter(event => event.kind === 'cultivation.taught')).toEqual([]);
    frame = finalizeExpired(frame, 'entity:1'); expect(reload(frame)).toEqual(frame);
  });

  it('refuses pending/living or expedition-locked archives and keeps failure inputs unchanged', () => {
    const before = fresh(); expect(authority(before, { kind: 'disciple.archive', discipleId: 'entity:1', deathId: 'instance:50' })).toMatchObject({ ok: false, code: 'DEATH_CONFLICT' });
    let frame = fresh([createCultivator('entity:1', { ageMonths: 959 })]); frame.cultivation.disciples[0]!.activityOwner = { kind: 'expedition', runId: 'run:1', lockId: 'lock:1' };
    frame = stepCultivationMonthsV3(frame, 1).frame;
    expect(authority(frame, { kind: 'disciple.archive', discipleId: 'entity:1', deathId: frame.cultivation.pendingDeaths[0]!.deathId })).toMatchObject({ ok: false, code: 'ACTIVITY_LOCKED' });
    frame = finalizeExpired(frame, 'entity:1'); const snapshot = cloneJson(frame);
    expect(authority(frame, { kind: 'disciple.archive', discipleId: 'entity:1', deathId: frame.cultivation.deaths[0]!.deathId })).toMatchObject({ ok: false, code: 'ACTIVITY_LOCKED' });
    expect(frame).toEqual(snapshot);
  });

  it('rejects rehashed orphan knowledge, fabricated archive/death and changed teaching provenance', () => {
    let frame = grant(fresh()); frame = player(frame, { kind: 'teaching.begin', discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.clear-heart' }).frame;
    frame = stepCultivationMonthsV3(frame, 2).frame;
    const changes: ((value: CultivationFrame) => void)[] = [
      value => { value.cultivation.authorityReceipts = []; },
      value => { value.cultivation.events = value.cultivation.events.filter(event => event.kind !== 'cultivation.taught'); },
      value => { value.cultivation.disciples[1]!.knowledge[0]!.teacherId = 'entity:2'; },
      value => { value.cultivation.authorityReceipts[0]!.fingerprint = '{}'; },
      value => { value.cultivation.disciples.push(createCultivator('entity:50')); },
    ];
    for (const mutate of changes) {
      const candidate = cloneJson(frame); mutate(candidate);
      expect(validateCultivationFrameV3(candidate).length).toBeGreaterThan(0);
      expect(() => restoreCultivationV3(canonicalStringify({ format: 'shanmen-cultivation', version: 3, frame: candidate, checksum: stableHash(candidate) }))).toThrow();
    }
  });

  it('enforces full-roster capacity, fixed mortal profiles and authority/player ID conflict without partial mutation', () => {
    const crowded = fresh(Array.from({ length: 36 }, (_, index) => createCultivator(`entity:${index + 1}`)));
    expect(authority(crowded, { kind: 'disciple.enroll', acquisitionId: 'full', discipleId: 'entity:50', profile })).toMatchObject({ ok: false, code: 'HISTORY_LIMIT' });
    expect(authority(fresh(), { kind: 'disciple.enroll', acquisitionId: 'bad', discipleId: 'entity:50', profile: { ...profile, lifespanMonths: 1200 } })).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    const overflow = fresh(); overflow.cultivation.revision = Number.MAX_SAFE_INTEGER; const before = cloneJson(overflow);
    expect(authority(overflow, { kind: 'disciple.enroll', acquisitionId: 'overflow', discipleId: 'entity:50', profile })).toMatchObject({ ok: false, code: 'OVERFLOW' }); expect(overflow).toEqual(before);
    const granted = grant(fresh()); const commandId = granted.cultivation.authorityReceipts[0]!.command.commandId;
    expect(applyCultivationCommandV3(granted, { commandId, expectedRevision: granted.cultivation.revision, kind: 'training.set', discipleId: 'entity:1', mode: 'rest' })).toMatchObject({ ok: false, code: 'COMMAND_CONFLICT' });
  });
});
