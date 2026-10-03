import { getSectResearchDefinition } from '../../../content/sect-v9/catalog';
import type { SectCell } from '../../../content/sect-v9/types';
import { cardinalDistance, MOVEMENT_TICKS_PER_CELL } from '../../agents/navigation';
import { isNonNegativeInteger } from '../../kernel/numeric';
import { canonicalStringify, cloneJson } from '../../kernel/serialization';
import type { ConstructionValidationIssue } from '../../sect-expansion/construction-types';
import { SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND } from '../../sect-expansion/descriptor-bounds';
import { ownSectFields } from '../../sect-expansion/layout';
import { sectBuildingPaidAt } from '../../sect-expansion/maintenance-periods';
import { validateSectMaintenanceL1SourceRecords } from '../../sect-expansion/maintenance-v10';
import type { SectRelocationRecordFrame } from '../../sect-expansion/relocation-types';
import { SECT_RELOCATION_DESCRIPTOR_NODE_BOUND } from '../../sect-expansion/relocation-validation';
import type { SectResearchSiteProof, SectResearchState } from '../../sect-expansion/research-types';
import { validateRelocationOwnerResearchSourceRecords } from '../../sect-expansion/research-validation';
import type { SectMaintenanceStateV10 } from '../../sect-expansion/upgrade-types';
import { compareRelocationHistoryEdges as compare, relocationHistoryCommandEdge as commandEdge,
  relocationHistoryCompletionEdge as completionEdge, relocationHistoryIntersection as intersection,
  type RelocationHistoryDomain, type RelocationHistoryEdge, type RelocationHistoryInterval } from './history-order';
import { relocationResearchSitesFromRecordsAt } from './history-sites';
import { inspectRelocationOwnerSpatialRecords } from './spatial-records';

/** One actual authority/clock/map/people/shared ledger and four complete books.
 * Unrelated ledger owners remain present. No fabricated World or empty domain books. */
export interface RelocationOwnerResearchSource extends SectRelocationRecordFrame {
  readonly research: SectResearchState;
  readonly maintenance: SectMaintenanceStateV10;
}
const SCOPE = 'partial-relocation-owner-library-l1-research-records' as const;
export interface RelocationOwnerResearchFailure {
  readonly ok: false;
  readonly scope: typeof SCOPE;
  readonly issues: readonly ConstructionValidationIssue[];
}
/** Bounded records, shared clocks, L1 maintenance payments, site evidence and
 * construction/relocation/research worker lifetimes ONLY. Not World/save admission,
 * L2 payment/upgrade proof, lifecycle/archive/capacity, historical navigation,
 * worker eligibility, or permission to start/execute a new research task. */
export type RelocationOwnerResearchInspection =
  | { readonly ok: true; readonly scope: typeof SCOPE }
  | RelocationOwnerResearchFailure;
const fail = (code: string, path = 'research'): RelocationOwnerResearchFailure => ({ ok: false, scope: SCOPE, issues: [{ code, path }] });
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const integer = isNonNegativeInteger;

/** Descriptor capture before downstream property access. Reject aliases as well
 * as cycles, accessors, sparse arrays, extra descriptors and exotic prototypes.
 * Reflective Proxy traps, as in the spatial inspector, are not a security sandbox. */
