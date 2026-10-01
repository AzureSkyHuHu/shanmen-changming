import { worldSaveByteDelta } from '../world/save-byte-delta';
import { cleanupAutomaticPendingPins } from '../economy/automatic-production';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES, verifySaveCandidate, verifyReservedRelease, type SaveCapacityRejectionCode } from '../save-budget';
import { worldAutomaticBudgetInput, tickWorldAutomaticWork } from '../world/automatic-work-bridge';
import { beforeWorldExpeditionTick, afterWorldExpeditionTick, reconcileWorldExpeditionDeaths } from '../expeditions/world-adapter';
import { tickProduction } from '../economy/production';
import type { WorldState } from '../world/types';
import { advanceWorldCultivation, withCultivationPause } from '../world/cultivation-bridge';
import { isPaused, setPauseReason, tickClock } from './clock';
import { compareCommands, dispatchCommand, enqueueCommands, isSaveCapacityError, SaveCapacityAdmissionError } from './commands';
import type { Command, CoreDiagnostic } from './contracts';
import { assertNonNegativeInteger } from './numeric';
import { stableHash } from './serialization';

class SaveCapacityStop extends Error {
  constructor(readonly code: SaveCapacityRejectionCode = 'SAVE_CAPACITY_EXCEEDED') { super(code); }
}
export interface AdvanceTicksResult { world: WorldState; capacityStop: SaveCapacityRejectionCode | null; invariantStop: CoreDiagnostic | null }
function capacityStopped(boundary: WorldState, code: SaveCapacityRejectionCode): AdvanceTicksResult {
  const paused = { ...boundary, clock: setPauseReason(boundary.clock, 'save-capacity', true) };
  // An imported boundary may be at the exact cap: preserve its bytes/identity and
  // let ApplicationSession expose a recoverable read-only stop without a saved addition.
  return { world: measureWorldSaveBytes(paused, { saveVersion: 7 }) <= SAVE_FILE_LIMIT_BYTES ? paused : boundary, capacityStop: code, invariantStop: null };
}
function obligationMutation(before: WorldState, after: WorldState): boolean {
  const simple = new Set(['clock', 'disciples', 'transactions', 'automaticProduction']);
  for (const key of Object.keys(after) as (keyof WorldState)[]) if (!simple.has(key) && before[key] !== after[key]) return true;
  if (before.automaticProduction.journal !== after.automaticProduction.journal || before.automaticProduction.pins !== after.automaticProduction.pins
    || Object.keys(before.automaticProduction.live).length !== Object.keys(after.automaticProduction.live).length) return true;
  const ids = Object.keys(after.transactions);
  if (ids.length !== Object.keys(before.transactions).length) return true;
  return ids.some((id) => { const left = before.transactions[id]; const right = after.transactions[id]!;
    return !left || left.worksiteId !== right.worksiteId || left.storageId !== right.storageId
      || String(left.activeTicks).length !== String(right.activeTicks).length; });
}

function checkTickCandidate(boundary: WorldState, next: WorldState, encodedBytes: number): number {
  if (next === boundary) return encodedBytes;
  const delta = worldSaveByteDelta(boundary, next, { saveVersion: 7 });
  const candidateBytes = encodedBytes + delta;
  if (candidateBytes > SAVE_FILE_LIMIT_BYTES) throw new SaveCapacityStop();
  if (delta > 0 || obligationMutation(boundary, next)) {
    const before = worldAutomaticBudgetInput(boundary); const candidate = worldAutomaticBudgetInput(next);
    const released = next.activeProductionTransactionIds.length < boundary.activeProductionTransactionIds.length;
    const verified = released ? verifyReservedRelease(before, candidate) : verifySaveCandidate(candidate);
    const budget = verified.budget;
    const existingUnknownQueue = budget.reason === 'unsupported-pending' && budget.actualFits && budget.availableBytes >= 0
      && budget.archiveSlotsFit && budget.archiveExpansionFit && next.pendingCommands.every((command) => boundary.pendingCommands.includes(command));
    if (!verified.ok && !existingUnknownQueue) throw new SaveCapacityStop(verified.code);
  }
  return candidateBytes;
}

