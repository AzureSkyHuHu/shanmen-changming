import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationSessionV9, type SessionCommandResultV9 } from '../../src/application/session-v9';
import { attachManagementReviewEscapeV9, createManagementUiHoldScopeV9, managementBlockedV9, type ManagementSnapshotV9 } from '../../src/application/management-v9-contract';
import { createManagementCultivationReviewV9, managementCultivationAcceptedV9, managementCultivationBoundaryV9,
  managementCultivationGuardV9, managementCultivationOutcomeV9, managementCultivationResultV9,
  managementCultivationReviewGuardV9, performManagementCultivationV9, type ManagementCultivationIntentV9,
} from '../../src/application/management-v9-cultivation-contract';
import { ManagementCultivationPanelV9, ManagementCultivationRiskV9 } from '../../src/app/ManagementCultivationPanelV9';
import { CALENDAR_TICKS_PER_MONTH as MONTH, type PauseReason } from '../../src/core/kernel/clock';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { parseSaveV9 } from '../../src/core/kernel/save-v9';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { translate, type TextKey, type TranslationParams } from '../../src/i18n';
import { fundedRuntimeFixture, recordChecked } from '../sect-expansion/fixtures/v9-runtime';

const t = (key: TextKey, parameters?: TranslationParams) => translate('zh-CN', key, parameters);
const sessions: ApplicationSessionV9[] = [];
const reviews: ReturnType<typeof createManagementCultivationReviewV9>[] = [];
const newSession = (source: WorldStateV9 = createUnregisteredWorldV9('cultivation-panel-v9')) => {
  const session = new ApplicationSessionV9(source); sessions.push(session); return session;
};
const controller = (session: ApplicationSessionV9, readOnly = () => false) => {
  const review = createManagementCultivationReviewV9(session, readOnly); reviews.push(review); review.start(); return review;
};
const activeReview = (review: ReturnType<typeof controller>) => { const current = review.getSnapshot(); expect(current).not.toBeNull(); if (!current) throw new Error('Missing review'); return current; };
const accepted = (result: SessionCommandResultV9 | null) => { expect(result && managementCultivationAcceptedV9(result), JSON.stringify(result)).toBe(true); };
function preparedSource(nearMonth = false): WorldStateV9 {
  // Explicit progress/stock test fixture. UI never injects resources or progress.
  const source = fundedRuntimeFixture(); source.cultivation.disciples.find(row => row.discipleId === 'entity:2')!.cultivation = 120;
  if (nearMonth) source.clock = { ...source.clock, simulationTick: MONTH - 1, calendarTick: MONTH - 1 };
  return recordChecked(source);
}
function dyingSession() {
  const source = createUnregisteredWorldV9('cultivation-panel-death');
  const actor = source.disciples.find(row => row.id === 'entity:2')!; const profile = source.cultivation.disciples.find(row => row.discipleId === actor.id)!;
  actor.birthCalendarTick = 2 - profile.lifespanMonths * MONTH;
  actor.ageMonths = Math.floor((source.clock.calendarTick - actor.birthCalendarTick) / MONTH); profile.ageMonths = actor.ageMonths;
  const session = newSession(recordChecked(source)); session.frame(0); session.frame(1000);
  expect(session.getSnapshot().cultivation.selected?.pendingDeath?.cause).toBe('lifespan'); return session;
}
function deathIntent(snapshot: ManagementSnapshotV9): ManagementCultivationIntentV9 & { kind: 'death' } {
  return { kind: 'death', discipleId: snapshot.cultivation.selected!.discipleId, deathId: snapshot.cultivation.selected!.pendingDeath!.deathId };
}
afterEach(() => { for (const review of reviews.splice(0)) review.stop(); for (const session of sessions.splice(0)) session.close(); vi.restoreAllMocks(); });

