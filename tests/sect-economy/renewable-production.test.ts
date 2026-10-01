import { lookupProduction } from '../../src/core/world/history-access';
import { describe, expect, it } from 'vitest';
import { getRecipe } from '../../src/core/economy/recipes';
import type { RecipeDefinition } from '../../src/core/economy/types';
import {
  advanceTicks, createSaveEnvelope, createWorld, dispatchCommand, isCultivationWorkerAvailable,
  parseSave, serializeSave, validateWorldState, type WorldState,
} from '../../src/core/kernel';
import { createSectEconomyState, createStarterWorkPlans, planAutomaticWork, type SectEconomyState } from '../../src/core/sect-economy';

const metadata = { buildId: 'renewable-food-tests', savedAt: '2026-10-01T09:00:00Z' };
function start(world: WorldState, recipeId: string, commandId = 'food.manual') {
  const operation = dispatchCommand(world, { commandId, sequence: 0, issuedTick: world.clock.simulationTick, kind: 'production.start', payload: { recipeId, workerId: world.disciples[1]!.id } });
  expect(operation.result.status).toBe('accepted');
  return { world: operation.world, transactionId: operation.result.transactionId! };
}
function reload(world: WorldState): WorldState {
  const result = parseSave(serializeSave(createSaveEnvelope(world, metadata)));
  if (!result.ok) throw new Error(result.error.message);
  return result.world;
}
/** Test-only adapter. Production release integration must supply its approved retention gate. */
function tickPlan(world: WorldState, state: SectEconomyState): { world: WorldState; state: SectEconomyState } {
  const decision = planAutomaticWork(state, {
    simulationTick: world.clock.simulationTick, mode: world.clock.mode, paused: world.clock.pauseReasons.length > 0,
    inventory: world.inventory,
    workers: world.disciples.map((worker) => ({ workerId: worker.id,
      available: worker.canWork && worker.lifeState === 'alive' && !worker.traveling && worker.assignmentTransactionId === null && isCultivationWorkerAvailable(world, worker.id) })),
    activeJobs: world.activeProductionTransactionIds.map((id) => world.transactions[id]!),
    operationalWorkstations: world.buildings.filter((building) => building.operational).map((building) => building.blueprintId as RecipeDefinition['workstation']),
    storageAvailable: world.buildings.some((building) => building.operational && building.blueprintId === 'storage'),
    autoStartAllowance: 2,
  });
  for (const intent of decision.intents) {
    const commandId = `food.test.${world.clock.simulationTick}.${intent.workerId}`;
    const operation = dispatchCommand(world, { commandId, sequence: 0, issuedTick: world.clock.simulationTick, kind: 'production.start', payload: intent });
    expect(operation.result.status).toBe('accepted');
    world = operation.world;
  }
  return { world: advanceTicks(world, 1), state: decision.state };
}

