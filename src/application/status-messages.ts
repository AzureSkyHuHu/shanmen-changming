import { campaignMessageKey } from './campaign-messages';
import type { CommandResult, RejectionCode } from '../core/kernel';
import type { TextKey } from '../i18n';
import type { BuildErrorV2 } from '../core/builds/v2-types';
import type { WorldExpeditionError } from '../core/expeditions/world-types';
import type { CultivationError } from '../core/cultivation/types';
import type { SectEconomyError } from '../core/sect-economy/types';
import { PersistenceError, type PersistenceErrorCode } from '../platform/persistence';

export const commandMessages: Record<RejectionCode, TextKey> = {
  INVALID_COMMAND: 'command.error.invalid', COMMAND_CONFLICT: 'command.error.conflict', COMMAND_NOT_DUE: 'command.error.notDue',
  UNKNOWN_RECIPE: 'command.error.recipe', UNKNOWN_WORKER: 'command.error.worker', WORKER_UNAVAILABLE: 'command.error.unavailable',
  INSUFFICIENT_INVENTORY: 'command.error.inventory', UNKNOWN_TRANSACTION: 'command.error.transaction', TRANSACTION_FINISHED: 'command.error.finished',
  INVALID_RESERVATION: 'command.error.reservation', CAPACITY_EXCEEDED: 'command.error.capacity', CORE_PAUSED_ERROR: 'command.error.paused',
  CULTIVATION_REJECTED: 'cultivation.error.INVALID_STATE',
  CAMPAIGN_REJECTED: 'campaign.growth.rejected',
  BUILD_REJECTED: 'buildView.rejected', EXPEDITION_REJECTED: 'expedition.error.INVALID_STATE',
  SECT_ECONOMY_REJECTED: 'economy.error.invalid',
  AUTO_JOB_RETIRED: 'command.error.autoRetired', SAVE_CAPACITY_EXCEEDED: 'command.error.saveCapacity',
  SAVE_OBLIGATION_UNBOUNDED: 'command.error.saveObligation', UNKNOWN_RESOURCE: 'command.error.resource',
  INVALID_QUANTITY: 'command.error.quantity', INSUFFICIENT_AVAILABLE: 'command.error.available',
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
    if (error.saveErrorCode === 'TOO_LARGE') return 'save.error.tooLarge';
    if (error.saveErrorCode?.startsWith('UNSUPPORTED_')) return 'save.error.version';
    return persistenceMessages[error.code];
  }
  return 'save.error.transaction';
}

export const cultivationMessages: Record<CultivationError, TextKey> = {
  INVALID_STATE: 'cultivation.error.INVALID_STATE',
  INVALID_COMMAND: 'cultivation.error.INVALID_COMMAND',
  REVISION_CONFLICT: 'cultivation.error.REVISION_CONFLICT',
  COMMAND_CONFLICT: 'cultivation.error.COMMAND_CONFLICT',
  UNKNOWN_DISCIPLE: 'cultivation.error.UNKNOWN_DISCIPLE',
  UNKNOWN_ATTEMPT: 'cultivation.error.UNKNOWN_ATTEMPT',
  PREVIEW_STALE: 'cultivation.error.PREVIEW_STALE',
  PREPARATION_BLOCKED: 'cultivation.error.PREPARATION_BLOCKED',
  INSUFFICIENT_RESOURCES: 'cultivation.error.INSUFFICIENT_RESOURCES',
  ATTEMPT_FINISHED: 'cultivation.error.ATTEMPT_FINISHED',
  INVALID_PHASE: 'cultivation.error.INVALID_PHASE',
  ACKNOWLEDGEMENT_REQUIRED: 'cultivation.error.ACKNOWLEDGEMENT_REQUIRED',
  DISCIPLE_UNAVAILABLE: 'cultivation.error.DISCIPLE_UNAVAILABLE',
  DEATH_CONFLICT: 'cultivation.error.DEATH_CONFLICT',
  INVALID_INHERITANCE: 'cultivation.error.INVALID_INHERITANCE',
  UNKNOWN_TALENT: 'cultivation.error.UNKNOWN_TALENT',
  INVALID_TEACHING: 'cultivation.error.INVALID_TEACHING',
  OVERFLOW: 'cultivation.error.OVERFLOW',
  ACTIVITY_LOCKED: 'cultivation.error.ACTIVITY_LOCKED',
};

