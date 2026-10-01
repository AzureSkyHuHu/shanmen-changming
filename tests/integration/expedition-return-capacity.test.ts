import { describe, expect, it } from 'vitest';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { assessDepartureReturnInventory, assessRunReturnInventory, remainingRunCommandReserve, returnClearanceReservation } from '../../src/core/world/expedition-return-capacity';
import { dispatchCommandV8 } from '../../src/core/kernel/commands-v8';
import { getWorldContent } from '../../src/core/world/content-access';
import { CAMPAIGN_ROUTE_IDS } from '../../src/core/campaign/types';
import { RESOURCE_IDS } from '../../src/core/economy/types';
import { copy } from '../../src/core/expeditions/shared';

function departure() {
  const world = createWorldV8('return-capacity'); const squadIds = world.disciples.slice(0, 2).map(actor => actor.id);
  const departed = dispatchCommandV8(world, { kind: 'expedition.command', commandId: 'capacity:depart', sequence: 1, issuedTick: 0, payload: {
    command: { kind: 'expedition.depart', commandId: 'capacity:depart', request: { routeId: 'route.qingfeng-trial', squadIds } } } });
  expect(departed.result.status).toBe('accepted'); return departed.world;
}
describe('registered return inventory and clearance reservations', () => {
  it.each(CAMPAIGN_ROUTE_IDS)('bounds every generated regular-node choice in %s', routeId => {
    const world = createWorldV8('return-ceiling'); const content = getWorldContent(world);
    const route = content.routes.find(entry => entry.id === routeId)!.specification;
    const squadIds = world.disciples.slice(0, 2).map(actor => actor.id);
    const bound = assessDepartureReturnInventory(world, { routeId, squadIds }); expect(bound.fits).toBe(true);
    const choices = route.regularEncounterIds;
    for (const first of choices) for (const second of choices) {
      const encounters = [first, second, route.bossEncounterId].map(id => content.encounters.find(encounter => encounter.id === id)!);
      for (const resourceId of RESOURCE_IDS) {
        // Upper arrival credits with two supply choices and all planned meals paid.
        const reward = encounters.reduce((sum, encounter) => sum + [...encounter.securedLoot, ...encounter.unsecuredLoot]
          .filter(line => line.resourceId === resourceId).reduce((total, line) => total + line.quantity, 0), 0) + (resourceId === 'meal' ? 4 : 0);
        expect(bound.creditCeilings.find(line => line.resourceId === resourceId)?.quantity ?? 0).toBeGreaterThanOrEqual(reward);
      }
    }
  });
  it('distinguishes full existing inventory from incoming loot which cannot fit even after a discard', () => {
    const world = createWorldV8('physical-cap'); const squadIds = world.disciples.slice(0, 2).map(actor => actor.id);
    world.inventory.wood = { ...world.inventory.wood, owned: world.inventory.wood.capacity };
    expect(assessDepartureReturnInventory(world, { routeId: 'route.qingfeng-trial', squadIds }).fits).toBe(true);
    world.inventory.wood = { ...world.inventory.wood, owned: 1, capacity: 1 };
    expect(assessDepartureReturnInventory(world, { routeId: 'route.qingfeng-trial', squadIds }).impossibleResources).toContain('wood');
  });
  it('reserves finite continuation rows and all six complete discard acknowledgements without mutating the World', () => {
    const world = departure(); const before = copy(world);
    const row = remainingRunCommandReserve(world); expect(row.current).toBe(2); expect(row.reserved).toBeGreaterThan(10); expect(row.fits).toBe(true);
    const clearance = returnClearanceReservation(world);
    expect(clearance.maximumDiscardOperations).toBe(6); expect(clearance.archiveRows.events).toBe(6);
    expect(clearance.archiveRows.commandReceipts).toBe(6 + row.reserved); expect(clearance.bytes).toBeGreaterThan(10_000);
    expect(clearance.archiveDecodedNodes).toBe(clearance.bytes + 32 * (clearance.archiveRows.commandReceipts + clearance.archiveRows.events));
    expect(assessRunReturnInventory(world).fits).toBe(true); expect(world).toEqual(before);
  });
});
