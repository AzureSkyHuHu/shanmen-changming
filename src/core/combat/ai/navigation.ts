import type { BattleArena, BattleState } from '../runtime';
import { battleCell, battlePosition, occupiedBattleCells } from '../runtime';
/** Bounded BFS tie order matches the world kernel: north, east, south, west. */
const directions = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }] as const;
export function approachBattleTarget(state: BattleState, arena: BattleArena, actorId: string, targetId: string, rangeUnits: number): { x: number; y: number } | null {
  const actor = state.entities[actorId]; const target = state.entities[targetId]; if (!actor || !target) return null;
  const start = battleCell(arena, actor.position); if (!start) return null;
  const blocked = new Set(arena.blockedCells.map(cell => `${cell.x},${cell.y}`)); const occupied = occupiedBattleCells(state, actorId);
  const inRange = (x: number, y: number) => { const position = battlePosition(arena, { x, y }); return (position.x - target.position.x) ** 2 + (position.y - target.position.y) ** 2 <= rangeUnits ** 2; };
  if (inRange(start.x, start.y)) return null;
  const key = (x: number, y: number) => y * arena.widthCells + x; const startKey = key(start.x, start.y); const queue = [startKey]; const parents = new Map<number, number>([[startKey, startKey]]);
  for (let head = 0; head < queue.length && head < arena.widthCells * arena.heightCells; head++) {
    const current = queue[head]!; const x = current % arena.widthCells; const y = Math.floor(current / arena.widthCells);
    for (const direction of directions) {
      const nextX = x + direction.x; const nextY = y + direction.y; const next = key(nextX, nextY);
      if (nextX < 0 || nextY < 0 || nextX >= arena.widthCells || nextY >= arena.heightCells || blocked.has(`${nextX},${nextY}`) || parents.has(next)) continue;
      const position = battlePosition(arena, { x: nextX, y: nextY }); if (occupied.has(`${position.x},${position.y}`)) continue;
      parents.set(next, current);
      if (inRange(nextX, nextY)) { let cursor = next; while (parents.get(cursor) !== startKey) cursor = parents.get(cursor)!; return battlePosition(arena, { x: cursor % arena.widthCells, y: Math.floor(cursor / arena.widthCells) }); }
      queue.push(next);
    }
  }
  return null;
}
