import type { GameContentIdentity } from '../../../content/registry';
import type { SectStock } from '../../../content/sect-v9/types';
import type { JobNavigation } from '../../agents/navigation';
import type { BuildDataV2 } from '../../builds/v2-types';
import type { CultivationState } from '../../cultivation/v3/types';
import type { AutomaticProductionState, ProductionWork } from '../../economy/automatic-types';
import type { InventoryLedger, ProductionTransaction, Reservation } from '../../economy/types';
import type { HistoryArchive } from '../../history/types';
import type { WorldClock } from '../../kernel/clock';
import type { CommandReceipt, CoreDiagnostic, DomainEvent } from '../../kernel/contracts';
import type { CommandV8 } from '../../kernel/contracts-v8';
import type { SequenceState } from '../../kernel/ids';
import type { RandomStreams } from '../../kernel/random';
import type { SectEconomyState } from '../../sect-economy/types';
import type { SectCareJob, SectCareState } from '../../sect-expansion/care-types';
import type { ConstructionJob } from '../../sect-expansion/construction-types';
import type { SectLedgerReservation } from '../../sect-expansion/ledger';
import type { SectRelocationLiveRuntime } from '../../sect-expansion/relocation-runtime-types';
import type { SectRelocationJob, SectRelocationState } from '../../sect-expansion/relocation-types';
import type { SectResearchJob, SectResearchState } from '../../sect-expansion/research-types';
import type { ConstructionOwnedRecordsV10, SectMaintenanceStateV10, SectProductionJobV10, SectProductionStateV10, SectUpgradeJobV10, SectUpgradeStateV10 } from '../../sect-expansion/upgrade-types';
import type { WorldCampaignState, WorldLegacyState } from '../campaign-state';
import type { WorldBuilding, WorldMap } from '../types';
import type { WorldDiscipleV8, WorldExpeditionStateV8 } from '../v8-types';
import type { V9CultivationClockRecords } from '../v9-cultivation-clock-types';

/** Data contracts only. No version identity, codec, constructor or admission brand.
 * Historical leaf protocols keep their genuine identities; this is not a v10 World. */
export interface RelocationOwnerDomainBooks {
  readonly construction: ConstructionOwnedRecordsV10;
  readonly stock: SectStock;
  readonly reservations: readonly SectLedgerReservation[];
  readonly production: SectProductionStateV10;
  readonly research: SectResearchState;
  readonly maintenance: SectMaintenanceStateV10;
  readonly care: SectCareState;
  readonly upgrade: SectUpgradeStateV10;
  readonly relocation: SectRelocationState;
  readonly relocationLive: readonly SectRelocationLiveRuntime[];
}
export interface RelocationOwnerDraft {
  readonly kind: 'internal-relocation-owner-draft';
  readonly seed: string;
  readonly contentIdentity: GameContentIdentity;
  readonly clock: WorldClock;
  readonly randomStreams: RandomStreams;
  readonly sequences: SequenceState;
  readonly map: WorldMap;
  readonly disciples: WorldDiscipleV8[];
  readonly buildings: WorldBuilding[];
  readonly sectEconomy: SectEconomyState;
  readonly history: HistoryArchive;
  readonly automaticProduction: AutomaticProductionState;
  readonly inventory: InventoryLedger;
  readonly reservations: Record<string, Reservation>;
  readonly transactions: Record<string, ProductionTransaction>;
  readonly activeProductionTransactionIds: string[];
  readonly commandReceipts: Record<string, CommandReceipt>;
  readonly pendingCommands: CommandV8[];
  readonly events: DomainEvent[];
  readonly unlocks: string[];
  readonly diagnostics: CoreDiagnostic[];
  readonly cultivation: CultivationState;
  readonly cultivationClock: V9CultivationClockRecords;
  readonly builds: BuildDataV2;
  readonly expedition: WorldExpeditionStateV8;
  readonly campaign: WorldCampaignState;
  readonly legacy: WorldLegacyState;
  readonly domains: RelocationOwnerDomainBooks;
}

/** Proposed fixed ordering only: these values do not execute or prove a tick. */
export const RELOCATION_OWNER_PHASES = [
  'clock', 'cultivation-lifecycle', 'legacy-automatic-starts', 'construction',
  'maintenance', 'upgrade', 'relocation', 'sect-production', 'research', 'care', 'legacy-production',
] as const;
export type RelocationOwnerPhase = typeof RELOCATION_OWNER_PHASES[number];
export interface RelocationOwnerBoundary { readonly tick: number; readonly phase: RelocationOwnerPhase; readonly side: 'before' | 'after' }

