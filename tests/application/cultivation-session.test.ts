import { lookupProduction } from '../../src/core/world/history-access';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApplicationSession, type CultivationRequest } from '../../src/application/session';
import { createWorld, advanceTicks, canonicalStringify, CALENDAR_TICKS_PER_MONTH, type WorldState } from '../../src/core/kernel';
import { REALM_RULES } from '../../src/core/cultivation/rules';
import { CultivationPanel, breakthroughRiskDisplay, cultivationActionLocks } from '../../src/app/CultivationPanel';
import { STARTER_ROUTE_ID } from '../../src/core/expeditions/encounter-catalog';
import { commandFeedbackKey } from '../../src/application/status-messages';
import { translate } from '../../src/i18n';

function preparedWorld(seed = 'cultivation-ui'): WorldState {
  const world = createWorld(seed);
  const profile = world.cultivation.disciples[1]!;
  profile.cultivation = REALM_RULES[profile.realm].cultivationRequired;
  return world;
}
function selectedId(session: ApplicationSession): string { return session.getSnapshot().cultivation.selected!.discipleId; }
function revision(session: ApplicationSession): number { return session.getSnapshot().cultivation.revision; }
/** Exercises the application accumulator in bounded 20-tick frames, never changes the world directly. */
function advanceMonths(session: ApplicationSession, count: number): void {
  session.frame(0);
  for (let frame = 1; frame <= count * 60; frame += 1) session.frame(frame * 1000);
}

function panel(session: ApplicationSession, locale: 'zh-CN' | 'en' = 'en'): string {
  return renderToStaticMarkup(createElement(CultivationPanel, { session, world: session.getSnapshot(), readOnly: false, t: (key, params) => translate(locale, key, params) }));
}

describe('mandatory away-disciple lifespan decisions', () => {
  it('keeps acknowledgement available while expedition ownership blocks ordinary cultivation', () => {
    const world = createWorld('away-lifespan-ui');
    const disciple = world.disciples[1]!;
    const profile = world.cultivation.disciples[1]!;
    disciple.ageMonths = profile.lifespanMonths - 1;
    disciple.birthCalendarTick = -disciple.ageMonths * CALENDAR_TICKS_PER_MONTH;
    profile.ageMonths = disciple.ageMonths;
    const session = new ApplicationSession(world);
    expect(session.dispatchExpedition({ kind: 'expedition.depart', request: { squadIds: [disciple.id, world.disciples[2]!.id], routeId: STARTER_ROUTE_ID } }).status).toBe('accepted');
    advanceMonths(session, 1);
    const selected = session.getSnapshot().cultivation.selected!;
    expect(selected.activityLocked).toBe(true);
    expect(selected.pendingDeath?.cause).toBe('lifespan');
    const inputs = panel(session).match(/<input[^>]*type="checkbox"[^>]*>/g)!;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toContain('disabled');
    expect(cultivationActionLocks(false, false, true)).toEqual({ ordinary: true, death: false });
    expect(cultivationActionLocks(true, false, true)).toEqual({ ordinary: true, death: true });
    expect(session.dispatchCultivation({ kind: 'death.finalize', discipleId: disciple.id, deathId: selected.pendingDeath!.deathId,
      cause: 'lifespan', acknowledgeDeath: true, expectedRevision: revision(session) }).status).toBe('accepted');
    session.frame(61_000); session.frame(62_000);
    expect(session.getSnapshot().clock.pauseReasons).not.toContain('cultivation');
    expect(session.exportWorld().expedition.run?.phase).toBe('AtNode');
  });
});

