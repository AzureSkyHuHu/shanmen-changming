import { describe, expect, it } from 'vitest';
import { createInventory } from '../../src/core/economy/inventory';
import { createSequences } from '../../src/core/kernel/ids';
import { createRandomStreams, drawInteger, RANDOM_ALGORITHM } from '../../src/core/kernel/random';
import { cloneJson } from '../../src/core/kernel/serialization';
import {
  applyCultivationCommand, createCultivationState, createCultivator, MAX_MONTHS_PER_STEP,
  previewBreakthrough, REALM_RULES, stepCultivationMonths, validateCultivationFrame,
  type CultivationCommand, type CultivationFrame, type Cultivator,
} from '../../src/core/cultivation';

type Input = CultivationCommand extends infer C ? C extends CultivationCommand ? Omit<C, 'commandId' | 'expectedRevision'> : never : never;
function frame(disciples: Cultivator[] = [createCultivator('entity:1', { cultivation: 120 })]): CultivationFrame {
  const inventory = createInventory();
  inventory.herbs.owned = 100; inventory.stone.owned = 100; inventory.meal.owned = 100;
  return { cultivation: createCultivationState(disciples), inventory, randomStreams: createRandomStreams('cultivation-tests'), sequences: { ...createSequences(), nextEntity: 100 } };
}
function accepted(before: CultivationFrame, input: Input, commandId = `command:${before.cultivation.revision}`) {
  const command = { ...input, commandId, expectedRevision: before.cultivation.revision } as CultivationCommand;
  const transition = applyCultivationCommand(before, command);
  expect(transition.ok).toBe(true);
  if (!transition.ok) throw new Error(`Unexpected cultivation error: ${transition.code}`);
  expect(validateCultivationFrame(transition.frame)).toEqual([]);
  return { ...transition, command };
}
function reserve(before: CultivationFrame, method: 'standard' | 'forced' = 'standard') {
  const preview = previewBreakthrough(before, 'entity:1', { method, arraySupport: 0 });
  return accepted(before, { kind: 'breakthrough.confirm', preview });
}
function ready(before: CultivationFrame, method: 'standard' | 'forced' = 'standard') {
  const confirmed = reserve(before, method);
  const attemptId = confirmed.result.relatedId!;
  const begun = accepted(confirmed.frame, { kind: 'breakthrough.begin', attemptId });
  const stepped = stepCultivationMonths(begun.frame, MAX_MONTHS_PER_STEP);
  expect(stepped.stopped).toBe('decision-required');
  return { frame: stepped.frame, attemptId, preview: confirmed.frame.cultivation.attempts[0]!.preview };
}
function chooseOutcome(before: CultivationFrame, outcome: 'success' | 'injury' | 'death', forced = false) {
  const preview = previewBreakthrough(before, 'entity:1', { method: forced ? 'forced' : 'standard', arraySupport: 0 });
  for (let state = 1; state < 10000; state++) {
    const stream = { algorithm: RANDOM_ALGORITHM, state, draws: 0 };
    const success = drawInteger({ ...before.randomStreams, events: stream }, 'events', 1, 10000);
    const fatal = drawInteger(success.streams, 'events', 1, 10000);
    if ((outcome === 'success' && success.value <= preview.successBps)
      || (outcome === 'injury' && success.value > preview.successBps && (preview.failureDeathBps === 0 || fatal.value > preview.failureDeathBps))
      || (outcome === 'death' && success.value > preview.successBps && fatal.value <= preview.failureDeathBps)) {
      return { ...before, randomStreams: { ...before.randomStreams, events: stream } };
    }
  }
  throw new Error('No deterministic fixture stream found');
}

