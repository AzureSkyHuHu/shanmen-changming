import { describe, expect, it } from 'vitest';
import { acknowledgeCampaignClaim, CAMPAIGN_ROUTES, campaignProgress, createCampaignState, prepareCampaignClaim, recordCampaignVictory } from '../../src/core/campaign';
import type { CampaignClaimRequest, CampaignRouteId } from '../../src/core/campaign';
import { STARTER_ROUTE, STARTER_ROUTE_ID } from '../../src/core/expeditions/encounter-catalog';
import { createExpedition } from '../../src/core/expeditions';
import { copy } from '../../src/core/campaign/shared';
import { atOffer, finishReturn, options, runToNode, transition } from '../expeditions/fixtures';
import { ack, catalog, claim, clear, cleared, context, lostContext, plan, settled } from './helpers';

describe('earned campaign progression', () => {
  it('reuses the existing starter identity and route instead of authoring a duplicate trial', () => {
    expect(CAMPAIGN_ROUTES[0]!.id).toBe(STARTER_ROUTE_ID);
    expect(CAMPAIGN_ROUTES[0]!.specification).toEqual(STARTER_ROUTE);
    expect(campaignProgress(createCampaignState())).toMatchObject({ completed: false, availableRouteIds: [STARTER_ROUTE_ID], archiveKnowledgeIds: [] });
  });
  it('records a committed victory, creates deterministic entitlements, and replays without mutation', () => {
    const before = createCampaignState(); const run = settled(); const result = recordCampaignVictory(before, STARTER_ROUTE_ID, run, catalog);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(before.revision).toBe(0);
    expect(campaignProgress(result.state)).toMatchObject({ availableRouteIds: [STARTER_ROUTE_ID, 'route.miasma-seal', 'route.thunder-seal'],
      archiveKnowledgeIds: ['knowledge.clear-heart', 'knowledge.sun-piercing'], unclaimedEquipmentRouteIds: [STARTER_ROUTE_ID], unclaimedRecruitRouteIds: [STARTER_ROUTE_ID] });
    const replay = recordCampaignVictory(result.state, STARTER_ROUTE_ID, run, catalog);
    expect(replay).toEqual({ ok: true, state: result.state, replayed: true });
    const repeated = recordCampaignVictory(result.state, STARTER_ROUTE_ID, settled(STARTER_ROUTE_ID, 'run-repeat'), catalog);
    expect(repeated).toEqual({ ok: true, state: result.state, replayed: true });
  });
  it.each([
    ['route.miasma-seal', 'route.thunder-seal'], ['route.thunder-seal', 'route.miasma-seal'],
  ] as const)('supports either seal order: %s before %s, then a finite finale and continued play', (first, second) => {
    let state = cleared(); state = clear(state, first);
    expect(campaignProgress(state).availableRouteIds).not.toContain('route.mountain-seal');
    state = clear(state, second); expect(campaignProgress(state).availableRouteIds).toContain('route.mountain-seal');
    state = clear(state, 'route.mountain-seal'); state = clear(state, 'route.everbright-finale');
    expect(campaignProgress(state)).toMatchObject({ completed: true, availableRouteIds: CAMPAIGN_ROUTES.map(route => route.id) });
    expect(recordCampaignVictory(state, STARTER_ROUTE_ID, settled(STARTER_ROUTE_ID, 'run-after-finale'), catalog)).toEqual({ ok: true, state, replayed: true });
  });
  it('cannot skip prerequisites by winning a locked authored route', () => {
    const state = createCampaignState();
    expect(recordCampaignVictory(state, 'route.mountain-seal', settled('route.mountain-seal'), catalog)).toMatchObject({ ok: false, code: 'ROUTE_LOCKED', state });
  });
  it('rejects unfinished, withdrawn, mislabeled, and externally edited victories', () => {
    const state = createCampaignState();
    expect(recordCampaignVictory(state, STARTER_ROUTE_ID, atOffer(), catalog)).toMatchObject({ ok: false, code: 'INVALID_VICTORY' });
    let retreat = runToNode(createExpedition(options({ route: copy(STARTER_ROUTE) }), catalog));
    retreat = finishReturn(transition(retreat, { kind: 'run.end', reason: 'safeRetreat' }).state);
    expect(recordCampaignVictory(state, STARTER_ROUTE_ID, retreat, catalog)).toMatchObject({ ok: false, code: 'INVALID_VICTORY' });
    expect(recordCampaignVictory(state, 'route.thunder-seal', settled(), catalog)).toMatchObject({ ok: false, code: 'INVALID_VICTORY' });
    const edited = copy(settled());
    edited.encounterResults.pop();
    expect(recordCampaignVictory(state, STARTER_ROUTE_ID, edited, catalog)).toMatchObject({ ok: false, code: 'INVALID_VICTORY' });
  });
  it('rejects reused run/settlement identity across different victories', () => {
    const first = settled(STARTER_ROUTE_ID, 'shared-run');
    const accepted = recordCampaignVictory(createCampaignState(), STARTER_ROUTE_ID, first, catalog); if (!accepted.ok) throw new Error(accepted.code);
    expect(recordCampaignVictory(accepted.state, 'route.miasma-seal', settled('route.miasma-seal', 'shared-run'), catalog)).toMatchObject({ ok: false, code: 'VICTORY_CONFLICT' });
  });
});

