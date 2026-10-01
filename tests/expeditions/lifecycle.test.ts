import { describe, expect, it } from 'vitest';
import { applyExpeditionCommand, createExpedition, expeditionDeparturePreview, getNextTimeCheckpoint, restoreExpedition, serializeExpedition } from '../../src/core/expeditions';
import { stableHash } from '../../src/core/kernel/serialization';
import { atOffer, catalog, command, fallback, finishReturn, options, outcome, runToNode, transition, winEncounter } from './fixtures';

describe('expedition preparation and route boundary', () => {
  it('locks a complete deterministic squad and bounded generated route without mutating inputs', () => {
    const input = options();
    const first = createExpedition(input, catalog);
    const second = createExpedition({ ...input, members: [...input.members].reverse(), route: { ...input.route, regularEncounterIds: [...input.route.regularEncounterIds].reverse() } }, catalog);
    expect(first).toEqual(second);
    expect(first.route).toHaveLength(3);
    expect(first.route.at(-1)?.reward).toBe(false);
    input.members[0]!.loadout.activeSkillIds[0] = 'skill.forged';
    expect(first.members[0]!.loadout.activeSkillIds[0]).toBe('skill.liuhen-jian');
    const departed = transition(first, { kind: 'depart' });
    expect(first.locked).toBe(false);
    expect(departed.state.locked).toBe(true);
    expect(departed.effects[0]).toMatchObject({ kind: 'departure', absentDiscipleIds: ['entity:1', 'entity:2', 'entity:3', 'entity:4'] });
    expect(Object.isFrozen(first.members[0]!.loadout)).toBe(true);
  });

  it('rejects unavailable, dead, incomplete, duplicate, cross-school, unsupported and oversized departure data', () => {
    for (const edit of [
      (input: ReturnType<typeof options>) => { input.members[0]!.available = false; },
      (input: ReturnType<typeof options>) => { input.members[0]!.alive = false; },
      (input: ReturnType<typeof options>) => { input.members[0]!.loadout.activeSkillIds[0] = 'skill.missing'; },
      (input: ReturnType<typeof options>) => { input.members[0]!.loadout.activeSkillIds[0] = 'skill.huichun'; },
      (input: ReturnType<typeof options>) => { input.members[0]!.loadout.activeSkillIds[0] = 'skill.cangfeng'; },
      (input: ReturnType<typeof options>) => { input.members.push(input.members[0]!); },
      (input: ReturnType<typeof options>) => { input.members[0]!.health = 101; },
      (input: ReturnType<typeof options>) => { input.route.encounterCount = 10; },
      (input: ReturnType<typeof options>) => { input.route.returnMonths = 13; },
    ]) { const input = options(); edit(input); expect(() => createExpedition(input, catalog)).toThrow(); }
    expect(() => createExpedition(options({ contentMode: 'verified' }), catalog)).toThrow('UNSUPPORTED_LOADOUT');
  });

  it('rejects a passive skill duplicated into an active slot even when it matches the passive slot ID', () => {
    const input = options(); input.members[0]!.loadout.activeSkillIds[0] = input.members[0]!.loadout.passiveSkillId;
    expect(() => createExpedition(input, catalog)).toThrow('INVALID_INPUT');
  });

  it('leaves unrelated RNG streams unchanged when generating a route or an offer', () => {
    const prepared = createExpedition(options(), catalog);
    const offered = winEncounter(prepared);
    for (const stream of ['combat', 'events', 'economy'] as const) expect(offered.randomStreams[stream]).toEqual(prepared.randomStreams[stream]);
    expect(offered.randomStreams.generation).toEqual(prepared.randomStreams.generation);
  });
});

