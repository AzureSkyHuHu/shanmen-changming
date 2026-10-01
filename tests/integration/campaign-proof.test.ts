import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { allocateId } from '../../src/core/kernel/ids';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareWorldCampaignCommit } from '../../src/core/world/campaign-grants';
import { previewWorldCampaign } from '../../src/core/world/campaign-queries';
import { validateWorldCampaignProofs } from '../../src/core/world/campaign-proof';
import type { CampaignPlayerRequest } from '../../src/core/world/campaign-types';

function fresh() { return migrateWorldV7ToV8((JSON.parse(readFileSync(new URL('./fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8')) as { payload: unknown }).payload); }
function prepare(request: CampaignPlayerRequest) {
  const input = fresh(); const before = cloneJson(input);
  const command = { ...request, commandId: 'proof-player:1', expectedBasisStamp: previewWorldCampaign(input, request).basisStamp };
  const prepared = prepareWorldCampaignCommit(input, command);
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true); if (!prepared.ok) throw new Error(prepared.code);
  const allocated = allocateId(prepared.candidate.sequences, 'event');
  const world = { ...prepared.candidate, sequences: allocated.sequences };
  const event = { eventId: allocated.id, kind: 'campaign.committed', rootActionId: prepared.rootActionId, parentEventId: null,
    tick: world.clock.simulationTick, payload: prepared.proof };
  const receipt = { commandId: command.commandId, fingerprint: canonicalStringify({ kind: 'campaign.command', payload: { command } }),
    result: { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [event.eventId], rejection: null, campaignResult: prepared.result } };
  expect(input).toEqual(before);
  return { world, facts: { events: [event], receipts: [receipt] } };
}

describe('candidate campaign transaction proof relationships', () => {
  it.each<CampaignPlayerRequest>([
    { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' },
    { kind: 'campaign.lesson.learn', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' },
    { kind: 'campaign.recruit', routeId: 'route.qingfeng-trial', school: 'alchemy' },
  ])('accepts exact domain effects, payment, event and receipt for $kind', request => {
    const { world, facts } = prepare(request); const before = cloneJson({ world, facts });
    expect(validateWorldCampaignProofs(world, facts)).toMatchObject({ ok: true,
      claimIds: [facts.events[0]!.payload.claimId], paymentInstanceIds: [facts.events[0]!.payload.payment.reservationId],
      buildCommandIds: facts.events[0]!.payload.buildCommandIds, cultivationCommandIds: facts.events[0]!.payload.cultivationCommandIds });
    expect({ world, facts }).toEqual(before);
  });

  it('rejects a domain claim whose World transaction or mandatory domain effect is missing', () => {
    const { world, facts } = prepare({ kind: 'campaign.lesson.learn', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' });
    expect(validateWorldCampaignProofs(world, { events: [], receipts: [] })).toEqual({ ok: false, errors: ['Campaign claim lacks a defined World transaction proof'] });
    expect(validateWorldCampaignProofs(world, { events: facts.events, receipts: [] })).toEqual({ ok: false, errors: ['Orphan campaign commit event'] });
    const missing = cloneJson(world); missing.builds.history = missing.builds.history.filter(entry => !facts.events[0]!.payload.buildCommandIds.includes(entry.command.commandId));
    expect(validateWorldCampaignProofs(missing, facts)).toEqual({ ok: false, errors: ['Campaign build effect is missing or reused'] });
    const missingCultivation = cloneJson(world); missingCultivation.cultivation.authorityReceipts = [];
    expect(validateWorldCampaignProofs(missingCultivation, facts)).toEqual({ ok: false, errors: ['Campaign cultivation effect is missing or reused'] });
  });

  it.each(['cost', 'credit', 'owner', 'state', 'receipt-event', 'duplicate', 'extra'] as const)('rejects a changed %s transaction proof', tamper => {
    const { world, facts } = prepare({ kind: 'campaign.lesson.learn', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' });
    const proof = facts.events[0]!.payload;
    if (tamper === 'cost') proof.payment.lines[0]!.quantity += 1;
    if (tamper === 'credit') proof.creditedResources.push({ resourceId: 'meal', quantity: 1 });
    if (tamper === 'owner') proof.payment.ownerTransactionId = 'action:1';
    if (tamper === 'state') proof.payment.state = 'released';
    if (tamper === 'receipt-event') facts.receipts[0]!.result.eventIds = [];
    if (tamper === 'duplicate') facts.events.push(cloneJson(facts.events[0]!));
    if (tamper === 'extra') Object.assign(proof, { uncheckedGrant: 'equipment.storm-focus' });
    expect(validateWorldCampaignProofs(world, facts).ok).toBe(false);
  });

  it('anchors a recruited identity to the real commit month and rejects a later declared month', () => {
    const { world, facts } = prepare({ kind: 'campaign.recruit', routeId: 'route.qingfeng-trial', school: 'body' });
    const id = facts.receipts[0]!.result.campaignResult.discipleIds[0]!;
    const badIdentity = cloneJson(world); badIdentity.disciples.find(member => member.id === id)!.birthCalendarTick += 1;
    expect(validateWorldCampaignProofs(badIdentity, facts)).toEqual({ ok: false, errors: ['Campaign recruit identity differs from its committed profile/month'] });
    const future = cloneJson(facts); future.events[0]!.payload.calendarTick = world.clock.calendarTick + 1;
    expect(validateWorldCampaignProofs(world, future).ok).toBe(false);
  });

  it('rejects accessors without executing them', () => {
    const { world, facts } = prepare({ kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' });
    let called = false; Object.defineProperty(facts.events[0]!.payload, 'claimId', { enumerable: true, get() { called = true; return 'invented'; } });
    expect(validateWorldCampaignProofs(world, facts).ok).toBe(false); expect(called).toBe(false);
  });
});
