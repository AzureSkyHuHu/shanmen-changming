import { createSaveEnvelope, parseSave, serializeSave, SIMULATION_VERSION } from '../core/kernel';
import { exportWorldSave, type SaveFile } from '../platform/files/save-files';
import {
  CAMPAIGN_SLOT_IDS, openSaveRepository, PersistenceError,
  type CampaignSlotId, type IndexedDbSaveRepository, type SlotManifest, type WriterLease,
} from '../platform/persistence';
import type { TextKey } from '../i18n';
import { persistenceMessage } from './status-messages';
import { ApplicationSession, deepFreeze, type DeepReadonly } from './session';

export interface SaveStatus {
  mode: 'opening' | 'browser' | 'memory';
  busy: boolean;
  slots: Array<{ slotId: CampaignSlotId; slot: SlotManifest | null }>;
  boundSlot: CampaignSlotId | null;
  readOnly: boolean;
  lastSavedAt: string | null;
  notice: TextKey | null;
}

/** UI/persistence coordinator. It never advances time and never mutates a world snapshot. */
export class SaveController {
  private repository: IndexedDbSaveRepository | null = null;
  private lease: WriterLease | null = null;
  private boundRevision = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewing = false;
  private memory = new Map<CampaignSlotId, string>();
  private listeners = new Set<() => void>();
  private status: DeepReadonly<SaveStatus> = deepFreeze({ mode: 'opening', busy: false, slots: CAMPAIGN_SLOT_IDS.map((slotId) => ({ slotId, slot: null })), boundSlot: null, readOnly: false, lastSavedAt: null, notice: null });
  private readonly ownerId = globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  constructor(private readonly session: ApplicationSession) {}
  readonly getSnapshot = (): DeepReadonly<SaveStatus> => this.status;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<SaveStatus>): void {
    this.status = deepFreeze({ ...this.status, ...patch }) as DeepReadonly<SaveStatus>;
    for (const listener of [...this.listeners]) listener();
  }
  private metadata() { return { buildId: `playable-${SIMULATION_VERSION}`, savedAt: new Date().toISOString() }; }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.update({ mode: 'opening', busy: false });
    try {
      const repository = await openSaveRepository();
      if (generation !== this.generation) { repository.close(); return; }
      this.repository = repository;
      const slots = await repository.listSlots();
      if (generation !== this.generation) return;
      this.update({ mode: 'browser', slots, notice: null });
      this.timer = setInterval(() => { void this.renew(); }, 5000);
    } catch (error) {
      if (generation !== this.generation) return;
      this.repository?.close();
      this.repository = null;
      this.update({ mode: 'memory', notice: persistenceMessage(error) });
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const repository = this.repository;
    const lease = this.lease;
    this.repository = null;
    this.lease = null;
    if (repository) {
      if (lease) void repository.releaseLease(lease).catch(() => {}).finally(() => repository.close());
      else repository.close();
    }
  }

  private async renew(): Promise<void> {
    const repository = this.repository;
    const lease = this.lease;
    if (!repository || !lease || this.renewing || this.status.busy) return;
    this.renewing = true;
    try {
      const next = await repository.renewLease(lease);
      if (this.repository === repository && this.lease === lease) this.lease = next;
    } catch (error) {
      if (this.repository === repository && this.lease === lease) this.loseWriter(error);
    } finally { this.renewing = false; }
  }

  private loseWriter(error: unknown): void {
    this.lease = null;
    this.session.setStorageReadOnly(true);
    this.update({ readOnly: true, notice: persistenceMessage(error) });
  }

  async refresh(): Promise<void> {
    if (!this.repository || this.status.busy) return;
    try { this.update({ slots: await this.repository.listSlots() }); }
    catch (error) { this.update({ notice: persistenceMessage(error) }); }
  }

  canSave(slotId: CampaignSlotId): boolean {
    if (this.status.busy || this.status.mode === 'opening' || this.status.readOnly) return false;
    const occupied = this.status.slots.find((slot) => slot.slotId === slotId)?.slot !== null;
    return !occupied || (this.status.boundSlot === slotId && !this.status.readOnly);
  }

  async save(slotId: CampaignSlotId): Promise<void> {
    if (this.status.busy || this.status.mode === 'opening') return;
    if (!this.canSave(slotId)) { this.update({ notice: 'save.error.slotOccupied' }); return; }
    this.update({ busy: true, notice: null });
    const world = this.session.exportWorld();
    const metadata = this.metadata();
    try {
      if (this.status.mode === 'memory') {
        this.memory.set(slotId, serializeSave(createSaveEnvelope(world, metadata)));
        const revision = (this.status.slots.find((entry) => entry.slotId === slotId)?.slot?.revision ?? 0) + 1;
        const snapshotId = `memory-${slotId}-${revision}`;
        const slot: SlotManifest = { recordVersion: 1, slotId, revision, currentSnapshotId: snapshotId, autoSnapshotIds: [], manualSnapshotId: snapshotId, checkpointSnapshotId: null, savedAt: metadata.savedAt };
        this.boundRevision = revision;
        this.update({ boundSlot: slotId, readOnly: false, lastSavedAt: metadata.savedAt, slots: this.status.slots.map((entry) => entry.slotId === slotId ? { slotId, slot } : { slotId: entry.slotId, slot: entry.slot ? { ...entry.slot, autoSnapshotIds: [...entry.slot.autoSnapshotIds] } : null }), notice: 'save.memorySaved' });
        return;
      }
      const repository = this.repository;
      if (!repository) throw new PersistenceError('STORAGE_UNAVAILABLE', 'Repository is not open');
      if (this.status.boundSlot === slotId && this.lease) {
        this.lease = await repository.renewLease(this.lease);
        const result = await repository.saveWorld(slotId, world, metadata, { expectedRevision: this.boundRevision, lease: this.lease, kind: 'manual' });
        this.boundRevision = result.slot.revision;
        this.update({ lastSavedAt: result.slot.savedAt, notice: 'save.saved' });
      } else {
        // New campaigns only enter empty slots. This operation atomically rejects occupied slots.
        const result = await repository.importSave(serializeSave(createSaveEnvelope(world, metadata)), { mode: 'new-slot', slotId, ownerId: this.ownerId });
        const old = this.lease;
        this.lease = result.lease;
        this.boundRevision = result.slot.revision;
        if (old && old.slotId !== slotId) await repository.releaseLease(old).catch(() => {});
        this.update({ boundSlot: slotId, readOnly: false, lastSavedAt: result.slot.savedAt, notice: 'save.saved' });
      }
      this.update({ slots: await repository.listSlots() });
    } catch (error) {
      if (error instanceof PersistenceError && ['LEASE_LOST', 'REVISION_CONFLICT'].includes(error.code)) this.loseWriter(error);
      else this.update({ notice: persistenceMessage(error) });
    } finally { this.update({ busy: false }); }
  }

  async load(slotId: CampaignSlotId, takeover = false): Promise<void> {
    if (this.status.busy || this.status.mode === 'opening') return;
    this.update({ busy: true, notice: null });
    try {
      if (this.status.mode === 'memory') {
        const text = this.memory.get(slotId);
        if (!text) throw new PersistenceError('SLOT_EMPTY', 'Memory slot is empty');
        const parsed = parseSave(text);
        if (!parsed.ok) throw new PersistenceError('INVALID_SAVE', 'Memory save is invalid');
        this.session.replaceWorld(parsed.world);
        this.session.setStorageReadOnly(false);
        this.update({ boundSlot: slotId, readOnly: false, notice: 'save.loadedPaused', lastSavedAt: parsed.envelope.savedAt });
        return;
      }
      const repository = this.repository;
      if (!repository) throw new PersistenceError('STORAGE_UNAVAILABLE', 'Repository is not open');
      let loaded = await repository.loadSlot(slotId);
      let acquired: WriterLease | null = null;
      let readOnly = loaded.recovered;
      let notice: TextKey = loaded.recovered ? 'save.recoveredReadOnly' : 'migration' in loaded && loaded.migration ? 'save.migratedPaused' : 'save.loadedPaused';
      if (!loaded.recovered) {
        try {
          acquired = await repository.acquireLease(slotId, this.ownerId, { takeover });
          // Re-read after acquiring ownership so a completed competing save cannot be overwritten.
          loaded = await repository.loadSlot(slotId);
          if (loaded.recovered) { readOnly = true; notice = 'save.recoveredReadOnly'; }
          else notice = 'migration' in loaded && loaded.migration ? 'save.migratedPaused' : 'save.loadedPaused';
        } catch (error) {
          if (error instanceof PersistenceError && error.code === 'LEASE_BUSY') { readOnly = true; notice = 'save.error.leaseBusy'; }
          else { if (acquired) await repository.releaseLease(acquired).catch(() => {}); throw error; }
        }
      }
      const old = this.lease;
      this.lease = readOnly ? null : acquired;
      if (readOnly && acquired) await repository.releaseLease(acquired).catch(() => {});
      if (old && (old.slotId !== slotId || old.epoch !== this.lease?.epoch)) await repository.releaseLease(old).catch(() => {});
      this.boundRevision = loaded.slot.revision;
      this.session.replaceWorld(loaded.world);
      this.session.setStorageReadOnly(readOnly);
      this.update({ boundSlot: slotId, readOnly, lastSavedAt: loaded.envelope.savedAt, notice, slots: await repository.listSlots() });
    } catch (error) { this.update({ notice: persistenceMessage(error) }); }
    finally { this.update({ busy: false }); }
  }

  exportCurrent(): SaveFile { return exportWorldSave(this.session.exportWorld(), this.metadata()); }
}
