import { canonicalUtf8ByteLength, measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import type { SaveCapacityRejectionCode } from '../save-budget';
import { assessWorldProgressionCapacity, verifyWorldProgressionTransition } from './progression-capacity';
import { assessRunReturnInventory, remainingRunCommandReserve, returnClearanceReservation } from './expedition-return-capacity';
import type { WorldStateV8 } from './v8-types';
const active = (world: WorldStateV8) => !!world.expedition.run && world.expedition.run.phase !== 'Ended';
/** These are the proved management and return-clearance dimensions only. The
 * registered battle and terminal run-proof envelope remains a separate gate. */
export function assessCoveredBoundaryCapacityV8(world: WorldStateV8) {
  const progression = assessWorldProgressionCapacity(world);
  const clearance = returnClearanceReservation(world);
  const rows = remainingRunCommandReserve(world);
  const costs = { ...progression.costs }; const limits = { ...progression.limits };
  costs.wireBytes! += clearance.bytes;
  costs.archiveReceiptRows! += clearance.archiveRows.commandReceipts;
  costs.archiveEventRows! += clearance.archiveRows.events;
  costs.archiveCharacters! += clearance.archiveDecodedCharacters;
  costs.archiveNodes! += clearance.archiveDecodedNodes;
  costs['sequence.nextAction']! += clearance.sequenceReserve.nextAction;
  costs['sequence.nextEvent']! += clearance.sequenceReserve.nextEvent;
  costs.runCommands = rows.current + rows.reserved; limits.runCommands = rows.limit;
  const supported = progression.progression.supported && progression.numeric.supported && !progression.base.unsupportedPendingKinds.length;
  const fits = supported && progression.numeric.fits && progression.actualFits && Object.keys(costs).every(key => costs[key]! <= limits[key]!);
  return { progression, clearance, costs, limits, supported, fits, actualFits: progression.actualFits,
    wireCeiling: SAVE_FILE_LIMIT_BYTES - (costs.wireBytes! - progression.base.encodedBytes) };
}
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
export function verifyCandidateBoundaryV8(before: WorldStateV8, after: WorldStateV8):
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
