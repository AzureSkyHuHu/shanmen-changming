import type { JobNavigation } from '../agents/navigation';
import type { SectRelocationRecordFrame } from './relocation-types';

export type SectRelocationBlock = 'WORKER_UNAVAILABLE' | 'CLAIM_CONFLICT' | 'ENTRANCE_BUSY' | 'PATH_BLOCKED' | 'PATH_BUDGET' | 'PLACEMENT_CHANGED' | null;
export interface SectRelocationLiveRuntime {
  readonly jobId: string;
  readonly navigation: JobNavigation;
  readonly blocked: SectRelocationBlock;
}
/** Detached local candidate. The single clock remains in records.construction. No World,
 * maintenance/research/level authority or public save/version is claimed by this envelope. */
export interface SectRelocationRuntimeFrame {
  readonly records: SectRelocationRecordFrame;
  readonly live: readonly SectRelocationLiveRuntime[];
}
export type SectRelocationRejection = 'INVALID_FRAME' | 'INVALID_CONTEXT' | 'INVALID_COMMAND' | 'STALE_CLOCK' | 'CLOCK_GAP'
  | 'STALE_REVISION' | 'IDENTITY_CONFLICT' | 'CAPACITY_EXCEEDED' | 'UNKNOWN_BUILDING' | 'UNKNOWN_JOB'
  | 'TRANSACTION_FINISHED' | 'WORKER_UNAVAILABLE' | 'BUILDING_BUSY' | 'CLAIM_CONFLICT' | 'PLACEMENT_CHANGED'
  | 'INSUFFICIENT_INVENTORY' | 'INVALID_RESERVATION' | 'MANAGEMENT_REQUIRED';
export type SectRelocationResult =
  | { readonly ok: true; readonly frame: SectRelocationRuntimeFrame; readonly jobId: string | null; readonly repeated: boolean }
  | { readonly ok: false; readonly frame: SectRelocationRuntimeFrame; readonly code: SectRelocationRejection };
