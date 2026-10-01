import { describe, expect, it } from 'vitest';
import { createCampaignState, restoreCampaign, serializeCampaign, validateCampaignState } from '../../src/core/campaign';
import { stableHash } from '../../src/core/kernel/serialization';
import { claim, clear, cleared, lostContext } from './helpers';

function completeState() {
  let state = claim(cleared(), { kind: 'equipment', routeId: 'route.qingfeng-trial', discipleId: 'entity:1' });
  state = claim(state, { kind: 'lesson', knowledgeId: 'knowledge.clear-heart', discipleId: 'entity:3' });
  state = clear(state, 'route.thunder-seal');
  return claim(state, { kind: 'recovery', discipleIds: ['entity:5', 'entity:6'], acknowledgeLoss: true }, lostContext());
}
function editedSnapshot(edit: (state: ReturnType<typeof JSON.parse>) => void) {
  const envelope = JSON.parse(serializeCampaign(completeState())); edit(envelope.state);
  envelope.checksum = stableHash(envelope.state); return JSON.stringify(envelope);
}

describe('campaign snapshot validation', () => {
  it('round-trips claim identities, archives, ordering and recovery in detached immutable state', () => {
    const state = completeState(); const restored = restoreCampaign(serializeCampaign(state));
    expect(restored).toEqual(state); expect(restored).not.toBe(state); expect(Object.isFrozen(restored.claims[0]!.plan.grants)).toBe(true);
    expect(validateCampaignState(restored)).toEqual([]);
  });
  it.each([
    ['equipment replacement', (state: any) => { state.claims[0].plan.grants[0].definitionId = 'equipment.guardian-robe'; }],
    ['free study', (state: any) => { state.claims[1].plan.costs = []; }],
    ['invented skill', (state: any) => { state.claims[1].plan.grants[0].skillId = 'skill.wanjian-chaozong'; }],
    ['duplicate acquisition', (state: any) => { state.claims[2].plan.grants[1].acquisitionId = state.claims[2].plan.grants[0].acquisitionId; }],
    ['older recruit', (state: any) => { state.claims[2].plan.grants[0].profile.ageMonths = 959; }],
    ['immortal recruit', (state: any) => { state.claims[2].plan.grants[0].profile.lifespanMonths = 12000; }],
    ['extra talent', (state: any) => { state.claims[2].plan.grants[0].profile.talentIds = ['talent.fanzhen']; }],
    ['inflated supplies', (state: any) => { state.claims[2].plan.grants[2].resources[0].quantity = 100000; }],
    ['bad acknowledgement', (state: any) => { state.claims[0].acknowledgement.acquisitionIds = []; }],
    ['reused transaction', (state: any) => { state.claims[1].acknowledgement.transactionId = state.claims[0].acknowledgement.transactionId; }],
    ['missing clear', (state: any) => { state.clears.shift(); state.revision--; }],
    ['unearned finale', (state: any) => { state.clears[1].routeId = 'route.everbright-finale'; }],
    ['wrong settlement', (state: any) => { state.clears[0].settlementId = 'other/settlement'; }],
    ['duplicate event revision', (state: any) => { state.clears[1].revision = 1; }],
    ['hardcore recovery', (state: any) => { state.mode = 'hardcore'; }],
    ['skipped generation', (state: any) => { state.claims[2].plan.recovery.generation = 3; }],
    ['unknown state key', (state: any) => { state.gold = 10; }],
  ])('rejects %s even when the outer checksum is recomputed', (_label, edit) => {
    expect(() => restoreCampaign(editedSnapshot(edit))).toThrow();
  });
  it('rejects recomputed inner hashes when claimed grants do not match the reward catalog', () => {
    expect(() => restoreCampaign(editedSnapshot(state => {
      const plan = state.claims[0].plan; plan.grants[0].definitionId = 'equipment.storm-focus';
      const { planHash: _old, ...base } = plan; plan.planHash = stableHash(base); state.claims[0].acknowledgement.planHash = plan.planHash;
    }))).toThrow();
  });
  it('rejects future versions and unknown envelopes while preserving the caller text', () => {
    const original = serializeCampaign(createCampaignState()); const future = JSON.parse(original); future.version = 99;
    expect(() => restoreCampaign(JSON.stringify(future))).toThrow(); expect(serializeCampaign(createCampaignState())).toBe(original);
    future.version = 1; future.unknown = true; expect(() => restoreCampaign(JSON.stringify(future))).toThrow();
  });
  it('rejects cycles, sparse arrays and getters without executing external code', () => {
    const state: any = JSON.parse(serializeCampaign(createCampaignState())).state; state.claims = new Array(1);
    expect(validateCampaignState(state).length).toBeGreaterThan(0);
    state.claims = []; state.loop = state; expect(validateCampaignState(state).length).toBeGreaterThan(0);
    let invoked = 0; const unsafe = { get mode() { invoked++; return 'standard'; } };
    expect(validateCampaignState(unsafe).length).toBeGreaterThan(0); expect(invoked).toBe(0);
  });
});
