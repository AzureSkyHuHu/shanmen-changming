import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import type { SectCell } from '../../content/sect-v9/types';
import { cardinalDistance, emptyNavigation, findCardinalPath, isWalkable, MOVEMENT_TICKS_PER_CELL, sameCell } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, type WorkPathBudget } from '../agents/work-navigation';
import { canonicalStringify, cloneJson } from '../kernel/serialization';
import { validateConstructionContext } from './construction-record-validation';
import { constructionClaims, tickConstructionForRelocationDomain } from './construction-runtime';
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
function safeTree(input: unknown): boolean {
  const seen = new Set<object>(); let remaining = SECT_RELOCATION_DESCRIPTOR_NODE_BOUND + 36 * (65536 * 3 + 30);
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
