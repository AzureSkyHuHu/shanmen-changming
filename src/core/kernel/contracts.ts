import type { ResourceId } from '../economy/types';
import type { JsonValue } from './serialization';

interface CommandBase { commandId: string; sequence: number; issuedTick: number }
export type Command = CommandBase & (
  | { kind: 'production.start'; payload: { recipeId: string; workerId: string } }
  | { kind: 'production.cancel'; payload: { transactionId: string } }
);
export type RejectionCode = 'INVALID_COMMAND' | 'COMMAND_CONFLICT' | 'COMMAND_NOT_DUE' | 'UNKNOWN_RECIPE' | 'UNKNOWN_WORKER' | 'WORKER_UNAVAILABLE' | 'INSUFFICIENT_INVENTORY' | 'UNKNOWN_TRANSACTION' | 'TRANSACTION_FINISHED' | 'INVALID_RESERVATION' | 'CAPACITY_EXCEEDED' | 'CORE_PAUSED_ERROR';
export interface CommandRejection { code: RejectionCode; resourceId?: ResourceId }
export interface CommandResult {
  commandId: string;
  status: 'accepted' | 'rejected';
  transactionId: string | null;
  eventIds: string[];
  rejection: CommandRejection | null;
}
export interface CommandReceipt { commandId: string; fingerprint: string; result: CommandResult }
export interface DomainEvent {
  readonly eventId: string;
  readonly kind: 'production.started' | 'production.committed' | 'production.cancelled' | 'production.blocked';
  readonly tick: number;
  readonly rootActionId: string;
  readonly parentEventId: string | null;
  readonly payload: Readonly<Record<string, JsonValue>>;
}
export interface CoreDiagnostic { code: 'INVARIANT_FAILURE'; tick: number; message: string }
