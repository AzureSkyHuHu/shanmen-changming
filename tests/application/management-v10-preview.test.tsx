import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { StrictMode, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { RootOptions } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagementPreviewTranslatorV10, managementPreviewMessagesV10,
  managementPreviewMessageSpecificationsV10 } from '../../src/management-next';
import { validateLocales } from '../../src/i18n';

const root = vi.hoisted(() => ({ render: vi.fn<(node: ReactNode) => void>(), unmount: vi.fn(), options: null as RootOptions | null }));
vi.mock('react-dom/client', () => ({ createRoot: vi.fn((_container: HTMLElement, options?: RootOptions) => { root.options = options ?? null; return root; }) }));
type PreviewModule = typeof import('../../src/management-next');
let managementPreviewEntryV10: PreviewModule['managementPreviewEntryV10'];
let mountManagementPreviewV10: PreviewModule['mountManagementPreviewV10'];
type Entry = NonNullable<Awaited<ReturnType<typeof managementPreviewEntryV10>>>;
type Services = ReturnType<Entry['createServices']>;
const cleanups: Array<() => Promise<void>> = [];
const candidateModules = ['../../src/application/session-v10', '../../src/application/management-v10-save-controller',
  '../../src/app/management-v10-storage', '../../src/app/ManagementAppV10'] as const;
function rejectCandidateImports() {
  const touched = vi.fn<(path: string) => void>();
  for (const path of candidateModules) vi.doMock(path, () => { touched(path); throw new Error('Disabled candidate module must not be imported.'); });
  return touched;
}
async function services(): Promise<Services> {
  const entry = await managementPreviewEntryV10('1'); expect(entry).not.toBeNull();
  const value = entry!.createServices(); cleanups.push(value.dispose); return value;
}
function renderedServices(): { session: Services['session']; storage: Services['storage'] } {
  const tree = root.render.mock.calls.at(-1)![0];
  expect(isValidElement(tree)).toBe(true);
  const strict = tree as ReactElement<{ children: ReactElement<{ session: Services['session']; storage: Services['storage'] }> }>;
  expect(strict.type).toBe(StrictMode); return strict.props.children.props;
}
async function seedLegacyDatabase(factory: IDBFactory, name: string, text: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1); request.onupgradeneeded = () => request.result.createObjectStore('sentinel');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('sentinel', 'readwrite'); transaction.objectStore('sentinel').put(text, 'raw');
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
async function readLegacyDatabase(factory: IDBFactory, name: string): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction('sentinel', 'readonly').objectStore('sentinel').get('raw');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { database.close(); }
}
beforeEach(async () => {
  // An entry retained across resetModules can retain the disabled-import
  // sentinel graph. Give every case a fresh entry after removing those traps.
  for (const path of candidateModules) vi.doUnmock(path);
  vi.resetModules();
  ({ managementPreviewEntryV10, mountManagementPreviewV10 } = await import('../../src/management-next'));
});
afterEach(async () => {
  try {
    for (const stop of cleanups.splice(0)) await stop().catch(() => {});
    // A rejected Promise.all does not settle its sibling imports. Keep this
    // case's mock factories alive until the whole import graph has finished.
    await vi.dynamicImportSettled();
  } finally {
    for (const path of candidateModules) vi.doUnmock(path);
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
    root.render.mockReset(); root.unmount.mockReset(); root.options = null;
  }
});

