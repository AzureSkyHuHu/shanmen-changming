import { lookupCommandReceipt } from './history-access';
import { automaticWorkContext, startAutomaticProduction, type AutomaticWorld } from '../economy/automatic-production';
import { getRecipe } from '../economy/recipes';
import { RESOURCE_IDS, type ResourceLine } from '../economy/types';
import { assessAutomaticWorkBudget, canonicalUtf8ByteLength, verifySaveCandidate, type AutomaticSaveBudgetAssessment, type AutomaticSaveBudgetInput } from '../save-budget';
import { planAutomaticWork } from '../sect-economy/planner';
import { MAX_AUTO_STARTS_PER_DECISION } from '../sect-economy/types';
import { WORLD_AUTO_START_ALLOWANCE } from './sect-economy-bridge';

export function worldAutomaticBudgetInput(world: AutomaticWorld, maximumNewStarts = 0): AutomaticSaveBudgetInput {
  return { world, map: world.map, liveAutomaticJobCount: Object.keys(world.automaticProduction.live).length,
    pendingCommands: world.pendingCommands.filter((command) => !lookupCommandReceipt(world, command.commandId)), maximumNewStarts, journalBytes: canonicalUtf8ByteLength(world.automaticProduction.journal),
    save: { saveVersion: 7 } };
}
/** Read-only projection. Planner returned state/intents are never applied by this query. */
export function previewWorldAutomaticWork(world: AutomaticWorld) {
  const executionReady = WORLD_AUTO_START_ALLOWANCE > 0;
  const context = automaticWorkContext(world, 0);
  let budget: AutomaticSaveBudgetAssessment | null = null;
  // Inactive, paused and not-yet-due views never walk the complete save. An
  // active due decision is the only case where a truthful allowance is needed.
  if (executionReady && world.sectEconomy.enabled && !world.automaticProduction.activationReviewRequired
    && !context.paused && context.mode === 'management' && world.clock.simulationTick >= world.sectEconomy.nextDecisionTick) {
    budget = assessAutomaticWorkBudget(worldAutomaticBudgetInput(world, MAX_AUTO_STARTS_PER_DECISION));
  }
  const allowance = budget ? Math.min(WORLD_AUTO_START_ALLOWANCE, budget.autoStartAllowance) : 0;
  const preview = planAutomaticWork(world.sectEconomy, { ...context, autoStartAllowance: allowance });
  const incoming: ResourceLine[] = RESOURCE_IDS.map((resourceId) => ({ resourceId, quantity: context.activeJobs.reduce((sum, job) => {
    const quantity = getRecipe(job.recipeId)!.outputs.find((line) => line.resourceId === resourceId)?.quantity ?? 0;
    return quantity > Number.MAX_SAFE_INTEGER - sum ? Number.MAX_SAFE_INTEGER : sum + quantity;
  }, 0) }));
  return { status: preview.status, blocked: preview.blocked, executionReady,
    activationReviewRequired: world.automaticProduction.activationReviewRequired, autoStartAllowance: allowance, incoming, budget };
}
/** Exactly one due decision, after player commands and cultivation expiry, before common production. */
export function tickWorldAutomaticWork(world: AutomaticWorld): AutomaticWorld {
  if (!world.sectEconomy.enabled || world.automaticProduction.activationReviewRequired || world.clock.mode !== 'management'
    || world.clock.pauseReasons.length > 0 || world.clock.simulationTick < world.sectEconomy.nextDecisionTick) return world;
  const budget = assessAutomaticWorkBudget(worldAutomaticBudgetInput(world, MAX_AUTO_STARTS_PER_DECISION));
  const decision = planAutomaticWork(world.sectEconomy, automaticWorkContext(world, Math.min(WORLD_AUTO_START_ALLOWANCE, budget.autoStartAllowance)));
  let next: AutomaticWorld = { ...world, sectEconomy: decision.state };
  for (const intent of decision.intents) {
    const admitted = startAutomaticProduction(next, intent);
    if (!admitted.ok) continue;
    // Check the complete live insertion and source-counter/notice deltas before exposing it.
    if (verifySaveCandidate(worldAutomaticBudgetInput(admitted.world)).ok) next = admitted.world;
  }
  return next;
}
