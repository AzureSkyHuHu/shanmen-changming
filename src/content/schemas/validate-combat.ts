import type { ActionAdjustment, Capability, CombatContentCatalog, CombatDefinition, Condition, EffectPrimitive, LifecycleScope, Mechanics, TreeNodeDefinition } from '../../core/combat/definitions/types.ts';
import { allCombatDefinitions } from '../definitions/index.ts';
import { validateCombatStructure } from './combat.ts';
import type { ContentIssue } from './combat.ts';

export interface CombatValidationOptions {
  readonly locales?: { readonly 'zh-CN': Readonly<Record<string, unknown>>; readonly en: Readonly<Record<string, unknown>> };
  /** Authoring validation is not execution certification. Runtime requires an explicit capability allowlist. */
  readonly mode?: 'authoring' | 'runtime';
  readonly supportedCapabilities?: readonly Capability[];
}
export interface CombatValidationReport {
  readonly valid: boolean;
  readonly errors: readonly ContentIssue[];
  readonly warnings: readonly ContentIssue[];
  readonly counts: Readonly<Record<string, number>>;
}
const scopeOrder: Readonly<Record<LifecycleScope, number>> = { encounter: 0, run: 1, character: 2 };
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Validate untrusted JSON structure first, then references, graphs, budgets and copy. */
export function validateCombatCatalog(input: unknown, options: CombatValidationOptions = {}): CombatValidationReport {
  const shape = validateCombatStructure(input);
  if (!shape.valid || !shape.value) return { valid: false, errors: shape.issues, warnings: [], counts: {} };
  const catalog = shape.value;
  const errors: ContentIssue[] = [];
  const warnings: ContentIssue[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const warn = (code: string, path: string, message: string) => warnings.push({ code, path, message });
  const definitions = allCombatDefinitions(catalog);
  const byId = new Map<string, CombatDefinition>();
  for (const d of definitions) {
    if (byId.has(d.id)) add('duplicate-id', d.id, 'Definition IDs must be globally unique.');
    else byId.set(d.id, d);
  }
  const reference = (id: string, kind: CombatDefinition['kind'], path: string) => {
    const found = byId.get(id);
    if (!found) add('dangling-reference', path, `Missing ${kind}: ${id}.`);
    else if (found.kind !== kind) add('reference-kind', path, `${id} is not a ${kind}.`);
    return found?.kind === kind ? found : undefined;
  };
  const unique = (ids: readonly string[], path: string) => { if (new Set(ids).size !== ids.length) add('duplicate-member', path, 'Entries must be unique.'); };
  function checkCondition(condition: Condition, path: string): void {
    switch (condition.kind) {
      case 'all': case 'any': condition.conditions.forEach((child, i) => checkCondition(child, `${path}.${i}`)); break;
      case 'not': checkCondition(condition.condition, `${path}.not`); break;
      case 'consumedStatus': case 'hasStatus': {
        const d = reference(condition.statusId, 'status', path);
        if (condition.kind === 'hasStatus' && d?.kind === 'status' && condition.minimumStacks > d.stackPolicy.maximumStacks) add('unreachable-condition', path, 'Requested status stacks exceed the definition cap.');
        break;
      }
      case 'compare': if (condition.field.endsWith('healthBps') && condition.value > 10_000) add('numeric-bound', path, 'Health ratios cannot exceed 10,000 basis points.'); break;
      default: break;
    }
  }
  function checkAdjustment(adjustment: ActionAdjustment, path: string): void {
    if (adjustment.kind === 'statusStacks') reference(adjustment.statusId, 'status', path);
  }
  function checkEffects(effects: readonly EffectPrimitive[], owner: CombatDefinition, path: string, capabilities: Set<Capability>, modifierIds: Set<string>): void {
    const results = new Set<string>();
    effects.forEach((effect, i) => {
      const current = `${path}[${i}]`;
      capabilities.add(effect.kind);
      checkCondition(effect.condition, `${current}.condition`);
      if ('amount' in effect && effect.amount.kind === 'consumed' && !results.has(effect.amount.resultKey)) add('unbound-result', current, 'Consumed amount must reference an earlier consume result in the same ordered effect list.');
      if ('lifecycleScope' in effect && 'lifecycleScope' in owner && scopeOrder[effect.lifecycleScope] > scopeOrder[owner.lifecycleScope]) add('scope-leak', current, 'An installed effect cannot outlive its source owner.');
      switch (effect.kind) {
        case 'applyStatus': {
          const d = reference(effect.statusId, 'status', current);
          if (d?.kind === 'status' && effect.stacks > d.stackPolicy.maximumStacks) add('numeric-bound', current, 'Applied stacks exceed the status cap.');
          break;
        }
        case 'consumeStatus': {
          const d = reference(effect.statusId, 'status', current);
          if (effect.minimumStacks > effect.maximumStacks || (d?.kind === 'status' && effect.maximumStacks > d.stackPolicy.maximumStacks)) add('numeric-bound', current, 'Consume minimum/maximum must fit the referenced status cap.');
          if (results.has(effect.resultKey)) add('duplicate-result', current, 'Consume result keys must be unique within a program.');
          results.add(effect.resultKey); break;
        }
        case 'installModifier': {
          checkCondition(effect.modifier.condition, `${current}.modifier.condition`);
          if (modifierIds.has(effect.modifier.modifierId)) add('duplicate-modifier', current, 'Modifier IDs must be unique within a source definition.');
          modifierIds.add(effect.modifier.modifierId);
          if ('lifecycleScope' in owner && scopeOrder[effect.modifier.lifecycleScope] > scopeOrder[owner.lifecycleScope]) add('scope-leak', current, 'Modifier scope cannot outlive its source owner.');
          if (effect.modifier.operation === 'multiplyBps' && effect.modifier.value < 0) add('numeric-bound', current, 'A multiplicative factor cannot be negative.');
          break;
        }
        case 'summon': {
          const summon = reference(effect.summonId, 'summon', current);
          if (summon?.kind === 'summon' && effect.duration.kind === 'ticks' && summon.duration.kind === 'ticks' && effect.duration.ticks > summon.duration.ticks) add('numeric-bound', current, 'Summon effect exceeds the summon duration cap.');
          break;
        }
        case 'zone':
          if (effect.duration.kind !== 'ticks' || effect.intervalTicks >= effect.duration.ticks) add('numeric-bound', current, 'Zones need finite tick duration exceeding their period.');
          checkEffects(effect.effects, owner, `${current}.effects`, capabilities, modifierIds); break;
        case 'augmentNextAction': checkAdjustment(effect.adjustment, current); break;
        default: break;
      }
    });
  }
  function checkMechanics(m: Mechanics, d: CombatDefinition, capabilities: Set<Capability>, modifierIds: Set<string>): void {
    checkEffects(m.onInstall, d, `${d.id}.onInstall`, capabilities, modifierIds);
    unique(m.triggers.map((t) => t.triggerId), `${d.id}.triggers`);
    unique(m.actionRules.map((r) => r.ruleId), `${d.id}.actionRules`);
    if (m.actionRules.length) capabilities.add('actionRules');
    for (const rule of m.actionRules) { checkCondition(rule.condition, `${d.id}.${rule.ruleId}`); checkAdjustment(rule.adjustment, `${d.id}.${rule.ruleId}`); }
    for (const t of m.triggers) {
      checkCondition(t.condition, `${d.id}.${t.triggerId}.condition`);
      if (!t.proc.oncePerRoot && t.proc.internalCooldownTicks === 0) add('unbounded-proc', `${d.id}.${t.triggerId}`, 'A trigger requires once-per-root or an internal cooldown.');
      if (t.proc.allowIndirectFamilies.includes(t.proc.family)) add('recursive-proc', `${d.id}.${t.triggerId}`, 'A proc family cannot opt into itself.');
      unique(t.proc.allowIndirectFamilies, `${d.id}.${t.triggerId}.allowIndirectFamilies`);
      checkEffects(t.effects, d, `${d.id}.${t.triggerId}.effects`, capabilities, modifierIds);
    }
  }
  const localeKeys = new Set<string>();
  for (const d of definitions) {
    const used = new Set<Capability>();
    const modifierIds = new Set<string>();
    unique(d.requiredCapabilities, `${d.id}.requiredCapabilities`);
    unique(d.tags, `${d.id}.tags`);
    for (const key of [d.nameKey, d.descriptionKey]) {
      if (localeKeys.has(key)) add('duplicate-locale-key', d.id, `A definition locale key is reused: ${key}.`);
      localeKeys.add(key);
    }
    if ('mechanics' in d) checkMechanics(d.mechanics, d, used, modifierIds);
    if (d.kind === 'skill' && d.activation === 'active') {
      checkCondition(d.action.condition, `${d.id}.action.condition`);
      checkEffects(d.action.effects, d, `${d.id}.action.effects`, used, modifierIds);
      const expectedParameters = { cost: d.action.spiritCostUnits, cooldownTicks: d.action.cooldownTicks, castTicks: d.action.castTicks };
      for (const [key, value] of Object.entries(expectedParameters)) if (d.descriptionParameters[key] !== value) add('copy-value-drift', d.id, `Description parameter ${key} differs from the authoritative action value.`);
    }
    if (d.kind === 'status') {
      checkEffects(d.periodicEffects, d, `${d.id}.periodicEffects`, used, modifierIds);
      if (d.actionLock !== 'none') used.add('control');
      if ((d.periodicIntervalTicks === 0) !== (d.periodicEffects.length === 0)) add('periodic-mismatch', d.id, 'Periodic effects and a positive periodic interval must be defined together.');
      if (d.periodicIntervalTicks > 0 && (d.duration.kind !== 'ticks' || d.periodicIntervalTicks >= d.duration.ticks)) add('numeric-bound', d.id, 'Periodic statuses need tick duration exceeding the interval.');
      if (d.stackPolicy.kind === 'extend' && d.duration.kind === 'ticks' && d.duration.ticks > d.stackPolicy.maximumDurationTicks) add('numeric-bound', d.id, 'Initial duration exceeds extension cap.');
      if (d.actionLock !== 'none' && d.resistancePolicy !== 'targetTenacity') add('control-resistance', d.id, 'Control must explicitly respect target tenacity.');
    }
    if (d.kind === 'summon') used.add('summon');
    if (!same([...used], d.requiredCapabilities)) add('capability-manifest', d.id, 'Required capabilities must exactly describe the definition operations.');
    const untestedAdvanced = [...used].some((kind) => ['move', 'zone', 'summon'].includes(kind));
    if (untestedAdvanced && d.implementation === 'definition-only') add('untested-operation', d.id, 'Movement, zones and summoning must be blocked until explicitly verified.');
    if ((d.implementation === 'blocked') !== (d.blockedReasons.length > 0)) add('blocked-reason', d.id, 'Blocked status and reasons must agree.');
    if (options.mode === 'runtime') {
      if (d.implementation !== 'verified') add('runtime-blocked', d.id, 'Only definitions explicitly verified against an executor may be activated.');
      for (const capability of used) if (!options.supportedCapabilities?.includes(capability)) add('unsupported-capability', d.id, `No certified executor capability: ${capability}.`);
    }
  }
  for (const d of [...catalog.treeNodes, ...catalog.talents]) {
    unique(d.prerequisites, `${d.id}.prerequisites`); unique(d.excludes, `${d.id}.excludes`);
    for (const id of d.prerequisites) { reference(id, d.kind, `${d.id}.prerequisites`); if (d.excludes.includes(id)) add('prerequisite-conflict', d.id, `Prerequisite ${id} is also excluded.`); }
    for (const id of d.excludes) {
      const excluded = reference(id, d.kind, `${d.id}.excludes`);
      if (id === d.id) add('self-exclusion', d.id, 'A definition cannot exclude itself.');
      if (excluded && 'excludes' in excluded && !excluded.excludes.includes(d.id)) add('asymmetric-exclusion', d.id, 'Mutual exclusions must be symmetric.');
    }
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) { add('prerequisite-cycle', id, 'A prerequisite cycle exists.'); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    const d = byId.get(id);
    if (d && 'prerequisites' in d) for (const parent of d.prerequisites) walk(parent);
    visiting.delete(id); visited.add(id);
  };
  for (const d of [...catalog.treeNodes, ...catalog.talents]) walk(d.id);

  for (const tree of catalog.trees) {
    unique(tree.nodeIds, `${tree.id}.nodeIds`);
    const members = tree.nodeIds.map((id) => reference(id, 'treeNode', tree.id)).filter((d): d is TreeNodeDefinition => d?.kind === 'treeNode');
    for (const node of members) {
      if (node.treeId !== tree.id || node.school !== tree.school) add('tree-membership', node.id, 'Node tree and school must agree with its containing tree.');
      const expected = members.filter((n) => n.branch === node.branch && n.tier < node.tier).map((n) => n.id);
      if (!same(node.prerequisites, expected)) add('tree-prerequisite', node.id, 'Each tier requires every earlier node on its own branch.');
    }
    for (const branch of ['a', 'b', 'c']) for (const tier of [1, 2, 3]) if (members.filter((n) => n.branch === branch && n.tier === tier).length !== 1) add('tree-shape', tree.id, 'Each branch must have exactly one node per tier.');
    const reachable = new Set<string>();
    for (let mask = 0; mask < 2 ** members.length; mask += 1) {
      const selection = members.filter((_, i) => (mask & (1 << i)) !== 0);
      if (selection.reduce((sum, node) => sum + node.pointCost, 0) > tree.maximumPoints) continue;
      const selected = new Set(selection.map((node) => node.id));
      if (selection.some((node) => node.prerequisites.some((id) => !selected.has(id)) || node.excludes.some((id) => selected.has(id)))) continue;
      for (const node of selection) reachable.add(node.id);
      if (selection.filter((node) => node.tier === 3).length > 1) add('tree-budget', tree.id, 'Two branch endpoints must not fit the five-point budget.');
    }
    for (const node of members) if (!reachable.has(node.id)) add('unreachable-node', node.id, 'No legal selection reaches this node within the point budget.');
  }
  for (const node of catalog.treeNodes) {
    const tree = reference(node.treeId, 'tree', node.id);
    if (tree?.kind === 'tree' && !tree.nodeIds.includes(node.id)) add('orphan-node', node.id, 'The node is not listed by its tree.');
  }
  for (const talent of catalog.talents) {
    reference(talent.buildId, 'build', talent.id);
    if ((talent.holderScope === 'team') !== (talent.teamStackPolicy === 'highestValueSharedBudget')) add('team-stack-policy', talent.id, 'Team auras must use highest-value contributions and a shared budget.');
    if (talent.holderScope === 'personal' && talent.recipientBinding !== 'holder') add('holder-binding', talent.id, 'Personal talents must bind to their holder.');
  }
  for (const build of catalog.builds) {
    unique(build.starterSkillIds, `${build.id}.starters`); unique(build.talentIds, `${build.id}.talents`);
    const starterTags = new Set<string>();
    for (const skillId of build.starterSkillIds) { const skill = reference(skillId, 'skill', build.id); if (skill) for (const tag of skill.tags) starterTags.add(tag); }
    for (const talentId of build.talentIds) {
      const talent = reference(talentId, 'talent', build.id);
      if (talent?.kind !== 'talent') continue;
      if (talent.buildId !== build.id) add('build-membership', talent.id, 'Talent belongs to another build.');
      if (talent.requiredSourceTags.some((tag) => !starterTags.has(tag) && !talent.providesSourceTags.includes(tag))) add('missing-starter', talent.id, 'The build starters do not supply every required source tag.');
    }
  }
  if (catalog.skills.length !== 24 || catalog.treeNodes.length !== 36 || catalog.trees.length !== 4 || catalog.builds.length !== 4) add('roster-count', '$', 'Foundation expects 24 skills, 36 tree nodes, four trees and four builds.');
  for (const school of ['sword', 'body', 'alchemy', 'talisman']) {
    if (catalog.skills.filter((s) => s.school === school && s.activation === 'active').length !== 4 || catalog.skills.filter((s) => s.school === school && s.activation === 'passive').length !== 2) add('school-count', school, 'Each school requires four active and two passive skills.');
  }
  if (catalog.talents.length < catalog.targetTalentCount) warn('incomplete-talent-catalog', '$.talents', `${catalog.talents.length}/${catalog.targetTalentCount} named talents are authored; no filler cards are generated.`);
  if (catalog.talents.length === catalog.targetTalentCount) {
    const count = (field: 'holderScope' | 'category', value: string) => catalog.talents.filter((t) => t[field] === value).length;
    if (count('holderScope', 'personal') !== 36 || count('holderScope', 'team') !== 12) add('talent-holder-count', '$.talents', 'The complete catalog requires 36 personal and 12 team cards.');
    if (count('category', 'general') !== 12 || count('category', 'school') !== 24 || count('category', 'crossSchool') !== 8 || count('category', 'route') !== 4) add('talent-category-count', '$.talents', 'Functional categories must independently total 12/24/8/4.');
  }
  if (catalog.talents.length > catalog.targetTalentCount) add('talent-count', '$.talents', 'The current content target is 48 cards.');
  if (options.locales) validateCopy(definitions, options.locales, localeKeys, add, warn);
  else warn('locales-unchecked', '$', 'Locale dictionaries were not supplied.');
  warn('execution-unverified', '$', 'Static authoring validation does not certify combat execution, balance, asset availability, or save/replay behavior.');
  const counts = { skills: catalog.skills.length, treeNodes: catalog.treeNodes.length, trees: catalog.trees.length, talents: catalog.talents.length, statuses: catalog.statuses.length, summons: catalog.summons.length, builds: catalog.builds.length };
  return { valid: errors.length === 0, errors, warnings, counts };
}

function validateCopy(definitions: readonly CombatDefinition[], locales: NonNullable<CombatValidationOptions['locales']>, keys: Set<string>, add: (code: string, path: string, message: string) => void, warn: (code: string, path: string, message: string) => void): void {
  for (const d of definitions) for (const key of [d.nameKey, d.descriptionKey]) {
    const expected = key === d.descriptionKey ? Object.keys(d.descriptionParameters) : [];
    for (const locale of ['zh-CN', 'en'] as const) {
      const value = Object.prototype.hasOwnProperty.call(locales[locale], key) ? locales[locale][key] : undefined;
      if (typeof value !== 'string' || value.trim() === '') {
        if (locale === 'en' && (value === undefined || (typeof value === 'string' && value.trim() === ''))) warn('english-fallback', key, 'Missing English uses the Chinese fallback.');
        else add('locale-missing', `${locale}.${key}`, 'A nonempty message is required.');
        continue;
      }
      const actual = [...new Set(Array.from(value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (m) => m[1]!))];
      if (!same(expected, actual) || /[{}]/.test(value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, ''))) add('locale-parameters', `${locale}.${key}`, 'Message parameter names must exactly match definition values.');
    }
  }
  for (const locale of ['zh-CN', 'en'] as const) for (const key of Object.keys(locales[locale])) if (!keys.has(key)) add('locale-unknown', `${locale}.${key}`, 'Combat locale key has no definition.');
}
