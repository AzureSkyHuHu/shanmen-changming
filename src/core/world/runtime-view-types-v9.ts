/** Fixed internal view protocol. These DTOs are not save data or authority inputs. */
import type { GameContentIdentity } from '../../content/registry';
import type { SectBuildingId, SectRecipeId, SectResearchId, SectResourceId, SectResourceLine } from '../../content/sect-v9/types';
import type { BuildLoadout, BuildProgress } from '../builds/types';
import type { BreakthroughAttempt, BreakthroughPreparation, BreakthroughPreview, Cultivator, DeathCause } from '../cultivation/types';
import type { InventoryEntry, ProductionTransaction, ResourceId } from '../economy/types';
import type { WorldClock } from '../kernel/clock';
import type { DomainEvent } from '../kernel/contracts';
import type { ConstructionBlock, ConstructionPhase, ConstructionRejection } from '../sect-expansion/construction-types';
import type { SectCareJob } from '../sect-expansion/care-types';
import type { SectMaintenanceStatus } from '../sect-expansion/maintenance-types';
import type { SectResearchBlock, SectResearchPhase } from '../sect-expansion/research-types';
import type { SectFootprint, SectGeometryError, SectPlacementRequest } from '../sect-expansion/types';
import type { SectEconomyState } from '../sect-economy/types';
import type { RuntimeInstanceErrorV9, RuntimeOperationV9 } from './runtime-instance-v9';
import type { V9WorkOwner } from './v9-sect-bridge';
import type { WorldBuilding, WorldMap } from './types';
import type { WorldDiscipleV8 } from './v8-types';

export type RuntimeReadonlyV9<T> = T extends object ? { readonly [K in keyof T]: RuntimeReadonlyV9<T[K]> } : T;
export type RuntimeReadV9<T> = Omit<RuntimeOperationV9, 'ok' | 'error'> & (
  | { readonly ok: true; readonly error: null; readonly value: RuntimeReadonlyV9<T> }
  | { readonly ok: false; readonly error: RuntimeInstanceErrorV9; readonly value: null }
);
export type RuntimeClockControlV9 = { readonly kind: 'speed'; readonly speed: 1 | 3 }
  | { readonly kind: 'pause'; readonly reason: 'player' | 'hidden'; readonly paused: boolean };
export type RuntimeClockResultV9 = Omit<RuntimeOperationV9, 'ok' | 'error'> & (
  | { readonly ok: true; readonly error: null; readonly changed: boolean }
  | { readonly ok: false; readonly error: RuntimeInstanceErrorV9; readonly changed: false }
);

/** Presentation limits, never truncation of authority or persisted history. */
export const RUNTIME_VIEW_LIMITS_V9 = Object.freeze({ recentEvents: 5, recentTerminals: 8, teachingChoices: 64,
  livePeople: 36, activeJobs: 36, plannedBlueprints: 16, visibleBlueprints: 52, objects: 200,
  mapTiles: 256 * 256, equipmentChoices: 512, workPlans: 36, workPriorities: 6,
  decisions: 72, completedResearch: 2, cacheEntries: 4 });
export interface RuntimeEventViewV9 {
  eventId: string; kind: DomainEvent['kind']; tick: number;
  transactionId: string | null; workerId: string | null; recipeId: string | null; reason: string | null;
  discipleId: string | null; resourceId: ResourceId | null; quantity: number | null;
}
export type RuntimeProductionViewV9 = Pick<ProductionTransaction, 'transactionId' | 'recipeId' | 'workerId'
  | 'state' | 'activeTicks' | 'requiredTicks' | 'phase' | 'blockedReason'>;
