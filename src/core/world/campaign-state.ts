import type { CampaignDataV2 } from '../campaign/v2-types';
import type { CampaignRouteId } from '../campaign/types';
import type { RegisteredExpedition } from '../expeditions/versioned';
import type { Realm } from '../cultivation/types';
import type { School } from '../combat/definitions/types';
import type { EquipmentOwner } from '../builds/v2-types';

export interface WorldCampaignState {
  schemaVersion: 1; progress: CampaignDataV2;
  /** At most one authenticated full settled proof per authored route, maximum five. */
  clearEvidence: { routeId: CampaignRouteId; expedition: RegisteredExpedition }[];
}
export interface WorldDeceasedIdentity {
  discipleId: string; nameKey: string; presentationId: 'disciple-0' | 'disciple-1' | 'disciple-2' | 'disciple-3';
  birthCalendarTick: number; ageMonths: number; aptitude: number; school: School; realm: Realm;
  deathId: string; archivedMonth: number;
}
export interface WorldEstateRecord {
  estateId: string; deathId: string; discipleId: string; beneficiaryId: string | null;
  itemInstanceIds: string[]; pendingRunId: string | null; transferCommandIds: string[];
  recordedMonth: number; settledMonth: number | null; settledOwner: EquipmentOwner | null;
}
export interface WorldLegacyState {
  schemaVersion: 1; archivedIdentities: WorldDeceasedIdentity[]; estates: WorldEstateRecord[];
}
