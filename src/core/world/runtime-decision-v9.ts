/** Internal complete-boundary decision shared verbatim with the strict oracle.
 * Assessment parameters are implementation detail, never an instance API. */
import type { ManagementCapacityV9 } from './management-capacity-v9';
import { inspectReservedDischargesV9, type ReservedDischargesV9 } from './sect-release-v9';
import type { CandidateCapacityDecisionV9, CapacityLimitedResultV9 } from './runtime-capacity-v9';
import type { SaveCapacityRejectionCode } from '../save-budget';
import type { WorldStateV9 } from './v9-types';

export { TEACHING_DETAIL, hasTeaching, actualDimensionsFitV9 as actualDimensionsFit } from './teaching-continuation-v9';
import { TEACHING_DETAIL, actualDimensionsFitV9 as actualDimensionsFit, deficitDoesNotIncreaseV9,
  inspectTeachingContinuationV9, authenticTeachingTransitionV9 } from './teaching-continuation-v9';
export function decision(before: WorldStateV9, after: WorldStateV9, previous: ManagementCapacityV9, current: ManagementCapacityV9): CandidateCapacityDecisionV9 {
  const fail = (reason: CandidateCapacityDecisionV9['reason'], code: Exclude<CandidateCapacityDecisionV9['code'], null>, details: readonly string[]): CandidateCapacityDecisionV9 =>
    ({ ok: false, code, reason, assessment: current, discharged: [], details });
  if (!previous.supported || !current.supported) return fail('unsupported-source', 'SAVE_OBLIGATION_UNBOUNDED',
    [...previous.sourceRecordIssues, ...previous.unknowns, ...current.sourceRecordIssues, ...current.unknowns]);
  const previousTeaching = inspectTeachingContinuationV9(before, previous); const currentTeaching = inspectTeachingContinuationV9(after, current);
  if (!previousTeaching.supported || !currentTeaching.supported) return fail('unsupported-continuation', 'UNSUPPORTED_CONTINUATION',
    [TEACHING_DETAIL, ...previousTeaching.unknowns, ...currentTeaching.unknowns]);
  if (!authenticTeachingTransitionV9(before, after)) return fail('unsupported-continuation', 'UNSUPPORTED_CONTINUATION', ['Teaching transition has no actual reducer witness']);
  if (!actualDimensionsFit(previous) || !actualDimensionsFit(current)) return fail('actual-capacity', 'SAVE_CAPACITY_EXCEEDED', ['Actual complete-boundary hard limit exceeded']);
  if (current.fits) return { ok: true, code: null, reason: 'ordinary', assessment: current, discharged: [], details: [] };
  if (!deficitDoesNotIncreaseV9(previous, current)) return fail('future-capacity', 'SAVE_CAPACITY_EXCEEDED', ['A deficient capacity dimension increased']);
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
