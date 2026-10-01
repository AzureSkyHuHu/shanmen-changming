import { describe, expect, it } from 'vitest';
import { applyExpeditionCommand, AUTHORED_TALENT_IDS, createExpedition, legalTalentCandidates, previewNextOffer, restoreExpedition, serializeExpedition } from '../../src/core/expeditions';
import type { ExpeditionCatalog, ExpeditionState } from '../../src/core/expeditions';
import { createRandomStreams } from '../../src/core/kernel/random';
import { atOffer, catalog, command, fallback, options, outcome, runToNode, transition, winEncounter } from './fixtures';

const subset = (...ids: string[]): ExpeditionCatalog => ({ ...catalog, talents: catalog.talents.filter(talent => ids.includes(talent.id)) });
const offerOf = (state: ExpeditionState) => state.offers.find(offer => offer.offerId === state.currentOfferId)!;
function choose(state: ExpeditionState, definitionId: string, content: ExpeditionCatalog = catalog, holderId?: string | null): ExpeditionState {
  const offer = offerOf(state);
  const holder = holderId === undefined ? offer.eligibleHolderIdsByCard[definitionId]?.[0] ?? null : holderId;
  return transition(state, { kind: 'offer.choose', offerId: offer.offerId, offerRevision: offer.revision, definitionId, holderId: holder }, content).state;
}

