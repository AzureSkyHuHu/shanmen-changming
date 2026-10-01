import type { InventoryLedger, ProductionTransaction, RecipeDefinition, ResourceId } from '../economy/types';
import type { SimulationMode } from '../kernel/clock';

export const SECT_ECONOMY_SCHEMA_VERSION = 1;
export const MAX_WORK_PLANS = 36;
export const MAX_WORK_PRIORITIES = 6;
export const MAX_STOCK_TARGET = 999;
export const AUTO_WORK_DECISION_TICKS = 20;
export const MAX_AUTO_STARTS_PER_DECISION = 2;

export interface ProductionPriority {
  recipeId: string;
  /** Goal for available stock plus all live output promises, in output resource units. */
  targetStock: number;
}
export interface DiscipleWorkPlan {
  workerId: string;
  enabled: boolean;
  /** Earlier entries have priority. Zero targets disable an individual recipe. */
  priorities: ProductionPriority[];
}
export interface SectEconomyState {
  schemaVersion: typeof SECT_ECONOMY_SCHEMA_VERSION;
  enabled: boolean;
  nextDecisionTick: number;
  plans: DiscipleWorkPlan[];
}
export type SectEconomyCommand =
  | { kind: 'enabled.set'; enabled: boolean }
  | { kind: 'plan.set'; plan: DiscipleWorkPlan };
export type SectEconomyError = 'INVALID_COMMAND' | 'UNKNOWN_WORKER' | 'PLAN_LIMIT';
export type SectEconomyTransition = { ok: true; state: SectEconomyState }
  | { ok: false; code: SectEconomyError };

export interface AutomaticWorkContext {
  simulationTick: number;
  mode: SimulationMode;
  paused: boolean;
  inventory: InventoryLedger;
  /** Availability must include age, duty, activity owner, death, travel and existing commitments. */
  workers: readonly { workerId: string; available: boolean }[];
  /** Only live jobs. Manual and automatic jobs are equally authoritative output promises. */
  activeJobs: readonly Pick<ProductionTransaction, 'recipeId' | 'workerId' | 'state'>[];
  operationalWorkstations: readonly RecipeDefinition['workstation'][];
  storageAvailable: boolean;
  /** Ephemeral World-owned retention budget. Zero is the fail-closed integration default. */
  autoStartAllowance: number;
}
export interface AutomaticProductionIntent { workerId: string; recipeId: string }
export type WorkPlanBlockedReason = 'PLAN_DISABLED' | 'WORKER_UNAVAILABLE' | 'NO_PRIORITIES'
  | 'TARGET_MET' | 'MATERIALS_MISSING' | 'CAPACITY_FULL' | 'WORKSTATION_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE' | 'START_LIMIT';
export interface WorkPlanBlocker {
  workerId: string;
  reason: WorkPlanBlockedReason;
  recipeId?: string;
  resourceId?: ResourceId;
}
export type AutomaticWorkStatus = 'DISABLED' | 'PAUSED' | 'NOT_MANAGEMENT' | 'COOLDOWN'
  | 'HISTORY_LIMIT' | 'SCHEDULED' | 'IDLE';
export interface AutomaticWorkDecision {
  state: SectEconomyState;
  intents: AutomaticProductionIntent[];
  /** Ephemeral diagnostics; do not append them to historical events each decision. */
  blocked: WorkPlanBlocker[];
  status: AutomaticWorkStatus;
}
