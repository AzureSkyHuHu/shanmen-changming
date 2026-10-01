import { useEffect, useId, useRef, useState } from 'react';
import type { DeepReadonly } from '../application/session';
import { matchesWorkPlanGuard, workPlanSignature, type WorkPlanEditGuard } from '../application/work-plan-contract';
import { getRecipe, STARTER_RECIPES } from '../core/economy/recipes';
import type { RecipeDefinition, ResourceId, ResourceLine } from '../core/economy/types';
import { TICKS_PER_SECOND } from '../core/kernel/clock';
import { isSectEconomyCommand } from '../core/sect-economy/state';
import {
  MAX_STOCK_TARGET, MAX_WORK_PRIORITIES,
  type AutomaticWorkStatus, type SectEconomyCommand,
  type SectEconomyState, type WorkPlanBlocker,
} from '../core/sect-economy/types';
import type { TextKey, TranslationParams } from '../i18n';
import './work-plans.css';

type Translator = (key: TextKey, parameters?: TranslationParams) => string;
export interface WorkPlanWorker {
  readonly workerId: string;
  readonly nameKey: string;
  readonly lifeState: 'alive' | 'pendingDeath' | 'dead';
  readonly ageMonths: number;
  readonly away: boolean;
  readonly available: boolean;
}
export interface WorkPlanResource {
  readonly resourceId: ResourceId;
  readonly owned: number;
  readonly reserved: number;
  readonly available: number;
  readonly capacity: number;
  /** Promised outputs of all live manual and automatic jobs, never credited stock. */
  readonly incoming: number;
}
export interface WorkPlanCommandResult { readonly ok: boolean; readonly code?: string }
export interface WorkPlansPanelProps {
  readonly sessionEpoch: number;
  readonly worker: WorkPlanWorker | null;
  readonly state: DeepReadonly<SectEconomyState>;
  readonly resources: readonly WorkPlanResource[];
  readonly status: AutomaticWorkStatus;
  readonly blockers: readonly DeepReadonly<WorkPlanBlocker>[];
  /** Protocol availability, not transient material/worker/storage availability. */
  readonly executionReady: boolean;
  readonly activationReviewRequired?: boolean;
  readonly readOnly: boolean;
  readonly busy?: boolean;
  readonly t: Translator;
  /** Session must recheck the guard against fresh authority immediately before dispatch. */
  readonly onCommand: (command: SectEconomyCommand, guard: WorkPlanEditGuard) => WorkPlanCommandResult;
}
export interface WorkPlanDraft {
  readonly guard: WorkPlanEditGuard;
  readonly enabled: boolean;
  /** Raw inputs keep invalid/empty edits visible instead of silently clamping them. */
  readonly priorities: readonly { readonly recipeId: string; readonly targetStock: string }[];
}
type PlanCommand = Extract<SectEconomyCommand, { kind: 'plan.set' }>;
type GlobalCommand = Extract<SectEconomyCommand, { kind: 'enabled.set' }>;
interface SubmittedChange { readonly command: SectEconomyCommand; readonly guard: WorkPlanEditGuard }

