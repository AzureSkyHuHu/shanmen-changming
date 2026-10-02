import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { combatContentTranslator } from '../application/combat-content-text';
import { attachManagementReviewEscapeV9, managementContentTextV9, managementResultV9,
  type ManagementSnapshotV9, type ManagementTextV9 } from '../application/management-v9-contract';
import { createManagementBuildControllerV9, MANAGEMENT_BUILD_SLOTS_V9, managementBuildBlockedV9, managementBuildContentV9,
  managementBuildEquipmentV9, managementBuildIntentGuardV9, managementBuildLearnErrorV9, managementBuildRequestErrorV9,
  managementBuildSkillRequirementsV9, managementBuildSupportedV9, managementBuildToggleNodeV9,
  type ManagementBuildReviewV9, type ManagementBuildSessionV9 } from '../application/management-v9-build-contract';
import type { BuildRequestV9 } from '../application/session-v9';
import type { BuildLoadout, EquipmentDefinition } from '../core/builds/types';
import type { BuildContentContext } from '../core/builds/v2-types';
import { COMBAT_TICKS_PER_SECOND, type SkillDefinition, type TreeNodeDefinition } from '../core/combat/definitions';
import type { RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import { translate, type Locale, type TextKey, type TranslationParams } from '../i18n';

export interface ManagementBuildPanelV9Props {
  session: ManagementBuildSessionV9;
  snapshot: ManagementSnapshotV9;
  locale: Locale;
  readOnly: boolean;
  getReadOnly: () => boolean;
  onFeedback: (notice: ManagementTextV9) => void;
}
type BuildDraftV9 = { basis: ManagementSnapshotV9; request: Exclude<BuildRequestV9, { kind: 'skill.learn' }> };
const trainingNames: Readonly<Record<string, TextKey>> = {
  'equipment.training-sword': 'buildView.item.training-sword', 'equipment.training-body': 'buildView.item.training-body',
  'equipment.training-alchemy': 'buildView.item.training-alchemy', 'equipment.training-talisman': 'buildView.item.training-talisman',
  'equipment.training-robe': 'buildView.item.training-robe', 'equipment.training-artifact': 'buildView.item.training-artifact',
};
/** Resolve against v9's actual owned context; the legacy BuildPanel registry does
 * not register this internal management identity. */
export function managementBuildNameV9(context: BuildContentContext, locale: Locale, id: string): string {
  const definition = [...context.catalog.skills, ...context.catalog.treeNodes, ...context.catalog.trees].find(row => row.id === id);
  if (definition) return combatContentTranslator(context.catalog)(locale, definition.nameKey);
  const item: (EquipmentDefinition & { nameKey?: string }) | undefined = context.rules.equipment.find(row => row.id === id);
  const key = item?.nameKey ?? trainingNames[id];
  if (key) return managementContentTextV9(key, (textKey, parameters) => translate(locale, textKey, parameters));
  const school = context.rules.schools.find(value => id === `basic.${value}`);
  return school ? translate(locale, 'buildView.basicSchool', { school: translate(locale, `buildView.school.${school}`) }) : translate(locale, 'buildView.itemUnknown');
}
function equipmentDescription(context: BuildContentContext, locale: Locale, id: string): string {
  const item: (EquipmentDefinition & { descriptionKey?: string }) | undefined = context.rules.equipment.find(row => row.id === id);
  if (!item) return translate(locale, 'buildView.itemUnknown');
  if (item.descriptionKey) return managementContentTextV9(item.descriptionKey, (key, parameters) => translate(locale, key, parameters));
  const lines = Object.entries(item.flatStats).map(([stat, amount]) => translate(locale, 'buildView.itemBonus', {
    stat: translate(locale, `buildView.stat.${stat}` as TextKey), amount,
  }));
  if (item.maximumSpiritBonus) lines.push(translate(locale, 'buildView.itemBonus', { stat: translate(locale, 'buildView.stat.maximumSpirit'), amount: item.maximumSpiritBonus }));
  return lines.join(' · ');
}
function definitionDescription(context: BuildContentContext, locale: Locale, definition: SkillDefinition | TreeNodeDefinition): string {
  return definition.kind === 'skill' && definition.activation === 'active'
    ? translate(locale, `buildView.skillSummary.${definition.id.slice('skill.'.length)}` as TextKey)
    : combatContentTranslator(context.catalog)(locale, definition.descriptionKey, definition.descriptionParameters);
}

/** One focus move for one newly mounted review. The callbacks recheck live UI
 * ownership; this scope never takes focus back from another interaction. */
export function focusManagementBuildReviewV9({ region, opener, document: documentPort, canEnter, canRestore }: {
  region: HTMLElement; opener: HTMLElement | null; document: Pick<Document, 'activeElement' | 'body'>;
  canEnter: () => boolean; canRestore: () => boolean;
}): () => void {
  const active = documentPort.activeElement;
  if (!region.isConnected || !canEnter() || (active !== opener && active !== documentPort.body && !region.contains(active))) return () => {};
  const target = region.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? region;
  if (!target.isConnected || target.matches(':disabled, [aria-disabled="true"]')) return () => {};
  target.focus(); // Native focus scrolls the actual control into view, using its sticky-toolbar scroll margin.
  let released = false;
  return () => {
    if (released) return; released = true;
    if (!canRestore() || !opener?.isConnected || opener.matches(':disabled, [aria-disabled="true"]')) return;
    const current = documentPort.activeElement;
    if (region.contains(current) || current === documentPort.body) opener.focus();
  };
}

export function ManagementBuildPanelV9(props: ManagementBuildPanelV9Props) {
  return <ManagementBuildEditorV9 key={`${props.snapshot.sessionEpoch}/${props.snapshot.selection?.kind}/${props.snapshot.selection?.id}`} {...props} />;
}
function ManagementBuildEditorV9(props: ManagementBuildPanelV9Props) {
  const { session, snapshot, locale, readOnly } = props;
  const prefix = useId(); const mounted = useRef(false);
  const latest = useRef(props); latest.current = props;
  const controller = useMemo(() => createManagementBuildControllerV9(session, () => latest.current.readOnly || latest.current.getReadOnly()), [session]);
  const liveController = useRef(controller); liveController.current = controller;
  const [draft, setDraft] = useState<BuildDraftV9 | null>(null);
  const [review, setReview] = useState<ManagementBuildReviewV9 | null>(null);
  const reviewRef = useRef<ManagementBuildReviewV9 | null>(null);
  const reviewRegion = useRef<HTMLDivElement | null>(null);
  const reviewFocus = useRef<{ review: ManagementBuildReviewV9; opener: HTMLButtonElement } | null>(null);
  const [notice, setNotice] = useState<ManagementTextV9 | null>(null);
  useLayoutEffect(() => {
    mounted.current = true; reviewRef.current = null; setDraft(null); setReview(null); setNotice(null);
    return () => { mounted.current = false; controller.cancel(); reviewRef.current = null; };
  }, [controller]);
  const cancel = () => { controller.cancel(); reviewRef.current = null; setReview(null); setDraft(null); setNotice(null); };
  useEffect(() => {
    if (!draft && !review) return;
    return attachManagementReviewEscapeV9(document, () => {
      const current = session.getSnapshot(); return current.holds.storageBusy || current.holds.overlay || current.holds.review;
    }, () => { controller.cancel(); reviewRef.current = null; setReview(null); setDraft(null); setNotice(null); });
  }, [draft, review, session, controller]);
  useEffect(() => {
    const focus = reviewFocus.current; const region = reviewRegion.current;
    if (!review || !focus || focus.review !== review || !region) return;
    const sameOwner = () => mounted.current && liveController.current === controller && latest.current.session === session;
    const release = focusManagementBuildReviewV9({ region, opener: focus.opener, document,
      canEnter: () => sameOwner() && reviewRef.current === review
        && !managementBuildIntentGuardV9(review.basis, session.getSnapshot(), latest.current.readOnly || latest.current.getReadOnly()),
      canRestore: () => {
        if (!sameOwner() || reviewRef.current !== null) return false;
        const current = session.getSnapshot();
        // A successful command changes revisions. Restore only UI ownership,
        // never the old request; disabled/removed/stale openers are still skipped.
        return current.sessionEpoch === review.basis.sessionEpoch && current.selection?.kind === review.basis.selection?.kind
          && current.selection?.id === review.basis.selection?.id && current.frame.clock.pauseReasons.includes('player')
          && !managementBuildBlockedV9(current, latest.current.readOnly || latest.current.getReadOnly());
      },
    });
    return () => { release(); if (reviewFocus.current === focus) reviewFocus.current = null; };
  }, [review, session, controller]);
  const t = (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);
  const b = (suffix: string, parameters?: TranslationParams) => t(`buildView.${suffix}` as TextKey, parameters);
  const v = (suffix: string, parameters?: TranslationParams) => t(`managementV9.build${suffix}` as TextKey, parameters);
  const report = (feedback: ManagementTextV9) => { setNotice(feedback); latest.current.onFeedback(feedback); };
  const content = managementBuildContentV9(snapshot); const selected = snapshot.build.selected;
  const blocker = managementBuildBlockedV9(snapshot, readOnly);
  const playerPaused = snapshot.frame.clock.pauseReasons.includes('player');
  const stale = !!draft && !!managementBuildIntentGuardV9(draft.basis, snapshot, readOnly);
  const reviewStale = !!review && !!managementBuildIntentGuardV9(review.basis, snapshot, readOnly);
  const disabled = !!blocker || !playerPaused || stale || !!review;
  const eventGuard = (basis: ManagementSnapshotV9 = draft?.basis ?? snapshot) => {
    if (!mounted.current || liveController.current !== controller || latest.current.session !== session) return false;
    const current = session.getSnapshot(); const reason = managementBuildIntentGuardV9(basis, current, latest.current.readOnly || latest.current.getReadOnly());
    if (reason) { report({ key: reason }); return false; }
    if (!current.frame.clock.pauseReasons.includes('player')) { report({ key: 'managementV9.buildPauseHint' as TextKey }); return false; }
    return !reviewRef.current;
  };
  const stage = (request: BuildDraftV9['request']) => {
    if (!eventGuard()) return;
    setNotice(null); setDraft({ basis: draft?.basis ?? snapshot, request });
  };
  const prepare = (basis: ManagementSnapshotV9, request: BuildRequestV9, opener: HTMLButtonElement) => {
    if (!eventGuard(basis)) return;
    const result = controller.prepare(basis, request);
    if (!result.ok) { report({ key: result.reason }); return; }
    reviewRef.current = result.review; reviewFocus.current = { review: result.review, opener }; setReview(result.review); setNotice(null);
  };
  const confirm = () => {
    if (!mounted.current || liveController.current !== controller || !review || reviewRef.current !== review) return;
    reviewRef.current = null; // Repeated callbacks cannot reuse this intent.
    const result = controller.confirm(review); setReview(null); setDraft(null); report(result.feedback);
  };
  const pause = () => {
    if (!mounted.current || liveController.current !== controller) return;
    const current = session.getSnapshot(); const reason = managementBuildIntentGuardV9(snapshot, current, latest.current.readOnly || latest.current.getReadOnly());
    if (reason) { report({ key: reason }); return; }
    const result = session.setPaused('player', true); if (!result.ok) report(managementResultV9(result));
  };
  const heading = <h2 id={`${prefix}-title`}>{v('Title')}</h2>;
  if (!content || !selected || snapshot.selection?.kind !== 'disciple' || snapshot.selection.id !== selected.discipleId) return <section id="management-v9-build" className="management-v9-panel management-v9-anchor" tabIndex={-1} aria-labelledby={`${prefix}-title`}>
    {heading}<p>{b(content ? 'selectDisciple' : 'unknownDefinition')}</p>
  </section>;
  const name = (id: string) => managementBuildNameV9(content, locale, id);
  const actor = snapshot.frame.disciples.find(row => row.id === selected.discipleId);
  const loadout = draft?.request.kind === 'loadout.set' ? draft.request.loadout : selected.loadout;
  const nodeIds = draft?.request.kind === 'tree.respec' ? draft.request.nodeIds : selected.allocatedNodeIds;
  const treeDisabled = disabled || draft?.request.kind === 'loadout.set';
  const loadoutDisabled = disabled || draft?.request.kind === 'tree.respec';
  const draftError = draft ? managementBuildRequestErrorV9(snapshot, draft.request) : null;
  const draftNodeIds = draft?.request.kind === 'tree.respec' ? draft.request.nodeIds : [];
  const reviewSkillId = review?.request.kind === 'skill.learn' ? review.request.skillId : null;
  const draftChanged = draft?.request.kind === 'tree.respec'
    ? [...draft.request.nodeIds].sort().join('|') !== [...selected.allocatedNodeIds].sort().join('|')
    : draft?.request.kind === 'loadout.set' && JSON.stringify(draft.request.loadout) !== JSON.stringify(selected.loadout);
  const stageLoadout = (next: RuntimeReadonlyV9<BuildLoadout>) => stage({ kind: 'loadout.set', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision, loadout: next });
  const skills = content.catalog.skills.filter(skill => skill.school === selected.school);
  const equipSkills = skills.filter(skill => selected.learnedSkillIds.includes(skill.id) && managementBuildSupportedV9(content, skill.id)
    && managementBuildSkillRequirementsV9(selected, content, skill.id));
  const itemName = (id: string) => name(selected.equipment.find(item => item.instanceId === id)?.definitionId ?? '');
  return <section id="management-v9-build" className="management-v9-panel management-v9-anchor" tabIndex={-1} aria-labelledby={`${prefix}-title`}>
    {heading}<p>{b('disciple', { name: actor ? managementContentTextV9(actor.nameKey, t) : b('fallbackDisciple') })} · {b(`school.${selected.school}`)}</p>
    <p><strong>{b('points', { earned: selected.progress.earnedPoints, allocated: selected.progress.allocatedPoints, remaining: selected.progress.availablePoints })}</strong><br />{b('credits', { remaining: selected.progress.availableLearningCredits, earned: selected.progress.earnedLearningCredits })}</p>
    <p className="management-v9-help">{v('MilestoneHelp')}</p>
    <p id={`${prefix}-blocked`} className="management-v9-notice">{blocker ? t(blocker) : !playerPaused ? v('PauseHint') : ''}</p>
    {!playerPaused && <button type="button" disabled={!!blocker} aria-describedby={`${prefix}-blocked`} onClick={pause}>{v('PauseEdit')}</button>}
    {(stale || reviewStale) && <p className="management-v9-notice" role="alert">{b('draftStale')}</p>}
    <div className="management-v9-card" aria-labelledby={`${prefix}-loadout`}>
      <h3 id={`${prefix}-loadout`}>{b('loadout')} · {b(draft?.request.kind === 'loadout.set' ? 'draftEquipped' : 'equipped')}</h3>
      <p>{b('basic')} · {name(selected.loadout.basicId)}</p>
      <div className="management-v9-recipe-list">{([0, 1] as const).map(index => <label className="management-v9-field" key={index} htmlFor={`${prefix}-active-${index}`}>
        {b(index === 0 ? 'activeOne' : 'activeTwo')}<select id={`${prefix}-active-${index}`} value={loadout.activeSkillIds[index]} disabled={loadoutDisabled} aria-describedby={`${prefix}-blocked`} onChange={event => {
          const activeSkillIds: [string, string] = [...loadout.activeSkillIds]; activeSkillIds[index] = event.currentTarget.value; stageLoadout({ ...loadout, activeSkillIds });
        }}>{equipSkills.filter(skill => skill.activation === 'active').map(skill => <option key={skill.id} value={skill.id} disabled={loadout.activeSkillIds[index === 0 ? 1 : 0] === skill.id}>{name(skill.id)}</option>)}</select>
      </label>)}<label className="management-v9-field" htmlFor={`${prefix}-passive`}>{b('passive')}<select id={`${prefix}-passive`} value={loadout.passiveSkillId} disabled={loadoutDisabled} aria-describedby={`${prefix}-blocked`} onChange={event => stageLoadout({ ...loadout, passiveSkillId: event.currentTarget.value })}>
        {equipSkills.filter(skill => skill.activation === 'passive').map(skill => <option key={skill.id} value={skill.id}>{name(skill.id)}</option>)}
      </select></label></div>
      <button type="button" className="secondary" disabled={loadoutDisabled} aria-describedby={`${prefix}-blocked`} onClick={() => stageLoadout({ ...loadout, activeSkillIds: [loadout.activeSkillIds[1], loadout.activeSkillIds[0]] })}>{v('SwapActive')}</button>
      <h3 className="management-v9-subheading">{b('equipment')}</h3><p id={`${prefix}-owned`} className="management-v9-help">{v('OnlyOwned')} {v('SlotsRequired')}</p>
      <div className="management-v9-recipe-list">{MANAGEMENT_BUILD_SLOTS_V9.map(slot => {
        const items = managementBuildEquipmentV9(selected, content, slot); const equipped = items.find(item => item.instanceId === loadout.equipment[`${slot}Id`]);
        return <label className="management-v9-field" key={slot} htmlFor={`${prefix}-gear-${slot}`}>{b(slot)}
          <select id={`${prefix}-gear-${slot}`} value={loadout.equipment[`${slot}Id`]} disabled={loadoutDisabled || items.length < 2} aria-describedby={`${prefix}-blocked ${prefix}-owned ${prefix}-gear-${slot}-help`} onChange={event => stageLoadout({ ...loadout, equipment: { ...loadout.equipment, [`${slot}Id`]: event.currentTarget.value } })}>
            {items.map(item => { const copies = items.filter(other => other.definitionId === item.definitionId); return <option key={item.instanceId} value={item.instanceId}>{copies.length > 1 ? b('itemCopy', { name: name(item.definitionId), number: copies.findIndex(other => other.instanceId === item.instanceId) + 1 }) : name(item.definitionId)}</option>; })}
          </select><small id={`${prefix}-gear-${slot}-help`}>{equipped ? equipmentDescription(content, locale, equipped.definitionId) : b('itemUnknown')}{items.length === 1 ? ` · ${v('OneItem')}` : ''}</small>
        </label>;
      })}</div>
    </div>
    <details className="management-v9-card"><summary>{b('tree')} · {nodeIds.length} / {Math.min(selected.progress.earnedPoints, content.rules.maximumAllocatedPoints)}</summary>
      <p className="management-v9-help">{v('TreeCost')}</p><p>{b('removeDependents')}</p>
      {(['a', 'b', 'c'] as const).map(branch => <div key={branch}><h3 className="management-v9-subheading">{b(`branch.${branch}`)}</h3><div className="management-v9-recipe-list">{content.catalog.treeNodes.filter(node => node.treeId === selected.treeId && node.branch === branch).sort((a, b) => a.tier - b.tier).map(node => {
        const toggle = managementBuildToggleNodeV9(selected, content, nodeIds, node.id); const active = nodeIds.includes(node.id);
        return <article className="management-v9-card" key={node.id}><h4>{name(node.id)}</h4><p>{definitionDescription(content, locale, node)}</p><p>{b('tier', { tier: node.tier, cost: node.pointCost })} · {b(active ? selected.allocatedNodeIds.includes(node.id) ? 'allocated' : 'draftSelected' : 'notSelected')}</p>
          <p id={`${prefix}-${node.id}-help`}>{node.prerequisites.length ? b('requires', { names: node.prerequisites.map(name).join(' · ') }) : b('noPrerequisite')}{!toggle.ok ? ` · ${t(toggle.reason)}` : ''}</p>
          <button type="button" aria-pressed={active} disabled={treeDisabled || !toggle.ok} aria-describedby={`${prefix}-blocked ${prefix}-${node.id}-help`} onClick={() => {
            if (!toggle.ok) return;
            stage({ kind: 'tree.respec', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision, nodeIds: toggle.nodeIds });
          }}>{b('toggleNode', { name: name(node.id) })}</button>
        </article>;
      })}</div></div>)}
    </details>
    {draft && <div className="management-v9-review" aria-label={b(draft.request.kind === 'tree.respec' ? 'tree' : 'loadout')}>
      {draft.request.kind === 'tree.respec' ? <><strong>{b('draftTree', { count: draftNodeIds.length, maximum: Math.min(content.rules.maximumAllocatedPoints, selected.progress.earnedPoints) })}</strong><p>{b('draftChanges', { added: draftNodeIds.filter(id => !selected.allocatedNodeIds.includes(id)).length, removed: selected.allocatedNodeIds.filter(id => !draftNodeIds.includes(id)).length })}</p><p>{v('TreeCost')}</p></>
        : <><strong>{b('draftLoadout')}</strong><ul>{([0, 1] as const).filter(index => selected.loadout.activeSkillIds[index] !== loadout.activeSkillIds[index]).map(index => <li key={index}>{b(index === 0 ? 'activeOne' : 'activeTwo')}: {name(selected.loadout.activeSkillIds[index])} → {name(loadout.activeSkillIds[index])}</li>)}{selected.loadout.passiveSkillId !== loadout.passiveSkillId && <li>{b('passive')}: {name(selected.loadout.passiveSkillId)} → {name(loadout.passiveSkillId)}</li>}{MANAGEMENT_BUILD_SLOTS_V9.filter(slot => selected.loadout.equipment[`${slot}Id`] !== loadout.equipment[`${slot}Id`]).map(slot => <li key={slot}>{b(slot)}: {itemName(selected.loadout.equipment[`${slot}Id`])} → {itemName(loadout.equipment[`${slot}Id`])}</li>)}</ul></>}
      {draftError && <p>{t(draftError)}</p>}
      {!review && <div className="management-v9-actions"><button type="button" disabled={disabled || !draftChanged || !!draftError} onClick={event => prepare(draft.basis, draft.request, event.currentTarget)}>{b(draft.request.kind === 'tree.respec' ? 'applyTree' : 'applyLoadout')}</button><button type="button" className="secondary" onClick={cancel}>{b('discardDraft')}</button></div>}
    </div>}
    {review && <div className="management-v9-review" ref={reviewRegion} tabIndex={-1} role="group" aria-labelledby={`${prefix}-confirm`}>
      <p id={`${prefix}-confirm`}>{reviewSkillId ? v('LearnConfirm', { name: name(reviewSkillId), cost: content.rules.lessons.find(row => row.skillId === reviewSkillId)?.creditCost ?? 0 }) : v('ConfirmChanges')}</p>
      <div className="management-v9-actions"><button type="button" disabled={!!blocker || reviewStale} onClick={confirm}>{v('Confirm')}</button><button type="button" className="secondary" onClick={cancel}>{b('discardDraft')}</button></div>
    </div>}
    <details className="management-v9-card"><summary>{b('skills')} · {b('learnedCount', { count: selected.learnedSkillIds.length })}</summary><p className="management-v9-help">{v('SkillsHelp')}</p>
      <div className="management-v9-recipe-list">{skills.map(skill => {
        const learned = selected.learnedSkillIds.includes(skill.id); const equipped = [...selected.loadout.activeSkillIds, selected.loadout.passiveSkillId].includes(skill.id);
        const rule = content.rules.lessons.find(row => row.skillId === skill.id); const reason = managementBuildLearnErrorV9(selected, content, skill.id);
        return <article className="management-v9-card" key={skill.id}><h3>{name(skill.id)}</h3><p>{b(skill.activation === 'passive' ? 'passive' : skill.ultimate ? 'ultimate' : 'active')} · {b(learned ? 'learned' : 'notLearned')}{equipped ? ` · ${b('equipped')}` : ''}</p><p>{definitionDescription(content, locale, skill)}</p>
          {skill.activation === 'active' && <p>{b('skillTiming', { cost: skill.action.spiritCostUnits, cooldown: skill.action.cooldownTicks / COMBAT_TICKS_PER_SECOND, cast: skill.action.castTicks / COMBAT_TICKS_PER_SECOND })}</p>}
          {!learned && <><p id={`${prefix}-${skill.id}-cost`}>{b('learningCost', { cost: rule?.creditCost ?? 0 })}{reason ? ` · ${t(reason)}` : ''}{rule && [...rule.requiredSkillIds, ...rule.requiredNodeIds].length > 0 ? ` · ${b('requires', { names: [...rule.requiredSkillIds, ...rule.requiredNodeIds].map(name).join(' · ') })}` : ''}</p><button type="button" disabled={disabled || !!draft || !!reason} aria-describedby={`${prefix}-blocked ${prefix}-${skill.id}-cost`} onClick={event => prepare(snapshot, { kind: 'skill.learn', discipleId: selected.discipleId, expectedRevision: snapshot.build.revision, skillId: skill.id }, event.currentTarget)}>{b('learn', { cost: rule?.creditCost ?? 0 })}</button></>}
        </article>;
      })}</div>
    </details>
    <p className="management-v9-feedback" role="status" aria-live="polite" aria-atomic="true">{notice ? t(notice.key, notice.parameters) : ''}</p>
  </section>;
}
