import { isNonNegativeInteger } from '../kernel/numeric';
import { RESOURCE_IDS, type EconomyRejection, type InventoryLedger, type Reservation, type ResourceLine } from './types';

export function availableResource(entry: InventoryLedger[keyof InventoryLedger]): number { return entry.owned - entry.reserved; }
export function createInventory(): InventoryLedger {
  const initial = { wood: 24, stone: 12, herbs: 6, grain: 20, meal: 8, plank: 0 };
  return Object.fromEntries(RESOURCE_IDS.map((resourceId) => [resourceId, { resourceId, owned: initial[resourceId], reserved: 0, capacity: 999 }])) as InventoryLedger;
}

export function normalizeResourceLines(lines: readonly ResourceLine[]): ResourceLine[] | null {
  const totals = new Map<ResourceLine['resourceId'], number>();
  for (const line of lines) {
    if (!RESOURCE_IDS.includes(line.resourceId) || !isNonNegativeInteger(line.quantity) || line.quantity === 0) return null;
    const quantity = (totals.get(line.resourceId) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity)) return null;
    totals.set(line.resourceId, quantity);
  }
  return RESOURCE_IDS.filter((id) => totals.has(id)).map((resourceId) => ({ resourceId, quantity: totals.get(resourceId)! }));
}

type LedgerResult = { ok: true; inventory: InventoryLedger; reservation: Reservation } | { ok: false; rejection: EconomyRejection };
export function reserveResources(inventory: InventoryLedger, lines: readonly ResourceLine[], reservationId: string, ownerTransactionId: string): LedgerResult {
  const normalized = normalizeResourceLines(lines);
  if (!normalized) return { ok: false, rejection: { code: 'INVALID_RESOURCE_LINE' } };
  for (const line of normalized) {
    if (availableResource(inventory[line.resourceId]) < line.quantity) return { ok: false, rejection: { code: 'INSUFFICIENT_INVENTORY', resourceId: line.resourceId } };
  }
  const next = { ...inventory };
  for (const line of normalized) next[line.resourceId] = { ...next[line.resourceId], reserved: next[line.resourceId].reserved + line.quantity };
  return { ok: true, inventory: next, reservation: { reservationId, ownerTransactionId, lines: normalized, state: 'reserved' } };
}

export function releaseReservation(inventory: InventoryLedger, reservation: Reservation): LedgerResult {
  if (reservation.state === 'released') return { ok: true, inventory, reservation };
  if (reservation.state !== 'reserved') return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  if (reservation.lines.some((line) => inventory[line.resourceId].reserved < line.quantity)) return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  const next = { ...inventory };
  for (const line of reservation.lines) next[line.resourceId] = { ...next[line.resourceId], reserved: next[line.resourceId].reserved - line.quantity };
  return { ok: true, inventory: next, reservation: { ...reservation, state: 'released' } };
}

/** Validate the entire delta before applying any debit or credit. */
export function commitReservation(inventory: InventoryLedger, reservation: Reservation, outputs: readonly ResourceLine[]): LedgerResult {
  if (reservation.state === 'committed') return { ok: true, inventory, reservation };
  if (reservation.state !== 'reserved') return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
  const normalized = normalizeResourceLines(outputs);
  if (!normalized) return { ok: false, rejection: { code: 'INVALID_RESOURCE_LINE' } };
  const next = { ...inventory };
  for (const line of reservation.lines) {
    const entry = next[line.resourceId];
    if (entry.reserved < line.quantity || entry.owned < line.quantity) return { ok: false, rejection: { code: 'INVALID_RESERVATION' } };
    next[line.resourceId] = { ...entry, owned: entry.owned - line.quantity, reserved: entry.reserved - line.quantity };
  }
  for (const line of normalized) {
    const entry = next[line.resourceId];
    const owned = entry.owned + line.quantity;
    if (!Number.isSafeInteger(owned) || owned > entry.capacity) return { ok: false, rejection: { code: 'CAPACITY_EXCEEDED', resourceId: line.resourceId } };
    next[line.resourceId] = { ...entry, owned };
  }
  return { ok: true, inventory: next, reservation: { ...reservation, state: 'committed' } };
}
