import { automaticWorkContext, startAutomaticProduction } from '../economy/automatic-production';
import { getRecipe } from '../economy/recipes';
import { RESOURCE_IDS, type ResourceLine } from '../economy/types';
import { planAutomaticWork } from '../sect-economy/planner';
import { applySectEconomyCommand } from '../sect-economy/state';
import type { SectEconomyCommand } from '../sect-economy/types';
import { MAX_AUTO_STARTS_PER_DECISION } from '../sect-economy/types';
import { assessWorldProgressionCapacity } from './progression-capacity';
import type { WorldProgressionCapacity } from './progression-capacity';
import type { WorldStateV8 } from './v8-types';
/** Cache at the owned immutable Session World identity, not a mutable global key. */
export function previewWorldAutomaticWorkV8(world: WorldStateV8) {
  const context = automaticWorkContext(world, 0); let budget: WorldProgressionCapacity | null = null;
  if (world.sectEconomy.enabled && !world.automaticProduction.activationReviewRequired && !context.paused && context.mode === 'management'
    && world.clock.simulationTick >= world.sectEconomy.nextDecisionTick && (!world.expedition.run || world.expedition.run.phase === 'Ended')) budget = assessWorldProgressionCapacity(world, MAX_AUTO_STARTS_PER_DECISION);
  const allowance = budget?.automaticStartAllowance ?? 0;
  const preview = planAutomaticWork(world.sectEconomy, { ...context, autoStartAllowance: allowance });
  const incoming: ResourceLine[] = RESOURCE_IDS.map(resourceId => ({ resourceId, quantity: context.activeJobs.reduce((sum, job) => {
    const quantity = getRecipe(job.recipeId)!.outputs.find(line => line.resourceId === resourceId)?.quantity ?? 0;
    return quantity > Number.MAX_SAFE_INTEGER - sum ? Number.MAX_SAFE_INTEGER : sum + quantity;
  }, 0) }));
  return { status: preview.status, blocked: preview.blocked, executionReady: true, activationReviewRequired: world.automaticProduction.activationReviewRequired,
    autoStartAllowance: allowance, incoming, budget };
}
export function tickWorldAutomaticWorkV8(world: WorldStateV8): WorldStateV8 {
  if (!world.sectEconomy.enabled || world.automaticProduction.activationReviewRequired || world.clock.mode !== 'management'
    || world.clock.pauseReasons.length || world.clock.simulationTick < world.sectEconomy.nextDecisionTick
    || world.expedition.run && world.expedition.run.phase !== 'Ended') return world;
  const preview = previewWorldAutomaticWorkV8(world);
  const decision = planAutomaticWork(world.sectEconomy, automaticWorkContext(world, preview.autoStartAllowance));
  let next = { ...world, sectEconomy: decision.state };
  for (const intent of decision.intents) { const admitted = startAutomaticProduction(next, intent); if (admitted.ok && assessWorldProgressionCapacity(admitted.world).fits) next = admitted.world; }
  return next;
}
export function dispatchWorldSectEconomyV8(world: WorldStateV8, command: SectEconomyCommand) {
  const applied = applySectEconomyCommand(world.sectEconomy, command, world.disciples.map(actor => actor.id));
  if (!applied.ok) return applied;
  return { ok: true as const, world: { ...world, sectEconomy: applied.state, automaticProduction: command.kind === 'enabled.set'
    ? { ...world.automaticProduction, activationReviewRequired: false } : world.automaticProduction },
    result: { kind: command.kind, workerId: command.kind === 'plan.set' ? command.plan.workerId : null } };
}
