import { isManagementV10Identity, MANAGEMENT_V10_CONTENT_VERSION } from '../../content/sect-v10/world-content';
import type { SaveMetadata } from '../../core/kernel/save';
import { parseSaveV9 } from '../../core/kernel/save-v9';
import { createSaveEnvelopeV10, parseSaveV10, SaveCodecErrorV10, serializeSaveV10 } from '../../core/kernel/save-v10';
import { canonicalStringify } from '../../core/kernel/serialization';
import { SAVE_FILE_LIMIT_BYTES, utf8ByteLength } from '../../core/save-budget';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../../core/sect-expansion/upgrade-types';
import { prepareV9ToV10Migration } from '../../core/world/migrate-v9-to-v10';
import { AUTO_GENERATIONS, CAMPAIGN_SLOT_IDS, DEFAULT_LEASE_DURATION_MS } from './types';
import {
  MANAGEMENT_V10_DATABASE_NAME, MANAGEMENT_V10_DATABASE_VERSION, MANAGEMENT_V10_STORES,
  ManagementV10PersistenceError as StorageError,
  type CampaignSlotId, type CommitV9CopyOptions, type ImportOptions, type ImportedManagementSaveV10,
  type LeaseRecord, type LoadedManagementSaveV10, type ManagementV10RepositoryOptions,
  type MigrationSourceRecordV10, type SaveCommit, type SlotManifest, type SnapshotIssueV10,
  type SnapshotKind, type SnapshotRecord, type V9CopyCommitReceipt, type WriterLease, type WriteOptions,
} from './management-v10-types';

