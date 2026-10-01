import type { BattleArena, BattleState } from './types';
export function validateBattleArena(arena: BattleArena): void {
  if (!arena || typeof arena !== 'object' || !arena.origin || !Array.isArray(arena.blockedCells)) throw new Error('Invalid battle arena');
  for (const dimension of [arena.widthCells, arena.heightCells, arena.cellSizeUnits]) if (!Number.isSafeInteger(dimension) || dimension < 1) throw new Error('Invalid arena dimension');
  if (arena.widthCells > 64 || arena.heightCells > 64 || arena.cellSizeUnits > 1000) throw new Error('Arena exceeds bounded grid');
  for (const coordinate of [arena.origin.x, arena.origin.y]) if (!Number.isSafeInteger(coordinate) || Math.abs(coordinate) > 900_000) throw new Error('Invalid arena origin');
  const cells = new Set<string>();
  for (const cell of arena.blockedCells) { if (!cell || !Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y) || cell.x < 0 || cell.x >= arena.widthCells || cell.y < 0 || cell.y >= arena.heightCells) throw new Error('Invalid blocked cell'); const key = `${cell.x},${cell.y}`; if (cells.has(key)) throw new Error('Duplicate blocked cell'); cells.add(key); }
}
export function battleCell(arena: BattleArena, position: { readonly x: number; readonly y: number }): { x: number; y: number } | null {
  const x = (position.x - arena.origin.x) / arena.cellSizeUnits; const y = (position.y - arena.origin.y) / arena.cellSizeUnits;
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) && x >= 0 && x < arena.widthCells && y >= 0 && y < arena.heightCells ? { x, y } : null;
}
export function battlePosition(arena: BattleArena, cell: { readonly x: number; readonly y: number }): { x: number; y: number } { return { x: arena.origin.x + cell.x * arena.cellSizeUnits, y: arena.origin.y + cell.y * arena.cellSizeUnits }; }
export function arenaWalkable(arena: BattleArena, position: { readonly x: number; readonly y: number }): boolean { const cell = battleCell(arena, position); return cell !== null && !arena.blockedCells.some(blocked => blocked.x === cell.x && blocked.y === cell.y); }
/** Downed bodies block cells; permanent-dead entities do not. */
export function occupiedBattleCells(state: BattleState, exceptId: string | null = null): ReadonlySet<string> { return new Set(Object.values(state.entities).filter(entity => entity.id !== exceptId && entity.life !== 'Dead').map(entity => `${entity.position.x},${entity.position.y}`)); }

/** Bounded cardinal flood-fill; occupied cells (including downed bodies) are impassable.
 * Destination is adjacent to the ally, not the ally's occupied position. */
export function allyMovementDestination(state: BattleState, actorId: string, allyId: string, maximumDistanceUnits: number): { x: number; y: number } | null {
  const arena = state.arena; const actor = state.entities[actorId]; const ally = state.entities[allyId];
  if (!arena || !actor || !ally || actor.team !== ally.team || actorId === allyId || !arenaWalkable(arena, actor.position) || !arenaWalkable(arena, ally.position)) return null;
  const adjacent = (position: { x: number; y: number }) => Math.abs(position.x - ally.position.x) + Math.abs(position.y - ally.position.y) === arena.cellSizeUnits;
  if (adjacent(actor.position)) return { ...actor.position };
  const occupied = occupiedBattleCells(state, actorId); const queue = [{ position: { ...actor.position }, distance: 0 }]; const visited = new Set([`${actor.position.x},${actor.position.y}`]);
  for (let head = 0; head < queue.length && head < arena.widthCells * arena.heightCells; head++) {
    const entry = queue[head]!; const distance = entry.distance + arena.cellSizeUnits; if (distance > maximumDistanceUnits) continue;
    for (const delta of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
      const position = { x: entry.position.x + delta.x * arena.cellSizeUnits, y: entry.position.y + delta.y * arena.cellSizeUnits }; const key = `${position.x},${position.y}`;
      if (visited.has(key) || occupied.has(key) || !arenaWalkable(arena, position)) continue;
      visited.add(key); if (adjacent(position)) return position; queue.push({ position, distance });
    }
  }
  return null;
}
/** Deterministic nearby placement, restricted to the four free neighboring cells. */
export function summonPlacement(state: BattleState, casterId: string, replacingId: string | null): { x: number; y: number } | null {
  const arena = state.arena; const caster = state.entities[casterId]; if (!arena || !caster) return null;
  const occupied = occupiedBattleCells(state, replacingId);
  for (const delta of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
    const position = { x: caster.position.x + delta.x * arena.cellSizeUnits, y: caster.position.y + delta.y * arena.cellSizeUnits };
    if (arenaWalkable(arena, position) && !occupied.has(`${position.x},${position.y}`)) return position;
  }
  return null;
}