export const expeditionMessages: Record<WorldExpeditionError, TextKey> = {
  INVALID_COMMAND: 'expedition.error.INVALID_COMMAND',
  INVALID_PHASE: 'expedition.error.INVALID_PHASE',
  BUSY: 'expedition.error.BUSY',
  MEMBER_UNAVAILABLE: 'expedition.error.MEMBER_UNAVAILABLE',
  BUILD_UNAVAILABLE: 'expedition.error.BUILD_UNAVAILABLE',
  INSUFFICIENT_SUPPLIES: 'expedition.error.INSUFFICIENT_SUPPLIES',
  INVENTORY_FULL: 'expedition.error.INVENTORY_FULL',
  STALE_OFFER: 'expedition.error.STALE_OFFER',
  ILLEGAL_CHOICE: 'expedition.error.ILLEGAL_CHOICE',
  NO_NEW_CANDIDATE: 'expedition.error.NO_NEW_CANDIDATE',
  REROLLS_EXHAUSTED: 'expedition.error.REROLLS_EXHAUSTED',
  CHECKPOINT_MISMATCH: 'expedition.error.CHECKPOINT_MISMATCH',
  CONTENT_MISMATCH: 'expedition.error.CONTENT_MISMATCH',
  INVALID_STATE: 'expedition.error.INVALID_STATE',
  BLOCKED_BY_DECISION: 'expedition.error.BLOCKED_BY_DECISION',
};
const buildMessages: Partial<Record<BuildErrorV2, TextKey>> = {
  REVISION_CONFLICT: 'buildView.draftStale', EXPEDITION_LOCKED: 'buildView.locked',
  MISSING_PREREQUISITE: 'buildView.missingPrerequisite', INSUFFICIENT_POINTS: 'buildView.insufficientPoints',
  POINT_LIMIT: 'buildView.pointLimit', INSUFFICIENT_LEARNING_CREDITS: 'buildView.insufficientCredits',
  UNKNOWN_DEFINITION: 'buildView.unknownDefinition', CONTENT_MISMATCH: 'buildView.unknownDefinition',
  UNSUPPORTED_CONTENT: 'buildView.support.generic',
};
const economyMessages: Record<SectEconomyError, TextKey> = {
  INVALID_COMMAND: 'economy.error.invalid',
  UNKNOWN_WORKER: 'economy.error.worker',
  PLAN_LIMIT: 'economy.error.limit',
};

export function commandFeedbackKey(result: Pick<CommandResult, 'rejection'>): TextKey {
  if (!result.rejection) return 'command.accepted';
  if (result.rejection.code === 'CAMPAIGN_REJECTED' && result.rejection.campaignCode) return campaignMessageKey(result.rejection.campaignCode);
  if (result.rejection.code === 'CULTIVATION_REJECTED' && result.rejection.cultivationCode) return cultivationMessages[result.rejection.cultivationCode];
  if (result.rejection.code === 'EXPEDITION_REJECTED' && result.rejection.expeditionCode) return expeditionMessages[result.rejection.expeditionCode];
  if (result.rejection.code === 'BUILD_REJECTED' && result.rejection.buildCode) return buildMessages[result.rejection.buildCode] ?? 'buildView.rejected';
  if (result.rejection.code === 'SECT_ECONOMY_REJECTED' && result.rejection.economyCode) return economyMessages[result.rejection.economyCode];
  return commandMessages[result.rejection.code];
}