const STORES = [...MANAGEMENT_V10_STORES];
const UNSUPPORTED = new Set(['UNSUPPORTED_SAVE_VERSION', 'UNSUPPORTED_SIMULATION_VERSION', 'UNSUPPORTED_CONTENT_VERSION', 'UNSUPPORTED_SCOPE']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const exactKeys = (value: Record<string, unknown>, keys: string): boolean => Object.keys(value).sort().join(',') === keys;
const isKind = (value: unknown): value is SnapshotKind => value === 'auto' || value === 'manual' || value === 'checkpoint';
function assertSlot(value: unknown): asserts value is CampaignSlotId {
  if (!CAMPAIGN_SLOT_IDS.includes(value as CampaignSlotId)) throw new StorageError('INVALID_ARGUMENT', 'Unknown management slot');
}
function assertOwner(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new StorageError('INVALID_ARGUMENT', 'A distinct writer identity is required');
}
function assertRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || value === Number.MAX_SAFE_INTEGER) throw new StorageError('INVALID_ARGUMENT', 'Expected revision must be a nonnegative safe integer');
}
function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new StorageError('INVALID_ARGUMENT', 'Invalid lease duration');
}
function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StorageError('TRANSACTION_FAILED', 'Storage operation was cancelled before commit');
}
function revisionOf(id: string): number { return Number(id.slice(id.lastIndexOf(':') + 1)); }
function validId(id: unknown, slotId: CampaignSlotId): id is string {
  return typeof id === 'string' && id.startsWith(`${slotId}:`) && /^[1-9]\d*$/.test(id.slice(slotId.length + 1)) && positive(revisionOf(id));
}
function snapshotIds(slot: SlotManifest): string[] {
  return [...slot.autoSnapshotIds, slot.manualSnapshotId, slot.checkpointSnapshotId].filter((id): id is string => id !== null);
}
function manifest(value: unknown, slotId: CampaignSlotId): SlotManifest | null {
  if (value === undefined) return null;
  if (!record(value) || !exactKeys(value, 'autoSnapshotIds,checkpointSnapshotId,currentSnapshotId,manualSnapshotId,recordVersion,revision,savedAt,slotId')
    || value.recordVersion !== 1 || value.slotId !== slotId || !positive(value.revision)
    || !validId(value.currentSnapshotId, slotId) || revisionOf(value.currentSnapshotId) !== value.revision
    || !Array.isArray(value.autoSnapshotIds) || value.autoSnapshotIds.length > AUTO_GENERATIONS
    || !value.autoSnapshotIds.every(id => validId(id, slotId))
    || !(value.manualSnapshotId === null || validId(value.manualSnapshotId, slotId))
    || !(value.checkpointSnapshotId === null || validId(value.checkpointSnapshotId, slotId))
    || typeof value.savedAt !== 'string' || !value.savedAt || value.savedAt.length > 64) {
    throw new StorageError('STORAGE_SCHEMA_INVALID', 'Stored slot metadata is unrecognized; data was preserved');
  }
  const slot = value as unknown as SlotManifest;
  const ids = snapshotIds(slot);
  if (!ids.includes(slot.currentSnapshotId) || new Set(ids).size !== ids.length || ids.some(id => revisionOf(id) > slot.revision)
    || slot.autoSnapshotIds.some((id, index, all) => index > 0 && revisionOf(all[index - 1]!) <= revisionOf(id))) {
    throw new StorageError('STORAGE_SCHEMA_INVALID', 'Stored slot pointers are invalid; data was preserved');
  }
  return slot;
}
function leaseRecord(value: unknown, slotId: CampaignSlotId): LeaseRecord | null {
  if (value === undefined) return null;
  if (!record(value) || !exactKeys(value, 'epoch,expiresAt,ownerId,recordVersion,slotId') || value.recordVersion !== 1
    || value.slotId !== slotId || !positive(value.epoch)
    || !(value.ownerId === null || typeof value.ownerId === 'string' && value.ownerId.trim().length > 0 && value.ownerId.length <= 128)
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 0) {
    throw new StorageError('STORAGE_SCHEMA_INVALID', 'Stored writer lease is unrecognized; data was preserved');
  }
  return value as unknown as LeaseRecord;
}
function snapshotRecord(value: unknown, slotId: CampaignSlotId, id: string, kind: SnapshotKind): SnapshotRecord | null {
  if (!record(value) || !exactKeys(value, 'id,kind,recordVersion,revision,slotId,text') || value.recordVersion !== 1
    || value.id !== id || value.slotId !== slotId || value.revision !== revisionOf(id) || value.kind !== kind || typeof value.text !== 'string') return null;
  return value as unknown as SnapshotRecord;
}
function backupId(slotId: CampaignSlotId): string { return `v9-source:${slotId}:1`; }
function sourceRecord(value: unknown, slotId: CampaignSlotId): MigrationSourceRecordV10 | null {
  if (value === undefined) return null;
  if (!record(value) || !exactKeys(value, 'id,recordVersion,sourceText,targetSlotId') || value.recordVersion !== 1
    || value.id !== backupId(slotId) || value.targetSlotId !== slotId || typeof value.sourceText !== 'string') {
    throw new StorageError('STORAGE_SCHEMA_INVALID', 'Stored migration source is unrecognized; data was preserved');
  }
  return value as unknown as MigrationSourceRecordV10;
}
function normalize(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return new StorageError('QUOTA_EXCEEDED', 'Storage quota exceeded; previous data was preserved', { cause: error });
  if (name === 'VersionError') return new StorageError('DATABASE_VERSION_UNSUPPORTED', 'A newer storage schema exists; data was preserved', { cause: error });
  if (name === 'SecurityError' || name === 'NotAllowedError') return new StorageError('STORAGE_UNAVAILABLE', 'Browser storage is unavailable', { cause: error });
  return new StorageError('TRANSACTION_FAILED', 'Storage transaction failed; no save was committed', { cause: error });
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    // The default error action must abort the transaction.
    operation.onerror = () => reject(operation.error ?? new Error('IndexedDB request failed'));
  });
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}
function parseTarget(text: string) {
  const parsed = parseSaveV10(text);
  if (!parsed.ok) throw new StorageError('INVALID_SAVE', 'V10 snapshot failed full admission', { saveErrorCode: parsed.error.code });
  return parsed;
}
function requireSource(text: string): void {
  const parsed = parseSaveV9(text);
  if (!parsed.ok) throw new StorageError('MIGRATION_SOURCE_INVALID', 'V9 source failed full admission', { saveErrorCode: parsed.error.code });
}
/** Preservation probe only, never validation or admission. Codec error ordering
 * can report a malformed envelope before it reaches a future authority marker.
 * Inspect bounded raw JSON independently before any retention/overwrite delete.
 * Refuse over-budget text rather than guessing that it is safe to discard. */
