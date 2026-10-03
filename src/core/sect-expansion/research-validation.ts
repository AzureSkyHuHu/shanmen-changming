import { SECT_RESEARCH_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';
import { relocationResearchSitesFromRecordsAt } from '../world/relocation-owner/history-sites';
import type { SectRelocationRecordFrame } from './relocation-types';
export { SECT_RESEARCH_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';
import { isArchivedSectWorkerReference, type SectHistoricalIdentitySource } from './history-identity';
import { sectBuildingPaidAt, sectBuildingPaidRange, type SectMaintenancePeriodSource } from './maintenance-periods';
import type { SectMaintenanceFrame } from './maintenance-types';
import { getSectResearchDefinition } from '../../content/sect-v9/catalog';
import type { SectResearchDefinition } from '../../content/sect-v9/types';
import { cardinalDistance, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, compareStable } from '../kernel/serialization';
import { constructionClaims } from './construction';
import type { ConstructionClaim } from './construction-types';
import { validateConstructionRecords } from './construction-record-validation';
import { validateSectResearchConsumerGates } from './research-consumer-gates';
import { deriveSectFootprint, ownSectFields } from './layout';
import { normalizeSectResourceLines, sectReservationLines } from './ledger';
import { sectProductionClaims, validateSectProductionRecords, validateSectProductionReceipts } from './production-runtime';
import { SECT_RESEARCH_LIMITS, type SectResearchCommand, type SectResearchFrame, type SectResearchSiteProof, type SectResearchValidationIssue } from './research-types';

const integer = isNonNegativeInteger;
const fields = ownSectFields;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const same = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const array = (value: unknown, maximum: number): value is unknown[] => isLedgerDataArray(value) && (value as unknown[]).length <= maximum;
const cell = (value: unknown): boolean => fields(value, ['x', 'y']) && integer(value.x) && integer(value.y) && value.x <= 255 && value.y <= 255;
const key = (p: { readonly x: number; readonly y: number }): string => `${p.x},${p.y}`;
type SectResearchRecordSource = Pick<SectResearchFrame, 'construction' | 'research'>;
export type SectMaintainedResearchRecordSource = SectResearchRecordSource & Pick<SectMaintenanceFrame, 'maintenance'>;
function plainTree(value: unknown, depth = 0, budget = { left: SECT_RESEARCH_DESCRIPTOR_NODE_BOUND }): boolean {
  if (--budget.left < 0 || depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return value.length <= 256;
  if (Array.isArray(value)) return isLedgerDataArray(value) && value.length <= 65536 && value.every(child => plainTree(child, depth + 1, budget));
  return isLedgerDataRecord(value) && Object.values(value as Record<string, unknown>).every(child => plainTree(child, depth + 1, budget));
}
export function isSectResearchCommand(value: unknown): value is SectResearchCommand {
  if (!plainTree(value, 0, { left: 100 }) || !fields(value, ['commandId', 'expectedRevision', 'kind'], false)
    || !id(value.commandId) || !integer(value.expectedRevision)) return false;
  if (value.kind === 'research.start') return fields(value, ['commandId', 'expectedRevision', 'kind', 'researchId', 'workerId']) && id(value.researchId) && id(value.workerId);
  return value.kind === 'research.cancel' && fields(value, ['commandId', 'expectedRevision', 'kind', 'jobId']) && id(value.jobId);
}
/** Both registered nodes require the same genuinely constructed, ungated library L1. */
export function sectResearchSites(frame: Pick<SectResearchFrame, 'construction'>, definition: SectResearchDefinition): readonly SectResearchSiteProof[] {
  return frame.construction.buildings.filter(building => definition.workstation.definitionId === 'library.v9' && building.definitionId === 'library.v9' && building.level === 1
    && building.level >= definition.workstation.minimumLevel && frame.construction.blueprints.some(bp => bp.jobId === building.sourceJobId && bp.definitionId === 'library.v9' && bp.researchGate === undefined)).map(building => {
    const shape = deriveSectFootprint({ definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation });
    if (!shape.ok) throw new Error('Validated research building geometry was lost');
    return { buildingId: building.buildingId, sourceJobId: building.sourceJobId, position: shape.footprint.entrance,
      level: 1 as const, firstMaintenanceCalendarTick: building.firstMaintenanceCalendarTick };
  });
}
export function sectResearchClaims(frame: SectResearchFrame): readonly ConstructionClaim[] {
  return frame.research.jobs.filter(job => job.terminal === null).slice().sort((a, b) => compareStable(a.jobId, b.jobId)).flatMap(job => [
    { kind: 'worker' as const, key: job.workerId, ownerId: job.jobId },
    { kind: 'seat' as const, key: job.site.buildingId, ownerId: job.jobId },
    { kind: 'entrance' as const, key: key(job.site.position), ownerId: job.jobId },
  ]);
}
export function sectAllLocalClaims(frame: SectResearchFrame): readonly ConstructionClaim[] {
  return [...constructionClaims(frame.construction), ...sectProductionClaims(frame), ...sectResearchClaims(frame)];
}
export function sectClaimsConflict(claims: readonly ConstructionClaim[]): boolean {
  const seen = new Set<string>();
  for (const claim of claims) { const token = `${claim.kind}:${claim.key}`; if (seen.has(token)) return true; seen.add(token); }
  return false;
}
/** Acyclic order: descriptors → construction → local production → research DAG/evidence → consumer gates →
 * exact three-owner closure → cross-domain claims/headroom. Never weaken a public validator. */
export function validateSectResearchFrame(input: unknown): readonly SectResearchValidationIssue[] {
  const fail = (code: string, path: string): readonly SectResearchValidationIssue[] => [{ code, path }];
  if (!plainTree(input) || !fields(input, ['schemaVersion', 'construction', 'production', 'research']) || input.schemaVersion !== 1) return fail('INVALID_SHAPE', 'frame');
  const frame = input as unknown as SectResearchFrame; const authority = frame.construction;
  const constructionIssues = validateConstructionRecords(authority);
  if (constructionIssues.length) return constructionIssues.map(issue => ({ ...issue, path: `construction.${issue.path}` }));
  const productionIssues = validateSectProductionRecords(frame);
  if (productionIssues.length) return productionIssues;
  const productionReceipts = validateSectProductionReceipts(frame);
  if (productionReceipts.length) return productionReceipts;
  const records = validateSectResearchRecords(frame);
  if (records.length) return records;
  const domain = frame.research; const active = domain.jobs.filter(job => job.terminal === null);
  const gates = validateSectResearchConsumerGates(frame);
  if (gates.length) return gates;
  for (const claim of authority.ledger.reservations) {
    const owners = authority.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + frame.production.jobs.filter(job => job.transactionId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + domain.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length;
    if (owners !== 1) return fail('ORPHAN_RESERVATION', claim.reservationId);
  }
  if (active.length + authority.jobs.filter(job => job.terminal === null).length + frame.production.jobs.filter(job => job.terminal === null).length > 36) return fail('JOB_LIMIT', 'frame');
  if (sectClaimsConflict(sectAllLocalClaims(frame))) return fail('CLAIM_CONFLICT', 'frame');
  return [];
}

function paidAt(_frame: SectResearchRecordSource, site: SectResearchSiteProof, tick: number, calendar: number, maintenance?: SectMaintenancePeriodSource): boolean {
  return maintenance ? sectBuildingPaidAt(maintenance, site.buildingId, tick, calendar) : calendar < site.firstMaintenanceCalendarTick;
}
/** Narrow local research stage. Construction and production descriptors/records are already checked. */
export function validateSectResearchRecords(frame: SectResearchFrame): readonly SectResearchValidationIssue[] {
  return validateResearchRecords(frame);
}
/** Four-domain stage, called only after immutable maintenance records have been authenticated. */
export function validateMaintainedSectResearchRecords(frame: SectMaintenanceFrame): readonly SectResearchValidationIssue[] {
  return validateResearchRecords(frame, frame);
}
/** World-only record leaf; its authenticated history source cannot supply active actors. */
export function validateWorldMaintainedSectResearchRecords(frame: SectMaintenanceFrame, identities: SectHistoricalIdentitySource): readonly SectResearchValidationIssue[] {
  return validateResearchRecords(frame, frame, identities);
}
/** Fixed one-source leaf for later version owners. Construction, the complete maintenance
 * history and every library payment must already be authenticated. All research evidence,
 * payment, DAG and receipt checks are identical to the v9 wrappers. This is not admission. */
export function validateMaintainedSectResearchSourceRecords(frame: SectMaintainedResearchRecordSource,
  identities?: SectHistoricalIdentitySource): readonly SectResearchValidationIssue[] {
  return validateResearchRecords(frame, frame, identities);
}
/** Fixed relocation-owner leaf, after construction/relocation/maintenance authentication.
 * Reuses every old check in its old order, changing only immutable site-at-start
 * geometry. Full lifetime exclusion and phase joins remain the owner's next stage. */
export function validateRelocationOwnerResearchSourceRecords(frame: SectMaintainedResearchRecordSource & SectRelocationRecordFrame): readonly SectResearchValidationIssue[] {
  return validateResearchRecords(frame, frame, undefined, frame);
}
function validateResearchRecords(frame: SectResearchRecordSource, maintenance?: SectMaintenancePeriodSource, identities?: SectHistoricalIdentitySource,
  relocation?: SectRelocationRecordFrame): readonly SectResearchValidationIssue[] {
  const fail = (code: string, path: string): readonly SectResearchValidationIssue[] => [{ code, path }];
  const authority = frame.construction;
  const domain = frame.research;
  if (!fields(domain, ['revision', 'nextId', 'jobs', 'receipts']) || !integer(domain.revision) || !integer(domain.nextId) || domain.nextId < 1
    || !array(domain.jobs, SECT_RESEARCH_LIMITS.records) || !array(domain.receipts, SECT_RESEARCH_LIMITS.receipts)
    || domain.jobs.some(job => !isLedgerDataRecord(job))) return fail('INVALID_DOMAIN', 'research');
  const active = domain.jobs.filter(job => job.terminal === null);
  if (active.length > 1) return fail('DUPLICATE_ACTIVE_RESEARCH', 'research.jobs');
  if (domain.revision > Number.MAX_SAFE_INTEGER - active.length || domain.receipts.length + active.length > SECT_RESEARCH_LIMITS.receipts) return fail('CANCELLATION_OBLIGATION', 'research');
  const allocations = new Set<number>(); const completed = new Map<string, string>();
  const inMap = (p: { readonly x: number; readonly y: number }): boolean => p.x < authority.map.width && p.y < authority.map.height;
  const allocation = (value: unknown, prefix: string): boolean => {
    if (!id(value) || !value.startsWith(`${prefix}:`)) return false;
    const suffix = value.slice(prefix.length + 1); const n = Number(suffix);
    if (!integer(n) || n < 1 || String(n) !== suffix || n >= domain.nextId || allocations.has(n)
      || authority.people.some(person => person.id === value) || authority.legacyStations.some(site => site.id === value)) return false;
    allocations.add(n); return true;
  };
  let previousEndTick = 0; let previousEndCalendar = 0; let previousLive = false;
  for (const job of domain.jobs) {
    if (!fields(job, ['jobId', 'reservationId', 'researchId', 'workerId', 'startedTick', 'startedCalendarTick', 'origin', 'site', 'prerequisites',
      'phase', 'activeTicks', 'requiredTicks', 'visits', 'workSpans', 'navigation', 'blocked', 'terminal'])
      || !allocation(job.jobId, 'sect-research') || !allocation(job.reservationId, 'sect-research-reservation')
      || !(authority.people.some(person => person.id === job.workerId) || isArchivedSectWorkerReference(identities, job.workerId, job.terminal)) || !integer(job.startedTick) || job.startedTick > authority.lastSimulationTick
      || !integer(job.startedCalendarTick) || job.startedCalendarTick > authority.lastCalendarTick || !cell(job.origin) || !inMap(job.origin)
      || !integer(job.activeTicks) || !integer(job.requiredTicks) || !['to-site', 'working', 'completed', 'cancelled'].includes(job.phase)
      || ![null, 'PATH_BLOCKED', 'PATH_BUDGET', 'WORKER_UNAVAILABLE', 'WORKSTATION_UNAVAILABLE', 'ENTRANCE_BUSY', 'VISIT_CAPACITY'].includes(job.blocked)
      || !array(job.visits, SECT_RESEARCH_LIMITS.visits) || !array(job.workSpans, SECT_RESEARCH_LIMITS.maximumWorkTicks)
      || !array(job.prerequisites, 2)) return fail('INVALID_JOB', 'research.jobs');
    const definition = getSectResearchDefinition(job.researchId);
    if (!definition || job.requiredTicks !== definition.workTicks || job.activeTicks > definition.workTicks) return fail('INVALID_RESEARCH_SOURCE', job.jobId);
    if (previousLive || job.startedTick < previousEndTick || job.startedCalendarTick < previousEndCalendar || completed.has(job.researchId)) return fail('RESEARCH_CHRONOLOGY', job.jobId);
    if (job.prerequisites.length !== definition.prerequisites.length || job.prerequisites.some((ref, i) => !fields(ref, ['researchId', 'completionJobId'])
      || ref.researchId !== definition.prerequisites[i] || completed.get(ref.researchId) !== ref.completionJobId)) return fail('INVALID_PREREQUISITE', job.jobId);
    for (const ref of job.prerequisites) {
      const parent = domain.jobs.find(value => value.jobId === ref.completionJobId)!;
      if (!parent || parent.terminal?.kind !== 'completed' || parent.terminal.tick > job.startedTick || parent.terminal.calendarTick > job.startedCalendarTick) return fail('INVALID_PREREQUISITE_CHRONOLOGY', job.jobId);
    }
    const site = job.site;
    if (!fields(site, ['buildingId', 'sourceJobId', 'position', 'level', 'firstMaintenanceCalendarTick'])
      || !(relocation ? relocationResearchSitesFromRecordsAt(relocation, definition, { tick: job.startedTick, phase: 'legacy-production', side: 'after' })
        : sectResearchSites(frame, definition)).some(proof => same(proof, site))) return fail('INVALID_SITE_SOURCE', job.jobId);
    const source = authority.jobs.find(value => value.jobId === site.sourceJobId);
    if (source?.terminal?.kind !== 'completed' || source.terminal.tick > job.startedTick || source.terminal.calendarTick > job.startedCalendarTick
      || !paidAt(frame, site, job.startedTick, job.startedCalendarTick, maintenance)) return fail('INVALID_PAID_SITE', job.jobId);
    let visitTick = job.startedTick; let visitCalendar = job.startedCalendarTick;
    for (const [i, visit] of job.visits.entries()) {
      if (!fields(visit, ['tick', 'calendarTick', 'position']) || !integer(visit.tick) || !integer(visit.calendarTick)
        || visit.tick <= visitTick || visit.calendarTick <= visitCalendar || visit.tick > authority.lastSimulationTick || visit.calendarTick > authority.lastCalendarTick
        || visit.calendarTick - visitCalendar > visit.tick - visitTick || !same(visit.position, site.position)
        || !paidAt(frame, site, visit.tick, visit.calendarTick, maintenance)
        || i === 0 && (visit.tick - job.startedTick < Math.max(1, cardinalDistance(job.origin, site.position) * MOVEMENT_TICKS_PER_CELL)
          || visit.calendarTick - job.startedCalendarTick < Math.max(1, cardinalDistance(job.origin, site.position) * MOVEMENT_TICKS_PER_CELL))) return fail('INVALID_VISIT', job.jobId);
      visitTick = visit.tick; visitCalendar = visit.calendarTick;
    }
    let count = 0; let lastTick = job.startedTick; let lastCalendar = job.startedCalendarTick; let lastVisit = -1;
    for (const span of job.workSpans) {
      if (!fields(span, ['firstTick', 'lastTick', 'firstCalendarTick', 'lastCalendarTick', 'visitIndex']) || !integer(span.firstTick) || !integer(span.lastTick)
        || !integer(span.firstCalendarTick) || !integer(span.lastCalendarTick) || !integer(span.visitIndex) || span.visitIndex >= job.visits.length || span.visitIndex < lastVisit
        || span.firstTick <= lastTick || span.firstCalendarTick <= lastCalendar || span.lastTick < span.firstTick || span.lastCalendarTick < span.firstCalendarTick
        || span.lastTick > authority.lastSimulationTick || span.lastCalendarTick > authority.lastCalendarTick
        || span.firstCalendarTick - lastCalendar > span.firstTick - lastTick || span.lastTick - span.firstTick !== span.lastCalendarTick - span.firstCalendarTick
        || !(maintenance ? sectBuildingPaidRange(maintenance, site.buildingId, span.firstTick, span.lastTick, span.firstCalendarTick, span.lastCalendarTick) : span.lastCalendarTick < site.firstMaintenanceCalendarTick)) return fail('INVALID_WORK_EVIDENCE', job.jobId);
      const visit = job.visits[span.visitIndex]!; const nextVisit = job.visits[span.visitIndex + 1];
      if (span.firstTick <= visit.tick || span.firstCalendarTick <= visit.calendarTick
        || span.firstCalendarTick - visit.calendarTick > span.firstTick - visit.tick
        || nextVisit && (span.lastTick >= nextVisit.tick || span.lastCalendarTick >= nextVisit.calendarTick)
        || count > 0 && span.visitIndex === lastVisit && span.firstTick === lastTick + 1 && span.firstCalendarTick === lastCalendar + 1) return fail('INVALID_WORK_VISIT', job.jobId);
      count += span.lastTick - span.firstTick + 1; lastTick = span.lastTick; lastCalendar = span.lastCalendarTick; lastVisit = span.visitIndex;
    }
    if (count !== job.activeTicks || (job.phase === 'working' && job.visits.length === 0)) return fail('INVALID_WORK_EVIDENCE', job.jobId);
    const claim = authority.ledger.reservations.find(value => value.ownerTransactionId === job.jobId && value.reservationId === job.reservationId);
    if (!claim || claim.policy !== 'on-completion' || !same(sectReservationLines(claim, 'lines'), normalizeSectResourceLines(definition.costs))) return fail('INVALID_COST_SOURCE', job.jobId);
    const nav = job.navigation;
    if (!fields(nav, ['path', 'target', 'routeVersion', 'movementTicks', 'retryAtTick']) || !array(nav.path, authority.map.width * authority.map.height)
      || nav.path.some(p => !cell(p) || !inMap(p)) || !(nav.target === null || cell(nav.target) && inMap(nav.target) && same(nav.target, site.position))
      || !(nav.routeVersion === null || integer(nav.routeVersion) && nav.routeVersion <= authority.map.navVersion)
      || !integer(nav.movementTicks) || nav.movementTicks >= MOVEMENT_TICKS_PER_CELL || !integer(nav.retryAtTick)
      || nav.path.some((p, i) => i > 0 && cardinalDistance(p, nav.path[i - 1]!) !== 1)) return fail('INVALID_NAVIGATION', job.jobId);
    if (job.terminal === null) {
      if (!['to-site', 'working'].includes(job.phase) || count >= definition.workTicks || claim.base.settlement !== null) return fail('INVALID_ACTIVE_RESEARCH', job.jobId);
      previousLive = true;
    } else {
      const terminal = job.terminal;
      if (!fields(terminal, ['tick', 'calendarTick', 'position', 'kind', 'previousPhase', 'consumed', 'released'])
        || !['completed', 'cancelled'].includes(terminal.kind) || job.phase !== terminal.kind || !integer(terminal.tick) || !integer(terminal.calendarTick)
        || terminal.tick < Math.max(lastTick, visitTick) || terminal.calendarTick < Math.max(lastCalendar, visitCalendar)
        || terminal.tick > authority.lastSimulationTick || terminal.calendarTick > authority.lastCalendarTick
        || terminal.calendarTick - job.startedCalendarTick > terminal.tick - job.startedTick || !cell(terminal.position) || !inMap(terminal.position)
        || !['to-site', 'working'].includes(terminal.previousPhase) || terminal.previousPhase === 'working' && !job.visits.length
        || !same(terminal.consumed, sectReservationLines(claim, 'consumed')) || !array(terminal.released, 9)
        || nav.path.length || nav.target !== null || nav.routeVersion !== null || nav.movementTicks !== 0 || nav.retryAtTick !== 0 || job.blocked !== null) return fail('INVALID_TERMINAL', job.jobId);
      if (terminal.kind === 'completed') {
        if (count !== definition.workTicks || terminal.tick !== lastTick || terminal.calendarTick !== lastCalendar || terminal.previousPhase !== 'working'
          || !same(terminal.position, site.position) || terminal.released.length || !paidAt(frame, site, terminal.tick, terminal.calendarTick, maintenance)
          || claim.base.settlement?.kind !== 'committed' || claim.sect.settlement?.kind !== 'committed'
          || claim.base.settlement.operationId !== `complete:${job.jobId}` || claim.base.settlement.outputs.length || claim.sect.settlement.outputs.length
          || !same(terminal.consumed, normalizeSectResourceLines(definition.costs))) return fail('INVALID_COMPLETION', job.jobId);
        completed.set(job.researchId, job.jobId);
      } else if (count >= definition.workTicks || claim.base.settlement?.kind !== 'released' || claim.base.settlement.operationId !== `cancel:${job.jobId}`
        || terminal.consumed.length || !same(terminal.released, normalizeSectResourceLines(definition.costs))) return fail('INVALID_CANCELLATION', job.jobId);
      previousEndTick = terminal.tick; previousEndCalendar = terminal.calendarTick;
    }
  }
  const commandIds = new Set<string>(); let previousRevision = 0;
  for (const receipt of domain.receipts) {
    if (!fields(receipt, ['command', 'revision', 'jobId']) || !isSectResearchCommand(receipt.command) || !integer(receipt.revision)
      || receipt.revision !== receipt.command.expectedRevision + 1 || receipt.revision > domain.revision || receipt.revision <= previousRevision
      || commandIds.has(receipt.command.commandId) || !id(receipt.jobId)) return fail('INVALID_RECEIPT', 'research.receipts');
    previousRevision = receipt.revision; commandIds.add(receipt.command.commandId);
    const job = domain.jobs.find(value => value.jobId === receipt.jobId); const command = receipt.command;
    if (!job || (command.kind === 'research.start' ? command.researchId !== job.researchId || command.workerId !== job.workerId
      : command.jobId !== job.jobId || job.terminal?.kind !== 'cancelled')) return fail('INVALID_RECEIPT_SOURCE', receipt.jobId);
    if (command.kind === 'research.cancel' && !domain.receipts.some(start => start.jobId === job.jobId && start.command.kind === 'research.start' && start.revision < receipt.revision)) return fail('INVALID_RECEIPT_CHRONOLOGY', receipt.jobId);
  }
  let previousStartRevision = 0; let previousCancellationRevision = 0;
  for (const job of domain.jobs) {
    const starts = domain.receipts.filter(receipt => receipt.jobId === job.jobId && receipt.command.kind === 'research.start');
    const cancellations = domain.receipts.filter(receipt => receipt.jobId === job.jobId && receipt.command.kind === 'research.cancel');
    if (starts.length !== 1 || cancellations.length !== (job.terminal?.kind === 'cancelled' ? 1 : 0)) return fail('MISSING_RECEIPT', job.jobId);
    if (starts[0]!.revision <= previousStartRevision || starts[0]!.revision <= previousCancellationRevision) return fail('INVALID_RECEIPT_CHRONOLOGY', job.jobId);
    previousStartRevision = starts[0]!.revision; previousCancellationRevision = cancellations[0]?.revision ?? 0;
  }
  return [];
}
