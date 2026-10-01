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
  blockedReason: 'CAPACITY_EXCEEDED' | null;
}
export type EconomyRejectionCode = 'INVALID_RESOURCE_LINE' | 'INSUFFICIENT_INVENTORY' | 'CAPACITY_EXCEEDED' | 'INVALID_RESERVATION';
export interface EconomyRejection { code: EconomyRejectionCode; resourceId?: ResourceId }
