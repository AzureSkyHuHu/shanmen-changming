import { IDBFactory as FakeIDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSaveEnvelopeV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createSaveEnvelopeV10, parseSaveV10, serializeSaveV10 } from '../../src/core/kernel/save-v10';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { prepareV9ToV10Migration } from '../../src/core/world/migrate-v9-to-v10';
import { openManagementV10Repository, type IndexedDbManagementV10Repository } from '../../src/platform/persistence/indexeddb-management-v10-repository';
import { MANAGEMENT_V10_DATABASE_NAME, MANAGEMENT_V10_DATABASE_VERSION, MANAGEMENT_V10_STORES,
  type ManagementV10RepositoryOptions, type ManagementV10WriteStage, type SnapshotRecord } from '../../src/platform/persistence/management-v10-types';
import { CAMPAIGN_SLOT_IDS } from '../../src/platform/persistence/types';

const slotId = 'campaign-1' as const;
const metadata = { buildId: 'v10-storage-tests', savedAt: '2026-10-02T21:00:00Z' };
const repositories: IndexedDbManagementV10Repository[] = [];
let text: string; let otherText: string; let oldText: string;
beforeAll(() => {
  text = serializeSaveV10(createSaveEnvelopeV10(createUnregisteredWorldV10('storage-山门-🌱'), metadata));
  otherText = serializeSaveV10(createSaveEnvelopeV10(createUnregisteredWorldV10('different-storage-world'), metadata));
  oldText = serializeSaveV9(createSaveEnvelopeV9(createUnregisteredWorldV9('storage-山门-🌱'), metadata));
});
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); vi.restoreAllMocks(); });
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
}
async function harness(extra: ManagementV10RepositoryOptions = {}) {
  const indexedDB = extra.indexedDB ?? new FakeIDBFactory(); let now = 1000;
  const options: ManagementV10RepositoryOptions = { indexedDB, now: () => now, ...extra };
  const open = async () => { const repository = await openManagementV10Repository(options); repositories.push(repository); return repository; };
  const repository = await open();
  const raw = async <T>(mode: IDBTransactionMode, body: (transaction: IDBTransaction) => Promise<T>) => {
    const database = await request(indexedDB.open(MANAGEMENT_V10_DATABASE_NAME));
    try { const transaction = database.transaction([...MANAGEMENT_V10_STORES], mode); const completed = done(transaction); const result = await body(transaction); await completed; return result; }
    finally { database.close(); }
  };
  return { indexedDB, repository, open, setNow: (value: number) => { now = value; },
    inspect: () => raw('readonly', async transaction => Object.fromEntries(await Promise.all(MANAGEMENT_V10_STORES.map(async name => [name, await request<unknown[]>(transaction.objectStore(name).getAll())])))),
    put: (name: string, value: unknown) => raw('readwrite', transaction => request(transaction.objectStore(name).put(value))),
    replace: (id: string, replacement: string) => raw('readwrite', async transaction => {
      const store = transaction.objectStore('snapshots'); const old = await request<SnapshotRecord>(store.get(id)); await request(store.put({ ...old, text: replacement }));
    }),
  };
}