function protectStoredIdentity(text: string): void {
  if (text.length > SAVE_FILE_LIMIT_BYTES || utf8ByteLength(text) > SAVE_FILE_LIMIT_BYTES) {
    throw new StorageError('NEWER_SAVE_PROTECTED', 'Stored text exceeds bounded identity inspection; raw data was preserved', { saveErrorCode: 'TOO_LARGE' });
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return; }
  if (!record(value)) return;
  if (Object.hasOwn(value, 'saveVersion') && value.saveVersion !== MANAGEMENT_V10_PROTOCOL.saveVersion) {
    throw new StorageError('NEWER_SAVE_PROTECTED', 'Unsupported stored save identity was preserved', { saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
  }
  const payload = record(value.payload) ? value.payload : null;
  if (Object.hasOwn(value, 'simulationVersion') && value.simulationVersion !== MANAGEMENT_V10_PROTOCOL.simulationVersion
    || payload && Object.hasOwn(payload, 'simulationVersion') && payload.simulationVersion !== MANAGEMENT_V10_PROTOCOL.simulationVersion) {
    throw new StorageError('NEWER_SAVE_PROTECTED', 'Unsupported stored simulation identity was preserved', { saveErrorCode: 'UNSUPPORTED_SIMULATION_VERSION' });
  }
  if (Object.hasOwn(value, 'contentVersion') && value.contentVersion !== MANAGEMENT_V10_CONTENT_VERSION
    || payload && Object.hasOwn(payload, 'contentVersion') && payload.contentVersion !== MANAGEMENT_V10_CONTENT_VERSION
    || payload && Object.hasOwn(payload, 'contentIdentity') && !isManagementV10Identity(payload.contentIdentity)) {
    throw new StorageError('NEWER_SAVE_PROTECTED', 'Unsupported stored content identity was preserved', { saveErrorCode: 'UNSUPPORTED_CONTENT_VERSION' });
  }
  if (payload && Object.hasOwn(payload, 'runtimeProtocol') && payload.runtimeProtocol !== MANAGEMENT_V10_PROTOCOL.runtimeProtocol) {
    throw new StorageError('NEWER_SAVE_PROTECTED', 'Unsupported stored runtime identity was preserved', { saveErrorCode: 'UNSUPPORTED_SCOPE' });
  }
}

/** Private v10-only storage. This module never opens the v9 database, advances a
 * World, registers a route, or binds a live Session. Leases are storage fences,
 * not authentication. A coordinator prepares its replacement before writing. */
export class IndexedDbManagementV10Repository {
  private readonly now: () => number;
  private readonly faultInjector: ManagementV10RepositoryOptions['faultInjector'];
  private closed = false;

  private constructor(private readonly database: IDBDatabase, options: ManagementV10RepositoryOptions) {
    this.now = options.now ?? Date.now;
    this.faultInjector = options.faultInjector;
    database.onversionchange = () => this.close();
  }
  static async open(options: ManagementV10RepositoryOptions = {}): Promise<IndexedDbManagementV10Repository> {
    // Reject policy-shaped overrides even from untyped callers; no validator or
    // database name can redirect this adapter into a source database.
    if (Object.keys(options).some(key => !['indexedDB', 'now', 'faultInjector'].includes(key))) {
      throw new StorageError('INVALID_ARGUMENT', 'Only storage, clock and fault-injection test seams are supported');
    }
    let factory: IDBFactory | undefined;
    try { factory = options.indexedDB ?? globalThis.indexedDB; } catch (error) { throw normalize(error); }
    if (!factory) throw new StorageError('STORAGE_UNAVAILABLE', 'IndexedDB is unavailable');
    let database: IDBDatabase;
    try {
      database = await new Promise<IDBDatabase>((resolve, reject) => {
        const operation = factory.open(MANAGEMENT_V10_DATABASE_NAME, MANAGEMENT_V10_DATABASE_VERSION);
        let rejected = false;
        operation.onblocked = () => { rejected = true; reject(new StorageError('STORAGE_BLOCKED', 'Another connection blocks storage open')); };
        operation.onupgradeneeded = event => {
          if (rejected || event.oldVersion !== 0) { operation.transaction?.abort(); return; }
          operation.result.createObjectStore('slots', { keyPath: 'slotId' });
          operation.result.createObjectStore('snapshots', { keyPath: 'id' });
          operation.result.createObjectStore('leases', { keyPath: 'slotId' });
          operation.result.createObjectStore('migrationSources', { keyPath: 'id' });
        };
        operation.onerror = () => reject(operation.error ?? new Error('Could not open IndexedDB'));
        operation.onsuccess = () => { if (rejected) operation.result.close(); else resolve(operation.result); };
      });
    } catch (error) { throw normalize(error); }
    try {
      if (database.objectStoreNames.length !== STORES.length || !STORES.every(name => database.objectStoreNames.contains(name))) throw new Error('Unknown store layout');
      const transaction = database.transaction(STORES, 'readonly');
      for (const name of STORES) {
        const store = transaction.objectStore(name);
        if (store.keyPath !== (name === 'slots' || name === 'leases' ? 'slotId' : 'id') || store.autoIncrement || store.indexNames.length) throw new Error('Unknown store shape');
      }
    } catch (cause) {
      database.close(); throw new StorageError('STORAGE_SCHEMA_INVALID', 'Storage schema is unrecognized; data was preserved', { cause });
    }
    return new IndexedDbManagementV10Repository(database, options);
  }
  close(): void { this.closed = true; this.database.close(); }
  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 300_000) throw new StorageError('INVALID_ARGUMENT', 'Invalid platform lease clock');
    return now;
  }
  private async transaction<T>(mode: IDBTransactionMode, body: (transaction: IDBTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertNotAborted(signal);
    if (this.closed) throw new StorageError('STORAGE_UNAVAILABLE', 'Storage connection is closed');
    let transaction: IDBTransaction;
    try { transaction = this.database.transaction(STORES, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
    catch (error) { throw normalize(error); }
    const done = completion(transaction);
    void done.catch(() => undefined);
    const abort = () => { try { transaction.abort(); } catch { /* Completion is irreversible. */ } };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      // Await only IDB requests in body; all pure/cold preparation precedes it.
      const result = await body(transaction);
      await done;
      return result;
    } catch (error) {
      abort(); await done.catch(() => undefined); throw normalize(error);
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async listSlots(): Promise<Array<{ slotId: CampaignSlotId; slot: SlotManifest | null }>> {
    return this.transaction('readonly', async transaction => {
      const values = await Promise.all(CAMPAIGN_SLOT_IDS.map(id => request<unknown>(transaction.objectStore('slots').get(id))));
      return CAMPAIGN_SLOT_IDS.map((slotId, index) => ({ slotId, slot: manifest(values[index], slotId) }));
    });
  }
  /** No live-owner takeover operation is exposed by this private foundation. */
  async acquireLease(slotId: CampaignSlotId, ownerId: string, options: { durationMs?: number } = {}): Promise<WriterLease> {
    assertSlot(slotId); assertOwner(ownerId);
    if (Object.keys(options).some(key => key !== 'durationMs')) throw new StorageError('INVALID_ARGUMENT', 'Lease takeover is not supported');
    const duration = options.durationMs ?? DEFAULT_LEASE_DURATION_MS; assertDuration(duration);
    return this.transaction('readwrite', transaction => this.acquireInTransaction(transaction, slotId, ownerId, duration));
  }
  private async acquireInTransaction(transaction: IDBTransaction, slotId: CampaignSlotId, ownerId: string, duration: number): Promise<WriterLease> {
    const store = transaction.objectStore('leases');
    const prior = leaseRecord(await request<unknown>(store.get(slotId)), slotId);
    const now = this.timestamp();
    if (prior?.ownerId && prior.expiresAt > now && prior.ownerId !== ownerId) throw new StorageError('LEASE_BUSY', 'Another writer owns this slot');
    const epoch = prior?.ownerId === ownerId && prior.expiresAt > now ? prior.epoch : (prior?.epoch ?? 0) + 1;
    if (!positive(epoch)) throw new StorageError('STORAGE_SCHEMA_INVALID', 'Writer epoch is exhausted');
    const lease: WriterLease = { slotId, ownerId, epoch, expiresAt: now + duration };
    await request(store.put({ recordVersion: 1, ...lease } satisfies LeaseRecord));
    return lease;
  }
  private async requireLease(transaction: IDBTransaction, slotId: CampaignSlotId, token: WriterLease): Promise<LeaseRecord> {
    if (!token || token.slotId !== slotId || typeof token.ownerId !== 'string' || !token.ownerId.trim() || !positive(token.epoch)) throw new StorageError('LEASE_LOST', 'Matching writer lease required');
    const lease = leaseRecord(await request<unknown>(transaction.objectStore('leases').get(slotId)), slotId);
    if (!lease || lease.ownerId !== token.ownerId || lease.epoch !== token.epoch || lease.expiresAt <= this.timestamp()) throw new StorageError('LEASE_LOST', 'Writer lease expired or changed');
    return lease;
  }
  async renewLease(token: WriterLease, durationMs = DEFAULT_LEASE_DURATION_MS): Promise<WriterLease> {
    assertSlot(token.slotId); assertDuration(durationMs);
    return this.transaction('readwrite', async transaction => {
      await this.requireLease(transaction, token.slotId, token);
      const lease: WriterLease = { slotId: token.slotId, ownerId: token.ownerId, epoch: token.epoch, expiresAt: this.timestamp() + durationMs };
      await request(transaction.objectStore('leases').put({ recordVersion: 1, ...lease } satisfies LeaseRecord)); return lease;
    });
  }
  async releaseLease(token: WriterLease): Promise<void> {
    assertSlot(token.slotId);
    await this.transaction('readwrite', async transaction => {
      const lease = await this.requireLease(transaction, token.slotId, token);
      await request(transaction.objectStore('leases').put({ ...lease, ownerId: null, expiresAt: 0 } satisfies LeaseRecord));
    });
  }
  async saveWorld(slotId: CampaignSlotId, world: WorldStateV10, metadata: SaveMetadata, options: WriteOptions): Promise<SaveCommit> {
    let text: string;
    try { text = serializeSaveV10(createSaveEnvelopeV10(world, metadata)); }
    catch (cause) { throw new StorageError('INVALID_SAVE', 'Cannot snapshot invalid v10 world or metadata', { cause, ...(cause instanceof SaveCodecErrorV10 ? { saveErrorCode: cause.code } : {}) }); }
    return this.saveText(slotId, text, options);
  }
  async saveText(slotId: CampaignSlotId, text: string, options: WriteOptions): Promise<SaveCommit> {
    assertSlot(slotId); assertRevision(options.expectedRevision); assertNotAborted(options.signal);
    const kind = options.kind ?? 'auto';
    if (!isKind(kind)) throw new StorageError('INVALID_ARGUMENT', 'Unknown snapshot kind');
    const parsed = parseTarget(text);
    return this.transaction('readwrite', async transaction => {
      await this.requireLease(transaction, slotId, options.lease);
      const prior = manifest(await request<unknown>(transaction.objectStore('slots').get(slotId)), slotId);
      this.requireRevision(prior, options.expectedRevision);
      return this.writeInTransaction(transaction, slotId, prior, text, parsed.envelope.savedAt, kind, options.lease, false, options.signal);
    }, options.signal);
  }
  private requireRevision(prior: SlotManifest | null, expected: number): void {
    if ((prior?.revision ?? 0) !== expected) throw new StorageError('REVISION_CONFLICT', 'Slot changed since it was read');
  }
  async importSave(text: string, options: ImportOptions): Promise<ImportedManagementSaveV10> {
    assertNotAborted(options.signal);
    const parsed = parseTarget(text);
    if (options.mode === 'overwrite') {
      assertSlot(options.slotId); assertRevision(options.expectedRevision);
      return this.transaction('readwrite', async transaction => {
        await this.requireLease(transaction, options.slotId, options.lease);
        const prior = manifest(await request<unknown>(transaction.objectStore('slots').get(options.slotId)), options.slotId);
        if (!prior) throw new StorageError('SLOT_EMPTY', 'Overwrite target is empty');
        this.requireRevision(prior, options.expectedRevision);
        const commit = await this.writeInTransaction(transaction, options.slotId, prior, text, parsed.envelope.savedAt, 'manual', options.lease, true, options.signal);
        return { ...commit, lease: options.lease };
      }, options.signal);
    }
    if (options.mode !== undefined && options.mode !== 'new-slot') throw new StorageError('INVALID_ARGUMENT', 'Unknown import mode');
    assertOwner(options.ownerId); if (options.slotId !== undefined) assertSlot(options.slotId);
    const duration = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS; assertDuration(duration);
    return this.transaction('readwrite', async transaction => {
      let selected: CampaignSlotId | undefined;
      for (const slotId of options.slotId ? [options.slotId] : CAMPAIGN_SLOT_IDS) {
        if (!manifest(await request<unknown>(transaction.objectStore('slots').get(slotId)), slotId)) { selected = slotId; break; }
      }
      if (!selected) throw new StorageError(options.slotId ? 'SLOT_OCCUPIED' : 'NO_EMPTY_SLOT', 'An empty target slot is required');
      const lease = await this.acquireInTransaction(transaction, selected, options.ownerId, duration);
      const commit = await this.writeInTransaction(transaction, selected, null, text, parsed.envelope.savedAt, 'manual', lease, false, options.signal);
      return { ...commit, lease };
    }, options.signal);
  }
  private async writeInTransaction(transaction: IDBTransaction, slotId: CampaignSlotId, prior: SlotManifest | null, text: string,
    savedAt: string, kind: SnapshotKind, lease: WriterLease, overwrite: boolean, signal?: AbortSignal): Promise<SaveCommit> {
    const snapshots = transaction.objectStore('snapshots');
    if (prior) {
      for (const id of snapshotIds(prior)) {
        const value: unknown = await request(snapshots.get(id));
        if (record(value) && (value.recordVersion !== 1 || !exactKeys(value, 'id,kind,recordVersion,revision,slotId,text'))) throw new StorageError('NEWER_SAVE_PROTECTED', 'Unrecognized snapshot record was preserved');
        if (record(value) && typeof value.text === 'string') protectStoredIdentity(value.text);
        const kind = prior.autoSnapshotIds.includes(id) ? 'auto' : prior.manualSnapshotId === id ? 'manual' : 'checkpoint';
        const saved = snapshotRecord(value, slotId, id, kind);
        const parsed = record(value) && typeof value.text === 'string' ? parseSaveV10(value.text) : null;
        if (parsed && !parsed.ok && UNSUPPORTED.has(parsed.error.code)) throw new StorageError('NEWER_SAVE_PROTECTED', 'Unsupported retained save was preserved', { saveErrorCode: parsed.error.code });
        if (!overwrite && id === prior.currentSnapshotId && (!saved || !parsed?.ok)) throw new StorageError('CURRENT_SNAPSHOT_INVALID', 'Current snapshot is corrupt; recover into an empty slot');
      }
    }
    const revision = (prior?.revision ?? 0) + 1;
    if (!positive(revision)) throw new StorageError('STORAGE_SCHEMA_INVALID', 'Slot revision is exhausted');
    const snapshot: SnapshotRecord = { recordVersion: 1, id: `${slotId}:${revision}`, slotId, revision, kind, text };
    this.faultInjector?.('before-snapshot', transaction);
    await request(snapshots.add(snapshot)); // Never overwrite an orphan generation.
    this.faultInjector?.('after-snapshot', transaction);
    await this.readBackSnapshot(transaction, snapshot);
    this.faultInjector?.('after-snapshot-readback', transaction);
    const base = overwrite ? null : prior;
    const slot: SlotManifest = { recordVersion: 1, slotId, revision, currentSnapshotId: snapshot.id, savedAt,
      autoSnapshotIds: kind === 'auto' ? [snapshot.id, ...(base?.autoSnapshotIds ?? [])].slice(0, AUTO_GENERATIONS) : [...(base?.autoSnapshotIds ?? [])],
      manualSnapshotId: kind === 'manual' ? snapshot.id : base?.manualSnapshotId ?? null,
      checkpointSnapshotId: kind === 'checkpoint' ? snapshot.id : base?.checkpointSnapshotId ?? null };
    this.faultInjector?.('before-pointer', transaction);
    await this.readBackSnapshot(transaction, snapshot);
    const current = manifest(await request<unknown>(transaction.objectStore('slots').get(slotId)), slotId);
    this.requireRevision(current, prior?.revision ?? 0);
    await this.requireLease(transaction, slotId, lease);
    assertNotAborted(signal);
    await request(transaction.objectStore('slots').put(slot));
    this.faultInjector?.('after-pointer', transaction);
    const retained = new Set(snapshotIds(slot));
    for (const id of prior ? snapshotIds(prior) : []) if (!retained.has(id)) await request(snapshots.delete(id));
    // migrationSources is intentionally never pruned, including explicit imports.
    this.faultInjector?.('after-prune', transaction);
    return { slot, snapshot };
  }
  private async readBackSnapshot(transaction: IDBTransaction, expected: SnapshotRecord): Promise<void> {
    const stored = snapshotRecord(await request<unknown>(transaction.objectStore('snapshots').get(expected.id)), expected.slotId, expected.id, expected.kind);
    if (!stored || stored.text !== expected.text) throw new StorageError('INVALID_SAVE', 'Stored snapshot read-back differs from the prepared text');
    parseTarget(stored.text);
  }
  private async readBackSource(transaction: IDBTransaction, expected: MigrationSourceRecordV10): Promise<void> {
    const stored = sourceRecord(await request<unknown>(transaction.objectStore('migrationSources').get(expected.id)), expected.targetSlotId);
    if (!stored || stored.sourceText !== expected.sourceText) throw new StorageError('SOURCE_BACKUP_CONFLICT', 'Source backup read-back differs from the original text');
    requireSource(stored.sourceText);
  }

  /** The caller must already hold/fence the latest writable source Session and
   * prepare its complete replacement. No source DB operation or Session switch
   * happens here. A returned receipt means the target is durably saved even if
   * the caller subsequently cannot bind its prepared Session. Never delete it
   * to pretend that a committed target transaction was rolled back. */
  async commitV9Copy(options: CommitV9CopyOptions): Promise<V9CopyCommitReceipt> {
    // Capture primitive inputs before any asynchronous step; caller mutation of
    // an options object cannot swap source, target, owner, slot, or signal later.
    const { sourceText, targetText, targetSlotId, ownerId, signal } = options;
    assertSlot(targetSlotId); assertOwner(ownerId); assertNotAborted(signal);
    requireSource(sourceText);
    const target = parseTarget(targetText);
    const prepared = prepareV9ToV10Migration(sourceText, { buildId: target.envelope.buildId, savedAt: target.envelope.savedAt });
    if (!prepared.ok) throw new StorageError('MIGRATION_NOT_READY', 'Source does not satisfy fixed migration admission', { migrationIssues: prepared.issues });
    if (canonicalStringify(target.envelope) !== canonicalStringify(prepared.envelope)) throw new StorageError('MIGRATION_TARGET_MISMATCH', 'Target is not the exact pure migration of this source');
    assertNotAborted(signal);
    const sourceBackup: MigrationSourceRecordV10 = { recordVersion: 1, id: backupId(targetSlotId), targetSlotId, sourceText };
    const snapshot: SnapshotRecord = { recordVersion: 1, id: `${targetSlotId}:1`, slotId: targetSlotId, revision: 1, kind: 'manual', text: targetText };
    const slot: SlotManifest = { recordVersion: 1, slotId: targetSlotId, revision: 1, currentSnapshotId: snapshot.id, autoSnapshotIds: [],
      manualSnapshotId: snapshot.id, checkpointSnapshotId: null, savedAt: target.envelope.savedAt };
    return this.transaction<V9CopyCommitReceipt>('readwrite', async transaction => {
      const slots = transaction.objectStore('slots');
      if (manifest(await request<unknown>(slots.get(targetSlotId)), targetSlotId)) throw new StorageError('SLOT_OCCUPIED', 'Migration requires an empty target slot');
      const lease = await this.acquireInTransaction(transaction, targetSlotId, ownerId, DEFAULT_LEASE_DURATION_MS);
      const sources = transaction.objectStore('migrationSources');
      this.faultInjector?.('before-backup', transaction);
      const existing = sourceRecord(await request<unknown>(sources.get(sourceBackup.id)), targetSlotId);
      if (existing && existing.sourceText !== sourceText) throw new StorageError('SOURCE_BACKUP_CONFLICT', 'A different exact source already owns this backup key');
      if (!existing) await request(sources.add(sourceBackup));
      this.faultInjector?.('after-backup', transaction);
      await this.readBackSource(transaction, sourceBackup);
      this.faultInjector?.('after-backup-readback', transaction);
      this.faultInjector?.('before-snapshot', transaction);
      await request(transaction.objectStore('snapshots').add(snapshot));
      this.faultInjector?.('after-snapshot', transaction);
      await this.readBackSnapshot(transaction, snapshot);
      this.faultInjector?.('after-snapshot-readback', transaction);

      // This seam runs BEFORE the final rereads, so queued tampering, stale
      // ownership, newly occupied slots and cancellation cannot skip the fence.
      this.faultInjector?.('before-pointer', transaction);
      await this.readBackSource(transaction, sourceBackup);
      await this.readBackSnapshot(transaction, snapshot);
      if (manifest(await request<unknown>(slots.get(targetSlotId)), targetSlotId)) throw new StorageError('SLOT_OCCUPIED', 'Target became occupied before pointer publication');
      await this.requireLease(transaction, targetSlotId, lease);
      assertNotAborted(signal);
      await request(slots.add(slot));
      this.faultInjector?.('after-pointer', transaction);
      return { committed: true, databaseName: MANAGEMENT_V10_DATABASE_NAME, sourceBackup, slot, snapshot, lease };
    }, signal);
  }
  async loadSlot(slotId: CampaignSlotId): Promise<LoadedManagementSaveV10> {
    assertSlot(slotId);
    return this.transaction('readonly', async transaction => {
      const slot = manifest(await request<unknown>(transaction.objectStore('slots').get(slotId)), slotId);
      if (!slot) throw new StorageError('SLOT_EMPTY', 'Management slot is empty');
      const fallbacks = snapshotIds(slot).filter(id => id !== slot.currentSnapshotId).sort((a, b) => revisionOf(b) - revisionOf(a));
      const issues: SnapshotIssueV10[] = [];
      for (const id of [slot.currentSnapshotId, ...fallbacks]) {
        const value: unknown = await request(transaction.objectStore('snapshots').get(id));
        const kind = slot.autoSnapshotIds.includes(id) ? 'auto' : slot.manualSnapshotId === id ? 'manual' : 'checkpoint';
        const snapshot = snapshotRecord(value, slotId, id, kind);
        if (!snapshot) { issues.push({ snapshotId: id, code: value === undefined ? 'MISSING_SNAPSHOT' : 'INVALID_SNAPSHOT_RECORD' }); continue; }
        const parsed = parseSaveV10(snapshot.text);
        if (!parsed.ok) { issues.push({ snapshotId: id, code: parsed.error.code }); continue; }
        return { slot, snapshot, envelope: parsed.envelope, world: parsed.world, migration: null, recovered: id !== slot.currentSnapshotId, issues };
      }
      throw new StorageError('NO_VALID_SNAPSHOT', 'No retained v10 snapshot passed validation; raw records were preserved', { issues });
    });
  }
  async exportRawSnapshot(slotId: CampaignSlotId, snapshotId: string): Promise<string> {
    assertSlot(slotId);
    if (!validId(snapshotId, slotId)) throw new StorageError('INVALID_ARGUMENT', 'Snapshot does not belong to this slot');
    return this.transaction('readonly', async transaction => {
      const value: unknown = await request(transaction.objectStore('snapshots').get(snapshotId));
      if (!record(value) || value.id !== snapshotId || value.slotId !== slotId || typeof value.text !== 'string') throw new StorageError('SNAPSHOT_MISSING', 'No raw snapshot text is available');
      return value.text;
    });
  }
  /** Exact source rescue remains usable even if its v9 codec later rejects it. */
  async exportMigrationSource(targetSlotId: CampaignSlotId): Promise<string> {
    assertSlot(targetSlotId);
    return this.transaction('readonly', async transaction => {
      const stored = sourceRecord(await request<unknown>(transaction.objectStore('migrationSources').get(backupId(targetSlotId))), targetSlotId);
      if (!stored) throw new StorageError('SNAPSHOT_MISSING', 'No migration source backup is available');
      return stored.sourceText;
    });
  }
}

export const openManagementV10Repository = (options: ManagementV10RepositoryOptions = {}): Promise<IndexedDbManagementV10Repository> => IndexedDbManagementV10Repository.open(options);