describe('bounded v9 cultivation action guards', () => {
  it('keeps the generic cultivation pause closed while permitting only the selected real death exit', () => {
    const session = dyingSession(); const snapshot = session.getSnapshot();
    expect(managementBlockedV9(snapshot, false)).toBe('managementV9.pausedHint');
    expect(managementCultivationGuardV9(snapshot, snapshot, false, deathIntent(snapshot))).toBeNull();
    for (const kind of ['training', 'preview', 'heir'] as const) {
      const intent: ManagementCultivationIntentV9 = kind === 'training' ? { kind, discipleId: 'entity:2', mode: 'rest' }
        : kind === 'heir' ? { kind, discipleId: 'entity:2', heirId: 'entity:1' } : { kind, discipleId: 'entity:2' };
      expect(managementCultivationGuardV9(snapshot, snapshot, false, intent)).toBeTruthy();
    }
    expect(managementCultivationGuardV9(snapshot, snapshot, false, { ...deathIntent(snapshot), deathId: 'unissued.death' })).toBeTruthy();
  });
  it.each(['player', 'hidden', 'error', 'save-capacity', 'danger', 'choice', 'expedition'] satisfies PauseReason[])('does not exempt a %s pause from the death exit', reason => {
    const session = dyingSession(); const before = session.getSnapshot();
    const snapshot = { ...before, frame: { ...before.frame, clock: { ...before.frame.clock, pauseReasons: ['cultivation', reason] as PauseReason[] } } };
    expect(managementCultivationGuardV9(snapshot, snapshot, false, deathIntent(snapshot))).toBe('managementV9.pausedHint');
  });
  it('keeps storage, busy, hidden, player, overlay, review, closed, runtime and capacity stops intact', () => {
    const session = dyingSession(); const before = session.getSnapshot(); const intent = deathIntent(before);
    for (const hold of ['storage', 'storageBusy', 'hidden', 'player', 'overlay', 'review'] as const) {
      const current = { ...before, holds: { ...before.holds, [hold]: true } };
      expect(managementCultivationGuardV9(before, current, false, intent), hold).toBeTruthy();
    }
    expect(managementCultivationGuardV9(before, before, true, intent)).toBe('managementV9.readOnly');
    expect(managementCultivationGuardV9(before, { ...before, closed: true }, false, intent)).toBe('managementV9.stopped');
    expect(managementCultivationGuardV9(before, { ...before, runtimeFailure: 'query-failed' }, false, intent)).toBe('managementV9.stopped');
    expect(managementCultivationGuardV9(before, { ...before, stopped: { kind: 'capacity', details: [] } }, false, intent)).toBe('managementV9.stopped');
  });
  it('checks epoch, selected person, cultivation/world revision, generation/publication and resource stamp', () => {
    const session = newSession(); const basis = session.getSnapshot(); const intent = { kind: 'training' as const, discipleId: 'entity:2', mode: 'rest' as const };
    const changed: ManagementSnapshotV9[] = [
      { ...basis, sessionEpoch: basis.sessionEpoch + 1 }, { ...basis, worldRevision: basis.worldRevision + 1 }, { ...basis, selection: null },
      { ...basis, stamp: { ...basis.stamp, publication: basis.stamp.publication + 1 } },
      { ...basis, stamp: { ...basis.stamp, generation: basis.stamp.generation + 1 } },
      { ...basis, cultivation: { ...basis.cultivation, revision: basis.cultivation.revision + 1 } },
      { ...basis, cultivation: { ...basis.cultivation, resourceStamp: 'changed.resources' } },
      { ...basis, cultivation: { ...basis.cultivation, selected: null } },
    ];
    for (const current of changed) {
      expect(managementCultivationBoundaryV9(basis, current)).toBe(false);
      expect(managementCultivationGuardV9(basis, current, false, intent)).toBe('managementV9.stale');
    }
  });
  it('performs real duty/train/rest commands and rejects the second event against a consumed boundary', () => {
    const session = newSession(); let basis = session.getSnapshot();
    for (const mode of ['training', 'rest', 'duty'] as const) {
      const intent = { kind: 'training' as const, discipleId: 'entity:2', mode };
      accepted(performManagementCultivationV9(session, basis, false, intent).result);
      expect(session.getSnapshot().cultivation.selected?.trainingMode).toBe(mode);
      expect(performManagementCultivationV9(session, basis, false, intent).message.key).toBe('managementV9.stale');
      basis = session.getSnapshot();
    }
  });
  it('applies real training and rest gains only at the actual month boundary', () => {
    const source = createUnregisteredWorldV9('cultivation-month-panel');
    source.clock = { ...source.clock, simulationTick: MONTH - 1, calendarTick: MONTH - 1 };
    const session = newSession(recordChecked(source)); const before = session.getSnapshot().cultivation.selected!.cultivation;
    accepted(performManagementCultivationV9(session, session.getSnapshot(), false, { kind: 'training', discipleId: 'entity:2', mode: 'training' }).result);
    expect(session.getSnapshot().cultivation.selected!.cultivation).toBe(before);
    session.select({ kind: 'disciple', id: 'entity:4' }); const injury = session.getSnapshot().cultivation.selected!.injury;
    accepted(performManagementCultivationV9(session, session.getSnapshot(), false, { kind: 'training', discipleId: 'entity:4', mode: 'rest' }).result);
    expect(session.getSnapshot().cultivation.selected!.injury).toBe(injury);
    session.frame(0); session.frame(50); expect(session.getSnapshot().cultivation.selected!.injury).toBeLessThan(injury);
    session.select({ kind: 'disciple', id: 'entity:2' }); expect(session.getSnapshot().cultivation.selected!.cultivation).toBeGreaterThan(before);
  });
  it('keeps actual work ownership and legal heir choices in the command preflight', () => {
    const session = newSession(); accepted(session.dispatch({ kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }));
    const snapshot = session.getSnapshot();
    expect(managementCultivationGuardV9(snapshot, snapshot, false, { kind: 'training', discipleId: 'entity:2', mode: 'training' })).toBe('managementV9.reason.worker');
    expect(managementCultivationGuardV9(snapshot, snapshot, false, { kind: 'heir', discipleId: 'entity:2', heirId: 'entity:2' })).toBe('cultivation.error.INVALID_INHERITANCE');
    accepted(performManagementCultivationV9(session, snapshot, false, { kind: 'heir', discipleId: 'entity:2', heirId: 'entity:1' }).result);
    expect(session.getSnapshot().cultivation.selected?.heirId).toBe('entity:1');
  });
  it('does not mistake typed domain rejection for business acceptance or hide its cultivation reason', () => {
    const rejected: SessionCommandResultV9 = { ok: true, kind: 'command', published: true, result: {
      commandId: 'ui.rejected', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'CULTIVATION_REJECTED', cultivationCode: 'INSUFFICIENT_RESOURCES' },
    } };
    expect(managementCultivationAcceptedV9(rejected)).toBe(false);
    expect(managementCultivationOutcomeV9(rejected)).toBeNull();
    expect(managementCultivationResultV9(rejected).key).toBe('cultivation.error.INSUFFICIENT_RESOURCES');
  });
});

