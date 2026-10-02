/** Fixed complete-v10 candidate decision. No caller-provided assessment, budget,
 * validator, release flag or teaching exemption is an authority at this boundary. */
import type { SaveCapacityRejectionCode } from '../save-budget';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { assessManagementCapacityV10 } from './management-capacity-v10';
import type { CandidateCapacityDecisionV10, CapacityLimitedResultV10 } from './runtime-capacity-v10';
import { inspectReservedDischargesV10 } from './sect-release-v10';
import { actualDimensionsFitV10, authenticTeachingTransitionV10, deficitDoesNotIncreaseV10, hasTeachingV10,
  inspectTeachingContinuationV10, TEACHING_DETAIL_V10 } from './teaching-continuation-v10';
import { captureV10RecordData } from './v10-sect-records';

export function decisionV10(before: WorldStateV10, after: WorldStateV10): CandidateCapacityDecisionV10 {
  // A capture failure must not read either hostile input a second time, or inspect
  // the thrown object's prototype/message. This diagnostic has no admission power.
  let current = assessManagementCapacityV10(null as unknown as WorldStateV10);
  const fail = (reason: CandidateCapacityDecisionV10['reason'], code: Exclude<CandidateCapacityDecisionV10['code'], null>,
    details: readonly string[]): CandidateCapacityDecisionV10 => ({ ok: false, code, reason, assessment: current, discharged: [], details });
  try {
    const source = captureV10RecordData(before) as WorldStateV10;
    const candidate = captureV10RecordData(after) as WorldStateV10;
    const previous = assessManagementCapacityV10(source); current = assessManagementCapacityV10(candidate);
    if (!previous.supported || !current.supported) return fail('unsupported-source', 'SAVE_OBLIGATION_UNBOUNDED',
      [...previous.sourceRecordIssues, ...previous.unknowns, ...current.sourceRecordIssues, ...current.unknowns]);
    if (!actualDimensionsFitV10(previous) || !actualDimensionsFitV10(current)) return fail('actual-capacity', 'SAVE_CAPACITY_EXCEEDED',
      ['Actual complete-boundary hard limit exceeded']);
    if (hasTeachingV10(source) || hasTeachingV10(candidate)) {
      const sourceTeaching = inspectTeachingContinuationV10(source); const candidateTeaching = inspectTeachingContinuationV10(candidate);
      if (!sourceTeaching.supported || !candidateTeaching.supported) return fail('unsupported-continuation', 'UNSUPPORTED_CONTINUATION',
        [TEACHING_DETAIL_V10, ...sourceTeaching.unknowns, ...candidateTeaching.unknowns]);
    }
    if (!authenticTeachingTransitionV10(source, candidate)) return fail('unsupported-continuation', 'UNSUPPORTED_CONTINUATION',
      ['Teaching transition has no actual fixed-v10 reducer witness']);
    // The fixed release inspector also proves complete same-source command/tick
    // equality, even when no owner disappears. Fitting unrelated Worlds are not
    // an executable transition and must never receive candidate admission.
    const release = inspectReservedDischargesV10(source, candidate);
    if (!release.supported) return fail('unsupported-transition', 'SAVE_OBLIGATION_UNBOUNDED', release.unknowns);
    if (current.fits) return { ok: true, code: null, reason: 'ordinary', assessment: current, discharged: [], details: [] };
    // Exact integer operands are compared for EVERY prior/candidate dimension,
    // including newly introduced dimensions. A shrinking wire deficit cannot
    // excuse growth in an unrelated deficient reader, counter or owner limit.
    if (!deficitDoesNotIncreaseV10(previous, current)) return fail('future-capacity', 'SAVE_CAPACITY_EXCEEDED',
      ['A deficient capacity dimension increased']);
    if (release.discharged.length === 0) return fail('future-capacity', 'SAVE_CAPACITY_EXCEEDED',
      release.unknowns.length ? release.unknowns : ['No authenticated reserved owner was discharged']);
    return { ok: true, code: null, reason: 'reserved-recovery', assessment: current, discharged: release.discharged, details: [] };
  } catch {
    return fail('unsupported-source', 'SAVE_OBLIGATION_UNBOUNDED', ['Invalid bounded v10 candidate data or fixed proof']);
  }
}

export function refusedV10(commandId: string, code: SaveCapacityRejectionCode | 'UNSUPPORTED_CONTINUATION'): CapacityLimitedResultV10 {
  return code === 'UNSUPPORTED_CONTINUATION'
    ? { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code, detail: TEACHING_DETAIL_V10 } }
    : { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code } };
}
