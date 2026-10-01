import { createVersionedSaveEnvelope, parseVersionedSave, serializeVersionedSave, type SaveMetadata, type VersionedWorldState } from '../save-codec';
import { describeSaveFile, parseSaveFile, type SaveFile } from '../files/save-files';
import {
  AUTO_GENERATIONS, CAMPAIGN_SLOT_IDS, DATABASE_NAME, DATABASE_VERSION, DEFAULT_LEASE_DURATION_MS,
  PersistenceError,
  type CampaignSlotId, type ImportOptions, type ImportedSave, type LeaseRecord, type LoadedSave,
  type RepositoryOptions, type SaveCommit, type SlotManifest, type SnapshotIssue, type SnapshotKind,
  type SnapshotRecord, type WriterLease, type WriteOptions,
} from './types';

const STORES = ['slots', 'snapshots', 'leases'];
const UNSUPPORTED_VERSIONS = new Set(['UNSUPPORTED_SAVE_VERSION', 'UNSUPPORTED_SIMULATION_VERSION', 'UNSUPPORTED_CONTENT_VERSION']);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isSlot = (value: unknown): value is CampaignSlotId => CAMPAIGN_SLOT_IDS.includes(value as CampaignSlotId);
const isKind = (value: unknown): value is SnapshotKind => value === 'auto' || value === 'manual' || value === 'checkpoint';

function assertSlot(slotId: unknown): asserts slotId is CampaignSlotId {
  if (!isSlot(slotId)) throw new PersistenceError('INVALID_ARGUMENT', 'Unknown campaign slot');
}
function assertOwner(ownerId: unknown): asserts ownerId is string {
  if (typeof ownerId !== 'string' || ownerId.trim().length === 0 || ownerId.length > 128) {
    throw new PersistenceError('INVALID_ARGUMENT', 'A distinct writer identity is required');
  }
}
function assertRevision(revision: unknown): asserts revision is number {
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new PersistenceError('INVALID_ARGUMENT', 'Expected revision must be a nonnegative safe integer');
  }
}
function assertDuration(duration: number): void {
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 5 * 60_000) {
    throw new PersistenceError('INVALID_ARGUMENT', 'Lease duration must be between 1 ms and 5 minutes');
  }
}
function snapshotRevision(id: string): number { return Number(id.slice(id.lastIndexOf(':') + 1)); }
function validSnapshotId(id: unknown, slotId: CampaignSlotId): id is string {
  return typeof id === 'string' && id.startsWith(`${slotId}:`) && /^[1-9]\d*$/.test(id.slice(slotId.length + 1)) && isPositiveInteger(snapshotRevision(id));
}
function snapshotIds(slot: SlotManifest): string[] {
  return [...slot.autoSnapshotIds, slot.manualSnapshotId, slot.checkpointSnapshotId].filter((id): id is string => id !== null);
}
function readManifest(value: unknown, slotId: CampaignSlotId): SlotManifest | null {
  if (value === undefined) return null;
  if (!isRecord(value) || value.recordVersion !== 1 || value.slotId !== slotId || !isPositiveInteger(value.revision)
    || !validSnapshotId(value.currentSnapshotId, slotId) || snapshotRevision(value.currentSnapshotId) !== value.revision
    || !Array.isArray(value.autoSnapshotIds) || value.autoSnapshotIds.length > AUTO_GENERATIONS
    || !value.autoSnapshotIds.every((id) => validSnapshotId(id, slotId))
    || !(value.manualSnapshotId === null || validSnapshotId(value.manualSnapshotId, slotId))
    || !(value.checkpointSnapshotId === null || validSnapshotId(value.checkpointSnapshotId, slotId))
    || typeof value.savedAt !== 'string' || value.savedAt.length === 0 || value.savedAt.length > 64) {
    throw new PersistenceError('STORAGE_SCHEMA_INVALID', 'Stored slot metadata is invalid; data was preserved');
  }
  const slot = value as unknown as SlotManifest;
  const ids = snapshotIds(slot);
  if (!ids.includes(slot.currentSnapshotId) || new Set(ids).size !== ids.length || ids.some((id) => snapshotRevision(id) > slot.revision)
    || slot.autoSnapshotIds.some((id, index, all) => index > 0 && snapshotRevision(all[index - 1]!) <= snapshotRevision(id))) {
    throw new PersistenceError('STORAGE_SCHEMA_INVALID', 'Stored slot pointers are invalid; data was preserved');
  }
  return slot;
}
function readLease(value: unknown, slotId: CampaignSlotId): LeaseRecord | null {
  if (value === undefined) return null;
  if (!isRecord(value) || value.recordVersion !== 1 || value.slotId !== slotId || !isPositiveInteger(value.epoch)
    || !(value.ownerId === null || (typeof value.ownerId === 'string' && value.ownerId.trim().length > 0 && value.ownerId.length <= 128))
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 0) {
    throw new PersistenceError('STORAGE_SCHEMA_INVALID', 'Stored writer lease is invalid; data was preserved');
  }
  return value as unknown as LeaseRecord;
}
function readSnapshot(value: unknown, slot: SlotManifest, id: string): SnapshotRecord | null {
  const expectedKind = slot.autoSnapshotIds.includes(id) ? 'auto' : slot.manualSnapshotId === id ? 'manual' : 'checkpoint';
  if (!isRecord(value) || value.recordVersion !== 1 || value.id !== id || value.slotId !== slot.slotId
    || value.revision !== snapshotRevision(id) || value.kind !== expectedKind || typeof value.text !== 'string') return null;
  return value as unknown as SnapshotRecord;
}
function normalizeError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return new PersistenceError('QUOTA_EXCEEDED', 'Storage quota exceeded; previous save was preserved', { cause: error });
  if (name === 'VersionError') return new PersistenceError('DATABASE_VERSION_UNSUPPORTED', 'A newer storage schema exists; data was preserved', { cause: error });
  if (name === 'SecurityError' || name === 'NotAllowedError') return new PersistenceError('STORAGE_UNAVAILABLE', 'Browser storage is unavailable', { cause: error });
  return new PersistenceError('TRANSACTION_FAILED', 'Storage transaction failed; no save was committed', { cause: error });
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    // Do not preventDefault: request errors must abort the entire transaction.
    operation.onerror = () => reject(operation.error ?? new Error('IndexedDB request failed'));
  });
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Local storage adapter. Authoritative world simulation never imports this module.
 * Every writer must use a distinct per-tab ownerId and retain the returned revision/lease.
 * A lease is a storage fence, not an authentication mechanism. No unload handler is used.
 */
