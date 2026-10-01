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
import { dispatchWorldSectEconomyV8 as dispatchWorldSectEconomy } from '../world/automatic-work-bridge-v8';
import { cancelProduction, startProduction } from '../economy/production';
import { isBuildCommand } from '../builds/builds';
import { dispatchWorldBuildV8 as dispatchWorldBuild } from '../world/build-bridge-v8';
import { dispatchWorldExpeditionV8 as dispatchWorldExpedition, reconcileWorldExpeditionDeathsV8 as reconcileWorldExpeditionDeaths } from '../expeditions/v8-world-adapter';
import { isCultivationCommand } from '../cultivation/validation';
import { isCultivationWorkerAvailable } from '../world/cultivation-bridge';
import { dispatchWorldCultivationV8 as dispatchWorldCultivation } from '../world/cultivation-bridge-v8';
import type { WorldStateV8 as WorldState } from '../world/v8-types';
import { prepareWorldEstateSettlement } from '../world/legacy-bridge';
import { prepareWorldCampaignTransaction } from '../world/campaign-transaction';
import { validateWorldStateV8 } from './validation';
import { isCommandV8 as isCommand } from './command-shape-v8';
import { verifyCandidateBoundaryV8 } from '../world/runtime-capacity-v8';
import type { CommandV8 as Command } from './contracts-v8';
import type { CommandResult, RejectionCode } from './contracts';
import { isNonNegativeInteger } from './numeric';
import { canonicalStringify, cloneJson, compareStable } from './serialization';

export function compareCommandsV8(left: Command, right: Command): number {
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
  if (command.kind === 'campaign.command') {
    const prepared = prepareWorldCampaignTransaction(world, command);
    return { world: prepared.ok ? prepared.candidate : world, result: prepared.result };
  }
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
        const settled = reconcileWorldExpeditionDeaths(operation.world);
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


/** Complete candidate publication boundary. Existing receipt replay is free. */
export function dispatchCommandV8(world: WorldState, command: unknown, _context?: { existingQueuedCommand: true }): { world: WorldState; result: CommandResult } {
  if (isCommand(command)) {
    const pending = world.pendingCommands.find(entry => entry.commandId === command.commandId);
    if (pending && canonicalStringify({ kind: pending.kind, payload: pending.payload }) !== canonicalStringify({ kind: command.kind, payload: command.payload })) return { world, result: rejected(command.commandId, 'COMMAND_CONFLICT') };
  }
  try {
    let operation = dispatchUncheckedCommand(world, command);
    if (operation.world === world) return operation;
    let candidate = cleanupAutomaticPendingPins(operation.world);
    if (candidate.cultivation.disciples.some(profile => profile.lifeState === 'dead')) {
      const estates = prepareWorldEstateSettlement(candidate);
      if (!estates.ok) return { world, result: rejected(operation.result.commandId, estates.code === 'SAVE_CAPACITY_EXCEEDED' ? estates.code : 'SAVE_OBLIGATION_UNBOUNDED') };
      candidate = estates.candidate;
    }
    const errors = validateWorldStateV8(candidate);
    if (errors.length) throw new TypeError(`Invalid v8 command candidate: ${errors.join('; ')}`);
    const verified = verifyCandidateBoundaryV8(world, candidate);
    if (!verified.ok) return { world, result: rejected(operation.result.commandId, verified.code) };
    candidate = candidate.clock.pauseReasons.includes('save-capacity') ? { ...candidate, clock: setPauseReason(candidate.clock, 'save-capacity', false) } : candidate;
    return { world: candidate, result: operation.result };
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError && /Invalid history:.*(limit|exceeds)/.test(error.message)) return { world, result: rejected(isCommand(command) ? command.commandId : '', 'SAVE_CAPACITY_EXCEEDED') };
    throw error;
  }
}
export function enqueueCommandsV8(world: WorldState, commands: readonly Command[]): WorldState {
  if (commands.some(command => !isCommand(command))) throw new TypeError('Invalid v8 queued command');
  const snapshots = commands.map(command => { const snapshot = cloneJson(command); Object.freeze(snapshot.payload); return Object.freeze(snapshot); });
  const candidate = { ...world, pendingCommands: [...world.pendingCommands, ...snapshots].sort(compareCommandsV8) };
  const verified = verifyCandidateBoundaryV8(world, candidate);
  if (!verified.ok) throw new SaveCapacityAdmissionError(verified.code);
  return candidate;
}
export { SaveCapacityAdmissionError } from './commands';
import { SaveCapacityAdmissionError } from './commands';