describe('atomic campaign claim proposals', () => {
  const gear = { kind: 'equipment', routeId: STARTER_ROUTE_ID, discipleId: 'entity:1' } as const;
  it('does not mark an item awarded when only a proposal was prepared or an adapter failed', () => {
    const state = cleared(); const world = context(); const prepared = plan(state, gear, world);
    expect(state.claims).toEqual([]); expect(state.revision).toBe(1);
    expect(prepared.grants).toEqual([{ kind: 'equipment', acquisitionId: `campaign/equipment/${STARTER_ROUTE_ID}`, discipleId: 'entity:1', definitionId: 'equipment.trail-robe' }]);
    const failure = acknowledgeCampaignClaim(state, prepared, world, { ...ack(prepared), acquisitionIds: [] });
    expect(failure).toMatchObject({ ok: false, code: 'INVALID_ACKNOWLEDGEMENT', state });
    expect(prepareCampaignClaim(state, gear, world)).toEqual({ ok: true, plan: prepared });
    const committed = acknowledgeCampaignClaim(state, prepared, world, ack(prepared)); if (!committed.ok) throw new Error(committed.code);
    expect(committed.state.claims).toHaveLength(1);
    expect(acknowledgeCampaignClaim(committed.state, prepared, world, ack(prepared))).toEqual({ ok: true, state: committed.state, replayed: true });
    expect(prepareCampaignClaim(committed.state, { ...gear, discipleId: 'entity:2' }, world)).toEqual({ ok: false, code: 'ALREADY_CLAIMED' });
  });
  it('rechecks target availability, context, amounts and revisions at atomic acknowledgement', () => {
    const state = cleared(); const world = context(); const prepared = plan(state, gear, world);
    const changed = context(); changed.revision++;
    expect(acknowledgeCampaignClaim(state, prepared, changed, ack(prepared))).toMatchObject({ ok: false, code: 'STALE_PLAN' });
    changed.disciples[0]!.available = false;
    expect(acknowledgeCampaignClaim(state, prepared, changed, ack(prepared))).toMatchObject({ ok: false, code: 'DISCIPLE_UNAVAILABLE' });
    const forged = copy(prepared);
    if (forged.grants[0]?.kind !== 'equipment') throw new Error('Expected equipment grant');
    forged.grants[0].definitionId = 'equipment.guardian-robe';
    expect(acknowledgeCampaignClaim(state, forged, world, ack(prepared))).toMatchObject({ ok: false, code: 'STALE_PLAN' });
    const advanced = clear(state, 'route.thunder-seal');
    expect(acknowledgeCampaignClaim(advanced, prepared, world, ack(prepared))).toMatchObject({ ok: false, code: 'STALE_PLAN' });
  });
  it('does not accept acknowledgement replay with a different transaction or grant list', () => {
    const state = cleared(); const prepared = plan(state, gear); const done = claim(state, gear);
    expect(acknowledgeCampaignClaim(done, prepared, context(), ack(prepared, 'other-transaction'))).toMatchObject({ ok: false, code: 'CLAIM_CONFLICT' });
    expect(acknowledgeCampaignClaim(state, prepared, context(), { ...ack(prepared), acquisitionIds: [prepared.claimId, prepared.claimId] })).toMatchObject({ ok: false, code: 'INVALID_ACKNOWLEDGEMENT' });
  });
  it('archives real skills, validates school and starter foundations, and charges fixed study resources', () => {
    const state = cleared(); const request = { kind: 'lesson', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' } as const;
    const prepared = plan(state, request);
    expect(prepared.costs).toEqual([{ resourceId: 'herbs', quantity: 2 }]);
    expect(prepared.grants).toEqual([{ kind: 'lesson', acquisitionId: 'campaign/lesson/knowledge.clear-heart/entity:3', discipleId: 'entity:3', knowledgeId: 'knowledge.clear-heart', skillId: 'skill.qingxin' }]);
    expect(prepareCampaignClaim(state, { ...request, discipleId: 'entity:1' }, context())).toEqual({ ok: false, code: 'WRONG_SCHOOL' });
    const noFoundation = context(); noFoundation.disciples[2]!.learnedSkillIds = [];
    expect(prepareCampaignClaim(state, request, noFoundation)).toEqual({ ok: false, code: 'MISSING_PREREQUISITE' });
    const already = context(); already.disciples[2]!.learnedSkillIds.push('skill.qingxin');
    expect(prepareCampaignClaim(state, request, already)).toEqual({ ok: false, code: 'ALREADY_LEARNED' });
    const poor = context(); poor.availableResources = [];
    expect(prepareCampaignClaim(state, request, poor)).toEqual({ ok: false, code: 'INSUFFICIENT_RESOURCES' });
    expect(prepareCampaignClaim(createCampaignState(), request, context())).toEqual({ ok: false, code: 'UNKNOWN_REWARD' });
  });
  it('offers one deterministic mortal recruit per invitation and rejects identity reuse or full rosters', () => {
    const state = cleared(); const request = { kind: 'recruit', routeId: STARTER_ROUTE_ID, school: 'alchemy', discipleId: 'entity:5' } as const;
    const prepared = plan(state, request);
    expect(prepared.costs).toEqual([{ resourceId: 'meal', quantity: 4 }]);
    expect(prepared.grants[0]).toMatchObject({ kind: 'recruit', discipleId: 'entity:5', profile: { school: 'alchemy', ageMonths: 240, lifespanMonths: 960, realm: 'mortal', injury: 0 } });
    expect(prepareCampaignClaim(state, { ...request, discipleId: 'entity:1' }, context())).toEqual({ ok: false, code: 'IDENTITY_REUSED' });
    const archived = context(); archived.archivedDiscipleIds = ['entity:5'];
    expect(prepareCampaignClaim(state, request, archived)).toEqual({ ok: false, code: 'IDENTITY_REUSED' });
    const full = context(); full.disciples = Array.from({ length: 36 }, (_, index) => ({ ...full.disciples[0]!, discipleId: `entity:${index + 1}` }));
    expect(prepareCampaignClaim(state, { ...request, discipleId: 'entity:37' }, full)).toEqual({ ok: false, code: 'ROSTER_FULL' });
    const done = claim(state, request);
    expect(prepareCampaignClaim(done, { ...request, school: 'body', discipleId: 'entity:6' }, context())).toEqual({ ok: false, code: 'ALREADY_CLAIMED' });
  });
  it('rejects executable input without invoking accessors and never freezes caller-owned context', () => {
    let calls = 0; const world = context(); const unsafe = { ...gear, get discipleId() { calls++; return 'entity:1'; } };
    expect(prepareCampaignClaim(cleared(), unsafe, world)).toEqual({ ok: false, code: 'INVALID_INPUT' }); expect(calls).toBe(0);
    plan(cleared(), gear, world); expect(Object.isFrozen(world)).toBe(false); expect(Object.isFrozen(world.disciples)).toBe(false);
  });
});

describe('standard-mode generational recovery', () => {
  const recovery: CampaignClaimRequest = { kind: 'recovery', discipleIds: ['entity:5', 'entity:6'], acknowledgeLoss: true };
  it('retains archives and unclaimed gear while proposing two new people and finite emergency supplies', () => {
    const state = cleared(); const world = lostContext(); const prepared = plan(state, recovery, world);
    expect(prepared.costs).toEqual([]); expect(prepared.recovery).toEqual({ generation: 1, terminalLossId: 'death:4' });
    expect(prepared.grants.map(grant => grant.kind)).toEqual(['recruit', 'recruit', 'resources']);
    expect(prepared.grants[2]).toMatchObject({ resources: [{ resourceId: 'grain', quantity: 8 }, { resourceId: 'meal', quantity: 4 }] });
    const next = claim(state, recovery, world);
    expect(campaignProgress(next)).toMatchObject({ recoveryGeneration: 1, archiveKnowledgeIds: campaignProgress(state).archiveKnowledgeIds,
      unclaimedEquipmentRouteIds: [STARTER_ROUTE_ID] });
    expect(world.disciples.every(disciple => disciple.lifeState === 'dead')).toBe(true);
    expect(prepareCampaignClaim(next, { ...recovery, discipleIds: ['entity:7', 'entity:8'] }, world)).toEqual({ ok: false, code: 'RECOVERY_UNAVAILABLE' });
  });
  it('never recovers pending/downed/living people, an active expedition, or a hardcore game', () => {
    for (const lifeState of ['alive', 'pendingDeath'] as const) {
      const world = lostContext(); world.disciples[0] = { ...world.disciples[0]!, lifeState, deathId: null, available: false };
      expect(prepareCampaignClaim(createCampaignState(), recovery, world)).toEqual({ ok: false, code: 'RECOVERY_UNAVAILABLE' });
    }
    const travelling = lostContext(); travelling.activeExpedition = true;
    expect(prepareCampaignClaim(createCampaignState(), recovery, travelling)).toEqual({ ok: false, code: 'RECOVERY_UNAVAILABLE' });
    expect(prepareCampaignClaim(createCampaignState('hardcore'), recovery, lostContext())).toEqual({ ok: false, code: 'RECOVERY_UNAVAILABLE' });
    expect(prepareCampaignClaim(createCampaignState(), { ...recovery, acknowledgeLoss: false } as unknown as CampaignClaimRequest, lostContext())).toEqual({ ok: false, code: 'LOSS_ACKNOWLEDGEMENT_REQUIRED' });
  });
  it('requires archiving dead full profiles before admitting past the 36-slot limit', () => {
    const full = lostContext(); full.disciples = Array.from({ length: 35 }, (_, index) => ({ ...full.disciples[0]!, discipleId: `entity:${index + 1}`, deathId: `death:${index + 1}` }));
    full.terminalLossId = 'death:35';
    expect(prepareCampaignClaim(createCampaignState(), { kind: 'recovery', discipleIds: ['entity:36', 'entity:37'], acknowledgeLoss: true }, full)).toEqual({ ok: false, code: 'ROSTER_FULL' });
    full.archivedDiscipleIds = full.disciples.map(disciple => disciple.discipleId); full.disciples = [];
    expect(prepareCampaignClaim(createCampaignState(), { kind: 'recovery', discipleIds: ['entity:36', 'entity:37'], acknowledgeLoss: true }, full).ok).toBe(true);
  });
  it('allows a later generation to study the same archive without copying its dead teacher or talents', () => {
    let state = claim(cleared(), { kind: 'lesson', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' });
    state = claim(state, recovery, lostContext());
    const descendants = context(); descendants.archivedDiscipleIds = descendants.disciples.map(disciple => disciple.discipleId);
    descendants.disciples = [{ ...descendants.disciples[2]!, discipleId: 'entity:6' }];
    const lesson = plan(state, { kind: 'lesson', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:6' }, descendants);
    expect(lesson.grants[0]).toMatchObject({ discipleId: 'entity:6', skillId: 'skill.qingxin' });
    expect(lesson.grants.every(grant => ['equipment', 'lesson', 'recruit', 'resources'].includes(grant.kind))).toBe(true);
  });
  it('permits another recovery only after a distinct later terminal loss and new identities', () => {
    const state = claim(cleared(), recovery, lostContext()); const nextLoss = lostContext();
    nextLoss.archivedDiscipleIds = nextLoss.disciples.map(disciple => disciple.discipleId);
    nextLoss.disciples = [
      { ...nextLoss.disciples[0]!, discipleId: 'entity:5', deathId: 'death:5' },
      { ...nextLoss.disciples[2]!, discipleId: 'entity:6', deathId: 'death:6' },
    ]; nextLoss.terminalLossId = 'death:6'; nextLoss.revision++;
    const prepared = plan(state, { kind: 'recovery', discipleIds: ['entity:7', 'entity:8'], acknowledgeLoss: true }, nextLoss);
    expect(prepared.recovery).toEqual({ generation: 2, terminalLossId: 'death:6' });
    expect(prepared.grants.every(grant => grant.acquisitionId.startsWith('campaign/recovery/2/'))).toBe(true);
    const empty = context(); empty.disciples = []; empty.terminalLossId = 'invented-death';
    expect(prepareCampaignClaim(createCampaignState(), recovery, empty)).toEqual({ ok: false, code: 'RECOVERY_UNAVAILABLE' });
  });
});
