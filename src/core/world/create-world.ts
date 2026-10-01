import { createInventory } from '../economy/inventory';
import { CALENDAR_TICKS_PER_MONTH, createClock } from '../kernel/clock';
import { allocateId, createSequences } from '../kernel/ids';
import { createRandomStreams, drawInteger } from '../kernel/random';
import type { Disciple, WorldBuilding, WorldState, WorldTile } from './types';

export const SIMULATION_VERSION = '0.1.0';
export const CONTENT_VERSION = 'starter-0.1.0';

/** Seeded starter fixture. The central road and all four resource stations are guaranteed reachable. */
export function createWorld(seed: string | number = 'shanmen-001'): WorldState {
  const normalizedSeed = String(seed);
  if (normalizedSeed.length === 0 || normalizedSeed.length > 256) throw new RangeError('Seed must contain 1–256 characters');
  let randomStreams = createRandomStreams(normalizedSeed);
  let sequences = createSequences();
  const tiles: WorldTile[] = [];
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 14; x += 1) {
      const draw = drawInteger(randomStreams, 'generation', 0, 9);
      randomStreams = draw.streams;
      const terrain = y === 5 || x === 7 ? 'path' : draw.value < 2 ? 'forest' : draw.value === 2 ? 'stone' : 'grass';
      tiles.push({ x, y, terrain, walkable: true });
    }
  }
  const disciples: Disciple[] = [14, 24, 41, 67].map((years, index) => {
    const allocated = allocateId(sequences, 'entity'); sequences = allocated.sequences;
    const aptitude = drawInteger(randomStreams, 'generation', 40, 80); randomStreams = aptitude.streams;
    return { id: allocated.id, nameKey: `disciple.starter.${index + 1}`, ageMonths: years * 12, birthCalendarTick: -years * 12 * CALENDAR_TICKS_PER_MONTH, position: { x: 5 + index, y: 5 }, lifeState: 'alive', canWork: years >= 16, traveling: false, assignmentTransactionId: null, aptitude: aptitude.value };
  });
  const locations = [
    { blueprintId: 'housing', nameKey: 'building.housing', x: 7, y: 2 },
    { blueprintId: 'forest', nameKey: 'building.forest', x: 2, y: 5 },
    { blueprintId: 'herb-garden', nameKey: 'building.herbGarden', x: 4, y: 5 },
    { blueprintId: 'kitchen', nameKey: 'building.kitchen', x: 9, y: 5 },
    { blueprintId: 'workshop', nameKey: 'building.workshop', x: 11, y: 5 },
    { blueprintId: 'mine', nameKey: 'building.mine', x: 7, y: 8 },
    { blueprintId: 'spirit-vein', nameKey: 'building.spiritVein', x: 7, y: 0 },
  ];
  const buildings: WorldBuilding[] = locations.map((building) => {
    const allocated = allocateId(sequences, 'entity'); sequences = allocated.sequences;
    return { ...building, id: allocated.id, operational: true };
  });
  return {
    seed: normalizedSeed, simulationVersion: SIMULATION_VERSION, contentVersion: CONTENT_VERSION,
    clock: createClock(), randomStreams, sequences,
    map: { width: 14, height: 10, seed: normalizedSeed, generationVersion: 1, tiles },
    disciples, buildings, inventory: createInventory(), reservations: {}, transactions: {}, commandReceipts: {}, pendingCommands: [], events: [],
    unlocks: ['recipe.gather', 'recipe.cooking', 'recipe.planks', 'route.first-breakthrough'], diagnostics: [],
  };
}
