import { getSectBuildingDefinition, SECT_V9_CANDIDATE_IDENTITY } from '../../content/sect-v9/catalog';
import type { SectCell } from '../../content/sect-v9/types';
import { cardinalDistance, MOVEMENT_TICKS_PER_CELL } from '../agents/navigation';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, cloneJson } from '../kernel/serialization';
import { inspectConstructionProvenanceForRelocationOwner, validateConstructionRecords } from './construction-record-validation';
import type { ConstructionValidationIssue } from './construction-types';
import { CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';
import { deriveSectFootprint, ownSectFields } from './layout';
import { normalizeSectResourceLines, sectReservationLines } from './ledger';
import { SECT_RELOCATION_LIMITS as LIMITS, type SectRelocationCommand, type SectRelocationJob,
  type SectRelocationRecordFrame, type SectRelocationState, type SectRelocationVisit } from './relocation-types';

const integer = isNonNegativeInteger;
const fields = ownSectFields;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const array = (value: unknown, maximum: number): value is unknown[] => Array.isArray(value) && value.length <= maximum;
/** Independent maxima for every fixed field, visit, span, checkpoint, terminal and receipt.
 * This is a descriptor bound, not a whole-save or continuation-budget certificate. */
export const SECT_RELOCATION_DESCRIPTOR_NODE_BOUND = CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND + 32
  + LIMITS.records * (256 + LIMITS.visits * 6 + LIMITS.spans * 6) + LIMITS.receipts * 24;

/** Descriptor-only preflight rejects accessors, cycles, aliases and exotic objects before
 * downstream validators read data. Reflective Proxy traps are not a sandbox boundary. */
function dataTree(value: unknown): boolean {
  const seen = new Set<object>(); let left = SECT_RELOCATION_DESCRIPTOR_NODE_BOUND;
  const visit = (node: unknown, depth: number): boolean => {
    if (--left < 0 || depth > 28) return false;
    if (node === null || typeof node === 'boolean') return true;
    if (typeof node === 'number') return integer(node);
    if (typeof node === 'string') return node.length <= 256;
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) {
      const length = Object.getOwnPropertyDescriptor(node, 'length');
      if (Object.getPrototypeOf(node) !== Array.prototype || !length || !Object.hasOwn(length, 'value')
        || !integer(length.value) || length.value > 65536 || length.value > left
        || Reflect.ownKeys(node).length !== length.value + 1) return false;
      for (let i = 0; i < length.value; i++) {
        const d = Object.getOwnPropertyDescriptor(node, String(i));
        if (!d?.enumerable || !Object.hasOwn(d, 'value') || !visit(d.value, depth + 1)) return false;
      }
      return true;
    }
    if (Object.getPrototypeOf(node) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(node);
    if (keys.length > 64 || keys.length > left) return false;
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) return false;
      const d = Object.getOwnPropertyDescriptor(node, key);
      if (!d?.enumerable || !Object.hasOwn(d, 'value') || !visit(d.value, depth + 1)) return false;
    }
    return true;
  };
  try { return visit(value, 0); } catch { return false; }
}
export function createSectRelocationState(): SectRelocationState {
  return { schemaVersion: 1, protocol: 'isolated-relocation-records.1', catalogIdentity: cloneJson(SECT_V9_CANDIDATE_IDENTITY),
    revision: 0, nextId: 1, jobs: [], receipts: [] };
}
export function isSectRelocationCommand(value: unknown): value is SectRelocationCommand {
  if (!dataTree(value) || !fields(value, ['kind', 'commandId', 'expectedRevision'], false)
    || !id(value.commandId) || !integer(value.expectedRevision) || value.expectedRevision === Number.MAX_SAFE_INTEGER) return false;
  if (value.kind === 'relocation.cancel') return fields(value, ['kind', 'commandId', 'expectedRevision', 'jobId']) && id(value.jobId);
  return value.kind === 'relocation.start' && fields(value, ['kind', 'commandId', 'expectedRevision', 'buildingId', 'workerId', 'target'])
    && id(value.buildingId) && id(value.workerId) && deriveSectFootprint(value.target).ok;
}

