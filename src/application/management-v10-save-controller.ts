import type { SaveMetadata } from '../core/kernel/save';
import { parseSaveV10 } from '../core/kernel/save-v10';
import { SAVE_FILE_LIMIT_BYTES } from '../core/save-budget';
import { captureSaveDataV10 } from '../core/world/save-admission-v10';
import type { RuntimeReadonlyV10 } from '../core/world/runtime-view-types-v10';
import type { TextKey } from '../i18n';
import type { SaveFile } from '../platform/files/save-files';
import { IndexedDbManagementV10Repository, openManagementV10Repository } from '../platform/persistence/indexeddb-management-v10-repository';
import { ManagementV10PersistenceError, managementV10PersistenceErrorCode, type CampaignSlotId,
  type ManagementV10PersistenceErrorCode, type ManagementV10RepositoryOptions, type SaveCommit, type SlotManifest,
  type WriterLease } from '../platform/persistence/management-v10-types';
import { CAMPAIGN_SLOT_IDS } from '../platform/persistence/types';
import type { ImportFileSource, SaveImportStatus } from './save-controller';
import { ApplicationSessionV10, type PreparedReplacementV10, type SessionSourceV10, type SessionValueV10 } from './session-v10';

export interface LoadReviewV10 extends SessionSourceV10 {
  readonly kind: 'v10-load-review'; readonly slotId: CampaignSlotId; readonly expectedRevision: number; readonly dirty: boolean;
}
export interface ImportConfirmationV10 {
  selectionId: number; slotId: CampaignSlotId; expectedRevision: number; overwriteConfirmed: boolean; replaceDirtyConfirmed: boolean;
}
export interface ManagementSaveStatusV10 {
  mode: 'stopped' | 'opening' | 'browser' | 'unavailable'; busy: boolean; readOnly: boolean; dirty: boolean;
  autosave: 'manual-only'; slots: Array<{ slotId: CampaignSlotId; slot: SlotManifest | null }>;
  boundSlot: CampaignSlotId | null; lastSavedAt: string | null; notice: TextKey | null;
  lastAction: 'saved' | 'loaded' | 'imported' | null; import: SaveImportStatus;
  load: LoadReviewV10 | null;
  /** A durable write can outlive a cancelled/stopped in-memory bind. Never call it a rollback. */
  committed: { slotId: CampaignSlotId; revision: number; bound: boolean } | null;
  rescue: { slotId: CampaignSlotId; snapshotIds: string[]; reason: 'recovered' | 'unreadable' } | null;
}
type Result<T> = { ok: true; value: T } | { ok: false };
type Lease = { repository: IndexedDbManagementV10Repository; token: WriterLease; release: Promise<void> | null };
type Operation = {
  generation: number; repository: IndexedDbManagementV10Repository | null; abort: AbortController;
  source: SessionSourceV10; held: boolean; phase: 'acquiring' | 'active' | 'committing' | 'releasing';
  prepared: PreparedReplacementV10 | null; done: Promise<void>; settle(): void;
};
const emptyImport = (selectionId = 0): SaveImportStatus => ({ selectionId, phase: 'idle', filename: null,
  seed: null, savedAt: null, migrated: false, target: null, notice: null });
const emptySlots = (): ManagementSaveStatusV10['slots'] => CAMPAIGN_SLOT_IDS.map(slotId => ({ slotId, slot: null }));
const sameSource = (a: SessionSourceV10, b: SessionSourceV10): boolean => a.sessionEpoch === b.sessionEpoch
  && a.worldRevision === b.worldRevision && a.revision === b.revision;
