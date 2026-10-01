import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWorld, advanceTicks, dispatchCommand, CALENDAR_TICKS_PER_MONTH, setPauseReason, parseSave, stableHash } from '../../src/core/kernel';
import type { WorldState, PlayerCultivationCommand } from '../../src/core/kernel';
import { applyCultivationCommandV3, synchronizeCultivationAgesV3 } from '../../src/core/cultivation/v3';
import type { CultivationFrame } from '../../src/core/cultivation/v3';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { appendEvent } from '../../src/core/kernel/events';
import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { assertCampaignHistoricalAdmission } from '../../src/core/world/campaign-admission-proof';
import { prepareWorldCampaignCommit } from '../../src/core/world/campaign-grants';
import { prepareWorldCampaignTransaction, campaignTransactionPayload } from '../../src/core/world/campaign-transaction';
import { previewWorldCampaign } from '../../src/core/world/campaign-queries';
import { validateWorldCampaignProofs, collectWorldCampaignProofFacts } from '../../src/core/world/campaign-proof';
import { appendWorldEvents, recordWorldReceipt } from '../../src/core/world/history-access';
import { prepareWorldEstateSettlement } from '../../src/core/world/legacy-bridge';
import type { CampaignPlayerRequest } from '../../src/core/world/campaign-types';
import type { WorldStateV8 } from '../../src/core/world/v8-types';

