import type { SaveEnvelope, SaveErrorCode } from '../../core/kernel/save';
import type { WorldState } from '../../core/world/types';

export const CAMPAIGN_SLOT_IDS = ['campaign-1', 'campaign-2', 'campaign-3'] as const;
export type CampaignSlotId = (typeof CAMPAIGN_SLOT_IDS)[number];
export type SnapshotKind = 'auto' | 'manual' | 'checkpoint';
export const AUTO_GENERATIONS = 3;
export const DATABASE_VERSION = 1;
export const DATABASE_NAME = 'shanmen-changming-saves';
export const DEFAULT_LEASE_DURATION_MS = 15_000;

export interface SlotManifest {
  recordVersion: 1;
  slotId: CampaignSlotId;
  revision: number;
  currentSnapshotId: string;
  autoSnapshotIds: string[];
  manualSnapshotId: string | null;
  checkpointSnapshotId: string | null;
  savedAt: string;
}

export interface SnapshotRecord {
  recordVersion: 1;
  id: string;
  slotId: CampaignSlotId;
  revision: number;
  kind: SnapshotKind;
  /** Exact provided JSON text. Import/export does not reserialize it. */
  text: string;
}

export interface WriterLease {
  slotId: CampaignSlotId;
  ownerId: string;
  epoch: number;
  expiresAt: number;
}

export interface LeaseRecord {
  recordVersion: 1;
  slotId: CampaignSlotId;
  ownerId: string | null;
  epoch: number;
  expiresAt: number;
}

export interface SaveCommit {
  slot: SlotManifest;
  snapshot: SnapshotRecord;
}
export interface SnapshotIssue {
  snapshotId: string;
  code: SaveErrorCode | 'MISSING_SNAPSHOT' | 'INVALID_SNAPSHOT_RECORD';
}
export interface LoadedSave extends SaveCommit {
  envelope: SaveEnvelope;
  world: WorldState;
  /** Fallback is read-only: loading never repairs or rewrites the current pointer. */
  recovered: boolean;
  issues: SnapshotIssue[];
}
export interface WriteOptions {
  expectedRevision: number;
  lease: WriterLease;
  kind?: SnapshotKind;
}
export interface NewSlotImportOptions {
  mode?: 'new-slot';
  ownerId: string;
  /** Omit to select the first empty slot atomically. Never overwrites an occupied slot. */
  slotId?: CampaignSlotId;
  leaseDurationMs?: number;
}
export interface OverwriteImportOptions {
  mode: 'overwrite';
  slotId: CampaignSlotId;
  expectedRevision: number;
  lease: WriterLease;
}
export type ImportOptions = NewSlotImportOptions | OverwriteImportOptions;
export interface ImportedSave extends SaveCommit { lease: WriterLease }
export type WriteStage = 'before-snapshot' | 'after-snapshot' | 'before-pointer' | 'after-pointer' | 'after-prune';
export interface RepositoryOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
  /** Platform clock only; never used to advance the simulation. */
  now?: () => number;
  /** Synchronous fault-injection seam for transaction tests; never await external work here. */
  faultInjector?: (stage: WriteStage, transaction: IDBTransaction) => void;
}

export type PersistenceErrorCode =
  | 'STORAGE_UNAVAILABLE' | 'STORAGE_BLOCKED' | 'DATABASE_VERSION_UNSUPPORTED'
  | 'STORAGE_SCHEMA_INVALID' | 'QUOTA_EXCEEDED' | 'TRANSACTION_FAILED'
  | 'INVALID_ARGUMENT' | 'INVALID_SAVE' | 'SLOT_EMPTY' | 'SLOT_OCCUPIED'
  | 'NO_EMPTY_SLOT' | 'REVISION_CONFLICT' | 'LEASE_BUSY' | 'LEASE_LOST'
  | 'SNAPSHOT_MISSING' | 'NO_VALID_SNAPSHOT' | 'CURRENT_SNAPSHOT_INVALID'
  | 'NEWER_SAVE_PROTECTED';

/** Codes are for localization; the diagnostic message is not player-facing copy. */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly saveErrorCode: SaveErrorCode | undefined;
  readonly issues: readonly SnapshotIssue[];

  constructor(code: PersistenceErrorCode, message: string, options: {
    cause?: unknown;
    saveErrorCode?: SaveErrorCode;
    issues?: readonly SnapshotIssue[];
  } = {}) {
    super(message, { cause: options.cause });
    this.name = 'PersistenceError';
    this.code = code;
    this.saveErrorCode = options.saveErrorCode;
    this.issues = options.issues ?? [];
  }
}
