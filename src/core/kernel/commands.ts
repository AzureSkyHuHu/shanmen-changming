import { RESOURCE_IDS } from '../economy/types';
import { cleanupAutomaticPendingPins, isAutomaticJobId } from '../economy/automatic-production';
import { discardAvailable } from '../economy/discard';
import { verifySaveCandidate, verifyReservedRelease } from '../save-budget';
import { worldAutomaticBudgetInput } from '../world/automatic-work-bridge';
import { appendEvent } from './events';
import { allocateId } from './ids';
import { setPauseReason } from './clock';
import { lookupCommandReceipt, recordWorldReceipt, worldEventCursor, worldEventsSince } from '../world/history-access';
import { isSectEconomyCommand } from '../sect-economy/state';
import { dispatchWorldSectEconomy } from '../world/sect-economy-bridge';
import { cancelProduction, startProduction } from '../economy/production';
import { isBuildCommand } from '../builds/builds';
import { dispatchWorldBuild, reconcileWorldRealmMilestones } from '../world/build-bridge';
import { dispatchWorldExpedition, isWorldExpeditionCommand, reconcileWorldExpeditionDeaths } from '../expeditions/world-adapter';
import { isCultivationCommand } from '../cultivation/validation';
import { dispatchWorldCultivation, isCultivationWorkerAvailable } from '../world/cultivation-bridge';
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
    : candidate.kind === 'production.cancel' ? Object.keys(payload).length === 1 && (validId(payload.transactionId) || isAutomaticJobId(payload.transactionId))
      : candidate.kind === 'inventory.discard' ? Object.keys(payload).length === 2 && validId(payload.resourceId) && typeof payload.quantity === 'number' && Number.isSafeInteger(payload.quantity)
      : candidate.kind === 'cultivation.command' ? Object.keys(payload).length === 1 && isCultivationCommand(payload.command)
        && payload.command.commandId === candidate.commandId && payload.command.kind !== 'talent.grant'
        && (payload.command.kind !== 'death.finalize' || payload.command.cause === 'lifespan')
        : candidate.kind === 'build.command' ? Object.keys(payload).length === 1 && isBuildCommand(payload.command) && payload.command.commandId === candidate.commandId
          : candidate.kind === 'expedition.command' ? Object.keys(payload).length === 1 && isWorldExpeditionCommand(payload.command) && payload.command.commandId === candidate.commandId
            : candidate.kind === 'sect-economy.command' && Object.keys(payload).length === 1 && isSectEconomyCommand(payload.command);
}
export function compareCommands(left: Command, right: Command): number {
  return left.issuedTick - right.issuedTick || left.sequence - right.sequence || compareStable(left.commandId, right.commandId) || compareStable(canonicalStringify({ kind: left.kind, payload: left.payload }), canonicalStringify({ kind: right.kind, payload: right.payload }));
}
function rejected(commandId: string, code: RejectionCode): CommandResult {
  return { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code } };
}

/** Called only at full boundaries. Invalid commands never consume IDs, RNG or resources. */
function dispatchUncheckedCommand(world: WorldState, command: unknown): { world: WorldState; result: CommandResult } {
  if (!isCommand(command)) return { world, result: rejected('', 'INVALID_COMMAND') };
  let fingerprint: string;
  try { fingerprint = canonicalStringify({ kind: command.kind, payload: command.payload }); }
  catch { return { world, result: rejected(command.commandId, 'INVALID_COMMAND') }; }
  const existing = lookupCommandReceipt(world, command.commandId);
  if (existing) return { world, result: existing.fingerprint === fingerprint ? cloneJson(existing.result) : rejected(command.commandId, 'COMMAND_CONFLICT') };
  if (command.issuedTick > world.clock.simulationTick) return { world, result: rejected(command.commandId, 'COMMAND_NOT_DUE') };
  if (world.clock.pauseReasons.includes('error')) return { world, result: rejected(command.commandId, 'CORE_PAUSED_ERROR') };
  if (command.kind === 'inventory.discard') {
    const discarded = discardAvailable(world.inventory, command.payload.resourceId, command.payload.quantity);
    let next = world;
    let result: CommandResult;
    if (!discarded.ok) result = rejected(command.commandId, discarded.code);
    else {
      const action = allocateId(world.sequences, 'action');
      const emitted = appendEvent({ ...world, sequences: action.sequences, inventory: discarded.inventory }, { kind: 'inventory.discarded',
        rootActionId: action.id, parentEventId: null, payload: { commandId: command.commandId, ...discarded.discarded } });
      next = emitted.world;
      result = { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [emitted.event.eventId], rejection: null, discardResult: discarded.discarded };
    }
    return { world: recordWorldReceipt(next, { commandId: command.commandId, fingerprint, result: cloneJson(result) }), result };
  }
  if (command.kind === 'sect-economy.command') {
    const operation = dispatchWorldSectEconomy(world, command.payload.command);
    const result: CommandResult = operation.ok
      ? { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [], rejection: null, economyResult: operation.result }
      : { commandId: command.commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'SECT_ECONOMY_REJECTED', economyCode: operation.code } };
    const next = operation.ok ? operation.world : world;
    return { world: recordWorldReceipt(next, { commandId: command.commandId, fingerprint, result: cloneJson(result) }), result };
  }
  if (command.kind === 'build.command') {
    const operation = dispatchWorldBuild(world, command.payload.command);
    const result: CommandResult = operation.ok
      ? { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: operation.eventIds, rejection: null, buildResult: operation.result }
      : { commandId: command.commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'BUILD_REJECTED', buildCode: operation.code } };
    const next = operation.ok ? operation.world : world;
    return { world: recordWorldReceipt(next, { commandId: command.commandId, fingerprint, result: cloneJson(result) }), result };
  }
  if (command.kind === 'expedition.command') {
    const operation = dispatchWorldExpedition(world, command.payload.command);
    const result: CommandResult = operation.ok
      ? { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: operation.eventIds, rejection: null, expeditionResult: operation.result }
      : { commandId: command.commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'EXPEDITION_REJECTED', expeditionCode: operation.code } };
    const next = operation.ok ? operation.world : world;
    return { world: recordWorldReceipt(next, { commandId: command.commandId, fingerprint, result: cloneJson(result) }), result };
  }
  if (command.kind === 'cultivation.command') {
    let operation;
    try {
      operation = dispatchWorldCultivation(world, command.payload.command, { commandId: command.commandId });
      if (operation.ok) {
        const settled = reconcileWorldExpeditionDeaths(reconcileWorldRealmMilestones(operation.world));
        operation = { ...operation, world: settled, eventIds: worldEventsSince(settled, worldEventCursor(world)).map((event) => event.eventId) };
      }
    }
    catch { operation = { ok: false as const, code: 'INVALID_STATE' as const }; }
    const result: CommandResult = operation.ok
      ? { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: operation.eventIds, rejection: null, cultivationResult: operation.result }
      : { commandId: command.commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'CULTIVATION_REJECTED', cultivationCode: operation.code } };
    const next = operation.ok ? operation.world : world;
    return { world: recordWorldReceipt(next, { commandId: command.commandId, fingerprint, result: cloneJson(result) }), result };
  }
  if (command.kind === 'production.start' && !isCultivationWorkerAvailable(world, command.payload.workerId)) {
    const result = rejected(command.commandId, world.disciples.some((d) => d.id === command.payload.workerId) ? 'WORKER_UNAVAILABLE' : 'UNKNOWN_WORKER');
    return { world: recordWorldReceipt(world, { commandId: command.commandId, fingerprint, result: cloneJson(result) }), result };
  }
  const operation = command.kind === 'production.start'
    ? startProduction(world, command.commandId, command.payload.recipeId, command.payload.workerId)
    : cancelProduction(world, command.payload.transactionId, { commandId: command.commandId });
  const result: CommandResult = operation.ok
    ? { commandId: command.commandId, status: 'accepted', transactionId: operation.transactionId, eventIds: operation.eventIds, rejection: null }
    : { commandId: command.commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: operation.rejection };
  const next = operation.ok ? operation.world : world;
  return { world: recordWorldReceipt(next, { commandId: command.commandId, fingerprint, result: cloneJson(result) }), result };
}

