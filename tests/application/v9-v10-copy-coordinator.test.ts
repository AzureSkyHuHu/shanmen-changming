import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementSaveControllerV9 } from '../../src/application/management-v9-save-controller';
import { ApplicationSessionV9, type SessionValueV9 } from '../../src/application/session-v9';
import { ApplicationSessionV10, type SessionValueV10 } from '../../src/application/session-v10';
import { V9V10CopyCoordinator, V9V10CopyHost, type V9V10CopyOptions } from '../../src/application/v9-v10-copy-coordinator';
import { parseSaveV9 } from '../../src/core/kernel/save-v9';
import { parseSaveV10, serializeSaveV10 } from '../../src/core/kernel/save-v10';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { prepareV9ToV10Migration } from '../../src/core/world/migrate-v9-to-v10';
import { IndexedDbManagementV10Repository, openManagementV10Repository } from '../../src/platform/persistence/indexeddb-management-v10-repository';
import { IndexedDbSaveRepository } from '../../src/platform/persistence/indexeddb-save-repository';
import { MANAGEMENT_V10_DATABASE_NAME, ManagementV10PersistenceError, managementV10PersistenceErrorCode,
  type ManagementV10RepositoryOptions } from '../../src/platform/persistence/management-v10-types';
import { MANAGEMENT_V9_DATABASE_NAME } from '../../src/platform/persistence/types';

