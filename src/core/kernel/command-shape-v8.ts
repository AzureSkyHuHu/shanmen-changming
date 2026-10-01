import { isCommand } from './commands';
import type { CommandV8 } from './contracts-v8';
import { isCampaignCommandEnvelope } from '../world/campaign-transaction';
import { isWorldExpeditionCommandV8 } from '../expeditions/v8-world-adapter';
import { canonicalUtf8ByteLength } from '../save-budget';
export function isCommandV8(value: unknown): value is CommandV8 {
  try {
    canonicalUtf8ByteLength(value);
    if (isCommand(value) || isCampaignCommandEnvelope(value)) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const command = value as Record<string, unknown>;
    if (Object.keys(command).sort().join(',') !== 'commandId,issuedTick,kind,payload,sequence'
      || command.kind !== 'expedition.command' || typeof command.commandId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(command.commandId) || ['__proto__','constructor','prototype'].includes(command.commandId)
      || typeof command.sequence !== 'number' || !Number.isSafeInteger(command.sequence) || command.sequence < 0
      || typeof command.issuedTick !== 'number' || !Number.isSafeInteger(command.issuedTick) || command.issuedTick < 0
      || !command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) return false;
    const payload = command.payload as Record<string, unknown>;
    return Object.keys(payload).join(',') === 'command' && isWorldExpeditionCommandV8(payload.command) && payload.command.commandId === command.commandId;
  } catch { return false; }
}
