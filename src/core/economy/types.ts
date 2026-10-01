import type { JobNavigation } from '../agents/navigation';

export const RESOURCE_IDS = ['wood', 'stone', 'herbs', 'grain', 'meal', 'plank'] as const;
export type ResourceId = typeof RESOURCE_IDS[number];
export interface ResourceLine { resourceId: ResourceId; quantity: number }
export interface InventoryEntry { resourceId: ResourceId; owned: number; reserved: number; capacity: number }
export type InventoryLedger = Record<ResourceId, InventoryEntry>;
export interface Reservation {
  reservationId: string;
  ownerTransactionId: string;
  lines: ResourceLine[];
  state: 'reserved' | 'committed' | 'released';
}
export interface RecipeDefinition {
  recipeId: string;
  nameKey: string;
  inputs: ResourceLine[];
  outputs: ResourceLine[];
  workTicks: number;
  workstation: 'forest' | 'herb-garden' | 'kitchen' | 'workshop';
  /** v1 consumes all inputs atomically at completion. Cancel only releases reservations. */
  commitPolicy: 'on-completion';
}
export type TransactionState = 'Requested' | 'Validated' | 'Reserved' | 'Running' | 'Committed' | 'Cancelled' | 'Blocked';
export const PRODUCTION_PHASES = ['WaitingForStation', 'TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery', 'Done', 'Cancelled'] as const;
export type ProductionPhase = typeof PRODUCTION_PHASES[number];
export const PRODUCTION_BLOCKED_REASONS = ['CAPACITY_EXCEEDED', 'WAITING_FOR_STATION', 'WORKER_UNAVAILABLE', 'WORKSTATION_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'PATH_BLOCKED'] as const;
export type ProductionBlockedReason = typeof PRODUCTION_BLOCKED_REASONS[number];
export interface ProductionTransaction {
  transactionId: string;
  rootActionId: string;
  commandId: string;
  recipeId: string;
  workerId: string;
  reservationId: string;
  state: TransactionState;
  activeTicks: number;
  requiredTicks: number;
  startedTick: number;
  completedTick: number | null;
  resultEventId: string | null;
  blockedReason: ProductionBlockedReason | null;
  phase: ProductionPhase;
  worksiteId: string | null;
  storageId: string | null;
  navigation: JobNavigation;
}
export type EconomyRejectionCode = 'INVALID_RESOURCE_LINE' | 'INSUFFICIENT_INVENTORY' | 'CAPACITY_EXCEEDED' | 'INVALID_RESERVATION';
export interface EconomyRejection { code: EconomyRejectionCode; resourceId?: ResourceId }
