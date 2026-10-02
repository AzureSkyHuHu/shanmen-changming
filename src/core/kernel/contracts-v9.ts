import type { ConstructionCommand } from '../sect-expansion/construction-types';
import type { SectProductionCommand } from '../sect-expansion/production-types';
import type { SectResearchCommand } from '../sect-expansion/research-types';
import type { CommandResult } from './contracts';
import type { CommandV8 } from './contracts-v8';

export type SectCommandV9 = { domain: 'construction'; command: ConstructionCommand }
  | { domain: 'production'; command: SectProductionCommand }
  | { domain: 'research'; command: SectResearchCommand };
/** No queue/codec registration. Departures and campaign commands explicitly reject. */
export type CommandV9 = CommandV8 | { kind: 'sect.command'; payload: SectCommandV9;
  commandId: string; sequence: number; issuedTick: number };
export type CommandResultV9 = CommandResult | {
  commandId: string; status: 'accepted' | 'rejected'; transactionId: string | null; eventIds: string[];
  rejection: { code: 'UNREGISTERED_COMMAND_FAMILY' | 'SECT_EXPANSION_REJECTED' | 'INVALID_WORLD_RECORDS'; detail?: string } | null;
  sectResult?: { domain: SectCommandV9['domain']; relatedId: string | null; repeated: boolean };
};
