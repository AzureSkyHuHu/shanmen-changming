import { getSectBuildingDefinition, getSectResearchDefinition } from '../../content/sect-v9/catalog';
import type { SectCell } from '../../content/sect-v9/types';
import { cardinalDistance, emptyNavigation, findCardinalPath, isWalkable, MOVEMENT_TICKS_PER_CELL, sameCell } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, type WorkPathBudget } from '../agents/work-navigation';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import { isConstructionCommand, validateConstructionContext } from './construction-record-validation';
import { applyConstructionCommandForRelocationDomain, constructionClaims, tickConstructionForRelocationDomain } from './construction-runtime';
import { relocationOwnerCurrentSpatialContext, relocationOwnerEffectiveMap, inspectRelocationOwnerSpatialRecords } from '../world/relocation-owner/spatial-records';
import { assessSectPlacement } from './queries';
import type { JobNavigation } from '../agents/navigation';
import type { WorldMap } from '../world/types';
import type { ConstructionClaim, ConstructionContext, ConstructionPerson, ConstructionRejection } from './construction-types';
import { deriveSectFootprint, ownSectFields } from './layout';
import { commitSectReservation, consumeSectConstructionCheckpoint, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { sectRelocationClaims, sectRelocationEffectiveMap, sectRelocationLayoutValid, sectRelocationTargetAvailable } from './relocation-queries';
import type { SectRelocationBlock, SectRelocationRejection, SectRelocationResult, SectRelocationRuntimeFrame } from './relocation-runtime-types';
import type { SectRelocationJob, SectRelocationPhase, SectRelocationRecordFrame, SectRelocationVisit } from './relocation-types';
import { inspectRelocationProvenanceForOwner, isSectRelocationCommand, SECT_RELOCATION_DESCRIPTOR_NODE_BOUND, validateSectRelocationRecords } from './relocation-validation';
import type { SectPlacementRequest } from './types';
import { SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';
import { sectBuildingPaidAt, sectMaintenanceStatusFromRecords } from './maintenance-periods';
import { SECT_RESEARCH_LIMITS, type SectResearchCommand, type SectResearchJob,
  type SectResearchRejection, type SectResearchSiteProof } from './research-types';
import { isSectResearchCommand } from './research-validation';
import { relocationResearchSitesFromRecordsAt } from '../world/relocation-owner/history-sites';
import { inspectRelocationOwnerResearchRecords, type RelocationOwnerResearchSource } from '../world/relocation-owner/research-records';
import type { ConstructionRelocationResearchDomainCandidate, ConstructionRelocationResearchDomainFrame } from '../world/relocation-owner/research-domain-types';

const MAX = Number.MAX_SAFE_INTEGER;
type RuntimePolicy = 'permanent-origin' | 'construction-relocation-domain';
const fields = (value: unknown, keys: readonly string[]): boolean => ownSectFields(value, keys);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const key = (c: SectCell): string => `${c.x},${c.y}`;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const eligible = (p: ConstructionPerson): boolean => p.lifeState === 'alive' && p.canWork && !p.away
  && p.productionTransactionId === null && p.cultivationOwnerId === null && p.otherOwnerId === null;
const rejected = (frame: SectRelocationRuntimeFrame, code: SectRelocationRejection): SectRelocationResult => ({ ok: false, frame, code });
function door(p: SectPlacementRequest): SectCell { const g = deriveSectFootprint(p); if (!g.ok) throw new Error('Relocation geometry invariant'); return g.footprint.entrance; }
function safeTree(input: unknown, bound = SECT_RELOCATION_DESCRIPTOR_NODE_BOUND + 36 * (65536 * 3 + 30)): boolean {
  const seen = new Set<object>(); let remaining = bound;
  const visit = (v: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 32) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0;
    if (typeof v === 'string') return v.length <= 256;
    if (typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    const array = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)) return false;
    const keys = Reflect.ownKeys(v);
    if (keys.length > (array ? 65537 : 64)) return false;
    if (array && (keys.length !== v.length + 1 || v.length > 65536)) return false;
    if (array) for (let index = 0; index < v.length; index++) {
      const d = Object.getOwnPropertyDescriptor(v, String(index));
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) return false;
    }
    for (const k of keys) {
      if (array && k === 'length') continue;
      if (typeof k !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(k)) return false;
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d?.enumerable || !Object.hasOwn(d, 'value') || !visit(d.value, depth + 1)) return false;
    }
    return true;
  };
  try { return visit(input, 0); } catch { return false; }
}
function recordIssues(input: unknown, policy: RuntimePolicy): readonly unknown[] {
  return policy === 'permanent-origin' ? validateSectRelocationRecords(input) : inspectRelocationProvenanceForOwner(input);
}
function effectiveMap(records: SectRelocationRecordFrame, policy: RuntimePolicy): WorldMap | null {
  if (policy === 'permanent-origin') return sectRelocationEffectiveMap(records);
  const result = relocationOwnerEffectiveMap(records); return result.ok ? result.map : null;
}
function relocationClaims(records: SectRelocationRecordFrame, policy: RuntimePolicy): readonly ConstructionClaim[] | null {
  if (policy === 'permanent-origin') return sectRelocationClaims(records);
  if (!inspectRelocationOwnerSpatialRecords(records).ok) return null;
  return records.relocation.jobs.filter(job => job.terminal === null).flatMap(job => [
    { kind: 'worker' as const, key: job.workerId, ownerId: job.jobId },
    { kind: 'seat' as const, key: job.buildingId, ownerId: job.jobId },
    ...Array.from(new Set([key(door(job.from)), key(door(job.to))])).map(token =>
      ({ kind: 'entrance' as const, key: token, ownerId: job.jobId })),
  ]);
}
function targetAvailable(records: SectRelocationRecordFrame, buildingId: string, target: SectPlacementRequest,
  workerId: string, policy: RuntimePolicy): boolean {
  if (policy === 'permanent-origin') return sectRelocationTargetAvailable(records, buildingId, target, workerId);
  const result = relocationOwnerCurrentSpatialContext(records); if (!result.ok) return false;
  if (!records.construction.buildings.some(building => building.buildingId === buildingId && building.definitionId === target.definitionId)) return false;
  if (!assessSectPlacement({ ...result.context, spaces: result.context.spaces.filter(space => space.buildingId !== buildingId),
    people: result.context.people.filter(person => person.id !== workerId) }, target).ok) return false;
  const geometry = deriveSectFootprint(target); if (!geometry.ok) return false;
  const occupied = new Set([...geometry.footprint.cells, geometry.footprint.entrance].map(key));
  return result.softTargets.filter(value => value.buildingId !== buildingId)
    .every(value => [...value.footprint.cells, value.footprint.entrance].every(cell => !occupied.has(key(cell))));
}
/** Current route evidence is bound to its actual phase and actor, not merely a
 * sequence of mutually adjacent cells. A changed map can leave only an empty route. */
