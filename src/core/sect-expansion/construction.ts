import { getSectBuildingDefinition, SECT_V9_CANDIDATE_IDENTITY } from '../../content/sect-v9/catalog';
import type { SectCell } from '../../content/sect-v9/types';
import { emptyNavigation, isWalkable, sameCell } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, type WorkPathBudget, type WorkNavigationEffect } from '../agents/work-navigation';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import type { WorldMap } from '../world/types';
import { deriveSectFootprint, ownSectFields } from './layout';
import { commitSectReservation, consumeSectConstructionCheckpoint, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { assessSectPlacement } from './queries';
import type { PlacedBuildingSpace, SectPlacementRequest, SectSpatialContext } from './types';
import { CONSTRUCTION_LIMITS, type ConstructionBlueprint, type ConstructionClaim, type ConstructionCommand, type ConstructionContext,
  type ConstructionFrame, type ConstructionJob, type ConstructionPerson, type ConstructionRejection, type ConstructionResult, type ConstructionSeed } from './construction-types';
import { isConstructionCommand, validateConstructionContext, validateConstructionFrame } from './construction-validation';

const MAX = Number.MAX_SAFE_INTEGER;
const live = (job: ConstructionJob): boolean => job.terminal === null;
const placement = (bp: SectPlacementRequest): SectPlacementRequest => ({ definitionId: bp.definitionId, anchor: { ...bp.anchor }, rotation: bp.rotation });
const key = (p: SectCell): string => `${p.x},${p.y}`;
const rejected = (frame: ConstructionFrame, code: ConstructionRejection): ConstructionResult => ({ ok: false, frame, code });
const accepted = (frame: ConstructionFrame, relatedId: string | null = null, repeated = false): ConstructionResult => ({ ok: true, frame, relatedId, repeated });
const eligible = (person: ConstructionPerson): boolean => person.lifeState === 'alive' && person.canWork && !person.away
  && person.productionTransactionId === null && person.cultivationOwnerId === null && person.otherOwnerId === null;
const blueprint = (frame: ConstructionFrame, job: ConstructionJob): ConstructionBlueprint => frame.blueprints.find(bp => bp.blueprintId === job.blueprintId)!;
function entrance(frame: ConstructionFrame, job: ConstructionJob): SectCell {
  const result = deriveSectFootprint(placement(blueprint(frame, job)));
  if (!result.ok) throw new Error('Construction geometry invariant');
  return result.footprint.entrance;
}
function space(bp: ConstructionBlueprint, buildingId: string): PlacedBuildingSpace {
  return { kind: 'placed', buildingId, ...placement(bp), level: 1 };
}
/** Active worksites are hard collisions; unstarted blueprints remain soft walking claims. */
function spatial(frame: ConstructionFrame, omitBlueprintId?: string, omitPersonId?: string): SectSpatialContext {
  return { map: frame.map, legacyStations: frame.legacyStations,
    people: frame.people.filter(person => person.id !== omitPersonId).map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState, traveling: person.away })),
    spaces: [...frame.legacyStations.map(station => ({ kind: 'legacy-point' as const, buildingId: station.id })),
      ...frame.buildings.map(building => ({ kind: 'placed' as const, buildingId: building.buildingId, ...placement(building), level: building.level })),
      ...frame.jobs.filter(job => live(job) && job.blueprintId !== omitBlueprintId).map(job => space(blueprint(frame, job), job.resultBuildingId))],
    blueprints: frame.blueprints.filter(bp => bp.status === 'planned' && bp.blueprintId !== omitBlueprintId)
      .map(bp => ({ blueprintId: bp.blueprintId, ...placement(bp) })) };
}
/** Explicit cross-domain ownership view; callers must feed it into production/cultivation/away admission. */
export function constructionClaims(frame: ConstructionFrame): readonly ConstructionClaim[] {
  return frame.jobs.filter(live).slice().sort((a, b) => compareStable(a.jobId, b.jobId)).flatMap(job => [
    { kind: 'worker' as const, key: job.workerId, ownerId: job.jobId },
    { kind: 'seat' as const, key: job.seatToken, ownerId: job.jobId },
    { kind: 'entrance' as const, key: job.entranceToken, ownerId: job.jobId },
  ]);
}
/** A detached map using the shared navigator. It never overwrites base terrain. */
export function constructionEffectiveMap(frame: ConstructionFrame): WorldMap {
  const cells = new Set<string>();
  const placements = [...frame.buildings, ...frame.jobs.filter(live).map(job => blueprint(frame, job))];
  for (const value of placements) {
    const geometry = deriveSectFootprint(placement(value));
    if (!geometry.ok) throw new Error('Construction geometry invariant');
    for (const cell of geometry.footprint.cells) cells.add(key(cell));
  }
  return { ...frame.map, tiles: frame.map.tiles.map(tile => ({ ...tile, walkable: tile.walkable && tile.terrain !== 'water' && !cells.has(key(tile)) })) };
}
function invalidate(frame: ConstructionFrame): ConstructionFrame {
  return { ...frame, map: { ...frame.map, navVersion: frame.map.navVersion + 1 },
    jobs: frame.jobs.map(job => live(job) ? { ...job, navigation: emptyNavigation() } : job) };
}
function replaceJob(frame: ConstructionFrame, job: ConstructionJob): ConstructionFrame {
  return { ...frame, jobs: frame.jobs.map(value => value.jobId === job.jobId ? job : value) };
}
function conflicts(context: ConstructionContext, kind: ConstructionClaim['kind'], token: string, ownerId?: string): boolean {
  return context.externalClaims.some(claim => claim.kind === kind && claim.key === token && claim.ownerId !== ownerId);
}
function siteOccupied(frame: ConstructionFrame, job: ConstructionJob): boolean {
  const door = entrance(frame, job);
  return frame.people.some(person => person.id !== job.workerId && person.lifeState !== 'dead' && !person.away && sameCell(person.position, door));
}
function current(frame: ConstructionFrame, context: ConstructionContext): ConstructionRejection | null {
  if (validateConstructionFrame(frame).length) return 'INVALID_FRAME';
  if (!validateConstructionContext(context)) return 'INVALID_CONTEXT';
  if (context.simulationTick !== frame.lastSimulationTick || context.calendarTick !== frame.lastCalendarTick) return 'STALE_CLOCK';
  return null;
}
function publish(source: ConstructionFrame, candidate: ConstructionFrame, relatedId: string | null): ConstructionResult {
  // Each outstanding blueprint has one real cancellation command left. Tick/command publication
  // may spend this headroom only if its own actual terminal evidence discharges an obligation.
  const cancellations = candidate.blueprints.filter(bp => bp.status === 'planned' || bp.status === 'started').length;
  if (candidate.revision > MAX - cancellations) return rejected(source, 'CAPACITY_EXCEEDED');
  if (validateConstructionFrame(candidate).length) return rejected(source, 'INVALID_FRAME');
  return accepted(cloneJson(candidate), relatedId);
}
export function createConstructionFrame(seed: ConstructionSeed): ConstructionFrame {
  if (!ownSectFields(seed, ['map', 'legacyStations', 'people', 'ledger', 'simulationTick', 'calendarTick'])) throw new RangeError('Invalid construction seed');
  const frame: ConstructionFrame = { schemaVersion: 1, catalogIdentity: SECT_V9_CANDIDATE_IDENTITY, revision: 0, nextId: 1,
    lastSimulationTick: seed.simulationTick, lastCalendarTick: seed.calendarTick, map: seed.map, legacyStations: seed.legacyStations,
    people: seed.people, ledger: seed.ledger, blueprints: [], jobs: [], buildings: [], receipts: [] };
  if (validateConstructionFrame(frame).length) throw new RangeError('Invalid construction seed');
  return cloneJson(frame);
}
/** Prediction only. Neither this result nor any command can certify research, money or completed work. */
export function previewConstructionPlacement(frame: ConstructionFrame, context: ConstructionContext, request: SectPlacementRequest): ConstructionResult {
  const problem = current(frame, context);
  if (problem) return rejected(frame, problem);
  const geometry = deriveSectFootprint(request);
  if (!geometry.ok) return rejected(frame, 'INVALID_COMMAND');
  if (getSectBuildingDefinition(request.definitionId)!.levels[0]!.requiredResearch.length) return rejected(frame, 'RESEARCH_AUTHORITY_REQUIRED');
  return assessSectPlacement(spatial(frame), request).ok ? accepted(frame) : rejected(frame, 'PLACEMENT_CHANGED');
}
/**
 * No move/upgrade/maintenance/research completion commands exist in this slice. Research-gated
 * definitions fail closed until a real research authority and provenance contract are integrated.
 */
