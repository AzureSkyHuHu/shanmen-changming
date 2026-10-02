import type { CommandResult } from './contracts';
import type { CommandV10, SectCommandV10 } from '../sect-expansion/upgrade-types';

export type { CommandV10, SectCommandV10 };
/** Internal result only. No queue, save, Session or runtime publication registration. */
export type CommandResultV10 = CommandResult | {
  commandId: string; status: 'accepted' | 'rejected'; transactionId: string | null; eventIds: string[];
  rejection: { code: 'UNREGISTERED_COMMAND_FAMILY' | 'SECT_EXPANSION_REJECTED' | 'INVALID_WORLD_RECORDS'; detail?: string } | null;
  sectResult?: { domain: SectCommandV10['domain']; relatedId: string | null; repeated: boolean };
};
