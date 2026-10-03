import type { SectCell } from '../../content/sect-v9/types';
import type { WorldMap } from '../world/types';
import type { ConstructionClaim } from './construction-types';
import { deriveSectFootprint } from './layout';
import { assessSectPlacement, inspectSectLayout } from './queries';
import type { SectRelocationRecordFrame } from './relocation-types';
import { validateSectRelocationRecords } from './relocation-validation';
import type { SectPlacementRequest, SectSpatialContext } from './types';

const key = (cell: SectCell): string => `${cell.x},${cell.y}`;
const placement = (p: SectPlacementRequest): SectPlacementRequest => ({ definitionId: p.definitionId, anchor: { ...p.anchor }, rotation: p.rotation });
function spatial(frame: SectRelocationRecordFrame, omitBuildingId?: string, omitPersonId?: string): SectSpatialContext {
  const source = frame.construction;
  return { map: source.map, legacyStations: source.legacyStations,
    people: source.people.filter(p => p.id !== omitPersonId).map(p => ({ id: p.id, position: p.position, lifeState: p.lifeState, traveling: p.away })),
    spaces: [...source.legacyStations.map(s => ({ kind: 'legacy-point' as const, buildingId: s.id })),
      ...source.buildings.filter(b => b.buildingId !== omitBuildingId).map(b => ({ kind: 'placed' as const, buildingId: b.buildingId,
        level: b.level, ...placement(frame.relocation.jobs.filter(j => j.buildingId === b.buildingId && j.terminal?.kind === 'completed').at(-1)?.to ?? b) })),
      ...source.jobs.filter(j => !j.terminal).map(j => ({ kind: 'placed' as const, buildingId: j.resultBuildingId, level: 1 as const,
        ...placement(source.blueprints.find(b => b.blueprintId === j.blueprintId)!) }))],
    blueprints: source.blueprints.filter(b => b.status === 'planned').map(b => ({ blueprintId: b.blueprintId, ...placement(b) })) };
}
/** Record-authenticated current physical grid. Soft relocation targets never block walking. */
export function sectRelocationEffectiveMap(input: unknown): WorldMap | null {
  if (validateSectRelocationRecords(input).length) return null;
  const frame = input as SectRelocationRecordFrame; const context = spatial(frame);
  const occupied = new Set(context.spaces.flatMap(s => {
    if (s.kind !== 'placed') return [];
    const geometry = deriveSectFootprint(placement(s)); return geometry.ok ? geometry.footprint.cells.map(key) : [];
  }));
  return { ...frame.construction.map, tiles: frame.construction.map.tiles.map(tile => ({ ...tile,
    walkable: tile.walkable && tile.terrain !== 'water' && !occupied.has(key(tile)) })) };
}
/** Fixed final replacement check, including people, home connectivity and every other soft
 * target. The moving building alone is omitted; overlapping its old footprint is legal. */
export function sectRelocationTargetAvailable(input: unknown, buildingId: string, target: SectPlacementRequest, workerId?: string): boolean {
  if (validateSectRelocationRecords(input).length) return false;
  const frame = input as SectRelocationRecordFrame;
  if (!frame.construction.buildings.some(b => b.buildingId === buildingId && b.definitionId === target.definitionId)) return false;
  if (!assessSectPlacement(spatial(frame, buildingId, workerId), target).ok) return false;
  const geometry = deriveSectFootprint(target); if (!geometry.ok) return false;
  const reserved = new Set([...geometry.footprint.cells, geometry.footprint.entrance].map(key));
  return frame.relocation.jobs.filter(j => !j.terminal && j.buildingId !== buildingId).every(j => {
    const other = deriveSectFootprint(j.to);
    return other.ok && [...other.footprint.cells, other.footprint.entrance].every(c => !reserved.has(key(c)));
  });
}
export function sectRelocationLayoutValid(input: unknown): boolean {
  return validateSectRelocationRecords(input).length === 0 && inspectSectLayout(spatial(input as SectRelocationRecordFrame)).ok;
}
/** Local owner claims must be composed with every other work domain by a future adapter. */
export function sectRelocationClaims(input: unknown): readonly ConstructionClaim[] | null {
  if (validateSectRelocationRecords(input).length) return null;
  return (input as SectRelocationRecordFrame).relocation.jobs.filter(j => !j.terminal).flatMap(j => {
    const old = deriveSectFootprint(j.from); const target = deriveSectFootprint(j.to);
    if (!old.ok || !target.ok) return [];
    return [{ kind: 'worker' as const, key: j.workerId, ownerId: j.jobId }, { kind: 'seat' as const, key: j.buildingId, ownerId: j.jobId },
      ...Array.from(new Set([key(old.footprint.entrance), key(target.footprint.entrance)])).map(entrance => ({ kind: 'entrance' as const, key: entrance, ownerId: j.jobId }))];
  });
}
export function sectBuildingAvailableDuringRelocation(input: unknown, buildingId: string): boolean {
  if (validateSectRelocationRecords(input).length) return false;
  const frame = input as SectRelocationRecordFrame;
  return frame.construction.buildings.some(b => b.buildingId === buildingId)
    && !frame.relocation.jobs.some(j => j.buildingId === buildingId && !j.terminal);
}
