import { migrateWorldV6ToV7 } from '../../src/core/kernel/migrate-v6';
import { migrateWorldHistory } from '../../src/core/world/history-access';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { advanceTicks, canonicalStringify, cloneJson, createSaveEnvelope, createWorld, dispatchCommand, parseSave, serializeSave,
  stableHash, validateLegacyWorldStateV4, validateWorldState, type Command, type WorldState } from '../../src/core/kernel';
import { migrateWorldV4ToV5 } from '../../src/core/kernel/migrate-v4';
import { openSaveRepository } from '../../src/platform/persistence';

const sourceText = readFileSync(new URL('./fixtures/save-v4-active-battle.json', import.meta.url), 'utf8');
const metadata = { buildId: 'combat-v5-tests', savedAt: '2026-10-01T09:45:00Z' };
function loadSource() {
  const parsed = parseSave(sourceText);
  expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed;
}
function resign(value: Record<string, unknown>): string {
  const { checksum: _checksum, ...body } = value;
  return canonicalStringify({ ...body, checksum: stableHash(body) });
}
function reload(world: WorldState) {
  const parsed = parseSave(serializeSave(createSaveEnvelope(world, metadata)));
  expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.world;
}

describe('frozen v4 combat state migration', () => {
  it('validates and upgrades a real active encounter without altering source bytes, RNG, IDs or work', () => {
    const original = JSON.parse(sourceText);
    expect(original.saveVersion).toBe(4);
    expect(validateLegacyWorldStateV4(original.payload)).toEqual([]);
    expect(JSON.stringify(original)).toBe(JSON.stringify(JSON.parse(sourceText)));
    const result = loadSource();
    expect(result.envelope.saveVersion).toBe(7);
    expect(result.migration).toEqual({ sourceSaveVersion: 4, sourceSimulationVersion: '0.4.0', sourceChecksum: '52337268' });
    expect(result.world).toEqual(migrateWorldV6ToV7(migrateWorldHistory(migrateWorldV4ToV5(original.payload))));
    const current = result.world.expedition.battle!.controller;
    expect(current.version).toBe(2);
    expect(current.battle.snapshotVersion).toBe(2);
    expect(current.battle.simulationVersion).toBe('combat-runtime-2');
    expect(current.battle.arena).toEqual(current.config.arena);
    expect(current.battle.zones).toEqual([]);
    expect(current.battle.summons).toEqual([]);
    const projected = JSON.parse(JSON.stringify(result.world));
    projected.simulationVersion = '0.4.0'; delete projected.sectEconomy; delete projected.history; delete projected.automaticProduction;
    const controller = projected.expedition.battle.controller;
    controller.version = 1;
    controller.battle.snapshotVersion = 1; controller.battle.simulationVersion = 'combat-runtime-1';
    delete controller.battle.arena; delete controller.battle.zones; delete controller.battle.summons;
    for (const entity of Object.values(controller.battle.entities) as Record<string, unknown>[]) delete entity.kind;
    for (const source of Object.values(controller.battle.sources) as Record<string, unknown>[]) delete source.executionKind;
    expect(projected).toEqual(original.payload);
    expect(result.world.sectEconomy).toEqual({ schemaVersion: 1, enabled: false, plans: [], nextDecisionTick: 1220 });
    expect(JSON.parse(sourceText)).toEqual(original);
    expect(validateWorldState(result.world)).toEqual([]);
  });

  it('continues deterministically through a current save boundary with existing effects and casts intact', () => {
    const world = loadSource().world;
    const direct = advanceTicks(world, 40);
    const resumed = advanceTicks(reload(advanceTicks(world, 7)), 33);
    expect(resumed).toEqual(direct);
    expect(direct.clock.simulationTick).toBe(1260);
    expect(validateWorldState(direct)).toEqual([]);
  });

  it.each(['version', 'unknownField', 'badReference', 'newBattleFields', 'newControllerVersion'])('rejects malformed old controller: %s', (kind) => {
    const source = JSON.parse(sourceText);
    const controller = source.payload.expedition.battle.controller;
    if (kind === 'version') controller.battle.simulationVersion = 'combat-runtime-99';
    if (kind === 'unknownField') controller.battle.entities['entity:1'].kind = 'combatant';
    if (kind === 'badReference') controller.battle.statuses[0].sourceInstanceId = 'instance:99999';
    if (kind === 'newBattleFields') controller.battle.zones = [];
    if (kind === 'newControllerVersion') controller.version = 2;
    const text = resign(source);
    expect(parseSave(text)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    expect(JSON.parse(text).payload).toEqual(source.payload);
  });

  it('rejects v5 fields and newly executable recipes at frozen v4 boundaries', () => {
    const source = JSON.parse(sourceText);
    source.payload.sectEconomy = { schemaVersion: 1, enabled: false, plans: [], nextDecisionTick: 1220 };
    expect(parseSave(resign(source))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    delete source.payload.sectEconomy;
    source.payload.pendingCommands = [{ commandId: 'old-new-recipe', sequence: 8, issuedTick: 1230, kind: 'production.start', payload: { recipeId: 'gather.grain', workerId: 'entity:3' } }];
    expect(parseSave(resign(source))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    source.payload.pendingCommands = [];
    // An unknown recipe rejection was valid history under v4 and remains a cached rejection.
    source.payload.commandReceipts['old-new-recipe'] = { commandId: 'old-new-recipe', fingerprint: canonicalStringify({ kind: 'production.start', payload: { recipeId: 'gather.grain', workerId: 'entity:3' } }),
      result: { commandId: 'old-new-recipe', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'UNKNOWN_RECIPE' } } };
    const parsed = parseSave(resign(source));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const retry = dispatchCommand(parsed.world, { commandId: 'old-new-recipe', sequence: 8, issuedTick: 1220, kind: 'production.start', payload: { recipeId: 'gather.grain', workerId: 'entity:3' } });
      expect(retry.world).toBe(parsed.world);
      expect(retry.result.rejection?.code).toBe('UNKNOWN_RECIPE');
    }
  });

  it('preserves stored v4 bytes and creates v5 only on explicit save; future imports leave it intact', async () => {
    const repository = await openSaveRepository({ indexedDB: new IDBFactory(), now: () => 1000 });
    try {
      const imported = await repository.importSave(sourceText, { ownerId: 'v4-source' });
      const loaded = await repository.loadSlot(imported.slot.slotId);
      expect(loaded.envelope.saveVersion).toBe(7);
      expect(loaded.snapshot.text).toBe(sourceText);
      expect((await repository.exportSlot(imported.slot.slotId)).text).toBe(sourceText);
      const future = JSON.parse(sourceText); future.saveVersion = 99;
      await expect(repository.importSave(resign(future), { mode: 'overwrite', slotId: imported.slot.slotId, expectedRevision: 1, lease: imported.lease })).rejects.toMatchObject({ code: 'INVALID_SAVE', saveErrorCode: 'UNSUPPORTED_SAVE_VERSION' });
      expect((await repository.exportSlot(imported.slot.slotId)).text).toBe(sourceText);
      const saved = await repository.saveWorld(imported.slot.slotId, loaded.world, metadata, { expectedRevision: 1, lease: imported.lease });
      expect(JSON.parse(saved.snapshot.text).saveVersion).toBe(7);
      expect(await repository.exportRawSnapshot(imported.slot.slotId, imported.snapshot.id)).toBe(sourceText);
    } finally { repository.close(); }
  });
});

describe('dormant v5 work plan gateway', () => {
  function planCommand(world: WorldState, commandId = 'plan:1'): Command {
    return { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
      kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: { workerId: world.disciples[1]!.id, enabled: true,
        priorities: [{ recipeId: 'farm.grain', targetStock: 24 }, { recipeId: 'gather.grain', targetStock: 24 }] } } } };
  }
  it('stores detached bounded configuration with exact retries, conflicts and save support', () => {
    const world = createWorld('dormant-work'); const command = planCommand(world);
    expect(world.sectEconomy).toEqual({ schemaVersion: 1, enabled: false, nextDecisionTick: 0, plans: [] });
    const result = dispatchCommand(world, command);
    expect(result.result.economyResult).toEqual({ kind: 'plan.set', workerId: world.disciples[1]!.id });
    expect(result.world.randomStreams).toBe(world.randomStreams);
    expect(result.world.inventory).toBe(world.inventory);
    expect(result.world.sequences).toBe(world.sequences);
    expect(dispatchCommand(result.world, command).world).toBe(result.world);
    expect(dispatchCommand(result.world, { ...command, payload: { command: { kind: 'enabled.set', enabled: true } } }).result.rejection?.code).toBe('COMMAND_CONFLICT');
    if (command.kind === 'sect-economy.command' && command.payload.command.kind === 'plan.set') command.payload.command.plan.priorities[0]!.targetStock = 999;
    expect(result.world.sectEconomy.plans[0]!.priorities[0]!.targetStock).toBe(24);
    expect(reload(result.world)).toEqual(result.world);
  });
  it('keeps an imported legacy enabled plan dormant until a fresh current activation choice', () => {
    const legacyText = readFileSync(new URL('./fixtures/save-v5-mixed-history.json', import.meta.url), 'utf8');
    const original = JSON.parse(legacyText); expect(original.payload.sectEconomy.enabled).toBe(true);
    const result = parseSave(legacyText); if (!result.ok) throw new Error(result.error.message);
    expect(result.world.sectEconomy.enabled).toBe(false); expect(result.world.automaticProduction.activationReviewRequired).toBe(true);
    const before = cloneJson(result.world); const after = advanceTicks(result.world, 20);
    expect(after.automaticProduction.nextCycle).toBe(1); expect(after.automaticProduction.live).toEqual({});
    expect(after.sectEconomy).toEqual(before.sectEconomy); expect(after.commandReceipts).toEqual(before.commandReceipts);
    expect(JSON.parse(legacyText)).toEqual(original); expect(validateWorldState(after)).toEqual([]);
  });
  it('rejects unknown workers, malformed plans, forged results and unknown state fields', () => {
    const world = createWorld(); const command = planCommand(world);
    if (command.kind !== 'sect-economy.command' || command.payload.command.kind !== 'plan.set') throw new Error('plan fixture');
    command.payload.command.plan.workerId = 'entity:999';
    const rejected = dispatchCommand(world, command);
    expect(rejected.result.rejection).toEqual({ code: 'SECT_ECONOMY_REJECTED', economyCode: 'UNKNOWN_WORKER' });
    expect(reload(rejected.world)).toEqual(rejected.world);
    command.payload.command.plan.priorities[0]!.targetStock = -1;
    expect(dispatchCommand(world, command).result.rejection?.code).toBe('INVALID_COMMAND');
    const accepted = dispatchCommand(world, planCommand(world)).world;
    const forged = cloneJson(accepted); forged.commandReceipts['plan:1']!.result.economyResult!.workerId = 'entity:1';
    expect(validateWorldState(forged).length).toBeGreaterThan(0);
    expect(validateWorldState({ ...accepted, sectEconomy: { ...accepted.sectEconomy, autoStartAllowance: 10 } }).length).toBeGreaterThan(0);
  });
});