function currentRoute(n: JobNavigation, worker: ConstructionPerson, target: SectCell, map: WorldMap, now: number): boolean {
  return !(n.target !== null && !sameCell(n.target, target)
    || n.path.length > 0 && (n.target === null || n.routeVersion !== map.navVersion
      || !sameCell(n.path.at(-1)!, target) || cardinalDistance(worker.position, n.path[0]!) !== 1
      || n.path.some(cell => !isWalkable(map, cell)))
    || n.path.length === 0 && n.movementTicks !== 0 || n.retryAtTick > now + 20
    || n.target === null && !same(n, emptyNavigation()));
}
/** Complete fixed local admission; no callbacks, trusted booleans, or alleged World proofs. */
export function validateSectRelocationRuntime(input: unknown): readonly string[] {
  return validateRuntime(input, 'permanent-origin');
}
/** Fixed bounded two-domain inspection; not a World, research, lifecycle or save admission. */
export function validateConstructionRelocationDomainRuntime(input: unknown): readonly string[] {
  return validateRuntime(input, 'construction-relocation-domain');
}
function validateRuntime(input: unknown, policy: RuntimePolicy): readonly string[] {
  const fail = (s: string): readonly string[] => [s];
  try {
    if (!safeTree(input) || !ownSectFields(input, ['records', 'live'])) return fail('INVALID_RUNTIME_SHAPE');
    const frame = input as unknown as SectRelocationRuntimeFrame;
    if (recordIssues(frame.records, policy).length || !Array.isArray(frame.live)) return fail('INVALID_RECORDS');
    const { construction: source, relocation } = frame.records; const active = relocation.jobs.filter(j => !j.terminal);
    if (frame.live.length !== active.length || source.map.navVersion > MAX - active.length - source.jobs.filter(j => !j.terminal).length
      || !(policy === 'permanent-origin' ? sectRelocationLayoutValid(frame.records) : inspectRelocationOwnerSpatialRecords(frame.records).ok)) return fail('INVALID_LIVE_CAPACITY_OR_LAYOUT');
    // Reservation geometry is an ownership invariant, independent of transient terrain
    // or people blockers that legitimately leave a completion waiting and cancellable.
    const soft = new Set<string>();
    for (const job of active) {
      const geometry = deriveSectFootprint(job.to); if (!geometry.ok) return fail('INVALID_SOFT_TARGET');
      for (const cell of [...geometry.footprint.cells, geometry.footprint.entrance]) {
        const token = key(cell); if (soft.has(token)) return fail('SOFT_TARGET_CONFLICT'); soft.add(token);
      }
    }
    const claims = relocationClaims(frame.records, policy)!; const tokens = new Set<string>();
    for (const c of claims) { const token = `${c.kind}:${c.key}`; if (tokens.has(token)) return fail('DUPLICATE_OWNER'); tokens.add(token); }
    if (source.jobs.filter(j => !j.terminal).some(j => claims.some(c => c.kind === 'worker' && c.key === j.workerId
      || c.kind === 'entrance' && c.key === j.entranceToken))) return fail('CONSTRUCTION_OWNER_CONFLICT');
    for (const [index, state] of frame.live.entries()) {
      const job = active[index];
      if (!job || !fields(state, ['jobId', 'navigation', 'blocked']) || state.jobId !== job.jobId
        || ![null, 'WORKER_UNAVAILABLE', 'CLAIM_CONFLICT', 'ENTRANCE_BUSY', 'PATH_BLOCKED', 'PATH_BUDGET', 'PLACEMENT_CHANGED'].includes(state.blocked)) return fail('INVALID_LIVE_OWNER');
      const n = state.navigation; const map = source.map;
      const cell = (p: unknown): p is SectCell => ownSectFields(p, ['x', 'y']) && Number.isSafeInteger(p.x) && Number.isSafeInteger(p.y)
        && (p.x as number) >= 0 && (p.y as number) >= 0 && (p.x as number) < map.width && (p.y as number) < map.height;
      if (!fields(n, ['path', 'target', 'routeVersion', 'movementTicks', 'retryAtTick']) || !Array.isArray(n.path)
        || n.path.length > map.width * map.height || n.path.some((p: unknown) => !cell(p)) || !(n.target === null || cell(n.target))
        || !(n.routeVersion === null || integer(n.routeVersion) && n.routeVersion <= map.navVersion)
        || !integer(n.movementTicks) || n.movementTicks >= MOVEMENT_TICKS_PER_CELL || !integer(n.retryAtTick) || n.retryAtTick > source.lastSimulationTick + 20
        || n.path.some((p: unknown, i: number) => !cell(p) || i > 0 && (!cell(n.path[i - 1]) || cardinalDistance(p, n.path[i - 1]) !== 1))) return fail('INVALID_NAVIGATION');
      const worker = source.people.find(p => p.id === job.workerId)!;
      const target = door(job.phase === 'to-old-entrance' ? job.from : job.to);
      if (n.target !== null && !sameCell(n.target, target) || n.path.length && (n.target === null
        || !sameCell(n.path.at(-1)!, target) || cardinalDistance(worker.position, n.path[0]!) !== 1)
        || n.path.length === 0 && n.movementTicks !== 0) return fail('INVALID_ROUTE');
      const span = job.workSpans.at(-1); const visit = job.newEntranceVisits.at(-1) ?? job.oldEntranceVisit;
      const observed = span && (!visit || span.lastTick >= visit.tick) ? { calendarTick: span.lastCalendarTick, position: door(job.to) }
        : visit ?? { calendarTick: job.startedCalendarTick, position: job.origin };
      if (source.lastCalendarTick - observed.calendarTick < cardinalDistance(observed.position, worker.position) * MOVEMENT_TICKS_PER_CELL
        + (policy === 'construction-relocation-domain' ? n.movementTicks : 0))
        return fail('INVALID_WORKER_CONTINUITY');
      if (job.phase === 'working' && !same(n, emptyNavigation())) return fail('INVALID_WORK_NAVIGATION');
    }
    if (policy === 'construction-relocation-domain') {
      const constructionActive = source.jobs.filter(job => job.terminal === null);
      if (active.length + constructionActive.length > 36) return fail('COMBINED_ACTIVE_CAPACITY');
      const allClaims = [...constructionClaims(source), ...claims]; const allTokens = new Set<string>();
      for (const claim of allClaims) {
        const token = `${claim.kind}:${claim.key}`;
        if (allTokens.has(token)) return fail('CROSS_DOMAIN_OWNER_CONFLICT'); allTokens.add(token);
      }
      const map = effectiveMap(frame.records, policy); if (!map) return fail('INVALID_CURRENT_MAP');
      for (const job of constructionActive) {
        const worker = source.people.find(person => person.id === job.workerId)!;
        const bp = source.blueprints.find(value => value.blueprintId === job.blueprintId)!;
        const storage = source.legacyStations.find(value => value.id === job.storageId)!;
        const site = door({ definitionId: bp.definitionId, anchor: bp.anchor, rotation: bp.rotation });
        const target = job.phase === 'to-storage' ? { x: storage.x, y: storage.y } : site;
        if (!currentRoute(job.navigation, worker, target, map, source.lastSimulationTick)) return fail('INVALID_CONSTRUCTION_ROUTE');
        if (job.phase === 'working' && (!same(job.navigation, emptyNavigation()) || !sameCell(worker.position, target))) return fail('INVALID_CONSTRUCTION_WORK_POSITION');
        const observed = job.workSpans.at(-1)?.lastTick ?? job.siteVisit?.tick ?? job.storageVisit?.tick ?? job.startedTick;
        const position = job.workSpans.length || job.siteVisit ? site : job.storageVisit?.position ?? job.origin;
        const unfinishedTravel = cardinalDistance(position, worker.position) * MOVEMENT_TICKS_PER_CELL + job.navigation.movementTicks;
        const storagePosition = { x: storage.x, y: storage.y };
        const storageElapsed = job.storageVisit ? Math.max(1, cardinalDistance(job.origin, storagePosition) * MOVEMENT_TICKS_PER_CELL) : 0;
        const siteElapsed = job.siteVisit ? Math.max(1, cardinalDistance(storagePosition, site) * MOVEMENT_TICKS_PER_CELL) : 0;
        // Construction visits have simulation timestamps only. Their independent calendar
        // lower bound must include every completed leg, productive work and current partial
        // movement. Paused/combat ticks can never fund an unexplained change of position.
        if (source.lastSimulationTick - observed < unfinishedTravel
          || source.lastCalendarTick - job.startedCalendarTick < storageElapsed + siteElapsed + job.activeTicks + unfinishedTravel)
          return fail('INVALID_CONSTRUCTION_WORKER_CONTINUITY');
      }
      for (const [index, state] of frame.live.entries()) {
        const job = active[index]!; const worker = source.people.find(person => person.id === job.workerId)!;
        const target = door(job.phase === 'to-old-entrance' ? job.from : job.to);
        if (!currentRoute(state.navigation, worker, target, map, source.lastSimulationTick)) return fail('INVALID_RELOCATION_ROUTE');
        if ((job.phase === 'working' || job.phase === 'waiting-completion') && (!same(state.navigation, emptyNavigation()) || !sameCell(worker.position, target)))
          return fail('INVALID_RELOCATION_WORK_POSITION');
      }
    }
    if (relocation.receipts.some(r => source.receipts.some(c => c.command.commandId === r.command.commandId))) return fail('IDENTITY_CONFLICT');
    return [];
  } catch { return fail('INVALID_RUNTIME'); }
}
export function createSectRelocationRuntime(records: SectRelocationRecordFrame): SectRelocationRuntimeFrame {
  if (validateSectRelocationRecords(records).length || records.relocation.jobs.some(j => !j.terminal)) throw new RangeError('Invalid relocation seed');
  const frame = cloneJson({ records, live: [] });
  if (validateSectRelocationRuntime(frame).length) throw new RangeError('Invalid relocation seed');
  return frame;
}
function publish(source: SectRelocationRuntimeFrame, next: SectRelocationRuntimeFrame, jobId: string | null = null, repeated = false, policy: RuntimePolicy = 'permanent-origin'): SectRelocationResult {
  // Clone removes harmless internal structural sharing before strict descriptor validation.
  const candidate = cloneJson(next);
  return validateRuntime(candidate, policy).length ? rejected(source, 'INVALID_FRAME') : { ok: true, frame: candidate, jobId, repeated };
}
function replace(frame: SectRelocationRuntimeFrame, job: SectRelocationJob, blocked: SectRelocationBlock = null): SectRelocationRuntimeFrame {
  return { ...frame, records: { ...frame.records, relocation: { ...frame.records.relocation,
    jobs: frame.records.relocation.jobs.map(j => j.jobId === job.jobId ? job : j) } },
    live: frame.live.filter(s => !job.terminal || s.jobId !== job.jobId).map(s => s.jobId === job.jobId ? { ...s, blocked } : s) };
}
function conflicts(frame: SectRelocationRuntimeFrame, context: ConstructionContext, job: Pick<SectRelocationJob, 'jobId' | 'workerId' | 'buildingId' | 'from' | 'to'>, policy: RuntimePolicy): boolean {
  const tokens = [{ kind: 'worker', key: job.workerId }, { kind: 'seat', key: job.buildingId },
    { kind: 'entrance', key: key(door(job.from)) }, { kind: 'entrance', key: key(door(job.to)) }];
  return [...context.externalClaims, ...(relocationClaims(policy === 'permanent-origin' ? frame.records : cloneJson(frame.records), policy) ?? []),
    ...(policy === 'construction-relocation-domain' ? constructionClaims(frame.records.construction) : [])].some(c => c.ownerId !== job.jobId
    && tokens.some(t => t.kind === c.kind && t.key === c.key));
}
export function applySectRelocationCommand(frame: SectRelocationRuntimeFrame, context: ConstructionContext, input: unknown): SectRelocationResult {
  return applyRelocationCommand(frame, context, input, 'permanent-origin');
}
/** Fixed new spatial policy; no caller-selected relaxation or alternate authoritative map. */
export function applyRelocationCommandForConstructionDomain(frame: SectRelocationRuntimeFrame, context: ConstructionContext, input: unknown): SectRelocationResult {
  return applyRelocationCommand(frame, context, input, 'construction-relocation-domain');
}
function applyRelocationCommand(frame: SectRelocationRuntimeFrame, context: ConstructionContext, input: unknown, policy: RuntimePolicy): SectRelocationResult {
  if (validateRuntime(frame, policy).length) return rejected(frame, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(frame, 'INVALID_CONTEXT');
  const { construction: source, relocation: state } = frame.records;
  if (context.simulationTick !== source.lastSimulationTick || context.calendarTick !== source.lastCalendarTick) return rejected(frame, 'STALE_CLOCK');
  if (!isSectRelocationCommand(input)) return rejected(frame, 'INVALID_COMMAND');
  const command = input; const previous = state.receipts.find(r => r.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? publish(frame, frame, previous.jobId, true, policy) : rejected(frame, 'IDENTITY_CONFLICT');
  if (source.receipts.some(r => r.command.commandId === command.commandId)) return rejected(frame, 'IDENTITY_CONFLICT');
  if (command.expectedRevision !== state.revision) return rejected(frame, 'STALE_REVISION');
  const revision = state.revision + 1; let next = frame; let jobId: string;
  if (command.kind === 'relocation.start') {
    if (context.mode !== 'management' || context.paused || context.expeditionActive) return rejected(frame, 'MANAGEMENT_REQUIRED');
    if (state.jobs.length >= 128 || frame.live.length + source.jobs.filter(j => !j.terminal).length + context.externalActiveJobs >= 36
      || state.receipts.length + frame.live.length + 2 > 256 || state.revision > MAX - frame.live.length - 2
      || source.map.navVersion > MAX - frame.live.length - source.jobs.filter(j => !j.terminal).length - 1 || source.lastSimulationTick > MAX - 20
      || source.ledger.reservations.length >= 384) return rejected(frame, 'CAPACITY_EXCEEDED');
    const building = source.buildings.find(b => b.buildingId === command.buildingId);
    if (!building || !['library.v9', 'alchemy.v9'].includes(building.definitionId)) return rejected(frame, 'UNKNOWN_BUILDING');
    if (state.jobs.some(j => !j.terminal && j.buildingId === building.buildingId)) return rejected(frame, 'BUILDING_BUSY');
    const worker = source.people.find(p => p.id === command.workerId);
    if (!worker || !eligible(worker) || state.jobs.some(j => !j.terminal && j.workerId === worker.id)
      || source.jobs.some(j => !j.terminal && j.workerId === worker.id)) return rejected(frame, 'WORKER_UNAVAILABLE');
    const prior = state.jobs.filter(j => j.buildingId === building.buildingId && j.terminal?.kind === 'completed').at(-1);
    const from = prior?.to ?? { definitionId: building.definitionId, anchor: building.anchor, rotation: building.rotation };
    jobId = `sect-relocation:${state.nextId}`;
    const job: SectRelocationJob = { jobId, reservationId: `sect-relocation-reservation:${state.nextId + 1}`, buildingId: building.buildingId,
      sourceJobId: building.sourceJobId, workerId: worker.id, previousRelocationJobId: prior?.jobId ?? null, from: cloneJson(from), to: cloneJson(command.target),
      startedTick: context.simulationTick, startedCalendarTick: context.calendarTick, origin: { ...worker.position }, requiredTicks: 200,
      phase: 'to-old-entrance', oldEntranceVisit: null, newEntranceVisits: [], workSpans: [], checkpoints: [], activeTicks: 0, terminal: null };
    if (conflicts(frame, context, job, policy)) return rejected(frame, 'CLAIM_CONFLICT');
    const map = effectiveMap(frame.records, policy)!;
    if (same(from, command.target) || !targetAvailable(frame.records, building.buildingId, command.target, worker.id, policy)
      || findCardinalPath(map, worker.position, door(from)) === null || findCardinalPath(map, door(from), door(command.target)) === null)
      return rejected(frame, 'PLACEMENT_CHANGED');
    const reservation = reserveSectResources(source.ledger, { reservationId: job.reservationId, ownerTransactionId: jobId },
      getSectBuildingDefinition(building.definitionId)!.relocation.costs, 'construction-checkpoints');
    if (!reservation.ok) return rejected(frame, reservation.rejection.code === 'INSUFFICIENT_INVENTORY' ? 'INSUFFICIENT_INVENTORY' : 'INVALID_RESERVATION');
    next = { records: { construction: { ...source, ledger: reservation.context }, relocation: { ...state, nextId: state.nextId + 2, jobs: [...state.jobs, job] } },
      live: [...frame.live, { jobId, navigation: emptyNavigation(), blocked: null }] };
  } else {
    const job = state.jobs.find(j => j.jobId === command.jobId);
    if (!job) return rejected(frame, 'UNKNOWN_JOB');
    if (job.terminal) return rejected(frame, 'TRANSACTION_FINISHED');
    jobId = job.jobId; const worker = source.people.find(p => p.id === job.workerId)!;
    const claim = source.ledger.reservations.find(r => r.reservationId === job.reservationId)!;
    const release = releaseSectReservation(source.ledger, { reservationId: job.reservationId, ownerTransactionId: jobId }, `cancel:${jobId}`);
    if (!release.ok) return rejected(frame, 'INVALID_RESERVATION');
    next = replace({ ...frame, records: { ...frame.records, construction: { ...source, ledger: release.context } } }, { ...job, phase: 'cancelled',
      terminal: { kind: 'cancelled', previousPhase: job.phase as SectRelocationPhase, tick: context.simulationTick, calendarTick: context.calendarTick,
        position: { ...worker.position }, revision, consumed: sectReservationLines(claim, 'consumed'), released: sectReservationLines(claim, 'remainingReservation') } });
  }
  next = { ...next, records: { ...next.records, relocation: { ...next.records.relocation, revision,
    receipts: [...next.records.relocation.receipts, { command: cloneJson(command), jobId, revision }] } } };
  return publish(frame, next, jobId, false, policy);
}

/** Exactly one local clock step, with the caller's existing shared navigation budget. Arrival,
 * combat, pause, expedition and waiting never create work. This does not run other domains. */
export function tickSectRelocation(frame: SectRelocationRuntimeFrame, context: ConstructionContext, budget: WorkPathBudget): SectRelocationResult {
  if (validateSectRelocationRuntime(frame).length) return rejected(frame, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(frame, 'INVALID_CONTEXT');
  const source = frame.records.construction;
  if (context.simulationTick === source.lastSimulationTick && context.calendarTick === source.lastCalendarTick) return publish(frame, frame, null, true);
  if (context.simulationTick <= source.lastSimulationTick || context.calendarTick < source.lastCalendarTick) return rejected(frame, 'STALE_CLOCK');
  const productive = context.mode === 'management' && !context.paused && !context.expeditionActive;
  if (context.simulationTick !== source.lastSimulationTick + 1 || context.calendarTick !== source.lastCalendarTick + (productive ? 1 : 0)) return rejected(frame, 'CLOCK_GAP');
  if (context.simulationTick > MAX - 20) return rejected(frame, 'CAPACITY_EXCEEDED');
  let next: SectRelocationRuntimeFrame = { ...frame, records: { ...frame.records, construction: { ...source,
    lastSimulationTick: context.simulationTick, lastCalendarTick: context.calendarTick } } };
  if (!productive) return publish(frame, next);
  return runAlreadyClockedWork(frame, next, context, budget, 'permanent-origin');
}
/** Fixed complete two-domain tick wrapper. The already-clocked work function is private:
 * no exported equal-clock entry can repeatedly advance fractional movement. This owns
 * construction's one clock step and invokes relocation work at most once afterward. */
export function tickConstructionRelocationDomain(frame: SectRelocationRuntimeFrame, context: ConstructionContext, budget: WorkPathBudget):
  SectRelocationResult | { readonly ok: false; readonly frame: SectRelocationRuntimeFrame; readonly code: ConstructionRejection } {
  const policy: RuntimePolicy = 'construction-relocation-domain';
  if (validateRuntime(frame, policy).length) return rejected(frame, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(frame, 'INVALID_CONTEXT');
  const source = frame.records.construction;
  if (context.simulationTick === source.lastSimulationTick && context.calendarTick === source.lastCalendarTick) return publish(frame, frame, null, true, policy);
  if (context.simulationTick <= source.lastSimulationTick || context.calendarTick < source.lastCalendarTick) return rejected(frame, 'STALE_CLOCK');
  const productive = context.mode === 'management' && !context.paused && !context.expeditionActive;
  if (context.simulationTick !== source.lastSimulationTick + 1 || context.calendarTick !== source.lastCalendarTick + (productive ? 1 : 0)) return rejected(frame, 'CLOCK_GAP');
  if (context.simulationTick > MAX - 20 || frame.live.length + source.jobs.filter(job => job.terminal === null).length + context.externalActiveJobs > 36)
    return rejected(frame, 'CAPACITY_EXCEEDED');
  const localClaims = [...constructionClaims(source), ...relocationClaims(frame.records, policy)!];
  if (context.externalClaims.some(external => localClaims.some(local => local.kind === external.kind && local.key === external.key))) return rejected(frame, 'CLAIM_CONFLICT');
  const position = source.people[0]?.position ?? { x: 0, y: 0 };
  try { advanceWorkNavigationWithBudget({ map: source.map, position, target: position, navigation: emptyNavigation(), simulationTick: context.simulationTick }, budget); }
  catch { return rejected(frame, 'INVALID_CONTEXT'); }
  const construction = tickConstructionForRelocationDomain(frame.records, context, budget);
  if (!construction.ok) return { ok: false, frame, code: construction.code };
  const next: SectRelocationRuntimeFrame = cloneJson({ records: { construction: construction.frame, relocation: frame.records.relocation },
    live: construction.frame.map.navVersion === source.map.navVersion ? frame.live : frame.live.map(state => ({ ...state, navigation: emptyNavigation() })) });
  if (validateRuntime(next, policy).length) return rejected(frame, 'INVALID_FRAME');
  if (!productive) return publish(frame, next, null, false, policy);
  return runAlreadyClockedWork(frame, next, context, budget, policy);
}
function runAlreadyClockedWork(frame: SectRelocationRuntimeFrame, clocked: SectRelocationRuntimeFrame, context: ConstructionContext, budget: WorkPathBudget, policy: RuntimePolicy): SectRelocationResult {
  const source = frame.records.construction; let next = clocked;
  // Validate the real budget even when all jobs are working (zero path cost).
  try { const map = effectiveMap(frame.records, policy)!; const p = source.people[0]?.position;
    if (p) advanceWorkNavigationWithBudget({ map, position: p, target: p, navigation: emptyNavigation(), simulationTick: context.simulationTick }, budget);
    else if (!budget || budget.simulationTick !== context.simulationTick) return rejected(frame, 'INVALID_CONTEXT');
  } catch { return rejected(frame, 'INVALID_CONTEXT'); }
  for (const original of frame.records.relocation.jobs.filter(j => !j.terminal)) {
    let job = next.records.relocation.jobs.find(j => j.jobId === original.jobId)!;
    let worker = next.records.construction.people.find(p => p.id === job.workerId)!;
    if (!eligible(worker)) { next = replace(next, job, 'WORKER_UNAVAILABLE'); continue; }
    if (conflicts(next, context, job, policy)) { next = replace(next, job, 'CLAIM_CONFLICT'); continue; }
    const target = door(job.phase === 'to-old-entrance' ? job.from : job.to);
    if (next.records.construction.people.some(p => p.id !== worker.id && p.lifeState !== 'dead' && !p.away && sameCell(p.position, target))) {
      next = replace(next, job, 'ENTRANCE_BUSY'); continue;
    }
    const map = effectiveMap(cloneJson(next.records), policy)!;
    if (!map) return rejected(frame, 'INVALID_FRAME');
    if (job.phase === 'working' && !sameCell(worker.position, target)) {
      job = { ...job, phase: 'to-new-entrance' }; next = replace(next, job);
    }
    if (job.phase === 'to-old-entrance' || job.phase === 'to-new-entrance' || !sameCell(worker.position, target)) {
      const state = next.live.find(s => s.jobId === job.jobId)!;
      let effect;
      try { effect = advanceWorkNavigationWithBudget({ map, position: worker.position, target, navigation: state.navigation, simulationTick: context.simulationTick }, budget); }
      catch { return rejected(frame, 'INVALID_CONTEXT'); }
      if (effect.position) next = { ...next, records: { ...next.records, construction: { ...next.records.construction,
        people: next.records.construction.people.map(p => p.id === worker.id ? { ...p, position: { ...effect.position! } } : p) } } };
      next = { ...next, live: next.live.map(s => s.jobId === job.jobId ? { ...s, navigation: effect.navigation } : s) };
      if (effect.status === 'arrived') {
        const visit: SectRelocationVisit = { tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...target } };
        job = job.phase === 'to-old-entrance' ? { ...job, phase: 'to-new-entrance', oldEntranceVisit: visit }
          : job.activeTicks === 200 ? { ...job, phase: 'waiting-completion' }
          : { ...job, phase: 'working', newEntranceVisits: job.newEntranceVisits.length > 0 && !job.workSpans.some(s => s.visitIndex === job.newEntranceVisits.length - 1)
            ? [...job.newEntranceVisits.slice(0, -1), visit] : [...job.newEntranceVisits, visit] };
      }
      next = replace(next, job, effect.status === 'path-blocked' ? 'PATH_BLOCKED' : effect.status === 'path-budget-exhausted' ? 'PATH_BUDGET' : null);
      continue;
    }
    if (!isWalkable(map, worker.position)) { next = replace(next, job, 'PATH_BLOCKED'); continue; }
    if (job.activeTicks < 200) {
      const spans = job.workSpans.slice(); const last = spans.at(-1); const visitIndex = job.newEntranceVisits.length - 1;
      if (last && last.lastTick === context.simulationTick - 1 && last.lastCalendarTick === context.calendarTick - 1 && last.visitIndex === visitIndex)
        spans[spans.length - 1] = { ...last, lastTick: context.simulationTick, lastCalendarTick: context.calendarTick };
      else spans.push({ firstTick: context.simulationTick, lastTick: context.simulationTick, firstCalendarTick: context.calendarTick,
        lastCalendarTick: context.calendarTick, visitIndex });
      job = { ...job, activeTicks: job.activeTicks + 1, workSpans: spans };
      if (job.activeTicks === 100) {
        const debit = consumeSectConstructionCheckpoint(next.records.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: job.jobId }, 'half');
        if (!debit.ok) return rejected(frame, 'INVALID_RESERVATION');
        next = { ...next, records: { ...next.records, construction: { ...next.records.construction, ledger: debit.context } } };
        job = { ...job, checkpoints: [...job.checkpoints, { checkpointId: 'construction.half', activeTicks: 100,
          tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...target } }] };
      }
      if (job.activeTicks === 200) job = { ...job, phase: 'waiting-completion' };
      next = replace(next, job);
    }
    if (job.activeTicks !== 200) continue;
    // Every query authenticates a detached full record tree, including this tick's work.
    if (!targetAvailable(cloneJson(next.records), job.buildingId, job.to, worker.id, policy)) { next = replace(next, job, 'PLACEMENT_CHANGED'); continue; }
    const identity = { reservationId: job.reservationId, ownerTransactionId: job.jobId };
    const debit = consumeSectConstructionCheckpoint(next.records.construction.ledger, identity, 'remainder');
    if (!debit.ok) return rejected(frame, 'INVALID_RESERVATION');
    const commit = commitSectReservation(debit.context, identity, `complete:${job.jobId}`, []);
    if (!commit.ok) return rejected(frame, 'INVALID_RESERVATION');
    const revision = next.records.relocation.revision + 1;
    worker = next.records.construction.people.find(p => p.id === job.workerId)!;
    job = { ...job, phase: 'completed', checkpoints: [...job.checkpoints, { checkpointId: 'construction.remainder', activeTicks: 200,
      tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...target } }], terminal: { kind: 'completed', previousPhase: 'waiting-completion',
      tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...worker.position }, revision,
      consumed: sectReservationLines(commit.reservation, 'consumed'), released: [] } };
    next = replace(next, job);
    next = { ...next, records: { construction: { ...next.records.construction, ledger: commit.context,
      map: { ...next.records.construction.map, navVersion: next.records.construction.map.navVersion + 1 },
      jobs: next.records.construction.jobs.map(j => j.terminal ? j : { ...j, navigation: emptyNavigation() }) },
      relocation: { ...next.records.relocation, revision } }, live: next.live.map(s => ({ ...s, navigation: emptyNavigation() })) };
  }
  return publish(frame, next, null, false, policy);
}

