import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatManagementSaveDateV9, ManagementSavePanelV9, ManagementSaveSummaryV9 } from '../../src/app/ManagementSavePanelV9';
import { ManagementSaveControllerV9, type ManagementSaveStatusV9 } from '../../src/application/management-v9-save-controller';
import { ApplicationSessionV9 } from '../../src/application/session-v9';
import { createSaveEnvelopeV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { translate, type Locale, type TextKey, type TranslationParams } from '../../src/i18n';
import { IndexedDbSaveRepository, type CampaignSlotId, type SlotManifest } from '../../src/platform/persistence';

const savedAt = '2026-10-02T14:37:12.891Z';
const sessions: ApplicationSessionV9[] = [];
const controllers: ManagementSaveControllerV9[] = [];
function makeSession() { const session = new ApplicationSessionV9(); sessions.push(session); return session; }
function manifest(slotId: CampaignSlotId, date = savedAt): SlotManifest {
  return { recordVersion: 1, slotId, revision: 4, currentSnapshotId: `${slotId}:4`, autoSnapshotIds: [],
    manualSnapshotId: `${slotId}:4`, checkpointSnapshotId: null, savedAt: date };
}
function status(patch: Partial<ManagementSaveStatusV9> = {}): ManagementSaveStatusV9 {
  return { mode: 'browser', busy: false, readOnly: false, boundSlot: 'campaign-1', dirty: false, autosave: 'manual-only', lastSavedAt: savedAt, notice: null,
    slots: [{ slotId: 'campaign-1', slot: manifest('campaign-1') }, { slotId: 'campaign-2', slot: manifest('campaign-2') }, { slotId: 'campaign-3', slot: null }],
    import: { selectionId: 1, phase: 'idle', filename: null, seed: null, savedAt: null, migrated: false, target: null, notice: null }, ...patch };
}
function controllerFor(state: ManagementSaveStatusV9): ComponentProps<typeof ManagementSavePanelV9>['controller'] {
  return { getSnapshot: () => state, subscribe: () => () => {},
    canSave: slotId => !state.busy && !state.readOnly && state.mode !== 'opening'
      && state.slots.some(row => row.slotId === slotId && (row.slot === null || state.boundSlot === slotId)),
    save: vi.fn(async () => {}), load: vi.fn(async () => {}), refresh: vi.fn(async () => {}), selectImportFile: vi.fn(async () => true),
    selectImportTarget: vi.fn(() => true), cancelImport: vi.fn(() => true), commitImport: vi.fn(async () => true),
    exportCurrent: vi.fn(() => { throw new Error('Rendering must not export'); }) };
}
function renderPanel(state: ManagementSaveStatusV9, locale: Locale = 'zh-CN') {
  return renderToStaticMarkup(createElement(ManagementSavePanelV9, { controller: controllerFor(state), session: makeSession(), locale, onClose: vi.fn() }));
}
const t = (locale: Locale) => (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);
const feedbackOf = (html: string) => html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/)?.[1] ?? '';
afterEach(() => { for (const controller of controllers.splice(0)) controller.stop(); for (const session of sessions.splice(0)) session.close(); vi.restoreAllMocks(); });