describe('cultivation session command authority', () => {
  it('uses matching outer/inner command IDs and releases production through the authoritative reducer', () => {
    const session = new ApplicationSession();
    const workerId = selectedId(session);
    const job = session.dispatch({ kind: 'production.start', payload: { recipeId: 'craft.plank', workerId } });
    expect(session.exportWorld().inventory.wood.reserved).toBe(3);
    const changed = session.dispatchCultivation({ kind: 'training.set', discipleId: workerId, mode: 'training', expectedRevision: revision(session) });
    expect(changed.status).toBe('accepted');
    expect(changed.cultivationResult?.commandId).toBe(changed.commandId);
    const world = session.exportWorld();
    expect(world.cultivation.receipts.at(-1)?.commandId).toBe(changed.commandId);
    expect(world.commandReceipts[changed.commandId]!.result.cultivationResult?.commandId).toBe(changed.commandId);
    expect(lookupProduction(world, job.transactionId!)!.state).toBe('Cancelled');
    expect(world.inventory.wood.reserved).toBe(0);
    expect(session.getSnapshot().cultivation.selected!.trainingMode).toBe('training');
    expect(session.getSnapshot().clock.simulationTick).toBe(0);
  });

  it('advances training and rest only at actual month boundaries', () => {
    const world = createWorld('monthly-cultivation-ui');
    world.cultivation.disciples[1]!.injury = 24;
    const session = new ApplicationSession(world);
    session.dispatchCultivation({ kind: 'training.set', discipleId: selectedId(session), mode: 'training', expectedRevision: revision(session) });
    session.frame(0); session.frame(50);
    expect(session.getSnapshot().cultivation.selected!.cultivation).toBe(0);
    advanceMonths(session, 1);
    expect(session.getSnapshot().cultivation.selected!.cultivation).toBeGreaterThan(0);
    session.dispatchCultivation({ kind: 'training.set', discipleId: selectedId(session), mode: 'rest', expectedRevision: revision(session) });
    const cultivated = session.getSnapshot().cultivation.selected!.cultivation;
    advanceMonths(session, 1);
    expect(session.getSnapshot().cultivation.selected!.injury).toBe(16);
    expect(session.getSnapshot().cultivation.selected!.cultivation).toBe(cultivated);
  });

  it('keeps revision checks intact and blocks writes under storage and error locks', () => {
    const session = new ApplicationSession();
    const originalRevision = revision(session);
    const id = selectedId(session);
    session.dispatchCultivation({ kind: 'training.set', discipleId: id, mode: 'training', expectedRevision: originalRevision });
    const stale = session.dispatchCultivation({ kind: 'training.set', discipleId: id, mode: 'rest', expectedRevision: originalRevision });
    expect(stale.rejection?.cultivationCode).toBe('REVISION_CONFLICT');
    expect(commandFeedbackKey(stale)).toBe('cultivation.error.REVISION_CONFLICT');
    session.setStorageReadOnly(true);
    const locked = session.dispatchCultivation({ kind: 'training.set', discipleId: id, mode: 'rest', expectedRevision: revision(session) });
    expect(locked.rejection?.code).toBe('CORE_PAUSED_ERROR');
    expect(session.getSnapshot().cultivation.selected!.trainingMode).toBe('training');
    session.setStorageReadOnly(false); session.setPaused('error', true);
    expect(session.dispatchCultivation({ kind: 'training.set', discipleId: id, mode: 'rest', expectedRevision: revision(session) }).rejection?.code).toBe('CORE_PAUSED_ERROR');
  });

  it('does not admit raw talent grants or fabricated combat death through the player command bridge', () => {
    const session = new ApplicationSession();
    const id = selectedId(session);
    const grant = session.dispatchCultivation({ kind: 'talent.grant', discipleId: id, talentId: 'cultivation.steady-breath', expectedRevision: revision(session) } as unknown as CultivationRequest);
    expect(grant.status).toBe('rejected');
    const forcedDeath = session.dispatchCultivation({ kind: 'death.finalize', discipleId: id, deathId: 'instance:999', cause: 'combat', acknowledgeDeath: true, expectedRevision: revision(session) } as unknown as CultivationRequest);
    expect(forcedDeath.status).toBe('rejected');
    expect(session.exportWorld().cultivation.disciples[1]!.lifeState).toBe('alive');
    expect(session.exportWorld().cultivation.disciples[1]!.talents).toEqual([]);
  });
});

