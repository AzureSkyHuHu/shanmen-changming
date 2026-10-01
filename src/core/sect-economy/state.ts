import { getRecipe } from '../economy/recipes';
import { assertNonNegativeInteger, isNonNegativeInteger } from '../kernel/numeric';
import { compareStable } from '../kernel/serialization';
import {
  AUTO_WORK_DECISION_TICKS, MAX_STOCK_TARGET, MAX_WORK_PLANS, MAX_WORK_PRIORITIES,
  SECT_ECONOMY_SCHEMA_VERSION, type DiscipleWorkPlan, type ProductionPriority,
  type SectEconomyCommand, type SectEconomyState, type SectEconomyTransition,
} from './types';

const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const workerIdValid = (value: unknown): value is string => typeof value === 'string' && /^entity:[1-9][0-9]*$/.test(value)
  && Number.isSafeInteger(Number(value.slice(7)));

function priorityValid(value: unknown): value is ProductionPriority {
  if (!object(value) || !exactKeys(value, ['recipeId', 'targetStock']) || typeof value.recipeId !== 'string'
    || !isNonNegativeInteger(value.targetStock) || value.targetStock > MAX_STOCK_TARGET) return false;
  const recipe = getRecipe(value.recipeId);
  if (!recipe || recipe.outputs.length !== 1) return false;
  const output = recipe.outputs[0]!;
  const ownInput = recipe.inputs.find((line) => line.resourceId === output.resourceId)?.quantity ?? 0;
  return output.quantity > ownInput;
}
function planValid(value: unknown): value is DiscipleWorkPlan {
  return object(value) && exactKeys(value, ['workerId', 'enabled', 'priorities']) && workerIdValid(value.workerId)
    && typeof value.enabled === 'boolean' && Array.isArray(value.priorities)
    && value.priorities.length <= MAX_WORK_PRIORITIES && value.priorities.every(priorityValid)
    && new Set(value.priorities.map((priority) => priority.recipeId)).size === value.priorities.length;
}
const copyPlan = (plan: DiscipleWorkPlan): DiscipleWorkPlan => ({ ...plan, priorities: plan.priorities.map((priority) => ({ ...priority })) });

/** Migration/default constructor intentionally does not enable any automatic behavior. */
export function createSectEconomyState(simulationTick = 0): SectEconomyState {
  assertNonNegativeInteger(simulationTick, 'economy simulation tick');
  return { schemaVersion: SECT_ECONOMY_SCHEMA_VERSION, enabled: false, nextDecisionTick: simulationTick, plans: [] };
}

/** Opt-in new-campaign suggestion. Caller supplies only eligible adult duty workers. */
export function createStarterWorkPlans(adultDutyWorkerIds: readonly string[]): DiscipleWorkPlan[] {
  if (adultDutyWorkerIds.length > MAX_WORK_PLANS || !adultDutyWorkerIds.every(workerIdValid)
    || new Set(adultDutyWorkerIds).size !== adultDutyWorkerIds.length) throw new TypeError('Invalid starter work roster');
  const workers = [...adultDutyWorkerIds].sort(compareStable);
  const farmer = workers[0];
  const cook = workers[1];
  if (!farmer) return [];
  const grainPriorities: ProductionPriority[] = [{ recipeId: 'farm.grain', targetStock: 24 }, { recipeId: 'gather.grain', targetStock: 24 }];
  // A lone adult alternates cooking and seed recovery instead of being assigned an impossible second role.
  if (!cook) return [{ workerId: farmer, enabled: true, priorities: [{ recipeId: 'cook.meal', targetStock: 18 }, ...grainPriorities] }];
  return [
    { workerId: farmer, enabled: true, priorities: grainPriorities },
    { workerId: cook, enabled: true, priorities: [{ recipeId: 'cook.meal', targetStock: 18 }] },
  ];
}

export function isSectEconomyCommand(value: unknown): value is SectEconomyCommand {
  return object(value) && (value.kind === 'enabled.set'
    ? exactKeys(value, ['kind', 'enabled']) && typeof value.enabled === 'boolean'
    : value.kind === 'plan.set' && exactKeys(value, ['kind', 'plan']) && planValid(value.plan));
}

/** World owns command receipts and idempotency; this transition only replaces bounded configuration. */
export function applySectEconomyCommand(state: SectEconomyState, command: unknown, knownWorkerIds: readonly string[]): SectEconomyTransition {
  if (!isSectEconomyCommand(command)) return { ok: false, code: 'INVALID_COMMAND' };
  if (command.kind === 'enabled.set') return { ok: true, state: { ...state, enabled: command.enabled } };
  if (!knownWorkerIds.includes(command.plan.workerId)) return { ok: false, code: 'UNKNOWN_WORKER' };
  const otherPlans = state.plans.filter((plan) => plan.workerId !== command.plan.workerId);
  if (otherPlans.length >= MAX_WORK_PLANS) return { ok: false, code: 'PLAN_LIMIT' };
  return { ok: true, state: { ...state, plans: [...otherPlans, copyPlan(command.plan)].sort((a, b) => compareStable(a.workerId, b.workerId)) } };
}

/** Strict additive schema boundary. Unknown fields/recipes and stale worker identities are rejected. */
export function validateSectEconomyState(value: unknown, knownWorkerIds: readonly string[], simulationTick: number): string[] {
  if (!isNonNegativeInteger(simulationTick) || !object(value)
    || !exactKeys(value, ['schemaVersion', 'enabled', 'nextDecisionTick', 'plans'])
    || value.schemaVersion !== SECT_ECONOMY_SCHEMA_VERSION || typeof value.enabled !== 'boolean'
    || !isNonNegativeInteger(value.nextDecisionTick)
    || value.nextDecisionTick - simulationTick > AUTO_WORK_DECISION_TICKS
    || !Array.isArray(value.plans) || value.plans.length > MAX_WORK_PLANS || !value.plans.every(planValid)) return ['Invalid sect economy state'];
  if (new Set(value.plans.map((plan) => plan.workerId)).size !== value.plans.length) return ['Duplicate disciple work plans'];
  if (value.plans.some((plan) => !knownWorkerIds.includes(plan.workerId))) return ['Unknown work plan disciple'];
  return [];
}
