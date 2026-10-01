import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import { SECT_LIMITS, type SectCell } from '../../content/sect-v9/types';
import { CARDINAL_DIRECTIONS } from '../agents/navigation';
import { deriveSectFootprint, ownSectFields } from './layout';
import { LEGACY_SECT_STATION_IDS, type SectFootprint, type SectHomeAnchor, type SectLayoutResult, type SectLayoutView,
  type SectPlacementRequest, type SectPlacementResult, type SectSpatialContext, type SectSpatialIssue } from './types';

interface Entry { readonly id: string; readonly footprint: SectFootprint; readonly legacy: boolean }
const key = (cell: SectCell) => `${cell.x},${cell.y}`;
const position = (cell: SectCell): SectCell => ({ x: cell.x, y: cell.y });
const idValid = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128;
const cellValid = (cell: unknown): cell is SectCell => ownSectFields(cell, ['x', 'y']) && Number.isSafeInteger(cell.x) && Number.isSafeInteger(cell.y);
function denseArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}
const compareEntries = (a: { readonly id: string }, b: { readonly id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function validContextShape(context: SectSpatialContext): readonly SectSpatialIssue[] {
  const fail = (code: SectSpatialIssue['code']): readonly SectSpatialIssue[] => [{ code, subjectId: 'context' }];
  if (!ownSectFields(context, ['map', 'legacyStations', 'people', 'spaces', 'blueprints']) || !ownSectFields(context.map, ['width', 'height', 'tiles'], false)) return fail('INVALID_MAP');
  const map = context.map;
  if (!Number.isSafeInteger(map.width) || !Number.isSafeInteger(map.height) || map.width < 1 || map.height < 1 || map.width > 256 || map.height > 256
    || !denseArray(map.tiles, 256 * 256) || map.tiles.length !== map.width * map.height) return fail('INVALID_MAP');
  const inMap = (cell: SectCell) => cell.x >= 0 && cell.y >= 0 && cell.x < map.width && cell.y < map.height;
  const tileKeys = new Set<string>();
  for (const tile of map.tiles) {
    if (!ownSectFields(tile, ['x', 'y', 'terrain', 'walkable']) || !Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y)
      || !inMap(tile) || !['grass', 'path', 'forest', 'stone', 'water'].includes(tile.terrain) || typeof tile.walkable !== 'boolean' || tileKeys.has(key(tile))) return fail('INVALID_MAP');
    tileKeys.add(key(tile));
  }
  if (!denseArray(context.people, SECT_LIMITS.activeJobs)) return fail('INVALID_PEOPLE');
  const peopleIds = new Set<string>();
  for (const person of context.people) {
    if (!ownSectFields(person, ['id', 'position', 'lifeState', 'traveling'], false) || !idValid(person.id) || peopleIds.has(person.id)
      || !cellValid(person.position) || !inMap(person.position) || !['alive', 'pendingDeath', 'dead'].includes(person.lifeState) || typeof person.traveling !== 'boolean') return fail('INVALID_PEOPLE');
    peopleIds.add(person.id);
  }
  if (!denseArray(context.legacyStations, LEGACY_SECT_STATION_IDS.length) || context.legacyStations.length !== LEGACY_SECT_STATION_IDS.length) return fail('INVALID_LEGACY_STATIONS');
  const legacyIds = new Set<string>(); const legacyKinds = new Set<string>();
  for (const station of context.legacyStations) {
    if (!ownSectFields(station, ['id', 'blueprintId', 'x', 'y'], false) || !idValid(station.id) || legacyIds.has(station.id) || peopleIds.has(station.id)
      || !LEGACY_SECT_STATION_IDS.some(id => id === station.blueprintId) || legacyKinds.has(station.blueprintId)
      || !Number.isSafeInteger(station.x) || !Number.isSafeInteger(station.y) || !inMap(station)) return fail('INVALID_LEGACY_STATIONS');
    legacyIds.add(station.id); legacyKinds.add(station.blueprintId);
  }
  if (!denseArray(context.spaces, SECT_LIMITS.buildings)) return fail('INVALID_SPACES');
  const spaceIds = new Set<string>(); const mappedLegacy = new Set<string>();
  for (const space of context.spaces) {
    if (!ownSectFields(space, ['kind', 'buildingId'], false) || !idValid(space.buildingId) || spaceIds.has(space.buildingId) || peopleIds.has(space.buildingId)) return fail('INVALID_SPACES');
    spaceIds.add(space.buildingId);
    if (space.kind === 'legacy-point') {
      if (!ownSectFields(space, ['kind', 'buildingId']) || !legacyIds.has(space.buildingId)) return fail('INVALID_SPACES');
      mappedLegacy.add(space.buildingId);
    } else if (space.kind === 'placed') {
      if (!ownSectFields(space, ['kind', 'buildingId', 'definitionId', 'anchor', 'rotation', 'level']) || legacyIds.has(space.buildingId)) return fail('INVALID_SPACES');
      const definition = getSectBuildingDefinition(space.definitionId);
      if (!definition?.levels.some(level => level.level === space.level) || !deriveSectFootprint({ definitionId: space.definitionId, anchor: space.anchor, rotation: space.rotation }).ok) return fail('INVALID_SPACES');
    } else return fail('INVALID_SPACES');
  }
  if (mappedLegacy.size !== legacyIds.size) return fail('INVALID_SPACES');
  if (!denseArray(context.blueprints, SECT_LIMITS.blueprints)) return fail('INVALID_BLUEPRINTS');
  const blueprintIds = new Set<string>();
  for (const blueprint of context.blueprints) {
    if (!ownSectFields(blueprint, ['blueprintId', 'definitionId', 'anchor', 'rotation']) || !idValid(blueprint.blueprintId)
      || blueprintIds.has(blueprint.blueprintId) || spaceIds.has(blueprint.blueprintId) || peopleIds.has(blueprint.blueprintId)
      || !deriveSectFootprint({ definitionId: blueprint.definitionId, anchor: blueprint.anchor, rotation: blueprint.rotation }).ok) return fail('INVALID_BLUEPRINTS');
    blueprintIds.add(blueprint.blueprintId);
  }
  return [];
}

function entries(context: SectSpatialContext): { hard: Entry[]; soft: Entry[] } {
  const hard: Entry[] = context.spaces.map(space => {
    if (space.kind === 'legacy-point') {
      const station = context.legacyStations.find(entry => entry.id === space.buildingId)!;
      return { id: space.buildingId, footprint: { cells: [], entrance: position(station) }, legacy: true };
    }
    const result = deriveSectFootprint({ definitionId: space.definitionId, anchor: space.anchor, rotation: space.rotation });
    if (!result.ok) throw new Error('Validated geometry was lost');
    return { id: space.buildingId, footprint: result.footprint, legacy: false };
  }).sort(compareEntries);
  const soft: Entry[] = context.blueprints.map(blueprint => {
    const result = deriveSectFootprint({ definitionId: blueprint.definitionId, anchor: blueprint.anchor, rotation: blueprint.rotation });
    if (!result.ok) throw new Error('Validated blueprint geometry was lost');
    return { id: blueprint.blueprintId, footprint: result.footprint, legacy: false };
  }).sort(compareEntries);
  return { hard, soft };
}

function terrainIssues(context: SectSpatialContext, entry: Entry): SectSpatialIssue[] {
  const tiles = new Map(context.map.tiles.map(tile => [key(tile), tile]));
  const issues: SectSpatialIssue[] = [];
  for (const cell of [...entry.footprint.cells, entry.footprint.entrance]) {
    const tile = tiles.get(key(cell));
    const occupied = entry.footprint.cells.some(candidate => key(candidate) === key(cell));
    if (!tile) issues.push({ code: 'OUT_OF_BOUNDS', subjectId: entry.id, position: position(cell) });
    else if (!tile.walkable || tile.terrain === 'water') issues.push({ code: 'TERRAIN_BLOCKED', subjectId: entry.id, position: position(cell) });
    else if (occupied && tile.terrain === 'path') issues.push({ code: 'ROAD_OCCUPIED', subjectId: entry.id, position: position(cell) });
  }
  return issues;
}
function overlaps(left: Entry, right: Entry, soft = false): SectSpatialIssue[] {
  const occupied = new Set(right.footprint.cells.map(key)); const entrance = key(right.footprint.entrance);
  const issues: SectSpatialIssue[] = [];
  for (const cell of left.footprint.cells) {
    if (occupied.has(key(cell)) || entrance === key(cell)) issues.push({
      code: soft ? 'BLUEPRINT_OVERLAP' : right.legacy ? 'LEGACY_STATION_OCCUPIED' : entrance === key(cell) ? 'ENTRANCE_OVERLAP' : 'FOOTPRINT_OVERLAP',
      subjectId: right.id, position: position(cell),
    });
  }
  if (occupied.has(key(left.footprint.entrance)) || entrance === key(left.footprint.entrance)) issues.push({ code: soft ? 'BLUEPRINT_OVERLAP' : 'ENTRANCE_OVERLAP', subjectId: right.id, position: position(left.footprint.entrance) });
  return issues;
}
function homePeople(context: SectSpatialContext) { return context.people.filter(person => !person.traveling && person.lifeState !== 'dead').slice().sort(compareEntries); }
function personIssues(context: SectSpatialContext, entry: Entry, includeEntrance: boolean): SectSpatialIssue[] {
  const cells = new Set(entry.footprint.cells.map(key));
  if (includeEntrance) cells.add(key(entry.footprint.entrance));
  return homePeople(context).filter(person => cells.has(key(person.position))).map(person => ({ code: 'PERSON_OCCUPIED', subjectId: person.id, position: position(person.position) }));
}
function view(context: SectSpatialContext, hard: readonly Entry[]): SectLayoutView {
  const occupiedCells = hard.flatMap(entry => entry.footprint.cells.map(position)).sort((a, b) => a.y - b.y || a.x - b.x);
  const occupied = new Set(occupiedCells.map(key));
  const requiredHomeAnchors: SectHomeAnchor[] = hard.map(entry => ({ kind: entry.legacy ? 'legacy-station' : 'placed-entrance', id: entry.id, position: position(entry.footprint.entrance) }));
  requiredHomeAnchors.push(...homePeople(context).map(person => ({ kind: 'home-person' as const, id: person.id, position: position(person.position) })));
  return {
    occupiedCells,
    entrances: hard.map(entry => ({ buildingId: entry.id, position: position(entry.footprint.entrance) })),
    requiredHomeAnchors,
    walkableCells: context.map.tiles.filter(tile => tile.walkable && tile.terrain !== 'water' && !occupied.has(key(tile))).map(position).sort((a, b) => a.y - b.y || a.x - b.x),
  };
}
function connectivityIssues(layout: SectLayoutView): SectSpatialIssue[] {
  const allowed = new Set(layout.walkableCells.map(key));
  const origin = layout.requiredHomeAnchors.find(anchor => anchor.kind === 'legacy-station')!.position;
  const reached = new Set<string>(); const queue: SectCell[] = [];
  if (allowed.has(key(origin))) { reached.add(key(origin)); queue.push(origin); }
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head]!;
    for (const direction of CARDINAL_DIRECTIONS) {
      const next = { x: cell.x + direction.x, y: cell.y + direction.y }; const nextKey = key(next);
      if (!allowed.has(nextKey) || reached.has(nextKey)) continue;
      reached.add(nextKey); queue.push(next);
    }
  }
  return layout.requiredHomeAnchors.filter(anchor => !reached.has(key(anchor.position))).map(anchor => ({ code: 'CONNECTIVITY_BLOCKED', subjectId: anchor.id, position: position(anchor.position) }));
}