const metadata = { buildId: 'internal-copy-test', savedAt: '2026-10-02T22:00:00Z' };
const options: V9V10CopyOptions = { targetSlotId: 'campaign-1', ownerId: 'v10-host-owner', metadata };
const sessions: ApplicationSessionV9[] = [];
const controllers: ManagementSaveControllerV9[] = [];
const repositories: IndexedDbManagementV10Repository[] = [];
const hosts: V9V10CopyHost[] = [];
function value<T>(result: SessionValueV9<T> | SessionValueV10<T>): T {
  if (!result.ok) throw new Error('Expected real Session success'); return result.value;
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
}
async function inspect(indexedDB: IDBFactory, name: string) {
  const database = await request(indexedDB.open(name));
  try {
    const transaction = database.transaction([...database.objectStoreNames], 'readonly'); const done = completed(transaction);
    const rows = Object.fromEntries(await Promise.all([...database.objectStoreNames].map(async store => [store, await request<unknown[]>(transaction.objectStore(store).getAll())])));
    await done; return rows;
  } finally { database.close(); }
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function harness(configuration: ManagementV10RepositoryOptions = {}, sourceWorld = createUnregisteredWorldV9('live-source')) {
  const indexedDB = new IDBFactory(); const session = new ApplicationSessionV9(sourceWorld); sessions.push(session);
  const source = new ManagementSaveControllerV9(session, { indexedDB, now: () => 1000 }); controllers.push(source); await source.start();
  const repository = await openManagementV10Repository({ indexedDB, now: () => 1000, ...configuration }); repositories.push(repository);
  const host = new V9V10CopyHost(source); hosts.push(host);
  const coordinator = new V9V10CopyCoordinator(host, repository);
  return { indexedDB, session, source, repository, host, coordinator,
    oldRows: () => inspect(indexedDB, MANAGEMENT_V9_DATABASE_NAME), targetRows: () => inspect(indexedDB, MANAGEMENT_V10_DATABASE_NAME) };
}
afterEach(async () => {
  // Restore injected cleanup faults before tearing down real owned resources.
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  for (const source of controllers.splice(0)) source.stop();
  for (const session of sessions.splice(0)) session.close();
  for (const repository of repositories.splice(0)) repository.close();
});

describe('internal v9 to v10 copy coordinator', () => {
  it('preallocates before the real transaction, copies the exact fresh dirty source, binds once after completion and retains old saves', async () => {
    let transactionComplete = false;
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage === 'after-pointer') transaction.addEventListener('complete', () => { transactionComplete = true; });
    } });
    await h.source.save('campaign-1'); const old = await h.oldRows();
    expect(h.session.setSpeed(3).ok).toBe(true); expect(h.session.setPaused('hidden', true).ok).toBe(true);
    const live = value(h.session.exportWorld()); const originalExport = h.session.exportSave.bind(h.session);
    vi.spyOn(h.session, 'exportSave').mockImplementation(meta => {
      const result = originalExport(meta); return result.ok ? { ok: true, value: `\r\n\t${result.value} \n` } : result;
    });
    const begin = vi.spyOn(h.source, 'beginV10CopySource'); const finish = vi.spyOn(h.source, 'finishV10CopySource');
    const prepare = vi.spyOn(ApplicationSessionV10, 'prepareSession'); const commit = vi.spyOn(h.repository, 'commitV9Copy');
    const bindReal = ApplicationSessionV10.bindPreparedSession;
    const bind = vi.spyOn(ApplicationSessionV10, 'bindPreparedSession').mockImplementation(token => {
      expect(transactionComplete).toBe(true); return bindReal(token);
    });
    const result = await h.coordinator.copy(options);
    expect(result).toMatchObject({ kind: 'committed-and-bound', committed: true, cleanup: [] });
    if (result.kind !== 'committed-and-bound') throw new Error('Expected binding');
    expect(h.host.getBoundTarget()).toBe(result.binding); expect(result.binding.repository).toBe(h.repository);
    expect(prepare).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1); expect(bind).toHaveBeenCalledTimes(1);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]!);
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(bind.mock.invocationCallOrder[0]!);
    expect(bind.mock.invocationCallOrder[0]).toBeLessThan(finish.mock.invocationCallOrder[0]!);
    const acquired = begin.mock.results[0]!.value as ReturnType<ManagementSaveControllerV9['beginV10CopySource']>;
    if (!acquired.ok) throw new Error('Expected held source');
    expect(commit.mock.calls[0]![0].signal).toBe(acquired.token.signal);
    expect(result.receipt.sourceBackup.sourceText).toBe(acquired.token.sourceText);
    expect(result.receipt.sourceBackup.sourceText.startsWith('\r\n\t')).toBe(true);
    expect(await h.repository.exportMigrationSource('campaign-1')).toBe(acquired.token.sourceText);
    const parsed = parseSaveV9(acquired.token.sourceText); expect(parsed.ok).toBe(true); if (parsed.ok) expect(parsed.world).toEqual(live);
    const expected = prepareV9ToV10Migration(acquired.token.sourceText, metadata); if (!expected.ok) throw new Error('Expected pure migration');
    expect(value(result.binding.session.exportWorld())).toEqual(expected.world);
    expect(result.binding.session.getSnapshot()).toMatchObject({ holds: { staging: false }, frame: { clock: { speed: 3, pauseReasons: ['hidden'] } } });
    const after = await h.oldRows(); expect(after.slots).toEqual(old.slots); expect(after.snapshots).toEqual(old.snapshots);
    expect(h.source.getSnapshot()).toMatchObject({ busy: false, readOnly: true });
    // Existing v9 hold release reconciles its live hidden pause to the current
    // visible foreground. The held backup and target above stay exact.
    expect(value(h.session.exportWorld())).toEqual({ ...live, clock: { ...live.clock, pauseReasons: [] } });
    const prepared = prepare.mock.results[0]!.value as ReturnType<typeof ApplicationSessionV10.prepareSession>;
    if (!prepared.ok) throw new Error('Expected prepared Session');
    expect(ApplicationSessionV10.bindPreparedSession(prepared.value)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    expect(ApplicationSessionV10.discardPreparedSession(prepared.value)).toMatchObject({ ok: false, code: 'REPLACEMENT_STALE' });
    expect(await h.source.finishV10CopySource(acquired.token, 'bound')).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', reason: { code: 'HOST_ALREADY_BOUND' } });
  });

  it('rejects invalid current export before target preparation or transaction and keeps the old source writable', async () => {
    const h = await harness(); await h.source.save('campaign-1'); const old = await h.oldRows();
    vi.spyOn(h.session, 'exportSave').mockReturnValueOnce({ ok: true, value: '{invalid' });
    const prepare = vi.spyOn(ApplicationSessionV10, 'prepareSession'); const write = vi.spyOn(h.repository, 'commitV9Copy');
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', committed: false, reason: { code: 'SOURCE_REJECTED', sourceCode: 'EXPORT_FAILED' } });
    expect(prepare).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(await h.oldRows()).toEqual(old);
    expect(h.source.getSnapshot()).toMatchObject({ readOnly: false, busy: false }); expect(h.session.setSpeed(3).ok).toBe(true);
  });

  it('rejects a fully valid active automatic-work source through the unchanged quiet boundary', async () => {
    const world = createUnregisteredWorldV9('active-source'); world.sectEconomy.enabled = true;
    const h = await harness({}, world); const before = value(h.session.exportWorld()); const rows = await h.targetRows();
    const prepare = vi.spyOn(ApplicationSessionV10, 'prepareSession'); const write = vi.spyOn(h.repository, 'commitV9Copy');
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', reason: { code: 'MIGRATION_REJECTED',
      issues: expect.arrayContaining([{ code: 'AUTOMATIC_WORK_ENABLED', path: 'sectEconomy.enabled' }]) }, cleanup: [] });
    expect(prepare).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(await h.targetRows()).toEqual(rows);
    expect(value(h.session.exportWorld())).toEqual(before); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });

  it('refuses read-only source and malformed request without obtaining target authority', async () => {
    const h = await harness(); const begin = vi.spyOn(h.source, 'beginV10CopySource'); const write = vi.spyOn(h.repository, 'commitV9Copy');
    let getterReads = 0; const hostile = Object.defineProperty({}, 'metadata', { enumerable: true, get() { getterReads++; throw new Error('Do not invoke'); } });
    expect(await h.coordinator.copy(hostile as V9V10CopyOptions)).toMatchObject({ kind: 'rejected', reason: { code: 'INVALID_REQUEST' } });
    expect(getterReads).toBe(0); expect(begin).not.toHaveBeenCalled();
    expect(h.session.setStorageReadOnly(true).ok).toBe(true);
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', reason: { code: 'SOURCE_REJECTED', sourceCode: 'READ_ONLY_SOURCE' } });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps source and target preimages unchanged when prepared target allocation fails', async () => {
    const h = await harness(); await h.source.save('campaign-1'); const old = await h.oldRows(); const target = await h.targetRows();
    vi.spyOn(ApplicationSessionV10, 'prepareSession').mockReturnValueOnce({ ok: false, kind: 'session-rejection', code: 'COUNTER_EXHAUSTED' });
    const write = vi.spyOn(h.repository, 'commitV9Copy');
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', reason: { code: 'PREPARATION_REJECTED' }, cleanup: [] });
    expect(write).not.toHaveBeenCalled(); expect(await h.oldRows()).toEqual(old); expect(await h.targetRows()).toEqual(target);
    expect(h.session.setSpeed(3).ok).toBe(true);
  });

  it('preserves an occupied target and discards the unbound candidate without releasing the old writer', async () => {
    const h = await harness(); await h.source.save('campaign-1');
    const migration = prepareV9ToV10Migration(value(h.session.exportSave(metadata)), metadata); if (!migration.ok) throw new Error('Expected pure migration');
    await h.repository.importSave(serializeSaveV10(migration.envelope), { mode: 'new-slot', slotId: 'campaign-1', ownerId: 'existing-owner' });
    const target = await h.targetRows(); const old = await h.oldRows(); const discard = vi.spyOn(ApplicationSessionV10, 'discardPreparedSession');
    const bind = vi.spyOn(ApplicationSessionV10, 'bindPreparedSession'); const finish = vi.spyOn(h.source, 'finishV10CopySource');
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', reason: { code: 'STORAGE_REJECTED', storageCode: 'SLOT_OCCUPIED' }, cleanup: [] });
    expect(discard).toHaveBeenCalledTimes(1); expect(bind).not.toHaveBeenCalled(); expect(finish.mock.calls[0]![1]).toBe('failed');
    expect(await h.targetRows()).toEqual(target); expect(await h.oldRows()).toEqual(old); expect(h.source.canSave('campaign-1')).toBe(true);
  });

  it.each(['quota', 'abort'] as const)('rejects real target %s transaction failure without a bind or misleading rollback', async failure => {
    const h = await harness({ faultInjector: (stage, transaction) => { if (failure === 'abort' && stage === 'after-pointer') transaction.abort(); } });
    await h.source.save('campaign-1'); const old = await h.oldRows(); const target = await h.targetRows(); const live = value(h.session.exportWorld());
    if (failure === 'quota') {
      const add = FakeIDBObjectStore.prototype.add;
      vi.spyOn(FakeIDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, input, key) {
        if (this.name === 'migrationSources') throw new DOMException('Synthetic quota', 'QuotaExceededError'); return add.call(this, input, key);
      });
    }
    const discard = vi.spyOn(ApplicationSessionV10, 'discardPreparedSession'); const bind = vi.spyOn(ApplicationSessionV10, 'bindPreparedSession');
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', committed: false, reason: { code: 'STORAGE_REJECTED', storageCode: failure === 'quota' ? 'QUOTA_EXCEEDED' : 'TRANSACTION_FAILED' }, cleanup: [] });
    expect(discard).toHaveBeenCalledTimes(1); expect(bind).not.toHaveBeenCalled();
    expect(await h.oldRows()).toEqual(old); expect(await h.targetRows()).toEqual(target); expect(value(h.session.exportWorld())).toEqual(live);
    expect(h.source.canSave('campaign-1')).toBe(true);
  });

  it('carries source cancellation into a delayed real commit, fences a replaced Session and rejects overlapping copies', async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred(); const original = h.repository.commitV9Copy.bind(h.repository);
    const target = await h.targetRows(); const begin = vi.spyOn(h.source, 'beginV10CopySource');
    vi.spyOn(h.repository, 'commitV9Copy').mockImplementation(async input => { entered.resolve(); await gate.promise; return original(input); });
    const pending = h.coordinator.copy(options); await entered.promise;
    expect(h.session.getSnapshot().holds.storageBusy).toBe(true); expect(h.session.setSpeed(3).ok).toBe(false);
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', reason: { code: 'COPY_BUSY' } });
    expect(await new V9V10CopyCoordinator(h.host, h.repository).copy(options)).toMatchObject({ kind: 'rejected', reason: { code: 'COPY_BUSY' } });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(h.session.replaceWorld(createUnregisteredWorldV9('new-live-source')).ok).toBe(true);
    const acquired = begin.mock.results[0]!.value as ReturnType<ManagementSaveControllerV9['beginV10CopySource']>;
    if (!acquired.ok) throw new Error('Expected source token'); expect(acquired.token.signal.aborted).toBe(true);
    gate.resolve(); expect(await pending).toMatchObject({ kind: 'rejected', reason: { code: 'SOURCE_STALE' }, cleanup: [] });
    expect(await h.targetRows()).toEqual(target); expect(value(h.session.exportWorld()).seed).toBe('new-live-source');
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(h.host.getBoundTarget()).toBeNull();
  });

  it.each(['close', 'generation'] as const)('reports durable-but-unbound on host %s at real transaction completion and leaves reloadable target', async change => {
    let invalidate = () => {};
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage === 'after-pointer') transaction.addEventListener('complete', () => invalidate());
    } });
    await h.source.save('campaign-1'); const old = await h.oldRows(); const live = value(h.session.exportWorld());
    invalidate = change === 'close' ? () => { void h.host.close(); } : () => { expect(h.host.replaceSource(h.source)).toBe(true); };
    const discard = vi.spyOn(ApplicationSessionV10, 'discardPreparedSession'); const bind = vi.spyOn(ApplicationSessionV10, 'bindPreparedSession');
    const release = vi.spyOn(h.repository, 'releaseLease'); const finish = vi.spyOn(h.source, 'finishV10CopySource');
    const result = await h.coordinator.copy(options);
    expect(result).toMatchObject({ kind: 'committed-not-bound', committed: true, reason: { code: change === 'close' ? 'HOST_CLOSED' : 'HOST_CHANGED' }, cleanup: [] });
    if (result.kind !== 'committed-not-bound') throw new Error('Expected durable unbound result');
    expect(discard).toHaveBeenCalledTimes(1); expect(bind).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledExactlyOnceWith(result.receipt.lease);
    expect(finish).toHaveBeenCalledTimes(1); expect(finish.mock.calls[0]![1]).toBe('cancelled');
    expect(h.host.getBoundTarget()).toBeNull(); expect(await h.oldRows()).toEqual(old); expect(value(h.session.exportWorld())).toEqual(live);
    expect(h.source.canSave('campaign-1')).toBe(true); expect(h.session.setSpeed(3).ok).toBe(true);
    expect((await h.repository.loadSlot('campaign-1')).snapshot.text).toBe(result.receipt.snapshot.text);
    expect(await h.repository.exportMigrationSource('campaign-1')).toBe(result.receipt.sourceBackup.sourceText);
    h.repository.close(); const reopened = await openManagementV10Repository({ indexedDB: h.indexedDB, now: () => 1000 }); repositories.push(reopened);
    const loaded = await reopened.loadSlot('campaign-1'); expect(parseSaveV10(loaded.snapshot.text).ok).toBe(true);
    expect(await reopened.acquireLease('campaign-1', 'reload-owner')).toMatchObject({ ownerId: 'reload-owner', epoch: 2 });
  });

  it('checks the actual source again after durable commit and preserves a replacement instead of binding the old generation', async () => {
    let replace = () => {};
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage === 'after-pointer') transaction.addEventListener('complete', () => replace());
    } });
    replace = () => { expect(h.session.replaceWorld(createUnregisteredWorldV9('new-after-commit')).ok).toBe(true); };
    const bind = vi.spyOn(ApplicationSessionV10, 'bindPreparedSession'); const finish = vi.spyOn(h.source, 'finishV10CopySource');
    const result = await h.coordinator.copy(options);
    expect(result).toMatchObject({ kind: 'committed-not-bound', reason: { code: 'SOURCE_STALE' }, cleanup: [] });
    expect(bind).not.toHaveBeenCalled(); expect(finish.mock.calls[0]![1]).toBe('failed');
    expect(value(h.session.exportWorld()).seed).toBe('new-after-commit'); expect(h.source.getSnapshot().readOnly).toBe(false);
    expect((await h.repository.loadSlot('campaign-1')).world.seed).toBe('live-source');
  });

  it('discards a candidate on refused one-use binding, keeps durable data and leaves the source usable', async () => {
    const h = await harness(); const bind = vi.spyOn(ApplicationSessionV10, 'bindPreparedSession').mockReturnValueOnce({ ok: false, kind: 'session-rejection', code: 'REPLACEMENT_STALE' });
    const discard = vi.spyOn(ApplicationSessionV10, 'discardPreparedSession'); const finish = vi.spyOn(h.source, 'finishV10CopySource');
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'committed-not-bound', committed: true, reason: { code: 'BIND_REJECTED' }, cleanup: [] });
    expect(bind).toHaveBeenCalledTimes(1); expect(discard).toHaveBeenCalledTimes(1); expect(finish.mock.calls[0]![1]).toBe('failed');
    expect(h.host.getBoundTarget()).toBeNull(); expect(h.session.setSpeed(3).ok).toBe(true); expect((await h.repository.loadSlot('campaign-1')).world.seed).toBe('live-source');
  });

  it('reports source lease cleanup failure separately after successful durable commit and bind', async () => {
    const h = await harness(); await h.source.save('campaign-1');
    vi.spyOn(IndexedDbSaveRepository.prototype, 'releaseLease').mockRejectedValueOnce(new Error('Synthetic source cleanup failure'));
    const result = await h.coordinator.copy(options);
    expect(result).toMatchObject({ kind: 'committed-and-bound', committed: true, cleanup: ['SOURCE_LEASE_RELEASE_FAILED'] });
    expect(h.host.getBoundTarget()).not.toBeNull(); expect(h.source.getSnapshot()).toMatchObject({ busy: false, readOnly: true });
    expect((await h.repository.loadSlot('campaign-1')).slot.revision).toBe(1);
  });

  it('reports unbound target lease cleanup failure without losing the durable receipt or old source', async () => {
    let close = () => {};
    const h = await harness({ faultInjector: (stage, transaction) => {
      if (stage === 'after-pointer') transaction.addEventListener('complete', () => close());
    } });
    close = () => { void h.host.close(); }; await h.source.save('campaign-1'); const old = await h.oldRows();
    vi.spyOn(h.repository, 'releaseLease').mockRejectedValueOnce(new Error('Synthetic target cleanup failure'));
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'committed-not-bound', committed: true,
      reason: { code: 'HOST_CLOSED' }, cleanup: ['TARGET_LEASE_RELEASE_FAILED'] });
    expect(await h.oldRows()).toEqual(old); expect(h.source.canSave('campaign-1')).toBe(true);
    expect((await h.repository.loadSlot('campaign-1')).slot.revision).toBe(1);
  });

  it('transfers target teardown to the host exactly once and preserves its committed snapshot and backup', async () => {
    const h = await harness(); const result = await h.coordinator.copy(options);
    if (result.kind !== 'committed-and-bound') throw new Error('Expected binding');
    const release = vi.spyOn(h.repository, 'releaseLease'); const close = vi.spyOn(result.binding.session, 'close');
    const first = h.host.close(); expect(h.host.close()).toBe(first); expect(await first).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledExactlyOnceWith(result.receipt.lease);
    expect(result.binding.session.getSnapshot().closed).toBe(true); expect(h.host.getBoundTarget()).toBeNull();
    expect((await h.repository.loadSlot('campaign-1')).snapshot.text).toBe(result.receipt.snapshot.text);
    expect(await h.repository.exportMigrationSource('campaign-1')).toBe(result.receipt.sourceBackup.sourceText);
  });

  it.each([false, true])('reports closed-after-bind during delayed real source cleanup without double target release (cleanup fault %s)', async failCleanup => {
    const h = await harness(); await h.source.save('campaign-1'); const old = await h.oldRows();
    const entered = deferred(); const gate = deferred(); const releaseSource = IndexedDbSaveRepository.prototype.releaseLease;
    vi.spyOn(IndexedDbSaveRepository.prototype, 'releaseLease').mockImplementation(async function (this: IndexedDbSaveRepository, lease) {
      entered.resolve(); await gate.promise; return releaseSource.call(this, lease);
    });
    const finish = vi.spyOn(h.source, 'finishV10CopySource'); const releaseTarget = vi.spyOn(h.repository, 'releaseLease');
    if (failCleanup) releaseTarget.mockRejectedValueOnce(new Error('Synthetic host teardown failure'));
    const pending = h.coordinator.copy(options); await entered.promise;
    const bound = h.host.getBoundTarget(); if (!bound) throw new Error('Target must actually bind before source cleanup');
    const close = vi.spyOn(bound.session, 'close'); await h.host.close(); gate.resolve();
    expect(await pending).toMatchObject({ kind: 'committed-not-bound', committed: true, bindingState: 'closed-after-bind',
      reason: { code: 'HOST_CLOSED' }, cleanup: failCleanup ? ['TARGET_LEASE_RELEASE_FAILED'] : [] });
    expect(finish).toHaveBeenCalledTimes(1); expect(finish.mock.calls[0]![1]).toBe('bound');
    expect(releaseTarget).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
    expect(bound.session.getSnapshot().closed).toBe(true); expect(h.source.getSnapshot().readOnly).toBe(true);
    const after = await h.oldRows(); expect(after.slots).toEqual(old.slots); expect(after.snapshots).toEqual(old.snapshots);
    expect((await h.repository.loadSlot('campaign-1')).snapshot.text).toBe(bound.receipt.snapshot.text);
    expect(await h.repository.exportMigrationSource('campaign-1')).toBe(bound.receipt.sourceBackup.sourceText);
  });

  it('guards option reflection reentrancy and never inspects an arbitrary thrown error', async () => {
    const h = await harness(); let nested: ReturnType<V9V10CopyCoordinator['copy']> | null = null; let errorReads = 0;
    const hostileError = new Proxy({}, { get() { errorReads++; throw null; }, getPrototypeOf() { errorReads++; throw null; }, ownKeys() { errorReads++; throw null; } });
    const hostile = new Proxy(options, { ownKeys() { nested = h.coordinator.copy(options); throw hostileError; } });
    const begin = vi.spyOn(h.source, 'beginV10CopySource');
    expect(await h.coordinator.copy(hostile)).toMatchObject({ kind: 'rejected', reason: { code: 'INVALID_REQUEST' } });
    expect(await nested).toMatchObject({ kind: 'rejected', reason: { code: 'COPY_BUSY' } }); expect(begin).not.toHaveBeenCalled();
    vi.spyOn(h.repository, 'commitV9Copy').mockRejectedValueOnce(hostileError);
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'rejected', reason: { code: 'INTERNAL_FAILURE' }, cleanup: [] });
    expect(errorReads).toBe(0); expect(h.session.setSpeed(3).ok).toBe(true);
  });

  it('recognizes only module-owned storage error codes without reading hostile or forged diagnostics', () => {
    let reads = 0; const hostile = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; }, ownKeys() { reads++; throw null; } });
    expect(managementV10PersistenceErrorCode(hostile)).toBeNull();
    expect(managementV10PersistenceErrorCode({ code: 'QUOTA_EXCEEDED', name: 'ManagementV10PersistenceError' })).toBeNull();
    const owned = new ManagementV10PersistenceError('QUOTA_EXCEEDED', 'Owned diagnostic');
    Object.defineProperty(owned, 'code', { get() { reads++; throw null; } });
    expect(managementV10PersistenceErrorCode(owned)).toBe('QUOTA_EXCEEDED'); expect(reads).toBe(0);
    expect(managementV10PersistenceErrorCode(null)).toBeNull(); expect(managementV10PersistenceErrorCode('QUOTA_EXCEEDED')).toBeNull();
  });
});
