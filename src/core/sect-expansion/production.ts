import { getSectRecipeDefinition } from '../../content/sect-v9/catalog';
import type { SectCell, SectRecipeDefinition } from '../../content/sect-v9/types';
import { cardinalDistance, emptyNavigation, isWalkable } from '../agents/navigation';
import type { WorkPathBudget } from '../agents/work-navigation';
import { runProductionPhases, type ProductionContext, type ProductionSite } from '../economy/production-context';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { constructionClaims, constructionEffectiveMap, tickConstruction } from './construction';
import type { ConstructionClaim, ConstructionFrame, ConstructionPerson } from './construction-types';
import { validateConstructionContext, validateConstructionFrame } from './construction-validation';
import { commitSectReservation, normalizeSectResourceLines, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { SECT_PRODUCTION_LIMITS, type SectProductionCommand, type SectProductionContext, type SectProductionFrame, type SectProductionJob,
  type SectProductionRejection, type SectProductionResult, type SectProductionSiteProof } from './production-types';
import { isSectProductionCommand, sectProductionSites, validateSectProductionFrame } from './production-validation';

const MAX = Number.MAX_SAFE_INTEGER;
const live = (job: SectProductionJob): boolean => job.terminal === null;
const key = (p: SectCell): string => `${p.x},${p.y}`;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const accepted = (frame: SectProductionFrame, jobId: string | null = null, repeated = false): SectProductionResult => ({ ok: true, frame, jobId, repeated });
const rejected = (frame: SectProductionFrame, code: SectProductionRejection): SectProductionResult => ({ ok: false, frame, code });
const eligible = (person: ConstructionPerson): boolean => person.lifeState === 'alive' && person.canWork && !person.away
  && person.productionTransactionId === null && person.cultivationOwnerId === null && person.otherOwnerId === null;
const currentJob = (frame: SectProductionFrame, id: string): SectProductionJob => frame.production.jobs.find(job => job.transactionId === id)!;
function replace(frame: SectProductionFrame, job: SectProductionJob): SectProductionFrame {
  return { ...frame, production: { ...frame.production, jobs: frame.production.jobs.map(value => value.transactionId === job.transactionId ? job : value) } };
}
/** Feed this explicit domain ownership into any future legacy/away/cultivation admission. */
export function sectProductionClaims(frame: SectProductionFrame): readonly ConstructionClaim[] {
  const storage = frame.construction.legacyStations.find(site => site.blueprintId === 'storage')!;
  return frame.production.jobs.filter(live).slice().sort((a, b) => compareStable(a.transactionId, b.transactionId)).flatMap(job => {
    const claims: ConstructionClaim[] = [{ kind: 'worker', key: job.workerId, ownerId: job.transactionId }];
    if (job.seatSiteId !== null) claims.push({ kind: 'seat', key: job.seatSiteId, ownerId: job.transactionId },
      { kind: 'entrance', key: key(job.productiveSite.position), ownerId: job.transactionId });
    else if (job.storageId !== null) claims.push({ kind: 'entrance', key: key(storage), ownerId: job.transactionId });
    return claims;
  });
}
function otherClaims(frame: SectProductionFrame, context: SectProductionContext, owner?: string): readonly ConstructionClaim[] {
  return [...context.externalClaims, ...constructionClaims(frame.construction), ...sectProductionClaims(frame)].filter(claim => claim.ownerId !== owner);
}
function siteUsable(frame: SectProductionFrame, recipe: SectRecipeDefinition, site: SectProductionSiteProof): boolean {
  if (recipe.requiredResearch.length || !sectProductionSites(frame, recipe).some(current => same(current, site))) return false;
  if (site.kind === 'legacy-point') return frame.construction.legacyStations.some(station => station.id === site.siteId && station.operational);
  // No upkeep executor exists yet. Never invent a paid flag or extend this first prepaid interval.
  return frame.construction.lastCalendarTick < site.firstMaintenanceCalendarTick!;
}
function siteOwner(frame: SectProductionFrame, context: SectProductionContext, site: SectProductionSiteProof, owner?: string): string | null {
  return otherClaims(frame, context, owner).find(claim => claim.kind === 'seat' && claim.key === site.siteId
    || claim.kind === 'entrance' && claim.key === key(site.position))?.ownerId ?? null;
}
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
/** Manual commands have only identity/revision plus recipe/worker or job. No client cost/effect authority. */
export function applySectProductionCommand(frame: SectProductionFrame, context: SectProductionContext, command: SectProductionCommand): SectProductionResult {
  const problem = current(frame, context);
  if (problem) return rejected(frame, problem);
  if (!isSectProductionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const old = frame.production.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (old) return same(old.command, command) ? accepted(frame, old.jobId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  if (command.expectedRevision !== frame.production.revision) return rejected(frame, 'STALE_REVISION');
  if (frame.production.revision === MAX) return rejected(frame, 'CAPACITY_EXCEEDED');
  let next = frame; let jobId: string;
  if (command.kind === 'production.start') {
    const recipe = getSectRecipeDefinition(command.recipeId);
    if (!recipe) return rejected(frame, 'UNKNOWN_RECIPE');
    if (recipe.requiredResearch.length) return rejected(frame, 'RESEARCH_AUTHORITY_REQUIRED');
    if (context.mode !== 'management' || context.paused || context.expeditionActive) return rejected(frame, 'MANAGEMENT_REQUIRED');
    const active = frame.production.jobs.filter(live); const constructionActive = frame.construction.jobs.filter(job => job.terminal === null).length;
    if (active.length + constructionActive + context.externalActiveJobs >= SECT_PRODUCTION_LIMITS.activeJobs
      || frame.production.jobs.length >= SECT_PRODUCTION_LIMITS.records || frame.production.receipts.length + active.length + 2 > SECT_PRODUCTION_LIMITS.receipts
      || frame.construction.ledger.reservations.length >= 384 || frame.production.nextId > MAX - 2 || context.simulationTick > MAX - 20) return rejected(frame, 'CAPACITY_EXCEEDED');
    const worker = frame.construction.people.find(person => person.id === command.workerId);
    if (!worker || !eligible(worker) || active.some(job => job.workerId === worker.id)) return rejected(frame, 'WORKER_UNAVAILABLE');
    if (otherClaims(frame, context).some(claim => claim.kind === 'worker' && claim.key === worker.id)) return rejected(frame, 'CLAIM_CONFLICT');
    const sites = sectProductionSites(frame, recipe).filter(site => siteUsable(frame, recipe, site));
    if (!sites.length) return rejected(frame, 'WORKSTATION_UNAVAILABLE');
    const site = sites.filter(value => siteOwner(frame, context, value) === null).sort((a, b) => cardinalDistance(worker.position, a.position) - cardinalDistance(worker.position, b.position) || compareStable(a.siteId, b.siteId))[0];
    if (!site) return rejected(frame, 'CLAIM_CONFLICT');
    if (!frame.construction.legacyStations.some(value => value.blueprintId === 'storage' && value.operational)) return rejected(frame, 'STORAGE_UNAVAILABLE');
    jobId = `sect-production:${frame.production.nextId}`;
    const reservationId = `sect-production-reservation:${frame.production.nextId + 1}`;
    const reserved = reserveSectResources(frame.construction.ledger, { reservationId, ownerTransactionId: jobId }, recipe.inputs, 'on-completion');
    if (!reserved.ok) return rejected(frame, reserved.rejection.code === 'INSUFFICIENT_INVENTORY' ? 'INSUFFICIENT_INVENTORY' : 'INVALID_RESERVATION');
    const job: SectProductionJob = { transactionId: jobId, recipeId: recipe.recipeId, workerId: worker.id, reservationId, state: 'Running', activeTicks: 0,
      requiredTicks: recipe.workTicks, startedTick: context.simulationTick, startedCalendarTick: context.calendarTick, origin: { ...worker.position },
      blockedReason: null, phase: 'WaitingForStation', worksiteId: null, storageId: null, navigation: emptyNavigation(), productiveSite: cloneJson(site), seatSiteId: null,
      workVisit: null, deliveryVisit: null, workSpans: [], terminal: null };
    next = { ...frame, construction: { ...frame.construction, ledger: reserved.context },
      production: { ...frame.production, nextId: frame.production.nextId + 2, jobs: [...frame.production.jobs, job] } };
  } else {
    const job = frame.production.jobs.find(value => value.transactionId === command.jobId);
    if (!job) return rejected(frame, 'UNKNOWN_JOB');
    if (!live(job)) return rejected(frame, 'TRANSACTION_FINISHED');
    jobId = job.transactionId;
    const person = frame.construction.people.find(value => value.id === job.workerId)!;
    // Cancellation never rechecks station/research eligibility and never teleports an actor.
    if (!isWalkable(constructionEffectiveMap(frame.construction), person.position)) return rejected(frame, 'UNSAFE_POSITION');
    const claim = frame.construction.ledger.reservations.find(value => value.reservationId === job.reservationId)!;
    const released = releaseSectReservation(frame.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: jobId }, `cancel:${jobId}`);
    if (!released.ok) return rejected(frame, 'INVALID_RESERVATION');
    next = replace({ ...frame, construction: { ...frame.construction, ledger: released.context } }, { ...job, state: 'Cancelled', phase: 'Cancelled',
      worksiteId: null, seatSiteId: null, navigation: emptyNavigation(), blockedReason: null,
      terminal: { kind: 'cancelled', tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...person.position },
        previousPhase: job.phase as 'WaitingForStation', consumed: [], released: sectReservationLines(claim, 'remainingReservation'), outputs: [] } });
  }
  next = { ...next, production: { ...next.production, revision: frame.production.revision + 1,
    receipts: [...next.production.receipts, { command: cloneJson(command), revision: frame.production.revision + 1, jobId }] } };
  return publish(frame, next, jobId);
}
function releaseSeat(frame: SectProductionFrame, id: string): SectProductionFrame {
  const job = currentJob(frame, id); return job.seatSiteId === null ? frame : replace(frame, { ...job, seatSiteId: null });
}
function blockedUnavailable(frame: SectProductionFrame, id: string): SectProductionFrame {
  const job = currentJob(frame, id);
  return replace(frame, { ...job, state: 'Blocked', blockedReason: 'WORKER_UNAVAILABLE', seatSiteId: null, worksiteId: null,
    phase: job.activeTicks === job.requiredTicks ? 'TravellingToStorage' : 'WaitingForStation', navigation: emptyNavigation() });
}
function makeContext(context: SectProductionContext): ProductionContext<SectProductionFrame, SectProductionJob> {
  // The shared runner calls job() at the beginning of each stable-sorted job iteration. This
  // ephemeral cursor is internal adapter routing, never serialized/player-supplied authority.
  let cursor = '';
  return {
    view: frame => ({ simulationTick: frame.construction.lastSimulationTick, management: context.mode === 'management' && !context.expeditionActive,
      paused: context.paused, map: constructionEffectiveMap(frame.construction), activeTransactionIds: frame.production.jobs.filter(live).map(job => job.transactionId) }),
    job: (frame, id) => { cursor = id; return currentJob(frame, id); },
    recipe: (_frame, recipeId) => getSectRecipeDefinition(recipeId) ? { workstation: recipeId } : undefined,
    worker: (frame, workerId) => {
      const person = frame.construction.people.find(value => value.id === workerId);
      if (!person) return undefined;
      const job = currentJob(frame, cursor);
      return { position: { ...person.position }, lifeState: person.lifeState,
        canWork: eligible(person) && !otherClaims(frame, context, job.transactionId).some(claim => claim.kind === 'worker' && claim.key === workerId),
        // Adapter-only ownership view. The actual projected legacy assignment remains untouched.
        assignmentTransactionId: job.transactionId };
    },
    workSites: (frame, recipeView) => {
      const job = currentJob(frame, cursor); const recipe = getSectRecipeDefinition(recipeView.workstation)!;
      if (!siteUsable(frame, recipe, job.productiveSite)) return [];
      const foreignOwner = siteOwner(frame, context, job.productiveSite, job.transactionId);
      return [{ id: job.productiveSite.siteId, position: { ...job.productiveSite.position },
        ownerTransactionId: foreignOwner ?? (job.seatSiteId === null ? null : job.transactionId) }];
    },
    storageSites: frame => {
      const job = currentJob(frame, cursor); const claims = otherClaims(frame, context, job.transactionId);
      return frame.construction.legacyStations.filter(site => site.blueprintId === 'storage' && site.operational
        && !claims.some(claim => claim.kind === 'entrance' && claim.key === key(site)))
        .map((site): ProductionSite => ({ id: site.id, position: { x: site.x, y: site.y }, ownerTransactionId: null }));
    },
    claimSite: (frame, siteId, id) => replace(frame, { ...currentJob(frame, id), seatSiteId: siteId }),
    releaseSites: releaseSeat,
    blockedNotice: frame => frame,
    writeProgress: (frame, job, _traveling, position) => {
      const old = currentJob(frame, job.transactionId); const tick = frame.construction.lastSimulationTick; const calendarTick = frame.construction.lastCalendarTick;
      const person = frame.construction.people.find(value => value.id === job.workerId)!;
      const visit = { tick, calendarTick, position: { ...(position ?? person.position) } };
      let workSpans = old.workSpans;
      if (job.activeTicks > old.activeTicks) {
        const last = workSpans.at(-1);
        workSpans = last && last.lastTick + 1 === tick && last.lastCalendarTick + 1 === calendarTick
          ? [...workSpans.slice(0, -1), { ...last, lastTick: tick, lastCalendarTick: calendarTick }]
          : [...workSpans, { firstTick: tick, lastTick: tick, firstCalendarTick: calendarTick, lastCalendarTick: calendarTick }];
      }
      const updated = { ...job, seatSiteId: old.seatSiteId, workSpans,
        workVisit: old.workVisit ?? (job.phase === 'Working' ? visit : null),
        deliveryVisit: old.deliveryVisit ?? (job.phase === 'AwaitingDelivery' ? visit : null) };
      return replace({ ...frame, construction: { ...frame.construction,
        people: position ? frame.construction.people.map(value => value.id === job.workerId ? { ...value, position: { ...position } } : value) : frame.construction.people } }, updated);
    },
    // Manual slice keeps an unavailable/dead worker's reservation cancellable. Lifecycle-driven
    // terminal commands require the future World owner; the phase runner cannot mint user receipts.
    cancel: (frame, id) => ({ ok: true, world: blockedUnavailable(frame, id) }),
    complete: (frame, id) => {
      const job = currentJob(frame, id); const recipe = getSectRecipeDefinition(job.recipeId)!;
      if (!siteUsable(frame, recipe, job.productiveSite)) {
        return { ok: true, world: replace(frame, { ...job, state: 'Blocked', blockedReason: 'WORKSTATION_UNAVAILABLE' }) };
      }
      const committed = commitSectReservation(frame.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: id }, `complete:${id}`, recipe.outputs);
      if (!committed.ok) return { ok: false, rejection: { code: committed.rejection.code } };
      const person = frame.construction.people.find(value => value.id === job.workerId)!;
      return { ok: true, world: replace({ ...frame, construction: { ...frame.construction, ledger: committed.context } }, { ...job, state: 'Committed', phase: 'Done',
        worksiteId: null, seatSiteId: null, navigation: emptyNavigation(), blockedReason: null,
        terminal: { kind: 'completed', tick: frame.construction.lastSimulationTick, calendarTick: frame.construction.lastCalendarTick, position: { ...person.position },
          previousPhase: 'AwaitingDelivery', consumed: sectReservationLines(committed.reservation, 'consumed'), released: [], outputs: normalizeSectResourceLines(recipe.outputs)! } }) };
    },
  };
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
    const next = runProductionPhases<SectProductionFrame, SectProductionJob>({ ...frame, construction: construction.frame,
      production: { ...frame.production, revision: frame.production.revision + 1 } }, makeContext(context), budget);
    return publish(frame, next);
  } catch (error) {
    if (error instanceof RangeError && (error.message === 'Invalid path budget' || error.message === 'Path budget belongs to another tick')) return rejected(frame, 'INVALID_CONTEXT');
    throw error;
  }
}
