import { isPaused } from '../kernel/clock';
import { isCommandV10, prepareUnregisteredCommandCandidateV10 } from '../kernel/commands-v10';
import type { CommandResultV10, CommandV10 } from '../kernel/contracts-v10';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, compareStable } from '../kernel/serialization';
import { prepareNoOptionalGrowthTickCandidateV10, prepareNormalTickCandidateV10 } from '../kernel/simulation-v10';
import type { SaveCapacityRejectionCode } from '../save-budget';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { assessManagementCapacityV10, type ManagementCapacityV10 } from './management-capacity-v10';
import { decisionV10, refusedV10 } from './runtime-decision-v10';
import { actualDimensionsFitV10, hasTeachingV10, inspectTeachingContinuationV10, TEACHING_DETAIL_V10 } from './teaching-continuation-v10';
import { captureV10RecordData } from './v10-sect-records';

export const CAPACITY_LIMITED_V10_SCOPE = 'unregistered-v10-fixed-candidate-recovery-gate' as const;
/** A synchronous call-work bound, not a gameplay or teaching elapsed-time cap.
 * Longer runs must preserve each returned complete boundary and call again. */
export const CAPACITY_LIMITED_V10_MAX_STEPS = 1200;
export type CapacityLimitedResultV10 = CommandResultV10 | {
  commandId: string; status: 'rejected'; transactionId: null; eventIds: [];
  rejection: { code: 'UNSUPPORTED_CONTINUATION'; detail: string };
};
export interface CandidateCapacityDecisionV10 {
  ok: boolean; code: SaveCapacityRejectionCode | 'UNSUPPORTED_CONTINUATION' | null;
  reason: 'ordinary' | 'reserved-recovery' | 'unsupported-continuation' | 'unsupported-source' | 'unsupported-transition' | 'actual-capacity' | 'future-capacity';
  assessment: ManagementCapacityV10; discharged: readonly string[]; details: readonly string[];
}
export interface CapacityLimitedAdvanceV10 {
  world: WorldStateV10;
  stopped: null | { kind: 'capacity' | 'invalid-records' | 'unsupported-continuation'; details: readonly string[] };
  commandResults: readonly CapacityLimitedResultV10[];
  /** Only outer tick preparations. Independent fixed proof replays/queries are
   * excluded; these ephemeral counters are NOT total cost or performance evidence. */
  metrics: { normalCandidates: number; noOptionalCandidates: number };
}

/** Complete candidate checking only; never save/import/codec authority. */
export function verifyCapacityLimitedCandidateV10(before: WorldStateV10, after: WorldStateV10): CandidateCapacityDecisionV10 {
  return decisionV10(before, after);
}
const invalidWorld = (commandId = ''): CapacityLimitedResultV10 => ({ commandId, status: 'rejected', transactionId: null, eventIds: [],
  rejection: { code: 'INVALID_WORLD_RECORDS', detail: 'Invalid bounded v10 source or candidate records' } });
const invalidCommand = (): CapacityLimitedResultV10 => ({ commandId: '', status: 'rejected', transactionId: null, eventIds: [],
  rejection: { code: 'INVALID_COMMAND' } });

/** The real record preparation resolves exact retries/conflicts before new
 * capacity admission. Capacity/capture refusal returns the ORIGINAL boundary;
 * legitimate recorded domain rejections retain their existing receipt semantics.
 * accepted new work owns detached state, with no caller data frozen or cached. */
export function dispatchCapacityLimitedCommandV10(world: WorldStateV10, input: unknown): { world: WorldStateV10; result: CapacityLimitedResultV10 } {
  let owned: WorldStateV10; let command: unknown;
  try { owned = captureV10RecordData(world) as WorldStateV10; }
  catch { return { world, result: invalidWorld() }; }
  try { command = captureV10RecordData(input); }
  catch { return { world, result: invalidCommand() }; }
  try {
    const prepared = prepareUnregisteredCommandCandidateV10(owned, command);
    if (prepared.world === owned) return { world, result: prepared.result };
    const checked = verifyCapacityLimitedCandidateV10(owned, prepared.world);
    return checked.ok ? prepared : { world, result: refusedV10(prepared.result.commandId, checked.code!) };
  } catch { return { world, result: invalidWorld() }; }
}