type WorkRecord =
  | { readonly domain: 'legacy-production'; readonly job: ProductionWork }
  | { readonly domain: 'construction'; readonly job: ConstructionJob }
  | { readonly domain: 'sect-production'; readonly job: SectProductionJobV10 }
  | { readonly domain: 'research'; readonly job: SectResearchJob }
  | { readonly domain: 'care'; readonly job: SectCareJob }
  | { readonly domain: 'upgrade'; readonly job: SectUpgradeJobV10 }
  | { readonly domain: 'relocation'; readonly job: SectRelocationJob };
export type RelocationWorkDomain = WorkRecord['domain'];
export interface RelocationWorkOwnerRef { readonly domain: RelocationWorkDomain; readonly id: string }
export type RelocationWorkOwner = WorkRecord & RelocationWorkOwnerRef & {
  readonly actorId: string;
  readonly actorRole: 'worker' | 'patient';
  /** Derived movement evidence, not a replacement for the actor's saved traveling flag. */
  readonly navigation: JobNavigation | null;
  readonly traveling: boolean;
};
export interface RelocationOwnerClaim {
  readonly kind: 'actor' | 'seat' | 'entrance' | 'building-lifetime' | 'soft-target';
  readonly key: string;
  /** Legacy storage occupancy is shared only with other legacy deliveries. */
  readonly access: 'exclusive' | 'shared-legacy-storage';
  readonly owner: RelocationWorkOwnerRef;
}
export interface RelocationEligibilityExclusion {
  readonly actorId: string;
  readonly kind: 'not-alive' | 'cannot-work' | 'training' | 'cultivation' | 'teaching' | 'away' | 'build-lock' | 'unowned-travel';
  readonly sourceId: string | null;
}
export interface RelocationProjectionIssue {
  readonly code: 'CLAIM_CONFLICT' | 'DUPLICATE_OWNER' | 'LEGACY_INDEX_MISMATCH' | 'LEGACY_ASSIGNMENT_MISMATCH' | 'LEGACY_STATION_MISMATCH' | 'RELOCATION_LIVE_MISMATCH' | 'MISSING_ACTOR_PROFILE' | 'MISSING_SITE' | 'INVALID_GEOMETRY' | 'OWNER_EXCLUDED';
  readonly key: string;
  readonly owners: readonly RelocationWorkOwnerRef[];
}
export interface RelocationOwnershipProjection {
  readonly owners: readonly RelocationWorkOwner[];
  readonly claims: readonly RelocationOwnerClaim[];
  readonly exclusions: readonly RelocationEligibilityExclusion[];
  readonly issues: readonly RelocationProjectionIssue[];
  /** Jobs, not claim-token count. Includes care and delivery-phase production. */
  readonly activeJobCount: number;
}
/** Detached transient projection. It carries each source authority once. Derived
 * ownership is diagnostic only and is never consumed as permission by recomposition. */
export interface RelocationOwnerFrame {
  readonly authority: {
    readonly clock: WorldClock; readonly map: WorldMap;
    readonly inventory: InventoryLedger; readonly disciples: WorldDiscipleV8[];
  };
  readonly continuity: {
    readonly kind: RelocationOwnerDraft['kind']; readonly seed: string; readonly contentIdentity: GameContentIdentity;
    readonly randomStreams: RandomStreams; readonly sequences: SequenceState; readonly buildings: WorldBuilding[];
    readonly sectEconomy: SectEconomyState; readonly history: HistoryArchive; readonly automaticProduction: AutomaticProductionState;
    readonly reservations: Record<string, Reservation>; readonly transactions: Record<string, ProductionTransaction>;
    readonly activeProductionTransactionIds: string[]; readonly commandReceipts: Record<string, CommandReceipt>;
    readonly pendingCommands: CommandV8[]; readonly events: DomainEvent[]; readonly unlocks: string[]; readonly diagnostics: CoreDiagnostic[];
    readonly cultivation: CultivationState; readonly cultivationClock: V9CultivationClockRecords; readonly builds: BuildDataV2;
    readonly expedition: WorldExpeditionStateV8; readonly campaign: WorldCampaignState; readonly legacy: WorldLegacyState;
  };
  readonly domains: RelocationOwnerDomainBooks;
  readonly ownership: RelocationOwnershipProjection;
}
