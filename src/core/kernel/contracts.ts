import type { SectEconomyCommand, SectEconomyError } from '../sect-economy/types';
import type { WorldSectEconomyResult } from '../world/sect-economy-bridge';
import type { ResourceId } from '../economy/types';
import type { JsonValue } from './serialization';
import type { BuildCommand, BuildError } from '../builds/types';
import type { WorldBuildResult } from '../world/build-bridge';
import type { PlayerExpeditionCommand, WorldExpeditionError, WorldExpeditionResult } from '../expeditions/world-types';
import type { CultivationCommand, CultivationCommandResult, CultivationError, CultivationEvent } from '../cultivation/types';

export type PlayerCultivationCommand = Exclude<CultivationCommand, { kind: 'talent.grant' | 'death.finalize' }>
  | (Extract<CultivationCommand, { kind: 'death.finalize' }> & { cause: 'lifespan' });

interface CommandBase { commandId: string; sequence: number; issuedTick: number }
export type Command = CommandBase & (
  | { kind: 'production.start'; payload: { recipeId: string; workerId: string } }
  | { kind: 'inventory.discard'; payload: { resourceId: ResourceId; quantity: number } }
  | { kind: 'production.cancel'; payload: { transactionId: string } }
  | { kind: 'cultivation.command'; payload: { command: PlayerCultivationCommand } }
  | { kind: 'build.command'; payload: { command: BuildCommand } }
  | { kind: 'expedition.command'; payload: { command: PlayerExpeditionCommand } }
  | { kind: 'sect-economy.command'; payload: { command: SectEconomyCommand } }
);
export type RejectionCode = 'INVALID_COMMAND' | 'COMMAND_CONFLICT' | 'COMMAND_NOT_DUE' | 'UNKNOWN_RECIPE' | 'UNKNOWN_WORKER' | 'WORKER_UNAVAILABLE' | 'INSUFFICIENT_INVENTORY' | 'UNKNOWN_TRANSACTION' | 'TRANSACTION_FINISHED' | 'INVALID_RESERVATION' | 'CAPACITY_EXCEEDED' | 'CORE_PAUSED_ERROR' | 'CULTIVATION_REJECTED' | 'BUILD_REJECTED' | 'EXPEDITION_REJECTED' | 'SECT_ECONOMY_REJECTED' | 'AUTO_JOB_RETIRED' | 'SAVE_CAPACITY_EXCEEDED' | 'SAVE_OBLIGATION_UNBOUNDED' | 'UNKNOWN_RESOURCE' | 'INVALID_QUANTITY' | 'INSUFFICIENT_AVAILABLE';
export interface CommandRejection { code: RejectionCode; resourceId?: ResourceId; cultivationCode?: CultivationError; buildCode?: BuildError; expeditionCode?: WorldExpeditionError; economyCode?: SectEconomyError }
export interface CommandResult {
  commandId: string;
  status: 'accepted' | 'rejected';
  transactionId: string | null;
  eventIds: string[];
  rejection: CommandRejection | null;
  cultivationResult?: CultivationCommandResult;
  buildResult?: WorldBuildResult;
  expeditionResult?: WorldExpeditionResult;
  economyResult?: WorldSectEconomyResult;
  discardResult?: { resourceId: ResourceId; quantity: number };
}
export interface CommandReceipt { commandId: string; fingerprint: string; result: CommandResult }
export interface DomainEvent {
  readonly eventId: string;
  readonly kind: 'inventory.discarded' | 'production.started' | 'production.committed' | 'production.cancelled' | 'production.blocked' | CultivationEvent['kind'];
  readonly tick: number;
  readonly rootActionId: string;
  readonly parentEventId: string | null;
  readonly payload: Readonly<Record<string, JsonValue>>;
}
export interface CoreDiagnostic { code: 'INVARIANT_FAILURE'; tick: number; message: string }
