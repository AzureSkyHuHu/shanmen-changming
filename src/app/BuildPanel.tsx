import { useId, useLayoutEffect, useRef, useState } from 'react';
import { COMBAT_TICKS_PER_SECOND } from '../core/combat/definitions';
import type { CombatContentCatalog, School, SkillDefinition, TreeNodeDefinition } from '../core/combat/definitions';
import { combatDefinitionSupport } from '../core/combat/runtime';
import { BUILD_SCHOOLS, EQUIPMENT_SLOTS, EQUIPMENT_DEFINITIONS, isBuildCommand, MAX_ALLOCATED_POINTS, SKILL_LEARNING_RULES } from '../core/builds';
import type { BuildCommand, BuildError, BuildLoadout, BuildProgress, BuildStateFrame, EquipmentDefinition, EquipmentSlot, Immutable, SkillLearningRule } from '../core/builds';
import type { BuildContentContext, BuildErrorV2, BuildStateFrameV2 } from '../core/builds/v2-types';
import { resolveBuildContentContext } from '../content/registry/build-context';
import { canonicalStringify, cloneJson, compareStable, stableHash } from '../core/kernel/serialization';
import { combatContentTranslator } from '../application/combat-content-text';
import { translate, type Locale, type TextKey, type TranslationParams } from '../i18n';
import './build-panel.css';

type WithoutCommandId<T> = T extends BuildCommand ? Omit<T, 'commandId'> : never;
export type BuildPanelRequest = WithoutCommandId<BuildCommand>;
export type BuildPanelFrame = BuildStateFrame | BuildStateFrameV2;
export interface BuildPanelCommandResult { readonly ok: boolean; readonly code?: BuildErrorV2; }
export interface BuildPanelProps {
  readonly frame: BuildPanelFrame;
  readonly catalog: CombatContentCatalog;
  /** Required for v2. Use the registry-resolved World context and its exact catalog. */
  readonly context?: BuildContentContext | null | undefined;
  /** Required to edit v2. Absent retains legacy v1 behavior only. */
  readonly lifeState?: 'alive' | 'pendingDeath' | 'dead' | null | undefined;
  readonly discipleId: string;
  readonly locale: Locale;
  /** The session allocates command IDs and synchronously reports its real reducer result. */
  readonly onCommand: (request: BuildPanelRequest) => BuildPanelCommandResult;
  readonly readOnly?: boolean;
  readonly locked?: boolean;
  readonly nameFor?: (definitionId: string) => string | undefined;
  readonly discipleName?: string;
}
interface BuildPanelDraft {
  readonly discipleId: string;
  readonly expectedRevision: number;
  readonly kind: 'tree' | 'loadout';
  readonly nodeIds: readonly string[];
  readonly loadout: Immutable<BuildLoadout>;
}
type Disciple = BuildPanelFrame['builds']['disciples'][number];
type PanelContent = { readonly catalog: CombatContentCatalog; readonly schools: readonly School[]; readonly equipmentSlots: readonly EquipmentSlot[];
  readonly equipment: readonly EquipmentDefinition[]; readonly lessons: readonly SkillLearningRule[]; readonly maximumAllocatedPoints: number };
