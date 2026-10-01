import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import { acknowledgeCampaignClaimV2, campaignProgressV2, createCampaignStateV2, prepareCampaignClaimV2, recordCampaignVictoryV2,
  restoreCampaignV2, serializeCampaignV2, validateCampaignStateV2 } from '../../src/core/campaign/v2';
import { STANDARD_RELIEF_POLICY } from '../../src/core/campaign/v2-types';
import type { CampaignClaimPlanV2, CampaignDataV2, CampaignStateV2 } from '../../src/core/campaign/v2-types';
import type { CampaignClaimAcknowledgement, CampaignContext, Immutable } from '../../src/core/campaign/types';
import type { ExpeditionState } from '../../src/core/expeditions/types';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';

function context(month = 50): CampaignContext {
  return { revision: 1, calendarMonth: month, activeExpedition: false,
    disciples: [{ discipleId: 'entity:1', school: 'sword', lifeState: 'alive', deathId: null, available: true, learnedSkillIds: ['skill.liuhen-jian', 'skill.guifeng', 'skill.jianxin'] }],
    archivedDiscipleIds: ['entity:2', 'entity:3', 'entity:4'], availableResources: [{ resourceId: 'meal', quantity: 8 }], terminalLossId: null };
}
function acknowledgement(plan: Immutable<CampaignClaimPlanV2>): CampaignClaimAcknowledgement {
  return { kind: 'campaignEffectsCommitted', claimId: plan.claimId, planHash: plan.planHash,
    transactionId: `transaction/${plan.claimId}`, acquisitionIds: plan.grants.map(grant => grant.acquisitionId) };
}
function prepare(state = createCampaignStateV2(), basis = context(), discipleId = 'entity:50') {
  const result = prepareCampaignClaimV2(state, { kind: 'relief', school: 'alchemy', discipleId }, basis);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code); return result.plan;
}
function commit(state: CampaignStateV2, plan: Immutable<CampaignClaimPlanV2>, basis: CampaignContext) {
  const result = acknowledgeCampaignClaimV2(state, plan, basis, acknowledgement(plan));
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code); return result.state;
}
function cleared(): CampaignStateV2 {
  const text = readFileSync(new URL('../integration/fixtures/save-v7-ended-clear.json', import.meta.url), 'utf8');
  const run = (JSON.parse(text) as { payload: { expedition: { run: ExpeditionState } } }).payload.expedition.run;
  const result = recordCampaignVictoryV2(createCampaignStateV2(), 'route.qingfeng-trial', run, LEGACY_V7_CONTENT.combat);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code); return result.state;
}

