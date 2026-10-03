import type { SectCell } from '../../../content/sect-v9/types';
import { cloneJson } from '../../kernel/serialization';
import type { ConstructionBlueprint, ConstructionFrame, ConstructionValidationIssue } from '../../sect-expansion/construction-types';
import { deriveSectFootprint, ownSectFields } from '../../sect-expansion/layout';
import { inspectSectLayout } from '../../sect-expansion/queries';
import type { SectHistoricalPlacement, SectRelocationRecordFrame } from '../../sect-expansion/relocation-types';
import { inspectRelocationProvenanceForOwner } from '../../sect-expansion/relocation-validation';
import type { SectFootprint, SectPlacementRequest, SectSpatialContext } from '../../sect-expansion/types';
import type { WorldMap } from '../types';
import { RELOCATION_OWNER_PHASES, type RelocationOwnerBoundary } from './types';
import { compareRelocationHistoryEdges as compare, relocationHistoryCommandEdge as commandEdge,
  relocationHistoryCompletionEdge as completionEdge, relocationHistoryIntersection as intersection,
  type RelocationHistoryEdge as Edge, type RelocationHistoryInterval as Interval } from './history-order';

export interface RelocationOwnerSpatialFailure {
  readonly ok: false;
  readonly issues: readonly ConstructionValidationIssue[];
}
export interface RelocationOwnerSoftTarget extends SectPlacementRequest {
  readonly jobId: string;
  readonly buildingId: string;
  readonly sourceJobId: string;
  readonly footprint: SectFootprint;
}
/** Certifies bounded historical occupancy and static geometry plus the current
 * physical layout/connectivity ONLY. Historical routes/people and intermediate
 * same-tick connectivity need shared command-order evidence absent here. An ok
 * result is never full historical/World, lifecycle, research or capacity admission. */
export type RelocationOwnerSpatialInspection =
  | { readonly ok: true; readonly scope: 'relocation-spatial-records' }
  | RelocationOwnerSpatialFailure;

interface Claim extends Interval {
  readonly id: string;
  readonly source: string;
  readonly placement: SectPlacementRequest;
  readonly footprint: SectFootprint;
}
interface CapturedSpatial {
  readonly ok: true;
  readonly frame: SectRelocationRecordFrame;
  readonly context: SectSpatialContext;
  readonly softTargets: readonly RelocationOwnerSoftTarget[];
  readonly walkable: ReadonlySet<string>;
}
const key = (cell: SectCell): string => `${cell.x},${cell.y}`;
const placement = (p: SectPlacementRequest): SectPlacementRequest => ({ definitionId: p.definitionId, anchor: { ...p.anchor }, rotation: p.rotation });
const failure = (code: string, path = 'spatial'): RelocationOwnerSpatialFailure => ({ ok: false, issues: [{ code, path }] });
function baseContext(frame: ConstructionFrame): SectSpatialContext {
  return { map: frame.map, legacyStations: frame.legacyStations, people: [],
    spaces: frame.legacyStations.map(s => ({ kind: 'legacy-point', buildingId: s.id })), blueprints: [] };
}
function currentContext(frame: SectRelocationRecordFrame): SectSpatialContext {
  const source = frame.construction;
  return { ...baseContext(source),
    people: source.people.map(p => ({ id: p.id, position: p.position, lifeState: p.lifeState, traveling: p.away })),
    spaces: [...source.legacyStations.map(s => ({ kind: 'legacy-point' as const, buildingId: s.id })),
      ...source.buildings.map(b => ({ kind: 'placed' as const, buildingId: b.buildingId, level: b.level,
        ...placement(frame.relocation.jobs.filter(j => j.buildingId === b.buildingId && j.terminal?.kind === 'completed').at(-1)?.to ?? b) })),
      ...source.jobs.filter(j => j.terminal === null).map(j => ({ kind: 'placed' as const, buildingId: j.resultBuildingId,
        level: 1 as const, ...placement(source.blueprints.find(b => b.blueprintId === j.blueprintId)!) }))],
    blueprints: source.blueprints.filter(b => b.status === 'planned').map(b => ({ blueprintId: b.blueprintId, ...placement(b) })) };
}
function receipt(frame: ConstructionFrame, bp: ConstructionBlueprint, kind: 'blueprint.place' | 'construction.start' | 'construction.cancel') {
  return frame.receipts.find(r => r.command.kind === kind && r.relatedId === (kind === 'construction.start' ? bp.jobId : bp.blueprintId))!;
}
/** Re-authenticate fixed records on every call. No external validated flag/token,
 * callback, root brand or old-World coercion is accepted. The copied data is kept
 * private to this invocation and never handed back as an admission capability. */
