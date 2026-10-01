import { describe, expect, it, vi } from 'vitest';
// A reduced real codec/budget ceiling exercises the exact last-slot transition
// without fabricating an impossible >4-million-node World fixture.
vi.mock('../../src/core/history/types', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/history/types')>(), MAX_HISTORY_RECORDS_PER_TABLE: 3,
}));
import { advanceTicksWithStatus, createWorld, dispatchCommand, enqueueCommands, lookupCommandReceipt, validateWorldState,
  type Command, type WorldState } from '../../src/core/kernel';
import { assessAutomaticWorkBudget } from '../../src/core/save-budget';
import { worldAutomaticBudgetInput } from '../../src/core/world/automatic-work-bridge';
function submit(world: WorldState, commandId: string, discard = false) {
  return dispatchCommand(world, { commandId, sequence: 1, issuedTick: 0, ...(discard
    ? { kind: 'inventory.discard', payload: { resourceId: 'wood', quantity: 1 } }
    : { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } }) }).world;
}
describe('exact queued retention slot admission', () => {
  it.each(['setting', 'discard', 'rejected'] as const)('consumes one admitted final slot for %s, without counting the same queue obligation twice', (kind) => {
    let world = createWorld(); world = submit(world, 'first', kind === 'discard'); world = submit(world, 'second', kind === 'discard');
    const command: Command = { commandId: 'last', sequence: 1, issuedTick: 0, ...(kind === 'discard'
      ? { kind: 'inventory.discard', payload: { resourceId: 'wood', quantity: 1 } } as const
      : kind === 'rejected' ? { kind: 'production.cancel', payload: { transactionId: 'instance:99999' } } as const
        : { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } } as const) };
    const queued = enqueueCommands(world, [command]);
    expect(assessAutomaticWorkBudget(worldAutomaticBudgetInput(queued)).archiveSlots.reserved.commandReceipts).toBe(1);
    const result = advanceTicksWithStatus(queued, 1);
    expect(result.capacityStop).toBeNull(); expect(result.invariantStop).toBeNull(); expect(result.world.pendingCommands).toEqual([]);
    expect(result.world.clock.pauseReasons).not.toContain('save-capacity');
    expect(lookupCommandReceipt(result.world, 'last')!.result.status).toBe(kind === 'rejected' ? 'rejected' : 'accepted');
    expect(Object.keys(result.world.commandReceipts)).toHaveLength(3); expect(validateWorldState(result.world)).toEqual([]);
    if (kind === 'discard') expect(result.world.events).toHaveLength(3);
  });
});
