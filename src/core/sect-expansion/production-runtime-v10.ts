import { isArchivedSectWorkerReference, type SectHistoricalIdentitySource } from './history-identity';
import { sectBuildingPaidAt, sectBuildingPaidRange } from './maintenance-periods';
import { getSectRecipeDefinition } from '../../content/sect-v9/catalog';
import type { SectCell, SectRecipeDefinition } from '../../content/sect-v9/types';
import { cardinalDistance, emptyNavigation, isWalkable, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import type { WorkPathBudget } from '../agents/work-navigation';
import { runProductionPhases, type ProductionContext, type ProductionSite } from '../economy/production-context';
import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { PRODUCTION_BLOCKED_REASONS, PRODUCTION_PHASES } from '../economy/types';
import { isSectProductionCommand } from './production-runtime';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { constructionEffectiveMap } from './construction-runtime';
import { validateConstructionContext } from './construction-record-validation';
import type { ConstructionClaim, ConstructionPerson } from './construction-types';
import { deriveSectFootprint, ownSectFields } from './layout';
import { isSectResearchGateRef } from './research-consumer-gates';
import { productionResearchGateV10, productionResearchGateMatchesV10 } from './research-consumer-gates-v10';
import { sectBuildingLevelAtFromUpgradeRecordsV10 } from './upgrade-level-records';
import { isSectUpgradeDataTreeV10, sectUpgradeAllLocalClaimsV10 } from './upgrade-validation';
import { commitSectReservation, normalizeSectResourceLines, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { SECT_PRODUCTION_LIMITS, type SectProductionCommand, type SectProductionContext,
  type SectProductionRejection, type SectProductionValidationIssue } from './production-types';
import type { SectProductionResultV10 } from './production-types-v10';
import type { SectProductionJobV10, SectProductionSiteProofV10, SectUpgradeFrameV10 } from './upgrade-types';

const MAX = Number.MAX_SAFE_INTEGER;
const live = (job: SectProductionJobV10): boolean => job.terminal === null;
const key = (p: SectCell): string => `${p.x},${p.y}`;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const accepted = (frame: SectUpgradeFrameV10, jobId: string | null = null, repeated = false): SectProductionResultV10 => ({ ok: true, frame: cloneJson(frame), jobId, repeated });
const rejected = (frame: SectUpgradeFrameV10, code: SectProductionRejection): SectProductionResultV10 => ({ ok: false, frame, code });
const eligible = (person: ConstructionPerson): boolean => person.lifeState === 'alive' && person.canWork && !person.away
  && person.productionTransactionId === null && person.cultivationOwnerId === null && person.otherOwnerId === null;
const currentJob = (frame: SectUpgradeFrameV10, id: string): SectProductionJobV10 => frame.production.jobs.find(job => job.transactionId === id)!;
function replace(frame: SectUpgradeFrameV10, job: SectProductionJobV10): SectUpgradeFrameV10 {
  return { ...frame, production: { ...frame.production, jobs: frame.production.jobs.map(value => value.transactionId === job.transactionId ? job : value) } };
}
/** Feed this explicit domain ownership into any future legacy/away/cultivation admission. */
export function sectProductionClaimsV10(frame: SectUpgradeFrameV10): readonly ConstructionClaim[] {
  const storage = frame.construction.legacyStations.find(site => site.blueprintId === 'storage')!;
  return frame.production.jobs.filter(live).slice().sort((a, b) => compareStable(a.transactionId, b.transactionId)).flatMap(job => {
    const claims: ConstructionClaim[] = [{ kind: 'worker', key: job.workerId, ownerId: job.transactionId }];
    if (job.seatSiteId !== null) claims.push({ kind: 'seat', key: job.seatSiteId, ownerId: job.transactionId },
      { kind: 'entrance', key: key(job.productiveSite.position), ownerId: job.transactionId });
    else if (job.storageId !== null) claims.push({ kind: 'entrance', key: key(storage), ownerId: job.transactionId });
    return claims;
  });
}
function otherClaims(frame: SectUpgradeFrameV10, context: SectProductionContext, owner?: string): readonly ConstructionClaim[] {
  return [...context.externalClaims, ...sectUpgradeAllLocalClaimsV10(frame)].filter(claim => claim.ownerId !== owner);
}
/** Whole lifetime, including the released-seat storage journey. Independent revision
 * counters prove no cross-domain ordering; genuine terminal/start clock equality does. */
function avoidsUpgrades(frame: SectUpgradeFrameV10, job: SectProductionJobV10): boolean {
  return job.productiveSite.kind !== 'placed' || frame.upgrade.jobs.filter(upgrade => upgrade.buildingId === job.productiveSite.siteId).every(upgrade =>
    job.terminal !== null && job.terminal.tick <= upgrade.startedTick && job.terminal.calendarTick <= upgrade.startedCalendarTick
    || upgrade.terminal !== null && upgrade.terminal.tick <= job.startedTick && upgrade.terminal.calendarTick <= job.startedCalendarTick);
}
function siteUsable(frame: SectUpgradeFrameV10, recipe: SectRecipeDefinition, site: SectProductionSiteProofV10, job?: SectProductionJobV10): boolean {
  if (!sectProductionSitesV10(frame, recipe).some(current => same(current, site))) return false;
  if (recipe.requiredResearch.length && (job ? !productionResearchGateMatchesV10(frame, job)
    : !productionResearchGateV10(frame, recipe.recipeId, frame.construction.lastSimulationTick, frame.construction.lastCalendarTick))) return false;
  if (job && !avoidsUpgrades(frame, job)) return false;
  if (site.kind === 'legacy-point') return frame.construction.legacyStations.some(station => station.id === site.siteId && station.operational);
  return sectBuildingPaidAt(frame, site.siteId, frame.construction.lastSimulationTick, frame.construction.lastCalendarTick)
    && (!job || job.workSpans.every(span => sectBuildingPaidRange(frame, site.siteId, span.firstTick, span.lastTick, span.firstCalendarTick, span.lastCalendarTick)));
}
function siteOwner(frame: SectUpgradeFrameV10, context: SectProductionContext, site: SectProductionSiteProofV10, owner?: string): string | null {
  return otherClaims(frame, context, owner).find(claim => claim.kind === 'seat' && claim.key === site.siteId
    || claim.kind === 'entrance' && claim.key === key(site.position))?.ownerId ?? null;
}
const integer = isNonNegativeInteger;
const fields = ownSectFields;
// Preserve the V10 proof discriminant rather than narrowing optional-never through Record.
const exactFields = (value: unknown, keys: readonly string[]): boolean => ownSectFields(value, keys);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const nullableId = (value: unknown): boolean => value === null || id(value);
const equal = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const array = (value: unknown, maximum: number): value is unknown[] => isLedgerDataArray(value) && (value as unknown[]).length <= maximum;
const cell = (value: unknown): boolean => fields(value, ['x', 'y']) && integer(value.x) && integer(value.y) && value.x <= 255 && value.y <= 255;
/** Validate every proof value before canonical comparison. A present undefined upgrade
 * reference is malformed data, never a reason to invoke serialization or an accessor. */
function siteProof(value: unknown): value is SectProductionSiteProofV10 {
  const keys = ['kind', 'siteId', 'position', 'sourceJobId', 'level', 'firstMaintenanceCalendarTick'];
  if (!fields(value, keys, false) || !id(value.siteId) || !cell(value.position)) return false;
  if (value.kind === 'legacy-point') return exactFields(value, keys) && value.level === 0
    && value.sourceJobId === null && value.firstMaintenanceCalendarTick === null;
  if (value.kind !== 'placed' || !id(value.sourceJobId) || !integer(value.firstMaintenanceCalendarTick)) return false;
  return value.level === 1 ? exactFields(value, keys)
    : value.level === 2 && fields(value, [...keys, 'upgradeJobId']) && id(value.upgradeJobId);
}
/** Historical site at the job's start boundary. Never substitutes today's effective
 * level for an immutable L1 proof. Root authenticates construction/upgrade sources. */
export function sectProductionSitesAtStartV10(frame: SectUpgradeFrameV10, recipe: SectRecipeDefinition,
  startedTick: number): readonly SectProductionSiteProofV10[] {
  if (!integer(startedTick) || startedTick > frame.construction.lastSimulationTick) return [];
  const authority = frame.construction; const requirement = recipe.workstation;
  if (requirement.kind === 'legacy-point') return authority.legacyStations.filter(site => site.blueprintId === requirement.blueprintId).map(site => ({
    kind: 'legacy-point' as const, siteId: site.id, position: { x: site.x, y: site.y }, sourceJobId: null, level: 0 as const, firstMaintenanceCalendarTick: null,
  }));
  return authority.buildings.flatMap((building): SectProductionSiteProofV10[] => {
    if (building.definitionId !== requirement.definitionId) return [];
    const level = sectBuildingLevelAtFromUpgradeRecordsV10(frame, building.buildingId, startedTick, 'after-upgrade');
    if (!level || level.level < requirement.minimumLevel) return [];
    const geometry = deriveSectFootprint({ definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation });
    if (!geometry.ok) throw new Error('Validated construction geometry was lost');
    const origin = { kind: 'placed' as const, siteId: building.buildingId, position: geometry.footprint.entrance,
      sourceJobId: building.sourceJobId, firstMaintenanceCalendarTick: building.firstMaintenanceCalendarTick };
    return level.level === 2 ? [{ ...origin, level: 2, upgradeJobId: level.upgradeJobId }] : [{ ...origin, level: 1 }];
  });
}
/** Current runnable sites exclude an active upgrade even after its seat is released by
 * unrelated production. Payment, ownership and research remain separate fixed gates. */
export function sectProductionSitesV10(frame: SectUpgradeFrameV10, recipe: SectRecipeDefinition): readonly SectProductionSiteProofV10[] {
  return sectProductionSitesAtStartV10(frame, recipe, frame.construction.lastSimulationTick).filter(site =>
    site.kind !== 'placed' || !frame.upgrade.jobs.some(upgrade => upgrade.buildingId === site.siteId && upgrade.terminal === null));
}
/** Version-owned leaf, AFTER descriptors, construction/paired ledger, research, upgrade
 * and maintenance authenticity. Receipts/consumer joins/owner closure follow separately.
 * An authenticated historical identity can resolve terminal references only. */
export function validateSectProductionRecordsV10(frame: SectUpgradeFrameV10,
  identities?: SectHistoricalIdentitySource): readonly SectProductionValidationIssue[] {
  const fail = (code: string, path: string): readonly SectProductionValidationIssue[] => [{ code, path }];
  const domain = frame.production; const authority = frame.construction;
  if (authority.lastSimulationTick !== authority.lastCalendarTick) return fail('INVALID_CLOCK', 'construction');
  if (!fields(domain, ['revision', 'nextId', 'jobs', 'receipts']) || !integer(domain.revision) || !integer(domain.nextId) || domain.nextId < 1
    || !array(domain.jobs, SECT_PRODUCTION_LIMITS.records) || !array(domain.receipts, SECT_PRODUCTION_LIMITS.receipts)) return fail('INVALID_DOMAIN', 'production');
  if (domain.jobs.some(job => !isLedgerDataRecord(job))) return fail('INVALID_JOB', 'production.jobs');
  const active = domain.jobs.filter(job => job.terminal === null);
  if (active.length + otherLocalActive(frame) > SECT_PRODUCTION_LIMITS.activeJobs) return fail('JOB_LIMIT', 'production.jobs');
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
      'reservationId', 'startedCalendarTick', 'origin', 'productiveSite', 'seatSiteId', 'workVisit', 'deliveryVisit', 'workSpans', 'terminal',
      ...((job.recipeId === 'craft.wound-powder.v9' || job.recipeId === 'craft.wound-powder-alt.v9') ? ['researchGate'] : [])])
      || !allocation(job.transactionId, 'sect-production') || !allocation(job.reservationId, 'sect-production-reservation') || jobIds.has(job.transactionId)
      || !(authority.people.some(person => person.id === job.workerId) || isArchivedSectWorkerReference(identities, job.workerId, job.terminal)) || !integer(job.startedTick) || job.startedTick > authority.lastSimulationTick
      || !integer(job.startedCalendarTick) || job.startedCalendarTick !== job.startedTick || job.startedCalendarTick > authority.lastCalendarTick || !cell(job.origin) || !inMap(job.origin)
      || !integer(job.activeTicks) || !integer(job.requiredTicks) || !PRODUCTION_PHASES.includes(job.phase)
      || !['Running', 'Blocked', 'Committed', 'Cancelled'].includes(job.state)
      || !(job.blockedReason === null || PRODUCTION_BLOCKED_REASONS.includes(job.blockedReason))
      || !nullableId(job.worksiteId) || !nullableId(job.storageId) || !nullableId(job.seatSiteId)
      || !array(job.workSpans, SECT_PRODUCTION_LIMITS.maximumWorkTicks)) return fail('INVALID_JOB', 'production.jobs');
    jobIds.add(job.transactionId);
    const recipe = getSectRecipeDefinition(job.recipeId);
    if (!recipe || (recipe.requiredResearch.length !== 0 && (!['craft.wound-powder.v9', 'craft.wound-powder-alt.v9'].includes(job.recipeId) || !isSectResearchGateRef(job.researchGate))) || job.requiredTicks !== recipe.workTicks || job.activeTicks > recipe.workTicks) return fail('INVALID_RECIPE_SOURCE', job.transactionId);
    const site = job.productiveSite;
    if (!siteProof(site)
      || !sectProductionSitesAtStartV10(frame, recipe, job.startedTick).some(proof => equal(proof, site))) return fail('INVALID_SITE_SOURCE', job.transactionId);
    if (site.kind === 'placed') {
      const sourceJob = authority.jobs.find(value => value.jobId === site.sourceJobId);
      if (sourceJob?.terminal?.kind !== 'completed' || sourceJob.terminal.tick > job.startedTick
        || sourceJob.terminal.calendarTick > job.startedCalendarTick || !sectBuildingPaidAt(frame, site.siteId, job.startedTick, job.startedCalendarTick)) return fail('INVALID_SITE_SOURCE', job.transactionId);
    }
    if (!avoidsUpgrades(frame, job)) return fail('PRODUCTION_UPGRADE_OVERLAP', job.transactionId);
    if (job.worksiteId !== null && job.worksiteId !== site.siteId || job.seatSiteId !== null && job.seatSiteId !== site.siteId) return fail('INVALID_SITE_OWNERSHIP', job.transactionId);
    const storage = authority.legacyStations.find(value => value.blueprintId === 'storage');
    if (!storage || (job.storageId !== null && job.storageId !== storage.id)) return fail('INVALID_STORAGE', job.transactionId);
    const visit = (value: typeof job.workVisit): boolean => value === null || fields(value, ['tick', 'calendarTick', 'position'])
      && integer(value.tick) && value.tick > job.startedTick && value.tick <= authority.lastSimulationTick
      && integer(value.calendarTick) && value.calendarTick === value.tick && value.calendarTick > job.startedCalendarTick && value.calendarTick <= authority.lastCalendarTick
      && value.calendarTick - job.startedCalendarTick <= value.tick - job.startedTick && cell(value.position) && inMap(value.position);
    if (!visit(job.workVisit) || !visit(job.deliveryVisit) || job.workVisit && !equal(job.workVisit.position, site.position)
      || job.deliveryVisit && (!job.workVisit || job.deliveryVisit.tick <= job.workVisit.tick || !equal(job.deliveryVisit.position, { x: storage.x, y: storage.y }))) return fail('INVALID_VISIT', job.transactionId);
    if (site.kind === 'placed' && job.workVisit && !sectBuildingPaidAt(frame, site.siteId, job.workVisit.tick, job.workVisit.calendarTick)) return fail('INVALID_PAID_VISIT', job.transactionId);
    const workTravel = Math.max(1, cardinalDistance(job.origin, site.position) * MOVEMENT_TICKS_PER_CELL);
    const deliveryTravel = Math.max(1, cardinalDistance(site.position, storage) * MOVEMENT_TICKS_PER_CELL);
    if (job.workVisit && (job.workVisit.tick - job.startedTick < workTravel || job.workVisit.calendarTick - job.startedCalendarTick < workTravel)) return fail('IMPOSSIBLE_TRAVEL_DURATION', job.transactionId);
    let count = 0; let lastTick = job.workVisit?.tick ?? job.startedTick; let lastCalendar = job.workVisit?.calendarTick ?? job.startedCalendarTick;
    for (const span of job.workSpans) {
      if (!fields(span, ['firstTick', 'lastTick', 'firstCalendarTick', 'lastCalendarTick']) || !integer(span.firstTick) || !integer(span.lastTick)
        || !integer(span.firstCalendarTick) || !integer(span.lastCalendarTick) || span.firstCalendarTick !== span.firstTick || span.lastCalendarTick !== span.lastTick || span.firstTick <= lastTick || span.firstCalendarTick <= lastCalendar
        || span.lastTick < span.firstTick || span.lastCalendarTick < span.firstCalendarTick || span.lastTick > authority.lastSimulationTick
        || span.lastCalendarTick > authority.lastCalendarTick || span.firstCalendarTick - lastCalendar > span.firstTick - lastTick || span.lastTick - span.firstTick !== span.lastCalendarTick - span.firstCalendarTick
        || count > 0 && span.firstTick === lastTick + 1 && span.firstCalendarTick === lastCalendar + 1
        || site.firstMaintenanceCalendarTick !== null && !sectBuildingPaidRange(frame, site.siteId, span.firstTick, span.lastTick, span.firstCalendarTick, span.lastCalendarTick)) return fail('INVALID_WORK_EVIDENCE', job.transactionId);
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
        || !integer(terminal.calendarTick) || terminal.calendarTick !== terminal.tick || terminal.calendarTick < lastCalendar || terminal.calendarTick > authority.lastCalendarTick
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
          || site.firstMaintenanceCalendarTick !== null && !sectBuildingPaidAt(frame, site.siteId, terminal.tick, terminal.calendarTick)) return fail('INVALID_COMPLETION', job.transactionId);
      } else if (job.state !== 'Cancelled' || job.phase !== 'Cancelled' || claim.base.settlement?.kind !== 'released'
        || claim.base.settlement.operationId !== `cancel:${job.transactionId}` || terminal.consumed.length || terminal.outputs.length
        || !equal(terminal.released, normalizeSectResourceLines(recipe.inputs))) return fail('INVALID_CANCELLATION', job.transactionId);
    }
  }
  return [];
}
/** Fixed receipt leaf after records. The root closes the complete six-domain owner union. */
export function validateSectProductionReceiptsV10(frame: SectUpgradeFrameV10): readonly SectProductionValidationIssue[] {
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
function contextProblem(frame: SectUpgradeFrameV10, context: SectProductionContext): SectProductionRejection | null {
  if (!isSectUpgradeDataTreeV10(context, 600) || !validateConstructionContext(context) || context.simulationTick !== context.calendarTick) return 'INVALID_CONTEXT';
  return context.simulationTick !== frame.construction.lastSimulationTick || context.calendarTick !== frame.construction.lastCalendarTick ? 'STALE_CLOCK' : null;
}
const otherLocalActive = (frame: SectUpgradeFrameV10): number => frame.construction.jobs.filter(job => job.terminal === null).length
  + frame.research.jobs.filter(job => job.terminal === null).length + frame.care.jobs.filter(job => job.terminal === null).length
  + frame.upgrade.jobs.filter(job => job.terminal === null).length;
/** Internal fixed candidate port only. The root authenticates COMPLETE source/candidate,
 * including historical identities, player/system command namespaces, owners and capacity.
 * Do not re-run unauthenticated local validators here: genuine retired history is legal. */
export function applyValidatedSectProductionCommandV10(frame: SectUpgradeFrameV10, context: SectProductionContext, command: SectProductionCommand): SectProductionResultV10 {
  const invalid = contextProblem(frame, context); if (invalid) return rejected(frame, invalid);
  if (!isSectProductionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const old = frame.production.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (old) return same(old.command, command) ? accepted(frame, old.jobId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  if ([...frame.construction.receipts, ...frame.research.receipts, ...frame.care.receipts, ...frame.upgrade.receipts]
    .some(receipt => receipt.command.commandId === command.commandId)) return rejected(frame, 'IDENTITY_CONFLICT');
  if (command.expectedRevision !== frame.production.revision) return rejected(frame, 'STALE_REVISION');
  if (frame.production.revision === MAX) return rejected(frame, 'CAPACITY_EXCEEDED');
  let next = frame; let jobId: string;
  if (command.kind === 'production.start') {
    const recipe = getSectRecipeDefinition(command.recipeId);
    if (!recipe) return rejected(frame, 'UNKNOWN_RECIPE');
    const researchGate = productionResearchGateV10(frame, recipe.recipeId, context.simulationTick, context.calendarTick);
    if (recipe.requiredResearch.length && !researchGate) return rejected(frame, 'RESEARCH_AUTHORITY_REQUIRED');
    if (context.mode !== 'management' || context.paused || context.expeditionActive) return rejected(frame, 'MANAGEMENT_REQUIRED');
    const active = frame.production.jobs.filter(live);
    if (active.length + otherLocalActive(frame) + context.externalActiveJobs >= SECT_PRODUCTION_LIMITS.activeJobs
      || frame.production.jobs.length >= SECT_PRODUCTION_LIMITS.records || frame.production.receipts.length + active.length + 2 > SECT_PRODUCTION_LIMITS.receipts
      || frame.construction.ledger.reservations.length >= 384 || frame.production.nextId > MAX - 2 || context.simulationTick > MAX - 20) return rejected(frame, 'CAPACITY_EXCEEDED');
    const worker = frame.construction.people.find(person => person.id === command.workerId);
    if (!worker || !eligible(worker) || active.some(job => job.workerId === worker.id)) return rejected(frame, 'WORKER_UNAVAILABLE');
    if (otherClaims(frame, context).some(claim => claim.kind === 'worker' && claim.key === worker.id)) return rejected(frame, 'CLAIM_CONFLICT');
    const sites = sectProductionSitesV10(frame, recipe).filter(site => siteUsable(frame, recipe, site));
    if (!sites.length) return rejected(frame, 'WORKSTATION_UNAVAILABLE');
    const site = sites.filter(value => siteOwner(frame, context, value) === null).sort((a, b) => cardinalDistance(worker.position, a.position) - cardinalDistance(worker.position, b.position) || compareStable(a.siteId, b.siteId))[0];
    if (!site) return rejected(frame, 'CLAIM_CONFLICT');
    if (!frame.construction.legacyStations.some(value => value.blueprintId === 'storage' && value.operational)) return rejected(frame, 'STORAGE_UNAVAILABLE');
    jobId = `sect-production:${frame.production.nextId}`;
    const reservationId = `sect-production-reservation:${frame.production.nextId + 1}`;
    const reserved = reserveSectResources(frame.construction.ledger, { reservationId, ownerTransactionId: jobId }, recipe.inputs, 'on-completion');
    if (!reserved.ok) return rejected(frame, reserved.rejection.code === 'INSUFFICIENT_INVENTORY' ? 'INSUFFICIENT_INVENTORY' : 'INVALID_RESERVATION');
    const progress = { transactionId: jobId, workerId: worker.id, reservationId, state: 'Running' as const, activeTicks: 0,
      requiredTicks: recipe.workTicks, startedTick: context.simulationTick, startedCalendarTick: context.calendarTick, origin: { ...worker.position },
      blockedReason: null, phase: 'WaitingForStation' as const, worksiteId: null, storageId: null, navigation: emptyNavigation(), seatSiteId: null,
      workVisit: null, deliveryVisit: null, workSpans: [], terminal: null };
    let job: SectProductionJobV10;
    if (site.level === 2) {
      if (recipe.recipeId === 'craft.wound-powder.v9' && researchGate?.researchId === 'basic-medicine.v9') {
        job = { ...progress, recipeId: recipe.recipeId, productiveSite: cloneJson(site),
          researchGate: { researchId: 'basic-medicine.v9', completionJobId: researchGate.completionJobId } };
      } else if (recipe.recipeId === 'craft.wound-powder-alt.v9' && researchGate?.researchId === 'herbal-compatibility.v9') {
        job = { ...progress, recipeId: recipe.recipeId, productiveSite: cloneJson(site),
          researchGate: { researchId: 'herbal-compatibility.v9', completionJobId: researchGate.completionJobId } };
      } else return rejected(frame, 'WORKSTATION_UNAVAILABLE');
    } else {
      if (recipe.recipeId === 'craft.wound-powder-alt.v9') return rejected(frame, 'WORKSTATION_UNAVAILABLE');
      job = { ...progress, recipeId: recipe.recipeId, productiveSite: cloneJson(site), ...(researchGate ? { researchGate } : {}) };
    }
    next = { ...frame, construction: { ...frame.construction, ledger: reserved.context },
      production: { ...frame.production, nextId: frame.production.nextId + 2, jobs: [...frame.production.jobs, job] } };
  } else {
    const job = frame.production.jobs.find(value => value.transactionId === command.jobId);
    if (!job) return rejected(frame, 'UNKNOWN_JOB');
    if (!live(job)) return rejected(frame, 'TRANSACTION_FINISHED');
    jobId = job.transactionId;
    const person = frame.construction.people.find(value => value.id === job.workerId)!;
    // Cancellation never rechecks station/research eligibility and never teleports an actor.
    if (!person || !isWalkable(constructionEffectiveMap(frame.construction), person.position)) return rejected(frame, 'UNSAFE_POSITION');
    const claim = frame.construction.ledger.reservations.find(value => value.reservationId === job.reservationId)!;
    const released = releaseSectReservation(frame.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: jobId }, `cancel:${jobId}`);
    if (!released.ok) return rejected(frame, 'INVALID_RESERVATION');
    next = replace({ ...frame, construction: { ...frame.construction, ledger: released.context } }, { ...job, state: 'Cancelled', phase: 'Cancelled',
      worksiteId: null, seatSiteId: null, navigation: emptyNavigation(), blockedReason: null,
      terminal: { kind: 'cancelled', tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...person.position },
        previousPhase: job.phase as Exclude<SectProductionJobV10['phase'], 'Done' | 'Cancelled'>, consumed: [], released: sectReservationLines(claim, 'remainingReservation'), outputs: [] } });
  }
  next = { ...next, production: { ...next.production, revision: frame.production.revision + 1,
    receipts: [...next.production.receipts, { command: cloneJson(command), revision: frame.production.revision + 1, jobId }] } };
  return accepted(next, jobId);
}
function releaseSeat(frame: SectUpgradeFrameV10, id: string): SectUpgradeFrameV10 {
  const job = currentJob(frame, id); return job.seatSiteId === null ? frame : replace(frame, { ...job, seatSiteId: null });
}
function blockedUnavailable(frame: SectUpgradeFrameV10, id: string): SectUpgradeFrameV10 {
  const job = currentJob(frame, id);
  return replace(frame, { ...job, state: 'Blocked', blockedReason: 'WORKER_UNAVAILABLE', seatSiteId: null, worksiteId: null,
    phase: job.activeTicks === job.requiredTicks ? 'TravellingToStorage' : 'WaitingForStation', navigation: emptyNavigation() });
}
function makeContext(context: SectProductionContext): ProductionContext<SectUpgradeFrameV10, SectProductionJobV10> {
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
      if (!siteUsable(frame, recipe, job.productiveSite, job)) return [];
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
      if (!siteUsable(frame, recipe, job.productiveSite, job)) {
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
/** Internal fixed production-only stage. Root has ALREADY advanced the single clock and
 * authenticated the source. It owns once-per-tick execution and complete candidate admission.
 * Uses the existing phase runner and caller's shared budget, never a policy callback. */
export function tickValidatedSectProductionV10(frame: SectUpgradeFrameV10, context: SectProductionContext, budget: WorkPathBudget): SectUpgradeFrameV10 {
  const invalid = contextProblem(frame, context); if (invalid) throw new RangeError(invalid);
  if (context.mode !== 'management' || context.paused || context.expeditionActive) return frame;
  if (!budget || budget.simulationTick !== context.simulationTick) throw new RangeError('Invalid path budget');
  if (frame.production.revision === MAX || frame.production.jobs.some(live) && context.simulationTick > MAX - 20) throw new RangeError('CAPACITY_EXCEEDED');
  return runProductionPhases<SectUpgradeFrameV10, SectProductionJobV10>({ ...frame,
    production: { ...frame.production, revision: frame.production.revision + 1 } }, makeContext(context), budget);
}
