import type { GameContentIdentity } from '../../content/registry';
import type { SectCatalogIdentity, SectCell, SectRecipeId, SectResourceLine } from '../../content/sect-v9/types';
import type { JobNavigation } from '../agents/navigation';
import type { WorkPathBudget } from '../agents/work-navigation';
import type { CommandV8 } from '../kernel/contracts-v8';
import type { SectCommandV9 } from '../kernel/contracts-v9';
import type { SaveMetadata } from '../kernel/save';
import type { WorldStateV9 } from '../world/v9-types';
import type { SectCareState, SectExpansionOwnedRecordsV9 } from './care-types';
import type { ConstructionBuilding, ConstructionClaim, ConstructionContext, ConstructionFrame, ConstructionValidationIssue } from './construction-types';
import type { SectHistoricalIdentitySource } from './history-identity';
import type { SectMaintenancePayment, SectMaintenanceState } from './maintenance-types';
import type { SectProductionJob, SectProductionSiteProof, SectProductionState } from './production-types';
import type { SectResearchState } from './research-types';

/** Frozen DESIGN contract, not codec/runtime registration or an implemented API.
 * See docs/v10-alchemy-upgrade-contract.md. Existing v9 .3 types/semantics are unchanged.
 * All interfaces below are data-only except explicitly marked transient ports/queries.
 */
export const MANAGEMENT_V10_PROTOCOL = Object.freeze({
  saveVersion: 10,
  simulationVersion: '0.10.0',
  runtimeProtocol: 'management-v10-alchemy-upgrade.1',
  contentVersion: 'shanmen-management-0.10.0-upgrade.1',
  registryId: 'content.management-v10.upgrade-1',
  sectSchemaVersion: 2,
  upgradeSchemaVersion: 1,
  upgradeProtocol: 'alchemy-l1-l2.1',
  maintenanceProtocol: 'historical-level-before-upgrade.v10.1',
  productionProtocol: 'immutable-origin-effective-level.v10.1',
  careProtocol: 'two-exact-powder-recipes.v10.1',
  permanentBuildIdentity: 'content.management-v9.unregistered-3',
} as const);

/** These are non-evicting local limits, NOT complete save/continuation certificates. */
export const SECT_UPGRADE_LIMITS_V10 = Object.freeze({
  records: 128, receipts: 256, activeJobs: 36,
  workTicks: 400, halfWorkTicks: 200, siteVisits: 401, workSpans: 400, checkpoints: 2,
} as const);
export const SECT_POWDER_RECIPE_IDS_V10 = Object.freeze([
  'craft.wound-powder.v9', 'craft.wound-powder-alt.v9',
] as const);
export type SectPowderRecipeIdV10 = typeof SECT_POWDER_RECIPE_IDS_V10[number];
/** Lifecycle may pause after advancing clocks; in that case no later stage runs. */
export const MANAGEMENT_V10_TICK_ORDER = Object.freeze([
  'clock', 'cultivation-lifecycle', 'legacy-automatic-starts', 'construction',
  'maintenance', 'upgrade', 'sect-production', 'research', 'care', 'legacy-production',
] as const);

/** Immutable construction origin; effective level is NEVER written here. */
export type ConstructionOriginV10 = ConstructionBuilding & { readonly level: 1 };
export type ConstructionOwnedRecordsV10 = Omit<SectExpansionOwnedRecordsV9['construction'], 'buildings'> & {
  readonly buildings: readonly ConstructionOriginV10[];
};
export type ConstructionProjectionV10 = Omit<ConstructionFrame, 'buildings'> & {
  readonly buildings: readonly ConstructionOriginV10[];
};