export interface RuntimeFrameViewV9 {
  seed: string; simulationVersion: '0.9.0'; contentVersion: string; contentIdentity: GameContentIdentity;
  clock: WorldClock; calendar: { year: number; month: number; progress: number };
  /** Base terrain. Expansion's footprints identify active construction collisions. */
  map: WorldMap; disciples: WorldDiscipleV8[]; buildings: WorldBuilding[];
  resources: Array<InventoryEntry & { available: number }>;
  transactions: RuntimeProductionViewV9[]; recentEvents: RuntimeEventViewV9[];
  sectEconomy: SectEconomyState;
}
export interface RuntimeSelectedCultivationV9 extends Pick<Cultivator, 'discipleId' | 'realm' | 'cultivation'
  | 'understanding' | 'foundation' | 'mindset' | 'injury' | 'lifeState' | 'trainingMode' | 'heirId'> {
  requiredCultivation: number; remainingLifespanMonths: number; relicCount: number; activityLocked: boolean;
  workOwner: V9WorkOwner | null; workerAvailable: boolean;
  activeAttempt: (Pick<BreakthroughAttempt, 'attemptId' | 'phase' | 'completedMonths' | 'blockedMonths' | 'blockedReason' | 'outcome'> & { preview: BreakthroughPreview }) | null;
  pendingDeath: { deathId: string; cause: DeathCause; month: number } | null;
  deathRecord: { cause: DeathCause; month: number; beneficiaryId: string | null; transferredRelicCount: number } | null;
  lastOutcome: BreakthroughAttempt['outcome']; heirChoices: string[];
  teaching: Cultivator['teaching'];
  learning: { teacherId: string; knowledgeId: string; completedMonths: number; requiredMonths: number } | null;
  teachingChoices: Array<{ knowledgeId: string; studentIds: string[] }>; totalTeachableKnowledge: number;
}
export interface RuntimeCultivationViewV9 {
  revision: number; resourceStamp: string; selected: RuntimeSelectedCultivationV9 | null;
  summaries: Array<Pick<Cultivator, 'discipleId' | 'realm' | 'lifeState' | 'trainingMode' | 'activeAttemptId'> & {
    teaching: boolean; learning: boolean; away: boolean; workOwner: V9WorkOwner | null; workerAvailable: boolean;
  }>;
  decisions: Array<{ discipleId: string; kind: 'death' | 'breakthrough' }>;
}
export interface RuntimeBuildViewV9 {
  revision: number; contentIdentity: GameContentIdentity;
  selected: null | {
    discipleId: string; school: string; treeId: string; lifeState: Cultivator['lifeState']; locked: boolean;
    allocatedNodeIds: string[]; learnedSkillIds: string[]; loadout: BuildLoadout; progress: BuildProgress;
    equipment: Array<{ instanceId: string; definitionId: string }>;
  };
}
export type RuntimeExpansionJobV9 =
  | { domain: 'construction'; jobId: string; blueprintId: string; workerId: string; phase: ConstructionPhase; activeTicks: number; requiredTicks: number; blocked: ConstructionBlock }
  | { domain: 'production'; jobId: string; recipeId: SectRecipeId; workerId: string; phase: ProductionTransaction['phase']; activeTicks: number; requiredTicks: number; blocked: ProductionTransaction['blockedReason'] }
  | { domain: 'research'; jobId: string; researchId: SectResearchId; workerId: string; phase: SectResearchPhase; activeTicks: number; requiredTicks: number; blocked: SectResearchBlock }
  | { domain: 'care'; jobId: string; patientId: string; phase: SectCareJob['phase']; activeTicks: number; requiredTicks: 40; blocked: SectCareJob['blocked'] };
export interface RuntimeExpansionTerminalV9 {
  domain: RuntimeExpansionJobV9['domain']; jobId: string; kind: 'completed' | 'cancelled'; tick: number;
  actorId: string; beforeInjury: number | null; afterInjury: number | null;
}
export interface RuntimeExpansionViewV9 {
  revisions: { construction: number; production: number; research: number; care: number };
  stock: Array<{ resourceId: SectResourceId; owned: number; reserved: number; available: number; capacity: 99 }>;
  blueprints: Array<SectPlacementRequest & { blueprintId: string; status: 'planned' | 'started'; jobId: string | null; footprint: SectFootprint }>;
  buildings: Array<SectPlacementRequest & { buildingId: string; level: 1 | 2; footprint: SectFootprint; maintenance: SectMaintenanceStatus }>;
  jobs: RuntimeExpansionJobV9[]; workOwners: V9WorkOwner[];
  completedResearch: Array<{ researchId: SectResearchId; completionJobId: string }>;
  recentTerminals: RuntimeExpansionTerminalV9[]; totalTerminals: number;
}
export interface RuntimeBreakthroughRequestV9 { discipleId: string; preparation: BreakthroughPreparation }
export interface RuntimeBreakthroughPreviewV9 {
  preview: BreakthroughPreview; resourceStamp: string;
  /** Additional enclosing-World occupancy; domain preview alone cannot see sect jobs. */
  workOwner: V9WorkOwner | null;
}
export interface RuntimePlacementPreviewV9 {
  request: SectPlacementRequest; expectedRevision: number; navVersion: number;
  allowed: boolean; code: SectGeometryError | ConstructionRejection | null;
  footprint: SectFootprint | null; costs: readonly SectResourceLine[]; requiredTicks: number;
  /** Geometry/research preview only. Dispatch still checks complete candidate capacity. */
  scope: 'placement-and-research';
}
export interface RuntimeApplicationCommandV9 { commandId: string; sequence: number; issuedTick: number }
