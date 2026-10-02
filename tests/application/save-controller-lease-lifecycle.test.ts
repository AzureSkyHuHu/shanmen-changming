import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveController, type NewWorldFactory } from '../../src/application/save-controller';
import { ApplicationSession } from '../../src/application/session';
import { CANDIDATE_DATABASE_NAME } from '../../src/candidate';
import { advanceTicks, createWorld } from '../../src/core/kernel';
import { createWorldV8 } from '../../src/core/kernel/v8';
import { translate } from '../../src/i18n';
import {
  DATABASE_NAME, DEFAULT_LEASE_DURATION_MS, openSaveRepository,
  type IndexedDbSaveRepository, type RepositoryOptions, type WriterLease,
} from '../../src/platform/persistence';

const slotId = 'campaign-1' as const;
const metadata = { buildId: 'lease-lifecycle-tests', savedAt: '2026-10-02T05:00:00.000Z' };
const controllers: SaveController[] = [];
const repositories: IndexedDbSaveRepository[] = [];

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
function harness() {
  const indexedDB = new IDBFactory();
  let now = 1000;
  const options: RepositoryOptions = { indexedDB, databaseName: DATABASE_NAME, now: () => now };
  return {
    options,
    setNow(value: number) { now = value; },
    async repository(selected = options) {
      const repository = await openSaveRepository(selected);
      repositories.push(repository);
      return repository;
    },
    async controller(factory: NewWorldFactory = createWorld, selected = options) {
      const session = new ApplicationSession(factory('new-document'));
      const controller = new SaveController(session, factory, selected);
      controllers.push(controller);
      await controller.start();
      return { session, controller };
    },
    async lease(databaseName = DATABASE_NAME): Promise<WriterLease> {
      const database = await request(indexedDB.open(databaseName));
      try {
        const transaction = database.transaction('leases', 'readonly');
        const done = completion(transaction);
        const lease = await request<WriterLease | undefined>(transaction.objectStore('leases').get(slotId));
        await done;
        if (!lease) throw new Error('Expected a persisted writer lease');
        return lease;
      } finally { database.close(); }
    },
    async corruptSnapshot(id: string) {
      const database = await request(indexedDB.open(DATABASE_NAME));
      try {
        const transaction = database.transaction('snapshots', 'readwrite');
        const done = completion(transaction);
        const store = transaction.objectStore('snapshots');
        const snapshot = await request<Record<string, unknown>>(store.get(id));
        await request(store.put({ ...snapshot, text: '{broken' }));
        await done;
      } finally { database.close(); }
    },
  };
}

beforeEach(() => {
  // Control heartbeat scheduling without faking IndexedDB's asynchronous request delivery.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const repository of repositories.splice(0)) repository.close();
  vi.useRealTimers();
});

