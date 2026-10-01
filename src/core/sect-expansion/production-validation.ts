import { getSectRecipeDefinition } from '../../content/sect-v9/catalog';
import type { SectRecipeDefinition } from '../../content/sect-v9/types';
import { cardinalDistance, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { PRODUCTION_BLOCKED_REASONS, PRODUCTION_PHASES } from '../economy/types';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify } from '../kernel/serialization';
import { CONSTRUCTION_DESCRIPTOR_NODE_BOUND, validateConstructionFrame } from './construction-validation';
import { deriveSectFootprint, ownSectFields } from './layout';
import { normalizeSectResourceLines, sectReservationLines } from './ledger';
import { SECT_PRODUCTION_LIMITS, type SectProductionCommand, type SectProductionFrame, type SectProductionSiteProof, type SectProductionValidationIssue } from './production-types';

const integer = isNonNegativeInteger;
const fields = ownSectFields;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const nullableId = (value: unknown): boolean => value === null || id(value);
const equal = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const array = (value: unknown, maximum: number): value is unknown[] => isLedgerDataArray(value) && (value as unknown[]).length <= maximum;
const cell = (value: unknown): boolean => fields(value, ['x', 'y']) && integer(value.x) && integer(value.y) && value.x <= 255 && value.y <= 255;
/** Construction's bound already covers the single map/people/both ledgers and every claim.
 * Each production record allows all 240 disjoint five-node spans, fixed proof/terminal fields,
 * and its navigation header. Only 36 live jobs may retain 65,536 three-node route cells.
 * Conservative independent maxima ensure adding any admitted cancellation cannot exceed this
 * reader gate. This is a LOCAL structural bound, never the eventual whole-World save budget.
 */
export const SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND = CONSTRUCTION_DESCRIPTOR_NODE_BOUND
  + 16 + SECT_PRODUCTION_LIMITS.records * (256 + SECT_PRODUCTION_LIMITS.maximumWorkTicks * 5)
  + SECT_PRODUCTION_LIMITS.activeJobs * 65536 * 3 + SECT_PRODUCTION_LIMITS.receipts * 12;
function plainTree(value: unknown, depth = 0, budget = { left: SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND }): boolean {
  if (--budget.left < 0 || depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return value.length <= 256;
  if (Array.isArray(value)) return isLedgerDataArray(value) && value.length <= 65536 && value.every(child => plainTree(child, depth + 1, budget));
  return isLedgerDataRecord(value) && Object.values(value as Record<string, unknown>).every(child => plainTree(child, depth + 1, budget));
}
export function isSectProductionCommand(value: unknown): value is SectProductionCommand {
  if (!plainTree(value) || !fields(value, ['commandId', 'expectedRevision', 'kind'], false) || !id(value.commandId) || !integer(value.expectedRevision)) return false;
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
export function validateSectProductionFrame(input: unknown): readonly SectProductionValidationIssue[] {
  const fail = (code: string, path: string): readonly SectProductionValidationIssue[] => [{ code, path }];
  if (!plainTree(input) || !fields(input, ['schemaVersion', 'construction', 'production']) || input.schemaVersion !== 1) return fail('INVALID_SHAPE', 'frame');
  const frame = input as unknown as SectProductionFrame;
  const constructionIssues = validateConstructionFrame(frame.construction);
  if (constructionIssues.length) return constructionIssues.map(issue => ({ ...issue, path: `construction.${issue.path}` }));
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
  // This slice has exactly two new-domain reservation owners. Legacy reservations stay only in
  // the existing base aggregate and must be authenticated by a future World projection.
  for (const claim of authority.ledger.reservations) {
    const owners = authority.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + domain.jobs.filter(job => job.transactionId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length;
    if (owners !== 1) return fail('ORPHAN_RESERVATION', claim.reservationId);
  }
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
