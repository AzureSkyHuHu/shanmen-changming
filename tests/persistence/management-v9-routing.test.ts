import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { createSaveEnvelope, parseSave, serializeSave } from '../../src/core/kernel/save';
import { createSaveEnvelopeV8, serializeSaveV8 } from '../../src/core/kernel/save-v8';
import { createSaveEnvelopeV9, parseSaveV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { stableHash } from '../../src/core/kernel/serialization';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createPrivateRuntimeV9 } from '../../src/core/world/runtime-instance-v9';
import { createVersionedSaveEnvelope, parseSaveForRoute, parseVersionedSave, serializeVersionedSave, type SaveRoutePolicy } from '../../src/platform/save-codec';
import { openSaveRepository, type IndexedDbSaveRepository, type RepositoryOptions, type SnapshotRecord, type WriteStage } from '../../src/platform/persistence';
import { fixturePlace, fundedRuntimeFixture } from '../sect-expansion/fixtures/v9-runtime';

const meta = { buildId: 'management-routing', savedAt: '2026-10-02T12:00:00Z' };
const slotId = 'campaign-1' as const;
const repositories: IndexedDbSaveRepository[] = [];
const text9 = (seed = 'v9-routing') => serializeSaveV9(createSaveEnvelopeV9(createUnregisteredWorldV9(seed), meta));
const text7 = () => serializeSave(createSaveEnvelope(createWorld('v7-routing'), meta));
const text8 = () => serializeSaveV8(createSaveEnvelopeV8(createWorldV8('v8-routing'), meta));
function edit(text: string, change: (value: Record<string, unknown>) => void, checksum = true): string {
  const data = JSON.parse(text) as Record<string, unknown>; change(data);
  if (checksum) { const { checksum: _old, ...body } = data; data.checksum = stableHash(body); }
  return JSON.stringify(data);
}
function scopeText(): string {
  const source = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
  const world = { ...source, sectExpansion: { ...source.sectExpansion, construction: { ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
  const body = { saveVersion: 9, simulationVersion: world.simulationVersion, contentVersion: world.contentVersion, seed: world.seed, ...meta, payload: world };
  return JSON.stringify({ ...body, checksum: stableHash(body) });
}
function request<T>(operation: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); }); }
function done(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); }); }
async function harness(extra: Partial<RepositoryOptions> = {}) {
  const indexedDB = new IDBFactory(); const databaseName = 'routing-v9-tests'; let now = 1000;
  const options: RepositoryOptions = { indexedDB, databaseName, routePolicy: 'management-v9', now: () => now, ...extra };
  const open = async (routePolicy = options.routePolicy) => {
    const repository = await openSaveRepository({ ...options, ...(routePolicy ? { routePolicy } : {}) }); repositories.push(repository); return repository;
  };
  const repository = await open();
  const raw = async <T>(mode: IDBTransactionMode, action: (transaction: IDBTransaction) => Promise<T>) => {
    const db = await request(indexedDB.open(databaseName));
    try { const transaction = db.transaction(['slots', 'snapshots', 'leases'], mode); const completion = done(transaction); const result = await action(transaction); await completion; return result; }
    finally { db.close(); }
  };
  return { repository, open, options, setNow(value: number) { now = value; },
    inspect: () => raw('readonly', async transaction => {
      const [slots, snapshots, leases] = await Promise.all(['slots', 'snapshots', 'leases'].map(name => request<unknown[]>(transaction.objectStore(name).getAll())));
      return { slots, snapshots, leases };
    }),
    replace: (id: string, text: string) => raw('readwrite', async transaction => {
      const store = transaction.objectStore('snapshots'); const original = await request<SnapshotRecord>(store.get(id)); await request(store.put({ ...original, text }));
    }),
  };
}
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

