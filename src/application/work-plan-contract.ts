import type { ProductionPriority, SectEconomyCommand } from '../core/sect-economy/types';
import { canonicalStringify } from '../core/kernel/serialization';

export interface WorkPlanEditGuard {
  sessionEpoch: number;
  workerId: string | null;
  expectedPlan: string | null;
  expectedEnabled: boolean;
}
type Plan = { readonly workerId: string; readonly enabled: boolean; readonly priorities: readonly Readonly<ProductionPriority>[] };
export function workPlanSignature(plan: Plan | undefined): string | null {
  return plan ? canonicalStringify({ workerId: plan.workerId, enabled: plan.enabled, priorities: plan.priorities }) : null;
}
/** UI drafts are guarded against the current authority, not merely their last rendered props. */
export function matchesWorkPlanGuard(state: { readonly enabled: boolean; readonly plans: readonly Plan[] }, epoch: number, command: SectEconomyCommand, guard: WorkPlanEditGuard): boolean {
  if (guard.sessionEpoch !== epoch) return false;
  if (command.kind === 'enabled.set') return guard.workerId === null && guard.expectedPlan === null && guard.expectedEnabled === state.enabled;
  return guard.workerId === command.plan.workerId && guard.expectedPlan === workPlanSignature(state.plans.find(plan => plan.workerId === command.plan.workerId));
}
