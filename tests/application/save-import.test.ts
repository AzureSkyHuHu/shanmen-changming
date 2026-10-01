import { IDBFactory } from 'fake-indexeddb';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SaveImportPanel } from '../../src/app/SaveImportPanel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { SaveController, type ImportFileSource } from '../../src/application/save-controller';
import { createWorld, SIMULATION_VERSION } from '../../src/core/kernel';
import { exportWorldSave, MAX_SAVE_FILE_BYTES } from '../../src/platform/files/save-files';
import { IndexedDbSaveRepository, openSaveRepository, PersistenceError, type CampaignSlotId } from '../../src/platform/persistence';
import legacyFixture from '../agents/fixtures/save-v1-in-progress.json';

const metadata = { buildId: 'save-import-tests', savedAt: '2026-10-01T00:00:00.000Z' };
const controllers: SaveController[] = [];
const repositories: IndexedDbSaveRepository[] = [];
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fileFromText(text: string, name = 'campaign.json'): ImportFileSource { return { name, size: new TextEncoder().encode(text).byteLength, text: vi.fn(async () => text) }; }
function source(seed = 'incoming'): ImportFileSource { return fileFromText(exportWorldSave(createWorld(seed), metadata).text); }
async function setup(seed = 'active-campaign') {
  const session = new ApplicationSession(createWorld(seed));
  const controller = new SaveController(session); controllers.push(controller); await controller.start();
  return { session, controller };
}
async function repo() { const repository = await openSaveRepository(); repositories.push(repository); return repository; }
async function prepare(controller: SaveController, slotId: CampaignSlotId = 'campaign-1', file = source()) {
  expect(await controller.selectImportFile(file)).toBe(true);
  expect(controller.selectImportTarget(slotId)).toBe(true);
  const preview = controller.getSnapshot().import;
  return { selectionId: preview.selectionId, slotId, expectedRevision: preview.target!.revision, overwriteConfirmed: false };
}
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); for (const controller of controllers.splice(0)) controller.stop(); for (const repository of repositories.splice(0)) repository.close(); vi.unstubAllGlobals(); });

describe('explicit file selection and validation', () => {
  it.each([MAX_SAVE_FILE_BYTES + 1, -1, 1.5, Infinity])('rejects invalid size %s before calling File.text', async (size) => {
    const { controller, session } = await setup();
    const before = session.exportWorld(); const read = vi.fn(async () => '{}');
    expect(await controller.selectImportFile({ name: 'too-large.json', size, text: read })).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(controller.getSnapshot().import.notice).toBe('save.import.tooLarge');
    expect(session.exportWorld()).toEqual(before);
  });
  it('checks UTF8 byte size after reading as well as the declared file size', async () => {
    const { controller } = await setup();
    expect(await controller.selectImportFile({ name: 'underreported.json', size: 1, text: async () => '界'.repeat(Math.floor(MAX_SAVE_FILE_BYTES / 3) + 1) })).toBe(false);
    expect(controller.getSnapshot().import.notice).toBe('save.import.tooLarge');
  });
  it('rejects corrupt and unsupported future saves without changing the campaign or slots', async () => {
    const { controller, session } = await setup();
    await controller.save('campaign-1');
    const before = session.exportWorld(); const revision = controller.getSnapshot().slots[0]!.slot!.revision;
    expect(await controller.selectImportFile(fileFromText('{bad'))).toBe(false);
    expect(controller.getSnapshot().import.notice).toBe('save.error.invalid');
    const future = JSON.parse(exportWorldSave(createWorld('future'), metadata).text);
    future.saveVersion += 999;
    expect(await controller.selectImportFile(fileFromText(JSON.stringify(future)))).toBe(false);
    expect(controller.getSnapshot().import.notice).toBe('save.error.version');
    expect(session.exportWorld()).toEqual(before);
    expect(controller.getSnapshot().slots[0]!.slot!.revision).toBe(revision);
    expect((await (await repo()).loadSlot('campaign-1')).world.seed).toBe(before.seed);
  });
  it('reports read failure and keeps the active campaign unchanged', async () => {
    const { controller, session } = await setup(); const before = session.exportWorld();
    await controller.selectImportFile({ name: 'missing.json', size: 100, text: async () => { throw new Error('unreadable'); } });
    expect(controller.getSnapshot().import).toMatchObject({ phase: 'error', notice: 'save.import.readError' });
    expect(session.exportWorld()).toEqual(before);
  });
  it('keeps an untrusted filename as plain preview text and publishes immutable stable snapshots', async () => {
    const { controller } = await setup();
    const file = fileFromText(exportWorldSave(createWorld('preview'), metadata).text, '<img src=x onerror=alert(1)>.json');
    await controller.selectImportFile(file);
    const snapshot = controller.getSnapshot();
    expect(snapshot.import.filename).toBe(file.name);
    expect(snapshot.import.seed).toBe('preview');
    expect(snapshot.import.phase).toBe('ready');
    expect(Object.isFrozen(snapshot.import)).toBe(true);
    expect(controller.getSnapshot()).toBe(snapshot);
    const markup = renderToStaticMarkup(createElement(SaveImportPanel, { controller, locale: 'en' }));
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;.json');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('type="file"');
  });
  it('validates in memory-only mode but never pretends to commit the imported file', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { controller, session } = await setup(); const before = session.exportWorld();
    expect(controller.getSnapshot().mode).toBe('memory');
    const confirmation = await prepare(controller);
    expect(await controller.commitImport(confirmation)).toBe(false);
    expect(controller.getSnapshot().import.notice).toBe('save.import.memoryOnly');
    expect(controller.getSnapshot().slots.every((entry) => entry.slot === null)).toBe(true);
    expect(session.exportWorld()).toEqual(before);
  });
});

