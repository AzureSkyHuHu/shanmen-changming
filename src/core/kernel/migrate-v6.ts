import { createAutomaticProductionState } from '../economy/automatic-production';
import { cloneWorldWithSharedHistory } from '../world/history-access';
import type { WorldState } from '../world/types';

/** Source v6 was checksum-verified and strictly validated. No identity, resource or event allocation. */
export function migrateWorldV6ToV7(value: unknown): WorldState {
  const source = value as WorldState;
  if (Object.hasOwn(source, 'automaticProduction')) throw new TypeError('Legacy automatic state is not admissible');
  const world = cloneWorldWithSharedHistory(source);
  return { ...world, simulationVersion: '0.7.0', automaticProduction: createAutomaticProductionState(world.sectEconomy.enabled),
    sectEconomy: { ...world.sectEconomy, enabled: false } };
}
