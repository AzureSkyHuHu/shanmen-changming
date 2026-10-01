import { describe, expect, it } from 'vitest';
import { STARTER_ROUTE_ID } from '../../src/core/expeditions/encounter-catalog';
import type { PlayerExpeditionCommand } from '../../src/core/expeditions/world-types';
import {
  advanceTicks, CALENDAR_TICKS_PER_MONTH, createSaveEnvelope, createWorld, dispatchCommand, domainHash,
  lookupProduction, parseSave, serializeSave, validateWorldState, worldEventsSince,
  type Command, type WorldState,
} from '../../src/core/kernel';

type ExpeditionInput = PlayerExpeditionCommand extends infer C ? C extends PlayerExpeditionCommand ? Omit<C, 'commandId'> : never : never;
const metadata = { buildId: 'inventory-return-recovery', savedAt: '2026-10-01T11:00:00Z' };
function accepted(world: WorldState, command: Command) {
  const outcome = dispatchCommand(world, command);
  expect(outcome.result.status, JSON.stringify(outcome.result.rejection)).toBe('accepted');
  return { ...outcome, command };
}
function expedition(world: WorldState, commandId: string, input: ExpeditionInput) {
  return accepted(world, { kind: 'expedition.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { command: { ...input, commandId } as PlayerExpeditionCommand } });
}
function reload(world: WorldState): WorldState {
  const encoded = serializeSave(createSaveEnvelope(world, metadata));
  const parsed = parseSave(encoded);
  expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(domainHash(parsed.world)).toBe(domainHash(world));
  expect(validateWorldState(parsed.world)).toEqual([]);
  return parsed.world;
}

/** Every change below is a normal player command, fixed-tick advance, or validated save restore. */
describe('player-command-only full-store expedition recovery', () => {
  it('gathers to capacity, earns actual battle loot, reloads a blocked return, discards once and settles once', () => {
    let world = createWorld('capacity-return');
    const workerId = world.disciples[1]!.id;
    const firstHerbs = world.inventory.herbs.owned;
    const capacity = world.inventory.herbs.capacity;
    expect(firstHerbs).toBe(6); expect(capacity).toBe(999);
    const gatheringIds: string[] = [];
    // 331 real worksite → labor → storage deliveries, with no inventory or capacity fixture edits.
    for (let delivery = 0; delivery < 331; delivery += 1) {
      const start = accepted(world, { kind: 'production.start', commandId: `recovery.gather.${String(delivery).padStart(3, '0')}`,
        sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick, payload: { recipeId: 'gather.herbs', workerId } });
      const transactionId = start.result.transactionId!;
      gatheringIds.push(transactionId);
      world = advanceTicks(start.world, 150);
      expect(lookupProduction(world, transactionId)?.state, `gathering delivery ${delivery}`).toBe('Committed');
      expect(world.inventory.herbs.owned).toBe(firstHerbs + (delivery + 1) * 3);
      expect(world.diagnostics).toEqual([]);
    }
    expect(world.inventory.herbs.owned).toBe(capacity);
    expect(world.inventory.herbs.reserved).toBe(0);
    expect(gatheringIds).toHaveLength(331);
    expect(world.activeProductionTransactionIds).toEqual([]);
    expect(validateWorldState(world)).toEqual([]);

    const squadIds = world.disciples.slice(0, 2).map(disciple => disciple.id);
    world = expedition(world, 'recovery.depart', { kind: 'expedition.depart', request: { squadIds, routeId: STARTER_ROUTE_ID } }).world;
    world = advanceTicks(world, CALENDAR_TICKS_PER_MONTH * 2);
    expect(world.expedition.run?.phase).toBe('AtNode');
    world = expedition(world, 'recovery.encounter', { kind: 'expedition.continue' }).world;
    expect(world.expedition.run?.phase).toBe('InEncounter');
    // Real starter encounter controller, stats, actions, damage and reward creation.
    for (let step = 0; step < 70 && world.expedition.run?.phase === 'InEncounter'; step += 1) world = advanceTicks(world, 60);
    expect(world.expedition.run?.phase).toBe('RewardPending');
    world = expedition(world, 'recovery.retreat', { kind: 'expedition.retreat' }).world;
    const settlement = world.expedition.run!.settlement!;
    const actualHerbLoot = settlement.loot.find(line => line.resourceId === 'herbs')!;
    expect(actualHerbLoot).toBeDefined(); expect(actualHerbLoot.quantity).toBeGreaterThan(0);
    expect(settlement.committed).toBe(false);
    world = expedition(world, 'recovery.return-travel', { kind: 'expedition.continue' }).world;
    world = advanceTicks(world, CALENDAR_TICKS_PER_MONTH * 2);
    expect(world.expedition.run?.phase).toBe('Ending');
    expect(world.expedition.blockedReason).toBe('INVENTORY_FULL');
    expect(world.expedition.run?.settlement?.committed).toBe(false);
    expect(world.expedition.effectReceipts.filter(receipt => receipt.kind === 'runSettled')).toHaveLength(0);
    expect(world.expedition.history).toHaveLength(0);
    expect(world.clock.pauseReasons).toContain('expedition');
    expect(domainHash(advanceTicks(world, CALENDAR_TICKS_PER_MONTH))).toBe(domainHash(world));
    for (const discipleId of squadIds) {
      expect(world.builds.disciples.find(disciple => disciple.discipleId === discipleId)?.lock).toBeTruthy();
      expect(world.cultivation.disciples.find(disciple => disciple.discipleId === discipleId)?.activityOwner).toBeTruthy();
    }

    world = reload(world);
    const heldBeforeRecovery = Object.fromEntries(Object.values(world.inventory).map(resource => [resource.resourceId, resource.owned]));
    const credits = [...world.expedition.run!.settlement!.loot, ...world.expedition.run!.settlement!.unusedSupplies];
    const herbCredit = credits.filter(line => line.resourceId === 'herbs').reduce((total, line) => total + line.quantity, 0);
    const overflow = world.inventory.herbs.owned + herbCredit - world.inventory.herbs.capacity;
    expect(overflow).toBeGreaterThan(0);
    const discard = accepted(world, { kind: 'inventory.discard', commandId: 'recovery.discard-exact-overflow',
      sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick, payload: { resourceId: 'herbs', quantity: overflow } });
    world = discard.world;
    expect(discard.result.discardResult).toEqual({ resourceId: 'herbs', quantity: overflow });
    expect(world.inventory.herbs.owned).toBe(capacity - overflow);
    expect(world.inventory.herbs.reserved).toBe(0);
    expect(world.expedition.run?.phase).toBe('Ending');
    expect(world.expedition.run?.settlement?.committed).toBe(false);
    expect(world.clock.pauseReasons).toContain('expedition');
    expect(discard.result.eventIds).toHaveLength(1);
    const discardEvent = worldEventsSince(world, 0).filter(event => event.kind === 'inventory.discarded');
    expect(discardEvent).toHaveLength(1);
    expect(discardEvent[0]!.payload).toEqual({ commandId: discard.command.commandId, resourceId: 'herbs', quantity: overflow });

    world = reload(world);
    const duplicateDiscard = dispatchCommand(world, discard.command);
    expect(duplicateDiscard.world).toBe(world); expect(duplicateDiscard.result).toEqual(discard.result);
    const resumed = expedition(world, 'recovery.retry-return', { kind: 'expedition.continue' });
    world = resumed.world;
    expect(world.expedition.run?.phase).toBe('Ended');
    expect(world.expedition.blockedReason).toBeNull();
    expect(world.expedition.run?.settlement?.committed).toBe(true);
    expect(world.expedition.effectReceipts.filter(receipt => receipt.kind === 'runSettled')).toHaveLength(1);
    expect(world.expedition.history).toHaveLength(1);
    expect(world.clock.pauseReasons).not.toContain('expedition');
    expect(world.inventory.herbs.owned).toBe(capacity);
    for (const resource of Object.values(world.inventory)) {
      const credit = credits.filter(line => line.resourceId === resource.resourceId).reduce((total, line) => total + line.quantity, 0);
      expect(resource.owned).toBe(heldBeforeRecovery[resource.resourceId]! + credit - (resource.resourceId === 'herbs' ? overflow : 0));
    }
    for (const discipleId of squadIds) {
      expect(world.builds.disciples.find(disciple => disciple.discipleId === discipleId)?.lock).toBeNull();
      expect(world.cultivation.disciples.find(disciple => disciple.discipleId === discipleId)?.activityOwner).toBeNull();
    }
    world = reload(world);
    const replayReturn = dispatchCommand(world, resumed.command);
    expect(replayReturn.world).toBe(world); expect(replayReturn.result).toEqual(resumed.result);
    expect(dispatchCommand(world, discard.command).world).toBe(world);
    const afterTicks = advanceTicks(world, 20);
    expect(afterTicks.inventory).toEqual(world.inventory);
    expect(afterTicks.expedition.effectReceipts.filter(receipt => receipt.kind === 'runSettled')).toHaveLength(1);
    expect(worldEventsSince(afterTicks, 0).filter(event => event.kind === 'inventory.discarded')).toHaveLength(1);
    expect(validateWorldState(afterTicks)).toEqual([]);
  }, 180_000);
});
