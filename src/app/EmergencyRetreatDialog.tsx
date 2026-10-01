import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ApplicationSession, DeepReadonly, EmergencyRetreatReview, EmergencyRetreatCommandResult } from '../application/session';
import { translate, type Locale, type TextKey } from '../i18n';
import type { ResourceLine } from '../core/economy/types';

export function confirmEmergencyReview(session: ApplicationSession, review: DeepReadonly<EmergencyRetreatReview>, acknowledged: boolean, isBlocked: () => boolean): EmergencyRetreatCommandResult {
  return isBlocked() ? { ok: false, code: 'CORE_PAUSED_ERROR' } : session.confirmEmergencyRetreat(review, acknowledged);
}
function ReviewDialog({ session, review, locale, readOnly, isBlocked }: { session: ApplicationSession; review: DeepReadonly<EmergencyRetreatReview>; locale: Locale; readOnly: boolean; isBlocked: () => boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const prefix = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const [failed, setFailed] = useState(false);
  const t = (key: TextKey, parameters?: Record<string, string | number>) => translate(locale, key, parameters);
  const name = (id: string) => { const key = session.getDiscipleNameKey(id); return key ? t(key as TextKey) : t('expedition.ui.none'); };
  const resources = (lines: readonly Readonly<ResourceLine>[]) => lines.length
    ? lines.map(line => t('production.line', { amount: line.quantity, name: t(`resource.${line.resourceId}`) })).join(' · ')
    : t('expedition.ui.none');
  const current = session.isEmergencyRetreatReviewCurrent(review);
  const cancel = () => { session.cancelEmergencyRetreat(review.reviewId); };
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className="save-dialog" aria-labelledby={`${prefix}-title`} onCancel={event => { event.preventDefault(); cancel(); }}>
    <h2 id={`${prefix}-title`}>{t('expedition.ui.emergencyRetreat')}</h2>
    <p>{t('expedition.ui.emergencyReviewHint')}</p>
    <p>{t('expedition.ui.deadMembers', { names: review.preview.losses.deadDiscipleIds.map(name).join(' · ') || t('expedition.ui.none') })}</p>
    {review.preview.losses.injuryByDisciple.map(injury => <p key={injury.discipleId}>{t('expedition.ui.addedInjury', { name: name(injury.discipleId), amount: injury.addedInjury })}</p>)}
    <p>{t('expedition.ui.lostLoot', { supplies: resources(review.preview.losses.unsecuredLoot) })}</p>
    <p>{t('expedition.ui.loot', { supplies: resources(review.preview.retainedLoot) })}</p>
    <p>{t('expedition.ui.expectedMonths', { months: review.preview.returnMonths })}</p>
    <p>{t('expedition.ui.minimumSupplies', { supplies: resources(review.preview.returnCost) })}</p>
    {(failed || !current || review.preview.blockers.length > 0) && <p className="notice" role="status">{t('expedition.ui.emergencyReviewBlocked')}</p>}
    <label className="expedition-ack"><input type="checkbox" checked={acknowledged} disabled={readOnly || !current} onChange={event => setAcknowledged(event.target.checked)} />{t('expedition.ui.emergencyAcknowledge')}</label>
    <div className="dialog-actions"><button disabled={readOnly || !current || !acknowledged || review.preview.blockers.length > 0} onClick={() => {
      // Session checks the current token, controller, outer modal/lease and explicit acknowledgement again.
      if (readOnly) return;
      const result = confirmEmergencyReview(session, review, acknowledged, isBlocked);
      if (!result.ok) setFailed(true);
    }}>{t('expedition.ui.confirmRetreat')}</button><button className="secondary" onClick={cancel}>{t('expedition.ui.keepRun')}</button></div>
  </dialog>;
}
/** Lives beside the App view switch so navigation cannot orphan a held battle. */
export function EmergencyRetreatDialog({ session, locale, readOnly, isBlocked = () => readOnly }: { session: ApplicationSession; locale: Locale; readOnly: boolean; isBlocked?: () => boolean }) {
  const review = useSyncExternalStore(session.subscribe, session.getEmergencyRetreatReview, session.getEmergencyRetreatReview);
  return review ? <ReviewDialog key={`${review.sessionEpoch}:${review.reviewId}`} session={session} review={review} locale={locale} readOnly={readOnly} isBlocked={isBlocked} /> : null;
}
