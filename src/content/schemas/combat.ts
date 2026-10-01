import type { CombatContentCatalog, SourceOwner } from '../../core/combat/definitions/types.ts';

export interface ContentIssue { readonly code: string; readonly path: string; readonly message: string }
export interface ValidationResult<T> { readonly valid: boolean; readonly issues: readonly ContentIssue[]; readonly value?: T }
type Context = { issues: ContentIssue[]; depth: number };
type Schema = (value: unknown, path: string, context: Context) => void;
type Shape = Readonly<Record<string, Schema>>;
const issue = (c: Context, path: string, message: string) => {
  if (c.issues.length < 200) c.issues.push({ code: 'schema', path, message });
};
const objectValue = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const safeProperties = (v: object, path: string, c: Context): boolean => {
  if (Reflect.ownKeys(v).some((key) => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(v, key)?.enumerable
    || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(v, key), 'value'))) {
    issue(c, path, 'Only enumerable own data fields are allowed.'); return false;
  }
  return true;
};
const text: Schema = (v, p, c) => { if (typeof v !== 'string' || !v.trim() || v.length > 500) issue(c, p, 'Expected a nonempty string of at most 500 characters.'); };
const id: Schema = (v, p, c) => { if (typeof v !== 'string' || !/^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/.test(v) || v.length > 120) issue(c, p, 'Expected a stable ASCII identifier.'); };
const instanceId: Schema = (v, p, c) => { if (typeof v !== 'string' || !/^[a-z][a-zA-Z0-9-]*:[1-9][0-9]*$/.test(v) || v.length > 120) issue(c, p, 'Expected a kernel-issued namespaced instance ID.'); };
const integer = (minimum = 0, maximum = 1_000_000): Schema => (v, p, c) => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < minimum || v > maximum) issue(c, p, `Expected an integer in [${minimum}, ${maximum}].`); };
const choice = (...values: readonly (string | number | boolean)[]): Schema => (v, p, c) => { if (!values.includes(v as string | number | boolean)) issue(c, p, `Expected one of: ${values.join(', ')}.`); };
const bool = choice(true, false);
const array = (item: Schema, minimum = 0, maximum = 512): Schema => (v, p, c) => {
  if (!Array.isArray(v) || v.length < minimum || v.length > maximum) { issue(c, p, `Expected an array with ${minimum}–${maximum} items.`); return; }
  if (Object.keys(v).length !== v.length || Object.keys(v).some((key, i) => key !== String(i))) { issue(c, p, 'Sparse arrays and extra array properties are forbidden.'); return; }
  for (let i = 0; i < v.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(v, String(i)), 'value')) { issue(c, `${p}[${i}]`, 'Accessors are forbidden.'); continue; }
    item(v[i], `${p}[${i}]`, c);
  }
};
const object = (shape: Shape): Schema => (v, p, c) => {
  if (!objectValue(v)) { issue(c, p, 'Expected a plain object.'); return; }
  if (!safeProperties(v, p, c)) return;
  if (c.depth >= 24) { issue(c, p, 'Definition nesting exceeds 24 levels.'); return; }
  const next = { ...c, depth: c.depth + 1 };
  for (const key of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(shape, key)) issue(c, `${p}.${key}`, 'Unknown field is forbidden.');
  for (const [key, schema] of Object.entries(shape)) {
    if (!Object.prototype.hasOwnProperty.call(v, key)) issue(c, `${p}.${key}`, 'Required field is missing.');
    else schema(v[key], `${p}.${key}`, next);
  }
};
const union = (discriminator: string, shapes: Readonly<Record<string, Schema>>): Schema => (v, p, c) => {
  if (!objectValue(v) || !safeProperties(v, p, c)) { if (!objectValue(v)) issue(c, p, 'Expected a discriminated object.'); return; }
  const key = v[discriminator];
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(shapes, key)) { issue(c, `${p}.${discriminator}`, 'Unknown operation or definition kind.'); return; }
  shapes[key]!(v, p, c);
};
const lazy = (schema: () => Schema): Schema => (v, p, c) => schema()(v, p, c);
const tags = choice('sword', 'body', 'alchemy', 'talisman', 'active', 'passive', 'ultimate', 'basic', 'physical', 'fire', 'lightning', 'poison', 'melee', 'ranged', 'projectile', 'beam', 'area', 'periodic', 'damage', 'shield', 'heal', 'cleanse', 'control', 'movement', 'summon', 'swordMark', 'storedForce', 'medicine', 'rune', 'proc', 'guard', 'interrupt', 'penetration');
const school = choice('sword', 'body', 'alchemy', 'talisman');
const scope = choice('character', 'run', 'encounter');
const stat = choice('attack', 'maxHealth', 'armor', 'criticalChanceBps', 'criticalMultiplierBps', 'hasteBps', 'damageReductionBps', 'healingBps', 'controlResistanceBps', 'shieldBps');
const tick = integer(1, 72_000);
const bps = integer(0, 100_000);
const duration = union('kind', {
  infinite: object({ kind: choice('infinite') }), ticks: object({ kind: choice('ticks'), ticks: tick }), nodes: object({ kind: choice('nodes'), nodes: integer(1, 100) }),
});
const condition: Schema = union('kind', {
  always: object({ kind: choice('always') }),
  all: object({ kind: choice('all'), conditions: array(lazy(() => condition), 1, 16) }),
  any: object({ kind: choice('any'), conditions: array(lazy(() => condition), 1, 16) }),
  not: object({ kind: choice('not'), condition: lazy(() => condition) }),
  compare: object({ kind: choice('compare'), field: choice('actor.healthBps', 'target.healthBps', 'actor.shieldUnits', 'event.actualHealthLoss', 'event.actualShieldAbsorbed', 'event.effectiveHealing', 'event.overhealing', 'event.consumedStacks', 'event.paidSpirit', 'event.idleTicks', 'event.distinctCasterCount', 'event.distinctSchoolCount'), operator: choice('eq', 'ne', 'lt', 'lte', 'gt', 'gte'), value: integer() }),
  flag: object({ kind: choice('flag'), field: choice('event.enemyCaused', 'event.isCritical', 'event.isActive', 'event.isBasic', 'event.targetAlive', 'event.differentCaster', 'event.differentSchool', 'event.ownedStatus'), value: bool }),
  hasStatus: object({ kind: choice('hasStatus'), subject: choice('actor', 'target', 'eventSource'), statusId: id, minimumStacks: integer(1, 99) }),
  hasTag: object({ kind: choice('hasTag'), subject: choice('actor', 'target', 'eventSource'), tag: tags }),
  consumedStatus: object({ kind: choice('consumedStatus'), statusId: id }),
});
const target = union('kind', {
  ...Object.fromEntries(['self', 'intent', 'eventTarget', 'eventActor', 'statusSource', 'focus', 'boundHolder'].map((kind) => [kind, object({ kind: choice(kind) })])),
  lowestHealth: object({ kind: choice('lowestHealth'), team: choice('ally', 'enemy'), excludeSelf: bool, maxRangeUnits: integer(1, 10_000) }),
  area: object({ kind: choice('area'), team: choice('ally', 'enemy'), center: choice('self', 'intent'), radiusUnits: integer(1, 10_000), limit: integer(1, 36) }),
  chain: object({ kind: choice('chain'), team: choice('ally', 'enemy'), start: choice('intent', 'eventTarget'), jumps: integer(1, 12), maxRangeUnits: integer(1, 10_000) }),
});
const amount = union('kind', {
  flat: object({ kind: choice('flat'), units: integer() }),
  stat: object({ kind: choice('stat'), stat: choice('attack', 'maxHealth'), coefficientBps: bps, flatUnits: integer() }),
  event: object({ kind: choice('event'), field: choice('actualShieldAbsorbed', 'effectiveHealing', 'overhealing'), coefficientBps: bps, capStat: choice('attack', 'maxHealth'), capBps: integer(1, 10_000) }),
  consumed: object({ kind: choice('consumed'), resultKey: id, stat: choice('attack', 'maxHealth'), coefficientPerStackBps: bps, flatPerStackUnits: integer() }),
});
const modifier = object({ modifierId: id, stat, operation: choice('addFlat', 'addPercentBps', 'multiplyBps', 'minimum', 'maximum'), value: integer(-100_000, 100_000), tags: array(tags), condition, priority: integer(-1000, 1000), lifecycleScope: scope, duration });
const adjustment = union('kind', {
  costReductionBps: object({ kind: choice('costReductionBps'), value: integer(0, 10_000), minimumCostUnits: integer() }),
  bonusDamageBps: object({ kind: choice('bonusDamageBps'), value: integer(-10_000, 100_000) }),
  additionalChainTargets: object({ kind: choice('additionalChainTargets'), value: integer(1, 12), staggerTicks: integer(0, 400) }),
  ...Object.fromEntries(['rangeUnits', 'castTimeTicks', 'statusDurationTicks', 'areaRadiusUnits', 'dispelCount', 'interruptStrength'].map((kind) => [kind, object({ kind: choice(kind), value: integer(-10_000, 10_000) })])),
  statusStacks: object({ kind: choice('statusStacks'), statusId: id, value: integer(-99, 99) }),
});
const effectBase = { target, condition };
const effect: Schema = union('kind', {
  damage: object({ ...effectBase, kind: choice('damage'), amount, damageType: choice('physical', 'fire', 'lightning', 'poison'), tags: array(tags), armorPenetrationBps: integer(0, 10_000), attackRead: choice('castSnapshot', 'applicationSnapshot'), defenseRead: choice('hitLive'), rounding: choice('floor'), canCritical: bool }),
  heal: object({ ...effectBase, kind: choice('heal'), amount, rounding: choice('floor') }),
  shield: object({ ...effectBase, kind: choice('shield'), amount, lifecycleScope: scope, duration, stackPolicy: choice('independent', 'refreshSource', 'strongest'), rounding: choice('floor') }),
  applyStatus: object({ ...effectBase, kind: choice('applyStatus'), statusId: id, stacks: integer(1, 99), duration }),
  consumeStatus: object({ ...effectBase, kind: choice('consumeStatus'), statusId: id, maximumStacks: integer(1, 99), minimumStacks: integer(1, 99), resultKey: id, sourceFilter: choice('any', 'self') }),
  restoreResource: object({ ...effectBase, kind: choice('restoreResource'), resource: choice('spirit'), units: integer(1) }),
  installModifier: object({ ...effectBase, kind: choice('installModifier'), modifier }),
  dispel: object({ ...effectBase, kind: choice('dispel'), category: choice('poison', 'control', 'debuff'), count: integer(1, 99) }),
  interrupt: object({ ...effectBase, kind: choice('interrupt'), strength: integer(1, 100) }),
  move: object({ ...effectBase, kind: choice('move'), mode: choice('toAlly'), maximumDistanceUnits: integer(1, 10_000) }),
  summon: object({ ...effectBase, kind: choice('summon'), summonId: id, maximumPerCaster: choice(1), duration }),
  zone: object({ ...effectBase, kind: choice('zone'), radiusUnits: integer(1, 10_000), intervalTicks: tick, duration, effects: array(lazy(() => effect), 1, 16) }),
  preventDowned: object({ ...effectBase, kind: choice('preventDowned'), healthFloorBps: integer(1, 10_000) }),
  rescue: object({ ...effectBase, kind: choice('rescue'), healthBps: integer(1, 10_000), recoveryLockTicks: tick }),
  storeForce: object({ ...effectBase, kind: choice('storeForce'), coefficientBps: integer(1, 10_000), maximumHealthBps: integer(1, 10_000) }),
  releaseForce: object({ ...effectBase, kind: choice('releaseForce'), coefficientBps: integer(1, 10_000), maximumHealthBps: integer(1, 10_000), damageType: choice('physical'), tags: array(tags) }),
  recordCast: object({ ...effectBase, kind: choice('recordCast'), windowTicks: tick, maximumRecords: integer(1, 36), distinctBy: choice('caster', 'school') }),
  augmentNextAction: object({ ...effectBase, kind: choice('augmentNextAction'), tags: array(tags, 1), uses: integer(1, 12), duration, adjustment }),
});
const capabilities = choice('damage', 'heal', 'shield', 'applyStatus', 'consumeStatus', 'restoreResource', 'installModifier', 'dispel', 'interrupt', 'move', 'summon', 'zone', 'preventDowned', 'rescue', 'storeForce', 'releaseForce', 'recordCast', 'augmentNextAction', 'actionRules', 'control');
const proc = object({ family: id, allowIndirectFamilies: array(id, 0, 16), oncePerRoot: bool, perTarget: bool, internalCooldownTicks: integer(0, 72_000), maximumActivations: integer(1, 10_000), activationScope: choice('encounter', 'run'), maxDepth: integer(1, 8), maxDerivedEffects: integer(1, 64) });
const mechanics = object({
  onInstall: array(effect, 0, 32),
  triggers: array(object({ triggerId: id, event: choice('action.committed', 'damage.healthLost', 'shield.absorbed', 'shield.broken', 'status.consumed', 'control.ended', 'life.beforeDowned', 'life.downed', 'healing.resolved', 'command.guard', 'force.released', 'castHistory.recorded'), eventScope: choice('owner', 'allies', 'team'), condition, priority: integer(-1000, 1000), proc, effects: array(effect, 1, 32) }), 0, 32),
  actionRules: array(object({ ruleId: id, tags: array(tags, 1), condition, adjustment }), 0, 32),
});
const parameters: Schema = (v, p, c) => {
  if (!objectValue(v) || !safeProperties(v, p, c)) { if (!objectValue(v)) issue(c, p, 'Expected parameter map.'); return; }
  if (Object.keys(v).length > 32) issue(c, p, 'At most 32 parameters are supported.');
  for (const [key, value] of Object.entries(v)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) issue(c, `${p}.${key}`, 'Invalid named parameter.');
    if (typeof value === 'number') integer(-1_000_000, 1_000_000)(value, `${p}.${key}`, c);
    else text(value, `${p}.${key}`, c);
  }
};
const base = { id, schemaVersion: choice(1), nameKey: id, descriptionKey: id, descriptionParameters: parameters, tags: array(tags), presentationKey: id, source: object({ designRef: text, section: integer(1, 99) }), testScenarioIds: array(id, 3, 32), tuning: choice('unbalanced-baseline'), implementation: choice('definition-only', 'blocked', 'verified'), blockedReasons: array(text, 0, 16), requiredCapabilities: array(capabilities) };
const skillBase = { ...base, kind: choice('skill'), school, lifecycleScope: choice('character'), mechanics };
const skill = union('activation', {
  passive: object({ ...skillBase, activation: choice('passive') }),
  active: object({ ...skillBase, activation: choice('active'), ultimate: bool, action: object({ spiritCostUnits: integer(1, 1_000), cooldownTicks: tick, castTicks: integer(0, 1200), rangeUnits: integer(0, 10_000), targetTeam: choice('self', 'ally', 'enemy'), target, condition, effects: array(effect, 1, 32), commitPolicy: choice('castEndRevalidate'), missRefundPolicy: choice('none'), launchedSourceDeathPolicy: choice('resolveCommitted') }) }),
});
const stackPolicy = union('kind', {
  refresh: object({ kind: choice('refresh'), maximumStacks: integer(1, 99) }),
  extend: object({ kind: choice('extend'), maximumStacks: integer(1, 99), maximumDurationTicks: tick }),
  independent: object({ kind: choice('independent'), maximumStacks: integer(1, 99) }),
  strongest: object({ kind: choice('strongest'), maximumStacks: choice(1), compareBy: choice('magnitude'), equalPolicy: choice('keepExisting', 'refreshDuration') }),
});
const catalogSchema = object({
  schemaVersion: choice(1), contentVersion: text, requiredSimulationVersion: text, scope: choice('combat-definition-foundation'), ticksPerSecond: choice(20), targetTalentCount: choice(48),
  skills: array(skill),
  trees: array(object({ ...base, kind: choice('tree'), school, lifecycleScope: choice('character'), maximumPoints: choice(5), nodeIds: array(id, 9, 9) })),
  treeNodes: array(object({ ...base, kind: choice('treeNode'), lifecycleScope: choice('character'), treeId: id, school, branch: choice('a', 'b', 'c'), tier: choice(1, 2, 3), pointCost: choice(1), prerequisites: array(id), excludes: array(id), mechanics })),
  talents: array(object({ ...base, kind: choice('talent'), lifecycleScope: choice('run'), holderScope: choice('personal', 'team'), category: choice('general', 'school', 'crossSchool', 'route'), buildId: id, offerRole: choice('core', 'support', 'bridge'), maximumRank: integer(1, 10), prerequisites: array(id), excludes: array(id), requiredSourceTags: array(tags), providesSourceTags: array(tags), teamStackPolicy: choice('notApplicable', 'highestValueSharedBudget'), recipientBinding: choice('holder', 'team', 'selectedTalisman'), mechanics })),
  statuses: array(object({ ...base, kind: choice('status'), lifecycleScope: choice('encounter'), duration, identity: choice('definition', 'definitionAndCaster'), stackPolicy, dispelCategory: choice('poison', 'control', 'debuff', 'buff', 'none'), actionLock: choice('none', 'untilRemoved'), resistancePolicy: choice('none', 'targetTenacity'), deathPolicy: choice('remove'), encounterEndPolicy: choice('remove'), expiryOrder: choice('expireBeforePeriodic'), periodicIntervalTicks: integer(0, 72_000), periodicEffects: array(effect, 0, 16), mechanics })),
  summons: array(object({ ...base, kind: choice('summon'), lifecycleScope: choice('encounter'), maximumPerCaster: choice(1), duration, healthCoefficientBps: integer(1, 10_000), role: choice('threatDecoy'), canCultivate: choice(false), canEquip: choice(false), canInherit: choice(false) })),
  builds: array(object({ ...base, kind: choice('build'), starterSkillIds: array(id, 1, 12), talentIds: array(id, 1, 12) })),
});
function validate<T>(schema: Schema, value: unknown): ValidationResult<T> {
  const context: Context = { issues: [], depth: 0 };
  schema(value, '$', context);
  return context.issues.length ? { valid: false, issues: context.issues } : { valid: true, issues: [], value: value as T };
}
/** Trust boundary for parsed JSON. Never interprets strings or permits unknown keys/ops. */
export function validateCombatStructure(value: unknown): ValidationResult<CombatContentCatalog> { return validate(catalogSchema, value); }
export function validateSourceOwner(value: unknown): ValidationResult<SourceOwner> {
  return validate(object({ sourceEntityId: instanceId, sourceDefinitionId: id, sourceInstanceId: instanceId, lifecycleScope: scope, duration, createdSequence: integer(0, Number.MAX_SAFE_INTEGER) }), value);
}
