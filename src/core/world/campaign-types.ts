import type { School } from '../combat/definitions/types';
import type { ResourceLine } from '../economy/types';
import type { CampaignMode, CampaignRouteId, CampaignRecruitDefinition } from '../campaign/types';
import type { CampaignErrorV2 } from '../campaign/v2-types';
import type { EquipmentOwner } from '../builds/v2-types';

export type CampaignPlayerRequest =
  | { kind: 'campaign.equipment.claim'; routeId: CampaignRouteId; discipleId: string }
  | { kind: 'campaign.lesson.learn'; knowledgeId: string; discipleId: string }
  | { kind: 'campaign.recruit'; routeId: CampaignRouteId; school: School }
  | { kind: 'campaign.relief'; school: School }
  | { kind: 'campaign.recover'; acknowledgeLoss: true }
  | { kind: 'estate.assign'; itemInstanceId: string; discipleId: string };
/** Preview token is derived by core; Session additionally protects the proposal with its own epoch. */
export type PlayerCampaignCommand = CampaignPlayerRequest & { commandId: string; expectedBasisStamp: string };
export type WorldCampaignError = CampaignErrorV2 | 'INVALID_COMMAND' | 'BLOCKED_BY_DECISION' | 'ACTIVE_EXPEDITION'
  | 'BUILD_REJECTED' | 'CULTIVATION_REJECTED' | 'INVENTORY_FULL' | 'ESTATE_UNAVAILABLE' | 'ITEM_UNAVAILABLE' | 'PREVIEW_STALE'
  | 'SAVE_CAPACITY_EXCEEDED' | 'SAVE_OBLIGATION_UNBOUNDED';
export interface WorldCampaignResult {
  kind: CampaignPlayerRequest['kind']; claimId: string | null; discipleIds: string[]; itemInstanceIds: string[];
}
export interface WorldCampaignPreview {
  /** Request stamp: hash({ stateStamp: projection.basisStamp, request }). */
  request: CampaignPlayerRequest; basisStamp: string; costs: ResourceLine[]; blockers: WorldCampaignError[];
  recruitProfiles: CampaignRecruitDefinition[]; grantedResources: ResourceLine[];
}
export interface CampaignRecipientProjection {
  discipleId: string; nameKey: string; presentationId: 'disciple-0' | 'disciple-1' | 'disciple-2' | 'disciple-3';
  school: School; available: boolean; away: boolean;
}
export interface CampaignRouteProjection {
  routeId: CampaignRouteId; nameKey: string; descriptionKey: string; counterplayKey: string;
  mechanism: 'fundamentals' | 'poison-attrition' | 'split-ranged' | 'shield-counterattack' | 'combined-arms';
  prerequisites: CampaignRouteId[]; available: boolean; cleared: boolean; final: boolean; expectedMonths: number;
}
export interface CampaignEstateItemProjection {
  itemInstanceId: string; definitionId: string; acquisitionId: string; owner: EquipmentOwner;
  deceasedDiscipleId: string; deathId: string; pendingRelease: boolean;
}
/** UI projection excludes full run evidence, combat snapshots and replay histories. */
export interface WorldCampaignProjection {
  /** Global state stamp, distinct from each request-specific preview stamp. */
  mode: CampaignMode; revision: number; completed: boolean; basisStamp: string;
  activeRun: boolean; managementActionsAvailable: boolean;
  routes: CampaignRouteProjection[]; recipients: CampaignRecipientProjection[];
  equipmentClaims: { routeId: CampaignRouteId; definitionId: string; nameKey: string; descriptionKey: string }[];
  lessons: { knowledgeId: string; nameKey: string; descriptionKey: string; skillId: string; school: School;
    costs: ResourceLine[]; learnedDiscipleIds: string[] }[];
  recruitInvitations: { routeId: CampaignRouteId; costs: ResourceLine[] }[];
  recruitProfiles: CampaignRecruitDefinition[];
  relief: { available: boolean; costs: ResourceLine[]; nextEligibleMonth: number | null; blockers: WorldCampaignError[] };
  recovery: { available: boolean; nextGeneration: number; resources: ResourceLine[]; recruitProfiles: CampaignRecruitDefinition[]; blockers: WorldCampaignError[] };
  estateItems: CampaignEstateItemProjection[];
}