export interface SectUpgradeVisitV10 {
  readonly tick: number;
  readonly calendarTick: number;
  readonly position: SectCell;
}
export interface SectUpgradeWorkSpanV10 {
  readonly firstTick: number;
  readonly lastTick: number;
  readonly firstCalendarTick: number;
  readonly lastCalendarTick: number;
  readonly visitIndex: number;
}
export interface SectUpgradeSiteProofV10 {
  readonly buildingId: string;
  readonly definitionId: 'alchemy.v9';
  readonly sourceJobId: string;
  readonly position: SectCell;
  readonly level: 1;
  readonly firstMaintenanceCalendarTick: number;
}
export interface SectUpgradeResearchRefV10 {
  readonly researchId: 'herbal-compatibility.v9';
  readonly completionJobId: string;
}
/** Reuses the existing paired-ledger policy and checkpoint names verbatim.
 * Time/ordinal evidence joins each ledger checkpoint to the actual Nth work tick.
 */
export type SectUpgradeCheckpointV10 = SectUpgradeVisitV10 & (
  | { readonly checkpointId: 'construction.half'; readonly activeTicks: 200 }
  | { readonly checkpointId: 'construction.remainder'; readonly activeTicks: 400 }
);
export type SectUpgradeCancellationV10 = { readonly kind: 'requested' }
  | { readonly kind: 'death'; readonly deathId: string };
export type SectUpgradeLivePhaseV10 = 'to-storage' | 'to-site' | 'working';
export type SectUpgradeBlockV10 = 'PATH_BLOCKED' | 'PATH_BUDGET' | 'WORKER_UNAVAILABLE'
  | 'ENTRANCE_BUSY' | 'STORAGE_UNAVAILABLE' | 'SITE_UNAVAILABLE' | 'MAINTENANCE_UNPAID'
  | 'VISIT_CAPACITY' | null;
interface SectUpgradeTerminalBaseV10 extends SectUpgradeVisitV10 {
  readonly consumed: readonly SectResourceLine[];
  readonly released: readonly SectResourceLine[];
  readonly upgradeRevision: number;
}
export type SectUpgradeTerminalV10 = SectUpgradeTerminalBaseV10 & (
  | { readonly kind: 'completed'; readonly previousPhase: 'working'; readonly resultLevel: 2; readonly cancellation: null }
  | { readonly kind: 'cancelled'; readonly previousPhase: SectUpgradeLivePhaseV10; readonly resultLevel: 1; readonly cancellation: SectUpgradeCancellationV10 }
);
export interface SectUpgradeJobV10 {
  readonly jobId: string;
  readonly reservationId: string;
  readonly workerId: string;
  readonly buildingId: string;
  readonly fromLevel: 1;
  readonly toLevel: 2;
  readonly requiredTicks: 400;
  readonly researchGate: SectUpgradeResearchRefV10;
  readonly site: SectUpgradeSiteProofV10;
  readonly storageId: string;
  readonly storagePosition: SectCell;
  /** Shared production/research seat key is buildingId, not construction blueprintId. */
  readonly seatToken: string;
  readonly entranceToken: string;
  readonly startedTick: number;
  readonly startedCalendarTick: number;
  readonly origin: SectCell;
  readonly phase: SectUpgradeLivePhaseV10 | 'completed' | 'cancelled';
  readonly storageVisit: SectUpgradeVisitV10 | null;
  readonly siteVisits: readonly SectUpgradeVisitV10[];
  readonly workSpans: readonly SectUpgradeWorkSpanV10[];
  readonly checkpoints: readonly SectUpgradeCheckpointV10[];
  readonly activeTicks: number;
  readonly navigation: JobNavigation;
  readonly blocked: SectUpgradeBlockV10;
  readonly terminal: SectUpgradeTerminalV10 | null;
}
interface SectUpgradeCommandBaseV10 { readonly commandId: string; readonly expectedRevision: number }
export type SectUpgradeCommandV10 = SectUpgradeCommandBaseV10 & (
  | { readonly kind: 'upgrade.start'; readonly buildingId: string; readonly workerId: string }
  | { readonly kind: 'upgrade.cancel'; readonly jobId: string }
);
export interface SectUpgradeReceiptV10 {
  readonly command: SectUpgradeCommandV10;
  readonly revision: number;
  readonly jobId: string;
}
export interface SectUpgradeStateV10 {
  readonly schemaVersion: 1;
  readonly protocol: 'alchemy-l1-l2.1';
  readonly catalogIdentity: SectCatalogIdentity;
  readonly revision: number;
  /** Start allocates sect-upgrade:N and sect-upgrade-reservation:N+1. */
  readonly nextId: number;
  readonly jobs: readonly SectUpgradeJobV10[];
  readonly receipts: readonly SectUpgradeReceiptV10[];
}