const sameLease = (a: WriterLease, b: WriterLease): boolean => a.slotId === b.slotId && a.ownerId === b.ownerId && a.epoch === b.epoch;
const source = (value: SessionSourceV10): SessionSourceV10 => ({ sessionEpoch: value.sessionEpoch, worldRevision: value.worldRevision, revision: value.revision });
function freeze<T>(value: T): RuntimeReadonlyV10<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child); Object.freeze(value);
  }
  return value as RuntimeReadonlyV10<T>;
}
function fail(code: ManagementV10PersistenceErrorCode): never { throw new ManagementV10PersistenceError(code, 'Private v10 storage operation rejected'); }
function unwrap<T>(result: SessionValueV10<T>): T {
  if (result.ok) return result.value;
  throw new ManagementV10PersistenceError('INVALID_SAVE', 'Session rejected v10 storage preparation', {
    ...(result.kind === 'save-rejection' ? { saveErrorCode: result.code } : {}),
  });
}
function parse(text: string) {
  const result = parseSaveV10(text);
  if (!result.ok) throw new ManagementV10PersistenceError('INVALID_SAVE', 'Strict v10 save admission failed', { saveErrorCode: result.error.code });
  return result;
}
function message(error: unknown): TextKey {
  const code = managementV10PersistenceErrorCode(error);
  // Only module-branded errors may have their diagnostic fields inspected.
  if (code && error instanceof ManagementV10PersistenceError) {
    if (error.saveErrorCode === 'TOO_LARGE') return 'save.error.tooLarge';
    if (error.saveErrorCode?.startsWith('UNSUPPORTED_')) return 'save.error.version';
  }
  const messages: Partial<Record<ManagementV10PersistenceErrorCode, TextKey>> = {
    STORAGE_UNAVAILABLE: 'save.error.unavailable', STORAGE_BLOCKED: 'save.error.blocked', DATABASE_VERSION_UNSUPPORTED: 'save.error.version',
    STORAGE_SCHEMA_INVALID: 'save.error.invalid', INVALID_ARGUMENT: 'save.error.invalid', INVALID_SAVE: 'save.error.invalid',
    QUOTA_EXCEEDED: 'save.error.quota', SLOT_EMPTY: 'save.error.empty', SLOT_OCCUPIED: 'save.error.slotOccupied', NO_EMPTY_SLOT: 'save.error.full',
    REVISION_CONFLICT: 'save.error.conflict', LEASE_BUSY: 'save.error.leaseBusy', LEASE_LOST: 'save.error.leaseLost',
    SNAPSHOT_MISSING: 'save.error.missing', NO_VALID_SNAPSHOT: 'save.error.invalid', CURRENT_SNAPSHOT_INVALID: 'save.error.protected',
    NEWER_SAVE_PROTECTED: 'save.error.version',
  };
  return code ? messages[code] ?? 'save.error.transaction' : 'save.error.transaction';
}
const download = (text: string, label: string): SaveFile => ({ text, mimeType: 'application/json',
  filename: `shanmen-changming-v10-${label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96)}.json` });

/** Private normal-save lifecycle. No legacy route, injected validator, memory-save
 * fiction, automatic load, force takeover, migration, or copied-host adoption.
 * Owns its connection and leases, but never closes the caller's Session. */