describe('transparent breakthrough transactions', () => {
  it('uses registered factors and distinguishes conditional failure death from total death chance', () => {
    const before = frame([createCultivator('entity:1', { realm: 'foundation', cultivation: 900, injury: 40, ageMonths: 2159 })]);
    const snapshot = cloneJson(before);
    const preview = previewBreakthrough(before, 'entity:1', { method: 'forced', arraySupport: 2 });
    expect(preview.successBps).toBe(Math.min(9500, Math.max(500, preview.factors.reduce((sum, factor) => sum + factor.contributionBps, 0))));
    expect(preview.failureDeathBps).toBe(3300);
    expect(preview.overallDeathBps).toBe(Math.floor((10000 - preview.successBps) * 3300 / 10000));
    expect(preview.warnings).toContain('LIFESPAN_BEFORE_COMPLETION');
    expect(preview.warnings).toContain('FAILURE_CAN_KILL');
    expect(preview.seclusionMonths).toBe(6);
    expect(before).toEqual(snapshot);
  });

  it('ordinary healthy early breakthroughs have no lethal failure branch', () => {
    const preview = previewBreakthrough(frame(), 'entity:1');
    expect(preview.failureDeathBps).toBe(0);
    expect(preview.overallDeathBps).toBe(0);
    expect(preview.warnings).not.toContain('FAILURE_CAN_KILL');
  });

  it('rejects forged or stale previews before any resource debit or RNG draw', () => {
    const before = frame();
    const preview = previewBreakthrough(before, 'entity:1');
    const forged = { ...preview, successBps: 10000 };
    expect(applyCultivationCommand(before, { commandId: 'forged', expectedRevision: 0, kind: 'breakthrough.confirm', preview: forged })).toMatchObject({ ok: false, code: 'PREVIEW_STALE', frame: before });
    const changed = cloneJson(before); changed.cultivation.disciples[0]!.injury = 20;
    expect(applyCultivationCommand(changed, { commandId: 'stale-injury', expectedRevision: 0, kind: 'breakthrough.confirm', preview })).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    const changedResources = cloneJson(before); changedResources.inventory.herbs.owned -= 1;
    expect(applyCultivationCommand(changedResources, { commandId: 'stale-resource', expectedRevision: 0, kind: 'breakthrough.confirm', preview })).toMatchObject({ ok: false, code: 'PREVIEW_STALE' });
    const older = stepCultivationMonths(before, 1).frame;
    expect(applyCultivationCommand(older, { commandId: 'stale-revision', expectedRevision: 0, kind: 'breakthrough.confirm', preview })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    expect(before.inventory.herbs.reserved).toBe(0);
  });

  it('blocks insufficient cultivation, heavy injury and missing materials without spending', () => {
    const before = frame([createCultivator('entity:1', { cultivation: 10, injury: 70 })]);
    before.inventory.herbs.owned = 0;
    const preview = previewBreakthrough(before, 'entity:1');
    expect(preview.blockers).toEqual(['CULTIVATION_REQUIRED', 'INJURY_TOO_HIGH', 'MATERIALS_REQUIRED']);
    const result = applyCultivationCommand(before, { commandId: 'blocked', expectedRevision: 0, kind: 'breakthrough.confirm', preview });
    expect(result).toMatchObject({ ok: false, code: 'PREPARATION_BLOCKED' });
    expect(result.frame).toBe(before);
  });

  it('reserves once and cancels once, releasing materials without refunding consumed meals', () => {
    const initial = frame([createCultivator('entity:1', { realm: 'qi', cultivation: 360 })]);
    const confirmed = reserve(initial);
    expect(confirmed.frame.inventory.herbs.owned).toBe(initial.inventory.herbs.owned);
    expect(confirmed.frame.inventory.herbs.reserved).toBe(6);
    const duplicate = applyCultivationCommand(confirmed.frame, confirmed.command);
    expect(duplicate).toMatchObject({ ok: true, replayed: true });
    expect(duplicate.frame).toBe(confirmed.frame);
    const started = accepted(confirmed.frame, { kind: 'breakthrough.begin', attemptId: confirmed.result.relatedId! });
    const month = stepCultivationMonths(started.frame, 1).frame;
    const cancelled = accepted(month, { kind: 'breakthrough.cancel', attemptId: confirmed.result.relatedId! });
    expect(cancelled.frame.inventory.herbs.reserved).toBe(0);
    expect(cancelled.frame.inventory.herbs.owned).toBe(initial.inventory.herbs.owned);
    expect(cancelled.frame.inventory.meal.owned).toBe(initial.inventory.meal.owned - 1);
    expect(cancelled.frame.randomStreams).toEqual(initial.randomStreams);
    expect(applyCultivationCommand(cancelled.frame, cancelled.command)).toMatchObject({ ok: true, replayed: true });
    expect(applyCultivationCommand(cancelled.frame, { commandId: 'late-resolve', expectedRevision: cancelled.frame.cultivation.revision, kind: 'breakthrough.resolve', attemptId: confirmed.result.relatedId!, acknowledgeRisk: true })).toMatchObject({ ok: false, code: 'ATTEMPT_FINISHED' });
  });

  it('requires explicit decision acknowledgement and commits successful cost/sample/progression together', () => {
    const initial = chooseOutcome(frame(), 'success');
    const waiting = ready(initial);
    const before = cloneJson(waiting.frame);
    const denied = applyCultivationCommand(waiting.frame, { commandId: 'no-ack', expectedRevision: waiting.frame.cultivation.revision, kind: 'breakthrough.resolve', attemptId: waiting.attemptId, acknowledgeRisk: false });
    expect(denied).toMatchObject({ ok: false, code: 'ACKNOWLEDGEMENT_REQUIRED' });
    expect(waiting.frame).toEqual(before);
    const resolved = accepted(waiting.frame, { kind: 'breakthrough.resolve', attemptId: waiting.attemptId, acknowledgeRisk: true });
    expect(resolved.result.outcome).toBe('success');
    const d = resolved.frame.cultivation.disciples[0]!;
    expect(d.realm).toBe('qi'); expect(d.ageMonths).toBe(217); expect(d.lifespanMonths).toBe(110 * 12);
    expect(resolved.frame.inventory.herbs.owned).toBe(initial.inventory.herbs.owned - 2);
    expect(resolved.frame.inventory.herbs.reserved).toBe(0);
    expect(resolved.frame.cultivation.attempts[0]!.sample?.randomAfter.draws).toBeGreaterThan(0);
    expect(applyCultivationCommand(resolved.frame, resolved.command)).toMatchObject({ ok: true, replayed: true, frame: resolved.frame });
    expect(applyCultivationCommand(resolved.frame, { ...resolved.command, acknowledgeRisk: false } as CultivationCommand)).toMatchObject({ ok: false, code: 'COMMAND_CONFLICT' });
  });

  it('injury failure is recoverable and cannot be rerolled by cancel or a new resolve command', () => {
    const initial = chooseOutcome(frame(), 'injury');
    const waiting = ready(initial);
    const resolved = accepted(waiting.frame, { kind: 'breakthrough.resolve', attemptId: waiting.attemptId, acknowledgeRisk: true });
    expect(resolved.result.outcome).toBe('injury');
    expect(resolved.frame.cultivation.disciples[0]).toMatchObject({ realm: 'mortal', injury: 20, cultivation: 96, lifeState: 'alive' });
    const rng = cloneJson(resolved.frame.randomStreams);
    for (const kind of ['breakthrough.cancel', 'breakthrough.resolve'] as const) {
      const command = { commandId: `retry-${kind}`, expectedRevision: resolved.frame.cultivation.revision, kind, attemptId: waiting.attemptId,
        ...(kind === 'breakthrough.resolve' ? { acknowledgeRisk: true } : {}) } as CultivationCommand;
      expect(applyCultivationCommand(resolved.frame, command)).toMatchObject({ ok: false, code: 'ATTEMPT_FINISHED' });
    }
    expect(resolved.frame.randomStreams).toEqual(rng);
    const resting = accepted(resolved.frame, { kind: 'training.set', discipleId: 'entity:1', mode: 'rest' });
    expect(stepCultivationMonths(resting.frame, 3).frame.cultivation.disciples[0]!.injury).toBe(0);
  });

  it('lethal failure occurs only inside its advertised branch and settles one permanent death', () => {
    let initial = frame([createCultivator('entity:1', { cultivation: 120, injury: 90, relicIds: ['relic:old-sword'] }), createCultivator('entity:2')]);
    initial = accepted(initial, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' }).frame;
    initial = chooseOutcome(initial, 'death', true);
    const waiting = ready(initial, 'forced');
    expect(waiting.preview.failureDeathBps).toBeGreaterThan(0);
    const resolved = accepted(waiting.frame, { kind: 'breakthrough.resolve', attemptId: waiting.attemptId, acknowledgeRisk: true });
    expect(resolved.result.outcome).toBe('death');
    expect(resolved.frame.cultivation.deaths).toHaveLength(1);
    expect(resolved.frame.cultivation.disciples[1]!.relicIds).toEqual(['relic:old-sword']);
    const duplicated = applyCultivationCommand(JSON.parse(JSON.stringify(resolved.frame)), resolved.command);
    expect(duplicated).toMatchObject({ ok: true, replayed: true });
    expect(duplicated.frame.cultivation.deaths).toHaveLength(1);
  });

  it('supply shortage blocks work without stealing another system’s reserved meals or consuming material escrow', () => {
    const initial = frame([createCultivator('entity:1', { realm: 'qi', cultivation: 360 })]);
    initial.inventory.meal.owned = 2; initial.inventory.meal.reserved = 2;
    expect(previewBreakthrough(initial, 'entity:1').warnings).toContain('AVAILABLE_MEALS_BELOW_PLAN');
    const confirmed = reserve(initial);
    const started = accepted(confirmed.frame, { kind: 'breakthrough.begin', attemptId: confirmed.result.relatedId! });
    const blocked = stepCultivationMonths(started.frame, 2);
    expect(blocked.processedMonths).toBe(2);
    expect(blocked.frame.cultivation.attempts[0]).toMatchObject({ completedMonths: 0, blockedMonths: 2, blockedReason: 'SUPPLY_SHORTAGE', sample: null });
    expect(blocked.frame.inventory.meal).toEqual(initial.inventory.meal);
    expect(blocked.frame.inventory.herbs.owned).toBe(initial.inventory.herbs.owned);
    expect(blocked.frame.cultivation.disciples[0]!.ageMonths).toBe(initial.cultivation.disciples[0]!.ageMonths + 2);
  });
});

describe('monthly progression, lifespan and legacy', () => {
  it('bounds stepping and matches one-month replay exactly, including serialized checkpoints', () => {
    let initial = frame([createCultivator('entity:1')]);
    initial = accepted(initial, { kind: 'training.set', discipleId: 'entity:1', mode: 'training' }).frame;
    initial = accepted(initial, { kind: 'talent.grant', discipleId: 'entity:1', talentId: 'cultivation.steady-breath' }).frame;
    const batch = stepCultivationMonths(initial, 12);
    let repeated = initial;
    for (let index = 0; index < 12; index++) repeated = stepCultivationMonths(JSON.parse(JSON.stringify(repeated)), 1).frame;
    expect(batch.frame).toEqual(repeated);
    expect(batch.frame.cultivation.disciples[0]!.cultivation).toBe(120);
    expect(stepCultivationMonths(initial, 13)).toMatchObject({ frame: initial, processedMonths: 0, stopped: 'invalid-month-count' });
    expect(stepCultivationMonths(initial, -1).stopped).toBe('invalid-month-count');
    expect(stepCultivationMonths(initial, 0).frame).toBe(initial);
  });

  it('stops on lifespan expiry before same-month breakthrough progress, with no hidden fatal draw', () => {
    const initial = frame([createCultivator('entity:1', { ageMonths: 959, cultivation: 120 })]);
    const preview = previewBreakthrough(initial, 'entity:1');
    expect(preview.warnings).toContain('LIFESPAN_BEFORE_COMPLETION');
    const confirmed = reserve(initial);
    const started = accepted(confirmed.frame, { kind: 'breakthrough.begin', attemptId: confirmed.result.relatedId! });
    const stopped = stepCultivationMonths(started.frame, 12);
    expect(stopped.processedMonths).toBe(1);
    expect(stopped.stopped).toBe('decision-required');
    expect(stopped.frame.cultivation.disciples[0]!.lifeState).toBe('pendingDeath');
    expect(stopped.frame.cultivation.attempts[0]).toMatchObject({ phase: 'Cancelled', completedMonths: 0, sample: null });
    expect(stopped.frame.inventory.herbs.reserved).toBe(0);
    expect(stopped.frame.inventory.meal.owned).toBe(initial.inventory.meal.owned);
    expect(stopped.frame.randomStreams).toEqual(initial.randomStreams);
    expect(stepCultivationMonths(stopped.frame, 1)).toMatchObject({ frame: stopped.frame, processedMonths: 0, stopped: 'decision-required' });
  });

  it('finalizes natural death and relic inheritance once while retaining archives and revoking only owned talents', () => {
    let initial = frame([createCultivator('entity:1', { ageMonths: 959, relicIds: ['relic:scroll'] }), createCultivator('entity:2')]);
    initial = accepted(initial, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' }).frame;
    initial = accepted(initial, { kind: 'talent.grant', discipleId: 'entity:1', talentId: 'cultivation.patient-scholar' }).frame;
    initial = accepted(initial, { kind: 'talent.grant', discipleId: 'entity:2', talentId: 'cultivation.steady-breath' }).frame;
    const stopped = stepCultivationMonths(initial, 1).frame;
    const death = stopped.cultivation.pendingDeaths[0]!;
    const finalized = accepted(stopped, { kind: 'death.finalize', discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true });
    expect(finalized.frame.cultivation.deaths).toHaveLength(1);
    expect(finalized.frame.cultivation.disciples).toHaveLength(2);
    expect(finalized.frame.cultivation.disciples[0]!.talents[0]!.active).toBe(false);
    expect(finalized.frame.cultivation.disciples[1]!.talents).toHaveLength(1);
    expect(finalized.frame.cultivation.disciples[1]!.talents[0]!.active).toBe(true);
    expect(finalized.frame.cultivation.disciples[1]!.relicIds).toEqual(['relic:scroll']);
    expect(finalized.frame.cultivation.deaths[0]!.cleanupDiscipleId).toBe('entity:1');
    expect(applyCultivationCommand(finalized.frame, finalized.command)).toMatchObject({ ok: true, replayed: true });
    expect(applyCultivationCommand(finalized.frame, { ...finalized.command, commandId: 'second-death', expectedRevision: finalized.frame.cultivation.revision, deathId: 'death:duplicate' } as CultivationCommand)).toMatchObject({ ok: false, code: 'DEATH_CONFLICT' });
  });

  it('keeps completed teachings after teacher death, without cloning their personal talents', () => {
    let initial = frame([createCultivator('entity:1', { ageMonths: 956, knowledgeIds: ['knowledge:herbalism'] }), createCultivator('entity:2')]);
    initial = accepted(initial, { kind: 'talent.grant', discipleId: 'entity:1', talentId: 'cultivation.patient-scholar' }).frame;
    const teaching = accepted(initial, { kind: 'teaching.begin', discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge:herbalism' });
    const taught = stepCultivationMonths(teaching.frame, 2).frame;
    expect(taught.cultivation.disciples[1]!.knowledge).toEqual([{ knowledgeId: 'knowledge:herbalism', teacherId: 'entity:1', teachingId: teaching.result.relatedId }]);
    expect(taught.cultivation.disciples[1]!.talents).toEqual([]);
    const stopped = stepCultivationMonths(taught, 2).frame;
    const death = stopped.cultivation.pendingDeaths[0]!;
    const finalized = accepted(stopped, { kind: 'death.finalize', discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true });
    expect(finalized.frame.cultivation.disciples[1]!.knowledge).toEqual(taught.cultivation.disciples[1]!.knowledge);
  });

  it('does not grant incomplete teaching when the teacher expires, and preserves all-dead campaign records', () => {
    const initial = frame([createCultivator('entity:1', { ageMonths: 959, knowledgeIds: ['knowledge:herbalism'], relicIds: ['relic:staff'] }), createCultivator('entity:2', { ageMonths: 959 })]);
    const teaching = accepted(initial, { kind: 'teaching.begin', discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge:herbalism' });
    let stopped = stepCultivationMonths(teaching.frame, 1).frame;
    expect(stopped.cultivation.disciples[1]!.knowledge).toEqual([]);
    for (const death of [...stopped.cultivation.pendingDeaths]) {
      stopped = accepted(stopped, { kind: 'death.finalize', discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true }).frame;
    }
    expect(stopped.cultivation.disciples.every((d) => d.lifeState === 'dead')).toBe(true);
    expect(stopped.cultivation.deaths).toHaveLength(2);
    expect(stopped.cultivation.sectRelicIds).toEqual(['relic:staff']);
    expect(stopped.cultivation.disciples).toHaveLength(2);
  });

  it('retains deterministic risk/RNG results through mid-seclusion serialization', () => {
    const initial = chooseOutcome(frame([createCultivator('entity:1', { realm: 'qi', cultivation: 360 })]), 'injury');
    const confirmed = reserve(initial);
    const started = accepted(confirmed.frame, { kind: 'breakthrough.begin', attemptId: confirmed.result.relatedId! });
    const middle = stepCultivationMonths(started.frame, 1).frame;
    const left = stepCultivationMonths(middle, 2).frame;
    const right = stepCultivationMonths(JSON.parse(JSON.stringify(middle)), 2).frame;
    const command: CultivationCommand = { commandId: 'deterministic-resolve', expectedRevision: left.cultivation.revision, kind: 'breakthrough.resolve', attemptId: confirmed.result.relatedId!, acknowledgeRisk: true };
    expect(applyCultivationCommand(left, command)).toEqual(applyCultivationCommand(right, command));
  });
});

describe('cultivation import and resource safety', () => {
  it.each(['negative-resource', 'reservation-underflow', 'invalid-rng', 'duplicate-disciple', 'unknown-realm', 'expired-alive'])('rejects malformed state (%s) without mutation', (variant) => {
    const before = frame();
    if (variant === 'negative-resource') before.inventory.herbs.owned = -1;
    if (variant === 'reservation-underflow') before.inventory.herbs.reserved = before.inventory.herbs.owned + 1;
    if (variant === 'invalid-rng') before.randomStreams.events.state = 0;
    if (variant === 'duplicate-disciple') before.cultivation.disciples.push(cloneJson(before.cultivation.disciples[0]!));
    if (variant === 'unknown-realm') (before.cultivation.disciples[0] as unknown as { realm: string }).realm = 'unsupported';
    if (variant === 'expired-alive') before.cultivation.disciples[0]!.ageMonths = REALM_RULES.mortal.lifespanMonths;
    const snapshot = cloneJson(before);
    expect(validateCultivationFrame(before).length).toBeGreaterThan(0);
    expect(applyCultivationCommand(before, { commandId: 'invalid-state', expectedRevision: 0, kind: 'training.set', discipleId: 'entity:1', mode: 'training' })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(stepCultivationMonths(before, 1).stopped).toBe('invalid-state');
    expect(before).toEqual(snapshot);
  });

  it('rejects erased escrow or altered frozen costs and never draws a breakthrough from malformed imported state', () => {
    const waiting = ready(frame());
    for (const corruption of ['escrow', 'costs'] as const) {
      const damaged = cloneJson(waiting.frame);
      if (corruption === 'escrow') damaged.inventory.herbs.reserved = 0;
      else { damaged.cultivation.attempts[0]!.reservation.lines = []; damaged.cultivation.attempts[0]!.preview.costs = []; damaged.inventory.herbs.reserved = 0; }
      const before = cloneJson(damaged);
      expect(applyCultivationCommand(damaged, { commandId: 'corrupt-resolution', expectedRevision: damaged.cultivation.revision, kind: 'breakthrough.resolve', attemptId: waiting.attemptId, acknowledgeRisk: true })).toMatchObject({ ok: false, code: 'INVALID_STATE' });
      expect(damaged).toEqual(before);
    }
  });

  it('rejects malformed constructors, unsupported commands and duplicate source grants safely', () => {
    expect(() => createCultivator('entity:1', { ageMonths: -1 })).toThrow();
    expect(() => createCultivator('entity:1', { aptitude: NaN })).toThrow();
    const before = frame();
    expect(validateCultivationFrame({ cultivation: null })).not.toEqual([]);
    expect(applyCultivationCommand(before, { commandId: 'unknown', expectedRevision: 0, kind: 'not-real' } as unknown as CultivationCommand)).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    const first = accepted(before, { kind: 'talent.grant', discipleId: 'entity:1', talentId: 'cultivation.steady-breath' });
    const second = accepted(first.frame, { kind: 'talent.grant', discipleId: 'entity:1', talentId: 'cultivation.steady-breath' });
    expect(second.frame.cultivation.disciples[0]!.talents).toHaveLength(1);
    expect(second.result.relatedId).toBe(first.result.relatedId);
  });

  it('does not debit escrow or publish a result if RNG exhaustion interrupts resolution', () => {
    const waiting = ready(frame());
    waiting.frame.randomStreams.events.draws = Number.MAX_SAFE_INTEGER;
    const before = cloneJson(waiting.frame);
    const result = applyCultivationCommand(waiting.frame, { commandId: 'rng-overflow', expectedRevision: waiting.frame.cultivation.revision,
      kind: 'breakthrough.resolve', attemptId: waiting.attemptId, acknowledgeRisk: true });
    expect(result).toMatchObject({ ok: false, code: 'OVERFLOW' });
    expect(result.frame).toBe(waiting.frame);
    expect(waiting.frame).toEqual(before);
    expect(waiting.frame.cultivation.attempts[0]!.sample).toBeNull();
    expect(waiting.frame.cultivation.attempts[0]!.reservation.state).toBe('reserved');
  });

  it('rejects changed active risk factors and cannot relabel a pending natural death as combat', () => {
    const waiting = ready(frame());
    const damaged = cloneJson(waiting.frame);
    damaged.cultivation.disciples[0]!.injury = 80;
    expect(validateCultivationFrame(damaged)).toContain('Active attempt differs from frozen preparation');
    const old = frame([createCultivator('entity:1', { ageMonths: 959 })]);
    const expired = stepCultivationMonths(old, 1).frame;
    const deathId = expired.cultivation.pendingDeaths[0]!.deathId;
    const result = applyCultivationCommand(expired, { commandId: 'relabel-death', expectedRevision: expired.cultivation.revision,
      kind: 'death.finalize', discipleId: 'entity:1', deathId, cause: 'combat', acknowledgeDeath: true });
    expect(result).toMatchObject({ ok: false, code: 'DEATH_CONFLICT', frame: expired });
  });

  it('validates recorded outcomes against the saved RNG trace', () => {
    const waiting = ready(chooseOutcome(frame(), 'success'));
    const resolved = accepted(waiting.frame, { kind: 'breakthrough.resolve', attemptId: waiting.attemptId, acknowledgeRisk: true }).frame;
    const damaged = cloneJson(resolved);
    damaged.cultivation.attempts[0]!.sample!.randomAfter.state = damaged.cultivation.attempts[0]!.sample!.randomAfter.state === 1 ? 2 : 1;
    expect(validateCultivationFrame(damaged)).toContain('Stored sample does not match its RNG trace');
  });

  it('preserves the last complete boundary on integer exhaustion', () => {
    const before = frame();
    before.cultivation.revision = Number.MAX_SAFE_INTEGER;
    const result = stepCultivationMonths(before, 1);
    expect(result).toMatchObject({ frame: before, processedMonths: 0, stopped: 'overflow' });
    const command = applyCultivationCommand(before, { commandId: 'overflow', expectedRevision: Number.MAX_SAFE_INTEGER, kind: 'training.set', discipleId: 'entity:1', mode: 'training' });
    expect(command).toMatchObject({ ok: false, code: 'OVERFLOW', frame: before });
  });
});
