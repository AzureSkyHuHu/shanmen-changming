import { getSectRecipeDefinition } from '../../content/sect-v9/catalog';
import type { SectCell, SectRecipeDefinition } from '../../content/sect-v9/types';
import { cardinalDistance, emptyNavigation, isWalkable, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import type { WorkPathBudget } from '../agents/work-navigation';
import { runProductionPhases, type ProductionContext, type ProductionSite } from '../economy/production-context';
import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { PRODUCTION_BLOCKED_REASONS, PRODUCTION_PHASES } from '../economy/types';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { constructionClaims, constructionEffectiveMap } from './construction';
import type { ConstructionClaim, ConstructionPerson } from './construction-types';
import { deriveSectFootprint, ownSectFields } from './layout';
import { commitSectReservation, normalizeSectResourceLines, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { SECT_PRODUCTION_LIMITS, type SectProductionCommand, type SectProductionContext, type SectProductionFrame, type SectProductionJob,
  type SectProductionRejection, type SectProductionResult, type SectProductionSiteProof, type SectProductionValidationIssue } from './production-types';

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
const integer = isNonNegativeInteger;
const fields = ownSectFields;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const nullableId = (value: unknown): boolean => value === null || id(value);
const equal = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const array = (value: unknown, maximum: number): value is unknown[] => isLedgerDataArray(value) && (value as unknown[]).length <= maximum;
const cell = (value: unknown): boolean => fields(value, ['x', 'y']) && integer(value.x) && integer(value.y) && value.x <= 255 && value.y <= 255;
function productionCommandTree(value: unknown, depth = 0, budget = { left: 100 }): boolean {
  if (--budget.left < 0 || depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return value.length <= 256;
  if (Array.isArray(value)) return isLedgerDataArray(value) && value.length <= 65536 && value.every(child => productionCommandTree(child, depth + 1, budget));
  return isLedgerDataRecord(value) && Object.values(value as Record<string, unknown>).every(child => productionCommandTree(child, depth + 1, budget));
}
export function isSectProductionCommand(value: unknown): value is SectProductionCommand {
  if (!productionCommandTree(value) || !fields(value, ['commandId', 'expectedRevision', 'kind'], false) || !id(value.commandId) || !integer(value.expectedRevision)) return false;
  if (value.kind === 'production.start') return fields(value, ['commandId', 'expectedRevision', 'kind', 'recipeId', 'workerId']) && id(value.recipeId) && id(value.workerId);
  return value.kind === 'production.cancel' && fields(value, ['commandId', 'expectedRevision', 'kind', 'jobId']) && id(value.jobId);
}
/** Derives station identity/entrance from the canonical projection; no caller-supplied site flags. */
export function sectProductionSites(frame: SectProductionFrame, recipe: SectRecipeDefinition): readonly SectProductionSiteProof[] {
  const authority = frame.construction; const requirement = recipe.workstation;
  if (requirement.kind === 'legacy-point') return authority.legacyStations.filter(site => site.blueprintId === requirement.blueprintId).map(site => ({
    kind: 'legacy-point' as const, siteId: site.id, position: { x: site.x, y: site.y }, sourceJobId: null, level: 0 as const, firstMaintenanceCalendarTick: null,
  }));
  return authority.buildings.filter(building => building.definitionId === requirement.definitionId && building.level >= requirement.minimumLevel).map(building => {
    const geometry = deriveSectFootprint({ definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation });
    if (!geometry.ok) throw new Error('Validated construction geometry was lost');
    return { kind: 'placed' as const, siteId: building.buildingId, position: geometry.footprint.entrance, sourceJobId: building.sourceJobId,
      level: building.level as 1, firstMaintenanceCalendarTick: building.firstMaintenanceCalendarTick };
  });
}
/** Internal only: the owner has checked descriptors and construction authority first.
 * Does not claim to validate the whole frame or close the reservation-owner union. */
export function validateSectProductionRecords(frame: SectProductionFrame): readonly SectProductionValidationIssue[] {
  const fail = (code: string, path: string): readonly SectProductionValidationIssue[] => [{ code, path }];
  const domain = frame.production; const authority = frame.construction;
  if (!fields(domain, ['revision', 'nextId', 'jobs', 'receipts']) || !integer(domain.revision) || !integer(domain.nextId) || domain.nextId < 1
    || !array(domain.jobs, SECT_PRODUCTION_LIMITS.records) || !array(domain.receipts, SECT_PRODUCTION_LIMITS.receipts)) return fail('INVALID_DOMAIN', 'production');
  if (domain.jobs.some(job => !isLedgerDataRecord(job))) return fail('INVALID_JOB', 'production.jobs');
  const active = domain.jobs.filter(job => job.terminal === null);
  if (active.length + authority.jobs.filter(job => job.terminal === null).length > SECT_PRODUCTION_LIMITS.activeJobs) return fail('JOB_LIMIT', 'production.jobs');
  if (domain.revision > Number.MAX_SAFE_INTEGER - active.length) return fail('REVISION_OBLIGATION', 'production.revision');
  if (domain.receipts.length + active.length > SECT_PRODUCTION_LIMITS.receipts) return fail('TERMINAL_CAPACITY', 'production.receipts');
  const allocationIds = new Set<number>(); const jobIds = new Set<string>();
  const reservedWorkers = new Set(authority.jobs.filter(job => job.terminal === null).map(job => job.workerId));
  const seats = new Set<string>(); const entrances = new Set<string>();
  const inMap = (p: { readonly x: number; readonly y: number }): boolean => p.x < authority.map.width && p.y < authority.map.height;
  const allocation = (value: unknown, prefix: string): boolean => {
    if (!id(value) || !value.startsWith(`${prefix}:`)) return false;
    const suffix = value.slice(prefix.length + 1); const number = Number(suffix);
    if (!integer(number) || number < 1 || String(number) !== suffix || number >= domain.nextId || allocationIds.has(number)) return false;
    if (authority.people.some(person => person.id === value) || authority.legacyStations.some(site => site.id === value)) return false;
    allocationIds.add(number); return true;
  };
  for (const job of domain.jobs) {
    if (!fields(job, ['transactionId', 'recipeId', 'workerId', 'state', 'activeTicks', 'requiredTicks', 'startedTick', 'blockedReason', 'phase', 'worksiteId', 'storageId', 'navigation',
      'reservationId', 'startedCalendarTick', 'origin', 'productiveSite', 'seatSiteId', 'workVisit', 'deliveryVisit', 'workSpans', 'terminal'])
      || !allocation(job.transactionId, 'sect-production') || !allocation(job.reservationId, 'sect-production-reservation') || jobIds.has(job.transactionId)
      || !authority.people.some(person => person.id === job.workerId) || !integer(job.startedTick) || job.startedTick > authority.lastSimulationTick
      || !integer(job.startedCalendarTick) || job.startedCalendarTick > authority.lastCalendarTick || !cell(job.origin) || !inMap(job.origin)
      || !integer(job.activeTicks) || !integer(job.requiredTicks) || !PRODUCTION_PHASES.includes(job.phase)
      || !['Running', 'Blocked', 'Committed', 'Cancelled'].includes(job.state)
      || !(job.blockedReason === null || PRODUCTION_BLOCKED_REASONS.includes(job.blockedReason))
      || !nullableId(job.worksiteId) || !nullableId(job.storageId) || !nullableId(job.seatSiteId)
      || !array(job.workSpans, SECT_PRODUCTION_LIMITS.maximumWorkTicks)) return fail('INVALID_JOB', 'production.jobs');
    jobIds.add(job.transactionId);
    const recipe = getSectRecipeDefinition(job.recipeId);
    if (!recipe || recipe.requiredResearch.length !== 0 || job.requiredTicks !== recipe.workTicks || job.activeTicks > recipe.workTicks) return fail('INVALID_RECIPE_SOURCE', job.transactionId);
    const site = job.productiveSite;
    if (!fields(site, ['kind', 'siteId', 'position', 'sourceJobId', 'level', 'firstMaintenanceCalendarTick'])
      || !sectProductionSites(frame, recipe).some(proof => equal(proof, site))) return fail('INVALID_SITE_SOURCE', job.transactionId);
    if (site.kind === 'placed') {
      const sourceJob = authority.jobs.find(value => value.jobId === site.sourceJobId);
      if (sourceJob?.terminal?.kind !== 'completed' || sourceJob.terminal.tick > job.startedTick
        || sourceJob.terminal.calendarTick > job.startedCalendarTick || job.startedCalendarTick >= site.firstMaintenanceCalendarTick!) return fail('INVALID_SITE_SOURCE', job.transactionId);
    }
    if (job.worksiteId !== null && job.worksiteId !== site.siteId || job.seatSiteId !== null && job.seatSiteId !== site.siteId) return fail('INVALID_SITE_OWNERSHIP', job.transactionId);
    const storage = authority.legacyStations.find(value => value.blueprintId === 'storage');
    if (!storage || (job.storageId !== null && job.storageId !== storage.id)) return fail('INVALID_STORAGE', job.transactionId);
    const visit = (value: typeof job.workVisit): boolean => value === null || fields(value, ['tick', 'calendarTick', 'position'])
      && integer(value.tick) && value.tick > job.startedTick && value.tick <= authority.lastSimulationTick
      && integer(value.calendarTick) && value.calendarTick > job.startedCalendarTick && value.calendarTick <= authority.lastCalendarTick
      && value.calendarTick - job.startedCalendarTick <= value.tick - job.startedTick && cell(value.position) && inMap(value.position);
    if (!visit(job.workVisit) || !visit(job.deliveryVisit) || job.workVisit && !equal(job.workVisit.position, site.position)
      || job.deliveryVisit && (!job.workVisit || job.deliveryVisit.tick <= job.workVisit.tick || !equal(job.deliveryVisit.position, { x: storage.x, y: storage.y }))) return fail('INVALID_VISIT', job.transactionId);
    const workTravel = Math.max(1, cardinalDistance(job.origin, site.position) * MOVEMENT_TICKS_PER_CELL);
    const deliveryTravel = Math.max(1, cardinalDistance(site.position, storage) * MOVEMENT_TICKS_PER_CELL);
    if (job.workVisit && (job.workVisit.tick - job.startedTick < workTravel || job.workVisit.calendarTick - job.startedCalendarTick < workTravel)) return fail('IMPOSSIBLE_TRAVEL_DURATION', job.transactionId);
    let count = 0; let lastTick = job.workVisit?.tick ?? job.startedTick; let lastCalendar = job.workVisit?.calendarTick ?? job.startedCalendarTick;
    for (const span of job.workSpans) {
      if (!fields(span, ['firstTick', 'lastTick', 'firstCalendarTick', 'lastCalendarTick']) || !integer(span.firstTick) || !integer(span.lastTick)
        || !integer(span.firstCalendarTick) || !integer(span.lastCalendarTick) || span.firstTick <= lastTick || span.firstCalendarTick <= lastCalendar
        || span.lastTick < span.firstTick || span.lastCalendarTick < span.firstCalendarTick || span.lastTick > authority.lastSimulationTick
        || span.lastCalendarTick > authority.lastCalendarTick || span.firstCalendarTick - lastCalendar > span.firstTick - lastTick || span.lastTick - span.firstTick !== span.lastCalendarTick - span.firstCalendarTick
        || count > 0 && span.firstTick === lastTick + 1 && span.firstCalendarTick === lastCalendar + 1
        || site.firstMaintenanceCalendarTick !== null && span.lastCalendarTick >= site.firstMaintenanceCalendarTick) return fail('INVALID_WORK_EVIDENCE', job.transactionId);
      count += span.lastTick - span.firstTick + 1; lastTick = span.lastTick; lastCalendar = span.lastCalendarTick;
    }
    if (count !== job.activeTicks || count > 0 && !job.workVisit) return fail('INVALID_WORK_EVIDENCE', job.transactionId);
    if (job.deliveryVisit && (count !== recipe.workTicks || job.deliveryVisit.tick - lastTick < deliveryTravel
      || job.deliveryVisit.calendarTick - lastCalendar < deliveryTravel)) return fail('IMPOSSIBLE_DELIVERY', job.transactionId);
    const claim = authority.ledger.reservations.find(value => value.ownerTransactionId === job.transactionId && value.reservationId === job.reservationId);
    if (!claim || claim.policy !== 'on-completion' || !equal(sectReservationLines(claim, 'lines'), normalizeSectResourceLines(recipe.inputs))) return fail('INVALID_COST_SOURCE', job.transactionId);
    const nav = job.navigation;
    if (!fields(nav, ['path', 'target', 'routeVersion', 'movementTicks', 'retryAtTick']) || !array(nav.path, authority.map.width * authority.map.height)
      || nav.path.some(p => !cell(p) || !inMap(p)) || !(nav.target === null || cell(nav.target) && inMap(nav.target))
      || !(nav.routeVersion === null || integer(nav.routeVersion) && nav.routeVersion <= authority.map.navVersion)
      || !integer(nav.movementTicks) || nav.movementTicks >= MOVEMENT_TICKS_PER_CELL || !integer(nav.retryAtTick)
      || nav.path.some((p, i) => i > 0 && cardinalDistance(p, nav.path[i - 1]!) !== 1)) return fail('INVALID_NAVIGATION', job.transactionId);
    if (job.terminal === null) {
      if (!['Running', 'Blocked'].includes(job.state) || ['Done', 'Cancelled'].includes(job.phase) || claim.base.settlement !== null
        || (job.state === 'Running') !== (job.blockedReason === null) || reservedWorkers.has(job.workerId)
        || job.phase === 'WaitingForStation' && (job.worksiteId !== null || job.seatSiteId !== null)
        || ['TravellingToWork', 'Working'].includes(job.phase) && (job.worksiteId !== site.siteId || job.seatSiteId !== site.siteId)
        || job.phase === 'Working' && !job.workVisit
        || ['TravellingToStorage', 'AwaitingDelivery'].includes(job.phase) && (count !== recipe.workTicks || job.seatSiteId !== null)
        || job.phase === 'AwaitingDelivery' && !job.deliveryVisit) return fail('INVALID_ACTIVE_OWNERSHIP', job.transactionId);
      reservedWorkers.add(job.workerId);
      const entrance = job.seatSiteId !== null ? site.position : job.storageId !== null ? storage : null;
      if (job.seatSiteId !== null) { if (seats.has(job.seatSiteId)) return fail('DUPLICATE_SEAT', job.transactionId); seats.add(job.seatSiteId); }
      if (entrance) {
        const key = `${entrance.x},${entrance.y}`;
        if (entrances.has(key)) return fail('DUPLICATE_ENTRANCE', job.transactionId);
        entrances.add(key);
      }
    } else {
      const terminal = job.terminal;
      if (!fields(terminal, ['tick', 'calendarTick', 'position', 'kind', 'previousPhase', 'consumed', 'released', 'outputs'])
        || !['completed', 'cancelled'].includes(terminal.kind) || !integer(terminal.tick) || terminal.tick < lastTick || terminal.tick > authority.lastSimulationTick
        || !integer(terminal.calendarTick) || terminal.calendarTick < lastCalendar || terminal.calendarTick > authority.lastCalendarTick
        || !cell(terminal.position) || !inMap(terminal.position) || !['WaitingForStation', 'TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery'].includes(terminal.previousPhase)
        || !equal(terminal.consumed, sectReservationLines(claim, 'consumed')) || !array(terminal.released, 9) || !array(terminal.outputs, 9)
        || nav.path.length || nav.target !== null || nav.routeVersion !== null || nav.movementTicks !== 0 || nav.retryAtTick !== 0
        || job.seatSiteId !== null || job.worksiteId !== null || job.blockedReason !== null
        || terminal.previousPhase === 'Working' && !job.workVisit
        || ['TravellingToStorage', 'AwaitingDelivery'].includes(terminal.previousPhase) && count !== recipe.workTicks
        || terminal.previousPhase === 'AwaitingDelivery' && !job.deliveryVisit) return fail('INVALID_TERMINAL', job.transactionId);
      if (terminal.kind === 'completed') {
        if (job.state !== 'Committed' || job.phase !== 'Done' || count !== recipe.workTicks || !job.deliveryVisit
          || terminal.previousPhase !== 'AwaitingDelivery' || terminal.tick <= job.deliveryVisit.tick || terminal.calendarTick <= job.deliveryVisit.calendarTick
          || !equal(terminal.position, job.deliveryVisit.position) || terminal.released.length !== 0 || !equal(terminal.outputs, normalizeSectResourceLines(recipe.outputs))
          || claim.base.settlement?.kind !== 'committed' || claim.base.settlement.operationId !== `complete:${job.transactionId}`
          || claim.sect.settlement?.kind !== 'committed'
          || !equal([...claim.base.settlement.outputs.map(line => ({ ledger: 'base', ...line })), ...claim.sect.settlement.outputs.map(line => ({ ledger: 'sect', ...line }))], terminal.outputs)
          || site.firstMaintenanceCalendarTick !== null && terminal.calendarTick >= site.firstMaintenanceCalendarTick) return fail('INVALID_COMPLETION', job.transactionId);
      } else if (job.state !== 'Cancelled' || job.phase !== 'Cancelled' || claim.base.settlement?.kind !== 'released'
        || claim.base.settlement.operationId !== `cancel:${job.transactionId}` || terminal.consumed.length || terminal.outputs.length
        || !equal(terminal.released, normalizeSectResourceLines(recipe.inputs))) return fail('INVALID_CANCELLATION', job.transactionId);
    }
  }
  return [];
}
/** Internal receipt stage: the public wrapper retains its original owner-closure ordering. */
export function validateSectProductionReceipts(frame: SectProductionFrame): readonly SectProductionValidationIssue[] {
  const fail = (code: string, path: string): readonly SectProductionValidationIssue[] => [{ code, path }];
  const domain = frame.production;
  const commandIds = new Set<string>(); const revisions = new Set<number>();
  for (const receipt of domain.receipts) {
    if (!fields(receipt, ['command', 'revision', 'jobId']) || !isSectProductionCommand(receipt.command) || !integer(receipt.revision)
      || receipt.revision !== receipt.command.expectedRevision + 1 || receipt.revision > domain.revision || commandIds.has(receipt.command.commandId)
      || revisions.has(receipt.revision) || !id(receipt.jobId)) return fail('INVALID_RECEIPT', 'production.receipts');
    commandIds.add(receipt.command.commandId); revisions.add(receipt.revision);
    const job = domain.jobs.find(value => value.transactionId === receipt.jobId); const command = receipt.command;
    if (!job || (command.kind === 'production.start' ? command.recipeId !== job.recipeId || command.workerId !== job.workerId
      : command.jobId !== job.transactionId || job.terminal?.kind !== 'cancelled')) return fail('INVALID_RECEIPT_SOURCE', receipt.jobId);
  }
  for (const job of domain.jobs) {
    if (domain.receipts.filter(receipt => receipt.command.kind === 'production.start' && receipt.jobId === job.transactionId).length !== 1
      || domain.receipts.filter(receipt => receipt.command.kind === 'production.cancel' && receipt.jobId === job.transactionId).length !== (job.terminal?.kind === 'cancelled' ? 1 : 0)) return fail('MISSING_RECEIPT', job.transactionId);
  }
  return [];
}
/** Manual commands have only identity/revision plus recipe/worker or job. No client cost/effect authority. */
export function applyValidatedSectProductionCommand(frame: SectProductionFrame, context: SectProductionContext, command: SectProductionCommand): SectProductionResult {
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
  return accepted(next, jobId);
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
/** Internal production-only stage. Authority clocks have already advanced exactly once. */
export function tickValidatedSectProduction(frame: SectProductionFrame, context: SectProductionContext, budget: WorkPathBudget): SectProductionFrame {
  return runProductionPhases<SectProductionFrame, SectProductionJob>({ ...frame,
    production: { ...frame.production, revision: frame.production.revision + 1 } }, makeContext(context), budget);
}
