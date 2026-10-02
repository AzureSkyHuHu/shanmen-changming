import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH as MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV9 } from '../../src/core/kernel/commands-v9';
import type { CommandV9 } from '../../src/core/kernel/contracts-v9';
import { createSaveEnvelope, parseSave, serializeSave } from '../../src/core/kernel/save';
import { createSaveEnvelopeV8, parseSaveV8, serializeSaveV8 } from '../../src/core/kernel/save-v8';
import { createSaveEnvelopeV9, parseSaveV9, serializeSaveV9, type SaveEnvelopeV9 } from '../../src/core/kernel/save-v9';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { SAVE_FILE_LIMIT_BYTES, utf8ByteLength } from '../../src/core/save-budget';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessTeachingManagementCapacityV9 as capacity } from '../../src/core/world/management-capacity-v9';
import * as owners from '../../src/core/world/runtime-instance-v9';
import type { PrivateRuntimeInstanceV9 } from '../../src/core/world/runtime-instance-v9';
import { admitSaveWorldV9, captureSaveDataV9, V9_SAVE_JSON_MAX_DEPTH } from '../../src/core/world/save-admission-v9';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { createVersionedSaveEnvelope, parseVersionedSave, serializeVersionedSave } from '../../src/platform/save-codec';
import { parseSaveFile } from '../../src/platform/files/save-files';
import { fixtureApply, fixtureCareStart, fixtureCommand, fixturePlace, fixtureProduce, fixtureResearchStart, fixtureSectCommand,
  fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture, recordChecked } from '../sect-expansion/fixtures/v9-runtime';

const metadata = { buildId: 'headless-v9-codec', savedAt: '2026-10-02T11:00:00Z' };
const instances: PrivateRuntimeInstanceV9[] = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.close(); vi.restoreAllMocks(); });
function runtime(world: WorldStateV9): PrivateRuntimeInstanceV9 {
  const created = owners.createPrivateRuntimeV9(world); expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error('Expected private runtime');
  expect(created.recoveryOnly).toBe(false); instances.push(created.instance); return created.instance;
}
function snapshot(instance: PrivateRuntimeInstanceV9): WorldStateV9 {
  const result = instance.snapshot(); expect(result.ok).toBe(true); expect(result.world).not.toBeNull(); return result.world!;
}
function roundtrip(world: WorldStateV9): WorldStateV9 {
  const envelope = createSaveEnvelopeV9(world, metadata); const text = serializeSaveV9(envelope); const result = parseSaveV9(text);
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.migration).toBeNull(); expect(result.world).toEqual(world); expect(result.envelope.payload).toBe(result.world);
  expect(result.world).not.toBe(world); expect(result.world.history).not.toBe(world.history);
  expect(serializeSaveV9(result.envelope)).toBe(text); return result.world;
}
function resumed(world: WorldStateV9, steps = 3): WorldStateV9 {
  const original = runtime(world); const loaded = runtime(roundtrip(world));
  const left = original.advance(steps); const right = loaded.advance(steps);
  expect(left.stopped).toBeNull(); expect(right.stopped).toBeNull(); expect(right.advancedTicks).toBe(left.advancedTicks);
  const next = snapshot(original); expect(snapshot(loaded)).toEqual(next); return roundtrip(next);
}
function rawEnvelope(world: WorldStateV9): SaveEnvelopeV9 {
  const body = { saveVersion: 9 as const, simulationVersion: '0.9.0' as const, contentVersion: world.contentVersion, seed: world.seed, ...metadata, payload: world };
  return { ...body, checksum: stableHash(body) };
}
function rechecksum(envelope: SaveEnvelopeV9): SaveEnvelopeV9 {
  const { checksum: _checksum, ...body } = envelope; return { ...body, checksum: stableHash(body) };
}
function refusesEveryEntrance(world: WorldStateV9, code: string): void {
  const before = canonicalStringify(world); const envelope = rawEnvelope(world);
  expect(admitSaveWorldV9(world)).toMatchObject({ ok: false, error: { code } });
  expect(() => createSaveEnvelopeV9(world, metadata)).toThrow(expect.objectContaining({ code }));
  expect(() => serializeSaveV9(envelope)).toThrow(expect.objectContaining({ code }));
  expect(parseSaveV9(canonicalStringify(envelope))).toMatchObject({ ok: false, error: { code } });
  expect(canonicalStringify(world)).toBe(before);
}
function atWireCost(source: WorldStateV9, target: number): WorldStateV9 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const before = capacity(world); expect(before.supported).toBe(true);
  const padding = target - before.costs.wireBytes!; expect(padding).toBeGreaterThanOrEqual(0);
  world.diagnostics.at(-1)!.message = 'x'.repeat(padding); return recordChecked(world);
}
function teachingOrigin(): WorldStateV9 {
  const world = fundedRuntimeFixture();
  // Authored knowledge origins, not alleged campaign acquisition. Lessons and
  // every subsequent calendar tick/provenance row below are genuine reducers.
  world.cultivation = createCultivationStateV3(world.cultivation.disciples.map((profile, index) => ({ ...profile,
    knowledge: [{ knowledgeId: index % 2 ? 'knowledge.codec-b' : 'knowledge.codec-a', teacherId: null, teachingId: null }] })));
  return recordChecked(world);
}
function lesson(world: WorldStateV9, teacher = 'entity:1', student = 'entity:2', knowledgeId = 'knowledge.codec-a', id = 'codec.lesson'): CommandV9 {
  return fixtureCommand(world, { kind: 'cultivation.command', payload: { command: { kind: 'teaching.begin', commandId: id,
    expectedRevision: world.cultivation.revision, discipleId: teacher, studentId: student, knowledgeId } } }, id);
}

