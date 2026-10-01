import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CampaignRouteId } from '../core/campaign/types';
import type { School } from '../core/combat/definitions';
import './campaign-growth-panel.css';

export interface CampaignGrowthText { readonly key: string; readonly parameters?: Readonly<Record<string, string | number>> }
export type CampaignGrowthTranslator = (key: string, parameters?: Readonly<Record<string, string | number>>) => string;
export interface CampaignGrowthGuard { readonly sessionEpoch: number; readonly basisStamp: string }
export interface CampaignGrowthDisciple { readonly discipleId: string; readonly name: string }
export interface CampaignGrowthCost { readonly resourceId: string; readonly nameKey: string; readonly quantity: number; readonly available: number }
interface GrowthAvailability { readonly blockedReason?: CampaignGrowthText }
export interface CampaignEquipmentClaimView extends GrowthAvailability {
  readonly routeId: CampaignRouteId; readonly nameKey: string; readonly descriptionKey: string;
  readonly eligibleDisciples: readonly CampaignGrowthDisciple[];
}
export interface CampaignManualView extends GrowthAvailability {
  readonly knowledgeId: string; readonly nameKey: string; readonly descriptionKey: string;
  readonly costs: readonly CampaignGrowthCost[]; readonly eligibleStudents: readonly CampaignGrowthDisciple[];
  readonly learnedBy: readonly CampaignGrowthDisciple[];
}
export interface CampaignRecruitSchoolView {
  readonly school: School; readonly schoolNameKey: string; readonly nameKey: string;
  readonly ageMonths: number; readonly lifespanMonths: number; readonly aptitude: number;
}
export interface CampaignRecruitInvitationView extends GrowthAvailability {
  readonly routeId: CampaignRouteId; readonly routeNameKey: string;
  readonly costs: readonly CampaignGrowthCost[]; readonly schools: readonly CampaignRecruitSchoolView[];
}
export interface CampaignReliefView extends GrowthAvailability {
  readonly costs: readonly CampaignGrowthCost[]; readonly schools: readonly CampaignRecruitSchoolView[];
  /** Current eligibility/cooldown explanation from the selected rules version. */
  readonly conditions: readonly CampaignGrowthText[];
}
export interface CampaignRecoveryView extends GrowthAvailability {
  /** Complete real consequences, retained assets and granted profiles/resources; never inferred by the panel. */
  readonly losses: readonly CampaignGrowthText[]; readonly retained: readonly CampaignGrowthText[];
  readonly grants: readonly CampaignGrowthText[];
}
export interface CampaignEstateItemView extends GrowthAvailability {
  readonly itemInstanceId: string; readonly nameKey: string; readonly descriptionKey: string;
  readonly provenance: readonly CampaignGrowthText[]; readonly eligibleDisciples: readonly CampaignGrowthDisciple[];
}
export type CampaignGrowthAction =
  | { readonly kind: 'campaign.equipment.claim'; readonly routeId: CampaignRouteId; readonly discipleId: string }
  | { readonly kind: 'campaign.lesson.learn'; readonly knowledgeId: string; readonly discipleId: string }
  | { readonly kind: 'campaign.recruit'; readonly routeId: CampaignRouteId; readonly school: School }
  | { readonly kind: 'campaign.relief'; readonly school: School }
  | { readonly kind: 'estate.assign'; readonly itemInstanceId: string; readonly discipleId: string };