/** Old proof records stay byte-for-byte unchanged. New L2 records have one mandatory
 * completion reference, not a mutable level flag or an alleged unlock list.
 */
export type SectProductionSiteProofV10 = (SectProductionSiteProof & { readonly upgradeJobId?: never })
  | {
    readonly kind: 'placed'; readonly siteId: string; readonly position: SectCell;
    readonly sourceJobId: string; readonly level: 2;
    readonly firstMaintenanceCalendarTick: number; readonly upgradeJobId: string;
  };
export type SectProductionJobV10 = Omit<SectProductionJob, 'recipeId' | 'productiveSite' | 'researchGate'> & (
  | { recipeId: Exclude<SectRecipeId, 'craft.wound-powder-alt.v9'>; readonly productiveSite: SectProductionSiteProof & { readonly upgradeJobId?: never }; readonly researchGate?: SectProductionJob['researchGate'] }
  | { recipeId: 'craft.wound-powder.v9'; readonly productiveSite: Extract<SectProductionSiteProofV10, { readonly level: 2 }>; readonly researchGate: { readonly researchId: 'basic-medicine.v9'; readonly completionJobId: string } }
  | { recipeId: 'craft.wound-powder-alt.v9'; readonly productiveSite: Extract<SectProductionSiteProofV10, { readonly level: 2 }>; readonly researchGate: SectUpgradeResearchRefV10 }
);
export type SectProductionStateV10 = Omit<SectProductionState, 'jobs'> & { readonly jobs: readonly SectProductionJobV10[] };

/** No rate field means an exact old-format L1 payment, including new L1 payments.
 * An L2 payment is a distinct exact shape. Its cost is checked at PAYMENT time.
 */
export type SectMaintenancePaymentV10 = (SectMaintenancePayment & { readonly rate?: never })
  | (SectMaintenancePayment & { readonly rate: { readonly level: 2; readonly upgradeJobId: string } });
export type SectMaintenanceStateV10 = Omit<SectMaintenanceState, 'payments'> & { readonly payments: readonly SectMaintenancePaymentV10[] };

export interface SectExpansionOwnedRecordsV10 extends Omit<SectExpansionOwnedRecordsV9,
  'schemaVersion' | 'construction' | 'production' | 'maintenance'> {
  readonly schemaVersion: 2;
  readonly construction: ConstructionOwnedRecordsV10;
  readonly production: SectProductionStateV10;
  readonly maintenance: SectMaintenanceStateV10;
  readonly upgrade: SectUpgradeStateV10;
}
/** Transient projection only: one live map/person/clock/base ledger in construction.
 * It is never stored inside World and grants no source/capacity admission by itself.
 */