describe('file-selection races and cancellation', () => {
  it('ignores an older read that resolves after a newer file has been selected', async () => {
    const { controller } = await setup();
    const slow = deferred<string>();
    const old = controller.selectImportFile({ name: 'older.json', size: 100, text: () => slow.promise });
    await controller.selectImportFile(source('newer-selection'));
    const snapshot = controller.getSnapshot();
    slow.resolve(await source('older-selection').text());
    expect(await old).toBe(false);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(snapshot.import.seed).toBe('newer-selection');
  });
  it('ignores an older read rejection after the newer preview is ready', async () => {
    const { controller } = await setup(); const slow = deferred<string>();
    const old = controller.selectImportFile({ name: 'older.json', size: 100, text: () => slow.promise });
    await controller.selectImportFile(source('newer')); const snapshot = controller.getSnapshot();
    slow.reject(new Error('old read failed')); await old;
    expect(controller.getSnapshot()).toBe(snapshot);
  });
  it('invalidates the pending read when the panel cleanup cancels its selection', async () => {
    const { controller, session } = await setup(); const before = session.exportWorld(); const slow = deferred<string>();
    const read = controller.selectImportFile({ name: 'unmounted.json', size: 100, text: () => slow.promise });
    expect(controller.cancelImport()).toBe(true); const cancelled = controller.getSnapshot();
    slow.resolve(await source().text()); await read;
    expect(controller.getSnapshot()).toBe(cancelled);
    expect(controller.getSnapshot().import.phase).toBe('idle');
    expect(session.exportWorld()).toEqual(before);
  });
  it('ignores a late read after controller unmount/stop', async () => {
    const { controller, session } = await setup(); const before = session.exportWorld(); const slow = deferred<string>();
    const read = controller.selectImportFile({ name: 'stopped.json', size: 100, text: () => slow.promise });
    controller.stop(); const stopped = controller.getSnapshot();
    slow.resolve(await source().text()); await read;
    expect(controller.getSnapshot()).toBe(stopped);
    expect(session.exportWorld()).toEqual(before);
  });
  it('a repeated file gets a new token and cannot reuse old target/overwrite consent', async () => {
    const { controller } = await setup(); const file = source('same-file');
    const stale = await prepare(controller, 'campaign-1', file);
    await controller.selectImportFile(file);
    expect(controller.getSnapshot().import.selectionId).not.toBe(stale.selectionId);
    expect(controller.getSnapshot().import.target).toBeNull();
    const snapshot = controller.getSnapshot();
    expect(await controller.commitImport({ ...stale, overwriteConfirmed: true })).toBe(false);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(controller.getSnapshot().slots.every((entry) => entry.slot === null)).toBe(true);
  });
  it('changing target invalidates a stale confirmation callback', async () => {
    const { controller } = await setup(); const stale = await prepare(controller, 'campaign-1');
    controller.selectImportTarget('campaign-2');
    expect(await controller.commitImport(stale)).toBe(false);
    expect(controller.getSnapshot().slots.every((entry) => entry.slot === null)).toBe(true);
  });
});

