import type { EquipmentDefinition } from '../builds/types';
import type { School } from '../combat/definitions/types';
import type { ResourceLine } from '../economy/types';
import type { RouteSpecification } from '../expeditions/types';

export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export const CAMPAIGN_ROUTE_IDS = ['route.qingfeng-trial', 'route.miasma-seal', 'route.thunder-seal', 'route.mountain-seal', 'route.everbright-finale'] as const;
export type CampaignRouteId = (typeof CAMPAIGN_ROUTE_IDS)[number];
export type CampaignMode = 'standard' | 'hardcore';
export interface CampaignRouteDefinition {
  id: CampaignRouteId;
  nameKey: string;
  descriptionKey: string;
  counterplayKey: string;
  mechanism: 'fundamentals' | 'poison-attrition' | 'split-ranged' | 'shield-counterattack' | 'combined-arms';
  prerequisites: CampaignRouteId[];
  specification: RouteSpecification;
  firstClear: { equipmentId: string | null; knowledgeIds: string[]; recruitInvitation: boolean };
  final: boolean;
}
export interface CampaignEquipmentDefinition extends EquipmentDefinition { readonly nameKey: string; readonly descriptionKey: string }
export interface CampaignKnowledgeDefinition {
  id: string;
  nameKey: string;
  descriptionKey: string;
  school: School;
  skillId: string;
  requiredSkillIds: string[];
  costs: ResourceLine[];
}
export interface CampaignRecruitDefinition {
  school: School;
  nameKey: string;
  ageMonths: number;
  lifespanMonths: 960;
  realm: 'mortal';
  aptitude: number;
  cultivation: number;
  understanding: number;
  foundation: number;
  mindset: number;
  injury: 0;
}
export interface CampaignClear {
  revision: number;
  routeId: CampaignRouteId;
  runId: string;
  settlementId: string;
  endedMonth: number;
  evidenceHash: string;
}
/** The World adapter creates this projection from authoritative state, never player input. */
export interface CampaignContext {
  revision: number;
  calendarMonth: number;
  activeExpedition: boolean;
  disciples: {
    discipleId: string;
    school: School;
    lifeState: 'alive' | 'pendingDeath' | 'dead';
    deathId: string | null;
    available: boolean;
    learnedSkillIds: string[];
  }[];
  /** Include archived IDs so a new generation cannot resurrect/reuse an old identity. */
  archivedDiscipleIds: string[];
  availableResources: ResourceLine[];
  /** Latest finalized death ID, only when ALL disciples have died and all runs are settled. */
  terminalLossId: string | null;
}
export type CampaignClaimRequest =
  | { kind: 'equipment'; routeId: CampaignRouteId; discipleId: string }
  | { kind: 'lesson'; knowledgeId: string; discipleId: string }
  | { kind: 'recruit'; routeId: CampaignRouteId; school: School; discipleId: string }
  | { kind: 'recovery'; discipleIds: [string, string]; acknowledgeLoss: true };
export type CampaignGrant =
  | { kind: 'equipment'; acquisitionId: string; discipleId: string; definitionId: string }
  | { kind: 'lesson'; acquisitionId: string; discipleId: string; knowledgeId: string; skillId: string }
  | { kind: 'recruit'; acquisitionId: string; discipleId: string; candidateId: string; profile: CampaignRecruitDefinition }
  | { kind: 'resources'; acquisitionId: string; resources: ResourceLine[] };
export interface CampaignClaimPlan {
  claimId: string;
  expectedRevision: number;
  contextRevision: number;
  contextHash: string;
  request: CampaignClaimRequest;
  costs: ResourceLine[];
  grants: CampaignGrant[];
  recovery: { generation: number; terminalLossId: string } | null;
  planHash: string;
}
/** Trusted atomic World transaction receipt. It is NOT a player-facing command. */
export interface CampaignClaimAcknowledgement {
  kind: 'campaignEffectsCommitted';
  claimId: string;
  planHash: string;
  transactionId: string;
  acquisitionIds: string[];
}
export interface CampaignClaimReceipt { plan: CampaignClaimPlan; acknowledgement: CampaignClaimAcknowledgement }
export interface CampaignData {
  schemaVersion: 1;
  rulesVersion: 1;
  mode: CampaignMode;
  revision: number;
  clears: CampaignClear[];
  claims: CampaignClaimReceipt[];
}
export type CampaignState = Immutable<CampaignData>;
export type CampaignError = 'INVALID_STATE' | 'INVALID_INPUT' | 'UNKNOWN_ROUTE' | 'ROUTE_LOCKED' | 'INVALID_VICTORY'
  | 'VICTORY_CONFLICT' | 'UNKNOWN_REWARD' | 'ALREADY_CLAIMED' | 'UNKNOWN_DISCIPLE' | 'DISCIPLE_UNAVAILABLE'
  | 'WRONG_SCHOOL' | 'MISSING_PREREQUISITE' | 'ALREADY_LEARNED' | 'INSUFFICIENT_RESOURCES' | 'ROSTER_FULL'
  | 'IDENTITY_REUSED' | 'RECOVERY_UNAVAILABLE' | 'LOSS_ACKNOWLEDGEMENT_REQUIRED' | 'STALE_PLAN' | 'INVALID_ACKNOWLEDGEMENT'
  | 'CLAIM_CONFLICT' | 'HISTORY_LIMIT' | 'OVERFLOW';
export type CampaignTransition = { ok: true; state: CampaignState; replayed: boolean } | { ok: false; state: CampaignState; code: CampaignError };
export type CampaignPlanResult = { ok: true; plan: Immutable<CampaignClaimPlan> } | { ok: false; code: CampaignError };
