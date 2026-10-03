import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BreakthroughPreparation, BreakthroughPreview } from '../core/cultivation/types';
import type { RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import { attachManagementReviewEscapeV9, managementContentTextV9,
  type ManagementSnapshotV9, type ManagementTextV9, type ManagementTranslatorV9 } from '../application/management-v9-contract';
import { createManagementCultivationReviewV9, managementCultivationGuardV9, managementCultivationOutcomeV9,
  managementCultivationReviewGuardV9, performManagementCultivationV9, type ManagementCultivationActionResultV9,
  type ManagementCultivationIntentV9, type ManagementCultivationSessionV9 } from '../application/management-v9-cultivation-contract';

export interface ManagementCultivationPanelV9Props {
  active?: boolean;
  session: ManagementCultivationSessionV9; snapshot: ManagementSnapshotV9;
  readOnly: boolean; getReadOnly: () => boolean; t: ManagementTranslatorV9; onFeedback: (message: ManagementTextV9) => void;
}
/** Risk numbers, costs and factors come directly from an issued or reserved DTO. */
export function ManagementCultivationRiskV9({ preview, t }: {
  preview: RuntimeReadonlyV9<BreakthroughPreview>; t: ManagementTranslatorV9;
}) {
  const materials = preview.costs.length ? preview.costs.map(line => t('production.line', {
    amount: line.quantity, name: t(`resource.${line.resourceId}`),
  })).join(' · ') : t('production.noInput');
  return <div className="management-v9-cultivation-risk">
    <h4>{preview.targetRealm ? t('cultivation.ui.target', { realm: t(`cultivation.realm.${preview.targetRealm}`) }) : t('cultivation.ui.finalRealm')}</h4>
    <p>{t('cultivation.ui.costs', { materials })}</p>
    <p>{t('cultivation.ui.seclusionMonths', { months: preview.seclusionMonths })} · {t('cultivation.ui.supply', { monthly: preview.monthlyMealCost, total: preview.monthlyMealCost * preview.seclusionMonths })}</p>
    <p>{t('cultivation.ui.lifespan', { months: preview.remainingLifespanMonths })}</p>
    <p><strong>{t('cultivation.ui.successChance', { chance: preview.successBps / 10000 })}</strong></p>
    <p data-risk-kind="overall-death"><strong>{t('cultivation.ui.overallDeathChance', { chance: preview.overallDeathBps / 10000 })}</strong></p>
    <p>{t('cultivation.ui.conditionalDeathChance', { chance: preview.failureDeathBps / 10000 })}</p>
    <details><summary>{t('cultivation.ui.factors')}</summary><p>{t('cultivation.ui.riskFormula')}</p><ul>{preview.factors.map(factor => <li key={factor.key}>{t('cultivation.ui.factorValue', { factor: t(`cultivation.factor.${factor.key}`), value: factor.contributionBps / 10000 })}</li>)}</ul></details>
    {preview.blockers.length > 0 && <ul>{preview.blockers.map(blocker => <li key={blocker}>{t(`cultivation.blocker.${blocker}`)}</li>)}</ul>}
    {preview.warnings.length > 0 && <ul>{preview.warnings.map(warning => <li key={warning}>{t(`cultivation.warning.${warning}`)}</li>)}</ul>}
  </div>;
}

export function ManagementCultivationPanelV9({ active = true, session, snapshot, readOnly, getReadOnly, t, onFeedback }: ManagementCultivationPanelV9Props) {
  const id = useId();
  const latestReadOnly = useRef(getReadOnly); latestReadOnly.current = () => readOnly || getReadOnly();
  const reviews = useMemo(() => createManagementCultivationReviewV9(session, () => latestReadOnly.current()), [session]);
  const review = useSyncExternalStore(reviews.subscribe, reviews.getSnapshot, reviews.getSnapshot);
  const [preparation, setPreparation] = useState<BreakthroughPreparation>({ method: 'standard', arraySupport: 0 });
  const [acknowledged, setAcknowledged] = useState<typeof review>(null);
  const [heirDraft, setHeirDraft] = useState<{ epoch: number; discipleId: string; heirId: string | null } | null>(null);
  const reviewRegion = useRef<HTMLDivElement | null>(null);
  const selected = snapshot.cultivation.selected;
  useEffect(() => { reviews.start(); return () => reviews.stop(); }, [reviews]);
  useEffect(() => { reviews.invalidate(); }, [reviews, readOnly]);
  useEffect(() => {
    if (!active || !review) return;
    return attachManagementReviewEscapeV9(document, () => {
      const current = session.getSnapshot(); return current.holds.overlay || current.holds.storageBusy;
    }, reviews.cancel);
  }, [active, review, reviews, session]);
  useEffect(() => {
    const region = reviewRegion.current; if (!active || !review || !region) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (region.querySelector<HTMLInputElement | HTMLButtonElement>('input:not(:disabled), button:not(:disabled)') ?? region).focus();
    return () => {
      if (opener?.isConnected && (region.contains(document.activeElement) || document.activeElement === document.body)) opener.focus();
    };
  }, [active, review]);
  const name = (actorId: string | null) => {
    if (actorId === null) return t('cultivation.ui.sectBeneficiary');
    const actor = snapshot.frame.disciples.find(row => row.id === actorId);
    return actor ? managementContentTextV9(actor.nameKey, t) : t('managementV9.unknownPerson');
  };
  const feedback = (action: ManagementCultivationActionResultV9) => {
    const outcome = action.result && managementCultivationOutcomeV9(action.result);
    onFeedback(outcome ? { key: 'cultivation.ui.outcome', parameters: { outcome: t(`cultivation.outcome.${outcome}`) } } : action.message);
  };
  const reasonFor = (intent: ManagementCultivationIntentV9, allowReview = false) => managementCultivationGuardV9(snapshot, snapshot, readOnly, intent, allowReview);
  const intent = (kind: 'preview' | 'confirm'): ManagementCultivationIntentV9 => ({ kind, discipleId: selected?.discipleId ?? '' });
  const open = (decision: Parameters<typeof reviews.open>[1]) => {
    setAcknowledged(null); const message = reviews.open(snapshot, decision); if (message) onFeedback(message);
  };
  const chooseDecision = (discipleId: string) => {
    const current = session.getSnapshot();
    if (current.closed || current.runtimeFailure || current.holds.storageBusy || current.holds.overlay
      || current.sessionEpoch !== snapshot.sessionEpoch || !current.cultivation.decisions.some(row => row.discipleId === discipleId)) {
      onFeedback({ key: 'managementV9.stale' }); return;
    }
    reviews.cancel(); const result = session.select({ kind: 'disciple', id: discipleId });
    if (!result.ok) onFeedback({ key: 'managementV9.stale' });
  };
  const attempt = selected?.activeAttempt;
  const reviewDenied = review ? managementCultivationReviewGuardV9(session, review, readOnly) : null;
  const currentReview = review && !reviewDenied ? review : null;
  const beneficiary = selected?.heirId && selected.heirChoices.includes(selected.heirId) ? selected.heirId : null;
  const chosenHeir = selected && heirDraft?.epoch === snapshot.sessionEpoch && heirDraft.discipleId === selected.discipleId
    ? heirDraft.heirId : selected?.heirId ?? null;
  const validHeir = chosenHeir && selected?.heirChoices.includes(chosenHeir) ? chosenHeir : null;
  const age = snapshot.frame.disciples.find(actor => actor.id === selected?.discipleId)?.ageMonths;
  const prepareBlocked = reasonFor(intent('preview'), review?.kind === 'proposal');
  const actionHint: ManagementCultivationIntentV9 = selected?.pendingDeath?.cause === 'lifespan'
    ? { kind: 'death', discipleId: selected.discipleId, deathId: selected.pendingDeath.deathId }
    : selected && attempt ? { kind: 'cancel', discipleId: selected.discipleId, attemptId: attempt.attemptId } : intent('preview');
  const panelBlocked = reasonFor(actionHint);
  return <section id="management-v9-cultivation" className="management-v9-panel management-v9-anchor" tabIndex={-1} aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>{t('cultivation.ui.title')}</h2>
    {snapshot.cultivation.decisions.length > 0 && <div className="management-v9-card">
      <p>{t('cultivation.ui.pending', { count: snapshot.cultivation.decisions.length })}</p><p>{t('managementV9.cultivationDecisionHint')}</p>
      <div className="management-v9-actions">{snapshot.cultivation.decisions.map(decision => <button type="button" className="secondary" key={`${decision.kind}:${decision.discipleId}`}
        disabled={snapshot.closed || !!snapshot.runtimeFailure || snapshot.holds.storageBusy || snapshot.holds.overlay}
        onClick={() => chooseDecision(decision.discipleId)}>{t('cultivation.ui.review', { name: name(decision.discipleId) })} · {t(decision.kind === 'death' ? 'cultivation.ui.pendingDeath' : 'cultivation.attempt.DecisionReady')}</button>)}</div>
    </div>}
    {!selected ? <p>{t('managementV9.selectCultivator')}</p> : <>
      <h3>{name(selected.discipleId)} · {t(`cultivation.realm.${selected.realm}`)}</h3>
      <p>{age === undefined ? null : t('managementV9.cultivationAge', { years: Math.floor(age / 12), months: age % 12 })} · {t('cultivation.ui.lifespan', { months: selected.remainingLifespanMonths })} · {t('cultivation.ui.injury', { value: selected.injury })}</p>
      <p>{selected.requiredCultivation > 0 ? t('cultivation.ui.progress', { value: selected.cultivation, required: selected.requiredCultivation }) : t('cultivation.ui.finalRealm')}</p>
      {selected.requiredCultivation > 0 && <progress value={selected.cultivation} max={selected.requiredCultivation} aria-label={t('cultivation.ui.progress', { value: selected.cultivation, required: selected.requiredCultivation })} />}
      <p>{t('cultivation.ui.understanding', { value: selected.understanding })} · {t('cultivation.ui.foundation', { value: selected.foundation })} · {t('cultivation.ui.mindset', { value: selected.mindset })}</p>
      {selected.lastOutcome && <p className="management-v9-success">{t('cultivation.ui.outcome', { outcome: t(`cultivation.outcome.${selected.lastOutcome}`) })}</p>}
      <div className="management-v9-actions" role="group" aria-label={t('cultivation.ui.mode')}>{(['duty', 'training', 'rest'] as const).map(mode => {
        const action = { kind: 'training' as const, discipleId: selected.discipleId, mode };
        return <button type="button" className="secondary" key={mode} aria-pressed={selected.trainingMode === mode} disabled={!!reasonFor(action) || selected.trainingMode === mode}
          onClick={() => feedback(performManagementCultivationV9(session, snapshot, getReadOnly(), action))}>{t(`cultivation.mode.${mode}`)}</button>;
      })}</div>
      <p className="management-v9-help">{t('managementV9.cultivationModeHint')} {t('cultivation.ui.monthHint')}</p>
      {panelBlocked && !review && <p className="management-v9-notice">{t(panelBlocked)}</p>}
      {selected.pendingDeath && <div className="management-v9-card">
        <h3>{t('cultivation.ui.deathTitle')}</h3><p>{t('cultivation.ui.deathWarning', { cause: t(`cultivation.cause.${selected.pendingDeath.cause}`) })}</p>
        <p>{t('cultivation.ui.deathDestination', { count: selected.relicCount, beneficiary: name(beneficiary) })}</p><p>{t('managementV9.cultivationHeirLocked')}</p>
        {selected.pendingDeath.cause === 'lifespan' && <button type="button" disabled={!!reasonFor({ kind: 'death', discipleId: selected.discipleId, deathId: selected.pendingDeath.deathId })}
          onClick={() => open({ kind: 'death', discipleId: selected.discipleId, deathId: selected.pendingDeath!.deathId })}>{t('managementV9.reviewCultivationDeath')}</button>}
      </div>}
      {selected.lifeState === 'alive' && <div className="management-v9-card">
        <h3>{t('cultivation.ui.breakthrough')}</h3>
        {attempt ? <>
          <p>{t(`cultivation.attempt.${attempt.phase}`)}</p><p>{t('cultivation.ui.monthsCompleted', { completed: attempt.completedMonths, required: attempt.preview.seclusionMonths })}</p>
          <progress value={attempt.completedMonths} max={attempt.preview.seclusionMonths} aria-label={t('cultivation.ui.monthsCompleted', { completed: attempt.completedMonths, required: attempt.preview.seclusionMonths })} />
          {attempt.blockedReason && <p className="management-v9-notice">{t('cultivation.ui.supplyBlocked', { months: attempt.blockedMonths })}</p>}
          <details><summary>{t('managementV9.reservedCultivationPlan')}</summary><ManagementCultivationRiskV9 preview={attempt.preview} t={t} /></details>
          <div className="management-v9-actions">
            {attempt.phase === 'Reserved' && <button type="button" disabled={!!reasonFor({ kind: 'begin', discipleId: selected.discipleId, attemptId: attempt.attemptId })}
              onClick={() => feedback(performManagementCultivationV9(session, snapshot, getReadOnly(), { kind: 'begin', discipleId: selected.discipleId, attemptId: attempt.attemptId }))}>{t('cultivation.ui.begin')}</button>}
            {attempt.phase === 'DecisionReady' && <button type="button" disabled={!!reasonFor({ kind: 'resolve', discipleId: selected.discipleId, attemptId: attempt.attemptId })}
              onClick={() => open({ kind: 'resolve', discipleId: selected.discipleId, attemptId: attempt.attemptId })}>{t('managementV9.reviewCultivationRisk')}</button>}
            <button type="button" className="secondary" disabled={!!reasonFor({ kind: 'cancel', discipleId: selected.discipleId, attemptId: attempt.attemptId })}
              onClick={() => open({ kind: 'cancel', discipleId: selected.discipleId, attemptId: attempt.attemptId })}>{t('cultivation.ui.cancel')}</button>
          </div>
        </> : <>
          <div className="management-v9-coordinates">
            <label>{t('cultivation.ui.method')}<select value={preparation.method} disabled={!!prepareBlocked} onChange={event => { reviews.cancel(); setPreparation({ ...preparation, method: event.currentTarget.value === 'forced' ? 'forced' : 'standard' }); }}>
              <option value="standard">{t('cultivation.method.standard')}</option><option value="forced">{t('cultivation.method.forced')}</option></select></label>
            <label>{t('cultivation.ui.array')}<select value={preparation.arraySupport} disabled={!!prepareBlocked} onChange={event => { reviews.cancel(); const level = Number(event.currentTarget.value); setPreparation({ ...preparation, arraySupport: level === 2 ? 2 : level === 1 ? 1 : 0 }); }}>
              {([0, 1, 2] as const).map(level => <option value={level} key={level}>{t('cultivation.ui.arrayLevel', { level })}</option>)}</select></label>
          </div>
          <p className="management-v9-help">{t('cultivation.ui.previewReadOnly')}</p>
          <button type="button" className="secondary" disabled={!!prepareBlocked} onClick={() => { setAcknowledged(null); const message = reviews.prepare(snapshot, preparation); if (message) onFeedback(message); }}>{t(review?.kind === 'proposal' ? 'cultivation.ui.repreview' : 'cultivation.ui.preview')}</button>
        </>}
      </div>}
      <div ref={reviewRegion} tabIndex={-1}>
        {currentReview && <div className="management-v9-review" role="group" aria-labelledby={`${id}-review-title`}>
          <h3 id={`${id}-review-title`}>{t(currentReview.kind === 'proposal' ? 'cultivation.ui.preview' : currentReview.intent.kind === 'death' ? 'cultivation.ui.deathTitle' : currentReview.intent.kind === 'cancel' ? 'cultivation.ui.confirmCancel' : 'managementV9.reviewCultivationRisk')}</h3>
          {currentReview.kind === 'proposal' ? <ManagementCultivationRiskV9 preview={currentReview.proposal.view.preview} t={t} />
            : currentReview.intent.kind === 'cancel' ? <p>{t('cultivation.ui.cancelWarning')}</p>
              : <>{currentReview.intent.kind === 'resolve' && attempt && <ManagementCultivationRiskV9 preview={attempt.preview} t={t} />}
                {currentReview.intent.kind === 'death' && selected.pendingDeath && <p>{t('cultivation.ui.deathWarning', { cause: t(`cultivation.cause.${selected.pendingDeath.cause}`) })}</p>}
                <p>{t('cultivation.ui.deathDestination', { count: selected.relicCount, beneficiary: name(beneficiary) })}</p></>}
          {!(currentReview.kind === 'decision' && currentReview.intent.kind === 'cancel') && <label className="management-v9-checkbox"><input type="checkbox" checked={acknowledged === currentReview}
            onChange={event => setAcknowledged(event.currentTarget.checked ? currentReview : null)} /><span>{t(currentReview.kind === 'decision' && currentReview.intent.kind === 'death' ? 'cultivation.ui.acknowledgeDeath' : 'cultivation.ui.acknowledgeRisk')}</span></label>}
          <div className="management-v9-actions"><button type="button" disabled={!!reviewDenied || (currentReview.kind === 'proposal' && (currentReview.proposal.view.preview.blockers.length > 0 || !!currentReview.proposal.view.workOwner))
            || (!(currentReview.kind === 'decision' && currentReview.intent.kind === 'cancel') && acknowledged !== currentReview)}
            onClick={() => { void reviews.confirm(currentReview, acknowledged === currentReview).then(feedback); }}>{t(currentReview.kind === 'proposal' ? 'cultivation.ui.confirm' : currentReview.intent.kind === 'cancel' ? 'cultivation.ui.confirmCancel' : currentReview.intent.kind === 'death' ? 'cultivation.ui.finalizeDeath' : 'cultivation.ui.resolve')}</button>
            <button type="button" className="secondary" onClick={reviews.cancel}>{t(currentReview.kind === 'proposal' ? 'managementV9.cancelPreview' : 'cultivation.ui.keep')}</button></div>
        </div>}
      </div>
      <details className="management-v9-card"><summary>{t('cultivation.ui.legacy')}</summary>
        <p>{t('cultivation.ui.deathDestination', { count: selected.relicCount, beneficiary: name(beneficiary) })}</p>
        <label className="management-v9-field">{t('cultivation.ui.heir')}<select value={validHeir ?? ''} disabled={!!reasonFor({ kind: 'heir', discipleId: selected.discipleId, heirId: validHeir })}
          onChange={event => setHeirDraft({ epoch: snapshot.sessionEpoch, discipleId: selected.discipleId, heirId: event.currentTarget.value || null })}>
          <option value="">{t('cultivation.ui.noHeir')}</option>{selected.heirChoices.map(heirId => <option key={heirId} value={heirId}>{name(heirId)}</option>)}</select></label>
        <button type="button" className="secondary" disabled={!!reasonFor({ kind: 'heir', discipleId: selected.discipleId, heirId: validHeir }) || validHeir === selected.heirId}
          onClick={() => { const outcome = performManagementCultivationV9(session, snapshot, getReadOnly(), { kind: 'heir', discipleId: selected.discipleId, heirId: validHeir }); feedback(outcome); setHeirDraft(null); }}>{t('cultivation.ui.setHeir')}</button>
        {selected.lifeState !== 'alive' && <p className="management-v9-help">{t('managementV9.cultivationHeirLocked')}</p>}
        <h3>{t('cultivation.ui.teach')}</h3>
        {selected.teaching && <p>{t('cultivation.ui.teachingProgress', { name: name(selected.teaching.studentId), knowledge: t('cultivation.ui.knownKnowledge', { id: selected.teaching.knowledgeId }), completed: selected.teaching.completedMonths, required: selected.teaching.requiredMonths })}</p>}
        {selected.learning && <><p>{t('cultivation.ui.learningProgress', { name: name(selected.learning.teacherId), knowledge: t('cultivation.ui.knownKnowledge', { id: selected.learning.knowledgeId }) })}</p><p>{t('managementV9.cultivationLearningProgress', { completed: selected.learning.completedMonths, required: selected.learning.requiredMonths })}</p></>}
        {!selected.teaching && !selected.learning && <p>{selected.totalTeachableKnowledge > 0 ? t('managementV9.cultivationTeachingAvailable', { count: selected.totalTeachableKnowledge }) : t('cultivation.ui.noTeaching')}</p>}
        <p className="management-v9-help">{t('managementV9.cultivationTeachingScope')}</p>
      </details>
    </>}
  </section>;
}