describe('renewable food uses authoritative production logistics', () => {
  it('forages grain from zero without credit before on-site work and storage delivery', () => {
    const initial = createWorld('zero-food-manual');
    initial.inventory.grain.owned = 0;
    const started = start(initial, 'gather.grain');
    let world = advanceTicks(started.world, 1);
    expect(world.inventory.grain.owned).toBe(0);
    expect(world.transactions[started.transactionId]?.activeTicks).toBe(0);
    expect(world.transactions[started.transactionId]?.worksiteId).toBe(world.buildings.find((building) => building.blueprintId === 'forest')?.id);
    while (world.transactions[started.transactionId]?.phase !== 'AwaitingDelivery') {
      expect(world.clock.simulationTick).toBeLessThan(500);
      world = advanceTicks(world, 1);
      expect(world.inventory.grain.owned).toBe(0);
    }
    expect(world.transactions[started.transactionId]?.activeTicks).toBe(getRecipe('gather.grain')?.workTicks);
    world = advanceTicks(reload(world), 1);
    expect(world.inventory.grain.owned).toBe(1);
    expect(lookupProduction(world, started.transactionId)?.state).toBe('Committed');
    expect(validateWorldState(world)).toEqual([]);
  });
  it('locks seed grain, shares the real garden station, and releases seed on cancellation', () => {
    const initial = createWorld('grain-seed-cancellation');
    initial.inventory.grain.owned = 1;
    const started = start(initial, 'farm.grain');
    let world = advanceTicks(started.world, 60);
    expect(world.inventory.grain).toMatchObject({ owned: 1, reserved: 1 });
    expect(world.transactions[started.transactionId]?.worksiteId).toBe(world.buildings.find((building) => building.blueprintId === 'herb-garden')?.id);
    const operation = dispatchCommand(world, { commandId: 'food.cancel', sequence: 1, issuedTick: world.clock.simulationTick, kind: 'production.cancel', payload: { transactionId: started.transactionId } });
    expect(operation.result.status).toBe('accepted');
    world = advanceTicks(reload(operation.world), 400);
    expect(world.inventory.grain).toMatchObject({ owned: 1, reserved: 0 });
    expect(lookupProduction(world, started.transactionId)?.state).toBe('Cancelled');
  });
  it('grows a net four grain only after delivery and can then cook real meals', () => {
    const initial = createWorld('grain-to-meals');
    initial.inventory.grain.owned = 1;
    initial.inventory.meal.owned = 0;
    const grown = start(initial, 'farm.grain');
    let world = advanceTicks(grown.world, 500);
    expect(world.inventory.grain).toMatchObject({ owned: 5, reserved: 0 });
    const cooked = start(world, 'cook.meal', 'food.cook');
    world = advanceTicks(cooked.world, 400);
    expect(world.inventory.grain.owned).toBe(3);
    expect(world.inventory.meal.owned).toBe(3);
    expect(validateWorldState(reload(world))).toEqual([]);
  });
  it('test adapter recovers zero stocks, stops at modest batch goals, and preserves exact reload behavior', () => {
    let world = createWorld('sustained-food');
    world.inventory.grain.owned = 0;
    world.inventory.meal.owned = 0;
    let state: SectEconomyState = { ...createSectEconomyState(), enabled: true, plans: createStarterWorkPlans([world.disciples[1]!.id, world.disciples[2]!.id]) };
    for (let tick = 0; tick < 4500; tick += 1) {
      ({ world, state } = tickPlan(world, state));
      expect(world.clock.pauseReasons).not.toContain('error');
      if (tick === 777) {
        const continuous = tickPlan(world, state);
        const restored = tickPlan(reload(world), JSON.parse(JSON.stringify(state)) as SectEconomyState);
        expect(restored).toEqual(continuous);
      }
    }
    expect(world.inventory.grain.owned).toBeGreaterThanOrEqual(24);
    expect(world.inventory.grain.owned).toBeLessThanOrEqual(27);
    expect(world.inventory.meal.owned).toBe(18);
    expect(world.activeProductionTransactionIds).toEqual([]);
    const receiptCount = Object.keys(world.commandReceipts).length;
    const eventCount = world.events.length;
    for (let tick = 0; tick < 400; tick += 1) ({ world, state } = tickPlan(world, state));
    expect(Object.keys(world.commandReceipts)).toHaveLength(receiptCount);
    expect(world.events).toHaveLength(eventCount);
    expect(validateWorldState(world)).toEqual([]);
  }, 20_000); // Thousands of fresh mutable one-tick boundaries now include checked byte accounting.
  it('never steals a manual job, training disciple or expedition-owned worker', () => {
    let world = createWorld('food-availability');
    const started = start(world, 'craft.plank');
    world = started.world;
    world.cultivation.disciples[2]!.trainingMode = 'training';
    const state: SectEconomyState = { ...createSectEconomyState(), enabled: true, plans: createStarterWorkPlans([world.disciples[1]!.id, world.disciples[2]!.id]) };
    const result = tickPlan(world, state);
    expect(result.world.activeProductionTransactionIds).toEqual([started.transactionId]);
    expect(result.world.transactions[started.transactionId]?.recipeId).toBe('craft.plank');
    world.cultivation.disciples[2]!.trainingMode = 'duty';
    world.cultivation.disciples[2]!.activityOwner = { kind: 'expedition', runId: 'test:away', lockId: 'test:lock' };
    const locked = tickPlan(world, state);
    expect(locked.world.activeProductionTransactionIds).toEqual([started.transactionId]);
  });
  it('disabling automation lets an admitted job finish without replacing it', () => {
    let world = createWorld('disable-work-plan');
    let state: SectEconomyState = { ...createSectEconomyState(), enabled: true, plans: createStarterWorkPlans([world.disciples[1]!.id]) };
    ({ world, state } = tickPlan(world, state));
    const id = world.activeProductionTransactionIds[0]!;
    expect(id).toBeTruthy();
    state = { ...state, enabled: false };
    const receiptCount = Object.keys(world.commandReceipts).length;
    for (let tick = 0; tick < 500; tick += 1) ({ world, state } = tickPlan(world, state));
    expect(lookupProduction(world, id)?.state).toBe('Committed');
    expect(world.activeProductionTransactionIds).toEqual([]);
    expect(Object.keys(world.commandReceipts)).toHaveLength(receiptCount);
    expect(validateWorldState(world)).toEqual([]);
  });
});