describe('legal three-choice offers', () => {
  it('uses only authored and engine-supported definitions, with an honest incomplete-catalog diagnostic', () => {
    const state = atOffer();
    const offer = offerOf(state);
    expect(AUTHORED_TALENT_IDS).toHaveLength(12);
    expect(catalog.targetTalentCount - AUTHORED_TALENT_IDS.length).toBe(36);
    expect(offer.candidateDefinitionIds).toHaveLength(3);
    expect(new Set(offer.candidateDefinitionIds).size).toBe(3);
    expect(offer.diagnostics).toContain('INCOMPLETE_CATALOG');
    expect(offer.diagnostics).toContain('NO_GENERAL_CARD');
    expect(legalTalentCandidates(state, catalog).some(card => card.definitionId === 'talent.zoumai-chengfu')).toBe(false); // nonzero staggerTicks
    expect(offer.candidateDefinitionIds.every(id => AUTHORED_TALENT_IDS.includes(id))).toBe(true);
  });

  it('does not fabricate a third card or repeat an invalid card when fewer than three are legal', () => {
    const content = subset('talent.xigui-jianmai', 'talent.cuofeng');
    const state = atOffer(content);
    expect(offerOf(state).candidateDefinitionIds).toHaveLength(2);
    expect(offerOf(state).diagnostics).toContain('INSUFFICIENT_LEGAL_CARDS');
    expect(offerOf(state).supplyFallback).toEqual([{ resourceId: 'meal', quantity: 2 }]);
    expect(offerOf(state).eligibleHolderIdsByCard['talent.xigui-jianmai']).toEqual(['entity:1']);
  });

  it('provides an explicit supply-only reward for a completely empty legal pool', () => {
    const content = subset();
    const state = atOffer(content);
    expect(offerOf(state).candidateDefinitionIds).toEqual([]);
    const accepted = fallback(state, content);
    expect(accepted.supplies).toEqual([{ resourceId: 'meal', quantity: 102 }]);
    expect(accepted.rewardCounters).toEqual({ generated: 1, committed: 1, forfeited: 0 });
    expect(accepted.offers[0]?.resolution).toBe('supplies');
    expect(accepted.talentInstances).toEqual([]);
    expect(applyExpeditionCommand(accepted, command(accepted, { kind: 'offer.supplies', offerId: state.currentOfferId!, offerRevision: 0 }), content)).toMatchObject({ ok: false });
  });

  it('requires real trigger-producing skills rather than a consume-only tag', () => {
    const input = options(); input.members = [input.members[3]!]; // fenzhang consumes poison, but does not apply it
    const content = subset('talent.yaoyan-yanmian');
    expect(legalTalentCandidates(createExpedition(input, content), content)).toEqual([]);
    const alchemy = options(); alchemy.members = [alchemy.members[2]!];
    expect(legalTalentCandidates(createExpedition(alchemy, content), content)).toEqual([]); // applies but cannot consume poison
    const mixed = options(); mixed.members = [mixed.members[2]!, mixed.members[3]!];
    expect(legalTalentCandidates(createExpedition(mixed, content), content)).toMatchObject([{ definitionId: 'talent.yaoyan-yanmian', holderIds: ['entity:4'] }]);
  });

  it('filters missing prerequisites, then admits their supported unlock and excludes incompatible cards symmetrically', () => {
    const core = catalog.talents.find(talent => talent.id === 'talent.xigui-jianmai')!;
    const support = catalog.talents.find(talent => talent.id === 'talent.cuofeng')!;
    const content: ExpeditionCatalog = { ...catalog, talents: [core, { ...support, prerequisites: [core.id] }] };
    const state = atOffer(content);
    expect(offerOf(state).candidateDefinitionIds).toEqual([core.id]);
    const selected = choose(state, core.id, content);
    expect(legalTalentCandidates(selected, content).map(card => card.definitionId)).toEqual([support.id]);
    const incompatible: ExpeditionCatalog = { ...catalog, talents: [{ ...core, excludes: [support.id] }, support] };
    const blocked = choose(atOffer(incompatible), core.id, incompatible);
    expect(legalTalentCandidates(blocked, incompatible)).toEqual([]);
  });

  it('caps personal ranks per living holder and team ranks once for the entire run', () => {
    const content = subset('talent.xigui-jianmai');
    const state = choose(atOffer(content), 'talent.xigui-jianmai', content);
    expect(state.talentInstances).toHaveLength(1);
    expect(legalTalentCandidates(state, content)).toEqual([]);
    const team = subset('talent.shouzhong-shengfeng');
    const teamState = choose(atOffer(team), 'talent.shouzhong-shengfeng', team, null);
    expect(teamState.talentInstances).toHaveLength(1);
    expect(teamState.talentInstances[0]).toMatchObject({ holderScope: 'team', holderId: null, rank: 1 });
    expect(legalTalentCandidates(teamState, team)).toEqual([]);
    const entered = transition(runToNode(teamState, team), { kind: 'encounter.begin' }, team).state;
    expect(entered.currentEncounter?.talentSources).toHaveLength(1); // no per-member duplication
  });

  it('supports an authored rank increase without installing another same-name team aura', () => {
    const talent = catalog.talents.find(entry => entry.id === 'talent.shouzhong-shengfeng')!;
    const content = { ...catalog, talents: [{ ...talent, maximumRank: 2 }] };
    let state = choose(atOffer(content), talent.id, content);
    state = choose(winEncounter(state, content), talent.id, content);
    expect(state.talentInstances).toHaveLength(1);
    expect(state.talentInstances[0]?.rank).toBe(2);
    expect(legalTalentCandidates(state, content)).toEqual([]);
  });

  it('binds selected-talisman team effects explicitly and requires a living compatible recipient', () => {
    const content = subset('talent.yifa-tongming');
    const state = atOffer(content);
    const offer = offerOf(state);
    expect(offer.eligibleHolderIdsByCard['talent.yifa-tongming']).toEqual(['entity:4']);
    for (const holderId of ['entity:1', null]) expect(applyExpeditionCommand(state, command(state, {
      kind: 'offer.choose', offerId: offer.offerId, offerRevision: offer.revision, definitionId: 'talent.yifa-tongming', holderId,
    }), content)).toMatchObject({ ok: false, code: 'ILLEGAL_CHOICE' });
    const selected = choose(state, 'talent.yifa-tongming', content);
    expect(selected.talentInstances[0]).toMatchObject({ holderScope: 'team', holderId: null, boundHolderId: 'entity:4' });
    const died = transition(selected, { kind: 'members.died', discipleIds: ['entity:4'], deathRecordIds: ['death:4'] }, content).state;
    expect(died.talentInstances).toHaveLength(1);
    const battle = transition(runToNode(died, content), { kind: 'encounter.begin' }, content).state;
    expect(battle.currentEncounter?.talentSources).toEqual([]); // retained, inactive until a legal explicit rebind
  });
});

