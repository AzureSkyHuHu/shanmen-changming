import { createWorld } from '../core/kernel';
import { measureWorldSaveBytes } from '../core/save-budget';
import { createVersionedSaveEnvelope, serializeVersionedSave, type VersionedWorldState } from '../platform/save-codec';
import { exportWorldSave, MAX_SAVE_FILE_BYTES, parseSaveFile, type SaveFile } from '../platform/files/save-files';
import {
  CAMPAIGN_SLOT_IDS, openSaveRepository, PersistenceError,
  type CampaignSlotId, type IndexedDbSaveRepository, type RepositoryOptions, type SlotManifest, type WriterLease,
} from '../platform/persistence';
import type { TextKey } from '../i18n';
import { persistenceMessage } from './status-messages';
import { ApplicationSession, deepFreeze, type DeepReadonly } from './session';

export interface ImportFileSource { readonly name: string; readonly size: number; text(): Promise<string> }
export type NewWorldFactory = (seed: string) => VersionedWorldState;
export interface ImportTarget { slotId: CampaignSlotId; revision: number; occupied: boolean }
export interface SaveImportStatus {
  selectionId: number;
  phase: 'idle' | 'reading' | 'ready' | 'committing' | 'error' | 'success';
  filename: string | null;
  seed: string | null;
  savedAt: string | null;
  migrated: boolean;
  target: ImportTarget | null;
  notice: TextKey | null;
}
export interface ImportConfirmation {
  selectionId: number;
  slotId: CampaignSlotId;
  expectedRevision: number;
  overwriteConfirmed: boolean;
}
const emptyImport = (selectionId = 0): SaveImportStatus => ({ selectionId, phase: 'idle', filename: null, seed: null, savedAt: null, migrated: false, target: null, notice: null });
function importFailureMessage(error: unknown): TextKey {
  if (error instanceof PersistenceError) {
    if (error.code === 'LEASE_BUSY') return 'save.import.leaseBusy';
    if (error.code === 'LEASE_LOST') return 'save.import.leaseLost';
    if (['REVISION_CONFLICT', 'SLOT_OCCUPIED', 'SLOT_EMPTY'].includes(error.code)) return 'save.import.conflict';
  }
  return persistenceMessage(error);
}

export interface SaveStatus {
  mode: 'opening' | 'browser' | 'memory';
  busy: boolean;
  slots: Array<{ slotId: CampaignSlotId; slot: SlotManifest | null }>;
  boundSlot: CampaignSlotId | null;
  readOnly: boolean;
  lastSavedAt: string | null;
  notice: TextKey | null;
  import: SaveImportStatus;
}

/** UI/persistence coordinator. It never advances time and never mutates a world snapshot. */
export class SaveController {
  private importSelection = 0;
  private importCandidate: { selectionId: number; text: string } | null = null;
  private repository: IndexedDbSaveRepository | null = null;
  private lease: WriterLease | null = null;
  private boundRevision = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewing = false;
  private memory = new Map<CampaignSlotId, string>();
  private listeners = new Set<() => void>();
  private status: DeepReadonly<SaveStatus> = deepFreeze({ mode: 'opening', busy: false, slots: CAMPAIGN_SLOT_IDS.map((slotId) => ({ slotId, slot: null })), boundSlot: null, readOnly: false, lastSavedAt: null, notice: null, import: emptyImport() });
  private readonly ownerId = globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private readonly repositoryOptions: RepositoryOptions;

