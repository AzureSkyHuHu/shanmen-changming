import { describe, expect, it } from 'vitest';
import { createInventory } from '../../src/core/economy/inventory';
import { LEGACY_V4_RECIPE_IDS, STARTER_RECIPES } from '../../src/core/economy/recipes';
import {
  AUTO_WORK_DECISION_TICKS, MAX_AUTO_STARTS_PER_DECISION, applySectEconomyCommand,
  createSectEconomyState, createStarterWorkPlans, isSectEconomyCommand, planAutomaticWork,
  validateSectEconomyState, type AutomaticWorkContext, type DiscipleWorkPlan, type SectEconomyState,
} from '../../src/core/sect-economy';

const plan = (workerId = 'entity:2', recipeId = 'farm.grain', targetStock = 24): DiscipleWorkPlan => ({
  workerId, enabled: true, priorities: [{ recipeId, targetStock }],
});
const state = (plans: DiscipleWorkPlan[] = [plan()]): SectEconomyState => ({ ...createSectEconomyState(), enabled: true, plans });
function context(overrides: Partial<AutomaticWorkContext> = {}): AutomaticWorkContext {
  return {
    simulationTick: 0, mode: 'management', paused: false, inventory: createInventory(),
    workers: ['entity:2', 'entity:3', 'entity:4'].map((workerId) => ({ workerId, available: true })),
    activeJobs: [], operationalWorkstations: ['forest', 'herb-garden', 'kitchen', 'workshop'],
    storageAvailable: true, autoStartAllowance: 2, ...overrides,
  };
}

describe('bounded serialized work plans', () => {
  it('defaults to disabled empty plans and proposes a modest optional adult plan', () => {
    expect(createSectEconomyState(31)).toEqual({ schemaVersion: 1, enabled: false, nextDecisionTick: 31, plans: [] });
    expect(createStarterWorkPlans(['entity:3', 'entity:2'])).toEqual([
      { workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'farm.grain', targetStock: 24 }, { recipeId: 'gather.grain', targetStock: 24 }] },
      { workerId: 'entity:3', enabled: true, priorities: [{ recipeId: 'cook.meal', targetStock: 18 }] },
    ]);
    expect(createStarterWorkPlans(['entity:2'])[0]?.priorities.map((entry) => entry.recipeId)).toEqual(['cook.meal', 'farm.grain', 'gather.grain']);
    expect(createStarterWorkPlans([])).toEqual([]);
    expect(() => createStarterWorkPlans(['entity:2', 'entity:2'])).toThrow();
    expect(() => createSectEconomyState(-1)).toThrow();
  });
  it('accepts bounded strict commands and detaches caller-owned priorities', () => {
    const input = { kind: 'plan.set' as const, plan: plan() };
    const original = createSectEconomyState();
    const result = applySectEconomyCommand(original, input, ['entity:2']);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    input.plan.priorities[0]!.targetStock = 999;
    expect(result.state.plans[0]?.priorities[0]?.targetStock).toBe(24);
    expect(original.plans).toEqual([]);
    expect(result.state.enabled).toBe(false);
    expect(applySectEconomyCommand(result.state, { kind: 'enabled.set', enabled: true }, ['entity:2'])).toMatchObject({ ok: true, state: { enabled: true } });
    expect(applySectEconomyCommand(original, { kind: 'plan.set', plan: plan('entity:99') }, ['entity:2'])).toEqual({ ok: false, code: 'UNKNOWN_WORKER' });
  });
  it.each([
    { kind: 'enabled.set', enabled: 'yes' },
    { kind: 'enabled.set', enabled: true, extra: true },
    { kind: 'plan.set', plan: { ...plan(), extra: true } },
    { kind: 'plan.set', plan: plan('constructor') },
    { kind: 'plan.set', plan: plan('entity:9007199254740992') },
    { kind: 'plan.set', plan: plan('entity:2', 'unknown.recipe') },
    { kind: 'plan.set', plan: plan('entity:2', 'cook.meal', -1) },
    { kind: 'plan.set', plan: plan('entity:2', 'cook.meal', 1000) },
    { kind: 'plan.set', plan: plan('entity:2', 'cook.meal', 2.5) },
    { kind: 'plan.set', plan: { ...plan(), priorities: [{ recipeId: 'farm.grain', targetStock: 24 }, { recipeId: 'farm.grain', targetStock: 25 }] } },
    { kind: 'plan.set', plan: { ...plan(), priorities: [{ recipeId: 'farm.grain', targetStock: 24, executable: 'no' }] } },
  ])('rejects malformed configuration %#', (command) => {
    expect(isSectEconomyCommand(command)).toBe(false);
    expect(applySectEconomyCommand(createSectEconomyState(), command, ['entity:2'])).toEqual({ ok: false, code: 'INVALID_COMMAND' });
  });
  it('validates serialized timing, unique workers, known identities and exact fields', () => {
    const saved = JSON.parse(JSON.stringify(state()));
    expect(validateSectEconomyState(saved, ['entity:2'], 0)).toEqual([]);
    expect(validateSectEconomyState({ ...saved, nextDecisionTick: 21 }, ['entity:2'], 0)).not.toEqual([]);
    expect(validateSectEconomyState({ ...saved, nextDecisionTick: 20 }, ['entity:2'], 0)).toEqual([]);
    expect(validateSectEconomyState({ ...saved, nextDecisionTick: 0 }, ['entity:2'], 1000)).toEqual([]);
    expect(validateSectEconomyState({ ...saved, plans: [plan(), plan()] }, ['entity:2'], 0)).toEqual(['Duplicate disciple work plans']);
    expect(validateSectEconomyState(saved, [], 0)).toEqual(['Unknown work plan disciple']);
    expect(validateSectEconomyState({ ...saved, allowance: 999 }, ['entity:2'], 0)).not.toEqual([]);
    expect(validateSectEconomyState({ ...saved, schemaVersion: 2 }, ['entity:2'], 0)).not.toEqual([]);
    expect(validateSectEconomyState({ ...saved, plans: Array.from({ length: 37 }, (_, index) => plan(`entity:${index + 1}`)) }, [], 0)).not.toEqual([]);
  });
  it('keeps the old recipe identity set frozen and existing cooking costs unchanged', () => {
    expect(LEGACY_V4_RECIPE_IDS).toEqual(['gather.wood', 'gather.herbs', 'cook.meal', 'craft.plank']);
    expect(Object.isFrozen(LEGACY_V4_RECIPE_IDS)).toBe(true);
    expect(STARTER_RECIPES['cook.meal']).toMatchObject({ inputs: [{ resourceId: 'grain', quantity: 2 }], outputs: [{ resourceId: 'meal', quantity: 3 }], workTicks: 80 });
    expect(STARTER_RECIPES['farm.grain']).toMatchObject({ inputs: [{ resourceId: 'grain', quantity: 1 }], outputs: [{ resourceId: 'grain', quantity: 5 }], workstation: 'herb-garden', workTicks: 240 });
    expect(STARTER_RECIPES['gather.grain']).toMatchObject({ inputs: [], outputs: [{ resourceId: 'grain', quantity: 1 }], workstation: 'forest' });
  });
});

