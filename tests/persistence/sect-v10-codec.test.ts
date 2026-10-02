import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGEMENT_V9_IDENTITY } from '../../src/content/sect-v9/world-content';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { createSaveEnvelopeV9, parseSaveV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createSaveEnvelopeV10, parseSaveV10, serializeSaveV10, type SaveEnvelopeV10 } from '../../src/core/kernel/save-v10';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES, utf8ByteLength } from '../../src/core/save-budget';
import { MAX_BUILD_ID_CODE_UNITS, MAX_SAVED_AT_CODE_UNITS } from '../../src/core/save-budget/envelope';
import { MANAGEMENT_V10_PROTOCOL, type SectProductionJobV10, type WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV10 as capacity } from '../../src/core/world/management-capacity-v10';
import * as owners from '../../src/core/world/runtime-instance-v10';
import type { PrivateRuntimeInstanceV10 } from '../../src/core/world/runtime-instance-v10';
import { admitSaveWorldV10, captureSaveDataV10, V10_SAVE_JSON_MAX_DEPTH } from '../../src/core/world/save-admission-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, fundedRuntimeFixture, medicineRuntimeFixture, recordChecked } from '../sect-expansion/fixtures/v9-runtime';

const metadata = { buildId: 'headless-v10-codec', savedAt: '2026-10-02T20:00:00Z' };
const instances: PrivateRuntimeInstanceV10[] = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.close(); vi.restoreAllMocks(); });

/** Test-only record lift of explicit v9 initial conditions/genuine old histories.
 * NOT a migration API, not a codec conversion, and never evidence that changing
 * version strings grants admission. The codec sees and checks actual v10 sources.
 * All new herbal/upgrade/L2/care progress below is made by real v10 candidates. */
function fixtureLift(source: WorldStateV9 = createUnregisteredWorldV9('codec-v10-山门')): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol,
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected genuine immutable L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No L2 in v9 fixture'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, command);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): CommandV10 {
  return { kind: 'sect.command', commandId: payload.command.commandId, issuedTick: world.clock.simulationTick, sequence: 0, payload };
}
function until(source: WorldStateV10, done: (world: WorldStateV10) => boolean, limit = 1600): WorldStateV10 {
  let world = source;
  for (let count = 0; count < limit && !done(world); count++) world = prepareNormalTickCandidateV10(world);
  if (!done(world)) throw new Error('Genuine v10 fixture did not complete'); return world;
}
function runtime(world: WorldStateV10): PrivateRuntimeInstanceV10 {
  const result = owners.createPrivateRuntimeV10(world); expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected private v10 runtime');
  expect(result.recoveryOnly).toBe(false); instances.push(result.instance); return result.instance;
}
function snapshot(instance: PrivateRuntimeInstanceV10): WorldStateV10 {
  const result = instance.snapshot(); expect(result.ok).toBe(true); expect(result.world).not.toBeNull(); return result.world!;
}
function roundtrip(world: WorldStateV10): WorldStateV10 {
  const envelope = createSaveEnvelopeV10(world, metadata); const text = serializeSaveV10(envelope); const result = parseSaveV10(text);
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.migration).toBeNull(); expect(result.world).toEqual(world); expect(result.envelope.payload).toBe(result.world);
  expect(result.world).not.toBe(world); expect(result.world.history).not.toBe(world.history);
  expect(serializeSaveV10(result.envelope)).toBe(text); return result.world;
}
function resumed(world: WorldStateV10, steps = 3): WorldStateV10 {
  const original = runtime(world); const loaded = runtime(roundtrip(world));
  const left = original.advance(steps); const right = loaded.advance(steps);
  expect(left.stopped).toBeNull(); expect(right.stopped).toBeNull(); expect(left.advancedTicks).toBe(steps); expect(right.advancedTicks).toBe(steps);
  const next = snapshot(original); expect(snapshot(loaded)).toEqual(next); return roundtrip(next);
}
function rawEnvelope(world: WorldStateV10): SaveEnvelopeV10 {
  const body = { saveVersion: 10 as const, simulationVersion: '0.10.0' as const, contentVersion: MANAGEMENT_V10_CONTENT_VERSION,
    seed: world.seed, ...metadata, payload: world };
  return { ...body, checksum: stableHash(body) };
}
function rechecksum<T extends { checksum: string }>(envelope: T): T {
  const { checksum: _checksum, ...body } = envelope; return { ...body, checksum: stableHash(body) } as T;
}
function refusesEveryEntrance(world: WorldStateV10, code: string): void {
  const before = canonicalStringify(world); const envelope = rawEnvelope(world);
  expect(admitSaveWorldV10(world)).toMatchObject({ ok: false, error: { code } });
  expect(() => createSaveEnvelopeV10(world, metadata)).toThrow(expect.objectContaining({ code }));
  expect(() => serializeSaveV10(envelope)).toThrow(expect.objectContaining({ code }));
  expect(parseSaveV10(canonicalStringify(envelope))).toMatchObject({ ok: false, error: { code } });
  expect(canonicalStringify(world)).toBe(before);
}
function lesson(world: WorldStateV10, teacher = 'entity:1', student = 'entity:2', knowledgeId = 'knowledge.codec-a', commandId = 'codec.lesson'): CommandV10 {
  return { kind: 'cultivation.command', commandId, issuedTick: world.clock.simulationTick, sequence: 0,
    payload: { command: { kind: 'teaching.begin', commandId, expectedRevision: world.cultivation.revision,
      discipleId: teacher, studentId: student, knowledgeId } } };
}
function teachingOrigin(): WorldStateV10 {
  const world = fundedRuntimeFixture();
  // Authored initial knowledge, not invented acquisition or teaching history.
  world.cultivation = createCultivationStateV3(world.cultivation.disciples.map((profile, index) => ({ ...profile,
    knowledge: [{ knowledgeId: index % 2 ? 'knowledge.codec-b' : 'knowledge.codec-a', teacherId: null, teachingId: null }] })));
  return fixtureLift(world);
}

