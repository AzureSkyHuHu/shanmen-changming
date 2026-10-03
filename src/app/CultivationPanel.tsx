import { useId, useState } from 'react';
import type { BreakthroughPreview, TrainingMode } from '../core/cultivation/types';
import type { ApplicationSession, BreakthroughProposal, DeepReadonly, SessionProjection } from '../application/session';
import type { TextKey, TranslationParams } from '../i18n';
import { knowledgeLabel } from './knowledge-label';
import './cultivation.css';

type Translator = (key: TextKey, parameters?: TranslationParams) => string;
type Projection = DeepReadonly<SessionProjection>;
interface PanelProps { session: ApplicationSession; world: Projection; readOnly: boolean; t: Translator }

/** Expedition ownership blocks ordinary actions, never its mandatory lifespan decision. */
export function cultivationActionLocks(readOnly: boolean, coreError: boolean, activityLocked: boolean) {
  return { ordinary: readOnly || coreError || activityLocked, death: readOnly || coreError };
}

/** Percent inputs are fractions. This deliberately uses overallDeathBps, never failureDeathBps. */
export function breakthroughRiskDisplay(preview: Pick<BreakthroughPreview, 'successBps' | 'overallDeathBps' | 'failureDeathBps'>) {
  return { success: preview.successBps / 10_000, overallDeath: preview.overallDeathBps / 10_000, conditionalDeath: preview.failureDeathBps / 10_000 };
}

function RiskDetails({ preview, t, prepared = false }: { preview: DeepReadonly<BreakthroughPreview>; t: Translator; prepared?: boolean }) {
  const risk = breakthroughRiskDisplay(preview);
  const materials = preview.costs.length ? preview.costs.map((line) => t('production.line', { amount: line.quantity, name: t(`resource.${line.resourceId}`) })).join(' · ') : t('production.noInput');
  return <section className="cultivation-risk" aria-label={t('cultivation.ui.preview')}>
    <h4>{preview.targetRealm ? t('cultivation.ui.target', { realm: t(`cultivation.realm.${preview.targetRealm}`) }) : t('cultivation.ui.finalRealm')}</h4>
    <p>{t('cultivation.ui.costs', { materials })}</p>
    <p>{t('cultivation.ui.seclusionMonths', { months: preview.seclusionMonths })}</p>
    <p>{t('cultivation.ui.supply', { monthly: preview.monthlyMealCost, total: preview.monthlyMealCost * preview.seclusionMonths })}</p>
    {prepared && <p>{t('cultivation.ui.lifespan', { months: preview.remainingLifespanMonths })}</p>}
    <div className="cultivation-probabilities"><strong>{t('cultivation.ui.successChance', { chance: risk.success })}</strong><strong className="cultivation-death-risk" data-risk-kind="overall-death">{t('cultivation.ui.overallDeathChance', { chance: risk.overallDeath })}</strong></div>
    <p className="footnote">{t('cultivation.ui.conditionalDeathChance', { chance: risk.conditionalDeath })}</p>
    <p className="footnote">{t('cultivation.ui.riskFormula')}</p>
    <details className="cultivation-factors"><summary>{t('cultivation.ui.factors')}</summary><ul>{preview.factors.map((factor) => <li key={factor.key}>{t('cultivation.ui.factorValue', { factor: t(`cultivation.factor.${factor.key}`), value: factor.contributionBps / 10_000 })}</li>)}</ul></details>
    {preview.blockers.length > 0 && <ul className="cultivation-blockers">{preview.blockers.map((blocker) => <li key={blocker}>{t(`cultivation.blocker.${blocker}`)}</li>)}</ul>}
    {preview.warnings.length > 0 && <ul className="cultivation-warnings">{preview.warnings.map((warning) => <li key={warning}>{t(`cultivation.warning.${warning}`)}</li>)}</ul>}
  </section>;
}