describe('atomic store-only import', () => {
  it('imports original bytes to an empty chosen slot without loading or altering the bound campaign', async () => {
    const { controller, session } = await setup();
    await controller.save('campaign-1');
    const before = session.exportWorld(); const replace = vi.spyOn(session, 'replaceWorld');
    const file = source('imported-second'); const confirmation = await prepare(controller, 'campaign-2', file);
    expect(await controller.commitImport(confirmation)).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect(session.exportWorld()).toEqual(before);
    expect(controller.getSnapshot()).toMatchObject({ boundSlot: 'campaign-1', busy: false, import: { phase: 'success', notice: 'save.import.success' } });
    const stored = await (await repo()).loadSlot('campaign-2');
    expect(stored.snapshot.text).toBe(await file.text());
    expect(stored.world.seed).toBe('imported-second');
    expect(controller.canSave('campaign-1')).toBe(true);
    expect(controller.canSave('campaign-2')).toBe(false);
  });
  it('requires explicit overwrite consent for the displayed revision and detaches only after commit', async () => {
    const { controller, session } = await setup(); await controller.save('campaign-1');
    const before = session.exportWorld(); const confirmation = await prepare(controller, 'campaign-1', source('replacement'));
    expect(confirmation.expectedRevision).toBe(1);
    expect(await controller.commitImport(confirmation)).toBe(false);
    expect(await controller.commitImport({ ...confirmation, expectedRevision: 0, overwriteConfirmed: true })).toBe(false);
    expect(controller.getSnapshot().boundSlot).toBe('campaign-1');
    expect(await controller.commitImport({ ...confirmation, overwriteConfirmed: true })).toBe(true);
    expect(session.exportWorld()).toEqual(before);
    expect(controller.getSnapshot()).toMatchObject({ boundSlot: null, lastSavedAt: null, readOnly: false });
    expect(controller.canSave('campaign-1')).toBe(false);
    const stored = await (await repo()).loadSlot('campaign-1');
    expect(stored.world.seed).toBe('replacement');
    expect(stored.slot.revision).toBe(2);
    // Loading remains a separate, explicit action after the import transaction succeeded.
    await controller.load('campaign-1');
    expect(session.exportWorld().seed).toBe('replacement');
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
  });
  it('retains the old campaign, bound slot and writer lease if atomic overwrite fails', async () => {
    const { controller, session } = await setup(); await controller.save('campaign-1');
    const before = session.exportWorld(); const confirmation = await prepare(controller);
    vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockRejectedValueOnce(new PersistenceError('TRANSACTION_FAILED', 'injected failure'));
    expect(await controller.commitImport({ ...confirmation, overwriteConfirmed: true })).toBe(false);
    expect(session.exportWorld()).toEqual(before);
    expect(controller.getSnapshot()).toMatchObject({ boundSlot: 'campaign-1', busy: false, import: { phase: 'ready', notice: 'save.error.transaction' } });
    expect(controller.getSnapshot().slots[0]!.slot!.revision).toBe(1);
    await controller.save('campaign-1');
    expect(controller.getSnapshot().slots[0]!.slot!.revision).toBe(2);
    expect((await (await repo()).loadSlot('campaign-1')).world.seed).toBe('active-campaign');
  });
  it('does not cancel, replace selection or issue a duplicate transaction once atomic commit starts', async () => {
    const { controller, session } = await setup(); const before = session.exportWorld();
    const confirmation = await prepare(controller); const gate = deferred<void>(); const entered = deferred<void>();
    const original = IndexedDbSaveRepository.prototype.importSave;
    const commitSpy = vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockImplementationOnce(async function (this: IndexedDbSaveRepository, text, options) { entered.resolve(); await gate.promise; return original.call(this, text, options); });
    const committing = controller.commitImport(confirmation); await entered.promise;
    expect(controller.getSnapshot().import.phase).toBe('committing');
    expect(controller.cancelImport()).toBe(false);
    const file = source('too-late');
    expect(await controller.selectImportFile(file)).toBe(false);
    expect(file.text).not.toHaveBeenCalled();
    expect(await controller.commitImport(confirmation)).toBe(false);
    expect(session.exportWorld()).toEqual(before);
    gate.resolve(); expect(await committing).toBe(true);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect((await (await repo()).loadSlot('campaign-1')).slot.revision).toBe(1);
  });
  it('suppresses a late storage callback after controller shutdown without loading a world', async () => {
    const { controller, session } = await setup(); const before = session.exportWorld();
    const confirmation = await prepare(controller); const gate = deferred<void>(); const written = deferred<void>();
    const original = IndexedDbSaveRepository.prototype.importSave;
    vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockImplementationOnce(async function (this: IndexedDbSaveRepository, text, options) { const result = await original.call(this, text, options); written.resolve(); await gate.promise; return result; });
    const committing = controller.commitImport(confirmation); await written.promise;
    controller.stop(); const stopped = controller.getSnapshot(); gate.resolve();
    expect(await committing).toBe(false);
    expect(controller.getSnapshot()).toBe(stopped);
    expect(session.exportWorld()).toEqual(before);
  });
  it('accepts a registered legacy migration while preserving raw bytes and current active progress', async () => {
    const { controller, session } = await setup(); const before = session.exportWorld(); const bytes = JSON.stringify(legacyFixture);
    const confirmation = await prepare(controller, 'campaign-3', fileFromText(bytes, 'legacy-v1.json'));
    expect(controller.getSnapshot().import.migrated).toBe(true);
    expect(await controller.commitImport(confirmation)).toBe(true);
    expect(session.exportWorld()).toEqual(before);
    const stored = await (await repo()).loadSlot('campaign-3');
    expect(stored.snapshot.text).toBe(bytes);
    expect(stored.world.simulationVersion).toBe(SIMULATION_VERSION);
    expect(Object.values(stored.world.transactions)[0]!.activeTicks).toBe(47);
  });
});

