import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import type { SectResearchId } from '../../content/sect-v9/types';
import type { WorkPathBudget } from '../agents/work-navigation';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { applyValidatedConstructionCommand, tickValidatedConstruction } from './construction-runtime';
import type { ConstructionCommand } from './construction-types';
import { isConstructionCommand, validateConstructionContext } from './construction-validation';
import { commitSectReservation, reserveSectResources } from './ledger';
import { sectMaintenanceStatusFromRecords } from './maintenance-periods';
import type { SectMaintenanceContext, SectMaintenanceFrame, SectMaintenanceResult, SectMaintenanceStatus } from './maintenance-types';
import { validateSectMaintenanceFrame } from './maintenance-validation';
import { applyValidatedSectProductionCommand, isSectProductionCommand, sectProductionClaims, tickValidatedSectProduction } from './production-runtime';
import type { SectProductionCommand } from './production-types';
import { applyValidatedSectResearchCommand, sectResearchCapacityExceeded, sectResearchContextConflict, tickValidatedSectResearch } from './research-runtime';
import type { SectResearchCommand, SectResearchFrame, SectResearchJob, SectResearchRejection } from './research-types';
import { isSectResearchCommand, sectResearchClaims, validateSectResearchFrame } from './research-validation';

const MAX = Number.MAX_SAFE_INTEGER;
const accepted = (frame: SectMaintenanceFrame, jobId: string | null = null, repeated = false): SectMaintenanceResult => ({ ok: true, frame, jobId, repeated });
const rejected = (frame: SectMaintenanceFrame, code: SectResearchRejection): SectMaintenanceResult => ({ ok: false, frame, code });
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
function current(frame: SectMaintenanceFrame, context: SectMaintenanceContext): SectResearchRejection | null {
  if (validateSectMaintenanceFrame(frame).length) return 'INVALID_FRAME';
  if (!validateConstructionContext(context)) return 'INVALID_CONTEXT';
  return context.simulationTick !== frame.construction.lastSimulationTick || context.calendarTick !== frame.construction.lastCalendarTick ? 'STALE_CLOCK' : null;
}
function publish(source: SectMaintenanceFrame, candidate: SectMaintenanceFrame, jobId: string | null = null): SectMaintenanceResult {
  // Preserve every outstanding cancellation's numeric and receipt headroom.
  const issues = validateSectMaintenanceFrame(candidate);
  if (issues.length) return rejected(source, issues[0]!.code === 'CLAIM_CONFLICT' ? 'CLAIM_CONFLICT'
    : ['CANCELLATION_OBLIGATION', 'REVISION_OBLIGATION', 'TERMINAL_CAPACITY'].includes(issues[0]!.code) ? 'CAPACITY_EXCEEDED' : 'INVALID_FRAME');
  return accepted(cloneJson(candidate), jobId);
}
/** Upgrade only a strictly admitted old three-domain candidate. No filtering its ledger/history. */
export function createSectMaintenanceFrame(source: SectResearchFrame): SectMaintenanceFrame {
  if (validateSectResearchFrame(source).length) throw new RangeError('Invalid research projection');
  const frame = { ...source, maintenance: { nextId: 1, payments: [] } };
  if (validateSectMaintenanceFrame(frame).length) throw new RangeError('Invalid four-domain projection');
  return cloneJson(frame);
}
export function sectMaintenanceStatus(frame: SectMaintenanceFrame, buildingId: string): SectMaintenanceStatus | null {
  if (validateSectMaintenanceFrame(frame).length) return null;
  const building = frame.construction.buildings.find(value => value.buildingId === buildingId);
  return building ? sectMaintenanceStatusFromRecords(frame, building) : null;
}
export function sectMaintenanceResearchCompletion(frame: SectMaintenanceFrame, researchId: SectResearchId): SectResearchJob | null {
  if (validateSectMaintenanceFrame(frame).length) return null;
  const job = frame.research.jobs.find(value => value.researchId === researchId && value.terminal?.kind === 'completed');
  return job ? cloneJson(job) : null;
}
export function applySectMaintenanceConstructionCommand(frame: SectMaintenanceFrame, context: SectMaintenanceContext, command: ConstructionCommand): SectMaintenanceResult {
  const problem = current(frame, context); if (problem) return rejected(frame, problem);
  if (!isConstructionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const previous = frame.construction.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? accepted(frame, previous.relatedId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  const cancellation = command.kind === 'construction.cancel';
  if (!cancellation && sectResearchContextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  if (!cancellation && sectResearchCapacityExceeded(frame, context)) return rejected(frame, 'CAPACITY_EXCEEDED');
  const result = applyValidatedConstructionCommand(frame.construction, cancellation ? context : { ...context,
    externalActiveJobs: context.externalActiveJobs + frame.production.jobs.filter(job => job.terminal === null).length + frame.research.jobs.filter(job => job.terminal === null).length,
    externalClaims: [...context.externalClaims, ...sectProductionClaims(frame), ...sectResearchClaims(frame)] }, command, frame);
  if (!result.ok) return rejected(frame, result.code);
  if (result.repeated) return accepted(frame, result.relatedId, true);
  return publish(frame, { ...frame, construction: result.frame }, result.relatedId);
}
export function applySectMaintenanceProductionCommand(frame: SectMaintenanceFrame, context: SectMaintenanceContext, command: SectProductionCommand): SectMaintenanceResult {
  const problem = current(frame, context); if (problem) return rejected(frame, problem);
  if (!isSectProductionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const previous = frame.production.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? accepted(frame, previous.jobId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  if (command.kind !== 'production.cancel' && sectResearchContextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  const result = applyValidatedSectProductionCommand(frame, { ...context,
    externalActiveJobs: context.externalActiveJobs + frame.research.jobs.filter(job => job.terminal === null).length,
    externalClaims: [...context.externalClaims, ...sectResearchClaims(frame)] }, command, frame, frame);
  if (!result.ok) return rejected(frame, result.code);
  if (result.repeated) return accepted(frame, result.jobId, true);
  return publish(frame, { ...frame, construction: result.frame.construction, production: result.frame.production }, result.jobId);
}
export function applySectMaintenanceResearchCommand(frame: SectMaintenanceFrame, context: SectMaintenanceContext, command: SectResearchCommand): SectMaintenanceResult {
  const problem = current(frame, context); if (problem) return rejected(frame, problem);
  if (!isSectResearchCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const result = applyValidatedSectResearchCommand(frame, context, command, frame);
  if (!result.ok) return rejected(frame, result.code);
  if (result.repeated) return accepted(frame, result.jobId, true);
  return publish(frame, { ...frame, construction: result.frame.construction, research: result.frame.research }, result.jobId);
}
/** Automatic payments have no client command/receipt. Each immutable payment is its exact
 * ledger receipt. At most one attempt per expired building, no accrued debt and no failed IDs. */
export function tickValidatedSectMaintenancePayment(frame: SectMaintenanceFrame, context: SectMaintenanceContext): SectMaintenanceFrame {
  if (context.mode !== 'management' || context.paused || context.expeditionActive) return frame;
  let next = frame;
  for (const building of frame.construction.buildings.slice().sort((a, b) => compareStable(a.buildingId, b.buildingId))) {
    const status = sectMaintenanceStatusFromRecords(next, building);
    if (status.operational || status.renewalBlock !== null) continue;
    const definition = getSectBuildingDefinition(building.definitionId)!.levels[0]!;
    const paymentId = `sect-maintenance:${next.maintenance.nextId}`;
    const reservationId = `sect-maintenance-reservation:${next.maintenance.nextId + 1}`;
    const identity = { reservationId, ownerTransactionId: paymentId };
    const reserved = reserveSectResources(next.construction.ledger, identity, definition.maintenance.costs, 'on-completion');
    if (!reserved.ok) continue;
    const paid = commitSectReservation(reserved.context, identity, `maintain:${paymentId}`, []);
    if (!paid.ok) continue; // Both candidates stay private; no reservation or ID is published.
    const predecessor = next.maintenance.payments.filter(payment => payment.buildingId === building.buildingId).at(-1);
    next = { ...next, construction: { ...next.construction, ledger: paid.context }, maintenance: {
      nextId: next.maintenance.nextId + 2, payments: [...next.maintenance.payments, {
        paymentId, reservationId, buildingId: building.buildingId, sourceJobId: building.sourceJobId,
        predecessorPaymentId: predecessor?.paymentId ?? null, previousDueCalendarTick: status.dueCalendarTick,
        paidTick: context.simulationTick, paidCalendarTick: context.calendarTick,
        dueCalendarTick: context.calendarTick + definition.maintenance.intervalTicks,
      }],
    } };
  }
  return next;
}
/** Single clock and shared navigation budget: construction → maintenance → production → research. */
export function tickSectMaintenance(frame: SectMaintenanceFrame, context: SectMaintenanceContext, budget: WorkPathBudget): SectMaintenanceResult {
  if (validateSectMaintenanceFrame(frame).length) return rejected(frame, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(frame, 'INVALID_CONTEXT');
  const authority = frame.construction;
  if (context.simulationTick === authority.lastSimulationTick && context.calendarTick === authority.lastCalendarTick) return accepted(frame, null, true);
  if (context.paused || context.simulationTick <= authority.lastSimulationTick || context.calendarTick < authority.lastCalendarTick) return rejected(frame, 'STALE_CLOCK');
  if (context.simulationTick !== authority.lastSimulationTick + 1 || context.calendarTick !== authority.lastCalendarTick + (context.mode === 'management' ? 1 : 0)) return rejected(frame, 'CLOCK_GAP');
  if (!budget || budget.simulationTick !== context.simulationTick) return rejected(frame, 'INVALID_CONTEXT');
  if (sectResearchContextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  const researchActive = frame.research.jobs.filter(job => job.terminal === null).length;
  const productionActive = frame.production.jobs.filter(job => job.terminal === null).length;
  if (sectResearchCapacityExceeded(frame, context) || frame.research.revision === MAX || frame.production.revision === MAX
    || researchActive + productionActive > 0 && context.simulationTick > MAX - 20) return rejected(frame, 'CAPACITY_EXCEEDED');
  const construction = tickValidatedConstruction(authority, { ...context, externalActiveJobs: context.externalActiveJobs + researchActive + productionActive,
    externalClaims: [...context.externalClaims, ...sectProductionClaims(frame), ...sectResearchClaims(frame)] }, budget, frame);
  if (!construction.ok) return rejected(frame, construction.code);
  try {
    const maintained = tickValidatedSectMaintenancePayment({ ...frame, construction: construction.frame }, context);
    const production = tickValidatedSectProduction(maintained, { ...context, externalActiveJobs: context.externalActiveJobs + researchActive,
      externalClaims: [...context.externalClaims, ...sectResearchClaims(maintained)] }, budget, maintained, maintained);
    const afterProduction = { ...maintained, construction: production.construction, production: production.production };
    const research = tickValidatedSectResearch(afterProduction, context, budget, afterProduction);
    return publish(frame, { ...afterProduction, construction: research.construction, research: research.research });
  } catch (error) {
    if (error instanceof RangeError && (error.message === 'Invalid path budget' || error.message === 'Path budget belongs to another tick')) return rejected(frame, 'INVALID_CONTEXT');
    throw error;
  }
}
