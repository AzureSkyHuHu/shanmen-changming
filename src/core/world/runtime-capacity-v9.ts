import { isPaused } from '../kernel/clock';
import { isCommandV9, prepareUnregisteredCommandCandidateV9 } from '../kernel/commands-v9';
import type { CommandV9, CommandResultV9 } from '../kernel/contracts-v9';
import { assertNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9 } from '../kernel/simulation-v9';
import { canonicalUtf8ByteLength } from '../save-budget';
import type { SaveCapacityRejectionCode } from '../save-budget';
import { assessTeachingManagementCapacityV9, type ManagementCapacityV9 } from './management-capacity-v9';
import { actualDimensionsFit, decision, refused, TEACHING_DETAIL } from './runtime-decision-v9';
import { inspectTeachingContinuationV9 } from './teaching-continuation-v9';
import type { WorldStateV9 } from './v9-types';

/** Internal finite continuation experiment. Record-only .3 APIs remain unchanged;
 * only independently proved disjoint lessons enter this capacity gate. */
export const CAPACITY_LIMITED_V9_SCOPE = 'unregistered-v9-recovery-gate-finite-teaching' as const;
export type CapacityLimitedResultV9 = CommandResultV9 | {
  commandId: string; status: 'rejected'; transactionId: null; eventIds: [];
  rejection: { code: 'UNSUPPORTED_CONTINUATION'; detail: string };
};
export type CandidateCapacityDecisionV9 = {
  ok: boolean; code: SaveCapacityRejectionCode | 'UNSUPPORTED_CONTINUATION' | null;
  reason: 'ordinary' | 'reserved-recovery' | 'unsupported-continuation' | 'unsupported-source' | 'actual-capacity' | 'future-capacity';
  assessment: ManagementCapacityV9; discharged: readonly string[]; details: readonly string[];
};
export interface CapacityLimitedAdvanceV9 {
  world: WorldStateV9;
  stopped: null | { kind: 'capacity' | 'invalid-records' | 'unsupported-continuation'; details: readonly string[] };
  commandResults: readonly CapacityLimitedResultV9[];
  /** Ephemeral top-level measurements, never copied into World/save/diagnostics.
   * fullQueries counts source/candidate queries only; internal teaching recovery
   * assessments and reducer replays are excluded. This is not total execution cost. */
  metrics: { fullQueries: number; normalCandidates: number; noOptionalCandidates: number };
}
/** Complete candidate query, not import/save authority. Accepts no caller-supplied
 * budget, owner/release flag, validation callback or teaching exemption. */
export function verifyCapacityLimitedCandidateV9(before: WorldStateV9, after: WorldStateV9): CandidateCapacityDecisionV9 {
  return decision(before, after, assessTeachingManagementCapacityV9(before), assessTeachingManagementCapacityV9(after));
}
/** Retries and conflicts resolve at the original record boundary before any new
 * admission. A refused candidate leaves every domain, receipt and RNG untouched. */
export function dispatchCapacityLimitedCommandV9(world: WorldStateV9, input: unknown): { world: WorldStateV9; result: CapacityLimitedResultV9 } {
  const candidate = prepareUnregisteredCommandCandidateV9(world, input);
  if (candidate.world === world) return candidate;
  const checked = verifyCapacityLimitedCandidateV9(world, candidate.world);
  return checked.ok ? candidate : { world, result: refused(candidate.result.commandId, checked.code!) };
}
/** Strict baseline: one initial top-level query, then one per complete candidate.
 * Bounded teaching recovery may perform additional internal assessments/replays;
 * these are deliberately excluded from the top-level fullQueries metric.
 * A batch owns a detached snapshot and carries its derived assessment forward;
 * no mutable caller input is frozen/cached and no before+after re-query per tick.
 * No fast path or 20Hz performance claim is made by this implementation. */