interface RegisteredContext { readonly context: BuildContentContext; readonly identity: string; readonly legacyIdentity: string; readonly rulesHash: string }
// The registry's immutable rule object is shared even when the Session creates a new context wrapper.
// Verify that object once; render never validates/replays frame history or rehashes full catalogs.
const registeredContexts = new WeakMap<object, RegisteredContext>();
function registeredContext(context: BuildContentContext | null | undefined): RegisteredContext | null {
  if (!context || typeof context !== 'object') return null;
  try {
    let registered = registeredContexts.get(context.rules);
    if (!registered) {
      const selected = resolveBuildContentContext(context.identity, { allowCandidate: true });
      if (!selected || selected.identity.buildRulesVersion !== 2 || selected.rules !== context.rules) return null;
      registered = { context: selected, identity: canonicalStringify(selected.identity), legacyIdentity: canonicalStringify(selected.legacy.identity), rulesHash: stableHash(selected.rules) };
      registeredContexts.set(selected.rules, registered);
    }
    return context.catalog === registered.context.catalog && context.legacy.catalog === registered.context.legacy.catalog
      && canonicalStringify(context.identity) === registered.identity && canonicalStringify(context.legacy.identity) === registered.legacyIdentity ? registered : null;
  } catch { return null; }
}
function panelContent(frame: BuildPanelFrame, catalog: CombatContentCatalog, context?: BuildContentContext | null): PanelContent | null {
  if (frame.builds.schemaVersion === 1) return context == null ? { catalog, schools: BUILD_SCHOOLS, equipmentSlots: EQUIPMENT_SLOTS,
    equipment: EQUIPMENT_DEFINITIONS, lessons: SKILL_LEARNING_RULES, maximumAllocatedPoints: MAX_ALLOCATED_POINTS } : null;
  if (frame.builds.schemaVersion !== 2) return null;
  const registered = registeredContext(context);
  if (!registered || catalog !== registered.context.catalog || frame.builds.rulesHash !== registered.rulesHash
    || canonicalStringify(frame.builds.contentIdentity) !== registered.identity) return null;
  return { catalog: registered.context.catalog, ...registered.context.rules, equipmentSlots: registered.context.rules.equipmentSlots as readonly EquipmentSlot[] };
}
const trainingItemNameKeys: Readonly<Record<string, TextKey>> = {
  'equipment.training-sword': 'buildView.item.training-sword', 'equipment.training-body': 'buildView.item.training-body',
  'equipment.training-alchemy': 'buildView.item.training-alchemy', 'equipment.training-talisman': 'buildView.item.training-talisman',
  'equipment.training-robe': 'buildView.item.training-robe', 'equipment.training-artifact': 'buildView.item.training-artifact',
};
function equipmentTextKey(definition: EquipmentDefinition, field: 'nameKey' | 'descriptionKey'): string | undefined {
  const value = (definition as EquipmentDefinition & { nameKey?: unknown; descriptionKey?: unknown })[field];
  return typeof value === 'string' ? value : undefined;
}
function cannotEditLife(props: Pick<BuildPanelProps, 'frame' | 'lifeState'>): boolean {
  return props.frame.builds.schemaVersion === 2 ? props.lifeState !== 'alive' : props.lifeState != null && props.lifeState !== 'alive';
}
export const buildText = (locale: Locale, suffix: string, parameters: TranslationParams = {}): string => translate(locale, `buildView.${suffix}` as TextKey, parameters);

