import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementSaveControllerV9 } from '../../src/application/management-v9-save-controller';
import { ApplicationSessionV9 } from '../../src/application/session-v9';
import { ApplicationSession } from '../../src/application/session';
import { SaveController } from '../../src/application/save-controller';
import { createSaveEnvelopeV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createWorld } from '../../src/core/world/create-world';
import { exportWorldSave, parseSaveFile } from '../../src/platform/files/save-files';
import { IndexedDbSaveRepository, MANAGEMENT_V9_DATABASE_NAME, openSaveRepository, type RepositoryOptions, type SnapshotRecord } from '../../src/platform/persistence';

const slotId = 'campaign-1' as const;
const metadata = { buildId: 'v9-controller', savedAt: '2026-10-02T12:00:00Z' };
const controllers: Array<{ stop(): void }> = []; const sessions: ApplicationSessionV9[] = []; const repositories: IndexedDbSaveRepository[] = [];
const makeText = (seed = 'imported-v9') => `\n ${serializeSaveV9(createSaveEnvelopeV9(createUnregisteredWorldV9(seed), metadata))}\n`;
const file = (text: string) => ({ name: 'management.json', size: text.length, text: async () => text });
function current(session: ApplicationSessionV9) { const result = session.exportWorld(); if (!result.ok) throw new Error('Export failed'); return result.value; }
function request<T>(operation: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); }); }
function done(transaction: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); }); }
async function harness(extra: RepositoryOptions = {}) {
  const indexedDB = new IDBFactory(); let now = 1000; const options = { indexedDB, now: () => now, ...extra };
  const session = new ApplicationSessionV9(createUnregisteredWorldV9('live-v9')); sessions.push(session);
  const controller = new ManagementSaveControllerV9(session, options); controllers.push(controller); await controller.start();
  const inspect = async () => {
    const db = await request(indexedDB.open(MANAGEMENT_V9_DATABASE_NAME));
    try { const transaction = db.transaction(['slots', 'snapshots', 'leases'], 'readonly'); const completion = done(transaction);
      const [slots, snapshots, leases] = await Promise.all(['slots', 'snapshots', 'leases'].map(name => request<unknown[]>(transaction.objectStore(name).getAll()))); await completion; return { slots, snapshots, leases }; }
    finally { db.close(); }
  };
  const repository = async () => { const repo = await openSaveRepository({ ...options, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' }); repositories.push(repo); return repo; };
  return { session, controller, options, indexedDB, inspect, repository, setNow(value: number) { now = value; },
    corrupt: async (id: string) => { const db = await request(indexedDB.open(MANAGEMENT_V9_DATABASE_NAME));
      try { const transaction = db.transaction('snapshots', 'readwrite'); const completion = done(transaction); const store = transaction.objectStore('snapshots'); const row = await request<SnapshotRecord>(store.get(id)); await request(store.put({ ...row, text: '{broken' })); await completion; }
      finally { db.close(); }
    } };
}
async function select(controller: ManagementSaveControllerV9, text = makeText(), target = slotId) {
  expect(await controller.selectImportFile(file(text))).toBe(true); expect(controller.selectImportTarget(target)).toBe(true);
  const state = controller.getSnapshot().import;
  return { selectionId: state.selectionId, slotId: target, expectedRevision: state.target!.revision, overwriteConfirmed: state.target!.occupied };
}
afterEach(() => { for (const controller of controllers.splice(0)) controller.stop(); for (const session of sessions.splice(0)) session.close(); for (const repository of repositories.splice(0)) repository.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('disabled-entry management v9 save controller', () => {
  it('opens only its fixed DB/route, saves twice, reloads paused and resumes exact continuation', async () => {
    const h = await harness({ databaseName: 'must-not-use-this', routePolicy: 'legacy-v7-v8' });
    expect((await h.indexedDB.databases()).map(db => db.name)).toEqual([MANAGEMENT_V9_DATABASE_NAME]);
    expect(h.controller.getSnapshot()).toMatchObject({ mode: 'browser', dirty: true, autosave: 'manual-only', boundSlot: null });
    expect((await h.inspect()).slots).toEqual([]);
    await h.controller.save(slotId); expect(h.controller.getSnapshot()).toMatchObject({ dirty: false, boundSlot: slotId, notice: 'save.saved' });
    h.session.frame(0); h.session.frame(250); expect(h.controller.getSnapshot().dirty).toBe(true);
    const saved = current(h.session); expect(saved.clock.simulationTick).toBe(5);
    await h.controller.save(slotId); expect(h.controller.getSnapshot().slots[0]!.slot!.revision).toBe(2);
    h.session.frame(300); await h.controller.load(slotId);
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(h.session.getSnapshot().frame.clock.pauseReasons).toContain('player');
    expect(h.controller.getSnapshot()).toMatchObject({ dirty: false, readOnly: false, notice: 'save.loadedPaused' });
    expect(h.session.setPaused('player', false).ok).toBe(true); expect(current(h.session)).toEqual(saved);
    h.session.frame(50000); h.session.frame(50050); expect(current(h.session).clock.simulationTick).toBe(6);
    expect(parseSaveFile(h.controller.exportCurrent().text)).toMatchObject({ ok: true, envelope: { saveVersion: 9 } });
  });
  it('provides manual memory save/export when browser storage is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const session = new ApplicationSessionV9(); sessions.push(session); const controller = new ManagementSaveControllerV9(session); controllers.push(controller);
    await controller.start(); expect(controller.getSnapshot().mode).toBe('memory'); await controller.save(slotId);
    expect(controller.getSnapshot().notice).toBe('save.memorySaved'); session.frame(0); session.frame(50); await controller.load(slotId);
    expect(current(session).clock.simulationTick).toBe(0); expect(parseSaveFile(controller.exportCurrent().text).ok).toBe(true);
  });
  it('prepares import before any write, then atomically swaps and binds while preserving original bytes', async () => {
    const h = await harness(); await h.controller.save(slotId); const source = makeText('exact-import'); const confirmation = await select(h.controller, source);
    const prepare = vi.spyOn(h.session, 'prepareReplacement'); const commit = vi.spyOn(h.session, 'commitReplacement');
    const importSave = vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave');
    expect(await h.controller.commitImport(confirmation)).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(importSave.mock.invocationCallOrder[0]!);
    expect(importSave.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]!);
    expect(current(h.session).seed).toBe('exact-import'); expect(h.session.getSnapshot().paused).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({ boundSlot: slotId, readOnly: false, dirty: false, import: { phase: 'success' } });
    expect((await (await h.repository()).loadSlot(slotId)).snapshot.text).toBe(source);
  });
  it('rejects incompatible imports before storage and keeps old entries unable to import v9', async () => {
    const h = await harness(); await h.controller.save(slotId); const before = await h.inspect(); const world = current(h.session); const bound = h.controller.getSnapshot().boundSlot;
    expect(await h.controller.selectImportFile(file(exportWorldSave(createWorld(), metadata).text))).toBe(false);
    expect(await h.inspect()).toEqual(before); expect(current(h.session)).toEqual(world); expect(h.controller.getSnapshot().boundSlot).toBe(bound);
    const legacy = new SaveController(new ApplicationSession(), createWorld, { indexedDB: h.indexedDB }); controllers.push(legacy); await legacy.start();
    expect(await legacy.selectImportFile(file(makeText()))).toBe(false); expect(legacy.getSnapshot().import.notice).toBe('save.error.version');
  });
  it('fails replacement preparation before acquiring a lease or writing, preserving binding and live World', async () => {
    const h = await harness(); await h.controller.save(slotId); const confirmation = await select(h.controller);
    const before = await h.inspect(); const world = current(h.session); const bound = h.controller.getSnapshot().boundSlot;
    vi.spyOn(h.session, 'prepareReplacement').mockReturnValueOnce({ ok: false, kind: 'session-rejection', code: 'REPLACEMENT_STALE' });
    const write = vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave'); const acquire = vi.spyOn(IndexedDbSaveRepository.prototype, 'acquireLease');
    expect(await h.controller.commitImport(confirmation)).toBe(false); expect(write).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
    expect(await h.inspect()).toEqual(before); expect(current(h.session)).toEqual(world); expect(h.controller.getSnapshot().boundSlot).toBe(bound); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });
  it('cleans a prepared token on transaction failure without losing the old save, World or binding', async () => {
    let fail = false; const h = await harness({ faultInjector: stage => { if (fail && stage === 'after-pointer') throw new Error('Injected failure'); } });
    await h.controller.save(slotId); const confirmation = await select(h.controller); const before = await h.inspect(); const world = current(h.session);
    const discard = vi.spyOn(h.session, 'discardReplacement'); const commit = vi.spyOn(h.session, 'commitReplacement'); fail = true;
    expect(await h.controller.commitImport(confirmation)).toBe(false); expect(discard).toHaveBeenCalledTimes(1); expect(commit).not.toHaveBeenCalled();
    expect(await h.inspect()).toEqual(before); expect(current(h.session)).toEqual(world); expect(h.controller.getSnapshot().boundSlot).toBe(slotId);
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });
  it('blocks Session changes while prepared import awaits storage and keeps dirty state separate from selection', async () => {
    const h = await harness(); await h.controller.save(slotId); h.session.select({ kind: 'disciple', id: 'entity:1' }); expect(h.controller.getSnapshot().dirty).toBe(false);
    const confirmation = await select(h.controller); const original = IndexedDbSaveRepository.prototype.importSave;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let arrived!: () => void; const entered = new Promise<void>(resolve => { arrived = resolve; });
    vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbSaveRepository, text, options) { arrived(); await gate; return original.call(this, text, options); });
    const pending = h.controller.commitImport(confirmation); await entered;
    expect(h.session.getSnapshot().holds.storageBusy).toBe(true); expect(h.session.setSpeed(3)).toMatchObject({ ok: false });
    expect(h.session.select({ kind: 'disciple', id: 'entity:2' })).toMatchObject({ ok: false });
    release(); expect(await pending).toBe(true); expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
  });
  it('aborts pending import on stop/restart, then prevents stale completion from rebinding or swapping', async () => {
    const h = await harness(); await h.controller.save(slotId); const confirmation = await select(h.controller); const world = current(h.session);
    const original = IndexedDbSaveRepository.prototype.importSave; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void; const entered = new Promise<void>(resolve => { arrived = resolve; });
    vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbSaveRepository, text, options) { arrived(); await gate; return original.call(this, text, options); });
    const pending = h.controller.commitImport(confirmation); await entered; h.controller.stop(); const restart = h.controller.start(); release();
    expect(await pending).toBe(false); await restart; expect(current(h.session)).toEqual(world); expect(h.controller.getSnapshot()).toMatchObject({ mode: 'browser', busy: false, boundSlot: null });
    const stored = await (await h.repository()).loadSlot(slotId); expect(stored.slot.revision).toBe(1); expect(stored.world.seed).toBe('live-v9');
  });
  it('aborts in-flight import on Session close and does not commit or leak candidate tokens', async () => {
    const h = await harness(); const confirmation = await select(h.controller); const original = IndexedDbSaveRepository.prototype.importSave;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let arrived!: () => void; const entered = new Promise<void>(resolve => { arrived = resolve; });
    vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbSaveRepository, text, options) { arrived(); await gate; return original.call(this, text, options); });
    const commit = vi.spyOn(h.session, 'commitReplacement'); const pending = h.controller.commitImport(confirmation); await entered; h.session.close(); release();
    expect(await pending).toBe(false); expect(commit).not.toHaveBeenCalled(); expect((await h.inspect()).slots).toEqual([]);
  });
  it('keeps recovered loads readonly through explicit takeover, and fences lost ownership on save', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository(); const lease = await repo.acquireLease(slotId, 'competing', { takeover: true });
    await h.controller.save(slotId); expect(h.controller.getSnapshot().readOnly).toBe(true); expect(h.session.getSnapshot().holds.storage).toBe(true);
    await repo.saveText(slotId, makeText('newer'), { expectedRevision: 1, lease }); await h.corrupt('campaign-1:2'); h.setNow(lease.expiresAt);
    for (const takeover of [false, true]) { await h.controller.load(slotId, takeover); expect(h.controller.getSnapshot()).toMatchObject({ readOnly: true, notice: 'save.recoveredReadOnly' }); expect(h.controller.canSave(slotId)).toBe(false); }
    expect((await repo.loadSlot(slotId)).slot.currentSnapshotId).toBe('campaign-1:2'); expect(await repo.exportRawSnapshot(slotId, 'campaign-1:2')).toBe('{broken');
  });
  it('requires fresh target consent on stale import revision and keeps current live World unchanged', async () => {
    const h = await harness(); await h.controller.save(slotId); const confirmation = await select(h.controller); const world = current(h.session);
    const repo = await h.repository(); const lease = await repo.acquireLease(slotId, 'other', { takeover: true }); await repo.saveText(slotId, makeText('other'), { expectedRevision: 1, lease }); await repo.releaseLease(lease);
    expect(await h.controller.commitImport(confirmation)).toBe(false); expect(current(h.session)).toEqual(world); expect((await repo.loadSlot(slotId)).slot.revision).toBe(2);
    expect(h.controller.getSnapshot().import.phase).toBe('ready');
  });
  it.each(['new', 'load', 'import'] as const)('reconciles old readonly holds to writable after successful %s', async action => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository();
    const other = await repo.acquireLease(slotId, 'other', { takeover: true });
    await h.controller.save(slotId); expect(h.controller.getSnapshot().readOnly).toBe(true); expect(h.session.getSnapshot().holds.storage).toBe(true);
    await repo.releaseLease(other);
    if (action === 'new') expect(await h.controller.beginNewCampaign('fresh-writable')).toBe(true);
    if (action === 'load') await h.controller.load(slotId);
    if (action === 'import') {
      const text = makeText('import-writable'); expect(await h.controller.selectImportFile(file(text))).toBe(true);
      expect(h.controller.selectImportTarget('campaign-2')).toBe(true); const preview = h.controller.getSnapshot().import;
      expect(await h.controller.commitImport({ selectionId: preview.selectionId, slotId: 'campaign-2', expectedRevision: 0, overwriteConfirmed: false })).toBe(true);
    }
    expect(h.controller.getSnapshot().readOnly).toBe(false); expect(h.session.getSnapshot().holds.storage).toBe(false);
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false); expect(h.session.setPaused('player', false).ok).toBe(true);
    h.session.frame(0); h.session.frame(50); expect(h.session.getSnapshot().frame.clock.simulationTick).toBe(1);
  });

  it('does not resurrect a lease when a subscriber stops during replacement publication', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository();
    const inserted = await repo.importSave(makeText('second-slot'), { ownerId: 'setup', slotId: 'campaign-2' }); await repo.releaseLease(inserted.lease);
    const unsubscribe = h.controller.subscribe(() => { if (h.controller.getSnapshot().dirty) h.controller.stop(); });
    await h.controller.load('campaign-2'); unsubscribe();
    // Load has swapped already; cancellation must release newly acquired storage
    // ownership rather than claim to roll back that completed synchronous swap.
    expect(h.controller.getSnapshot().boundSlot).not.toBe('campaign-2');
    await expect(repo.acquireLease('campaign-2', 'after-stop')).resolves.toMatchObject({ ownerId: 'after-stop' });
  });

  it('releases idle ownership when its Session closes and never reopens a closed Session', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository();
    h.session.close();
    await vi.waitFor(async () => { await expect(repo.acquireLease(slotId, 'after-close')).resolves.toMatchObject({ ownerId: 'after-close' }); });
    await h.controller.start();
    expect(h.controller.canSave(slotId)).toBe(false);
  });

  it('checks the real stored revision when another writer advances after the load review', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository();
    const imported = await repo.importSave(makeText('reviewed-slot'), { ownerId: 'other', slotId: 'campaign-2' });
    await h.controller.refresh(); const reviewedRevision = h.controller.getSnapshot().slots[1]!.slot!.revision;
    const before = current(h.session); const epoch = h.session.getSnapshot().sessionEpoch; const binding = h.controller.getSnapshot().boundSlot;
    await repo.saveText('campaign-2', makeText('changed-after-review'), { expectedRevision: 1, lease: imported.lease }); await repo.releaseLease(imported.lease);
    // The controller's list still contains the confirmed older revision.
    expect(h.controller.getSnapshot().slots[1]!.slot!.revision).toBe(reviewedRevision);
    const acquire = vi.spyOn(IndexedDbSaveRepository.prototype, 'acquireLease');
    await h.controller.load('campaign-2', false, reviewedRevision);
    expect(acquire).not.toHaveBeenCalled(); expect(current(h.session)).toEqual(before); expect(h.session.getSnapshot().sessionEpoch).toBe(epoch);
    expect(h.controller.getSnapshot()).toMatchObject({ boundSlot: binding, readOnly: false, notice: 'save.error.conflict' });
    expect(h.session.getSnapshot().holds.storage).toBe(false); expect((await repo.loadSlot('campaign-2')).world.seed).toBe('changed-after-review');
  });
  it('checks again after lease acquisition and releases temporary ownership on a post-review revision mismatch', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository();
    const imported = await repo.importSave(makeText('reviewed-slot'), { ownerId: 'setup', slotId: 'campaign-2' }); await repo.releaseLease(imported.lease);
    await h.controller.refresh(); const before = current(h.session); const epoch = h.session.getSnapshot().sessionEpoch;
    const acquire = IndexedDbSaveRepository.prototype.acquireLease; let advanced = false;
    vi.spyOn(IndexedDbSaveRepository.prototype, 'acquireLease').mockImplementation(async function (this: IndexedDbSaveRepository, slot, owner, options) {
      if (slot === 'campaign-2' && !advanced) {
        advanced = true;
        const competing = await acquire.call(repo, slot, 'between-read-and-acquire');
        await repo.saveText(slot, makeText('changed-before-reread'), { expectedRevision: 1, lease: competing }); await repo.releaseLease(competing);
      }
      return acquire.call(this, slot, owner, options);
    });
    await h.controller.load('campaign-2', false, 1);
    expect(advanced).toBe(true); expect(current(h.session)).toEqual(before); expect(h.session.getSnapshot().sessionEpoch).toBe(epoch);
    expect(h.controller.getSnapshot()).toMatchObject({ boundSlot: slotId, readOnly: false, notice: 'save.error.conflict' });
    expect(h.session.getSnapshot().holds.storageBusy).toBe(false);
    await expect(repo.acquireLease('campaign-2', 'after-stale-load')).resolves.toMatchObject({ ownerId: 'after-stale-load' });
    expect((await repo.loadSlot('campaign-2')).world.seed).toBe('changed-before-reread');
  });

  it('does not bypass reviewed revision checks when a competing writer keeps the load readonly', async () => {
    const h = await harness(); await h.controller.save(slotId); const repo = await h.repository();
    const imported = await repo.importSave(makeText('reviewed-slot'), { ownerId: 'live-other', slotId: 'campaign-2' });
    await h.controller.refresh(); const before = current(h.session);
    const acquire = IndexedDbSaveRepository.prototype.acquireLease; let advanced = false;
    vi.spyOn(IndexedDbSaveRepository.prototype, 'acquireLease').mockImplementation(async function (this: IndexedDbSaveRepository, slot, owner, options) {
      if (slot === 'campaign-2' && !advanced) {
        advanced = true; await repo.saveText(slot, makeText('changed-while-busy'), { expectedRevision: 1, lease: imported.lease });
      }
      return acquire.call(this, slot, owner, options);
    });
    await h.controller.load('campaign-2', false, 1);
    expect(current(h.session)).toEqual(before); expect(h.controller.getSnapshot()).toMatchObject({ boundSlot: slotId, readOnly: false, notice: 'save.error.conflict' });
    expect(h.session.getSnapshot().holds.storage).toBe(false); expect((await repo.loadSlot('campaign-2')).slot.revision).toBe(2);
  });

});
