import type { CampaignClaimPlan, CampaignClaimReceipt, CampaignClaimRequest, CampaignContext, CampaignData, CampaignError,
  CampaignMode, CampaignState, Immutable } from './types';
import type { School } from '../combat/definitions/types';
import type { ResourceLine } from '../economy/types';

export interface StandardReliefPolicy {
  protocol: 'standard-relief-v1'; mode: 'standard'; requiredLivingCount: 1;
  requireExhaustedUnlockedInvitations: true; costs: readonly ResourceLine[]; cooldownMonths: 12; countPendingDeathAsLiving: true;
}
export const STANDARD_RELIEF_POLICY: Readonly<StandardReliefPolicy> = Object.freeze({ protocol: 'standard-relief-v1', mode: 'standard', requiredLivingCount: 1,
  requireExhaustedUnlockedInvitations: true, costs: Object.freeze([Object.freeze({ resourceId: 'meal' as const, quantity: 8 })]), cooldownMonths: 12, countPendingDeathAsLiving: true });
export type CampaignClaimRequestV2 = CampaignClaimRequest | { kind: 'relief'; school: School; discipleId: string };
export interface CampaignReliefBasis { ordinal: number; month: number; survivorId: string }
export interface CampaignClaimPlanV2 extends Omit<CampaignClaimPlan, 'request'> {
  request: CampaignClaimRequestV2; relief: CampaignReliefBasis | null;
}
export interface CampaignClaimReceiptV2 extends Omit<CampaignClaimReceipt, 'plan'> { plan: CampaignClaimPlanV2 }
export interface CampaignDataV2 extends Omit<CampaignData, 'schemaVersion' | 'rulesVersion' | 'claims'> {
  schemaVersion: 2; rulesVersion: 2; reliefProtocol: 'standard-relief-v1'; claims: CampaignClaimReceiptV2[];
}
export type CampaignStateV2 = Immutable<CampaignDataV2>;
export type CampaignErrorV2 = CampaignError | 'RELIEF_UNAVAILABLE' | 'RELIEF_COOLDOWN';
export type CampaignTransitionV2 = { ok: true; state: CampaignStateV2; replayed: boolean } | { ok: false; state: CampaignStateV2; code: CampaignErrorV2 };
export type CampaignPlanResultV2 = { ok: true; plan: Immutable<CampaignClaimPlanV2> } | { ok: false; code: CampaignErrorV2 };
// Re-export domain-neutral contracts for the future World bridge.
export type { CampaignContext, CampaignMode, CampaignState };
