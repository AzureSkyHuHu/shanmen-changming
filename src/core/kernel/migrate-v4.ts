import { upgradeLegacyCombatControllerState } from '../combat/ai';
import { EXPEDITION_COMBAT_CATALOG } from '../expeditions/encounter-catalog';
import { createSectEconomyState } from '../sect-economy/state';
import type { WorldState } from '../world/types';
import { cloneJson } from './serialization';

/** Detached v4 projection. The strict raw reader checks old controller/battle keys and capabilities first. */
export function projectLegacyWorldV4Controller(value: unknown): WorldState {
  const copy = cloneJson(value) as WorldState;
  if (copy.expedition?.battle) {
    const battle = copy.expedition.battle;
    battle.controller = upgradeLegacyCombatControllerState(battle.controller, EXPEDITION_COMBAT_CATALOG, battle.configHash);
  }
  return copy;
}

/** Only called after frozen v4 World validation. No clock, resources, IDs or RNG are advanced. */
export function migrateWorldV4ToV5(value: unknown): WorldState {
  const copy = projectLegacyWorldV4Controller(value);
  return { ...copy, simulationVersion: '0.5.0', sectEconomy: createSectEconomyState(copy.clock.simulationTick) };
}