// Separate bounded owner; both existing complete ticks keep their original policy.
type ResearchDomainFrame = ConstructionRelocationResearchDomainFrame;
type ResearchDomainResult = ConstructionRelocationResearchDomainCandidate;
const RESEARCH_SCOPE = 'construction-relocation-research-domain-candidate' as const;
const RESEARCH_DESCRIPTOR_BOUND = SECT_RELOCATION_DESCRIPTOR_NODE_BOUND
  + SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND + 36 * (65536 * 3 + 30) + 4;
const researchRejected = (input: unknown, code: SectRelocationRejection | SectResearchRejection,
  issues: readonly string[] = []): ResearchDomainResult => ({ ok: false, scope: RESEARCH_SCOPE, frame: input, code, issues });
/** A real two-book mechanical leaf, NEVER complete source/candidate admission.
 * All shared ledger owners survive; no empty six-domain/v10 root is manufactured. */
function researchRelocationLeaf(frame: ResearchDomainFrame): SectRelocationRuntimeFrame {
  return cloneJson({ records: { construction: frame.records.construction, relocation: frame.records.relocation }, live: frame.live });
}
function researchOnlyClaims(records: RelocationOwnerResearchSource): readonly ConstructionClaim[] {
  return records.research.jobs.filter(job => job.terminal === null).flatMap(job => [
    { kind: 'worker' as const, key: job.workerId, ownerId: job.jobId },
    { kind: 'seat' as const, key: job.site.buildingId, ownerId: job.jobId },
    { kind: 'entrance' as const, key: key(job.site.position), ownerId: job.jobId },
  ]);
}
function researchAllClaims(records: RelocationOwnerResearchSource): readonly ConstructionClaim[] {
  return [...constructionClaims(records.construction), ...records.relocation.jobs.filter(job => job.terminal === null).flatMap(job => [
    { kind: 'worker' as const, key: job.workerId, ownerId: job.jobId },
    { kind: 'seat' as const, key: job.buildingId, ownerId: job.jobId },
    ...Array.from(new Set([key(door(job.from)), key(door(job.to))])).map(token => ({ kind: 'entrance' as const, key: token, ownerId: job.jobId })),
  ]), ...researchOnlyClaims(records)];
}
function researchActiveCount(records: RelocationOwnerResearchSource): number {
  return records.construction.jobs.filter(job => job.terminal === null).length
    + records.relocation.jobs.filter(job => job.terminal === null).length + records.research.jobs.filter(job => job.terminal === null).length;
}
function researchClaimsConflict(claims: readonly ConstructionClaim[]): boolean {
  const tokens = new Set<string>();
  return claims.some(claim => { const token = `${claim.kind}:${claim.key}`; if (tokens.has(token)) return true; tokens.add(token); return false; });
}
function researchContextProblem(frame: ResearchDomainFrame, context: ConstructionContext): SectResearchRejection | null {
  if (researchActiveCount(frame.records) + context.externalActiveJobs > 36) return 'CAPACITY_EXCEEDED';
  return researchClaimsConflict([...researchAllClaims(frame.records), ...context.externalClaims]) ? 'CLAIM_CONFLICT' : null;
}
function researchEffectiveMap(records: RelocationOwnerResearchSource): WorldMap {
  const map = effectiveMap(cloneJson({ construction: records.construction, relocation: records.relocation }), 'construction-relocation-domain');
  if (!map) throw new Error('Authenticated research map was lost'); return map;
}
/** Complete fixed local inspection: descriptor/alias capture, all four books,
 * lifetime/site joins, current routes and local obligations. Never World/save,
 * lifecycle/archive or arbitrary historical terrain/navigation certification. */