export interface SectUpgradeFrameV10 {
  readonly schemaVersion: 2;
  readonly construction: ConstructionProjectionV10;
  readonly production: SectProductionStateV10;
  readonly research: SectResearchState;
  readonly maintenance: SectMaintenanceStateV10;
  readonly care: SectCareState;
  readonly upgrade: SectUpgradeStateV10;
}
export interface WorldStateV10 extends Omit<WorldStateV9,
  'simulationVersion' | 'runtimeProtocol' | 'contentVersion' | 'contentIdentity' | 'sectExpansion'> {
  simulationVersion: '0.10.0';
  runtimeProtocol: 'management-v10-alchemy-upgrade.1';
  contentVersion: 'shanmen-management-0.10.0-upgrade.1';
  contentIdentity: GameContentIdentity;
  sectExpansion: SectExpansionOwnedRecordsV10;
}
/** Exact eight-field envelope; no hidden migration/authority flags. */
export interface SaveEnvelopeV10 extends SaveMetadata {
  saveVersion: 10;
  simulationVersion: '0.10.0';
  contentVersion: 'shanmen-management-0.10.0-upgrade.1';
  seed: string;
  checksum: string;
  payload: WorldStateV10;
}
export type SectCommandV10 = SectCommandV9 | { readonly domain: 'upgrade'; readonly command: SectUpgradeCommandV10 };
export type CommandV10 = CommandV8 | {
  readonly kind: 'sect.command'; readonly payload: SectCommandV10;
  readonly commandId: string; readonly sequence: number; readonly issuedTick: number;
};

export type SectUpgradeRejectionV10 = 'INVALID_FRAME' | 'INVALID_CONTEXT' | 'INVALID_COMMAND'
  | 'IDENTITY_CONFLICT' | 'STALE_REVISION' | 'STALE_CLOCK' | 'CLOCK_GAP'
  | 'CAPACITY_EXCEEDED' | 'UNKNOWN_BUILDING' | 'UNKNOWN_JOB' | 'TRANSACTION_FINISHED'
  | 'UNSUPPORTED_UPGRADE' | 'ALREADY_UPGRADED' | 'UPGRADE_ACTIVE' | 'BUILDING_BUSY'
  | 'WORKER_UNAVAILABLE' | 'STORAGE_UNAVAILABLE' | 'WORKSTATION_UNAVAILABLE'
  | 'CLAIM_CONFLICT' | 'SITE_UNAVAILABLE' | 'MAINTENANCE_UNPAID'
  | 'INSUFFICIENT_INVENTORY' | 'RESEARCH_AUTHORITY_REQUIRED' | 'MANAGEMENT_REQUIRED'
  | 'INVALID_RESERVATION' | 'UNSAFE_POSITION';
export type SectUpgradeResultV10 =
  | { readonly ok: true; readonly frame: SectUpgradeFrameV10; readonly repeated: boolean; readonly jobId: string | null }
  | { readonly ok: false; readonly frame: SectUpgradeFrameV10; readonly code: SectUpgradeRejectionV10 };
export interface SectCommandResultV10 {
  readonly commandId: string;
  readonly status: 'accepted' | 'rejected';
  readonly transactionId: string | null;
  readonly eventIds: readonly string[];
  readonly rejection: null | { readonly code: 'SECT_EXPANSION_REJECTED' | 'INVALID_WORLD_RECORDS' | 'SAVE_CAPACITY_EXCEEDED'; readonly detail?: string };
  readonly sectResult?: { readonly domain: SectCommandV10['domain']; readonly relatedId: string | null; readonly repeated: boolean };
}

/** Pure derived query, never saved. The construction record remains L1 even here. */
export type SectBuildingLevelEvidenceV10 =
  | { readonly level: 1; readonly constructionJobId: string; readonly upgradeJobId: null }
  | { readonly level: 2; readonly constructionJobId: string; readonly upgradeJobId: string };
export interface SectBuildingStatusV10 {
  readonly buildingId: string;
  readonly level: SectBuildingLevelEvidenceV10;
  readonly activeUpgradeJobId: string | null;
  readonly paid: boolean;
  readonly operational: boolean;
  readonly dueCalendarTick: number;
  readonly nextMaintenanceCosts: readonly SectResourceLine[];
  readonly deficits: readonly SectResourceLine[];
}
export interface SectUpgradePreviewV10 {
  readonly buildingId: string;
  readonly workerId: string;
  readonly revision: number;
  readonly simulationTick: number;
  readonly eligible: boolean;
  readonly rejection: SectUpgradeRejectionV10 | null;
  readonly costs: readonly SectResourceLine[];
  readonly halfCosts: readonly SectResourceLine[];
  readonly remainingCosts: readonly SectResourceLine[];
  readonly requiredTicks: 400;
  readonly researchGate: SectUpgradeResearchRefV10 | null;
  readonly dueCalendarTick: number | null;
}
/** Internal fixed adapters only. A caller-supplied frame/context/token is never a
 * player authorization. Root validates the complete source/candidate and capacity.
 * No implementation is exported by this contract file.
 */