/** The same locale catalogs and parameter-checked translator used by combat; no Phaser dependency. */
export function buildDefinitionName(locale: Locale, definitionId: string, catalog: CombatContentCatalog, context?: BuildContentContext | null): string {
  const selected = context == null ? null : registeredContext(context);
  if (context != null && (!selected || selected.context.catalog !== catalog)) return buildText(locale, 'unknownDefinition');
  const definition = [...catalog.skills, ...catalog.treeNodes, ...catalog.trees, ...catalog.statuses].find(item => item.id === definitionId);
  if (definition) return combatContentTranslator(catalog)(locale, definition.nameKey);
  const equipment = (selected ? selected.context.rules.equipment : EQUIPMENT_DEFINITIONS).find(item => item.id === definitionId);
  if (equipment) {
    const key = equipmentTextKey(equipment, 'nameKey') ?? trainingItemNameKeys[equipment.id];
    return key ? translate(locale, key as TextKey) : buildText(locale, 'itemUnknown');
  }
  const school = BUILD_SCHOOLS.find(school => definitionId === `basic.${school}`);
  return school ? buildText(locale, 'basicSchool', { school: buildText(locale, `school.${school}`) }) : buildText(locale, 'itemUnknown');
}
export function buildSkillTiming(skill: SkillDefinition): { cost: number; cooldown: number; cast: number } | null {
  return skill.activation === 'active' ? { cost: skill.action.spiritCostUnits, cooldown: skill.action.cooldownTicks / COMBAT_TICKS_PER_SECOND, cast: skill.action.castTicks / COMBAT_TICKS_PER_SECOND } : null;
}
export function buildDefinitionDescription(locale: Locale, definition: SkillDefinition | TreeNodeDefinition, catalog?: CombatContentCatalog): string {
  // Authored active descriptions append simulation ticks. Their concise effect-only UI keys
  // keep those implementation units out of player text; timing is shown separately in seconds.
  if (definition.kind === 'skill' && definition.activation === 'active') return buildText(locale, `skillSummary.${definition.id.slice('skill.'.length)}`);
  return combatContentTranslator(catalog)(locale, definition.descriptionKey, definition.descriptionParameters);
}
export function buildSupportExplanation(locale: Locale, reasons: readonly string[]): string {
  const text = reasons.join(' ');
  const suffix = /Unverified/.test(text) ? 'unverified' : /(?:capability|operation): move\b/.test(text) ? 'move'
    : /(?:capability|operation): zone\b/.test(text) ? 'zone' : /(?:capability|operation): summon\b/.test(text) ? 'summon'
      : /staggerTicks/.test(text) ? 'stagger' : /duration: nodes/.test(text) ? 'duration' : 'generic';
  return buildText(locale, `support.${suffix}`);
}
/** Cheap read-only projection of an already validated World snapshot. Never replay history per render. */
export function buildPanelProgress(frame: BuildPanelFrame, discipleId: string): BuildProgress | null {
  const disciple = frame.builds.disciples.find(item => item.discipleId === discipleId);
  if (!disciple) return null;
  const awards = frame.builds.awards.filter(award => award.discipleId === discipleId);
  const earnedPoints = awards.reduce((sum, award) => sum + award.treePoints, 0);
  const earnedLearningCredits = awards.reduce((sum, award) => sum + award.learningCredits, 0);
  const spentLearningCredits = disciple.learnedSkills.reduce((sum, skill) => sum + skill.creditCost, 0);
  return { earnedPoints, allocatedPoints: disciple.allocatedNodeIds.length, availablePoints: earnedPoints - disciple.allocatedNodeIds.length,
    earnedLearningCredits, spentLearningCredits, availableLearningCredits: earnedLearningCredits - spentLearningCredits };
}
function sortedNodes(ids: readonly string[], catalog: CombatContentCatalog): string[] {
  return [...ids].sort((left, right) => (catalog.treeNodes.find(node => node.id === left)?.tier ?? 0) - (catalog.treeNodes.find(node => node.id === right)?.tier ?? 0) || compareStable(left, right));
}
function nodeSetError(frame: BuildPanelFrame, content: PanelContent, disciple: Disciple, ids: readonly string[]): BuildError | null {
  const { catalog } = content;
  if (new Set(ids).size !== ids.length) return 'INVALID_ALLOCATION';
  if (ids.length > content.maximumAllocatedPoints) return 'POINT_LIMIT';
  if (ids.length > (buildPanelProgress(frame, disciple.discipleId)?.earnedPoints ?? 0)) return 'INSUFFICIENT_POINTS';
  for (const id of ids) {
    const node = catalog.treeNodes.find(node => node.id === id);
    if (!node) return 'UNKNOWN_DEFINITION';
    if (node.school !== disciple.school || node.treeId !== disciple.treeId || node.excludes.some(excluded => ids.includes(excluded))) return 'INVALID_ALLOCATION';
    if (node.prerequisites.some(prerequisite => !ids.includes(prerequisite))) return 'MISSING_PREREQUISITE';
    if (!combatDefinitionSupport(catalog, id, frame.builds.contentMode).supported) return 'UNSUPPORTED_CONTENT';
  }
  return null;
}
/** Only edits a UI draft. Removing a prerequisite removes its dependent descendants together. */
export function toggleBuildTreeDraft(frame: BuildPanelFrame, catalog: CombatContentCatalog, discipleId: string, ids: readonly string[], definitionId: string, context?: BuildContentContext | null): { ok: true; nodeIds: string[] } | { ok: false; code: BuildError } {
  const disciple = frame.builds.disciples.find(item => item.discipleId === discipleId);
  if (!disciple) return { ok: false, code: 'UNKNOWN_DISCIPLE' };
  if (disciple.lock) return { ok: false, code: 'EXPEDITION_LOCKED' };
  const content = panelContent(frame, catalog, context);
  if (!content) return { ok: false, code: 'CONTENT_MISMATCH' };
  const target = content.catalog.treeNodes.find(node => node.id === definitionId);
  if (!target || target.school !== disciple.school) return { ok: false, code: 'INVALID_ALLOCATION' };
  let next = ids.includes(definitionId) ? ids.filter(id => id !== definitionId) : [...ids, definitionId];
  if (ids.includes(definitionId)) {
    for (let remaining = next.length, changed = true; changed && remaining >= 0; remaining -= 1) {
      const valid = next.filter(id => catalog.treeNodes.find(node => node.id === id)?.prerequisites.every(prerequisite => next.includes(prerequisite)));
      changed = valid.length !== next.length; next = valid;
    }
  }
  const error = nodeSetError(frame, content, disciple, next);
  return error ? { ok: false, code: error } : { ok: true, nodeIds: sortedNodes(next, catalog) };
}
type BuildDispatchProps = Pick<BuildPanelProps, 'frame' | 'discipleId' | 'readOnly' | 'locked' | 'onCommand' | 'context' | 'lifeState'> & { readonly catalog?: CombatContentCatalog };
function requestError(props: BuildDispatchProps, request: BuildPanelRequest): BuildError | null {
  if (props.frame.builds.schemaVersion === 2) {
    if (!props.context || !panelContent(props.frame, props.catalog ?? props.context.catalog, props.context)) return 'CONTENT_MISMATCH';
  } else if (props.context != null) return 'CONTENT_MISMATCH';
  const disciple = props.frame.builds.disciples.find(item => item.discipleId === props.discipleId);
  if (!disciple) return 'UNKNOWN_DISCIPLE';
  if (props.readOnly || cannotEditLife(props)) return 'INVALID_COMMAND';
  if (props.locked || disciple.lock) return 'EXPEDITION_LOCKED';
  if (!request || typeof request !== 'object') return 'INVALID_COMMAND';
  if (Object.prototype.hasOwnProperty.call(request, 'commandId') || !isBuildCommand({ ...request, commandId: 'build-panel.shape-check' }) || request.discipleId !== props.discipleId) return 'INVALID_COMMAND';
  if (request.expectedRevision !== props.frame.builds.revision) return 'REVISION_CONFLICT';
  return null;
}
/** A second guard at the event boundary, in addition to disabled DOM controls and the core reducer. */
export function dispatchBuildPanelRequest(props: BuildDispatchProps, request: BuildPanelRequest): BuildPanelCommandResult {
  const error = requestError(props, request);
  if (error) return { ok: false, code: error };
  try {
    const result = props.onCommand(cloneJson(request));
    return result && typeof result.ok === 'boolean' ? result : { ok: false, code: 'INVALID_COMMAND' };
  } catch { return { ok: false, code: 'INVALID_COMMAND' }; }
}
/** Synchronous latch closes same-turn double clicks, rejected repeats and callback reentrancy. */
export function createBuildPanelController() {
  let basis: string | null = null; let awaiting = false; let inFlight = false;
  const attempted = new Set<string>();
  function observe(props: BuildDispatchProps) {
    const identity = props.frame.builds.schemaVersion === 2 ? canonicalStringify(props.frame.builds.contentIdentity) : props.frame.builds.contentHash;
    const next = `${props.discipleId}/${props.frame.builds.schemaVersion}/${identity}/${props.frame.builds.revision}`;
    if (next !== basis) { basis = next; awaiting = false; attempted.clear(); }
  }
  return {
    pending(props: BuildDispatchProps) { observe(props); return awaiting || inFlight; },
    submit(props: BuildDispatchProps, request: BuildPanelRequest): BuildPanelCommandResult {
      observe(props);
      if (awaiting || inFlight) return { ok: false, code: 'REVISION_CONFLICT' };
      const error = requestError(props, request);
      if (error) return { ok: false, code: error };
      const key = canonicalStringify(request);
      if (attempted.has(key)) return { ok: false, code: 'COMMAND_CONFLICT' };
      attempted.add(key); inFlight = true;
      try {
        const result = props.onCommand(cloneJson(request));
        if (!result || typeof result.ok !== 'boolean') throw new TypeError('Invalid build callback result');
        if (result.ok) awaiting = true;
        return result;
      } catch { awaiting = true; return { ok: false, code: 'INVALID_COMMAND' }; }
      finally { inFlight = false; }
    },
  };
}
function feedback(locale: Locale, code: BuildErrorV2 | undefined): string {
  const keys: Partial<Record<BuildErrorV2, string>> = {
    REVISION_CONFLICT: 'draftStale', EXPEDITION_LOCKED: 'locked', MISSING_PREREQUISITE: 'missingPrerequisite',
    INSUFFICIENT_POINTS: 'insufficientPoints', POINT_LIMIT: 'pointLimit', INSUFFICIENT_LEARNING_CREDITS: 'insufficientCredits',
    UNKNOWN_DEFINITION: 'unknownDefinition', CONTENT_MISMATCH: 'unknownDefinition', UNSUPPORTED_CONTENT: 'support.generic',
  };
  return buildText(locale, (code && keys[code]) || 'rejected');
}
function skillRequirementsMet(disciple: Disciple, skillId: string, content: PanelContent): boolean {
  const rule = content.lessons.find(item => item.skillId === skillId);
  return !!rule && rule.requiredSkillIds.every(id => disciple.learnedSkills.some(skill => skill.skillId === id)) && rule.requiredNodeIds.every(id => disciple.allocatedNodeIds.includes(id));
}
function equipmentBonuses(locale: Locale, definitionId: string, content: PanelContent): string {
  const definition = content.equipment.find(item => item.id === definitionId);
  if (!definition) return buildText(locale, 'itemUnknown');
  const description = equipmentTextKey(definition, 'descriptionKey');
  if (description) return translate(locale, description as TextKey);
  const lines = Object.entries(definition.flatStats).map(([stat, amount]) => buildText(locale, 'itemBonus', { stat: buildText(locale, `stat.${stat}`), amount }));
  if (definition.maximumSpiritBonus) lines.push(buildText(locale, 'itemBonus', { stat: buildText(locale, 'stat.maximumSpirit'), amount: definition.maximumSpiritBonus }));
  return lines.join(' · ');
}