describe('explicit v9 codec identity and consumer route policy', () => {
  it('correlates admitted v9 envelope/World, preserving raw bytes and exact old codecs', () => {
    const world = createUnregisteredWorldV9('routing-identity'); const envelope = createVersionedSaveEnvelope(world, meta);
    const text = serializeVersionedSave(envelope);
    const nine: 9 = envelope.saveVersion;
    const eight: 8 = createVersionedSaveEnvelope(createWorldV8(), meta).saveVersion;
    const seven: 7 = createVersionedSaveEnvelope(createWorld(), meta).saveVersion;
    expect([seven, eight, nine]).toEqual([7, 8, 9]);
    expect(envelope.saveVersion).toBe(9); expect(parseVersionedSave(text)).toEqual(parseSaveV9(text));
    expect(serializeVersionedSave(createVersionedSaveEnvelope(createWorld('v7-routing'), meta))).toBe(text7());
    for (const text of [text7(), text8()]) expect(parseSaveForRoute(text, 'legacy-v7-v8').ok).toBe(true);
    expect(parseSave(text)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    for (const route of ['legacy-v7-v8', 'v7', 'v8'] as const) expect(parseSaveForRoute(text, route)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    for (const old of [text7(), text8()]) expect(parseSaveForRoute(old, 'management-v9')).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    expect(parseSaveForRoute(text8(), 'v7').ok).toBe(false); expect(parseSaveForRoute(text7(), 'v8').ok).toBe(false);
  });
  it('does not execute routing getters before the fixed headless validator', () => {
    let reads = 0; const get = () => { reads++; throw new Error('No getter reads'); };
    const world = createUnregisteredWorldV9(); Object.defineProperty(world, 'simulationVersion', { enumerable: true, get });
    expect(() => createVersionedSaveEnvelope(world, meta)).toThrow();
    const envelope = createSaveEnvelopeV9(createUnregisteredWorldV9(), meta); Object.defineProperty(envelope, 'saveVersion', { enumerable: true, get });
    expect(() => serializeVersionedSave(envelope)).toThrow(); expect(reads).toBe(0);
  });
  it('rejects reserved v9 authority in original v1–v8 bytes before migration', () => {
    const paths = ['./fixtures/save-v1-in-progress.json', '../integration/fixtures/save-v2-in-progress.json', '../integration/fixtures/save-v3-in-progress.json',
      '../integration/fixtures/save-v4-active-battle.json', '../integration/fixtures/save-v5-mixed-history.json', '../integration/fixtures/save-v6-before-automatic-work.json'];
    const originals = [...paths.map(path => readFileSync(new URL(path, import.meta.url), 'utf8')), text7(), text8()];
    for (const original of originals) for (const key of ['runtimeProtocol', 'sectExpansion', 'cultivationClock']) {
      const source = edit(original, envelope => { (envelope.payload as Record<string, unknown>)[key] = null; });
      expect(parseVersionedSave(source)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    }
  });
  it('distinguishes corrupt, malformed, future identity and unsupported funded scope without relabeling .1/.2', () => {
    expect(parseVersionedSave('{bad')).toMatchObject({ ok: false, error: { code: 'INVALID_JSON' } });
    expect(parseVersionedSave('{"saveVersion":9}')).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    expect(parseVersionedSave(edit(text9(), data => { data.checksum = '00000000'; }, false))).toMatchObject({ ok: false, error: { code: 'CHECKSUM_MISMATCH' } });
    expect(parseVersionedSave(edit(text9(), data => { data.saveVersion = 10; }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    expect(parseVersionedSave(edit(text9(), data => { data.contentVersion = 'future'; }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_CONTENT_VERSION' } });
    for (const suffix of ['1', '2']) expect(parseVersionedSave(edit(text9(), data => { (data.payload as Record<string, unknown>).runtimeProtocol = `fresh-management-v9-unregistered.${suffix}`; })).ok).toBe(false);
    expect(parseVersionedSave(scopeText())).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCOPE' } });
  });
});

describe('v9 fenced storage and retained-generation protection', () => {
  it('roundtrips exact text, reopens, and continues genuine runtime ticks identically', async () => {
    const h = await harness(); const text = `\n ${JSON.stringify(JSON.parse(text9()), null, 2)}\n`;
    const imported = await h.repository.importSave(text, { ownerId: 'management' });
    h.repository.close(); const repository = await h.open(); const loaded = await repository.loadSlot(slotId);
    expect(loaded.snapshot.text).toBe(text); expect((await repository.exportSlot(slotId)).text).toBe(text); expect(loaded.envelope.saveVersion).toBe(9);
    const a = createPrivateRuntimeV9(loaded.world); const b = createPrivateRuntimeV9(createUnregisteredWorldV9('v9-routing'));
    if (!a.ok || !b.ok) throw new Error('Expected admitted runtimes');
    try { expect(a.instance.advance(5)).toEqual(b.instance.advance(5)); expect(a.instance.snapshot()).toEqual(b.instance.snapshot()); }
    finally { a.instance.close(); b.instance.close(); }
    await repository.saveWorld(slotId, loaded.world, meta, { expectedRevision: 1, lease: imported.lease });
    expect((await repository.loadSlot(slotId)).slot.revision).toBe(2); expect(await repository.exportRawSnapshot(slotId, imported.snapshot.id)).toBe(text);
  });
  it.each(['legacy-v7-v8', 'v7', 'v8', 'management-v9'] as const)('rejects incompatible new import before any lease or pointer changes on %s', async (route: SaveRoutePolicy) => {
    const h = await harness({ routePolicy: route }); const before = await h.inspect();
    await expect(h.repository.importSave(route === 'management-v9' ? text7() : text9(), { ownerId: 'rejected' })).rejects.toMatchObject({ code: 'INVALID_SAVE', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
    expect(await h.inspect()).toEqual(before);
  });
  it.each(['current', 'retained'] as const)('protects route-incompatible %s data on auto, manual, checkpoint and overwrite writes', async target => {
    const h = await harness(); const imported = await h.repository.importSave(text9(), { ownerId: 'management' });
    await h.repository.saveText(slotId, text9(), { expectedRevision: 1, lease: imported.lease });
    const id = target === 'current' ? 'campaign-1:2' : 'campaign-1:1'; await h.replace(id, text8()); const before = await h.inspect();
    for (const kind of ['auto', 'manual', 'checkpoint'] as const) await expect(h.repository.saveText(slotId, text9(), { expectedRevision: 2, lease: imported.lease, kind })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
    await expect(h.repository.importSave(text9(), { mode: 'overwrite', slotId, expectedRevision: 2, lease: imported.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await h.inspect()).toEqual(before); expect(await h.repository.exportRawSnapshot(slotId, id)).toBe(text8());
  });
  it.each(['current', 'retained'] as const)('protects fully parsed UNSUPPORTED_SCOPE in a %s generation even from overwrite', async target => {
    const h = await harness(); const imported = await h.repository.importSave(text9(), { ownerId: 'management' });
    await h.repository.saveText(slotId, text9(), { expectedRevision: 1, lease: imported.lease });
    const id = target === 'current' ? 'campaign-1:2' : 'campaign-1:1'; const unsupported = scopeText(); await h.replace(id, unsupported); const before = await h.inspect();
    for (const kind of ['auto', 'manual', 'checkpoint'] as const) await expect(h.repository.saveText(slotId, text9(), { expectedRevision: 2, lease: imported.lease, kind })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: 'UNSUPPORTED_SCOPE' });
    await expect(h.repository.importSave(text9(), { mode: 'overwrite', slotId, expectedRevision: 2, lease: imported.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: 'UNSUPPORTED_SCOPE' });
    expect(await h.inspect()).toEqual(before);
  });
  it('keeps old default stores from loading or overwriting recognized v9, including retained v9', async () => {
    const h = await harness(); const imported = await h.repository.importSave(text9(), { ownerId: 'v9' });
    await h.repository.saveText(slotId, text9(), { expectedRevision: 1, lease: imported.lease }); await h.replace('campaign-1:2', text7());
    const legacy = await h.open('legacy-v7-v8'); const before = await h.inspect();
    expect((await legacy.loadSlot(slotId)).envelope.saveVersion).toBe(7);
    await expect(legacy.saveText(slotId, text7(), { expectedRevision: 2, lease: imported.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    await expect(legacy.importSave(text7(), { mode: 'overwrite', slotId, expectedRevision: 2, lease: imported.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await h.inspect()).toEqual(before);
  });
  it('retains readonly recovery without repairing current pointer or source bytes', async () => {
    const h = await harness(); const imported = await h.repository.importSave(text9(), { ownerId: 'management' });
    await h.repository.saveText(slotId, text9(), { expectedRevision: 1, lease: imported.lease }); await h.replace('campaign-1:2', '{bad');
    const before = await h.inspect(); const loaded = await h.repository.loadSlot(slotId);
    expect(loaded.recovered).toBe(true); expect(loaded.snapshot.id).toBe(imported.snapshot.id); expect(loaded.slot.currentSnapshotId).toBe('campaign-1:2');
    await expect(h.repository.saveText(slotId, text9(), { expectedRevision: 2, lease: imported.lease })).rejects.toMatchObject({ code: 'CURRENT_SNAPSHOT_INVALID' });
    expect(await h.inspect()).toEqual(before);
  });
  it('fences contention, takeover, expired ownership and stale revisions', async () => {
    const h = await harness(); const imported = await h.repository.importSave(text9(), { ownerId: 'first' }); const second = await h.open();
    await expect(second.acquireLease(slotId, 'second')).rejects.toMatchObject({ code: 'LEASE_BUSY' });
    const lease = await second.acquireLease(slotId, 'second', { takeover: true });
    await expect(h.repository.saveText(slotId, text9(), { expectedRevision: 1, lease: imported.lease })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(second.saveText(slotId, text9(), { expectedRevision: 0, lease })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    h.setNow(lease.expiresAt); await expect(second.saveText(slotId, text9(), { expectedRevision: 1, lease })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await second.loadSlot(slotId)).slot.revision).toBe(1);
  });
  it.each(['before-snapshot', 'after-snapshot', 'before-pointer', 'after-pointer', 'after-prune'] satisfies WriteStage[])('rolls back all v9 records on %s fault', async stage => {
    let enabled = false; const h = await harness({ faultInjector: current => { if (enabled && current === stage) throw new Error('Injected fault'); } });
    const imported = await h.repository.importSave(text9(), { ownerId: 'management' }); const before = await h.inspect(); enabled = true;
    await expect(h.repository.saveText(slotId, text9('second'), { expectedRevision: 1, lease: imported.lease })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await h.inspect()).toEqual(before);
  });
  it('validates stored bytes before pointer update and aborts in-flight lifecycle cancellation', async () => {
    let mode: 'none' | 'corrupt' | 'abort' = 'none'; const abort = new AbortController();
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage !== 'after-snapshot') return;
      if (mode === 'corrupt') transaction.objectStore('snapshots').put({ recordVersion: 1, id: 'campaign-1:2', slotId, revision: 2, kind: 'auto', text: '{bad' });
      if (mode === 'abort') abort.abort();
    } });
    const imported = await h.repository.importSave(text9(), { ownerId: 'management' }); const before = await h.inspect();
    mode = 'corrupt'; await expect(h.repository.saveText(slotId, text9(), { expectedRevision: 1, lease: imported.lease })).rejects.toMatchObject({ code: 'INVALID_SAVE' });
    expect(await h.inspect()).toEqual(before);
    mode = 'abort'; await expect(h.repository.saveText(slotId, text9(), { expectedRevision: 1, lease: imported.lease, signal: abort.signal })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await h.inspect()).toEqual(before);
  });
});