describe('issued breakthrough review and interrupted confirmation lifecycle', () => {
  it('holds a real issued preview, requires acknowledgement, reserves once and begins through Session', async () => {
    const session = newSession(preparedSource()); const review = controller(session); const before = session.getSnapshot();
    expect(review.prepare(before, { method: 'standard', arraySupport: 0 })).toBeNull();
    const proposal = activeReview(review); expect(proposal.kind).toBe('proposal');
    expect(session.getSnapshot().holds.review).toBe(true); expect(session.getSnapshot().worldRevision).toBe(before.worldRevision);
    expect(session.getSnapshot().frame.resources).toEqual(before.frame.resources);
    expect((await review.confirm(proposal, false)).message.key).toBe('cultivation.error.ACKNOWLEDGEMENT_REQUIRED');
    const pending = review.confirm(proposal, true); const repeated = review.confirm(proposal, true);
    accepted((await pending).result); expect((await repeated).message.key).toBe('managementV9.stale');
    const reserved = session.getSnapshot(); expect(reserved.holds.review).toBe(false); expect(reserved.cultivation.selected?.activeAttempt?.phase).toBe('Reserved');
    expect(reserved.frame.resources.find(row => row.resourceId === 'herbs')!.reserved).toBe(2);
    accepted(performManagementCultivationV9(session, reserved, false, { kind: 'begin', discipleId: 'entity:2', attemptId: reserved.cultivation.selected!.activeAttempt!.attemptId }).result);
    expect(session.getSnapshot().cultivation.selected?.activeAttempt?.phase).toBe('InSeclusion');
  });
  it('rejects copied/altered proposal identity and basis hashes without issuing a command', () => {
    const session = newSession(preparedSource()); const review = controller(session); review.prepare(session.getSnapshot(), { method: 'standard', arraySupport: 0 });
    const current = activeReview(review); if (current.kind !== 'proposal') throw new Error('Expected proposal');
    const command = vi.spyOn(session, 'confirmBreakthrough');
    for (const proposal of [{ ...current.proposal }, { ...current.proposal, view: { ...current.proposal.view, preview: { ...current.proposal.view.preview, basisHash: 'forged.basis' } } }]) {
      expect(managementCultivationReviewGuardV9(session, { ...current, proposal }, false)).toBe('managementV9.stale');
    }
    expect(command).not.toHaveBeenCalled();
  });
  it('replaces a preparation without inheriting acknowledgement and cancels without reservation', async () => {
    const session = newSession(preparedSource()); const review = controller(session); const before = session.getSnapshot();
    review.prepare(before, { method: 'standard', arraySupport: 0 }); const old = activeReview(review);
    review.prepare(session.getSnapshot(), { method: 'forced', arraySupport: 2 }); const replacement = activeReview(review);
    expect(replacement).not.toBe(old); expect((await review.confirm(old, true)).message.key).toBe('managementV9.stale');
    expect((await review.confirm(replacement, false)).message.key).toBe('cultivation.error.ACKNOWLEDGEMENT_REQUIRED');
    review.cancel(); await Promise.resolve();
    expect(session.getSnapshot().holds.review).toBe(false); expect(session.getSnapshot().worldRevision).toBe(before.worldRevision);
    expect(session.getSnapshot().frame.resources).toEqual(before.frame.resources);
  });
  it('closes review on selection, actual storage lock, hidden transition and world replacement', async () => {
    const session = newSession(preparedSource()); const review = controller(session);
    const prepare = () => { review.prepare(session.getSnapshot(), { method: 'standard', arraySupport: 0 }); return activeReview(review); };
    const selected = prepare(); session.select({ kind: 'disciple', id: 'entity:4' }); expect(review.getSnapshot()).toBeNull(); await Promise.resolve();
    expect((await review.confirm(selected, true)).message.key).toBe('managementV9.stale');
    session.select({ kind: 'disciple', id: 'entity:2' }); prepare(); session.setStorageReadOnly(true); expect(review.getSnapshot()).toBeNull(); await Promise.resolve(); session.setStorageReadOnly(false);
    prepare(); session.setForeground({ visible: false }); expect(review.getSnapshot()).toBeNull(); await Promise.resolve(); session.setForeground({ visible: true });
    const replaced = prepare(); expect(session.replaceWorld(preparedSource()).ok).toBe(true); expect(review.getSnapshot()).toBeNull(); await Promise.resolve();
    expect((await review.confirm(replaced, true)).message.key).toBe('managementV9.stale'); expect(session.getSnapshot().holds.review).toBe(false);
  });
  it('routes document Escape to review cancel and releases the hold without commands', async () => {
    const session = newSession(preparedSource()); const review = controller(session); review.prepare(session.getSnapshot(), { method: 'standard', arraySupport: 0 });
    const target = new EventTarget(); const command = vi.spyOn(session, 'confirmBreakthrough');
    const detach = attachManagementReviewEscapeV9(target, () => false, review.cancel);
    const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: 'Escape' }); target.dispatchEvent(event);
    await Promise.resolve(); expect(event.defaultPrevented).toBe(true); expect(review.getSnapshot()).toBeNull(); expect(session.getSnapshot().holds.review).toBe(false); expect(command).not.toHaveBeenCalled(); detach();
  });
  it('does not steal an external review hold and survives mount-cleanup-mount', async () => {
    const session = newSession(preparedSource()); const external = createManagementUiHoldScopeV9(session); external.setReviewPaused(true);
    const review = controller(session); expect(review.prepare(session.getSnapshot(), { method: 'standard', arraySupport: 0 })?.key).toBe('managementV9.reviewHeld');
    review.stop(); await Promise.resolve(); expect(session.getSnapshot().holds.review).toBe(true);
    external.dispose(); await Promise.resolve(); review.start(); expect(review.prepare(session.getSnapshot(), { method: 'standard', arraySupport: 0 })).toBeNull();
    review.stop(); await Promise.resolve(); expect(session.getSnapshot().holds.review).toBe(false);
  });
  it('cancels a real reserved attempt once, releasing only its unused resources', async () => {
    const session = newSession(preparedSource()); const review = controller(session); review.prepare(session.getSnapshot(), { method: 'standard', arraySupport: 0 }); accepted((await review.confirm(activeReview(review), true)).result);
    const reserved = session.getSnapshot(); const id = reserved.cultivation.selected!.activeAttempt!.attemptId;
    expect(review.open(reserved, { kind: 'cancel', discipleId: 'entity:2', attemptId: id })).toBeNull(); const cancellation = activeReview(review);
    const pending = review.confirm(cancellation, false); expect(review.getSnapshot()).toBeNull();
    expect((await review.confirm(cancellation, false)).message.key).toBe('managementV9.stale'); accepted((await pending).result);
    expect(session.getSnapshot().cultivation.selected?.activeAttempt).toBeNull(); expect(session.getSnapshot().frame.resources.find(row => row.resourceId === 'herbs')!.reserved).toBe(0);
    expect(session.getSnapshot().cultivation.selected?.lastOutcome).toBe('cancelled');
  });
});