describe('read-only breakthrough proposals and explicit lifecycle', () => {
  it('previews consume no state, IDs, resources or RNG and expose overall rather than conditional death chance', () => {
    const session = new ApplicationSession(preparedWorld());
    const before = canonicalStringify(session.exportWorld());
    const preview = session.prepareBreakthrough(selectedId(session), { method: 'forced', arraySupport: 0 });
    expect(canonicalStringify(session.exportWorld())).toBe(before);
    expect(Object.isFrozen(preview.preview.factors)).toBe(true);
    const display = breakthroughRiskDisplay(preview.preview);
    expect(display.overallDeath).toBe(preview.preview.overallDeathBps / 10_000);
    expect(display.conditionalDeath).toBe(preview.preview.failureDeathBps / 10_000);
    expect(display.overallDeath).toBeLessThan(display.conditionalDeath);
    expect(breakthroughRiskDisplay({ successBps: 7000, failureDeathBps: 2000, overallDeathBps: 600 })).toEqual({ success: 0.7, conditionalDeath: 0.2, overallDeath: 0.06 });
  });

  it('invalidates previews when resources change or the same world is reloaded', () => {
    const session = new ApplicationSession(preparedWorld());
    const proposal = session.prepareBreakthrough(selectedId(session), { method: 'standard', arraySupport: 1 });
    session.dispatch({ kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: session.getSnapshot().disciples[2]!.id } });
    expect(session.isBreakthroughProposalCurrent(proposal)).toBe(false);
    expect(session.confirmBreakthrough(proposal).rejection?.cultivationCode).toBe('PREVIEW_STALE');
    expect(session.exportWorld().cultivation.attempts).toHaveLength(0);
    const fresh = session.prepareBreakthrough(selectedId(session));
    session.replaceWorld(session.exportWorld());
    expect(session.isBreakthroughProposalCurrent(fresh)).toBe(false);
    expect(session.confirmBreakthrough(fresh).status).toBe('rejected');
    expect(session.exportWorld().cultivation.attempts).toHaveLength(0);
  });

  it('reserve, begin, cancel and duplicate confirmation never refund spent meals or debit twice', () => {
    const session = new ApplicationSession(preparedWorld());
    const proposal = session.prepareBreakthrough(selectedId(session));
    const confirmed = session.confirmBreakthrough(proposal);
    expect(confirmed.status).toBe('accepted');
    const attemptId = confirmed.cultivationResult!.relatedId!;
    expect(session.getSnapshot().cultivation.selected!.activeAttempt?.phase).toBe('Reserved');
    expect(session.exportWorld().inventory.herbs.reserved).toBe(2);
    expect(session.confirmBreakthrough(proposal).status).toBe('rejected');
    expect(session.exportWorld().cultivation.attempts).toHaveLength(1);
    const beforeMeals = session.exportWorld().inventory.meal.owned;
    session.dispatchCultivation({ kind: 'breakthrough.begin', attemptId, expectedRevision: revision(session) });
    advanceMonths(session, 1);
    expect(session.getSnapshot().cultivation.selected!.activeAttempt?.phase).toBe('DecisionReady');
    expect(session.exportWorld().inventory.meal.owned).toBe(beforeMeals - 1);
    session.setPaused('player', true);
    session.dispatchCultivation({ kind: 'breakthrough.cancel', attemptId, expectedRevision: revision(session) });
    expect(session.exportWorld().inventory.herbs.reserved).toBe(0);
    expect(session.exportWorld().inventory.meal.owned).toBe(beforeMeals - 1);
    expect(session.getSnapshot().clock.pauseReasons).toContain('player');
    expect(session.getSnapshot().clock.pauseReasons).not.toContain('cultivation');
  });

  it('requires explicit risk acknowledgment and preserves other pauses on resolution', () => {
    const session = new ApplicationSession(preparedWorld('resolve-ui'));
    const confirmed = session.confirmBreakthrough(session.prepareBreakthrough(selectedId(session)));
    const attemptId = confirmed.cultivationResult!.relatedId!;
    session.dispatchCultivation({ kind: 'breakthrough.begin', attemptId, expectedRevision: revision(session) });
    advanceMonths(session, 1);
    const beforeRandom = session.exportWorld().randomStreams;
    const rejected = session.dispatchCultivation({ kind: 'breakthrough.resolve', attemptId, acknowledgeRisk: false, expectedRevision: revision(session) });
    expect(rejected.rejection?.cultivationCode).toBe('ACKNOWLEDGEMENT_REQUIRED');
    expect(session.exportWorld().randomStreams).toEqual(beforeRandom);
    session.setPaused('player', true); session.setPaused('choice', true);
    const resolved = session.dispatchCultivation({ kind: 'breakthrough.resolve', attemptId, acknowledgeRisk: true, expectedRevision: revision(session) });
    expect(resolved.status).toBe('accepted');
    expect(session.getSnapshot().clock.pauseReasons).toEqual(['player', 'choice']);
    expect(session.getSnapshot().cultivation.selected!.lastOutcome).not.toBeNull();
    expect(session.getSnapshot().cultivation.selected!.activeAttempt).toBeNull();
  });

  it('maps saved risk details in both locales without changing the preview or exposing internal histories', () => {
    const session = new ApplicationSession(preparedWorld('risk-labels'));
    const proposal = session.prepareBreakthrough(selectedId(session), { method: 'forced', arraySupport: 0 });
    session.confirmBreakthrough(proposal);
    const before = canonicalStringify(session.exportWorld());
    const en = panel(session, 'en'); const zh = panel(session, 'zh-CN');
    expect(en).toContain('Overall death chance:');
    expect(en).toContain('Given failure, death chance is');
    expect(en).toContain('data-risk-kind="overall-death"');
    expect(zh).toContain('总体死亡率');
    expect(zh).not.toContain('文本暂不可用');
    expect(en).not.toContain('Text is temporarily unavailable');
    expect(canonicalStringify(session.exportWorld())).toBe(before);
    expect('receipts' in session.getSnapshot().cultivation).toBe(false);
    expect('events' in session.getSnapshot().cultivation).toBe(false);
    expect('sample' in session.getSnapshot().cultivation.selected!.activeAttempt!).toBe(false);
  });
});

