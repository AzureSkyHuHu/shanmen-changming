import type { WorkPathBudget } from '../agents/work-navigation';
import { cloneJson } from '../kernel/serialization';
import { tickConstruction } from './construction';
import type { ConstructionClaim, ConstructionFrame } from './construction-types';
import { validateConstructionContext, validateConstructionFrame } from './construction-validation';
import { SECT_PRODUCTION_LIMITS, type SectProductionCommand, type SectProductionContext, type SectProductionFrame,
  type SectProductionJob, type SectProductionRejection, type SectProductionResult } from './production-types';
import { isSectProductionCommand, validateSectProductionFrame } from './production-validation';
import { applyValidatedSectProductionCommand, sectProductionClaims, tickValidatedSectProduction } from './production-runtime';
export { sectProductionClaims } from './production-runtime';
const MAX = Number.MAX_SAFE_INTEGER;
const live = (job: SectProductionJob): boolean => job.terminal === null;
const accepted = (frame: SectProductionFrame, jobId: string | null = null, repeated = false): SectProductionResult => ({ ok: true, frame, jobId, repeated });
const rejected = (frame: SectProductionFrame, code: SectProductionRejection): SectProductionResult => ({ ok: false, frame, code });
function current(frame: SectProductionFrame, context: SectProductionContext): SectProductionRejection | null {
  if (validateSectProductionFrame(frame).length) return 'INVALID_FRAME';
  if (!validateConstructionContext(context)) return 'INVALID_CONTEXT';
  if (context.simulationTick !== frame.construction.lastSimulationTick || context.calendarTick !== frame.construction.lastCalendarTick) return 'STALE_CLOCK';
  return null;
}
function publish(source: SectProductionFrame, candidate: SectProductionFrame, jobId: string | null = null): SectProductionResult {
  const count = candidate.production.jobs.filter(live).length;
  if (candidate.production.revision > MAX - count || candidate.production.receipts.length + count > SECT_PRODUCTION_LIMITS.receipts) return rejected(source, 'CAPACITY_EXCEEDED');
  if (validateSectProductionFrame(candidate).length) return rejected(source, 'INVALID_FRAME');
  return accepted(cloneJson(candidate), jobId);
}
/** Receives actual construction evidence; copying an alleged unlock/level flag is not supported. */
export function createSectProductionFrame(construction: ConstructionFrame): SectProductionFrame {
  if (validateConstructionFrame(construction).length) throw new RangeError('Invalid construction projection');
  const frame: SectProductionFrame = { schemaVersion: 1, construction, production: { revision: 0, nextId: 1, jobs: [], receipts: [] } };
  if (validateSectProductionFrame(frame).length) throw new RangeError('Unowned reservation in production projection');
  return cloneJson(frame);
}
/** Public two-domain command boundary remains strict and fail-closed. */
export function applySectProductionCommand(frame: SectProductionFrame, context: SectProductionContext, command: SectProductionCommand): SectProductionResult {
  const problem = current(frame, context);
  if (problem) return rejected(frame, problem);
  if (!isSectProductionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const result = applyValidatedSectProductionCommand(frame, context, command);
  if (!result.ok || result.repeated) return result;
  return publish(frame, result.frame, result.jobId);
}
/** One caller-owned budget, shared in explicit construction→production order; never authorization. */
export function tickSectProduction(frame: SectProductionFrame, context: SectProductionContext, budget: WorkPathBudget): SectProductionResult {
  if (validateSectProductionFrame(frame).length) return rejected(frame, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(frame, 'INVALID_CONTEXT');
  const authority = frame.construction;
  if (context.simulationTick === authority.lastSimulationTick && context.calendarTick === authority.lastCalendarTick) return accepted(frame, null, true);
  if (context.paused || context.simulationTick <= authority.lastSimulationTick || context.calendarTick < authority.lastCalendarTick) return rejected(frame, 'STALE_CLOCK');
  if (context.simulationTick !== authority.lastSimulationTick + 1 || context.calendarTick !== authority.lastCalendarTick + (context.mode === 'management' ? 1 : 0)) return rejected(frame, 'CLOCK_GAP');
  if (!budget || budget.simulationTick !== context.simulationTick) return rejected(frame, 'INVALID_CONTEXT');
  const active = frame.production.jobs.filter(live).length;
  if (frame.production.revision === MAX || active > 0 && context.simulationTick > MAX - 20
    || active + context.externalActiveJobs + authority.jobs.filter(job => job.terminal === null).length > SECT_PRODUCTION_LIMITS.activeJobs) return rejected(frame, 'CAPACITY_EXCEEDED');
  const claims = new Map<string, ConstructionClaim>();
  for (const claim of [...sectProductionClaims(frame), ...context.externalClaims]) claims.set(`${claim.kind}:${claim.key}`, claim);
  const construction = tickConstruction(authority, { ...context, externalActiveJobs: context.externalActiveJobs + active, externalClaims: [...claims.values()] }, budget);
  if (!construction.ok) return rejected(frame, construction.code === 'CAPACITY_EXCEEDED' ? 'CAPACITY_EXCEEDED' : 'INVALID_CONTEXT');
  try {
    const next = tickValidatedSectProduction({ ...frame, construction: construction.frame }, context, budget);
    return publish(frame, next);
  } catch (error) {
    if (error instanceof RangeError && (error.message === 'Invalid path budget' || error.message === 'Path budget belongs to another tick')) return rejected(frame, 'INVALID_CONTEXT');
    throw error;
  }
}