/** Exact receipts/conflicts are resolved before capacity checks. A transient refusal writes no receipt. */
export function dispatchCommand(world: WorldState, command: unknown, context?: { existingQueuedCommand: true }): { world: WorldState; result: CommandResult } {
  let operation: { world: WorldState; result: CommandResult };
  try { operation = dispatchUncheckedCommand(world, command); }
  catch (error) {
    if (!isCommand(command) || !isSaveCapacityError(error)) throw error;
    return { world, result: rejected(command.commandId, 'SAVE_CAPACITY_EXCEEDED') };
  }
  if (operation.world === world) return operation;
  if (operation.world.pendingCommands.length) operation = { ...operation, world: cleanupAutomaticPendingPins(operation.world) };
  const before = worldAutomaticBudgetInput(world);
  const candidate = worldAutomaticBudgetInput(operation.world);
  const release = operation.world.activeProductionTransactionIds.length < world.activeProductionTransactionIds.length
    || RESOURCE_IDS.some((key) => operation.world.inventory[key].reserved < world.inventory[key].reserved);
  const verified = release ? verifyReservedRelease(before, candidate) : verifySaveCandidate(candidate);
  const budget = verified.budget;
  const existingUnknownQueue = context?.existingQueuedCommand && budget.reason === 'unsupported-pending'
    && budget.actualFits && budget.availableBytes >= 0 && budget.archiveSlotsFit && budget.archiveExpansionFit;
  if (!verified.ok && !existingUnknownQueue) return { world, result: rejected(operation.result.commandId, verified.code) };
  return { ...operation, world: operation.world.clock.pauseReasons.includes('save-capacity') && budget.obligationsFit
    ? { ...operation.world, clock: setPauseReason(operation.world.clock, 'save-capacity', false) } : operation.world };
}
export class SaveCapacityAdmissionError extends Error {
  constructor(readonly code: 'SAVE_CAPACITY_EXCEEDED' | 'SAVE_OBLIGATION_UNBOUNDED') { super(code); }
}
export function isSaveCapacityError(error: unknown): boolean {
  return error instanceof TypeError && /Invalid history: (record count exceeds limit|decoded history exceeds limit)/.test(error.message);
}

/** Future commands persist through snapshots; sorting does not depend on incoming array order. */
export function enqueueCommands(world: WorldState, commands: readonly Command[]): WorldState {
  if (commands.some((command) => !isCommand(command))) throw new TypeError('Invalid queued command');
  const snapshots = commands.map((command) => {
    const snapshot = cloneJson(command);
    Object.freeze(snapshot.payload);
    return Object.freeze(snapshot);
  });
  const candidate = { ...world, pendingCommands: [...world.pendingCommands, ...snapshots].sort(compareCommands) };
  const verified = verifySaveCandidate(worldAutomaticBudgetInput(candidate));
  const budget = verified.budget;
  // Complex pending effects are unproven, so suppress automatic admission; each due
  // effect still checks its complete candidate before publication. Known obligations stay funded.
  const unknownOnly = budget.reason === 'unsupported-pending' && budget.actualFits && budget.availableBytes >= 0
    && budget.archiveSlotsFit && budget.archiveExpansionFit;
  if (!verified.ok && !unknownOnly) throw new SaveCapacityAdmissionError(verified.code);
  return candidate;
}
