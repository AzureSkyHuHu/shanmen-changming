import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { createWorld } from '../../src/core/kernel';

describe('inventory discard authority guard', () => {
  it('debits once and rejects stale stock and campaign guards before issuing another command', () => {
    const session = new ApplicationSession();
    const resource = session.getSnapshot().resources.find(row => row.resourceId === 'herbs')!;
    const guard = { sessionEpoch: session.getSnapshot().sessionEpoch, resourceId: resource.resourceId, owned: resource.owned, reserved: resource.reserved, capacity: resource.capacity };
    const request = { resourceId: resource.resourceId, quantity: 1 };
    expect(session.dispatchInventoryDiscard(request, guard)).toEqual({ ok: true });
    expect(session.getSnapshot().resources.find(row => row.resourceId === 'herbs')!.owned).toBe(resource.owned - 1);
    const after = session.exportWorld();
    expect(session.dispatchInventoryDiscard(request, guard)).toEqual({ ok: false, code: 'STALE_INVENTORY' });
    expect(session.exportWorld()).toEqual(after);
    const event = session.getSnapshot().recentEvents.find(row => row.kind === 'inventory.discarded');
    expect(event).toMatchObject({ resourceId: 'herbs', quantity: 1 });
    session.replaceWorld(createWorld('replacement'));
    const replacement = session.exportWorld();
    expect(session.dispatchInventoryDiscard(request, guard).ok).toBe(false);
    expect(session.exportWorld()).toEqual(replacement);
  });
  it('does not change inventory while storage is read-only or an overlay is open', () => {
    const session = new ApplicationSession();
    const resource = session.getSnapshot().resources.find(row => row.resourceId === 'herbs')!;
    const guard = { sessionEpoch: session.getSnapshot().sessionEpoch, resourceId: resource.resourceId, owned: resource.owned, reserved: resource.reserved, capacity: resource.capacity };
    const before = session.exportWorld();
    session.setStorageReadOnly(true);
    expect(session.dispatchInventoryDiscard({ resourceId: 'herbs', quantity: 1 }, guard).ok).toBe(false);
    expect(session.exportWorld()).toEqual(before);
    session.setStorageReadOnly(false); session.setOverlayPaused(true);
    expect(session.dispatchInventoryDiscard({ resourceId: 'herbs', quantity: 1 }, guard).ok).toBe(false);
    expect(session.exportWorld()).toEqual(before);
  });
});