/** Same supported subset as the domain validator; definitions always come from the registry. */
export function workPlanRecipes(): readonly RecipeDefinition[] {
  return Object.values(STARTER_RECIPES).filter(recipe => recipe.outputs.length === 1
    && recipe.outputs[0]!.quantity > (recipe.inputs.find(line => line.resourceId === recipe.outputs[0]!.resourceId)?.quantity ?? 0));
}
export function createWorkPlanDraft(props: Pick<WorkPlansPanelProps, 'sessionEpoch' | 'worker' | 'state'>): WorkPlanDraft | null {
  if (!props.worker) return null;
  const plan = props.state.plans.find(plan => plan.workerId === props.worker!.workerId);
  return {
    guard: { sessionEpoch: props.sessionEpoch, workerId: props.worker.workerId, expectedPlan: workPlanSignature(plan), expectedEnabled: props.state.enabled },
    enabled: plan?.enabled ?? false,
    priorities: (plan?.priorities ?? []).map(priority => ({ recipeId: priority.recipeId, targetStock: String(priority.targetStock) })),
  };
}
export function workPlanDraftCommand(draft: WorkPlanDraft): PlanCommand | null {
  if (!draft.guard.workerId || draft.priorities.some(priority => !/^\d{1,3}$/.test(priority.targetStock))) return null;
  const command: PlanCommand = { kind: 'plan.set', plan: {
    workerId: draft.guard.workerId, enabled: draft.enabled,
    priorities: draft.priorities.map(priority => ({ recipeId: priority.recipeId, targetStock: Number(priority.targetStock) })),
  } };
  return isSectEconomyCommand(command) ? command : null;
}
/** Reordering keeps recipe identities and targets together and never edits the saved plan. */
export function moveWorkPlanPriority(draft: WorkPlanDraft, index: number, direction: -1 | 1): WorkPlanDraft {
  const destination = index + direction;
  if (!Number.isInteger(index) || index < 0 || index >= draft.priorities.length || destination < 0 || destination >= draft.priorities.length) return draft;
  const priorities = [...draft.priorities];
  [priorities[index], priorities[destination]] = [priorities[destination]!, priorities[index]!];
  return { ...draft, priorities };
}
export function addWorkPlanPriority(draft: WorkPlanDraft, recipeId: string): WorkPlanDraft {
  if (draft.priorities.length >= MAX_WORK_PRIORITIES || draft.priorities.some(priority => priority.recipeId === recipeId)
    || !workPlanRecipes().some(recipe => recipe.recipeId === recipeId)) return draft;
  // Adding a row never silently enables it; the player chooses an explicit stock target.
  return { ...draft, priorities: [...draft.priorities, { recipeId, targetStock: '0' }] };
}
export function workPlanWorkerNotice(worker: WorkPlanWorker): TextKey | null {
  if (worker.lifeState !== 'alive') return `workPlans.worker.${worker.lifeState}` as TextKey;
  if (worker.ageMonths < 16 * 12) return 'workPlans.worker.young' as TextKey;
  if (worker.away) return 'workPlans.worker.away' as TextKey;
  return worker.available ? null : 'workPlans.worker.unavailable' as TextKey;
}

/** Pure UI guard. The application repeats freshness checks against its live World. */
export function dispatchWorkPlanCommand(
  props: WorkPlansPanelProps, command: SectEconomyCommand, guard: WorkPlanEditGuard, activationReviewed = false,
): WorkPlanCommandResult {
  if (!isSectEconomyCommand(command)) return { ok: false, code: 'INVALID_COMMAND' };
  if (props.readOnly || props.busy) return { ok: false, code: 'READ_ONLY_OR_BUSY' };
  if (!matchesWorkPlanGuard(props.state, props.sessionEpoch, command, guard)) return { ok: false, code: 'STALE_PLAN' };
  if (command.kind === 'enabled.set') {
    if (command.enabled === props.state.enabled) return { ok: false, code: 'UNCHANGED' };
    if (command.enabled && !props.executionReady) return { ok: false, code: 'EXECUTION_GATED' };
    if (command.enabled && props.activationReviewRequired && !activationReviewed) return { ok: false, code: 'REVIEW_REQUIRED' };
  } else {
    if (!props.worker || props.worker.workerId !== command.plan.workerId) return { ok: false, code: 'UNKNOWN_WORKER' };
    const saved = props.state.plans.find(plan => plan.workerId === command.plan.workerId);
    if (command.plan.enabled && !saved?.enabled && (!props.executionReady || props.worker.lifeState !== 'alive')) {
      return { ok: false, code: props.worker.lifeState !== 'alive' ? 'WORKER_UNAVAILABLE' : 'EXECUTION_GATED' };
    }
    if (workPlanSignature(command.plan) === workPlanSignature(saved)) return { ok: false, code: 'UNCHANGED' };
  }
  // Own the callback payload: consumers cannot mutate the input draft or saved projection.
  const ownedCommand: SectEconomyCommand = command.kind === 'enabled.set' ? { ...command }
    : { kind: 'plan.set', plan: { ...command.plan, priorities: command.plan.priorities.map(priority => ({ ...priority })) } };
  return props.onCommand(ownedCommand, { ...guard });
}
function lineText(lines: readonly ResourceLine[], t: Translator): string {
  return lines.length ? lines.map(line => t('production.line', { amount: line.quantity, name: t(`resource.${line.resourceId}`) })).join(' · ') : t('production.noInput');
}
function blockerText(blocker: DeepReadonly<WorkPlanBlocker>, t: Translator): string {
  let reason = t(`workPlans.blocker.${blocker.reason}` as TextKey);
  if (blocker.resourceId) reason = t('workPlans.resourceDetail' as TextKey, { reason, resource: t(`resource.${blocker.resourceId}`) });
  const recipe = blocker.recipeId ? getRecipe(blocker.recipeId) : undefined;
  return recipe ? t('workPlans.recipeDetail' as TextKey, { recipe: t(recipe.nameKey as TextKey), reason }) : reason;
}
function submissionWaiting(props: WorkPlansPanelProps, submission: SubmittedChange | null): boolean {
  return !!submission && matchesWorkPlanGuard(props.state, props.sessionEpoch, submission.command, submission.guard);
}