function inspect(input: unknown): CapturedSpatial | RelocationOwnerSpatialFailure {
  try { return inspectRecords(input); }
  catch { return failure('INVALID_SPATIAL_RECORDS'); }
}
function inspectRecords(input: unknown): CapturedSpatial | RelocationOwnerSpatialFailure {
  const provenance = inspectRelocationProvenanceForOwner(input);
  if (provenance.length) return { ok: false, issues: cloneJson(provenance) };
  const frame = cloneJson(input as SectRelocationRecordFrame);
  const source = frame.construction;
  const claims: Claim[] = [];
  const commandChronology: Edge[] = [];
  const add = (id: string, owner: string, p: SectPlacementRequest, start: Edge, end: Edge | null): RelocationOwnerSpatialFailure | null => {
    if (end !== null && (compare(start, end) ?? 1) >= 0) return failure('INVALID_SPATIAL_CHRONOLOGY', id);
    const geometry = deriveSectFootprint(placement(p));
    if (!geometry.ok) return failure('INVALID_GEOMETRY', id);
    const claim: Claim = { id, source: owner, placement: placement(p), footprint: geometry.footprint, start, end };
    claims.push(claim);
    return null;
  };
  for (const bp of source.blueprints) {
    const placed = commandEdge(bp.placedTick, 'construction', receipt(source, bp, 'blueprint.place').revision);
    commandChronology.push(placed);
    const job = bp.jobId === null ? null : source.jobs.find(j => j.jobId === bp.jobId)!;
    const started = job === null ? null : commandEdge(job.startedTick, 'construction', receipt(source, bp, 'construction.start').revision);
    if (started) {
      commandChronology.push(started);
      if (compare(placed, started)! >= 0) return failure('INVALID_SPATIAL_CHRONOLOGY', bp.blueprintId);
    }
    let end: Edge | null = null;
    if (bp.status === 'cancelled') {
      end = commandEdge(bp.endedTick!, 'construction', receipt(source, bp, 'construction.cancel').revision);
      commandChronology.push(end);
    } else if (bp.status === 'completed') end = completionEdge(bp.endedTick!, 'construction');
    const owner = job?.jobId ?? bp.blueprintId;
    // The exclusive construction claim starts at placement. It remains continuous
    // through hard construction and transfers to the building at completion.
    let issue = add(bp.blueprintId, owner, bp, placed, end);
    if (issue) return issue;
    if (started) {
      issue = add(job!.jobId, owner, bp, started, end);
      if (issue) return issue;
    }
  }
  commandChronology.sort((a, b) => a.revision - b.revision);
  if (commandChronology.some((edge, index) => index > 0 && edge.tick < commandChronology[index - 1]!.tick))
    return failure('INVALID_SPATIAL_CHRONOLOGY', 'construction.receipts');
  for (const building of source.buildings) {
    let from = placement(building); let start = completionEdge(building.completedTick, 'construction');
    for (const job of frame.relocation.jobs.filter(j => j.buildingId === building.buildingId && j.terminal?.kind === 'completed')) {
      const end = completionEdge(job.terminal!.tick, 'relocation', job.terminal!.revision);
      const issue = add(building.buildingId, building.sourceJobId, from, start, end);
      if (issue) return issue;
      from = placement(job.to); start = end;
    }
    const issue = add(building.buildingId, building.sourceJobId, from, start, null);
    if (issue) return issue;
  }
  const relocationChronology: Edge[] = [];
  for (const job of frame.relocation.jobs) {
    const revision = frame.relocation.receipts.find(r => r.jobId === job.jobId && r.command.kind === 'relocation.start')!.revision;
    const start = commandEdge(job.startedTick, 'relocation', revision);
    const end = job.terminal === null ? null : job.terminal.kind === 'completed'
      ? completionEdge(job.terminal.tick, 'relocation', job.terminal.revision)
      : commandEdge(job.terminal.tick, 'relocation', job.terminal.revision);
    relocationChronology.push(start); if (end) relocationChronology.push(end);
    const issue = add(job.jobId, job.sourceJobId, job.to, start, end);
    if (issue) return issue;
  }
  // A domain's real journal order must also agree with the fixed tick phases.
  // Provenance's nondecreasing tick check alone permits a same-tick command
  // with a lower revision than a completion. Neither order may override the
  // other: that history is inconsistent, not evidence of vacated ground.
  relocationChronology.sort((a, b) => a.revision - b.revision);
  if (relocationChronology.some((edge, index) => index > 0 && compare(relocationChronology[index - 1]!, edge)! >= 0))
    return failure('INVALID_SPATIAL_CHRONOLOGY', 'relocation.revisions');
  // Reuse the existing static terrain/road/legacy rules for EVERY historical
  // footprint and entrance, including cancelled blueprints and ended targets.
  // One soft claim per call avoids the live-blueprint limit and never invents
  // a hard target or historical person position. Terrain is assumed unchanged.
  const base = baseContext(source);
  for (const claim of claims) {
    const result = inspectSectLayout({ ...base, blueprints: [{ blueprintId: claim.id, ...placement(claim.placement) }] });
    if (!result.ok) return { ok: false, issues: result.issues.map(i => ({ code: i.code, path: `${claim.id}:${i.subjectId}` })) };
  }
  // Finite interval-event scan, independent of elapsed tick values. Each cell's
  // bucket joins at most the bounded record count; no per-tick history replay.
  // The same immutable source alone may overlap itself (handoff/self-move).
  const cells = new Map<string, Claim[]>();
  for (const claim of claims) for (const cell of [...claim.footprint.cells, claim.footprint.entrance]) {
    const bucket = cells.get(key(cell)) ?? [];
    for (const other of bucket) {
      if (other.source === claim.source) continue;
      const overlap = intersection(other, claim);
      if (overlap !== 'none') return failure(overlap === 'ambiguous' ? 'AMBIGUOUS_SPATIAL_BOUNDARY' : 'HISTORICAL_SPATIAL_CONFLICT', `${other.id}:${claim.id}@${key(cell)}`);
    }
    bucket.push(claim); cells.set(key(cell), bucket);
  }
  // Current physical context includes started construction, never completed
  // blueprint origins. Waiting targets remain soft, so a person may stand there.
  const context = currentContext(frame); const layout = inspectSectLayout(context);
  if (!layout.ok) return { ok: false, issues: layout.issues.map(i => ({ code: i.code, path: i.subjectId })) };
  const softTargets = frame.relocation.jobs.filter(j => j.terminal === null).map(j => {
    const geometry = deriveSectFootprint(j.to);
    if (!geometry.ok) throw new Error('Authenticated relocation geometry was lost');
    return { jobId: j.jobId, buildingId: j.buildingId, sourceJobId: j.sourceJobId, ...placement(j.to), footprint: geometry.footprint };
  });
  return { ok: true, frame, context, softTargets, walkable: new Set(layout.layout.walkableCells.map(key)) };
}

