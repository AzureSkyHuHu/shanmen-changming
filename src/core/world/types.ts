import type { InventoryLedger, ProductionTransaction, Reservation } from '../economy/types';
import type { Command, CommandReceipt, CoreDiagnostic, DomainEvent } from '../kernel/contracts';
import type { WorldClock } from '../kernel/clock';
import type { RandomStreams } from '../kernel/random';
import type { SequenceState } from '../kernel/ids';

export const MAX_DISCIPLES = 36;
export interface GridPosition { x: number; y: number }
export interface WorldTile extends GridPosition { terrain: 'grass' | 'path' | 'forest' | 'stone' | 'water'; walkable: boolean }
export interface WorldMap { width: number; height: number; seed: string; generationVersion: 1; tiles: WorldTile[] }
export interface Disciple {
  id: string;
  nameKey: string;
  ageMonths: number;
  birthCalendarTick: number;
  position: GridPosition;
  lifeState: 'alive' | 'dead';
  canWork: boolean;
  traveling: boolean;
  assignmentTransactionId: string | null;
  aptitude: number;
}
export interface WorldBuilding extends GridPosition { id: string; blueprintId: string; nameKey: string; operational: boolean }
export interface WorldState {
  seed: string;
  simulationVersion: string;
  contentVersion: string;
  clock: WorldClock;
  randomStreams: RandomStreams;
  sequences: SequenceState;
  map: WorldMap;
  disciples: Disciple[];
  buildings: WorldBuilding[];
  inventory: InventoryLedger;
  reservations: Record<string, Reservation>;
  transactions: Record<string, ProductionTransaction>;
  commandReceipts: Record<string, CommandReceipt>;
  pendingCommands: Command[];
  events: DomainEvent[];
  unlocks: string[];
  diagnostics: CoreDiagnostic[];
}
