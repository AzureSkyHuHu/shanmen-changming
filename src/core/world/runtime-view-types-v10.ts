/** Fixed internal v10 presentation protocol. DTOs are not save data, gate inputs
 * or capacity certificates. Unchanged DTO fragments share shape only with v9. */
import type { SectRecipeId, SectResourceLine } from '../../content/sect-v9/types';
import type { SectMaintenanceStatus } from '../sect-expansion/maintenance-types';
import type { SectResearchGateRef } from '../sect-expansion/research-gate-types';
import type { SectBuildingLevelEvidenceV10, SectProductionSiteProofV10, SectUpgradeCheckpointV10, SectUpgradeJobV10,
  SectUpgradePreviewV10 } from '../sect-expansion/upgrade-types';
import type { RuntimeInstanceErrorV10, RuntimeOperationV10 } from './runtime-instance-v10';
import type { RuntimeApplicationCommandV9, RuntimeBreakthroughPreviewV9, RuntimeBreakthroughRequestV9,
  RuntimeBuildViewV9, RuntimeCultivationViewV9, RuntimeExpansionJobV9, RuntimeExpansionTerminalV9,
  RuntimeExpansionViewV9, RuntimeFrameViewV9, RuntimePlacementPreviewV9, RuntimeSelectedCultivationV9 } from './runtime-view-types-v9';
import type { V10WorkOwner } from './v10-sect-frame';

export type RuntimeReadonlyV10<T> = T extends object ? { readonly [K in keyof T]: RuntimeReadonlyV10<T[K]> } : T;
export type RuntimeReadV10<T> = Omit<RuntimeOperationV10, 'ok' | 'error'> & (
  | { readonly ok: true; readonly error: null; readonly value: RuntimeReadonlyV10<T> }
  | { readonly ok: false; readonly error: RuntimeInstanceErrorV10 | 'invalid-query'; readonly value: null }
);
export const RUNTIME_VIEW_LIMITS_V10 = Object.freeze({ recentEvents: 5, recentTerminals: 8, teachingChoices: 64,
  livePeople: 36, activeJobs: 36, plannedBlueprints: 16, visibleBlueprints: 52, objects: 200,
  mapTiles: 256 * 256, equipmentChoices: 512, workPlans: 36, workPriorities: 6,
  decisions: 72, completedResearch: 2, recipes: 5, resourceLines: 11, upgradeCheckpoints: 2, cacheEntries: 4 });

export type RuntimeFrameViewV10 = Omit<RuntimeFrameViewV9, 'simulationVersion'> & { simulationVersion: '0.10.0' };
export type RuntimeSelectedCultivationV10 = Omit<RuntimeSelectedCultivationV9, 'workOwner'> & { workOwner: V10WorkOwner | null };
export type RuntimeCultivationViewV10 = Omit<RuntimeCultivationViewV9, 'selected' | 'summaries'> & {
  selected: RuntimeSelectedCultivationV10 | null;
  summaries: Array<Omit<RuntimeCultivationViewV9['summaries'][number], 'workOwner'> & { workOwner: V10WorkOwner | null }>;
};
/** Permanent build identity remains the frozen v9 .3 identity by contract. */
export type RuntimeBuildViewV10 = RuntimeBuildViewV9;
export type RuntimeBreakthroughRequestV10 = RuntimeBreakthroughRequestV9;
export type RuntimeBreakthroughPreviewV10 = Omit<RuntimeBreakthroughPreviewV9, 'workOwner'> & { workOwner: V10WorkOwner | null };
export type RuntimePlacementPreviewV10 = RuntimePlacementPreviewV9;
export type RuntimeApplicationCommandV10 = RuntimeApplicationCommandV9;
export interface RuntimeUpgradeRequestV10 { buildingId: string; workerId: string }
export type RuntimeUpgradePreviewV10 = SectUpgradePreviewV10 & { scope: 'upgrade-start-conditions' };

/** Only compact source references, never the producer's work/ledger evidence. */
export type RuntimeProductionSiteV10 = Pick<SectProductionSiteProofV10, 'kind' | 'siteId' | 'sourceJobId' | 'level'> & { upgradeJobId: string | null };
export interface RuntimeDoseSourceV10 { productionJobId: string; recipeId: SectRecipeId; site: RuntimeProductionSiteV10 }
/** Recorded work checkpoint joined to its actual paired-ledger consumption.
 * These are historical facts, not preview costs or a promised future refund. */
export type RuntimeUpgradeCheckpointV10 = Pick<SectUpgradeCheckpointV10, 'checkpointId' | 'activeTicks' | 'tick'> & {
  consumed: readonly SectResourceLine[];
};
export type RuntimeExpansionJobV10 = Exclude<RuntimeExpansionJobV9, { domain: 'production' | 'care' }>
  | (Extract<RuntimeExpansionJobV9, { domain: 'production' }> & { site: RuntimeProductionSiteV10 })
  | (Extract<RuntimeExpansionJobV9, { domain: 'care' }> & { doseSource: RuntimeDoseSourceV10 })
  | { domain: 'upgrade'; jobId: string; buildingId: string; workerId: string; fromLevel: 1; toLevel: 2;
    phase: SectUpgradeJobV10['phase']; activeTicks: number; requiredTicks: 400; blocked: SectUpgradeJobV10['blocked'];
    checkpoints: RuntimeUpgradeCheckpointV10[] };
export type RuntimeExpansionTerminalV10 = Omit<RuntimeExpansionTerminalV9, 'domain'> & {
  resultLevel: 1 | 2 | null; doseSource: RuntimeDoseSourceV10 | null;
} & (
  | { domain: 'upgrade'; consumed: readonly SectResourceLine[]; released: readonly SectResourceLine[] }
  | { domain: Exclude<RuntimeExpansionJobV10['domain'], 'upgrade'>; consumed?: never; released?: never }
);
export type RuntimeMaintenanceViewV10 = SectMaintenanceStatus & {
  paid: boolean;
  /** An upgrade never retroactively changes the rate of the current paid period. */
  currentPeriod: null | { paymentId: string | null; level: 1 | 2; upgradeJobId: string | null;
    paidTick: number; paidCalendarTick: number; dueCalendarTick: number };
  nextMaintenanceCosts: readonly SectResourceLine[];
};
export interface RuntimeRecipeViewV10 {
  recipeId: SectRecipeId; inputs: readonly SectResourceLine[]; outputs: readonly SectResourceLine[]; requiredTicks: number;
  researchGate: SectResearchGateRef | null; researchSatisfied: boolean; deficits: readonly SectResourceLine[];
  /** Eligible level/source and current payment only. Worker, navigation, capacity
   * and the full candidate are still checked when dispatching the command. */
  sites: Array<RuntimeProductionSiteV10 & { paid: boolean; operational: boolean; busy: boolean }>;
  scope: 'catalog-and-authenticated-sites';
}
export type RuntimeExpansionViewV10 = Omit<RuntimeExpansionViewV9, 'revisions' | 'buildings' | 'jobs' | 'workOwners' | 'recentTerminals'> & {
  revisions: RuntimeExpansionViewV9['revisions'] & { upgrade: number };
  buildings: Array<Omit<RuntimeExpansionViewV9['buildings'][number], 'maintenance'> & {
    levelEvidence: SectBuildingLevelEvidenceV10; activeUpgradeJobId: string | null; maintenance: RuntimeMaintenanceViewV10;
  }>;
  jobs: RuntimeExpansionJobV10[]; workOwners: V10WorkOwner[]; recentTerminals: RuntimeExpansionTerminalV10[];
  recipes: RuntimeRecipeViewV10[];
};