export class IndexedDbSaveRepository {
  private readonly now: () => number;
  private readonly faultInjector: RepositoryOptions['faultInjector'];
  private closed = false;

  private constructor(private readonly database: IDBDatabase, options: RepositoryOptions) {
    this.now = options.now ?? Date.now;
    this.faultInjector = options.faultInjector;
    database.onversionchange = () => this.close();
  }

  static async open(options: RepositoryOptions = {}): Promise<IndexedDbSaveRepository> {
    let factory: IDBFactory | undefined;
    try { factory = options.indexedDB ?? globalThis.indexedDB; }
    catch (error) { throw normalizeError(error); }
    if (!factory) throw new PersistenceError('STORAGE_UNAVAILABLE', 'IndexedDB is not available; session export can still be used');
    const name = options.databaseName ?? DATABASE_NAME;
    if (typeof name !== 'string' || !name.trim()) throw new PersistenceError('INVALID_ARGUMENT', 'Database name is required');
    let database: IDBDatabase;
    try {
      database = await new Promise<IDBDatabase>((resolve, reject) => {
        const operation = factory.open(name, DATABASE_VERSION);
        let rejected = false;
        operation.onblocked = () => {
          rejected = true;
          reject(new PersistenceError('STORAGE_BLOCKED', 'Another connection is blocking storage open'));
        };
        operation.onupgradeneeded = (event) => {
          // There is currently only schema v1. Never recreate/delete an existing store.
          if (rejected || event.oldVersion !== 0) {
            operation.transaction?.abort();
            return;
          }
          operation.result.createObjectStore('slots', { keyPath: 'slotId' });
          operation.result.createObjectStore('snapshots', { keyPath: 'id' });
          operation.result.createObjectStore('leases', { keyPath: 'slotId' });
        };
        operation.onerror = () => reject(operation.error ?? new Error('Could not open IndexedDB'));
        operation.onsuccess = () => {
          if (rejected) operation.result.close();
          else resolve(operation.result);
        };
      });
    } catch (error) { throw normalizeError(error); }
    try {
      if (!STORES.every((store) => database.objectStoreNames.contains(store))) throw new Error('Required store is missing');
      const transaction = database.transaction(STORES, 'readonly');
      if (transaction.objectStore('slots').keyPath !== 'slotId' || transaction.objectStore('snapshots').keyPath !== 'id'
        || transaction.objectStore('leases').keyPath !== 'slotId') throw new Error('Store key path differs');
    } catch (cause) {
      database.close();
      throw new PersistenceError('STORAGE_SCHEMA_INVALID', 'Storage schema is unrecognized; data was preserved', { cause });
    }
    return new IndexedDbSaveRepository(database, options);
  }