type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
function actLegacy(world: WorldState, body: Body<PlayerCultivationCommand>) {
  const commandId = `historical:${world.cultivation.revision}`;
  const result = dispatchCommand(world, { commandId, sequence: 0, issuedTick: world.clock.simulationTick, kind: 'cultivation.command',
    payload: { command: { ...body, commandId, expectedRevision: world.cultivation.revision } as PlayerCultivationCommand } });
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function atRisk(world: WorldState) {
  const actor = world.disciples[0]!; const profile = world.cultivation.disciples[0]!;
  actor.birthCalendarTick = world.clock.calendarTick + 17 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  return world;
}
function oneDeath(previous = createWorld('campaign-real-prior-death')) {
  const pending = advanceTicks(atRisk(previous), 17); const profile = pending.cultivation.disciples[0]!;
  return migrateWorldV7ToV8(actLegacy(pending, { kind: 'death.finalize', discipleId: profile.discipleId, deathId: profile.pendingDeathId!, cause: 'lifespan', acknowledgeDeath: true }));
}
function envelope(world: WorldStateV8, request: CampaignPlayerRequest) {
  const commandId = 'historical:campaign';
  return { commandId, sequence: 0, issuedTick: world.clock.simulationTick, kind: 'campaign.command' as const,
    payload: { command: { ...request, commandId, expectedBasisStamp: previewWorldCampaign(world, request).basisStamp } } };
}
/** Negative import fixture: deliberately lie only to the trusted candidate
 * component about its roster, then restore the actual World actors. Every grant,
 * payment, event and receipt remains real; historical admission must catch the lie. */
function forgedRosterClaim(actual: WorldStateV8, request: CampaignPlayerRequest, visibleIds: string[]) {
  const lie = cloneJson(actual); lie.disciples = lie.disciples.filter(actor => visibleIds.includes(actor.id));
  const command = envelope(lie, request); const grant = prepareWorldCampaignCommit(lie, command.payload.command);
  expect(grant.ok, JSON.stringify(grant)).toBe(true); if (!grant.ok) throw new Error(grant.code);
  const originalIds = new Set(actual.disciples.map(actor => actor.id));
  let world = { ...grant.candidate, disciples: [...actual.disciples, ...grant.candidate.disciples.filter(actor => !originalIds.has(actor.id))] };
  const emitted = appendEvent(world, { kind: 'campaign.committed', rootActionId: grant.rootActionId, parentEventId: null, payload: campaignTransactionPayload(grant.proof) });
  world = recordWorldReceipt(emitted.world, { commandId: command.commandId, fingerprint: canonicalStringify({ kind: command.kind, payload: command.payload }),
    result: { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [emitted.event.eventId], rejection: null, campaignResult: grant.result } });
  return world;
}
function mirror(world: WorldStateV8, frame: CultivationFrame): WorldStateV8 {
  return appendWorldEvents({ ...world, ...frame, disciples: world.disciples.map(actor => {
    const profile = frame.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    return { ...actor, ageMonths: profile.ageMonths, lifeState: profile.lifeState, canWork: profile.lifeState === 'alive' && actor.canWork };
  }), clock: { ...world.clock, pauseReasons: setPauseReason(world.clock, 'cultivation', frame.cultivation.pendingDeaths.length > 0).pauseReasons } },
  frame.cultivation.events.slice(world.cultivation.events.length).map(event => ({ eventId: event.eventId, kind: event.kind, rootActionId: event.rootActionId,
    tick: world.clock.simulationTick, parentEventId: null, payload: { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month } })));
}

describe('historical campaign admission authority', () => {
  it('rejects relief assembled with a one-survivor context when four original disciples actually lived', () => {
    const original = migrateWorldV7ToV8(createWorld('false-relief-roster'));
    const forged = forgedRosterClaim(original, { kind: 'campaign.relief', school: 'body' }, ['entity:1']);
    expect(validateWorldStateV8(forged)).toContain('Relief lacked its actual single-survivor basis');
  });
  it('rejects recovery assembled from one real old death while three original disciples still live, even on the same tick', () => {
    const original = oneDeath(); const forged = forgedRosterClaim(original, { kind: 'campaign.recover', acknowledgeLoss: true }, ['entity:1']);
    expect(forged.clock).toEqual(original.clock);
    expect(validateWorldStateV8(forged)).toContain('Recovery lacked an actual finalized total loss');
  });
  it.each<CampaignPlayerRequest>([
    { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' },
    { kind: 'campaign.lesson.learn', knowledgeId: 'knowledge.sun-piercing', discipleId: 'entity:1' },
    { kind: 'estate.assign', itemInstanceId: 'instance:1', discipleId: 'entity:1' },
  ])('rejects a personal $kind recipient who died earlier on the same simulation tick', request => {
    const world = oneDeath();
    expect(() => assertCampaignHistoricalAdmission(world, request, undefined, `action:${world.sequences.nextAction}`, `event:${world.sequences.nextEvent}`, world.clock.calendarTick))
      .toThrow('Campaign recipient was unavailable at commit');
  });
  it('rejects an equipment proof with a counterfeit living context for an actually deceased recipient', () => {
    const old = (JSON.parse(readFileSync(new URL('./fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8')) as { payload: WorldState }).payload;
    const actual = oneDeath(old); const lie = cloneJson(actual);
    lie.disciples[0] = { ...lie.disciples[0]!, lifeState: 'alive', canWork: true };
    lie.cultivation.disciples[0] = { ...lie.cultivation.disciples[0]!, lifeState: 'alive', deathId: null };
    // A fabricated context may even lie about age to pass its own primitive check.
    lie.cultivation.disciples[0]!.ageMonths -= 1;
    const request: CampaignPlayerRequest = { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' };
    const command = envelope(lie, request); const grant = prepareWorldCampaignCommit(lie, command.payload.command);
    expect(grant.ok, JSON.stringify(grant)).toBe(true); if (!grant.ok) throw new Error(grant.code);
    const emitted = appendEvent({ ...grant.candidate, disciples: actual.disciples, cultivation: actual.cultivation },
      { kind: 'campaign.committed', rootActionId: grant.rootActionId, parentEventId: null, payload: campaignTransactionPayload(grant.proof) });
    const world = recordWorldReceipt(emitted.world, { commandId: command.commandId, fingerprint: canonicalStringify({ kind: command.kind, payload: command.payload }),
      result: { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [emitted.event.eventId], rejection: null, campaignResult: grant.result } });
    expect(validateWorldCampaignProofs(world, collectWorldCampaignProofFacts(world))).toEqual({ ok: false, errors: ['Campaign recipient was unavailable at commit'] });
  });
  it('keeps an explicitly unknown old death import valid but does not infer historical claim eligibility from it', () => {
    const old: Record<string, unknown> = JSON.parse(readFileSync(new URL('./fixtures/save-v2-in-progress.json', import.meta.url), 'utf8'));
    const payload = old.payload as { disciples: { lifeState: string; canWork: boolean }[] };
    payload.disciples[0]!.lifeState = 'dead'; payload.disciples[0]!.canWork = false;
    const { checksum: _checksum, ...body } = old; const parsed = parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }));
    expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message);
    const world = migrateWorldV7ToV8(parsed.world);
    expect(world.cultivation.deaths[0]!.cause).toBe('legacy-unknown'); expect(validateWorldStateV8(world)).toEqual([]);
    expect(() => assertCampaignHistoricalAdmission(world, { kind: 'campaign.recover', acknowledgeLoss: true }, undefined,
      `action:${world.sequences.nextAction}`, `event:${world.sequences.nextEvent}`, world.clock.calendarTick)).toThrow('Campaign eligibility lacks legacy lifecycle evidence');
  });
  it('preserves a genuine equipment claim after a later real lifespan death, inheritance, retirement and JSON roundtrip', () => {
    let previous = (JSON.parse(readFileSync(new URL('./fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8')) as { payload: WorldState }).payload;
    previous = actLegacy(previous, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' }); previous = atRisk(previous);
    let world = migrateWorldV7ToV8(previous);
    const request: CampaignPlayerRequest = { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' };
    const committed = prepareWorldCampaignTransaction(world, envelope(world, request));
    expect(committed.ok).toBe(true); if (!committed.ok) throw new Error(JSON.stringify(committed));
    expect(committed.result.status).toBe('accepted'); world = committed.candidate;
    const acquired = committed.result.campaignResult!.itemInstanceIds[0]!;
    world = { ...world, clock: { ...world.clock, simulationTick: world.clock.simulationTick + 17, calendarTick: world.clock.calendarTick + 17 } };
    const aged = synchronizeCultivationAgesV3({ cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences },
      Object.fromEntries(world.disciples.map(actor => [actor.id, Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH)])));
    expect(aged.ok).toBe(true); if (!aged.ok) throw new Error(aged.code); world = mirror(world, aged.frame);
    const profile = world.cultivation.disciples.find(member => member.discipleId === 'entity:1')!;
    const command = { kind: 'death.finalize' as const, commandId: 'historical:finalize', expectedRevision: world.cultivation.revision,
      discipleId: profile.discipleId, deathId: profile.pendingDeathId!, cause: 'lifespan' as const, acknowledgeDeath: true };
    const death = applyCultivationCommandV3({ cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences }, command);
    expect(death.ok).toBe(true); if (!death.ok) throw new Error(death.code);
    const eventIds = death.frame.cultivation.events.slice(world.cultivation.events.length).map(event => event.eventId);
    world = recordWorldReceipt(mirror(world, death.frame), { commandId: command.commandId, fingerprint: canonicalStringify({ kind: 'cultivation.command', payload: { command } }),
      result: { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds, rejection: null, cultivationResult: death.result } });
    const settled = prepareWorldEstateSettlement(world);
    expect(settled.ok, JSON.stringify(settled)).toBe(true); if (!settled.ok) throw new Error(settled.details.join('; '));
    expect(settled.candidate.builds.equipment.find(item => item.instanceId === acquired)!.owner).toEqual({ kind: 'disciple', discipleId: 'entity:2' });
    expect(validateWorldStateV8(JSON.parse(JSON.stringify(settled.candidate)))).toEqual([]);
  });
  it('rejects an otherwise matching campaign transaction relabeled onto its expedition action root', () => {
    const world = migrateWorldV7ToV8((JSON.parse(readFileSync(new URL('./fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8')) as { payload: unknown }).payload);
    const committed = prepareWorldCampaignTransaction(world, envelope(world, { kind: 'campaign.equipment.claim', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' }));
    expect(committed.ok).toBe(true); if (!committed.ok) throw new Error(JSON.stringify(committed));
    const forged = cloneJson(committed.candidate); const eventIndex = forged.events.findIndex(event => event.kind === 'campaign.committed');
    const event = forged.events[eventIndex]!; const originalRoot = event.rootActionId; const root = forged.expedition.run!.runId.replace('run:', 'action:');
    const rename = (id: string) => id.replace(`${originalRoot}/`, `${root}/`);
    const payment = event.payload.payment; if (!payment || typeof payment !== 'object' || Array.isArray(payment)) throw new Error('Missing payment');
    forged.events[eventIndex] = { ...event, rootActionId: root, payload: { ...event.payload, payment: { ...payment, ownerTransactionId: root },
      buildCommandIds: (event.payload.buildCommandIds as string[]).map(rename) } };
    forged.campaign.progress.claims[0]!.acknowledgement.transactionId = root;
    forged.builds.history = forged.builds.history.map(entry => ({ ...entry, command: { ...entry.command, commandId: rename(entry.command.commandId) } }));
    forged.builds.receipts = forged.builds.receipts.map(receipt => {
      const nextId = rename(receipt.commandId); const entry = forged.builds.history.find(value => value.command.commandId === nextId)!;
      return { ...receipt, commandId: nextId, fingerprint: canonicalStringify({ command: entry.command, authority: entry.authority }) };
    });
    const proof = validateWorldCampaignProofs(forged, collectWorldCampaignProofFacts(forged));
    expect(proof).toEqual({ ok: false, errors: ['Campaign action allocation boundary differs'] });
    expect(validateWorldStateV8(forged).length).toBeGreaterThan(0);
  });
});
