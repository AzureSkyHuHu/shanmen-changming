import { IDBFactory } from 'fake-indexeddb';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createAppServices } from '../../src/app/App';
import { DEFAULT_CAMPAIGN_SEED } from '../../src/app/CampaignEntry';
import * as browserRuntime from '../../src/application/browser-runtime';
import { SaveController } from '../../src/application/save-controller';
import * as worldEngine from '../../src/application/world-engine';
import { CANDIDATE_DATABASE_NAME, candidatePreviewProps, mountCandidatePreview } from '../../src/candidate';
import { createWorld } from '../../src/core/kernel';
import * as v8 from '../../src/core/kernel/v8';
import { translate } from '../../src/i18n';
import { DATABASE_NAME, DATABASE_VERSION, openSaveRepository, type RepositoryOptions } from '../../src/platform/persistence';
import { createVersionedSaveEnvelope, parseVersionedSave, serializeVersionedSave } from '../../src/platform/save-codec';

const entryRoot = vi.hoisted(() => ({ render: vi.fn<(node: ReactNode) => void>() }));
vi.mock('react-dom/client', () => ({ createRoot: vi.fn(() => entryRoot) }));

const controllers: SaveController[] = [];
function own<T extends { saves: SaveController }>(services: T): T { controllers.push(services.saves); return services; }
async function enabledProps() {
  const props = await candidatePreviewProps('1');
  if (!props) throw new Error('Explicit candidate configuration was not available');
  return props;
}
function renderedEntry(): string {
  const node = entryRoot.render.mock.calls.at(-1)?.[0];
  if (!node) throw new Error('Entry was not rendered');
  return renderToStaticMarkup(node);
}

/** Raw records include leases and every snapshot generation, not just the current World. */
async function rawRecords(factory: IDBFactory, name: string): Promise<{ version: number; records: unknown[][] }> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const stores = ['slots', 'snapshots', 'leases'];
      const transaction = database.transaction(stores, 'readonly');
      const records: unknown[][] = [];
      stores.forEach((store, index) => {
        const request = transaction.objectStore(store).getAll();
        request.onsuccess = () => { records[index] = request.result; };
      });
      transaction.oncomplete = () => resolve({ version: database.version, records });
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  entryRoot.render.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('candidate preview build gate', () => {
  it.each([undefined, null, '', '0', 'false', 'true', '01', '1 ', ' 1', 1, true, {}, ['1']].map(flag => [flag] as const))('fails closed for the non-exact flag %j', async flag => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const open = vi.spyOn(factory, 'open');
    const createCandidate = vi.spyOn(v8, 'createWorldV8');
    const createSessionWorld = vi.spyOn(worldEngine, 'ownSessionWorld');
    const startStorage = vi.spyOn(SaveController.prototype, 'start');
    const attachRuntime = vi.spyOn(browserRuntime, 'attachBrowserRuntime');
    expect(await candidatePreviewProps(flag)).toBeNull();
    expect(createCandidate).not.toHaveBeenCalled();
    expect(createSessionWorld).not.toHaveBeenCalled();
    expect(startStorage).not.toHaveBeenCalled();
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await factory.databases()).toEqual([]);
  });

  it.each([undefined, '', '0', 'true', '1 '])('mounts only the bilingual locked page for build flag %j', async flag => {
    vi.stubEnv('VITE_ENABLE_V8_CANDIDATE', flag);
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const open = vi.spyOn(factory, 'open');
    const createCandidate = vi.spyOn(v8, 'createWorldV8');
    const createSessionWorld = vi.spyOn(worldEngine, 'ownSessionWorld');
    const startStorage = vi.spyOn(SaveController.prototype, 'start');
    const attachRuntime = vi.spyOn(browserRuntime, 'attachBrowserRuntime');
    // ReactDOM is a capture seam; no synthetic DOM or browser-runtime substitute is started.
    await mountCandidatePreview({} as HTMLElement);
    const html = renderedEntry();
    for (const locale of ['zh-CN', 'en'] as const) {
      expect(html).toContain(translate(locale, 'candidate.banner'));
      expect(html).toContain(translate(locale, 'candidate.locked'));
    }
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('campaign-world');
    expect(createCandidate).not.toHaveBeenCalled();
    expect(createSessionWorld).not.toHaveBeenCalled();
    expect(startStorage).not.toHaveBeenCalled();
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await factory.databases()).toEqual([]);
  });

  it('renders ordinary App entry and the notice inside its modal only after an exact enabled build flag', async () => {
    vi.stubEnv('VITE_ENABLE_V8_CANDIDATE', '1');
    const createCandidate = vi.spyOn(v8, 'createWorldV8');
    await mountCandidatePreview({} as HTMLElement);
    const html = renderedEntry();
    expect(createCandidate).toHaveBeenCalledOnce();
    expect(createCandidate).toHaveBeenCalledWith(DEFAULT_CAMPAIGN_SEED);
    expect(html).toContain('class="campaign-world" inert=""');
    expect(html).toContain(translate('zh-CN', 'campaign.ui.title'));
    expect(html).toContain(translate('zh-CN', 'campaign.growth.title'));
    expect(html).not.toContain(translate('zh-CN', 'candidate.locked'));
    const dialog = html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'));
    expect(dialog).toContain(translate('zh-CN', 'candidate.banner'));
    expect(dialog).toContain(translate('en', 'candidate.banner'));
    // Static markup checks do not claim modal focus, Canvas or browser interaction acceptance.
  });
});

