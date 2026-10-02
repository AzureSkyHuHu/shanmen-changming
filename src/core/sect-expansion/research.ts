import { applyValidatedSectResearchCommand, tickValidatedSectResearch, sectResearchContextConflict, sectResearchCapacityExceeded } from './research-runtime';
import type { SectResearchId } from '../../content/sect-v9/types';
import type { WorkPathBudget } from '../agents/work-navigation';
import { canonicalStringify, cloneJson } from '../kernel/serialization';
import { applyValidatedConstructionCommand, tickValidatedConstruction } from './construction-runtime';
import type { ConstructionCommand } from './construction-types';
import { isConstructionCommand, validateConstructionContext } from './construction-validation';
import { applyValidatedSectProductionCommand, isSectProductionCommand, sectProductionClaims, tickValidatedSectProduction } from './production-runtime';
import type { SectProductionCommand, SectProductionFrame } from './production-types';
import { validateSectProductionFrame } from './production-validation';
import { SECT_RESEARCH_LIMITS, type SectResearchCommand, type SectResearchContext, type SectResearchFrame, type SectResearchJob,
  type SectResearchRejection, type SectResearchResult } from './research-types';
import { isSectResearchCommand, sectResearchClaims, validateSectResearchFrame } from './research-validation';

const MAX = Number.MAX_SAFE_INTEGER;
const live = (job: SectResearchJob): boolean => job.terminal === null;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const accepted = (frame: SectResearchFrame, jobId: string | null = null, repeated = false): SectResearchResult => ({ ok: true, frame, jobId, repeated });
const rejected = (frame: SectResearchFrame, code: SectResearchRejection): SectResearchResult => ({ ok: false, frame, code });
function current(frame: SectResearchFrame, context: SectResearchContext): SectResearchRejection | null {
  if (validateSectResearchFrame(frame).length) return 'INVALID_FRAME';
  if (!validateConstructionContext(context)) return 'INVALID_CONTEXT';
  if (context.simulationTick !== frame.construction.lastSimulationTick || context.calendarTick !== frame.construction.lastCalendarTick) return 'STALE_CLOCK';
  return null;
}
function publish(source: SectResearchFrame, candidate: SectResearchFrame, jobId: string | null = null): SectResearchResult {
  const active = candidate.research.jobs.filter(live).length;
  if (candidate.research.revision > MAX - active || candidate.research.receipts.length + active > SECT_RESEARCH_LIMITS.receipts
    || candidate.production.revision > MAX - candidate.production.jobs.filter(job => job.terminal === null).length
    || candidate.construction.revision > MAX - candidate.construction.blueprints.filter(bp => bp.status === 'planned' || bp.status === 'started').length) return rejected(source, 'CAPACITY_EXCEEDED');
  const issues = validateSectResearchFrame(candidate);
  if (issues.length) return rejected(source, issues[0]!.code === 'CLAIM_CONFLICT' ? 'CLAIM_CONFLICT' : 'INVALID_FRAME');
  return accepted(cloneJson(candidate), jobId);
}
/** Admits an actual strictly validated two-domain frame. No reservation filtering or duplication. */
export function createSectResearchFrame(source: SectProductionFrame): SectResearchFrame {
  if (validateSectProductionFrame(source).length) throw new RangeError('Invalid production projection');
  const frame: SectResearchFrame = { ...source, research: { revision: 0, nextId: 1, jobs: [], receipts: [] } };
  if (validateSectResearchFrame(frame).length) throw new RangeError('Invalid three-domain projection');
  return cloneJson(frame);
}
/** Read-only completion evidence. Used for inspection; validators resolve leaf references directly without recursive validation. */
export function sectResearchCompletion(frame: SectResearchFrame, researchId: SectResearchId): SectResearchJob | null {
  if (validateSectResearchFrame(frame).length) return null;
  const job = frame.research.jobs.find(value => value.researchId === researchId && value.terminal?.kind === 'completed');
  return job ? cloneJson(job) : null;
}
/** Strict public three-domain command boundary. */
export function applySectResearchCommand(frame: SectResearchFrame, context: SectResearchContext, command: SectResearchCommand): SectResearchResult {
  const problem = current(frame, context); if (problem) return rejected(frame, problem);
  if (!isSectResearchCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const result = applyValidatedSectResearchCommand(frame, context, command);
  if (!result.ok || result.repeated) return result;
  return publish(frame, result.frame, result.jobId);
}
/** Fixed internal construction adapter: all three domains stay present throughout validation. */
export function applySectResearchConstructionCommand(frame: SectResearchFrame, context: SectResearchContext, command: ConstructionCommand): SectResearchResult {
  const problem = current(frame, context); if (problem) return rejected(frame, problem);
  if (!isConstructionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const previous = frame.construction.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? accepted(frame, previous.relatedId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  const cancellation = command.kind === 'construction.cancel';
  if (!cancellation && sectResearchContextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  if (!cancellation && sectResearchCapacityExceeded(frame, context)) return rejected(frame, 'CAPACITY_EXCEEDED');
  const result = applyValidatedConstructionCommand(frame.construction, cancellation ? context : { ...context,
    externalActiveJobs: context.externalActiveJobs + frame.production.jobs.filter(job => job.terminal === null).length + frame.research.jobs.filter(live).length,
    externalClaims: [...context.externalClaims, ...sectProductionClaims(frame), ...sectResearchClaims(frame)] }, command, frame);
  if (!result.ok) return rejected(frame, result.code);
  if (result.repeated) return accepted(frame, result.relatedId, true);
  return publish(frame, { ...frame, construction: result.frame }, result.relatedId);
}
/** Fixed internal production adapter, without the strict public two-owner wrapper. */
export function applySectResearchProductionCommand(frame: SectResearchFrame, context: SectResearchContext, command: SectProductionCommand): SectResearchResult {
  const problem = current(frame, context); if (problem) return rejected(frame, problem);
  if (!isSectProductionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const previous = frame.production.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? accepted(frame, previous.jobId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  if (command.kind !== 'production.cancel' && sectResearchContextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  const result = applyValidatedSectProductionCommand(frame, { ...context,
    externalActiveJobs: context.externalActiveJobs + frame.research.jobs.filter(live).length,
    externalClaims: [...context.externalClaims, ...sectResearchClaims(frame)] }, command, frame);
  if (!result.ok) return rejected(frame, result.code);
  if (result.repeated) return accepted(frame, result.jobId, true);
  return publish(frame, { ...frame, construction: result.frame.construction, production: result.frame.production }, result.jobId);
}
/** Exactly one clock advance and one shared budget, in construction → production → research order. */
export function tickSectResearch(frame: SectResearchFrame, context: SectResearchContext, budget: WorkPathBudget): SectResearchResult {
  if (validateSectResearchFrame(frame).length) return rejected(frame, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(frame, 'INVALID_CONTEXT');
  const authority = frame.construction;
  if (context.simulationTick === authority.lastSimulationTick && context.calendarTick === authority.lastCalendarTick) return accepted(frame, null, true);
  if (context.paused || context.simulationTick <= authority.lastSimulationTick || context.calendarTick < authority.lastCalendarTick) return rejected(frame, 'STALE_CLOCK');
  if (context.simulationTick !== authority.lastSimulationTick + 1 || context.calendarTick !== authority.lastCalendarTick + (context.mode === 'management' ? 1 : 0)) return rejected(frame, 'CLOCK_GAP');
  if (!budget || budget.simulationTick !== context.simulationTick) return rejected(frame, 'INVALID_CONTEXT');
  if (sectResearchContextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  const researchActive = frame.research.jobs.filter(live).length; const productionActive = frame.production.jobs.filter(job => job.terminal === null).length;
  if (sectResearchCapacityExceeded(frame, context) || frame.research.revision === MAX || frame.production.revision === MAX
    || researchActive + productionActive > 0 && context.simulationTick > MAX - 20) return rejected(frame, 'CAPACITY_EXCEEDED');
  const construction = tickValidatedConstruction(authority, { ...context, externalActiveJobs: context.externalActiveJobs + researchActive + productionActive,
    externalClaims: [...context.externalClaims, ...sectProductionClaims(frame), ...sectResearchClaims(frame)] }, budget, frame);
  if (!construction.ok) return rejected(frame, construction.code);
  try {
    const afterConstruction = { ...frame, construction: construction.frame };
    const production = tickValidatedSectProduction(afterConstruction, { ...context, externalActiveJobs: context.externalActiveJobs + researchActive,
      externalClaims: [...context.externalClaims, ...sectResearchClaims(afterConstruction)] }, budget, afterConstruction);
    const next = tickValidatedSectResearch({ ...afterConstruction, construction: production.construction, production: production.production }, context, budget);
    return publish(frame, next);
  } catch (error) {
    if (error instanceof RangeError && (error.message === 'Invalid path budget' || error.message === 'Path budget belongs to another tick')) return rejected(frame, 'INVALID_CONTEXT');
    throw error;
  }
}
