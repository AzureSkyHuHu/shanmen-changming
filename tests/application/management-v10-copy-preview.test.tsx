import { IDBFactory } from 'fake-indexeddb';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { managementPreviewEntryV10 } from '../../src/management-next';
import { createSaveEnvelopeV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { openSaveRepository } from '../../src/platform/persistence/indexeddb-save-repository';
import { MANAGEMENT_V9_DATABASE_NAME } from '../../src/platform/persistence/types';
import { openManagementV10Repository } from '../../src/platform/persistence/indexeddb-management-v10-repository';

type Services = ReturnType<NonNullable<Awaited<ReturnType<typeof managementPreviewEntryV10>>>['createServices']>;
const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  vi.doUnmock('../../src/application/management-v10-copy-entry'); vi.resetModules();
});
afterEach(async () => {
  try { for (const dispose of cleanups.splice(0)) await dispose(); }
  finally {
    vi.doUnmock('../../src/application/management-v10-copy-entry');
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  }
});

describe('build-gated copy service integration', () => {
  it('keeps the disabled branch isolated from the newly added copy adapter too', async () => {
    const touched = vi.fn();
    vi.doMock('../../src/application/management-v10-copy-entry', () => { touched(); throw new Error('Disabled import'); });
    const entry = await import('../../src/management-next');
    expect(await entry.managementPreviewEntryV10(undefined)).toBeNull(); expect(await entry.managementPreviewEntryV10('0')).toBeNull(); expect(touched).not.toHaveBeenCalled();
  });
  it('mounts the adopted real Session/storage pair once, retires the fresh Session, and keeps saving manual', async () => {
    const indexedDB = new IDBFactory(); vi.stubGlobal('indexedDB', indexedDB);
    const repository = await openSaveRepository({ indexedDB, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' });
    const sourceText = serializeSaveV9(createSaveEnvelopeV9(createUnregisteredWorldV9('copy-entry-integration'), { buildId: 'integration', savedAt: '2026-10-03T05:00:00Z' }));
    const imported = await repository.importSave(sourceText, { mode: 'new-slot', slotId: 'campaign-1', ownerId: 'seed' });
    await repository.releaseLease(imported.lease); repository.close();
    // Import a fresh entry after this test's mock reset. Do not reuse an entry
    // function from a module graph that captured the disabled-import sentinel.
    const { managementPreviewEntryV10 } = await import('../../src/management-next');
    const entry = await managementPreviewEntryV10('1'); if (!entry) throw new Error('Expected enabled test entry');
    const services: Services = entry.createServices(); cleanups.push(services.dispose); const initial = services.session;
    const open = vi.spyOn(indexedDB, 'open'); await services.start();
    expect(open.mock.calls.map(call => call[0])).not.toContain(MANAGEMENT_V9_DATABASE_NAME);
    const updates = vi.fn(); const unsubscribe = services.subscribe(updates);
    expect(await services.copy.open()).toBe(true); expect(services.copy.selectSource('campaign-1')).toBe(true);
    expect(await services.copy.readSource()).toBe(true); expect(services.copy.selectTarget('campaign-2')).toBe(true); expect(await services.copy.review()).toBe(true);
    const review = services.copy.getSnapshot().review; if (!review) throw new Error('Expected review');
    expect(await services.copy.confirm(review, true)).toBe(true);
    expect(services.session).not.toBe(initial); expect(services.version).toBe(1); expect(updates).toHaveBeenCalledOnce();
    // Retirement is intentionally off the old Session publication stack.
    await Promise.resolve(); await Promise.resolve(); expect(initial.getSnapshot().closed).toBe(true);
    expect(services.saves.getSnapshot()).toMatchObject({ boundSlot: 'campaign-2', autosave: 'manual-only', dirty: false });
    const html = renderToStaticMarkup(services.storage.renderBody({ session: services.session, locale: 'en', close: () => {} }));
    expect(html).toContain('Entered the v9 copy'); expect(html).not.toContain('Cancel copy</button>');
    const target = services.session; expect(target.setSpeed(3).ok).toBe(true); expect(services.saves.getSnapshot().dirty).toBe(true);
    const db = await openManagementV10Repository({ indexedDB });
    try { expect((await db.listSlots()).find(row => row.slotId === 'campaign-2')?.slot?.revision).toBe(1); }
    finally { db.close(); }
    unsubscribe(); await services.dispose(); expect(target.getSnapshot().closed).toBe(true); expect(services.dispose()).toBe(services.dispose());
  }, 60000);
});
