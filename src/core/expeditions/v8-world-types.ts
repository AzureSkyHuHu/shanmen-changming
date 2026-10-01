import type { CampaignRouteId } from '../campaign/types';
import type { PlayerExpeditionCommand, WorldExpeditionPreview, WorldExpeditionProjection } from './world-types';
import type { ResourceLine } from '../economy/types';
export interface ExpeditionDepartureRequestV8 { squadIds: string[]; routeId: CampaignRouteId; supplies?: ResourceLine[] }
export type PlayerExpeditionCommandV8 = Exclude<PlayerExpeditionCommand, { kind: 'expedition.depart' }>
  | { commandId: string; kind: 'expedition.depart'; request: ExpeditionDepartureRequestV8 }
  | { commandId: string; kind: 'expedition.emergency-retreat'; expectedBasisStamp: string; acknowledgeLoss: true };
export interface WorldExpeditionPreviewV8 extends Omit<WorldExpeditionPreview, 'routeId'> { routeId: CampaignRouteId }
export interface WorldExpeditionProjectionV8 extends WorldExpeditionProjection { routeId: CampaignRouteId | null }
export interface WorldEmergencyRetreatPreview {
  basisStamp: string; runId: string; encounterId: string; blockers: string[];
  losses: { unsecuredLoot: ResourceLine[]; injuryByDisciple: { discipleId: string; addedInjury: number }[]; deadDiscipleIds: string[] };
  retainedLoot: ResourceLine[]; returnMonths: number; returnCost: ResourceLine[];
}
