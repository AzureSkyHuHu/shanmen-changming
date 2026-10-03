import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementSaveControllerV10, type ImportConfirmationV10 } from '../../src/application/management-v10-save-controller';
import { ApplicationSessionV10 } from '../../src/application/session-v10';
import { createSaveEnvelopeV10, parseSaveV10, serializeSaveV10 } from '../../src/core/kernel/save-v10';
import { createSaveEnvelopeV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { IndexedDbManagementV10Repository, openManagementV10Repository } from '../../src/platform/persistence/indexeddb-management-v10-repository';
import { MANAGEMENT_V10_DATABASE_NAME, type ManagementV10RepositoryOptions, type SnapshotRecord } from '../../src/platform/persistence/management-v10-types';

const metadata = { buildId: 'old-file-metadata', savedAt: '2026-01-01T00:00:00Z' };
const slot = 'campaign-1' as const;
const controllers: ManagementSaveControllerV10[] = [];
const sessions: ApplicationSessionV10[] = [];
const repositories: IndexedDbManagementV10Repository[] = [];
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function request<T>(operation: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); }); }
function completion(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); }); }
function text(seed = 'import-v10') { return `\n ${serializeSaveV10(createSaveEnvelopeV10(createUnregisteredWorldV10(seed), metadata))}\n`; }
const file = (value: string) => ({ name: 'private-v10.json', size: value.length, text: async () => value });
function world(session: ApplicationSessionV10) { const exported = session.exportWorld(); if (!exported.ok) throw new Error('World export failed'); return exported.value; }
function session(seed = 'live-v10') { const result = new ApplicationSessionV10(createUnregisteredWorldV10(seed)); sessions.push(result); return result; }
async function harness(extra: ManagementV10RepositoryOptions = {}) {
  const indexedDB = new IDBFactory(); let now = 1000;
  const options = { indexedDB, now: () => now, ...extra }; const live = session();
  const controller = new ManagementSaveControllerV10(live, options); controllers.push(controller); await controller.start();
  const repo = await openManagementV10Repository(options); repositories.push(repo);
  const inspect = async () => {
    const db = await request(indexedDB.open(MANAGEMENT_V10_DATABASE_NAME));
    try { const names = ['slots', 'snapshots', 'leases', 'migrationSources']; const tx = db.transaction(names, 'readonly'); const done = completion(tx);
      const [slots, snapshots, leases, migrationSources] = await Promise.all(names.map(name => request<unknown[]>(tx.objectStore(name).getAll())));
      await done; return { slots, snapshots, leases, migrationSources };
    } finally { db.close(); }
  };
  const mutate = async (id: string, change: (row: SnapshotRecord) => SnapshotRecord) => {
    const db = await request(indexedDB.open(MANAGEMENT_V10_DATABASE_NAME));
    try { const tx = db.transaction('snapshots', 'readwrite'); const done = completion(tx); const store = tx.objectStore('snapshots');
      const row = await request<SnapshotRecord>(store.get(id)); await request(store.put(change(row))); await done;
    } finally { db.close(); }
  };
  return { controller, session: live, repo, indexedDB, options, inspect, mutate, setNow(value: number) { now = value; } };
}
async function select(controller: ManagementSaveControllerV10, value = text(), target: 'campaign-1' | 'campaign-2' | 'campaign-3' = slot): Promise<ImportConfirmationV10> {
  expect(await controller.selectImportFile(file(value))).toBe(true); expect(controller.selectImportTarget(target)).toBe(true);
  const current = controller.getSnapshot().import;
  return { selectionId: current.selectionId, slotId: target, expectedRevision: current.target!.revision,
    overwriteConfirmed: current.target!.occupied, replaceDirtyConfirmed: true };
}
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.stop()));
  for (const live of sessions.splice(0)) live.close(); for (const repo of repositories.splice(0)) repo.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('private normal v10 save lifecycle', () => {
  it('opens only the fixed v10 database without auto-load; round trips the exact runtime and keeps selection clean', async () => {
    const h = await harness();
    expect((await h.indexedDB.databases()).map(db => db.name)).toEqual([MANAGEMENT_V10_DATABASE_NAME]);
    expect(h.controller.getSnapshot()).toMatchObject({ mode: 'browser', dirty: true, boundSlot: null, autosave: 'manual-only' });
    expect(await h.controller.save(slot)).toBe(true);
    h.session.select({ kind: 'disciple', id: 'entity:1' }); expect(h.controller.getSnapshot().dirty).toBe(false);
    h.session.frame(0); h.session.frame(50); expect(h.controller.getSnapshot().dirty).toBe(true);
    expect(await h.controller.save(slot)).toBe(true); const saved = world(h.session);
    expect(h.session.frame(100)).toEqual({ ok: true, value: 0 }); // Storage hold release resets the wall-time baseline.
    expect(h.session.frame(150)).toEqual({ ok: true, value: 1 });
    expect(world(h.session).clock.simulationTick).toBe(saved.clock.simulationTick + 1);
    expect(h.controller.getSnapshot().dirty).toBe(true);
    const review = h.controller.reviewLoad(slot)!;
    expect(review).toMatchObject({ expectedRevision: 2, dirty: true });
    expect(await h.controller.load(review)).toBe(false); expect(world(h.session).clock.simulationTick).toBe(2);
    expect(await h.controller.load(review, true)).toBe(true); expect(world(h.session)).toEqual(saved);
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(h.session.getSnapshot().frame.clock.pauseReasons).toEqual(saved.clock.pauseReasons);
    expect(h.controller.getSnapshot()).toMatchObject({ dirty: false, readOnly: false, lastAction: 'loaded' });
    await h.controller.stop(); await h.controller.start();
    expect(h.controller.getSnapshot()).toMatchObject({ boundSlot: null, dirty: true }); expect(world(h.session)).toEqual(saved);
  });
  it('keeps exports available with no browser storage and never claims an in-memory save is durable', async () => {
    vi.stubGlobal('indexedDB', undefined); const live = session(); const controller = new ManagementSaveControllerV10(live); controllers.push(controller);
    await controller.start(); expect(controller.getSnapshot()).toMatchObject({ mode: 'unavailable', boundSlot: null });
    expect(await controller.save(slot)).toBe(false); expect(parseSaveV10(controller.exportCurrent().text).ok).toBe(true);
    expect(controller.getSnapshot().lastSavedAt).toBeNull();
  });
  it('prepares strict import before storage then binds once without changing original stored bytes or World pause reasons', async () => {
    const h = await harness(); await h.controller.save(slot); const original = text('exact-input'); const approval = await select(h.controller, original);
    const prepare = vi.spyOn(h.session, 'prepareReplacement'); const commit = vi.spyOn(h.session, 'commitReplacement');
    const write = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'importSave');
    expect(await h.controller.commitImport(approval)).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]!);
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]!);
    const loaded = await h.repo.loadSlot(slot); expect(loaded.snapshot.text).toBe(original); expect(world(h.session)).toEqual(loaded.world);
    expect(h.controller.getSnapshot()).toMatchObject({ boundSlot: slot, dirty: false, committed: { revision: 2, bound: true }, import: { phase: 'success' } });
    const exported = parseSaveV10(h.controller.exportCurrent().text); expect(exported.ok).toBe(true);
    if (exported.ok) { expect(exported.envelope.buildId).toBe('management-0.10.0'); expect(exported.envelope.savedAt).not.toBe(metadata.savedAt); expect(exported.world).toEqual(loaded.world); }
  });
  it('requires explicit dirty replacement and overwrite approval and rejects copied or stale load reviews', async () => {
    const h = await harness(); await h.controller.save(slot); h.session.frame(0); h.session.frame(50);
    const review = h.controller.reviewLoad(slot)!; const before = world(h.session);
    expect(await h.controller.load({ ...review }, true)).toBe(false);
    h.session.select({ kind: 'disciple', id: 'entity:1' }); expect(await h.controller.load(review, true)).toBe(false);
    const approval = await select(h.controller);
    expect(await h.controller.commitImport({ ...approval, replaceDirtyConfirmed: false })).toBe(false);
    expect(await h.controller.commitImport({ ...approval, overwriteConfirmed: false })).toBe(false);
    expect(world(h.session)).toEqual(before); expect((await h.repo.loadSlot(slot)).slot.revision).toBe(1);
  });
  it('rejects v9 and malformed/overlarge input before writing and has no implicit migration path', async () => {
    const h = await harness(); const before = await h.inspect();
    const old = serializeSaveV9(createSaveEnvelopeV9(createUnregisteredWorldV9(), metadata));
    expect(await h.controller.selectImportFile(file(old))).toBe(false);
    expect(h.controller.getSnapshot().import.notice).toBe('save.error.version');
    expect(await h.controller.selectImportFile(file('{broken'))).toBe(false);
    const read = vi.fn(async () => text());
    expect(await h.controller.selectImportFile({ name: 'large', size: 5 * 1024 * 1024, text: read })).toBe(false); expect(read).not.toHaveBeenCalled();
    expect(await h.inspect()).toEqual(before);
  });
  it('keeps unsupported source bytes exportable after refused load', async () => {
    const h = await harness(); await h.controller.save(slot);
    const raw = JSON.stringify({ saveVersion: 11, extension: true, payload: { future: true } });
    await h.mutate(`${slot}:1`, row => ({ ...row, text: raw }));
    const before = world(h.session); expect(await h.controller.load(h.controller.reviewLoad(slot)!, true)).toBe(false);
    expect(world(h.session)).toEqual(before); expect(h.controller.getSnapshot().rescue).toMatchObject({ slotId: slot, reason: 'unreadable' });
    expect((await h.controller.exportRawSnapshot(slot, `${slot}:1`))?.text).toBe(raw);
    expect(await h.controller.save(slot)).toBe(false); expect((await h.controller.exportRawSnapshot(slot, `${slot}:1`))?.text).toBe(raw);
    expect(h.controller.getSnapshot().readOnly).toBe(true);
  });
  it('loads a valid fallback read-only and preserves the corrupt current pointer and bytes', async () => {
    const h = await harness(); await h.controller.stop();
    const first = await h.repo.importSave(text('fallback'), { ownerId: 'setup', slotId: slot });
    await h.repo.saveText(slot, text('bad-current'), { expectedRevision: 1, lease: first.lease, kind: 'auto' });
    await h.repo.releaseLease(first.lease); await h.mutate(`${slot}:2`, row => ({ ...row, text: '{broken' }));
    await h.controller.start(); const before = await h.inspect();
    expect(await h.controller.load(h.controller.reviewLoad(slot)!, true)).toBe(true);
    expect(world(h.session).seed).toBe('fallback'); expect(h.session.getSnapshot().holds.storage).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({ readOnly: true, dirty: false, rescue: { reason: 'recovered' } });
    expect(h.controller.canSave(slot)).toBe(false); expect(await h.inspect()).toEqual(before);
    expect((await h.controller.exportRawSnapshot(slot, `${slot}:2`))?.text).toBe('{broken');
    const approval = await select(h.controller, text('fresh-target'), 'campaign-2');
    expect(await h.controller.commitImport(approval)).toBe(true); expect(h.session.getSnapshot().holds.storage).toBe(false);
    expect(h.controller.getSnapshot().readOnly).toBe(false); expect((await h.repo.loadSlot(slot)).slot.currentSnapshotId).toBe(`${slot}:2`);
  });
  it('handles an active competing writer by loading read-only and never offers takeover', async () => {
    const h = await harness(); const inserted = await h.repo.importSave(text('other-tab'), { ownerId: 'other', slotId: slot });
    await h.controller.refresh(); expect(await h.controller.load(h.controller.reviewLoad(slot)!, true)).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({ readOnly: true, notice: 'save.error.leaseBusy' }); expect(h.session.getSnapshot().holds.storage).toBe(true);
    expect(await h.controller.save(slot)).toBe(false); await h.repo.releaseLease(inserted.lease);
    expect(await h.controller.load(h.controller.reviewLoad(slot)!, true)).toBe(true);
    expect(h.controller.getSnapshot().readOnly).toBe(false); expect(h.session.getSnapshot().holds.storage).toBe(false);
  });
  it('renews ownership and fences expired leases without mutating the prior saved World', async () => {
    const h = await harness(); await h.controller.save(slot); h.setNow(5000); expect(await h.controller.renew()).toBe(true);
    h.setNow(25000); const other = await h.repo.acquireLease(slot, 'other'); const before = (await h.repo.loadSlot(slot)).snapshot.text;
    expect(await h.controller.renew()).toBe(false); expect(h.controller.getSnapshot()).toMatchObject({ readOnly: true, notice: 'save.error.leaseLost' });
    expect(h.session.getSnapshot().holds.storage).toBe(true); expect((await h.repo.loadSlot(slot)).snapshot.text).toBe(before);
    await h.repo.releaseLease(other);
  });
  it('fences expired ownership during explicit same-slot reload without overwriting the live World', async () => {
    const h = await harness(); await h.controller.save(slot);
    h.session.frame(0); h.session.frame(50); const live = world(h.session);
    const review = h.controller.reviewLoad(slot)!; const stored = (await h.repo.loadSlot(slot)).snapshot.text;
    h.setNow(20000); const other = await h.repo.acquireLease(slot, 'replacement-writer');
    expect(await h.controller.load(review, true)).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({ readOnly: true, notice: 'save.error.leaseLost' });
    expect(h.session.getSnapshot().holds.storage).toBe(true); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
    expect(h.controller.canSave(slot)).toBe(false); expect(await h.controller.save(slot)).toBe(false);
    expect(world(h.session)).toEqual(live); expect((await h.repo.loadSlot(slot)).snapshot.text).toBe(stored);
    await h.repo.releaseLease(other);
  });
  it('fails preparation before lease acquisition or durable writes and leaves the old binding intact', async () => {
    const h = await harness(); await h.controller.save(slot); const approval = await select(h.controller, text(), 'campaign-2');
    const before = await h.inspect(); const live = world(h.session);
    vi.spyOn(h.session, 'prepareReplacement').mockReturnValueOnce({ ok: false, kind: 'session-rejection', code: 'REPLACEMENT_STALE' });
    const acquire = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'acquireLease'); const write = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'importSave');
    expect(await h.controller.commitImport(approval)).toBe(false); expect(acquire).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(await h.inspect()).toEqual(before); expect(world(h.session)).toEqual(live); expect(h.controller.getSnapshot().boundSlot).toBe(slot);
  });
  it.each(['after-snapshot', 'after-pointer', 'after-prune'] as const)('rolls back %s failure and discards the prepared replacement', async stage => {
    let failing = false; const h = await harness({ faultInjector: reached => { if (failing && reached === stage) throw new Error('Injected'); } });
    await h.controller.save(slot); const approval = await select(h.controller); const before = await h.inspect(); const live = world(h.session);
    const discard = vi.spyOn(h.session, 'discardReplacement'); const commit = vi.spyOn(h.session, 'commitReplacement'); failing = true;
    expect(await h.controller.commitImport(approval)).toBe(false); expect(discard).toHaveBeenCalledTimes(1); expect(commit).not.toHaveBeenCalled();
    expect(await h.inspect()).toEqual(before); expect(world(h.session)).toEqual(live); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });
});

