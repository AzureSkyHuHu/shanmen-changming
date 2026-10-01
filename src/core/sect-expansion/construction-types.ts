import type { SectCatalogIdentity, SectCell, SectResourceLine } from '../../content/sect-v9/types';
import type { JobNavigation } from '../agents/navigation';
import type { SectLedgerContext } from './ledger';
import type { PlacedBuildingSpace, SectPlacementRequest } from './types';
import type { WorldMap } from '../world/types';

/** Finite candidate history. Nothing is evicted; a future World archive/budget bridge is required. */
export const CONSTRUCTION_LIMITS = Object.freeze({ blueprints: 16, activeJobs: 36, buildings: 200, records: 128, receipts: 384, externalClaims: 108 });
export interface ConstructionPerson {
  readonly id: string;
  readonly position: SectCell;
  readonly lifeState: 'alive' | 'pendingDeath' | 'dead';
  readonly canWork: boolean;
  readonly away: boolean;
  readonly productionTransactionId: string | null;
  readonly cultivationOwnerId: string | null;
  readonly otherOwnerId: string | null;
}
export interface ConstructionStation {
  readonly id: string;
  readonly blueprintId: string;
  readonly x: number;
  readonly y: number;
  readonly operational: boolean;
}
export interface ConstructionClaim {
  readonly kind: 'worker' | 'seat' | 'entrance';
  /** Worker ID, construction blueprint ID for a seat, or "x,y" for an entrance. */
  readonly key: string;
  readonly ownerId: string;
}
/** Trusted internal adapter input, never a player command or serialized authorization. */
export interface ConstructionContext {
  readonly simulationTick: number;
  readonly calendarTick: number;
  readonly mode: 'management' | 'combat';
  readonly paused: boolean;
  readonly expeditionActive: boolean;
  readonly externalActiveJobs: number;
  readonly externalClaims: readonly ConstructionClaim[];
}
export interface ConstructionBlueprint extends SectPlacementRequest {
  readonly blueprintId: string;
  readonly placedTick: number;
  readonly placedCalendarTick: number;
  readonly status: 'planned' | 'started' | 'completed' | 'cancelled';
  readonly jobId: string | null;
  readonly endedTick: number | null;
}
export type ConstructionPhase = 'to-storage' | 'to-site' | 'working' | 'completed' | 'cancelled';
export type ConstructionBlock = 'PATH_BLOCKED' | 'PATH_BUDGET' | 'WORKER_UNAVAILABLE' | 'ENTRANCE_BUSY' | 'STORAGE_UNAVAILABLE' | 'PLACEMENT_CHANGED' | null;
export interface ConstructionVisit { readonly tick: number; readonly position: SectCell }
export interface ConstructionWorkSpan { readonly firstTick: number; readonly lastTick: number }
export interface ConstructionTerminal {
  readonly kind: 'completed' | 'cancelled';
  readonly tick: number;
  readonly calendarTick: number;
  readonly position: SectCell;
  readonly previousPhase: 'to-storage' | 'to-site' | 'working';
  readonly consumed: readonly SectResourceLine[];
  readonly released: readonly SectResourceLine[];
  readonly buildingId: string | null;
}
export interface ConstructionJob {
  readonly jobId: string;
  readonly blueprintId: string;
  readonly reservationId: string;
  /** Allocated at start so completion never needs a fresh ID. */
  readonly resultBuildingId: string;
  readonly workerId: string;
  readonly storageId: string;
  readonly seatToken: string;
  readonly entranceToken: string;
  readonly phase: ConstructionPhase;
  readonly startedTick: number;
  readonly startedCalendarTick: number;
  readonly origin: SectCell;
  readonly storageVisit: ConstructionVisit | null;
  readonly siteVisit: ConstructionVisit | null;
  /** Only actual productive management ticks are recorded; paused/travel ticks never appear. */
  readonly workSpans: readonly ConstructionWorkSpan[];
  readonly activeTicks: number;
  readonly navigation: JobNavigation;
  readonly blocked: ConstructionBlock;
  readonly terminal: ConstructionTerminal | null;
}
export interface ConstructionBuilding extends PlacedBuildingSpace {
  readonly sourceJobId: string;
  readonly completedTick: number;
  readonly completedCalendarTick: number;
  /** Construction includes the first month. Maintenance execution is deliberately not implemented. */
  readonly firstMaintenanceCalendarTick: number;
}
interface ConstructionCommandBase { readonly commandId: string; readonly expectedRevision: number }
export type ConstructionCommand = ConstructionCommandBase & (
  | { readonly kind: 'blueprint.place'; readonly placement: SectPlacementRequest }
  | { readonly kind: 'construction.start'; readonly blueprintId: string; readonly workerId: string }
  | { readonly kind: 'construction.cancel'; readonly blueprintId: string }
);
export interface ConstructionReceipt {
  readonly command: ConstructionCommand;
  readonly revision: number;
  readonly relatedId: string;
}
/**
 * Isolated, save-shaped domain candidate, not a World/save version. The future World bridge must
 * authenticate catalog/research provenance, every projected person and claim, source ledger,
 * clock progression, ID namespace, and whole-save completion/cancellation budget before publishing.
 * It must publish the frame's ledger, positions, navVersion and domain state atomically and must
 * invalidate ALL other systems' routes when navVersion changes. No RNG is read or written here.
 */
export interface ConstructionFrame {
  readonly schemaVersion: 1;
  readonly catalogIdentity: SectCatalogIdentity;
  readonly revision: number;
  readonly nextId: number;
  readonly lastSimulationTick: number;
  readonly lastCalendarTick: number;
  readonly map: WorldMap;
  readonly legacyStations: readonly ConstructionStation[];
  readonly people: readonly ConstructionPerson[];
  readonly ledger: SectLedgerContext;
  readonly blueprints: readonly ConstructionBlueprint[];
  readonly jobs: readonly ConstructionJob[];
  readonly buildings: readonly ConstructionBuilding[];
  readonly receipts: readonly ConstructionReceipt[];
}
export interface ConstructionSeed {
  readonly map: WorldMap;
  readonly legacyStations: readonly ConstructionStation[];
  readonly people: readonly ConstructionPerson[];
  readonly ledger: SectLedgerContext;
  readonly simulationTick: number;
  readonly calendarTick: number;
}
export type ConstructionRejection = 'INVALID_FRAME' | 'INVALID_CONTEXT' | 'INVALID_COMMAND' | 'IDENTITY_CONFLICT' | 'STALE_REVISION'
  | 'STALE_CLOCK' | 'CLOCK_GAP' | 'CAPACITY_EXCEEDED' | 'UNKNOWN_BLUEPRINT' | 'TRANSACTION_FINISHED'
  | 'WORKER_UNAVAILABLE' | 'STORAGE_UNAVAILABLE' | 'CLAIM_CONFLICT' | 'PLACEMENT_CHANGED' | 'INSUFFICIENT_INVENTORY'
  | 'RESEARCH_AUTHORITY_REQUIRED' | 'MANAGEMENT_REQUIRED' | 'INVALID_RESERVATION';
export type ConstructionResult =
  | { readonly ok: true; readonly frame: ConstructionFrame; readonly repeated: boolean; readonly relatedId: string | null }
  | { readonly ok: false; readonly frame: ConstructionFrame; readonly code: ConstructionRejection };
export interface ConstructionValidationIssue { readonly code: string; readonly path: string }
