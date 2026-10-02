import { IDBFactory } from 'fake-indexeddb';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as worlds from '../../src/core/world/create-world-v9';
import { translate } from '../../src/i18n';
import { managementPreviewEntry, mountManagementPreview } from '../../src/management';
import { DATABASE_NAME, MANAGEMENT_V9_DATABASE_NAME } from '../../src/platform/persistence';

const root = vi.hoisted(() => ({ render: vi.fn<(node: ReactNode) => void>(), unmount: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: vi.fn(() => root) }));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); root.render.mockClear(); root.unmount.mockClear(); });

describe('separate management entry build gate', () => {
  it.each([undefined, null, '', '0', 'false', 'true', '01', '1 ', ' 1', 1, true, {}, ['1']].map(flag => [flag] as const))('keeps non-exact flag %j inert', async flag => {
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const open = vi.spyOn(database, 'open'); const create = vi.spyOn(worlds, 'createUnregisteredWorldV9');
    expect(await managementPreviewEntry(flag)).toBeNull();
    expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(await database.databases()).toEqual([]);
  });
  it('never observes a hostile non-string flag', async () => {
    let reads = 0; const flag = new Proxy({}, { get() { reads++; throw new Error('not data'); } });
    expect(await managementPreviewEntry(flag)).toBeNull(); expect(reads).toBe(0);
  });
  it('mounts the disabled notice without creating a world or database', async () => {
    vi.stubEnv('VITE_ENABLE_V9_MANAGEMENT', undefined);
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database);
    const create = vi.spyOn(worlds, 'createUnregisteredWorldV9');
    const stop = await mountManagementPreview({} as HTMLElement); cleanups.push(stop);
    const html = renderToStaticMarkup(root.render.mock.calls.at(-1)![0]);
    expect(html).toContain(translate('zh-CN', 'managementV9.previewLocked'));
    expect(html).toContain(translate('en', 'managementV9.previewLocked'));
    expect(create).not.toHaveBeenCalled(); expect(await database.databases()).toEqual([]);
    stop(); stop(); expect(root.unmount).toHaveBeenCalledOnce();
  });
  it('creates fresh v9 services only when enabled and opens only its fixed database on explicit start', async () => {
    const database = new IDBFactory(); vi.stubGlobal('indexedDB', database); const open = vi.spyOn(database, 'open');
    const entry = await managementPreviewEntry('1'); expect(entry).not.toBeNull();
    const services = entry!.createServices(); cleanups.push(services.dispose);
    expect(services.session.getEngineVersion()).toBe(9);
    expect(services.session.getSnapshot().frame.clock.speed).toBe(1);
    expect(open).not.toHaveBeenCalled();
    await services.saves.start();
    expect((await database.databases()).map(row => row.name)).toEqual([MANAGEMENT_V9_DATABASE_NAME]);
    expect(MANAGEMENT_V9_DATABASE_NAME).not.toBe(DATABASE_NAME);
    expect(MANAGEMENT_V9_DATABASE_NAME).not.toBe('shanmen-changming-v8-candidate-saves');
    services.dispose(); services.dispose(); expect(services.session.getSnapshot().closed).toBe(true);
  });
});