describe('document reload and writer lease lifetime', () => {
  const versions: Array<[number, NewWorldFactory]> = [[7, createWorld], [8, createWorldV8]];
  it.each(versions)('loads v%s read-only after interrupted cleanup, then retries normally at the exact lease expiry', async (_version, factory) => {
    const h = harness();
    const departed = await h.repository();
    const lease = await departed.acquireLease(slotId, 'departed-document');
    expect(lease.expiresAt).toBe(1000 + DEFAULT_LEASE_DURATION_MS);
    await departed.saveWorld(slotId, factory('saved-before-reload'), metadata, { expectedRevision: 0, lease, kind: 'manual' });
    const original = await departed.exportRawSnapshot(slotId, 'campaign-1:1');
    // A browser document can disappear without completing application cleanup. Closing its
    // connection deliberately does not release its durable lease, just as on that reload path.
    departed.close();
    const { controller, session } = await h.controller(factory);
    await controller.load(slotId);
    expect(controller.getSnapshot()).toMatchObject({ readOnly: true, notice: 'save.error.leaseBusy' });
    expect(session.getSnapshot().clock.pauseReasons).toContain('danger');
    expect(controller.canSave(slotId)).toBe(false);
    expect(await h.lease()).toMatchObject(lease);
    h.setNow(lease.expiresAt - 1);
    await controller.load(slotId);
    expect(controller.getSnapshot().readOnly).toBe(true);
    h.setNow(lease.expiresAt);
    // Passage of time alone never grants write access to the already displayed world.
    expect(controller.getSnapshot().readOnly).toBe(true);
    await controller.load(slotId);
    expect(controller.getSnapshot()).toMatchObject({ readOnly: false, notice: 'save.loadedPaused' });
    expect(session.getSnapshot().seed).toBe('saved-before-reload');
    expect(session.getSnapshot().clock.pauseReasons).not.toContain('danger');
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    const nextLease = await h.lease();
    expect(nextLease.ownerId).not.toBe(lease.ownerId);
    expect(nextLease.epoch).toBe(lease.epoch + 1);
    const inspector = await h.repository();
    expect(await inspector.exportRawSnapshot(slotId, 'campaign-1:1')).toBe(original);
    expect((await inspector.loadSlot(slotId)).slot.revision).toBe(1);
    await controller.save(slotId);
    expect(controller.getSnapshot().slots[0]!.slot!.revision).toBe(2);
  });

  it('keeps a genuine competing document read-only while the live writer renews', async () => {
    const h = harness();
    const first = await h.controller();
    await first.controller.save(slotId);
    const original = await h.lease();
    const second = await h.controller();
    await second.controller.load(slotId);
    expect(second.controller.getSnapshot().readOnly).toBe(true);
    h.setNow(6000);
    await vi.advanceTimersByTimeAsync(5000);
    // This read queues behind the heartbeat's real readwrite transaction.
    const renewed = await h.lease();
    expect(renewed).toMatchObject({ ownerId: original.ownerId, epoch: original.epoch, expiresAt: 6000 + DEFAULT_LEASE_DURATION_MS });
    h.setNow(original.expiresAt);
    await second.controller.load(slotId);
    expect(second.controller.getSnapshot()).toMatchObject({ readOnly: true, notice: 'save.error.leaseBusy' });
    expect(second.controller.canSave(slotId)).toBe(false);
    expect(await h.lease()).toEqual(renewed);
    expect(first.controller.getSnapshot().readOnly).toBe(false);
  });

  it('rereads newer persisted state on retry rather than unlocking the earlier read-only world', async () => {
    const h = harness();
    const writer = await h.repository();
    const lease = await writer.acquireLease(slotId, 'still-writing');
    const world = createWorld('fresh-retry');
    await writer.saveWorld(slotId, world, metadata, { expectedRevision: 0, lease, kind: 'manual' });
    const reader = await h.controller();
    await reader.controller.load(slotId);
    expect(reader.session.getSnapshot().clock.simulationTick).toBe(0);
    const newer = advanceTicks(world, 7);
    await writer.saveWorld(slotId, newer, metadata, { expectedRevision: 1, lease, kind: 'manual' });
    writer.close();
    h.setNow(lease.expiresAt);
    expect(reader.session.getSnapshot().clock.simulationTick).toBe(0);
    expect(reader.controller.getSnapshot().readOnly).toBe(true);
    await reader.controller.load(slotId);
    expect(reader.controller.getSnapshot().readOnly).toBe(false);
    expect(reader.session.getSnapshot().clock.simulationTick).toBe(7);
    expect(reader.session.exportWorld().randomStreams).toEqual(newer.randomStreams);
    expect(reader.controller.getSnapshot().slots[0]!.slot!.revision).toBe(2);
    await reader.controller.save(slotId);
    expect(reader.controller.getSnapshot().slots[0]!.slot!.revision).toBe(3);
  });

  it.each(['expiry', 'release', 'explicit takeover'] as const)('fences a delayed old release, renewal and save after %s', async mode => {
    const h = harness();
    const prior = await h.repository();
    const oldLease = await prior.acquireLease(slotId, 'old-document');
    await prior.saveWorld(slotId, createWorld('old-save'), metadata, { expectedRevision: 0, lease: oldLease, kind: 'manual' });
    if (mode === 'expiry') h.setNow(oldLease.expiresAt);
    if (mode === 'release') await prior.releaseLease(oldLease);
    const next = await h.controller();
    await next.controller.load(slotId, mode === 'explicit takeover');
    expect(next.controller.getSnapshot().readOnly).toBe(false);
    const nextLease = await h.lease();
    expect(nextLease.epoch).toBe(oldLease.epoch + 1);
    await expect(prior.releaseLease(oldLease)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(prior.renewLease(oldLease)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(prior.saveWorld(slotId, createWorld('stale-write'), metadata, { expectedRevision: 1, lease: oldLease })).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await h.lease()).toEqual(nextLease);
    await next.controller.save(slotId);
    expect((await prior.loadSlot(slotId)).world.seed).toBe('old-save');
    expect((await prior.loadSlot(slotId)).slot.revision).toBe(2);
  });

  it('keeps ordinary and candidate databases independent even when both own campaign-1', async () => {
    const h = harness();
    const ordinary = await h.controller();
    const candidateOptions = { ...h.options, databaseName: CANDIDATE_DATABASE_NAME };
    const candidate = await h.controller(createWorldV8, candidateOptions);
    await ordinary.controller.beginNewCampaign('ordinary-world');
    await candidate.controller.beginNewCampaign('candidate-world');
    await candidate.controller.save(slotId);
    await ordinary.controller.refresh();
    expect(ordinary.controller.getSnapshot().slots.every(entry => entry.slot === null)).toBe(true);
    await ordinary.controller.save(slotId);
    const ordinaryLease = await h.lease();
    const candidateLease = await h.lease(CANDIDATE_DATABASE_NAME);
    expect(ordinaryLease.ownerId).not.toBe(candidateLease.ownerId);
    expect(ordinary.controller.getSnapshot().readOnly).toBe(false);
    expect(candidate.controller.getSnapshot().readOnly).toBe(false);
    const reloaded = await h.controller(createWorldV8, candidateOptions);
    await reloaded.controller.load(slotId);
    expect(reloaded.controller.getSnapshot().readOnly).toBe(true);
    expect(reloaded.session.getSnapshot().seed).toBe('candidate-world');
    await reloaded.controller.load(slotId, true);
    expect(await h.lease()).toEqual(ordinaryLease);
    await ordinary.controller.save(slotId);
    expect(ordinary.controller.getSnapshot().slots[0]!.slot!.revision).toBe(2);
    await expect((await h.repository()).loadSlot(slotId)).resolves.toMatchObject({ world: { seed: 'ordinary-world' } });
  });

  it('never promotes a recovered corrupt snapshot to writable, including after expiry or explicit takeover', async () => {
    const h = harness();
    const prior = await h.repository();
    const lease = await prior.acquireLease(slotId, 'departed-document');
    const world = createWorld('recover-only');
    await prior.saveWorld(slotId, world, metadata, { expectedRevision: 0, lease, kind: 'manual' });
    const damaged = await prior.saveWorld(slotId, advanceTicks(world, 1), metadata, { expectedRevision: 1, lease, kind: 'auto' });
    await h.corruptSnapshot(damaged.snapshot.id);
    h.setNow(lease.expiresAt);
    const reader = await h.controller();
    for (const takeover of [false, true]) {
      await reader.controller.load(slotId, takeover);
      expect(reader.controller.getSnapshot()).toMatchObject({ readOnly: true, notice: 'save.recoveredReadOnly' });
      expect(reader.controller.canSave(slotId)).toBe(false);
      expect(reader.session.getSnapshot().clock.simulationTick).toBe(0);
      expect(await h.lease()).toMatchObject(lease);
      expect(await prior.exportRawSnapshot(slotId, damaged.snapshot.id)).toBe('{broken');
      expect((await prior.loadSlot(slotId)).slot.currentSnapshotId).toBe(damaged.snapshot.id);
    }
  });

  it('explains the bounded previous-session wait without promising expiry for a renewing tab', () => {
    expect(DEFAULT_LEASE_DURATION_MS).toBe(15_000);
    for (const key of ['save.error.leaseBusy', 'save.import.leaseBusy'] as const) {
      expect(translate('zh-CN', key)).toContain('其他页面或刷新前的会话');
      expect(translate('zh-CN', key)).toContain('若没有其他标签页打开');
      expect(translate('zh-CN', key)).toContain('最多等待15秒');
      expect(translate('en', key)).toContain('Another page or the session before a refresh');
      expect(translate('en', key)).toContain('If no other tab is open, wait up to 15 seconds');
    }
  });
});
