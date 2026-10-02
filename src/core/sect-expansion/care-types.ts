import type { SectCell, SectResourceLine } from '../../content/sect-v9/types';
import type { JobNavigation } from '../agents/navigation';
import type { WoundPowderEffectReceiptV9 } from '../cultivation/care-effect-v9';
import type { SectMaintenanceFrame } from './maintenance-types';
import type { SectExpansionOwnedRecords } from './world-records-types';

/** Finite, non-evicting internal evidence; not a whole-save capacity certificate. */
export const SECT_CARE_LIMITS = Object.freeze({ records: 128, receipts: 256, workTicks: 40, visits: 41 });
export const WOUND_POWDER_COST_V9: readonly SectResourceLine[] = Object.freeze([
  Object.freeze({ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }),
]);
export interface SectCareVisit { readonly tick: number; readonly calendarTick: number; readonly position: SectCell }
export interface SectCareWorkSpan { readonly firstTick: number; readonly lastTick: number; readonly visitIndex: number }
export type SectCareCancellation = { readonly kind: 'requested' }
  | { readonly kind: 'death'; readonly deathId: string }
  | { readonly kind: 'rest-healed'; readonly beforeInjury: number; readonly beforeRevision: number; readonly afterRevision: number; readonly month: number; readonly healingSourceInstanceIds: readonly string[] };
export interface SectCareTerminal extends SectCareVisit {
  readonly kind: 'completed' | 'cancelled'; readonly previousPhase: 'to-storage' | 'working';
  readonly consumed: readonly SectResourceLine[]; readonly released: readonly SectResourceLine[];
  readonly effect: WoundPowderEffectReceiptV9 | null; readonly cancellation: SectCareCancellation | null;
  readonly careRevision: number;
}
export interface SectCareJob {
  readonly jobId: string; readonly reservationId: string; readonly patientId: string;
  /** One physical powder is the single delivered output of this authenticated job. */
  readonly doseProductionJobId: string; readonly previousCancelledCareId: string | null;
  readonly startedTick: number; readonly startedCalendarTick: number; readonly origin: SectCell;
  readonly storageId: string; readonly storagePosition: SectCell;
  readonly phase: 'to-storage' | 'working' | 'completed' | 'cancelled'; readonly activeTicks: number;
  readonly visits: readonly SectCareVisit[]; readonly workSpans: readonly SectCareWorkSpan[];
  readonly navigation: JobNavigation; readonly blocked: 'PATH_BLOCKED' | 'PATH_BUDGET' | 'STORAGE_UNAVAILABLE' | 'ENTRANCE_BUSY' | 'VISIT_CAPACITY' | null;
  readonly terminal: SectCareTerminal | null;
}
interface CommandBase { readonly commandId: string; readonly expectedRevision: number }
export type SectCareCommand = CommandBase & (
  | { readonly kind: 'care.start'; readonly patientId: string }
  | { readonly kind: 'care.cancel'; readonly jobId: string }
);
export interface SectCareReceipt { readonly command: SectCareCommand; readonly revision: number; readonly jobId: string }
export interface SectCareState { readonly revision: number; readonly nextId: number; readonly jobs: readonly SectCareJob[]; readonly receipts: readonly SectCareReceipt[] }
/** Distinct v9 extension. The old four-domain owned contract and validators stay unchanged. */
export interface SectExpansionOwnedRecordsV9 extends SectExpansionOwnedRecords { readonly care: SectCareState }
export interface SectCareFrameV9 extends SectMaintenanceFrame { readonly care: SectCareState }
