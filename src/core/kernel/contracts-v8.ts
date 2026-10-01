import type { Command } from './contracts';
import type { PlayerExpeditionCommandV8 } from '../expeditions/v8-world-types';
import type { CampaignCommandEnvelope } from '../world/campaign-transaction';
/** The legacy public Command remains v7. Shared queues explicitly accept this
 * versioned superset, while each engine validates its own executable protocol. */
export type CommandV8 = Exclude<Command, { kind: 'expedition.command' }>
  | { commandId: string; sequence: number; issuedTick: number; kind: 'expedition.command'; payload: { command: PlayerExpeditionCommandV8 } }
  | CampaignCommandEnvelope;
