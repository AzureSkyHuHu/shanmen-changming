import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagementSaveControllerV9, type FinishV10CopySourceV9 } from '../../src/application/management-v9-save-controller';
import { ManagementSaveControllerV10, type AdoptedManagementServiceV10,
  type PreparedCopyControllerV10 } from '../../src/application/management-v10-save-controller';
import { ApplicationSessionV9 } from '../../src/application/session-v9';
import { V9V10CopyCoordinator, V9V10CopyHost, type CopyHostTransferOfferV10 } from '../../src/application/v9-v10-copy-coordinator';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { openManagementV10Repository, type IndexedDbManagementV10Repository } from '../../src/platform/persistence/indexeddb-management-v10-repository';

const metadata = { buildId: 'copy-transfer-test', savedAt: '2026-10-02T23:00:00Z' };
const services: AdoptedManagementServiceV10[] = []; const sources: ManagementSaveControllerV9[] = [];
const sessions: ApplicationSessionV9[] = []; const hosts: V9V10CopyHost[] = []; const repositories: IndexedDbManagementV10Repository[] = [];
const options = { metadata, targetSlotId: 'campaign-1' as const, ownerId: 'copied-writer' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function harness(copy = true) {
  const indexedDB = new IDBFactory(); const session = new ApplicationSessionV9(createUnregisteredWorldV9('copied-live')); sessions.push(session);
  const source = new ManagementSaveControllerV9(session, { indexedDB, now: () => 1000 }); sources.push(source); await source.start();
  const repository = await openManagementV10Repository({ indexedDB, now: () => 1000 }); repositories.push(repository);
  const host = new V9V10CopyHost(source); hosts.push(host); const coordinator = new V9V10CopyCoordinator(host, repository);
  if (copy) expect(await coordinator.copy(options)).toMatchObject({ kind: 'committed-and-bound', cleanup: [] });
  return { indexedDB, session, source, repository, host, coordinator };
}
async function adopted(host: V9V10CopyHost) {
  const result = await host.transferToController(); if (!result.ok) throw new Error(`Adoption failed: ${result.code}`);
  services.push(result.service); return result.service;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.dispose();
  for (const host of hosts.splice(0)) await host.close();
  for (const source of sources.splice(0)) source.stop();
  for (const session of sessions.splice(0)) session.close();
  for (const repository of repositories.splice(0)) repository.close();
});