export interface SectUpgradeDomainPortsV10 {
  isSectUpgradeCommandV10(value: unknown): value is SectUpgradeCommandV10;
  validateSectUpgradeRecordsV10(frame: SectUpgradeFrameV10, identities?: SectHistoricalIdentitySource): readonly ConstructionValidationIssue[];
  sectUpgradeClaimsV10(frame: SectUpgradeFrameV10): readonly ConstructionClaim[];
  applyValidatedSectUpgradeCommandV10(frame: SectUpgradeFrameV10, context: ConstructionContext, command: SectUpgradeCommandV10): SectUpgradeResultV10;
  tickValidatedSectUpgradeV10(frame: SectUpgradeFrameV10, context: ConstructionContext, budget: WorkPathBudget): SectUpgradeResultV10;
  sectBuildingLevelAtV10(frame: SectUpgradeFrameV10, buildingId: string, tick: number, phase: 'maintenance' | 'after-upgrade'): SectBuildingLevelEvidenceV10 | null;
  sectBuildingStatusV10(frame: SectUpgradeFrameV10, buildingId: string): SectBuildingStatusV10 | null;
  previewSectUpgradeV10(frame: SectUpgradeFrameV10, context: ConstructionContext, buildingId: string, workerId: string): SectUpgradePreviewV10;
}

/** New local owner envelope must join the existing WHOLE-v10 measurement. These
 * returned diagnostics cannot be supplied back as a trusted admission certificate.
 */
export interface SectUpgradeMeasureV10 { readonly bytes: number; readonly decodedCharacters: number; readonly decodedNodes: number }
export interface SectUpgradeObligationV10 extends SectUpgradeMeasureV10 {
  readonly jobId: string;
  readonly branches: readonly (SectUpgradeMeasureV10 & { readonly kind: 'live-peak' | 'completion' | 'cancellation' })[];
  readonly rows: { readonly upgradeReceipts: 1; readonly upgradeJobs: 0; readonly pairedClaims: 0; readonly buildings: 0 };
  readonly counters: { readonly upgradeRevisions: number; readonly upgradeNextId: 0; readonly navVersion: 0 };
}
export type MigrationBlockV10 = 'INVALID_SOURCE' | 'UNSUPPORTED_SOURCE' | 'ACTIVE_WORK'
  | 'PLANNED_BLUEPRINT' | 'AUTOMATIC_WORK_ENABLED' | 'PENDING_COMMANDS' | 'ACTIVE_PROGRESSION'
  | 'PENDING_LIFECYCLE' | 'UNSETTLED_ESTATE' | 'READ_ONLY_SOURCE' | 'CAPACITY_EXCEEDED';
export interface MigrationIssueV10 { readonly code: MigrationBlockV10; readonly path: string }
export type PreparedMigrationV10 =
  | { readonly ok: true; readonly sourceText: string; readonly sourceChecksum: string; readonly world: WorldStateV10; readonly envelope: SaveEnvelopeV10 }
  | { readonly ok: false; readonly issues: readonly MigrationIssueV10[] };
/** Pure preparation only. Persistence owns exact-source backup, readback, lease,
 * generation fence and pointer commit; success here means no data was written.
 */
export interface MigrationPortsV10 {
  inspectQuietV9ToV10Boundary(source: WorldStateV9): readonly MigrationIssueV10[];
  prepareV9ToV10Migration(sourceText: string, metadata: SaveMetadata): PreparedMigrationV10;
}
