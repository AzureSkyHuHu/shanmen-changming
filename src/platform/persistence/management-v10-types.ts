import type { SaveEnvelopeV10, SaveErrorCodeV10 } from '../../core/kernel/save-v10';
import type { MigrationIssueV10, WorldStateV10 } from '../../core/sect-expansion/upgrade-types';
import type {
  CampaignSlotId, ImportOptions, LeaseRecord, PersistenceErrorCode, SaveCommit, SlotManifest,
  SnapshotKind, SnapshotRecord, WriterLease, WriteOptions,
} from './types';

/** Private adapter identity. Callers cannot redirect this repository to an old database. */
export const MANAGEMENT_V10_DATABASE_NAME = 'shanmen-changming-v10-management-saves';
export const MANAGEMENT_V10_DATABASE_VERSION = 1;
export const MANAGEMENT_V10_STORES = ['slots', 'snapshots', 'leases', 'migrationSources'] as const;

export type { CampaignSlotId, ImportOptions, LeaseRecord, SaveCommit, SlotManifest, SnapshotKind, SnapshotRecord, WriterLease, WriteOptions };

/** Append-only backup, never a retained v10 snapshot. Source text is not reserialized. */
export interface MigrationSourceRecordV10 {
  recordVersion: 1;
  id: string;
  targetSlotId: CampaignSlotId;
  sourceText: string;
}
export interface SnapshotIssueV10 {
  snapshotId: string;
  code: SaveErrorCodeV10 | 'MISSING_SNAPSHOT' | 'INVALID_SNAPSHOT_RECORD';
}
export interface LoadedManagementSaveV10 extends SaveCommit {
  envelope: SaveEnvelopeV10;
  world: WorldStateV10;
  migration: null;
  /** Recovery never repairs storage and must stay read-only in the caller. */
  recovered: boolean;
  issues: SnapshotIssueV10[];
}
export interface ImportedManagementSaveV10 extends SaveCommit { lease: WriterLease }
export interface CommitV9CopyOptions {
  sourceText: string;
  targetText: string;
  targetSlotId: CampaignSlotId;
  ownerId: string;
  signal?: AbortSignal;
}
/** Durable target receipt, not proof that the caller bound a new live Session. */
export interface V9CopyCommitReceipt extends ImportedManagementSaveV10 {
  committed: true;
  databaseName: typeof MANAGEMENT_V10_DATABASE_NAME;
  sourceBackup: MigrationSourceRecordV10;
}
export type ManagementV10WriteStage =
  | 'before-backup' | 'after-backup' | 'after-backup-readback'
  | 'before-snapshot' | 'after-snapshot' | 'after-snapshot-readback'
  | 'before-pointer' | 'after-pointer' | 'after-prune';
export interface ManagementV10RepositoryOptions {
  indexedDB?: IDBFactory;
  /** Platform lease clock only; never changes simulation time. */
  now?: () => number;
  /** Synchronous test seam. External asynchronous work makes IDB transactions inactive. */
  faultInjector?: (stage: ManagementV10WriteStage, transaction: IDBTransaction) => void;
}
export type ManagementV10PersistenceErrorCode = PersistenceErrorCode
  | 'MIGRATION_SOURCE_INVALID' | 'MIGRATION_NOT_READY' | 'MIGRATION_TARGET_MISMATCH'
  | 'SOURCE_BACKUP_CONFLICT';
/** Diagnostic messages are not player-facing copy; consumers localize the codes. */
export class ManagementV10PersistenceError extends Error {
  readonly code: ManagementV10PersistenceErrorCode;
  readonly saveErrorCode: SaveErrorCodeV10 | undefined;
  readonly issues: readonly SnapshotIssueV10[];
  readonly migrationIssues: readonly MigrationIssueV10[];

  constructor(code: ManagementV10PersistenceErrorCode, message: string, options: {
    cause?: unknown;
    saveErrorCode?: SaveErrorCodeV10;
    issues?: readonly SnapshotIssueV10[];
    migrationIssues?: readonly MigrationIssueV10[];
  } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ManagementV10PersistenceError';
    this.code = code;
    this.saveErrorCode = options.saveErrorCode;
    this.issues = options.issues ?? [];
    this.migrationIssues = options.migrationIssues ?? [];
  }
}
