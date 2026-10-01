import { cloneJson } from './serialization';
import { attachWorldProgression } from '../world/build-bridge';
import type { CultivationWorld } from '../world/types';

/** Frozen-v3 input has already passed its own checksum/schema. No source mutation or random draws. */
export function migrateWorldV3ToV4(value: unknown): unknown {
  const copy = cloneJson(value) as CultivationWorld;
  copy.simulationVersion = '0.4.0';
  copy.cultivation.schemaVersion = 2;
  for (const profile of copy.cultivation.disciples) profile.activityOwner = null;
  const { sectEconomy: _futureEconomy, history: _futureHistory, automaticProduction: _futureAutomatic, ...historical } = attachWorldProgression(copy);
  return historical;
}
