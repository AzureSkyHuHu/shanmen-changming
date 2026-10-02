import type { BreakthroughPreparation, TrainingMode } from '../core/cultivation/types';
import type { RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import { messageSpecifications, type TextKey } from '../i18n';
import type { ApplicationSessionV9, BreakthroughProposalV9, CultivationRequestV9, SessionCommandResultV9 } from './session-v9';
import { createManagementUiHoldScopeV9, managementResultV9, managementRiskCurrentV9,
  type ManagementSnapshotV9, type ManagementTextV9, type ManagementUiHoldScopeV9 } from './management-v9-contract';

/** Fixed DTO/command ports only; no World, storage, reward or content mutation port. */
export type ManagementCultivationSessionV9 = Pick<ApplicationSessionV9, 'getSnapshot' | 'subscribe' | 'select'
  | 'dispatchCultivation' | 'prepareBreakthrough' | 'confirmBreakthrough' | 'isProposalCurrent'
  | 'setReviewPaused' | 'setOverlayPaused'>;
export type ManagementCultivationIntentV9 =
  | { kind: 'preview' | 'confirm'; discipleId: string }
  | { kind: 'training'; discipleId: string; mode: TrainingMode }
  | { kind: 'heir'; discipleId: string; heirId: string | null }
  | { kind: 'begin' | 'cancel' | 'resolve'; discipleId: string; attemptId: string }
  | { kind: 'death'; discipleId: string; deathId: string };
export type ManagementCultivationDecisionV9 = Extract<ManagementCultivationIntentV9, { kind: 'begin' | 'cancel' | 'resolve' | 'death' }>;
type OrdinaryIntent = Extract<ManagementCultivationIntentV9, { kind: 'training' | 'heir' }> | { kind: 'begin'; discipleId: string; attemptId: string };
type DecisionIntent = { kind: 'cancel' | 'resolve'; discipleId: string; attemptId: string } | { kind: 'death'; discipleId: string; deathId: string };

export function managementCultivationBoundaryV9(expected: ManagementSnapshotV9, current: ManagementSnapshotV9): boolean {
  return expected.sessionEpoch === current.sessionEpoch && expected.worldRevision === current.worldRevision
    && expected.stamp.generation === current.stamp.generation && expected.stamp.publication === current.stamp.publication
    && expected.cultivation.revision === current.cultivation.revision && expected.cultivation.resourceStamp === current.cultivation.resourceStamp
    && expected.selection?.kind === current.selection?.kind && expected.selection?.id === current.selection?.id
    && expected.cultivation.selected?.discipleId === current.cultivation.selected?.discipleId;
}
/** Only existing decision exits may pass the cultivation pause. Every other
 * domain pause and Session/storage restriction remains a rejection. */
export function managementCultivationGuardV9(expected: ManagementSnapshotV9, current: ManagementSnapshotV9,
  readOnly: boolean, intent: ManagementCultivationIntentV9, allowReview = false): TextKey | null {
  if (current.closed || current.stopped || current.runtimeFailure) return 'managementV9.stopped';
  if (readOnly || current.holds.storage) return 'managementV9.readOnly';
  if (current.holds.storageBusy) return 'managementV9.busy';
  if (current.holds.overlay || current.holds.review && !allowReview) return 'managementV9.reviewHeld';
  if (current.holds.hidden || current.holds.player || current.frame.clock.mode !== 'management') return 'managementV9.pausedHint';
  if (!managementCultivationBoundaryV9(expected, current)) return 'managementV9.stale';
  const selected = current.cultivation.selected;
  if (!selected || current.selection?.kind !== 'disciple' || current.selection.id !== intent.discipleId || selected.discipleId !== intent.discipleId
    || !current.frame.disciples.some(actor => actor.id === intent.discipleId)) return 'managementV9.stale';
  const attempt = selected.activeAttempt;
  const pendingDecision = current.cultivation.decisions.some(row => row.discipleId === intent.discipleId
    && row.kind === (intent.kind === 'death' ? 'death' : 'breakthrough'));
  const decisionExit = pendingDecision && (intent.kind === 'death' ? selected.lifeState === 'pendingDeath'
    && selected.pendingDeath?.deathId === intent.deathId && selected.pendingDeath.cause === 'lifespan'
    : attempt?.phase === 'DecisionReady' && selected.lifeState === 'alive'
      && (intent.kind === 'heir' || (intent.kind === 'resolve' || intent.kind === 'cancel') && attempt.attemptId === intent.attemptId));
  if (current.frame.clock.pauseReasons.some(reason => reason !== 'cultivation' || !decisionExit)) return 'managementV9.pausedHint';
  if (intent.kind === 'death') return selected.lifeState === 'pendingDeath' && selected.pendingDeath?.deathId === intent.deathId
    && selected.pendingDeath.cause === 'lifespan' && pendingDecision ? null : 'cultivation.error.DEATH_CONFLICT';
  if (selected.lifeState !== 'alive') return 'cultivation.error.DISCIPLE_UNAVAILABLE';
  if (intent.kind === 'begin' || intent.kind === 'cancel' || intent.kind === 'resolve') {
    if (!attempt || attempt.attemptId !== intent.attemptId) return 'cultivation.error.UNKNOWN_ATTEMPT';
    return (intent.kind === 'begin' ? attempt.phase === 'Reserved' : intent.kind === 'resolve' ? attempt.phase === 'DecisionReady' && pendingDecision
      : ['Reserved', 'InSeclusion', 'DecisionReady'].includes(attempt.phase)) ? null : 'cultivation.error.INVALID_PHASE';
  }
  const away = current.cultivation.summaries.find(row => row.discipleId === intent.discipleId)?.away;
  if (intent.kind === 'heir') {
    if (away) return 'cultivation.error.DISCIPLE_UNAVAILABLE';
    return intent.heirId === null || selected.heirChoices.includes(intent.heirId)
      && current.cultivation.summaries.some(row => row.discipleId === intent.heirId && row.lifeState === 'alive')
      ? null : 'cultivation.error.INVALID_INHERITANCE';
  }
  if (away || attempt || selected.teaching || selected.learning) return 'cultivation.error.DISCIPLE_UNAVAILABLE';
  if (selected.workOwner && !(intent.kind === 'training' && (intent.mode === 'duty' || intent.mode === 'rest' && selected.workOwner.kind === 'care')))
    return 'managementV9.reason.worker';
  return null;
}
export function managementCultivationAcceptedV9(result: SessionCommandResultV9): boolean {
  return result.ok && result.result.status === 'accepted';
}
export function managementCultivationResultV9(result: SessionCommandResultV9): ManagementTextV9 {
  if (result.ok && result.result.status === 'rejected' && result.result.rejection && 'cultivationCode' in result.result.rejection) {
    const key = `cultivation.error.${result.result.rejection.cultivationCode}`;
    if (Object.hasOwn(messageSpecifications, key)) return { key: key as TextKey };
  }
  return managementResultV9(result);
}
/** Accepted outcomes are localized by the view; never call ok an acceptance. */
export function managementCultivationOutcomeV9(result: SessionCommandResultV9): 'success' | 'injury' | 'death' | 'cancelled' | null {
  const command = result.ok && result.result.status === 'accepted' && 'cultivationResult' in result.result ? result.result.cultivationResult : null;
  return command && (command.kind === 'breakthrough.resolve' || command.kind === 'breakthrough.cancel') && command.outcome !== 'accepted' ? command.outcome : null;
}
function requestFor(intent: OrdinaryIntent | DecisionIntent, revision: number): CultivationRequestV9 {
  const expectedRevision = revision;
  switch (intent.kind) {
    case 'training': return { kind: 'training.set', discipleId: intent.discipleId, mode: intent.mode, expectedRevision };
    case 'heir': return { kind: 'legacy.setHeir', discipleId: intent.discipleId, heirId: intent.heirId, expectedRevision };
    case 'begin': return { kind: 'breakthrough.begin', attemptId: intent.attemptId, expectedRevision };
    case 'cancel': return { kind: 'breakthrough.cancel', attemptId: intent.attemptId, expectedRevision };
    case 'resolve': return { kind: 'breakthrough.resolve', attemptId: intent.attemptId, acknowledgeRisk: true, expectedRevision };
    case 'death': return { kind: 'death.finalize', discipleId: intent.discipleId, deathId: intent.deathId, cause: 'lifespan', acknowledgeDeath: true, expectedRevision };
  }
}
export type ManagementCultivationActionResultV9 = { message: ManagementTextV9; result: SessionCommandResultV9 | null };
const deniedResult = (key: TextKey): ManagementCultivationActionResultV9 => ({ message: { key }, result: null });
const commandResult = (result: SessionCommandResultV9): ManagementCultivationActionResultV9 => ({ message: managementCultivationResultV9(result), result });
export function performManagementCultivationV9(session: ManagementCultivationSessionV9, basis: ManagementSnapshotV9,
  readOnly: boolean, intent: OrdinaryIntent): ManagementCultivationActionResultV9 {
  const current = session.getSnapshot(); const denied = managementCultivationGuardV9(basis, current, readOnly, intent);
  return denied ? deniedResult(denied) : commandResult(session.dispatchCultivation(requestFor(intent, current.cultivation.revision)));
}
export type ManagementCultivationReviewV9 = Readonly<{ kind: 'proposal'; basis: ManagementSnapshotV9; proposal: RuntimeReadonlyV9<BreakthroughProposalV9> }>
  | Readonly<{ kind: 'decision'; basis: ManagementSnapshotV9; intent: DecisionIntent }>;
export function managementCultivationReviewGuardV9(session: ManagementCultivationSessionV9, review: ManagementCultivationReviewV9,
  readOnly: boolean, allowReview = true): TextKey | null {
  const current = session.getSnapshot();
  const intent: ManagementCultivationIntentV9 = review.kind === 'proposal' ? { kind: 'confirm', discipleId: review.proposal.view.preview.discipleId } : review.intent;
  const denied = managementCultivationGuardV9(review.basis, current, readOnly, intent, allowReview); if (denied) return denied;
  if (review.kind === 'proposal' && (!managementRiskCurrentV9(review.proposal, current) || !session.isProposalCurrent(review.proposal)
    || !review.proposal.view.preview.basisHash)) return 'managementV9.stale';
  return null;
}
/** UI review lifecycle is independently testable. Issued proposal identity stays
 * intact; decision acknowledgements are consumed before asynchronous hold release.
 * start/stop can be replayed by React StrictMode without leaking a Session hold. */
export function createManagementCultivationReviewV9(session: ManagementCultivationSessionV9, getReadOnly: () => boolean) {
  let review: ManagementCultivationReviewV9 | null = null;
  let scope: ManagementUiHoldScopeV9 | null = null; let unsubscribe: (() => void) | null = null;
  let lifecycle = 0; const listeners = new Set<() => void>();
  const publish = (next: ManagementCultivationReviewV9 | null) => { review = next; for (const listener of listeners) listener(); };
  const cancel = () => { if (!review) return; publish(null); scope?.setReviewPaused(false); };
  const invalidate = () => { if (review && managementCultivationReviewGuardV9(session, review, getReadOnly())) cancel(); };
  const acquire = (basis: ManagementSnapshotV9, intent: ManagementCultivationIntentV9): ManagementTextV9 | null => {
    if (!scope) return { key: 'managementV9.stopped' };
    const denied = managementCultivationGuardV9(basis, session.getSnapshot(), getReadOnly(), intent, review !== null);
    if (denied) { cancel(); return { key: denied }; }
    const held = scope.setReviewPaused(true); return held.ok ? null : managementResultV9(held);
  };
  return {
    getSnapshot: () => review,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (scope) return; lifecycle++; scope = createManagementUiHoldScopeV9(session); unsubscribe = session.subscribe(invalidate); },
    stop() { lifecycle++; unsubscribe?.(); unsubscribe = null; cancel(); scope?.dispose(); scope = null; },
    cancel, invalidate,
    prepare(basis: ManagementSnapshotV9, preparation: BreakthroughPreparation): ManagementTextV9 | null {
      const discipleId = basis.cultivation.selected?.discipleId; if (!discipleId) return { key: 'managementV9.stale' };
      const denied = acquire(basis, { kind: 'preview', discipleId }); if (denied) return denied;
      const result = session.prepareBreakthrough(discipleId, preparation);
      if (!result.ok) { publish(null); scope?.setReviewPaused(false); return managementResultV9(result); }
      publish(Object.freeze({ kind: 'proposal', basis: session.getSnapshot(), proposal: result.value })); return null;
    },
    open(basis: ManagementSnapshotV9, intent: DecisionIntent): ManagementTextV9 | null {
      const denied = acquire(basis, intent); if (denied) return denied;
      publish(Object.freeze({ kind: 'decision', basis: session.getSnapshot(), intent: Object.freeze({ ...intent }) })); return null;
    },
    async confirm(expected: ManagementCultivationReviewV9, acknowledged: boolean): Promise<ManagementCultivationActionResultV9> {
      if (review !== expected || !scope) return deniedResult('managementV9.stale');
      if (!acknowledged && !(expected.kind === 'decision' && expected.intent.kind === 'cancel')) return deniedResult('cultivation.error.ACKNOWLEDGEMENT_REQUIRED');
      const denied = managementCultivationReviewGuardV9(session, expected, getReadOnly());
      if (denied) { cancel(); return deniedResult(denied); }
      if (expected.kind === 'proposal' && (expected.proposal.view.preview.blockers.length || expected.proposal.view.workOwner)) return deniedResult('cultivation.error.PREPARATION_BLOCKED');
      const pendingLifecycle = lifecycle; const ownedScope = scope;
      // Consume synchronously, even if React has not rerendered the old button.
      publish(null);
      if (!scope || lifecycle !== pendingLifecycle) return deniedResult('managementV9.stale');
      if (expected.kind === 'proposal') {
        const changed = managementCultivationReviewGuardV9(session, expected, getReadOnly());
        if (changed) { ownedScope.setReviewPaused(false); return deniedResult(changed); }
        const result = session.confirmBreakthrough(expected.proposal); ownedScope.setReviewPaused(false); return commandResult(result);
      }
      ownedScope.setReviewPaused(false);
      // The shared coordinator releases only this UI's hold outside publication.
      await Promise.resolve();
      if (!scope || lifecycle !== pendingLifecycle) return deniedResult('managementV9.stale');
      const current = session.getSnapshot(); const changed = managementCultivationReviewGuardV9(session, expected, getReadOnly(), false);
      return changed ? deniedResult(changed) : commandResult(session.dispatchCultivation(requestFor(expected.intent, current.cultivation.revision)));
    },
  };
}