describe('candidate preview factory and save isolation', () => {
  it('keeps default App services and all default new campaigns on v7 and the existing database', async () => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const open = vi.spyOn(factory, 'open');
    const { session, saves } = own(createAppServices());
    expect(session.getEngineVersion()).toBe(7);
    expect(session.getSnapshot().seed).toBe(DEFAULT_CAMPAIGN_SEED);
    expect(session.getCampaignProjection()).toBeNull();
    await saves.start();
    expect(open).toHaveBeenCalledExactlyOnceWith(DATABASE_NAME, DATABASE_VERSION);
    expect(await saves.beginNewCampaign('ordinary-still-seven')).toBe(true);
    expect(session.getEngineVersion()).toBe(7);
    expect(session.getBuildFrame().builds.schemaVersion).toBe(1);
    await saves.save('campaign-1');
    expect(saves.getSnapshot().notice).toBe('save.saved');
    expect((await factory.databases()).map(database => database.name)).toEqual([DATABASE_NAME]);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toContain(translate('zh-CN', 'candidate.banner'));
    expect(html).not.toContain(translate('en', 'candidate.banner'));
  });

  it('uses the same v8 factory for initial App and every detached new campaign', async () => {
    const indexedDB = new IDBFactory();
    vi.stubGlobal('indexedDB', indexedDB);
    const props = await enabledProps();
    expect(Object.isFrozen(props.saveRepositoryOptions)).toBe(true);
    expect(props.saveRepositoryOptions).toEqual({ databaseName: CANDIDATE_DATABASE_NAME });
    expect(CANDIDATE_DATABASE_NAME).not.toBe(DATABASE_NAME);
    const factory = vi.fn(props.newWorldFactory);
    const { session, saves } = own(createAppServices({ ...props, newWorldFactory: factory }));
    expect(factory).toHaveBeenCalledExactlyOnceWith(DEFAULT_CAMPAIGN_SEED);
    expect(session.getEngineVersion()).toBe(8);
    expect(session.getCampaignProjection()).not.toBeNull();
    expect(session.getBuildFrame().builds.schemaVersion).toBe(2);
    await saves.start();
    expect(await saves.beginNewCampaign(' ')).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    for (const seed of ['first-candidate', 'second-candidate']) {
      expect(await saves.beginNewCampaign(`  ${seed}  `)).toBe(true);
      expect(factory).toHaveBeenLastCalledWith(seed);
      expect(session.getEngineVersion()).toBe(8);
      expect(session.getSnapshot().seed).toBe(seed);
      expect(session.getBuildFrame().builds.schemaVersion).toBe(2);
      expect(v8.validateWorldStateV8(session.exportWorld())).toEqual([]);
      expect(saves.getSnapshot().boundSlot).toBeNull();
    }
    expect(factory).toHaveBeenCalledTimes(3);
    expect((await indexedDB.databases()).map(database => database.name)).toEqual([CANDIDATE_DATABASE_NAME]);
  });

  it('never reads, claims, copies or modifies old default-database slots across candidate save, reload and new campaign', async () => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const legacy = await openSaveRepository();
    const text = serializeVersionedSave(createVersionedSaveEnvelope(createWorld('old-private-campaign'), { buildId: 'legacy-preview-test', savedAt: '2026-10-01T00:00:00.000Z' }));
    try {
      await legacy.importSave(text, { mode: 'new-slot', slotId: 'campaign-1', ownerId: 'legacy-writer' });
      const original = await rawRecords(factory, DATABASE_NAME);
      const open = vi.spyOn(factory, 'open');
      const { session, saves } = own(createAppServices(await enabledProps()));
      await saves.start();
      expect(saves.getSnapshot().mode).toBe('browser');
      expect(saves.getSnapshot().slots.every(slot => slot.slot === null)).toBe(true);
      // An old default slot with the same slot ID must not become readable from this entry.
      const initialEpoch = session.getSnapshot().sessionEpoch;
      await saves.load('campaign-1');
      expect(session.getSnapshot().sessionEpoch).toBe(initialEpoch);
      expect(saves.getSnapshot().notice).toBe('save.error.empty');
      expect(await saves.beginNewCampaign('isolated-v8')).toBe(true);
      await saves.save('campaign-1');
      expect(saves.getSnapshot().notice).toBe('save.saved');
      expect(saves.getSnapshot().slots[0]!.slot!.revision).toBe(1);
      const stored = session.exportWorld();
      expect(await saves.beginNewCampaign('another-isolated-v8')).toBe(true);
      await saves.load('campaign-1');
      expect(saves.getSnapshot().notice).toBe('save.loadedPaused');
      expect(session.getEngineVersion()).toBe(8);
      expect(session.getSnapshot().seed).toBe('isolated-v8');
      expect(session.exportWorld()).toEqual(stored);
      const exported = parseVersionedSave(saves.exportCurrent().text);
      expect(exported.ok).toBe(true);
      if (exported.ok) expect(exported.envelope.saveVersion).toBe(8);
      expect(open.mock.calls.map(([name]) => name)).toEqual([CANDIDATE_DATABASE_NAME]);
      open.mockRestore();
      expect(await rawRecords(factory, DATABASE_NAME)).toEqual(original);
      expect((await rawRecords(factory, CANDIDATE_DATABASE_NAME)).version).toBe(DATABASE_VERSION);
      expect((await legacy.exportSlot('campaign-1')).text).toBe(text);
    } finally { legacy.close(); }
  });

  it('owns repository options so a later caller mutation cannot redirect storage to ordinary saves', async () => {
    const indexedDB = new IDBFactory();
    const props = await enabledProps();
    const options: RepositoryOptions = { ...props.saveRepositoryOptions, indexedDB };
    const open = vi.spyOn(indexedDB, 'open');
    const { saves } = own(createAppServices({ ...props, saveRepositoryOptions: options }));
    options.databaseName = DATABASE_NAME;
    await saves.start();
    expect(saves.getSnapshot().mode).toBe('browser');
    expect(open).toHaveBeenCalledExactlyOnceWith(CANDIDATE_DATABASE_NAME, DATABASE_VERSION);
    expect((await indexedDB.databases()).map(database => database.name)).toEqual([CANDIDATE_DATABASE_NAME]);
  });
});
