import { getSectResearchDefinition } from '../../content/sect-v9/catalog';
import type { SectResearchId } from '../../content/sect-v9/types';
import { cardinalDistance, emptyNavigation, isWalkable, sameCell } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, type WorkPathBudget } from '../agents/work-navigation';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { applyConstructionCommand, constructionEffectiveMap, tickConstruction } from './construction';
import type { ConstructionCommand, ConstructionPerson } from './construction-types';
import { isConstructionCommand, validateConstructionContext } from './construction-validation';
import { commitSectReservation, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { applyValidatedSectProductionCommand, isSectProductionCommand, sectProductionClaims, tickValidatedSectProduction } from './production-runtime';
import type { SectProductionCommand, SectProductionFrame } from './production-types';
import { validateSectProductionFrame } from './production-validation';
import { SECT_RESEARCH_LIMITS, type SectResearchCommand, type SectResearchContext, type SectResearchFrame, type SectResearchJob,
  type SectResearchRejection, type SectResearchResult, type SectResearchSiteProof } from './research-types';
import { isSectResearchCommand, sectAllLocalClaims, sectClaimsConflict, sectResearchClaims, sectResearchSites, validateSectResearchFrame } from './research-validation';

const MAX = Number.MAX_SAFE_INTEGER;
const live = (job: SectResearchJob): boolean => job.terminal === null;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const accepted = (frame: SectResearchFrame, jobId: string | null = null, repeated = false): SectResearchResult => ({ ok: true, frame, jobId, repeated });
const rejected = (frame: SectResearchFrame, code: SectResearchRejection): SectResearchResult => ({ ok: false, frame, code });
const eligible = (person: ConstructionPerson): boolean => person.lifeState === 'alive' && person.canWork && !person.away
  && person.productionTransactionId === null && person.cultivationOwnerId === null && person.otherOwnerId === null;
function replace(frame: SectResearchFrame, job: SectResearchJob): SectResearchFrame {
  return { ...frame, research: { ...frame.research, jobs: frame.research.jobs.map(value => value.jobId === job.jobId ? job : value) } };
}
function current(frame: SectResearchFrame, context: SectResearchContext): SectResearchRejection | null {
  if (validateSectResearchFrame(frame).length) return 'INVALID_FRAME';
  if (!validateConstructionContext(context)) return 'INVALID_CONTEXT';
  if (context.simulationTick !== frame.construction.lastSimulationTick || context.calendarTick !== frame.construction.lastCalendarTick) return 'STALE_CLOCK';
  return null;
}
function contextConflict(frame: SectResearchFrame, context: SectResearchContext): boolean {
  return sectClaimsConflict([...sectAllLocalClaims(frame), ...context.externalClaims]);
}
function capacity(frame: SectResearchFrame, context: SectResearchContext): boolean {
  return frame.construction.jobs.filter(job => job.terminal === null).length + frame.production.jobs.filter(job => job.terminal === null).length
    + frame.research.jobs.filter(live).length + context.externalActiveJobs > 36;
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
/** Read-only completion evidence. Gate consumers remain closed in this slice. */
export function sectResearchCompletion(frame: SectResearchFrame, researchId: SectResearchId): SectResearchJob | null {
  if (validateSectResearchFrame(frame).length) return null;
  const job = frame.research.jobs.find(value => value.researchId === researchId && value.terminal?.kind === 'completed');
  return job ? cloneJson(job) : null;
}
function siteUsable(frame: SectResearchFrame, job: SectResearchJob): boolean {
  const definition = getSectResearchDefinition(job.researchId)!;
  return frame.construction.lastCalendarTick < job.site.firstMaintenanceCalendarTick && sectResearchSites(frame, definition).some(site => same(site, job.site))
    && job.prerequisites.every(ref => frame.research.jobs.some(parent => parent.jobId === ref.completionJobId && parent.researchId === ref.researchId && parent.terminal?.kind === 'completed'));
}
function siteFree(frame: SectResearchFrame, context: SectResearchContext, site: SectResearchSiteProof, ownerId?: string): boolean {
  return ![...sectAllLocalClaims(frame), ...context.externalClaims].some(claim => claim.ownerId !== ownerId
    && (claim.kind === 'seat' && claim.key === site.buildingId || claim.kind === 'entrance' && claim.key === `${site.position.x},${site.position.y}`));
}
/** Research commands cannot choose prices, work, effects, prerequisites, payment or completion. */
export function applySectResearchCommand(frame: SectResearchFrame, context: SectResearchContext, command: SectResearchCommand): SectResearchResult {
  const problem = current(frame, context); if (problem) return rejected(frame, problem);
  if (!isSectResearchCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const previous = frame.research.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? accepted(frame, previous.jobId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  if (command.expectedRevision !== frame.research.revision) return rejected(frame, 'STALE_REVISION');
  if (frame.research.revision === MAX) return rejected(frame, 'CAPACITY_EXCEEDED');
  let next = frame; let jobId: string;
  if (command.kind === 'research.start') {
    const definition = getSectResearchDefinition(command.researchId);
    if (!definition) return rejected(frame, 'UNKNOWN_RESEARCH');
    if (frame.research.jobs.some(job => job.researchId === command.researchId && job.terminal?.kind === 'completed')) return rejected(frame, 'RESEARCH_COMPLETED');
    if (frame.research.jobs.some(live)) return rejected(frame, 'RESEARCH_ACTIVE');
    const prerequisites = definition.prerequisites.map(researchId => ({ researchId, completionJobId: frame.research.jobs.find(job => job.researchId === researchId && job.terminal?.kind === 'completed')?.jobId ?? '' }));
    if (prerequisites.some(ref => !ref.completionJobId)) return rejected(frame, 'PREREQUISITE_REQUIRED');
    if (context.mode !== 'management' || context.paused || context.expeditionActive) return rejected(frame, 'MANAGEMENT_REQUIRED');
    if (capacity(frame, { ...context, externalActiveJobs: context.externalActiveJobs + 1 }) || frame.research.jobs.length >= SECT_RESEARCH_LIMITS.records
      || frame.research.receipts.length + 2 > SECT_RESEARCH_LIMITS.receipts || frame.research.nextId > MAX - 2
      || frame.construction.ledger.reservations.length >= 384 || context.simulationTick > MAX - 20 || context.calendarTick === MAX) return rejected(frame, 'CAPACITY_EXCEEDED');
    if (contextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
    const worker = frame.construction.people.find(person => person.id === command.workerId);
    if (!worker || !eligible(worker)) return rejected(frame, 'WORKER_UNAVAILABLE');
    if ([...sectAllLocalClaims(frame), ...context.externalClaims].some(claim => claim.kind === 'worker' && claim.key === worker.id)) return rejected(frame, 'CLAIM_CONFLICT');
    const sites = sectResearchSites(frame, definition).filter(site => context.calendarTick < site.firstMaintenanceCalendarTick);
    if (!sites.length) return rejected(frame, 'WORKSTATION_UNAVAILABLE');
    const site = sites.filter(value => siteFree(frame, context, value)).sort((a, b) => cardinalDistance(worker.position, a.position) - cardinalDistance(worker.position, b.position) || compareStable(a.buildingId, b.buildingId))[0];
    if (!site) return rejected(frame, 'CLAIM_CONFLICT');
    jobId = `sect-research:${frame.research.nextId}`;
    const reservationId = `sect-research-reservation:${frame.research.nextId + 1}`;
    const reserved = reserveSectResources(frame.construction.ledger, { reservationId, ownerTransactionId: jobId }, definition.costs, 'on-completion');
    if (!reserved.ok) return rejected(frame, reserved.rejection.code === 'INSUFFICIENT_INVENTORY' ? 'INSUFFICIENT_INVENTORY' : 'INVALID_RESERVATION');
    const job: SectResearchJob = { jobId, reservationId, researchId: definition.id, workerId: worker.id, startedTick: context.simulationTick,
      startedCalendarTick: context.calendarTick, origin: { ...worker.position }, site: cloneJson(site), prerequisites, phase: 'to-site', activeTicks: 0,
      requiredTicks: definition.workTicks, visits: [], workSpans: [], navigation: emptyNavigation(), blocked: null, terminal: null };
    next = { ...frame, construction: { ...frame.construction, ledger: reserved.context },
      research: { ...frame.research, nextId: frame.research.nextId + 2, jobs: [...frame.research.jobs, job] } };
  } else {
    const job = frame.research.jobs.find(value => value.jobId === command.jobId);
    if (!job) return rejected(frame, 'UNKNOWN_JOB');
    if (!live(job)) return rejected(frame, 'TRANSACTION_FINISHED');
    const person = frame.construction.people.find(value => value.id === job.workerId)!;
    // Expiry, away/death and new external worker ownership never suppress a real cancellation.
    if (!isWalkable(constructionEffectiveMap(frame.construction), person.position)) return rejected(frame, 'UNSAFE_POSITION');
    jobId = job.jobId;
    const claim = frame.construction.ledger.reservations.find(value => value.reservationId === job.reservationId)!;
    const released = releaseSectReservation(frame.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: jobId }, `cancel:${jobId}`);
    if (!released.ok) return rejected(frame, 'INVALID_RESERVATION');
    next = replace({ ...frame, construction: { ...frame.construction, ledger: released.context } }, { ...job, phase: 'cancelled', navigation: emptyNavigation(), blocked: null,
      terminal: { kind: 'cancelled', previousPhase: job.phase as 'to-site' | 'working', tick: context.simulationTick, calendarTick: context.calendarTick,
        position: { ...person.position }, consumed: [], released: sectReservationLines(claim, 'remainingReservation') } });
  }
  next = { ...next, research: { ...next.research, revision: frame.research.revision + 1,
    receipts: [...next.research.receipts, { command: cloneJson(command), revision: frame.research.revision + 1, jobId }] } };
  return publish(frame, next, jobId);
}
/** Fixed internal construction adapter: all three domains stay present throughout validation. */
export function applySectResearchConstructionCommand(frame: SectResearchFrame, context: SectResearchContext, command: ConstructionCommand): SectResearchResult {
  const problem = current(frame, context); if (problem) return rejected(frame, problem);
  if (!isConstructionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const previous = frame.construction.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? accepted(frame, previous.relatedId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  const cancellation = command.kind === 'construction.cancel';
  if (!cancellation && contextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  if (!cancellation && capacity(frame, context)) return rejected(frame, 'CAPACITY_EXCEEDED');
  const result = applyConstructionCommand(frame.construction, cancellation ? context : { ...context,
    externalActiveJobs: context.externalActiveJobs + frame.production.jobs.filter(job => job.terminal === null).length + frame.research.jobs.filter(live).length,
    externalClaims: [...context.externalClaims, ...sectProductionClaims(frame), ...sectResearchClaims(frame)] }, command);
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
  if (command.kind !== 'production.cancel' && contextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  const result = applyValidatedSectProductionCommand(frame, { ...context,
    externalActiveJobs: context.externalActiveJobs + frame.research.jobs.filter(live).length,
    externalClaims: [...context.externalClaims, ...sectResearchClaims(frame)] }, command);
  if (!result.ok) return rejected(frame, result.code);
  if (result.repeated) return accepted(frame, result.jobId, true);
  return publish(frame, { ...frame, construction: result.frame.construction, production: result.frame.production }, result.jobId);
}
function tickResearchOnly(frame: SectResearchFrame, context: SectResearchContext, budget: WorkPathBudget): SectResearchFrame {
  let next: SectResearchFrame = { ...frame, research: { ...frame.research, revision: frame.research.revision + 1 } };
  if (context.mode !== 'management' || context.expeditionActive || context.paused) return next;
  const job = next.research.jobs.find(live); if (!job) return next;
  const worker = next.construction.people.find(person => person.id === job.workerId)!;
  if (!eligible(worker)) return replace(next, { ...job, blocked: 'WORKER_UNAVAILABLE' });
  if (!siteUsable(next, job)) return replace(next, { ...job, blocked: 'WORKSTATION_UNAVAILABLE' });
  if (!siteFree(next, context, job.site, job.jobId)) return replace(next, { ...job, blocked: 'ENTRANCE_BUSY' });
  const map = constructionEffectiveMap(next.construction);
  if (job.phase === 'to-site' || !sameCell(worker.position, job.site.position) || !isWalkable(map, worker.position)) {
    if (job.visits.length >= SECT_RESEARCH_LIMITS.visits) return replace(next, { ...job, blocked: 'VISIT_CAPACITY' });
    const effect = advanceWorkNavigationWithBudget({ map, position: worker.position, target: job.site.position, navigation: job.navigation, simulationTick: context.simulationTick }, budget);
    if (effect.position) next = { ...next, construction: { ...next.construction,
      people: next.construction.people.map(person => person.id === job.workerId ? { ...person, position: { ...effect.position! } } : person) } };
    return replace(next, { ...job, phase: effect.status === 'arrived' ? 'working' : 'to-site', navigation: effect.navigation,
      blocked: effect.status === 'path-blocked' ? 'PATH_BLOCKED' : effect.status === 'path-budget-exhausted' ? 'PATH_BUDGET' : null,
      visits: effect.status === 'arrived' ? [...job.visits, { tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...job.site.position } }] : job.visits });
  }
  const last = job.workSpans.at(-1); const visitIndex = job.visits.length - 1;
  const workSpans = last && last.visitIndex === visitIndex && last.lastTick + 1 === context.simulationTick && last.lastCalendarTick + 1 === context.calendarTick
    ? [...job.workSpans.slice(0, -1), { ...last, lastTick: context.simulationTick, lastCalendarTick: context.calendarTick }]
    : [...job.workSpans, { firstTick: context.simulationTick, lastTick: context.simulationTick, firstCalendarTick: context.calendarTick, lastCalendarTick: context.calendarTick, visitIndex }];
  const progressed = { ...job, activeTicks: job.activeTicks + 1, workSpans, blocked: null };
  if (progressed.activeTicks !== getSectResearchDefinition(job.researchId)!.workTicks) return replace(next, progressed);
  // Eligibility and the first paid period were checked on this exact final work boundary.
  const paid = commitSectReservation(next.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: job.jobId }, `complete:${job.jobId}`, []);
  if (!paid.ok) throw new Error(`Validated research payment failed: ${paid.rejection.code}`);
  return replace({ ...next, construction: { ...next.construction, ledger: paid.context } }, { ...progressed, phase: 'completed', navigation: emptyNavigation(),
    terminal: { kind: 'completed', previousPhase: 'working', tick: context.simulationTick, calendarTick: context.calendarTick,
      position: { ...worker.position }, consumed: sectReservationLines(paid.reservation, 'consumed'), released: [] } });
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
  if (contextConflict(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
  const researchActive = frame.research.jobs.filter(live).length; const productionActive = frame.production.jobs.filter(job => job.terminal === null).length;
  if (capacity(frame, context) || frame.research.revision === MAX || frame.production.revision === MAX
    || researchActive + productionActive > 0 && context.simulationTick > MAX - 20) return rejected(frame, 'CAPACITY_EXCEEDED');
  const construction = tickConstruction(authority, { ...context, externalActiveJobs: context.externalActiveJobs + researchActive + productionActive,
    externalClaims: [...context.externalClaims, ...sectProductionClaims(frame), ...sectResearchClaims(frame)] }, budget);
  if (!construction.ok) return rejected(frame, construction.code);
  try {
    const afterConstruction = { ...frame, construction: construction.frame };
    const production = tickValidatedSectProduction(afterConstruction, { ...context, externalActiveJobs: context.externalActiveJobs + researchActive,
      externalClaims: [...context.externalClaims, ...sectResearchClaims(afterConstruction)] }, budget);
    const next = tickResearchOnly({ ...afterConstruction, construction: production.construction, production: production.production }, context, budget);
    return publish(frame, next);
  } catch (error) {
    if (error instanceof RangeError && (error.message === 'Invalid path budget' || error.message === 'Path budget belongs to another tick')) return rejected(frame, 'INVALID_CONTEXT');
    throw error;
  }
}
