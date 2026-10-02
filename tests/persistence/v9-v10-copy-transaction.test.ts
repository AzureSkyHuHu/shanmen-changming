import { IDBFactory as FakeIDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSaveEnvelopeV9, parseSaveV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createSaveEnvelopeV10, parseSaveV10, serializeSaveV10 } from '../../src/core/kernel/save-v10';
import { hashText, stableHash } from '../../src/core/kernel/serialization';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { prepareV9ToV10Migration } from '../../src/core/world/migrate-v9-to-v10';
import { openManagementV10Repository, type IndexedDbManagementV10Repository } from '../../src/platform/persistence/indexeddb-management-v10-repository';
import { MANAGEMENT_V10_DATABASE_NAME, MANAGEMENT_V10_STORES, type CommitV9CopyOptions,
  type ManagementV10RepositoryOptions, type ManagementV10WriteStage } from '../../src/platform/persistence/management-v10-types';
import { openSaveRepository, type IndexedDbSaveRepository } from '../../src/platform/persistence/indexeddb-save-repository';
import { MANAGEMENT_V9_DATABASE_NAME } from '../../src/platform/persistence/types';

const slotId = 'campaign-1' as const; const sourceId = 'v9-source:campaign-1:1';
const metadata = { buildId: 'v10-copy-tests', savedAt: '2026-10-02T21:00:00Z' };
const repositories: Array<IndexedDbManagementV10Repository | IndexedDbSaveRepository> = [];
let sourceText: string; let targetText: string; let unrelatedText: string;
beforeAll(() => {
  const old = createSaveEnvelopeV9(createUnregisteredWorldV9('copy-山门-🌱-e\u0301'), { ...metadata, buildId: '原版-🧪' });
  // Genuine exact source, deliberately noncanonical order, CRLF, tabs and Unicode.
  sourceText = `\r\n\t ${JSON.stringify(Object.fromEntries(Object.entries(old).reverse()), null, 2)} \r\n`;
  targetText = migrationTarget(sourceText);
  unrelatedText = serializeSaveV10(createSaveEnvelopeV10(createUnregisteredWorldV10('unrelated-target'), metadata));
});
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); vi.restoreAllMocks(); });
function migrationTarget(source: string): string {
  const prepared = prepareV9ToV10Migration(source, metadata); if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues));
  return serializeSaveV10(prepared.envelope);
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
}
async function raw<T>(indexedDB: IDBFactory, databaseName: string, mode: IDBTransactionMode, body: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
  const database = await request(indexedDB.open(databaseName));
  try {
    const transaction = database.transaction([...database.objectStoreNames], mode); const completed = done(transaction);
    const result = await body(transaction); await completed; return result;
  } finally { database.close(); }
}
async function inspect(indexedDB: IDBFactory, databaseName = MANAGEMENT_V10_DATABASE_NAME) {
  return raw(indexedDB, databaseName, 'readonly', async transaction => Object.fromEntries(await Promise.all([...transaction.objectStoreNames].map(async name => [name, await request<unknown[]>(transaction.objectStore(name).getAll())]))));
}
async function harness(extra: ManagementV10RepositoryOptions = {}) {
  const indexedDB = extra.indexedDB ?? new FakeIDBFactory(); let now = 1000;
  const options: ManagementV10RepositoryOptions = { indexedDB, now: () => now, ...extra };
  const open = async () => { const repository = await openManagementV10Repository(options); repositories.push(repository); return repository; };
  const repository = await open();
  return { indexedDB, repository, open, setNow: (value: number) => { now = value; }, inspect: () => inspect(indexedDB),
    put: (name: string, value: unknown) => raw(indexedDB, MANAGEMENT_V10_DATABASE_NAME, 'readwrite', transaction => request(transaction.objectStore(name).put(value))),
  };
}
function copyOptions(extra: Partial<CommitV9CopyOptions> = {}): CommitV9CopyOptions {
  return { sourceText, targetText, targetSlotId: slotId, ownerId: 'migration-owner', ...extra };
}
function backup(source = sourceText) { return { recordVersion: 1, id: sourceId, targetSlotId: slotId, sourceText: source }; }
function generation(text = targetText) { return { recordVersion: 1, id: 'campaign-1:1', slotId, revision: 1, kind: 'manual', text }; }
function pointer() { return { recordVersion: 1, slotId, revision: 1, currentSnapshotId: 'campaign-1:1', autoSnapshotIds: [], manualSnapshotId: 'campaign-1:1', checkpointSnapshotId: null, savedAt: metadata.savedAt }; }

