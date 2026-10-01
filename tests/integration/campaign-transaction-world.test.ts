import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { allocateId } from '../../src/core/kernel/ids';
import { appendEvent } from '../../src/core/kernel/events';
import { dispatchCommand } from '../../src/core/kernel/commands';
import { discardAvailable } from '../../src/core/economy/discard';
import { previewWorldCampaign } from '../../src/core/world/campaign-queries';
import { isCampaignCommandEnvelope, prepareWorldCampaignTransaction } from '../../src/core/world/campaign-transaction';
import { lookupCommandReceipt, lookupEvent, recordWorldReceipt } from '../../src/core/world/history-access';
import type { CampaignPlayerRequest } from '../../src/core/world/campaign-types';
import type { WorldState } from '../../src/core/world/types';
import type { WorldStateV8 } from '../../src/core/world/v8-types';

function source(): WorldState { return (JSON.parse(readFileSync(new URL('./fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8')) as { payload: WorldState }).payload; }
function fresh() { return migrateWorldV7ToV8(source()); }
function envelope(world: WorldStateV8, request: CampaignPlayerRequest, commandId = 'campaign:test') {
  return { commandId, sequence: 0, issuedTick: world.clock.simulationTick, kind: 'campaign.command' as const,
    payload: { command: { ...request, commandId, expectedBasisStamp: previewWorldCampaign(world, request).basisStamp } } };
}
const equipment: CampaignPlayerRequest = { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' };
function accepted(world = fresh(), request = equipment) {
  const command = envelope(world, request); const result = prepareWorldCampaignTransaction(world, command);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result));
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return { ...result, command };
}