export type CampaignGrowthRequest = CampaignGrowthAction | { readonly kind: 'campaign.recover'; readonly acknowledgeLoss: true };
export interface CampaignGrowthResult { readonly ok: boolean; readonly code?: string; readonly message?: CampaignGrowthText }
export interface CampaignGrowthPanelProps extends CampaignGrowthGuard {
  readonly readOnly: boolean; readonly activeRun: boolean; readonly managementActionsAvailable: boolean; readonly busy?: boolean;
  readonly equipment: readonly CampaignEquipmentClaimView[]; readonly manuals: readonly CampaignManualView[];
  readonly invitations: readonly CampaignRecruitInvitationView[]; readonly relief: CampaignReliefView | null;
  readonly recovery: CampaignRecoveryView | null; readonly estate: readonly CampaignEstateItemView[];
  readonly t: CampaignGrowthTranslator;
  /** Session rechecks current authority, owns command IDs and returns the real synchronous result. */
  readonly onCommand: (request: CampaignGrowthRequest, guard: CampaignGrowthGuard) => CampaignGrowthResult;
}
export interface CampaignRecoveryReview {
  readonly guard: CampaignGrowthGuard;
  readonly consequences: CampaignRecoveryView;
}
const sameGuard = (props: CampaignGrowthGuard, guard: CampaignGrowthGuard) => Number.isSafeInteger(guard.sessionEpoch)
  && guard.sessionEpoch >= 0 && typeof guard.basisStamp === 'string' && guard.basisStamp.length > 0 && props.sessionEpoch === guard.sessionEpoch && props.basisStamp === guard.basisStamp;
const costsAffordable = (costs: readonly CampaignGrowthCost[]) => new Set(costs.map(cost => cost.resourceId)).size === costs.length
  && costs.every(cost => cost.resourceId.length > 0 && Number.isSafeInteger(cost.quantity) && cost.quantity > 0
    && Number.isSafeInteger(cost.available) && cost.available >= cost.quantity);