export function validateConstructionRelocationResearchDomainRuntime(input: unknown): readonly string[] {
  const fail = (issue: string): readonly string[] => [issue];
  try {
    if (!safeTree(input, RESEARCH_DESCRIPTOR_BOUND) || !fields(input, ['records', 'live'])) return fail('INVALID_RESEARCH_RUNTIME_SHAPE');
    // Descriptor capture permits reading only; all domain authority is proved below.
    const frame = cloneJson(input) as ResearchDomainFrame;
    const inspected = inspectRelocationOwnerResearchRecords(frame.records);
    if (!inspected.ok) return inspected.issues.map(issue => `${issue.code}:${issue.path}`);
    const records = frame.records; const source = records.construction;
    // Every historical blueprint, including cancelled/unstarted ones, stays in scope.
    if (source.blueprints.some(bp => bp.definitionId !== 'library.v9' || Object.hasOwn(bp, 'researchGate'))
      || source.buildings.some(building => building.definitionId !== 'library.v9' || building.level !== 1)
      || records.relocation.jobs.some(job => job.from.definitionId !== 'library.v9' || job.to.definitionId !== 'library.v9')
      || records.maintenance.payments.some(payment => Object.hasOwn(payment, 'rate'))) return fail('UNSUPPORTED_RESEARCH_DOMAIN_HISTORY');
    const mechanical = validateRuntime(researchRelocationLeaf(frame), 'construction-relocation-domain');
    if (mechanical.length) return mechanical;
    if (researchActiveCount(records) > 36 || source.ledger.reservations.length > 384) return fail('RESEARCH_DOMAIN_CAPACITY');
    if (researchClaimsConflict(researchAllClaims(records))) return fail('RESEARCH_DOMAIN_CLAIM_CONFLICT');
    const map = researchEffectiveMap(records);
    for (const job of records.research.jobs.filter(value => value.terminal === null)) {
      const worker = source.people.find(person => person.id === job.workerId)!;
      if (!currentRoute(job.navigation, worker, job.site.position, map, source.lastSimulationTick)) return fail('INVALID_RESEARCH_ROUTE');
      if (job.phase === 'working' && (!same(job.navigation, emptyNavigation()) || !sameCell(worker.position, job.site.position))) return fail('INVALID_RESEARCH_WORK_POSITION');
      const span = job.workSpans.at(-1); const visit = job.visits.at(-1);
      const observed = span && (!visit || span.lastTick >= visit.tick) ? { tick: span.lastTick, calendar: span.lastCalendarTick, position: job.site.position }
        : visit ? { tick: visit.tick, calendar: visit.calendarTick, position: visit.position }
          : { tick: job.startedTick, calendar: job.startedCalendarTick, position: job.origin };
      const travel = cardinalDistance(observed.position, worker.position) * MOVEMENT_TICKS_PER_CELL + job.navigation.movementTicks;
      if (source.lastCalendarTick - observed.calendar < travel || source.lastSimulationTick - observed.tick < travel) return fail('INVALID_RESEARCH_WORKER_CONTINUITY');
    }
    return [];
  } catch { return fail('INVALID_RESEARCH_RUNTIME'); }
}
function researchCaptured(input: unknown): ResearchDomainFrame | null {
  return validateConstructionRelocationResearchDomainRuntime(input).length ? null : cloneJson(input as ResearchDomainFrame);
}
function researchPublish(input: unknown, next: ResearchDomainFrame, context: ConstructionContext,
  relatedId: string | null = null, repeated = false, cancellation = false): ResearchDomainResult {
  const frame = cloneJson(next); const issues = validateConstructionRelocationResearchDomainRuntime(frame);
  if (issues.length) return researchRejected(input, 'INVALID_FRAME', issues);
  // External availability is not authority to suppress a real cancellation. Internal
  // ownership, lifetime, receipts and paid evidence above are always authenticated.
  const problem = cancellation ? null : researchContextProblem(frame, context); if (problem) return researchRejected(input, problem);
  return { ok: true, scope: RESEARCH_SCOPE, frame, relatedId, repeated };
}
function researchAfterLeaf(frame: ResearchDomainFrame, leaf: SectRelocationRuntimeFrame): ResearchDomainFrame {
  const changed = leaf.records.construction.map.navVersion !== frame.records.construction.map.navVersion;
  return { records: { ...frame.records, construction: leaf.records.construction, relocation: leaf.records.relocation,
    research: changed ? { ...frame.records.research, jobs: frame.records.research.jobs.map(job => job.terminal ? job : { ...job, navigation: emptyNavigation() }) } : frame.records.research }, live: leaf.live };
}
function researchOtherContext(frame: ResearchDomainFrame, context: ConstructionContext): ConstructionContext {
  return { ...context, externalActiveJobs: context.externalActiveJobs + frame.records.research.jobs.filter(job => job.terminal === null).length,
    externalClaims: [...context.externalClaims, ...researchOnlyClaims(frame.records)] };
}
/** All commands authenticate complete source and candidate, including retries. */
export function prepareConstructionRelocationResearchCommandCandidate(input: unknown, rawContext: unknown, command: unknown): ResearchDomainResult {
  const frame = researchCaptured(input); if (!frame) return researchRejected(input, 'INVALID_FRAME');
  if (!safeTree(rawContext) || !validateConstructionContext(rawContext)) return researchRejected(input, 'INVALID_CONTEXT');
  const context = cloneJson(rawContext); const source = frame.records.construction;
  if (context.simulationTick !== source.lastSimulationTick || context.calendarTick !== source.lastCalendarTick) return researchRejected(input, 'STALE_CLOCK');
  if (!safeTree(command, 100) || !(isConstructionCommand(command) || isSectRelocationCommand(command) || isSectResearchCommand(command))) return researchRejected(input, 'INVALID_COMMAND');
  const cancellation = command.kind === 'construction.cancel' || command.kind === 'relocation.cancel' || command.kind === 'research.cancel';
  const previous = [...source.receipts, ...frame.records.relocation.receipts, ...frame.records.research.receipts].find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? researchPublish(input, frame, context, 'relatedId' in previous ? previous.relatedId : previous.jobId, true, cancellation)
    : researchRejected(input, 'IDENTITY_CONFLICT');
  const problem = cancellation ? null : researchContextProblem(frame, context); if (problem) return researchRejected(input, problem);
  if (isSectResearchCommand(command)) {
    const result = researchCommand(frame.records, context, command);
    return result.ok ? researchPublish(input, { ...frame, records: result.frame }, context, result.jobId, result.repeated, cancellation) : researchRejected(input, result.code);
  }
  // A cancellation does not acquire work ownership. Keep its already-validated
  // original context; derived research claims/counts must not overflow that
  // context's shape or duplicate external tokens before the private cancel leaf.
  const leaf = researchRelocationLeaf(frame); const others = cancellation ? context : researchOtherContext(frame, context);
  if (isConstructionCommand(command)) {
    if (command.kind === 'blueprint.place' && command.placement.definitionId !== 'library.v9') return researchRejected(input, 'RESEARCH_AUTHORITY_REQUIRED');
    const result = applyConstructionCommandForRelocationDomain(leaf.records, others, command);
    if (!result.ok) return researchRejected(input, result.code);
    const changed = result.frame.map.navVersion !== source.map.navVersion;
    return researchPublish(input, researchAfterLeaf(frame, { records: { construction: result.frame, relocation: leaf.records.relocation },
      live: changed ? leaf.live.map(state => ({ ...state, navigation: emptyNavigation() })) : leaf.live }), context, result.relatedId, result.repeated, cancellation);
  }
  const result = applyRelocationCommand(leaf, others, command, 'construction-relocation-domain');
  return result.ok ? researchPublish(input, researchAfterLeaf(frame, result.frame), context, result.jobId, result.repeated, cancellation) : researchRejected(input, result.code);
}
/** construction -> L1 maintenance -> private relocation -> private research. Only
 * the complete old source and next context enter; no clocked-stage export exists.
 * Rejection preserves input; real budget already spent is never restored/retried. */