export function applyConstructionCommand(frame: ConstructionFrame, context: ConstructionContext, command: ConstructionCommand): ConstructionResult {
  const problem = current(frame, context);
  if (problem) return rejected(frame, problem);
  if (!isConstructionCommand(command)) return rejected(frame, 'INVALID_COMMAND');
  const old = frame.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (old) return canonicalStringify(old.command) === canonicalStringify(command) ? accepted(frame, old.relatedId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  if (command.expectedRevision !== frame.revision) return rejected(frame, 'STALE_REVISION');
  if (frame.revision === MAX) return rejected(frame, 'CAPACITY_EXCEEDED');
  let next = frame; let relatedId: string;
  if (command.kind === 'blueprint.place') {
    if (context.mode !== 'management' || context.expeditionActive) return rejected(frame, 'MANAGEMENT_REQUIRED');
    if (frame.blueprints.length >= CONSTRUCTION_LIMITS.records || frame.blueprints.filter(bp => bp.status === 'planned').length >= CONSTRUCTION_LIMITS.blueprints
      || frame.nextId >= MAX || frame.receipts.length + 3 * (frame.blueprints.filter(bp => bp.status === 'planned').length + 1) + frame.jobs.filter(live).length > CONSTRUCTION_LIMITS.receipts) return rejected(frame, 'CAPACITY_EXCEEDED');
    const preview = previewConstructionPlacement(frame, context, command.placement);
    if (!preview.ok) return preview;
    relatedId = `sect-blueprint:${frame.nextId}`;
    const bp: ConstructionBlueprint = { ...placement(command.placement), blueprintId: relatedId, placedTick: context.simulationTick,
      placedCalendarTick: context.calendarTick, status: 'planned', jobId: null, endedTick: null };
    next = { ...frame, nextId: frame.nextId + 1, blueprints: [...frame.blueprints, bp] };
  } else {
    const bp = frame.blueprints.find(value => value.blueprintId === command.blueprintId);
    if (!bp) return rejected(frame, 'UNKNOWN_BLUEPRINT');
    if (bp.status === 'completed' || bp.status === 'cancelled') return rejected(frame, 'TRANSACTION_FINISHED');
    if (command.kind === 'construction.start') {
      if (context.mode !== 'management' || context.paused || context.expeditionActive) return rejected(frame, 'MANAGEMENT_REQUIRED');
      if (bp.status !== 'planned') return rejected(frame, 'TRANSACTION_FINISHED');
      if (getSectBuildingDefinition(bp.definitionId)!.levels[0]!.requiredResearch.length) return rejected(frame, 'RESEARCH_AUTHORITY_REQUIRED');
      const active = frame.jobs.filter(live);
      if (active.length + context.externalActiveJobs >= CONSTRUCTION_LIMITS.activeJobs || active.length + frame.buildings.length + 8 >= CONSTRUCTION_LIMITS.buildings
        || frame.jobs.length >= CONSTRUCTION_LIMITS.records || frame.ledger.reservations.length >= CONSTRUCTION_LIMITS.records * 3
        || frame.nextId > MAX - 3 || frame.map.navVersion > MAX - active.length - 2 || context.calendarTick > MAX - 1200) return rejected(frame, 'CAPACITY_EXCEEDED');
      const worker = frame.people.find(person => person.id === command.workerId);
      if (!worker || !eligible(worker) || active.some(job => job.workerId === worker.id)) return rejected(frame, 'WORKER_UNAVAILABLE');
      const storage = frame.legacyStations.find(station => station.blueprintId === 'storage' && station.operational);
      if (!storage) return rejected(frame, 'STORAGE_UNAVAILABLE');
      const geometry = deriveSectFootprint(placement(bp));
      if (!geometry.ok) return rejected(frame, 'INVALID_FRAME');
      if (conflicts(context, 'worker', worker.id) || conflicts(context, 'seat', bp.blueprintId) || conflicts(context, 'entrance', key(geometry.footprint.entrance))) return rejected(frame, 'CLAIM_CONFLICT');
      if (!assessSectPlacement(spatial(frame, bp.blueprintId), placement(bp)).ok) return rejected(frame, 'PLACEMENT_CHANGED');
      relatedId = `sect-construction:${frame.nextId}`;
      const reservationId = `sect-reservation:${frame.nextId + 1}`; const resultBuildingId = `sect-building:${frame.nextId + 2}`;
      const reserve = reserveSectResources(frame.ledger, { reservationId, ownerTransactionId: relatedId }, getSectBuildingDefinition(bp.definitionId)!.levels[0]!.costs, 'construction-checkpoints');
      if (!reserve.ok) return rejected(frame, reserve.rejection.code === 'INSUFFICIENT_INVENTORY' ? 'INSUFFICIENT_INVENTORY' : 'INVALID_RESERVATION');
      const job: ConstructionJob = { jobId: relatedId, blueprintId: bp.blueprintId, reservationId, resultBuildingId, workerId: worker.id, storageId: storage.id,
        seatToken: bp.blueprintId, entranceToken: key(geometry.footprint.entrance), phase: 'to-storage', startedTick: context.simulationTick,
        startedCalendarTick: context.calendarTick, origin: { ...worker.position }, storageVisit: null, siteVisit: null, workSpans: [], activeTicks: 0,
        navigation: emptyNavigation(), blocked: null, terminal: null };
      next = invalidate({ ...frame, nextId: frame.nextId + 3, ledger: reserve.context, jobs: [...frame.jobs, job],
        blueprints: frame.blueprints.map(value => value.blueprintId === bp.blueprintId ? { ...value, status: 'started', jobId: relatedId } : value) });
    } else {
      relatedId = bp.blueprintId;
      if (bp.jobId !== null) {
        const job = frame.jobs.find(value => value.jobId === bp.jobId)!;
        if (frame.map.navVersion === MAX) return rejected(frame, 'CAPACITY_EXCEEDED');
        const worker = frame.people.find(person => person.id === job.workerId)!;
        const claim = frame.ledger.reservations.find(value => value.reservationId === job.reservationId)!;
        const release = releaseSectReservation(frame.ledger, { reservationId: job.reservationId, ownerTransactionId: job.jobId }, `cancel:${job.jobId}`);
        if (!release.ok) return rejected(frame, 'INVALID_RESERVATION');
        const cancelled: ConstructionJob = { ...job, phase: 'cancelled', navigation: emptyNavigation(), blocked: null,
          terminal: { kind: 'cancelled', tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...worker.position },
            previousPhase: job.phase as 'to-storage' | 'to-site' | 'working', consumed: sectReservationLines(claim, 'consumed'),
            released: sectReservationLines(claim, 'remainingReservation'), buildingId: null } };
        next = invalidate(replaceJob({ ...frame, ledger: release.context }, cancelled));
        // A broken external terrain/position input is never repaired by teleporting the worker.
        if (!isWalkable(constructionEffectiveMap(next), worker.position)) return rejected(frame, 'PLACEMENT_CHANGED');
      }
      next = { ...next, blueprints: next.blueprints.map(value => value.blueprintId === bp.blueprintId ? { ...value, status: 'cancelled', endedTick: context.simulationTick } : value) };
    }
  }
  if (next.receipts.length >= CONSTRUCTION_LIMITS.receipts) return rejected(frame, 'CAPACITY_EXCEEDED');
  next = { ...next, revision: frame.revision + 1, receipts: [...next.receipts, { command: cloneJson(command), revision: frame.revision + 1, relatedId }] };
  return publish(frame, next, relatedId);
}
function complete(frame: ConstructionFrame, context: ConstructionContext, job: ConstructionJob): ConstructionFrame {
  const bp = blueprint(frame, job); const worker = frame.people.find(person => person.id === job.workerId)!;
  if (!assessSectPlacement(spatial(frame, bp.blueprintId, worker.id), placement(bp)).ok) return replaceJob(frame, { ...job, blocked: 'PLACEMENT_CHANGED' });
  const identity = { reservationId: job.reservationId, ownerTransactionId: job.jobId };
  const debit = consumeSectConstructionCheckpoint(frame.ledger, identity, 'remainder');
  if (!debit.ok) throw new Error('Construction remainder invariant');
  const commit = commitSectReservation(debit.context, identity, `complete:${job.jobId}`, []);
  if (!commit.ok) throw new Error('Construction completion invariant');
  const terminalJob: ConstructionJob = { ...job, phase: 'completed', navigation: emptyNavigation(), blocked: null,
    terminal: { kind: 'completed', tick: context.simulationTick, calendarTick: context.calendarTick, position: { ...worker.position }, previousPhase: 'working',
      consumed: sectReservationLines(commit.reservation, 'consumed'), released: [], buildingId: job.resultBuildingId } };
  return invalidate({ ...replaceJob(frame, terminalJob), ledger: commit.context,
    blueprints: frame.blueprints.map(value => value.blueprintId === bp.blueprintId ? { ...value, status: 'completed', endedTick: context.simulationTick } : value),
    buildings: [...frame.buildings, { ...space(bp, job.resultBuildingId), sourceJobId: job.jobId, completedTick: context.simulationTick,
      completedCalendarTick: context.calendarTick, firstMaintenanceCalendarTick: context.calendarTick + 1200 }] });
}
/** One true management boundary. The caller creates ONE budget per tick shared with all work domains. */
export function tickConstruction(frame: ConstructionFrame, context: ConstructionContext, budget: WorkPathBudget): ConstructionResult {
  if (validateConstructionFrame(frame).length) return rejected(frame, 'INVALID_FRAME');
  if (!validateConstructionContext(context)) return rejected(frame, 'INVALID_CONTEXT');
  if (context.simulationTick === frame.lastSimulationTick && context.calendarTick === frame.lastCalendarTick) return accepted(frame, null, true);
  if (context.paused || context.simulationTick <= frame.lastSimulationTick || context.calendarTick < frame.lastCalendarTick) return rejected(frame, 'STALE_CLOCK');
  if (context.simulationTick !== frame.lastSimulationTick + 1 || context.calendarTick !== frame.lastCalendarTick + (context.mode === 'management' ? 1 : 0)) return rejected(frame, 'CLOCK_GAP');
  if (!budget || budget.simulationTick !== context.simulationTick) return rejected(frame, 'INVALID_CONTEXT');
  const activeCount = frame.jobs.filter(live).length;
  if (frame.revision === MAX || frame.map.navVersion > MAX - activeCount || (activeCount > 0 && (context.calendarTick > MAX - 1200 || context.simulationTick > MAX - 20))) return rejected(frame, 'CAPACITY_EXCEEDED');
  let next: ConstructionFrame = { ...frame, lastSimulationTick: context.simulationTick, lastCalendarTick: context.calendarTick, revision: frame.revision + 1 };
  if (context.mode !== 'management' || context.expeditionActive) return publish(frame, next, null);
  const ordered = frame.jobs.filter(live).slice().sort((a, b) => compareStable(a.jobId, b.jobId));
  for (const original of ordered) {
    let job = next.jobs.find(value => value.jobId === original.jobId)!;
    const worker = next.people.find(person => person.id === job.workerId)!;
    if (!eligible(worker) || conflicts(context, 'worker', worker.id, job.jobId)) { next = replaceJob(next, { ...job, blocked: 'WORKER_UNAVAILABLE' }); continue; }
    const storage = next.legacyStations.find(station => station.id === job.storageId)!;
    if (!storage.operational) { next = replaceJob(next, { ...job, blocked: 'STORAGE_UNAVAILABLE' }); continue; }
    const target = job.phase === 'to-storage' ? { x: storage.x, y: storage.y } : entrance(next, job);
    if (conflicts(context, 'seat', job.seatToken, job.jobId) || conflicts(context, 'entrance', key(target), job.jobId) || (job.phase !== 'to-storage' && siteOccupied(next, job))) {
      next = replaceJob(next, { ...job, blocked: 'ENTRANCE_BUSY' }); continue;
    }
    const effectiveMap = constructionEffectiveMap(next);
    if (job.phase === 'to-storage' || job.phase === 'to-site') {
      let effect: WorkNavigationEffect;
      try { effect = advanceWorkNavigationWithBudget({ map: effectiveMap, position: worker.position, target, navigation: job.navigation, simulationTick: context.simulationTick }, budget); }
      catch (error) {
        if (error instanceof RangeError && (error.message === 'Invalid path budget' || error.message === 'Path budget belongs to another tick')) return rejected(frame, 'INVALID_CONTEXT');
        throw error;
      }
      job = { ...job, navigation: effect.navigation, blocked: effect.status === 'path-blocked' ? 'PATH_BLOCKED' : effect.status === 'path-budget-exhausted' ? 'PATH_BUDGET' : null };
      if (effect.position) next = { ...next, people: next.people.map(person => person.id === worker.id ? { ...person, position: { ...effect.position! } } : person) };
      if (effect.status === 'arrived') {
        const visit = { tick: context.simulationTick, position: { ...target } };
        job = job.phase === 'to-storage' ? { ...job, phase: 'to-site', storageVisit: visit } : { ...job, phase: 'working', siteVisit: visit };
      }
      next = replaceJob(next, job); continue; // Arrival never grants a work tick.
    }
    if (!sameCell(worker.position, target) || !isWalkable(effectiveMap, worker.position)) { next = replaceJob(next, { ...job, blocked: 'PATH_BLOCKED' }); continue; }
    const definition = getSectBuildingDefinition(blueprint(next, job).definitionId)!.levels[0]!;
    if (job.activeTicks < definition.workTicks) {
      const spans = job.workSpans.slice(); const last = spans.at(-1);
      if (last && last.lastTick === context.simulationTick - 1) spans[spans.length - 1] = { ...last, lastTick: context.simulationTick };
      else spans.push({ firstTick: context.simulationTick, lastTick: context.simulationTick });
      job = { ...job, activeTicks: job.activeTicks + 1, workSpans: spans, blocked: null };
      if (job.activeTicks === Math.ceil(definition.workTicks / 2)) {
        const paid = consumeSectConstructionCheckpoint(next.ledger, { reservationId: job.reservationId, ownerTransactionId: job.jobId }, 'half');
        if (!paid.ok) return rejected(frame, 'INVALID_RESERVATION');
        next = { ...next, ledger: paid.context };
      }
      next = replaceJob(next, job);
    }
    if (job.activeTicks === definition.workTicks) next = complete(next, context, job);
  }
  return publish(frame, next, null);
}
