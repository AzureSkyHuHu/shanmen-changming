import { RESOURCE_IDS, type InventoryLedger, type ResourceId } from '../core/economy/types';

export interface InventoryDiscardRequest { resourceId: ResourceId; quantity: number }
export interface InventoryDiscardCommandResult { ok: boolean; code?: string }
export interface InventoryDiscardGuard { sessionEpoch: number; resourceId: ResourceId; owned: number; reserved: number; capacity: number }
export function matchesInventoryDiscardGuard(inventory: InventoryLedger, epoch: number, request: InventoryDiscardRequest, guard: InventoryDiscardGuard): boolean {
  if (!RESOURCE_IDS.includes(request.resourceId)) return false;
  const current = inventory[request.resourceId];
  return guard.sessionEpoch === epoch && guard.resourceId === request.resourceId && !!current
    && current.owned === guard.owned && current.reserved === guard.reserved && current.capacity === guard.capacity;
}
