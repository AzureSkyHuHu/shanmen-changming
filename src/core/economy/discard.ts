import { RESOURCE_IDS, type InventoryLedger, type ResourceId, type ResourceLine } from './types';

export type InventoryDiscardCode = 'UNKNOWN_RESOURCE' | 'INVALID_QUANTITY' | 'INSUFFICIENT_AVAILABLE';
export type InventoryDiscardResult = { ok: true; inventory: InventoryLedger; discarded: ResourceLine }
  | { ok: false; code: InventoryDiscardCode };

/** Pure debit only. The command adapter owns confirmation, exact receipts, IDs and events. */
export function discardAvailable(inventory: InventoryLedger, resourceId: unknown, quantity: unknown): InventoryDiscardResult {
  if (typeof resourceId !== 'string' || !RESOURCE_IDS.includes(resourceId as ResourceId)) return { ok: false, code: 'UNKNOWN_RESOURCE' };
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) return { ok: false, code: 'INVALID_QUANTITY' };
  const id = resourceId as ResourceId;
  const entry = inventory[id];
  if (entry.owned - entry.reserved < quantity) return { ok: false, code: 'INSUFFICIENT_AVAILABLE' };
  return { ok: true, inventory: { ...inventory, [id]: { ...entry, owned: entry.owned - quantity } }, discarded: { resourceId: id, quantity } };
}