describe('private fixed v10-only repository', () => {
  it('creates exactly the fixed schema1 four-store layout and rejects policy overrides', async () => {
    const h = await harness();
    const db = await request(h.indexedDB.open(MANAGEMENT_V10_DATABASE_NAME));
    try {
      expect(db.version).toBe(MANAGEMENT_V10_DATABASE_VERSION);
      expect([...db.objectStoreNames].sort()).toEqual([...MANAGEMENT_V10_STORES].sort());
      const transaction = db.transaction([...MANAGEMENT_V10_STORES], 'readonly');
      expect(MANAGEMENT_V10_STORES.map(name => transaction.objectStore(name).keyPath)).toEqual(['slotId', 'id', 'slotId', 'id']);
    } finally { db.close(); }
    for (const overrides of [{ databaseName: 'old-database' }, { routePolicy: 'management-v9' }, { validator: () => true }]) {
      await expect(openManagementV10Repository({ indexedDB: h.indexedDB, ...overrides } as ManagementV10RepositoryOptions)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(await h.repository.listSlots()).toEqual(CAMPAIGN_SLOT_IDS.map(slotId => ({ slotId, slot: null })));
  });
  it('roundtrips exact noncanonical text after reopening without changing returned World ownership', async () => {
    const h = await harness(); const raw = `\r\n ${JSON.stringify(JSON.parse(text), null, 2)}\t\n`;
    const imported = await h.repository.importSave(raw, { ownerId: 'first' });
    h.repository.close(); const reopened = await h.open();
    const loaded = await reopened.loadSlot(slotId);
    expect(loaded.envelope.saveVersion).toBe(10); expect(loaded.migration).toBeNull(); expect(loaded.recovered).toBe(false);
    expect(loaded.snapshot.text).toBe(raw); expect(await reopened.exportRawSnapshot(slotId, imported.snapshot.id)).toBe(raw);
    const world = loaded.world; expect(Object.isFrozen(world)).toBe(true); expect(Reflect.set(world, 'seed', 'caller-mutation')).toBe(false);
    expect((await reopened.loadSlot(slotId)).world.seed).toBe('storage-山门-🌱');
    const parsed = parseSaveV10(text); if (!parsed.ok) throw new Error('Expected v10 fixture');
    await reopened.saveWorld(slotId, parsed.world, metadata, { lease: imported.lease, expectedRevision: 1 });
    expect((await reopened.loadSlot(slotId)).slot.revision).toBe(2);
  });
  it('rejects old v9, malformed and unsupported future v10 before lease or pointer writes', async () => {
    const h = await harness(); const before = await h.inspect();
    const future = JSON.parse(text) as Record<string, unknown>; future.saveVersion = 11;
    for (const rejected of [oldText, '{bad', JSON.stringify(future)]) {
      await expect(h.repository.importSave(rejected, { ownerId: 'bad-import' })).rejects.toMatchObject({ code: 'INVALID_SAVE' });
      expect(await h.inspect()).toEqual(before);
    }
    await expect(h.repository.saveWorld(slotId, createUnregisteredWorldV9('wrong-world') as never, metadata,
      { lease: { slotId, ownerId: 'none', epoch: 1, expiresAt: 2000 }, expectedRevision: 0 })).rejects.toMatchObject({ code: 'INVALID_SAVE' });
    expect(await h.inspect()).toEqual(before);
  });
  it('rotates three autos, manual and checkpoint while every ordinary/import path retains migration backup', async () => {
    const h = await harness();
    const prepared = prepareV9ToV10Migration(oldText, metadata); if (!prepared.ok) throw new Error('Expected migration fixture');
    const receipt = await h.repository.commitV9Copy({ sourceText: oldText, targetText: serializeSaveV10(prepared.envelope), targetSlotId: slotId, ownerId: 'writer' });
    const backups = (await h.inspect()).migrationSources;
    for (let revision = 1; revision <= 4; revision++) await h.repository.saveText(slotId, text, { expectedRevision: revision, lease: receipt.lease });
    await h.repository.saveText(slotId, text, { expectedRevision: 5, lease: receipt.lease, kind: 'checkpoint' });
    const manual = await h.repository.saveText(slotId, text, { expectedRevision: 6, lease: receipt.lease, kind: 'manual' });
    expect(manual.slot.autoSnapshotIds).toEqual(['campaign-1:5', 'campaign-1:4', 'campaign-1:3']);
    expect(manual.slot.manualSnapshotId).toBe('campaign-1:7'); expect(manual.slot.checkpointSnapshotId).toBe('campaign-1:6');
    expect((await h.inspect()).migrationSources).toEqual(backups);
    await h.repository.importSave(otherText, { mode: 'overwrite', slotId, expectedRevision: 7, lease: receipt.lease });
    expect((await h.inspect()).snapshots).toEqual([{ recordVersion: 1, id: 'campaign-1:8', slotId, revision: 8, kind: 'manual', text: otherText }]);
    expect((await h.inspect()).migrationSources).toEqual(backups);
    expect(await h.repository.exportMigrationSource(slotId)).toBe(oldText);
    await h.repository.importSave(text, { ownerId: 'other-slot' });
    expect((await h.inspect()).migrationSources).toEqual(backups);
  }, 20000); // Multiple fully admitted save/import transactions; CI measured 5029ms.
  it('requires an empty target for default import and fences overwrite by revision', async () => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'first' });
    await expect(h.repository.importSave(text, { ownerId: 'other', slotId })).rejects.toMatchObject({ code: 'SLOT_OCCUPIED' });
    await expect(h.repository.importSave(text, { mode: 'overwrite', slotId, expectedRevision: 0, lease: first.lease })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const second = await h.repository.importSave(text, { ownerId: 'second' }); expect(second.slot.slotId).toBe('campaign-2');
    await h.repository.importSave(text, { ownerId: 'third' });
    await expect(h.repository.importSave(text, { ownerId: 'fourth' })).rejects.toMatchObject({ code: 'NO_EMPTY_SLOT' });
  });
  it('prevents live-owner takeover and invalidates expired and released epoch tokens', async () => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'first' }); const other = await h.open();
    await expect(other.acquireLease(slotId, 'other')).rejects.toMatchObject({ code: 'LEASE_BUSY' });
    await expect(other.acquireLease(slotId, 'other', { takeover: true } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const renewed = await h.repository.renewLease(first.lease, 2000); expect(renewed.epoch).toBe(first.lease.epoch);
    h.setNow(renewed.expiresAt);
    await expect(h.repository.saveText(slotId, text, { expectedRevision: 1, lease: renewed })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const fresh = await other.acquireLease(slotId, 'other'); expect(fresh.epoch).toBe(renewed.epoch + 1);
    await expect(h.repository.saveText(slotId, text, { expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await other.releaseLease(fresh); const next = await other.acquireLease(slotId, 'other'); expect(next.epoch).toBe(fresh.epoch + 1);
    await expect(other.renewLease(fresh)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it.each(['before-snapshot', 'after-snapshot', 'after-snapshot-readback', 'before-pointer', 'after-pointer', 'after-prune'] satisfies ManagementV10WriteStage[])(
    'rolls back ordinary save records and retention at %s', async stage => {
      let enabled = false; const h = await harness({ faultInjector: point => { if (enabled && point === stage) throw new Error('Injected write fault'); } });
      const first = await h.repository.importSave(text, { ownerId: 'writer' }); const before = await h.inspect(); enabled = true;
      await expect(h.repository.saveText(slotId, otherText, { expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
      expect(await h.inspect()).toEqual(before);
    });
  it('preserves existing data on quota failure and pre-aborted calls', async () => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'writer' }); const before = await h.inspect();
    vi.spyOn(FakeIDBObjectStore.prototype, 'add').mockImplementationOnce(() => { throw new DOMException('Synthetic quota', 'QuotaExceededError'); });
    await expect(h.repository.saveText(slotId, otherText, { expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(await h.inspect()).toEqual(before); const abort = new AbortController(); abort.abort();
    await expect(h.repository.saveText(slotId, otherText, { expectedRevision: 1, lease: first.lease, signal: abort.signal })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await h.inspect()).toEqual(before);
  });
  it.each(['after-snapshot', 'before-pointer'] satisfies ManagementV10WriteStage[])('rechecks exact text at %s before publication', async stage => {
    let enabled = false; const h = await harness({ faultInjector: (point, transaction) => {
      if (enabled && point === stage) transaction.objectStore('snapshots').put({ recordVersion: 1, id: 'campaign-1:2', slotId, revision: 2, kind: 'auto', text: otherText });
    } });
    const first = await h.repository.importSave(text, { ownerId: 'writer' }); const before = await h.inspect(); enabled = true;
    await expect(h.repository.saveText(slotId, text, { expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'INVALID_SAVE' });
    expect(await h.inspect()).toEqual(before);
  });
  it('preserves orphan generations and unknown record shapes', async () => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'writer' });
    await h.put('snapshots', { recordVersion: 1, id: 'campaign-1:2', slotId, revision: 2, kind: 'auto', text: otherText }); const before = await h.inspect();
    await expect(h.repository.saveText(slotId, text, { expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await h.inspect()).toEqual(before);
    await h.put('slots', { ...first.slot, futureField: true });
    await expect(h.repository.listSlots()).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
    await expect(h.repository.loadSlot(slotId)).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
  });
  it.each(['current', 'retained'] as const)('protects incompatible %s saves from rotations and explicit overwrite', async where => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'writer' });
    await h.repository.saveText(slotId, text, { expectedRevision: 1, lease: first.lease });
    await h.replace(where === 'current' ? 'campaign-1:2' : 'campaign-1:1', oldText); const before = await h.inspect();
    for (const kind of ['auto', 'manual', 'checkpoint'] as const) await expect(h.repository.saveText(slotId, text,
      { expectedRevision: 2, lease: first.lease, kind })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
    await expect(h.repository.importSave(text, { mode: 'overwrite', slotId, expectedRevision: 2, lease: first.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await h.inspect()).toEqual(before);
  });
  it.each([
    ['current', 'extra-field'], ['retained', 'extra-field'],
    ['current', 'checksum-shape'], ['retained', 'checksum-shape'],
  ] as const)('preserves future %s authority masked by %s before retention or overwrite', async (where, malformed) => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'writer' });
    await h.repository.saveText(slotId, text, { expectedRevision: 1, lease: first.lease });
    const future = JSON.parse(text) as Record<string, unknown>; future.saveVersion = 11;
    if (malformed === 'extra-field') future.futureField = { futureAuthority: true };
    else future.checksum = { algorithm: 'future-checksum', value: 'opaque' };
    const raw = `\n${JSON.stringify(future, null, 2)}\t`;
    // Full admission must still reject, but its earlier shape error cannot be
    // used as permission to prune this unmistakably unsupported source version.
    expect(parseSaveV10(raw)).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    const id = where === 'current' ? 'campaign-1:2' : 'campaign-1:1'; await h.replace(id, raw);
    const before = await h.inspect();
    for (const kind of ['auto', 'manual', 'checkpoint'] as const) await expect(h.repository.saveText(slotId, text,
      { expectedRevision: 2, lease: first.lease, kind })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
    await expect(h.repository.importSave(text, { mode: 'overwrite', slotId, expectedRevision: 2, lease: first.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
    expect(await h.inspect()).toEqual(before); expect(await h.repository.exportRawSnapshot(slotId, id)).toBe(raw);
  });
  it.each(['simulation', 'content', 'runtime', 'world-content', 'world-identity'] as const)('preserves masked future %s identity in a retained generation', async identity => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'writer' });
    await h.repository.saveText(slotId, text, { expectedRevision: 1, lease: first.lease });
    const future = JSON.parse(text) as Record<string, unknown>; future.futureField = true;
    const payload = future.payload as Record<string, unknown>;
    if (identity === 'simulation') future.simulationVersion = '0.11.0';
    else if (identity === 'content') future.contentVersion = 'future-content';
    else if (identity === 'runtime') payload.runtimeProtocol = 'future-runtime';
    else if (identity === 'world-content') payload.contentVersion = 'future-content';
    else payload.contentIdentity = { futureAuthority: true };
    const raw = JSON.stringify(future); expect(parseSaveV10(raw)).toMatchObject({ ok: false, error: { code: 'INVALID_ENVELOPE' } });
    await h.replace('campaign-1:1', raw); const before = await h.inspect();
    await expect(h.repository.saveText(slotId, text, { expectedRevision: 2, lease: first.lease, kind: 'manual' })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    await expect(h.repository.importSave(text, { mode: 'overwrite', slotId, expectedRevision: 2, lease: first.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await h.inspect()).toEqual(before);
  });
  it('preserves over-budget retained text that cannot be safely identity-inspected', async () => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'writer' });
    await h.repository.saveText(slotId, text, { expectedRevision: 1, lease: first.lease });
    const oversized = ' '.repeat(4 * 1024 * 1024 + 1); await h.replace('campaign-1:1', oversized); const before = await h.inspect();
    await expect(h.repository.saveText(slotId, text, { expectedRevision: 2, lease: first.lease, kind: 'manual' })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED', saveErrorCode: 'TOO_LARGE' });
    await expect(h.repository.importSave(text, { mode: 'overwrite', slotId, expectedRevision: 2, lease: first.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await h.inspect()).toEqual(before);
  });
  it('loads a validated fallback read-only without repairing the current pointer', async () => {
    const h = await harness(); const first = await h.repository.importSave(text, { ownerId: 'writer' });
    await h.repository.saveText(slotId, text, { expectedRevision: 1, lease: first.lease }); await h.replace('campaign-1:2', '{broken');
    const before = await h.inspect(); const loaded = await h.repository.loadSlot(slotId);
    expect(loaded.recovered).toBe(true); expect(loaded.snapshot.id).toBe('campaign-1:1'); expect(loaded.slot.currentSnapshotId).toBe('campaign-1:2');
    expect(loaded.issues).toEqual([{ snapshotId: 'campaign-1:2', code: 'INVALID_JSON' }]);
    await expect(h.repository.saveText(slotId, text, { expectedRevision: 2, lease: first.lease })).rejects.toMatchObject({ code: 'CURRENT_SNAPSHOT_INVALID' });
    expect(await h.inspect()).toEqual(before); expect(await h.repository.exportRawSnapshot(slotId, 'campaign-1:2')).toBe('{broken');
  });
  it.each(['missing-store', 'extra-store', 'wrong-key'] as const)('rejects an unknown database layout: %s', async layout => {
    const indexedDB = new FakeIDBFactory(); const open = indexedDB.open(MANAGEMENT_V10_DATABASE_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('slots', { keyPath: layout === 'wrong-key' ? 'id' : 'slotId' });
      open.result.createObjectStore('snapshots', { keyPath: 'id' }); open.result.createObjectStore('leases', { keyPath: 'slotId' });
      if (layout !== 'missing-store') open.result.createObjectStore('migrationSources', { keyPath: 'id' });
      if (layout === 'extra-store') open.result.createObjectStore('unknown', { keyPath: 'id' });
    };
    const db = await request(open); const names = [...db.objectStoreNames]; db.close();
    await expect(openManagementV10Repository({ indexedDB })).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
    const unchanged = await request(indexedDB.open(MANAGEMENT_V10_DATABASE_NAME)); expect([...unchanged.objectStoreNames]).toEqual(names); unchanged.close();
  });
  it('preserves a newer database version instead of downgrading or recreating it', async () => {
    const indexedDB = new FakeIDBFactory(); const open = indexedDB.open(MANAGEMENT_V10_DATABASE_NAME, 2);
    open.onupgradeneeded = () => { open.result.createObjectStore('futureRecords', { keyPath: 'id' }).add({ id: 'future', authority: 'preserve-me' }); };
    const db = await request(open); db.close();
    await expect(openManagementV10Repository({ indexedDB })).rejects.toMatchObject({ code: 'DATABASE_VERSION_UNSUPPORTED' });
    const unchanged = await request(indexedDB.open(MANAGEMENT_V10_DATABASE_NAME));
    try {
      expect(unchanged.version).toBe(2); expect([...unchanged.objectStoreNames]).toEqual(['futureRecords']);
      expect(await request(unchanged.transaction('futureRecords', 'readonly').objectStore('futureRecords').getAll())).toEqual([{ id: 'future', authority: 'preserve-me' }]);
    } finally { unchanged.close(); }
  });
});
