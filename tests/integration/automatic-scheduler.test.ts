import { describe, expect, it } from 'vitest';
import { advanceTicksWithStatus, createSaveEnvelope, createWorld, dispatchCommand, parseSave, serializeSave, validateWorldState,
  WORLD_AUTO_START_ALLOWANCE, type Command, type WorldState } from '../../src/core/kernel';
import { measureWorldSaveBytes } from '../../src/core/save-budget';

const metadata = { buildId: 'automatic-stress', savedAt: '2026-10-01T11:20:00Z' };
function submit(world: WorldState, command: Command): WorldState {
  const operation = dispatchCommand(world, command); expect(operation.result.status, JSON.stringify(operation.result)).toBe('accepted'); return operation.world;
}
function reload(world: WorldState): WorldState {
  const parsed = parseSave(serializeSave(createSaveEnvelope(world, metadata)));
  if (!parsed.ok) throw new Error(parsed.error.message); return parsed.world;
}
function step(world: WorldState, count: number): WorldState {
  const result = advanceTicksWithStatus(world, count);
  expect(result.capacityStop).toBeNull(); expect(result.invariantStop).toBeNull();
  world = result.world;
  // If the unassigned elder naturally reaches expiry during this long real-calendar
  // run, acknowledge that actual pending death through the same player command.
  for (const death of [...world.cultivation.pendingDeaths]) {
    const commandId = `stress.death.${death.deathId}`;
    world = submit(world, { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
      kind: 'cultivation.command', payload: { command: { commandId, expectedRevision: world.cultivation.revision,
        kind: 'death.finalize', discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
  }
  return world;
}
// Gate0 is deliberately skipped, not evidence of scheduler execution. Parent enables
// the local candidate only after the focused lifecycle/capacity suite is accepted.
describe.skipIf(WORLD_AUTO_START_ALLOWANCE === 0)('active automatic scheduler acceptance', () => {
  it('runs1000 real farmer/cook cycles with bounded live/journal state, target stops and exact public cancel history', () => {
    let world = createWorld('automatic-scheduler-stress');
    const plans = [{ workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'farm.grain', targetStock: 40 }] },
      { workerId: 'entity:3', enabled: true, priorities: [{ recipeId: 'cook.meal', targetStock: 30 }] }];
    for (const plan of plans) world = submit(world, { commandId: `stress.plan.${plan.workerId}`, sequence: 1, issuedTick: 0,
      kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan } } });
    world = submit(world, { commandId: 'stress.enabled', sequence: 2, issuedTick: 0, kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } });
    world = step(world, 1); expect(Object.keys(world.automaticProduction.live)).toHaveLength(2);
    const cancelledId = Object.keys(world.automaticProduction.live)[0]!;
    const cancel: Command = { commandId: 'stress.public.cancel', sequence: 3, issuedTick: world.clock.simulationTick,
      kind: 'production.cancel', payload: { transactionId: cancelledId } };
    const cancelled = dispatchCommand(world, cancel); expect(cancelled.result.status).toBe('accepted'); world = cancelled.world;
    let rounds = 0;
    while (world.automaticProduction.nextCycle <= 1000 && rounds < 60) {
      for (let checkpoint = 0; checkpoint < 100; checkpoint++) {
        world = step(world, 200);
        expect(Object.keys(world.automaticProduction.live).length).toBeLessThanOrEqual(2);
        expect(world.automaticProduction.journal.length).toBeLessThanOrEqual(64);
        expect(world.activeProductionTransactionIds.length).toBeLessThanOrEqual(2);
        if (world.inventory.grain.owned >= 40 && world.inventory.meal.owned >= 30 && world.activeProductionTransactionIds.length === 0) break;
      }
      expect(world.inventory.grain.owned).toBeGreaterThanOrEqual(40); expect(world.inventory.meal.owned).toBeGreaterThanOrEqual(30);
      expect(world.activeProductionTransactionIds).toEqual([]); expect(validateWorldState(world)).toEqual([]);
      const stoppedCycle = world.automaticProduction.nextCycle;
      expect(step(world, 60).automaticProduction.nextCycle).toBe(stoppedCycle);
      const restored = reload(world);
      expect(step(restored, 37)).toEqual(step(world, 37));
      world = restored;
      if (world.automaticProduction.nextCycle > 1000) break;
      for (const resourceId of ['grain', 'meal'] as const) {
        const quantity = world.inventory[resourceId].owned - (resourceId === 'grain' ? 1 : 0);
        world = submit(world, { commandId: `stress.consume.${rounds}.${resourceId}`, sequence: world.sequences.nextAction,
          issuedTick: world.clock.simulationTick, kind: 'inventory.discard', payload: { resourceId, quantity } });
      }
      rounds++;
    }
    expect(world.automaticProduction.nextCycle).toBeGreaterThan(1000); expect(world.automaticProduction.live).toEqual({});
    expect(world.automaticProduction.journal).toHaveLength(64);
    expect(world.transactions).toEqual({}); expect(world.reservations).toEqual({}); expect(world.history.production.count).toBe(0);
    expect(Object.keys(world.automaticProduction.pins)).toEqual([cancelledId]);
    expect(measureWorldSaveBytes(world, { saveVersion: 7 })).toBeLessThan(250_000);
    const final = reload(world); const replay = dispatchCommand(final, cancel);
    expect(replay.world).toBe(final); expect(replay.result).toEqual(cancelled.result); expect(validateWorldState(final)).toEqual([]);
  }, 180_000);
});
