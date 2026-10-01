import { IDBFactory as FakeIDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceTicks, createSaveEnvelope, createWorld, dispatchCommand, domainHash, serializeSave, stableHash,
} from '../../src/core/kernel';
import { exportWorldSave, MAX_SAVE_FILE_BYTES, parseSaveFile } from '../../src/platform/files/save-files';
import {
  CAMPAIGN_SLOT_IDS, DATABASE_VERSION, openSaveRepository, PersistenceError,
  type IndexedDbSaveRepository, type RepositoryOptions, type SnapshotRecord, type WriteStage,
} from '../../src/platform/persistence';

const metadata = { buildId: 'persistence-tests', savedAt: '2026-10-01T06:00:00Z' };
const slotId = 'campaign-1' as const;
const repositories: IndexedDbSaveRepository[] = [];

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
async function harness(extra: Partial<RepositoryOptions> = {}) {
  const factory = new FakeIDBFactory();
  const databaseName = 'test-saves';
  const options = { indexedDB: factory, databaseName, now: () => 1000, ...extra };
  const open = async () => {
    const repository = await openSaveRepository(options);
    repositories.push(repository);
    return repository;
  };
  const repository = await open();
  return { factory, databaseName, options, repository, open };
}
async function inspect(factory: IDBFactory, name: string) {
  const database = await request(factory.open(name));
  try {
    const transaction = database.transaction(['slots', 'snapshots', 'leases'], 'readonly');
    const done = completion(transaction);
    const [slots, snapshots, leases] = await Promise.all([
      request<unknown[]>(transaction.objectStore('slots').getAll()),
      request<unknown[]>(transaction.objectStore('snapshots').getAll()),
      request<unknown[]>(transaction.objectStore('leases').getAll()),
    ]);
    await done;
    return { slots, snapshots, leases };
  } finally { database.close(); }
}
async function mutateRecord(factory: IDBFactory, name: string, storeName: string, key: string, mutate: (value: Record<string, unknown>) => Record<string, unknown>) {
  const database = await request(factory.open(name));
  try {
    const transaction = database.transaction(storeName, 'readwrite');
    const done = completion(transaction);
    const store = transaction.objectStore(storeName);
    const value: Record<string, unknown> = await request(store.get(key));
    await request(store.put(mutate(value)));
    await done;
  } finally { database.close(); }
}
function textFor(seed = 'persisted-world') { return serializeSave(createSaveEnvelope(createWorld(seed), metadata)); }
function editEnvelope(text: string, change: (body: Record<string, unknown>) => void, recompute = false): string {
  const value = JSON.parse(text) as Record<string, unknown>;
  change(value);
  if (recompute) {
    const { checksum: _checksum, ...body } = value;
    value.checksum = stableHash(body);
  }
  return JSON.stringify(value);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  vi.restoreAllMocks();
});

