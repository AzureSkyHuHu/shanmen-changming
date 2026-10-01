import type { AutomaticProductionState } from '../economy/automatic-types';
import type { HistoryArchive } from '../history/types';
import type { InventoryLedger, ProductionTransaction, Reservation } from '../economy/types';
import type { Command, CommandReceipt, CoreDiagnostic, DomainEvent } from '../kernel/contracts';
import type { WorldClock } from '../kernel/clock';
import type { RandomStreams } from '../kernel/random';
import type { SequenceState } from '../kernel/ids';
import type { BuildData } from '../builds/types';
import type { WorldExpeditionState } from '../expeditions/world-types';
import type { CultivationState } from '../cultivation/types';
import type { SectEconomyState } from '../sect-economy/types';

export const MAX_DISCIPLES = 36;
export interface GridPosition { x: number; y: number }
export interface WorldTile extends GridPosition { terrain: 'grass' | 'path' | 'forest' | 'stone' | 'water'; walkable: boolean }
export interface WorldMap { width: number; height: number; seed: string; generationVersion: 1; navVersion: number; tiles: WorldTile[] }
export interface Disciple {
  id: string;
  nameKey: string;
  ageMonths: number;
  birthCalendarTick: number;
  position: GridPosition;
  lifeState: 'alive' | 'pendingDeath' | 'dead';
  canWork: boolean;
  traveling: boolean;
  assignmentTransactionId: string | null;
  aptitude: number;
}
export interface WorldBuilding extends GridPosition { id: string; blueprintId: string; nameKey: string; operational: boolean; stationTransactionId: string | null }
/** Fields shared by frozen legacy schemas and v8. Domain authority stays in the selected version. */
export interface WorldStateBase<TDisciple extends Disciple = Disciple> {
  seed: string;
  simulationVersion: string;
  contentVersion: string;
  clock: WorldClock;
  randomStreams: RandomStreams;
  sequences: SequenceState;
  map: WorldMap;
  disciples: TDisciple[];
  buildings: WorldBuilding[];
  sectEconomy: SectEconomyState;
  history: HistoryArchive;
  automaticProduction: AutomaticProductionState;
  inventory: InventoryLedger;
  reservations: Record<string, Reservation>;
  transactions: Record<string, ProductionTransaction>;
  /** Source-owned live job index; historical ledgers are retained for idempotency. */
  activeProductionTransactionIds: string[];
  commandReceipts: Record<string, CommandReceipt>;
  pendingCommands: Command[];
  events: DomainEvent[];
  unlocks: string[];
  diagnostics: CoreDiagnostic[];
}
/** The live alias remains v7 until the complete v8 admission/budget boundary is ready. */
export interface WorldState extends WorldStateBase {
  cultivation: CultivationState;
  builds: BuildData;
  expedition: WorldExpeditionState;
}

/** Internal bootstrap/migration boundary before permanent builds and expedition state are attached. */
export type CultivationWorld = Omit<WorldState, 'builds' | 'expedition' | 'sectEconomy' | 'history' | 'automaticProduction'>;