describe('pure deterministic automatic production admission', () => {
  it('stays bounded by both the per-decision limit and shared transient history allowance', () => {
    const plans = [plan('entity:4', 'gather.wood', 99), plan('entity:3', 'gather.herbs', 99), plan('entity:2')];
    const two = planAutomaticWork(state(plans), context());
    expect(two.intents).toHaveLength(MAX_AUTO_STARTS_PER_DECISION);
    expect(two.intents.map((intent) => intent.workerId)).toEqual(['entity:2', 'entity:3']);
    expect(two.blocked).toContainEqual({ workerId: 'entity:4', reason: 'START_LIMIT' });
    expect(planAutomaticWork(state(plans), context({ autoStartAllowance: 1 })).intents).toHaveLength(1);
    expect(planAutomaticWork(state(plans), context({ autoStartAllowance: 999 })).intents).toHaveLength(2);
    expect(planAutomaticWork(state(plans), context({ autoStartAllowance: 0 }))).toMatchObject({ intents: [], blocked: [], status: 'HISTORY_LIMIT' });
  });
  it('persists its decision deadline and does not catch up missed decisions in a burst', () => {
    const first = planAutomaticWork(state(), context());
    expect(first.state.nextDecisionTick).toBe(AUTO_WORK_DECISION_TICKS);
    expect(planAutomaticWork(first.state, context({ simulationTick: 19 }))).toMatchObject({ status: 'COOLDOWN', intents: [] });
    const loaded = JSON.parse(JSON.stringify(first.state)) as SectEconomyState;
    expect(planAutomaticWork(loaded, context({ simulationTick: 20 }))).toEqual(planAutomaticWork(first.state, context({ simulationTick: 20 })));
    expect(planAutomaticWork(first.state, context({ simulationTick: 1000 })).state.nextDecisionTick).toBe(1020);
    expect(() => planAutomaticWork({ ...state(), nextDecisionTick: Number.MAX_SAFE_INTEGER }, context({ simulationTick: Number.MAX_SAFE_INTEGER }))).toThrow();
  });
  it('does not alter state while disabled, paused, in combat or inside the decision interval', () => {
    const disabled = createSectEconomyState();
    expect(planAutomaticWork(disabled, context()).state).toBe(disabled);
    const enabled = state();
    expect(planAutomaticWork(enabled, context({ paused: true }))).toMatchObject({ status: 'PAUSED', intents: [] });
    expect(planAutomaticWork(enabled, context({ mode: 'combat' }))).toMatchObject({ status: 'NOT_MANAGEMENT', intents: [] });
    expect(planAutomaticWork(enabled, context({ paused: true })).state).toBe(enabled);
  });
  it('deduplicates active worker ownership and honors all supplied availability locks', () => {
    const plans = [plan('entity:2'), plan('entity:3', 'gather.wood', 99), { ...plan('entity:4'), enabled: false }];
    const result = planAutomaticWork(state(plans), context({
      workers: [{ workerId: 'entity:2', available: true }, { workerId: 'entity:3', available: false }, { workerId: 'entity:4', available: true }],
      activeJobs: [{ workerId: 'entity:2', recipeId: 'craft.plank', state: 'Blocked' }],
    }));
    expect(result.intents).toEqual([]);
    expect(result.blocked).toEqual([
      { workerId: 'entity:2', reason: 'WORKER_UNAVAILABLE' },
      { workerId: 'entity:3', reason: 'WORKER_UNAVAILABLE' },
      { workerId: 'entity:4', reason: 'PLAN_DISABLED' },
    ]);
  });
  it('recovers from zero grain by foraging without first needing food or seed', () => {
    const input = context();
    input.inventory.grain.owned = 0;
    const plans = createStarterWorkPlans(['entity:2', 'entity:3']);
    const before = JSON.stringify(input);
    const result = planAutomaticWork(state(plans), input);
    expect(result.intents).toEqual([{ workerId: 'entity:2', recipeId: 'gather.grain' }]);
    expect(result.blocked).toContainEqual({ workerId: 'entity:3', reason: 'MATERIALS_MISSING', recipeId: 'cook.meal', resourceId: 'grain' });
    expect(JSON.stringify(input)).toBe(before);
  });
  it('counts all live output promises, including manual blocked jobs, against targets', () => {
    const input = context({ activeJobs: [{ workerId: 'entity:4', recipeId: 'farm.grain', state: 'Blocked' }] });
    input.inventory.grain.reserved = 1;
    expect(planAutomaticWork(state(), input)).toMatchObject({ intents: [], blocked: [{ workerId: 'entity:2', reason: 'TARGET_MET' }] });
    input.inventory.grain.owned = 19;
    expect(planAutomaticWork(state(), input).intents).toEqual([{ workerId: 'entity:2', recipeId: 'farm.grain' }]);
  });
  it('updates projected outputs and seed reservations between candidates to avoid extra work', () => {
    const result = planAutomaticWork(state([plan('entity:2'), plan('entity:3')]), context());
    expect(result.intents).toEqual([{ workerId: 'entity:2', recipeId: 'farm.grain' }]);
    const scarce = context();
    scarce.inventory.grain.owned = 2;
    const competing = planAutomaticWork(state([plan('entity:2', 'cook.meal', 18), plan('entity:3', 'cook.meal', 18)]), scarce);
    expect(competing.intents).toHaveLength(1);
    expect(competing.blocked).toContainEqual({ workerId: 'entity:3', reason: 'MATERIALS_MISSING', recipeId: 'cook.meal', resourceId: 'grain' });
  });
  it('will not spend undelivered output promises as input materials', () => {
    const input = context({ activeJobs: [{ workerId: 'entity:4', recipeId: 'farm.grain', state: 'Running' }] });
    input.inventory.grain.owned = 1;
    input.inventory.grain.reserved = 1;
    expect(planAutomaticWork(state([plan('entity:2', 'cook.meal', 18)]), input)).toMatchObject({ intents: [], blocked: [{ reason: 'MATERIALS_MISSING' }] });
  });
  it('uses only this batch’s own input debit in capacity admission, never another job’s debit', () => {
    const input = context();
    input.inventory.grain.capacity = 24;
    expect(planAutomaticWork(state(), input).intents).toHaveLength(1); // 20 - 1 + 5 = 24
    input.inventory.grain.capacity = 23;
    expect(planAutomaticWork(state(), input)).toMatchObject({ intents: [], blocked: [{ reason: 'CAPACITY_FULL' }] });
    input.inventory.grain.capacity = 25;
    input.inventory.grain.reserved = 2;
    input.activeJobs = [{ workerId: 'entity:4', recipeId: 'cook.meal', state: 'Running' }];
    const forage = state([plan('entity:2', 'gather.grain', 24)]);
    input.inventory.grain.owned = 25;
    expect(planAutomaticWork(forage, input)).toMatchObject({ intents: [], blocked: [{ reason: 'CAPACITY_FULL' }] });
  });
  it('reserves output headroom for every proposed and active batch', () => {
    const input = context();
    input.inventory.meal.capacity = 13;
    const result = planAutomaticWork(state([plan('entity:2', 'cook.meal', 18), plan('entity:3', 'cook.meal', 18)]), input);
    expect(result.intents).toHaveLength(1);
    expect(result.blocked).toContainEqual({ workerId: 'entity:3', reason: 'CAPACITY_FULL', recipeId: 'cook.meal', resourceId: 'meal' });
  });
  it('can choose a smaller forage batch when planting would exceed capacity', () => {
    const input = context();
    input.inventory.grain.owned = 22;
    input.inventory.grain.capacity = 24;
    const result = planAutomaticWork(state(createStarterWorkPlans(['entity:2', 'entity:3']).slice(0, 1)), input);
    expect(result.intents).toEqual([{ workerId: 'entity:2', recipeId: 'gather.grain' }]);
  });
  it('bounds a full 36-disciple roster without starting more than two jobs', () => {
    const workerIds = Array.from({ length: 36 }, (_, index) => `entity:${index + 1}`);
    const input = context({ workers: workerIds.map((workerId) => ({ workerId, available: true })) });
    const result = planAutomaticWork(state(workerIds.map((workerId) => plan(workerId, 'gather.wood', 99))), input);
    expect(result.intents).toHaveLength(2);
    expect(result.blocked).toHaveLength(34);
    expect(() => planAutomaticWork(state(), context({ workers: Array.from({ length: 37 }, (_, index) => ({ workerId: `entity:${index + 1}`, available: true })) }))).toThrow();
  });
  it('skips absent workstations and storage without allocating any command or job', () => {
    expect(planAutomaticWork(state(), context({ operationalWorkstations: [] }))).toMatchObject({ intents: [], blocked: [{ reason: 'WORKSTATION_UNAVAILABLE' }] });
    expect(planAutomaticWork(state(), context({ storageAvailable: false }))).toMatchObject({ intents: [], blocked: [{ reason: 'STORAGE_UNAVAILABLE' }] });
    const fallback = state(createStarterWorkPlans(['entity:2']));
    const result = planAutomaticWork(fallback, context({ operationalWorkstations: ['forest'] }));
    expect(result.intents).toEqual([{ workerId: 'entity:2', recipeId: 'gather.grain' }]);
  });
  it('safely saturates comparisons near integer limits rather than overflowing real stock', () => {
    const input = context({ activeJobs: [{ workerId: 'entity:4', recipeId: 'farm.grain', state: 'Running' }] });
    input.inventory.grain = { resourceId: 'grain', owned: Number.MAX_SAFE_INTEGER, reserved: 1, capacity: Number.MAX_SAFE_INTEGER };
    expect(planAutomaticWork(state(), input)).toMatchObject({ intents: [], blocked: [{ reason: 'TARGET_MET' }] });
    expect(input.inventory.grain.owned).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('reports the first unmet priority blocker instead of hiding it behind a satisfied goal', () => {
    const input = context({ operationalWorkstations: ['kitchen', 'herb-garden'] });
    input.inventory.meal.owned = 18;
    input.inventory.grain.owned = 0;
    const result = planAutomaticWork(state(createStarterWorkPlans(['entity:2'])), input);
    expect(result).toMatchObject({ intents: [], blocked: [{ recipeId: 'farm.grain', reason: 'MATERIALS_MISSING' }] });
  });
  it('evaluates the same proposals regardless of collection insertion order', () => {
    const plans = [plan('entity:2'), plan('entity:3', 'cook.meal', 18)];
    const input = context();
    const normal = planAutomaticWork(state(plans), input);
    const reversed = planAutomaticWork(state([...plans].reverse()), { ...input, workers: [...input.workers].reverse(), operationalWorkstations: [...input.operationalWorkstations].reverse() });
    expect(reversed.intents).toEqual(normal.intents);
    expect(reversed.blocked).toEqual(normal.blocked);
  });
});