function capture(input: unknown): unknown {
  const seen = new Set<object>();
  let left = SECT_RELOCATION_DESCRIPTOR_NODE_BOUND + SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND;
  const read = (value: unknown, depth: number): unknown => {
    if (--left < 0 || depth > 28) throw new Error('Descriptor budget');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && integer(value)) return value;
    if (typeof value === 'string' && value.length <= 256) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Invalid descriptor');
    seen.add(value);
    if (Array.isArray(value)) {
      const d = Object.getOwnPropertyDescriptor(value, 'length');
      if (Object.getPrototypeOf(value) !== Array.prototype || !d || !Object.hasOwn(d, 'value')
        || !integer(d.value) || d.value > 65536 || d.value > left || Reflect.ownKeys(value).length !== d.value + 1) throw new Error('Invalid array');
      const result: unknown[] = [];
      for (let i = 0; i < d.value; i++) {
        const item = Object.getOwnPropertyDescriptor(value, String(i));
        if (!item?.enumerable || !Object.hasOwn(item, 'value')) throw new Error('Invalid array item');
        result.push(read(item.value, depth + 1));
      }
      return result;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid prototype');
    const keys = Reflect.ownKeys(value); const result: Record<string, unknown> = {};
    if (keys.length > 64 || keys.length > left) throw new Error('Invalid object');
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !d?.enumerable || !Object.hasOwn(d, 'value')) throw new Error('Invalid field');
      result[key] = read(d.value, depth + 1);
    }
    return result;
  };
  return read(input, 0);
}
interface Lifetime extends RelocationHistoryInterval {
  readonly domain: RelocationHistoryDomain;
  readonly id: string;
  readonly worker: string;
  readonly building: string;
  readonly startCalendar: number;
  readonly origin: SectCell;
  readonly terminal: { readonly calendarTick: number; readonly position: SectCell } | null;
}
function joins(frame: RelocationOwnerResearchSource): RelocationOwnerResearchFailure | null {
  // One real paired clock for all observed endpoints; pauses cannot pay travel.
  const anchors = [
    { tick: frame.construction.lastSimulationTick, calendar: frame.construction.lastCalendarTick },
    ...frame.maintenance.payments.map(p => ({ tick: p.paidTick, calendar: p.paidCalendarTick })),
    ...frame.construction.blueprints.map(bp => ({ tick: bp.placedTick, calendar: bp.placedCalendarTick })),
    ...frame.construction.jobs.flatMap(j => [{ tick: j.startedTick, calendar: j.startedCalendarTick },
      ...(j.terminal ? [{ tick: j.terminal.tick, calendar: j.terminal.calendarTick }] : [])]),
    ...frame.relocation.jobs.flatMap(j => [{ tick: j.startedTick, calendar: j.startedCalendarTick },
      ...[j.oldEntranceVisit, ...j.newEntranceVisits, j.terminal].flatMap(v => v ? [{ tick: v.tick, calendar: v.calendarTick }] : []),
      ...j.workSpans.flatMap(s => [{ tick: s.firstTick, calendar: s.firstCalendarTick }, { tick: s.lastTick, calendar: s.lastCalendarTick }])]),
    ...frame.research.jobs.flatMap(j => [{ tick: j.startedTick, calendar: j.startedCalendarTick },
      ...[...j.visits, j.terminal].flatMap(v => v ? [{ tick: v.tick, calendar: v.calendarTick }] : []),
      ...j.workSpans.flatMap(s => [{ tick: s.firstTick, calendar: s.firstCalendarTick }, { tick: s.lastTick, calendar: s.lastCalendarTick }])]),
  ].sort((a, b) => a.tick - b.tick);
  if (anchors.some((a, i) => a.calendar > a.tick || i > 0 && (a.calendar < anchors[i - 1]!.calendar
    || a.calendar - anchors[i - 1]!.calendar > a.tick - anchors[i - 1]!.tick))) return fail('INVALID_RESEARCH_SHARED_CLOCK');
  const lifetimes: Lifetime[] = [];
  for (const job of frame.construction.jobs) {
    const start = frame.construction.receipts.find(r => r.command.kind === 'construction.start' && r.relatedId === job.jobId)!;
    const cancel = frame.construction.receipts.find(r => r.command.kind === 'construction.cancel' && r.relatedId === job.blueprintId);
    lifetimes.push({ domain: 'construction', id: job.jobId, worker: job.workerId, building: job.resultBuildingId,
      start: commandEdge(job.startedTick, 'construction', start.revision), startCalendar: job.startedCalendarTick, origin: job.origin,
      end: job.terminal === null ? null : job.terminal.kind === 'completed' ? completionEdge(job.terminal.tick, 'construction')
        : commandEdge(job.terminal.tick, 'construction', cancel!.revision), terminal: job.terminal });
  }
  for (const job of frame.relocation.jobs) {
    const start = frame.relocation.receipts.find(r => r.command.kind === 'relocation.start' && r.jobId === job.jobId)!;
    lifetimes.push({ domain: 'relocation', id: job.jobId, worker: job.workerId, building: job.buildingId,
      start: commandEdge(job.startedTick, 'relocation', start.revision), startCalendar: job.startedCalendarTick, origin: job.origin,
      end: job.terminal === null ? null : job.terminal.kind === 'completed' ? completionEdge(job.terminal.tick, 'relocation', job.terminal.revision)
        : commandEdge(job.terminal.tick, 'relocation', job.terminal.revision), terminal: job.terminal });
  }
  const researchCommands: RelocationHistoryEdge[] = [];
  for (const job of frame.research.jobs) {
    const start = frame.research.receipts.find(r => r.command.kind === 'research.start' && r.jobId === job.jobId)!;
    const cancel = frame.research.receipts.find(r => r.command.kind === 'research.cancel' && r.jobId === job.jobId);
    const begin = commandEdge(job.startedTick, 'research', start.revision);
    const end = job.terminal === null ? null : job.terminal.kind === 'completed' ? completionEdge(job.terminal.tick, 'research')
      : commandEdge(job.terminal.tick, 'research', cancel!.revision);
    researchCommands.push(begin); if (job.terminal?.kind === 'cancelled') researchCommands.push(end!);
    lifetimes.push({ domain: 'research', id: job.jobId, worker: job.workerId, building: job.site.buildingId,
      start: begin, startCalendar: job.startedCalendarTick, origin: job.origin, end, terminal: job.terminal });
  }
  researchCommands.sort((a, b) => a.revision - b.revision);
  if (researchCommands.some((edge, i) => i > 0 && compare(researchCommands[i - 1]!, edge)! >= 0)) return fail('INVALID_RESEARCH_COMMAND_CHRONOLOGY');
  for (let i = 0; i < lifetimes.length; i++) for (let n = i + 1; n < lifetimes.length; n++) {
    const a = lifetimes[i]!; const b = lifetimes[n]!;
    const sharedWorker = a.worker === b.worker;
    const sharedBuilding = a.building === b.building && (a.domain === 'research' && b.domain === 'relocation' || a.domain === 'relocation' && b.domain === 'research');
    if (!sharedWorker && !sharedBuilding) continue;
    const overlap = intersection(a, b);
    if (overlap !== 'none') return fail(overlap === 'ambiguous' ? 'AMBIGUOUS_RESEARCH_HISTORY_BOUNDARY'
      : sharedBuilding ? 'RESEARCH_RELOCATION_BUILDING_OVERLAP' : 'RESEARCH_HISTORY_WORKER_OVERLAP', `${a.id}:${b.id}`);
    if (!sharedWorker) continue;
    const before = a.end && compare(a.end, b.start) !== null && compare(a.end, b.start)! <= 0 ? a : b;
    const after = before === a ? b : a;
    if (!before.end || !before.terminal) return fail('INVALID_RESEARCH_WORKER_CONTINUITY', `${before.id}:${after.id}`);
    const elapsed = after.startCalendar - before.terminal.calendarTick;
    if (elapsed < cardinalDistance(before.terminal.position, after.origin) * MOVEMENT_TICKS_PER_CELL
      || elapsed > after.start.tick - before.end.tick) return fail('INVALID_RESEARCH_WORKER_CONTINUITY', `${before.id}:${after.id}`);
  }
  // Whole-lifetime exclusion above detects out-and-back moves even if every
  // sparse research site sample and the final entrance happen to be identical.
  for (const job of frame.research.jobs) {
    if (job.terminal) {
      const observed = [{ calendar: job.startedCalendarTick, position: job.origin },
        ...job.visits.map(v => ({ calendar: v.calendarTick, position: v.position })),
        ...job.workSpans.map(span => ({ calendar: span.lastCalendarTick, position: job.site.position }))];
      if (observed.some(p => job.terminal!.calendarTick - p.calendar < cardinalDistance(p.position, job.terminal!.position) * MOVEMENT_TICKS_PER_CELL))
        return fail('INVALID_RESEARCH_TERMINAL_TRAVEL', job.jobId);
    }
    const definition = getSectResearchDefinition(job.researchId)!;
    const evidence = [...job.visits.map(v => v.tick), ...job.workSpans.flatMap(s => [s.firstTick, s.lastTick]),
      ...(job.terminal?.kind === 'completed' ? [job.terminal.tick] : [])];
    if (evidence.some(tick => !relocationResearchSitesFromRecordsAt(frame, definition, { tick, phase: 'research', side: 'after' })
      .some(site => same(site, job.site)))) return fail('INVALID_RESEARCH_HISTORICAL_SITE', job.jobId);
  }
  return null;
}
function inspect(input: unknown): { readonly ok: true; readonly frame: RelocationOwnerResearchSource } | RelocationOwnerResearchFailure {
  try {
    const captured = capture(input);
    if (!ownSectFields(captured, ['construction', 'relocation', 'research', 'maintenance'])) return fail('INVALID_RESEARCH_SOURCE_SHAPE');
    // This assertion follows descriptor capture only; every domain is authenticated
    // below before it can be used as evidence. It never supplies a validation flag.
    const frame = captured as unknown as RelocationOwnerResearchSource;
    const spatial = inspectRelocationOwnerSpatialRecords({ construction: frame.construction, relocation: frame.relocation });
    if (!spatial.ok) return { ok: false, scope: SCOPE, issues: cloneJson(spatial.issues) };
    const maintenance = validateSectMaintenanceL1SourceRecords(frame);
    if (maintenance.length) return { ok: false, scope: SCOPE, issues: cloneJson(maintenance) };
    const research = validateRelocationOwnerResearchSourceRecords(frame);
    if (research.length) return { ok: false, scope: SCOPE, issues: cloneJson(research) };
    // Preserve the complete ledger, but close the two authenticated namespaces.
    // Deleting a payment/job must not erase its debit's owner proof.
    for (const claim of frame.construction.ledger.reservations) {
      if ((claim.ownerTransactionId.startsWith('sect-maintenance:') || claim.reservationId.startsWith('sect-maintenance-reservation:'))
        && frame.maintenance.payments.filter(p => p.paymentId === claim.ownerTransactionId && p.reservationId === claim.reservationId).length !== 1)
        return fail('ORPHAN_MAINTENANCE_RESERVATION', claim.reservationId);
      if ((claim.ownerTransactionId.startsWith('sect-research:') || claim.reservationId.startsWith('sect-research-reservation:'))
        && frame.research.jobs.filter(j => j.jobId === claim.ownerTransactionId && j.reservationId === claim.reservationId).length !== 1)
        return fail('ORPHAN_RESEARCH_RESERVATION', claim.reservationId);
    }
    const commandIds = new Set<string>();
    for (const receipt of [...frame.construction.receipts, ...frame.relocation.receipts, ...frame.research.receipts]) {
      if (commandIds.has(receipt.command.commandId)) return fail('DUPLICATE_RESEARCH_SOURCE_COMMAND', receipt.command.commandId);
      commandIds.add(receipt.command.commandId);
    }
    const joined = joins(frame); if (joined) return joined;
    return { ok: true, frame };
  } catch { return fail('INVALID_RESEARCH_SOURCE_RECORDS'); }
}
export function inspectRelocationOwnerResearchRecords(input: unknown): RelocationOwnerResearchInspection {
  const result = inspect(input); return result.ok ? { ok: true, scope: SCOPE } : result;
}
/** The actual recorded start is an external command AFTER the complete tick. */
export function relocationOwnerResearchSiteAtStart(input: unknown, jobId: string):
  | { readonly ok: true; readonly scope: typeof SCOPE; readonly site: SectResearchSiteProof }
  | RelocationOwnerResearchFailure {
  const result = inspect(input); if (!result.ok) return result;
  const job = typeof jobId === 'string' ? result.frame.research.jobs.find(j => j.jobId === jobId) : undefined;
  return job ? { ok: true, scope: SCOPE, site: cloneJson(job.site) } : fail('UNKNOWN_RESEARCH_JOB');
}
/** Current paid, unoccupied library sites only. This does not select a worker,
 * certify reachability/eligibility, satisfy a research DAG or execute a candidate. */
export function relocationOwnerResearchSitesNow(input: unknown, researchId: string):
  | { readonly ok: true; readonly scope: typeof SCOPE; readonly sites: readonly SectResearchSiteProof[] }
  | RelocationOwnerResearchFailure {
  const result = inspect(input); if (!result.ok) return result;
  const definition = typeof researchId === 'string' ? getSectResearchDefinition(researchId) : undefined;
  if (!definition) return fail('UNKNOWN_RESEARCH');
  const frame = result.frame; const tick = frame.construction.lastSimulationTick; const calendar = frame.construction.lastCalendarTick;
  const sites = relocationResearchSitesFromRecordsAt(frame, definition, { tick, phase: 'legacy-production', side: 'after' })
    .filter(site => sectBuildingPaidAt(frame, site.buildingId, tick, calendar)
      && !frame.relocation.jobs.some(job => job.buildingId === site.buildingId && job.terminal === null)
      && !frame.research.jobs.some(job => job.site.buildingId === site.buildingId && job.terminal === null));
  return { ok: true, scope: SCOPE, sites: cloneJson(sites) };
}