describe('private v10 preview build gate', () => {
  it.each([undefined, null, '', '0', 'false', 'true', '01', '1 ', ' 1', 1, true, {}, ['1']].map(flag => [flag] as const))('keeps non-exact flag %j entirely inert', async flag => {
    const touched = rejectCandidateImports(); const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const open = vi.spyOn(database, 'open');
    expect(await managementPreviewEntryV10(flag)).toBeNull();
    expect(touched).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(await database.databases()).toEqual([]);
  });
  it('does not inspect or coerce a hostile flag', async () => {
    const touched = rejectCandidateImports(); const read = vi.fn(() => { throw new Error('Not configuration.'); });
    expect(await managementPreviewEntryV10(new Proxy({}, { get: read }))).toBeNull();
    expect(read).not.toHaveBeenCalled(); expect(touched).not.toHaveBeenCalled();
  });
  it('uses only the exact v10 build flag and renders an honest bilingual locked page', async () => {
    vi.stubEnv('VITE_ENABLE_V10_MANAGEMENT', undefined); vi.stubEnv('VITE_ENABLE_V9_MANAGEMENT', '1');
    vi.stubGlobal('location', { search: '?VITE_ENABLE_V10_MANAGEMENT=1', hash: '#v10=1' });
    const read = vi.fn(() => { throw new Error('Runtime storage cannot enable this entry.'); });
    vi.stubGlobal('localStorage', new Proxy({}, { get: read })); vi.stubGlobal('sessionStorage', new Proxy({}, { get: read }));
    const touched = rejectCandidateImports(); const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const stop = await mountManagementPreviewV10({} as HTMLElement); cleanups.push(stop);
    const html = renderToStaticMarkup(root.render.mock.calls.at(-1)![0]);
    expect(html).toContain(createManagementPreviewTranslatorV10('zh-CN')('previewV10.locked'));
    expect(html).toContain(createManagementPreviewTranslatorV10('en')('previewV10.locked'));
    expect(read).not.toHaveBeenCalled(); expect(touched).not.toHaveBeenCalled(); expect(await database.databases()).toEqual([]);
    expect(stop()).toBe(stop()); await stop(); expect(root.unmount).toHaveBeenCalledOnce();
  });
  it('keeps the new HTML root and build input isolated without enabling a CI flag', () => {
    const html = readFileSync(new URL('../../management-next.html', import.meta.url), 'utf8');
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    const entry = readFileSync(new URL('../../src/management-next.tsx', import.meta.url), 'utf8');
    expect(html).toContain('id="management-next-root"'); expect(html).toContain('src="/src/management-next.tsx"');
    expect(config).toContain("managementNext: 'management-next.html'"); expect(config).not.toContain('VITE_ENABLE_V10_MANAGEMENT');
    expect(entry).toContain("if (buildFlag !== '1') return null;");
    expect(entry).toContain('import.meta.env.VITE_ENABLE_V10_MANAGEMENT');
    for (const file of ['management.html', 'candidate.html', 'index.html']) {
      expect(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')).not.toContain('management-next');
    }
  });
  it('validates private gate copy and falls back to Chinese per missing English key', () => {
    const zh = Object.fromEntries(Object.entries(managementPreviewMessagesV10).map(([key, values]) => [key, values[0]]));
    const en = Object.fromEntries(Object.entries(managementPreviewMessagesV10).map(([key, values]) => [key, values[1]]));
    expect(validateLocales(zh, en, managementPreviewMessageSpecificationsV10).valid).toBe(true);
    const t = createManagementPreviewTranslatorV10('en', { ...en, 'previewV10.noMigration': '' });
    expect(t('previewV10.noMigration')).toBe(zh['previewV10.noMigration']); expect(t('previewV10.locked')).toBe(en['previewV10.locked']);
  });
});

describe('real v10 preview services', () => {
  it('constructs one paused real Session and a pure manual-only storage adapter without opening a database', async () => {
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database); const open = vi.spyOn(database, 'open');
    const value = await services(); const state = value.session.getSnapshot();
    expect(state.paused).toBe(true); expect(state.frame.clock.pauseReasons).toContain('player'); expect(state.frame.clock.speed).toBe(1);
    expect(value.saves.getSnapshot()).toMatchObject({ mode: 'stopped', autosave: 'manual-only', boundSlot: null, dirty: true });
    expect(value.storage.getSnapshot().summary.key).toBe('managementV10.unsavedSession');
    expect(open).not.toHaveBeenCalled(); expect(await database.databases()).toEqual([]);
    const html = renderToStaticMarkup(value.storage.renderBody({ session: value.session, locale: 'en', close: () => {} }));
    expect(html).toContain(createManagementPreviewTranslatorV10('en')('previewV10.noMigration'));
    expect(html).toContain('v10 JSON'); expect(open).not.toHaveBeenCalled();
    const close = vi.spyOn(value.session, 'close');
    expect(value.dispose()).toBe(value.dispose()); await value.dispose();
    expect(close).toHaveBeenCalledOnce(); expect(value.session.getSnapshot().closed).toBe(true);
  });
  it('starts storage once and opens only the fixed v10 database while leaving all slots unbound and empty', async () => {
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database); const open = vi.spyOn(database, 'open');
    const value = await services(); const start = vi.spyOn(value.saves, 'start');
    const first = value.start(); expect(value.start()).toBe(first); await first; await value.start();
    expect(start).toHaveBeenCalledOnce(); expect(open.mock.calls.map(call => call[0])).toEqual(['shanmen-changming-v10-management-saves']);
    expect((await database.databases()).map(row => row.name)).toEqual(['shanmen-changming-v10-management-saves']);
    const state = value.saves.getSnapshot();
    expect(state).toMatchObject({ mode: 'browser', autosave: 'manual-only', boundSlot: null, lastSavedAt: null, dirty: true, lastAction: null });
    expect(state.slots.every(row => row.slot === null)).toBe(true); expect(value.session.getSnapshot().paused).toBe(true);
  });
  it('revisits with a fresh paused Session and loads saved progress only after explicit review and load', async () => {
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const first = await services(); await first.start();
    expect(first.session.setSpeed(3).ok).toBe(true); expect(await first.saves.save('campaign-1')).toBe(true);
    const file = first.saves.exportCurrent(); expect(file).not.toBeNull(); await first.dispose();
    const second = await services(); await second.start();
    expect(second.session.getSnapshot().frame.clock.speed).toBe(1); expect(second.session.getSnapshot().paused).toBe(true);
    expect(second.saves.getSnapshot()).toMatchObject({ boundSlot: null, lastAction: null, dirty: true, autosave: 'manual-only' });
    expect(second.saves.getSnapshot().slots[0]!.slot?.revision).toBe(1);
    const review = second.saves.reviewLoad('campaign-1'); expect(review).not.toBeNull();
    expect(second.session.getSnapshot().frame.clock.speed).toBe(1);
    expect(await second.saves.load(review!, true)).toBe(true);
    expect(second.session.getSnapshot().frame.clock.speed).toBe(3); expect(second.session.getSnapshot().frame.clock.pauseReasons).toContain('player');
    expect(second.saves.getSnapshot()).toMatchObject({ boundSlot: 'campaign-1', lastAction: 'loaded', dirty: false, autosave: 'manual-only' });
    expect(second.saves.exportCurrent()?.text).not.toBeNull();
  });
  it('never opens or changes existing ordinary, v8 or v9 databases', async () => {
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const { DATABASE_NAME } = await import('../../src/platform/persistence/types');
    const legacy = [DATABASE_NAME, 'shanmen-changming-v8-candidate-saves', 'shanmen-changming-v9-management-saves'];
    const raw = '  legacy source bytes\n{"keep":"unchanged"}  ';
    for (const name of legacy) await seedLegacyDatabase(database, name, raw);
    const open = vi.spyOn(database, 'open'); const value = await services(); await value.start();
    expect(await value.saves.save('campaign-1')).toBe(true); await value.dispose();
    expect(open.mock.calls.map(call => call[0])).toEqual(['shanmen-changming-v10-management-saves']); open.mockRestore();
    for (const name of legacy) expect(await readLegacyDatabase(database, name)).toBe(raw);
  });
  it('keeps a usable paused Session and current export when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined); const value = await services(); await value.start();
    expect(value.saves.getSnapshot()).toMatchObject({ mode: 'unavailable', boundSlot: null, lastSavedAt: null, dirty: true, autosave: 'manual-only' });
    expect(value.saves.exportCurrent()?.text).toContain('"saveVersion":10'); expect(value.session.getSnapshot().paused).toBe(true);
    expect(value.saves.canSave('campaign-1')).toBe(false);
  });
  it('cancels a pending first start before opening storage and never restarts disposed services', async () => {
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database); const open = vi.spyOn(database, 'open');
    const value = await services(); const start = vi.spyOn(value.saves, 'start'); const stop = vi.spyOn(value.saves, 'stop');
    const starting = value.start(); const disposed = value.dispose();
    await Promise.all([starting, disposed]); expect(value.start()).toBe(disposed); await value.start();
    expect(start).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
    expect(value.session.getSnapshot().closed).toBe(true);
  });
  it('disposes safely when requested synchronously during Session publication', async () => {
    const value = await services(); const close = vi.spyOn(value.session, 'close'); const stop = vi.spyOn(value.saves, 'stop');
    let pending: Promise<void> | null = null;
    const unsubscribe = value.session.subscribe(() => { pending = value.dispose(); });
    expect(value.session.setSpeed(3).ok).toBe(true); expect(pending).not.toBeNull(); await pending; unsubscribe();
    expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(value.session.getSnapshot().closed).toBe(true);
  });
  it('still closes the Session when storage teardown rejects, retaining the same failed disposal promise', async () => {
    const value = await services(); const problem = new Error('storage teardown failed');
    const stop = vi.spyOn(value.saves, 'stop').mockRejectedValue(problem); const close = vi.spyOn(value.session, 'close');
    const disposed = value.dispose(); expect(value.dispose()).toBe(disposed); await expect(disposed).rejects.toBe(problem);
    expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(value.session.getSnapshot().closed).toBe(true);
  });
  it('retries only an explicitly BUSY close outside the current stack', async () => {
    const value = await services(); const close = vi.spyOn(value.session, 'close').mockReturnValueOnce({ ok: false, kind: 'session-rejection', code: 'BUSY' });
    await value.dispose(); expect(close).toHaveBeenCalledTimes(2); expect(value.session.getSnapshot().closed).toBe(true);
  });
  it('closes an unstarted Session if initial pause or pure storage adapter construction fails', async () => {
    const { ApplicationSessionV10 } = await import('../../src/application/session-v10');
    const close = vi.spyOn(ApplicationSessionV10.prototype, 'close');
    vi.spyOn(ApplicationSessionV10.prototype, 'setPaused').mockReturnValueOnce({ ok: false, kind: 'session-rejection', code: 'SESSION_HELD' });
    const entry = await managementPreviewEntryV10('1'); expect(() => entry!.createServices()).toThrow('Unable to pause'); expect(close).toHaveBeenCalledOnce();
    const storage = await import('../../src/app/management-v10-storage');
    vi.spyOn(storage, 'createManagementStorageSlotV10').mockImplementationOnce(() => { throw new Error('adapter failed'); });
    const broken = await managementPreviewEntryV10('1'); expect(() => broken!.createServices()).toThrow('adapter failed'); expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('v10 preview root lifecycle', () => {
  it('creates and starts one owner outside the StrictMode tree and closes it once', async () => {
    vi.stubEnv('VITE_ENABLE_V10_MANAGEMENT', '1'); const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const worlds = await import('../../src/core/world/create-world-v10'); const create = vi.spyOn(worlds, 'createUnregisteredWorldV10');
    const { ManagementSaveControllerV10 } = await import('../../src/application/management-v10-save-controller');
    const start = vi.spyOn(ManagementSaveControllerV10.prototype, 'start');
    const stop = await mountManagementPreviewV10({} as HTMLElement); cleanups.push(stop); const owner = renderedServices();
    expect(create).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce(); expect(owner.session.getSnapshot().paused).toBe(true);
    expect(owner.storage.getSnapshot().summary.key).toBe('managementV9.unsaved');
    const close = vi.spyOn(owner.session, 'close'); const stopped = stop(); expect(stop()).toBe(stopped); await stopped;
    expect(root.unmount).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(owner.session.getSnapshot().closed).toBe(true);
  });
  it('handles pagehide before imports finish without constructing any Session or opening a database', async () => {
    vi.stubEnv('VITE_ENABLE_V10_MANAGEMENT', '1'); const windowPort = new EventTarget(); vi.stubGlobal('window', windowPort);
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database); const open = vi.spyOn(database, 'open');
    const worlds = await import('../../src/core/world/create-world-v10'); const create = vi.spyOn(worlds, 'createUnregisteredWorldV10');
    const mounting = mountManagementPreviewV10({} as HTMLElement); windowPort.dispatchEvent(new Event('pagehide'));
    const stop = await mounting; cleanups.push(stop); await stop();
    expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(root.render).not.toHaveBeenCalled(); expect(root.unmount).toHaveBeenCalledOnce();
  });
  it('removes pagehide ownership and closes services even when root unmount throws', async () => {
    vi.stubEnv('VITE_ENABLE_V10_MANAGEMENT', '1'); const windowPort = new EventTarget(); vi.stubGlobal('window', windowPort);
    const remove = vi.spyOn(windowPort, 'removeEventListener'); vi.stubGlobal('indexedDB', new IDBFactory());
    const stop = await mountManagementPreviewV10({} as HTMLElement); cleanups.push(stop); const owner = renderedServices();
    root.unmount.mockImplementationOnce(() => { throw new Error('unmount failed'); });
    await expect(stop()).rejects.toThrow('unmount failed'); expect(owner.session.getSnapshot().closed).toBe(true);
    expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
    windowPort.dispatchEvent(new Event('pagehide')); expect(root.unmount).toHaveBeenCalledOnce();
  });
  it('does not render or restart a late storage opening after pagehide', async () => {
    vi.stubEnv('VITE_ENABLE_V10_MANAGEMENT', '1'); const windowPort = new EventTarget(); vi.stubGlobal('window', windowPort);
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const { ManagementSaveControllerV10 } = await import('../../src/application/management-v10-save-controller');
    const start = vi.spyOn(ManagementSaveControllerV10.prototype, 'start').mockReturnValueOnce(pending);
    const mounting = mountManagementPreviewV10({} as HTMLElement);
    await vi.waitFor(() => { expect(start).toHaveBeenCalledOnce(); }); const owner = renderedServices();
    windowPort.dispatchEvent(new Event('pagehide')); release(); const stop = await mounting; cleanups.push(stop); await stop();
    expect(owner.session.getSnapshot().closed).toBe(true); expect(root.render).toHaveBeenCalledOnce(); expect(root.unmount).toHaveBeenCalledOnce();
  });
  it('reports rejected module loading without opening storage or creating a Session', async () => {
    vi.stubEnv('VITE_ENABLE_V10_MANAGEMENT', '1'); const touched = rejectCandidateImports();
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const stop = await mountManagementPreviewV10({} as HTMLElement); cleanups.push(stop);
    expect(touched).toHaveBeenCalled(); expect(await database.databases()).toEqual([]);
    expect(renderToStaticMarkup(root.render.mock.calls.at(-1)![0])).toContain(createManagementPreviewTranslatorV10('zh-CN')('previewV10.unavailable'));
  });
  it('cleans up an unexpected start rejection and displays failure rather than saved progress', async () => {
    vi.stubEnv('VITE_ENABLE_V10_MANAGEMENT', '1');
    const { ManagementSaveControllerV10 } = await import('../../src/application/management-v10-save-controller');
    vi.spyOn(ManagementSaveControllerV10.prototype, 'start').mockRejectedValueOnce(new Error('unexpected startup failure'));
    const { ApplicationSessionV10 } = await import('../../src/application/session-v10'); const close = vi.spyOn(ApplicationSessionV10.prototype, 'close');
    const stop = await mountManagementPreviewV10({} as HTMLElement); cleanups.push(stop);
    expect(close).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(root.render.mock.calls.at(-1)![0])).toContain(createManagementPreviewTranslatorV10('en')('previewV10.unavailable'));
    await stop(); expect(close).toHaveBeenCalledOnce();
  });
  it('cleans up React uncaught render failures as well as synchronous startup failures', async () => {
    vi.stubEnv('VITE_ENABLE_V10_MANAGEMENT', '1'); vi.stubGlobal('indexedDB', new IDBFactory());
    const stop = await mountManagementPreviewV10({} as HTMLElement); cleanups.push(stop); const owner = renderedServices();
    const close = vi.spyOn(owner.session, 'close'); root.options?.onUncaughtError?.(new Error('render failed'), { componentStack: '' });
    await vi.waitFor(() => { expect(owner.session.getSnapshot().closed).toBe(true); });
    expect(renderToStaticMarkup(root.render.mock.calls.at(-1)![0])).toContain(createManagementPreviewTranslatorV10('zh-CN')('previewV10.unavailable'));
    await stop(); expect(close).toHaveBeenCalledOnce();
  });
});