/** The key prevents stale local drafts, notices or acknowledgements crossing campaign/selection replacement. */
export function WorkPlansPanel(props: WorkPlansPanelProps) {
  return <WorkPlansEditor key={JSON.stringify([props.sessionEpoch, props.worker?.workerId ?? null])} {...props} />;
}
function WorkPlansEditor(props: WorkPlansPanelProps) {
  const { worker, state, t, readOnly, busy = false } = props;
  const id = useId();
  const [draft, setDraft] = useState<WorkPlanDraft | null>(null);
  const [addRecipeId, setAddRecipeId] = useState('');
  const [activationReviewed, setActivationReviewed] = useState(false);
  const [notice, setNotice] = useState<'applied' | 'rejected' | null>(null);
  const [submission, setSubmission] = useState<SubmittedChange | null>(null);
  const submitting = useRef<SubmittedChange | null>(null);
  const current = draft ?? createWorkPlanDraft(props);
  const saved = worker ? state.plans.find(plan => plan.workerId === worker.workerId) : undefined;
  const draftCommand = current ? workPlanDraftCommand(current) : null;
  // Even an invalid draft retains a valid identity-only command for freshness checking.
  const identityCommand: PlanCommand | null = current?.guard.workerId ? { kind: 'plan.set', plan: { workerId: current.guard.workerId, enabled: false, priorities: [] } } : null;
  const stale = !!draft && !!identityCommand && !matchesWorkPlanGuard(state, props.sessionEpoch, identityCommand, draft.guard);
  const pending = submissionWaiting(props, submission);
  useEffect(() => {
    // Forget an acknowledged old basis permanently: returning to the same settings
    // later must not resurrect the pending lock from an earlier command.
    if (submission && !pending) { setSubmission(null); submitting.current = null; }
  }, [submission, pending]);
  const blocked = readOnly || busy || pending;
  const editingBlocked = blocked || stale;
  const changed = !!draft && (!draftCommand || workPlanSignature(draftCommand.plan) !== workPlanSignature(saved));
  const recipes = workPlanRecipes();
  const remaining = recipes.filter(recipe => !current?.priorities.some(priority => priority.recipeId === recipe.recipeId));
  const selectedRecipe = remaining.some(recipe => recipe.recipeId === addRecipeId) ? addRecipeId : remaining[0]?.recipeId ?? '';
  const workerNotice = worker ? workPlanWorkerNotice(worker) : null;
  const planActivationBlocked = !saved?.enabled && (!props.executionReady || worker?.lifeState !== 'alive');
  const globalEnableBlocked = !state.enabled && (!props.executionReady || !!props.activationReviewRequired && !activationReviewed);
  const selectedBlockers = props.blockers.filter(blocker => blocker.workerId === worker?.workerId);
  const text = (suffix: string, parameters?: TranslationParams) => t(`workPlans.${suffix}` as TextKey, parameters);
  function edit(next: WorkPlanDraft) { if (!editingBlocked) { setDraft(next); setNotice(null); } }
  function discard() { setDraft(null); setNotice(null); setAddRecipeId(''); }
  function submit(command: SectEconomyCommand, guard: WorkPlanEditGuard) {
    if (blocked || submissionWaiting(props, submitting.current)) return;
    const attempt = { command, guard };
    submitting.current = attempt;
    let result: WorkPlanCommandResult;
    try { result = dispatchWorkPlanCommand(props, command, guard, activationReviewed); }
    catch { result = { ok: false, code: 'CALLBACK_FAILED' }; }
    if (result.ok) {
      setSubmission(attempt);
      if (command.kind === 'plan.set') setDraft(null);
      setNotice('applied');
    } else {
      submitting.current = null;
      setNotice('rejected');
    }
  }
  function globalSwitch() {
    const command: GlobalCommand = { kind: 'enabled.set', enabled: !state.enabled };
    submit(command, { sessionEpoch: props.sessionEpoch, workerId: null, expectedPlan: null, expectedEnabled: state.enabled });
  }
  return <section className="work-plans-panel" aria-labelledby={`${id}-title`}>
    <header className="work-plans-header"><span className="section-eyebrow">{text('subtitle')}</span><h3 id={`${id}-title`}>{text('title')}</h3></header>
    <section className="work-plans-global" aria-label={text('global')}>
      <div className="work-plans-global-heading"><strong>{text('global')}</strong><button type="button" className="secondary work-plans-global-toggle" aria-pressed={state.enabled} disabled={blocked || globalEnableBlocked} onClick={globalSwitch}>{text(state.enabled ? 'disable' : 'enable')}</button></div>
      <p className="work-plans-help">{text('globalHint')}</p>
      {!props.executionReady ? <p className="work-plans-notice">{text('gated')}</p> : <p className="work-plans-status" role="status">{text(`status.${props.status}`)}</p>}
      {props.activationReviewRequired && !state.enabled && <div className="work-plans-review"><p>{text('review')}</p><label className="work-plans-check"><input type="checkbox" checked={activationReviewed} disabled={blocked} onChange={event => setActivationReviewed(event.target.checked)} />{text('reviewAck')}</label></div>}
    </section>
    {(readOnly || busy || pending) && <p className="work-plans-notice" role="status">{text(readOnly ? 'readOnly' : busy ? 'busy' : 'pending')}</p>}
    {!worker || !current ? <p className="work-plans-help">{text('selectDisciple')}</p> : <>
      <h4 className="work-plans-disciple">{text('planFor', { name: t(worker.nameKey as TextKey) })}</h4>
      {workerNotice && <p className="work-plans-notice">{t(workerNotice)}</p>}
      {selectedBlockers.length > 0 && <ul className="work-plans-blockers">{selectedBlockers.map((blocker, index) => <li key={`${blocker.reason}:${blocker.recipeId ?? ''}:${index}`}>{blockerText(blocker, t)}</li>)}</ul>}
      {stale && <div className="work-plans-notice work-plans-stale" role="alert"><p>{text('stale')}</p><button type="button" className="secondary" onClick={discard}>{text('reload')}</button></div>}
      <fieldset className="work-plans-fields" disabled={editingBlocked}>
        <legend className="sr-only">{text('planFor', { name: t(worker.nameKey as TextKey) })}</legend>
        <label className="work-plans-check"><input type="checkbox" className="work-plans-plan-toggle" checked={current.enabled} disabled={editingBlocked || planActivationBlocked && !current.enabled} onChange={event => edit({ ...current, enabled: event.target.checked })} />{text('planEnabled')}</label>
        <p id={`${id}-target-help`} className="work-plans-help">{text('targetHint')}</p>
        <p className="work-plans-help">{text('orderHint')}</p>
        {current.priorities.length === 0 && <p className="work-plans-empty">{text('empty')}</p>}
        <ol className="work-plans-priorities">{current.priorities.map((priority, index) => {
          const recipe = getRecipe(priority.recipeId);
          // Validated projections and add helpers use only registered recipes; fail closed otherwise.
          if (!recipe) return null;
          const name = t(recipe.nameKey as TextKey);
          const inputId = `${id}-target-${recipe.recipeId}`;
          const invalid = !/^\d{1,3}$/.test(priority.targetStock) || Number(priority.targetStock) > MAX_STOCK_TARGET;
          const resources = [...new Set([...recipe.inputs, ...recipe.outputs].map(line => line.resourceId))];
          return <li className="work-plans-priority" key={recipe.recipeId}>
            <div className="work-plans-priority-heading"><span>{text('priority', { number: index + 1 })}</span><h5>{name}</h5></div>
            <p className="work-plans-recipe-flow">{t('production.recipeFlow', { inputs: lineText(recipe.inputs, t), outputs: lineText(recipe.outputs, t) })}</p>
            <p className="work-plans-recipe-meta">{text('station', { name: text(`station.${recipe.workstation}`) })} · {t('production.duration', { seconds: recipe.workTicks / TICKS_PER_SECOND })}</p>
            <label className="work-plans-target" htmlFor={inputId}><span>{text('target', { name })}</span><input id={inputId} type="number" min={0} max={MAX_STOCK_TARGET} step={1} inputMode="numeric" value={priority.targetStock} disabled={editingBlocked} aria-invalid={invalid} aria-describedby={`${id}-target-help${invalid ? ` ${id}-invalid` : ''}`} onChange={event => edit({ ...current, priorities: current.priorities.map((row, rowIndex) => rowIndex === index ? { ...row, targetStock: event.target.value } : row) })} /></label>
            <ul className="work-plans-stock">{resources.map(resourceId => {
              const stock = props.resources.find(resource => resource.resourceId === resourceId);
              return <li key={resourceId}>{stock ? text('stock', { name: t(`resource.${resourceId}`), owned: stock.owned, capacity: stock.capacity, available: stock.available, reserved: stock.reserved, incoming: stock.incoming }) : text('stockMissing')}</li>;
            })}</ul>
            <div className="work-plans-row-actions"><button type="button" className="secondary" aria-label={text('moveUp', { name })} disabled={editingBlocked || index === 0} onClick={() => edit(moveWorkPlanPriority(current, index, -1))}>{text('up')}</button><button type="button" className="secondary" aria-label={text('moveDown', { name })} disabled={editingBlocked || index === current.priorities.length - 1} onClick={() => edit(moveWorkPlanPriority(current, index, 1))}>{text('down')}</button><button type="button" className="secondary" aria-label={text('remove', { name })} disabled={editingBlocked} onClick={() => edit({ ...current, priorities: current.priorities.filter((_, rowIndex) => rowIndex !== index) })}>{text('removeShort')}</button></div>
          </li>;
        })}</ol>
        <div className="work-plans-add"><label htmlFor={`${id}-add`}>{text('addRecipe')}</label><select id={`${id}-add`} value={selectedRecipe} disabled={editingBlocked || !remaining.length || current.priorities.length >= MAX_WORK_PRIORITIES} onChange={event => setAddRecipeId(event.target.value)}>{remaining.map(recipe => <option key={recipe.recipeId} value={recipe.recipeId}>{t(recipe.nameKey as TextKey)}</option>)}</select><button type="button" className="secondary" disabled={editingBlocked || !selectedRecipe || current.priorities.length >= MAX_WORK_PRIORITIES} onClick={() => edit(addWorkPlanPriority(current, selectedRecipe))}>{text('add')}</button></div>
        <p className="work-plans-help">{text('limit', { count: MAX_WORK_PRIORITIES })}</p>
      </fieldset>
      {!draftCommand && <p id={`${id}-invalid`} className="work-plans-notice" role="alert">{text('invalid')}</p>}
      {changed && !stale && <p className="work-plans-draft">{text('draft')}</p>}
      <div className="work-plans-actions"><button type="button" className="work-plans-save" disabled={editingBlocked || !changed || !draftCommand} onClick={() => { if (draftCommand) submit(draftCommand, current.guard); }}>{text('save')}</button><button type="button" className="secondary" disabled={!draft} onClick={discard}>{text('cancel')}</button></div>
      <p className="work-plans-help">{text('snapshotHint')}</p>
    </>}
    <details className="work-plans-rules" open><summary>{t('production.current')}</summary><p>{text('lifecycle')}</p></details>
    <p className="work-plans-feedback" role="status" aria-live="polite">{notice ? text(notice) : null}</p>
  </section>;
}
