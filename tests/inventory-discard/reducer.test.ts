import { describe, expect, it } from 'vitest';
import { discardAvailable } from '../../src/core/economy/discard';
import { createInventory } from '../../src/core/economy/inventory';

describe('explicit discard only consumes unreserved stock', () => {
  it('preserves escrow and input ownership while freeing actual capacity', () => {
    const inventory = createInventory();
    inventory.wood.reserved = 3;
    const before = structuredClone(inventory);
    expect(discardAvailable(inventory, 'wood', 22)).toEqual({ ok: false, code: 'INSUFFICIENT_AVAILABLE' });
    const result = discardAvailable(inventory, 'wood', 21);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.discarded).toEqual({ resourceId: 'wood', quantity: 21 });
    expect(result.inventory.wood).toMatchObject({ owned: 3, reserved: 3, capacity: 999 });
    expect(inventory).toEqual(before);
    expect(discardAvailable(result.inventory, 'wood', 1)).toEqual({ ok: false, code: 'INSUFFICIENT_AVAILABLE' });
  });
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects invalid quantity %s without changes', quantity => {
    const inventory = createInventory(); const before = structuredClone(inventory);
    expect(discardAvailable(inventory, 'wood', quantity)).toEqual({ ok: false, code: 'INVALID_QUANTITY' });
    expect(inventory).toEqual(before);
  });
  it.each(['__proto__', 'constructor', 'gold', null, 1])('rejects unknown resource %s', resource => {
    expect(discardAvailable(createInventory(), resource, 1)).toEqual({ ok: false, code: 'UNKNOWN_RESOURCE' });
  });
});