export function tickConstructionRelocationResearchDomain(input: unknown, rawContext: unknown, budget: WorkPathBudget): ResearchDomainResult {
  const frame = researchCaptured(input); if (!frame) return researchRejected(input, 'INVALID_FRAME');
  if (!safeTree(rawContext) || !validateConstructionContext(rawContext)) return researchRejected(input, 'INVALID_CONTEXT');
  const context = cloneJson(rawContext); const source = frame.records.construction;
  if (context.simulationTick === source.lastSimulationTick && context.calendarTick === source.lastCalendarTick) return researchPublish(input, frame, context, null, true);
  if (context.simulationTick <= source.lastSimulationTick || context.calendarTick < source.lastCalendarTick) return researchRejected(input, 'STALE_CLOCK');
  const productive = context.mode === 'management' && !context.paused && !context.expeditionActive;
  if (context.simulationTick !== source.lastSimulationTick + 1 || context.calendarTick !== source.lastCalendarTick + (productive ? 1 : 0)) return researchRejected(input, 'CLOCK_GAP');
  const problem = researchContextProblem(frame, context); if (problem) return researchRejected(input, problem);
  if (context.simulationTick > MAX - 20 || productive && frame.records.research.revision >= MAX - frame.records.research.jobs.filter(job => job.terminal === null).length) return researchRejected(input, 'CAPACITY_EXCEEDED');
  try {
    const position = source.people[0]?.position ?? { x: 0, y: 0 };
    // Zero-cost real-budget authentication; equal-clock does not even inspect it.
    advanceWorkNavigationWithBudget({ map: source.map, position, target: position, navigation: emptyNavigation(), simulationTick: context.simulationTick }, budget);
    const leaf = researchRelocationLeaf(frame);
    const construction = tickConstructionForRelocationDomain(leaf.records, researchOtherContext(frame, context), budget);
    if (!construction.ok) return researchRejected(input, construction.code);
    let next = researchAfterLeaf(frame, { records: { construction: construction.frame, relocation: leaf.records.relocation },
      live: construction.frame.map.navVersion === source.map.navVersion ? leaf.live : leaf.live.map(state => ({ ...state, navigation: emptyNavigation() })) });
    if (!productive) return researchPublish(input, next, context);
    next = { ...next, records: researchMaintenance(next.records, context) };
    const relocated = runAlreadyClockedWork(leaf, researchRelocationLeaf(next), researchOtherContext(next, context), budget, 'construction-relocation-domain');
    if (!relocated.ok) return researchRejected(input, relocated.code);
    next = researchAfterLeaf(next, relocated.frame);
    return researchPublish(input, { ...next, records: researchWork(next.records, context, budget) }, context);
  } catch { return researchRejected(input, 'INVALID_CONTEXT'); }
}
/** Stable L1 reserve+commit. Inventory-only renewal is allowed during relocation;
 * failed attempts allocate nothing, and actual payment starts one fresh period. */
