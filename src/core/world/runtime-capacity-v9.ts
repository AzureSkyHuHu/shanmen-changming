import { isPaused } from '../kernel/clock';
import { isCommandV9, prepareUnregisteredCommandCandidateV9 } from '../kernel/commands-v9';
import type { CommandV9, CommandResultV9 } from '../kernel/contracts-v9';
import { assertNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9 } from '../kernel/simulation-v9';
import { canonicalUtf8ByteLength } from '../save-budget';
import type { SaveCapacityRejectionCode } from '../save-budget';
import { assessManagementCapacityV9, type ManagementCapacityV9 } from './management-capacity-v9';
import { inspectReservedDischargesV9, type ReservedDischargesV9 } from './sect-release-v9';
import type { WorldStateV9 } from './v9-types';

/** Explicitly limited, unregistered runtime experiment. Teaching is deliberately
 * outside this API: it has no cancellation and the .3 sizing query does not prove
 * affordable no-optional continuation through its remaining calendar horizon.
 * The existing record-only .3 APIs retain their original teaching behavior. */
export const CAPACITY_LIMITED_V9_SCOPE = 'unregistered-v9-recovery-gate-without-teaching' as const;
const TEACHING_DETAIL = 'Teaching continuation is unsupported by this limited gate; use the existing .3 record-only API until a finite continuation proof is implemented';
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
  /** Ephemeral measurements, never copied into World/save/diagnostics. */
  metrics: { fullQueries: number; normalCandidates: number; noOptionalCandidates: number };
}
const hasTeaching = (world: WorldStateV9): boolean => world.cultivation.disciples.some(profile => profile.teaching !== null);
function actualDimensionsFit(value: ManagementCapacityV9): boolean {
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
function decision(before: WorldStateV9, after: WorldStateV9, previous: ManagementCapacityV9, current: ManagementCapacityV9): CandidateCapacityDecisionV9 {
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
/** Complete candidate query, not import/save authority. Accepts no caller-supplied
 * budget, owner/release flag, validation callback or teaching exemption. */
export function verifyCapacityLimitedCandidateV9(before: WorldStateV9, after: WorldStateV9): CandidateCapacityDecisionV9 {
  return decision(before, after, assessManagementCapacityV9(before), assessManagementCapacityV9(after));
}
function refused(commandId: string, code: SaveCapacityRejectionCode | 'UNSUPPORTED_CONTINUATION'): CapacityLimitedResultV9 {
  return code === 'UNSUPPORTED_CONTINUATION'
    ? { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code, detail: TEACHING_DETAIL } }
    : { commandId, status: 'rejected', transactionId: null, eventIds: [], rejection: { code } };
}
/** Retries and conflicts resolve at the original record boundary before any new
 * admission. A refused candidate leaves every domain, receipt and RNG untouched. */
export function dispatchCapacityLimitedCommandV9(world: WorldStateV9, input: unknown): { world: WorldStateV9; result: CapacityLimitedResultV9 } {
  const candidate = prepareUnregisteredCommandCandidateV9(world, input);
  if (candidate.world === world) return candidate;
  if (hasTeaching(world) || isCommandV9(input) && input.kind === 'cultivation.command' && input.payload.command.kind === 'teaching.begin') {
    return { world, result: refused(candidate.result.commandId, 'UNSUPPORTED_CONTINUATION') };
  }
  const checked = verifyCapacityLimitedCandidateV9(world, candidate.world);
  return checked.ok ? candidate : { world, result: refused(candidate.result.commandId, checked.code!) };
}
/** Strict baseline: one initial full query, then one per complete candidate.
 * A batch owns a detached snapshot and carries its derived assessment forward;
 * no mutable caller input is frozen/cached and no before+after re-query per tick.
 * No fast path or 20Hz performance claim is made by this implementation. */
export function advanceCapacityLimitedTicksV9(world: WorldStateV9, steps: number, commands: readonly CommandV9[] = []): CapacityLimitedAdvanceV9 {
  assertNonNegativeInteger(steps, 'steps');
  const metrics = { fullQueries: 0, normalCandidates: 0, noOptionalCandidates: 0 };
  const commandResults: CapacityLimitedResultV9[] = [];
  const query = (source: WorldStateV9): ManagementCapacityV9 => { metrics.fullQueries++; return assessManagementCapacityV9(source); };
  const stopped = (boundary: WorldStateV9, kind: NonNullable<CapacityLimitedAdvanceV9['stopped']>['kind'], details: readonly string[]): CapacityLimitedAdvanceV9 =>
    ({ world: boundary, stopped: { kind, details }, commandResults, metrics });
  let owned: WorldStateV9; let published = world; let assessment: ManagementCapacityV9;
  try {
    canonicalUtf8ByteLength(world); canonicalUtf8ByteLength(commands);
    if (!Array.isArray(commands) || commands.some(command => !isCommandV9(command))) return stopped(world, 'invalid-records', ['Invalid immediate v9 commands']);
    owned = cloneJson(world); assessment = query(owned);
    if (!assessment.supported) return stopped(world, 'invalid-records', [...assessment.sourceRecordIssues, ...assessment.unknowns]);
    const ordered = cloneJson(commands).slice().sort((a, b) => a.issuedTick - b.issuedTick || a.sequence - b.sequence
      || compareStable(a.commandId, b.commandId) || compareStable(canonicalStringify(a), canonicalStringify(b)));
    for (const command of ordered) {
      const prepared = prepareUnregisteredCommandCandidateV9(owned, command);
      if (prepared.world === owned) { commandResults.push(prepared.result); continue; }
      if (hasTeaching(owned) || command.kind === 'cultivation.command' && command.payload.command.kind === 'teaching.begin') {
        commandResults.push(refused(command.commandId, 'UNSUPPORTED_CONTINUATION')); continue;
      }
      const nextAssessment = query(prepared.world); const checked = decision(owned, prepared.world, assessment, nextAssessment);
      if (!checked.ok) { commandResults.push(refused(command.commandId, checked.code!)); continue; }
      owned = prepared.world; published = owned; assessment = nextAssessment; commandResults.push(prepared.result);
    }
    if (hasTeaching(owned)) return stopped(published, 'unsupported-continuation', [TEACHING_DETAIL]);
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