const eligible = (options: readonly CampaignGrowthDisciple[], id: string) => typeof id === 'string' && id.length > 0 && options.some(option => option.discipleId === id);
const unblocked = (view: GrowthAvailability | undefined | null) => !!view && !view.blockedReason;
const exact = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function ready(props: CampaignGrowthPanelProps, guard: CampaignGrowthGuard) {
  return !props.readOnly && !props.busy && sameGuard(props, guard);
}
/** This is a display-boundary check, not a replacement for the authoritative command reducer. */
export function canSubmitCampaignGrowth(props: CampaignGrowthPanelProps, request: CampaignGrowthAction, guard: CampaignGrowthGuard): boolean {
  if (!ready(props, guard) || !request || typeof request !== 'object') return false;
  if (request.kind !== 'campaign.relief' && !props.managementActionsAvailable) return false;
  switch (request.kind) {
    case 'campaign.equipment.claim': {
      const view = props.equipment.find(entry => entry.routeId === request.routeId);
      return exact(request, ['kind', 'routeId', 'discipleId']) && !!view && unblocked(view) && eligible(view.eligibleDisciples, request.discipleId);
    }
    case 'campaign.lesson.learn': {
      const view = props.manuals.find(entry => entry.knowledgeId === request.knowledgeId);
      return exact(request, ['kind', 'knowledgeId', 'discipleId']) && !!view && unblocked(view) && costsAffordable(view.costs)
        && eligible(view.eligibleStudents, request.discipleId) && !eligible(view.learnedBy, request.discipleId);
    }
    case 'campaign.recruit': {
      const view = props.invitations.find(entry => entry.routeId === request.routeId);
      return exact(request, ['kind', 'routeId', 'school']) && !!view && unblocked(view) && costsAffordable(view.costs)
        && view.schools.some(option => option.school === request.school);
    }
    case 'campaign.relief': return !props.activeRun && exact(request, ['kind', 'school']) && !!props.relief && unblocked(props.relief)
      && costsAffordable(props.relief.costs) && props.relief.schools.some(option => option.school === request.school);
    case 'estate.assign': {
      const view = props.estate.find(entry => entry.itemInstanceId === request.itemInstanceId);
      return exact(request, ['kind', 'itemInstanceId', 'discipleId']) && !!view && unblocked(view) && eligible(view.eligibleDisciples, request.discipleId);
    }
    default: return false;
  }
}
export function canReviewCampaignRecovery(props: CampaignGrowthPanelProps, guard: CampaignGrowthGuard): boolean {
  return ready(props, guard) && !props.activeRun && unblocked(props.recovery) && !!props.recovery?.losses.length && !!props.recovery.retained.length && !!props.recovery.grants.length;
}
function copyRecovery(view: CampaignRecoveryView): CampaignRecoveryView {
  const copy = (lines: readonly CampaignGrowthText[]) => Object.freeze(lines.map(line => Object.freeze({ key: line.key,
    ...(line.parameters ? { parameters: Object.freeze({ ...line.parameters }) } : {}),
  })));
  return Object.freeze({ losses: copy(view.losses), retained: copy(view.retained), grants: copy(view.grants) });
}
/** One shared transaction latch, including re-entrant clicks and uncertain callback results. */
export function createCampaignGrowthController() {
  let inFlight = false;
  let awaiting: CampaignGrowthGuard | null = null;
  let review: CampaignRecoveryReview | null = null;
  const attemptedRequests = new Set<string>();
  let attemptedBasis: string | null = null;
  const keyFor = (guard: CampaignGrowthGuard) => JSON.stringify([guard.sessionEpoch, guard.basisStamp]);
  function observe(props: CampaignGrowthPanelProps) {
    if (awaiting && !sameGuard(props, awaiting)) awaiting = null;
    if (attemptedBasis !== keyFor(props)) { attemptedRequests.clear(); attemptedBasis = keyFor(props); }
    if (review && !canReviewCampaignRecovery(props, review.guard)) review = null;
  }
  function execute(props: CampaignGrowthPanelProps, request: CampaignGrowthRequest, guard: CampaignGrowthGuard): CampaignGrowthResult {
    observe(props);
    if (!ready(props, guard)) return { ok: false, code: 'STALE_OR_BLOCKED' };
    if (inFlight || awaiting) return { ok: false, code: 'AWAITING_PROJECTION' };
    const requestKey = request.kind === 'campaign.recover' ? JSON.stringify(request)
      : JSON.stringify(Object.entries(request).sort(([left], [right]) => left.localeCompare(right)));
    if (attemptedRequests.has(requestKey)) return { ok: false, code: 'DUPLICATE_REQUEST' };
    // Consume this intent before invoking user code. A rejected double-click still dispatches once.
    attemptedRequests.add(requestKey); inFlight = true;
    try {
      const result = props.onCommand({ ...request }, { ...guard });
      if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid command result');
      if (result.ok) awaiting = { ...guard };
      return result;
    } catch { awaiting = { ...guard }; return { ok: false, code: 'CALLBACK_FAILED' }; }
    finally { inFlight = false; }
  }
  return {
    observe,
    pending(props: CampaignGrowthPanelProps) { observe(props); return inFlight || !!awaiting; },
    submit(props: CampaignGrowthPanelProps, request: CampaignGrowthAction, guard: CampaignGrowthGuard): CampaignGrowthResult {
      observe(props);
      if (review || !canSubmitCampaignGrowth(props, request, guard)) return { ok: false, code: 'STALE_OR_BLOCKED' };
      return execute(props, request, guard);
    },
    reviewRecovery(props: CampaignGrowthPanelProps, guard: CampaignGrowthGuard): CampaignRecoveryReview | null {
      observe(props);
      if (inFlight || awaiting || attemptedRequests.has(JSON.stringify({ kind: 'campaign.recover', acknowledgeLoss: true })) || !canReviewCampaignRecovery(props, guard) || !props.recovery) return null;
      review = Object.freeze({ guard: Object.freeze({ ...guard }), consequences: copyRecovery(props.recovery) });
      return review;
    },
    isReviewCurrent(props: CampaignGrowthPanelProps, candidate: CampaignRecoveryReview) {
      observe(props); return review === candidate && canReviewCampaignRecovery(props, candidate.guard);
    },
    cancelRecovery(candidate: CampaignRecoveryReview) { if (review === candidate) review = null; },
    confirmRecovery(props: CampaignGrowthPanelProps, candidate: CampaignRecoveryReview): CampaignGrowthResult {
      observe(props);
      if (review !== candidate || !canReviewCampaignRecovery(props, candidate.guard)) return { ok: false, code: 'STALE_CONFIRMATION' };
      review = null;
      return execute(props, { kind: 'campaign.recover', acknowledgeLoss: true }, candidate.guard);
    },
  };
}

