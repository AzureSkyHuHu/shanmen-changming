import { emptyNavigation } from '../../agents/navigation';
import type { WorkPathBudget } from '../../agents/work-navigation';
import { cloneJson } from '../../kernel/serialization';
import { isConstructionCommand, validateConstructionContext } from '../../sect-expansion/construction-record-validation';
import { applyConstructionCommandForRelocationDomain, constructionClaims } from '../../sect-expansion/construction-runtime';
import type { ConstructionClaim, ConstructionContext, ConstructionRejection } from '../../sect-expansion/construction-types';
import { deriveSectFootprint } from '../../sect-expansion/layout';
import { applyRelocationCommandForConstructionDomain, tickConstructionRelocationDomain,
  validateConstructionRelocationDomainRuntime } from '../../sect-expansion/relocation-runtime';
import type { SectRelocationRejection, SectRelocationRuntimeFrame } from '../../sect-expansion/relocation-runtime-types';
import { isSectRelocationCommand } from '../../sect-expansion/relocation-validation';

const SCOPE = 'construction-relocation-domain-candidate' as const;
/** Local two-domain executable candidate ONLY. This does not certify a World, research
 * gates, other domain books, lifecycle/archives, historical terrain/navigation or restore
 * admission. The input has one construction clock/map/people/ledger and one relocation
 * records/live pair. No public save identity or RelocationOwnerDraft is introduced. */
export type ConstructionRelocationDomainCandidate =
  | { readonly ok: true; readonly scope: typeof SCOPE; readonly frame: SectRelocationRuntimeFrame;
      readonly relatedId: string | null; readonly repeated: boolean }
  | { readonly ok: false; readonly scope: typeof SCOPE; readonly frame: unknown;
      readonly code: ConstructionRejection | SectRelocationRejection; readonly issues: readonly string[] };
const rejected = (input: unknown, code: ConstructionRejection | SectRelocationRejection, issues: readonly string[] = []): ConstructionRelocationDomainCandidate =>
  ({ ok: false, scope: SCOPE, frame: input, code, issues });
function captured(input: unknown): SectRelocationRuntimeFrame | null {
  // The fixed inspector performs descriptor capture, provenance, temporal/current spatial,
  // live ownership and both current-route proofs before any copy or field access here.
  if (validateConstructionRelocationDomainRuntime(input).length) return null;
  return cloneJson(input as SectRelocationRuntimeFrame);
}
function claims(frame: SectRelocationRuntimeFrame): readonly ConstructionClaim[] {
  return [...constructionClaims(frame.records.construction), ...frame.records.relocation.jobs.filter(job => job.terminal === null).flatMap(job => {
    const old = deriveSectFootprint(job.from); const target = deriveSectFootprint(job.to);
    if (!old.ok || !target.ok) throw new Error('Authenticated relocation geometry was lost');
    return [{ kind: 'worker' as const, key: job.workerId, ownerId: job.jobId },
      { kind: 'seat' as const, key: job.buildingId, ownerId: job.jobId },
      ...Array.from(new Set([old.footprint.entrance, target.footprint.entrance].map(cell => `${cell.x},${cell.y}`)))
        .map(key => ({ kind: 'entrance' as const, key, ownerId: job.jobId }))];
  })];
}
function contextProblem(frame: SectRelocationRuntimeFrame, context: ConstructionContext): ConstructionRejection | null {
  // Count owners once per job, never worker/seat/entrance claim tokens.
  const count = frame.records.construction.jobs.filter(job => job.terminal === null).length + frame.live.length;
  if (count + context.externalActiveJobs > 36) return 'CAPACITY_EXCEEDED';
  const local = claims(frame);
  if (context.externalClaims.some(external => local.some(own => own.kind === external.kind && own.key === external.key))) return 'CLAIM_CONFLICT';
  return null;
}
function publish(input: unknown, frame: SectRelocationRuntimeFrame, context: ConstructionContext, relatedId: string | null,
  repeated = false): ConstructionRelocationDomainCandidate {
  // Internal mechanics may share immutable subtrees. Remove that sharing before independently
  // inspecting the entire candidate, rather than returning an alleged validation token.
  const candidate = cloneJson(frame); const issues = validateConstructionRelocationDomainRuntime(candidate);
  if (issues.length) return rejected(input, 'INVALID_FRAME', issues);
  const problem = contextProblem(candidate, context); if (problem) return rejected(input, problem);
  return { ok: true, scope: SCOPE, frame: candidate, relatedId, repeated };
}
function afterConstruction(frame: SectRelocationRuntimeFrame, construction: SectRelocationRuntimeFrame['records']['construction']): SectRelocationRuntimeFrame {
  const navigationChanged = construction.map.navVersion !== frame.records.construction.map.navVersion;
  return cloneJson({ records: { construction, relocation: frame.records.relocation },
    live: navigationChanged ? frame.live.map(state => ({ ...state, navigation: emptyNavigation() })) : frame.live });
}

/** Fixed command boundary. A successful command is the actual reducer result, independently
 * re-inspected; rejection always returns the exact unchanged caller input. Cross-domain
 * same-tick cancellation/reuse without command-order evidence remains spatially ambiguous. */
export function prepareConstructionRelocationCommandCandidate(input: unknown, context: unknown, command: unknown): ConstructionRelocationDomainCandidate {
  const frame = captured(input); if (!frame) return rejected(input, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(input, 'INVALID_CONTEXT');
  const source = frame.records.construction;
  if (context.simulationTick !== source.lastSimulationTick || context.calendarTick !== source.lastCalendarTick) return rejected(input, 'STALE_CLOCK');
  const problem = contextProblem(frame, context); if (problem) return rejected(input, problem);
  if (isConstructionCommand(command)) {
    const result = applyConstructionCommandForRelocationDomain(frame.records, context, command);
    if (!result.ok) return rejected(input, result.code);
    return publish(input, afterConstruction(frame, result.frame), context, result.relatedId, result.repeated);
  }
  if (!isSectRelocationCommand(command)) return rejected(input, 'INVALID_COMMAND');
  const result = applyRelocationCommandForConstructionDomain(frame, context, command);
  if (!result.ok) return rejected(input, result.code);
  return publish(input, result.frame, context, result.jobId, result.repeated);
}

/** Clock -> construction -> relocation, once each. Both stages receive the exact same
 * real budget. A failed candidate is discarded and the spent budget is never replenished
 * or retried here. The caller must prepare a fresh attempt from its unchanged source. */
export function prepareConstructionRelocationTickCandidate(input: unknown, nextContext: unknown, budget: WorkPathBudget): ConstructionRelocationDomainCandidate {
  const frame = captured(input); if (!frame) return rejected(input, 'INVALID_FRAME');
  if (!validateConstructionContext(nextContext)) return rejected(input, 'INVALID_CONTEXT');
  const problem = contextProblem(frame, nextContext); if (problem) return rejected(input, problem);
  const result = tickConstructionRelocationDomain(frame, nextContext, budget);
  if (!result.ok) return rejected(input, result.code);
  return publish(input, result.frame, nextContext, null, result.repeated);
}