export function BuildPanel(props: BuildPanelProps) {
  const identity = props.frame.builds.schemaVersion === 2 ? canonicalStringify(props.frame.builds.contentIdentity) : props.frame.builds.contentHash;
  return <BuildPanelEditor key={`${props.discipleId}/${identity}`} {...props} />;
}
function BuildPanelEditor(props: BuildPanelProps) {
  const { frame, catalog, discipleId, locale, readOnly = false, locked = false, onCommand: _onCommand, nameFor, discipleName } = props;
  const prefix = useId();
  const latest = useRef(props); latest.current = props;
  const mounted = useRef(false);
  const controller = useRef(createBuildPanelController());
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const content = panelContent(frame, catalog, props.context);
  const disciple = frame.builds.disciples.find(item => item.discipleId === discipleId);
  const [browsing, setBrowsing] = useState<{ discipleId: string; school: School } | null>(null);
  const [draft, setDraft] = useState<BuildPanelDraft | null>(null);
  const [notice, setNotice] = useState<BuildPanelCommandResult | null>(null);
  const t = (suffix: string, parameters: TranslationParams = {}) => buildText(locale, suffix, parameters);
  const name = (id: string): string => { const supplied = nameFor?.(id)?.trim(); return supplied && supplied !== id ? supplied : buildDefinitionName(locale, id, catalog, props.context); };
  if (!content) return <section className="build-panel"><h3>{t('title')}</h3><p className="build-notice" role="alert">{t('unknownDefinition')}</p></section>;
  const retired = frame.builds.schemaVersion === 2 ? frame.builds.retiredDisciples.find(item => item.discipleId === discipleId) : undefined;
  if (retired) return <section className="build-panel"><h3>{t('title')}</h3><p>{t('disciple', { name: discipleName || t('fallbackDisciple') })}</p><p className="build-notice" role="status">{translate(locale, 'disciple.dead')} · {t('readOnly')}</p><p>{t('learnedCount', { count: retired.learnedSkills.length })}</p><ul>{retired.learnedSkills.map(skill => <li key={skill.skillId}>{name(skill.skillId)}</li>)}</ul></section>;
  if (!disciple) return <section className="build-panel"><h3>{t('title')}</h3><p className="build-notice">{t('selectDisciple')}</p></section>;
  const progress = buildPanelProgress(frame, discipleId)!;
  const school = browsing?.discipleId === discipleId ? browsing.school : disciple.school;
  const currentDraft = draft?.discipleId === discipleId ? draft : null;
  const stale = !!currentDraft && currentDraft.expectedRevision !== frame.builds.revision;
  const pending = controller.current.pending(props);
  const lifeBlocked = cannotEditLife(props);
  const blocked = readOnly || lifeBlocked || locked || !!disciple.lock || pending;
  const treeEditingBlocked = blocked || stale || school !== disciple.school || currentDraft?.kind === 'loadout';
  const loadoutEditingBlocked = blocked || stale || currentDraft?.kind === 'tree';
  const nativeNodeIds = currentDraft?.kind === 'tree' ? currentDraft.nodeIds : disciple.allocatedNodeIds;
  const nodeIds = school === disciple.school ? nativeNodeIds : [];
  const loadout = currentDraft?.kind === 'loadout' ? currentDraft.loadout : disciple.loadout;
  const tree = catalog.trees.find(tree => tree.school === school);
  const learnedIds = new Set(disciple.learnedSkills.map(skill => skill.skillId));
  const ownEquipment = frame.builds.schemaVersion === 2
    ? frame.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === discipleId)
    : frame.builds.equipment.filter(item => item.ownerDiscipleId === discipleId);
  const equippedIds = [...disciple.loadout.activeSkillIds, disciple.loadout.passiveSkillId];
  const editableSkills = catalog.skills.filter(skill => skill.school === disciple.school && learnedIds.has(skill.id) && skillRequirementsMet(disciple, skill.id, content) && combatDefinitionSupport(catalog, skill.id, frame.builds.contentMode).supported);
  const makeDraft = (kind: BuildPanelDraft['kind']): BuildPanelDraft => ({ kind, discipleId, expectedRevision: frame.builds.revision, nodeIds: [...disciple.allocatedNodeIds], loadout: cloneJson(disciple.loadout) });
  const editLoadout = (next: Immutable<BuildLoadout>) => { if (loadoutEditingBlocked) return; setNotice(null); setDraft({ ...(currentDraft ?? makeDraft('loadout')), loadout: cloneJson(next) }); };
  const send = (request: BuildPanelRequest) => {
    if (!mounted.current || blocked || stale) return;
    const result = controller.current.submit(latest.current, request); setNotice(result);
    if (result.ok) setDraft(null);
  };
  const discard = () => { setDraft(null); setNotice(null); };
  const treeChanged = currentDraft?.kind === 'tree' && sortedNodes(currentDraft.nodeIds, catalog).join('|') !== sortedNodes(disciple.allocatedNodeIds, catalog).join('|');
  const loadoutChanged = currentDraft?.kind === 'loadout' && JSON.stringify(currentDraft.loadout) !== JSON.stringify(disciple.loadout);
  const treeError = currentDraft?.kind === 'tree' ? nodeSetError(frame, content, disciple, currentDraft.nodeIds) : null;
  const draftAdded = currentDraft?.nodeIds.filter(id => !disciple.allocatedNodeIds.includes(id)).length ?? 0;
  const draftRemoved = disciple.allocatedNodeIds.filter(id => !currentDraft?.nodeIds.includes(id)).length;
  return <section className="build-panel" aria-labelledby={`${prefix}-title`}>
    <header className="build-header"><span className="build-seal" aria-hidden="true">◇</span><div><span className="build-eyebrow">{t('subtitle')}</span><h3 id={`${prefix}-title`}>{t('title')}</h3><p>{t('disciple', { name: discipleName || t('fallbackDisciple') })}</p></div></header>
    <div className="build-resource-summary"><strong>{t('points', { earned: progress.earnedPoints, allocated: progress.allocatedPoints, remaining: progress.availablePoints })}</strong><span>{t('credits', { remaining: progress.availableLearningCredits, earned: progress.earnedLearningCredits })}</span></div>
    <p className="build-footnote">{t('milestoneHelp')}</p>
    {(readOnly || lifeBlocked || locked || disciple.lock) && <p className="build-notice" role="status">{props.lifeState === 'dead' ? `${translate(locale, 'disciple.dead')} · ` : props.lifeState === 'pendingDeath' ? `${translate(locale, 'cultivation.ui.pendingDeath')} · ` : ''}{t(readOnly || lifeBlocked ? 'readOnly' : 'locked')}</p>}
    {stale && <div className="build-notice build-stale" role="alert"><p>{t('draftStale')}</p><button type="button" className="build-secondary" onClick={discard}>{t('reloadDraft')}</button></div>}
    {pending && <p className="build-notice" role="status">{t('pending')}</p>}
    <div className="build-schools" role="group" aria-label={t('schools')}>{content.schools.map(item => <button type="button" key={item} aria-pressed={school === item} onClick={() => setBrowsing({ discipleId, school: item })}><span>{t(`school.${item}`)}</span>{disciple.school === item && <small>{t('nativeSchool')}</small>}</button>)}</div>
    {school !== disciple.school && <p className="build-footnote">{t('browseOnly', { school: t(`school.${disciple.school}`) })}</p>}
    <section className="build-tree-section" aria-labelledby={`${prefix}-tree`}><div className="build-section-heading"><h4 id={`${prefix}-tree`}>{tree ? name(tree.id) : t('tree')}</h4><span>{t('tree')}</span></div><p className="build-help">{t('treeHelp')}</p>
      <div className="build-tree">{(['a', 'b', 'c'] as const).map(branch => <section className="build-branch" key={branch} aria-labelledby={`${prefix}-branch-${branch}`}><h5 id={`${prefix}-branch-${branch}`}>{t(`branch.${branch}`)}</h5><ol>{catalog.treeNodes.filter(node => node.school === school && node.branch === branch).sort((a, b) => a.tier - b.tier).map(node => {
        const selected = nodeIds.includes(node.id); const committed = disciple.allocatedNodeIds.includes(node.id);
        const support = combatDefinitionSupport(catalog, node.id, frame.builds.contentMode);
        const toggle = !treeEditingBlocked ? toggleBuildTreeDraft(frame, catalog, discipleId, nativeNodeIds, node.id, props.context) : null;
        const missing = node.prerequisites.filter(id => !nodeIds.includes(id));
        const reason = !support.supported ? buildSupportExplanation(locale, support.reasons) : missing.length ? t('requires', { names: missing.map(name).join('、') }) : toggle && !toggle.ok ? feedback(locale, toggle.code) : null;
        const disabled = treeEditingBlocked || !support.supported || !toggle?.ok;
        return <li key={node.id} className="build-node" data-selected={selected} data-committed={committed} data-supported={support.supported}>
          <button type="button" className="build-node-toggle" aria-pressed={selected} aria-label={t('toggleNode', { name: name(node.id) })} aria-describedby={`${prefix}-${node.id}-description`} disabled={disabled} onClick={() => {
            if (treeEditingBlocked) return;
            const next = toggleBuildTreeDraft(frame, catalog, discipleId, nativeNodeIds, node.id, props.context);
            if (next.ok) { setNotice(null); setDraft({ ...(currentDraft ?? makeDraft('tree')), nodeIds: next.nodeIds }); }
          }}><span className="build-node-mark" aria-hidden="true">{selected ? '◆' : '◇'}</span><strong>{name(node.id)}</strong><small>{t('tier', { tier: node.tier, cost: node.pointCost })}</small></button>
          <div className="build-node-copy" id={`${prefix}-${node.id}-description`}><span className="build-state-label">{t(selected ? committed ? 'allocated' : 'draftSelected' : 'notSelected')}</span><p>{buildDefinitionDescription(locale, node, catalog)}</p><small>{node.prerequisites.length ? t('requires', { names: node.prerequisites.map(name).join('、') }) : t('noPrerequisite')}</small>{reason && <p className="build-blocker">{reason}</p>}</div>
        </li>;
      })}</ol></section>)}</div>
      <p className="build-footnote">{t('removeDependents')}</p>
      {currentDraft?.kind === 'tree' && <div className="build-draft" aria-label={t('draftTree', { count: currentDraft.nodeIds.length, maximum: Math.min(content.maximumAllocatedPoints, progress.earnedPoints) })}><strong>{t('draftTree', { count: currentDraft.nodeIds.length, maximum: Math.min(content.maximumAllocatedPoints, progress.earnedPoints) })}</strong><p>{t('draftChanges', { added: draftAdded, removed: draftRemoved })}</p>{treeError && <p className="build-blocker">{feedback(locale, treeError)}</p>}<div className="build-actions"><button type="button" disabled={blocked || stale || !treeChanged || !!treeError} onClick={() => send({ kind: 'tree.respec', discipleId, nodeIds: [...currentDraft.nodeIds], expectedRevision: currentDraft.expectedRevision })}>{t('applyTree')}</button><button type="button" className="build-secondary" onClick={discard}>{t('discardDraft')}</button></div></div>}
    </section>
    <section className="build-loadout-section" data-draft={currentDraft?.kind === 'loadout'} aria-labelledby={`${prefix}-loadout`}><div className="build-section-heading"><h4 id={`${prefix}-loadout`}>{t('loadout')}</h4><span>{t(currentDraft?.kind === 'loadout' ? 'draftEquipped' : 'equipped')}</span></div><p className="build-help">{t('loadoutHelp')}</p>
      <p className="build-basic"><span>{t('basic')}</span><strong>{name(disciple.loadout.basicId)}</strong></p>
      {currentDraft && <p className="build-footnote">{t('finishDraft')}</p>}
      <div className="build-skill-slots">{([0, 1] as const).map(index => <label key={index} htmlFor={`${prefix}-active-${index}`}><span>{t(index === 0 ? 'activeOne' : 'activeTwo')}</span><select id={`${prefix}-active-${index}`} value={loadout.activeSkillIds[index]} disabled={loadoutEditingBlocked} onChange={event => {
        const activeSkillIds: [string, string] = [...loadout.activeSkillIds]; activeSkillIds[index] = event.target.value; editLoadout({ ...loadout, activeSkillIds });
      }}>{editableSkills.filter(skill => skill.activation === 'active').map(skill => <option key={skill.id} value={skill.id} disabled={loadout.activeSkillIds[index === 0 ? 1 : 0] === skill.id}>{name(skill.id)}{skill.activation === 'active' && skill.ultimate ? ` · ${t('ultimate')}` : ''}</option>)}</select></label>)}
        <label htmlFor={`${prefix}-passive`}><span>{t('passive')}</span><select id={`${prefix}-passive`} value={loadout.passiveSkillId} disabled={loadoutEditingBlocked} onChange={event => editLoadout({ ...loadout, passiveSkillId: event.target.value })}>{editableSkills.filter(skill => skill.activation === 'passive').map(skill => <option key={skill.id} value={skill.id}>{name(skill.id)}</option>)}</select></label>
      </div>
      <div className="build-equipment"><h5>{t('equipment')}</h5><p className="build-footnote">{t('ownedGear')}</p>{content.equipmentSlots.map(slot => {
        const items = ownEquipment.filter(item => { const definition = content.equipment.find(definition => definition.id === item.definitionId); return definition?.slot === slot && (!definition.school || definition.school === disciple.school); });
        const selected = items.find(item => item.instanceId === loadout.equipment[`${slot}Id`]);
        return <label className="build-equipment-slot" key={slot} htmlFor={`${prefix}-gear-${slot}`}><span>{t(slot)}</span><select id={`${prefix}-gear-${slot}`} value={loadout.equipment[`${slot}Id`]} disabled={loadoutEditingBlocked || items.length < 2} onChange={event => editLoadout({ ...loadout, equipment: { ...loadout.equipment, [`${slot}Id`]: event.target.value } })}>{items.map(item => {
          const identical = items.filter(other => other.definitionId === item.definitionId); const index = identical.findIndex(other => other.instanceId === item.instanceId) + 1;
          return <option key={item.instanceId} value={item.instanceId}>{identical.length > 1 ? t('itemCopy', { name: name(item.definitionId), number: index }) : name(item.definitionId)}</option>;
        })}</select><small>{selected ? equipmentBonuses(locale, selected.definitionId, content) : t('itemUnknown')}</small></label>;
      })}</div>
      {currentDraft?.kind === 'loadout' && <div className="build-draft"><strong>{t('draftLoadout')}</strong><div className="build-actions"><button type="button" disabled={blocked || stale || !loadoutChanged} onClick={() => send({ kind: 'loadout.set', discipleId, loadout: cloneJson(currentDraft.loadout), expectedRevision: currentDraft.expectedRevision })}>{t('applyLoadout')}</button><button type="button" className="build-secondary" onClick={discard}>{t('discardDraft')}</button></div></div>}
    </section>
    <details className="build-library" open><summary><span>{t('skills')}</span><small>{t('learnedCount', { count: disciple.learnedSkills.length })}</small></summary><p className="build-help">{t('skillsHelp')}</p><p className="build-library-credits">{t('credits', { remaining: progress.availableLearningCredits, earned: progress.earnedLearningCredits })}</p><div className="build-skill-library">{catalog.skills.filter(skill => skill.school === school).map(skill => {
      const learned = learnedIds.has(skill.id); const equipped = equippedIds.includes(skill.id); const rule = content.lessons.find(rule => rule.skillId === skill.id); const timing = buildSkillTiming(skill);
      const support = combatDefinitionSupport(catalog, skill.id, frame.builds.contentMode); const requirements = skillRequirementsMet(disciple, skill.id, content);
      const prerequisites = [...(rule?.requiredSkillIds ?? []), ...(rule?.requiredNodeIds ?? [])];
      const cost = rule?.creditCost ?? 0; const enoughCredits = !!rule && progress.availableLearningCredits >= cost;
      const canLearn = !blocked && !currentDraft && !learned && support.supported && requirements && enoughCredits;
      return <article className="build-skill-card" key={skill.id} data-supported={support.supported} data-learned={learned}><header><h5>{name(skill.id)}</h5><span>{t(skill.activation === 'passive' ? 'passive' : skill.ultimate ? 'ultimate' : 'active')}</span></header><div className="build-skill-badges"><span>{t(learned ? 'learned' : 'notLearned')}</span>{equipped && <strong>{t('equipped')}</strong>}</div><p>{buildDefinitionDescription(locale, skill, catalog)}</p>{timing && <p className="build-skill-timing">{t('skillTiming', timing)}</p>}{prerequisites.length > 0 && <small>{t('requires', { names: prerequisites.map(name).join('、') })}</small>}{!support.supported && <p className="build-blocker">{buildSupportExplanation(locale, support.reasons)}</p>}{skill.school !== disciple.school && <p className="build-footnote">{t('foreignSkill')}</p>}{!learned && <div className="build-study"><span>{t('learningCost', { cost })}</span><button type="button" disabled={!canLearn} onClick={() => { if (canLearn) send({ kind: 'skill.learn', discipleId, skillId: skill.id, expectedRevision: frame.builds.revision }); }}>{t('learn', { cost })}</button>{support.supported && !requirements && <p className="build-blocker">{t('missingPrerequisite')}</p>}{support.supported && requirements && !enoughCredits && <p className="build-blocker">{t('insufficientCredits')}</p>}</div>}</article>;
    })}</div></details>
    <div className="build-feedback" role="status" aria-live="polite">{notice ? notice.ok ? pending ? t('submitted') : null : feedback(locale, notice.code) : null}</div>
  </section>;
}