describe('strict unregistered headless v9 envelope', () => {
  it('roundtrips the exact fresh .3 identity with eight fields and no migration', () => {
    const world = createUnregisteredWorldV9('codec-山门'); const envelope = createSaveEnvelopeV9(world, metadata);
    expect(Object.keys(envelope).sort()).toEqual(['buildId', 'checksum', 'contentVersion', 'payload', 'saveVersion', 'savedAt', 'seed', 'simulationVersion']);
    expect(envelope).toMatchObject({ saveVersion: 9, simulationVersion: '0.9.0', contentVersion: world.contentVersion });
    expect(envelope.payload.runtimeProtocol).toBe('fresh-management-v9-unregistered.3');
    resumed(world, 20); expect(world.clock.simulationTick).toBe(0);
  });
  it('roundtrips a real permanent loadout command and its exact retry without resetting sources', () => {
    const source = createUnregisteredWorldV9('codec-build'); const disciple = source.builds.disciples[0]!;
    const loadout = cloneJson(disciple.loadout); loadout.activeSkillIds = [loadout.activeSkillIds[1], loadout.activeSkillIds[0]];
    const command = fixtureCommand(source, { kind: 'build.command', payload: { command: { kind: 'loadout.set', commandId: 'codec.loadout',
      expectedRevision: source.builds.revision, discipleId: disciple.discipleId, loadout } } }, 'codec.loadout');
    const owner = runtime(source); expect(owner.command(command).result?.status).toBe('accepted');
    const changed = roundtrip(snapshot(owner)); expect(changed.builds.history).toHaveLength(1);
    const restored = runtime(changed); expect(restored.command(command).published).toBe(false); expect(snapshot(restored)).toEqual(changed);
    resumed(changed);
  });
  it('constructs, snapshots and closes a temporary owner independently on every codec entrance', () => {
    const actual = owners.createPrivateRuntimeV9; const closes: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(owners, 'createPrivateRuntimeV9').mockImplementation(input => {
      const created = actual(input); if (!created.ok) return created;
      const close = vi.fn(() => created.instance.close()); closes.push(close);
      return { ...created, instance: { ...created.instance, close } };
    });
    const envelope = createSaveEnvelopeV9(createUnregisteredWorldV9(), metadata);
    const text = serializeSaveV9(envelope); expect(parseSaveV9(text).ok).toBe(true);
    expect(closes).toHaveLength(3); for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });
  it('closes a successfully created owner even when its detached snapshot fails', () => {
    const actual = owners.createPrivateRuntimeV9; let close = vi.fn();
    vi.spyOn(owners, 'createPrivateRuntimeV9').mockImplementation(input => {
      const created = actual(input); if (!created.ok) return created;
      close = vi.fn(() => created.instance.close());
      return { ...created, instance: { ...created.instance, close, snapshot: () => ({ ...created.instance.snapshot(), ok: false, error: 'snapshot-failed' as const, world: null }) } };
    });
    expect(admitSaveWorldV9(createUnregisteredWorldV9())).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('classifies missing/malformed envelope fields before unsupported numeric versions', () => {
    for (const text of ['{}', '[]', 'null', '9', '"text"', '{"saveVersion":"9"}']) {
      expect(parseSaveV9(text)).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    }
    expect(parseSaveV9('{broken')).toMatchObject({ ok: false, error: { code: 'INVALID_JSON' } });
    const valid = rawEnvelope(createUnregisteredWorldV9());
    const { simulationVersion: _simulation, ...missing } = valid;
    expect(parseSaveV9(JSON.stringify(missing))).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    for (const saveVersion of ['9', null, 9.5]) {
      expect(parseSaveV9(JSON.stringify({ ...valid, saveVersion }))).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    }
    expect(parseSaveV9(JSON.stringify({ ...valid, saveVersion: 10 }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
  });
  it('rejects direct serializer bypasses, extra fields, stale checksums and identity mismatches', () => {
    const valid = createSaveEnvelopeV9(createUnregisteredWorldV9(), metadata);
    const extra = { ...valid, trusted: true };
    expect(parseSaveV9(JSON.stringify(extra))).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    expect(() => serializeSaveV9(extra)).toThrow(expect.objectContaining({ code: 'INVALID_ENVELOPE' }));
    const damaged = { ...valid, seed: 'changed' };
    expect(parseSaveV9(JSON.stringify(damaged))).toMatchObject({ ok: false, error: { code: 'CHECKSUM_MISMATCH' } });
    expect(() => serializeSaveV9(damaged)).toThrow(expect.objectContaining({ code: 'CHECKSUM_MISMATCH' }));
    expect(parseSaveV9(JSON.stringify(rechecksum(damaged)))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    const corrupt = cloneJson(valid.payload); corrupt.inventory.wood.owned = -1; refusesEveryEntrance(corrupt, 'INVALID_WORLD');
  });
  for (const protocol of ['fresh-management-v9-unregistered.1', 'fresh-management-v9-unregistered.2']) it(`never relabels ${protocol}`, () => {
    const old = Object.assign(createUnregisteredWorldV9(), { runtimeProtocol: protocol });
    refusesEveryEntrance(old as WorldStateV9, 'UNSUPPORTED_SCOPE');
  });
  it('rejects changed simulation/content identity and persisted queues/departures without deletion', () => {
    const simulation = Object.assign(createUnregisteredWorldV9(), { simulationVersion: '0.8.0' });
    refusesEveryEntrance(simulation as WorldStateV9, 'UNSUPPORTED_SIMULATION_VERSION');
    const identity = createUnregisteredWorldV9(); identity.contentIdentity.compositeFingerprint = '00000000';
    refusesEveryEntrance(identity, 'UNSUPPORTED_CONTENT_VERSION');
    const queue = createUnregisteredWorldV9(); queue.pendingCommands.push({ kind: 'production.start', commandId: 'queued', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }); refusesEveryEntrance(queue, 'INVALID_WORLD');
    const departure = createUnregisteredWorldV9(); departure.expedition.routeId = 'route.qingfeng-trial'; refusesEveryEntrance(departure, 'INVALID_WORLD');
  });
  it('distinguishes record-valid unsupported teaching from corruption', () => {
    let world = fixtureApply(teachingOrigin(), lesson(teachingOrigin()));
    world = fixtureApply(world, lesson(world, 'entity:2', 'entity:3', 'knowledge.codec-b', 'codec.chain'));
    recordChecked(world); refusesEveryEntrance(world, 'UNSUPPORTED_SCOPE');
  });
  it('rejects a valid actual-fitting recovery-only reserve deficit at all entrances', () => {
    const source = atWireCost(createUnregisteredWorldV9('codec-deficit'), SAVE_FILE_LIMIT_BYTES + 100);
    const measured = capacity(source); expect(measured.actualFits).toBe(true); expect(measured.fits).toBe(false);
    const created = owners.createPrivateRuntimeV9(source); expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('Expected recovery-only source');
    expect(created.recoveryOnly).toBe(true); created.instance.close(); refusesEveryEntrance(source, 'UNSUPPORTED_SCOPE');
  });
});

describe('recovery-only temporary ownership', () => {
  it('closes without cancelling or rewriting a record-valid reserve-deficient source', () => {
    let source = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
    source = { ...source, sectExpansion: { ...source.sectExpansion, construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    recordChecked(source); const before = canonicalStringify(source); const actual = owners.createPrivateRuntimeV9; let close = vi.fn();
    vi.spyOn(owners, 'createPrivateRuntimeV9').mockImplementation(input => {
      const created = actual(input); if (!created.ok) return created;
      expect(created.recoveryOnly).toBe(true); close = vi.fn(() => created.instance.close());
      return { ...created, instance: { ...created.instance, close } };
    });
    expect(admitSaveWorldV9(source)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCOPE' } });
    expect(close).toHaveBeenCalledTimes(1); expect(canonicalStringify(source)).toBe(before);
  });
});

describe('descriptor isolation and bounded hostile JSON', () => {
  it('isolates creator inputs, metadata, envelopes, parsed outputs and independent restored owners', () => {
    const source = createUnregisteredWorldV9('codec-alias'); const meta = { ...metadata }; const original = canonicalStringify(source);
    const envelope = createSaveEnvelopeV9(source, meta); const text = serializeSaveV9(envelope);
    source.inventory.wood.owned++; meta.buildId = 'changed';
    expect(canonicalStringify(envelope.payload)).toBe(original); expect(envelope.buildId).toBe(metadata.buildId);
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(envelope.payload.inventory)).toBe(true);
    const a = parseSaveV9(text); const b = parseSaveV9(text); if (!a.ok || !b.ok) throw new Error('Expected parsed roots');
    expect(a.world).not.toBe(b.world); expect(a.world.history).not.toBe(b.world.history);
    expect(Reflect.set(a.world.inventory.wood, 'owned', 0)).toBe(false);
    const owner = runtime(a.world); owner.advance(1); expect(b.world.clock.simulationTick).toBe(0);
    expect(captureSaveDataV9({ a: source.inventory, b: source.inventory })).toMatchObject({ ok: true });
    const aliases = captureSaveDataV9({ a: source.inventory, b: source.inventory });
    if (aliases.ok) { const value = aliases.value as { a: unknown; b: unknown }; expect(value.a).not.toBe(value.b); }
  });
  it('does not execute getters on payload, nested fields, metadata or supplied envelope', () => {
    let reads = 0; const getter = () => { reads++; throw new Error('Getter must never execute'); };
    const source = createUnregisteredWorldV9(); Object.defineProperty(source.inventory.wood, 'owned', { enumerable: true, get: getter });
    expect(() => createSaveEnvelopeV9(source, metadata)).toThrow();
    const meta = Object.defineProperty({ ...metadata }, 'buildId', { enumerable: true, get: getter });
    expect(() => createSaveEnvelopeV9(createUnregisteredWorldV9(), meta)).toThrow();
    const envelope = Object.defineProperty(rawEnvelope(createUnregisteredWorldV9()), 'payload', { enumerable: true, get: getter });
    expect(() => serializeSaveV9(envelope)).toThrow(); expect(reads).toBe(0);
  });
  it('captures before hostile later metadata reflection and never inspects thrown Proxy errors', () => {
    const source = createUnregisteredWorldV9(); const before = canonicalStringify(source);
    const meta = new Proxy({ ...metadata }, { ownKeys(target) { source.inventory.wood.owned = -1; return Reflect.ownKeys(target); } });
    const envelope = createSaveEnvelopeV9(source, meta); expect(canonicalStringify(envelope.payload)).toBe(before);
    let errorReads = 0; const hostileError = new Proxy({}, { get() { errorReads++; throw null; }, getPrototypeOf() { errorReads++; throw null; } });
    const hostile = new Proxy({}, { ownKeys() { throw hostileError; } });
    expect(admitSaveWorldV9(hostile)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } }); expect(errorReads).toBe(0);
  });
  it('rejects cycles, sparse/custom arrays, hidden/symbol properties, non-finite values and excessive depth', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 }); const symbol = { [Symbol('x')]: 1 };
    const custom = [1]; Object.defineProperty(custom, 'map', { value: () => [] });
    for (const value of [cyclic, new Array(3), custom, hidden, symbol, Infinity, NaN, undefined, new Date(), () => 1]) {
      expect(captureSaveDataV9(value).ok).toBe(false);
    }
    const nested = `${'['.repeat(V9_SAVE_JSON_MAX_DEPTH + 2)}0${']'.repeat(V9_SAVE_JSON_MAX_DEPTH + 2)}`;
    expect(parseSaveV9(nested)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it('rejects a huge all-digit custom array key before regex scanning or numeric conversion', () => {
    // Same own-key count as a dense single-entry array, but index 0 is absent.
    const sparse = new Array(1); const key = '9'.repeat(100_000);
    Object.defineProperty(sparse, key, { value: 0, enumerable: true, configurable: true });
    const test = vi.spyOn(RegExp.prototype, 'test');
    const captured = captureSaveDataV9(sparse); const regexCalls = test.mock.calls.length; test.mockRestore();
    expect(captured).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } }); expect(regexCalls).toBe(0);
  });
  it('rejects impossible key counts before requesting any property descriptors', () => {
    let descriptors = 0;
    const keys = Array.from({ length: Math.floor(SAVE_FILE_LIMIT_BYTES / 5) + 1 }, (_, index) => String(index));
    const source = new Proxy({}, { ownKeys: () => keys, getOwnPropertyDescriptor() {
      descriptors++; return { value: 0, enumerable: true, configurable: true, writable: true };
    } });
    expect(captureSaveDataV9(source)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } }); expect(descriptors).toBe(0);
  });
  it('accepts exactly 4 MiB UTF-8 text with worst escaped metadata and refuses one extra byte', () => {
    const envelope = createSaveEnvelopeV9(createUnregisteredWorldV9('codec-界'), { buildId: '\u0000'.repeat(128), savedAt: '\u0000'.repeat(64) });
    const text = serializeSaveV9(envelope); const exact = text + ' '.repeat(SAVE_FILE_LIMIT_BYTES - utf8ByteLength(text));
    expect(utf8ByteLength(exact)).toBe(SAVE_FILE_LIMIT_BYTES); expect(parseSaveV9(exact).ok).toBe(true);
    expect(parseSaveV9(exact + ' ')).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
  });
  it('enforces UTF-8 file bytes before JSON parsing and exact bounded capture accounting', () => {
    const oversized = '界'.repeat(Math.floor(SAVE_FILE_LIMIT_BYTES / 3) + 1);
    expect(oversized.length).toBeLessThan(SAVE_FILE_LIMIT_BYTES); expect(utf8ByteLength(oversized)).toBeGreaterThan(SAVE_FILE_LIMIT_BYTES);
    expect(parseSaveV9(oversized)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(captureSaveDataV9(oversized)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    expect(captureSaveDataV9('x'.repeat(SAVE_FILE_LIMIT_BYTES - 2)).ok).toBe(true);
    expect(captureSaveDataV9('x'.repeat(SAVE_FILE_LIMIT_BYTES - 1))).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    const source = createUnregisteredWorldV9(); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: oversized });
    expect(() => createSaveEnvelopeV9(source, metadata)).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
    expect(() => serializeSaveV9(rawEnvelope(source))).toThrow(expect.objectContaining({ code: 'TOO_LARGE' }));
  });
});

let work: WorldStateV9;
describe('genuine paid construction, research, medicine and care checkpoints', () => {
  it('saves planned and working construction with isolated resume equivalence', () => {
    work = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1); work = roundtrip(work);
    work = fixtureStartConstruction(work); work = resumed(work); expect(work.sectExpansion.construction.jobs[0]!.terminal).toBeNull();
    work = fixtureUntil(work, world => !!world.sectExpansion.construction.jobs[0]!.terminal); work = roundtrip(work);
  });
  for (const [index, recipe] of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'].entries()) {
    it(`roundtrips genuine research input payment and delivery ${index + 1}`, () => {
      work = fixtureProduce(work, recipe as 'extract.spirit-stone.v9' | 'study.basic-insight.v9'); work = roundtrip(work);
    });
  }
  it('roundtrips active and completed paid research', () => {
    work = fixtureResearchStart(work); work = resumed(work);
    work = fixtureUntil(work, world => !!world.sectExpansion.research.jobs[0]!.terminal); work = roundtrip(work);
    expect(work.sectExpansion.research.jobs[0]!.terminal!.kind).toBe('completed');
  });
  it('builds genuine gated alchemy and saves its completed payment/history', () => {
    work = fixtureStartConstruction(fixturePlace(work, 'alchemy.v9', 10)); work = resumed(work);
    work = fixtureUntil(work, world => !!world.sectExpansion.construction.jobs.at(-1)!.terminal); work = roundtrip(work);
  });
  it('resumes a genuine medicine job and retains its dose provenance on delivery', () => {
    work = fixtureApply(work, fixtureSectCommand(work, { domain: 'production', command: { kind: 'production.start', commandId: 'codec.medicine',
      expectedRevision: work.sectExpansion.production.revision, recipeId: 'craft.wound-powder.v9', workerId: 'entity:2' } }));
    work = resumed(work); work = fixtureUntil(work, world => !!world.sectExpansion.production.jobs.at(-1)!.terminal); work = roundtrip(work);
    expect(work.sectExpansion.stock['wound-powder'].owned).toBe(1);
  });
  it('roundtrips active care, cancellation, exact retry and completion without reusing medicine', () => {
    const before = work.cultivation.disciples.find(profile => profile.discipleId === 'entity:4')!.injury;
    work = fixtureCareStart(work, 'codec.care'); work = resumed(work);
    const cancel = fixtureSectCommand(work, { domain: 'care', command: { kind: 'care.cancel', commandId: 'codec.care.cancel',
      expectedRevision: work.sectExpansion.care.revision, jobId: work.sectExpansion.care.jobs.at(-1)!.jobId } });
    const owner = runtime(work); expect(owner.command(cancel).result?.status).toBe('accepted'); work = roundtrip(snapshot(owner));
    const restored = runtime(work); expect(restored.command(cancel).published).toBe(false); expect(snapshot(restored)).toEqual(work);
    work = fixtureCareStart(work, 'codec.care.restart'); work = fixtureUntil(work, world => !!world.sectExpansion.care.jobs.at(-1)!.terminal); work = roundtrip(work);
    expect(work.sectExpansion.stock['wound-powder'].owned).toBe(0);
    expect(work.cultivation.disciples.find(profile => profile.discipleId === 'entity:4')!.injury).toBe(Math.max(0, before - 20));
  });
});

