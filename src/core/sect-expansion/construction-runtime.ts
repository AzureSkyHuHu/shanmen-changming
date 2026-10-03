import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import type { SectCell } from '../../content/sect-v9/types';
import { emptyNavigation, isWalkable, sameCell } from '../agents/navigation';
import { advanceWorkNavigationWithBudget, type WorkPathBudget, type WorkNavigationEffect } from '../agents/work-navigation';
import { canonicalStringify, cloneJson, compareStable } from '../kernel/serialization';
import type { WorldMap } from '../world/types';
import { relocationOwnerCurrentSpatialContext, relocationOwnerEffectiveMap } from '../world/relocation-owner/spatial-records';
import type { SectRelocationRecordFrame, SectRelocationState } from './relocation-types';
import { deriveSectFootprint } from './layout';
import { commitSectReservation, consumeSectConstructionCheckpoint, releaseSectReservation, reserveSectResources, sectReservationLines } from './ledger';
import { constructionResearchGate, constructionResearchGateMatches } from './research-consumer-gates';
import type { SectResearchFrame } from './research-types';
import { assessSectPlacement } from './queries';
import type { PlacedBuildingSpace, SectPlacementRequest, SectSpatialContext } from './types';
import { CONSTRUCTION_LIMITS, type ConstructionBlueprint, type ConstructionClaim, type ConstructionCommand, type ConstructionContext,
  type ConstructionFrame, type ConstructionJob, type ConstructionPerson, type ConstructionRejection, type ConstructionResult } from './construction-types';