describe('offer identity, refresh and guarantees', () => {
  it('keeps previews pure and persists the exact options, eligible holders and RNG identity', () => {
    const base = createExpedition(options(), catalog);
    const random = JSON.stringify(base.randomStreams);
    const preview = previewNextOffer(base, catalog);
    expect(previewNextOffer(base, catalog)).toEqual(preview);
    expect(JSON.stringify(base.randomStreams)).toBe(random);
    expect(base.offers).toEqual([]);
    const shown = atOffer();
    const restored = restoreExpedition(serializeExpedition(shown), catalog);
    expect(offerOf(restored)).toEqual(offerOf(shown));
    expect(Object.isFrozen(offerOf(shown).candidateDefinitionIds)).toBe(true);
  });

  it('guarantees at least one previously unseen legal card on refresh and permits only two refreshes per run', () => {
    let state = atOffer();
    let history = new Set(offerOf(state).shownHistory);
    for (let round = 0; round < 2; round += 1) {
      const offer = offerOf(state);
      state = transition(state, { kind: 'offer.reroll', offerId: offer.offerId, offerRevision: offer.revision }).state;
      const refreshed = offerOf(state);
      expect(refreshed.offerId).toBe(offer.offerId);
      expect(refreshed.revision).toBe(offer.revision + 1);
      expect(refreshed.candidateDefinitionIds.some(id => !history.has(id))).toBe(true);
      expect(state.remainingRerolls).toBe(1 - round);
      history = new Set(refreshed.shownHistory);
    }
    const offer = offerOf(state);
    expect(applyExpeditionCommand(state, command(state, { kind: 'offer.reroll', offerId: offer.offerId, offerRevision: offer.revision }), catalog))
      .toMatchObject({ ok: false, code: 'REROLLS_EXHAUSTED', state });
    const nextReward = winEncounter(fallback(state));
    expect(offerOf(nextReward).remainingRerolls).toBe(0);
  });

  it('does not spend a refresh or RNG draw when the legal pool has no unseen option', () => {
    const content = subset('talent.xigui-jianmai', 'talent.cuofeng');
    const state = atOffer(content); const offer = offerOf(state);
    const result = applyExpeditionCommand(state, command(state, { kind: 'offer.reroll', offerId: offer.offerId, offerRevision: offer.revision }), content);
    expect(result).toMatchObject({ ok: false, code: 'NO_NEW_CANDIDATE', state });
    expect(result.state.remainingRerolls).toBe(2);
    expect(result.state.randomStreams).toEqual(state.randomStreams);
  });

  it('commits card, holder, source and reward counter once and rejects stale refresh revisions', () => {
    const state = atOffer(); const old = offerOf(state);
    const refreshed = transition(state, { kind: 'offer.reroll', offerId: old.offerId, offerRevision: old.revision }).state;
    const selectedId = old.candidateDefinitionIds[0]!;
    expect(applyExpeditionCommand(refreshed, command(refreshed, { kind: 'offer.choose', offerId: old.offerId, offerRevision: old.revision,
      definitionId: selectedId, holderId: old.eligibleHolderIdsByCard[selectedId]?.[0] ?? null }), catalog)).toMatchObject({ ok: false, code: 'STALE_OFFER' });
    const current = offerOf(refreshed); const id = current.candidateDefinitionIds[0]!;
    const cmd = command(refreshed, { kind: 'offer.choose', offerId: current.offerId, offerRevision: current.revision, definitionId: id, holderId: current.eligibleHolderIdsByCard[id]?.[0] ?? null });
    const accepted = applyExpeditionCommand(refreshed, cmd, catalog); if (!accepted.ok) throw new Error(accepted.code);
    const restored = restoreExpedition(serializeExpedition(accepted.state), catalog);
    const repeated = applyExpeditionCommand(restored, cmd, catalog);
    expect(repeated).toMatchObject({ ok: true, replayed: true, effects: [] });
    expect(repeated.state.talentInstances).toHaveLength(1);
    expect(repeated.state.rewardCounters.committed).toBe(1);
  });

  it('shows a core immediately when legal and a matching support within two subsequent rewards', () => {
    const input = options(); input.route.encounterCount = 5;
    let state = atOffer(catalog, input);
    const coreId = offerOf(state).candidateDefinitionIds.find(id => catalog.talents.find(talent => talent.id === id)?.offerRole === 'core')!;
    expect(coreId).toBeTruthy();
    const core = catalog.talents.find(talent => talent.id === coreId)!;
    state = choose(state, coreId);
    let supportShown = false;
    for (let reward = 0; reward < 2; reward += 1) {
      state = winEncounter(state);
      const offer = offerOf(state);
      supportShown ||= offer.candidateDefinitionIds.some(id => catalog.talents.some(talent => talent.id === id && talent.buildId === core.buildId && talent.offerRole === 'support'));
      if (reward === 0) state = fallback(state);
    }
    const hasLegalSupport = legalTalentCandidates(state, catalog).some(card => card.buildId === core.buildId && card.role === 'support');
    if (hasLegalSupport) expect(supportShown).toBe(true);
    else expect(offerOf(state).diagnostics).toContain('SUPPORT_GUARANTEE_UNAVAILABLE');
  });

  it('rebuilds stale legal holders after an authoritative death without granting a second reward', () => {
    const content = subset('talent.xigui-jianmai');
    const state = atOffer(content); const old = offerOf(state);
    const changed = transition(state, { kind: 'members.died', discipleIds: ['entity:1'], deathRecordIds: ['death:1'] }, content).state;
    expect(offerOf(changed).offerId).toBe(old.offerId);
    expect(offerOf(changed).revision).toBe(old.revision + 1);
    expect(offerOf(changed).candidateDefinitionIds).toEqual([]);
    expect(changed.rewardCounters.generated).toBe(1);
    expect(changed.remainingRerolls).toBe(2);
    expect(applyExpeditionCommand(changed, command(changed, { kind: 'offer.choose', offerId: old.offerId, offerRevision: old.revision,
      definitionId: 'talent.xigui-jianmai', holderId: 'entity:1' }), content)).toMatchObject({ ok: false, code: 'STALE_OFFER' });
    expect(fallback(changed, content).rewardCounters.committed).toBe(1);
  });

  it('removes a dead personal holder talent between battles while keeping living/team sources', () => {
    const content = subset('talent.xigui-jianmai');
    let state = choose(atOffer(content), 'talent.xigui-jianmai', content);
    state = transition(runToNode(state, content), { kind: 'encounter.begin' }, content).state;
    expect(state.currentEncounter?.talentSources).toHaveLength(1);
    const result = outcome(state);
    result.members = result.members.map(member => member.discipleId === 'entity:1' ? { ...member, alive: false, health: 0, permanentDeathId: 'death:1' } : member);
    const resolved = transition(state, { kind: 'encounter.resolve', result }, content);
    expect(resolved.state.talentInstances).toEqual([]);
    expect(resolved.effects[0]).toMatchObject({ kind: 'encounterResult', revokedTalentInstanceIds: [state.talentInstances[0]!.instanceId] });
    expect(resolved.state.members[0]!.loadout.passiveSkillId).toBe('skill.jianxin'); // character identity is not erased
  });

  it('removes a personal proc from the offer when its living holder loses a required allied source', () => {
    const content = subset('talent.yaoyan-yanmian');
    const state = atOffer(content);
    expect(offerOf(state).eligibleHolderIdsByCard['talent.yaoyan-yanmian']).toEqual(['entity:4']);
    const changed = transition(state, { kind: 'members.died', discipleIds: ['entity:3'], deathRecordIds: ['death:3'] }, content).state;
    expect(changed.members.find(member => member.discipleId === 'entity:4')?.alive).toBe(true);
    expect(offerOf(changed).candidateDefinitionIds).toEqual([]);
  });

  it('checks 10,000 independent offer seeds for unique legal cards, living holders, core guarantees and pure previews', () => {
    const base = createExpedition(options(), catalog);
    const legal = legalTalentCandidates(base, catalog);
    const ids = new Set(legal.map(card => card.definitionId));
    for (let seed = 0; seed < 10_000; seed += 1) {
      // Isolate the offers stream: no route generation or battle outcome is being claimed by this sweep.
      const state: ExpeditionState = { ...base, randomStreams: createRandomStreams(`offer-seed:${seed}`) };
      const before = state.randomStreams.offers;
      const offer = previewNextOffer(state, catalog);
      expect(new Set(offer.candidateDefinitionIds).size).toBe(3);
      expect(offer.candidateDefinitionIds.every(id => ids.has(id))).toBe(true);
      expect(offer.candidateDefinitionIds.some(id => catalog.talents.some(talent => talent.id === id && talent.offerRole === 'core'))).toBe(true);
      for (const id of offer.candidateDefinitionIds) expect(offer.eligibleHolderIdsByCard[id]).toEqual(legal.find(card => card.definitionId === id)!.holderIds);
      expect(state.randomStreams.offers).toBe(before);
    }
  }, 120_000);
});