  constructor(private readonly session: ApplicationSession, private readonly newWorldFactory: NewWorldFactory = createWorld, repositoryOptions: RepositoryOptions = {}) {
    // Own the selected storage destination; later caller mutation cannot redirect this controller.
    this.repositoryOptions = { ...repositoryOptions };
  }
  readonly getSnapshot = (): DeepReadonly<SaveStatus> => this.status;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<SaveStatus>): void {
    this.status = deepFreeze({ ...this.status, ...patch }) as DeepReadonly<SaveStatus>;
    for (const listener of [...this.listeners]) listener();
  }
  private metadata() { return { buildId: `playable-${this.session.getSaveIdentity().simulationVersion}`, savedAt: new Date().toISOString() }; }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.importCandidate = null;
    this.update({ mode: 'opening', busy: false, import: emptyImport(++this.importSelection) });
    try {
      const repository = await openSaveRepository(this.repositoryOptions);
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
    this.importSelection += 1;
    this.importCandidate = null;
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

  /** UI must confirm abandoning unsaved progress. Never writes or clears a stored slot. */
  async beginNewCampaign(seed: string): Promise<boolean> {
    if (this.status.busy || this.status.mode === 'opening') return false;
    if (typeof seed !== 'string' || seed.trim().length < 1 || seed.trim().length > 256) {
      this.update({ notice: 'save.error.seed' }); return false;
    }
    const generation = this.generation;
    const repository = this.repository;
    const oldLease = this.lease;
    this.update({ busy: true, notice: null });
    const current = () => generation === this.generation && repository === this.repository;
    try {
      const fresh = this.newWorldFactory(seed.trim());
      if (repository && oldLease) await repository.releaseLease(oldLease);
      if (!current()) return false;
      this.lease = null;
      this.boundRevision = 0;
      this.importCandidate = null;
      this.importSelection += 1;
      this.session.replaceWorld(fresh);
      this.session.setStorageReadOnly(false);
      this.update({ boundSlot: null, readOnly: false, lastSavedAt: null, import: emptyImport(this.importSelection), notice: 'save.newCampaign' });
      return true;
    } catch (error) {
      if (current()) this.update({ notice: persistenceMessage(error) });
      return false;
    } finally { if (current()) this.update({ busy: false }); }
  }

  async save(slotId: CampaignSlotId): Promise<void> {
    if (this.status.busy || this.status.mode === 'opening') return;
    if (!this.canSave(slotId)) { this.update({ notice: 'save.error.slotOccupied' }); return; }
    this.update({ busy: true, notice: null });
    try {
      const world = this.session.exportWorld();
      const metadata = this.metadata();
      // Classify actual encoded size before a codec can throw an untyped RangeError.
      // Use the real metadata, not the budget helper's conservative worst-case default.
      if (measureWorldSaveBytes(world, { saveVersion: this.session.getSaveIdentity().saveVersion, metadata }) > MAX_SAVE_FILE_BYTES) {
        throw new PersistenceError('INVALID_SAVE', 'Save exceeds the file size limit; previous save preserved', { saveErrorCode: 'TOO_LARGE' });
      }
      if (this.status.mode === 'memory') {
        const text = serializeVersionedSave(createVersionedSaveEnvelope(world, metadata));
        const checked = parseSaveFile(text);
        if (!checked.ok) throw new PersistenceError('INVALID_SAVE', 'Memory save failed validation; previous save preserved', { saveErrorCode: checked.error.code });
        this.memory.set(slotId, text);
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
        const result = await repository.importSave(serializeVersionedSave(createVersionedSaveEnvelope(world, metadata)), { mode: 'new-slot', slotId, ownerId: this.ownerId });
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
        const parsed = parseSaveFile(text);
        if (!parsed.ok) throw new PersistenceError('INVALID_SAVE', 'Memory save is invalid');
        this.session.replaceWorld(parsed.world);
        // v1–v4 SaveDialog persisted its UI-only choice hold. Domain decisions use separate reasons.
        if (parsed.migration && parsed.migration.sourceSaveVersion <= 4) this.session.setPaused('choice', false);
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
      if (loaded.migration && loaded.migration.sourceSaveVersion <= 4) this.session.setPaused('choice', false);
      this.session.setStorageReadOnly(readOnly);
      this.update({ boundSlot: slotId, readOnly, lastSavedAt: loaded.envelope.savedAt, notice, slots: await repository.listSlots() });
    } catch (error) { this.update({ notice: persistenceMessage(error) }); }
    finally { this.update({ busy: false }); }
  }

  /** Called only from an explicit browser file selection. File metadata is checked before reading. */
  async selectImportFile(file: ImportFileSource): Promise<boolean> {
    if (this.status.busy || this.status.import.phase === 'committing') return false;
    const selectionId = ++this.importSelection;
    const generation = this.generation;
    this.importCandidate = null;
    const filename = typeof file.name === 'string' ? file.name.slice(0, 256) : '';
    this.update({ import: { ...emptyImport(selectionId), phase: 'reading', filename } });
    const current = () => generation === this.generation && selectionId === this.importSelection;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_SAVE_FILE_BYTES) {
      this.update({ import: { ...emptyImport(selectionId), phase: 'error', filename, notice: 'save.import.tooLarge' } });
      return false;
    }
    try {
      const text = await file.text();
      if (!current()) return false;
      const parsed = parseSaveFile(text);
      if (!parsed.ok) {
        const notice: TextKey = parsed.error.code === 'TOO_LARGE' ? 'save.import.tooLarge' : parsed.error.code.startsWith('UNSUPPORTED_') ? 'save.error.version' : 'save.error.invalid';
        this.update({ import: { ...emptyImport(selectionId), phase: 'error', filename, notice } });
        return false;
      }
      this.importCandidate = { selectionId, text };
      this.update({ import: { ...emptyImport(selectionId), phase: 'ready', filename, seed: parsed.world.seed, savedAt: parsed.envelope.savedAt, migrated: !!parsed.migration, notice: this.status.mode === 'memory' ? 'save.import.memoryOnly' : null } });
      return true;
    } catch {
      if (current()) this.update({ import: { ...emptyImport(selectionId), phase: 'error', filename, notice: 'save.import.readError' } });
      return false;
    }
  }

  /** Target selection snapshots the exact visible revision. A changed target requires fresh consent. */
  selectImportTarget(slotId: CampaignSlotId): boolean {
    if (this.status.busy || this.status.import.phase !== 'ready' || !this.importCandidate || !CAMPAIGN_SLOT_IDS.includes(slotId)) return false;
    const entry = this.status.slots.find((slot) => slot.slotId === slotId);
    if (!entry) return false;
    this.update({ import: { ...this.status.import, target: { slotId, revision: entry.slot?.revision ?? 0, occupied: entry.slot !== null }, notice: this.status.mode === 'memory' ? 'save.import.memoryOnly' : null } });
    return true;
  }

  /** Once the atomic write starts it is not cancellable; the UI must not promise otherwise. */
  cancelImport(): boolean {
    if (this.status.import.phase === 'committing') return false;
    this.importCandidate = null;
    this.update({ import: emptyImport(++this.importSelection) });
    return true;
  }

  /** Store-only import. Loading is a separate explicit action after a successful storage commit. */
  async commitImport(confirmation: ImportConfirmation): Promise<boolean> {
    const candidate = this.importCandidate;
    const preview = this.status.import;
    const target = preview.target;
    if (this.status.busy || preview.phase !== 'ready' || !candidate || !target || confirmation.selectionId !== candidate.selectionId || confirmation.selectionId !== preview.selectionId || confirmation.slotId !== target.slotId || confirmation.expectedRevision !== target.revision || (target.occupied && confirmation.overwriteConfirmed !== true)) return false;
    const repository = this.repository;
    if (this.status.mode !== 'browser' || !repository) {
      this.update({ import: { ...preview, notice: 'save.import.memoryOnly' } });
      return false;
    }
    const generation = this.generation;
    const selectionId = candidate.selectionId;
    const current = () => generation === this.generation && this.repository === repository && selectionId === this.importSelection;
    const priorBoundLease = this.status.boundSlot === target.slotId ? this.lease : null;
    let acquired: WriterLease | null = null;
    let committed = false;
    this.update({ busy: true, import: { ...preview, phase: 'committing', notice: null } });
    try {
      if (target.occupied) {
        acquired = priorBoundLease ? await repository.renewLease(priorBoundLease) : await repository.acquireLease(target.slotId, this.ownerId);
        if (!current()) return false;
      }
      const result = target.occupied
        ? await repository.importSave(candidate.text, { mode: 'overwrite', slotId: target.slotId, expectedRevision: target.revision, lease: acquired! })
        : await repository.importSave(candidate.text, { mode: 'new-slot', slotId: target.slotId, ownerId: this.ownerId });
      committed = true;
      acquired = result.lease;
      // A fulfilled transaction is the sole point where detaching the old binding is allowed.
      if (current() && this.status.boundSlot === target.slotId) {
        this.lease = null;
        this.boundRevision = 0;
        this.session.setStorageReadOnly(false);
        this.update({ boundSlot: null, readOnly: false, lastSavedAt: null });
      }
      await repository.releaseLease(result.lease).catch(() => {});
      acquired = null;
      if (!current()) return false;
      this.importCandidate = null;
      this.update({
        slots: this.status.slots.map((entry) => entry.slotId === target.slotId ? { slotId: target.slotId, slot: result.slot } : { slotId: entry.slotId, slot: entry.slot ? { ...entry.slot, autoSnapshotIds: [...entry.slot.autoSnapshotIds] } : null }),
        import: { ...preview, phase: 'success', notice: 'save.import.success' },
      });
      return true;
    } catch (error) {
      if (current()) {
        const conflict = error instanceof PersistenceError && ['REVISION_CONFLICT', 'SLOT_OCCUPIED', 'SLOT_EMPTY'].includes(error.code);
        let slots: SaveStatus['slots'] | undefined;
        if (conflict) {
          try { slots = await repository.listSlots(); } catch { /* Preserve the displayed list if refresh also fails. */ }
        }
        if (current()) this.update({ ...(slots ? { slots } : {}), import: { ...preview, phase: 'ready', target: conflict ? null : target, notice: importFailureMessage(error) } });
      }
      return false;
    } finally {
      // A failed overwrite retains the original campaign's lease/binding. Temporary leases are released.
      if (acquired && (committed || !priorBoundLease)) await repository.releaseLease(acquired).catch(() => {});
      if (current()) this.update({ busy: false });
    }
  }

  exportCurrent(): SaveFile { return exportWorldSave(this.session.exportWorld(), this.metadata()); }
}