/** Every write uses the session command port. Opening/closing these details changes no pause reason. */
export function CultivationPanel({ session, world, readOnly, t }: PanelProps) {
  const prefix = useId();
  const selected = world.cultivation.selected;
  const [method, setMethod] = useState<'standard' | 'forced'>('standard');
  const [arraySupport, setArraySupport] = useState<0 | 1 | 2>(0);
  const [proposal, setProposal] = useState<DeepReadonly<BreakthroughProposal> | null>(null);
  const [previewFailure, setPreviewFailure] = useState(false);
  const [acknowledgedPreview, setAcknowledgedPreview] = useState(false);
  const [acknowledgedDecision, setAcknowledgedDecision] = useState<string | null>(null);
  const [acknowledgedDeath, setAcknowledgedDeath] = useState<string | null>(null);
  const [cancelAttemptId, setCancelAttemptId] = useState<string | null>(null);
  const [heirChoice, setHeirChoice] = useState<string | null>(null);
  const [knowledgeChoice, setKnowledgeChoice] = useState<string | null>(null);
  const [studentChoice, setStudentChoice] = useState<string | null>(null);
  if (!selected) return null;
  const revision = world.cultivation.revision;
  const locks = cultivationActionLocks(readOnly, world.clock.pauseReasons.includes('error'), selected.activityLocked);
  const locked = locks.ordinary;
  const alive = selected.lifeState === 'alive';
  const attempt = selected.activeAttempt;
  const canChangeMode = alive && !attempt && !selected.teaching && !selected.learning && !locked;
  const fresh = proposal !== null && proposal.sessionEpoch === world.sessionEpoch && proposal.preview.discipleId === selected.discipleId && proposal.preview.stateRevision === revision && proposal.resourceStamp === world.cultivation.resourceStamp;
  const nameOf = (id: string | null) => {
    const nameKey = world.disciples.find((entry) => entry.id === id)?.nameKey;
    return nameKey ? t(nameKey as TextKey) : t('cultivation.ui.sectBeneficiary');
  };
  const knowledgeName = (id: string) => knowledgeLabel(id, t);
  const selectedHeir = heirChoice === null ? selected.heirId ?? '' : heirChoice;
  const validHeir = selected.heirChoices.includes(selectedHeir) ? selectedHeir : '';
  const chosenKnowledge = selected.teachingChoices.find((entry) => entry.knowledgeId === knowledgeChoice) ?? selected.teachingChoices[0];
  const chosenStudent = chosenKnowledge?.studentIds.includes(studentChoice ?? '') ? studentChoice! : chosenKnowledge?.studentIds[0] ?? '';
  const decisionToken = attempt ? `${attempt.attemptId}:${revision}` : '';
  const deathToken = selected.pendingDeath ? `${selected.pendingDeath.deathId}:${revision}` : '';

  function changePreparation(nextMethod: 'standard' | 'forced', nextArray: 0 | 1 | 2) {
    setMethod(nextMethod); setArraySupport(nextArray); setProposal(null); setAcknowledgedPreview(false); setPreviewFailure(false);
  }
  function prepare() {
    try {
      setProposal(session.prepareBreakthrough(selected!.discipleId, { method, arraySupport }));
      setAcknowledgedPreview(false); setPreviewFailure(false);
    } catch { setPreviewFailure(true); setProposal(null); }
  }
  function changeMode(mode: TrainingMode) {
    if (!canChangeMode) return;
    session.dispatchCultivation({ kind: 'training.set', discipleId: selected!.discipleId, mode, expectedRevision: revision });
  }

  return <section className="cultivation-panel" aria-labelledby={`${prefix}-title`}>
    <h3 id={`${prefix}-title`}>{t('cultivation.ui.title')}</h3>
    <div className="cultivation-stats"><div><span>{t('cultivation.ui.realm')}</span><strong>{t(`cultivation.realm.${selected.realm}`)}</strong></div><div><span>{t('cultivation.ui.injury', { value: selected.injury })}</span><strong>{t('cultivation.ui.lifespan', { months: selected.remainingLifespanMonths })}</strong></div></div>
    <p className="small">{selected.requiredCultivation ? t('cultivation.ui.progress', { value: selected.cultivation, required: selected.requiredCultivation }) : t('cultivation.ui.finalRealm')}</p>
    {selected.requiredCultivation > 0 && <progress value={selected.cultivation} max={selected.requiredCultivation} aria-label={t('cultivation.ui.progress', { value: selected.cultivation, required: selected.requiredCultivation })} />}
    <div className="cultivation-minor-stats"><span>{t('cultivation.ui.understanding', { value: selected.understanding })}</span><span>{t('cultivation.ui.foundation', { value: selected.foundation })}</span><span>{t('cultivation.ui.mindset', { value: selected.mindset })}</span></div>
    {selected.lastOutcome && <p className="cultivation-outcome" role="status">{t('cultivation.ui.outcome', { outcome: t(`cultivation.outcome.${selected.lastOutcome}`) })}</p>}
    <div className="cultivation-modes" role="group" aria-label={t('cultivation.ui.mode')}>{(['duty', 'training', 'rest'] as const).map((mode) => <button key={mode} className="secondary" disabled={!canChangeMode} aria-pressed={selected.trainingMode === mode} onClick={() => changeMode(mode)}>{t(`cultivation.mode.${mode}`)}</button>)}</div>
    <p className="footnote">{t('cultivation.ui.modeHint')}</p><p className="footnote">{t('cultivation.ui.monthHint')}</p>

    {selected.pendingDeath && <section className="cultivation-decision" aria-labelledby={`${prefix}-death`}>
      <h4 id={`${prefix}-death`}>{t('cultivation.ui.deathTitle')}</h4>
      <p>{t('cultivation.ui.deathWarning', { cause: t(`cultivation.cause.${selected.pendingDeath.cause}`) })}</p>
      <p>{t('cultivation.ui.deathDestination', { count: selected.relicCount, beneficiary: nameOf(selected.heirId) })}</p>
      {selected.pendingDeath.cause === 'lifespan' && <><label className="cultivation-ack"><input type="checkbox" checked={acknowledgedDeath === deathToken} disabled={locks.death} onChange={(event) => setAcknowledgedDeath(event.target.checked ? deathToken : null)} /><span>{t('cultivation.ui.acknowledgeDeath')}</span></label><button disabled={locks.death || acknowledgedDeath !== deathToken} onClick={() => { if (selected.pendingDeath?.cause === 'lifespan' && acknowledgedDeath === deathToken) session.dispatchCultivation({ kind: 'death.finalize', discipleId: selected.discipleId, deathId: selected.pendingDeath.deathId, cause: 'lifespan', acknowledgeDeath: true, expectedRevision: revision }); }}>{t('cultivation.ui.finalizeDeath')}</button></>}
    </section>}
    {selected.deathRecord && <p className="cultivation-outcome">{t('cultivation.ui.deathRecord', { cause: t(`cultivation.cause.${selected.deathRecord.cause}`), count: selected.deathRecord.transferredRelicCount, beneficiary: nameOf(selected.deathRecord.beneficiaryId) })}</p>}

    {alive && <section className="cultivation-breakthrough" aria-labelledby={`${prefix}-breakthrough`}>
      <h4 id={`${prefix}-breakthrough`}>{t('cultivation.ui.breakthrough')}</h4>
      {attempt ? <>
        <p className="cultivation-phase">{t(`cultivation.attempt.${attempt.phase}`)}</p>
        <p>{t('cultivation.ui.monthsCompleted', { completed: attempt.completedMonths, required: attempt.preview.seclusionMonths })}</p>
        {attempt.blockedReason && <p className="notice">{t('cultivation.ui.supplyBlocked', { months: attempt.blockedMonths })}</p>}
        <RiskDetails preview={attempt.preview} t={t} />
        {attempt.phase === 'Reserved' && <button disabled={locked} onClick={() => session.dispatchCultivation({ kind: 'breakthrough.begin', attemptId: attempt.attemptId, expectedRevision: revision })}>{t('cultivation.ui.begin')}</button>}
        {attempt.phase === 'DecisionReady' && <div className="cultivation-decision">
          <p>{t('cultivation.ui.deathDestination', { count: selected.relicCount, beneficiary: nameOf(selected.heirId) })}</p>
          <label className="cultivation-ack"><input type="checkbox" checked={acknowledgedDecision === decisionToken} disabled={locked} onChange={(event) => setAcknowledgedDecision(event.target.checked ? decisionToken : null)} /><span>{t('cultivation.ui.acknowledgeRisk')}</span></label>
          <button disabled={locked || acknowledgedDecision !== decisionToken} onClick={() => { if (acknowledgedDecision === decisionToken) session.dispatchCultivation({ kind: 'breakthrough.resolve', attemptId: attempt.attemptId, acknowledgeRisk: true, expectedRevision: revision }); }}>{t('cultivation.ui.resolve')}</button>
        </div>}
        <button className="secondary" disabled={locked} onClick={() => setCancelAttemptId(attempt.attemptId)}>{t('cultivation.ui.cancel')}</button>
        {cancelAttemptId === attempt.attemptId && <div className="cultivation-cancel-confirmation"><p>{t('cultivation.ui.cancelWarning')}</p><div className="cultivation-actions"><button disabled={locked} onClick={() => { session.dispatchCultivation({ kind: 'breakthrough.cancel', attemptId: attempt.attemptId, expectedRevision: revision }); setCancelAttemptId(null); }}>{t('cultivation.ui.confirmCancel')}</button><button className="secondary" onClick={() => setCancelAttemptId(null)}>{t('cultivation.ui.keep')}</button></div></div>}
      </> : <>
        <div className="cultivation-preparation"><label htmlFor={`${prefix}-method`}>{t('cultivation.ui.method')}<select id={`${prefix}-method`} value={method} onChange={(event) => changePreparation(event.target.value === 'forced' ? 'forced' : 'standard', arraySupport)}><option value="standard">{t('cultivation.method.standard')}</option><option value="forced">{t('cultivation.method.forced')}</option></select></label><label htmlFor={`${prefix}-array`}>{t('cultivation.ui.array')}<select id={`${prefix}-array`} value={arraySupport} onChange={(event) => changePreparation(method, Number(event.target.value) as 0 | 1 | 2)}>{[0, 1, 2].map((level) => <option value={level} key={level}>{t('cultivation.ui.arrayLevel', { level })}</option>)}</select></label></div>
        <p className="footnote">{t('cultivation.ui.previewReadOnly')}</p>
        <button className="secondary" onClick={prepare}>{t(proposal ? 'cultivation.ui.repreview' : 'cultivation.ui.preview')}</button>
        {previewFailure && <p className="notice" role="status">{t('cultivation.ui.previewUnavailable')}</p>}
        {proposal && <><RiskDetails preview={proposal.preview} t={t} prepared />{!fresh && <p className="notice" role="status">{t('cultivation.ui.previewStale')}</p>}<label className="cultivation-ack"><input type="checkbox" checked={acknowledgedPreview} disabled={locked || !fresh || proposal.preview.blockers.length > 0} onChange={(event) => setAcknowledgedPreview(event.target.checked)} /><span>{t('cultivation.ui.acknowledgeRisk')}</span></label><button disabled={locked || !fresh || !acknowledgedPreview || proposal.preview.blockers.length > 0} onClick={() => { if (fresh && acknowledgedPreview) { const result = session.confirmBreakthrough(proposal); if (result.status === 'accepted') { setProposal(null); setAcknowledgedPreview(false); } } }}>{t('cultivation.ui.confirm')}</button></>}
      </>}
    </section>}

    <details className="cultivation-legacy"><summary>{t('cultivation.ui.legacy')}</summary>
      <label htmlFor={`${prefix}-heir`}>{t('cultivation.ui.heir')}<select id={`${prefix}-heir`} value={validHeir} disabled={!alive || locked} onChange={(event) => setHeirChoice(event.target.value)}><option value="">{t('cultivation.ui.noHeir')}</option>{selected.heirChoices.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}</select></label>
      <button className="secondary" disabled={!alive || locked || (validHeir || null) === selected.heirId} onClick={() => session.dispatchCultivation({ kind: 'legacy.setHeir', discipleId: selected.discipleId, heirId: validHeir || null, expectedRevision: revision })}>{t('cultivation.ui.setHeir')}</button>
      <h4>{t('cultivation.ui.teach')}</h4>
      {selected.teaching && <p>{t('cultivation.ui.teachingProgress', { name: nameOf(selected.teaching.studentId), knowledge: knowledgeName(selected.teaching.knowledgeId), completed: selected.teaching.completedMonths, required: selected.teaching.requiredMonths })}</p>}
      {selected.learning && <p>{t('cultivation.ui.learningProgress', { name: nameOf(selected.learning.teacherId), knowledge: knowledgeName(selected.learning.knowledgeId) })}</p>}
      {chosenKnowledge && chosenStudent ? <>
        <label htmlFor={`${prefix}-knowledge`}>{t('cultivation.ui.knowledge')}<select id={`${prefix}-knowledge`} disabled={locked} value={chosenKnowledge.knowledgeId} onChange={(event) => { setKnowledgeChoice(event.target.value); setStudentChoice(null); }}>{selected.teachingChoices.map((entry) => <option key={entry.knowledgeId} value={entry.knowledgeId}>{knowledgeName(entry.knowledgeId)}</option>)}</select></label>
        <label htmlFor={`${prefix}-student`}>{t('cultivation.ui.student')}<select id={`${prefix}-student`} disabled={locked} value={chosenStudent} onChange={(event) => setStudentChoice(event.target.value)}>{chosenKnowledge.studentIds.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}</select></label>
        <button disabled={locked} onClick={() => session.dispatchCultivation({ kind: 'teaching.begin', discipleId: selected.discipleId, studentId: chosenStudent, knowledgeId: chosenKnowledge.knowledgeId, expectedRevision: revision })}>{t('cultivation.ui.beginTeaching')}</button>
        {selected.totalTeachableKnowledge > selected.teachingChoices.length && <p className="footnote">{t('cultivation.ui.teachingLimited', { count: selected.teachingChoices.length })}</p>}
      </> : <p className="footnote">{t('cultivation.ui.noTeaching')}</p>}
      <p className="footnote">{t('cultivation.ui.teachingHint')}</p>
    </details>
  </section>;
}
