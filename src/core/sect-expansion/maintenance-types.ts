import type { SectResourceLine } from '../../content/sect-v9/types';
import type { SectResearchContext, SectResearchFrame, SectResearchRejection } from './research-types';

/** Finite, immutable receipts. Exhaustion expires buildings rather than evicting evidence. */
export const SECT_MAINTENANCE_LIMITS = Object.freeze({ payments: 128, pairedClaims: 384 });
export interface SectMaintenancePayment {
  readonly paymentId: string;
  readonly reservationId: string;
  readonly buildingId: string;
  readonly sourceJobId: string;
  /** null refers to the immutable construction-paid first period. */
  readonly predecessorPaymentId: string | null;
  readonly previousDueCalendarTick: number;
  readonly paidTick: number;
  readonly paidCalendarTick: number;
  readonly dueCalendarTick: number;
}
export interface SectMaintenanceState {
  readonly nextId: number;
  readonly payments: readonly SectMaintenancePayment[];
}
/** Isolated four-domain candidate, not a registered World/codec/UI schema. Construction owns
 * the only map, people, clock and paired ledger. No persisted operational or paid-through flag. */
export interface SectMaintenanceFrame extends SectResearchFrame {
  readonly maintenance: SectMaintenanceState;
}
export type SectMaintenanceContext = SectResearchContext;
export type SectMaintenanceResult =
  | { readonly ok: true; readonly frame: SectMaintenanceFrame; readonly repeated: boolean; readonly jobId: string | null }
  | { readonly ok: false; readonly frame: SectMaintenanceFrame; readonly code: SectResearchRejection };
export interface SectMaintenanceStatus {
  readonly buildingId: string;
  readonly operational: boolean;
  readonly dueCalendarTick: number;
  readonly deficits: readonly SectResourceLine[];
  readonly renewalBlock: 'HISTORY_EXHAUSTED' | 'ID_LIMIT' | 'CLOCK_LIMIT' | 'INSUFFICIENT_INVENTORY' | null;
}