describe('IndexedDB snapshot repository', () => {
  it('lists exactly three campaign slots and roundtrips after closing/reopening storage', async () => {
    const h = await harness();
    expect(await h.repository.listSlots()).toEqual(CAMPAIGN_SLOT_IDS.map((slotId) => ({ slotId, slot: null })));
    const lease = await h.repository.acquireLease(slotId, 'tab-one');
    const initial = createWorld('production-roundtrip');
    const working = dispatchCommand(initial, {
      commandId: 'production-for-save', sequence: 1, issuedTick: 0, kind: 'production.start',
      payload: { recipeId: 'craft.plank', workerId: initial.disciples[1]!.id },
    }).world;
    const world = advanceTicks(working, 10);
    const committed = await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 0, lease });
    expect(committed.slot.revision).toBe(1);
    h.repository.close();
    const reopened = await h.open();
    const loaded = await reopened.loadSlot(slotId);
    expect(loaded.recovered).toBe(false);
    expect(loaded.issues).toEqual([]);
    expect(loaded.envelope.saveVersion).toBe(7);
    if (loaded.envelope.saveVersion !== 7) throw new Error('This regression expects a legacy v7 snapshot');
    const loadedV7 = loaded.envelope.payload;
    expect(domainHash(loadedV7)).toBe(domainHash(world));
    expect(domainHash(advanceTicks(loadedV7, 120))).toBe(domainHash(advanceTicks(world, 120)));
    // Returned world objects are detached from stored text.
    loaded.world.seed = 'mutated-client-object';
    expect((await reopened.loadSlot(slotId)).world.seed).toBe('production-roundtrip');
  });

  it('rotates three autos independently of one manual and one checkpoint', async () => {
    const h = await harness();
    const lease = await h.repository.acquireLease(slotId, 'tab-one');
    const world = createWorld();
    for (let revision = 0; revision < 5; revision++) {
      await h.repository.saveWorld(slotId, advanceTicks(world, revision), metadata, { expectedRevision: revision, lease });
    }
    await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 5, lease, kind: 'manual' });
    await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 6, lease, kind: 'checkpoint' });
    const manual = await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 7, lease, kind: 'manual' });
    expect(manual.slot.autoSnapshotIds).toEqual(['campaign-1:5', 'campaign-1:4', 'campaign-1:3']);
    expect(manual.slot.manualSnapshotId).toBe('campaign-1:8');
    expect(manual.slot.checkpointSnapshotId).toBe('campaign-1:7');
    const records = await inspect(h.factory, h.databaseName);
    expect((records.snapshots as SnapshotRecord[]).map((entry) => entry.id)).toEqual([
      'campaign-1:3', 'campaign-1:4', 'campaign-1:5', 'campaign-1:7', 'campaign-1:8',
    ]);
    expect((await h.repository.loadSlot(slotId)).snapshot.id).toBe('campaign-1:8');
  });

  it.each<WriteStage>(['before-snapshot', 'after-snapshot', 'before-pointer', 'after-pointer', 'after-prune'])(
    'rolls back payload, pointer, rotation, and last-success timestamp when aborted at %s', async (stage) => {
      let abortAt: WriteStage | undefined;
      const h = await harness({ faultInjector: (point, transaction) => { if (point === abortAt) transaction.abort(); } });
      const lease = await h.repository.acquireLease(slotId, 'tab-one');
      const world = createWorld();
      for (let revision = 0; revision < 3; revision++) await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: revision, lease });
      const before = await inspect(h.factory, h.databaseName);
      abortAt = stage;
      await expect(h.repository.saveWorld(slotId, advanceTicks(world, 5), { ...metadata, savedAt: 'never-committed' }, { expectedRevision: 3, lease })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
      expect(await inspect(h.factory, h.databaseName)).toEqual(before);
      expect((await h.repository.loadSlot(slotId)).slot.savedAt).toBe(metadata.savedAt);
    },
  );

  it.each(['QuotaExceededError', 'UnknownError'])('preserves current save on mocked storage failure %s', async (errorName) => {
    const h = await harness();
    const lease = await h.repository.acquireLease(slotId, 'tab-one');
    const world = createWorld();
    await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 0, lease });
    const before = await inspect(h.factory, h.databaseName);
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => { throw new DOMException('Injected storage failure', errorName); });
    await expect(h.repository.saveWorld(slotId, advanceTicks(world, 1), metadata, { expectedRevision: 1, lease })).rejects.toMatchObject({ code: errorName === 'QuotaExceededError' ? 'QUOTA_EXCEEDED' : 'TRANSACTION_FAILED' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
    expect((await h.repository.loadSlot(slotId)).slot.revision).toBe(1);
  });

  it.each(['text', 'recordVersion'])('rejects read-back tampering with %s before publishing the pointer', async (field) => {
    let tamper = false;
    const text = textFor('read-back');
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (tamper && stage === 'after-snapshot') {
        transaction.objectStore('snapshots').put({
          recordVersion: field === 'recordVersion' ? 99 : 1,
          id: 'campaign-1:2', slotId, revision: 2, kind: 'auto', text: field === 'text' ? '{broken' : text,
        });
      }
    } });
    const first = await h.repository.importSave(text, { ownerId: 'tab-one' });
    const before = await inspect(h.factory, h.databaseName);
    tamper = true;
    await expect(h.repository.saveWorld(slotId, createWorld('read-back'), metadata, { expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'INVALID_SAVE' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('never overwrites an orphan snapshot with a duplicate record key', async () => {
    const h = await harness();
    const lease = await h.repository.acquireLease(slotId, 'tab-one');
    await h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 0, lease });
    const raw = await request(h.factory.open(h.databaseName));
    const transaction = raw.transaction('snapshots', 'readwrite');
    const done = completion(transaction);
    await request(transaction.objectStore('snapshots').add({ recordVersion: 1, id: 'campaign-1:2', slotId, revision: 2, kind: 'auto', text: 'orphaned original' }));
    await done; raw.close();
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 1, lease })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('rejects invalid live worlds without mutating anything', async () => {
    const h = await harness();
    const lease = await h.repository.acquireLease(slotId, 'tab-one');
    const before = await inspect(h.factory, h.databaseName);
    const world = createWorld();
    world.inventory.wood.owned = -1;
    await expect(h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 0, lease })).rejects.toMatchObject({ code: 'INVALID_SAVE' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('recovers a corrupt current snapshot without changing its pointer or bytes', async () => {
    const h = await harness();
    const lease = await h.repository.acquireLease(slotId, 'tab-one');
    const world = createWorld();
    await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 0, lease });
    await h.repository.saveWorld(slotId, advanceTicks(world, 1), metadata, { expectedRevision: 1, lease });
    await mutateRecord(h.factory, h.databaseName, 'snapshots', 'campaign-1:2', (value) => ({ ...value, text: '{broken' }));
    const before = await inspect(h.factory, h.databaseName);
    const recovered = await h.repository.loadSlot(slotId);
    expect(recovered.recovered).toBe(true);
    expect(recovered.snapshot.id).toBe('campaign-1:1');
    expect(recovered.slot.currentSnapshotId).toBe('campaign-1:2');
    expect(recovered.issues).toEqual([{ snapshotId: 'campaign-1:2', code: 'INVALID_JSON' }]);
    expect(await h.repository.exportRawSnapshot(slotId, 'campaign-1:2')).toBe('{broken');
    expect((await h.repository.exportSlot(slotId)).recovered).toBe(true);
    await expect(h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 2, lease })).rejects.toMatchObject({ code: 'CURRENT_SNAPSHOT_INVALID' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('reports all-invalid generations and preserves raw bytes for rescue', async () => {
    const h = await harness();
    const imported = await h.repository.importSave(textFor(), { ownerId: 'tab-one' });
    await mutateRecord(h.factory, h.databaseName, 'snapshots', imported.snapshot.id, (value) => ({ ...value, text: 'broken' }));
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.loadSlot(slotId)).rejects.toMatchObject({ code: 'NO_VALID_SNAPSHOT', issues: [{ code: 'INVALID_JSON' }] });
    expect(await h.repository.exportRawSnapshot(slotId, imported.snapshot.id)).toBe('broken');
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('uses checkpoint/manual fallback by most recent revision when autos are corrupt', async () => {
    const h = await harness();
    const lease = await h.repository.acquireLease(slotId, 'tab-one');
    const world = createWorld();
    await h.repository.saveWorld(slotId, world, metadata, { expectedRevision: 0, lease, kind: 'manual' });
    await h.repository.saveWorld(slotId, advanceTicks(world, 1), metadata, { expectedRevision: 1, lease, kind: 'checkpoint' });
    await h.repository.saveWorld(slotId, advanceTicks(world, 2), metadata, { expectedRevision: 2, lease });
    await mutateRecord(h.factory, h.databaseName, 'snapshots', 'campaign-1:3', (value) => ({ ...value, text: 'broken' }));
    expect((await h.repository.loadSlot(slotId)).snapshot.kind).toBe('checkpoint');
  });

  it('rejects corrupted manifest metadata rather than treating the slot as empty', async () => {
    const h = await harness();
    await h.repository.importSave(textFor(), { ownerId: 'tab-one' });
    await mutateRecord(h.factory, h.databaseName, 'slots', slotId, (value) => ({ ...value, recordVersion: 20 }));
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.importSave(textFor('new'), { ownerId: 'tab-two' })).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });
});

describe('writer fencing and conflicts', () => {
  it('rejects two concurrent writes with the same expected revision after one commits', async () => {
    const h = await harness();
    const lease = await h.repository.acquireLease(slotId, 'tab-one');
    const second = await h.open();
    const results = await Promise.allSettled([
      h.repository.saveWorld(slotId, createWorld('first'), metadata, { expectedRevision: 0, lease }),
      second.saveWorld(slotId, createWorld('second'), metadata, { expectedRevision: 0, lease }),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((entry) => entry.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await inspect(h.factory, h.databaseName)).snapshots).toHaveLength(1);
  });

  it('makes second tabs read-only until explicit takeover and fences the previous epoch', async () => {
    const h = await harness();
    const firstLease = await h.repository.acquireLease(slotId, 'tab-one');
    await h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 0, lease: firstLease });
    const second = await h.open();
    expect((await second.loadSlot(slotId)).slot.revision).toBe(1);
    await expect(second.acquireLease(slotId, 'tab-two')).rejects.toMatchObject({ code: 'LEASE_BUSY' });
    const secondLease = await second.acquireLease(slotId, 'tab-two', { takeover: true });
    expect(secondLease.epoch).toBe(firstLease.epoch + 1);
    await expect(h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 1, lease: firstLease })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(h.repository.renewLease(firstLease)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(h.repository.releaseLease(firstLease)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await second.saveWorld(slotId, createWorld('second-tab'), metadata, { expectedRevision: 1, lease: secondLease });
    expect((await h.repository.loadSlot(slotId)).world.seed).toBe('second-tab');
  });

  it('fences expired tokens, including the same owner after reacquisition or release', async () => {
    let now = 1000;
    const h = await harness({ now: () => now });
    const first = await h.repository.acquireLease(slotId, 'same-owner', { durationMs: 10 });
    now = 1010;
    await expect(h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 0, lease: first })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const second = await h.repository.acquireLease(slotId, 'same-owner');
    expect(second.epoch).toBe(first.epoch + 1);
    await h.repository.releaseLease(second);
    const third = await h.repository.acquireLease(slotId, 'same-owner');
    expect(third.epoch).toBe(second.epoch + 1);
    await expect(h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 0, lease: second })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 0, lease: third });
  });

  it('rolls back the whole write if the lease expires before publishing the pointer', async () => {
    let now = 1000;
    let expire = false;
    const h = await harness({ now: () => now, faultInjector: (stage) => {
      if (expire && stage === 'after-snapshot') now = 2000;
    } });
    const first = await h.repository.acquireLease(slotId, 'tab-one', { durationMs: 100 });
    await h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 0, lease: first });
    const before = await inspect(h.factory, h.databaseName);
    expire = true;
    await expect(h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 1, lease: first })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('renews a live lease without advancing its epoch', async () => {
    let now = 1000;
    const h = await harness({ now: () => now });
    const first = await h.repository.acquireLease(slotId, 'tab-one', { durationMs: 10 });
    now = 1005;
    const renewed = await h.repository.renewLease(first, 30);
    expect(renewed.epoch).toBe(first.epoch);
    expect(renewed.expiresAt).toBe(1035);
    now = 1020;
    await h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 0, lease: renewed });
  });
});

