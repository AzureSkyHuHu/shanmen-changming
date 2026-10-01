import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { dispatchCommand } from '../../src/core/kernel';
import { lookupCommandReceipt, lookupProduction } from '../../src/core/world/history-access';

function campaignWithArchivedWork() {
  const session = new ApplicationSession();
  const workerId = session.getSnapshot().disciples[1]!.id;
  for (let index = 0; index < 70; index++) {
    const start = session.dispatch({ kind: 'production.start', payload: { workerId, recipeId: 'gather.wood' } });
    expect(start.status).toBe('accepted');
    const cancel = session.dispatch({ kind: 'production.cancel', payload: { transactionId: start.transactionId! } });
    expect(cancel.status).toBe('accepted');
  }
  return { session, workerId };
}
describe('application queries over archived campaign history', () => {
  it('restores receipt allocation without reusing archived or pending IDs', () => {
    const { session, workerId } = campaignWithArchivedWork();
    const world = session.exportWorld();
    expect(world.history.production.count).toBe(70);
    expect(world.commandReceipts['app-command.0']).toBeUndefined();
    const original = lookupCommandReceipt(world, 'app-command.0')!;
    expect(original.result.status).toBe('accepted');
    const replay = dispatchCommand(world, { commandId: 'app-command.0', sequence: 999, issuedTick: 0, kind: 'production.start', payload: { workerId, recipeId: 'gather.wood' } });
    expect(replay.result).toEqual(original.result);
    world.pendingCommands.push({ commandId: 'app-command.140', sequence: 140, issuedTick: 100, kind: 'production.start', payload: { workerId, recipeId: 'gather.wood' } });
    const restored = new ApplicationSession(world);
    const next = restored.dispatch({ kind: 'production.start', payload: { workerId, recipeId: 'gather.wood' } });
    expect(next.commandId).toBe('app-command.141');
    expect(next.status).toBe('accepted');
  });
  it('projects bounded recent terminal work from archive after reload', () => {
    const { session } = campaignWithArchivedWork();
    const world = session.exportWorld();
    expect(Object.keys(world.transactions)).toHaveLength(0);
    const restored = new ApplicationSession(world);
    const view = restored.getSnapshot();
    expect(view.recentEvents).toHaveLength(5);
    expect(view.transactions.length).toBeGreaterThan(0);
    expect(view.transactions.length).toBeLessThanOrEqual(5);
    for (const transaction of view.transactions) {
      expect(transaction.state).toBe('Cancelled');
      expect(lookupProduction(world, transaction.transactionId)?.state).toBe('Cancelled');
    }
    expect(view.recentEvents).toEqual(session.getSnapshot().recentEvents);
  });
});