describe('strict internal headless v10 envelope', () => {
  it('roundtrips the exact eight-field current-text protocol and preserves the old build identity', () => {
    const world = fixtureLift(); const envelope = createSaveEnvelopeV10(world, metadata);
    expect(Object.keys(envelope).sort()).toEqual(['buildId', 'checksum', 'contentVersion', 'payload', 'saveVersion', 'savedAt', 'seed', 'simulationVersion']);
    expect(envelope).toMatchObject({ saveVersion: 10, simulationVersion: '0.10.0', contentVersion: MANAGEMENT_V10_CONTENT_VERSION });
    expect(envelope.payload.contentIdentity).toEqual(MANAGEMENT_V10_IDENTITY);
    expect(envelope.payload.runtimeProtocol).toBe(MANAGEMENT_V10_PROTOCOL.runtimeProtocol);
    expect(envelope.payload.builds.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
    resumed(world); expect(world.clock.simulationTick).toBe(0);
  });
  it('constructs and finally closes a temporary owner on all three codec entrances', () => {
    const actual = owners.createPrivateRuntimeV10; const closes: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(owners, 'createPrivateRuntimeV10').mockImplementation(input => {
      const created = actual(input); if (!created.ok) return created;
      const close = vi.fn(() => created.instance.close()); closes.push(close);
      return { ...created, instance: { ...created.instance, close } };
    });
    const envelope = createSaveEnvelopeV10(fixtureLift(), metadata); const text = serializeSaveV10(envelope);
    expect(parseSaveV10(text).ok).toBe(true); expect(closes).toHaveLength(3);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });
  it('finally closes a successful owner even when snapshot export fails', () => {
    const actual = owners.createPrivateRuntimeV10; let close = vi.fn();
    vi.spyOn(owners, 'createPrivateRuntimeV10').mockImplementation(input => {
      const created = actual(input); if (!created.ok) return created;
      close = vi.fn(() => created.instance.close());
      return { ...created, instance: { ...created.instance, close,
        snapshot: () => ({ ...created.instance.snapshot(), ok: false, error: 'snapshot-failed' as const, world: null }) } };
    });
    expect(admitSaveWorldV10(fixtureLift())).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed JSON/envelopes before version dispatch and unknown versions without fallback', () => {
    expect(parseSaveV10('{broken')).toMatchObject({ ok: false, error: { code: 'INVALID_JSON' } });
    expect(parseSaveV10(null as unknown as string)).toMatchObject({ ok: false, error: { code: 'INVALID_JSON' } });
    for (const text of ['{}', '[]', 'null', '10', '"text"', '{"saveVersion":11}']) {
      expect(parseSaveV10(text)).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    }
    const valid = rawEnvelope(fixtureLift()); const { seed: _seed, ...missing } = valid;
    for (const invalid of [missing, { ...valid, saveVersion: '10' }, { ...valid, saveVersion: 10.5 }, { ...valid, payload: [] },
      { ...valid, checksum: 'FFFFFFFF' }, { ...valid, trusted: true }]) {
      expect(parseSaveV10(JSON.stringify(invalid))).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    }
    for (const saveVersion of [7, 8, 9, 11, 999]) {
      expect(parseSaveV10(JSON.stringify({ ...valid, saveVersion }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    }
  });
  it('requires checksum, exact identities and full records even from a caller-built envelope', () => {
    const envelope = rawEnvelope(fixtureLift()); const damaged = { ...envelope, seed: 'changed' };
    expect(parseSaveV10(JSON.stringify(damaged))).toMatchObject({ ok: false, error: { code: 'CHECKSUM_MISMATCH' } });
    expect(() => serializeSaveV10(damaged)).toThrow(expect.objectContaining({ code: 'CHECKSUM_MISMATCH' }));
    expect(parseSaveV10(JSON.stringify(rechecksum(damaged)))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    expect(parseSaveV10(JSON.stringify({ ...envelope, simulationVersion: '0.9.0' }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SIMULATION_VERSION' } });
    expect(parseSaveV10(JSON.stringify(rechecksum({ ...envelope, contentVersion: 'wrong' })))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_CONTENT_VERSION' } });
    const corrupt = fixtureLift(); corrupt.inventory.wood.owned = -1; refusesEveryEntrance(corrupt, 'INVALID_WORLD');
    const identity = fixtureLift(); identity.contentIdentity.compositeFingerprint = '00000000'; refusesEveryEntrance(identity, 'UNSUPPORTED_CONTENT_VERSION');
    refusesEveryEntrance(Object.assign(fixtureLift(), { simulationVersion: '0.9.0' }) as WorldStateV10, 'UNSUPPORTED_SIMULATION_VERSION');
    refusesEveryEntrance(Object.assign(fixtureLift(), { runtimeProtocol: 'fresh-management-v9-unregistered.3' }) as WorldStateV10, 'UNSUPPORTED_SCOPE');
    const queue = fixtureLift(); queue.pendingCommands.push({ kind: 'production.start', commandId: 'queued', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }); refusesEveryEntrance(queue, 'INVALID_WORLD');
  });
  it('does not relabel v9 payloads or alter the old parser accepted set', () => {
    const old = createUnregisteredWorldV9('old-v9-preserved'); const oldText = serializeSaveV9(createSaveEnvelopeV9(old, metadata));
    expect(parseSaveV9(oldText)).toMatchObject({ ok: true, world: old });
    expect(parseSaveV10(oldText)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    expect(() => createSaveEnvelopeV10(old, metadata)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SIMULATION_VERSION' }));
    const disguised = { ...rawEnvelope(fixtureLift()), payload: old };
    expect(parseSaveV10(JSON.stringify(rechecksum(disguised)))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SIMULATION_VERSION' } });
    expect(parseSaveV9(serializeSaveV10(createSaveEnvelopeV10(fixtureLift(), metadata)))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
  });
  it('preserves a real permanent-build command and exact retry without rewriting history identity', () => {
    const source = fixtureLift(); const disciple = source.builds.disciples[0]!; const loadout = cloneJson(disciple.loadout);
    loadout.activeSkillIds = [loadout.activeSkillIds[1], loadout.activeSkillIds[0]];
    const command: CommandV10 = { kind: 'build.command', commandId: 'codec.loadout', issuedTick: 0, sequence: 0,
      payload: { command: { kind: 'loadout.set', commandId: 'codec.loadout', expectedRevision: source.builds.revision, discipleId: disciple.discipleId, loadout } } };
    const changed = roundtrip(apply(source, command)); expect(changed.builds.history).toHaveLength(1);
    expect(changed.builds.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
    const owner = runtime(changed); expect(owner.command(command).published).toBe(false); expect(snapshot(owner)).toEqual(changed);
  });
  it('accepts supported disjoint finite teaching but rejects a record-valid unsupported teaching chain', () => {
    const origin = teachingOrigin(); const single = apply(origin, lesson(origin)); resumed(single, 1);
    const chain = apply(single, lesson(single, 'entity:2', 'entity:3', 'knowledge.codec-b', 'codec.chain'));
    expect(inspectUnregisteredWorldV10Records(chain)).toEqual([]); refusesEveryEntrance(chain, 'UNSUPPORTED_SCOPE');
  });
  it('refuses and closes actual-fitting recovery-only boundaries without changing the source', () => {
    const source = fixtureLift(); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    const initial = capacity(source); expect(initial.supported).toBe(true);
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES + 100 - initial.costs.wireBytes!);
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    const measured = capacity(source); expect(measured.actualFits).toBe(true); expect(measured.fits).toBe(false);
    const created = owners.createPrivateRuntimeV10(source); expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('Expected actual-fitting recovery-only source');
    expect(created.recoveryOnly).toBe(true); created.instance.close();
    const actual = owners.createPrivateRuntimeV10; const closes: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(owners, 'createPrivateRuntimeV10').mockImplementation(input => {
      const result = actual(input); if (!result.ok) return result;
      const close = vi.fn(() => result.instance.close()); closes.push(close); return { ...result, instance: { ...result.instance, close } };
    });
    refusesEveryEntrance(source, 'UNSUPPORTED_SCOPE'); expect(closes).toHaveLength(4);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  }, 30000);
});

describe('v10 descriptor, metadata, byte and reader boundaries', () => {
  it('isolates all inputs/outputs, freezes only owned snapshots, and rejects external aliases', () => {
    const source = fixtureLift(); const before = canonicalStringify(source); const meta = { ...metadata };
    const envelope = createSaveEnvelopeV10(source, meta); const text = serializeSaveV10(envelope);
    source.inventory.wood.owned++; meta.buildId = 'changed';
    expect(canonicalStringify(envelope.payload)).toBe(before); expect(envelope.buildId).toBe(metadata.buildId);
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(envelope.payload.inventory)).toBe(true);
    const left = parseSaveV10(text); const right = parseSaveV10(text); if (!left.ok || !right.ok) throw new Error('Expected parsed roots');
    expect(left.world).not.toBe(right.world); expect(left.world.history).not.toBe(right.world.history);
    expect(Reflect.set(left.world.inventory.wood, 'owned', 0)).toBe(false);
    expect(captureSaveDataV10({ first: source.inventory, second: source.inventory })).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it('never executes payload, metadata or envelope getters, including toJSON', () => {
    let reads = 0; const getter = () => { reads++; throw new Error('Do not invoke'); };
    const source = fixtureLift(); Object.defineProperty(source.inventory.wood, 'owned', { enumerable: true, get: getter });
    expect(() => createSaveEnvelopeV10(source, metadata)).toThrow();
    expect(() => createSaveEnvelopeV10(fixtureLift(), Object.defineProperty({ ...metadata }, 'buildId', { enumerable: true, get: getter }))).toThrow();
    const envelope = Object.defineProperty(rawEnvelope(fixtureLift()), 'payload', { enumerable: true, get: getter });
    expect(() => serializeSaveV10(envelope)).toThrow();
    expect(captureSaveDataV10(Object.defineProperty({}, 'toJSON', { enumerable: true, get: getter })).ok).toBe(false); expect(reads).toBe(0);
  });
  it('captures World before later metadata traps and never inspects caller-thrown objects', () => {
    const source = fixtureLift(); const before = canonicalStringify(source);
    const metadataTrap = new Proxy({ ...metadata }, { ownKeys(target) { source.inventory.wood.owned = -1; return Reflect.ownKeys(target); } });
    expect(canonicalStringify(createSaveEnvelopeV10(source, metadataTrap).payload)).toBe(before);
    let reads = 0; const hostileError = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; } });
    for (const traps of [{ ownKeys() { throw hostileError; } }, { getPrototypeOf() { throw hostileError; } },
      { getOwnPropertyDescriptor() { throw hostileError; } }]) {
      expect(admitSaveWorldV10(new Proxy({ seed: 'x' }, traps))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    }
    expect(reads).toBe(0);
  });
  it('captures sibling descriptors before nested reflection can replace them with getters', () => {
    let reads = 0; const source: Record<string, unknown> = { nested: null, later: 7 };
    source.nested = new Proxy({}, { ownKeys() { Object.defineProperty(source, 'later', { enumerable: true, get() { reads++; return 99; } }); return []; } });
    expect(captureSaveDataV10(source)).toEqual({ ok: true, value: { nested: {}, later: 7 } }); expect(reads).toBe(0);
  });
  it('rejects cycles, aliases, sparse/custom arrays, hidden/symbol/unsafe keys and non-JSON values', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; const shared = {};
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 }); const custom = [1]; Object.defineProperty(custom, 'map', { value: () => [] });
    for (const value of [cyclic, { a: shared, b: shared }, new Array(3), custom, hidden, { [Symbol('x')]: 1 },
      JSON.parse('{"__proto__":{}}'), { constructor: 1 }, { prototype: 1 }, Object.create(null), Infinity, NaN, undefined, new Date(), () => 1]) {
      expect(captureSaveDataV10(value).ok).toBe(false);
    }
    expect(parseSaveV10(`${'['.repeat(V10_SAVE_JSON_MAX_DEPTH + 2)}0${']'.repeat(V10_SAVE_JSON_MAX_DEPTH + 2)}`))
      .toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it('bounds huge array indices and impossible key counts before costly descriptor traversal', () => {
    const sparse = new Array(1); Object.defineProperty(sparse, '9'.repeat(100_000), { value: 0, enumerable: true });
    const regex = vi.spyOn(RegExp.prototype, 'test'); const result = captureSaveDataV10(sparse); const calls = regex.mock.calls.length; regex.mockRestore();
    expect(result.ok).toBe(false); expect(calls).toBe(0);
    let descriptors = 0; const keys = Array.from({ length: Math.floor(SAVE_FILE_LIMIT_BYTES / 5) + 1 }, (_, index) => String(index));
    const source = new Proxy({}, { ownKeys: () => keys, getOwnPropertyDescriptor() { descriptors++; return { value: 0, enumerable: true, configurable: true }; } });
    expect(captureSaveDataV10(source)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } }); expect(descriptors).toBe(0);
  });
  it('accepts all legal metadata endpoints and rejects empty, excessive or extra metadata', () => {
    const source = fixtureLift();
    for (const meta of [{ buildId: 'b', savedAt: 's' }, { buildId: '\u0000'.repeat(MAX_BUILD_ID_CODE_UNITS), savedAt: '\u0000'.repeat(MAX_SAVED_AT_CODE_UNITS) }]) {
      const envelope = createSaveEnvelopeV10(source, meta); expect(parseSaveV10(serializeSaveV10(envelope))).toMatchObject({ ok: true, envelope: meta });
    }
    for (const meta of [{ ...metadata, buildId: '' }, { ...metadata, savedAt: '' }, { ...metadata, buildId: 'b'.repeat(MAX_BUILD_ID_CODE_UNITS + 1) },
      { ...metadata, savedAt: 's'.repeat(MAX_SAVED_AT_CODE_UNITS + 1) }, { ...metadata, trusted: true }]) {
      expect(() => createSaveEnvelopeV10(source, meta)).toThrow(expect.objectContaining({ code: 'INVALID_ENVELOPE' }));
    }
  });
  it('accepts exact 4 MiB UTF-8 JSON text including whitespace and rejects one byte more', () => {
    const text = serializeSaveV10(createSaveEnvelopeV10(fixtureLift(), { buildId: '\u0000'.repeat(128), savedAt: '\u0000'.repeat(64) }));
    const exact = text + ' '.repeat(SAVE_FILE_LIMIT_BYTES - utf8ByteLength(text));
    expect(utf8ByteLength(exact)).toBe(SAVE_FILE_LIMIT_BYTES); expect(parseSaveV10(exact).ok).toBe(true);
    expect(parseSaveV10(exact + ' ')).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    const oversized = '界'.repeat(Math.floor(SAVE_FILE_LIMIT_BYTES / 3) + 1);
    expect(oversized.length).toBeLessThan(SAVE_FILE_LIMIT_BYTES); expect(parseSaveV10(oversized)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(captureSaveDataV10(oversized)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(captureSaveDataV10('x'.repeat(SAVE_FILE_LIMIT_BYTES - 2)).ok).toBe(true);
    expect(captureSaveDataV10('x'.repeat(SAVE_FILE_LIMIT_BYTES - 1))).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    const source = fixtureLift(); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: oversized });
    expect(() => createSaveEnvelopeV10(source, metadata)).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    expect(() => serializeSaveV10(rawEnvelope(source))).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
  });
  it('never grants admission for below-wire-limit independent domain-reader overflow', () => {
    // Deliberately malformed pressure input; not a claimed real gameplay history.
    const source = fixtureLift(); const builds = source.builds as unknown as Record<string, unknown>;
    builds.pressure = Array.from({ length: 31 }, () => Array(10_000).fill(0)); builds.wide = Array(16_385).fill(0);
    const measured = capacity(source); expect(measured.actualFits).toBe(true); expect(measured.supported).toBe(false);
    expect(measured.deficits.some(deficit => deficit.dimension === 'buildReaderNodes')).toBe(true);
    expect(measured.deficits.some(deficit => deficit.dimension === 'buildArray.builds.wide')).toBe(true);
    refusesEveryEntrance(source, 'INVALID_WORLD');
  }, 30000);
});

describe('real v10 research, upgrade and two-recipe care save continuations', () => {
  let old: WorldStateV9; let researchStart: WorldStateV10; let ready: WorldStateV10;
  let started: WorldStateV10; let half: WorldStateV10; let almost: WorldStateV10; let complete: WorldStateV10;
  let powder: WorldStateV10; let delivered: WorldStateV10; let care: WorldStateV10; let healed: WorldStateV10;
  beforeAll(() => { old = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let count = 0; count < 4; count++) beforeAll(() => { old = fixtureProduce(old, recipe); }, 60000);
  }
  beforeAll(() => {
    const source = fixtureLift(old);
    researchStart = apply(source, sect(source, { domain: 'research', command: { kind: 'research.start', commandId: 'codec.herbal',
      expectedRevision: source.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
    ready = until(researchStart, world => world.sectExpansion.research.jobs.at(-1)!.terminal !== null);
    started = apply(ready, sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'codec.upgrade',
      expectedRevision: ready.sectExpansion.upgrade.revision, workerId: 'entity:2',
      buildingId: ready.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } }));
    half = until(started, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 200);
    almost = until(half, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 399);
    complete = prepareNormalTickCandidateV10(almost);
  }, 180000);
  beforeAll(() => {
    let source = apply(complete, sect(complete, { domain: 'care', command: { kind: 'care.start', commandId: 'codec.old-dose',
      expectedRevision: complete.sectExpansion.care.revision, patientId: 'entity:4' } }));
    source = until(source, world => world.sectExpansion.care.jobs.at(-1)!.terminal !== null);
    source = apply(source, { kind: 'inventory.discard', commandId: 'codec.no-grain', issuedTick: source.clock.simulationTick, sequence: 0,
      payload: { resourceId: 'grain', quantity: source.inventory.grain.owned - source.inventory.grain.reserved } });
    powder = apply(source, sect(source, { domain: 'production', command: { kind: 'production.start', commandId: 'codec.alternative',
      expectedRevision: source.sectExpansion.production.revision, recipeId: 'craft.wound-powder-alt.v9', workerId: 'entity:2' } }));
    delivered = until(powder, world => world.sectExpansion.production.jobs.at(-1)!.terminal !== null);
    care = apply(delivered, sect(delivered, { domain: 'care', command: { kind: 'care.start', commandId: 'codec.care',
      expectedRevision: delivered.sectExpansion.care.revision, patientId: 'entity:4' } }));
    healed = until(care, world => world.sectExpansion.care.jobs.at(-1)!.terminal !== null);
  }, 120000);

  it('resumes genuine herbal research without synthesizing paid work', () => { resumed(researchStart); roundtrip(ready); }, 30000);
  it('preserves start, half-payment and exact retry, then resumes through genuine L2 completion', () => {
    resumed(started); const savedHalf = resumed(half);
    expect(savedHalf.sectExpansion.upgrade.jobs[0]!.checkpoints).toHaveLength(1);
    const owner = runtime(savedHalf); const command = sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'codec.upgrade',
      expectedRevision: ready.sectExpansion.upgrade.revision, workerId: 'entity:2',
      buildingId: ready.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } });
    expect(owner.command(command).published).toBe(false); expect(snapshot(owner)).toEqual(savedHalf);
    const finished = resumed(almost, 1); expect(finished).toEqual(complete);
    expect(finished.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 400, terminal: { kind: 'completed', resultLevel: 2 } });
    expect(finished.sectExpansion.upgrade.jobs[0]!.checkpoints).toHaveLength(2);
    expect(finished.sectExpansion.construction.buildings).toEqual(ready.sectExpansion.construction.buildings);
  }, 30000);
  it('roundtrips an actual half-paid cancellation and never refunds consumed materials', () => {
    const loaded = roundtrip(half); const cancelled = apply(loaded, sect(loaded, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'codec.cancel',
      expectedRevision: loaded.sectExpansion.upgrade.revision, jobId: loaded.sectExpansion.upgrade.jobs[0]!.jobId } }));
    const restored = resumed(cancelled, 1);
    expect(restored.sectExpansion.upgrade.jobs[0]!.terminal?.released.map(line => line.quantity)).toEqual([3, 3]);
    expect(restored.inventory.stone.reserved).toBe(0); expect(restored.inventory.plank.reserved).toBe(0);
  });
  it('resumes true zero-grain L2 production, delivered dose source and resulting care effect', () => {
    resumed(powder); roundtrip(delivered); resumed(care); roundtrip(healed);
    expect(delivered.inventory.grain.owned).toBe(0);
    expect(delivered.sectExpansion.production.jobs.at(-1)).toMatchObject({ recipeId: 'craft.wound-powder-alt.v9', activeTicks: 200,
      productiveSite: { level: 2, upgradeJobId: complete.sectExpansion.upgrade.jobs[0]!.jobId }, terminal: { kind: 'completed' } });
    expect(care.sectExpansion.care.jobs.at(-1)!.doseProductionJobId).toBe(delivered.sectExpansion.production.jobs.at(-1)!.transactionId);
    expect(healed.cultivation.disciples.find(profile => profile.discipleId === 'entity:4')!.injury).toBe(0);
    expect(healed.sectExpansion.care.jobs.at(-1)!.terminal?.kind).toBe('completed');
  }, 30000);
  it('rejects correctly checksummed forged upgrade completion, dose provenance and ownership', () => {
    const unpaid = cloneJson(complete); unpaid.sectExpansion = { ...unpaid.sectExpansion, upgrade: { ...unpaid.sectExpansion.upgrade,
      jobs: unpaid.sectExpansion.upgrade.jobs.map((job, index) => index === 0 ? { ...job, checkpoints: job.checkpoints.slice(0, -1) } : job) } };
    refusesEveryEntrance(unpaid, 'INVALID_WORLD');
    const falseDose = cloneJson(care); falseDose.sectExpansion = { ...falseDose.sectExpansion, care: { ...falseDose.sectExpansion.care,
      jobs: falseDose.sectExpansion.care.jobs.map((job, index, jobs) => index === jobs.length - 1 ? { ...job, doseProductionJobId: 'invented-dose' } : job) } };
    refusesEveryEntrance(falseDose, 'INVALID_WORLD');
    const orphan = cloneJson(half); orphan.sectExpansion = { ...orphan.sectExpansion, reservations: orphan.sectExpansion.reservations.slice(0, -1) };
    refusesEveryEntrance(orphan, 'INVALID_WORLD');
  });
});