/** Integer ticks only. Speed is converted by the frame adapter, never inside simulation. */
export function advanceTicksWithStatus(world: WorldState, steps: number, commands: readonly Command[] = []): AdvanceTicksResult {
  assertNonNegativeInteger(steps, 'steps');
  if (steps === 0 && commands.length === 0) return { world: withCultivationPause(world), capacityStop: null, invariantStop: null };
  let next: WorldState;
  try { next = withCultivationPause(commands.length ? enqueueCommands(world, commands) : world); }
  catch (error) { if (error instanceof SaveCapacityAdmissionError) return capacityStopped(world, error.code); throw error; }
  // A scalar local to this synchronous call; remeasured from caller input on every call.
  let encodedBytes = measureWorldSaveBytes(next, { saveVersion: 7 });
  for (let index = 0; index < steps; index += 1) {
    const boundary = next;
    try {
      next = beforeWorldExpeditionTick(next);
      next = withCultivationPause(next);
      if (isPaused(next.clock)) { encodedBytes = checkTickCandidate(boundary, next, encodedBytes); break; }
      const due = next.pendingCommands.filter((command) => command.issuedTick <= next.clock.simulationTick).sort(compareCommands);
      for (const command of due) {
        const operation = dispatchCommand(next, command, { existingQueuedCommand: true });
        if (['SAVE_CAPACITY_EXCEEDED', 'SAVE_OBLIGATION_UNBOUNDED'].includes(operation.result.rejection?.code ?? '')) throw new SaveCapacityStop(operation.result.rejection!.code as SaveCapacityRejectionCode);
        next = operation.world;
        // Keep later due cancellations visible to earlier ownership transitions.
        const pendingIndex = next.pendingCommands.findIndex((pending) => compareCommands(pending, command) === 0);
        if (pendingIndex >= 0) next = { ...next, pendingCommands: next.pendingCommands.filter((_, index) => index !== pendingIndex) };
      }
      if (due.length) next = cleanupAutomaticPendingPins(next);
      next = { ...next, clock: tickClock(next.clock) };
      // Chronology/expiry and monthly progression settle before a worker can deliver on this tick.
      next = advanceWorldCultivation(next);
      next = reconcileWorldExpeditionDeaths(next);
      next = tickWorldAutomaticWork(next);
      next = tickProduction(next);
      next = afterWorldExpeditionTick(next);
      encodedBytes = checkTickCandidate(boundary, next, encodedBytes);
    } catch (error) {
      if (error instanceof SaveCapacityStop || isSaveCapacityError(error)) return capacityStopped(boundary, error instanceof SaveCapacityStop ? error.code : 'SAVE_CAPACITY_EXCEEDED');
      // Roll the incomplete tick back, preserve a diagnosable complete boundary, and stop.
      const diagnostic: CoreDiagnostic = { code: 'INVARIANT_FAILURE', tick: boundary.clock.simulationTick,
        message: error instanceof Error ? error.message : 'Unknown kernel invariant failure' };
      const diagnosed = { ...boundary, clock: setPauseReason(boundary.clock, 'error', true), diagnostics: [...boundary.diagnostics, diagnostic] };
      return { world: measureWorldSaveBytes(diagnosed, { saveVersion: 7 }) <= SAVE_FILE_LIMIT_BYTES ? diagnosed : boundary,
        capacityStop: null, invariantStop: diagnostic };
    }
  }
  return { world: next, capacityStop: null, invariantStop: null };
}
/** Compatibility World-only API. ApplicationSession uses the typed status variant. */
export function advanceTicks(world: WorldState, steps: number, commands: readonly Command[] = []): WorldState {
  return advanceTicksWithStatus(world, steps, commands).world;
}

/** Replay hash omits rate/pause controls; snapshot checksum includes them. Mode remains authoritative. */
export function domainHash(world: WorldState): string {
  const { speed: _speed, pauseReasons: _pauseReasons, ...clock } = world.clock;
  return stableHash({ ...world, clock });
}
