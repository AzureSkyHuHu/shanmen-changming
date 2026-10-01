import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentIdentity, LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import { applyExpeditionCommand as applyOriginal } from '../../src/core/expeditions/expedition';
import { createRegisteredExpedition, pinLegacyExpedition, applyRegisteredExpeditionCommand,
  registeredEligibility, registeredTimeCheckpoint, restoreRegisteredExpedition, resolveReleaseExpeditionContext } from '../../src/core/expeditions/versioned';
import type { RegisteredExpedition } from '../../src/core/expeditions/versioned';
import type { ExpeditionCommand, ExpeditionState, ValidatedEncounterOutcome } from '../../src/core/expeditions/types';
import { releaseAnalysisView, releaseContextForRun } from '../../src/core/expeditions/v3/context';
import { cloneJson, canonicalStringify } from '../../src/core/kernel/serialization';
import { copy } from '../../src/core/expeditions/shared';

function fixture(name = 'save-v7-awaiting-choice.json') {
  const text = readFileSync(new URL(`../integration/fixtures/${name}`, import.meta.url), 'utf8');
  const payload = (JSON.parse(text) as { payload: { expedition: { run: ExpeditionState } } }).payload;
  return { text, run: payload.expedition.run };
}
type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
function command(state: RegisteredExpedition, body: Body<ExpeditionCommand>, id = `v3:${state.run.revision + 1}`): ExpeditionCommand {
  return { ...body, commandId: id, expectedRevision: state.run.revision } as ExpeditionCommand;
}
function act(state: RegisteredExpedition, body: Body<ExpeditionCommand>): RegisteredExpedition {
  const result = applyRegisteredExpeditionCommand(state, command(state, body));
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code); return result.expedition;
}
function fresh(seed = 'registered-v3'): RegisteredExpedition {
  const input = copy(fixture('save-v7-ended-clear.json').run.origin);
  return createRegisteredExpedition({ ...input, runId: 'run:v3', seed }, 'route.qingfeng-trial', contentIdentity(RELEASE_V8_CANDIDATE));
}
function firstOffer(seed?: string): RegisteredExpedition {
  let state = fresh(seed); state = act(state, { kind: 'depart' });
  while (state.run.phase === 'Travelling') {
    const checkpoint = registeredTimeCheckpoint(state)!;
    if (!state.run.admittedCheckpoint) state = act(state, { kind: 'time.admit', checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth });
    state = act(state, { kind: 'time.commit', checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth, resultingCalendarMonth: checkpoint.resultingCalendarMonth });
  }
  state = act(state, { kind: 'encounter.begin' });
  // Domain-adapter outcome fixture. Real controller-to-World binding is tested in
  // the later World integration, not claimed by this protocol/replay test.
  const encounter = state.run.currentEncounter!;
  const outcome: ValidatedEncounterOutcome = { encounterId: encounter.encounterId, resultId: 'result:v3:first',
    validation: { kind: 'validatedCombatOutcome', battleId: 'battle:v3:first', battleSnapshotHash: '01234567' },
    outcome: 'victory', retreatConfirmed: false,
    members: encounter.squad.map(member => ({ discipleId: member.discipleId, alive: true, permanentDeathId: null,
      health: member.health, spirit: member.spirit, injury: member.injury, durability: member.durability })),
    consumedSupplies: [], securedLoot: [], unsecuredLoot: [], unlockIds: [] };
  return act(state, { kind: 'encounter.resolve', result: outcome });
}