function researchMaintenance(frame: RelocationOwnerResearchSource, context: ConstructionContext): RelocationOwnerResearchSource {
  let next = frame;
  for (const building of frame.construction.buildings.slice().sort((a, b) => compareStable(a.buildingId, b.buildingId))) {
    const status = sectMaintenanceStatusFromRecords(next, building); if (status.operational || status.renewalBlock !== null) continue;
    const definition = getSectBuildingDefinition(building.definitionId)!.levels[0]!;
    const paymentId = `sect-maintenance:${next.maintenance.nextId}`; const reservationId = `sect-maintenance-reservation:${next.maintenance.nextId + 1}`;
    const identity = { reservationId, ownerTransactionId: paymentId };
    const reserved = reserveSectResources(next.construction.ledger, identity, definition.maintenance.costs, 'on-completion'); if (!reserved.ok) continue;
    const paid = commitSectReservation(reserved.context, identity, `maintain:${paymentId}`, []); if (!paid.ok) continue;
    const previous = next.maintenance.payments.filter(payment => payment.buildingId === building.buildingId).at(-1);
    next = { ...next, construction: { ...next.construction, ledger: paid.context }, maintenance: { nextId: next.maintenance.nextId + 2,
      payments: [...next.maintenance.payments, { paymentId, reservationId, buildingId: building.buildingId, sourceJobId: building.sourceJobId,
        predecessorPaymentId: previous?.paymentId ?? null, previousDueCalendarTick: status.dueCalendarTick,
        paidTick: context.simulationTick, paidCalendarTick: context.calendarTick, dueCalendarTick: context.calendarTick + definition.maintenance.intervalTicks }] } };
  }
  return next;
}
function researchSites(frame: RelocationOwnerResearchSource, definition: NonNullable<ReturnType<typeof getSectResearchDefinition>>): readonly SectResearchSiteProof[] {
  return relocationResearchSitesFromRecordsAt(frame, definition, { tick: frame.construction.lastSimulationTick, phase: 'research', side: 'after' });
}
type PrivateResearchResult =
  | { readonly ok: true; readonly frame: RelocationOwnerResearchSource; readonly repeated: boolean; readonly jobId: string | null }
  | { readonly ok: false; readonly frame: RelocationOwnerResearchSource; readonly code: SectResearchRejection };


