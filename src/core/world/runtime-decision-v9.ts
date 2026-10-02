/** Internal complete-boundary decision shared verbatim with the strict oracle.
 * Assessment parameters are implementation detail, never an instance API. */
import type { ManagementCapacityV9 } from './management-capacity-v9';
import { inspectReservedDischargesV9, type ReservedDischargesV9 } from './sect-release-v9';
import type { CandidateCapacityDecisionV9, CapacityLimitedResultV9 } from './runtime-capacity-v9';
import type { SaveCapacityRejectionCode } from '../save-budget';
import type { WorldStateV9 } from './v9-types';

export const TEACHING_DETAIL = 'Teaching continuation is unsupported by this limited gate; use the existing .3 record-only API until a finite continuation proof is implemented';
export const hasTeaching = (world: WorldStateV9): boolean => world.cultivation.disciples.some(profile => profile.teaching !== null);
export function actualDimensionsFit(value: ManagementCapacityV9): boolean {
  return value.actualFits && Object.keys(value.current).every(key => Number.isSafeInteger(value.current[key]) && value.current[key]! >= 0
    && Number.isSafeInteger(value.limits[key]) && value.current[key]! <= value.limits[key]!);
}
/** The query reports overflowing summed costs as Infinity. Compare the actual
 * integer operands instead, so no rounding or Infinity creates release authority. */
function unionFitsOrNonincreasing(before: ManagementCapacityV9, after: ManagementCapacityV9): boolean {
  const keys = new Set([...Object.keys(before.costs), ...Object.keys(after.costs)]);
  for (const key of keys) {
    const hasBefore = Object.hasOwn(before.costs, key); const hasAfter = Object.hasOwn(after.costs, key);
    const limit = hasAfter ? after.limits[key] : before.limits[key];
    if (!Number.isSafeInteger(limit) || limit! < 0 || hasBefore && hasAfter && before.limits[key] !== after.limits[key]) return false;
    const operands = [hasBefore ? before.current[key] : 0, hasBefore ? before.reserved[key] : 0,
      hasAfter ? after.current[key] : 0, hasAfter ? after.reserved[key] : 0];
    if (!operands.every(value => Number.isSafeInteger(value) && value! >= 0)) return false;
    const prior = BigInt(operands[0]!) + BigInt(operands[1]!); const next = BigInt(operands[2]!) + BigInt(operands[3]!);
    if (next > BigInt(limit!) && next > prior) return false;
  }
  return true;
}
export function decision(before: WorldStateV9, after: WorldStateV9, previous: ManagementCapacityV9, current: ManagementCapacityV9): CandidateCapacityDecisionV9 {
  const fail = (reason: CandidateCapacityDecisionV9['reason'], code: Exclude<CandidateCapacityDecisionV9['code'], null>, details: readonly string[]): CandidateCapacityDecisionV9 =>
    ({ ok: false, code, reason, assessment: current, discharged: [], details });
  if (!previous.supported || !current.supported) return fail('unsupported-source', 'SAVE_OBLIGATION_UNBOUNDED',
    [...previous.sourceRecordIssues, ...previous.unknowns, ...current.sourceRecordIssues, ...current.unknowns]);
  if (hasTeaching(before) || hasTeaching(after)) return fail('unsupported-continuation', 'UNSUPPORTED_CONTINUATION', [TEACHING_DETAIL]);
  if (!actualDimensionsFit(previous) || !actualDimensionsFit(current)) return fail('actual-capacity', 'SAVE_CAPACITY_EXCEEDED', ['Actual complete-boundary hard limit exceeded']);
  if (current.fits) return { ok: true, code: null, reason: 'ordinary', assessment: current, discharged: [], details: [] };
  if (!unionFitsOrNonincreasing(previous, current)) return fail('future-capacity', 'SAVE_CAPACITY_EXCEEDED', ['A deficient capacity dimension increased']);
  let release: ReservedDischargesV9;
  try { release = inspectReservedDischargesV9(before, after,
    { sect: previous.sect!, progression: previous.progression! }, { sect: current.sect!, progression: current.progression! }); }
  catch (error) { return fail('unsupported-source', 'SAVE_OBLIGATION_UNBOUNDED', [error instanceof Error ? error.message : 'Invalid release evidence']); }
  if (!release.supported || release.discharged.length === 0) return fail('future-capacity', 'SAVE_CAPACITY_EXCEEDED',
    release.unknowns.length ? release.unknowns : ['No authenticated reserved owner was discharged']);
  return { ok: true, code: null, reason: 'reserved-recovery', assessment: current, discharged: release.discharged, details: [] };
}
export function refused(commandId: string, code: SaveCapacityRejectionCode | 'UNSUPPORTED_CONTINUATION'): CapacityLimitedResultV9 {
  return code === 'UNSUPPORTED_CONTINUATION'
    ? { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code, detail: TEACHING_DETAIL } }
    : { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code } };
}
