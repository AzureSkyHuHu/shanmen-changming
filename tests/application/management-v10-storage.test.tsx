import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementSaveControllerV10, type ManagementSaveStatusV10 } from '../../src/application/management-v10-save-controller';
import { ApplicationSessionV10 } from '../../src/application/session-v10';
import { createSaveEnvelopeV10, parseSaveV10, serializeSaveV10 } from '../../src/core/kernel/save-v10';
import { createSaveEnvelopeV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { ManagementStorageBodyV10, createManagementStorageSlotV10, createManagementStorageActionsV10,
  managementStorageMessagesV10, managementStorageMessageSpecificationsV10, createManagementStorageTranslatorV10,
  managementStorageStatusV10, managementStorageErrorV10, createManagementSaveDownloadV10,
  managementStorageFocusOwnerV10, focusManagementStorageReviewV10,
  type ManagementStorageControllerV10 } from '../../src/app/management-v10-storage';
import { formatManagementSaveDateV9 } from '../../src/app/ManagementSavePanelV9';
import { translate, validateLocales, type Locale, type TextKey } from '../../src/i18n';
import type { SaveFile } from '../../src/platform/files/save-files';
import { ManagementV10PersistenceError, type CampaignSlotId, type SlotManifest } from '../../src/platform/persistence/management-v10-types';
import { IndexedDbManagementV10Repository } from '../../src/platform/persistence/indexeddb-management-v10-repository';

const savedAt = '2026-10-02T23:00:00.000Z';
const metadata = { savedAt, buildId: 'storage-panel-test' };
const sessions: ApplicationSessionV10[] = []; const controllers: ManagementSaveControllerV10[] = [];
function session() { const value = new ApplicationSessionV10(); sessions.push(value); return value; }
function manifest(slotId: CampaignSlotId, revision = 4): SlotManifest {
  return { recordVersion: 1, slotId, revision, currentSnapshotId: `${slotId}:${revision}`, autoSnapshotIds: [], manualSnapshotId: `${slotId}:${revision}`, checkpointSnapshotId: null, savedAt };
}
function status(patch: Partial<ManagementSaveStatusV10> = {}): ManagementSaveStatusV10 {
  return { mode: 'browser', busy: false, readOnly: false, dirty: true, autosave: 'manual-only', slots: [{ slotId: 'campaign-1', slot: manifest('campaign-1') },
    { slotId: 'campaign-2', slot: null }, { slotId: 'campaign-3', slot: null }], boundSlot: 'campaign-1', lastSavedAt: savedAt,
    notice: null, lastAction: null, committed: null, rescue: null, load: null,
    import: { selectionId: 1, phase: 'idle', filename: null, seed: null, savedAt: null, migrated: false, target: null, notice: null }, ...patch };
}
function fakeController(initial = status()) {
  let state = initial; const listeners = new Set<() => void>(); const live = session();
  const publish = (patch: Partial<ManagementSaveStatusV10>) => { state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
  const controller: ManagementStorageControllerV10 = {
    getSnapshot: () => state, subscribe: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    canSave: slotId => state.mode === 'browser' && !state.busy && !state.readOnly && state.slots.some(row => row.slotId === slotId && (!row.slot || slotId === state.boundSlot)),
    save: vi.fn(async () => true), load: vi.fn(async () => true), refresh: vi.fn(async () => true),
    reviewLoad: vi.fn(slotId => {
      const slot = state.slots.find(row => row.slotId === slotId)?.slot; if (!slot) return null;
      const value = live.getSnapshot(); const review = { kind: 'v10-load-review' as const, slotId, expectedRevision: slot.revision, dirty: state.dirty,
        sessionEpoch: value.sessionEpoch, worldRevision: value.worldRevision, revision: value.revision };
      publish({ load: review }); return review;
    }), cancelLoad: vi.fn(() => publish({ load: null })), selectImportFile: vi.fn(async () => true),
    selectImportTarget: vi.fn(slotId => { const row = state.slots.find(row => row.slotId === slotId); if (!row || state.import.phase !== 'ready') return false;
      publish({ import: { ...state.import, target: { slotId, revision: row.slot?.revision ?? 0, occupied: !!row.slot } } }); return true; }),
    cancelImport: vi.fn(() => true), commitImport: vi.fn(async () => true),
    exportCurrent: vi.fn(() => ({ text: '{"live":true}', filename: 'live.json', mimeType: 'application/json' as const })),
    exportRawSnapshot: vi.fn(async () => ({ text: ' raw unsupported bytes ', filename: 'raw.json', mimeType: 'application/json' as const })),
    exportMigrationSource: vi.fn(async () => ({ text: ' untouched v9 bytes ', filename: 'source.json', mimeType: 'application/json' as const })),
  };
  return { controller, session: live, publish, listeners };
}
function actionsFor(h: ReturnType<typeof fakeController>) {
  const feedback = vi.fn<(key: TextKey | null) => void>(); const download = vi.fn<(file: SaveFile) => void>();
  const actions = createManagementStorageActionsV10(h.controller, h.session, feedback, download); actions.activate(); return { actions, feedback, download };
}
function render(state: ManagementSaveStatusV10, locale: Locale = 'zh-CN') {
  const h = fakeController(state);
  return renderToStaticMarkup(createElement(ManagementStorageBodyV10, { controller: h.controller, session: h.session, locale, feedback: vi.fn() }));
}
function ready(h: ReturnType<typeof fakeController>) {
  h.publish({ import: { ...h.controller.getSnapshot().import, phase: 'ready', filename: 'v10.json', seed: 'file-world', savedAt } });
}
afterEach(async () => { await Promise.all(controllers.splice(0).map(value => value.stop())); for (const value of sessions.splice(0)) value.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('private v10 storage adapter presentation', () => {
  it('constructs and renders without starting storage, subscribing eagerly, exporting or owning a second modal', () => {
    const h = fakeController(); const adapter = createManagementStorageSlotV10(h.controller);
    expect(adapter.getSnapshot()).toBe(adapter.getSnapshot()); expect(h.controller.subscribe).not.toHaveBeenCalled();
    const before = h.session.getSnapshot(); const hold = vi.spyOn(h.session, 'setOverlayPaused');
    const html = renderToStaticMarkup(adapter.renderBody({ session: h.session, locale: 'zh-CN', close: vi.fn() }));
    expect(html).not.toMatch(/<dialog|<header|<footer|role="status"/); expect(hold).not.toHaveBeenCalled();
    expect(h.session.getSnapshot()).toBe(before); expect(h.controller.exportCurrent).not.toHaveBeenCalled(); expect(h.controller.save).not.toHaveBeenCalled();
    expect(html).toContain('type="file"'); expect(html).toContain('accept=".json,application/json"'); expect(html).not.toContain('textarea');
    const source = readFileSync(new URL('../../src/app/management-v10-storage.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.start\(|\.stop\(|setOverlayPaused\(|indexedDB\.|openManagementV10Repository\(/);
  });
  it('returns stable snapshots and removes both adapter and controller subscriptions', () => {
    const h = fakeController(); const adapter = createManagementStorageSlotV10(h.controller); const listener = vi.fn();
    const stop = adapter.subscribe(listener); const first = adapter.getSnapshot(); h.publish({ readOnly: true });
    expect(listener).toHaveBeenCalledOnce(); expect(adapter.getSnapshot()).not.toBe(first); expect(adapter.getSnapshot().readOnly).toBe(true);
    expect(adapter.getSnapshot()).toBe(adapter.getSnapshot()); stop(); expect(h.listeners.size).toBe(0); h.publish({ readOnly: false }); expect(listener).toHaveBeenCalledOnce();
  });
  it.each<Locale>(['zh-CN', 'en'])('shows real binding, dirty/manual policy, exact slot revision and consistent %s timestamps', locale => {
    const state = status({ readOnly: true }); state.import = { ...state.import, phase: 'ready', seed: '<world>', filename: '<file>.json', savedAt };
    const html = render(state, locale); const date = formatManagementSaveDateV9(savedAt, locale);
    expect(html).toContain(translate(locale, 'managementV9.currentSlot', { number: 1 })); expect(html).toContain(translate(locale, 'managementV9.unsaved'));
    expect(html).toContain(translate(locale, 'managementV9.manualOnly')); expect(html).toContain(translate(locale, 'save.readOnly'));
    expect(html).toContain(translate(locale, 'save.revision', { revision: 4, date })); expect(html.split(date)).toHaveLength(4);
    expect(html).toContain('&lt;world&gt;'); expect(html).not.toContain('文本暂不可用'); expect(html).not.toContain(translate(locale, 'save.takeover'));
  });
  it('distinguishes recovery, unsupported data, unavailable storage and durable but unbound writes', () => {
    const state = status({ rescue: { reason: 'recovered', slotId: 'campaign-1', snapshotIds: ['campaign-1:4'] }, readOnly: true,
      notice: 'save.error.version', committed: { slotId: 'campaign-1', revision: 7, bound: false } });
    const html = render(state); expect(html).toContain('较早快照恢复'); expect(html).toContain('版本不受支持'); expect(html).toContain('版本 7'); expect(html).toContain('并未回滚');
    expect(render(status({ rescue: { reason: 'unreadable', slotId: 'campaign-1', snapshotIds: [] } }))).toContain('尚未成功读取');
    expect(render(status({ mode: 'unavailable' }))).toContain(translate('zh-CN', 'save.error.unavailable'));
    expect(render(status({ mode: 'stopped' }))).toContain('尚未启动或已停止');
  });
  it('describes an unbound write only as a historical fact, regardless of refreshed revisions or recovery', () => {
    const state = status({ lastAction: 'loaded', committed: { slotId: 'campaign-1', revision: 3, bound: false } });
    expect(render(state)).not.toContain('现已明确读取同一版本'); expect(render(state)).toContain('写入完成时尚未绑定到游戏');
    expect(render(state)).not.toContain('请刷新列表并重新读取'); expect(render(state)).not.toContain('但未绑定到当前会话');
    state.committed = { slotId: 'campaign-1', revision: 4, bound: false };
    state.rescue = { slotId: 'campaign-1', snapshotIds: ['campaign-1:4'], reason: 'recovered' };
    expect(render(state)).not.toContain('现已明确读取同一版本');
    state.rescue = null; state.boundSlot = 'campaign-2'; expect(render(state)).not.toContain('现已明确读取同一版本');
  });
  it('keeps every database control disabled while busy and export available without browser storage', () => {
    const html = render(status({ busy: true }));
    for (const control of html.match(/<(?:button|input|select)\b[^>]*>/g) ?? []) expect(control).toContain('disabled=""');
    const unavailable = render(status({ mode: 'unavailable', boundSlot: null, lastSavedAt: null }));
    expect(unavailable).toContain(`<button type="button" class="secondary">${translate('zh-CN', 'save.export')}</button>`);
  });
  it('localizes private keys with validated parameters and per-key Chinese fallback', () => {
    const zh = Object.fromEntries(Object.entries(managementStorageMessagesV10).map(([key, values]) => [key, values[0]]));
    const en = Object.fromEntries(Object.entries(managementStorageMessagesV10).map(([key, values]) => [key, values[1]]));
    expect(validateLocales(zh, en, managementStorageMessageSpecificationsV10).valid).toBe(true);
    const t = createManagementStorageTranslatorV10('en', { ...en, 'storageV10.loadReview': '' });
    expect(t('storageV10.loadReview', { number: 2, revision: 1234 })).toBe('读取存档 2 的版本 1,234');
    expect(t('storageV10.importConfirm')).toBe('Confirm import and load');
  });
  it('does not leak legacy false-success/force-takeover copy or raw error strings into feedback', () => {
    const state = status({ dirty: false, lastAction: 'imported' }); state.import = { ...state.import, phase: 'success', notice: 'save.import.success' };
    expect(managementStorageStatusV10(state).notice?.key).toBe('managementV9.savedBoundary');
    expect(render(state)).not.toContain('当前进度保持不变'); expect(render(state)).toContain('保留文件中的暂停状态');
    state.dirty = true; expect(managementStorageStatusV10(state).notice?.key).toBe('managementV9.unsaved');
    state.notice = 'save.error.leaseBusy'; expect(managementStorageStatusV10(state).notice?.key).toBe('save.readOnly');
    expect(managementStorageErrorV10(new ManagementV10PersistenceError('QUOTA_EXCEEDED', 'secret diagnostic'))).toBe('save.error.quota');
    expect(managementStorageErrorV10(new ManagementV10PersistenceError('INVALID_SAVE', 'internal', { saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' }))).toBe('save.error.version');
    expect(managementStorageErrorV10(new Error('UNTRUSTED_CODE'))).toBe('save.error.transaction');
  });
});

describe('v10 storage action fences', () => {
  it('keeps storage-review focus in its owning overlay and rejects changed owners, selections, epochs and busy/closed Sessions', () => {
    const live = session(); live.setOverlayPaused(true); const basis = live.getSnapshot();
    expect(managementStorageFocusOwnerV10(live, live, basis)).toBe(true);
    const other = { getSnapshot: () => basis, subscribe: vi.fn() };
    expect(managementStorageFocusOwnerV10(live, other, basis)).toBe(false);
    let current = basis; const owner = { getSnapshot: () => current, subscribe: vi.fn() };
    for (const changed of [
      { ...basis, sessionEpoch: basis.sessionEpoch + 1 }, { ...basis, selection: { kind: 'disciple' as const, id: 'different' } },
      { ...basis, holds: { ...basis.holds, storageBusy: true } }, { ...basis, closed: true },
    ]) { current = changed; expect(managementStorageFocusOwnerV10(owner, owner, basis)).toBe(false); }
    const source = readFileSync(new URL('../../src/app/management-v10-storage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('mounted.current && managementStorageFocusOwnerV10(session, latest.current.session, intent.basis)');
    expect(source).not.toContain('autoFocus');
  });
  it.each(['button', 'select'] as const)('enters only explicit %s reviews and restores the stable cancellation target', kind => {
    const body = {} as HTMLElement; const inside = {} as HTMLElement; const documentPort = { activeElement: body as Element, body };
    const opener = { isConnected: true, matches: (selector: string) => selector === 'select' && kind === 'select', focus: vi.fn() } as unknown as HTMLElement;
    const target = { isConnected: true, matches: () => false, focus: vi.fn() } as unknown as HTMLElement;
    const first = { focus: vi.fn(() => { documentPort.activeElement = inside; }) };
    const region = { isConnected: true, contains: (node: Node | null) => node === inside, querySelector: () => first, focus: vi.fn() } as unknown as HTMLElement;
    documentPort.activeElement = opener;
    const restore = focusManagementStorageReviewV10({ region, focus: { opener, restoreTo: target }, document: documentPort, canEnter: () => true, canRestore: () => true });
    expect(first.focus).toHaveBeenCalledTimes(kind === 'button' ? 1 : 0);
    documentPort.activeElement = inside; restore(); expect(target.focus).toHaveBeenCalledOnce(); expect(opener.focus).not.toHaveBeenCalled();
  });
  it.each(['owner', 'moved', 'disabled', 'detached'] as const)('does not restore a storage review after %s changes', change => {
    const body = {} as HTMLElement; const inside = {} as HTMLElement; const outside = {} as HTMLElement;
    const opener = { isConnected: change !== 'detached', matches: (selector: string) => selector !== 'select' && change === 'disabled', focus: vi.fn() } as unknown as HTMLElement;
    const documentPort = { activeElement: opener as Element, body };
    const first = { focus: vi.fn(() => { documentPort.activeElement = inside; }) };
    const region = { isConnected: true, contains: (node: Node | null) => node === inside, querySelector: () => first, focus: vi.fn() } as unknown as HTMLElement;
    const restore = focusManagementStorageReviewV10({ region, focus: { opener }, document: documentPort, canEnter: () => true, canRestore: () => change !== 'owner' });
    if (change === 'moved') documentPort.activeElement = outside;
    restore(); expect(opener.focus).not.toHaveBeenCalled();
  });
  it('requires a separate dirty-replacement acknowledgement and consumes the exact load token once', async () => {
    const h = fakeController(); const { actions } = actionsFor(h); const review = actions.beginLoad(h.session.getSnapshot(), 'campaign-1')!;
    expect(await actions.confirmLoad(review, false)).toBe(false); expect(h.controller.load).not.toHaveBeenCalled();
    const first = actions.confirmLoad(review, true); const second = actions.confirmLoad(review, true);
    expect(await first).toBe(true); expect(await second).toBe(false); expect(h.controller.load).toHaveBeenCalledExactlyOnceWith(review.review, true);
  });
  it.each(['selection', 'revision', 'slot', 'token'] as const)('rejects a changed %s before load', async changed => {
    const h = fakeController(); const { actions } = actionsFor(h); const intent = actions.beginLoad(h.session.getSnapshot(), 'campaign-1')!;
    if (changed === 'selection') h.session.select(null);
    else if (changed === 'revision') h.session.setOverlayPaused(true);
    else if (changed === 'slot') h.publish({ slots: [{ slotId: 'campaign-1', slot: manifest('campaign-1', 5) }] });
    else h.publish({ load: { ...intent.review } });
    expect(await actions.confirmLoad(intent, true)).toBe(false); expect(h.controller.load).not.toHaveBeenCalled();
  });
  it('requires both occupied-target overwrite and dirty replacement and submits full selection/revision tokens', async () => {
    const h = fakeController(); ready(h); const { actions } = actionsFor(h); const intent = actions.selectTarget(h.session.getSnapshot(), 'campaign-1')!;
    expect(await actions.confirmImport(intent, false, true)).toBe(false); expect(await actions.confirmImport(intent, true, false)).toBe(false);
    expect(h.controller.commitImport).not.toHaveBeenCalled(); const first = actions.confirmImport(intent, true, true); const second = actions.confirmImport(intent, true, true);
    expect(await first).toBe(true); expect(await second).toBe(false);
    expect(h.controller.commitImport).toHaveBeenCalledExactlyOnceWith({ selectionId: 1, slotId: 'campaign-1', expectedRevision: 4, overwriteConfirmed: true, replaceDirtyConfirmed: true });
  });
  it.each(['selectionId', 'targetRevision', 'sessionRevision', 'dirty', 'copied'] as const)('stales import acknowledgement after %s changes', async changed => {
    const h = fakeController(); ready(h); const { actions } = actionsFor(h); const intent = actions.selectTarget(h.session.getSnapshot(), 'campaign-1')!;
    const preview = h.controller.getSnapshot().import;
    if (changed === 'selectionId') h.publish({ import: { ...preview, selectionId: 2 } });
    else if (changed === 'targetRevision') h.publish({ import: { ...preview, target: { slotId: 'campaign-1', revision: 5, occupied: true } } });
    else if (changed === 'sessionRevision') h.session.setReviewPaused(true);
    else if (changed === 'dirty') h.publish({ dirty: false });
    expect(await actions.confirmImport(changed === 'copied' ? { ...intent } : intent, true, true)).toBe(false); expect(h.controller.commitImport).not.toHaveBeenCalled();
  });
  it('does not turn a false save result or null backup into success and does not claim an old success', async () => {
    const h = fakeController(status({ notice: 'save.saved' })); const { actions, feedback, download } = actionsFor(h);
    vi.mocked(h.controller.save).mockResolvedValue(false); expect(await actions.save(h.session.getSnapshot(), 'campaign-1')).toBe(false); expect(feedback).toHaveBeenLastCalledWith('managementV9.stale');
    vi.mocked(h.controller.exportMigrationSource).mockResolvedValue(null); expect(await actions.exportSource(h.session.getSnapshot(), 'campaign-1')).toBe(false);
    expect(download).not.toHaveBeenCalled(); expect(feedback).not.toHaveBeenCalledWith('save.exported');
  });
  it('rechecks Session ownership after synchronous feedback subscribers change the displayed boundary', async () => {
    const h = fakeController(); const feedback = vi.fn((key: TextKey | null) => { if (key === null) h.session.select(null); });
    const actions = createManagementStorageActionsV10(h.controller, h.session, feedback, vi.fn()); actions.activate();
    expect(await actions.save(h.session.getSnapshot(), 'campaign-1')).toBe(false); expect(h.controller.save).not.toHaveBeenCalled();
  });
  it.each([
    ['save', 'save.error.quota'], ['save', 'save.error.leaseLost'], ['source', 'save.error.missing'], ['raw', 'save.error.transaction'],
  ] as const)('reports the current %s failure %s instead of a previous invalid-import version notice', async (operation, notice) => {
    const state = status(); state.import = { ...state.import, phase: 'error', notice: 'save.error.version', filename: 'invalid-v9.json' };
    const h = fakeController(state); const { actions, feedback, download } = actionsFor(h);
    if (operation === 'save') vi.mocked(h.controller.save).mockImplementationOnce(async () => { h.publish({ notice }); return false; });
    else if (operation === 'source') vi.mocked(h.controller.exportMigrationSource).mockImplementationOnce(async () => { h.publish({ notice }); return null; });
    else vi.mocked(h.controller.exportRawSnapshot).mockImplementationOnce(async () => { h.publish({ notice }); return null; });
    const result = operation === 'save' ? await actions.save(h.session.getSnapshot(), 'campaign-1')
      : operation === 'source' ? await actions.exportSource(h.session.getSnapshot(), 'campaign-1') : await actions.exportRaw(h.session.getSnapshot(), 'campaign-1', 'campaign-1:4');
    expect(result).toBe(false); expect(feedback).toHaveBeenLastCalledWith(notice); expect(feedback).not.toHaveBeenCalledWith('save.error.version');
    expect(download).not.toHaveBeenCalled(); expect(h.controller.getSnapshot().import.notice).toBe('save.error.version');
  });
  it('passes through exact current/raw/source bytes and reports only prepared downloads', async () => {
    const h = fakeController(); const { actions, download, feedback } = actionsFor(h);
    expect(await actions.exportCurrent(h.session.getSnapshot())).toBe(true);
    expect(await actions.exportRaw(h.session.getSnapshot(), 'campaign-1', 'campaign-1:4')).toBe(true);
    expect(await actions.exportSource(h.session.getSnapshot(), 'campaign-1')).toBe(true);
    expect(download.mock.calls.map(([file]) => file.text)).toEqual(['{"live":true}', ' raw unsupported bytes ', ' untouched v9 bytes ']);
    expect(feedback).toHaveBeenLastCalledWith('save.exported');
    expect(h.controller.exportRawSnapshot).toHaveBeenCalledExactlyOnceWith('campaign-1', 'campaign-1:4');
  });
  it('cancels file review on disposal and ignores late completion from an older mount', async () => {
    const h = fakeController(); let finish!: (value: boolean) => void;
    vi.mocked(h.controller.selectImportFile).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { actions, feedback } = actionsFor(h); const pending = actions.selectFile(h.session.getSnapshot(), { name: 'a', size: 1, text: async () => 'a' });
    actions.deactivate(); actions.activate(); feedback.mockClear(); finish(true);
    expect(await pending).toBe(false); expect(h.controller.cancelImport).toHaveBeenCalled(); expect(feedback).not.toHaveBeenCalled();
  });
  it('revokes owned Blob URLs on replacement, disposal, and failed browser download', () => {
    const click = vi.fn(); const remove = vi.fn(); const append = vi.fn(); const createObjectURL = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second').mockReturnValueOnce('blob:failure'); const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL }); vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click, remove }), body: { append } });
    const owner = createManagementSaveDownloadV10(); const file: SaveFile = { filename: 'save.json', mimeType: 'application/json', text: ' bytes ' };
    owner.download(file); owner.download(file); expect(revokeObjectURL).toHaveBeenCalledWith('blob:first'); owner.dispose(); expect(revokeObjectURL).toHaveBeenCalledWith('blob:second');
    click.mockImplementationOnce(() => { throw new Error('blocked'); }); expect(() => owner.download(file)).toThrow('blocked'); expect(revokeObjectURL).toHaveBeenCalledWith('blob:failure'); expect(remove).toHaveBeenCalledTimes(3);
  });
  it('revokes a prepared Blob URL when the download anchor cannot be constructed', () => {
    const createObjectURL = vi.fn(() => 'blob:no-anchor'); const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('document', { createElement: () => { throw new Error('no document element'); } });
    const owner = createManagementSaveDownloadV10();
    expect(() => owner.download({ filename: 'save.json', mimeType: 'application/json', text: ' exact bytes ' })).toThrow('no document element');
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:no-anchor'); owner.dispose(); expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
});

describe('v10 storage panel with its real controller', () => {
  it('does not infer a rev2 Session binding from a refreshed manifest after a rev1 load and an unbound rev2 overwrite', async () => {
    const live = session(); const controller = new ManagementSaveControllerV10(live, { indexedDB: new IDBFactory() }); controllers.push(controller); await controller.start();
    const actions = createManagementStorageActionsV10(controller, live, vi.fn(), vi.fn()); actions.activate();
    expect(await actions.save(live.getSnapshot(), 'campaign-1')).toBe(true);
    const first = actions.beginLoad(live.getSnapshot(), 'campaign-1')!; expect(await actions.confirmLoad(first, false)).toBe(true);
    const original = parseSaveV10(controller.exportCurrent().text); expect(original.ok).toBe(true);
    const replacement = serializeSaveV10(createSaveEnvelopeV10(createUnregisteredWorldV10('unbound-rev2-file'), metadata));
    expect(await actions.selectFile(live.getSnapshot(), { name: 'rev2.json', size: replacement.length, text: async () => replacement })).toBe(true);
    const target = actions.selectTarget(live.getSnapshot(), 'campaign-1')!; expect(target.revision).toBe(1);
    let invalidated = false;
    const stop = controller.subscribe(() => {
      const receipt = controller.getSnapshot().committed;
      if (!invalidated && receipt?.revision === 2 && !receipt.bound) { invalidated = true; live.setStorageBusy(false); }
    });
    expect(await actions.confirmImport(target, true, false)).toBe(false); stop(); expect(invalidated).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ boundSlot: 'campaign-1', lastAction: 'loaded', committed: { slotId: 'campaign-1', revision: 2, bound: false } });
    expect(await actions.refresh(live.getSnapshot())).toBe(true);
    expect(controller.getSnapshot().slots.find(row => row.slotId === 'campaign-1')?.slot?.revision).toBe(2);
    const current = parseSaveV10(controller.exportCurrent().text); expect(current.ok).toBe(true);
    expect(current.ok && current.world).toEqual(original.ok && original.world);
    const html = renderToStaticMarkup(createElement(ManagementStorageBodyV10, { controller, session: live, locale: 'zh-CN', feedback: vi.fn() }));
    expect(html).toContain('版本 2；写入完成时尚未绑定到游戏'); expect(html).toContain('此记录保留当时的结果');
    expect(html).not.toContain('现已明确读取同一版本'); expect(html).not.toContain('但未绑定到当前会话'); expect(html).not.toContain('请刷新列表并重新读取');
    actions.deactivate();
  }, 20000);
  it('keeps the durable unbound receipt historical before and after refresh and explicit load', async () => {
    const live = session(); const controller = new ManagementSaveControllerV10(live, { indexedDB: new IDBFactory() }); controllers.push(controller); await controller.start();
    const actions = createManagementStorageActionsV10(controller, live, vi.fn(), vi.fn()); actions.activate();
    const body = () => renderToStaticMarkup(createElement(ManagementStorageBodyV10, { controller, session: live, locale: 'zh-CN', feedback: vi.fn() }));
    const text = serializeSaveV10(createSaveEnvelopeV10(createUnregisteredWorldV10('durable-unbound-panel'), metadata));
    expect(await actions.selectFile(live.getSnapshot(), { name: 'v10.json', size: text.length, text: async () => text })).toBe(true);
    const intent = actions.selectTarget(live.getSnapshot(), 'campaign-1')!;
    const original = IndexedDbManagementV10Repository.prototype.importSave;
    const write = vi.spyOn(IndexedDbManagementV10Repository.prototype, 'importSave').mockImplementationOnce(async function (this: IndexedDbManagementV10Repository, value, options) {
      const result = await original.call(this, value, options); void controller.stop(); return result;
    });
    expect(await actions.confirmImport(intent, false, true)).toBe(false); await controller.stop(); write.mockRestore();
    const receipt = controller.getSnapshot().committed; expect(receipt).toEqual({ slotId: 'campaign-1', revision: 1, bound: false });
    expect(body()).toContain('写入完成时尚未绑定到游戏'); expect(body()).toContain('并未回滚');
    await controller.start(); expect(await actions.refresh(live.getSnapshot())).toBe(true);
    const review = actions.beginLoad(live.getSnapshot(), 'campaign-1')!; expect(review.review.expectedRevision).toBe(1);
    expect(await actions.confirmLoad(review, true)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ boundSlot: 'campaign-1', lastAction: 'loaded', rescue: null, committed: receipt });
    expect(controller.getSnapshot().slots.find(row => row.slotId === 'campaign-1')?.slot?.revision).toBe(1);
    expect(body()).toContain('写入完成时尚未绑定到游戏'); expect(body()).toContain('此记录保留当时的结果');
    expect(body()).not.toContain('现已明确读取同一版本');
    expect(body()).not.toContain('请刷新列表并重新读取'); expect(body()).not.toContain('但未绑定到当前会话');
    const parsed = parseSaveV10(controller.exportCurrent().text); expect(parsed.ok && parsed.world.seed).toBe('durable-unbound-panel');
    actions.deactivate();
  }, 20000);
  it('strictly rejects a real v9 file without changing the world, then imports v10 with both explicit acknowledgements', async () => {
    const live = session(); const controller = new ManagementSaveControllerV10(live, { indexedDB: new IDBFactory() }); controllers.push(controller); await controller.start();
    const feedback = vi.fn(); const actions = createManagementStorageActionsV10(controller, live, feedback, vi.fn()); actions.activate();
    expect(await actions.save(live.getSnapshot(), 'campaign-1')).toBe(true);
    const before = live.getSnapshot(); const old = serializeSaveV9(createSaveEnvelopeV9(createUnregisteredWorldV9(), metadata));
    expect(await actions.selectFile(before, { name: 'old-v9.json', size: old.length, text: async () => old })).toBe(false);
    expect(live.getSnapshot()).toBe(before); expect(controller.getSnapshot().import.notice).toBe('save.error.version');
    expect(managementStorageStatusV10(controller.getSnapshot()).notice?.key).toBe('save.error.version');
    live.setPaused('player', true); const text = serializeSaveV10(createSaveEnvelopeV10(createUnregisteredWorldV10('real-panel-import'), metadata));
    expect(await actions.selectFile(live.getSnapshot(), { name: 'v10.json', size: text.length, text: async () => text })).toBe(true);
    const intent = actions.selectTarget(live.getSnapshot(), 'campaign-1')!; expect(intent).toMatchObject({ dirty: true, occupied: true, revision: 1 });
    expect(await actions.confirmImport(intent, true, false)).toBe(false); expect(await actions.confirmImport(intent, true, true)).toBe(true);
    const parsed = parseSaveV10(controller.exportCurrent().text); expect(parsed.ok && parsed.world.seed).toBe('real-panel-import');
    expect(controller.getSnapshot()).toMatchObject({ boundSlot: 'campaign-1', dirty: false, lastAction: 'imported', committed: { revision: 2, bound: true } });
    expect(managementStorageStatusV10(controller.getSnapshot()).notice?.key).toBe('managementV9.savedBoundary');
    actions.deactivate();
  }, 20000);
});