let teaching: WorldStateV9; let teachingReference: WorldStateV9;
describe('funded real finite lesson closure across sequential save/resume checkpoints', () => {
  it('starts the actual lesson from a fully funded home root', () => {
    teaching = teachingOrigin(); const owner = runtime(teaching); expect(owner.command(lesson(teaching)).result?.status).toBe('accepted');
    teaching = roundtrip(snapshot(owner)); teachingReference = cloneJson(teaching);
    expect(capacity(teaching).fits).toBe(true);
  });
  // Every one of 2400 fixed ticks executes. Save only at 60-tick boundaries,
  // rather than serializing thousands of identical in-month shapes per tick.
  for (let checkpoint = 0; checkpoint < 40; checkpoint++) it(`restores exact funded lesson checkpoint ${checkpoint + 1}/40`, () => {
    const owner = runtime(teaching); const result = owner.advance(60);
    expect(result.stopped).toBeNull(); expect(result.advancedTicks).toBe(60);
    for (let tick = 0; tick < 60; tick++) teachingReference = prepareNormalTickCandidateV9(teachingReference);
    teaching = snapshot(owner); expect(teaching).toEqual(teachingReference); teaching = roundtrip(teaching);
  });
  it('retains one genuine taught event, provenance and terminal lesson after two months', () => {
    expect(teaching.clock.calendarTick).toBe(2 * MONTH); expect(teaching.cultivation.disciples[0]!.teaching).toBeNull();
    expect(teaching.cultivation.events.filter(event => event.kind === 'cultivation.taught')).toHaveLength(1);
    expect(teaching.cultivation.disciples[1]!.knowledge).toContainEqual(expect.objectContaining({ knowledgeId: 'knowledge.codec-a', teacherId: 'entity:1' }));
    expect(teaching.cultivationClock.transitions.map(row => row.tick)).toEqual([MONTH, 2 * MONTH]);
  });
});

