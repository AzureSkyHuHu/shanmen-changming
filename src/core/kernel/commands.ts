import { cancelProduction, startProduction } from '../economy/production';
import type { WorldState } from '../world/types';
import type { Command, CommandResult, RejectionCode } from './contracts';
import { isNonNegativeInteger } from './numeric';
import { canonicalStringify, cloneJson, compareStable } from './serialization';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export function isCommand(value: unknown): value is Command {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !['commandId', 'sequence', 'issuedTick', 'kind', 'payload'].includes(key)) || !validId(candidate.commandId) || !isNonNegativeInteger(candidate.sequence) || !isNonNegativeInteger(candidate.issuedTick) || !candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload) || Object.getPrototypeOf(candidate.payload) !== Object.prototype) return false;
  const payload = candidate.payload as Record<string, unknown>;
  return candidate.kind === 'production.start'
    ? Object.keys(payload).length === 2 && validId(payload.recipeId) && validId(payload.workerId)
    : candidate.kind === 'production.cancel' && Object.keys(payload).length === 1 && validId(payload.transactionId);
}
export function compareCommands(left: Command, right: Command): number {
  return left.issuedTick - right.issuedTick || left.sequence - right.sequence || compareStable(left.commandId, right.commandId) || compareStable(canonicalStringify({ kind: left.kind, payload: left.payload }), canonicalStringify({ kind: right.kind, payload: right.payload }));
}
function rejected(commandId: string, code: RejectionCode): CommandResult {
  return { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code } };
}

/** Called only at full boundaries. Invalid commands never consume IDs, RNG or resources. */
export function dispatchCommand(world: WorldState, command: unknown): { world: WorldState; result: CommandResult } {
  if (!isCommand(command)) return { world, result: rejected('', 'INVALID_COMMAND') };
  let fingerprint: string;
  try { fingerprint = canonicalStringify({ kind: command.kind, payload: command.payload }); }
  catch { return { world, result: rejected(command.commandId, 'INVALID_COMMAND') }; }
  const existing = Object.hasOwn(world.commandReceipts, command.commandId) ? world.commandReceipts[command.commandId] : undefined;
  if (existing) return { world, result: existing.fingerprint === fingerprint ? cloneJson(existing.result) : rejected(command.commandId, 'COMMAND_CONFLICT') };
  if (command.issuedTick > world.clock.simulationTick) return { world, result: rejected(command.commandId, 'COMMAND_NOT_DUE') };
  if (world.clock.pauseReasons.includes('error')) return { world, result: rejected(command.commandId, 'CORE_PAUSED_ERROR') };
  const operation = command.kind === 'production.start'
    ? startProduction(world, command.commandId, command.payload.recipeId, command.payload.workerId)
    : cancelProduction(world, command.payload.transactionId);
  const result: CommandResult = operation.ok
    ? { commandId: command.commandId, status: 'accepted', transactionId: operation.transactionId, eventIds: operation.eventIds, rejection: null }
    : { commandId: command.commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: operation.rejection };
  const next = operation.ok ? operation.world : world;
  return { world: { ...next, commandReceipts: { ...next.commandReceipts, [command.commandId]: { commandId: command.commandId, fingerprint, result: cloneJson(result) } } }, result };
}

/** Future commands persist through snapshots; sorting does not depend on incoming array order. */
export function enqueueCommands(world: WorldState, commands: readonly Command[]): WorldState {
  if (commands.some((command) => !isCommand(command))) throw new TypeError('Invalid queued command');
  const snapshots = commands.map((command) => {
    const snapshot = cloneJson(command);
    Object.freeze(snapshot.payload);
    return Object.freeze(snapshot);
  });
  return { ...world, pendingCommands: [...world.pendingCommands, ...snapshots].sort(compareCommands) };
}
