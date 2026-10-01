import { describe, expect, it } from 'vitest';
import frozenWorld from '../integration/fixtures/save-v4-active-battle.json';
import { combatCatalog } from '../../src/content/definitions';
import { prepareCombatCatalog, restoreBattle, serializeBattle, upgradeLegacyBattleState } from '../../src/core/combat';
import { restoreCombatController, serializeCombatController, stepCombatController, upgradeLegacyCombatControllerSnapshot, upgradeLegacyCombatControllerState } from '../../src/core/combat/ai';
import { cloneJson, stableHash } from '../../src/core/kernel/serialization';
const catalog = prepareCombatCatalog(combatCatalog);
// This fixture was produced by the untouched accepted v4 runtime, not reverse-shaped v2 output.
const legacy = frozenWorld.payload.expedition.battle!.controller;
describe('explicit frozen-v1 combat migration', () => {
  it('upgrades the genuine active v4 raw controller without changing RNG, reservations, effects, ICDs or config hash', () => {
    const upgraded = upgradeLegacyCombatControllerState(legacy, catalog, legacy.configHash);
    expect(upgraded.version).toBe(2); expect(upgraded.battle.snapshotVersion).toBe(2); expect(upgraded.battle.simulationVersion).toBe('combat-runtime-2');
    expect(upgraded.battle.arena).toEqual(legacy.config.arena); expect(upgraded.battle.zones).toEqual([]); expect(upgraded.battle.summons).toEqual([]);
    for (const key of ['random', 'sequences', 'actions', 'statuses', 'shields', 'triggerLedger', 'roots', 'statistics'] as const) expect(upgraded.battle[key]).toEqual(legacy.battle[key]);
    expect(upgraded.configHash).toBe(legacy.configHash); expect(legacy.version).toBe(1); expect(legacy.battle.snapshotVersion).toBe(1);
    const restored = restoreCombatController(serializeCombatController(upgraded), catalog, upgraded.configHash); expect(restored).toEqual(upgraded); expect(stepCombatController(restored, catalog, 20)).toEqual(stepCombatController(upgraded, catalog, 20));
  });
  it('requires explicit legacy APIs and validates the original text checksums', () => {
    const battleText = JSON.stringify({ snapshotVersion: 1, simulationVersion: 'combat-runtime-1', checksum: stableHash(legacy.battle), state: legacy.battle });
    expect(() => restoreBattle(battleText, catalog)).toThrow(/version/);
    const state = { ...legacy, battle: battleText }; const text = JSON.stringify({ version: 1, checksum: stableHash(state), state });
    expect(() => restoreCombatController(text, catalog)).toThrow(/version/); expect(upgradeLegacyCombatControllerSnapshot(text, catalog)).toEqual(upgradeLegacyCombatControllerState(legacy, catalog));
    expect(() => upgradeLegacyCombatControllerSnapshot(text.replace(stableHash(state), '00000000'), catalog)).toThrow();
  });
  it('rejects forged legacy shape, missing entities, RNG and unsupported advanced programs rather than repairing them', () => {
    const missing = cloneJson(legacy); delete (missing.battle.entities as Record<string, unknown>)['entity:1']; expect(() => upgradeLegacyCombatControllerState(missing, catalog)).toThrow();
    const extra = { ...cloneJson(legacy), unexpected: true }; expect(() => upgradeLegacyCombatControllerState(extra, catalog)).toThrow();
    const malformed = cloneJson(legacy); malformed.battle.random.combat.state = 0; expect(() => upgradeLegacyCombatControllerState(malformed, catalog)).toThrow();
    const wrongVersion = { ...legacy.battle, snapshotVersion: 2 }; expect(() => upgradeLegacyBattleState(wrongVersion, catalog)).toThrow();
    const current = upgradeLegacyBattleState(legacy.battle, catalog); expect(() => upgradeLegacyBattleState(JSON.parse(serializeBattle(current)).state, catalog)).toThrow();
  });
});