describe('real paused breakthrough and lifetime decisions', () => {
  it('reaches a genuine month boundary, permits legal heir choice, and resolves once under cultivation pause', async () => {
    const session = newSession(preparedSource(true)); const review = controller(session);
    review.prepare(session.getSnapshot(), { method: 'standard', arraySupport: 0 }); accepted((await review.confirm(activeReview(review), true)).result);
    let basis = session.getSnapshot(); const attemptId = basis.cultivation.selected!.activeAttempt!.attemptId;
    accepted(performManagementCultivationV9(session, basis, false, { kind: 'begin', discipleId: 'entity:2', attemptId }).result);
    session.frame(0); session.frame(50); basis = session.getSnapshot();
    expect(basis.cultivation.selected?.activeAttempt?.phase).toBe('DecisionReady'); expect(basis.frame.clock.pauseReasons).toContain('cultivation');
    accepted(performManagementCultivationV9(session, basis, false, { kind: 'heir', discipleId: 'entity:2', heirId: 'entity:1' }).result);
    basis = session.getSnapshot(); expect(review.open(basis, { kind: 'resolve', discipleId: 'entity:2', attemptId })).toBeNull(); const risk = activeReview(review);
    expect((await review.confirm(risk, false)).message.key).toBe('cultivation.error.ACKNOWLEDGEMENT_REQUIRED');
    const pending = review.confirm(risk, true); const repeated = review.confirm(risk, true); accepted((await pending).result);
    expect((await repeated).message.key).toBe('managementV9.stale'); expect(session.getSnapshot().cultivation.selected?.activeAttempt).toBeNull();
    expect(session.getSnapshot().frame.clock.pauseReasons).not.toContain('cultivation');
    expect(['success', 'injury']).toContain(session.getSnapshot().cultivation.selected?.lastOutcome);
  });
  it('confirms an existing lifespan death, archives the selected actor and roundtrips the real save', async () => {
    const session = dyingSession(); const review = controller(session); const basis = session.getSnapshot();
    expect(review.open(basis, deathIntent(basis))).toBeNull(); const death = activeReview(review);
    expect((await review.confirm(death, false)).message.key).toBe('cultivation.error.ACKNOWLEDGEMENT_REQUIRED');
    accepted((await review.confirm(death, true)).result); expect(session.getSnapshot().selection).toBeNull(); expect(session.getSnapshot().cultivation.selected).toBeNull();
    expect(session.getSnapshot().frame.disciples.some(actor => actor.id === 'entity:2')).toBe(false);
    expect((await review.confirm(death, true)).message.key).toBe('managementV9.stale');
    const save = session.exportSave({ buildId: 'v9-cultivation-panel-test', savedAt: '2026-10-02T16:00:00Z' }); expect(save.ok).toBe(true);
    if (save.ok) expect(parseSaveV9(save.value).ok).toBe(true);
  });
  it('rechecks storage/readOnly after releasing review and before any queued death command', async () => {
    const session = dyingSession(); let readOnly = false; const review = controller(session, () => readOnly);
    review.open(session.getSnapshot(), deathIntent(session.getSnapshot())); const command = vi.spyOn(session, 'dispatchCultivation');
    const pending = review.confirm(activeReview(review), true); readOnly = true;
    expect((await pending).message.key).toBe('managementV9.readOnly'); expect(command).not.toHaveBeenCalled();
    expect(session.getSnapshot().cultivation.selected?.lifeState).toBe('pendingDeath');
  });
  it('cancels queued confirmation on unmount and defers hold release while storage is busy', async () => {
    const session = dyingSession(); const review = controller(session);
    review.open(session.getSnapshot(), deathIntent(session.getSnapshot())); const command = vi.spyOn(session, 'dispatchCultivation');
    const pending = review.confirm(activeReview(review), true); review.stop(); review.start();
    expect((await pending).message.key).toBe('managementV9.stale'); expect(command).not.toHaveBeenCalled();
    review.open(session.getSnapshot(), deathIntent(session.getSnapshot())); session.setStorageBusy(true); expect(review.getSnapshot()).toBeNull(); await Promise.resolve();
    expect(session.getSnapshot().holds.review).toBe(true); session.setStorageBusy(false); await Promise.resolve();
    expect(session.getSnapshot().holds.review).toBe(false); expect(command).not.toHaveBeenCalled();
  });
});