const researchLive = (job: SectResearchJob): boolean => job.terminal === null;
const researchAccepted = (frame: RelocationOwnerResearchSource, jobId: string | null = null, repeated = false): PrivateResearchResult => ({ ok: true, frame, jobId, repeated });
const privateResearchRejected = (frame: RelocationOwnerResearchSource, code: SectResearchRejection): PrivateResearchResult => ({ ok: false, frame, code });
function researchReplace(frame: RelocationOwnerResearchSource, job: SectResearchJob): RelocationOwnerResearchSource {
  return { ...frame, research: { ...frame.research, jobs: frame.research.jobs.map(value => value.jobId === job.jobId ? job : value) } };
}
function researchContextConflict(frame: RelocationOwnerResearchSource, context: ConstructionContext): boolean {
  return researchClaimsConflict([...researchAllClaims(frame), ...context.externalClaims]);
}
function researchCapacityExceeded(frame: RelocationOwnerResearchSource, context: ConstructionContext): boolean {
  return researchActiveCount(frame) + context.externalActiveJobs > 36;
}
function researchSiteUsable(frame: RelocationOwnerResearchSource, job: SectResearchJob): boolean {
  const definition = getSectResearchDefinition(job.researchId)!;
  return sectBuildingPaidAt(frame, job.site.buildingId, frame.construction.lastSimulationTick, frame.construction.lastCalendarTick) && researchSites(frame, definition).some(site => same(site, job.site))
    && !frame.relocation.jobs.some(move => move.terminal === null && move.buildingId === job.site.buildingId)
    && job.prerequisites.every(ref => frame.research.jobs.some(parent => parent.jobId === ref.completionJobId && parent.researchId === ref.researchId && parent.terminal?.kind === 'completed'));
}
function researchSiteFree(frame: RelocationOwnerResearchSource, context: ConstructionContext, site: SectResearchSiteProof, ownerId?: string): boolean {
  return ![...researchAllClaims(frame), ...context.externalClaims].some(claim => claim.ownerId !== ownerId
    && (claim.kind === 'seat' && claim.key === site.buildingId || claim.kind === 'entrance' && claim.key === `${site.position.x},${site.position.y}`));
}
/** Bounded copy of v10 mechanics. Three deliberate substitutions: three-domain
 * claims, historical placement sites and the current effective relocated map.
 * Complete owner validation surrounds this PRIVATE stage; no equal-clock work
 * entry or old six-domain root is exposed. Cancellation headroom is checked. */
