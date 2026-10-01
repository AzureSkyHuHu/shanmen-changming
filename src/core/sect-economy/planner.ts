import { availableResource } from '../economy/inventory';
import { getRecipe } from '../economy/recipes';
import { RESOURCE_IDS, type ResourceId } from '../economy/types';
import { assertNonNegativeInteger, checkedAdd } from '../kernel/numeric';
import { compareStable } from '../kernel/serialization';
import { validateSectEconomyState } from './state';
import {
  AUTO_WORK_DECISION_TICKS, MAX_AUTO_STARTS_PER_DECISION, MAX_WORK_PLANS,
  type AutomaticWorkContext, type AutomaticWorkDecision, type AutomaticWorkStatus,
  type SectEconomyState, type WorkPlanBlocker,
} from './types';

type ResourceTotals = Record<ResourceId, number>;
const totals = (read: (id: ResourceId) => number): ResourceTotals => Object.fromEntries(RESOURCE_IDS.map((id) => [id, read(id)])) as ResourceTotals;
// A projection is only an upper-bound comparison, never an inventory credit. Saturation stays conservative.
const boundedAdd = (left: number, right: number): number => right > Number.MAX_SAFE_INTEGER - left ? Number.MAX_SAFE_INTEGER : left + right;

/**
 * Computes proposals only: no inventory, position, reservation, receipt or sequence mutation.
 * World must recheck admission and execute each proposal through its authoritative production path.
 */
export function planAutomaticWork(state: SectEconomyState, context: AutomaticWorkContext): AutomaticWorkDecision {
  assertNonNegativeInteger(context.simulationTick, 'automatic work tick');
  assertNonNegativeInteger(context.autoStartAllowance, 'automatic work allowance');
  const unchanged = (status: AutomaticWorkStatus): AutomaticWorkDecision => ({ state, intents: [], blocked: [], status });
  if (!state.enabled) return unchanged('DISABLED');
  if (context.paused) return unchanged('PAUSED');
  if (context.mode !== 'management') return unchanged('NOT_MANAGEMENT');
  if (context.simulationTick < state.nextDecisionTick) return unchanged('COOLDOWN');
  if (context.workers.length > MAX_WORK_PLANS || context.activeJobs.length > MAX_WORK_PLANS
    || new Set(context.workers.map((worker) => worker.workerId)).size !== context.workers.length
    || new Set(context.activeJobs.map((job) => job.workerId)).size !== context.activeJobs.length
    || validateSectEconomyState(state, context.workers.map((worker) => worker.workerId), context.simulationTick).length) {
    throw new TypeError('Invalid automatic work context/state');
  }
  const nextState = { ...state, nextDecisionTick: checkedAdd(context.simulationTick, AUTO_WORK_DECISION_TICKS) };
  const decision: AutomaticWorkDecision = { state: nextState, intents: [], blocked: [], status: 'IDLE' };
  if (context.autoStartAllowance === 0) return { ...decision, status: 'HISTORY_LIMIT' };

  const available = totals((id) => availableResource(context.inventory[id]));
  const incoming = totals(() => 0);
  const physicalOwned = totals((id) => context.inventory[id].owned);
  const occupied = new Set<string>();
  for (const job of context.activeJobs) {
    const recipe = getRecipe(job.recipeId);
    if (!recipe || !['Running', 'Blocked'].includes(job.state)) throw new TypeError('Automatic work context contains an invalid live job');
    occupied.add(job.workerId);
    for (const output of recipe.outputs) incoming[output.resourceId] = boundedAdd(incoming[output.resourceId], output.quantity);
  }
  const projected = totals((id) => boundedAdd(available[id], incoming[id]));
  const startLimit = Math.min(MAX_AUTO_STARTS_PER_DECISION, context.autoStartAllowance);
  const workers = new Map(context.workers.map((worker) => [worker.workerId, worker]));

  for (const plan of [...state.plans].sort((a, b) => compareStable(a.workerId, b.workerId))) {
    const blocked = (reason: WorkPlanBlocker['reason']): void => { decision.blocked.push({ workerId: plan.workerId, reason }); };
    if (!plan.enabled) { blocked('PLAN_DISABLED'); continue; }
    if (!workers.get(plan.workerId)?.available || occupied.has(plan.workerId)) { blocked('WORKER_UNAVAILABLE'); continue; }
    if (plan.priorities.length === 0) { blocked('NO_PRIORITIES'); continue; }
    if (decision.intents.length >= startLimit) { blocked('START_LIMIT'); continue; }
    if (!context.storageAvailable) { blocked('STORAGE_UNAVAILABLE'); continue; }
    let firstBlocker: WorkPlanBlocker | undefined;
    let selected = false;
    for (const priority of plan.priorities) {
      const recipe = getRecipe(priority.recipeId)!;
      const output = recipe.outputs[0]!;
      let blocker: WorkPlanBlocker | undefined;
      if (projected[output.resourceId] >= priority.targetStock) blocker = { workerId: plan.workerId, reason: 'TARGET_MET', recipeId: priority.recipeId, resourceId: output.resourceId };
      else if (!context.operationalWorkstations.includes(recipe.workstation)) blocker = { workerId: plan.workerId, reason: 'WORKSTATION_UNAVAILABLE', recipeId: priority.recipeId };
      else {
        const missing = recipe.inputs.find((input) => available[input.resourceId] < input.quantity);
        if (missing) blocker = { workerId: plan.workerId, reason: 'MATERIALS_MISSING', recipeId: priority.recipeId, resourceId: missing.resourceId };
        else {
          // Do not assume another job consumes its inputs before these outputs arrive.
          const full = recipe.outputs.find((candidate) => {
            const ownInput = recipe.inputs.find((input) => input.resourceId === candidate.resourceId)?.quantity ?? 0;
            const room = context.inventory[candidate.resourceId].capacity - (physicalOwned[candidate.resourceId] - ownInput);
            return candidate.quantity > room || incoming[candidate.resourceId] > room - candidate.quantity;
          });
          if (full) blocker = { workerId: plan.workerId, reason: 'CAPACITY_FULL', recipeId: priority.recipeId, resourceId: full.resourceId };
        }
      }
      if (blocker) {
        // A satisfied earlier priority must not hide why an unmet later priority cannot start.
        if (!firstBlocker || firstBlocker.reason === 'TARGET_MET' && blocker.reason !== 'TARGET_MET') firstBlocker = blocker;
        continue;
      }
      decision.intents.push({ workerId: plan.workerId, recipeId: priority.recipeId });
      occupied.add(plan.workerId);
      for (const input of recipe.inputs) {
        available[input.resourceId] -= input.quantity;
        projected[input.resourceId] -= input.quantity;
      }
      for (const result of recipe.outputs) {
        incoming[result.resourceId] = boundedAdd(incoming[result.resourceId], result.quantity);
        projected[result.resourceId] = boundedAdd(projected[result.resourceId], result.quantity);
      }
      selected = true;
      break;
    }
    if (!selected && firstBlocker) decision.blocked.push(firstBlocker);
  }
  decision.status = decision.intents.length ? 'SCHEDULED' : 'IDLE';
  return decision;
}
