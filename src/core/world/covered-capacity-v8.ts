import { SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { assessWorldProgressionCapacity } from './progression-capacity';
import { remainingRunCommandReserve, returnClearanceReservation } from './expedition-return-capacity';
import type { WorldStateV8 } from './v8-types';
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

/** Outer kernel grammar plus the complete derived domain effect ID. This helper
 * never clips, hashes, rewrites or allocates an identity. */
export function isRegisteredExitCommandId(runId: string, commandId: string): boolean {
  const ordinal = Number(runId.slice(4));
  return Number.isSafeInteger(ordinal) && ordinal > 0 && ordinal < Number.MAX_SAFE_INTEGER && runId === `run:${ordinal}`
    && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(commandId)
    && !['constructor', 'prototype', '__proto__'].includes(commandId)
    && `${runId}/command/${commandId}`.length <= 120;
}