function researchCommand(frame: RelocationOwnerResearchSource, context: ConstructionContext, command: SectResearchCommand): PrivateResearchResult {
  const previous = frame.research.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (previous) return same(previous.command, command) ? researchAccepted(frame, previous.jobId, true) : privateResearchRejected(frame, 'IDENTITY_CONFLICT');
  if (command.expectedRevision !== frame.research.revision) return privateResearchRejected(frame, 'STALE_REVISION');
  if (frame.research.revision === MAX) return privateResearchRejected(frame, 'CAPACITY_EXCEEDED');
  let next = frame; let jobId: string;
  if (command.kind === 'research.start') {
    const definition = getSectResearchDefinition(command.researchId);
    if (!definition) return privateResearchRejected(frame, 'UNKNOWN_RESEARCH');
    if (frame.research.jobs.some(job => job.researchId === command.researchId && job.terminal?.kind === 'completed')) return privateResearchRejected(frame, 'RESEARCH_COMPLETED');
    if (frame.research.jobs.some(researchLive)) return privateResearchRejected(frame, 'RESEARCH_ACTIVE');
    const prerequisites = definition.prerequisites.map(researchId => ({ researchId, completionJobId: frame.research.jobs.find(job => job.researchId === researchId && job.terminal?.kind === 'completed')?.jobId ?? '' }));
    if (prerequisites.some(ref => !ref.completionJobId)) return privateResearchRejected(frame, 'PREREQUISITE_REQUIRED');
    if (context.mode !== 'management' || context.paused || context.expeditionActive) return privateResearchRejected(frame, 'MANAGEMENT_REQUIRED');
    if (researchCapacityExceeded(frame, { ...context, externalActiveJobs: context.externalActiveJobs + 1 }) || frame.research.jobs.length >= SECT_RESEARCH_LIMITS.records
      || frame.research.receipts.length + 2 > SECT_RESEARCH_LIMITS.receipts || frame.research.nextId > MAX - 2 || frame.research.revision > MAX - 2
      || frame.construction.ledger.reservations.length >= 384 || context.simulationTick > MAX - 20 || context.calendarTick === MAX) return privateResearchRejected(frame, 'CAPACITY_EXCEEDED');
    if (researchContextConflict(frame, context)) return privateResearchRejected(frame, 'CLAIM_CONFLICT');
    const worker = frame.construction.people.find(person => person.id === command.workerId);
    if (!worker || !eligible(worker)) return privateResearchRejected(frame, 'WORKER_UNAVAILABLE');
    if ([...researchAllClaims(frame), ...context.externalClaims].some(claim => claim.kind === 'worker' && claim.key === worker.id)) return privateResearchRejected(frame, 'CLAIM_CONFLICT');
    const sites = researchSites(frame, definition).filter(site => sectBuildingPaidAt(frame, site.buildingId, context.simulationTick, context.calendarTick));
    if (!sites.length) return privateResearchRejected(frame, 'WORKSTATION_UNAVAILABLE');
    const site = sites.filter(value => researchSiteFree(frame, context, value)).sort((a, b) => cardinalDistance(worker.position, a.position) - cardinalDistance(worker.position, b.position) || compareStable(a.buildingId, b.buildingId))[0];
    if (!site) return privateResearchRejected(frame, 'CLAIM_CONFLICT');
    jobId = `sect-research:${frame.research.nextId}`;
    const reservationId = `sect-research-reservation:${frame.research.nextId + 1}`;
    const reserved = reserveSectResources(frame.construction.ledger, { reservationId, ownerTransactionId: jobId }, definition.costs, 'on-completion');
    if (!reserved.ok) return privateResearchRejected(frame, reserved.rejection.code === 'INSUFFICIENT_INVENTORY' ? 'INSUFFICIENT_INVENTORY' : 'INVALID_RESERVATION');
    const job: SectResearchJob = { jobId, reservationId, researchId: definition.id, workerId: worker.id, startedTick: context.simulationTick,
      startedCalendarTick: context.calendarTick, origin: { ...worker.position }, site: cloneJson(site), prerequisites, phase: 'to-site', activeTicks: 0,
      requiredTicks: definition.workTicks, visits: [], workSpans: [], navigation: emptyNavigation(), blocked: null, terminal: null };
    next = { ...frame, construction: { ...frame.construction, ledger: reserved.context },
      research: { ...frame.research, nextId: frame.research.nextId + 2, jobs: [...frame.research.jobs, job] } };
  } else {
    const job = frame.research.jobs.find(value => value.jobId === command.jobId);
    if (!job) return privateResearchRejected(frame, 'UNKNOWN_JOB');
    if (!researchLive(job)) return privateResearchRejected(frame, 'TRANSACTION_FINISHED');
    const person = frame.construction.people.find(value => value.id === job.workerId)!;
    // Expiry, away/death and new external worker ownership never suppress a real cancellation.
    if (!isWalkable(researchEffectiveMap(frame), person.position)) return privateResearchRejected(frame, 'UNSAFE_POSITION');
    jobId = job.jobId;
    const claim = frame.construction.ledger.reservations.find(value => value.reservationId === job.reservationId)!;
    const released = releaseSectReservation(frame.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: jobId }, `cancel:${jobId}`);
    if (!released.ok) return privateResearchRejected(frame, 'INVALID_RESERVATION');
    next = researchReplace({ ...frame, construction: { ...frame.construction, ledger: released.context } }, { ...job, phase: 'cancelled', navigation: emptyNavigation(), blocked: null,
      terminal: { kind: 'cancelled', previousPhase: job.phase as 'to-site' | 'working', tick: context.simulationTick, calendarTick: context.calendarTick,
        position: { ...person.position }, consumed: [], released: sectReservationLines(claim, 'remainingReservation') } });
  }
  next = { ...next, research: { ...next.research, revision: frame.research.revision + 1,
    receipts: [...next.research.receipts, { command: cloneJson(command), revision: frame.research.revision + 1, jobId }] } };
  return researchAccepted(next, jobId);
}
function researchWork(frame: RelocationOwnerResearchSource, context: ConstructionContext, budget: WorkPathBudget): RelocationOwnerResearchSource {
  let next: RelocationOwnerResearchSource = { ...frame, research: { ...frame.research, revision: frame.research.revision + 1 } };
  if (context.mode !== 'management' || context.expeditionActive || context.paused) return next;
  const job = next.research.jobs.find(researchLive); if (!job) return next;
  const worker = next.construction.people.find(person => person.id === job.workerId)!;
  if (!eligible(worker)) return researchReplace(next, { ...job, blocked: 'WORKER_UNAVAILABLE' });
  if (!researchSiteUsable(next, job)) return researchReplace(next, { ...job, blocked: 'WORKSTATION_UNAVAILABLE' });
  if (!researchSiteFree(next, context, job.site, job.jobId)) return researchReplace(next, { ...job, blocked: 'ENTRANCE_BUSY' });
  const map = researchEffectiveMap(next);
  if (job.phase === 'to-site' || !sameCell(worker.position, job.site.position) || !isWalkable(map, worker.position)) {
    if (job.visits.length >= SECT_RESEARCH_LIMITS.visits) return researchReplace(next, { ...job, blocked: 'VISIT_CAPACITY' });
    const effect = advanceWorkNavigationWithBudget({ map, position: worker.position, target: job.site.position, navigation: job.navigation, simulationTick: context.simulationTick }, budget);
    if (effect.position) next = { ...next, construction: { ...next.construction,
      people: next.construction.people.map(person => person.id === job.workerId ? { ...person, position: { ...effect.position! } } : person) } };
    return researchReplace(next, { ...job, phase: effect.status === 'arrived' ? 'working' : 'to-site', navigation: effect.navigation,
      blocked: effect.status === 'path-blocked' ? 'PATH_BLOCKED' : effect.status === 'path-budget-exhausted' ? 'PATH_BUDGET' : null,
      visits: effect.status === 'arrived' ? [...job.visits, { tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...job.site.position } }] : job.visits });
  }
  const last = job.workSpans.at(-1); const visitIndex = job.visits.length - 1;
  const workSpans = last && last.visitIndex === visitIndex && last.lastTick + 1 === context.simulationTick && last.lastCalendarTick + 1 === context.calendarTick
    ? [...job.workSpans.slice(0, -1), { ...last, lastTick: context.simulationTick, lastCalendarTick: context.calendarTick }]
    : [...job.workSpans, { firstTick: context.simulationTick, lastTick: context.simulationTick, firstCalendarTick: context.calendarTick, lastCalendarTick: context.calendarTick, visitIndex }];
  const progressed = { ...job, activeTicks: job.activeTicks + 1, workSpans, blocked: null };
  if (progressed.activeTicks !== getSectResearchDefinition(job.researchId)!.workTicks) return researchReplace(next, progressed);
  // Eligibility and the applicable paid interval were checked on this exact final work boundary.
  const paid = commitSectReservation(next.construction.ledger, { reservationId: job.reservationId, ownerTransactionId: job.jobId }, `complete:${job.jobId}`, []);
  if (!paid.ok) throw new Error(`Validated research payment failed: ${paid.rejection.code}`);
  return researchReplace({ ...next, construction: { ...next.construction, ledger: paid.context } }, { ...progressed, phase: 'completed', navigation: emptyNavigation(),
    terminal: { kind: 'completed', previousPhase: 'working', tick: context.simulationTick, calendarTick: context.calendarTick,
      position: { ...worker.position }, consumed: sectReservationLines(paid.reservation, 'consumed'), released: [] } });
}