describe('legitimate legacy and teaching choices', () => {
  it('shows the true empty teaching state until actual learned knowledge exists', () => {
    const session = new ApplicationSession();
    expect(session.getSnapshot().cultivation.selected!.teachingChoices).toEqual([]);
    expect(panel(session)).toContain('No learned knowledge');
    const world = createWorld('teaching-ui');
    world.cultivation.disciples[1]!.knowledge.push({ knowledgeId: 'knowledge:herbalism', teacherId: null, teachingId: null });
    world.cultivation.disciples[2]!.knowledge.push({ knowledgeId: 'knowledge:herbalism', teacherId: null, teachingId: null });
    const learned = new ApplicationSession(world);
    const choices = learned.getSnapshot().cultivation.selected!.teachingChoices;
    expect(choices).toHaveLength(1);
    expect(choices[0]!.knowledgeId).toBe('knowledge:herbalism');
    expect(choices[0]!.studentIds).not.toContain(world.disciples[1]!.id);
    expect(choices[0]!.studentIds).not.toContain(world.disciples[2]!.id);
    const studentId = choices[0]!.studentIds[0]!;
    expect(learned.dispatchCultivation({ kind: 'teaching.begin', discipleId: selectedId(learned), studentId, knowledgeId: choices[0]!.knowledgeId, expectedRevision: revision(learned) }).status).toBe('accepted');
    expect(learned.getSnapshot().cultivation.selected!.teaching?.studentId).toBe(studentId);
    advanceMonths(learned, 2);
    expect(learned.exportWorld().cultivation.disciples.find((entry) => entry.discipleId === studentId)!.knowledge.some((entry) => entry.knowledgeId === 'knowledge:herbalism')).toBe(true);
  });

  it('only acknowledges an existing pending lifespan death and reports actual legacy settlement', () => {
    const world = createWorld('pending-death-ui');
    const id = world.disciples[1]!.id;
    const heirId = world.disciples[2]!.id;
    world.disciples[1]!.ageMonths = 959;
    world.disciples[1]!.birthCalendarTick = -959 * CALENDAR_TICKS_PER_MONTH;
    world.cultivation.disciples[1]!.ageMonths = 959;
    world.cultivation.disciples[1]!.relicIds = ['relic:staff'];
    world.cultivation.disciples[1]!.heirId = heirId;
    const pending = advanceTicks(world, CALENDAR_TICKS_PER_MONTH);
    const session = new ApplicationSession(pending);
    const projection = session.getSnapshot().cultivation.selected!;
    expect(projection.pendingDeath?.cause).toBe('lifespan');
    expect(session.getSnapshot().cultivation.decisions).toContainEqual({ discipleId: id, kind: 'death' });
    expect(panel(session)).toContain('permanent');
    session.setPaused('player', true);
    const rejected = session.dispatchCultivation({ kind: 'death.finalize', discipleId: id, deathId: projection.pendingDeath!.deathId, cause: 'lifespan', acknowledgeDeath: false, expectedRevision: revision(session) });
    expect(rejected.rejection?.cultivationCode).toBe('ACKNOWLEDGEMENT_REQUIRED');
    const finalized = session.dispatchCultivation({ kind: 'death.finalize', discipleId: id, deathId: projection.pendingDeath!.deathId, cause: 'lifespan', acknowledgeDeath: true, expectedRevision: revision(session) });
    expect(finalized.status).toBe('accepted');
    expect(session.getSnapshot().clock.pauseReasons).toEqual(['player']);
    expect(session.getSnapshot().cultivation.selected!.deathRecord).toMatchObject({ beneficiaryId: heirId, transferredRelicCount: 1 });
    expect(session.exportWorld().cultivation.disciples.find((entry) => entry.discipleId === heirId)!.relicIds).toContain('relic:staff');
  });
});
