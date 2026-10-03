import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementSaveControllerV9 } from '../../src/application/management-v9-save-controller';
import { ManagementCopyEntryV10 } from '../../src/application/management-v10-copy-entry';
import { ManagementSaveControllerV10, type AdoptedManagementServiceV10 } from '../../src/application/management-v10-save-controller';
import { ApplicationSessionV10 } from '../../src/application/session-v10';
import { V9V10CopyHost } from '../../src/application/v9-v10-copy-coordinator';
import { createSaveEnvelopeV9, parseSaveV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { IndexedDbSaveRepository, openSaveRepository } from '../../src/platform/persistence/indexeddb-save-repository';
import { IndexedDbManagementV10Repository, openManagementV10Repository } from '../../src/platform/persistence/indexeddb-management-v10-repository';
import { MANAGEMENT_V9_DATABASE_NAME } from '../../src/platform/persistence/types';
import { MANAGEMENT_V10_DATABASE_NAME, type ManagementV10RepositoryOptions } from '../../src/platform/persistence/management-v10-types';

const metadata = { buildId: 'copy-entry-test', savedAt: '2026-10-03T05:00:00Z' };
const cleanup: Array<() => void | Promise<unknown>> = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function request<T>(input: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { input.onsuccess = () => resolve(input.result); input.onerror = () => reject(input.error); }); }
async function oldRows(factory: IDBFactory) {
  const db = await request(factory.open(MANAGEMENT_V9_DATABASE_NAME));
  try {
    const transaction = db.transaction(['slots', 'snapshots'], 'readonly');
    return await Promise.all(['slots', 'snapshots'].map(store => request(transaction.objectStore(store).getAll())));
  } finally { db.close(); }
}
async function harness(options: ManagementV10RepositoryOptions = {}, active = false, accept = true) {
  const indexedDB = new IDBFactory(); const sourceWorld = createUnregisteredWorldV9('copy-source'); sourceWorld.sectEconomy.enabled = active;
  const sourceText = `\r\n${serializeSaveV9(createSaveEnvelopeV9(sourceWorld, metadata))}\t\n`;
  const old = await openSaveRepository({ indexedDB, now: () => 1000, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' });
  const imported = await old.importSave(sourceText, { mode: 'new-slot', slotId: 'campaign-1', ownerId: 'seed-owner' });
  await old.releaseLease(imported.lease); old.close();
  const destination = new ApplicationSessionV10(); destination.setPaused('player', true);
  const saves = new ManagementSaveControllerV10(destination, { indexedDB, now: () => 1000 }); await saves.start();
  const accepted: AdoptedManagementServiceV10[] = [];
  const adopt = vi.fn((service: AdoptedManagementServiceV10) => { if (accept) accepted.push(service); return accept; });
  const entry = new ManagementCopyEntryV10(destination, saves, adopt, { indexedDB, now: () => 1000, ...options });
  cleanup.push(async () => { await entry.dispose(); await saves.stop(); destination.close(); });
  return { indexedDB, destination, saves, entry, accepted, adopt, sourceText };
}
async function reviewed(h: Awaited<ReturnType<typeof harness>>) {
  expect(await h.entry.open()).toBe(true); expect(h.entry.selectSource('campaign-1')).toBe(true);
  expect(await h.entry.readSource()).toBe(true); expect(h.entry.selectTarget('campaign-2')).toBe(true);
  expect(await h.entry.review()).toBe(true); const review = h.entry.getSnapshot().review;
  if (!review) throw new Error('Expected source review'); return review;
}
afterEach(async () => { vi.restoreAllMocks(); for (const stop of cleanup.splice(0).reverse()) await stop(); vi.useRealTimers(); });

describe('explicit v9 to v10 copy entry', () => {
  it('constructs without touching the old DB; explicit listing and source selection do not read a slot', async () => {
    const h = await harness(); const open = vi.spyOn(h.indexedDB, 'open'); const load = vi.spyOn(IndexedDbSaveRepository.prototype, 'loadSlot');
    expect(h.entry.getSnapshot()).toMatchObject({ phase: 'idle', selectedSource: null, loadedSource: null, selectedTarget: null, committed: null });
    expect(open).not.toHaveBeenCalled(); expect(await h.entry.open()).toBe(true);
    expect(load).not.toHaveBeenCalled(); expect(open.mock.calls.map(call => call[0])).toEqual([MANAGEMENT_V9_DATABASE_NAME, MANAGEMENT_V10_DATABASE_NAME]);
    expect(h.entry.selectSource('campaign-2')).toBe(false); expect(h.entry.selectSource('campaign-1')).toBe(true); expect(load).not.toHaveBeenCalled();
    expect(h.entry.selectTarget('campaign-2')).toBe(false); expect(await h.entry.review()).toBe(false);
    expect(await h.entry.readSource()).toBe(true); expect(load).toHaveBeenCalled(); expect(h.destination.getSnapshot().closed).toBe(false);
  }, 30000);

  it('requires review and dirty acknowledgement, commits once, adopts the exact target and preserves original v9 text and revision', async () => {
    const h = await harness(); const before = await oldRows(h.indexedDB);
    const write = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'commitV9Copy'); const transfer = vi.spyOn(V9V10CopyHost.prototype, 'transferToController');
    const review = await reviewed(h); expect(Object.isFrozen(review)).toBe(true); expect(review.blockers).toEqual([]); expect(review.dirty).toBe(true);
    expect(write).not.toHaveBeenCalled(); expect(await h.entry.confirm(review, false)).toBe(false);
    const first = h.entry.confirm(review, true); expect(await h.entry.confirm(review, true)).toBe(false); expect(await first).toBe(true);
    expect(write).toHaveBeenCalledOnce(); expect(transfer).toHaveBeenCalledOnce(); expect(h.adopt).toHaveBeenCalledOnce();
    expect(h.entry.getSnapshot()).toMatchObject({ phase: 'completed', committed: { slotId: 'campaign-2', revision: 1, mounted: true } });
    const adopted = h.accepted[0]!; expect(adopted.saves.getSnapshot()).toMatchObject({ boundSlot: 'campaign-2', dirty: false, autosave: 'manual-only' });
    const repository = await openManagementV10Repository({ indexedDB: h.indexedDB, now: () => 1000 }); cleanup.push(() => repository.close());
    const backup = await repository.exportMigrationSource('campaign-2');
    expect(backup).toBe(write.mock.calls[0]![0].sourceText); expect(parseSaveV9(backup).ok).toBe(true);
    expect(await oldRows(h.indexedDB)).toEqual(before);
    expect(adopted.session.setSpeed(3).ok).toBe(true); expect(await adopted.saves.save('campaign-2')).toBe(true);
    expect(await repository.exportMigrationSource('campaign-2')).toBe(backup); expect(await oldRows(h.indexedDB)).toEqual(before);
    await h.entry.cancel(); expect(adopted.session.getSnapshot().closed).toBe(false);
    expect(h.entry.dispose()).toBe(h.entry.dispose()); await h.entry.dispose(); expect(adopted.session.getSnapshot().closed).toBe(true);
  }, 60000);

  it('renders active automatic work as a review blocker without mutating, cancelling or copying it', async () => {
    const h = await harness({}, true); const before = await oldRows(h.indexedDB); const write = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'commitV9Copy');
    const review = await reviewed(h); expect(review.blockers).toContain('AUTOMATIC_WORK_ENABLED');
    expect(await h.entry.confirm(review, true)).toBe(false); expect(write).not.toHaveBeenCalled(); expect(await oldRows(h.indexedDB)).toEqual(before);
  }, 30000);

  it('keeps a source held by another writer read-only and offers no takeover', async () => {
    const h = await harness(); const old = await openSaveRepository({ indexedDB: h.indexedDB, now: () => 1000, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' });
    const lease = await old.acquireLease('campaign-1', 'other-page'); cleanup.push(async () => { await old.releaseLease(lease); old.close(); });
    const acquire = vi.spyOn(IndexedDbSaveRepository.prototype, 'acquireLease'); const review = await reviewed(h);
    expect(review.blockers).toEqual(['READ_ONLY_SOURCE']); expect(await h.entry.confirm(review, true)).toBe(false);
    expect(acquire.mock.calls.every(call => call[2]?.takeover !== true)).toBe(true);
    expect(h.entry.getSnapshot().committed).toBeNull();
  }, 30000);

  it('publishes lease loss during an idle review without a destination tick or a confirm click', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = await harness(); const review = await reviewed(h); const destination = h.destination.getSnapshot();
    const changed = deferred(); const observer = vi.fn(() => {
      if (h.entry.getSnapshot().notice === 'source-readonly') changed.resolve();
    });
    const unsubscribe = h.entry.subscribe(observer);
    const old = await openSaveRepository({ indexedDB: h.indexedDB, now: () => 1000, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' });
    const lease = await old.acquireLease('campaign-1', 'different-page', { takeover: true });
    cleanup.push(async () => { await old.releaseLease(lease); old.close(); });
    const write = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'commitV9Copy');
    await vi.advanceTimersByTimeAsync(5000); await changed.promise;
    expect(observer).toHaveBeenCalled(); expect(h.destination.getSnapshot()).toBe(destination);
    expect(h.entry.getSnapshot()).toMatchObject({ phase: 'review', busy: false, notice: 'source-readonly' });
    expect(h.entry.getSnapshot().review?.blockers).toContain('READ_ONLY_SOURCE');
    expect(h.entry.isReviewCurrent(review)).toBe(false); expect(await h.entry.confirm(review, true)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    await h.entry.cancel(); const publications = observer.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000); expect(observer).toHaveBeenCalledTimes(publications); unsubscribe();
  }, 45000);

  it('does not clear a newer operation busy state when source invalidation publishes during settlement', async () => {
    const h = await harness(); const captured: { source: ManagementSaveControllerV9 | null } = { source: null };
    const load = ManagementSaveControllerV9.prototype.load;
    vi.spyOn(ManagementSaveControllerV9.prototype, 'load').mockImplementation(function (this: ManagementSaveControllerV9, ...args) {
      captured.source = this; return load.apply(this, args);
    });
    expect(await h.entry.open()).toBe(true); h.entry.selectSource('campaign-1'); expect(await h.entry.readSource()).toBe(true); h.entry.selectTarget('campaign-2');
    if (!captured.source) throw new Error('Expected explicitly loaded source controller');
    const source = captured.source; const snapshot = source.getSnapshot; let revoked = false;
    vi.spyOn(source, 'getSnapshot').mockImplementation(() => {
      const state = snapshot(); return revoked ? Object.freeze({ ...state, readOnly: true }) : state;
    });
    let newer: Promise<boolean> | null = null; let reentered = false;
    const stop = h.entry.subscribe(() => {
      const state = h.entry.getSnapshot();
      // The final review publication is still inside the original operation.
      // Reveal a late read-only result only to its settlement observer.
      if (state.review && state.busy && !state.notice) revoked = true;
      if (state.notice === 'source-readonly' && !reentered) { reentered = true; newer = h.entry.review(); }
    });
    expect(await h.entry.review()).toBe(true); expect(reentered).toBe(true); expect(newer).not.toBeNull();
    expect(h.entry.getSnapshot().busy).toBe(true);
    expect(await newer).toBe(true); expect(h.entry.getSnapshot().busy).toBe(false);
    expect(h.entry.getSnapshot().review?.blockers).toContain('READ_ONLY_SOURCE'); stop();
  }, 45000);

  it('keeps observing a reusable source after durable bind failure and a new target review without reopening', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = await harness(); const first = await reviewed(h);
    vi.spyOn(ApplicationSessionV10, 'bindPreparedSession').mockReturnValueOnce({ ok: false, kind: 'session-rejection', code: 'REPLACEMENT_STALE' });
    expect(await h.entry.confirm(first, true)).toBe(false);
    expect(h.entry.getSnapshot().committed).toMatchObject({ slotId: 'campaign-2', mounted: false });
    expect(h.entry.selectTarget('campaign-3')).toBe(true); expect(await h.entry.review()).toBe(true);
    const next = h.entry.getSnapshot().review; if (!next) throw new Error('Expected retry review'); expect(next.blockers).toEqual([]);
    const changed = deferred(); const stop = h.entry.subscribe(() => { if (h.entry.getSnapshot().notice === 'source-readonly') changed.resolve(); });
    const old = await openSaveRepository({ indexedDB: h.indexedDB, now: () => 1000, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' });
    const lease = await old.acquireLease('campaign-1', 'later-writer', { takeover: true }); cleanup.push(async () => { await old.releaseLease(lease); old.close(); });
    await vi.advanceTimersByTimeAsync(5000); await changed.promise;
    expect(h.entry.getSnapshot().review?.blockers).toContain('READ_ONLY_SOURCE'); expect(h.entry.isReviewCurrent(next)).toBe(false);
    expect(await h.entry.confirm(next, true)).toBe(false); expect(h.entry.getSnapshot().committed?.slotId).toBe('campaign-2'); stop();
  }, 60000);

  it('refuses a target occupied after review and leaves the other save and source unchanged', async () => {
    const h = await harness(); const review = await reviewed(h); const before = await oldRows(h.indexedDB);
    const repository = await openManagementV10Repository({ indexedDB: h.indexedDB, now: () => 1000 }); cleanup.push(() => repository.close());
    const current = h.saves.exportCurrent(); if (!current) throw new Error('Expected v10 export');
    const occupied = await repository.importSave(current.text, { mode: 'new-slot', slotId: 'campaign-2', ownerId: 'other-target' });
    expect(await h.entry.confirm(review, true)).toBe(false); expect(h.entry.getSnapshot()).toMatchObject({ notice: 'occupied', committed: null });
    expect((await repository.loadSlot('campaign-2')).snapshot.text).toBe(occupied.snapshot.text); expect(await oldRows(h.indexedDB)).toEqual(before);
    await repository.releaseLease(occupied.lease);
  }, 45000);

  it('rejects a stale current v10 Session before beginning a copy', async () => {
    const h = await harness(); const review = await reviewed(h); const write = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'commitV9Copy');
    expect(h.destination.setSpeed(3).ok).toBe(true); expect(h.entry.isReviewCurrent(review)).toBe(false);
    expect(await h.entry.confirm(review, true)).toBe(false); expect(write).not.toHaveBeenCalled(); expect(h.entry.getSnapshot().notice).toBe('stale');
  }, 30000);

  it('cancels delayed pending work, prevents repeated submission and never claims a write', async () => {
    const h = await harness(); const review = await reviewed(h); const gate = deferred(); const entered = deferred();
    const commit = IndexedDbManagementV10Repository.prototype.commitV9Copy;
    vi.spyOn(IndexedDbManagementV10Repository.prototype, 'commitV9Copy').mockImplementation(async function (this: IndexedDbManagementV10Repository, options) { entered.resolve(); await gate.promise; return commit.call(this, options); });
    const pending = h.entry.confirm(review, true); await entered.promise;
    expect(h.destination.getSnapshot().holds.storageBusy).toBe(true); expect(await h.entry.confirm(review, true)).toBe(false);
    const cancelled = h.entry.cancel(); expect(h.entry.cancel()).toBe(cancelled); gate.resolve();
    expect(await pending).toBe(false); await cancelled;
    expect(h.entry.getSnapshot()).toMatchObject({ phase: 'idle', busy: false, review: null, committed: null });
    expect(h.destination.getSnapshot().holds.storageBusy).toBe(false); expect(h.adopt).not.toHaveBeenCalled();
  }, 45000);

  it('retains a truthful committed-but-unmounted receipt when cancellation follows durable transaction completion', async () => {
    let cancel = () => {};
    const h = await harness({ faultInjector: (stage, transaction) => { if (stage === 'after-pointer') transaction.addEventListener('complete', () => cancel()); } });
    const review = await reviewed(h); const before = await oldRows(h.indexedDB); let closing: Promise<void> | null = null;
    cancel = () => { closing = h.entry.cancel(); };
    expect(await h.entry.confirm(review, true)).toBe(false); await closing;
    expect(h.entry.getSnapshot()).toMatchObject({ phase: 'idle', committed: { slotId: 'campaign-2', revision: 1, mounted: false } });
    expect(h.adopt).not.toHaveBeenCalled(); expect(await oldRows(h.indexedDB)).toEqual(before);
    const repository = await openManagementV10Repository({ indexedDB: h.indexedDB, now: () => 1000 }); cleanup.push(() => repository.close());
    expect((await repository.loadSlot('campaign-2')).slot.revision).toBe(1); expect(parseSaveV9(await repository.exportMigrationSource('campaign-2')).ok).toBe(true);
  }, 45000);

  it.each(['transfer', 'mount'] as const)('preserves committed target when %s fails after the transaction', async failure => {
    const h = await harness({}, false, failure !== 'mount'); const review = await reviewed(h);
    if (failure === 'transfer') vi.spyOn(V9V10CopyHost.prototype, 'transferToController').mockResolvedValue({ ok: false, code: 'PREPARATION_FAILED' });
    expect(await h.entry.confirm(review, true)).toBe(false);
    expect(h.entry.getSnapshot()).toMatchObject({ committed: { slotId: 'campaign-2', revision: 1, mounted: false }, notice: 'failed' });
    await h.entry.cancel(); expect(h.entry.getSnapshot().committed?.mounted).toBe(false);
    const repository = await openManagementV10Repository({ indexedDB: h.indexedDB, now: () => 1000 }); cleanup.push(() => repository.close());
    expect((await repository.loadSlot('campaign-2')).slot.revision).toBe(1);
    const lease = await repository.acquireLease('campaign-2', 'explicit-reload'); await repository.releaseLease(lease);
  }, 45000);

  it.each(['SOURCE_PROTECTION_FAILED', 'SOURCE_CLEANUP_UNCONFIRMED'] as const)('retains %s independently through refused transfer, cancel and a new listing', async issue => {
    const h = await harness(); const review = await reviewed(h);
    const finish = ManagementSaveControllerV9.prototype.finishV10CopySource;
    vi.spyOn(ManagementSaveControllerV9.prototype, 'finishV10CopySource').mockImplementation(async function (this: ManagementSaveControllerV9, token, outcome) {
      const result = await finish.call(this, token, outcome);
      if (outcome !== 'bound') return result;
      return issue === 'SOURCE_PROTECTION_FAILED'
        ? { ok: false, code: 'SOURCE_PROTECTION_FAILED', sourceCurrent: true, holdReleased: true, lease: 'released' }
        : { ok: true, sourceCurrent: false, holdReleased: true, lease: 'retained' };
    });
    expect(await h.entry.confirm(review, true)).toBe(false);
    expect(h.entry.getSnapshot()).toMatchObject({ notice: 'cleanup', cleanup: [issue], committed: { slotId: 'campaign-2', revision: 1, mounted: false } });
    expect(h.adopt).not.toHaveBeenCalled(); await h.entry.cancel();
    expect(h.entry.getSnapshot()).toMatchObject({ phase: 'idle', notice: 'cleanup', cleanup: [issue], committed: { slotId: 'campaign-2', revision: 1, mounted: false } });
    expect(await h.entry.open()).toBe(true); expect(h.entry.getSnapshot()).toMatchObject({ notice: 'cleanup', cleanup: [issue] });
  }, 45000);

  it('cancels opening before its microtask without opening either database, and cannot restart a disposed entry', async () => {
    const h = await harness(); const open = vi.spyOn(h.indexedDB, 'open'); const pending = h.entry.open();
    const disposed = h.entry.dispose(); expect(h.entry.dispose()).toBe(disposed); expect(await pending).toBe(false); await disposed;
    expect(open).not.toHaveBeenCalled(); expect(await h.entry.open()).toBe(false); expect(h.entry.getSnapshot().phase).toBe('disposed');
  }, 30000);
});
