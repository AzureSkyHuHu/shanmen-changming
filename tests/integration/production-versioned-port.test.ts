import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWorld } from '../../src/core/world/create-world';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { validateWorldState, validateWorldStateV8 } from '../../src/core/kernel/validation';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { cancelProduction, startProduction, tickProduction } from '../../src/core/economy/production';
import type { AutomaticWorld } from '../../src/core/economy/automatic-production';
import { recordWorldReceipt } from '../../src/core/world/history-access';
import type { WorldState } from '../../src/core/world/types';
import type { WorldStateV8 } from '../../src/core/world/v8-types';

function begin<W extends AutomaticWorld>(world: W): W {
  const commandId = 'typed.manual'; const payload = { recipeId: 'craft.plank', workerId: 'entity:2' };
  const result = startProduction(world, commandId, payload.recipeId, payload.workerId);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.rejection.code);
  return recordWorldReceipt(result.world, { commandId, fingerprint: canonicalStringify({ kind: 'production.start', payload }),
    result: { commandId, status: 'accepted', transactionId: result.transactionId, eventIds: result.eventIds, rejection: null } });
}
function cancel<W extends AutomaticWorld>(world: W, transactionId: string): W {
  const commandId = 'typed.cancel'; const result = cancelProduction(world, transactionId, { commandId });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.rejection.code);
  return recordWorldReceipt(result.world, { commandId, fingerprint: canonicalStringify({ kind: 'production.cancel', payload: { transactionId } }),
    result: { commandId, status: 'accepted', transactionId: result.transactionId, eventIds: result.eventIds, rejection: null } });
}
function shared(world: WorldState | WorldStateV8) {
  return { inventory: world.inventory, sequences: world.sequences, randomStreams: world.randomStreams,
    automaticProduction: world.automaticProduction, transactions: world.transactions, reservations: world.reservations,
    activeProductionTransactionIds: world.activeProductionTransactionIds, events: world.events, history: world.history, commandReceipts: world.commandReceipts,
    disciples: world.disciples.map(member => ({ id: member.id, position: member.position, traveling: member.traveling, assignmentTransactionId: member.assignmentTransactionId })) };
}

describe('shared production ports retain versioned World authority', () => {
  it('delivers the same manual work and archive under v7 and v8 without casting either World', () => {
    const source = createWorld('typed-production-port'); const migrated = migrateWorldV7ToV8(source);
    let legacy: WorldState = begin(source); let candidate: WorldStateV8 = begin(migrated);
    for (let tick = 0; tick < 800 && legacy.activeProductionTransactionIds.length; tick += 1) {
      legacy = tickProduction({ ...legacy, clock: { ...legacy.clock, simulationTick: legacy.clock.simulationTick + 1, calendarTick: legacy.clock.calendarTick + 1 } });
      candidate = tickProduction({ ...candidate, clock: { ...candidate.clock, simulationTick: candidate.clock.simulationTick + 1, calendarTick: candidate.clock.calendarTick + 1 } });
    }
    expect(legacy.activeProductionTransactionIds).toEqual([]); expect(legacy.inventory.plank.owned).toBe(2);
    expect(shared(candidate)).toEqual(shared(legacy));
    expect(candidate.builds).toBe(migrated.builds); expect(candidate.campaign).toBe(migrated.campaign); expect(candidate.legacy).toBe(migrated.legacy);
    expect(candidate.disciples.map(member => member.presentationId)).toEqual(migrated.disciples.map(member => member.presentationId));
    expect(validateWorldState(legacy)).toEqual([]); expect(validateWorldStateV8(candidate)).toEqual([]);
  });

  it('cancels a genuine automatic live job with identical exact receipt/pin/resource effects in both versions', () => {
    const source = (JSON.parse(readFileSync(new URL('./fixtures/save-v7-active-automatic.json', import.meta.url), 'utf8')) as { payload: WorldState }).payload;
    const migrated = migrateWorldV7ToV8(source); const before = cloneJson(migrated);
    const transactionId = Object.keys(source.automaticProduction.live)[0]!;
    expect(transactionId).toBeTruthy();
    const legacy: WorldState = cancel(source, transactionId); const candidate: WorldStateV8 = cancel(migrated, transactionId);
    expect(shared(candidate)).toEqual(shared(legacy)); expect(migrated).toEqual(before);
    expect(candidate.builds).toBe(migrated.builds); expect(candidate.cultivation).toBe(migrated.cultivation);
    expect(candidate.campaign).toBe(migrated.campaign); expect(candidate.legacy).toBe(migrated.legacy);
    expect(validateWorldState(legacy)).toEqual([]); expect(validateWorldStateV8(candidate)).toEqual([]);
  });
});