describe('versioned standard relief recruitment domain', () => {
  it('matches the approved manifest and prepares a fixed new recruit for exactly eight meals', () => {
    expect(RELEASE_V8_CANDIDATE.campaign?.reliefPolicy).toEqual(STANDARD_RELIEF_POLICY);
    const state = createCampaignStateV2(); const basis = context(); const snapshot = cloneJson(basis); const plan = prepare(state, basis);
    expect(plan.costs).toEqual([{ resourceId: 'meal', quantity: 8 }]); expect(plan.relief).toEqual({ ordinal: 1, month: 50, survivorId: 'entity:1' });
    expect(plan.grants).toHaveLength(1); expect(plan.grants[0]).toMatchObject({ kind: 'recruit', discipleId: 'entity:50', acquisitionId: 'campaign/relief/1',
      profile: { school: 'alchemy', realm: 'mortal', injury: 0, cultivation: 0 } });
    expect(basis).toEqual(snapshot); expect(state.claims).toEqual([]);
    const next = commit(state, plan, basis); expect(next.clears).toEqual([]);
    expect(restoreCampaignV2(serializeCampaignV2(next))).toEqual(next);
    expect(campaignProgressV2(next)).toMatchObject({ reliefCount: 1, lastReliefMonth: 50, recoveryGeneration: 0 });
  });

  it.each(['hardcore', 'zero-living', 'two-living', 'pending-death', 'active-run', 'false-terminal-loss'] as const)('blocks relief at %s boundary', reason => {
    const basis = context(); const state = createCampaignStateV2(reason === 'hardcore' ? 'hardcore' : 'standard');
    if (reason === 'zero-living') basis.disciples = [];
    if (reason === 'two-living') basis.disciples.push({ ...basis.disciples[0]!, discipleId: 'entity:5' });
    if (reason === 'pending-death') basis.disciples[0]!.lifeState = 'pendingDeath', basis.disciples[0]!.available = false;
    if (reason === 'active-run') basis.activeExpedition = true;
    if (reason === 'false-terminal-loss') basis.terminalLossId = 'death:1';
    expect(prepareCampaignClaimV2(state, { kind: 'relief', school: 'alchemy', discipleId: 'entity:50' }, basis)).toMatchObject({ ok: false, code: 'RELIEF_UNAVAILABLE' });
  });

  it('requires all already-unlocked invitations to be spent, without resetting future invitations or first-clear facts', () => {
    let state = cleared(); const basis = context();
    expect(prepareCampaignClaimV2(state, { kind: 'relief', school: 'alchemy', discipleId: 'entity:50' }, basis)).toMatchObject({ ok: false, code: 'RELIEF_UNAVAILABLE' });
    const invited = prepareCampaignClaimV2(state, { kind: 'recruit', routeId: 'route.qingfeng-trial', school: 'body', discipleId: 'entity:10' }, basis);
    expect(invited.ok).toBe(true); if (!invited.ok) throw new Error(invited.code);
    state = commit(state, invited.plan, basis);
    // A later authoritative context supplies the finalized death/archive of that
    // recruit. The World integration must prove this context from real death facts.
    basis.archivedDiscipleIds.push('entity:10'); basis.revision++;
    const plan = prepare(state, basis); const next = commit(state, plan, basis);
    expect(next.clears).toEqual(state.clears); expect(campaignProgressV2(next).unclaimedRecruitRouteIds).toEqual([]);
    expect(next.claims.filter(receipt => receipt.plan.request.kind === 'recruit')).toHaveLength(1);
    expect(campaignProgressV2(next).availableRouteIds).not.toContain('route.everbright-finale');
  });

  it('allows another newly identified recruit at exactly twelve months, never before or by replaying the first plan', () => {
    const initial = createCampaignStateV2(); const firstContext = context(); const first = prepare(initial, firstContext);
    const state = commit(initial, first, firstContext);
    expect(acknowledgeCampaignClaimV2(state, first, firstContext, acknowledgement(first))).toMatchObject({ ok: true, replayed: true, state });
    const eleven = context(61); eleven.archivedDiscipleIds.push('entity:50');
    expect(prepareCampaignClaimV2(state, { kind: 'relief', school: 'body', discipleId: 'entity:51' }, eleven)).toMatchObject({ ok: false, code: 'RELIEF_COOLDOWN' });
    const twelve = { ...eleven, calendarMonth: 62 }; const second = prepare(state, twelve, 'entity:51');
    expect(second.claimId).toBe('campaign/relief/2'); expect(second.relief?.month).toBe(62);
    expect(restoreCampaignV2(serializeCampaignV2(commit(state, second, twelve))).claims).toHaveLength(2);
    expect(prepareCampaignClaimV2(state, { kind: 'relief', school: 'body', discipleId: 'entity:50' }, twelve)).toMatchObject({ ok: false, code: 'IDENTITY_REUSED' });
  });

  it('preserves affordable resource and full-roster checks, including archived identity non-reuse', () => {
    const basis = context(); basis.availableResources[0]!.quantity = 7;
    expect(prepareCampaignClaimV2(createCampaignStateV2(), { kind: 'relief', school: 'body', discipleId: 'entity:50' }, basis)).toMatchObject({ ok: false, code: 'INSUFFICIENT_RESOURCES' });
    basis.availableResources[0]!.quantity = 8;
    expect(prepareCampaignClaimV2(createCampaignStateV2(), { kind: 'relief', school: 'body', discipleId: 'entity:2' }, basis)).toMatchObject({ ok: false, code: 'IDENTITY_REUSED' });
    basis.archivedDiscipleIds = [];
    for (let i = 2; i <= 36; i++) basis.disciples.push({ discipleId: `entity:${i}`, school: 'sword', lifeState: 'dead', deathId: `death:${i}`, available: false, learnedSkillIds: [] });
    expect(prepareCampaignClaimV2(createCampaignStateV2(), { kind: 'relief', school: 'body', discipleId: 'entity:50' }, basis)).toMatchObject({ ok: false, code: 'ROSTER_FULL' });
  });

  it('keeps standard all-dead recovery separate and unchanged, with two new identities and the original food grant', () => {
    const basis = context(); basis.disciples[0] = { ...basis.disciples[0]!, lifeState: 'dead', deathId: 'death:1', available: false }; basis.terminalLossId = 'death:1';
    const initial = createCampaignStateV2();
    const planned = prepareCampaignClaimV2(initial, { kind: 'recovery', discipleIds: ['entity:50', 'entity:51'], acknowledgeLoss: true }, basis);
    expect(planned.ok).toBe(true); if (!planned.ok) throw new Error(planned.code);
    expect(planned.plan.relief).toBeNull(); expect(planned.plan.grants.filter(grant => grant.kind === 'recruit')).toHaveLength(2);
    expect(planned.plan.grants.find(grant => grant.kind === 'resources')).toMatchObject({ resources: [{ resourceId: 'grain', quantity: 8 }, { resourceId: 'meal', quantity: 4 }] });
    expect(campaignProgressV2(commit(initial, planned.plan, basis))).toMatchObject({ recoveryGeneration: 1, reliefCount: 0 });
  });

  it('rejects stale contexts and rehashed costs, profile, ordinal, month or protocol corruption', () => {
    const state = createCampaignStateV2(); const basis = context(); const plan = prepare(state, basis);
    const changed = { ...basis, revision: basis.revision + 1 };
    expect(acknowledgeCampaignClaimV2(state, plan, changed, acknowledgement(plan))).toMatchObject({ ok: false, code: 'STALE_PLAN' });
    const first = commit(state, plan, basis); const laterBasis = context(62); laterBasis.archivedDiscipleIds.push('entity:50');
    const second = commit(first, prepare(first, laterBasis, 'entity:51'), laterBasis);
    const changes: ((value: CampaignDataV2) => void)[] = [
      value => { value.claims[0]!.plan.costs[0]!.quantity = 0; },
      value => { value.claims[1]!.plan.relief!.month = 61; },
      value => { value.claims[1]!.plan.relief!.ordinal = 1; },
      value => { const recruit = value.claims[0]!.plan.grants[0]!; if (recruit.kind === 'recruit') recruit.profile.aptitude = 99; },
    ];
    for (const mutate of changes) {
      const candidate = cloneJson(second) as CampaignDataV2; mutate(candidate);
      for (const receipt of candidate.claims) { const { planHash: _hash, ...body } = receipt.plan; receipt.plan.planHash = stableHash(body); receipt.acknowledgement.planHash = receipt.plan.planHash; }
      expect(validateCampaignStateV2(candidate).length).toBeGreaterThan(0);
      expect(() => restoreCampaignV2(canonicalStringify({ format: 'shanmen-campaign', version: 2, state: candidate, checksum: stableHash(candidate) }))).toThrow();
    }
    expect(validateCampaignStateV2({ ...second, reliefProtocol: 'future-relief' }).length).toBeGreaterThan(0);
  });
});