describe('one-use copy-host to v10 save-service transfer', () => {
  it('adopts exact live Session and existing lease, lists real slots, then saves revision2 without another acquire/import', async () => {
    const h = await harness(); const binding = h.host.getBoundTarget()!;
    const other = await h.repository.importSave(binding.receipt.snapshot.text, { mode: 'new-slot', slotId: 'campaign-2', ownerId: 'other-slot' });
    await h.repository.releaseLease(other.lease);
    const acquire = vi.spyOn(h.repository, 'acquireLease'); const imported = vi.spyOn(h.repository, 'importSave');
    const write = vi.spyOn(h.repository, 'saveText'); const renew = vi.spyOn(h.repository, 'renewLease'); const listing = vi.spyOn(h.repository, 'listSlots');
    const changed = vi.fn(); const unsubscribe = binding.session.subscribe(changed); const before = binding.session.getSnapshot();
    const service = await adopted(h.host);
    expect(service.session).toBe(binding.session); expect(h.host.getBoundTarget()).toBeNull();
    expect(service.session.getSnapshot()).toBe(before); expect(changed).not.toHaveBeenCalled(); unsubscribe();
    expect(service.saves.getSnapshot()).toMatchObject({ mode: 'browser', dirty: false, busy: false, readOnly: false,
      boundSlot: 'campaign-1', lastSavedAt: metadata.savedAt, committed: { slotId: 'campaign-1', revision: 1, bound: true } });
    expect(service.saves.getSnapshot().slots[1]!.slot).toEqual(other.slot);
    expect(service.saves.canSave('campaign-2')).toBe(false); expect(service.saves.canSave('campaign-3')).toBe(true);
    expect(listing).toHaveBeenCalledTimes(1); expect(renew).toHaveBeenCalledExactlyOnceWith(binding.receipt.lease);
    expect(acquire).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(service.session.setSpeed(3).ok).toBe(true); expect(service.saves.getSnapshot().dirty).toBe(true);
    expect(await service.saves.save('campaign-1')).toBe(true);
    expect((await h.repository.loadSlot('campaign-1')).slot.revision).toBe(2); expect(service.saves.getSnapshot().dirty).toBe(false);
    expect(await h.repository.exportMigrationSource('campaign-1')).toBe(binding.receipt.sourceBackup.sourceText);
    expect(acquire).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled();
  });

  it('hands teardown to an idempotent service while host close and controller stop preserve the caller-owned connection', async () => {
    const h = await harness(); const service = await adopted(h.host);
    const closeSession = vi.spyOn(service.session, 'close'); const release = vi.spyOn(h.repository, 'releaseLease'); const closeRepository = vi.spyOn(h.repository, 'close');
    expect(await h.host.close()).toEqual([]); expect(closeSession).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    expect(service.saves.canSave('campaign-1')).toBe(true);
    const first = service.dispose(); expect(service.dispose()).toBe(first);
    expect(await first).toEqual({ storageStopped: true, sessionClosed: true });
    expect(closeSession).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1); expect(closeRepository).not.toHaveBeenCalled();
    expect((await h.repository.loadSlot('campaign-1')).slot.revision).toBe(1);
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'HOST_CLOSED' });
    await service.saves.stop(); expect(release).toHaveBeenCalledTimes(1); expect(closeRepository).not.toHaveBeenCalled();
  });

  it('keeps progressed live World dirty against the original durable copy boundary until explicitly saved', async () => {
    const h = await harness(); const target = h.host.getBoundTarget()!;
    target.session.frame(0); expect(target.session.frame(50)).toEqual({ ok: true, value: 1 });
    const service = await adopted(h.host);
    expect(service.saves.getSnapshot().dirty).toBe(true); expect(service.session.getSnapshot().frame.clock.simulationTick).toBe(1);
    expect((await h.repository.loadSlot('campaign-1')).world.clock.simulationTick).toBe(0);
    expect(await service.saves.save('campaign-1')).toBe(true); expect(service.saves.getSnapshot().dirty).toBe(false);
    expect((await h.repository.loadSlot('campaign-1')).world.clock.simulationTick).toBe(1);
  });

  it('renews through the adopted controller with the original writer epoch and releases that owner once', async () => {
    const h = await harness(); const target = h.host.getBoundTarget()!; const service = await adopted(h.host);
    const renew = vi.spyOn(h.repository, 'renewLease'); const release = vi.spyOn(h.repository, 'releaseLease');
    expect(await service.saves.renew()).toBe(true);
    expect(renew).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ slotId: target.receipt.lease.slotId,
      ownerId: target.receipt.lease.ownerId, epoch: target.receipt.lease.epoch }));
    expect(service.saves.getSnapshot()).toMatchObject({ dirty: false, busy: false, readOnly: false, boundSlot: 'campaign-1' });
    expect(await service.dispose()).toEqual({ storageStopped: true, sessionClosed: true });
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ slotId: target.receipt.lease.slotId,
      ownerId: target.receipt.lease.ownerId, epoch: target.receipt.lease.epoch }));
    expect(await service.saves.renew()).toBe(false); expect(renew).toHaveBeenCalledTimes(1);
    expect((await h.repository.loadSlot('campaign-1')).slot.revision).toBe(1);
  });

  it('keeps host ownership intact and disarms its candidate when subscription/timer preparation fails', async () => {
    const h = await harness(); const target = h.host.getBoundTarget()!; const subscribe = target.session.subscribe;
    const detached = vi.fn(); vi.spyOn(target.session, 'subscribe').mockImplementation(listener => {
      const unsubscribe = subscribe(listener); return () => { detached(); unsubscribe(); };
    });
    vi.spyOn(globalThis, 'setInterval').mockImplementationOnce(() => { throw new Error('Synthetic timer allocation failure'); });
    const closeSession = vi.spyOn(target.session, 'close'); const release = vi.spyOn(h.repository, 'releaseLease'); const closeRepository = vi.spyOn(h.repository, 'close');
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'PREPARATION_FAILED' });
    expect(h.host.getBoundTarget()).toBe(target); expect(detached).toHaveBeenCalledTimes(1);
    expect(closeSession).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(closeRepository).not.toHaveBeenCalled();
    expect(target.session.setSpeed(3).ok).toBe(true); expect((await h.repository.loadSlot('campaign-1')).slot.revision).toBe(1);
    const service = await adopted(h.host); expect(service.saves.getSnapshot().dirty).toBe(true);
  });

  it('fences Session changes after an await, rejects overlapping transfers, and leaves the host available for retry', async () => {
    const h = await harness(); const target = h.host.getBoundTarget()!; const gate = deferred(); const entered = deferred();
    const list = h.repository.listSlots.bind(h.repository); const renew = vi.spyOn(h.repository, 'renewLease');
    vi.spyOn(h.repository, 'listSlots').mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return list(); });
    const pending = h.host.transferToController(); await entered.promise;
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'TRANSFER_BUSY' });
    expect(target.session.setSpeed(3).ok).toBe(true); gate.resolve();
    expect(await pending).toEqual({ ok: false, code: 'SOURCE_CHANGED' }); expect(renew).not.toHaveBeenCalled();
    expect(h.host.getBoundTarget()).toBe(target); expect(target.session.getSnapshot().closed).toBe(false);
    expect((await adopted(h.host)).saves.getSnapshot().dirty).toBe(true);
  });

  it('fences host close after real renewal without a second release or closing the caller connection', async () => {
    const h = await harness(); const target = h.host.getBoundTarget()!; const renewed = deferred(); const gate = deferred();
    const realRenew = h.repository.renewLease.bind(h.repository);
    vi.spyOn(h.repository, 'renewLease').mockImplementationOnce(async token => { const result = await realRenew(token); renewed.resolve(); await gate.promise; return result; });
    const release = vi.spyOn(h.repository, 'releaseLease'); const closeRepository = vi.spyOn(h.repository, 'close');
    const pending = h.host.transferToController(); await renewed.promise; await h.host.close(); gate.resolve();
    expect(await pending).toEqual({ ok: false, code: 'HOST_CLOSED' }); expect(release).toHaveBeenCalledTimes(1);
    expect(closeRepository).not.toHaveBeenCalled(); expect(target.session.getSnapshot().closed).toBe(true);
    expect((await h.repository.loadSlot('campaign-1')).snapshot.text).toBe(target.receipt.snapshot.text);
  });

  it('discards fully prepared allocations if the host closes before final ownership transfer', async () => {
    const h = await harness(); const prepared = deferred(); const gate = deferred();
    const realPrepare = ManagementSaveControllerV10.prepareCopyTransfer;
    vi.spyOn(ManagementSaveControllerV10, 'prepareCopyTransfer').mockImplementationOnce(async offer => {
      const result = await realPrepare(offer); prepared.resolve(); await gate.promise; return result;
    });
    const discard = vi.spyOn(ManagementSaveControllerV10, 'discardCopyTransfer'); const activation = vi.spyOn(ManagementSaveControllerV10, 'activateCopyTransfer');
    const pending = h.host.transferToController(); await prepared.promise; await h.host.close(); gate.resolve();
    expect(await pending).toEqual({ ok: false, code: 'HOST_CLOSED' }); expect(discard).toHaveBeenCalledTimes(1); expect(activation).not.toHaveBeenCalled();
  });

  it('requires exact host/paired token provenance and consumes prepared activation once with no arbitrary reflection', async () => {
    const h = await harness(); const realPrepare = ManagementSaveControllerV10.prepareCopyTransfer; const realActivate = ManagementSaveControllerV10.activateCopyTransfer;
    let token: PreparedCopyControllerV10 | null = null; let offer: CopyHostTransferOfferV10 | null = null;
    vi.spyOn(ManagementSaveControllerV10, 'prepareCopyTransfer').mockImplementationOnce(async input => {
      const result = await realPrepare(input); if (!result.ok) return result; token = result.token; offer = input;
      const view = V9V10CopyHost.readTransferOffer(input)!;
      expect(Object.keys(view).sort()).toEqual(['binding', 'savedSource', 'source']);
      expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.source)).toBe(true); expect(Object.isFrozen(view.savedSource)).toBe(true);
      expect(realActivate(result.token, input)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
      expect(realActivate({ ...result.token }, input)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
      expect(await realPrepare(input)).toEqual({ ok: false, code: 'TRANSFER_BUSY' });
      expect(h.host.getBoundTarget()).not.toBeNull(); return result;
    });
    await adopted(h.host);
    expect(realActivate(token!, offer!)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
    expect(ManagementSaveControllerV10.discardCopyTransfer(token!)).toBe(false);
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'NO_BOUND_TARGET' });
    let reads = 0; const hostile = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; }, ownKeys() { reads++; throw null; } });
    expect(V9V10CopyHost.readTransferOffer(hostile as CopyHostTransferOfferV10)).toBeNull();
    expect(await realPrepare(hostile as CopyHostTransferOfferV10)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
    expect(realActivate(hostile as PreparedCopyControllerV10, hostile as CopyHostTransferOfferV10)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
    expect(reads).toBe(0);
  });

  it('cannot activate a prepared controller with another live host offer', async () => {
    const first = await harness(); const second = await harness();
    const realPrepare = ManagementSaveControllerV10.prepareCopyTransfer;
    const ready = deferred(); const gate = deferred();
    let firstOffer: CopyHostTransferOfferV10 | null = null; let firstToken: PreparedCopyControllerV10 | null = null;
    vi.spyOn(ManagementSaveControllerV10, 'prepareCopyTransfer')
      .mockImplementationOnce(async offer => {
        const result = await realPrepare(offer); if (!result.ok) return result;
        firstOffer = offer; firstToken = result.token; ready.resolve(); await gate.promise; return result;
      })
      .mockImplementationOnce(async offer => {
        const result = await realPrepare(offer); if (!result.ok) return result;
        expect(ManagementSaveControllerV10.activateCopyTransfer(firstToken!, offer)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
        expect(ManagementSaveControllerV10.activateCopyTransfer(result.token, firstOffer!)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
        return result;
      });
    const pending = adopted(first.host); await ready.promise;
    const secondService = await adopted(second.host); gate.resolve(); const firstService = await pending;
    expect(firstService.session).not.toBe(secondService.session);
    expect(firstService.saves.canSave('campaign-1')).toBe(true); expect(secondService.saves.canSave('campaign-1')).toBe(true);
    expect(first.host.getBoundTarget()).toBeNull(); expect(second.host.getBoundTarget()).toBeNull();
  });

  it('waits for completed source cleanup before enabling transfer', async () => {
    const h = await harness(false); const gate = deferred(); const entered = deferred(); const finish = h.source.finishV10CopySource.bind(h.source);
    vi.spyOn(h.source, 'finishV10CopySource').mockImplementationOnce(async (token, outcome) => {
      const result = await finish(token, outcome); entered.resolve(); await gate.promise; return result;
    });
    const pending = h.coordinator.copy(options); await entered.promise;
    expect(h.host.getBoundTarget()).not.toBeNull(); expect(await h.host.transferToController()).toEqual({ ok: false, code: 'COPY_PENDING' });
    gate.resolve(); expect(await pending).toMatchObject({ kind: 'committed-and-bound', cleanup: [] }); await adopted(h.host);
  });

  it('does not confuse successful stale-source cleanup with retirement of the actual source writer', async () => {
    const h = await harness(false); await h.source.save('campaign-1');
    const finish = h.source.finishV10CopySource.bind(h.source);
    let cleanupResult: FinishV10CopySourceV9 | null = null;
    vi.spyOn(h.source, 'finishV10CopySource').mockImplementationOnce(async (token, outcome) => {
      expect(outcome).toBe('bound');
      expect(h.session.replaceWorld(createUnregisteredWorldV9('new-source-owner')).ok).toBe(true);
      cleanupResult = await finish(token, outcome); return cleanupResult;
    });
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'committed-and-bound', committed: true,
      cleanup: ['SOURCE_CLEANUP_UNCONFIRMED'] });
    expect(cleanupResult).toMatchObject({ ok: true, sourceCurrent: false, lease: 'retained' });
    expect(h.source.getSnapshot().readOnly).toBe(false); expect(h.session.getSnapshot().holds.storage).toBe(false);
    const list = vi.spyOn(h.repository, 'listSlots');
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'SOURCE_UNPROTECTED' });
    expect(list).not.toHaveBeenCalled(); expect(h.host.getBoundTarget()).not.toBeNull();
    expect((await h.repository.loadSlot('campaign-1')).slot.revision).toBe(1);
  });

  it('refuses adoption when a current source cleaned up without relinquishing its writer', async () => {
    const h = await harness(false); const finish = h.source.finishV10CopySource.bind(h.source);
    let cleanupResult: FinishV10CopySourceV9 | null = null;
    vi.spyOn(h.source, 'finishV10CopySource').mockImplementationOnce(async token => {
      cleanupResult = await finish(token, 'failed'); return cleanupResult;
    });
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'committed-and-bound', committed: true,
      cleanup: ['SOURCE_CLEANUP_UNCONFIRMED'] });
    expect(cleanupResult).toMatchObject({ ok: true, sourceCurrent: true, lease: 'retained' });
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'SOURCE_UNPROTECTED' });
    expect(h.session.getSnapshot().holds.storage).toBe(false);
  });

  it('preserves a source lease-release failure while allowing adoption after confirmed source protection', async () => {
    const h = await harness(false); const finish = h.source.finishV10CopySource.bind(h.source);
    vi.spyOn(h.source, 'finishV10CopySource').mockImplementationOnce(async (token, outcome) => {
      const result = await finish(token, outcome);
      expect(result).toMatchObject({ ok: true, sourceCurrent: true, holdReleased: true, lease: 'released' });
      return { ok: true, sourceCurrent: true, holdReleased: true, lease: 'release-failed' };
    });
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'committed-and-bound', committed: true,
      cleanup: ['SOURCE_LEASE_RELEASE_FAILED'] });
    expect(h.source.getSnapshot().readOnly).toBe(true); expect(h.session.getSnapshot().holds.storage).toBe(true);
    expect((await adopted(h.host)).saves.canSave('campaign-1')).toBe(true);
  });

  it('preserves explicit source protection, hold and lease failure diagnostics and refuses automatic adoption', async () => {
    const h = await harness(false); const finish = h.source.finishV10CopySource.bind(h.source);
    vi.spyOn(h.source, 'finishV10CopySource').mockImplementationOnce(async (token, outcome) => {
      await finish(token, outcome);
      return { ok: false, code: 'SOURCE_PROTECTION_FAILED', sourceCurrent: true, holdReleased: false, lease: 'release-failed' };
    });
    expect(await h.coordinator.copy(options)).toMatchObject({ kind: 'committed-and-bound', committed: true,
      cleanup: ['SOURCE_PROTECTION_FAILED', 'SOURCE_HOLD_RELEASE_FAILED', 'SOURCE_LEASE_RELEASE_FAILED'] });
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'SOURCE_UNPROTECTED' });
    expect(h.host.getBoundTarget()).not.toBeNull(); expect((await h.repository.loadSlot('campaign-1')).slot.revision).toBe(1);
  });

  it('preserves a foreign read-only hold and rejects an externally replaced Session before storage work', async () => {
    const h = await harness(); const target = h.host.getBoundTarget()!; target.session.setStorageReadOnly(true);
    const service = await adopted(h.host); expect(service.saves.getSnapshot()).toMatchObject({ readOnly: true, dirty: false });
    expect(service.saves.canSave('campaign-1')).toBe(false); await service.saves.stop();
    expect(service.session.getSnapshot().holds.storage).toBe(true); expect(service.session.getSnapshot().closed).toBe(false);
    const next = await harness(); const old = next.host.getBoundTarget()!;
    expect(old.session.replaceWorld(createUnregisteredWorldV10('external-replacement')).ok).toBe(true);
    const list = vi.spyOn(next.repository, 'listSlots'); expect(await next.host.transferToController()).toEqual({ ok: false, code: 'SOURCE_CHANGED' });
    expect(list).not.toHaveBeenCalled(); expect(next.host.getBoundTarget()).toBe(old);
  });

  it('leaves host ownership intact on storage/lease failure without inspecting a thrown proxy', async () => {
    const h = await harness(); const target = h.host.getBoundTarget()!; let reads = 0;
    const error = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; } });
    vi.spyOn(h.repository, 'listSlots').mockRejectedValueOnce(error);
    const release = vi.spyOn(h.repository, 'releaseLease');
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'STORAGE_FAILED' }); expect(reads).toBe(0);
    expect(h.host.getBoundTarget()).toBe(target); expect(release).not.toHaveBeenCalled();
    vi.spyOn(h.repository, 'renewLease').mockRejectedValueOnce(error);
    expect(await h.host.transferToController()).toEqual({ ok: false, code: 'STORAGE_FAILED' }); expect(reads).toBe(0);
    expect(h.host.getBoundTarget()).toBe(target); expect(release).not.toHaveBeenCalled();
  });
});
