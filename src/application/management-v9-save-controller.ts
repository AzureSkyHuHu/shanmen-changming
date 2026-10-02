import { createUnregisteredWorldV9 } from '../core/world/create-world-v9';
import type { RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import { describeSaveFile, MAX_SAVE_FILE_BYTES, parseSaveFile, type SaveFile } from '../platform/files/save-files';
import { CAMPAIGN_SLOT_IDS, MANAGEMENT_V9_DATABASE_NAME, openSaveRepository, PersistenceError,
  type CampaignSlotId, type IndexedDbSaveRepository, type RepositoryOptions, type SlotManifest, type WriterLease } from '../platform/persistence';
import type { TextKey } from '../i18n';
import type { ImportConfirmation, ImportFileSource, SaveImportStatus, SaveStatus } from './save-controller';
import type { ApplicationSessionV9, PreparedReplacementV9, SessionValueV9 } from './session-v9';
import { persistenceMessage } from './status-messages';

/** Narrow, fixed Session port. No injected validator or legacy World cast. */
export type ManagementSaveSessionV9 = Pick<ApplicationSessionV9, 'getSnapshot' | 'subscribe' | 'setStorageReadOnly' | 'setStorageBusy'
  | 'exportSave' | 'prepareReplacement' | 'commitReplacement' | 'discardReplacement'>;
export interface ManagementSaveStatusV9 extends SaveStatus {
  dirty: boolean;
  autosave: 'manual-only';
}
const emptyImport = (selectionId = 0): SaveImportStatus => ({ selectionId, phase: 'idle', filename: null, seed: null,
  savedAt: null, migrated: false, target: null, notice: null });
function freeze<T>(value: T): RuntimeReadonlyV9<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as RuntimeReadonlyV9<T>;
}
function value<T>(result: SessionValueV9<T>): T {
  if (result.ok) return result.value;
  throw new PersistenceError('INVALID_SAVE', `Session ${result.kind} prevented saving or replacement`, {
    ...(result.kind === 'save-rejection' ? { saveErrorCode: result.code } : {}),
  });
}
function v9Save(text: string) {
  const parsed = parseSaveFile(text, 'management-v9');
  if (!parsed.ok) throw new PersistenceError('INVALID_SAVE', 'Management save failed fixed v9 admission', { saveErrorCode: parsed.error.code });
  // The policy rejects other source versions before decoding; this explicit
  // discriminant protects the boundary even if that implementation changes.
  if (parsed.envelope.saveVersion !== 9) throw new PersistenceError('INVALID_SAVE', 'Management entry requires v9', { saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
  return parsed;
}
interface OperationV9 {
  readonly repository: IndexedDbSaveRepository | null;
  readonly signal: AbortSignal;
  current(): boolean;
  check(): void;
}

/** Disabled-entry coordinator; constructing it does not open a database.
 * Every write uses an explicit fixed route and storage destination. A busy hold
 * spans source admission, prepared replacement, transaction and atomic swap.
 * Stop aborts any transaction still pending; it does not claim to undo a commit.
 */
export class ManagementSaveControllerV9 {
  private repository: IndexedDbSaveRepository | null = null;
  private lease: WriterLease | null = null;
  private boundRevision = 0;
  private generation = 0;
  private selection = 0;
  private importCandidate: { selectionId: number; text: string } | null = null;
  private readonly memory = new Map<CampaignSlotId, string>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewing = false;
  private running = false;
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private prepared: PreparedReplacementV9 | null = null;
  private savedBoundary: string | null = null;
  private closing: Promise<void> = Promise.resolve();
  private readonly ownerId = globalThis.crypto?.randomUUID?.() ?? `management-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private readonly options: RepositoryOptions;
  private status: RuntimeReadonlyV9<ManagementSaveStatusV9> = freeze({ mode: 'opening', busy: false,
    slots: CAMPAIGN_SLOT_IDS.map(slotId => ({ slotId, slot: null })), boundSlot: null, readOnly: false,
    lastSavedAt: null, notice: null, import: emptyImport(), dirty: true, autosave: 'manual-only' });

  constructor(private readonly session: ManagementSaveSessionV9, options: RepositoryOptions = {}) {
    this.options = { ...options, databaseName: MANAGEMENT_V9_DATABASE_NAME, routePolicy: 'management-v9' };
    session.subscribe(() => {
      if (session.getSnapshot().closed) { this.stop(); return; }
      const dirty = this.savedBoundary === null || this.savedBoundary !== this.boundary() || session.getSnapshot().runtimeFailure !== null;
      if (dirty !== this.status.dirty) this.update({ dirty });
    });
  }
  readonly getSnapshot = (): RuntimeReadonlyV9<ManagementSaveStatusV9> => this.status;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private boundary(): string {
    const snapshot = this.session.getSnapshot();
    return `${snapshot.sessionEpoch}:${snapshot.worldRevision}`;
  }
  private update(patch: Partial<ManagementSaveStatusV9>): void {
    this.status = freeze({ ...this.status, ...patch }) as RuntimeReadonlyV9<ManagementSaveStatusV9>;
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* UI observers do not own persistence. */ } }
  }
  private metadata() { return { buildId: 'management-0.9.0', savedAt: new Date().toISOString() }; }
  private rows(slot: SlotManifest): SaveStatus['slots'] {
    return this.status.slots.map(entry => entry.slotId === slot.slotId ? { slotId: slot.slotId, slot }
      : { slotId: entry.slotId, slot: entry.slot ? { ...entry.slot, autoSnapshotIds: [...entry.slot.autoSnapshotIds] } : null });
  }
  private saved(): void { this.savedBoundary = this.boundary(); }
  private loseWriter(error: unknown): void {
    this.lease = null;
    if (!this.running) this.applyReadOnly(true);
    this.update({ readOnly: true, notice: persistenceMessage(error) });
  }
  private applyReadOnly(readOnly: boolean): void {
    const result = this.session.setStorageReadOnly(readOnly);
    if (!result.ok && !this.session.getSnapshot().closed) {
      this.update({ readOnly: true, notice: 'save.error.protected' });
    }
  }
  async start(): Promise<void> {
    this.stop();
    const generation = this.generation;
    await this.closing;
    if (generation !== this.generation || this.session.getSnapshot().closed) return;
    this.savedBoundary = null;
    this.update({ mode: 'opening', busy: false, boundSlot: null, readOnly: false, lastSavedAt: null,
      dirty: true, import: emptyImport(++this.selection) });
    if (generation !== this.generation) return;
    let opened: IndexedDbSaveRepository | null = null;
    try {
      const repository = await openSaveRepository(this.options); opened = repository;
      if (generation !== this.generation) { repository.close(); return; }
      const slots = await repository.listSlots();
      if (generation !== this.generation) { repository.close(); return; }
      this.repository = repository;
      this.applyReadOnly(false);
      if (generation !== this.generation) return;
      this.update({ mode: 'browser', slots, notice: null });
      if (generation !== this.generation) return;
      this.timer = setInterval(() => { void this.renew(); }, 5000);
    } catch (error) {
      opened?.close();
      if (generation !== this.generation) return;
      this.applyReadOnly(false);
      if (generation !== this.generation) return;
      this.update({ mode: 'memory', slots: CAMPAIGN_SLOT_IDS.map(slotId => ({ slotId, slot: null })), notice: persistenceMessage(error) });
    }
  }
  stop(): void {
    this.generation++;
    this.selection++;
    this.importCandidate = null;
    this.abort?.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const repository = this.repository; const lease = this.lease;
    this.repository = null; this.lease = null; this.boundRevision = 0;
    const cleanup = async () => {
      if (repository) {
        if (lease) await repository.releaseLease(lease).catch(() => {});
        repository.close();
      }
    };
    this.closing = Promise.all([this.closing, this.pending]).then(cleanup);
  }
  private async renew(): Promise<void> {
    const repository = this.repository; const lease = this.lease; const generation = this.generation;
    if (!repository || !lease || this.running || this.renewing || this.session.getSnapshot().closed) return;
    this.renewing = true;
    try {
      const next = await repository.renewLease(lease);
      if (generation === this.generation && repository === this.repository && lease === this.lease) this.lease = next;
    } catch (error) {
      if (generation === this.generation && repository === this.repository && lease === this.lease) this.loseWriter(error);
    } finally { this.renewing = false; }
  }
  async refresh(): Promise<void> {
    const repository = this.repository; const generation = this.generation;
    if (!repository || this.running) return;
    try {
      const slots = await repository.listSlots();
      if (generation === this.generation && repository === this.repository) this.update({ slots });
    } catch (error) { if (generation === this.generation) this.update({ notice: persistenceMessage(error) }); }
  }
  canSave(slotId: CampaignSlotId): boolean {
    if (!CAMPAIGN_SLOT_IDS.includes(slotId) || this.running || this.status.busy || this.status.mode === 'opening' || this.status.readOnly || this.session.getSnapshot().closed) return false;
    const entry = this.status.slots.find(row => row.slotId === slotId);
    return !!entry && (entry.slot === null || this.status.boundSlot === slotId);
  }
  private async run(work: (operation: OperationV9) => Promise<void>, failure?: (error: unknown) => void, fenceBinding = true): Promise<boolean> {
    if (this.running || this.status.mode === 'opening' || this.session.getSnapshot().closed || this.session.getSnapshot().holds.storageBusy) return false;
    this.running = true;
    const repository = this.repository; const generation = this.generation; const abort = new AbortController();
    this.abort = abort;
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; }); this.pending = pending;
    const current = () => generation === this.generation && repository === this.repository && !abort.signal.aborted && !this.session.getSnapshot().closed;
    const operation: OperationV9 = { repository, signal: abort.signal, current,
      check: () => { if (!current()) throw new PersistenceError('TRANSACTION_FAILED', 'Stale storage operation was cancelled'); } };
    try {
      const held = this.session.setStorageBusy(true);
      if (!held.ok) throw new PersistenceError('INVALID_SAVE', 'Session refused storage hold');
      operation.check();
      this.update({ busy: true, notice: null });
      operation.check();
      await work(operation);
      operation.check();
      return true;
    } catch (error) {
      if (current()) {
        if (fenceBinding && error instanceof PersistenceError && ['LEASE_LOST', 'REVISION_CONFLICT'].includes(error.code)) this.loseWriter(error);
        if (current()) { if (failure) failure(error); else this.update({ notice: persistenceMessage(error) }); }
      }
      return false;
    } finally {
      if (this.prepared) this.session.discardReplacement(this.prepared);
      this.prepared = null;
      const released = this.session.setStorageBusy(false);
      if (!released.ok && !this.session.getSnapshot().closed) this.update({ readOnly: true, notice: 'save.error.protected' });
      // BOTH directions must be reconciled after the token hold has ended.
      // A successful replacement may inherit a former read-only storage hold.
      this.applyReadOnly(this.status.readOnly);
      this.running = false;
      if (this.abort === abort) this.abort = null;
      if (generation === this.generation) this.update({ busy: false });
      if (this.pending === pending) this.pending = null;
      settle();
    }
  }
  private prepare(world: unknown): void { this.prepared = value(this.session.prepareReplacement(world)); }
  private commitPrepared(): void {
    if (!this.prepared) throw new PersistenceError('INVALID_SAVE', 'Prepared replacement is missing');
    const result = this.session.commitReplacement(this.prepared);
    if (!result.ok) throw new PersistenceError('INVALID_SAVE', 'Prepared replacement became stale');
    this.prepared = null;
  }
  async beginNewCampaign(seed: string): Promise<boolean> {
    if (typeof seed !== 'string' || seed.trim().length < 1 || seed.trim().length > 256) { this.update({ notice: 'save.error.seed' }); return false; }
    return this.run(async operation => {
      this.prepare(createUnregisteredWorldV9(seed.trim()));
      operation.check();
      const old = this.lease;
      if (operation.repository && old) await operation.repository.releaseLease(old);
      operation.check();
      this.commitPrepared(); operation.check();
      this.lease = null; this.boundRevision = 0; this.savedBoundary = null;
      this.importCandidate = null;
      this.update({ boundSlot: null, readOnly: false, dirty: true, lastSavedAt: null, import: emptyImport(++this.selection), notice: 'save.newCampaign' });
    });
  }
  async save(slotId: CampaignSlotId): Promise<void> {
    if (!this.canSave(slotId)) { if (!this.running) this.update({ notice: 'save.error.slotOccupied' }); return; }
    await this.run(async operation => {
      const text = value(this.session.exportSave(this.metadata()));
      const parsed = v9Save(text); const boundary = this.boundary();
      operation.check();
      if (this.status.mode === 'memory') {
        const revision = (this.status.slots.find(entry => entry.slotId === slotId)?.slot?.revision ?? 0) + 1;
        const id = `${slotId}:${revision}`;
        const slot: SlotManifest = { recordVersion: 1, slotId, revision, currentSnapshotId: id, autoSnapshotIds: [],
          manualSnapshotId: id, checkpointSnapshotId: null, savedAt: parsed.envelope.savedAt };
        this.memory.set(slotId, text); this.boundRevision = revision; this.savedBoundary = boundary;
        this.update({ boundSlot: slotId, readOnly: false, dirty: false, lastSavedAt: slot.savedAt, slots: this.rows(slot), notice: 'save.memorySaved' });
        return;
      }
      const repository = operation.repository;
      if (!repository) throw new PersistenceError('STORAGE_UNAVAILABLE', 'Repository is not open');
      if (this.status.boundSlot === slotId && this.lease) {
        const lease = await repository.renewLease(this.lease); operation.check();
        const result = await repository.saveText(slotId, text, { expectedRevision: this.boundRevision, lease, kind: 'manual', signal: operation.signal });
        operation.check(); this.lease = lease; this.boundRevision = result.slot.revision; this.savedBoundary = boundary;
        this.update({ lastSavedAt: result.slot.savedAt, dirty: false, slots: this.rows(result.slot), notice: 'save.saved' });
      } else {
        const result = await repository.importSave(text, { mode: 'new-slot', slotId, ownerId: this.ownerId, signal: operation.signal });
        if (!operation.current()) { await repository.releaseLease(result.lease).catch(() => {}); operation.check(); }
        const old = this.lease; this.lease = result.lease; this.boundRevision = result.slot.revision; this.savedBoundary = boundary;
        this.update({ boundSlot: slotId, readOnly: false, dirty: false, lastSavedAt: result.slot.savedAt, slots: this.rows(result.slot), notice: 'save.saved' });
        if (old && old.slotId !== slotId) void repository.releaseLease(old).catch(() => {});
      }
    });
  }
  /** expectedRevision is the manifest revision the user reviewed, not a fresh
   * cached value. Check the actual store both before and after acquiring a lease. */
  async load(slotId: CampaignSlotId, takeover = false, expectedRevision?: number): Promise<void> {
    await this.run(async operation => {
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
        throw new PersistenceError('INVALID_ARGUMENT', 'Reviewed load revision must be a positive safe integer');
      }
      const checkRevision = (revision: number): void => {
        if (expectedRevision !== undefined && revision !== expectedRevision) {
          throw new PersistenceError('REVISION_CONFLICT', 'Load target changed after confirmation; review it again');
        }
      };
      if (this.status.mode === 'memory') {
        const text = this.memory.get(slotId);
        if (!text) throw new PersistenceError('SLOT_EMPTY', 'Memory slot is empty');
        checkRevision(this.status.slots.find(entry => entry.slotId === slotId)?.slot?.revision ?? 0);
        const parsed = v9Save(text); this.prepare(parsed.world); operation.check(); this.commitPrepared(); operation.check();
        this.saved();
        this.boundRevision = this.status.slots.find(entry => entry.slotId === slotId)?.slot?.revision ?? 0;
        this.update({ boundSlot: slotId, readOnly: false, dirty: false, lastSavedAt: parsed.envelope.savedAt, notice: 'save.loadedPaused' });
        return;
      }
      const repository = operation.repository;
      if (!repository) throw new PersistenceError('STORAGE_UNAVAILABLE', 'Repository is not open');
      let loaded = await repository.loadSlot(slotId); operation.check(); checkRevision(loaded.slot.revision); v9Save(loaded.snapshot.text);
      let acquired: WriterLease | null = null; let transferred = false;
      let readOnly = loaded.recovered; let notice: TextKey = readOnly ? 'save.recoveredReadOnly' : 'save.loadedPaused';
      try {
        if (!loaded.recovered) {
          try {
            acquired = await repository.acquireLease(slotId, this.ownerId, { takeover }); operation.check();
            loaded = await repository.loadSlot(slotId); operation.check(); checkRevision(loaded.slot.revision); v9Save(loaded.snapshot.text);
            if (loaded.recovered) { readOnly = true; notice = 'save.recoveredReadOnly'; }
          } catch (error) {
            if (error instanceof PersistenceError && error.code === 'LEASE_BUSY') {
              readOnly = true; notice = 'save.error.leaseBusy';
              // A competing writer may have advanced between the first read and
              // this refused lease. Read-only loading must honor the review too.
              loaded = await repository.loadSlot(slotId); operation.check(); checkRevision(loaded.slot.revision); v9Save(loaded.snapshot.text);
              if (loaded.recovered) notice = 'save.recoveredReadOnly';
            } else throw error;
          }
        }
        this.prepare(loaded.world); operation.check();
        const old = this.lease;
        this.commitPrepared(); operation.check();
        this.lease = readOnly ? null : acquired; transferred = !readOnly;
        this.boundRevision = loaded.slot.revision;
        this.saved();
        this.update({ boundSlot: slotId, readOnly, dirty: false, lastSavedAt: loaded.envelope.savedAt, slots: this.rows(loaded.slot), notice });
        if (old && (old.slotId !== this.lease?.slotId || old.epoch !== this.lease?.epoch)) void repository.releaseLease(old).catch(() => {});
      } finally {
        if (acquired && !transferred && (acquired.slotId !== this.lease?.slotId || acquired.epoch !== this.lease?.epoch)) await repository.releaseLease(acquired).catch(() => {});
      }
    }, undefined, false);
  }
  async selectImportFile(file: ImportFileSource): Promise<boolean> {
    if (this.running || this.status.import.phase === 'committing') return false;
    const selectionId = ++this.selection; const generation = this.generation;
    const filename = typeof file.name === 'string' ? file.name.slice(0, 256) : '';
    this.importCandidate = null;
    this.update({ import: { ...emptyImport(selectionId), phase: 'reading', filename } });
    const current = () => generation === this.generation && selectionId === this.selection;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_SAVE_FILE_BYTES) {
      this.update({ import: { ...emptyImport(selectionId), phase: 'error', filename, notice: 'save.import.tooLarge' } }); return false;
    }
    try {
      const text = await file.text(); if (!current()) return false;
      const parsed = v9Save(text);
      this.importCandidate = { selectionId, text };
      this.update({ import: { ...emptyImport(selectionId), phase: 'ready', filename, seed: parsed.world.seed,
        savedAt: parsed.envelope.savedAt, notice: this.status.mode === 'memory' ? 'save.import.memoryOnly' : null } });
      return true;
    } catch (error) {
      if (current()) this.update({ import: { ...emptyImport(selectionId), phase: 'error', filename,
        notice: error instanceof PersistenceError ? persistenceMessage(error) : 'save.import.readError' } });
      return false;
    }
  }
  selectImportTarget(slotId: CampaignSlotId): boolean {
    if (this.running || this.status.import.phase !== 'ready' || !this.importCandidate) return false;
    const entry = this.status.slots.find(row => row.slotId === slotId); if (!entry) return false;
    this.update({ import: { ...this.status.import, target: { slotId, revision: entry.slot?.revision ?? 0, occupied: entry.slot !== null } } });
    return true;
  }
  cancelImport(): boolean {
    if (this.status.import.phase === 'committing') return false;
    this.importCandidate = null; this.update({ import: emptyImport(++this.selection) }); return true;
  }
  /** Explicit v9 import-and-load: full replacement preparation happens BEFORE the
   * repository write. The stored source text is unchanged; paused state is live-only. */
  async commitImport(confirmation: ImportConfirmation): Promise<boolean> {
    const candidate = this.importCandidate; const preview = this.status.import; const target = preview.target;
    if (this.running || preview.phase !== 'ready' || !candidate || !target || confirmation.selectionId !== candidate.selectionId
      || confirmation.selectionId !== preview.selectionId || confirmation.slotId !== target.slotId || confirmation.expectedRevision !== target.revision
      || target.occupied && !confirmation.overwriteConfirmed) return false;
    if (!this.repository || this.status.mode !== 'browser') { this.update({ import: { ...preview, notice: 'save.import.memoryOnly' } }); return false; }
    return this.run(async operation => {
      const repository = operation.repository!;
      const parsed = v9Save(candidate.text);
      this.prepare(parsed.world); operation.check();
      this.update({ import: { ...preview, phase: 'committing', notice: null } });
      operation.check();
      const priorBoundLease = this.status.boundSlot === target.slotId ? this.lease : null;
      let acquired: WriterLease | null = null; let transferred = false;
      try {
        if (target.occupied) {
          acquired = priorBoundLease ? await repository.renewLease(priorBoundLease) : await repository.acquireLease(target.slotId, this.ownerId);
          operation.check();
        }
        const result = target.occupied
          ? await repository.importSave(candidate.text, { mode: 'overwrite', slotId: target.slotId, expectedRevision: target.revision, lease: acquired!, signal: operation.signal })
          : await repository.importSave(candidate.text, { mode: 'new-slot', slotId: target.slotId, ownerId: this.ownerId, signal: operation.signal });
        acquired = result.lease; operation.check();
        const old = this.lease;
        this.commitPrepared(); operation.check();
        this.lease = result.lease; transferred = true; this.boundRevision = result.slot.revision;
        this.saved(); this.importCandidate = null;
        this.update({ boundSlot: target.slotId, readOnly: false, dirty: false, lastSavedAt: result.slot.savedAt, slots: this.rows(result.slot),
          import: { ...preview, phase: 'success', notice: 'save.import.success' } });
        if (old && (old.slotId !== result.lease.slotId || old.epoch !== result.lease.epoch)) void repository.releaseLease(old).catch(() => {});
      } finally {
        if (acquired && !transferred && !priorBoundLease) await repository.releaseLease(acquired).catch(() => {});
      }
    }, error => {
      const conflict = error instanceof PersistenceError && ['REVISION_CONFLICT', 'SLOT_OCCUPIED', 'SLOT_EMPTY'].includes(error.code);
      this.update({ import: { ...preview, phase: 'ready', target: conflict ? null : target, notice: persistenceMessage(error) } });
    });
  }
  exportCurrent(): SaveFile {
    const text = value(this.session.exportSave(this.metadata())); const parsed = v9Save(text);
    return describeSaveFile(text, parsed.envelope);
  }
}
