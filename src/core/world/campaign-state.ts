import type { CampaignDataV2 } from '../campaign/v2-types';
import type { CampaignRouteId } from '../campaign/types';
import type { RegisteredExpedition } from '../expeditions/versioned';
import type { Realm, PendingDeath } from '../cultivation/types';
import type { School } from '../combat/definitions/types';
import type { EquipmentOwner } from '../builds/v2-types';

export interface WorldCampaignState {
  schemaVersion: 2; progress: CampaignDataV2;
  /** Routes refer to one run-owned proof; personal milestones/deaths share it. */
  clearEvidence: { routeId: CampaignRouteId; runId: string }[];
  settledRunEvidence: RegisteredExpedition[];
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
export interface WorldMigrationLifecycle {
  kind: 'legacy-v7'; sourceBuildBoundaryHash: string; sourceCultivationRevision: number; sourceCalendarMonth: number;
  receiptCount: number; eventCount: number; deathCount: number; prefixHash: string;
  finalizedDeaths: PendingDeath[]; pendingDeaths: PendingDeath[];
}
export interface WorldLegacyState {
  schemaVersion: 1; archivedIdentities: WorldDeceasedIdentity[]; estates: WorldEstateRecord[]; migrationLifecycle: WorldMigrationLifecycle | null;
}