  close(): void { this.closed = true; this.database.close(); }

  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 300_000) {
      throw new PersistenceError('INVALID_ARGUMENT', 'Platform clock returned an invalid timestamp');
    }
    return now;
  }

  private async transaction<T>(mode: IDBTransactionMode, body: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
    if (this.closed) throw new PersistenceError('STORAGE_UNAVAILABLE', 'Storage connection is closed; reopen it');
    let transaction: IDBTransaction;
    try { transaction = this.database.transaction(STORES, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
    catch (error) { throw normalizeError(error); }
    const done = completion(transaction);
    // Attach rejection handling immediately, even while an individual request is pending.
    void done.catch(() => undefined);
    try {
      // Only IndexedDB requests may be awaited in body. External async work makes IDB inactive.
      const result = await body(transaction);
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* Already aborted or completed. */ }
      await done.catch(() => undefined);
      throw normalizeError(error);
    }
  }

  async listSlots(): Promise<Array<{ slotId: CampaignSlotId; slot: SlotManifest | null }>> {
    return this.transaction('readonly', async (transaction) => {
      const store = transaction.objectStore('slots');
      const values = await Promise.all(CAMPAIGN_SLOT_IDS.map((slotId) => request<unknown>(store.get(slotId))));
      return CAMPAIGN_SLOT_IDS.map((slotId, index) => ({ slotId, slot: readManifest(values[index], slotId) }));
    });
  }

  /** Live owners cannot be displaced without takeover:true. Expiry increments the epoch. */
  async acquireLease(slotId: CampaignSlotId, ownerId: string, options: { takeover?: boolean; durationMs?: number } = {}): Promise<WriterLease> {
    assertSlot(slotId); assertOwner(ownerId);
    const duration = options.durationMs ?? DEFAULT_LEASE_DURATION_MS;
    assertDuration(duration);
    return this.transaction('readwrite', (transaction) => this.acquireInTransaction(transaction, slotId, ownerId, duration, options.takeover ?? false));
  }

  private async acquireInTransaction(transaction: IDBTransaction, slotId: CampaignSlotId, ownerId: string, duration: number, takeover: boolean): Promise<WriterLease> {
    const store = transaction.objectStore('leases');
    const prior = readLease(await request<unknown>(store.get(slotId)), slotId);
    const now = this.timestamp();
    if (prior?.ownerId && prior.expiresAt > now && prior.ownerId !== ownerId && !takeover) {
      throw new PersistenceError('LEASE_BUSY', 'Another tab owns this slot; remain read-only or request explicit takeover');
    }
    const isRenewal = prior?.ownerId === ownerId && prior.expiresAt > now && !takeover;
    const epoch = isRenewal ? prior.epoch : (prior?.epoch ?? 0) + 1;
    if (!isPositiveInteger(epoch)) throw new PersistenceError('STORAGE_SCHEMA_INVALID', 'Writer epoch is exhausted');
    const lease = { slotId, ownerId, epoch, expiresAt: now + duration };
    await request(store.put({ recordVersion: 1, ...lease } satisfies LeaseRecord));
    return lease;
  }

  private async requireLease(transaction: IDBTransaction, slotId: CampaignSlotId, token: WriterLease): Promise<LeaseRecord> {
    if (!token || token.slotId !== slotId) throw new PersistenceError('LEASE_LOST', 'A matching writer lease is required');
    const lease = readLease(await request<unknown>(transaction.objectStore('leases').get(slotId)), slotId);
    if (!lease || lease.ownerId !== token.ownerId || lease.epoch !== token.epoch || lease.expiresAt <= this.timestamp()) {
      throw new PersistenceError('LEASE_LOST', 'Writer lease expired or another tab took ownership');
    }
    return lease;
  }

  async renewLease(token: WriterLease, durationMs = DEFAULT_LEASE_DURATION_MS): Promise<WriterLease> {
    assertSlot(token.slotId); assertDuration(durationMs);
    return this.transaction('readwrite', async (transaction) => {
      await this.requireLease(transaction, token.slotId, token);
      const lease = { ...token, expiresAt: this.timestamp() + durationMs };
      await request(transaction.objectStore('leases').put({ recordVersion: 1, ...lease } satisfies LeaseRecord));
      return lease;
    });
  }

  /** A tombstone preserves the epoch so stale tokens cannot become valid again. */
  async releaseLease(token: WriterLease): Promise<void> {
    assertSlot(token.slotId);
    await this.transaction('readwrite', async (transaction) => {
      const lease = await this.requireLease(transaction, token.slotId, token);
      await request(transaction.objectStore('leases').put({ ...lease, ownerId: null, expiresAt: 0 } satisfies LeaseRecord));
    });
  }

  async saveWorld(slotId: CampaignSlotId, world: VersionedWorldState, metadata: SaveMetadata, options: WriteOptions): Promise<SaveCommit> {
    let text: string;
    try { text = serializeVersionedSave(createVersionedSaveEnvelope(world, metadata)); }
    catch (cause) { throw new PersistenceError('INVALID_SAVE', 'Cannot snapshot an invalid world or metadata', { cause }); }
    return this.saveText(slotId, text, options);
  }

  private async saveText(slotId: CampaignSlotId, text: string, options: WriteOptions): Promise<SaveCommit> {
    assertSlot(slotId); assertRevision(options.expectedRevision);
    const kind = options.kind ?? 'auto';
    if (!isKind(kind)) throw new PersistenceError('INVALID_ARGUMENT', 'Unknown snapshot kind');
    const parsed = parseSaveFile(text);
    if (!parsed.ok) throw new PersistenceError('INVALID_SAVE', 'Snapshot failed validation', { saveErrorCode: parsed.error.code });
    return this.transaction('readwrite', async (transaction) => {
      await this.requireLease(transaction, slotId, options.lease);
      const prior = readManifest(await request<unknown>(transaction.objectStore('slots').get(slotId)), slotId);
      this.requireRevision(prior, options.expectedRevision);
      return this.writeInTransaction(transaction, slotId, prior, text, parsed.envelope.savedAt, kind, options.lease, false);
    });
  }

  private requireRevision(prior: SlotManifest | null, expectedRevision: number): void {
    if ((prior?.revision ?? 0) !== expectedRevision) throw new PersistenceError('REVISION_CONFLICT', 'Slot changed since it was read; reload before writing');
  }

  /** Import defaults to an empty slot. Explicit overwrite is also revision/lease fenced. */
  async importSave(text: string, options: ImportOptions): Promise<ImportedSave> {
    const parsed = parseSaveFile(text);
    if (!parsed.ok) throw new PersistenceError('INVALID_SAVE', 'Import failed validation; all slots were preserved', { saveErrorCode: parsed.error.code });
    if (options.mode === 'overwrite') {
      assertSlot(options.slotId); assertRevision(options.expectedRevision);
      return this.transaction('readwrite', async (transaction) => {
        await this.requireLease(transaction, options.slotId, options.lease);
        const prior = readManifest(await request<unknown>(transaction.objectStore('slots').get(options.slotId)), options.slotId);
        if (!prior) throw new PersistenceError('SLOT_EMPTY', 'Overwrite target is empty; use new-slot import');
        this.requireRevision(prior, options.expectedRevision);
        const commit = await this.writeInTransaction(transaction, options.slotId, prior, text, parsed.envelope.savedAt, 'manual', options.lease, true);
        return { ...commit, lease: options.lease };
      });
    }
    assertOwner(options.ownerId);
    if (options.slotId !== undefined) assertSlot(options.slotId);
    const duration = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    assertDuration(duration);
    return this.transaction('readwrite', async (transaction) => {
      const store = transaction.objectStore('slots');
      const candidates = options.slotId ? [options.slotId] : CAMPAIGN_SLOT_IDS;
      let selected: CampaignSlotId | undefined;
      for (const slotId of candidates) {
        const prior = readManifest(await request<unknown>(store.get(slotId)), slotId);
        if (!prior) { selected = slotId; break; }
      }
      if (!selected) throw new PersistenceError(options.slotId ? 'SLOT_OCCUPIED' : 'NO_EMPTY_SLOT', 'Import needs an empty slot or explicit overwrite');
      const lease = await this.acquireInTransaction(transaction, selected, options.ownerId, duration, false);
      const commit = await this.writeInTransaction(transaction, selected, null, text, parsed.envelope.savedAt, 'manual', lease, false);
      return { ...commit, lease };
    });
  }

  private async writeInTransaction(transaction: IDBTransaction, slotId: CampaignSlotId, prior: SlotManifest | null,
    text: string, savedAt: string, kind: SnapshotKind, lease: WriterLease, overwrite: boolean): Promise<SaveCommit> {
    const snapshots = transaction.objectStore('snapshots');
    if (prior) {
      // Older builds must never rotate away records written by an unsupported newer build.
      for (const id of snapshotIds(prior)) {
        const value: unknown = await request(snapshots.get(id));
        if (isRecord(value) && value.recordVersion !== 1) {
          throw new PersistenceError('NEWER_SAVE_PROTECTED', 'Unrecognized snapshot record version was preserved');
        }
        const record = readSnapshot(value, prior, id);
        const result = record ? parseVersionedSave(record.text) : null;
        if (result && !result.ok && UNSUPPORTED_VERSIONS.has(result.error.code)) {
          throw new PersistenceError('NEWER_SAVE_PROTECTED', 'Unsupported stored save was preserved; export it before using another build', { saveErrorCode: result.error.code });
        }
        if (!overwrite && id === prior.currentSnapshotId && (!result || !result.ok)) {
          throw new PersistenceError('CURRENT_SNAPSHOT_INVALID', 'Current snapshot is corrupt; export a recovered generation into an empty slot');
        }
      }
    }
    const revision = (prior?.revision ?? 0) + 1;
    if (!isPositiveInteger(revision)) throw new PersistenceError('STORAGE_SCHEMA_INVALID', 'Slot revision is exhausted');
    const id = `${slotId}:${revision}`;
    const snapshot: SnapshotRecord = { recordVersion: 1, id, slotId, revision, kind, text };
    this.faultInjector?.('before-snapshot', transaction);
    // add, not put: even an orphan with the next ID must not be silently overwritten.
    await request(snapshots.add(snapshot));
    this.faultInjector?.('after-snapshot', transaction);
    const stored: unknown = await request(snapshots.get(id));
    if (!isRecord(stored) || stored.recordVersion !== 1 || stored.id !== id || stored.slotId !== slotId
      || stored.revision !== revision || stored.kind !== kind || stored.text !== text || !parseSaveFile(stored.text).ok) {
      throw new PersistenceError('INVALID_SAVE', 'Stored snapshot read-back failed validation');
    }
    const base = overwrite ? null : prior;
    const slot: SlotManifest = {
      recordVersion: 1, slotId, revision, currentSnapshotId: id, savedAt,
      autoSnapshotIds: kind === 'auto' ? [id, ...(base?.autoSnapshotIds ?? [])].slice(0, AUTO_GENERATIONS) : [...(base?.autoSnapshotIds ?? [])],
      manualSnapshotId: kind === 'manual' ? id : base?.manualSnapshotId ?? null,
      checkpointSnapshotId: kind === 'checkpoint' ? id : base?.checkpointSnapshotId ?? null,
    };
    await this.requireLease(transaction, slotId, lease);
    this.faultInjector?.('before-pointer', transaction);
    await request(transaction.objectStore('slots').put(slot));
    this.faultInjector?.('after-pointer', transaction);
    const retained = new Set(snapshotIds(slot));
    for (const priorId of prior ? snapshotIds(prior) : []) {
      if (!retained.has(priorId)) await request(snapshots.delete(priorId));
    }
    this.faultInjector?.('after-prune', transaction);
    return { slot, snapshot };
  }

  /** Migration is in-memory only. A later explicit save creates a new-generation current envelope. */
  async loadSlot(slotId: CampaignSlotId): Promise<LoadedSave> {
    assertSlot(slotId);
    return this.transaction('readonly', async (transaction) => {
      const slot = readManifest(await request<unknown>(transaction.objectStore('slots').get(slotId)), slotId);
      if (!slot) throw new PersistenceError('SLOT_EMPTY', 'Campaign slot is empty');
      const fallbackIds = snapshotIds(slot).filter((id) => id !== slot.currentSnapshotId).sort((a, b) => snapshotRevision(b) - snapshotRevision(a));
      const issues: SnapshotIssue[] = [];
      for (const id of [slot.currentSnapshotId, ...fallbackIds]) {
        const value: unknown = await request(transaction.objectStore('snapshots').get(id));
        const snapshot = readSnapshot(value, slot, id);
        if (!snapshot) { issues.push({ snapshotId: id, code: value === undefined ? 'MISSING_SNAPSHOT' : 'INVALID_SNAPSHOT_RECORD' }); continue; }
        const parsed = parseSaveFile(snapshot.text);
        if (!parsed.ok) { issues.push({ snapshotId: id, code: parsed.error.code }); continue; }
        const { ok: _ok, ...data } = parsed;
        return { slot, snapshot, ...data, recovered: id !== slot.currentSnapshotId, issues };
      }
      throw new PersistenceError('NO_VALID_SNAPSHOT', 'No retained snapshot passed validation; raw data was preserved', { issues });
    });
  }

  /** Exports original validated text, including a legacy source that was migrated only in memory. */
  async exportSlot(slotId: CampaignSlotId): Promise<SaveFile & { recovered: boolean; snapshotId: string }> {
    const loaded = await this.loadSlot(slotId);
    return { ...describeSaveFile(loaded.snapshot.text, loaded.envelope), recovered: loaded.recovered, snapshotId: loaded.snapshot.id };
  }

  /** Exact-text rescue for a corrupt/unsupported record. Do not treat it as a valid world. */
  async exportRawSnapshot(slotId: CampaignSlotId, snapshotId: string): Promise<string> {
    assertSlot(slotId);
    if (!validSnapshotId(snapshotId, slotId)) throw new PersistenceError('INVALID_ARGUMENT', 'Snapshot does not belong to this slot');
    return this.transaction('readonly', async (transaction) => {
      const value: unknown = await request(transaction.objectStore('snapshots').get(snapshotId));
      if (!isRecord(value) || value.slotId !== slotId || value.id !== snapshotId || typeof value.text !== 'string') {
        throw new PersistenceError('SNAPSHOT_MISSING', 'No raw snapshot text is available');
      }
      return value.text;
    });
  }
}

export const openSaveRepository = (options: RepositoryOptions = {}): Promise<IndexedDbSaveRepository> => IndexedDbSaveRepository.open(options);