describe('fixed DTO presentation and translated risk labels', () => {
  it.each(['zh-CN', 'en'] as const)('renders compact real age, injury, progress and teaching availability in %s without querying or exporting', locale => {
    const session = newSession(); session.select({ kind: 'disciple', id: 'entity:4' }); const before = session.getSnapshot();
    const prepare = vi.spyOn(session, 'prepareBreakthrough'); const exportWorld = vi.spyOn(session, 'exportWorld'); const command = vi.spyOn(session, 'dispatchCultivation');
    const translator = (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);
    const html = renderToStaticMarkup(createElement(ManagementCultivationPanelV9, { session, snapshot: before, readOnly: false, getReadOnly: () => false, t: translator, onFeedback: () => {} }));
    const age = before.frame.disciples.find(actor => actor.id === 'entity:4')!.ageMonths;
    expect(html).toContain(translator('managementV9.cultivationAge', { years: Math.floor(age / 12), months: age % 12 }));
    expect(html).toContain(translator('cultivation.ui.injury', { value: 25 })); expect(html).toContain(translator('cultivation.ui.noTeaching'));
    expect(html).not.toContain('<table'); expect(html).not.toContain(translator('cultivation.ui.beginTeaching'));
    expect(prepare).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled(); expect(exportWorld).not.toHaveBeenCalled(); expect(session.getSnapshot()).toBe(before);
  });
  it('renders issued total death and conditional death with their actual distinct percentages', () => {
    const session = newSession(preparedSource()); const result = session.prepareBreakthrough('entity:2', { method: 'forced', arraySupport: 0 }); expect(result.ok).toBe(true); if (!result.ok) return;
    const preview = result.value.view.preview;
    expect(preview.failureDeathBps).not.toBe(preview.overallDeathBps);
    const html = renderToStaticMarkup(createElement(ManagementCultivationRiskV9, { preview, t }));
    expect(html).toContain('data-risk-kind="overall-death"'); expect(html).toContain(t('cultivation.ui.overallDeathChance', { chance: preview.overallDeathBps / 10000 }));
    expect(html).toContain(t('cultivation.ui.conditionalDeathChance', { chance: preview.failureDeathBps / 10000 }));
    expect(html).toContain(t('cultivation.ui.supply', { monthly: preview.monthlyMealCost, total: preview.monthlyMealCost * preview.seclusionMonths }));
  });
  it('keeps no-selection and pending decisions visible without introducing authority/storage adapters', () => {
    const session = dyingSession(); session.select(null);
    const html = renderToStaticMarkup(createElement(ManagementCultivationPanelV9, { session, snapshot: session.getSnapshot(), readOnly: false, getReadOnly: () => false, t, onFeedback: () => {} }));
    expect(html).toContain(t('managementV9.selectCultivator')); expect(html).toContain(t('cultivation.ui.pending', { count: 1 }));
    const source = readFileSync(new URL('../../src/app/ManagementCultivationPanelV9.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/exportWorld\(|\.snapshot\(|as\s+(?:unknown\s+as\s+)?WorldState|indexedDB\.|localStorage\.|talent\.grant|teaching\.begin/);
    expect(source).toContain('attachManagementReviewEscapeV9'); expect(source).toContain('aria-pressed');
  });
});