describe('monthly checkpoint accounting', () => {
  it('accounts for three battles and travel/return months exactly once, never battle seconds', () => {
    const input = options(); input.route.minimumTravelMonths = 2; input.route.maximumTravelMonths = 2;
    let state = createExpedition(input, catalog);
    expect(expeditionDeparturePreview(state).expectedTotalMonths).toBe(8);
    for (let battle = 0; battle < 3; battle += 1) { state = winEncounter(state); if (state.phase === 'RewardPending') state = fallback(state); }
    expect(state.calendarMonth).toBe(246);
    expect(state.phase).toBe('Ending');
    expect(state.offers).toHaveLength(2);
    expect(getNextTimeCheckpoint(state)?.kind).toBe('return');
    state = finishReturn(state);
    expect(state.calendarMonth).toBe(248);
    expect(state.travelLedger).toHaveLength(8);
    expect(new Set(state.travelLedger.map(entry => entry.checkpointId)).size).toBe(8);
    expect(state.supplies).toEqual([{ resourceId: 'meal', quantity: 72 }]); // 100 - 32 travel + 4 fallback
    expect(state.settlement?.unusedSupplies).toEqual(state.supplies);
    expect(state.settlement?.loot).toEqual([{ resourceId: 'stone', quantity: 6 }, { resourceId: 'wood', quantity: 15 }]);
  });

  it('can pause and restore at an uncommitted or partially committed checkpoint', () => {
    const input = options(); input.route.minimumTravelMonths = 2; input.route.maximumTravelMonths = 2;
    let departed = transition(createExpedition(input, catalog), { kind: 'depart' }).state;
    const cp = getNextTimeCheckpoint(departed)!;
    departed = transition(departed, { kind: 'time.admit', checkpointId: cp.checkpointId, expectedCalendarMonth: cp.expectedCalendarMonth }).state;
    const cmd = command(departed, { kind: 'time.commit', checkpointId: cp.checkpointId, expectedCalendarMonth: cp.expectedCalendarMonth, resultingCalendarMonth: cp.resultingCalendarMonth });
    const first = applyExpeditionCommand(departed, cmd, catalog);
    if (!first.ok) throw new Error(first.code);
    const restored = restoreExpedition(serializeExpedition(first.state), catalog);
    expect(restored.nodeTimeProgress).toBe(1);
    expect(getNextTimeCheckpoint(restored)?.monthOrdinal).toBe(2);
    expect(applyExpeditionCommand(restored, cmd, catalog)).toMatchObject({ ok: true, replayed: true, effects: [] });
    expect(runToNode(restored)).toEqual(runToNode(first.state));
    expect(getNextTimeCheckpoint(departed)).toEqual(cp);
  });

  it('rejects wrong checkpoint IDs, skipped months, and insufficient carried supply without partial mutation', () => {
    const input = options({ supplies: [{ resourceId: 'meal', quantity: 1 }] }); input.route.minimumTravelMonths = 1; input.route.maximumTravelMonths = 1;
    const departed = transition(createExpedition(input, catalog), { kind: 'depart' }).state;
    const cp = getNextTimeCheckpoint(departed)!;
    for (const body of [
      { kind: 'time.commit' as const, checkpointId: 'wrong:1', expectedCalendarMonth: 240, resultingCalendarMonth: 241 },
      { kind: 'time.commit' as const, checkpointId: cp.checkpointId, expectedCalendarMonth: 240, resultingCalendarMonth: 242 },
    ]) expect(applyExpeditionCommand(departed, command(departed, body), catalog)).toMatchObject({ ok: false, code: 'CHECKPOINT_MISMATCH', state: departed });
    expect(applyExpeditionCommand(departed, command(departed, { kind: 'time.admit', checkpointId: cp.checkpointId, expectedCalendarMonth: 240 }), catalog))
      .toMatchObject({ ok: false, code: 'INSUFFICIENT_SUPPLIES', state: departed });
    expect(departed.calendarMonth).toBe(240);
    expect(departed.travelLedger).toEqual([]);
  });
});