/** Fixed local record authentication; never accepts supplied validation callbacks, flags or
 * historical tokens. Original construction records and the complete shared ledger are checked
 * unchanged. This does NOT authenticate research/upgrade/maintenance, terrain history, travel
 * routes, lifecycle or other domain owners. No public command or World codec calls this stage. */
export function validateSectRelocationRecords(input: unknown): readonly ConstructionValidationIssue[] {
  return inspectRecords(input, 'permanent-origins');
}
/** Internal partial record inspection only. The complete future owner must join
 * historical and current spatial claims before accepting any state or command.
 * This does not authenticate vacated-ground placement, lifecycle or a World. */
export function inspectRelocationProvenanceForOwner(input: unknown): readonly ConstructionValidationIssue[] {
  return inspectRecords(input, 'historical-origins');
}
function inspectRecords(input: unknown, spatialMeaning: 'permanent-origins' | 'historical-origins'): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path = 'relocation'): readonly ConstructionValidationIssue[] => [{ code, path }];
  try {
    if (!dataTree(input) || !fields(input, ['construction', 'relocation'])) return fail('INVALID_RELOCATION_SHAPE');
    const frame = input as unknown as SectRelocationRecordFrame;
    const constructionIssues = spatialMeaning === 'permanent-origins'
      ? validateConstructionRecords(frame.construction)
      : inspectConstructionProvenanceForRelocationOwner(frame.construction);
    if (constructionIssues.length) return constructionIssues;
    const source = frame.construction; const state = frame.relocation;
    if (!fields(state, ['schemaVersion', 'protocol', 'catalogIdentity', 'revision', 'nextId', 'jobs', 'receipts'])
      || state.schemaVersion !== 1 || state.protocol !== 'isolated-relocation-records.1'
      || !same(state.catalogIdentity, SECT_V9_CANDIDATE_IDENTITY) || !same(state.catalogIdentity, source.catalogIdentity)
      || !integer(state.revision) || !array(state.jobs, LIMITS.records) || !array(state.receipts, LIMITS.receipts)
      || state.nextId !== state.jobs.length * 2 + 1) return fail('INVALID_RELOCATION_DOMAIN');
    if (source.lastCalendarTick > source.lastSimulationTick) return fail('INVALID_RELOCATION_CLOCK');
    const cell = (p: unknown): p is SectCell => fields(p, ['x', 'y']) && integer(p.x) && integer(p.y)
      && p.x < source.map.width && p.y < source.map.height;
    const now = { tick: source.lastSimulationTick, calendarTick: source.lastCalendarTick };
    const time = (p: { readonly tick: number; readonly calendarTick: number }): boolean => integer(p.tick) && integer(p.calendarTick)
      && p.calendarTick <= p.tick && p.tick <= now.tick && p.calendarTick <= now.calendarTick
      && now.calendarTick - p.calendarTick <= now.tick - p.tick;
    const follows = (a: { readonly tick: number; readonly calendarTick: number }, b: { readonly tick: number; readonly calendarTick: number }, minimum = 0): boolean =>
      b.tick >= a.tick && b.calendarTick - a.calendarTick >= minimum && b.calendarTick - a.calendarTick <= b.tick - a.tick;
    const visit = (p: unknown): p is SectRelocationVisit => fields(p, ['tick', 'calendarTick', 'position'])
      && time(p as unknown as SectRelocationVisit) && cell(p.position);
    const active = state.jobs.filter(job => job?.terminal === null).length;
    if (active > LIMITS.activeJobs || state.receipts.length + active > LIMITS.receipts
      || state.revision > Number.MAX_SAFE_INTEGER - active) return fail('RELOCATION_TERMINAL_CAPACITY');
    const commands = new Set<string>(); let lastReceipt = 0;
    for (const receipt of state.receipts) {
      if (!fields(receipt, ['command', 'jobId', 'revision']) || !isSectRelocationCommand(receipt.command)
        || !id(receipt.jobId) || !integer(receipt.revision) || receipt.revision !== receipt.command.expectedRevision + 1
        || receipt.revision <= lastReceipt || receipt.revision > state.revision || commands.has(receipt.command.commandId)) return fail('INVALID_RELOCATION_RECEIPT');
      const job = state.jobs.find(j => j.jobId === receipt.jobId); const command = receipt.command;
      if (!job || (command.kind === 'relocation.start' ? command.buildingId !== job.buildingId || command.workerId !== job.workerId || !same(command.target, job.to)
        : command.jobId !== job.jobId || job.terminal?.kind !== 'cancelled' || job.terminal.revision !== receipt.revision)) return fail('INVALID_RELOCATION_RECEIPT_SOURCE');
      commands.add(command.commandId); lastReceipt = receipt.revision;
    }
    const externalIds = new Set([...source.people.map(p => p.id), ...source.legacyStations.map(s => s.id),
      ...source.buildings.map(b => b.buildingId), ...source.jobs.flatMap(j => [j.jobId, j.reservationId]), ...source.blueprints.map(b => b.blueprintId)]);
    const history: SectRelocationJob[] = [];
    const revisions: { revision: number; tick: number; calendarTick: number }[] = [];
    let previousStartRevision = 0;
    const livePhases = ['to-old-entrance', 'to-new-entrance', 'working', 'waiting-completion'];
    for (const [index, job] of state.jobs.entries()) {
      if (!fields(job, ['jobId', 'reservationId', 'buildingId', 'sourceJobId', 'workerId', 'previousRelocationJobId', 'from', 'to',
        'startedTick', 'startedCalendarTick', 'origin', 'requiredTicks', 'phase', 'oldEntranceVisit', 'newEntranceVisits', 'workSpans', 'checkpoints', 'activeTicks', 'terminal'])
        || job.jobId !== `sect-relocation:${index * 2 + 1}` || job.reservationId !== `sect-relocation-reservation:${index * 2 + 2}`
        || externalIds.has(job.jobId) || externalIds.has(job.reservationId)
        || !id(job.buildingId) || !id(job.sourceJobId) || !id(job.workerId)
        || !(job.previousRelocationJobId === null || id(job.previousRelocationJobId)) || !cell(job.origin)
        || job.requiredTicks !== 200 || !integer(job.activeTicks) || job.activeTicks > 200
        || ![...livePhases, 'completed', 'cancelled'].includes(job.phase)
        || !array(job.newEntranceVisits, LIMITS.visits) || !array(job.workSpans, LIMITS.spans) || !array(job.checkpoints, LIMITS.checkpoints)) return fail('INVALID_RELOCATION_JOB');
      const start = { tick: job.startedTick, calendarTick: job.startedCalendarTick };
      if (!time(start)) return fail('INVALID_RELOCATION_START', job.jobId);
      const starts = state.receipts.filter(r => r.jobId === job.jobId && r.command.kind === 'relocation.start');
      const cancels = state.receipts.filter(r => r.jobId === job.jobId && r.command.kind === 'relocation.cancel');
      if (starts.length !== 1 || starts[0]!.revision <= previousStartRevision
        || cancels.length !== (job.terminal?.kind === 'cancelled' ? 1 : 0)) return fail('INVALID_RELOCATION_RECEIPT_COUNT', job.jobId);
      const startRevision = starts[0]!.revision; previousStartRevision = startRevision;
      revisions.push({ ...start, revision: startRevision });
      const building = source.buildings.find(b => b.buildingId === job.buildingId);
      if (!building || building.sourceJobId !== job.sourceJobId || !['library.v9', 'alchemy.v9'].includes(building.definitionId)
        || !follows({ tick: building.completedTick, calendarTick: building.completedCalendarTick }, start)) return fail('INVALID_RELOCATION_CONSTRUCTION_SOURCE', job.jobId);
      if (!source.people.some(p => p.id === job.workerId)) return fail('INVALID_RELOCATION_WORKER', job.jobId);
      const predecessors = history.filter(j => j.buildingId === job.buildingId);
      const previous = predecessors.filter(j => j.terminal?.kind === 'completed').at(-1);
      const expectedFrom = previous?.to ?? { definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation };
      const oldGeometry = deriveSectFootprint(job.from); const newGeometry = deriveSectFootprint(job.to);
      if (job.previousRelocationJobId !== (previous?.jobId ?? null) || !same(job.from, expectedFrom) || same(job.from, job.to)
        || !oldGeometry.ok || !newGeometry.ok || job.to.definitionId !== building.definitionId
        || ![...oldGeometry.footprint.cells, oldGeometry.footprint.entrance, ...newGeometry.footprint.cells, newGeometry.footprint.entrance].every(cell)) return fail('INVALID_RELOCATION_POSITION_CHAIN', job.jobId);
      const oldEntrance = oldGeometry.footprint.entrance; const newEntrance = newGeometry.footprint.entrance;
      if (history.some(other => (other.buildingId === job.buildingId || other.workerId === job.workerId)
        && (!other.terminal || !follows(other.terminal, start) || other.terminal.revision >= startRevision))) return fail('RELOCATION_HISTORY_OVERLAP', job.jobId);
      const workerPredecessor = history.filter(other => other.workerId === job.workerId).at(-1);
      if (workerPredecessor?.terminal && !follows(workerPredecessor.terminal, start,
        cardinalDistance(workerPredecessor.terminal.position, job.origin) * MOVEMENT_TICKS_PER_CELL)) return fail('INVALID_RELOCATION_WORKER_CONTINUITY', job.jobId);
      const constructionPredecessor = source.jobs.filter(other => other.workerId === job.workerId && other.terminal && other.terminal.tick <= start.tick)
        .sort((a, b) => a.terminal!.tick - b.terminal!.tick).at(-1);
      if (constructionPredecessor?.terminal && !follows(constructionPredecessor.terminal, start,
        cardinalDistance(constructionPredecessor.terminal.position, job.origin) * MOVEMENT_TICKS_PER_CELL)) return fail('INVALID_RELOCATION_CONSTRUCTION_CONTINUITY', job.jobId);
      const end = job.terminal?.tick ?? Number.MAX_SAFE_INTEGER;
      if (source.jobs.some(other => other.workerId === job.workerId && (other.terminal === null || other.terminal.tick > job.startedTick)
        && other.startedTick < end)) return fail('RELOCATION_CONSTRUCTION_WORKER_OVERLAP', job.jobId);
      const travel = (a: SectCell, b: SectCell): number => Math.max(1, cardinalDistance(a, b) * MOVEMENT_TICKS_PER_CELL);
      if (job.oldEntranceVisit !== null && (!visit(job.oldEntranceVisit) || !same(job.oldEntranceVisit.position, oldEntrance)
        || !follows(start, job.oldEntranceVisit, travel(job.origin, oldEntrance)))) return fail('INVALID_RELOCATION_OLD_VISIT', job.jobId);
      let previousVisit = job.oldEntranceVisit;
      for (const [n, v] of job.newEntranceVisits.entries()) {
        if (!previousVisit || !visit(v) || !same(v.position, newEntrance)
          || !follows(previousVisit, v, n === 0 ? travel(oldEntrance, newEntrance) : 1)) return fail('INVALID_RELOCATION_NEW_VISIT', job.jobId);
        previousVisit = v;
      }
      let count = 0; let lastWork = start; let lastVisitIndex = -1;
      const ordinals = new Map<number, { tick: number; calendarTick: number }>();
      for (const span of job.workSpans) {
        if (!fields(span, ['firstTick', 'lastTick', 'firstCalendarTick', 'lastCalendarTick', 'visitIndex']) || !integer(span.visitIndex)
          || span.visitIndex < lastVisitIndex || span.visitIndex >= job.newEntranceVisits.length) return fail('INVALID_RELOCATION_WORK', job.jobId);
        const first = { tick: span.firstTick, calendarTick: span.firstCalendarTick }; const last = { tick: span.lastTick, calendarTick: span.lastCalendarTick };
        const arrival = job.newEntranceVisits[span.visitIndex]!; const next = job.newEntranceVisits[span.visitIndex + 1];
        const length = span.lastTick - span.firstTick + 1;
        if (!time(first) || !time(last) || !follows(lastWork, first, 1) || !follows(arrival, first, 1)
          || !follows(first, last) || span.lastCalendarTick - span.firstCalendarTick !== length - 1 || length < 1 || length > 200 - count
          || next && (!follows(last, next, 1)) || lastVisitIndex === span.visitIndex && span.firstTick === lastWork.tick + 1)
          return fail('INVALID_RELOCATION_WORK', job.jobId);
        for (const ordinal of [100, 200]) if (count < ordinal && count + length >= ordinal)
          ordinals.set(ordinal, { tick: first.tick + ordinal - count - 1, calendarTick: first.calendarTick + ordinal - count - 1 });
        count += length; lastWork = last; lastVisitIndex = span.visitIndex;
      }
      if (count !== job.activeTicks) return fail('INVALID_RELOCATION_WORK_COUNT', job.jobId);
      // Work 200 may wait indefinitely for a safe atomic swap. The second wood is charged
      // only at successful completion, which can be later than the 200th work tick.
      const checkpointCount = job.terminal?.kind === 'completed' ? 2 : count >= 100 ? 1 : 0;
      if (job.checkpoints.length !== checkpointCount) return fail('INVALID_RELOCATION_CHECKPOINTS', job.jobId);
      for (const [n, checkpoint] of job.checkpoints.entries()) {
        const at = n === 0 ? ordinals.get(100) : job.terminal;
        if (!fields(checkpoint, ['tick', 'calendarTick', 'position', 'checkpointId', 'activeTicks']) || !at
          || checkpoint.activeTicks !== (n === 0 ? 100 : 200) || checkpoint.checkpointId !== (n === 0 ? 'construction.half' : 'construction.remainder')
          || checkpoint.tick !== at.tick || checkpoint.calendarTick !== at.calendarTick || !same(checkpoint.position, newEntrance)) return fail('INVALID_RELOCATION_CHECKPOINT_WORK', job.jobId);
      }
      const costs = normalizeSectResourceLines(getSectBuildingDefinition(building.definitionId)!.relocation.costs)!;
      const half = costs.map(line => ({ ...line, quantity: Math.ceil(line.quantity / 2) }));
      if (getSectBuildingDefinition(building.definitionId)!.relocation.workTicks !== 200
        || !same(costs, [{ ledger: 'base', resourceId: 'wood', quantity: 2 }])) return fail('INVALID_RELOCATION_CATALOG');
      const consumed = checkpointCount === 2 ? costs : checkpointCount === 1 ? half : [];
      const unpaid = checkpointCount > 0 ? half : costs;
      const claims = source.ledger.reservations.filter(c => c.reservationId === job.reservationId || c.ownerTransactionId === job.jobId);
      const claim = claims[0];
      if (claims.length !== 1 || !claim || claim.reservationId !== job.reservationId || claim.ownerTransactionId !== job.jobId
        || claim.policy !== 'construction-checkpoints' || !same(sectReservationLines(claim, 'lines'), costs)
        || claim.base.checkpoints.length !== checkpointCount || claim.sect.checkpoints.length !== checkpointCount
        || !same(sectReservationLines(claim, 'consumed'), consumed)) return fail('INVALID_RELOCATION_COST_SOURCE', job.jobId);
      const phaseEvidence = (phase: string): boolean => phase === 'to-old-entrance' ? job.oldEntranceVisit === null && !job.newEntranceVisits.length && count === 0
        : phase === 'to-new-entrance' ? job.oldEntranceVisit !== null && count < 200
        : phase === 'working' ? job.newEntranceVisits.length > 0 && count < 200
        : phase === 'waiting-completion' && job.newEntranceVisits.length > 0 && count === 200;
      if (job.terminal === null) {
        if (!phaseEvidence(job.phase) || claim.base.settlement !== null || claim.sect.settlement !== null
          || !same(sectReservationLines(claim, 'remainingReservation'), unpaid)) return fail('INVALID_ACTIVE_RELOCATION', job.jobId);
      } else {
        const t = job.terminal;
        if (!fields(t, ['kind', 'tick', 'calendarTick', 'position', 'previousPhase', 'revision', 'consumed', 'released'])
          || !['completed', 'cancelled'].includes(t.kind) || job.phase !== t.kind || !time(t) || !cell(t.position)
          || !follows(lastWork, t) || !follows(previousVisit ?? start, t) || !integer(t.revision)
          || t.revision <= startRevision || t.revision > state.revision || !same(t.consumed, consumed)
          || sectReservationLines(claim, 'remainingReservation').length) return fail('INVALID_RELOCATION_TERMINAL', job.jobId);
        const lastPosition = previousVisit?.position ?? job.origin;
        const lastPositionTime = previousVisit ?? start;
        if (!follows(lastPositionTime, t, cardinalDistance(lastPosition, t.position) * MOVEMENT_TICKS_PER_CELL)
          || count > 0 && !follows(lastWork, t, cardinalDistance(newEntrance, t.position) * MOVEMENT_TICKS_PER_CELL)) return fail('INVALID_RELOCATION_TERMINAL_TRAVEL', job.jobId);
        if (t.kind === 'completed') {
          if (count !== 200 || !['working', 'waiting-completion'].includes(t.previousPhase) || !same(t.position, newEntrance)
            || !same(t.released, []) || claim.base.settlement?.kind !== 'committed' || claim.sect.settlement?.kind !== 'committed'
            || claim.base.settlement.operationId !== `complete:${job.jobId}` || claim.sect.settlement.operationId !== `complete:${job.jobId}`)
            return fail('INVALID_RELOCATION_COMPLETION', job.jobId);
        } else if (!phaseEvidence(t.previousPhase) || !same(t.released, unpaid) || cancels[0]!.revision !== t.revision
          || claim.base.settlement?.kind !== 'released' || claim.sect.settlement?.kind !== 'released'
          || claim.base.settlement.operationId !== `cancel:${job.jobId}` || claim.sect.settlement.operationId !== `cancel:${job.jobId}`)
          return fail('INVALID_RELOCATION_CANCELLATION', job.jobId);
        // A later construction's recorded origin is another observed worker position.
        // Authenticate the reverse handoff too: interval non-overlap alone cannot
        // explain movement at the shared terminal/start tick. Only calendar ticks
        // can pay the necessary travel; simulation-only pauses cannot do so.
        if (source.jobs.some(other => other.workerId === job.workerId && other.startedTick >= t.tick
          && !follows(t, { tick: other.startedTick, calendarTick: other.startedCalendarTick },
            cardinalDistance(t.position, other.origin) * MOVEMENT_TICKS_PER_CELL)))
          return fail('INVALID_RELOCATION_TO_CONSTRUCTION_CONTINUITY', job.jobId);
        revisions.push({ revision: t.revision, tick: t.tick, calendarTick: t.calendarTick });
      }
      history.push(job);
    }
    for (const claim of source.ledger.reservations) {
      if ((claim.reservationId.startsWith('sect-relocation-reservation:') || claim.ownerTransactionId.startsWith('sect-relocation:'))
        && state.jobs.filter(j => j.jobId === claim.ownerTransactionId && j.reservationId === claim.reservationId).length !== 1) return fail('ORPHAN_RELOCATION_RESERVATION');
    }
    revisions.sort((a, b) => a.revision - b.revision);
    if (state.revision !== revisions.length || revisions.some((r, i) => r.revision !== i + 1
      || i > 0 && !follows(revisions[i - 1]!, r))) return fail('INVALID_RELOCATION_REVISION_CHRONOLOGY');
    return [];
  } catch { return fail('INVALID_RELOCATION_RECORDS'); }
}