/** Epoch replacement clears selectors, review state and duplicate-click latches together. */
export function CampaignGrowthPanel(props: CampaignGrowthPanelProps) {
  return <CampaignGrowthEditor key={props.sessionEpoch} {...props} />;
}
function CampaignGrowthEditor(props: CampaignGrowthPanelProps) {
  const id = useId();
  const latest = useRef(props); latest.current = props;
  const mounted = useRef(false);
  const controller = useRef(createCampaignGrowthController());
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [review, setReview] = useState<CampaignRecoveryReview | null>(null);
  const [notice, setNotice] = useState<CampaignGrowthResult | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    controller.current.observe(props);
    if (!review && restoreFocus.current) {
      if (reviewButton.current && !reviewButton.current.disabled) reviewButton.current.focus(); else panel.current?.focus();
      restoreFocus.current = false;
    }
  });
  const { t } = props;
  const text = (suffix: string, parameters?: Readonly<Record<string, string | number>>) => t(`campaign.growth.${suffix}`, parameters);
  const guard = { sessionEpoch: props.sessionEpoch, basisStamp: props.basisStamp };
  const pending = controller.current.pending(props);
  const blocked = props.readOnly || !!props.busy || pending || !!review;
  const managementBlocked = blocked || !props.managementActionsAvailable;
  const staleReview = !!review && !controller.current.isReviewCurrent(props, review);
  function send(request: CampaignGrowthAction) {
    if (!mounted.current) return;
    const result = controller.current.submit(latest.current, request, guard); setNotice(result);
  }
  function cancel() {
    if (review) controller.current.cancelRecovery(review);
    restoreFocus.current = true; setReview(null);
  }
  function confirm() {
    if (!mounted.current || !review) return;
    const result = controller.current.confirmRecovery(latest.current, review);
    setNotice(result); restoreFocus.current = true; setReview(null);
  }
  const sections = [
    ['equipment', props.equipment.length], ['manuals', props.manuals.length], ['recruits', props.invitations.length], ['estate', props.estate.length],
  ] as const;
  return <section ref={panel} tabIndex={-1} className="campaign-growth" aria-labelledby={`${id}-title`} onKeyDown={event => {
    event.stopPropagation(); if (event.key === 'Escape' && review) { event.preventDefault(); cancel(); }
  }}>
    <header className="campaign-growth-header"><span className="campaign-growth-seal" aria-hidden="true">✦</span><div>
      <p className="campaign-growth-eyebrow">{text('eyebrow')}</p><h2 id={`${id}-title`}>{text('title')}</h2><p>{text('intro')}</p>
    </div></header>
    <nav className="campaign-growth-index" aria-label={text('sections')}>{sections.map(([section, count]) => <a key={section} href={`#${id}-${section}`}>
      {text(`${section}.title`)}<span aria-label={text('count', { count })}>{count}</span>
    </a>)}</nav>
    {(props.readOnly || props.busy || props.activeRun || !props.managementActionsAvailable || pending) && <p className="campaign-growth-notice" role="status">
      {text(props.readOnly ? 'readOnly' : props.busy ? 'busy' : props.activeRun ? 'activeRun' : !props.managementActionsAvailable ? 'managementUnavailable' : notice?.code === 'CALLBACK_FAILED' ? 'uncertain' : 'pending')}
    </p>}
    <p className="campaign-growth-feedback" role="status" aria-live="polite">{notice
      ? notice.message ? t(notice.message.key, notice.message.parameters) : text(notice.ok ? 'applied' : notice.code === 'CALLBACK_FAILED' ? 'uncertain' : 'rejected') : null}</p>
    <GrowthSection id={`${id}-equipment`} title={text('equipment.title')} description={text('equipment.help')} empty={text('equipment.empty')} count={props.equipment.length}>
      {props.equipment.map(view => <GrowthDiscipleCard key={view.routeId} title={t(view.nameKey)} description={t(view.descriptionKey)}
        options={view.eligibleDisciples} blocked={managementBlocked || !unblocked(view)} reason={view.blockedReason} t={t} action="equipment.action" select="equipment.select" empty="noDisciples"
        onChoose={discipleId => send({ kind: 'campaign.equipment.claim', routeId: view.routeId, discipleId })} />)}
    </GrowthSection>
    <GrowthSection id={`${id}-manuals`} title={text('manuals.title')} description={text('manuals.help')} empty={text('manuals.empty')} count={props.manuals.length}>
      {props.manuals.map(view => <GrowthDiscipleCard key={view.knowledgeId} title={t(view.nameKey)} description={t(view.descriptionKey)} options={view.eligibleStudents}
        blocked={managementBlocked || !unblocked(view) || !costsAffordable(view.costs)} reason={view.blockedReason} t={t} action="manuals.action" select="manuals.select" empty="noStudents"
        onChoose={discipleId => send({ kind: 'campaign.lesson.learn', knowledgeId: view.knowledgeId, discipleId })}>
        <GrowthCosts costs={view.costs} t={t} /><p className="campaign-growth-footnote">{view.learnedBy.length
          ? text('manuals.learnedBy', { names: view.learnedBy.map(disciple => disciple.name).join(text('separator')) }) : text('manuals.unlearned')}</p>
      </GrowthDiscipleCard>)}
    </GrowthSection>
    <GrowthSection id={`${id}-recruits`} title={text('recruits.title')} description={text('recruits.help')} empty={text('recruits.empty')} count={props.invitations.length}>
      {props.invitations.map(view => <GrowthRecruitCard key={view.routeId} title={text('recruits.invitation', { route: t(view.routeNameKey) })} schools={view.schools}
        costs={view.costs} blocked={managementBlocked || !unblocked(view)} reason={view.blockedReason} t={t} action="recruits.action"
        onChoose={school => send({ kind: 'campaign.recruit', routeId: view.routeId, school })} />)}
    </GrowthSection>
    {(props.relief || props.recovery || review) && <section className="campaign-growth-renewal" aria-labelledby={`${id}-renewal`}>
      <h3 id={`${id}-renewal`}>{text('renewal.title')}</h3>
      {props.relief && <GrowthRecruitCard title={text('relief.title')} schools={props.relief.schools} costs={props.relief.costs}
        blocked={blocked || props.activeRun || !unblocked(props.relief)} reason={props.relief.blockedReason} t={t} action="relief.action"
        onChoose={school => send({ kind: 'campaign.relief', school })}><GrowthLines lines={props.relief.conditions} t={t} /></GrowthRecruitCard>}
      {(props.recovery || review) && <article className="campaign-growth-recovery"><h4>{text('recovery.title')}</h4><p>{text('recovery.help')}</p>
        <GrowthReason reason={props.recovery?.blockedReason} t={t} />
        {!review && <button type="button" ref={reviewButton} className="campaign-growth-secondary" disabled={blocked || !canReviewCampaignRecovery(props, guard)} onClick={() => {
          if (!mounted.current) return;
          const prepared = controller.current.reviewRecovery(latest.current, guard); if (prepared) { setReview(prepared); setNotice(null); } else setNotice({ ok: false, code: 'STALE_OR_BLOCKED' });
        }}>{text('recovery.review')}</button>}
        {review && <CampaignRecoveryConfirmation review={review} stale={staleReview} blocked={props.readOnly || !!props.busy || props.activeRun || pending} t={t} onCancel={cancel} onConfirm={confirm} />}
      </article>}
    </section>}
    <GrowthSection id={`${id}-estate`} title={text('estate.title')} description={text('estate.help')} empty={text('estate.empty')} count={props.estate.length}>
      {props.estate.map(view => <GrowthDiscipleCard key={view.itemInstanceId} title={t(view.nameKey)} description={t(view.descriptionKey)}
        options={view.eligibleDisciples} blocked={managementBlocked || !unblocked(view)} reason={view.blockedReason} t={t} action="estate.action" select="estate.select" empty="noDisciples"
        onChoose={discipleId => send({ kind: 'estate.assign', itemInstanceId: view.itemInstanceId, discipleId })}><GrowthLines lines={view.provenance} t={t} /></GrowthDiscipleCard>)}
    </GrowthSection>
  </section>;
}
function GrowthSection({ id, title, description, empty, count, children }: { id: string; title: string; description: string; empty: string; count: number; children: ReactNode }) {
  return <section className="campaign-growth-section" id={id} aria-labelledby={`${id}-heading`}><div className="campaign-growth-section-heading"><h3 id={`${id}-heading`}>{title}</h3><p>{description}</p></div>
    {count ? <div className="campaign-growth-cards">{children}</div> : <p className="campaign-growth-empty">{empty}</p>}</section>;
}
function GrowthReason({ reason, t }: { reason: CampaignGrowthText | undefined; t: CampaignGrowthTranslator }) {
  return reason ? <p className="campaign-growth-blocker">{t(reason.key, reason.parameters)}</p> : null;
}
function GrowthLines({ lines, t }: { lines: readonly CampaignGrowthText[]; t: CampaignGrowthTranslator }) {
  return lines.length ? <ul className="campaign-growth-lines">{lines.map((line, index) => <li key={`${line.key}:${index}`}>{t(line.key, line.parameters)}</li>)}</ul> : null;
}
function GrowthCosts({ costs, t }: { costs: readonly CampaignGrowthCost[]; t: CampaignGrowthTranslator }) {
  return <div className="campaign-growth-costs"><strong>{t('campaign.growth.costs')}</strong>{costs.length ? <ul>{costs.map(cost => <li key={cost.resourceId} data-affordable={cost.available >= cost.quantity}>
    {t('campaign.growth.costLine', { name: t(cost.nameKey), quantity: cost.quantity, available: cost.available })}
  </li>)}</ul> : <span>{t('campaign.growth.noCost')}</span>}
    {!costsAffordable(costs) && <p className="campaign-growth-blocker">{t('campaign.growth.insufficientResources')}</p>}</div>;
}
function GrowthDiscipleCard({ title, description, options, blocked, reason, t, action, select, empty, onChoose, children }: {
  title: string; description: string; options: readonly CampaignGrowthDisciple[]; blocked: boolean; reason: CampaignGrowthText | undefined; t: CampaignGrowthTranslator;
  action: string; select: string; empty: string; onChoose: (discipleId: string) => void; children?: ReactNode;
}) {
  const id = useId(); const [chosen, setChosen] = useState(''); const value = options.some(option => option.discipleId === chosen) ? chosen : '';
  return <article className="campaign-growth-card" aria-labelledby={`${id}-title`}><h4 id={`${id}-title`}>{title}</h4><p>{description}</p>{children}
    <GrowthReason reason={reason} t={t} />
    {options.length ? <div className="campaign-growth-fields"><label htmlFor={`${id}-disciple`}>{t(`campaign.growth.${select}`)}</label>
      <select id={`${id}-disciple`} value={value} disabled={blocked} onChange={event => setChosen(event.target.value)} aria-describedby={`${id}-title`}>
        <option value="">{t('campaign.growth.chooseDisciple')}</option>{options.map(option => <option key={option.discipleId} value={option.discipleId}>{option.name}</option>)}
      </select><button type="button" disabled={blocked || !value} onClick={() => { if (!blocked && value) onChoose(value); }} aria-label={t('campaign.growth.actionFor', { action: t(`campaign.growth.${action}`), name: title })}>{t(`campaign.growth.${action}`)}</button>
    </div> : <p className="campaign-growth-empty">{t(`campaign.growth.${empty}`)}</p>}
  </article>;
}
function GrowthRecruitCard({ title, schools, costs, blocked, reason, t, action, onChoose, children }: {
  title: string; schools: readonly CampaignRecruitSchoolView[]; costs: readonly CampaignGrowthCost[]; blocked: boolean; reason: CampaignGrowthText | undefined;
  t: CampaignGrowthTranslator; action: string; onChoose: (school: School) => void; children?: ReactNode;
}) {
  const id = useId(); const [chosen, setChosen] = useState(''); const selected = schools.find(option => option.school === chosen);
  const disabled = blocked || !costsAffordable(costs);
  return <article className="campaign-growth-card" aria-labelledby={`${id}-title`}><h4 id={`${id}-title`}>{title}</h4>{children}<GrowthCosts costs={costs} t={t} /><GrowthReason reason={reason} t={t} />
    {schools.length ? <><div className="campaign-growth-fields"><label htmlFor={`${id}-school`}>{t('campaign.growth.recruits.school')}</label>
      <select id={`${id}-school`} value={selected?.school ?? ''} disabled={disabled} onChange={event => setChosen(event.target.value)} aria-describedby={`${id}-title`}>
        <option value="">{t('campaign.growth.chooseSchool')}</option>{schools.map(option => <option key={option.school} value={option.school}>{t(option.schoolNameKey)}</option>)}
      </select><button type="button" disabled={disabled || !selected} onClick={() => { if (!disabled && selected) onChoose(selected.school); }} aria-label={t('campaign.growth.actionFor', { action: t(`campaign.growth.${action}`), name: title })}>{t(`campaign.growth.${action}`)}</button></div>
      {selected && <p className="campaign-growth-profile">{t('campaign.growth.recruits.profile', { name: t(selected.nameKey), ageYears: Math.floor(selected.ageMonths / 12), ageMonths: selected.ageMonths % 12, lifespanYears: Math.floor(selected.lifespanMonths / 12), lifespanMonths: selected.lifespanMonths % 12, aptitude: selected.aptitude })}</p>}
    </> : <p className="campaign-growth-empty">{t('campaign.growth.noSchools')}</p>}
  </article>;
}
export function CampaignRecoveryConfirmation({ review, stale, blocked, t, onCancel, onConfirm }: {
  readonly review: CampaignRecoveryReview; readonly stale: boolean; readonly blocked: boolean; readonly t: CampaignGrowthTranslator;
  readonly onCancel: () => void; readonly onConfirm: () => void;
}) {
  const id = useId(); const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { cancel.current?.focus(); }, [stale]);
  return <section className="campaign-growth-confirmation" role="group" aria-labelledby={`${id}-title`} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }}><h4 id={`${id}-title`}>{t('campaign.growth.recovery.confirmTitle')}</h4><p>{t('campaign.growth.recovery.confirmHelp')}</p>
    {(['losses', 'retained', 'grants'] as const).map(section => <div key={section}><h5>{t(`campaign.growth.recovery.${section}`)}</h5><GrowthLines lines={review.consequences[section]} t={t} /></div>)}
    {stale && <p className="campaign-growth-blocker" role="alert">{t('campaign.growth.recovery.stale')}</p>}
    <div className="campaign-growth-actions"><button type="button" className="campaign-growth-confirm" disabled={blocked || stale} onClick={() => { if (!blocked && !stale) onConfirm(); }}>{t('campaign.growth.recovery.confirm')}</button>
      <button type="button" className="campaign-growth-secondary" ref={cancel} onClick={onCancel}>{t('campaign.growth.recovery.cancel')}</button></div>
  </section>;
}