describe('validated encounter and terminal boundaries', () => {
  it('exposes a battle adapter boundary without running AI or progressing strategic time', () => {
    const state = runToNode(createExpedition(options(), catalog));
    const battle = transition(state, { kind: 'encounter.begin' });
    expect(battle.effects[0]).toMatchObject({ kind: 'encounterBegin', boundary: { calendarMonth: 240, memberIds: ['entity:1', 'entity:2', 'entity:3', 'entity:4'] } });
    expect(battle.state.phase).toBe('InEncounter');
    expect(getNextTimeCheckpoint(battle.state)).toBeNull();
    expect(restoreExpedition(serializeExpedition(battle.state), catalog)).toEqual(battle.state);
  });

  it('rejects wrong battles, missing members, unconfirmed escape, victory without survivors, inflated health and excess consumption', () => {
    const state = transition(runToNode(createExpedition(options(), catalog)), { kind: 'encounter.begin' }).state;
    const cases = [
      outcome(state, { encounterId: 'encounter:wrong' }),
      outcome(state, { members: [] }),
      outcome(state, { outcome: 'emergencyRetreat', retreatConfirmed: false }),
      outcome(state, { members: outcome(state).members.map(member => ({ ...member, alive: false, health: 0, permanentDeathId: `death:${member.discipleId}` })) }),
      outcome(state, { members: outcome(state).members.map(member => ({ ...member, health: 101 })) }),
      outcome(state, { consumedSupplies: [{ resourceId: 'meal', quantity: 101 }] }),
    ];
    for (const result of cases) {
      const transitionResult = applyExpeditionCommand(state, command(state, { kind: 'encounter.resolve', result }), catalog);
      expect(transitionResult.ok).toBe(false); expect(transitionResult.state).toBe(state);
    }
    expect(state.securedLoot).toEqual([]);
  });

  it('settles victory, safe retreat, confirmed emergency retreat and all-dead defeat through one idempotent transaction', () => {
    for (const reason of ['victory', 'safeRetreat', 'emergencyRetreat', 'defeat'] as const) {
      let state;
      if (reason === 'safeRetreat') {
        state = atOffer();
        state = transition(state, { kind: 'run.end', reason }).state;
        expect(state.rewardCounters.forfeited).toBe(1);
      } else {
        state = transition(runToNode(createExpedition(options(), catalog)), { kind: 'encounter.begin' }).state;
        const result = outcome(state, { outcome: reason, retreatConfirmed: reason === 'emergencyRetreat' });
        if (reason === 'defeat') result.members = result.members.map(member => ({ ...member, alive: false, health: 0, permanentDeathId: `death:${member.discipleId}` }));
        state = transition(state, { kind: 'encounter.resolve', result }).state;
        if (reason === 'victory') { state = winEncounter(fallback(state)); state = winEncounter(fallback(state)); }
      }
      expect(state.phase).toBe('Ending');
      const settled = finishReturn(state);
      expect(settled.phase).toBe('Ended'); expect(settled.locked).toBe(false);
      expect(settled.talentInstances).toEqual([]);
      expect(settled.settlement?.reason).toBe(reason);
      const wood = settled.settlement?.loot.find(line => line.resourceId === 'wood')?.quantity ?? 0;
      expect(wood).toBe(reason === 'defeat' ? 0 : reason === 'emergencyRetreat' ? 2 : reason === 'victory' ? 15 : 5);
      const repeated = transition(settled, { kind: 'run.settle', settlementId: settled.settlement!.settlementId });
      expect(repeated.effects).toEqual([]);
      expect(repeated.state.settlement).toEqual(settled.settlement);
      const repeatedEnd = transition(repeated.state, { kind: 'run.end', reason });
      expect(repeatedEnd.effects).toEqual([]);
      expect(repeatedEnd.state.settlement).toEqual(settled.settlement);
      expect(repeatedEnd.state.receipts.flatMap(receipt => receipt.effectIds).filter(id => id === settled.settlement!.settlementId)).toHaveLength(1);
    }
  });

  it('allows a validated battle defeat with injured survivors without manufacturing permanent deaths', () => {
    const state = transition(runToNode(createExpedition(options(), catalog)), { kind: 'encounter.begin' }).state;
    const result = outcome(state, { outcome: 'defeat' });
    result.members = result.members.map(member => ({ ...member, health: 1, injury: 50 }));
    const ending = transition(state, { kind: 'encounter.resolve', result }).state;
    expect(ending.settlement).toMatchObject({ reason: 'defeat', returnMonths: 2, retainedUnsecuredBps: 0 });
    expect(ending.members.every(member => member.alive && member.permanentDeathId === null)).toBe(true);
    expect(finishReturn(ending).members.every(member => member.alive)).toBe(true);
  });

  it('keeps Ending resumable and forbids early settlement or unverified emergency exit', () => {
    const state = atOffer();
    expect(applyExpeditionCommand(state, command(state, { kind: 'run.end', reason: 'emergencyRetreat' }), catalog)).toMatchObject({ ok: false, code: 'INVALID_END_REASON' });
    let ending = transition(state, { kind: 'run.end', reason: 'safeRetreat' }).state;
    expect(applyExpeditionCommand(ending, command(ending, { kind: 'run.settle', settlementId: ending.settlement!.settlementId }), catalog)).toMatchObject({ ok: false, code: 'RETURN_INCOMPLETE' });
    const cp = getNextTimeCheckpoint(ending)!;
    ending = transition(ending, { kind: 'time.admit', checkpointId: cp.checkpointId, expectedCalendarMonth: cp.expectedCalendarMonth }).state;
    const halfReturn = transition(ending, { kind: 'time.commit', checkpointId: cp.checkpointId, expectedCalendarMonth: cp.expectedCalendarMonth, resultingCalendarMonth: cp.resultingCalendarMonth }).state;
    expect(finishReturn(restoreExpedition(serializeExpedition(halfReturn), catalog))).toEqual(finishReturn(halfReturn));
  });

  it('precharges a frozen checkpoint roster once across death, duplicate admission, save and final commit', () => {
    const input = options(); input.route.minimumTravelMonths = 1; input.route.maximumTravelMonths = 1;
    let state = transition(createExpedition(input, catalog), { kind: 'depart' }).state;
    const checkpoint = getNextTimeCheckpoint(state)!;
    const admission = command(state, { kind: 'time.admit', checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth });
    const admitted = applyExpeditionCommand(state, admission, catalog); if (!admitted.ok) throw new Error(admitted.code);
    state = restoreExpedition(serializeExpedition(admitted.state), catalog);
    expect(state.supplies).toEqual([{ resourceId: 'meal', quantity: 96 }]);
    expect(applyExpeditionCommand(state, admission, catalog)).toMatchObject({ ok: true, replayed: true, effects: [] });
    state = transition(state, { kind: 'time.admit', checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth }).state;
    state = transition(state, { kind: 'members.died', discipleIds: ['entity:1'], deathRecordIds: ['death:1'] }).state;
    expect(state.admittedCheckpoint?.absentDiscipleIds).toHaveLength(4);
    expect(state.admittedCheckpoint?.supplyCost).toEqual([{ resourceId: 'meal', quantity: 4 }]);
    state = transition(state, { kind: 'time.commit', checkpointId: checkpoint.checkpointId, expectedCalendarMonth: 240, resultingCalendarMonth: 241 }).state;
    expect(state.supplies).toEqual([{ resourceId: 'meal', quantity: 96 }]);
    expect(state.admittedCheckpoint).toBeNull();
  });

  it('records an abandoned prepaid checkpoint when all members die before the month is committed', () => {
    const input = options(); input.route.minimumTravelMonths = 1; input.route.maximumTravelMonths = 1;
    let state = transition(createExpedition(input, catalog), { kind: 'depart' }).state;
    const checkpoint = getNextTimeCheckpoint(state)!;
    state = transition(state, { kind: 'time.admit', checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth }).state;
    state = transition(state, { kind: 'members.died', discipleIds: state.members.map(member => member.discipleId), deathRecordIds: state.members.map(member => `death:${member.discipleId}`) }).state;
    expect(state.phase).toBe('Ending'); expect(state.calendarMonth).toBe(240);
    expect(state.travelLedger).toEqual([]); expect(state.admittedCheckpoint).toBeNull();
    expect(state.abandonedCheckpoints).toMatchObject([{ reason: 'allMembersDead', checkpoint: { supplyCost: [{ resourceId: 'meal', quantity: 4 }] } }]);
    expect(state.supplies).toEqual([{ resourceId: 'meal', quantity: 96 }]);
    expect(finishReturn(restoreExpedition(serializeExpedition(state), catalog)).settlement?.unusedSupplies).toEqual(state.supplies);
  });

  it('rejects changed command identity and stale revision and never reapplies accepted adapter effects', () => {
    const prepared = createExpedition(options(), catalog);
    const cmd = command(prepared, { kind: 'depart' });
    const accepted = applyExpeditionCommand(prepared, cmd, catalog); if (!accepted.ok) throw new Error(accepted.code);
    expect(applyExpeditionCommand(accepted.state, cmd, catalog)).toMatchObject({ ok: true, replayed: true, effects: [] });
    expect(applyExpeditionCommand(accepted.state, { ...cmd, kind: 'encounter.begin' }, catalog)).toMatchObject({ ok: false, code: 'COMMAND_CONFLICT' });
    expect(applyExpeditionCommand(accepted.state, { ...command(accepted.state, { kind: 'encounter.begin' }), expectedRevision: 0 }, catalog)).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
  });

  it('rejects content changes and forged saved offers even when a checksum is recomputed', () => {
    const state = atOffer();
    const saved = serializeExpedition(state);
    expect(restoreExpedition(saved, catalog)).toEqual(state);
    const forged = JSON.parse(saved); forged.state.offers[0].candidateDefinitionIds = ['talent.forged']; forged.checksum = stableHash(forged.state);
    expect(() => restoreExpedition(JSON.stringify(forged), catalog)).toThrow('diverges');
    expect(() => restoreExpedition(saved, { ...catalog, contentVersion: 'changed' })).toThrow();
    expect(applyExpeditionCommand(state, command(state, { kind: 'run.end', reason: 'safeRetreat' }), { ...catalog, contentVersion: 'changed' }))
      .toMatchObject({ ok: false, code: 'CONTENT_MISMATCH' });
  });
});
