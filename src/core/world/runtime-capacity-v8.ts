import { canonicalUtf8ByteLength, measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import type { SaveCapacityRejectionCode } from '../save-budget';
import { assessWorldProgressionCapacity, verifyWorldProgressionTransition } from './progression-capacity';
import type { WorldStateV8 } from './v8-types';
/** Candidate-engine scope: actual complete boundaries plus the proved management
 * obligations. Run continuation remains an explicit separate acceptance gate. */
export function verifyCandidateBoundaryV8(before: WorldStateV8, after: WorldStateV8):
  { ok: true } | { ok: false; code: SaveCapacityRejectionCode } {
  if (measureWorldSaveBytes(after, { saveVersion: 8 }) > SAVE_FILE_LIMIT_BYTES) return { ok: false, code: 'SAVE_CAPACITY_EXCEEDED' };
  const active = after.expedition.run && after.expedition.run.phase !== 'Ended';
  if (!active) {
    const progression = verifyWorldProgressionTransition(before, after, 'reserved-progress');
    if (progression.ok) return { ok: true };
    // A retained unsupported legacy queue can execute one due command without
    // being retroactively rejected just because its future effects were unknown.
    const assessment = progression.assessment;
    const sameQueue = after.pendingCommands.every(command => before.pendingCommands.includes(command));
    if (sameQueue && assessment.unknowns.length === 1 && assessment.base.reason === 'unsupported-pending'
      && Object.keys(assessment.costs).every(key => assessment.costs[key]! <= assessment.limits[key]!)) return { ok: true };
    return { ok: false, code: progression.code };
  }
  const assessment = assessWorldProgressionCapacity(after);
  if (!assessment.progression.supported || !assessment.numeric.supported || !assessment.numeric.fits || assessment.base.unsupportedPendingKinds.length
    || !Object.keys(assessment.costs).every(key => assessment.costs[key]! <= assessment.limits[key]!)) return { ok: false, code: 'SAVE_CAPACITY_EXCEEDED' };
  // These explicit candidate bounds retain a saveable full boundary while the
  // final registered-run obligation proof is independently reviewed. They are
  // not presented as proof of unlimited or arbitrary-content battle growth.
  if (canonicalUtf8ByteLength(after.expedition.run) > 196_608 || after.expedition.battle && canonicalUtf8ByteLength(after.expedition.battle) > 262_144) return { ok: false, code: 'SAVE_OBLIGATION_UNBOUNDED' };
  return { ok: true };
}