export class ManagementSaveControllerV10 {
  private repository: IndexedDbManagementV10Repository | null = null;
  private lease: Lease | null = null;
  private revision = 0;
  private generation = 0;
  private enabled = false;
  private operation: Operation | null = null;
  private closing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private observedEpoch: number;
  private ownReadOnly = false;
  private desiredReadOnly = false;
  private savedBoundary: string | null = null;
  private selection = 0;
  private candidate: { selectionId: number; text: string; targetSource: SessionSourceV10 | null } | null = null;
  private loadReview: LoadReviewV10 | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly ownerId = globalThis.crypto?.randomUUID?.() ?? `management-v10-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private readonly options: ManagementV10RepositoryOptions;
  private status: RuntimeReadonlyV10<ManagementSaveStatusV10> = freeze({ mode: 'stopped', busy: false, readOnly: false,
    dirty: true, autosave: 'manual-only', slots: emptySlots(), boundSlot: null, lastSavedAt: null, notice: null,
    lastAction: null, import: emptyImport(), load: null, committed: null, rescue: null });

  constructor(private readonly session: ApplicationSessionV10, options: ManagementV10RepositoryOptions = {}) {
    this.options = { ...options }; this.observedEpoch = session.getSnapshot().sessionEpoch;
  }
  readonly getSnapshot = (): RuntimeReadonlyV10<ManagementSaveStatusV10> => this.status;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private boundary(): string { const value = this.session.getSnapshot(); return `${value.sessionEpoch}:${value.worldRevision}`; }
  private dirty(): boolean { return this.savedBoundary !== this.boundary() || this.session.getSnapshot().runtimeFailure !== null; }
  private update(patch: Partial<ManagementSaveStatusV10>): void {
    this.status = freeze({ ...this.status, ...patch }) as RuntimeReadonlyV10<ManagementSaveStatusV10>;
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* Observers do not own storage. */ } }
  }
  private onSession = (): void => {
    const snapshot = this.session.getSnapshot(); const operation = this.operation;
    if (!snapshot.holds.storage) this.ownReadOnly = false;
    const expected = operation?.phase === 'acquiring'
      ? { ...operation.source, revision: operation.source.revision + 1 }
      : operation?.phase === 'committing'
        ? { sessionEpoch: operation.source.sessionEpoch + 1, worldRevision: operation.source.worldRevision + 1, revision: operation.source.revision + 1 }
        : operation?.phase === 'releasing' ? { ...operation.source, revision: operation.source.revision + 1 } : operation?.source;
    const ownPublication = !!operation && !!expected && sameSource(snapshot, expected)
      && (operation.phase === 'releasing' ? !snapshot.holds.storageBusy : snapshot.holds.storageBusy);
    if (operation && !ownPublication) {
      if (!snapshot.holds.storageBusy || snapshot.sessionEpoch !== operation.source.sessionEpoch) operation.held = false;
      operation.abort.abort();
    }
    if (snapshot.closed || snapshot.sessionEpoch !== this.observedEpoch && !ownPublication) {
      this.ownReadOnly = false; this.observedEpoch = snapshot.sessionEpoch; void this.stop(); return;
    }
    this.observedEpoch = snapshot.sessionEpoch;
    const dirty = this.dirty();
    if (dirty !== this.status.dirty) this.update({ dirty });
    if (!this.operation && this.enabled && (this.status.busy !== snapshot.holds.storageBusy
      || this.status.readOnly !== (this.desiredReadOnly || snapshot.holds.storage))) {
      this.update({ busy: snapshot.holds.storageBusy, readOnly: this.desiredReadOnly || snapshot.holds.storage });
    }
  };
  private current(operation: Operation): boolean {
    return this.enabled && operation === this.operation && operation.generation === this.generation
      && operation.repository === this.repository && !operation.abort.signal.aborted
      && !this.session.getSnapshot().closed && sameSource(operation.source, this.session.getSnapshot())
      && operation.held && this.session.getSnapshot().holds.storageBusy;
  }
  private check(operation: Operation): void { if (!this.current(operation)) fail('TRANSACTION_FAILED'); }
  private releaseLease(lease: Lease | null): Promise<void> {
    if (!lease) return Promise.resolve();
    // Set once before entering user-observable promise work; renewal shares this handle.
    lease.release ??= Promise.resolve().then(() => lease.repository.releaseLease(lease.token)).catch(() => {});
    return lease.release;
  }
  private syncReadOnly(): void {
    const snapshot = this.session.getSnapshot();
    if (snapshot.closed || snapshot.holds.storageBusy) return;
    if (this.desiredReadOnly && !snapshot.holds.storage) {
      const result = this.session.setStorageReadOnly(true);
      this.ownReadOnly = result.ok && result.changed && this.session.getSnapshot().holds.storage
        && this.session.getSnapshot().sessionEpoch === snapshot.sessionEpoch;
    } else if (!this.desiredReadOnly && this.ownReadOnly && snapshot.holds.storage) {
      this.ownReadOnly = false; this.session.setStorageReadOnly(false);
    }
    if (this.enabled && this.status.readOnly !== (this.desiredReadOnly || this.session.getSnapshot().holds.storage)) {
      this.update({ readOnly: this.desiredReadOnly || this.session.getSnapshot().holds.storage });
    }
  }
  private rows(slot: SlotManifest): ManagementSaveStatusV10['slots'] {
    return this.status.slots.map(entry => ({ slotId: entry.slotId, slot: entry.slotId === slot.slotId ? { ...slot, autoSnapshotIds: [...slot.autoSnapshotIds] }
      : entry.slot ? { ...entry.slot, autoSnapshotIds: [...entry.slot.autoSnapshotIds] } : null }));
  }
  private metadata(): SaveMetadata { return { buildId: 'management-0.10.0', savedAt: new Date().toISOString() }; }
  private async run<T>(work: (operation: Operation) => Promise<T>, opening = false, protectBinding = false): Promise<Result<T>> {
    if (!this.enabled || this.operation || this.session.getSnapshot().closed || this.session.getSnapshot().holds.storageBusy
      || !opening && this.status.mode !== 'browser') return { ok: false };
    let settle!: () => void;
    const operation: Operation = { generation: this.generation, repository: this.repository, abort: new AbortController(),
      source: source(this.session.getSnapshot()), held: false, phase: 'acquiring', prepared: null,
      done: new Promise<void>(resolve => { settle = resolve; }), settle: () => settle() };
    this.operation = operation;
    try {
      const held = this.session.setStorageBusy(true);
      const snapshot = this.session.getSnapshot();
      operation.held = held.ok && held.changed && snapshot.holds.storageBusy
        && sameSource(snapshot, { ...operation.source, revision: operation.source.revision + 1 });
      operation.source = source(snapshot); operation.phase = 'active';
      this.check(operation); this.update({ busy: true, notice: null }); this.check(operation);
      const value = await work(operation); this.check(operation); return { ok: true, value };
    } catch (error) {
      if (operation.generation === this.generation && this.enabled) {
        const code = managementV10PersistenceErrorCode(error);
        if (protectBinding && (code === 'LEASE_LOST' || code === 'REVISION_CONFLICT' || code === 'NEWER_SAVE_PROTECTED' || code === 'CURRENT_SNAPSHOT_INVALID')) {
          this.desiredReadOnly = true;
          const old = this.lease; this.lease = null; void this.releaseLease(old);
          this.update({ readOnly: true });
        }
        if (operation.generation === this.generation) this.update({ notice: message(error) });
      }
      return { ok: false };
    } finally {
      if (operation.prepared) this.session.discardReplacement(operation.prepared);
      operation.prepared = null;
      // A false publication or a replacement permanently ends ownership. A later
      // true belongs to someone else; never clear it as cleanup for this operation.
      if (operation.held && sameSource(operation.source, this.session.getSnapshot()) && this.session.getSnapshot().holds.storageBusy) {
        operation.phase = 'releasing'; operation.held = false; this.session.setStorageBusy(false);
      }
      if (this.operation === operation) this.operation = null;
      if (operation.generation === this.generation) { this.syncReadOnly(); this.update({ busy: this.session.getSnapshot().holds.storageBusy, dirty: this.dirty() }); }
      operation.settle();
    }
  }
  async start(): Promise<void> {
    const closing = this.stop(); const generation = this.generation;
    await closing;
    if (generation !== this.generation || this.session.getSnapshot().closed) return;
    this.enabled = true; this.observedEpoch = this.session.getSnapshot().sessionEpoch;
    this.unsubscribeSession = this.session.subscribe(this.onSession);
    this.savedBoundary = null; this.desiredReadOnly = false;
    await this.run(async operation => {
      this.update({ mode: 'opening', boundSlot: null, lastSavedAt: null, readOnly: this.session.getSnapshot().holds.storage,
        dirty: true, slots: emptySlots(), notice: null, lastAction: null, load: null, import: emptyImport(++this.selection), rescue: null });
      this.check(operation);
      let repository: IndexedDbManagementV10Repository | null = null;
      try {
        repository = await openManagementV10Repository(this.options); this.check(operation);
        const slots = await repository.listSlots(); this.check(operation);
        this.repository = repository; operation.repository = repository;
        this.update({ mode: 'browser', slots }); this.check(operation);
        this.timer = setInterval(() => { void this.renew(); }, 5000);
      } catch (error) {
        if (repository && repository !== this.repository) repository.close();
        this.check(operation); this.update({ mode: 'unavailable', notice: message(error) });
      }
    }, true);
  }
  /** Invalidates immediately. The returned promise waits for held work and lease
   * teardown. Safe to call without awaiting from a synchronous subscriber. */
  stop(): Promise<void> {
    const generation = ++this.generation; this.enabled = false; this.operation?.abort.abort();
    if (this.timer) clearInterval(this.timer); this.timer = null;
    const repository = this.repository; const lease = this.lease; const pending = this.operation?.done;
    this.repository = null; this.lease = null; this.revision = 0;
    this.candidate = null; this.loadReview = null; this.selection++;
    const notify = this.status.mode !== 'stopped' || this.status.boundSlot !== null || this.status.load !== null || this.status.import.phase !== 'idle';
    this.closing = Promise.all([this.closing, pending]).then(async () => {
      await this.releaseLease(lease); repository?.close();
      if (generation !== this.generation) return;
      this.desiredReadOnly = false; this.syncReadOnly();
      this.unsubscribeSession?.(); this.unsubscribeSession = null;
      const snapshot = this.session.getSnapshot();
      if (this.status.busy !== snapshot.holds.storageBusy || this.status.readOnly !== snapshot.holds.storage) {
        this.update({ busy: snapshot.holds.storageBusy, readOnly: snapshot.holds.storage });
      }
    });
    if (notify) this.update({ mode: 'stopped', busy: !!this.operation, boundSlot: null, import: emptyImport(this.selection), load: null });
    return this.closing;
  }
  async refresh(): Promise<boolean> {
    return (await this.run(async operation => {
      const slots = await operation.repository!.listSlots(); this.check(operation); this.update({ slots });
    })).ok;
  }
  async renew(): Promise<boolean> {
    if (!this.lease || this.operation) return false;
    return (await this.run(async operation => {
      const lease = this.lease!; const token = await lease.repository.renewLease(lease.token); this.check(operation);
      if (lease !== this.lease || lease.release) fail('LEASE_LOST'); lease.token = token;
    }, false, true)).ok;
  }
  canSave(slotId: CampaignSlotId): boolean {
    const row = this.status.slots.find(entry => entry.slotId === slotId);
    return this.enabled && this.status.mode === 'browser' && !this.operation && !this.status.readOnly
      && !this.session.getSnapshot().closed && !this.session.getSnapshot().holds.storageBusy && !this.session.getSnapshot().holds.storage
      && !!row && (row.slot === null || this.status.boundSlot === slotId && this.lease !== null);
  }
  private committed(result: SaveCommit): void { this.update({ committed: { slotId: result.slot.slotId, revision: result.slot.revision, bound: false } }); }
  private bind(operation: Operation, result: SaveCommit, lease: Lease | null, readOnly: boolean, action: 'saved' | 'loaded' | 'imported'): Lease | null {
    this.check(operation); const old = this.lease;
    this.lease = lease; this.revision = result.slot.revision; this.savedBoundary = this.boundary(); this.desiredReadOnly = readOnly;
    this.update({ slots: this.rows(result.slot), boundSlot: result.slot.slotId, lastSavedAt: result.slot.savedAt,
      readOnly: readOnly || this.session.getSnapshot().holds.storage && !this.ownReadOnly, dirty: false, lastAction: action,
      notice: action === 'saved' ? 'save.saved' : readOnly ? 'save.recoveredReadOnly' : null,
      committed: action === 'loaded' ? this.status.committed : { slotId: result.slot.slotId, revision: result.slot.revision, bound: true } });
    return old !== lease ? old : null;
  }
  async save(slotId: CampaignSlotId): Promise<boolean> {
    if (!this.canSave(slotId)) return false;
    return (await this.run(async operation => {
      const text = unwrap(this.session.exportSave(this.metadata())); parse(text); this.check(operation);
      const repository = operation.repository!; let acquired: Lease | null = null;
      try {
        let result: SaveCommit;
        if (this.status.boundSlot === slotId && this.lease) {
          acquired = this.lease; const token = await repository.renewLease(acquired.token); this.check(operation); acquired.token = token;
          result = await repository.saveText(slotId, text, { expectedRevision: this.revision, lease: token, kind: 'manual', signal: operation.abort.signal });
        } else {
          const inserted = await repository.importSave(text, { mode: 'new-slot', slotId, ownerId: this.ownerId, signal: operation.abort.signal });
          result = inserted; acquired = { repository, token: inserted.lease, release: null };
        }
        // Record durable facts even when a stop raced the transaction's completion.
        this.committed(result); this.check(operation);
        const old = this.bind(operation, result, acquired, false, 'saved');
        await this.releaseLease(old); this.check(operation);
      } finally { if (acquired && acquired !== this.lease) await this.releaseLease(acquired); }
    }, false, true)).ok;
  }
  reviewLoad(slotId: CampaignSlotId): LoadReviewV10 | null {
    if (!this.enabled || this.operation || this.status.mode !== 'browser' || this.session.getSnapshot().closed) return null;
    const slot = this.status.slots.find(row => row.slotId === slotId)?.slot; if (!slot) return null;
    const review: LoadReviewV10 = Object.freeze({ kind: 'v10-load-review', ...source(this.session.getSnapshot()),
      slotId, expectedRevision: slot.revision, dirty: this.dirty() });
    this.loadReview = review; this.update({ load: review }); return review;
  }
  cancelLoad(): void { this.loadReview = null; this.update({ load: null }); }
  private prepare(operation: Operation, world: unknown): void { this.check(operation); operation.prepared = unwrap(this.session.prepareReplacement(world)); this.check(operation); }
  private commitPrepared(operation: Operation): void {
    this.check(operation); if (!operation.prepared) fail('INVALID_SAVE');
    operation.phase = 'committing';
    const result = this.session.commitReplacement(operation.prepared);
    operation.phase = 'active';
    if (!result.ok) fail('INVALID_SAVE');
    operation.prepared = null;
    operation.source = { sessionEpoch: operation.source.sessionEpoch + 1, worldRevision: operation.source.worldRevision + 1, revision: operation.source.revision + 1 };
    this.check(operation);
  }
  async load(review: LoadReviewV10, replaceDirtyConfirmed = false): Promise<boolean> {
    // Identity check comes before reading any caller-controlled review properties.
    if (!this.loadReview || review !== this.loadReview || !sameSource(review, this.session.getSnapshot())
      || review.dirty && replaceDirtyConfirmed !== true) return false;
    const result = await this.run(async operation => {
      this.loadReview = null; this.update({ load: null }); this.check(operation);
      const repository = operation.repository!; let acquired: Lease | null = null;
      try {
        let loaded = await repository.loadSlot(review.slotId); this.check(operation);
        if (loaded.slot.revision !== review.expectedRevision) fail('REVISION_CONFLICT');
        let readOnly = loaded.recovered;
        if (!readOnly) {
          try {
            if (this.lease?.token.slotId === review.slotId) {
              acquired = this.lease; const token = await repository.renewLease(acquired.token); this.check(operation); acquired.token = token;
            } else {
              const token = await repository.acquireLease(review.slotId, this.ownerId);
              acquired = { repository, token, release: null }; this.check(operation);
            }
          } catch (error) { this.check(operation); if (managementV10PersistenceErrorCode(error) !== 'LEASE_BUSY') throw error; readOnly = true; }
          loaded = await repository.loadSlot(review.slotId); this.check(operation);
          if (loaded.slot.revision !== review.expectedRevision) fail('REVISION_CONFLICT');
          readOnly ||= loaded.recovered;
        }
        this.prepare(operation, loaded.world); this.commitPrepared(operation);
        const old = this.bind(operation, loaded, readOnly ? null : acquired, readOnly, 'loaded');
        // Dispose the prior owner even if a subscriber invalidates this binding.
        const oldReleased = this.releaseLease(old); this.check(operation);
        this.update({ rescue: loaded.recovered ? { slotId: review.slotId, snapshotIds: this.snapshotIds(loaded.slot), reason: 'recovered' } : null,
          notice: loaded.recovered ? 'save.recoveredReadOnly' : readOnly ? 'save.error.leaseBusy' : null });
        await oldReleased; this.check(operation);
      } finally { if (acquired && acquired !== this.lease) await this.releaseLease(acquired); }
    }, false, review.slotId === this.status.boundSlot);
    if (!result.ok && this.enabled && this.status.mode === 'browser' && !this.operation) {
      const slot = this.status.slots.find(row => row.slotId === review.slotId)?.slot;
      if (slot) this.update({ rescue: { slotId: review.slotId, snapshotIds: this.snapshotIds(slot), reason: 'unreadable' } });
    }
    return result.ok;
  }
  private snapshotIds(slot: Pick<SlotManifest, 'currentSnapshotId' | 'manualSnapshotId' | 'checkpointSnapshotId'> & { readonly autoSnapshotIds: readonly string[] }): string[] {
    return [...new Set([slot.currentSnapshotId, ...slot.autoSnapshotIds, slot.manualSnapshotId, slot.checkpointSnapshotId].filter((id): id is string => id !== null))].slice(0, 5);
  }
  async selectImportFile(file: ImportFileSource): Promise<boolean> {
    if (!this.enabled || this.operation || this.status.mode !== 'browser') return false;
    const generation = this.generation; const selectionId = ++this.selection; const boundary = source(this.session.getSnapshot());
    this.candidate = null;
    let filename = '';
    const current = (): boolean => this.enabled && generation === this.generation && selectionId === this.selection
      && sameSource(boundary, this.session.getSnapshot()) && !this.session.getSnapshot().closed;
    try {
      const name = file.name; filename = typeof name === 'string' ? name.slice(0, 256) : '';
      const size = file.size;
      this.update({ import: { ...emptyImport(selectionId), phase: 'reading', filename } });
      if (!current()) return false;
      if (!Number.isSafeInteger(size) || size < 0 || size > SAVE_FILE_LIMIT_BYTES) {
        throw new ManagementV10PersistenceError('INVALID_SAVE', 'Import file exceeds its bounded size', { saveErrorCode: 'TOO_LARGE' });
      }
      const text = await file.text();
      if (!current()) {
        if (generation === this.generation && selectionId === this.selection) this.update({ import: { ...emptyImport(++this.selection), notice: 'save.error.conflict' } });
        return false;
      }
      const parsed = parse(text); if (!current()) return false;
      this.candidate = { selectionId, text, targetSource: null };
      this.update({ import: { ...emptyImport(selectionId), phase: 'ready', filename, seed: parsed.world.seed, savedAt: parsed.envelope.savedAt } });
      return current();
    } catch (error) {
      if (current()) this.update({ import: { ...emptyImport(selectionId), phase: 'error', filename, notice: message(error) } });
      else if (generation === this.generation && selectionId === this.selection) {
        this.update({ import: { ...emptyImport(++this.selection), notice: 'save.error.conflict' } });
      }
      return false;
    }
  }
  selectImportTarget(slotId: CampaignSlotId): boolean {
    if (!this.enabled || this.operation || this.status.import.phase !== 'ready' || !this.candidate) return false;
    const row = this.status.slots.find(entry => entry.slotId === slotId); if (!row) return false;
    this.candidate.targetSource = source(this.session.getSnapshot());
    this.update({ import: { ...this.status.import, target: { slotId, revision: row.slot?.revision ?? 0, occupied: row.slot !== null } } }); return true;
  }
  cancelImport(): boolean {
    if (this.operation || this.status.import.phase === 'committing') return false;
    this.candidate = null; this.update({ import: emptyImport(++this.selection) }); return true;
  }
  async commitImport(input: ImportConfirmationV10): Promise<boolean> {
    const captured = captureSaveDataV10(input); if (!captured.ok) return false;
    const value = captured.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'expectedRevision,overwriteConfirmed,replaceDirtyConfirmed,selectionId,slotId') return false;
    const confirmation = value as ImportConfirmationV10;
    if (!Number.isSafeInteger(confirmation.selectionId) || !Number.isSafeInteger(confirmation.expectedRevision)
      || typeof confirmation.overwriteConfirmed !== 'boolean' || typeof confirmation.replaceDirtyConfirmed !== 'boolean') return false;
    const candidate = this.candidate; const preview = this.status.import; const target = preview.target;
    if (!candidate || !target || !confirmation || preview.phase !== 'ready' || !candidate.targetSource
      || !sameSource(candidate.targetSource, this.session.getSnapshot()) || candidate.selectionId !== confirmation.selectionId
      || confirmation.slotId !== target.slotId || confirmation.expectedRevision !== target.revision
      || target.occupied && confirmation.overwriteConfirmed !== true || this.dirty() && confirmation.replaceDirtyConfirmed !== true) return false;
    const result = await this.run(async operation => {
      const repository = operation.repository!; const parsed = parse(candidate.text);
      this.prepare(operation, parsed.world);
      this.update({ import: { ...preview, phase: 'committing', notice: null } }); this.check(operation);
      let acquired: Lease | null = null;
      try {
        if (target.occupied) {
          if (this.lease?.token.slotId === target.slotId) {
            acquired = this.lease; const token = await repository.renewLease(acquired.token); this.check(operation); acquired.token = token;
          } else {
            const token = await repository.acquireLease(target.slotId, this.ownerId);
            acquired = { repository, token, release: null }; this.check(operation);
          }
        }
        const stored = target.occupied
          ? await repository.importSave(candidate.text, { mode: 'overwrite', slotId: target.slotId, expectedRevision: target.revision, lease: acquired!.token, signal: operation.abort.signal })
          : await repository.importSave(candidate.text, { mode: 'new-slot', slotId: target.slotId, ownerId: this.ownerId, signal: operation.abort.signal });
        if (!acquired) acquired = { repository, token: stored.lease, release: null };
        else if (!sameLease(acquired.token, stored.lease)) fail('LEASE_LOST');
        this.committed(stored); this.check(operation); this.commitPrepared(operation);
        const old = this.bind(operation, stored, acquired, false, 'imported');
        const oldReleased = this.releaseLease(old); this.check(operation);
        this.candidate = null;
        this.update({ import: { ...preview, phase: 'success', notice: 'save.import.success' }, rescue: null });
        await oldReleased; this.check(operation);
      } finally { if (acquired && acquired !== this.lease) await this.releaseLease(acquired); }
    }, false, target.slotId === this.status.boundSlot);
    if (!result.ok && this.enabled && candidate === this.candidate) {
      candidate.targetSource = null;
      this.update({ import: { ...preview, phase: 'ready', target: null, notice: this.status.notice } });
    }
    return result.ok;
  }
  /** Always a fresh live export, including a new display timestamp. It does not
   * return an old imported envelope and does not mark unsaved progress clean. */
  exportCurrent(): SaveFile {
    const before = source(this.session.getSnapshot());
    if (this.session.getSnapshot().closed || this.operation) fail('INVALID_SAVE');
    const text = unwrap(this.session.exportSave(this.metadata())); const parsed = parse(text);
    if (!sameSource(before, this.session.getSnapshot())) fail('TRANSACTION_FAILED');
    return download(text, parsed.envelope.savedAt);
  }
  async exportRawSnapshot(slotId: CampaignSlotId, snapshotId: string): Promise<SaveFile | null> {
    const result = await this.run(async operation => {
      const text = await operation.repository!.exportRawSnapshot(slotId, snapshotId); this.check(operation);
      return download(text, `raw-${snapshotId}`);
    });
    return result.ok ? result.value : null;
  }
  async exportMigrationSource(slotId: CampaignSlotId): Promise<SaveFile | null> {
    const result = await this.run(async operation => {
      const text = await operation.repository!.exportMigrationSource(slotId); this.check(operation);
      return download(text, `preserved-v9-source-${slotId}`);
    });
    return result.ok ? result.value : null;
  }
}