describe('complete unpublished v8 campaign transactions', () => {
  it.each<CampaignPlayerRequest>([equipment, { kind: 'campaign.lesson.learn', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' },
    { kind: 'campaign.recruit', routeId: 'route.qingfeng-trial', school: 'body' }])('binds $kind to one World receipt/event/payment and exact domain effects', request => {
    const world = fresh(); const before = cloneJson(world); const result = accepted(world, request);
    expect(validateWorldStateV8(result.candidate)).toEqual([]);
    expect(result.result.eventIds).toHaveLength(1); const event = lookupEvent(result.candidate, result.result.eventIds[0]!)!;
    expect(event.kind).toBe('campaign.committed'); expect(event.payload.commandId).toBe(result.command.commandId);
    expect(event.payload.calendarTick).toBe(world.clock.calendarTick); expect(event.parentEventId).toBeNull();
    expect(lookupCommandReceipt(result.candidate, result.command.commandId)?.result).toEqual(result.result);
    expect(result.candidate.reservations).toEqual(world.reservations); expect(result.candidate.randomStreams).toEqual(world.randomStreams);
    expect(world).toEqual(before);
    const replay = prepareWorldCampaignTransaction(result.candidate, result.command);
    expect(replay.ok).toBe(true); if (!replay.ok) throw new Error(JSON.stringify(replay));
    expect(replay.replayed).toBe(true); expect(replay.candidate).toBe(result.candidate); expect(replay.result).toEqual(result.result);
    const conflict = cloneJson(result.command); conflict.payload.command.expectedBasisStamp = '00000000';
    expect(prepareWorldCampaignTransaction(result.candidate, conflict)).toMatchObject({ ok: false, result: { rejection: { code: 'COMMAND_CONFLICT' } } });
  });

  it('records a stale preview rejection exactly once without paying or acknowledging a claim', () => {
    const world = fresh(); const command = envelope(world, equipment); command.payload.command.expectedBasisStamp = '00000000';
    const result = prepareWorldCampaignTransaction(world, command);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.result).toMatchObject({ status: 'rejected', eventIds: [], rejection: { code: 'CAMPAIGN_REJECTED', campaignCode: 'PREVIEW_STALE' } });
    expect(result.candidate.campaign).toEqual(world.campaign); expect(result.candidate.inventory).toEqual(world.inventory); expect(result.candidate.sequences).toEqual(world.sequences);
    expect(validateWorldStateV8(result.candidate)).toEqual([]);
    expect(prepareWorldCampaignTransaction(result.candidate, command)).toMatchObject({ ok: true, replayed: true, result: result.result });
  });

  it('rejects stripped proofs, payment instance collisions and wrong outer result identities after reserialization', () => {
    const result = accepted();
    const stripped = cloneJson(result.candidate); delete stripped.commandReceipts[result.command.commandId];
    expect(validateWorldStateV8(stripped)).toContain('Orphan campaign commit event');
    const paymentCollision = cloneJson(result.candidate); const eventIndex = paymentCollision.events.findIndex(entry => entry.kind === 'campaign.committed');
    const event = paymentCollision.events[eventIndex]!; const payment = event.payload.payment;
    if (!payment || typeof payment !== 'object' || Array.isArray(payment)) throw new Error('Expected campaign payment');
    paymentCollision.events[eventIndex] = { ...event, payload: { ...event.payload, payment: { ...payment, reservationId: paymentCollision.builds.equipment[0]!.instanceId } } };
    expect(validateWorldStateV8(paymentCollision)).toContain('Invalid instance sequence continuity');
    const wrongResult = cloneJson(result.candidate);
    wrongResult.commandReceipts[result.command.commandId]!.result.campaignResult!.itemInstanceIds = [];
    expect(validateWorldStateV8(wrongResult)).toContain('Campaign result identity differs from committed grants');
  });

  it('keeps exact campaign proofs usable after both their event and receipt move to authenticated archive pages', () => {
    const result = accepted(); let world = result.candidate;
    // Exercise shared ledger/event/archive APIs with actual available stock. This
    // isolates archival preservation without pretending v8 is the live gateway.
    for (let index = 0; index < 64; index += 1) {
      const resourceId = world.inventory.wood.owned > 0 ? 'wood' : 'grain'; const commandId = `zz-discard:${index.toString().padStart(2, '0')}`;
      const discarded = discardAvailable(world.inventory, resourceId, 1); expect(discarded.ok).toBe(true); if (!discarded.ok) throw new Error(discarded.code);
      const action = allocateId(world.sequences, 'action');
      const emitted = appendEvent({ ...world, inventory: discarded.inventory, sequences: action.sequences }, { kind: 'inventory.discarded', rootActionId: action.id,
        parentEventId: null, payload: { commandId, resourceId, quantity: 1 } });
      world = recordWorldReceipt(emitted.world, { commandId, fingerprint: canonicalStringify({ kind: 'inventory.discard', payload: { resourceId, quantity: 1 } }),
        result: { commandId, status: 'accepted', transactionId: null, eventIds: [emitted.event.eventId], rejection: null, discardResult: { resourceId, quantity: 1 } } });
    }
    expect(world.events.some(event => event.kind === 'campaign.committed')).toBe(false); expect(world.commandReceipts[result.command.commandId]).toBeUndefined();
    expect(world.history.events.count).toBeGreaterThan(0); expect(world.history.commandReceipts.count).toBeGreaterThan(0);
    expect(validateWorldStateV8(JSON.parse(JSON.stringify(world)))).toEqual([]);
    const replay = prepareWorldCampaignTransaction(world, result.command);
    expect(replay).toMatchObject({ ok: true, replayed: true, result: result.result });
    if (replay.ok) expect(replay.candidate).toBe(world);
  });

  it('does not enable the candidate command through the still-live version 7 gateway', () => {
    const legacy = source(); const command = envelope(migrateWorldV7ToV8(legacy), equipment);
    expect(isCampaignCommandEnvelope(command)).toBe(true);
    const rejected = dispatchCommand(legacy, command);
    expect(rejected.world).toBe(legacy); expect(rejected.result.rejection?.code).toBe('INVALID_COMMAND');
  });
});
