import { allocateId } from '../kernel/ids';
import { cloneJson } from '../kernel/serialization';
import type { WorldState } from '../world/types';
import { cardinalDistance, emptyNavigation } from './navigation';

/** Input MUST pass validateLegacyWorldStateV1 first. No resource/RNG/event changes. */
export function migrateWorldV1ToV2(value: unknown): WorldState {
  const world = cloneJson(value) as WorldState;
  world.simulationVersion = '0.2.0';
  world.map.navVersion = 0;
  world.buildings = world.buildings.map((building) => ({ ...building, stationTransactionId: null }));
  const center = { x: Math.floor(world.map.width / 2), y: Math.floor(world.map.height / 2) };
  const location = [...world.map.tiles].sort((left, right) => Number(right.walkable) - Number(left.walkable) || cardinalDistance(left, center) - cardinalDistance(right, center) || left.y - right.y || left.x - right.x)[0]!;
  const storage = allocateId(world.sequences, 'entity');
  world.sequences = storage.sequences;
  world.buildings.push({ id: storage.id, blueprintId: 'storage', nameKey: 'building.storage', x: location.x, y: location.y, operational: true, stationTransactionId: null });
  world.activeProductionTransactionIds = [];
  for (const transaction of Object.values(world.transactions)) {
    transaction.worksiteId = null;
    transaction.storageId = null;
    transaction.navigation = emptyNavigation();
    if (transaction.state === 'Committed') transaction.phase = 'Done';
    else if (transaction.state === 'Cancelled') transaction.phase = 'Cancelled';
    else {
      // Old work is preserved, but legacy completion cannot award outputs remotely.
      world.activeProductionTransactionIds.push(transaction.transactionId);
      transaction.phase = transaction.activeTicks === transaction.requiredTicks ? 'TravellingToStorage' : 'WaitingForStation';
      transaction.state = 'Running';
      transaction.blockedReason = null;
    }
  }
  world.disciples = world.disciples.map((disciple) => disciple.assignmentTransactionId === null ? disciple : { ...disciple, traveling: false });
  return world;
}