const MAX = Number.MAX_SAFE_INTEGER;
// Only fixed wrappers select this private policy. The original records are never projected
// onto moved anchors, nor is a caller-supplied map/callback accepted as authority.
type SpatialPolicy = { readonly kind: 'permanent-origin' } | { readonly kind: 'relocation-domain'; readonly relocation: SectRelocationState };
const permanentOrigin: SpatialPolicy = { kind: 'permanent-origin' };
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
/** Each query binds the complete current construction book to the unchanged relocation book. */
function policyPlacement(frame: ConstructionFrame, policy: SpatialPolicy, request: SectPlacementRequest,
  omitBlueprintId?: string, omitPersonId?: string): boolean {
  if (policy.kind === 'permanent-origin') return assessSectPlacement(spatial(frame, omitBlueprintId, omitPersonId), request).ok;
  const result = relocationOwnerCurrentSpatialContext(cloneJson({ construction: frame, relocation: policy.relocation }));
  if (!result.ok) return false;
  const omitted = frame.jobs.find(job => job.blueprintId === omitBlueprintId)?.resultBuildingId;
  const context: SectSpatialContext = { ...result.context,
    people: result.context.people.filter(person => person.id !== omitPersonId),
    spaces: result.context.spaces.filter(value => value.buildingId !== omitted),
    blueprints: result.context.blueprints.filter(value => value.blueprintId !== omitBlueprintId) };
  if (!assessSectPlacement(context, request).ok) return false;
  const geometry = deriveSectFootprint(request); if (!geometry.ok) return false;
  const occupied = new Set([...geometry.footprint.cells, geometry.footprint.entrance].map(key));
  // Relocation reservations do not consume the sixteen blueprint slots.
  return result.softTargets.every(target => [...target.footprint.cells, target.footprint.entrance].every(cell => !occupied.has(key(cell))));
}
function policyMap(frame: ConstructionFrame, policy: SpatialPolicy): WorldMap | null {
  if (policy.kind === 'permanent-origin') return constructionEffectiveMap(frame);
  const result = relocationOwnerEffectiveMap(cloneJson({ construction: frame, relocation: policy.relocation }));
  return result.ok ? result.map : null;
}
function relocationContext(context: ConstructionContext, relocation: SectRelocationState): ConstructionContext {
  const active = relocation.jobs.filter(job => job.terminal === null);
  const claims: ConstructionClaim[] = active.flatMap(job => {
    const old = deriveSectFootprint(job.from); const target = deriveSectFootprint(job.to);
    if (!old.ok || !target.ok) throw new Error('Relocation geometry invariant');
    return [{ kind: 'worker' as const, key: job.workerId, ownerId: job.jobId },
      { kind: 'seat' as const, key: job.buildingId, ownerId: job.jobId },
      ...Array.from(new Set([key(old.footprint.entrance), key(target.footprint.entrance)])).map(token =>
        ({ kind: 'entrance' as const, key: token, ownerId: job.jobId }))];
  });
  return { ...context, externalActiveJobs: context.externalActiveJobs + active.length, externalClaims: [...context.externalClaims, ...claims] };
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
/** Internal prediction for a validated frame/context and, only at the research root, full authority.
 * This is a local candidate only, never proof of research, funds or completed work. */
export function previewValidatedConstructionPlacement(frame: ConstructionFrame, context: ConstructionContext, request: SectPlacementRequest, researchAuthority?: Pick<SectResearchFrame, 'construction' | 'research'>): ConstructionResult {
  return previewPlacement(frame, context, request, permanentOrigin, researchAuthority);
}
function previewPlacement(frame: ConstructionFrame, context: ConstructionContext, request: SectPlacementRequest, policy: SpatialPolicy, researchAuthority?: Pick<SectResearchFrame, 'construction' | 'research'>): ConstructionResult {
  const geometry = deriveSectFootprint(request);
  if (!geometry.ok) return rejected(frame, 'INVALID_COMMAND');
  if (getSectBuildingDefinition(request.definitionId)!.levels[0]!.requiredResearch.length
    && (!researchAuthority || !constructionResearchGate(researchAuthority, request.definitionId, context.simulationTick, context.calendarTick))) return rejected(frame, 'RESEARCH_AUTHORITY_REQUIRED');
  return policyPlacement(frame, policy, request) ? accepted(frame) : rejected(frame, 'PLACEMENT_CHANGED');
}
/**
 * Internal command stage: source frame, context, clock and command shape are already checked.
 * The owner validates/clones the whole candidate before publication. Only research root passes
 * its actual full authority; the standalone public wrapper can never authorize gated work.
 */
export function applyValidatedConstructionCommand(frame: ConstructionFrame, context: ConstructionContext, command: ConstructionCommand, researchAuthority?: Pick<SectResearchFrame, 'construction' | 'research'>): ConstructionResult {
  return applyCommand(frame, context, command, permanentOrigin, researchAuthority);
}
function applyCommand(frame: ConstructionFrame, context: ConstructionContext, command: ConstructionCommand, policy: SpatialPolicy, researchAuthority?: Pick<SectResearchFrame, 'construction' | 'research'>): ConstructionResult {
  const old = frame.receipts.find(receipt => receipt.command.commandId === command.commandId);
  if (old) return canonicalStringify(old.command) === canonicalStringify(command) ? accepted(frame, old.relatedId, true) : rejected(frame, 'IDENTITY_CONFLICT');
  if (command.expectedRevision !== frame.revision) return rejected(frame, 'STALE_REVISION');
  if (frame.revision === MAX) return rejected(frame, 'CAPACITY_EXCEEDED');
  let next = frame; let relatedId: string;
  if (command.kind === 'blueprint.place') {
    if (context.mode !== 'management' || context.expeditionActive) return rejected(frame, 'MANAGEMENT_REQUIRED');
    if (frame.blueprints.length >= CONSTRUCTION_LIMITS.records || frame.blueprints.filter(bp => bp.status === 'planned').length >= CONSTRUCTION_LIMITS.blueprints
      || frame.nextId >= MAX || frame.receipts.length + 3 * (frame.blueprints.filter(bp => bp.status === 'planned').length + 1) + frame.jobs.filter(live).length > CONSTRUCTION_LIMITS.receipts) return rejected(frame, 'CAPACITY_EXCEEDED');
    const preview = previewPlacement(frame, context, command.placement, policy, researchAuthority);
    if (!preview.ok) return preview;
    relatedId = `sect-blueprint:${frame.nextId}`;
    const researchGate = researchAuthority ? constructionResearchGate(researchAuthority, command.placement.definitionId, context.simulationTick, context.calendarTick) : null;
    const bp: ConstructionBlueprint = { ...placement(command.placement), ...(researchGate ? { researchGate } : {}), blueprintId: relatedId, placedTick: context.simulationTick,
      placedCalendarTick: context.calendarTick, status: 'planned', jobId: null, endedTick: null };
    next = { ...frame, nextId: frame.nextId + 1, blueprints: [...frame.blueprints, bp] };
  } else {
    const bp = frame.blueprints.find(value => value.blueprintId === command.blueprintId);
    if (!bp) return rejected(frame, 'UNKNOWN_BLUEPRINT');
    if (bp.status === 'completed' || bp.status === 'cancelled') return rejected(frame, 'TRANSACTION_FINISHED');
    if (command.kind === 'construction.start') {
      if (context.mode !== 'management' || context.paused || context.expeditionActive) return rejected(frame, 'MANAGEMENT_REQUIRED');
      if (bp.status !== 'planned') return rejected(frame, 'TRANSACTION_FINISHED');
      if (getSectBuildingDefinition(bp.definitionId)!.levels[0]!.requiredResearch.length
        && (!researchAuthority || !constructionResearchGateMatches(researchAuthority, bp, context.simulationTick, context.calendarTick))) return rejected(frame, 'RESEARCH_AUTHORITY_REQUIRED');
      const active = frame.jobs.filter(live);
      if (active.length + context.externalActiveJobs >= CONSTRUCTION_LIMITS.activeJobs || active.length + frame.buildings.length + 8 >= CONSTRUCTION_LIMITS.buildings
        || frame.jobs.length >= CONSTRUCTION_LIMITS.records || frame.ledger.reservations.length >= CONSTRUCTION_LIMITS.records * 3
        || frame.nextId > MAX - 3 || frame.map.navVersion > MAX - active.length - 2
        - (policy.kind === 'relocation-domain' ? policy.relocation.jobs.filter(job => job.terminal === null).length : 0) || context.calendarTick > MAX - 1200) return rejected(frame, 'CAPACITY_EXCEEDED');
      const worker = frame.people.find(person => person.id === command.workerId);
      if (!worker || !eligible(worker) || active.some(job => job.workerId === worker.id)) return rejected(frame, 'WORKER_UNAVAILABLE');
      const storage = frame.legacyStations.find(station => station.blueprintId === 'storage' && station.operational);
      if (!storage) return rejected(frame, 'STORAGE_UNAVAILABLE');
      const geometry = deriveSectFootprint(placement(bp));
      if (!geometry.ok) return rejected(frame, 'INVALID_FRAME');
      if (conflicts(context, 'worker', worker.id) || conflicts(context, 'seat', bp.blueprintId) || conflicts(context, 'entrance', key(geometry.footprint.entrance))) return rejected(frame, 'CLAIM_CONFLICT');
      if (!policyPlacement(frame, policy, placement(bp), bp.blueprintId)) return rejected(frame, 'PLACEMENT_CHANGED');
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
        if (policy.kind === 'permanent-origin' && !isWalkable(constructionEffectiveMap(next), worker.position)) return rejected(frame, 'PLACEMENT_CHANGED');
      }
      next = { ...next, blueprints: next.blueprints.map(value => value.blueprintId === bp.blueprintId ? { ...value, status: 'cancelled', endedTick: context.simulationTick } : value) };
    }
  }
  if (next.receipts.length >= CONSTRUCTION_LIMITS.receipts) return rejected(frame, 'CAPACITY_EXCEEDED');
  next = { ...next, revision: frame.revision + 1, receipts: [...next.receipts, { command: cloneJson(command), revision: frame.revision + 1, relatedId }] };
  if (policy.kind === 'relocation-domain' && command.kind === 'construction.cancel') {
    const cancelled = next.jobs.find(job => job.blueprintId === command.blueprintId);
    if (cancelled) {
      const map = policyMap(next, policy); const worker = next.people.find(person => person.id === cancelled.workerId)!;
      if (!map || !isWalkable(map, worker.position)) return rejected(frame, 'PLACEMENT_CHANGED');
    }
  }
  return accepted(next, relatedId);
}
function complete(frame: ConstructionFrame, context: ConstructionContext, job: ConstructionJob, policy: SpatialPolicy): ConstructionFrame {
  const bp = blueprint(frame, job); const worker = frame.people.find(person => person.id === job.workerId)!;
  if (!policyPlacement(frame, policy, placement(bp), bp.blueprintId, worker.id)) return replaceJob(frame, { ...job, blocked: 'PLACEMENT_CHANGED' });
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
/** Internal tick stage for a validated source and the next admitted typed context.
 * Advances this authority clock once and preserves source on rejection. The owner still checks
 * cancellation headroom and the complete candidate before publishing. ONE caller-owned path
 * budget is shared with all work domains; it is never an authorization or validation bypass. */
export function tickValidatedConstruction(frame: ConstructionFrame, context: ConstructionContext, budget: WorkPathBudget, researchAuthority?: Pick<SectResearchFrame, 'construction' | 'research'>): ConstructionResult {
  return tickConstructionMechanics(frame, context, budget, permanentOrigin, researchAuthority);
}
function tickConstructionMechanics(frame: ConstructionFrame, context: ConstructionContext, budget: WorkPathBudget, policy: SpatialPolicy, researchAuthority?: Pick<SectResearchFrame, 'construction' | 'research'>): ConstructionResult {
  const activeCount = frame.jobs.filter(live).length;
  if (frame.revision === MAX || frame.map.navVersion > MAX - activeCount || (activeCount > 0 && (context.calendarTick > MAX - 1200 || context.simulationTick > MAX - 20))) return rejected(frame, 'CAPACITY_EXCEEDED');
  let next: ConstructionFrame = { ...frame, lastSimulationTick: context.simulationTick, lastCalendarTick: context.calendarTick, revision: frame.revision + 1 };
  if (context.mode !== 'management' || context.expeditionActive || policy.kind === 'relocation-domain' && context.paused) return accepted(next);
  const ordered = frame.jobs.filter(live).slice().sort((a, b) => compareStable(a.jobId, b.jobId));
  for (const original of ordered) {
    let job = next.jobs.find(value => value.jobId === original.jobId)!;
    const bp = blueprint(next, job);
    // Resolve the durable reference again before this boundary's work/checkpoints/completion.
    if (getSectBuildingDefinition(bp.definitionId)!.levels[0]!.requiredResearch.length
      && (!researchAuthority || !constructionResearchGateMatches(researchAuthority, bp, context.simulationTick, context.calendarTick))) return rejected(frame, 'RESEARCH_AUTHORITY_REQUIRED');
    const worker = next.people.find(person => person.id === job.workerId)!;
    if (!eligible(worker) || conflicts(context, 'worker', worker.id, job.jobId)) { next = replaceJob(next, { ...job, blocked: 'WORKER_UNAVAILABLE' }); continue; }
    const storage = next.legacyStations.find(station => station.id === job.storageId)!;
    if (!storage.operational) { next = replaceJob(next, { ...job, blocked: 'STORAGE_UNAVAILABLE' }); continue; }
    const target = job.phase === 'to-storage' ? { x: storage.x, y: storage.y } : entrance(next, job);
    if (conflicts(context, 'seat', job.seatToken, job.jobId) || conflicts(context, 'entrance', key(target), job.jobId) || (job.phase !== 'to-storage' && siteOccupied(next, job))) {
      next = replaceJob(next, { ...job, blocked: 'ENTRANCE_BUSY' }); continue;
    }
    const effectiveMap = policyMap(next, policy);
    if (!effectiveMap) return rejected(frame, 'INVALID_FRAME');
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
    if (job.activeTicks === definition.workTicks) next = complete(next, context, job, policy);
  }
  return accepted(next);
}

/** Fixed internal two-domain stage. Full envelope/live admission belongs to the composition
 * root; every spatial query independently binds the real relocation records. No research
 * authority is manufactured here, so gated construction remains unavailable. */
export function applyConstructionCommandForRelocationDomain(records: SectRelocationRecordFrame, context: ConstructionContext,
  command: ConstructionCommand): ConstructionResult {
  if (!relocationOwnerCurrentSpatialContext(records).ok) return rejected(records.construction, 'INVALID_FRAME');
  if (records.relocation.receipts.some(receipt => receipt.command.commandId === command.commandId)) return rejected(records.construction, 'IDENTITY_CONFLICT');
  return applyCommand(records.construction, relocationContext(context, records.relocation), command,
    { kind: 'relocation-domain', relocation: records.relocation });
}
/** Advances the single construction clock; relocation subsequently runs its already-clocked
 * work stage using this exact candidate and the same caller-owned path budget. */
export function tickConstructionForRelocationDomain(records: SectRelocationRecordFrame, context: ConstructionContext,
  budget: WorkPathBudget): ConstructionResult {
  if (!relocationOwnerCurrentSpatialContext(records).ok) return rejected(records.construction, 'INVALID_FRAME');
  return tickConstructionMechanics(records.construction, relocationContext(context, records.relocation), budget,
    { kind: 'relocation-domain', relocation: records.relocation });
}
