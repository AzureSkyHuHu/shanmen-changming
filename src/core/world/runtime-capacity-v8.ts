import { canonicalUtf8ByteLength, measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import type { SaveCapacityRejectionCode } from '../save-budget';
import { verifyWorldProgressionTransition } from './progression-capacity';
import { assessRunReturnInventory, returnClearanceReservation } from './expedition-return-capacity';
import { assessRegisteredExpeditionExitBudget, REGISTERED_EXPEDITION_EXIT_QUOTAS, type RegisteredExpeditionExitBudget } from './expedition-exit-budget';
import { classifyAutomaticHandle, isAutomaticJobId } from '../economy/automatic-production';
import { lookupProduction } from './history-access';
import { verifyProgressionReservationDischarges } from '../save-budget/progression-bounds';
import type { WorldStateV8 } from './v8-types';
const active = (world: WorldStateV8) => !!world.expedition.run && world.expedition.run.phase !== 'Ended';
export { assessCoveredBoundaryCapacityV8 } from './covered-capacity-v8';
import { assessCoveredBoundaryCapacityV8 } from './covered-capacity-v8';
function completeReservedProgress(before: WorldStateV8, after: WorldStateV8): boolean {
  const previous = before.expedition.run; const next = after.expedition.run;
  if (!previous || previous.phase === 'Ended' || next?.runId !== previous.runId) return false;
  const required = new Set(['time.admit', 'time.commit', 'encounter.begin', 'encounter.resolve', 'members.died', 'offer.choose', 'offer.supplies', 'run.end', 'run.settle']);
  const suffix = next.commandLog.slice(previous.commandLog.length);
  if (suffix.length && suffix.every(command => required.has(command.kind))) return true;
  const earlier = returnClearanceReservation(before).discardResourceIds;
  const remaining = returnClearanceReservation(after).discardResourceIds;
  // Only an actual owned-inventory reduction which clears a required resource
  // discharges one slot; partial discards and unrelated commands keep it reserved.
  return earlier.some(id => !remaining.includes(id) && after.inventory[id].owned < before.inventory[id].owned);
}
/** Current complete candidate plus all proved dimensions. No generic "release"
 * flag can bypass a cap: each covered cost must fit or decrease after real work. */
function verifyLegacyOrManagementBoundaryV8(before: WorldStateV8, after: WorldStateV8):
  { ok: true } | { ok: false; code: SaveCapacityRejectionCode } {
  if (measureWorldSaveBytes(after, { saveVersion: 8 }) > SAVE_FILE_LIMIT_BYTES) return { ok: false, code: 'SAVE_CAPACITY_EXCEEDED' };
  const covered = assessCoveredBoundaryCapacityV8(after);
  if (active(after)) {
    if (!assessRunReturnInventory(after).fits) return { ok: false, code: 'SAVE_OBLIGATION_UNBOUNDED' };
    if (canonicalUtf8ByteLength(after.expedition.run) > 196_608 || after.expedition.battle && canonicalUtf8ByteLength(after.expedition.battle) > 262_144) return { ok: false, code: 'SAVE_OBLIGATION_UNBOUNDED' };
    if (covered.fits) return { ok: true };
  } else {
    const progression = verifyWorldProgressionTransition(before, after, 'reserved-progress');
    if (progression.ok) return { ok: true };
    const assessment = progression.assessment;
    const sameQueue = after.pendingCommands.every(command => before.pendingCommands.includes(command));
    if (sameQueue && assessment.unknowns.length === 1 && assessment.base.reason === 'unsupported-pending'
      && Object.keys(covered.costs).every(key => covered.costs[key]! <= covered.limits[key]!)) return { ok: true };
  }
  if (covered.supported && covered.actualFits && completeReservedProgress(before, after)) {
    const previous = assessCoveredBoundaryCapacityV8(before);
    if (previous.supported && Object.keys(covered.costs).every(key => covered.costs[key]! <= previous.costs[key]!)) return { ok: true };
  }
  return { ok: false, code: covered.supported ? 'SAVE_CAPACITY_EXCEEDED' : 'SAVE_OBLIGATION_UNBOUNDED' };
}

/** A reservation is discharged only by an authenticated real owner transition.
 * Optional encounter entry, reward choices and rerolls are deliberately absent.
 * Both complete Worlds are validated by the registered budget query below. */
function completedRegisteredExitWork(before: WorldStateV8, after: WorldStateV8): boolean {
  const previous = before.expedition.run; const next = after.expedition.run;
  if (!previous || previous.phase === 'Ended' || next?.runId !== previous.runId) return false;
  const suffix = next.commandLog.slice(previous.commandLog.length);
  if (suffix.length && suffix.every(command => {
    if (command.kind === 'time.admit') return ['Travelling', 'Ending'].includes(previous.phase) && next.admittedCheckpoint !== null;
    if (command.kind === 'time.commit') return previous.admittedCheckpoint !== null
      && next.travelLedger.some(row => row.checkpointId === previous.admittedCheckpoint!.checkpointId);
    if (command.kind === 'members.died') return command.discipleIds.every(id => previous.members.some(member => member.discipleId === id && member.alive)
      && next.members.some(member => member.discipleId === id && !member.alive));
    if (command.kind === 'run.end') return command.reason === 'safeRetreat' && next.settlement?.reason === 'safeRetreat';
    if (command.kind === 'encounter.resolve') return previous.phase === 'InEncounter' && command.result.outcome !== 'victory'
      && next.settlement !== null && next.encounterResults.some(result => result.resultId === command.result.resultId);
    return command.kind === 'run.settle' && next.phase === 'Ended' && next.settlement?.committed === true
      && after.expedition.history.some(history => history.runId === next.runId && history.settlementId === next.settlement!.settlementId); // Proof is conditional; the full validator checks its actual owners.
  })) return true;
  const cursor = before.expedition.travel;
  if (cursor && after.clock.calendarTick > before.clock.calendarTick && after.clock.calendarTick <= cursor.targetCalendarTick
    && after.expedition.travel?.checkpointId === cursor.checkpointId) return true;
  const earlier = returnClearanceReservation(before).discardResourceIds;
  const remaining = returnClearanceReservation(after).discardResourceIds;
  if (earlier.some(id => !remaining.includes(id) && after.inventory[id].owned < before.inventory[id].owned)) return true;
  if (before.activeProductionTransactionIds.some(id => {
    if (after.activeProductionTransactionIds.includes(id)) return false;
    if (!isAutomaticJobId(id)) return lookupProduction(after, id)?.state === 'Cancelled';
    const terminal = classifyAutomaticHandle(after, id);
    return terminal.kind === 'pinned' && terminal.pin.state === 'Cancelled';
  })) return true;
  if (before.cultivation === after.cultivation && before.builds === after.builds && before.legacy === after.legacy) return false;
  const left = assessCoveredBoundaryCapacityV8(before).progression.progression;
  const right = assessCoveredBoundaryCapacityV8(after).progression.progression;
  const discharges = verifyProgressionReservationDischarges({ world: before, assessment: left }, { world: after, assessment: right });
  return discharges.supported && discharges.discharged.length > 0;
}
/** Complete publication gate. Registered runs pay both the current and terminal
 * proof copies. Frozen legacy continuation retains its separate prior gate. */
export function verifyCandidateBoundaryV8(before: WorldStateV8, after: WorldStateV8):
  { ok: true; registeredExitBudget?: RegisteredExpeditionExitBudget } | { ok: false; code: SaveCapacityRejectionCode } {
  const registered = (active(before) && before.expedition.protocol !== 'legacy-v2')
    || (active(after) && after.expedition.protocol !== 'legacy-v2');
  if (!registered) return verifyLegacyOrManagementBoundaryV8(before, after);
  const assessment = assessRegisteredExpeditionExitBudget(after);
  if (assessment.fits) return { ok: true, registeredExitBudget: assessment };
  if (!assessment.supported) return { ok: false, code: 'SAVE_OBLIGATION_UNBOUNDED' };
  const quota = REGISTERED_EXPEDITION_EXIT_QUOTAS;
  // Actual hard limits are never relaxed, including when releasing a reservation.
  if (!assessment.actualFits || assessment.run.currentBytes > quota.runBytes
    || assessment.costs.worldEncounterQuota! > quota.worldEncounterBytes) return { ok: false, code: 'SAVE_CAPACITY_EXCEEDED' };
  if (!completedRegisteredExitWork(before, after)) return { ok: false, code: 'SAVE_CAPACITY_EXCEEDED' };
  const previous = assessRegisteredExpeditionExitBudget(before);
  if (previous.supported && previous.actualFits
    && Object.keys(assessment.costs).every(key => Number.isSafeInteger(assessment.costs[key])
      && (assessment.costs[key]! <= assessment.limits[key]! || assessment.costs[key]! <= previous.costs[key]!))) return { ok: true, registeredExitBudget: assessment };
  return { ok: false, code: 'SAVE_CAPACITY_EXCEEDED' };
}