describe('v10 storage ownership, reentrancy and stale completion fences', () => {
  it('keeps the original writer and World when an unrelated reviewed target revision becomes stale', async () => {
    const h = await harness(); await h.controller.save(slot);
    const inserted = await h.repo.importSave(text('target'), { ownerId: 'other', slotId: 'campaign-2' }); await h.repo.releaseLease(inserted.lease);
    await h.controller.refresh(); const review = h.controller.reviewLoad('campaign-2')!; const before = world(h.session);
    const lease = await h.repo.acquireLease('campaign-2', 'other');
    await h.repo.saveText('campaign-2', text('newer'), { expectedRevision: 1, lease }); await h.repo.releaseLease(lease);
    expect(await h.controller.load(review, true)).toBe(false); expect(world(h.session)).toEqual(before);
    expect(h.controller.getSnapshot()).toMatchObject({ boundSlot: slot, readOnly: false }); expect(await h.controller.save(slot)).toBe(true);
  });
  it('blocks real Session commands and duplicate commits while import awaits storage', async () => {
    const h = await harness(); const approval = await select(h.controller); const entered = deferred(); const gate = deferred();
    const original = IndexedDbManagementV10Repository.prototype.importSave;
    vi.spyOn(IndexedDbManagementV10Repository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbManagementV10Repository, value, options) {
      entered.resolve(); await gate.promise; return original.call(this, value, options);
    });
    const pending = h.controller.commitImport(approval); await entered.promise;
    expect(h.session.getSnapshot().holds.storageBusy).toBe(true); expect(h.session.setSpeed(3).ok).toBe(false);
    expect(await h.controller.commitImport(approval)).toBe(false); expect(await h.controller.save(slot)).toBe(false);
    gate.resolve(); expect(await pending).toBe(true); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });
  it('aborts an awaiting import on stop/restart and releases old ownership exactly once', async () => {
    const h = await harness(); await h.controller.save(slot); const approval = await select(h.controller);
    const before = world(h.session); const entered = deferred(); const gate = deferred();
    const original = IndexedDbManagementV10Repository.prototype.importSave;
    vi.spyOn(IndexedDbManagementV10Repository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbManagementV10Repository, value, options) {
      entered.resolve(); await gate.promise; return original.call(this, value, options);
    });
    const release = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'releaseLease');
    const pending = h.controller.commitImport(approval); await entered.promise; const stopped = h.controller.stop(); const restarted = h.controller.start();
    gate.resolve(); expect(await pending).toBe(false); await stopped; await restarted;
    expect(world(h.session)).toEqual(before); expect((await h.repo.loadSlot(slot)).slot.revision).toBe(1);
    expect(release).toHaveBeenCalledTimes(1); expect(h.controller.getSnapshot()).toMatchObject({ mode: 'browser', boundSlot: null, busy: false });
  });
  it('never clears a hold already owned by another caller', async () => {
    const h = await harness(); h.session.setStorageBusy(true);
    const clear = vi.spyOn(h.session, 'setStorageBusy'); expect(await h.controller.save(slot)).toBe(false);
    expect(clear).not.toHaveBeenCalled(); await h.controller.stop(); expect(h.session.getSnapshot().holds.storageBusy).toBe(true);
    h.session.setStorageBusy(false);
  });
  it('never clears a foreign re-acquired hold after its own hold was removed', async () => {
    const h = await harness(); const approval = await select(h.controller); const entered = deferred(); const gate = deferred();
    const original = IndexedDbManagementV10Repository.prototype.importSave;
    vi.spyOn(IndexedDbManagementV10Repository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbManagementV10Repository, value, options) {
      entered.resolve(); await gate.promise; return original.call(this, value, options);
    });
    const pending = h.controller.commitImport(approval); await entered.promise;
    expect(h.session.setStorageBusy(false).ok).toBe(true); expect(h.session.setStorageBusy(true).ok).toBe(true);
    gate.resolve(); expect(await pending).toBe(false); expect(h.session.getSnapshot().holds.storageBusy).toBe(true);
    expect((await h.inspect()).slots).toEqual([]); h.session.setStorageBusy(false);
  });
  it('invalidates a pending save if an external caller replaces its host Session', async () => {
    const h = await harness(); const entered = deferred(); const gate = deferred();
    const original = IndexedDbManagementV10Repository.prototype.importSave;
    vi.spyOn(IndexedDbManagementV10Repository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbManagementV10Repository, value, options) {
      entered.resolve(); await gate.promise; return original.call(this, value, options);
    });
    const pending = h.controller.save(slot); await entered.promise;
    expect(h.session.replaceWorld(createUnregisteredWorldV10('replacement-host')).ok).toBe(true);
    gate.resolve(); expect(await pending).toBe(false); expect(world(h.session).seed).toBe('replacement-host');
    expect(h.session.getSnapshot().holds.storageBusy).toBe(true); expect((await h.inspect()).slots).toEqual([]);
    expect(h.controller.getSnapshot().mode).toBe('stopped'); h.session.setStorageBusy(false);
  });
  it('releases its acquisition when a controller subscriber stops during hold publication', async () => {
    const h = await harness(); const before = world(h.session); let stopped = false;
    const unsubscribe = h.controller.subscribe(() => { if (!stopped && h.controller.getSnapshot().busy) { stopped = true; void h.controller.stop(); } });
    expect(await h.controller.save(slot)).toBe(false); unsubscribe(); await h.controller.stop();
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(world(h.session)).toEqual(before); expect((await h.inspect()).slots).toEqual([]);
  });
  it('records a durable target without pretending rollback if stop arrives after actual commit', async () => {
    const h = await harness(); const approval = await select(h.controller); const before = world(h.session);
    const original = IndexedDbManagementV10Repository.prototype.importSave;
    vi.spyOn(IndexedDbManagementV10Repository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbManagementV10Repository, value, options) {
      const result = await original.call(this, value, options); void h.controller.stop(); return result;
    });
    const release = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'releaseLease');
    expect(await h.controller.commitImport(approval)).toBe(false); await h.controller.stop();
    expect(world(h.session)).toEqual(before); expect((await h.repo.loadSlot(slot)).world.seed).toBe('import-v10');
    expect(h.controller.getSnapshot().committed).toEqual({ slotId: slot, revision: 1, bound: false }); expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not resurrect lease ownership after a subscriber stops during replacement publication', async () => {
    const h = await harness(); const approval = await select(h.controller); const initialEpoch = h.session.getSnapshot().sessionEpoch;
    const unsubscribe = h.session.subscribe(() => { if (h.session.getSnapshot().sessionEpoch !== initialEpoch) void h.controller.stop(); });
    expect(await h.controller.commitImport(approval)).toBe(false); unsubscribe(); await h.controller.stop();
    expect(h.controller.getSnapshot().boundSlot).toBeNull(); expect(world(h.session).seed).toBe('import-v10');
    const lease = await h.repo.acquireLease(slot, 'after-stop'); expect(lease.ownerId).toBe('after-stop'); await h.repo.releaseLease(lease);
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });
  it('rejects stale file reading, including source revision changes, and bounds frozen status without cold exports', async () => {
    const h = await harness(); const gate = deferred<string>(); const exports = vi.spyOn(h.session, 'exportSave');
    const pending = h.controller.selectImportFile({ name: 'a'.repeat(600), size: 1, text: () => gate.promise });
    h.session.select({ kind: 'disciple', id: 'entity:1' }); gate.resolve(text()); expect(await pending).toBe(false);
    expect(h.controller.getSnapshot().import.phase).toBe('idle');
    for (let i = 0; i < 20; i++) h.controller.getSnapshot(); expect(exports).not.toHaveBeenCalled();
    expect(Object.isFrozen(h.controller.getSnapshot())).toBe(true); expect(h.controller.getSnapshot().slots).toHaveLength(3);
    expect(JSON.stringify(h.controller.getSnapshot())).not.toContain('payload');
  });
  it('clears its stale rejected file read without clearing a newer successful selection', async () => {
    const h = await harness(); const first = deferred<string>();
    const pending = h.controller.selectImportFile({ name: 'stale.json', size: 1, text: () => first.promise });
    h.session.select({ kind: 'disciple', id: 'entity:1' }); first.reject(new Error('Read failed'));
    expect(await pending).toBe(false);
    expect(h.controller.getSnapshot().import).toMatchObject({ phase: 'idle', notice: 'save.error.conflict' });
    const second = deferred<string>();
    const superseded = h.controller.selectImportFile({ name: 'older.json', size: 1, text: () => second.promise });
    expect(await h.controller.selectImportFile(file(text('newest-file')))).toBe(true);
    const selected = h.controller.getSnapshot().import;
    second.reject(new Error('Late failed read')); expect(await superseded).toBe(false);
    expect(h.controller.getSnapshot().import).toEqual(selected);
    expect(h.controller.getSnapshot().import).toMatchObject({ phase: 'ready', seed: 'newest-file' });
  });
  it('preserves foreign read-only holds even after successful import and controller stop', async () => {
    const h = await harness(); h.session.setStorageReadOnly(true); const approval = await select(h.controller);
    expect(await h.controller.commitImport(approval)).toBe(true); expect(h.session.getSnapshot().holds.storage).toBe(true);
    expect(h.controller.getSnapshot().readOnly).toBe(true); await h.controller.stop(); expect(h.session.getSnapshot().holds.storage).toBe(true);
    h.session.setStorageReadOnly(false);
  });
});
