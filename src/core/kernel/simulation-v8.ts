import { cleanupAutomaticPendingPins } from '../economy/automatic-production';
import { tickProduction } from '../economy/production';
import { afterWorldExpeditionTickV8, beforeWorldExpeditionTickV8, reconcileWorldExpeditionDeathsV8 } from '../expeditions/v8-world-adapter';
import { advanceWorldCultivationV8, withCultivationPauseV8 } from '../world/cultivation-bridge-v8';
import { tickWorldAutomaticWorkV8 } from '../world/automatic-work-bridge-v8';
import { prepareWorldEstateSettlement } from '../world/legacy-bridge';
import { assessCoveredBoundaryCapacityV8, verifyCandidateBoundaryV8 } from '../world/runtime-capacity-v8';
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
function stopped(world: WorldStateV8, code: SaveCapacityRejectionCode): AdvanceTicksResultV8 {
  const paused = { ...world, clock: setPauseReason(world.clock, 'save-capacity', true) };
  return { world: measureWorldSaveBytes(paused, { saveVersion: 8 }) <= SAVE_FILE_LIMIT_BYTES ? paused : world, capacityStop: code, invariantStop: null };
}
function obligationsChanged(before: WorldStateV8, after: WorldStateV8): boolean {
  return before.builds !== after.builds || before.cultivation !== after.cultivation || before.inventory !== after.inventory
    || before.history !== after.history || before.commandReceipts !== after.commandReceipts || before.events !== after.events
    || before.activeProductionTransactionIds !== after.activeProductionTransactionIds || before.reservations !== after.reservations
    || before.automaticProduction.journal !== after.automaticProduction.journal || before.automaticProduction.pins !== after.automaticProduction.pins
    || before.expedition.run !== after.expedition.run || before.legacy !== after.legacy || before.campaign !== after.campaign;
}
function check(before: WorldStateV8, after: WorldStateV8, bytes: number, wireCeiling: number): { bytes: number; wireCeiling: number } {
  const nextBytes = bytes + worldSaveByteDelta(before, after, { saveVersion: 8 });
  if (nextBytes > SAVE_FILE_LIMIT_BYTES) throw new CapacityStop('SAVE_CAPACITY_EXCEEDED');
  if (after.expedition.battle && canonicalUtf8ByteLength(after.expedition.battle) > 262_144) throw new CapacityStop('SAVE_OBLIGATION_UNBOUNDED');
  if (obligationsChanged(before, after)) {
    const proof = verifyCandidateBoundaryV8(before, after); if (!proof.ok) throw new CapacityStop(proof.code);
    wireCeiling = assessCoveredBoundaryCapacityV8(after).wireCeiling;
  } else if (nextBytes > wireCeiling) throw new CapacityStop('SAVE_CAPACITY_EXCEEDED');
  return { bytes: nextBytes, wireCeiling };
}
/** Candidate v8 engine. No legacy alias or imported source is silently upgraded. */
export function advanceTicksWithStatusV8(world: WorldStateV8, steps: number, commands: readonly CommandV8[] = []): AdvanceTicksResultV8 {
  assertNonNegativeInteger(steps, 'steps');
  if (!steps && !commands.length) return { world: withCultivationPauseV8(world), capacityStop: null, invariantStop: null };
  let next: WorldStateV8;
  try { next = withCultivationPauseV8(commands.length ? enqueueCommandsV8(world, commands) : world); }
  catch (error) { if (error instanceof SaveCapacityAdmissionError) return stopped(world, error.code); throw error; }
  let bytes = measureWorldSaveBytes(next, { saveVersion: 8 });
  let wireCeiling = assessCoveredBoundaryCapacityV8(next).wireCeiling;
  for (let index = 0; index < steps; index += 1) {
    const boundary = next;
    try {
      next = withCultivationPauseV8(beforeWorldExpeditionTickV8(next));
      if (isPaused(next.clock)) { ({ bytes, wireCeiling } = check(boundary, next, bytes, wireCeiling)); break; }
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
      ({ bytes, wireCeiling } = check(boundary, next, bytes, wireCeiling));
    } catch (error) {
      if (error instanceof CapacityStop || isSaveCapacityError(error)) return stopped(boundary, error instanceof CapacityStop ? error.code : 'SAVE_CAPACITY_EXCEEDED');
      const diagnostic: CoreDiagnostic = { code: 'INVARIANT_FAILURE', tick: boundary.clock.simulationTick, message: error instanceof Error ? error.message : 'Unknown v8 invariant' };
      const diagnosed = { ...boundary, clock: setPauseReason(boundary.clock, 'error', true), diagnostics: [...boundary.diagnostics, diagnostic] };
      return { world: measureWorldSaveBytes(diagnosed, { saveVersion: 8 }) <= SAVE_FILE_LIMIT_BYTES ? diagnosed : boundary, capacityStop: null, invariantStop: diagnostic };
    }
  }
  return { world: next, capacityStop: null, invariantStop: null };
}
export function advanceTicksV8(world: WorldStateV8, steps: number, commands: readonly CommandV8[] = []): WorldStateV8 { return advanceTicksWithStatusV8(world, steps, commands).world; }
export function domainHashV8(world: WorldStateV8): string { const { speed: _speed, pauseReasons: _pauseReasons, ...clock } = world.clock; return stableHash({ ...world, clock }); }
