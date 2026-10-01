import { describe, expect, it } from 'vitest';
import { deriveSectFootprint } from '../../src/core/sect-expansion/layout';
import { assessSectPlacement, inspectSectLayout } from '../../src/core/sect-expansion/queries';
import { SECT_ROTATIONS, type SectPlacementRequest, type SectPlacementResult, type SectSpatialContext } from '../../src/core/sect-expansion/types';
import { createWorld } from '../../src/core/world/create-world';
import type { WorldTile } from '../../src/core/world/types';

function initial(): SectSpatialContext {
  const world = createWorld('sect-v9-real-layout');
  return { map: world.map, legacyStations: world.buildings, people: world.disciples,
    spaces: world.buildings.map(building => ({ kind: 'legacy-point', buildingId: building.id })), blueprints: [] };
}
const request = (x = 1, y = 1, rotation: SectPlacementRequest['rotation'] = 0): SectPlacementRequest => ({ definitionId: 'library.v9', anchor: { x, y }, rotation });
const issueCodes = (result: SectPlacementResult) => !result.ok && 'issues' in result ? result.issues.map(issue => issue.code) : [];
function withTile(context: SectSpatialContext, x: number, y: number, patch: Partial<Pick<WorldTile, 'terrain' | 'walkable'>>): SectSpatialContext {
  return { ...context, map: { ...context.map, tiles: context.map.tiles.map(tile => tile.x === x && tile.y === y ? { ...tile, ...patch } : tile) } };
}
function placed(context: SectSpatialContext, placement: SectPlacementRequest, buildingId = 'entity:new-library'): SectSpatialContext {
  return { ...context, spaces: [...context.spaces, { kind: 'placed', buildingId, ...placement, level: 1 }] };
}