/** Validates authoritative point mappings and derived geometry before exposing an effective grid. */
export function inspectSectLayout(context: SectSpatialContext): SectLayoutResult {
  const shapeIssues = validContextShape(context);
  if (shapeIssues.length) return { ok: false, issues: shapeIssues };
  const { hard, soft } = entries(context); const issues: SectSpatialIssue[] = [];
  hard.forEach((entry, index) => {
    issues.push(...terrainIssues(context, entry), ...personIssues(context, entry, false));
    for (const other of hard.slice(0, index)) issues.push(...overlaps(entry, other));
  });
  soft.forEach((entry, index) => {
    issues.push(...terrainIssues(context, entry));
    for (const other of [...hard, ...soft.slice(0, index)]) issues.push(...overlaps(entry, other, true));
  });
  if (issues.length) return { ok: false, issues };
  const layout = view(context, hard);
  issues.push(...connectivityIssues(layout));
  return issues.length ? { ok: false, issues } : { ok: true, layout };
}

/** Pure prediction only. Admission/commit must call again against the then-current World view. */
export function assessSectPlacement(context: SectSpatialContext, request: SectPlacementRequest): SectPlacementResult {
  const geometry = deriveSectFootprint(request);
  if (!geometry.ok) return geometry;
  const existing = inspectSectLayout(context);
  if (!existing.ok) return existing;
  if (context.spaces.length >= SECT_LIMITS.buildings) return { ok: false, issues: [{ code: 'INVALID_SPACES', subjectId: 'building-limit' }] };
  const candidate: Entry = { id: 'candidate-placement', footprint: geometry.footprint, legacy: false };
  const { hard, soft } = entries(context);
  const issues = [...terrainIssues(context, candidate), ...personIssues(context, candidate, true)];
  for (const other of hard) issues.push(...overlaps(candidate, other));
  for (const other of soft) issues.push(...overlaps(candidate, other, true));
  if (issues.length) return { ok: false, issues };
  const layout = view(context, [...hard, candidate]);
  issues.push(...connectivityIssues(layout));
  return issues.length ? { ok: false, issues } : { ok: true, footprint: geometry.footprint, layout };
}