describe('safe file import and export', () => {
  it('imports into empty slots by default, preserving exact text and keeping campaigns separate', async () => {
    const h = await harness();
    const text = JSON.stringify(JSON.parse(textFor()), null, 2);
    const first = await h.repository.importSave(text, { ownerId: 'tab-one' });
    expect(first.slot.slotId).toBe('campaign-1');
    expect((await h.repository.exportSlot('campaign-1')).text).toBe(text);
    const second = await h.repository.importSave(textFor('second'), { ownerId: 'tab-one' });
    const third = await h.repository.importSave(textFor('third'), { ownerId: 'tab-one' });
    expect(second.slot.slotId).toBe('campaign-2');
    expect(third.slot.slotId).toBe('campaign-3');
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.importSave(textFor('fourth'), { ownerId: 'tab-one' })).rejects.toMatchObject({ code: 'NO_EMPTY_SLOT' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('allocates different empty slots for simultaneous default imports', async () => {
    const h = await harness();
    const second = await h.open();
    const results = await Promise.all([
      h.repository.importSave(textFor('one'), { ownerId: 'tab-one' }),
      second.importSave(textFor('two'), { ownerId: 'tab-two' }),
    ]);
    expect(new Set(results.map((result) => result.slot.slotId)).size).toBe(2);
    expect((await inspect(h.factory, h.databaseName)).snapshots).toHaveLength(2);
  });

  it('rolls back the newly acquired lease along with a failed new-slot import', async () => {
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage === 'after-pointer') transaction.abort();
    } });
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.importSave(textFor(), { ownerId: 'tab-one' })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('never treats a targeted new-slot import as overwrite permission', async () => {
    const h = await harness();
    await h.repository.importSave(textFor(), { ownerId: 'tab-one' });
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.importSave(textFor('different'), { ownerId: 'tab-one', slotId })).rejects.toMatchObject({ code: 'SLOT_OCCUPIED' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('supports explicit revision-fenced overwrite and removes unrelated old-campaign fallbacks atomically', async () => {
    const h = await harness();
    const first = await h.repository.importSave(textFor('old'), { ownerId: 'tab-one' });
    await h.repository.saveWorld(slotId, createWorld('old'), metadata, { expectedRevision: 1, lease: first.lease });
    await expect(h.repository.importSave(textFor('new'), { mode: 'overwrite', slotId, expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const imported = await h.repository.importSave(textFor('new'), { mode: 'overwrite', slotId, expectedRevision: 2, lease: first.lease });
    expect(imported.slot.revision).toBe(3);
    expect(imported.slot.autoSnapshotIds).toEqual([]);
    expect((await inspect(h.factory, h.databaseName)).snapshots).toHaveLength(1);
    expect((await h.repository.loadSlot(slotId)).world.seed).toBe('new');
  });

  it('rolls back import overwrite, including pruning, when the transaction aborts', async () => {
    let fail = false;
    const h = await harness({ faultInjector: (stage, transaction) => { if (fail && stage === 'after-prune') transaction.abort(); } });
    const first = await h.repository.importSave(textFor('old'), { ownerId: 'tab-one' });
    const before = await inspect(h.factory, h.databaseName);
    fail = true;
    await expect(h.repository.importSave(textFor('new'), { mode: 'overwrite', slotId, expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it.each([
    ['{invalid', 'INVALID_JSON'],
    [JSON.stringify({ saveVersion: 999, payload: { futureData: 'preserve-me' } }), 'UNSUPPORTED_SAVE_VERSION'],
    [editEnvelope(textFor(), (value) => { value.simulationVersion = '99.0.0'; }), 'UNSUPPORTED_SIMULATION_VERSION'],
    [editEnvelope(textFor(), (value) => { value.contentVersion = 'future-content'; }), 'UNSUPPORTED_CONTENT_VERSION'],
    [editEnvelope(textFor(), (value) => { value.savedAt = 'tampered'; }), 'CHECKSUM_MISMATCH'],
    [editEnvelope(textFor(), (value) => { const payload = value.payload as { seed: string }; payload.seed = 'different'; }, true), 'INVALID_WORLD'],
  ])('rejects invalid/unsupported import without replacing any slot (%s)', async (text, code) => {
    const h = await harness();
    const first = await h.repository.importSave(textFor('original'), { ownerId: 'tab-one' });
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.importSave(text, { mode: 'overwrite', slotId, expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'INVALID_SAVE', saveErrorCode: code });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('preserves unsupported stored future versions, including during explicit overwrite', async () => {
    const h = await harness();
    const first = await h.repository.importSave(textFor('old'), { ownerId: 'tab-one' });
    await h.repository.saveWorld(slotId, createWorld('old'), metadata, { expectedRevision: 1, lease: first.lease });
    const futureText = editEnvelope(textFor('future'), (value) => { value.saveVersion = 999; });
    await mutateRecord(h.factory, h.databaseName, 'snapshots', 'campaign-1:2', (value) => ({ ...value, text: futureText }));
    const before = await inspect(h.factory, h.databaseName);
    const recovered = await h.repository.loadSlot(slotId);
    expect(recovered.recovered).toBe(true);
    expect(recovered.issues[0]?.code).toBe('UNSUPPORTED_SAVE_VERSION');
    await expect(h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 2, lease: first.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    await expect(h.repository.importSave(textFor(), { mode: 'overwrite', slotId, expectedRevision: 2, lease: first.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await h.repository.exportRawSnapshot(slotId, 'campaign-1:2')).toBe(futureText);
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('protects unsupported retained versions even when the current generation loads successfully', async () => {
    const h = await harness();
    const first = await h.repository.importSave(textFor(), { ownerId: 'tab-one' });
    await h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 1, lease: first.lease });
    const futureText = editEnvelope(first.snapshot.text, (value) => { value.saveVersion = 999; });
    await mutateRecord(h.factory, h.databaseName, 'snapshots', first.snapshot.id, (value) => ({ ...value, text: futureText }));
    expect((await h.repository.loadSlot(slotId)).recovered).toBe(false);
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.saveWorld(slotId, createWorld(), metadata, { expectedRevision: 2, lease: first.lease, kind: 'manual' })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('preserves an unknown snapshot record format on explicit overwrite', async () => {
    const h = await harness();
    const first = await h.repository.importSave(textFor(), { ownerId: 'tab-one' });
    await mutateRecord(h.factory, h.databaseName, 'snapshots', first.snapshot.id, (value) => ({ ...value, recordVersion: 999, extra: 'keep me' }));
    const before = await inspect(h.factory, h.databaseName);
    await expect(h.repository.importSave(textFor('new'), { mode: 'overwrite', slotId, expectedRevision: 1, lease: first.lease })).rejects.toMatchObject({ code: 'NEWER_SAVE_PROTECTED' });
    expect(await h.repository.exportRawSnapshot(slotId, first.snapshot.id)).toBe(first.snapshot.text);
    expect(await inspect(h.factory, h.databaseName)).toEqual(before);
  });

  it('rejects UTF-8 file byte overflow even below the JSON character limit', () => {
    const large = '汉'.repeat(Math.floor(MAX_SAVE_FILE_BYTES / 3) + 1);
    expect(large.length).toBeLessThan(MAX_SAVE_FILE_BYTES);
    expect(parseSaveFile(large)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
  });

  it('exports current-session JSON without any storage connection', () => {
    const world = createWorld('storage-unavailable');
    const file = exportWorldSave(world, metadata);
    expect(file.mimeType).toBe('application/json');
    expect(file.filename).toMatch(/^shanmen-changming-.*\.json$/);
    const parsed = parseSaveFile(file.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.envelope.saveVersion !== 7) throw new Error('This regression expects a legacy v7 export');
    expect(domainHash(parsed.envelope.payload)).toBe(domainHash(world));
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });
});

describe('database lifecycle safety', () => {
  it('refuses a newer IndexedDB schema without downgrading or clearing it', async () => {
    const factory = new FakeIDBFactory();
    const operation = factory.open('future-db', DATABASE_VERSION + 1);
    operation.onupgradeneeded = () => operation.result.createObjectStore('future-payloads');
    const database = await request(operation);
    const transaction = database.transaction('future-payloads', 'readwrite');
    const done = completion(transaction);
    await request(transaction.objectStore('future-payloads').put('preserved-future-value', 'key'));
    await done; database.close();
    await expect(openSaveRepository({ indexedDB: factory, databaseName: 'future-db' })).rejects.toMatchObject({ code: 'DATABASE_VERSION_UNSUPPORTED' });
    const reopened = await request(factory.open('future-db'));
    expect(reopened.version).toBe(DATABASE_VERSION + 1);
    expect(await request(reopened.transaction('future-payloads', 'readonly').objectStore('future-payloads').get('key'))).toBe('preserved-future-value');
    reopened.close();
  });

  it('refuses an unrecognized schema instead of recreating missing stores', async () => {
    const factory = new FakeIDBFactory();
    const operation = factory.open('unrecognized', DATABASE_VERSION);
    operation.onupgradeneeded = () => operation.result.createObjectStore('important-data');
    const database = await request(operation); database.close();
    await expect(openSaveRepository({ indexedDB: factory, databaseName: 'unrecognized' })).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
    const reopened = await request(factory.open('unrecognized'));
    expect([...reopened.objectStoreNames]).toEqual(['important-data']);
    reopened.close();
  });

  it('returns a typed error on storage denial and after the connection closes', async () => {
    const factory = new FakeIDBFactory();
    vi.spyOn(factory, 'open').mockImplementationOnce(() => { throw new DOMException('Denied', 'SecurityError'); });
    await expect(openSaveRepository({ indexedDB: factory })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const h = await harness();
    h.repository.close();
    await expect(h.repository.listSlots()).rejects.toBeInstanceOf(PersistenceError);
    await expect(h.repository.listSlots()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});
