import type { SectResearchGateRef } from './research-gate-types';
import type { SectCell, SectRecipeId, SectResourceLine } from '../../content/sect-v9/types';
import type { ProductionProgress } from '../economy/production-context';
import type { ConstructionClaim, ConstructionContext, ConstructionFrame, ConstructionValidationIssue } from './construction-types';

/** Finite, non-evicting local history. Exhaustion rejects new work, never cancellation. */
export const SECT_PRODUCTION_LIMITS = Object.freeze({ records: 128, receipts: 256, activeJobs: 36, maximumWorkTicks: 240 });
export interface SectProductionVisit { readonly tick: number; readonly calendarTick: number; readonly position: SectCell }
export interface SectProductionWorkSpan {
  readonly firstTick: number; readonly lastTick: number;
  readonly firstCalendarTick: number; readonly lastCalendarTick: number;
}
/** Immutable association survives seat release and the entire storage journey. */
export interface SectProductionSiteProof {
  readonly kind: 'legacy-point' | 'placed';
  readonly siteId: string;
  readonly position: SectCell;
  readonly sourceJobId: string | null;
  readonly level: 0 | 1;
  readonly firstMaintenanceCalendarTick: number | null;
}
export interface SectProductionTerminal extends SectProductionVisit {
  readonly kind: 'completed' | 'cancelled';
  readonly previousPhase: 'WaitingForStation' | 'TravellingToWork' | 'Working' | 'TravellingToStorage' | 'AwaitingDelivery';
  readonly consumed: readonly SectResourceLine[];
  readonly released: readonly SectResourceLine[];
  readonly outputs: readonly SectResourceLine[];
}
/** transactionId is this domain's canonical job ID, not a legacy transaction or assignment. */
export interface SectProductionJob extends ProductionProgress {
  /** Present only on the authenticated alchemy/medicine consumer; ungated records omit it. */
  readonly researchGate?: SectResearchGateRef;
  recipeId: SectRecipeId;
  readonly reservationId: string;
  readonly startedCalendarTick: number;
  readonly origin: SectCell;
  readonly productiveSite: SectProductionSiteProof;
  readonly seatSiteId: string | null;
  readonly workVisit: SectProductionVisit | null;
  readonly deliveryVisit: SectProductionVisit | null;
  readonly workSpans: readonly SectProductionWorkSpan[];
  readonly terminal: SectProductionTerminal | null;
}
interface CommandBase { readonly commandId: string; readonly expectedRevision: number }
export type SectProductionCommand = CommandBase & (
  | { readonly kind: 'production.start'; readonly recipeId: SectRecipeId; readonly workerId: string }
  | { readonly kind: 'production.cancel'; readonly jobId: string }
);
export interface SectProductionReceipt { readonly command: SectProductionCommand; readonly revision: number; readonly jobId: string }
export interface SectProductionState {
  readonly revision: number;
  readonly nextId: number;
  readonly jobs: readonly SectProductionJob[];
  readonly receipts: readonly SectProductionReceipt[];
}
/**
 * Detached combined domain frame, NOT a registered v9 World or save. `construction` contains
 * the ONE projected map, people, inventory, sect stock and tagged reservation book, as well as
 * genuine construction source evidence. There is no second balance, person or map snapshot.
 * Production IDs never inhabit legacy transactions/reservations/assignmentTransactionId.
 *
 * Future World admission must authenticate the projection (including legacy-point coordinates,
 * legacy reserved balances, cultivation/away/other ownership and clock provenance), publish all
 * domains atomically, reserve global IDs/revisions and actual whole-save UTF-8 4 MiB/reader costs,
 * and bind genuine research/maintenance authority before widening this isolated candidate.
 */
export interface SectProductionFrame {
  readonly schemaVersion: 1;
  readonly construction: ConstructionFrame;
  readonly production: SectProductionState;
}
/** Trusted engine projection only. Commands cannot supply claims, prices, outputs or flags. */
export type SectProductionContext = ConstructionContext;
export type SectProductionClaim = ConstructionClaim;
export type SectProductionRejection = 'INVALID_FRAME' | 'INVALID_CONTEXT' | 'INVALID_COMMAND' | 'IDENTITY_CONFLICT' | 'STALE_REVISION'
  | 'STALE_CLOCK' | 'CLOCK_GAP' | 'CAPACITY_EXCEEDED' | 'UNKNOWN_RECIPE' | 'UNKNOWN_JOB' | 'TRANSACTION_FINISHED'
  | 'WORKER_UNAVAILABLE' | 'WORKSTATION_UNAVAILABLE' | 'STORAGE_UNAVAILABLE' | 'CLAIM_CONFLICT'
  | 'INSUFFICIENT_INVENTORY' | 'RESEARCH_AUTHORITY_REQUIRED' | 'MANAGEMENT_REQUIRED' | 'INVALID_RESERVATION' | 'UNSAFE_POSITION';
export type SectProductionResult =
  | { readonly ok: true; readonly frame: SectProductionFrame; readonly repeated: boolean; readonly jobId: string | null }
  | { readonly ok: false; readonly frame: SectProductionFrame; readonly code: SectProductionRejection };
export type SectProductionValidationIssue = ConstructionValidationIssue;
