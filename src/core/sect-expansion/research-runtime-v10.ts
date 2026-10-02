import { getSectResearchDefinition } from '../../content/sect-v9/catalog';
import { cardinalDistance, emptyNavigation, isWalkable, sameCell } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, type WorkPathBudget } from '../agents/work-navigation';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { constructionEffectiveMap } from './construction-runtime';
import type { ConstructionPerson } from './construction-types';
import { commitSectReservation, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { sectBuildingPaidAt } from './maintenance-periods';
import type { SectUpgradeFrameV10 } from './upgrade-types';
import { SECT_RESEARCH_LIMITS, type SectResearchCommand, type SectResearchContext, type SectResearchJob,
  type SectResearchRejection, type SectResearchSiteProof } from './research-types';
import { sectResearchSites } from './research-validation';
import { sectUpgradeAllLocalClaimsV10, sectUpgradeClaimsConflictV10 } from './upgrade-validation';

export type SectResearchResultV10 =
  | { readonly ok: true; readonly frame: SectUpgradeFrameV10; readonly repeated: boolean; readonly jobId: string | null }
  | { readonly ok: false; readonly frame: SectUpgradeFrameV10; readonly code: SectResearchRejection };


const MAX = Number.MAX_SAFE_INTEGER;
const live = (job: SectResearchJob): boolean => job.terminal === null;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const accepted = (frame: SectUpgradeFrameV10, jobId: string | null = null, repeated = false): SectResearchResultV10 => ({ ok: true, frame, jobId, repeated });
const rejected = (frame: SectUpgradeFrameV10, code: SectResearchRejection): SectResearchResultV10 => ({ ok: false, frame, code });
const eligible = (person: ConstructionPerson): boolean => person.lifeState === 'alive' && person.canWork && !person.away
  && person.productionTransactionId === null && person.cultivationOwnerId === null && person.otherOwnerId === null;
function replace(frame: SectUpgradeFrameV10, job: SectResearchJob): SectUpgradeFrameV10 {
  return { ...frame, research: { ...frame.research, jobs: frame.research.jobs.map(value => value.jobId === job.jobId ? job : value) } };
}
function sectResearchContextConflictV10(frame: SectUpgradeFrameV10, context: SectResearchContext): boolean {
  return sectUpgradeClaimsConflictV10([...sectUpgradeAllLocalClaimsV10(frame), ...context.externalClaims]);
}
function sectResearchCapacityExceededV10(frame: SectUpgradeFrameV10, context: SectResearchContext): boolean {
  return sectUpgradeAllLocalClaimsV10(frame).filter(claim => claim.kind === 'worker').length + context.externalActiveJobs > 36;
}
function siteUsable(frame: SectUpgradeFrameV10, job: SectResearchJob): boolean {
  const definition = getSectResearchDefinition(job.researchId)!;
  return sectBuildingPaidAt(frame, job.site.buildingId, frame.construction.lastSimulationTick, frame.construction.lastCalendarTick) && sectResearchSites(frame, definition).some(site => same(site, job.site))
    && job.prerequisites.every(ref => frame.research.jobs.some(parent => parent.jobId === ref.completionJobId && parent.researchId === ref.researchId && parent.terminal?.kind === 'completed'));
}
function siteFree(frame: SectUpgradeFrameV10, context: SectResearchContext, site: SectResearchSiteProof, ownerId?: string): boolean {
  return ![...sectUpgradeAllLocalClaimsV10(frame), ...context.externalClaims].some(claim => claim.ownerId !== ownerId
    && (claim.kind === 'seat' && claim.key === site.buildingId || claim.kind === 'entrance' && claim.key === `${site.position.x},${site.position.y}`));
}
/** INTERNAL fixed v10 candidate stage. The complete root authenticates source/result.
 * The v9 research algorithm and L1 library payment semantics are unchanged; the
 * new six-domain claim union includes care and upgrade exactly once, while the
 * context contains legacy owners only. No old whole-frame validator is called. */
export function applyValidatedSectResearchCommandV10(frame: SectUpgradeFrameV10, context: SectResearchContext, command: SectResearchCommand): SectResearchResultV10 {
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
    if (sectResearchCapacityExceededV10(frame, { ...context, externalActiveJobs: context.externalActiveJobs + 1 }) || frame.research.jobs.length >= SECT_RESEARCH_LIMITS.records
      || frame.research.receipts.length + 2 > SECT_RESEARCH_LIMITS.receipts || frame.research.nextId > MAX - 2
      || frame.construction.ledger.reservations.length >= 384 || context.simulationTick > MAX - 20 || context.calendarTick === MAX) return rejected(frame, 'CAPACITY_EXCEEDED');
    if (sectResearchContextConflictV10(frame, context)) return rejected(frame, 'CLAIM_CONFLICT');
    const worker = frame.construction.people.find(person => person.id === command.workerId);
    if (!worker || !eligible(worker)) return rejected(frame, 'WORKER_UNAVAILABLE');
    if ([...sectUpgradeAllLocalClaimsV10(frame), ...context.externalClaims].some(claim => claim.kind === 'worker' && claim.key === worker.id)) return rejected(frame, 'CLAIM_CONFLICT');
    const sites = sectResearchSites(frame, definition).filter(site => sectBuildingPaidAt(frame, site.buildingId, context.simulationTick, context.calendarTick));
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
  return accepted(next, jobId);
}
export function tickValidatedSectResearchV10(frame: SectUpgradeFrameV10, context: SectResearchContext, budget: WorkPathBudget): SectUpgradeFrameV10 {
  let next: SectUpgradeFrameV10 = { ...frame, research: { ...frame.research, revision: frame.research.revision + 1 } };
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
  // Eligibility and the applicable paid interval were checked on this exact final work boundary.
  const paid = commitSectReservation(next.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: job.jobId }, `complete:${job.jobId}`, []);
  if (!paid.ok) throw new Error(`Validated research payment failed: ${paid.rejection.code}`);
  return replace({ ...next, construction: { ...next.construction, ledger: paid.context } }, { ...progressed, phase: 'completed', navigation: emptyNavigation(),
    terminal: { kind: 'completed', previousPhase: 'working', tick: context.simulationTick, calendarTick: context.calendarTick,
      position: { ...worker.position }, consumed: sectReservationLines(paid.reservation, 'consumed'), released: [] } });
}