export function advanceCapacityLimitedTicksV9(world: WorldStateV9, steps: number, commands: readonly CommandV9[] = []): CapacityLimitedAdvanceV9 {
  assertNonNegativeInteger(steps, 'steps');
  const metrics = { fullQueries: 0, normalCandidates: 0, noOptionalCandidates: 0 };
  const commandResults: CapacityLimitedResultV9[] = [];
  const query = (source: WorldStateV9): ManagementCapacityV9 => { metrics.fullQueries++; return assessTeachingManagementCapacityV9(source); };
  const stopped = (boundary: WorldStateV9, kind: NonNullable<CapacityLimitedAdvanceV9['stopped']>['kind'], details: readonly string[]): CapacityLimitedAdvanceV9 =>
    ({ world: boundary, stopped: { kind, details }, commandResults, metrics });
  let owned: WorldStateV9; let published = world; let assessment: ManagementCapacityV9;
  try {
    canonicalUtf8ByteLength(world); canonicalUtf8ByteLength(commands);
    if (!Array.isArray(commands) || commands.some(command => !isCommandV9(command))) return stopped(world, 'invalid-records', ['Invalid immediate v9 commands']);
    owned = cloneJson(world); assessment = query(owned);
    if (!assessment.supported) return stopped(world, 'invalid-records', [...assessment.sourceRecordIssues, ...assessment.unknowns]);
    const sourceTeaching = inspectTeachingContinuationV9(owned, assessment);
    if (!sourceTeaching.supported) return stopped(world, 'unsupported-continuation', [TEACHING_DETAIL, ...sourceTeaching.unknowns]);
    const ordered = cloneJson(commands).slice().sort((a, b) => a.issuedTick - b.issuedTick || a.sequence - b.sequence
      || compareStable(a.commandId, b.commandId) || compareStable(canonicalStringify(a), canonicalStringify(b)));
    for (const command of ordered) {
      const prepared = prepareUnregisteredCommandCandidateV9(owned, command);
      if (prepared.world === owned) { commandResults.push(prepared.result); continue; }
      const nextAssessment = query(prepared.world); const checked = decision(owned, prepared.world, assessment, nextAssessment);
      if (!checked.ok) { commandResults.push(refused(command.commandId, checked.code!)); continue; }
      owned = prepared.world; published = owned; assessment = nextAssessment; commandResults.push(prepared.result);
    }
    const teaching = inspectTeachingContinuationV9(owned, assessment);
    if (!teaching.supported) return stopped(published, 'unsupported-continuation', [TEACHING_DETAIL, ...teaching.unknowns]);
    if (!actualDimensionsFit(assessment)) return stopped(published, 'capacity', ['Actual complete-boundary hard limit exceeded']);
  } catch (error) { return stopped(published, 'invalid-records', [error instanceof Error ? error.message : 'Invalid input']); }
  for (let index = 0; index < steps; index++) {
    if (isPaused(owned.clock)) break;
    const boundary = owned; const previousAssessment = assessment;
    let failure: CandidateCapacityDecisionV9 | null = null; let error: unknown;
    // Preserve normal funded order. If it fails, prepare the same tick from the
    // unchanged complete source; no resources, paths, clocks or RNG leak through.
    for (const prepare of [prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9]) {
      try {
        if (prepare === prepareNormalTickCandidateV9) metrics.normalCandidates++; else metrics.noOptionalCandidates++;
        const candidate = prepare(boundary); const nextAssessment = query(candidate);
        const checked = decision(boundary, candidate, previousAssessment, nextAssessment);
        if (!checked.ok) { failure = checked; continue; }
        owned = candidate; published = owned; assessment = nextAssessment; failure = null; error = undefined; break;
      } catch (caught) { error = caught; }
    }
    if (owned === boundary) {
      if (failure) return stopped(published, failure.reason === 'unsupported-continuation' ? 'unsupported-continuation'
        : failure.reason === 'unsupported-source' ? 'invalid-records' : 'capacity', failure.details);
      return stopped(published, error instanceof RangeError ? 'capacity' : 'invalid-records', [error instanceof Error ? error.message : 'Invalid tick candidate']);
    }
  }
  return { world: published, stopped: null, commandResults, metrics };
}