describe('management v9 save presentation', () => {
  it.each<Locale>(['zh-CN', 'en'])('uses one explicit local-zone format in %s summary, slots and import preview', locale => {
    const expected = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, timeZoneName: 'shortOffset' }).format(new Date(savedAt));
    expect(formatManagementSaveDateV9(savedAt, locale)).toBe(expected);
    const state = status(); state.import = { ...state.import, phase: 'ready', seed: 'preview', filename: 'save.json', savedAt };
    const html = renderPanel(state, locale);
    expect(html.split(expected)).toHaveLength(5); // summary, two occupied slots, file preview
    expect(html).not.toContain(savedAt);
    const summary = renderToStaticMarkup(createElement(ManagementSaveSummaryV9, { status: state, t: t(locale), locale }));
    expect(summary).toContain(translate(locale, 'save.lastSuccess', { date: expected }));
    expect(summary).toContain('role="status"');
  });

  it.each<Locale>(['zh-CN', 'en'])('renders a localized fallback for missing or invalid %s timestamps', locale => {
    for (const date of [null, '', 'not-a-date', '2026-99-99T99:99:99Z']) {
      expect(formatManagementSaveDateV9(date, locale)).toBe(translate(locale, 'managementV9.unknownSaveTime'));
    }
    const state = status({ lastSavedAt: 'not-a-date', slots: [{ slotId: 'campaign-1', slot: manifest('campaign-1', 'not-a-date') }] });
    state.import = { ...state.import, phase: 'ready', seed: 'preview', savedAt: null };
    const html = renderPanel(state, locale);
    expect(html.split(translate(locale, 'managementV9.unknownSaveTime'))).toHaveLength(4);
    expect(html).not.toContain('Invalid Date'); expect(html).not.toContain('not-a-date');
  });

  it.each<Locale>(['zh-CN', 'en'])('names saves without changing slot identifiers and explains the %s occupied-slot restriction', locale => {
    const state = status(); state.import = { ...state.import, phase: 'ready', target: { slotId: 'campaign-2', revision: 4, occupied: true } };
    const html = renderPanel(state, locale);
    expect(html).toContain(`<h3>${translate(locale, 'managementV9.saveSlot', { number: 1 })} · ${translate(locale, 'managementV9.currentSave')}</h3>`);
    expect(html).toContain('<option value="campaign-2" selected="">');
    expect(html).not.toContain(translate(locale, 'save.slot', { number: 1 }));
    expect(html).not.toContain(translate(locale, 'save.import.emptyTarget'));
    const hint = translate(locale, 'managementV9.saveLoadFirst');
    expect(html.split(hint)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="[^"]*-campaign-2-load-hint"/);
    expect(html).toMatch(/<p[^>]*id="[^"]*-campaign-2-load-hint"/);
    expect(html).toContain(translate(locale, 'managementV9.importOverwriteWarning', { number: 2, revision: 4 }));
    expect(html).not.toContain(translate(locale, 'save.import.overwriteWarning', { number: 2, revision: 4 }));
  });

  it('does not mislabel read-only, opening or busy save restrictions as the occupied-slot rule', () => {
    for (const patch of [{ readOnly: true }, { mode: 'opening' as const }, { busy: true }]) {
      const html = renderPanel(status(patch));
      expect(html).not.toContain(translate('zh-CN', 'managementV9.saveLoadFirst'));
    }
  });

  it('keeps one feedback region outside the scrolling body, with the native heading and return control', () => {
    const html = renderPanel(status({ notice: 'save.loadedPaused' }));
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toMatch(/^<dialog[^>]*aria-labelledby="[^"]*-title"/);
    expect(html.indexOf('<header')).toBeLessThan(html.indexOf('class="management-v9-save-body"'));
    expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('class="management-v9-save-body"'));
    expect(html).toMatch(/<\/section><\/div><footer class="management-v9-save-feedback" role="status" aria-live="polite" aria-atomic="true">/);
    expect(feedbackOf(html)).toContain(translate('zh-CN', 'save.loadedPaused'));
    const css = readFileSync(new URL('../../src/app/management-v9-save.css', import.meta.url), 'utf8');
    expect(css).toMatch(/dialog\.management-v9-save-dialog\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/dialog\.management-v9-save-dialog\[open\]\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/\.management-v9-save-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.management-v9-save-feedback\s*\{[^}]*flex:\s*0 0 auto/s);
    const source = readFileSync(new URL('../../src/app/ManagementSavePanelV9.tsx', import.meta.url), 'utf8');
    expect(source).toContain('dialog.current?.showModal()'); expect(source).toContain('opener.focus()');
    expect(source).toContain('if (intent) confirmationButton.current?.focus()');
    expect(source).toContain('onCancel={event => { event.preventDefault(); close(); }}');
    expect(source).toContain('if (fresh()) { controller.cancelImport(); onClose(); }');
    expect(source).toContain('!controller.getSnapshot().busy && !session.getSnapshot().holds.storageBusy');
    expect(source).toContain('clearFeedback(); void controller.load(chosen.slotId, chosen.takeover, chosen.slotRevision)');
    expect(source).toContain('clearFeedback(); void controller.save(slotId)');
    expect(source).toContain('clearFeedback(); void controller.refresh()');
    expect(source).toContain('setImportIntent(null); clearFeedback(true);');
    expect(source).toContain('(showImportFeedback ? preview.notice : null)');
    expect(source.match(/onClose\(\)/g)).toHaveLength(1); // no close-on-success path
  });

  it.each(['reading', 'committing', 'error', 'success'] as const)('puts %s feedback in the single visible region', phase => {
    const state = status({ notice: null, busy: phase === 'committing' });
    const notice = phase === 'error' ? 'save.import.readError' : phase === 'success' ? 'managementV9.importLoadedPaused' : null;
    state.import = { ...state.import, phase, notice };
    const key = phase === 'reading' ? 'save.import.reading' : phase === 'committing' ? 'save.import.committing' : notice!;
    const html = renderPanel(state);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html.split(translate('zh-CN', key))).toHaveLength(2);
    expect(feedbackOf(html)).toContain(translate('zh-CN', key));
  });

  it('shows an import error ahead of old load feedback, but lets a new load replace old import success', () => {
    const state = status({ notice: 'save.loadedPaused' });
    state.import = { ...state.import, phase: 'error', notice: 'save.import.readError' };
    expect(feedbackOf(renderPanel(state))).toContain(translate('zh-CN', 'save.import.readError'));
    state.import = { ...state.import, phase: 'success', notice: 'managementV9.importLoadedPaused' };
    expect(feedbackOf(renderPanel(state))).toContain(translate('zh-CN', 'save.loadedPaused'));
  });

  it('keeps every action disabled during a busy import review', () => {
    const state = status({ busy: true }); state.import = { ...state.import, phase: 'ready', target: { slotId: 'campaign-2', revision: 4, occupied: true } };
    const html = renderPanel(state);
    const controls = html.match(/<(?:button|input|select)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) expect(control).toContain('disabled=""');
    expect(feedbackOf(html)).toContain(translate('zh-CN', 'managementV9.busy'));
  });

  it('keeps legacy import wording intact while v9 describes replacement and pause', () => {
    expect(translate('zh-CN', 'save.import.success')).toContain('当前进度保持不变');
    expect(translate('en', 'save.import.success')).toContain('Your current progress is unchanged');
    expect(translate('zh-CN', 'managementV9.importLoadedPaused')).toContain('加载为当前进度，保持暂停');
    expect(translate('en', 'managementV9.importLoadedPaused')).toContain('loaded as current progress, paused');
  });

  it('publishes the v9 success message only after the actual import loads paused and releases busy', async () => {
    const session = makeSession(); const controller = new ManagementSaveControllerV9(session, { indexedDB: new IDBFactory() }); controllers.push(controller);
    await controller.start();
    const text = serializeSaveV9(createSaveEnvelopeV9(createUnregisteredWorldV9('presentation-import'), { buildId: 'presentation-test', savedAt }));
    expect(await controller.selectImportFile({ name: 'save.json', size: text.length, text: async () => text })).toBe(true);
    expect(controller.selectImportTarget('campaign-2')).toBe(true);
    const preview = controller.getSnapshot().import;
    const original = IndexedDbSaveRepository.prototype.importSave;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void; const entered = new Promise<void>(resolve => { arrived = resolve; });
    vi.spyOn(IndexedDbSaveRepository.prototype, 'importSave').mockImplementation(async function (this: IndexedDbSaveRepository, source, options) {
      arrived(); await gate; return original.call(this, source, options);
    });
    const pending = controller.commitImport({ selectionId: preview.selectionId, slotId: 'campaign-2', expectedRevision: 0, overwriteConfirmed: false });
    try {
      await entered;
      expect(controller.getSnapshot().busy).toBe(true); expect(session.getSnapshot().holds.storageBusy).toBe(true);
      expect(controller.canSave('campaign-1')).toBe(false); expect(controller.cancelImport()).toBe(false);
      const busy = renderToStaticMarkup(createElement(ManagementSavePanelV9, { controller, session, locale: 'zh-CN', onClose: vi.fn() }));
      expect(feedbackOf(busy)).toContain(translate('zh-CN', 'save.import.committing'));
      for (const button of busy.match(/<button\b[^>]*>/g) ?? []) expect(button).toContain('disabled=""');
      expect(busy).not.toContain(translate('zh-CN', 'managementV9.importLoadedPaused'));
      release(); expect(await pending).toBe(true);
      expect(controller.getSnapshot()).toMatchObject({ busy: false, boundSlot: 'campaign-2', import: { phase: 'success', notice: 'managementV9.importLoadedPaused' } });
      expect(session.getSnapshot().paused).toBe(true); expect(session.getSnapshot().holds.storageBusy).toBe(false);
      const world = session.exportWorld(); expect(world.ok && world.value.seed).toBe('presentation-import');
      const complete = renderToStaticMarkup(createElement(ManagementSavePanelV9, { controller, session, locale: 'en', onClose: vi.fn() }));
      expect(feedbackOf(complete)).toContain(translate('en', 'managementV9.importLoadedPaused'));
    } finally { release(); await pending; }
  });
});
