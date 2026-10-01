import { cleanupAutomaticPendingPins } from '../economy/automatic-production';
import { tickProduction } from '../economy/production';
import { afterWorldExpeditionTickV8, beforeWorldExpeditionTickV8, reconcileWorldExpeditionDeathsV8 } from '../expeditions/v8-world-adapter';
import { advanceWorldCultivationV8, withCultivationPauseV8 } from '../world/cultivation-bridge-v8';
import { tickWorldAutomaticWorkV8 } from '../world/automatic-work-bridge-v8';
import { prepareWorldEstateSettlement } from '../world/legacy-bridge';
import { assessCoveredBoundaryCapacityV8, verifyCandidateBoundaryV8 } from '../world/runtime-capacity-v8';
import { assessRegisteredExpeditionExitBudget, REGISTERED_EXPEDITION_EXIT_QUOTAS as EXIT_QUOTA, type RegisteredExpeditionExitBudget } from '../world/expedition-exit-budget';
import { cloneWorldWithSharedHistory } from '../world/history-access';
import { worldSaveByteDelta } from '../world/save-byte-delta';
import type { WorldStateV8 } from '../world/v8-types';
import { canonicalUtf8ByteLength, measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import type { SaveCapacityRejectionCode } from '../save-budget';
import { isPaused, setPauseReason, tickClock } from './clock';
import { compareCommandsV8, dispatchCommandV8, enqueueCommandsV8 } from './commands-v8';
import { isSaveCapacityError, SaveCapacityAdmissionError } from './commands';
import type { CommandV8 } from './contracts-v8';
import type { CoreDiagnostic } from './contracts';
import { assertNonNegativeInteger } from './numeric';
import { stableHash } from './serialization';
export interface AdvanceTicksResultV8 { world: WorldStateV8; capacityStop: SaveCapacityRejectionCode | null; invariantStop: CoreDiagnostic | null }
class CapacityStop extends Error { constructor(readonly code: SaveCapacityRejectionCode) { super(code); } }
/** Exact capacity() vocabulary in combat/runtime/engine.ts; unrelated range,
 * arithmetic, content and stack failures remain invariant diagnostics. */
function isBattleCapacityError(error: unknown): boolean {
  return error instanceof RangeError && /^Battle (trigger ledgers|statuses|sources|shields|charges|modifiers) capacity exceeded$/.test(error.message);
}
function stopped(world: WorldStateV8, code: SaveCapacityRejectionCode): AdvanceTicksResultV8 {
  const paused = { ...world, clock: setPauseReason(world.clock, 'save-capacity', true) };
  return { world: measureWorldSaveBytes(paused, { saveVersion: 8 }) <= SAVE_FILE_LIMIT_BYTES ? paused : world, capacityStop: code, invariantStop: null };
}
function obligationsChanged(before: WorldStateV8, after: WorldStateV8): boolean {
  return before.builds !== after.builds || before.cultivation !== after.cultivation || before.inventory !== after.inventory
    || before.history !== after.history || before.commandReceipts !== after.commandReceipts || before.events !== after.events
    || before.activeProductionTransactionIds !== after.activeProductionTransactionIds || before.reservations !== after.reservations
    || before.automaticProduction.journal !== after.automaticProduction.journal || before.automaticProduction.pins !== after.automaticProduction.pins
    || before.expedition.run !== after.expedition.run || before.legacy !== after.legacy || before.campaign !== after.campaign
    || before.sequences !== after.sequences || before.randomStreams !== after.randomStreams || before.pendingCommands !== after.pendingCommands
    || before.expedition.travel !== after.expedition.travel || before.expedition.deathMappings !== after.expedition.deathMappings
    || before.expedition.effectReceipts !== after.expedition.effectReceipts || before.expedition.history !== after.expedition.history
    || before.diagnostics !== after.diagnostics || before.unlocks !== after.unlocks
    // Manual terminal fallback preserves live activeTicks/worksite/storage fields
    // in more than one future placement. Its reserve changes even before completion.
    || registeredActive(before) && before.transactions !== after.transactions;
}
const registeredActive = (world: WorldStateV8) => !!world.expedition.run && world.expedition.run.phase !== 'Ended' && world.expedition.protocol !== 'legacy-v2';
/** Only called inside one synchronous advance invocation, after strict source
 * authentication and detachment. No global cache, save flag or caller token can
 * authorize this path. Shared subtrees were recursively frozen by this scope. */
function incrementalExitBudget(before: WorldStateV8, after: WorldStateV8, previous: RegisteredExpeditionExitBudget,
  bytes: number): RegisteredExpeditionExitBudget {
  if (!Object.isFrozen(before) || !Object.isFrozen(after) || !previous.supported || !previous.plan
    || before.expedition.run !== after.expedition.run) throw new CapacityStop('SAVE_OBLIGATION_UNBOUNDED');
  const calendar = after.clock.calendarTick - before.clock.calendarTick;
  if (calendar < 0 || calendar > 1 || calendar > previous.plan.calendarTicks
    || calendar && !before.expedition.travel) throw new CapacityStop('SAVE_OBLIGATION_UNBOUNDED');
  const encounterBytes = canonicalUtf8ByteLength(after.expedition.battle);
  const runBytes = canonicalUtf8ByteLength(after.expedition.run);
  const fixedDelta = bytes - previous.peak.encodedWorldBytes
    - (encounterBytes - canonicalUtf8ByteLength(before.expedition.battle));
  // An active run always owns run-build/shared-counter-width-growth. Its typed
  // replacement contains both these scalars. Spend exactly ONE copy of their
  // actual digit growth; other lifecycle copies stay deliberately conservative.
  const clockGrowth = canonicalUtf8ByteLength(after.clock.simulationTick) - canonicalUtf8ByteLength(before.clock.simulationTick)
    + canonicalUtf8ByteLength(after.clock.calendarTick) - canonicalUtf8ByteLength(before.clock.calendarTick);
  const peak = { ...previous.peak, encodedWorldBytes: bytes, fixedWorldBytes: previous.peak.fixedWorldBytes + fixedDelta,
    progressionBytes: previous.peak.progressionBytes - clockGrowth, totalBytes: previous.peak.totalBytes + fixedDelta - clockGrowth };
  // Form the one-tick delta BEFORE addition. Adding two near-MAX absolute
  // counters and subtracting later can round away the very last reserved tick.
  const simulationDelta = after.clock.simulationTick - before.clock.simulationTick - calendar;
  if (!Number.isSafeInteger(simulationDelta) || simulationDelta < 0 || simulationDelta > 1)
    throw new CapacityStop('SAVE_OBLIGATION_UNBOUNDED');
  const simulationTick = previous.costs.simulationTick! > Number.MAX_SAFE_INTEGER - simulationDelta
    ? Number.MAX_SAFE_INTEGER + 1 : previous.costs.simulationTick! + simulationDelta;
  const costs: Record<string, number> = { ...previous.costs, wireBytes: peak.totalBytes, worldEncounterQuota: encounterBytes,
    runQuota: runBytes + previous.run.finishDeltaBytes,
    simulationTick };
  const violations = Object.keys(costs).filter(key => !Number.isSafeInteger(costs[key]) || costs[key]! < 0 || costs[key]! > previous.limits[key]!);
  return { ...previous, costs, violations, fits: violations.length === 0, actualFits: bytes <= SAVE_FILE_LIMIT_BYTES, peak,
    plan: { ...previous.plan, calendarTicks: previous.plan.calendarTicks - calendar } };
}
interface TickCapacity { bytes: number; wireCeiling: number; exit: RegisteredExpeditionExitBudget | null }
function check(before: WorldStateV8, after: WorldStateV8, capacity: TickCapacity): TickCapacity {
  const bytes = capacity.bytes + worldSaveByteDelta(before, after, { saveVersion: 8 });
  if (bytes > SAVE_FILE_LIMIT_BYTES) throw new CapacityStop('SAVE_CAPACITY_EXCEEDED');
  if (after.expedition.battle && canonicalUtf8ByteLength(after.expedition.battle) > EXIT_QUOTA.worldEncounterBytes)
    throw new CapacityStop('SAVE_CAPACITY_EXCEEDED');
  let exit = capacity.exit;
  if (obligationsChanged(before, after)) {
    const proof = verifyCandidateBoundaryV8(before, after); if (!proof.ok) throw new CapacityStop(proof.code);
    exit = registeredActive(after) ? proof.registeredExitBudget ?? assessRegisteredExpeditionExitBudget(after) : null;
    return { bytes, wireCeiling: exit ? SAVE_FILE_LIMIT_BYTES - (exit.peak.totalBytes - bytes) : assessCoveredBoundaryCapacityV8(after).wireCeiling, exit };
  }
  if (exit) {
    const next = incrementalExitBudget(before, after, exit, bytes);
    // A conservative delta can retain duplicate scalar reserves. If it reaches a
    // ceiling, recompute the strict complete certificate before rejecting.
    if (!next.fits) {
      const proof = verifyCandidateBoundaryV8(before, after); if (!proof.ok) throw new CapacityStop(proof.code);
      exit = proof.registeredExitBudget ?? assessRegisteredExpeditionExitBudget(after);
    } else exit = next;
    return { bytes, wireCeiling: SAVE_FILE_LIMIT_BYTES - (exit.peak.totalBytes - bytes), exit };
  }
  if (bytes > capacity.wireCeiling) throw new CapacityStop('SAVE_CAPACITY_EXCEEDED');
  return { bytes, wireCeiling: capacity.wireCeiling, exit: null };
}
/** Candidate v8 engine. No legacy alias or imported source is silently upgraded. */
export function advanceTicksWithStatusV8(world: WorldStateV8, steps: number, commands: readonly CommandV8[] = []): AdvanceTicksResultV8 {
  assertNonNegativeInteger(steps, 'steps');
  if (!steps && !commands.length) return { world: withCultivationPauseV8(world), capacityStop: null, invariantStop: null };
  // Authentication precedes detachment. Unknown imports remain byte-for-byte
  // unchanged and exportable; a capacity result must not become an error pause.
  let exit: RegisteredExpeditionExitBudget | null = null;
  if (registeredActive(world)) {
    exit = assessRegisteredExpeditionExitBudget(world);
    if (!exit.supported) return { world, capacityStop: 'SAVE_OBLIGATION_UNBOUNDED', invariantStop: null };
    if (!exit.actualFits || exit.run.currentBytes > EXIT_QUOTA.runBytes || exit.costs.worldEncounterQuota! > EXIT_QUOTA.worldEncounterBytes)
      return { world, capacityStop: 'SAVE_CAPACITY_EXCEEDED', invariantStop: null };
  }
  const owned = new WeakSet<object>();
  const freezeOwned = <T>(value: T): T => {
    if (value && typeof value === 'object' && !owned.has(value)) {
      for (const child of Object.values(value)) freezeOwned(child);
      Object.freeze(value); owned.add(value);
    }
    return value;
  };
  let next: WorldStateV8;
  try { next = withCultivationPauseV8(commands.length ? enqueueCommandsV8(world, commands) : world); }
  catch (error) { if (error instanceof SaveCapacityAdmissionError) return stopped(world, error.code); throw error; }
  if (exit) next = freezeOwned(cloneWorldWithSharedHistory(next));
  const bytes = measureWorldSaveBytes(next, { saveVersion: 8 });
  let capacity: TickCapacity = { bytes, wireCeiling: exit ? SAVE_FILE_LIMIT_BYTES - (exit.peak.totalBytes - bytes)
    : assessCoveredBoundaryCapacityV8(next).wireCeiling, exit };
  for (let index = 0; index < steps; index += 1) {
    const boundary = next;
    try {
      next = withCultivationPauseV8(beforeWorldExpeditionTickV8(next));
      if (isPaused(next.clock)) { if (capacity.exit) next = freezeOwned(next); capacity = check(boundary, next, capacity); break; }
      const due = next.pendingCommands.filter(command => command.issuedTick <= next.clock.simulationTick).sort(compareCommandsV8);
      for (const command of due) {
        const applied = dispatchCommandV8(next, command, { existingQueuedCommand: true });
        const code = applied.result.rejection?.code;
        if (code === 'SAVE_CAPACITY_EXCEEDED' || code === 'SAVE_OBLIGATION_UNBOUNDED') throw new CapacityStop(code);
        next = applied.world;
        const at = next.pendingCommands.findIndex(pending => compareCommandsV8(command, pending) === 0);
        if (at >= 0) next = { ...next, pendingCommands: next.pendingCommands.filter((_, index) => index !== at) };
      }
      if (due.length) next = cleanupAutomaticPendingPins(next);
      if (next.clock.simulationTick === Number.MAX_SAFE_INTEGER || next.clock.calendarTick === Number.MAX_SAFE_INTEGER
        || next.clock.encounterTick === Number.MAX_SAFE_INTEGER) throw new CapacityStop('SAVE_CAPACITY_EXCEEDED');
      next = { ...next, clock: tickClock(next.clock) };
      next = advanceWorldCultivationV8(next);
      next = reconcileWorldExpeditionDeathsV8(next);
      next = tickWorldAutomaticWorkV8(next);
      next = tickProduction(next);
      next = afterWorldExpeditionTickV8(next);
      if (next.cultivation.disciples.some(profile => profile.lifeState === 'dead' && !profile.activityOwner)
        || next.cultivation.deaths.some(death => !next.legacy.estates.some(estate => estate.deathId === death.deathId))) {
        const estates = prepareWorldEstateSettlement(next);
        if (!estates.ok) throw new Error(`Estate settlement failed: ${estates.details.join('; ')}`); next = estates.candidate;
      }
      if (capacity.exit) next = freezeOwned(next);
      capacity = check(boundary, next, capacity);
      if (capacity.exit) next = freezeOwned(next);
    } catch (error) {
      if (error instanceof CapacityStop || isBattleCapacityError(error) || isSaveCapacityError(error)) return stopped(boundary, error instanceof CapacityStop ? error.code : 'SAVE_CAPACITY_EXCEEDED');
      const diagnostic: CoreDiagnostic = { code: 'INVARIANT_FAILURE', tick: boundary.clock.simulationTick, message: error instanceof Error ? error.message : 'Unknown v8 invariant' };
      const diagnosed = { ...boundary, clock: setPauseReason(boundary.clock, 'error', true), diagnostics: [...boundary.diagnostics, diagnostic] };
      return { world: measureWorldSaveBytes(diagnosed, { saveVersion: 8 }) <= SAVE_FILE_LIMIT_BYTES ? diagnosed : boundary, capacityStop: null, invariantStop: diagnostic };
    }
  }
  return { world: next, capacityStop: null, invariantStop: null };
}
export function advanceTicksV8(world: WorldStateV8, steps: number, commands: readonly CommandV8[] = []): WorldStateV8 { return advanceTicksWithStatusV8(world, steps, commands).world; }
export function domainHashV8(world: WorldStateV8): string { const { speed: _speed, pauseReasons: _pauseReasons, ...clock } = world.clock; return stableHash({ ...world, clock }); }