describe('per-run registered expedition protocols', () => {
  it.each(['save-v7-active-battle.json', 'save-v7-awaiting-choice.json', 'save-v7-ended-clear.json'])(
    'pins genuine %s without changing offers, locks, IDs, receipts or RNG', filename => {
      const source = fixture(filename); const before = cloneJson(source.run); const pinned = pinLegacyExpedition(source.run);
      expect(pinned.protocol).toBe('legacy-v2'); expect(pinned.identity).toEqual(contentIdentity(LEGACY_V7_CONTENT));
      expect(pinned.run).toEqual(before); expect(source.run).toEqual(before); expect(restoreRegisteredExpedition(cloneJson(pinned))).toEqual(pinned);
      expect(readFileSync(new URL(`../integration/fixtures/${filename}`, import.meta.url), 'utf8')).toBe(source.text);
      expect(registeredEligibility(pinned)).toBeNull();
    });

  it('continues an old pending offer with the exact original algorithm and keeps receipt replay unchanged', () => {
    const source = fixture(); const pinned = pinLegacyExpedition(source.run); const offer = source.run.offers.find(item => item.offerId === source.run.currentOfferId)!;
    const request = command(pinned, { kind: 'offer.reroll', offerId: offer.offerId, offerRevision: offer.revision }, 'legacy.same-reroll');
    const original = applyOriginal(source.run, request, LEGACY_V7_CONTENT.combat);
    const resumed = applyRegisteredExpeditionCommand(pinned, request);
    expect(resumed.ok).toBe(original.ok);
    if (resumed.ok && original.ok) {
      expect(resumed.expedition.run).toEqual(original.state); expect(resumed.receipt).toEqual(original.receipt);
      const replay = applyRegisteredExpeditionCommand(restoreRegisteredExpedition(cloneJson(resumed.expedition)), request);
      expect(replay).toMatchObject({ ok: true, replayed: true, effects: [], receipt: original.receipt });
    } else if (!resumed.ok && !original.ok) expect(resumed.code).toBe(original.code);
  });

  it('rejects swapping an old run to the candidate catalog or a future protocol, preserving caller objects', () => {
    const original = cloneJson(pinLegacyExpedition(fixture().run));
    for (const changed of [{ ...original, identity: contentIdentity(RELEASE_V8_CANDIDATE) }, { ...original, protocol: 'release-v3' },
      { ...original, routeId: 'route.everbright-finale' }, { ...original, identity: { ...original.identity, registryId: 'future.content' } }]) {
      const before = cloneJson(changed); const frozenBefore = Object.isFrozen(changed.identity);
      expect(() => restoreRegisteredExpedition(changed)).toThrow(); expect(changed).toEqual(before);
      expect(Object.isFrozen(changed.identity)).toBe(frozenBefore);
    }
  });

  it('derives real geometry, damage/control opportunities and runtime team-source anchors without consuming run state', () => {
    const state = fresh(); if (state.protocol !== 'release-v3') throw new Error('Wrong protocol');
    const before = cloneJson(state); const context = resolveReleaseExpeditionContext(state.identity);
    const facts = releaseContextForRun(state.run, context);
    expect(facts.members.map(member => member.discipleId)).toEqual(state.run.members.map(member => member.discipleId));
    expect(facts.reachablePairs.every(pair => pair.distanceUnits > 0)).toBe(true);
    expect(facts.enemies.length).toBeGreaterThan(0);
    expect(facts.teamSourceHolders.map(entry => entry.definitionId)).toEqual(context.catalog.talents
      .filter(talent => talent.holderScope === 'team' && talent.recipientBinding !== 'selectedTalisman').map(talent => talent.id).sort());
    expect(facts.identity.inputHash).toBeTruthy(); expect(releaseAnalysisView(state.run).randomStreams).toEqual(state.run.randomStreams);
    expect(state).toEqual(before);
    const evaluation = registeredEligibility(state)!;
    expect(evaluation.candidates.some(candidate => candidate.definitionId === 'talent.zoumai-chengfu')).toBe(false);
    expect(evaluation.diagnostics.some(item => item.code === 'UNSUPPORTED_EXTRA_TARGET_STAGGER')).toBe(true);
    expect(evaluation.diagnostics.some(item => ['INVALID_CONTEXT', 'CONTEXT_IDENTITY_MISMATCH', 'MISSING_MEMBER_FACTS'].includes(item.code))).toBe(false);
  });

  it('does not fabricate a selected-talisman anchor from a basic-school label without an equipped talisman skill', () => {
    const state = fresh(); if (state.protocol !== 'release-v3') throw new Error('Wrong protocol');
    const run = copy(state.run); run.members[0]!.loadout.basic.school = 'talisman';
    const context = resolveReleaseExpeditionContext(state.identity);
    const facts = releaseContextForRun(run, context);
    const selectedCards = new Set(context.catalog.talents.filter(talent => talent.recipientBinding === 'selectedTalisman').map(talent => talent.id));
    expect(facts.teamSourceHolders.some(entry => selectedCards.has(entry.definitionId))).toBe(false);
    expect(run.members.flatMap(member => [...member.loadout.activeSkillIds, member.loadout.passiveSkillId])
      .some(id => context.catalog.skills.some(skill => skill.id === id && skill.school === 'talisman'))).toBe(false);
  });

  it('generates only eligible new-run offers and restores deterministic continuation with the pinned identity', () => {
    const state = firstOffer(); expect(state.protocol).toBe('release-v3'); expect(state.run.schemaVersion).toBe(3);
    expect(state.run.phase).toBe('RewardPending'); const offer = state.run.offers.find(entry => entry.offerId === state.run.currentOfferId)!;
    const eligible = registeredEligibility(state)!;
    // This ordinary first-two-member squad has no talisman skill at all, yet still
    // receives its real ordinary choices instead of losing the entire reward transaction.
    expect(offer.candidateDefinitionIds).toHaveLength(3);
    expect(offer.candidateDefinitionIds.every(id => eligible.candidates.some(candidate => candidate.definitionId === id))).toBe(true);
    expect(offer.candidateDefinitionIds).not.toContain('talent.zoumai-chengfu');
    const mutable = cloneJson(state); const restored = restoreRegisteredExpedition(mutable);
    expect(restored).toEqual(state); expect(Object.isFrozen(mutable.identity)).toBe(false); expect(Object.isFrozen(mutable.run)).toBe(false);
    const request = command(state, { kind: 'offer.supplies', offerId: offer.offerId, offerRevision: offer.revision });
    expect(applyRegisteredExpeditionCommand(restored, request)).toEqual(applyRegisteredExpeditionCommand(state, request));
    const unavailable = command(state, { kind: 'offer.choose', offerId: offer.offerId, offerRevision: offer.revision,
      definitionId: 'talent.zoumai-chengfu', holderId: state.run.members[0]!.discipleId });
    expect(applyRegisteredExpeditionCommand(state, unavailable)).toMatchObject({ ok: false, code: 'ILLEGAL_CHOICE', expedition: state });
  });

  it('re-evaluates after an actual domain casualty and rejects malformed/future identities and rewritten offer history', () => {
    const state = firstOffer('casualty-v3');
    const dead = state.run.members[0]!.discipleId;
    const next = act(state, { kind: 'members.died', discipleIds: [dead], deathRecordIds: ['death:v3:1'] });
    const candidates = registeredEligibility(next)!.candidates;
    expect(candidates.every(candidate => !candidate.holderIds.includes(dead))).toBe(true);
    expect(restoreRegisteredExpedition(cloneJson(next))).toEqual(next);
    const forged = cloneJson(next) as unknown as { run: { offers: { candidateDefinitionIds: string[] }[] } };
    forged.run.offers[0]!.candidateDefinitionIds.push('talent.zoumai-chengfu');
    expect(() => restoreRegisteredExpedition(forged)).toThrow();
    expect(() => createRegisteredExpedition(copy(fixture().run.origin), 'route.qingfeng-trial', { ...state.identity, compositeFingerprint: '00000000' })).toThrow();
    expect(canonicalStringify(state.run.randomStreams)).not.toBe(canonicalStringify(next.run.randomStreams));
  });
});
