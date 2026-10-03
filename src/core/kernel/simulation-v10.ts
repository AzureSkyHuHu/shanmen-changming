import { createWorkPathBudget } from '../agents/work-navigation';
import { automaticWorkContext, startAutomaticProduction } from '../economy/automatic-production';
import { planAutomaticWork } from '../sect-economy/planner';
import { MAX_AUTO_STARTS_PER_DECISION } from '../sect-economy/types';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { reconcilePreparedV10Cultivation } from '../world/v10-cultivation-bridge';
import { prepareValidatedV10CultivationClock } from '../world/v10-cultivation-preparation';
import { captureValidatedV10PreparationSource, prepareV10SectStagesWithoutOptionalGrowth, tickV10LegacyProduction, tickV10SectStages } from '../world/v10-sect-bridge';
import { v10WorkerAvailable, v10WorkOwners } from '../world/v10-sect-frame';
import { isPaused } from './clock';
import { inspectUnregisteredWorldV10Records } from './validation';

/** Unchanged legacy automatic planner. There is no automatic sect research,
 * construction, upgrade or medicine request, and no headroom shortcut here. */
function prepareAutomatic(world: WorldStateV10): WorldStateV10 {
  if (!world.sectEconomy.enabled || world.automaticProduction.activationReviewRequired || isPaused(world.clock)
    || world.clock.simulationTick < world.sectEconomy.nextDecisionTick) return world;
  const context = automaticWorkContext(world, Math.min(MAX_AUTO_STARTS_PER_DECISION, 36 - v10WorkOwners(world).length));
  const decision = planAutomaticWork(world.sectEconomy, { ...context,
    workers: context.workers.map(worker => ({ ...worker, available: v10WorkerAvailable(world, worker.workerId) })) });
  let next = { ...world, sectEconomy: decision.state };
  for (const intent of decision.intents) {
    if (!v10WorkerAvailable(next, intent.workerId) || v10WorkOwners(next).length >= 36) continue;
    const started = startAutomaticProduction(next, intent);
    if (started.ok) next = started.world;
  }
  return next;
}
/** Fixed stage composition shared by the strict wrappers and private owned
 * factory. This function adds no source/candidate admission or trust policy. */
function prepareStages(source: WorldStateV10, growth: 'normal' | 'no-optional-growth'): WorldStateV10 {
  const preparation = prepareValidatedV10CultivationClock(source);
  if (!preparation.advanced) return source;
  let next = reconcilePreparedV10Cultivation(source, preparation);
  if (!isPaused(next.clock)) {
    const budget = createWorkPathBudget(next.clock.simulationTick);
    if (growth === 'normal') next = prepareAutomatic(next);
    next = growth === 'normal' ? tickV10SectStages(next, budget) : prepareV10SectStagesWithoutOptionalGrowth(next, budget);
    next = tickV10LegacyProduction(next, budget);
  }
  return next;
}
/** INTERNAL candidate-only stage helper. Never export through public barrels.
 * The only runtime caller is the private owned tick factory, which supplies its
 * own captured, restored-history, frozen, fully validated source and then MUST
 * isolate the result and run full candidate capacity and residual record checks.
 * Calling this helper grants no source, candidate, save or import admission.
 * There is no validator, callback, assessment, policy or trusted-source argument. */
export function prepareOwnedNormalTickStagesV10(source: WorldStateV10): WorldStateV10 {
  return prepareStages(source, 'normal');
}
/** INTERNAL candidate-only fixed alternative. Omit only automatic starts and
 * maintenance renewal; retain real funded work/lifecycle and saved settings. */
export function prepareOwnedNoOptionalGrowthTickStagesV10(source: WorldStateV10): WorldStateV10 {
  return prepareStages(source, 'no-optional-growth');
}
function prepareTick(original: WorldStateV10, growth: 'normal' | 'no-optional-growth'): WorldStateV10 {
  const source = captureValidatedV10PreparationSource(original);
  const next = growth === 'normal' ? prepareOwnedNormalTickStagesV10(source) : prepareOwnedNoOptionalGrowthTickStagesV10(source);
  // Even a paused caller is captured and completely source-validated first.
  // Preserve original caller identity, not the temporary restored snapshot.
  if (next === source) return original;
  const errors = inspectUnregisteredWorldV10Records(next);
  if (errors.length) throw new TypeError(errors[0]);
  return next;
}
/** INTERNAL root-owned-source preparation ONLY. The fixed complete source and
 * candidate RECORD inspectors do not certify the envelope or finite future
 * obligations. A later complete capacity gate must run before any publication.
 * Any failure leaves the entire supplied source unchanged. */
export function prepareNormalTickCandidateV10(world: WorldStateV10): WorldStateV10 {
  return prepareTick(world, 'normal');
}
/** Independently re-prepares the same unchanged source. Only legacy automatic
 * starts and maintenance renewals are omitted; already-funded work and lifecycle
 * reconciliation still run. It never saves disabled automatic/renewal settings. */
export function prepareNoOptionalGrowthTickCandidateV10(world: WorldStateV10): WorldStateV10 {
  return prepareTick(world, 'no-optional-growth');
}
