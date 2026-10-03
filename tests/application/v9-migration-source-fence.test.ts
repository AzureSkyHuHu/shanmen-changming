import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementSaveControllerV9, type V10CopySourceV9 } from '../../src/application/management-v9-save-controller';
import { ApplicationSessionV9 } from '../../src/application/session-v9';
import { createSaveEnvelopeV9, parseSaveV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { IndexedDbSaveRepository, MANAGEMENT_V9_DATABASE_NAME, openSaveRepository, type RepositoryOptions,
  type SnapshotRecord } from '../../src/platform/persistence';

const metadata = { buildId: 'v9-copy-source-test', savedAt: '2026-10-02T22:00:00Z' };
const slotId = 'campaign-1' as const;
const controllers: ManagementSaveControllerV9[] = [];
const sessions: ApplicationSessionV9[] = [];
const repositories: IndexedDbSaveRepository[] = [];
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
}
function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
}
function world(session: ApplicationSessionV9) {
  const exported = session.exportWorld(); if (!exported.ok) throw new Error('Expected playable source'); return exported.value;
}
function source(controller: ManagementSaveControllerV9): V10CopySourceV9 {
  const result = controller.beginV10CopySource(metadata);
  if (!result.ok) throw new Error(`Expected source, received ${result.code}`);
  return result.token;
}
async function harness(options: RepositoryOptions = {}) {
  const indexedDB = new IDBFactory(); let now = 1000;
  const settings = { indexedDB, now: () => now, ...options };
  const session = new ApplicationSessionV9(createUnregisteredWorldV9('live-copy-source')); sessions.push(session);
  const controller = new ManagementSaveControllerV9(session, settings); controllers.push(controller); await controller.start();
  const repository = async () => {
    const repo = await openSaveRepository({ ...settings, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' });
    repositories.push(repo); return repo;
  };
  const inspect = async () => {
    const db = await request(indexedDB.open(MANAGEMENT_V9_DATABASE_NAME));
    try {
      const transaction = db.transaction(['slots', 'snapshots', 'leases'], 'readonly'); const completion = done(transaction);
      const [slots, snapshots, leases] = await Promise.all(['slots', 'snapshots', 'leases'].map(name => request<unknown[]>(transaction.objectStore(name).getAll())));
      await completion; return { slots, snapshots, leases };
    } finally { db.close(); }
  };
  const corrupt = async (id: string) => {
    const db = await request(indexedDB.open(MANAGEMENT_V9_DATABASE_NAME));
    try {
      const transaction = db.transaction('snapshots', 'readwrite'); const completion = done(transaction); const store = transaction.objectStore('snapshots');
      const row = await request<SnapshotRecord>(store.get(id)); await request(store.put({ ...row, text: '{broken' })); await completion;
    } finally { db.close(); }
  };
  return { session, controller, repository, inspect, corrupt, setNow(value: number) { now = value; } };
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.stop();
  await Promise.resolve();
  for (const session of sessions.splice(0)) session.close();
  for (const repository of repositories.splice(0)) repository.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('v9 live-source fence for an explicit future v10 copy', () => {
  it('exports the dirty live World under a post-hold revision without writing either storage or the source World', async () => {
    const h = await harness(); await h.controller.save(slotId);
    h.session.frame(0); h.session.frame(100);
    const live = world(h.session); const before = h.session.getSnapshot(); const stored = await h.inspect();
    const exportSave = vi.spyOn(h.session, 'exportSave'); const write = vi.spyOn(IndexedDbSaveRepository.prototype, 'saveText');
    const importSave = vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave'); const acquire = vi.spyOn(IndexedDbSaveRepository.prototype, 'acquireLease');
    const token = source(h.controller); const held = h.session.getSnapshot();
    expect(exportSave).toHaveBeenCalledWith(metadata); expect(Object.isFrozen(token)).toBe(true);
    expect(token).toMatchObject({ sessionEpoch: held.sessionEpoch, worldRevision: held.worldRevision, revision: held.revision });
    expect(token.revision).toBe(before.revision + 1); expect(token.worldRevision).toBe(before.worldRevision);
    expect(parseSaveV9(token.sourceText)).toMatchObject({ ok: true, world: live });
    expect(world(h.session)).toEqual(live); expect(h.controller.getSnapshot()).toMatchObject({ busy: true, dirty: true });
    expect(h.controller.isV10CopySourceCurrent(token)).toBe(true); expect(token.signal.aborted).toBe(false);
    expect(write).not.toHaveBeenCalled(); expect(importSave).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
    expect(await h.inspect()).toEqual(stored);
    expect(await h.controller.finishV10CopySource(token, 'cancelled')).toEqual({ ok: true, sourceCurrent: true, holdReleased: true, lease: 'retained' });
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(world(h.session)).toEqual(live); expect(await h.inspect()).toEqual(stored);
  });

  it('exports the actual loaded pause boundary even when dirty is false and stored bytes differ', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository();
    const disk = (await repo.loadSlot(slotId)).snapshot.text;
    await h.controller.load(slotId);
    expect(h.controller.getSnapshot().dirty).toBe(false); expect(world(h.session).clock.pauseReasons).toContain('player');
    const token = source(h.controller); const parsed = parseSaveV9(token.sourceText);
    expect(parsed).toMatchObject({ ok: true, world: { clock: { pauseReasons: ['player'] } } });
    expect(token.sourceText).not.toBe(disk); expect((await repo.loadSlot(slotId)).snapshot.text).toBe(disk);
    await h.controller.finishV10CopySource(token, 'failed');
  });

  it('blocks commands, ticks, normal storage operations and double begin until its owning token finishes', async () => {
    const h = await harness(); const token = source(h.controller); const held = h.session.getSnapshot();
    expect(h.controller.beginV10CopySource(metadata)).toEqual({ ok: false, code: 'SOURCE_BUSY' });
    expect(h.session.setSpeed(3)).toMatchObject({ ok: false, code: 'SESSION_HELD' });
    expect(h.session.dispatch({ kind: 'inventory.discard', payload: { resourceId: 'wood', quantity: 1 } })).toMatchObject({ ok: false, code: 'SESSION_HELD' });
    h.session.frame(0); h.session.frame(10000);
    expect(h.session.getSnapshot()).toBe(held); expect(await h.controller.beginNewCampaign('blocked')).toBe(false);
    await h.controller.save(slotId); expect((await h.inspect()).slots).toEqual([]);
    await h.controller.finishV10CopySource(token, 'failed');
    expect(h.session.setSpeed(3).ok).toBe(true); await h.controller.save(slotId);
    expect(h.controller.getSnapshot()).toMatchObject({ busy: false, dirty: false, boundSlot: slotId });
    await h.controller.load(slotId); expect(h.controller.getSnapshot().notice).toBe('save.loadedPaused');
  });

  it('rejects copied, foreign, forged and repeated tokens without reading their properties or releasing another hold', async () => {
    const a = await harness(); const b = await harness(); const tokenA = source(a.controller); const tokenB = source(b.controller);
    let reads = 0;
    const hostile = new Proxy({}, { get() { reads++; throw new Error('Must not inspect caller token fields'); } });
    for (const token of [{ ...tokenA }, tokenB, hostile, null, 7]) {
      expect(a.controller.isV10CopySourceCurrent(token)).toBe(false);
      expect(await a.controller.finishV10CopySource(token, 'cancelled')).toEqual({ ok: false, code: 'INVALID_TOKEN' });
    }
    expect(reads).toBe(0); expect(a.session.getSnapshot().holds.storageBusy).toBe(true); expect(b.session.getSnapshot().holds.storageBusy).toBe(true);
    await a.controller.finishV10CopySource(tokenA, 'cancelled');
    const next = source(a.controller);
    expect(await a.controller.finishV10CopySource(tokenA, 'cancelled')).toEqual({ ok: false, code: 'INVALID_TOKEN' });
    expect(a.controller.isV10CopySourceCurrent(next)).toBe(true); expect(a.session.getSnapshot().holds.storageBusy).toBe(true);
    await a.controller.finishV10CopySource(next, 'failed'); await b.controller.finishV10CopySource(tokenB, 'failed');
  });

  it('rejects unopened, stopped, closed and already-held sources before attempting export', async () => {
    const session = new ApplicationSessionV9(); sessions.push(session);
    const controller = new ManagementSaveControllerV9(session, { indexedDB: new IDBFactory() }); controllers.push(controller);
    const exportSave = vi.spyOn(session, 'exportSave');
    expect(controller.beginV10CopySource(metadata)).toEqual({ ok: false, code: 'SOURCE_UNAVAILABLE' });
    await controller.start(); session.setStorageBusy(true);
    expect(controller.beginV10CopySource(metadata)).toEqual({ ok: false, code: 'SOURCE_BUSY' });
    expect(session.getSnapshot().holds.storageBusy).toBe(true); session.setStorageBusy(false); controller.stop();
    expect(controller.beginV10CopySource(metadata)).toEqual({ ok: false, code: 'SOURCE_UNAVAILABLE' });
    await controller.start(); session.close();
    expect(controller.beginV10CopySource(metadata)).toEqual({ ok: false, code: 'SOURCE_UNAVAILABLE' });
    expect(exportSave).not.toHaveBeenCalled();
  });

  it('independently rejects controller readonly and Session storage holds, including their divergence', async () => {
    const h = await harness(); const exportSave = vi.spyOn(h.session, 'exportSave');
    h.session.setStorageReadOnly(true); expect(h.controller.getSnapshot().readOnly).toBe(false);
    expect(h.controller.beginV10CopySource(metadata)).toEqual({ ok: false, code: 'READ_ONLY_SOURCE' });
    expect(exportSave).not.toHaveBeenCalled(); h.session.setStorageReadOnly(false);
    await h.controller.save(slotId); const repo = await h.repository(); await repo.acquireLease(slotId, 'other', { takeover: true });
    await h.controller.save(slotId); expect(h.controller.getSnapshot().readOnly).toBe(true);
    h.session.setStorageReadOnly(false); exportSave.mockClear();
    expect(h.controller.beginV10CopySource(metadata)).toEqual({ ok: false, code: 'READ_ONLY_SOURCE' });
    expect(exportSave).not.toHaveBeenCalled(); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });

  it('refuses a recovered readonly source even after a requested takeover load', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository();
    const lease = await repo.acquireLease(slotId, 'setup', { takeover: true });
    const text = serializeSaveV9(createSaveEnvelopeV9(createUnregisteredWorldV9('newer-corrupt'), metadata));
    await repo.saveText(slotId, text, { expectedRevision: 1, lease }); await h.corrupt('campaign-1:2'); h.setNow(lease.expiresAt);
    await h.controller.load(slotId, true); expect(h.controller.getSnapshot().notice).toBe('save.recoveredReadOnly');
    const stored = await h.inspect(); const exportSave = vi.spyOn(h.session, 'exportSave');
    expect(h.controller.beginV10CopySource(metadata)).toEqual({ ok: false, code: 'READ_ONLY_SOURCE' });
    expect(exportSave).not.toHaveBeenCalled(); expect(await h.inspect()).toEqual(stored);
  });

  it.each(['stop', 'restart', 'close'] as const)('synchronously aborts on %s and ignores stale async completion', async action => {
    const h = await harness(); const token = source(h.controller); let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; }); let bound = false;
    const pending = (async () => { await gate; if (h.controller.isV10CopySourceCurrent(token)) bound = true; return bound; })();
    const aborted = vi.fn(); token.signal.addEventListener('abort', aborted);
    let restart: Promise<void> | null = null;
    if (action === 'stop') h.controller.stop();
    if (action === 'restart') restart = h.controller.start();
    if (action === 'close') h.session.close();
    expect(token.signal.aborted).toBe(true); expect(aborted).toHaveBeenCalledTimes(1); resume();
    expect(await pending).toBe(false); if (restart) await restart;
    expect(h.controller.isV10CopySourceCurrent(token)).toBe(false);
    expect(await h.controller.finishV10CopySource(token, 'bound')).toEqual({ ok: false, code: 'INVALID_TOKEN' });
    if (action !== 'close') expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
    if (action === 'restart') { const next = source(h.controller); await h.controller.finishV10CopySource(next, 'cancelled'); }
  });

  it('aborts synchronously on source replacement and keeps a stale bound finish from releasing the old writer', async () => {
    const h = await harness(); await h.controller.save(slotId); const token = source(h.controller); const release = vi.spyOn(IndexedDbSaveRepository.prototype, 'releaseLease');
    const aborted = vi.fn(); token.signal.addEventListener('abort', aborted);
    expect(h.session.replaceWorld(createUnregisteredWorldV9('replacement')).ok).toBe(true);
    expect(token.signal.aborted).toBe(true); expect(aborted).toHaveBeenCalledTimes(1);
    expect(await h.controller.finishV10CopySource(token, 'bound')).toEqual({ ok: true, sourceCurrent: false, holdReleased: true, lease: 'retained' });
    expect(release).not.toHaveBeenCalled(); expect(world(h.session).seed).toBe('replacement'); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });

  it('detects revision-only drift and never releases a hold removed and reacquired by somebody else', async () => {
    const h = await harness(); const token = source(h.controller); const before = h.session.getSnapshot();
    h.session.setStorageBusy(false); h.session.setStorageBusy(true);
    expect(h.session.getSnapshot().sessionEpoch).toBe(before.sessionEpoch); expect(h.session.getSnapshot().worldRevision).toBe(before.worldRevision);
    expect(h.session.getSnapshot().revision).toBeGreaterThan(before.revision); expect(token.signal.aborted).toBe(true);
    await h.controller.finishV10CopySource(token, 'failed');
    expect(h.session.getSnapshot().holds.storageBusy).toBe(true); h.session.setStorageBusy(false);
  });

  it.each(['invalid', 'getter', 'export-refusal', 'export-throw', 'bad-text'] as const)('cleans up %s failure and preserves playable World and save binding', async failure => {
    const h = await harness(); await h.controller.save(slotId); const before = world(h.session); const stored = await h.inspect();
    let meta = metadata; let reads = 0;
    if (failure === 'invalid') meta = { ...metadata, buildId: '' };
    if (failure === 'getter') meta = { get buildId(): string { reads++; throw new Error('Accessor must not run'); }, savedAt: metadata.savedAt };
    if (failure === 'export-refusal') vi.spyOn(h.session, 'exportSave').mockReturnValueOnce({ ok: false, kind: 'save-rejection', code: 'INVALID_ENVELOPE' });
    if (failure === 'export-throw') vi.spyOn(h.session, 'exportSave').mockImplementationOnce(() => { throw new Error('Export failed'); });
    if (failure === 'bad-text') vi.spyOn(h.session, 'exportSave').mockReturnValueOnce({ ok: true, value: '{}' });
    expect(h.controller.beginV10CopySource(meta)).toEqual({ ok: false, code: 'EXPORT_FAILED' });
    expect(reads).toBe(0); expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(world(h.session)).toEqual(before);
    expect(h.controller.getSnapshot()).toMatchObject({ boundSlot: slotId, busy: false, readOnly: false, dirty: false });
    expect(await h.inspect()).toEqual(stored); expect(h.session.setSpeed(3).ok).toBe(true);
  });

  it.each(['session-listener', 'controller-listener', 'metadata-proxy'] as const)('does not leak the hold when %s stops reentrantly during capture', async entry => {
    const h = await harness(); const before = world(h.session); let unsubscribe = () => {};
    if (entry === 'session-listener') unsubscribe = h.session.subscribe(() => { if (h.session.getSnapshot().holds.storageBusy) h.controller.stop(); });
    if (entry === 'controller-listener') unsubscribe = h.controller.subscribe(() => { if (h.controller.getSnapshot().busy) h.controller.stop(); });
    const meta = entry === 'metadata-proxy' ? new Proxy(metadata, { ownKeys(target) { h.controller.stop(); return Reflect.ownKeys(target); } }) : metadata;
    expect(h.controller.beginV10CopySource(meta)).toEqual({ ok: false, code: 'SOURCE_UNAVAILABLE' });
    unsubscribe(); await Promise.resolve();
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(h.controller.getSnapshot().busy).toBe(false); expect(world(h.session)).toEqual(before);
    await h.controller.start(); const next = source(h.controller); await h.controller.finishV10CopySource(next, 'cancelled');
  });

  it('defers only an owning finish called inside Session publication, then releases it without starving restart', async () => {
    const h = await harness(); const token = source(h.controller);
    let cleanup: ReturnType<ManagementSaveControllerV9['finishV10CopySource']> | null = null;
    token.signal.addEventListener('abort', () => { cleanup = h.controller.finishV10CopySource(token, 'failed'); });
    h.session.replaceWorld(createUnregisteredWorldV9('publication-reentry'));
    expect(cleanup).not.toBeNull(); expect(await cleanup).toMatchObject({ ok: true, sourceCurrent: false, holdReleased: true });
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(world(h.session).seed).toBe('publication-reentry');
  });

  it('preserves a foreign hold reacquired while an owning finish is waiting for Session publication to unwind', async () => {
    const h = await harness(); const token = source(h.controller);
    let cleanup: ReturnType<ManagementSaveControllerV9['finishV10CopySource']> | null = null;
    token.signal.addEventListener('abort', () => { cleanup = h.controller.finishV10CopySource(token, 'failed'); });
    expect(h.session.replaceWorld(createUnregisteredWorldV9('deferred-foreign-hold')).ok).toBe(true);
    expect(cleanup).not.toBeNull(); expect(h.session.getSnapshot().holds.storageBusy).toBe(true);
    // These synchronous publications precede the queued BUSY cleanup retry.
    expect(h.session.setStorageBusy(false).ok).toBe(true);
    expect(h.session.setStorageBusy(true).ok).toBe(true);
    expect(await cleanup).toMatchObject({ ok: true, sourceCurrent: false, holdReleased: true, lease: 'retained' });
    expect(h.session.getSnapshot().holds.storageBusy).toBe(true);
    expect(h.controller.isV10CopySourceCurrent(token)).toBe(false);
    h.session.setStorageBusy(false);
  });

  it('holds the source writer through cancellation and releases it only after bound success, reporting release completion', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository(); const release = vi.spyOn(IndexedDbSaveRepository.prototype, 'releaseLease');
    const failed = source(h.controller); await h.controller.finishV10CopySource(failed, 'failed'); expect(release).not.toHaveBeenCalled();
    const token = source(h.controller);
    await expect(repo.acquireLease(slotId, 'competing')).rejects.toMatchObject({ code: 'LEASE_BUSY' });
    expect(h.controller.isV10CopySourceCurrent(token)).toBe(true); expect(release).not.toHaveBeenCalled();
    const finish = await h.controller.finishV10CopySource(token, 'bound');
    expect(finish).toEqual({ ok: true, sourceCurrent: true, holdReleased: true, lease: 'released' });
    expect(h.controller.getSnapshot()).toMatchObject({ busy: false, readOnly: true }); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
    expect(await repo.acquireLease(slotId, 'after-target-binding')).toMatchObject({ ownerId: 'after-target-binding' });
  });

  it('reports source-lease cleanup failure separately from accepted durable target binding', async () => {
    const h = await harness(); await h.controller.save(slotId); const token = source(h.controller);
    vi.spyOn(IndexedDbSaveRepository.prototype, 'releaseLease').mockRejectedValueOnce(new Error('Cleanup failed'));
    expect(await h.controller.finishV10CopySource(token, 'bound')).toEqual({ ok: true, sourceCurrent: true, holdReleased: true, lease: 'release-failed' });
    expect(h.controller.isV10CopySourceCurrent(token)).toBe(false); expect(h.controller.getSnapshot().readOnly).toBe(true);
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });

  it('installs actual readonly protection before bound abort observers can replace the busy hold', async () => {
    const h = await harness(); await h.controller.save(slotId); const token = source(h.controller);
    const tick = h.session.getSnapshot().frame.clock.simulationTick;
    let protectedAtAbort = false;
    token.signal.addEventListener('abort', () => {
      protectedAtAbort = h.session.getSnapshot().holds.storage;
      h.session.setStorageBusy(false); h.session.setStorageBusy(true);
    });
    expect(await h.controller.finishV10CopySource(token, 'bound')).toMatchObject({ ok: true, sourceCurrent: true, lease: 'released' });
    expect(protectedAtAbort).toBe(true);
    expect(h.session.getSnapshot()).toMatchObject({ closed: false, holds: { storage: true, storageBusy: true } });
    expect(h.session.setStorageBusy(false).ok).toBe(true);
    h.session.frame(0); h.session.frame(50);
    expect(h.session.getSnapshot().holds.storage).toBe(true);
    expect(h.session.getSnapshot().frame.clock.simulationTick).toBe(tick);
  });

  it('reports unexpected actual protection failure instead of claiming accepted protected cleanup', async () => {
    const h = await harness(); await h.controller.save(slotId); const token = source(h.controller);
    vi.spyOn(h.session, 'setStorageReadOnly').mockReturnValueOnce({ ok: false, kind: 'session-rejection', code: 'COUNTER_EXHAUSTED' });
    expect(await h.controller.finishV10CopySource(token, 'bound')).toEqual({ ok: false, code: 'SOURCE_PROTECTION_FAILED',
      sourceCurrent: true, holdReleased: true, lease: 'released' });
    expect(h.session.getSnapshot().holds.storage).toBe(false);
    expect(h.controller.isV10CopySourceCurrent(token)).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({ busy: false, readOnly: true, notice: 'save.error.protected' });
  });

  it('rejects reentrant bound finish before consuming its hold or writer and permits a later protected finish', async () => {
    const h = await harness(); await h.controller.save(slotId); const token = source(h.controller);
    const release = vi.spyOn(IndexedDbSaveRepository.prototype, 'releaseLease');
    const tick = h.session.getSnapshot().frame.clock.simulationTick;
    let cleanup: ReturnType<ManagementSaveControllerV9['finishV10CopySource']> | null = null;
    const meta = new Proxy(metadata, { ownKeys(target) {
      cleanup = h.controller.finishV10CopySource(token, 'bound');
      return Reflect.ownKeys(target);
    } });
    // Metadata reflection runs inside Session.exportSave's exclusive lock.
    expect(h.session.exportSave(meta).ok).toBe(true); expect(cleanup).not.toBeNull();
    expect(token.signal.aborted).toBe(false);
    expect(await cleanup).toEqual({ ok: false, code: 'SOURCE_BUSY' });
    expect(release).not.toHaveBeenCalled(); expect(h.controller.isV10CopySourceCurrent(token)).toBe(true);
    expect(h.session.getSnapshot()).toMatchObject({ closed: false, holds: { storage: false, storageBusy: true } });
    expect(h.controller.getSnapshot()).toMatchObject({ busy: true, readOnly: false });
    expect(await h.controller.finishV10CopySource(token, 'bound')).toMatchObject({ ok: true, sourceCurrent: true, lease: 'released' });
    expect(h.session.getSnapshot()).toMatchObject({ closed: false, holds: { storage: true, storageBusy: false } });
    expect(release).toHaveBeenCalledTimes(1); expect(token.signal.aborted).toBe(true);
    expect(h.session.setStorageBusy(false).ok).toBe(true);
    h.session.frame(0); h.session.frame(50);
    expect(h.session.getSnapshot().frame.clock.simulationTick).toBe(tick);
    expect(h.controller.getSnapshot().busy).toBe(false);
  });

  it('continues source writer renewal while held and aborts a pending target operation when ownership is lost', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); const h = await harness(); await h.controller.save(slotId); const token = source(h.controller);
    const original = IndexedDbSaveRepository.prototype.renewLease;
    let renewed: ReturnType<typeof original> | null = null;
    const renew = vi.spyOn(IndexedDbSaveRepository.prototype, 'renewLease').mockImplementation(function (this: IndexedDbSaveRepository, lease) {
      renewed = original.call(this, lease); return renewed;
    });
    h.setNow(7000); await vi.advanceTimersByTimeAsync(5000);
    await renewed;
    expect(renew).toHaveBeenCalled(); expect(h.controller.isV10CopySourceCurrent(token)).toBe(true);
    const repo = await h.repository(); await repo.acquireLease(slotId, 'competing', { takeover: true });
    const aborted = new Promise<void>(resolve => token.signal.addEventListener('abort', () => resolve(), { once: true }));
    await vi.advanceTimersByTimeAsync(5000); await aborted;
    expect(h.controller.getSnapshot().readOnly).toBe(true); expect(h.controller.isV10CopySourceCurrent(token)).toBe(false);
    await h.controller.finishV10CopySource(token, 'failed'); expect(h.session.getSnapshot().holds.storage).toBe(true);
  });

  it('permits held memory export without claiming that it created a durable migration backup', async () => {
    vi.stubGlobal('indexedDB', undefined); const session = new ApplicationSessionV9(); sessions.push(session);
    const controller = new ManagementSaveControllerV9(session); controllers.push(controller); await controller.start();
    expect(controller.getSnapshot().mode).toBe('memory'); const token = source(controller);
    expect(parseSaveV9(token.sourceText).ok).toBe(true); await controller.finishV10CopySource(token, 'cancelled');
    expect(controller.getSnapshot()).toMatchObject({ mode: 'memory', boundSlot: null, dirty: true });
  });
});