describe('v9 to v10 exact-source atomic target copy', () => {
  it('returns a durable revision1/manual receipt after exact source and target rereads in one strict four-store transaction', async () => {
    const stages: ManagementV10WriteStage[] = []; const transactions = new Set<IDBTransaction>(); let completed = false;
    const h = await harness({ faultInjector: (stage, transaction) => {
      stages.push(stage); transactions.add(transaction);
      expect(transaction.db.name).toBe(MANAGEMENT_V10_DATABASE_NAME); expect(transaction.mode).toBe('readwrite');
      expect(transaction.durability).toBe('strict'); expect([...transaction.objectStoreNames].sort()).toEqual([...MANAGEMENT_V10_STORES].sort());
      if (stage === 'before-backup') transaction.addEventListener('complete', () => { completed = true; });
    } });
    const operations: string[] = []; const get = FakeIDBObjectStore.prototype.get; const add = FakeIDBObjectStore.prototype.add;
    vi.spyOn(FakeIDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) { operations.push(`${this.name}:get`); return get.call(this, key); });
    vi.spyOn(FakeIDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) { operations.push(`${this.name}:add`); return add.call(this, value, key); });
    const receipt = await h.repository.commitV9Copy(copyOptions());
    expect(completed).toBe(true); expect(transactions.size).toBe(1);
    expect(receipt).toMatchObject({ committed: true, databaseName: MANAGEMENT_V10_DATABASE_NAME, sourceBackup: backup(), snapshot: generation(), slot: pointer() });
    expect(receipt.lease).toEqual({ slotId, ownerId: 'migration-owner', epoch: 1, expiresAt: 16000 });
    expect(stages).toEqual(['before-backup', 'after-backup', 'after-backup-readback', 'before-snapshot', 'after-snapshot', 'after-snapshot-readback', 'before-pointer', 'after-pointer']);
    expect(operations.filter(op => op === 'migrationSources:get')).toHaveLength(3);
    expect(operations.filter(op => op === 'snapshots:get')).toHaveLength(2);
    expect(operations.slice(-4)).toEqual(['snapshots:get', 'slots:get', 'leases:get', 'slots:add']);
    expect(operations.indexOf('migrationSources:add')).toBeLessThan(operations.indexOf('snapshots:add'));
    expect(await h.repository.exportMigrationSource(slotId)).toBe(sourceText);
    const loaded = await h.repository.loadSlot(slotId); expect(loaded.snapshot.text).toBe(targetText); expect(loaded.envelope.saveVersion).toBe(10);
    h.repository.close(); const reopened = await h.open();
    expect((await reopened.loadSlot(slotId)).slot).toEqual(receipt.slot); expect(await reopened.exportMigrationSource(slotId)).toBe(sourceText);
  });
  it('accepts semantically exact prepared target formatting while retaining exact target bytes', async () => {
    const h = await harness(); const formatted = `\n ${JSON.stringify(JSON.parse(targetText), null, 2)}\n`;
    const receipt = await h.repository.commitV9Copy(copyOptions({ targetText: formatted }));
    expect(receipt.snapshot.text).toBe(formatted); expect((await h.repository.loadSlot(slotId)).snapshot.text).toBe(formatted);
    expect(await h.repository.exportMigrationSource(slotId)).toBe(sourceText);
  });
  it('independently rejects unrelated valid target, invalid source and invalid target without any writes', async () => {
    const h = await harness(); const before = await h.inspect(); expect(parseSaveV10(unrelatedText).ok).toBe(true);
    await expect(h.repository.commitV9Copy(copyOptions({ targetText: unrelatedText }))).rejects.toMatchObject({ code: 'MIGRATION_TARGET_MISMATCH' });
    await expect(h.repository.commitV9Copy(copyOptions({ sourceText: '{broken' }))).rejects.toMatchObject({ code: 'MIGRATION_SOURCE_INVALID', saveErrorCode: 'INVALID_JSON' });
    await expect(h.repository.commitV9Copy(copyOptions({ sourceText: targetText }))).rejects.toMatchObject({ code: 'MIGRATION_SOURCE_INVALID', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
    await expect(h.repository.commitV9Copy(copyOptions({ targetText: sourceText }))).rejects.toMatchObject({ code: 'INVALID_SAVE', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
    expect(await h.inspect()).toEqual(before);
  });
  it('rechecks the actual quiet boundary instead of trusting valid old/new save checksums', async () => {
    const h = await harness(); const world = createUnregisteredWorldV9('automatic-source'); world.sectEconomy.enabled = true;
    const automatic = serializeSaveV9(createSaveEnvelopeV9(world, metadata)); expect(parseSaveV9(automatic).ok).toBe(true);
    const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions({ sourceText: automatic }))).rejects.toMatchObject({ code: 'MIGRATION_NOT_READY', migrationIssues: expect.arrayContaining([{ code: 'AUTOMATIC_WORK_ENABLED', path: 'sectEconomy.enabled' }]) });
    expect(await h.inspect()).toEqual(before);
  });
  it.each(['before-backup', 'after-backup', 'after-backup-readback', 'before-snapshot', 'after-snapshot', 'after-snapshot-readback', 'before-pointer', 'after-pointer'] satisfies ManagementV10WriteStage[])(
    'aborts every target record on injected fault at %s without automatic retry', async stage => {
      let failures = 0; const h = await harness({ faultInjector: point => { if (point === stage) { failures++; throw new Error('Synthetic migration failure'); } } });
      const before = await h.inspect();
      await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
      expect(failures).toBe(1); expect(await h.inspect()).toEqual(before);
    });
  it.each(['migrationSources', 'snapshots', 'slots'])('rolls back all four stores on %s quota failure', async failingStore => {
    const h = await harness(); const before = await h.inspect(); const add = FakeIDBObjectStore.prototype.add; let attempts = 0;
    vi.spyOn(FakeIDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === failingStore) { attempts++; throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); }
      return add.call(this, value, key);
    });
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(attempts).toBe(1); expect(await h.inspect()).toEqual(before);
  });
  it('preserves an expired prior lease when migration lease acquisition hits a put quota failure', async () => {
    const h = await harness(); const prior = await h.repository.acquireLease(slotId, 'expired-owner'); h.setNow(prior.expiresAt);
    const before = await h.inspect(); const put = FakeIDBObjectStore.prototype.put; let attempts = 0;
    vi.spyOn(FakeIDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'leases') { attempts++; throw new DOMException('Synthetic lease quota', 'QuotaExceededError'); }
      return put.call(this, value, key);
    });
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(attempts).toBe(1); expect(await h.inspect()).toEqual(before);
  });
  it.each(['before-call', 'after-backup', 'before-pointer', 'after-pointer'] as const)('honors cancellation at %s and preserves the entire preimage', async point => {
    const abort = new AbortController(); const h = await harness({ faultInjector: stage => { if (stage === point) abort.abort(); } });
    const before = await h.inspect(); if (point === 'before-call') abort.abort();
    await expect(h.repository.commitV9Copy(copyOptions({ signal: abort.signal }))).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await h.inspect()).toEqual(before);
  });
  it('does not pretend a cancellation after actual durable completion rolls back the saved target', async () => {
    const abort = new AbortController(); const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage === 'after-pointer') transaction.addEventListener('complete', () => abort.abort());
    } });
    const receipt = await h.repository.commitV9Copy(copyOptions({ signal: abort.signal }));
    expect(abort.signal.aborted).toBe(true); expect(receipt.committed).toBe(true);
    expect((await h.repository.loadSlot(slotId)).slot.revision).toBe(1); expect(await h.repository.exportMigrationSource(slotId)).toBe(sourceText);
  });
  it.each(['after-backup', 'before-pointer'] satisfies ManagementV10WriteStage[])('rejects changed raw backup at %s even when the envelope checksum is unchanged', async point => {
    const changed = `\n${sourceText}`; expect(parseSaveV9(changed).ok).toBe(true);
    const h = await harness({ faultInjector: (stage, transaction) => { if (stage === point) transaction.objectStore('migrationSources').put(backup(changed)); } });
    const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'SOURCE_BACKUP_CONFLICT' });
    expect(await h.inspect()).toEqual(before);
  });
  it.each(['after-snapshot', 'before-pointer'] satisfies ManagementV10WriteStage[])('rejects unrelated yet valid generation readback at %s', async point => {
    const h = await harness({ faultInjector: (stage, transaction) => { if (stage === point) transaction.objectStore('snapshots').put(generation(unrelatedText)); } });
    const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'INVALID_SAVE' });
    expect(await h.inspect()).toEqual(before);
  });
  it.each(['migrationSources', 'snapshots'])('rereads %s after initial successful readback and rejects a missing record', async store => {
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage === 'before-pointer') transaction.objectStore(store).delete(store === 'migrationSources' ? sourceId : 'campaign-1:1');
    } });
    const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: store === 'migrationSources' ? 'SOURCE_BACKUP_CONFLICT' : 'INVALID_SAVE' });
    expect(await h.inspect()).toEqual(before);
  });
  it.each(['epoch', 'owner', 'expiry'] as const)('rejects the final %s lease fence after readback', async changed => {
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage === 'before-pointer') transaction.objectStore('leases').put({ recordVersion: 1, slotId,
        ownerId: changed === 'owner' ? 'other-owner' : 'migration-owner', epoch: changed === 'epoch' ? 2 : 1, expiresAt: changed === 'expiry' ? 1000 : 16000 });
    } });
    const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await h.inspect()).toEqual(before);
  });
  it('checks the real clock again immediately before pointer publication', async () => {
    let now = 1000; const h = await harness({ now: () => now, faultInjector: stage => { if (stage === 'before-pointer') now = 16000; } });
    const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await h.inspect()).toEqual(before);
  });
  it('never takes over a live competing writer on an empty slot', async () => {
    const h = await harness(); await h.repository.acquireLease(slotId, 'other'); const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'LEASE_BUSY' });
    expect(await h.inspect()).toEqual(before);
  });
  it('rejects an occupied target and a second conversion instead of overwriting or automatically retrying', async () => {
    const h = await harness(); const receipt = await h.repository.commitV9Copy(copyOptions()); const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'SLOT_OCCUPIED' });
    await expect(h.repository.commitV9Copy(copyOptions({ targetText: unrelatedText }))).rejects.toMatchObject({ code: 'MIGRATION_TARGET_MISMATCH' });
    expect(await h.inspect()).toEqual(before); expect((await h.repository.loadSlot(slotId)).slot).toEqual(receipt.slot);
  });
  it('serializes two real writers racing for one empty target so only one commits', async () => {
    const h = await harness(); const other = await h.open();
    const results = await Promise.allSettled([h.repository.commitV9Copy(copyOptions()), other.commitV9Copy(copyOptions({ ownerId: 'second' }))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected'); expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'SLOT_OCCUPIED' } });
    const state = await h.inspect(); expect(state.slots).toHaveLength(1); expect(state.snapshots).toHaveLength(1); expect(state.migrationSources).toHaveLength(1); expect(state.leases).toHaveLength(1);
  });
  it('rechecks an occupied manifest just before pointer publication', async () => {
    const h = await harness({ faultInjector: (stage, transaction) => { if (stage === 'before-pointer') transaction.objectStore('slots').put(pointer()); } });
    const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'SLOT_OCCUPIED' });
    expect(await h.inspect()).toEqual(before);
  });
  it('preserves an orphan generation1 instead of overwriting it, even if its text is identical', async () => {
    const h = await harness(); await h.put('snapshots', generation()); const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await h.inspect()).toEqual(before); await expect(h.repository.loadSlot(slotId)).rejects.toMatchObject({ code: 'SLOT_EMPTY' });
  });
  it('reuses only an exact preexisting backup and preserves it when a later stage aborts', async () => {
    let fail = true; const h = await harness({ faultInjector: stage => { if (fail && stage === 'after-snapshot') throw new Error('Synthetic interruption'); } });
    await h.put('migrationSources', backup()); const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' }); expect(await h.inspect()).toEqual(before);
    fail = false; const receipt = await h.repository.commitV9Copy(copyOptions()); expect(receipt.sourceBackup).toEqual(backup());
    expect((await h.inspect()).migrationSources).toEqual([backup()]);
  });
  it('rejects a differently formatted backup with the same checksum', async () => {
    const h = await harness(); const other = JSON.stringify(JSON.parse(sourceText));
    expect(other).not.toBe(sourceText); expect(JSON.parse(other).checksum).toBe(JSON.parse(sourceText).checksum);
    await h.put('migrationSources', backup(other)); const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'SOURCE_BACKUP_CONFLICT' });
    expect(await h.inspect()).toEqual(before);
  });
  it('rejects different fully valid v9 source envelopes with a genuine FNV checksum collision', async () => {
    // Construct two safe Unicode buildId values whose canonical prefix hash is
    // identical. Their remaining canonical source envelope suffix is identical,
    // so both independently validated old envelopes have the same real checksum.
    const initial = hashText('{"buildId":"'); const seen = new Map<number, { first: number; hash: number }>();
    let ids: [string, string] | undefined;
    const safe = (code: number) => code >= 0x100 && code < 0xd800;
    for (let first = 0x100; first < 0xd800 && !ids; first++) {
      const hash = Math.imul(initial ^ first, 16777619) >>> 0; const upper = hash >>> 16; const prior = seen.get(upper);
      if (prior) {
        for (let low = 0x100; low < 0xd800; low++) {
          const left = (prior.hash & 0xffff) ^ low; const right = (hash & 0xffff) ^ low;
          if (safe(left) && safe(right)) { ids = [String.fromCharCode(prior.first, left), String.fromCharCode(first, right)]; break; }
        }
      } else seen.set(upper, { first, hash });
    }
    if (!ids) throw new Error('Could not construct the fixed synthetic checksum collision');
    const base = JSON.parse(sourceText) as Record<string, unknown>; const { checksum: _checksum, ...body } = base;
    const leftBody = { ...body, buildId: ids[0] }; const rightBody = { ...body, buildId: ids[1] };
    expect(ids[0]).not.toBe(ids[1]); expect(stableHash(leftBody)).toBe(stableHash(rightBody));
    const left = JSON.stringify({ ...leftBody, checksum: stableHash(leftBody) }); const right = JSON.stringify({ ...rightBody, checksum: stableHash(rightBody) });
    expect(parseSaveV9(left).ok).toBe(true); expect(parseSaveV9(right).ok).toBe(true);
    const h = await harness(); await h.put('migrationSources', backup(right)); const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions({ sourceText: left, targetText: migrationTarget(left) }))).rejects.toMatchObject({ code: 'SOURCE_BACKUP_CONFLICT' });
    expect(await h.inspect()).toEqual(before);
  });
  it.each(['version', 'extra', 'target', 'text'] as const)('preserves and rejects an unrecognized migration source record: %s', async changed => {
    const h = await harness(); const invalid = { ...backup(), ...(changed === 'version' ? { recordVersion: 2 } : changed === 'extra' ? { futureField: true }
      : changed === 'target' ? { targetSlotId: 'campaign-2' } : { sourceText: 123 }) };
    await h.put('migrationSources', invalid); const before = await h.inspect();
    await expect(h.repository.commitV9Copy(copyOptions())).rejects.toMatchObject({ code: 'STORAGE_SCHEMA_INVALID' });
    expect(await h.inspect()).toEqual(before);
  });
  it('captures options before asynchronous writes so callers cannot replace the prepared input', async () => {
    const h = await harness(); const options = copyOptions(); const promise = h.repository.commitV9Copy(options);
    options.sourceText = '{broken'; options.targetText = unrelatedText; options.ownerId = 'swapped'; options.targetSlotId = 'campaign-2';
    const receipt = await promise; expect(receipt.sourceBackup).toEqual(backup()); expect(receipt.snapshot.text).toBe(targetText);
    expect(receipt.slot.slotId).toBe(slotId); expect(receipt.lease.ownerId).toBe('migration-owner');
  });
  it('leaves the separate v9 database, both old slots, pointers, leases and exact texts untouched on success and abort', async () => {
    const indexedDB = new FakeIDBFactory(); const old = await openSaveRepository({ indexedDB, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9', now: () => 1000 });
    repositories.push(old); const first = await old.importSave(sourceText, { ownerId: 'old-first' });
    await old.importSave(sourceText, { ownerId: 'old-second' }); const oldBefore = await inspect(indexedDB, MANAGEMENT_V9_DATABASE_NAME);
    let fail = false; const h = await harness({ indexedDB, faultInjector: stage => { if (fail && stage === 'after-pointer') throw new Error('Synthetic target failure'); } });
    const open = vi.spyOn(indexedDB, 'open');
    await h.repository.commitV9Copy(copyOptions()); expect(open).not.toHaveBeenCalled();
    expect(await inspect(indexedDB, MANAGEMENT_V9_DATABASE_NAME)).toEqual(oldBefore);
    const targetBefore = await h.inspect(); fail = true;
    await expect(h.repository.commitV9Copy(copyOptions({ targetSlotId: 'campaign-2' }))).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' });
    expect(await h.inspect()).toEqual(targetBefore); expect(await inspect(indexedDB, MANAGEMENT_V9_DATABASE_NAME)).toEqual(oldBefore);
    expect(await old.exportRawSnapshot(slotId, first.snapshot.id)).toBe(sourceText);
    const db = await request(indexedDB.open(MANAGEMENT_V9_DATABASE_NAME)); expect([...db.objectStoreNames]).toEqual(['leases', 'slots', 'snapshots']); db.close();
  });
});
