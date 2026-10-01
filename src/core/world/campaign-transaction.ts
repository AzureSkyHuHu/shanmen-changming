import type { CommandResult } from '../kernel/contracts';
import { appendEvent } from '../kernel/events';
import { canonicalStringify, cloneJson, type JsonValue } from '../kernel/serialization';
import { validateWorldStateV8 } from '../kernel/validation';
import { canonicalUtf8ByteLength, measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { cleanupAutomaticPendingPins } from '../economy/automatic-production';
import { prepareWorldCampaignCommit } from './campaign-grants';
import { isPlayerCampaignCommand } from './campaign-queries';
import { lookupCommandReceipt, recordWorldReceipt } from './history-access';
import { assessWorldBuildHistoryObligations } from './progression-obligations';
import type { PlayerCampaignCommand } from './campaign-types';
import type { WorldCampaignTransactionProof } from './campaign-transaction-types';
import type { WorldStateV8 } from './v8-types';

/** Candidate-only envelope. The live v7 Command/isCommand/gateway intentionally
 * cannot admit this new kind until all v8 future obligations are integrated. */
export interface CampaignCommandEnvelope {
  commandId: string; sequence: number; issuedTick: number;
  kind: 'campaign.command'; payload: { command: PlayerCampaignCommand };
}
export type WorldCampaignTransactionCandidate =
  | { ok: true; candidate: WorldStateV8; result: CommandResult; replayed: boolean }
  | { ok: false; result: CommandResult };
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function isCampaignCommandEnvelope(value: unknown): value is CampaignCommandEnvelope {
  try {
    canonicalUtf8ByteLength(value);
    return exact(value, ['commandId', 'sequence', 'issuedTick', 'kind', 'payload']) && value.kind === 'campaign.command'
      && typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence >= 0
      && typeof value.issuedTick === 'number' && Number.isSafeInteger(value.issuedTick) && value.issuedTick >= 0
      && exact(value.payload, ['command']) && isPlayerCampaignCommand(value.payload.command) && value.commandId === value.payload.command.commandId;
  } catch { return false; }
}
export function campaignTransactionPayload(proof: WorldCampaignTransactionProof): Record<string, JsonValue> {
  return { commandId: proof.commandId, calendarTick: proof.calendarTick, claimId: proof.claimId,
    payment: { reservationId: proof.payment.reservationId, ownerTransactionId: proof.payment.ownerTransactionId,
      state: proof.payment.state, lines: proof.payment.lines.map(line => ({ ...line })) },
    creditedResources: proof.creditedResources.map(line => ({ ...line })), acquisitionIds: [...proof.acquisitionIds],
    buildCommandIds: [...proof.buildCommandIds], cultivationCommandIds: [...proof.cultivationCommandIds] };
}
function failure(commandId: string, code: NonNullable<CommandResult['rejection']>['code']): WorldCampaignTransactionCandidate {
  return { ok: false, result: { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code } } };
}

/** Produces a complete, validated but UNPUBLISHED v8 event/receipt/domain candidate.
 * Actual bytes and build rows are checked here. This is not the final admission
 * gateway: all progression/run/production future obligations must also be funded
 * before a caller may publish the candidate. */
export function prepareWorldCampaignTransaction(world: WorldStateV8, input: unknown): WorldCampaignTransactionCandidate {
  if (!isCampaignCommandEnvelope(input)) return failure('', 'INVALID_COMMAND');
  const fingerprint = canonicalStringify({ kind: input.kind, payload: input.payload });
  const previous = lookupCommandReceipt(world, input.commandId);
  if (previous) return previous.fingerprint === fingerprint ? { ok: true, candidate: world, result: cloneJson(previous.result), replayed: true }
    : failure(input.commandId, 'COMMAND_CONFLICT');
  if (world.pendingCommands.some(command => command.commandId === input.commandId)) return failure(input.commandId, 'COMMAND_CONFLICT');
  if (input.issuedTick > world.clock.simulationTick) return failure(input.commandId, 'COMMAND_NOT_DUE');
  if (world.clock.pauseReasons.includes('error')) return failure(input.commandId, 'CORE_PAUSED_ERROR');
  try {
    if (validateWorldStateV8(world).length) return failure(input.commandId, 'INVALID_COMMAND');
    const grant = prepareWorldCampaignCommit(world, input.payload.command);
    let candidate = world; let result: CommandResult;
    if (grant.ok) {
      const committed = appendEvent(grant.candidate, { kind: 'campaign.committed', rootActionId: grant.rootActionId, parentEventId: null, payload: campaignTransactionPayload(grant.proof) });
      candidate = committed.world;
      result = { commandId: input.commandId, status: 'accepted', transactionId: null, eventIds: [committed.event.eventId], rejection: null, campaignResult: cloneJson(grant.result) };
    } else result = { commandId: input.commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'CAMPAIGN_REJECTED', campaignCode: grant.code } };
    candidate = recordWorldReceipt(candidate, { commandId: input.commandId, fingerprint, result: cloneJson(result) });
    candidate = cleanupAutomaticPendingPins(candidate);
    if (validateWorldStateV8(candidate).length) return failure(input.commandId, 'INVALID_COMMAND');
    if (!assessWorldBuildHistoryObligations(candidate).fits || measureWorldSaveBytes(candidate, { saveVersion: 8 }) > SAVE_FILE_LIMIT_BYTES) return failure(input.commandId, 'SAVE_CAPACITY_EXCEEDED');
    return { ok: true, candidate, result, replayed: false };
  } catch (error) {
    return failure(input.commandId, error instanceof RangeError || error instanceof TypeError && /Invalid history:.*(limit|exceeds)/.test(error.message)
      ? 'SAVE_CAPACITY_EXCEEDED' : 'INVALID_COMMAND');
  }
}
