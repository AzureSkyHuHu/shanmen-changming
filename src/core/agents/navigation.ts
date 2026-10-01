import { checkedAdd, isNonNegativeInteger } from '../kernel/numeric';
import type { GridPosition, WorldMap, WorldState } from '../world/types';

/** Fixed, versioned tie order: north, east, south, west. */
export const CARDINAL_DIRECTIONS: readonly GridPosition[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
export const MOVEMENT_TICKS_PER_CELL = 4;
export const MAX_PATH_REQUESTS_PER_TICK = 4;
export const BLOCKED_PATH_RETRY_TICKS = 20;
export interface JobNavigation {
  /** Remaining cells, excluding the worker's current cell. */
  path: GridPosition[];
  target: GridPosition | null;
  routeVersion: number | null;
  movementTicks: number;
  retryAtTick: number;
}
export function emptyNavigation(): JobNavigation { return { path: [], target: null, routeVersion: null, movementTicks: 0, retryAtTick: 0 }; }
export function sameCell(left: GridPosition, right: GridPosition): boolean { return left.x === right.x && left.y === right.y; }
export function isMapCell(map: WorldMap, position: GridPosition): boolean {
  return isNonNegativeInteger(position.x) && isNonNegativeInteger(position.y) && position.x < map.width && position.y < map.height;
}
export function isWalkable(map: WorldMap, position: GridPosition): boolean {
  return isMapCell(map, position) && map.tiles.some((tile) => sameCell(tile, position) && tile.walkable);
}
export function cardinalDistance(left: GridPosition, right: GridPosition): number { return Math.abs(left.x - right.x) + Math.abs(left.y - right.y); }

/** Bounded BFS: each validated map cell is visited at most once; no RNG or hidden cache. */
export function findCardinalPath(map: WorldMap, start: GridPosition, target: GridPosition): GridPosition[] | null {
  if (!isMapCell(map, start) || !isMapCell(map, target) || map.width > 256 || map.height > 256 || map.width < 1 || map.height < 1) return null;
  const walkable = new Set(map.tiles.filter((tile) => tile.walkable && isMapCell(map, tile)).map((tile) => tile.y * map.width + tile.x));
  const startIndex = start.y * map.width + start.x;
  const targetIndex = target.y * map.width + target.x;
  if (!walkable.has(startIndex) || !walkable.has(targetIndex)) return null;
  if (startIndex === targetIndex) return [];
  const queue = [startIndex];
  const parents = new Map<number, number>([[startIndex, startIndex]]);
  for (let head = 0; head < queue.length && head < map.width * map.height; head += 1) {
    const index = queue[head]!;
    const position = { x: index % map.width, y: Math.floor(index / map.width) };
    for (const delta of CARDINAL_DIRECTIONS) {
      const adjacent = { x: position.x + delta.x, y: position.y + delta.y };
      if (!isMapCell(map, adjacent)) continue;
      const next = adjacent.y * map.width + adjacent.x;
      if (!walkable.has(next) || parents.has(next)) continue;
      parents.set(next, index);
      if (next === targetIndex) {
        const path: GridPosition[] = [];
        for (let cursor = next; cursor !== startIndex; cursor = parents.get(cursor)!) path.push({ x: cursor % map.width, y: Math.floor(cursor / map.width) });
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/** All authoritative map edits must invalidate serialized routes. */
export function setTileWalkable(world: WorldState, position: GridPosition, walkable: boolean): WorldState {
  if (!isMapCell(world.map, position) || typeof walkable !== 'boolean') throw new RangeError('Invalid navigation tile');
  const tile = world.map.tiles.find((entry) => sameCell(entry, position));
  if (!tile) throw new RangeError('Missing navigation tile');
  if (tile.walkable === walkable) return world;
  return { ...world, map: { ...world.map, navVersion: checkedAdd(world.map.navVersion, 1), tiles: world.map.tiles.map((entry) => sameCell(entry, position) ? { ...entry, walkable } : entry) } };
}