describe('derived candidate geometry on the real starter map', () => {
  it.each([
    [0, { x: 9, y: 3 }], [90, { x: 8, y: 1 }], [180, { x: 10, y: 0 }], [270, { x: 11, y: 2 }],
  ] as const)('rotates a fixed 2×2 footprint %s degrees and derives an outside entrance', (rotation, entrance) => {
    const result = deriveSectFootprint(request(9, 1, rotation));
    expect(result).toEqual({ ok: true, footprint: { cells: [{ x: 9, y: 1 }, { x: 10, y: 1 }, { x: 9, y: 2 }, { x: 10, y: 2 }], entrance } });
    expect(assessSectPlacement(initial(), request(9, 1, rotation)).ok).toBe(true);
  });
  it('preserves all eight legacy points, road tiles and home people without retroactive footprints', () => {
    const context = initial(); const result = inspectSectLayout(context);
    expect(context.map).toMatchObject({ width: 14, height: 10 }); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected initial layout');
    expect(result.layout.occupiedCells).toEqual([]);
    expect(result.layout.walkableCells).toHaveLength(140);
    expect(result.layout.entrances).toHaveLength(8);
    expect(result.layout.requiredHomeAnchors.filter(anchor => anchor.kind === 'legacy-station')).toHaveLength(8);
    expect(result.layout.requiredHomeAnchors.filter(anchor => anchor.kind === 'home-person')).toHaveLength(4);
    for (const station of context.legacyStations) {
      expect(result.layout.walkableCells).toContainEqual({ x: station.x, y: station.y });
      expect(result.layout.entrances).toContainEqual({ buildingId: station.id, position: { x: station.x, y: station.y } });
    }
  });
  it('fits both distinct candidate buildings in the actual 14×10 map without editing base terrain', () => {
    const context = initial(); const before = JSON.stringify(context);
    const library = request(1, 1, 0);
    const alchemy: SectPlacementRequest = { definitionId: 'alchemy.v9', anchor: { x: 9, y: 1 }, rotation: 90 };
    expect(assessSectPlacement(context, library).ok).toBe(true);
    const first = placed(context, library);
    const second = assessSectPlacement(first, alchemy);
    expect(second.ok).toBe(true);
    const both = placed(first, alchemy, 'entity:new-alchemy');
    const layout = inspectSectLayout(both);
    expect(layout.ok).toBe(true);
    if (!layout.ok) throw new Error('Expected two-site layout');
    expect(layout.layout.occupiedCells).toHaveLength(8);
    expect(layout.layout.walkableCells).toHaveLength(132);
    expect(layout.layout.requiredHomeAnchors).toHaveLength(14);
    expect(JSON.stringify(context)).toBe(before);
    expect(both.map).toBe(context.map);
    // Geometry evidence only: no research completion, construction transaction or v9 World is fabricated.
  });
  it('permits a clear entrance on a road while forbidding road occupancy', () => {
    const context = initial();
    expect(assessSectPlacement(context, request(0, 3)).ok).toBe(true);
    expect(issueCodes(assessSectPlacement(context, request(6, 1)))).toContain('ROAD_OCCUPIED');
    expect(issueCodes(assessSectPlacement(context, request(1, 4)))).toContain('ROAD_OCCUPIED');
  });
  it.each([-90, 45, 360, 450, NaN, Infinity, '90', null])('rejects unrecognized rotation %s rather than normalizing it', rotation => {
    expect(deriveSectFootprint({ ...request(), rotation })).toEqual({ ok: false, code: 'INVALID_ROTATION' });
  });
  it('rejects fractional/overflow anchors, water, non-walkable terrain and both footprint/door map edges', () => {
    for (const anchor of [{ x: 0.5, y: 1 }, { x: -1, y: 1 }, { x: Number.MAX_SAFE_INTEGER, y: 1 }]) expect(deriveSectFootprint({ ...request(), anchor })).toEqual({ ok: false, code: 'INVALID_ANCHOR' });
    const context = initial();
    expect(issueCodes(assessSectPlacement(context, request(13, 1)))).toContain('OUT_OF_BOUNDS');
    expect(issueCodes(assessSectPlacement(context, request(1, 0, 180)))).toContain('OUT_OF_BOUNDS');
    expect(issueCodes(assessSectPlacement(withTile(context, 1, 1, { terrain: 'water', walkable: true }), request()))).toContain('TERRAIN_BLOCKED');
    expect(issueCodes(assessSectPlacement(withTile(context, 1, 3, { walkable: false }), request()))).toContain('TERRAIN_BLOCKED');
  });
  it.each(['alive', 'pendingDeath'] as const)('protects the current cell of a %s home person, including a doorway', lifeState => {
    const context = initial();
    for (const position of [{ x: 1, y: 1 }, { x: 1, y: 3 }]) {
      const people = context.people.map((person, index) => index === 0 ? { ...person, lifeState, position } : person);
      expect(issueCodes(assessSectPlacement({ ...context, people }, request()))).toContain('PERSON_OCCUPIED');
    }
  });
  it('does not treat dead people or stale positions of travelers as home collisions', () => {
    const context = initial();
    for (const changes of [{ lifeState: 'dead' as const }, { traveling: true }]) {
      const people = context.people.map((person, index) => index === 0 ? { ...person, ...changes, position: { x: 1, y: 1 } } : person);
      expect(assessSectPlacement({ ...context, people }, request()).ok).toBe(true);
    }
  });
  it('rejects existing footprints, protected legacy points and old/new entrance overlap', () => {
    const context = initial();
    expect(issueCodes(assessSectPlacement(placed(context, request()), request(2, 1)))).toContain('FOOTPRINT_OVERLAP');
    expect(issueCodes(assessSectPlacement(context, request(6, 7)))).toContain('LEGACY_STATION_OCCUPIED');
    // A left-facing door would share the old spirit-vein point, despite a clear 2×2 footprint.
    expect(issueCodes(assessSectPlacement(context, request(8, 0, 90)))).toContain('ENTRANCE_OVERLAP');
    const first = placed(context, request(1, 0));
    // Both doors at (1,2), disjoint footprints, no road/person collision.
    const sharedDoor = assessSectPlacement(first, request(0, 3, 180));
    expect(issueCodes(sharedDoor)).toEqual(['ENTRANCE_OVERLAP']);
    expect(issueCodes(assessSectPlacement(placed(context, request()), request(0, 3, 270)))).toContain('ENTRANCE_OVERLAP');
  });
  it('soft-reserves blueprint footprint and entrance but never removes their walkable cells', () => {
    const context = initial();
    const reserved: SectSpatialContext = { ...context, blueprints: [{ blueprintId: 'blueprint:1', ...request() }] };
    const result = inspectSectLayout(reserved);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected reserved layout');
    expect(result.layout.walkableCells).toHaveLength(140); expect(result.layout.occupiedCells).toEqual([]);
    expect(issueCodes(assessSectPlacement(reserved, request(2, 1)))).toContain('BLUEPRINT_OVERLAP');
    // A person may subsequently walk through a soft claim; start must recheck current people.
    const people = reserved.people.map((person, index) => index === 0 ? { ...person, position: { x: 1, y: 1 } } : person);
    expect(inspectSectLayout({ ...reserved, people }).ok).toBe(true);
    expect(issueCodes(assessSectPlacement({ ...context, people }, request()))).toContain('PERSON_OCCUPIED');
  });
  it('checks every old home anchor and person even when the new doorway itself stays reachable', () => {
    const base = initial();
    // Real starter map with an explicit obstacle-wall fixture and a two-cell gap, not a toy map.
    const context: SectSpatialContext = {
      ...base,
      map: { ...base.map, tiles: base.map.tiles.map(tile => tile.x === 3 && tile.y !== 1 && tile.y !== 2 ? { ...tile, walkable: false } : tile) },
      people: base.people.map((person, index) => index === 0 ? { ...person, position: { x: 0, y: 1 } } : person),
    };
    expect(inspectSectLayout(context).ok).toBe(true);
    const result = assessSectPlacement(context, request(2, 1, 270));
    expect(result.ok).toBe(false);
    if (result.ok || !('issues' in result)) throw new Error('Expected disconnection');
    const forest = context.legacyStations.find(station => station.blueprintId === 'forest')!;
    expect(result.issues).toContainEqual({ code: 'CONNECTIVITY_BLOCKED', subjectId: forest.id, position: { x: 2, y: 5 } });
    expect(result.issues).toContainEqual({ code: 'CONNECTIVITY_BLOCKED', subjectId: context.people[0]!.id, position: { x: 0, y: 1 } });
    expect(result.issues.some(issue => issue.subjectId === 'candidate-placement')).toBe(false);
    expect(issueCodes(result)).not.toContain('ROAD_OCCUPIED');
  });
  it('protects existing placed entrances and rejects a pre-disconnected required station', () => {
    const base = initial();
    const context = placed({ ...base, map: { ...base.map, tiles: base.map.tiles.map(tile => tile.x === 3 && tile.y !== 1 && tile.y !== 2 ? { ...tile, walkable: false } : tile) } }, request(0, 6));
    expect(inspectSectLayout(context).ok).toBe(true);
    const result = assessSectPlacement(context, request(2, 1, 270));
    expect(result.ok).toBe(false);
    if (result.ok || !('issues' in result)) throw new Error('Expected disconnection');
    expect(result.issues.some(issue => issue.code === 'CONNECTIVITY_BLOCKED' && issue.subjectId === 'entity:new-library')).toBe(true);
    const disconnected = { ...base, map: { ...base.map, tiles: base.map.tiles.map(tile => tile.x === 3 ? { ...tile, walkable: false } : tile) } };
    expect(issueCodes(assessSectPlacement(disconnected, request(9, 1)))).toContain('CONNECTIVITY_BLOCKED');
  });
  it('rejects missing anchors, fake legacy buildings and caller-supplied footprint/entrance definitions', () => {
    const context = initial();
    expect(issueCodes(assessSectPlacement({ ...context, legacyStations: context.legacyStations.slice(1) }, request()))).toEqual(['INVALID_LEGACY_STATIONS']);
    expect(issueCodes(assessSectPlacement({ ...context, spaces: context.spaces.slice(1) }, request()))).toEqual(['INVALID_SPACES']);
    expect(issueCodes(assessSectPlacement({ ...context, spaces: [...context.spaces, { kind: 'legacy-point', buildingId: 'entity:new-library' }] }, request()))).toEqual(['INVALID_SPACES']);
    expect(deriveSectFootprint({ ...request(), footprint: { cells: [], entrance: { x: 7, y: 5 } } })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(deriveSectFootprint({ ...request(), definitionId: 'housing' })).toEqual({ ok: false, code: 'UNKNOWN_DEFINITION' });
    const fakePlaced = placed(context, request());
    const spoof = { ...fakePlaced, spaces: fakePlaced.spaces.map(space => space.kind === 'placed' ? { ...space, cells: [] } : space) };
    expect(issueCodes(assessSectPlacement(spoof, request(9, 1)))).toEqual(['INVALID_SPACES']);
    const relabeled = { ...context, spaces: context.spaces.map((space, index) => index === 0 ? { kind: 'placed' as const, buildingId: space.buildingId, ...request(), level: 1 as const } : space) };
    expect(issueCodes(assessSectPlacement(relabeled, request(9, 1)))).toEqual(['INVALID_SPACES']);
  });
  it('rejects unknown levels, bad record rotations, duplicate map cells and oversized soft claims', () => {
    const context = initial();
    for (const changes of [{ level: 2 }, { rotation: 45 }, { definitionId: 'caller.free-house' }]) {
      const original = placed(context, request());
      const bad = { ...original, spaces: original.spaces.map(space => space.kind === 'placed' ? { ...space, ...changes } : space) } as SectSpatialContext;
      expect(issueCodes(assessSectPlacement(bad, request(9, 1)))).toEqual(['INVALID_SPACES']);
    }
    const duplicate = { ...context, map: { ...context.map, tiles: context.map.tiles.map((tile, index) => index === 1 ? { ...context.map.tiles[0]! } : tile) } };
    expect(issueCodes(assessSectPlacement(duplicate, request()))).toEqual(['INVALID_MAP']);
    const tooMany = { ...context, blueprints: Array.from({ length: 17 }, (_, index) => ({ blueprintId: `blueprint:${index}`, ...request() })) };
    expect(issueCodes(assessSectPlacement(tooMany, request(9, 1)))).toEqual(['INVALID_BLUEPRINTS']);
  });
  it('does not execute accessor requests and returns detached deterministic views without a cache', () => {
    let invoked = false;
    const accessor = { ...request(), get rotation() { invoked = true; return 0; } };
    expect(deriveSectFootprint(accessor)).toEqual({ ok: false, code: 'INVALID_REQUEST' }); expect(invoked).toBe(false);
    const context = placed(initial(), request()); const before = JSON.stringify(context);
    const left = inspectSectLayout(context);
    const right = inspectSectLayout({ ...context, spaces: [...context.spaces].reverse(), people: [...context.people].reverse(), legacyStations: [...context.legacyStations].reverse(), map: { ...context.map, tiles: [...context.map.tiles].reverse() } });
    expect(right).toEqual(left); expect(right).not.toBe(left);
    expect(JSON.stringify(context)).toBe(before);
    expect(Object.isFrozen(SECT_ROTATIONS)).toBe(true);
  });
});