describe('funded death, pause and near-cap boundaries', () => {
  it('roundtrips genuine lifespan pause and finalization once, including build retirement and legacy archive', () => {
    const source = createUnregisteredWorldV9('codec-death'); const actor = source.disciples[1]!; const profile = source.cultivation.disciples[1]!;
    // Explicit zero-history age fixture; expiry/finalization are real operations.
    actor.birthCalendarTick = 1 - profile.lifespanMonths * MONTH; actor.ageMonths = Math.floor(-actor.birthCalendarTick / MONTH); profile.ageMonths = actor.ageMonths;
    const before = roundtrip(recordChecked(source)); const owner = runtime(before); expect(owner.advance(1).advancedTicks).toBe(1);
    const pending = roundtrip(snapshot(owner)); expect(pending.clock.pauseReasons).toContain('cultivation');
    const restored = runtime(pending); expect(restored.advance(10).advancedTicks).toBe(0); expect(snapshot(restored)).toEqual(pending);
    const death = pending.cultivation.pendingDeaths[0]!; const command = fixtureCommand(pending, { kind: 'cultivation.command', payload: { command: {
      kind: 'death.finalize', commandId: 'codec.finalize', expectedRevision: pending.cultivation.revision, discipleId: death.discipleId,
      deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } }, 'codec.finalize');
    expect(restored.command(command).result?.status).toBe('accepted'); const settled = roundtrip(snapshot(restored));
    expect(settled.legacy.archivedIdentities).toHaveLength(1); expect(settled.builds.retiredDisciples).toHaveLength(1);
    const again = runtime(settled); expect(again.command(command).published).toBe(false); expect(snapshot(again)).toEqual(settled);
    resumed(settled);
  });
  it('preserves a player pause and uses full admitted replacement before resuming', () => {
    const source = createUnregisteredWorldV9(); source.clock = setPauseReason(source.clock, 'player', true);
    const paused = roundtrip(source); const owner = runtime(paused); expect(owner.advance(20).advancedTicks).toBe(0);
    const unpaused = cloneJson(paused); unpaused.clock = setPauseReason(unpaused.clock, 'player', false);
    expect(owner.replace(roundtrip(unpaused)).ok).toBe(true); expect(owner.advance(1).advancedTicks).toBe(1); roundtrip(snapshot(owner));
  });
  it('saves a funded exact-cap start, refuses new growth atomically, then saves a genuine cancellation', () => {
    const seed = createUnregisteredWorldV9('codec-cap-start');
    const start = fixtureSectCommand(seed, { domain: 'production', command: { kind: 'production.start', commandId: 'codec.cap.start', expectedRevision: 0,
      recipeId: 'gather.stone.v9', workerId: 'entity:2' } });
    const candidate = prepareUnregisteredCommandCandidateV9(seed, start); expect(candidate.result.status).toBe('accepted');
    const delta = capacity(candidate.world).costs.wireBytes! - capacity(seed).costs.wireBytes!;
    const source = atWireCost(seed, SAVE_FILE_LIMIT_BYTES - delta); const owner = runtime(roundtrip(source));
    expect(owner.command(start).result?.status).toBe('accepted'); const started = roundtrip(snapshot(owner));
    expect(capacity(started).fits).toBe(true); expect(capacity(started).costs.wireBytes).toBe(SAVE_FILE_LIMIT_BYTES);
    const growth = fixtureSectCommand(started, { domain: 'production', command: { kind: 'production.start', commandId: 'codec.cap.more',
      expectedRevision: started.sectExpansion.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:3' } });
    const refused = owner.command(growth); expect(refused.published).toBe(false); expect(refused.result?.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED');
    expect(snapshot(owner)).toEqual(started);
    const cancel = fixtureSectCommand(started, { domain: 'production', command: { kind: 'production.cancel', commandId: 'codec.cap.cancel',
      expectedRevision: started.sectExpansion.production.revision, jobId: started.sectExpansion.production.jobs[0]!.transactionId } });
    expect(owner.command(cancel).result?.status).toBe('accepted'); const cancelled = roundtrip(snapshot(owner));
    expect(cancelled.sectExpansion.production.jobs[0]!.terminal?.kind).toBe('cancelled'); expect(cancelled.inventory.wood.reserved).toBe(0);
  });
});

describe('versioned platform routing leaves legacy core codecs unchanged', () => {
  it('keeps genuine v7 and v8 bytes while recognizing v9 only through its dedicated codec', () => {
    const v7 = serializeSave(createSaveEnvelope(createWorld('codec-legacy-seven'), metadata));
    const v8 = serializeSaveV8(createSaveEnvelopeV8(createWorldV8('codec-legacy-eight'), metadata));
    expect(parseVersionedSave(v7)).toEqual(parseSave(v7)); expect(parseVersionedSave(v8)).toEqual(parseSaveV8(v8));
    const historical = readFileSync(new URL('./fixtures/save-v1-in-progress.json', import.meta.url), 'utf8');
    expect(parseVersionedSave(historical)).toEqual(parseSave(historical));
    for (const legacy of [v7, v8, historical]) expect(parseSaveV9(legacy)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    const world = createUnregisteredWorldV9(); const envelope = createSaveEnvelopeV9(world, metadata); const text = serializeSaveV9(envelope);
    for (const parse of [parseSave, parseSaveV8]) expect(parse(text)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    expect(parseVersionedSave(text)).toEqual(parseSaveV9(text));
    expect(parseSaveFile(text)).toEqual(parseSaveV9(text));
    expect(createVersionedSaveEnvelope(world, metadata)).toEqual(envelope);
    expect(serializeVersionedSave(envelope)).toBe(text);
  });
});
