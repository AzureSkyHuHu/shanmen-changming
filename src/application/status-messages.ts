import type { RejectionCode } from '../core/kernel';
import type { TextKey } from '../i18n';
import { PersistenceError, type PersistenceErrorCode } from '../platform/persistence';

export const commandMessages: Record<RejectionCode, TextKey> = {
  INVALID_COMMAND: 'command.error.invalid', COMMAND_CONFLICT: 'command.error.conflict', COMMAND_NOT_DUE: 'command.error.notDue',
  UNKNOWN_RECIPE: 'command.error.recipe', UNKNOWN_WORKER: 'command.error.worker', WORKER_UNAVAILABLE: 'command.error.unavailable',
  INSUFFICIENT_INVENTORY: 'command.error.inventory', UNKNOWN_TRANSACTION: 'command.error.transaction', TRANSACTION_FINISHED: 'command.error.finished',
  INVALID_RESERVATION: 'command.error.reservation', CAPACITY_EXCEEDED: 'command.error.capacity', CORE_PAUSED_ERROR: 'command.error.paused',
};
const persistenceMessages: Record<PersistenceErrorCode, TextKey> = {
  STORAGE_UNAVAILABLE: 'save.error.unavailable', STORAGE_BLOCKED: 'save.error.blocked', DATABASE_VERSION_UNSUPPORTED: 'save.error.version',
  STORAGE_SCHEMA_INVALID: 'save.error.invalid', QUOTA_EXCEEDED: 'save.error.quota', TRANSACTION_FAILED: 'save.error.transaction',
  INVALID_ARGUMENT: 'save.error.invalid', INVALID_SAVE: 'save.error.invalid', SLOT_EMPTY: 'save.error.empty', SLOT_OCCUPIED: 'save.error.slotOccupied',
  NO_EMPTY_SLOT: 'save.error.full', REVISION_CONFLICT: 'save.error.conflict', LEASE_BUSY: 'save.error.leaseBusy', LEASE_LOST: 'save.error.leaseLost',
  SNAPSHOT_MISSING: 'save.error.missing', NO_VALID_SNAPSHOT: 'save.error.invalid', CURRENT_SNAPSHOT_INVALID: 'save.error.protected', NEWER_SAVE_PROTECTED: 'save.error.version',
};
export function persistenceMessage(error: unknown): TextKey {
  if (error instanceof PersistenceError) {
    if (error.saveErrorCode?.startsWith('UNSUPPORTED_')) return 'save.error.version';
    return persistenceMessages[error.code];
  }
  return 'save.error.transaction';
}