export function inspectRelocationOwnerSpatialRecords(input: unknown): RelocationOwnerSpatialInspection {
  const result = inspect(input);
  return result.ok ? { ok: true, scope: 'relocation-spatial-records' } : result;
}
function validBoundary(boundary: RelocationOwnerBoundary, now: number): boolean {
  try {
    return ownSectFields(boundary, ['tick', 'phase', 'side']) && Number.isSafeInteger(boundary.tick)
      && boundary.tick >= 0 && boundary.tick <= now && RELOCATION_OWNER_PHASES.includes(boundary.phase)
      && ['before', 'after'].includes(boundary.side);
  } catch { return false; }
}
/** Historical placement under the fixed construction -> relocation phase order.
 * A valid query before construction completion returns placement:null. */
export function relocationOwnerPlacementAt(input: unknown, buildingId: string, boundary: RelocationOwnerBoundary):
  | { readonly ok: true; readonly placement: SectHistoricalPlacement | null } | RelocationOwnerSpatialFailure {
  const result = inspect(input); if (!result.ok) return result;
  if (typeof buildingId !== 'string' || !validBoundary(boundary, result.frame.construction.lastSimulationTick)) return failure('INVALID_SPATIAL_BOUNDARY');
  const original = result.frame.construction.buildings.find(b => b.buildingId === buildingId);
  if (!original) return failure('UNKNOWN_BUILDING', buildingId);
  const passed = (tick: number, phase: 'construction' | 'relocation'): boolean => tick < boundary.tick || tick === boundary.tick
    && (RELOCATION_OWNER_PHASES.indexOf(phase) < RELOCATION_OWNER_PHASES.indexOf(boundary.phase) || phase === boundary.phase && boundary.side === 'after');
  if (!passed(original.completedTick, 'construction')) return { ok: true, placement: null };
  const moved = result.frame.relocation.jobs.filter(j => j.buildingId === buildingId && j.terminal?.kind === 'completed' && passed(j.terminal.tick, 'relocation')).at(-1);
  return { ok: true, placement: cloneJson({ buildingId, sourceJobId: original.sourceJobId, relocationJobId: moved?.jobId ?? null,
    ...placement(moved?.to ?? original), firstMaintenanceCalendarTick: original.firstMaintenanceCalendarTick }) };
}
export function relocationOwnerCurrentSpatialContext(input: unknown):
  | { readonly ok: true; readonly context: SectSpatialContext; readonly softTargets: readonly RelocationOwnerSoftTarget[] } | RelocationOwnerSpatialFailure {
  const result = inspect(input);
  return result.ok ? { ok: true, context: cloneJson(result.context), softTargets: cloneJson(result.softTargets) } : result;
}
export function relocationOwnerEffectiveMap(input: unknown): { readonly ok: true; readonly map: WorldMap } | RelocationOwnerSpatialFailure {
  const result = inspect(input);
  return result.ok ? { ok: true, map: { ...cloneJson(result.frame.construction.map), tiles: result.frame.construction.map.tiles.map(tile => ({ ...tile, walkable: result.walkable.has(key(tile)) })) } } : result;
}
