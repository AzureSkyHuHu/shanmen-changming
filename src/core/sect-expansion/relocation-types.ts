import type { SectCatalogIdentity, SectCell, SectResourceLine } from '../../content/sect-v9/types';
import type { ConstructionFrame } from './construction-types';
import type { SectPlacementRequest } from './types';

/** Isolated record candidate only. Not a registered World, command or save version. */
export const SECT_RELOCATION_LIMITS = Object.freeze({ records: 128, receipts: 256, activeJobs: 36,
  visits: 201, spans: 200, checkpoints: 2, workTicks: 200, halfWorkTicks: 100 });
export interface SectRelocationVisit { readonly tick: number; readonly calendarTick: number; readonly position: SectCell }
export interface SectRelocationWorkSpan {
  readonly firstTick: number; readonly lastTick: number;
  readonly firstCalendarTick: number; readonly lastCalendarTick: number; readonly visitIndex: number;
}
export type SectRelocationPhase = 'to-old-entrance' | 'to-new-entrance' | 'working' | 'waiting-completion';
export type SectRelocationCheckpoint = SectRelocationVisit & (
  | { readonly checkpointId: 'construction.half'; readonly activeTicks: 100 }
  | { readonly checkpointId: 'construction.remainder'; readonly activeTicks: 200 }
);
export interface SectRelocationTerminal extends SectRelocationVisit {
  readonly kind: 'completed' | 'cancelled';
  readonly previousPhase: SectRelocationPhase;
  readonly revision: number;
  readonly consumed: readonly SectResourceLine[];
  readonly released: readonly SectResourceLine[];
}
/** Position history owns neither level/research nor maintenance. The immutable sourceJobId
 * refers to the original construction; previousRelocationJobId refers ONLY to the last
 * successful relocation. Cancelling an attempt never changes that predecessor or position.
 * Navigation and live owner closure are intentionally absent from this record-only stage.
 */
export interface SectRelocationJob {
  readonly jobId: string; readonly reservationId: string;
  readonly buildingId: string; readonly sourceJobId: string; readonly workerId: string;
  readonly previousRelocationJobId: string | null;
  readonly from: SectPlacementRequest; readonly to: SectPlacementRequest;
  readonly startedTick: number; readonly startedCalendarTick: number; readonly origin: SectCell;
  readonly requiredTicks: 200;
  readonly phase: SectRelocationPhase | 'completed' | 'cancelled';
  readonly oldEntranceVisit: SectRelocationVisit | null;
  readonly newEntranceVisits: readonly SectRelocationVisit[];
  readonly workSpans: readonly SectRelocationWorkSpan[];
  readonly checkpoints: readonly SectRelocationCheckpoint[];
  readonly activeTicks: number;
  readonly terminal: SectRelocationTerminal | null;
}
interface SectRelocationCommandBase { readonly commandId: string; readonly expectedRevision: number }
/** Local receipt bodies, not accepted by any public dispatcher. No system/death receipt
 * is accepted without a future version-owned lifecycle authority. */
export type SectRelocationCommand = SectRelocationCommandBase & (
  | { readonly kind: 'relocation.start'; readonly buildingId: string; readonly workerId: string; readonly target: SectPlacementRequest }
  | { readonly kind: 'relocation.cancel'; readonly jobId: string }
);
export interface SectRelocationReceipt { readonly command: SectRelocationCommand; readonly jobId: string; readonly revision: number }
export interface SectRelocationState {
  readonly schemaVersion: 1; readonly protocol: 'isolated-relocation-records.1';
  readonly catalogIdentity: SectCatalogIdentity;
  /** Revision advances once per start, cancellation or completion; work alone does not advance it. */
  readonly revision: number; readonly nextId: number;
  readonly jobs: readonly SectRelocationJob[]; readonly receipts: readonly SectRelocationReceipt[];
}
/** One construction authority and one shared ledger, never a duplicate inventory. This is
 * insufficient for World admission: the future version owner must authenticate all other
 * domain histories, research prerequisites, lifecycle, occupancy and future save budgets. */
export interface SectRelocationRecordFrame { readonly construction: ConstructionFrame; readonly relocation: SectRelocationState }
export interface SectHistoricalPlacement extends SectPlacementRequest {
  readonly buildingId: string; readonly sourceJobId: string; readonly relocationJobId: string | null;
  readonly firstMaintenanceCalendarTick: number;
}