/** Strict internal bounded advancement, with no retained runtime instance.
 * All input is captured before command validation/execution; every candidate
 * gets fixed complete before/after queries and finite teaching/release checks.
 * A refused normal candidate is discarded before the SAME SOURCE is used for
 * no-optional growth. No domain, path, resource, receipt, clock or RNG can leak. */
export function advanceCapacityLimitedTicksV10(world: WorldStateV10, steps: number, commands: readonly CommandV10[] = []): CapacityLimitedAdvanceV10 {
  const metrics = { normalCandidates: 0, noOptionalCandidates: 0 };
  const commandResults: CapacityLimitedResultV10[] = [];
  const stopped = (boundary: WorldStateV10, kind: NonNullable<CapacityLimitedAdvanceV10['stopped']>['kind'], details: readonly string[]): CapacityLimitedAdvanceV10 =>
    ({ world: boundary, stopped: { kind, details }, commandResults, metrics });
  if (!isNonNegativeInteger(steps) || steps > CAPACITY_LIMITED_V10_MAX_STEPS) return stopped(world, 'invalid-records',
    [`steps must be an integer from 0 through ${CAPACITY_LIMITED_V10_MAX_STEPS}`]);
  let owned: WorldStateV10; let published = world;
  try {
    owned = captureV10RecordData(world) as WorldStateV10;
    const captured = captureV10RecordData(commands);
    if (!Array.isArray(captured) || !captured.every(isCommandV10)) return stopped(world, 'invalid-records', ['Invalid immediate v10 commands']);
    const source = assessManagementCapacityV10(owned);
    if (!source.supported) return stopped(world, 'invalid-records', [...source.sourceRecordIssues, ...source.unknowns]);
    if (!actualDimensionsFitV10(source)) return stopped(world, 'capacity', ['Actual complete-boundary hard limit exceeded']);
    const ordered = (captured as CommandV10[]).sort((a, b) => a.issuedTick - b.issuedTick || a.sequence - b.sequence
      || compareStable(a.commandId, b.commandId) || compareStable(canonicalStringify(a), canonicalStringify(b)));
    for (const command of ordered) {
      const prepared = prepareUnregisteredCommandCandidateV10(owned, command);
      if (prepared.world === owned) { commandResults.push(prepared.result); continue; }
      const checked = verifyCapacityLimitedCandidateV10(owned, prepared.world);
      if (!checked.ok) { commandResults.push(refusedV10(command.commandId, checked.code!)); continue; }
      owned = prepared.world; published = owned; commandResults.push(prepared.result);
    }
    // Preserve record-boundary retries/conflicts even if the existing teaching
    // route cannot currently continue. Every new command was independently gated.
    if (hasTeachingV10(owned)) {
      const sourceTeaching = inspectTeachingContinuationV10(owned);
      if (!sourceTeaching.supported) return stopped(published, 'unsupported-continuation', [TEACHING_DETAIL_V10, ...sourceTeaching.unknowns]);
    }
  } catch { return stopped(published, 'invalid-records', ['Invalid bounded v10 source or immediate commands']); }
  for (let index = 0; index < steps; index++) {
    if (isPaused(owned.clock)) break;
    const boundary = owned;
    let failure: NonNullable<CapacityLimitedAdvanceV10['stopped']> = { kind: 'invalid-records', details: ['Invalid fixed v10 tick candidate'] };
    for (const prepare of [prepareNormalTickCandidateV10, prepareNoOptionalGrowthTickCandidateV10]) {
      try {
        if (prepare === prepareNormalTickCandidateV10) metrics.normalCandidates++; else metrics.noOptionalCandidates++;
        const candidate = prepare(boundary);
        if (candidate === boundary) { failure = { kind: 'invalid-records', details: ['Unpaused v10 candidate did not advance'] }; continue; }
        const checked = verifyCapacityLimitedCandidateV10(boundary, candidate);
        if (!checked.ok) {
          failure = { kind: checked.reason === 'unsupported-continuation' ? 'unsupported-continuation'
            : checked.reason === 'unsupported-source' || checked.reason === 'unsupported-transition' ? 'invalid-records' : 'capacity', details: checked.details };
          continue;
        }
        owned = candidate; published = owned; break;
      } catch { failure = { kind: 'invalid-records', details: ['Invalid fixed v10 tick candidate'] }; }
    }
    if (owned === boundary) return stopped(published, failure.kind, failure.details);
  }
  return { world: published, stopped: null, commandResults, metrics };
}