describe('occupied slot revision and lease races', () => {
  it('does not take over a live owner, even when overwrite was confirmed', async () => {
    const first = await setup('protected'); await first.controller.save('campaign-2');
    const { controller, session } = await setup(); const before = session.exportWorld();
    const confirmation = await prepare(controller, 'campaign-2');
    const acquire = vi.spyOn(IndexedDbSaveRepository.prototype, 'acquireLease');
    expect(await controller.commitImport({ ...confirmation, overwriteConfirmed: true })).toBe(false);
    expect(acquire).toHaveBeenCalledWith('campaign-2', expect.any(String));
    expect(controller.getSnapshot().import.notice).toBe('save.import.leaseBusy');
    expect(controller.getSnapshot().readOnly).toBe(false);
    expect(session.exportWorld()).toEqual(before);
    expect((await (await repo()).loadSlot('campaign-2')).world.seed).toBe('protected');
  });
  it('rejects a revision changed after preview and demands a fresh target selection', async () => {
    const storage = await repo();
    const initial = await storage.importSave(await source('stored-first').text(), { mode: 'new-slot', slotId: 'campaign-2', ownerId: 'external' });
    await storage.releaseLease(initial.lease);
    const { controller, session } = await setup(); const before = session.exportWorld();
    const confirmation = await prepare(controller, 'campaign-2');
    const lease = await storage.acquireLease('campaign-2', 'external');
    await storage.saveWorld('campaign-2', createWorld('stored-newer'), metadata, { expectedRevision: 1, lease });
    await storage.releaseLease(lease);
    expect(await controller.commitImport({ ...confirmation, overwriteConfirmed: true })).toBe(false);
    expect(controller.getSnapshot().import).toMatchObject({ phase: 'ready', target: null, notice: 'save.import.conflict' });
    expect(controller.getSnapshot().slots[1]!.slot!.revision).toBe(2);
    expect((await storage.loadSlot('campaign-2')).world.seed).toBe('stored-newer');
    expect(session.exportWorld()).toEqual(before);
  });
  it('never silently overwrites a slot that was empty at preview but populated before commit', async () => {
    const { controller } = await setup(); const confirmation = await prepare(controller, 'campaign-3'); const storage = await repo();
    await storage.importSave(await source('racing-campaign').text(), { mode: 'new-slot', slotId: 'campaign-3', ownerId: 'competitor' });
    expect(await controller.commitImport(confirmation)).toBe(false);
    expect(controller.getSnapshot().import.notice).toBe('save.import.conflict');
    expect((await storage.loadSlot('campaign-3')).world.seed).toBe('racing-campaign');
  });
  it('fences a lease takeover occurring after renewal and before the overwrite transaction', async () => {
    const { controller, session } = await setup(); await controller.save('campaign-1'); const before = session.exportWorld();
    const confirmation = await prepare(controller); const storage = await repo();
    const original = IndexedDbSaveRepository.prototype.importSave;
    vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockImplementationOnce(async function (this: IndexedDbSaveRepository, text, options) { await storage.acquireLease('campaign-1', 'competing-tab', { takeover: true }); return original.call(this, text, options); });
    expect(await controller.commitImport({ ...confirmation, overwriteConfirmed: true })).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ boundSlot: 'campaign-1', import: { notice: 'save.import.leaseLost' } });
    expect((await storage.loadSlot('campaign-1')).slot.revision).toBe(1);
    expect(session.exportWorld()).toEqual(before);
  });
});
