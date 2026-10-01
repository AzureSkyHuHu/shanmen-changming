import { cloneJson } from './serialization';
import { attachCultivationState } from '../world/initialize-cultivation';
import type { CultivationWorld } from '../world/types';

/** Called only after frozen v2 validation. Never changes caller/source bytes or draws randomness. */
export function migrateWorldV2ToV3(value: unknown): unknown {
  const prior = cloneJson(value) as Omit<CultivationWorld, 'cultivation'>;
  const migrated = cloneJson(attachCultivationState({ ...prior, simulationVersion: '0.3.0' })) as unknown as Record<string, unknown>;
  const cultivation = migrated.cultivation as Record<string, unknown>;
  cultivation.schemaVersion = 1;
  for (const profile of cultivation.disciples as Array<Record<string, unknown>>) delete profile.activityOwner;
  return migrated;
}
