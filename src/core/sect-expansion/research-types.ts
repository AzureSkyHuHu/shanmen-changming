import type { SectCell, SectResearchId, SectResourceLine } from '../../content/sect-v9/types';
import type { JobNavigation } from '../agents/navigation';
import type { ConstructionContext, ConstructionFrame, ConstructionRejection, ConstructionValidationIssue } from './construction-types';
import type { SectProductionRejection, SectProductionState } from './production-types';

/** Non-evicting local evidence. No start may consume the remaining cancellation capacity. */
export const SECT_RESEARCH_LIMITS = Object.freeze({ records: 128, receipts: 256, activeJobs: 1, maximumWorkTicks: 400, visits: 401 });
export type SectResearchPhase = 'to-site' | 'working' | 'completed' | 'cancelled';
export type SectResearchBlock = 'PATH_BLOCKED' | 'PATH_BUDGET' | 'WORKER_UNAVAILABLE' | 'WORKSTATION_UNAVAILABLE' | 'ENTRANCE_BUSY' | 'VISIT_CAPACITY' | null;
export interface SectResearchVisit { readonly tick: number; readonly calendarTick: number; readonly position: SectCell }
export interface SectResearchWorkSpan {
  readonly firstTick: number; readonly lastTick: number;
  readonly firstCalendarTick: number; readonly lastCalendarTick: number;
  readonly visitIndex: number;
}
export interface SectResearchSiteProof {
  readonly buildingId: string; readonly sourceJobId: string; readonly position: SectCell;
  readonly level: 1; readonly firstMaintenanceCalendarTick: number;
}
export interface SectResearchPrerequisite { readonly researchId: SectResearchId; readonly completionJobId: string }
export interface SectResearchTerminal extends SectResearchVisit {
  readonly kind: 'completed' | 'cancelled'; readonly previousPhase: 'to-site' | 'working';
  readonly consumed: readonly SectResourceLine[]; readonly released: readonly SectResourceLine[];
}
/** Completion itself is the durable authority. No writable unlock/completed-ID/effect list. */
export interface SectResearchJob {
  readonly jobId: string; readonly reservationId: string; readonly researchId: SectResearchId; readonly workerId: string;
  readonly startedTick: number; readonly startedCalendarTick: number; readonly origin: SectCell;
  readonly site: SectResearchSiteProof; readonly prerequisites: readonly SectResearchPrerequisite[];
  readonly phase: SectResearchPhase; readonly activeTicks: number; readonly requiredTicks: number;
  readonly visits: readonly SectResearchVisit[]; readonly workSpans: readonly SectResearchWorkSpan[];
  readonly navigation: JobNavigation; readonly blocked: SectResearchBlock; readonly terminal: SectResearchTerminal | null;
}
interface CommandBase { readonly commandId: string; readonly expectedRevision: number }
export type SectResearchCommand = CommandBase & (
  | { readonly kind: 'research.start'; readonly researchId: SectResearchId; readonly workerId: string }
  | { readonly kind: 'research.cancel'; readonly jobId: string }
);
export interface SectResearchReceipt { readonly command: SectResearchCommand; readonly revision: number; readonly jobId: string }
export interface SectResearchState {
  readonly revision: number; readonly nextId: number;
  readonly jobs: readonly SectResearchJob[]; readonly receipts: readonly SectResearchReceipt[];
}
/**
 * Isolated three-domain candidate. Construction is the SOLE projection of map, people, clocks,
 * both stocks and reservation book. World/codec/Session/UI integration remains closed. A future
 * authenticated World bridge must prove legacy owners, IDs, clock/lifecycle provenance, archive,
 * actual 4 MiB/reader and exit capacity. Maintenance and authenticated gate consumers are absent.
 */
export interface SectResearchFrame {
  readonly schemaVersion: 1; readonly construction: ConstructionFrame;
  readonly production: SectProductionState; readonly research: SectResearchState;
}
export type SectResearchContext = ConstructionContext;
export type SectResearchRejection = ConstructionRejection | SectProductionRejection
  | 'UNKNOWN_RESEARCH' | 'PREREQUISITE_REQUIRED' | 'RESEARCH_ACTIVE' | 'RESEARCH_COMPLETED';
export type SectResearchResult =
  | { readonly ok: true; readonly frame: SectResearchFrame; readonly repeated: boolean; readonly jobId: string | null }
  | { readonly ok: false; readonly frame: SectResearchFrame; readonly code: SectResearchRejection };
export type SectResearchValidationIssue = ConstructionValidationIssue;
