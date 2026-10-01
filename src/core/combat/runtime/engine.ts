import type { ActionAdjustment, Amount, Capability, CombatContentCatalog, CombatDefinition, CombatTag, Duration, EffectPrimitive, LifecycleScope, SourceOwner, Stat, TriggerDefinition } from '../definitions/types';
import { ROOT_PROC_LIMITS } from '../definitions/types';
import { allocateId, createSequences } from '../../kernel/ids';
import { assertNonNegativeInteger, checkedAdd, multiplyDivideFloor } from '../../kernel/numeric';
import { createRandomStreams, drawInteger } from '../../kernel/random';
import { canonicalStringify, cloneJson, compareStable } from '../../kernel/serialization';
import { validateBattleArena, arenaWalkable, occupiedBattleCells, allyMovementDestination, summonPlacement } from './movement';
import { catalogFingerprint, copyCombatData } from './catalog';
import { actionAdjustmentSum as adjustmentSum, actorActionBlock, actionTargetBlock, adjustedActionCost as costAfter, collectActionAdjustments, queryCastReadiness } from './castReadiness';
import { activeShields, alive, conditionPasses, definition, emptyContext, mechanics, queryStat, selectTargets, snapshotStats, sourceActive, statusActive, STAT_DEFAULTS, tagsMatch, within } from './queries';
import type { EvaluationContext } from './queries';
import { BATTLE_SIMULATION_VERSION, BATTLE_SNAPSHOT_VERSION } from './types';
import type { BattleAction, BattleArena, BattleCommand, BattleData, BattleEvent, BattleOptions, BattleState, BattleStepOptions, CombatStats, InstalledSource, Provenance, QueuedProgram, SourceInstallOptions, StatusInstance, TriggerLedger } from './types';

export const SUPPORTED_COMBAT_CAPABILITIES: readonly Capability[] = Object.freeze(['damage', 'heal', 'shield', 'applyStatus', 'consumeStatus', 'restoreResource', 'installModifier', 'dispel', 'interrupt', 'preventDowned', 'rescue', 'storeForce', 'releaseForce', 'recordCast', 'augmentNextAction', 'actionRules', 'control', 'move', 'zone', 'summon']);
export const UNSUPPORTED_COMBAT_CAPABILITIES: readonly Capability[] = Object.freeze([]);
const MAX_ENTITIES = 72;
export const MAX_BATTLE_ZONES = 128;
export const RETIRED_SUMMON_TARGET = 'retired-summons';
const MAX_STEP_TICKS = 100_000;
const MAX_LIVE_CONTRIBUTIONS = 4096;
function capacity(size: number, kind: string): void { if (size >= MAX_LIVE_CONTRIBUTIONS) throw new RangeError(`Battle ${kind} capacity exceeded`); }
const infinite: Duration = { kind: 'infinite' };
const always = { kind: 'always' } as const;
const self = { kind: 'self' } as const;
const intent = { kind: 'intent' } as const;
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
export const COMPLETED_ACTION_RETENTION = 256;
function compact(state: BattleData): void {
  const completed = Object.values(state.actions).filter(action => action.state !== 'Casting').sort((a, b) => Number(b.actionId.slice(7)) - Number(a.actionId.slice(7)));
  for (const action of completed.slice(COMPLETED_ACTION_RETENTION)) delete state.actions[action.actionId];
  const roots = new Set([...Object.keys(state.actions), ...state.log.map(event => event.rootActionId), ...state.statuses.map(status => status.provenance.rootActionId), ...state.zones.map(zone => zone.provenance.rootActionId), ...state.queue.map(program => program.provenance.rootActionId), ...Object.values(state.castHistory).flatMap(records => records.map(record => record.rootActionId))]);
  for (const key of Object.keys(state.roots)) if (!roots.has(key)) delete state.roots[key];
  const teamBudgetIds = new Set(Object.values(state.teamBudgets).map(item => item.budgetId));
  state.triggerLedger = state.triggerLedger.filter(ledger => !!state.sources[ledger.sourceInstanceId] || teamBudgetIds.has(ledger.sourceInstanceId));
  for (const ledger of state.triggerLedger) ledger.roots = ledger.roots.filter(root => roots.has(root));
}
export const immutableBattle = (state: BattleData): BattleState => { compact(state); return freeze(state); };
function clampHealth(state: BattleData, catalog: CombatContentCatalog): void { for (const entity of Object.values(state.entities)) if (entity.health > 0) entity.health = Math.min(entity.health, queryStat(state, catalog, entity.id, 'maxHealth')); }
function finishBattle(state: BattleData, catalog: CombatContentCatalog): BattleState { clampHealth(state, catalog); return immutableBattle(state); }
function draft(state: BattleState): BattleData {
  // Closed actions and events are immutable audit data. Share those frozen subtrees;
  // clone only the current transactional state and windups that can still change.
  const copy: BattleData = copyCombatData({ ...state, actions: {}, log: [] });
  copy.actions = Object.fromEntries(Object.entries(state.actions).sort(([a], [b]) => compareStable(a, b)).map(([key, action]) => [key, action.state === 'Casting' || !Object.isFrozen(action) ? copyCombatData(action) : action])) as Record<string, BattleAction>;
  copy.log = state.log.map(event => Object.isFrozen(event) ? event : copyCombatData(event)) as BattleEvent[];
  return copy;
}
function id(state: BattleData, kind: 'action' | 'event' | 'entity' | 'instance'): string { const result = allocateId(state.sequences, kind); state.sequences = result.sequences; return result.id; }
function provenanceOf(p: Provenance): Provenance { return { rootActionId: p.rootActionId, parentId: p.parentId, depth: p.depth, family: p.family, direct: p.direct, originalTags: p.originalTags, originalActorId: p.originalActorId, school: p.school }; }
function newRoot(state: BattleData, actorId: string, tags: readonly CombatTag[] = []): Provenance { const rootActionId = id(state, 'action'); state.roots[rootActionId] = { rootActionId, derivedEffects: 0, exhausted: false }; return { rootActionId, parentId: null, depth: 0, family: null, direct: true, originalTags: tags, originalActorId: actorId, school: null }; }
function expiry(state: BattleData, duration: Duration): number | null { return duration.kind === 'ticks' ? checkedAdd(state.tick, duration.ticks) : null; }
function assertCatalog(state: BattleState, catalog: CombatContentCatalog): void { if (state.contentVersion !== catalog.contentVersion || state.catalogHash !== catalogFingerprint(catalog)) throw new Error('Battle catalog mismatch; explicit migration required'); }
export function assertSupported(catalog: CombatContentCatalog, d: CombatDefinition, mode: BattleData['contentMode'], visited = new Set<string>()): void {
  if (visited.has(d.id)) return; visited.add(d.id);
  if (mode === 'verified' && d.implementation !== 'verified') throw new Error(`Unverified combat definition: ${d.id}`);
  for (const capability of d.requiredCapabilities) if (!SUPPORTED_COMBAT_CAPABILITIES.includes(capability)) throw new Error(`Unsupported combat capability: ${capability} (${d.id})`);
  const visit = (effects: readonly EffectPrimitive[]): void => { for (const effect of effects) { if (('duration' in effect && effect.duration.kind === 'nodes') || (effect.kind === 'installModifier' && effect.modifier.duration.kind === 'nodes')) throw new Error(`Unsupported effect duration: nodes (${d.id})`); if (!SUPPORTED_COMBAT_CAPABILITIES.includes(effect.kind)) throw new Error(`Unsupported combat operation: ${effect.kind}`); if (effect.kind === 'augmentNextAction' && effect.adjustment.kind === 'additionalChainTargets' && effect.adjustment.staggerTicks !== 0) throw new Error(`Unsupported adjustment: additionalChainTargets.staggerTicks (${d.id})`); if (effect.kind === 'applyStatus') assertSupported(catalog, definition(catalog, effect.statusId), mode, visited); if (effect.kind === 'summon') { const summon = definition(catalog, effect.summonId); if (summon.kind !== 'summon' || effect.duration.kind !== 'ticks' || effect.duration.ticks < 1) throw new Error('Summon requires finite positive duration'); assertSupported(catalog, summon, mode, visited); } if (effect.kind === 'zone') { if (!Number.isSafeInteger(effect.intervalTicks) || effect.intervalTicks < 1) throw new Error('Zone interval must be positive'); visit(effect.effects); } } };
  if ('mechanics' in d) { for (const rule of d.mechanics.actionRules) if (rule.adjustment.kind === 'additionalChainTargets' && rule.adjustment.staggerTicks !== 0) throw new Error(`Unsupported adjustment: additionalChainTargets.staggerTicks (${d.id})`); visit(d.mechanics.onInstall); for (const trigger of d.mechanics.triggers) visit(trigger.effects); }
  if (d.kind === 'skill' && d.activation === 'active') visit(d.action.effects);
  if (d.kind === 'status') visit(d.periodicEffects);
}
export function combatDefinitionSupport(catalog: CombatContentCatalog, definitionId: string, mode: BattleData['contentMode'] = 'experimental'): { readonly supported: boolean; readonly reasons: readonly string[] } {
  try { assertSupported(catalog, definition(catalog, definitionId), mode); return { supported: true, reasons: [] }; }
  catch (error) { return { supported: false, reasons: [error instanceof Error ? error.message : 'Invalid combat definition'] }; }
}
// The context factory below always resolves stats against the supplied catalog.
function makeContext(state: BattleData, catalog: CombatContentCatalog, holderId: string, provenance: Provenance, source: InstalledSource | null = null, event: BattleEvent | null = null): EvaluationContext {
  return { ...emptyContext(state, holderId, provenance.originalTags), provenance, sourceInstanceId: source?.sourceInstanceId ?? null, sourceDefinitionId: source?.sourceDefinitionId ?? null, boundHolderId: source?.boundHolderId ?? holderId, event, intentId: event?.targetId ?? null, targetId: event?.targetId ?? null, statusApplierId: source?.statusInstanceId ? state.statuses.find(s => s.statusInstanceId === source.statusInstanceId)?.applierId ?? null : null, attackSnapshot: snapshotStats(state, catalog, holderId, provenance.originalTags) };
}
function eventValues(state: BattleData, event: BattleEvent): void {
  const stats = state.statistics; stats.eventCount = checkedAdd(stats.eventCount, 1);
  const actor = stats.byEntity[event.actorId];
  if (event.kind === 'damage.healthLost') { stats.healthLost = checkedAdd(stats.healthLost, event.values.actualHealthLoss ?? 0); if (actor) actor.damage = checkedAdd(actor.damage, event.values.actualHealthLoss ?? 0); }
  if (event.kind === 'shield.absorbed') { stats.shieldAbsorbed = checkedAdd(stats.shieldAbsorbed, event.values.actualShieldAbsorbed ?? 0); const victim = event.targetId ? stats.byEntity[event.targetId] : null; if (victim) victim.absorbed = checkedAdd(victim.absorbed, event.values.actualShieldAbsorbed ?? 0); }
  if (event.kind === 'healing.resolved') { stats.requestedHealing = checkedAdd(stats.requestedHealing, event.values.requestedHealing ?? 0); stats.effectiveHealing = checkedAdd(stats.effectiveHealing, event.values.effectiveHealing ?? 0); stats.overhealing = checkedAdd(stats.overhealing, event.values.overhealing ?? 0); if (actor) actor.healing = checkedAdd(actor.healing, event.values.effectiveHealing ?? 0); }
  if (event.kind === 'action.committed') stats.committedActions = checkedAdd(stats.committedActions, 1);
  if (event.kind === 'life.downed') stats.downed = checkedAdd(stats.downed, 1);
  if (event.kind === 'life.recovered') stats.recovered = checkedAdd(stats.recovered, 1);
  if (event.kind === 'life.died') { stats.deaths = checkedAdd(stats.deaths, 1); if (actor) actor.kills = checkedAdd(actor.kills, 1); }
  if (event.kind === 'command.rejected') stats.rejectedCommands = checkedAdd(stats.rejectedCommands, 1);
  if (event.kind === 'proc.truncated') stats.truncatedProcs = checkedAdd(stats.truncatedProcs, 1);
}
type EventInput = Pick<BattleEvent, 'kind' | 'actorId' | 'targetId'> & Partial<Pick<BattleEvent, 'values' | 'flags' | 'statusId' | 'consumedApplierIds' | 'shieldInstanceId' | 'reason' | 'sourceDefinitionId' | 'sourceInstanceId'>>;
function emit(state: BattleData, catalog: CombatContentCatalog, input: EventInput, ctx: EvaluationContext, preDowned = false): BattleEvent {
  const eventId = id(state, 'event');
  const event: BattleEvent = freeze({ ...ctx.provenance, eventId, sequence: state.sequences.nextEvent - 1, tick: state.tick, sourceDefinitionId: ctx.sourceDefinitionId, sourceInstanceId: ctx.sourceInstanceId, values: {}, flags: {}, statusId: null, consumedApplierIds: [], shieldInstanceId: null, reason: null, ...cloneJson(input) });
  eventValues(state, event);
  if (state.logCapacity > 0) { state.log.push(event); if (state.log.length > state.logCapacity) state.log.splice(0, state.log.length - state.logCapacity); }
  const programs = input.reason?.endsWith('-cleanup') || input.reason === 'encounter-ended' ? [] : collectTriggers(state, catalog, event);
  if (preDowned) { for (const program of programs) executeQueued(state, catalog, program); } else state.queue.push(...programs);
  return event;
}
function listenerEvent(event: BattleEvent, source: InstalledSource): BattleEvent {
  if (event.kind !== 'action.committed') return event;
  const previous = source.previousCast;
  return { ...event, flags: { ...event.flags, differentCaster: previous !== null && previous.actorId !== event.actorId, differentSchool: previous !== null && previous.school !== event.school } };
}
function scopeMatches(state: BattleData, source: InstalledSource, trigger: TriggerDefinition, event: BattleEvent): boolean {
  const holder = state.entities[source.holderId]; if (!holder || !alive(state, holder.id)) return false;
  const defensive = ['shield.absorbed', 'shield.broken', 'control.ended', 'life.beforeDowned', 'life.downed'].includes(event.kind);
  const relevant = defensive ? event.targetId : event.actorId;
  if (!relevant) return false;
  if (trigger.eventScope === 'owner') return relevant === holder.id;
  return state.entities[relevant]?.team === holder.team && (alive(state, relevant) || event.kind === 'life.downed');
}
function ledgerFor(state: BattleData, sourceId: string, trigger: TriggerDefinition, targetId: string | null): TriggerLedger {
  sourceId = state.sources[sourceId]?.sharedBudgetId ?? sourceId;
  const targetKey = trigger.proc.perTarget ? targetId ?? '' : '';
  let ledger = state.triggerLedger.find(item => item.sourceInstanceId === sourceId && item.triggerId === trigger.triggerId && item.targetKey === targetKey);
  if (!ledger) { capacity(state.triggerLedger.length, 'trigger ledgers'); ledger = { sourceInstanceId: sourceId, triggerId: trigger.triggerId, targetKey, activations: 0, cooldownUntilTick: 0, roots: [] }; state.triggerLedger.push(ledger); }
  return ledger;
}
function truncate(state: BattleData, catalog: CombatContentCatalog, ctx: EvaluationContext, reason: string): void {
  const root = state.roots[ctx.provenance.rootActionId]; if (root?.exhausted) return; if (root) root.exhausted = true;
  emit(state, catalog, { kind: 'proc.truncated', actorId: ctx.holderId, targetId: ctx.targetId, reason }, { ...ctx, provenance: { ...ctx.provenance, depth: Math.min(ctx.provenance.depth, ROOT_PROC_LIMITS.maxDepth) } });
}
function collectTriggers(state: BattleData, catalog: CombatContentCatalog, event: BattleEvent): QueuedProgram[] {
  const frozen: { source: InstalledSource; trigger: TriggerDefinition; index: number; event: BattleEvent; ctx: EvaluationContext }[] = [];
  const observed: InstalledSource[] = [];
  for (const source of Object.values(state.sources)) {
    if (source.executionKind === 'committed' || !sourceActive(state, catalog, source.sourceInstanceId)) continue;
    const m = mechanics(catalog, source); if (!m) continue;
    const view = listenerEvent(event, source);
    if (event.kind === 'action.committed' && event.direct && (event.values.paidSpirit ?? 0) > 0 && event.school !== null && m.triggers.some(trigger => trigger.event === 'action.committed' && scopeMatches(state, source, trigger, event))) observed.push(source);
    for (const [index, trigger] of m.triggers.entries()) {
      if (trigger.event !== event.kind || !scopeMatches(state, source, trigger, event)) continue;
      if (!event.direct && (!event.family || !trigger.proc.allowIndirectFamilies.includes(event.family) || trigger.proc.family === event.family)) continue;
      const ctx = makeContext(state, catalog, source.holderId, provenanceOf(event), source, view);
      if (!conditionPasses(state, catalog, trigger.condition, ctx)) continue;
      frozen.push({ source: cloneJson(source), trigger, index, event: view, ctx });
    }
  }
  for (const source of observed) source.previousCast = { actorId: event.actorId, school: event.school! };
  frozen.sort((a, b) => a.trigger.priority - b.trigger.priority || compareStable(a.source.holderId, b.source.holderId) || a.source.createdSequence - b.source.createdSequence || a.index - b.index);
  const result: QueuedProgram[] = [];
  for (const item of frozen) {
    const { source, trigger, ctx } = item; const policy = trigger.proc;
    const ledger = ledgerFor(state, source.sourceInstanceId, trigger, event.targetId);
    const sourceActivations = state.triggerLedger.filter(item => item.sourceInstanceId === (source.sharedBudgetId ?? source.sourceInstanceId) && item.triggerId === trigger.triggerId).reduce((sum, item) => checkedAdd(sum, item.activations), 0);
    if (sourceActivations >= policy.maximumActivations || state.tick < ledger.cooldownUntilTick || (policy.oncePerRoot && ledger.roots.includes(event.rootActionId))) continue;
    const depth = event.depth + 1;
    if (depth > Math.min(ROOT_PROC_LIMITS.maxDepth, policy.maxDepth)) { truncate(state, catalog, ctx, 'maximum-proc-depth'); continue; }
    ledger.activations = checkedAdd(ledger.activations, 1); ledger.cooldownUntilTick = checkedAdd(state.tick, policy.internalCooldownTicks); if (policy.oncePerRoot) ledger.roots.push(event.rootActionId);
    result.push({ sourceInstanceId: source.sourceInstanceId, holderId: source.holderId, boundHolderId: source.boundHolderId, statusApplierId: ctx.statusApplierId, effects: cloneJson(trigger.effects), event: item.event, provenance: { ...provenanceOf(event), parentId: event.eventId, depth, direct: false, family: policy.family }, attackSnapshot: ctx.attackSnapshot, intentId: event.targetId, adjustments: [], effectLimit: Math.min(ROOT_PROC_LIMITS.maxDerivedEffects, policy.maxDerivedEffects) });
  }
  return result;
}
function executeQueued(state: BattleData, catalog: CombatContentCatalog, queued: QueuedProgram): void {
  if (!state.sources[queued.sourceInstanceId] || !alive(state, queued.holderId)) return;
  const ctx: EvaluationContext = { holderId: queued.holderId, boundHolderId: queued.boundHolderId, statusApplierId: queued.statusApplierId, sourceInstanceId: queued.sourceInstanceId, sourceDefinitionId: state.sources[queued.sourceInstanceId]?.sourceDefinitionId ?? null, targetId: queued.event.targetId, intentId: queued.intentId, event: queued.event, provenance: queued.provenance, attackSnapshot: queued.attackSnapshot, results: {} };
  executeProgram(state, catalog, queued.effects, ctx, queued.adjustments, queued.effectLimit);
}
function drain(state: BattleData, catalog: CombatContentCatalog): void { while (state.queue.length) { const next = state.queue.shift()!; executeQueued(state, catalog, next); } }
function amount(state: BattleData, catalog: CombatContentCatalog, spec: Amount, ctx: EvaluationContext): number {
  switch (spec.kind) {
    case 'flat': return spec.units;
    case 'stat': return checkedAdd(multiplyDivideFloor(ctx.attackSnapshot[spec.stat], spec.coefficientBps, 10_000), spec.flatUnits);
    case 'event': return Math.min(multiplyDivideFloor(ctx.event?.values[spec.field] ?? 0, spec.coefficientBps, 10_000), multiplyDivideFloor(queryStat(state, catalog, ctx.holderId, spec.capStat), spec.capBps, 10_000));
    case 'consumed': { const count = ctx.results[spec.resultKey] ?? 0; return multiplyDivideFloor(checkedAdd(multiplyDivideFloor(ctx.attackSnapshot[spec.stat], spec.coefficientPerStackBps, 10_000), spec.flatPerStackUnits), count, 1); }
  }
}
function adjustedDuration(duration: Duration, adjustments: readonly ActionAdjustment[]): Duration { return duration.kind === 'ticks' ? { kind: 'ticks', ticks: Math.max(0, checkedAdd(duration.ticks, adjustmentSum(adjustments, 'statusDurationTicks'))) } : duration; }
function owned(state: BattleData, ctx: EvaluationContext, scope: LifecycleScope, duration: Duration): SourceOwner {
  const source = ctx.sourceInstanceId ? state.sources[ctx.sourceInstanceId] : null;
  return { sourceEntityId: source?.sourceEntityId ?? ctx.holderId, sourceDefinitionId: source?.sourceDefinitionId ?? ctx.sourceDefinitionId ?? 'runtime.basic', sourceInstanceId: source?.sourceInstanceId ?? ctx.provenance.rootActionId, lifecycleScope: scope, duration: cloneJson(duration), createdSequence: source?.createdSequence ?? state.sequences.nextInstance };
}
function targetAllowed(state: BattleData, effect: EffectPrimitive, ctx: EvaluationContext, targetId: string): boolean {
  const holder = state.entities[ctx.holderId]; const target = state.entities[targetId]; if (!holder || !target) return false;
  const allied = holder.team === target.team;
  if (effect.kind === 'damage') return !allied || ctx.statusApplierId !== null; // status self denotes bearer, original attacker is distinct.
  if (['heal', 'shield', 'rescue', 'restoreResource', 'preventDowned', 'augmentNextAction', 'storeForce'].includes(effect.kind)) return allied;
  if (effect.kind === 'move') return allied && targetId !== ctx.holderId;
  if (effect.kind === 'releaseForce' || effect.kind === 'interrupt') return !allied;
  return true;
}
function interruptAction(state: BattleData, catalog: CombatContentCatalog, actorId: string, reason: string, ctx: EvaluationContext): void {
  const actor = state.entities[actorId]; const action = actor?.currentActionId ? state.actions[actor.currentActionId] : null;
  if (!actor || !action || action.state !== 'Casting') return;
  actor.reservedSpirit -= action.reservedSpirit; action.reservedSpirit = 0; action.state = reason === 'invalid-target' ? 'Invalidated' : 'Interrupted'; action.reason = reason; actor.currentActionId = null;
  emit(state, catalog, { kind: action.state === 'Invalidated' ? 'action.invalidated' : 'action.interrupted', actorId, targetId: action.targetId, reason }, { ...ctx, provenance: { ...ctx.provenance, rootActionId: action.actionId } });
}
function removeOwnedStacks(state: BattleData, catalog: CombatContentCatalog, sourceId: string, reason: string, ctx: EvaluationContext): void {
  for (const status of [...state.statuses]) {
    const remaining = status.stackSources.filter(contribution => contribution.sourceInstanceId !== sourceId);
    if (remaining.length === status.stackSources.length) continue;
    status.stackSources = remaining; status.stacks = remaining.reduce((sum, contribution) => checkedAdd(sum, contribution.stacks), 0);
    if (status.stacks === 0) removeStatus(state, catalog, status.statusInstanceId, reason, ctx);
    else { status.applierId = remaining[0]!.applierId; const owner = state.sources[status.sourceInstanceId]; if (owner) state.sources[status.sourceInstanceId] = { ...owner, sourceEntityId: status.applierId }; }
  }
}
function removeStatus(state: BattleData, catalog: CombatContentCatalog, statusId: string, reason: string, ctx: EvaluationContext): void {
  const status = state.statuses.find(item => item.statusInstanceId === statusId); if (!status) return;
  const d = definition(catalog, status.definitionId);
  state.statuses = state.statuses.filter(item => item.statusInstanceId !== statusId);
  for (const child of Object.values(state.sources).filter(item => item.parentSourceInstanceId === status.sourceInstanceId)) { if (reason === 'death' && child.executionKind === 'committed') child.parentSourceInstanceId = null; else removeSource(state, catalog, child.sourceInstanceId, reason, ctx); }
  removeOwnedStacks(state, catalog, status.sourceInstanceId, reason, ctx);
  state.modifiers = state.modifiers.filter(item => item.sourceInstanceId !== status.sourceInstanceId);
  state.augments = state.augments.filter(item => item.sourceInstanceId !== status.sourceInstanceId);
  state.shields = state.shields.filter(item => item.sourceInstanceId !== status.sourceInstanceId);
  delete state.sources[status.sourceInstanceId];
  clampHealth(state, catalog);
  emit(state, catalog, { kind: 'status.removed', actorId: status.applierId, targetId: status.holderId, statusId: status.definitionId, reason, sourceInstanceId: status.sourceInstanceId, sourceDefinitionId: status.definitionId }, ctx);
  if (d.kind === 'status' && d.actionLock === 'untilRemoved') emit(state, catalog, { kind: 'control.ended', actorId: status.applierId, targetId: status.holderId, statusId: status.definitionId, reason }, ctx);
}
function removeSource(state: BattleData, catalog: CombatContentCatalog, sourceId: string, reason: string, ctx: EvaluationContext): void {
  const source = state.sources[sourceId]; if (!source) return;
  for (const zone of [...state.zones].filter(item => item.sourceInstanceId === sourceId)) { state.zones = state.zones.filter(item => item.zoneInstanceId !== zone.zoneInstanceId); emit(state, catalog, { kind: 'zone.removed', actorId: zone.casterId, targetId: null, sourceInstanceId: sourceId, sourceDefinitionId: source.sourceDefinitionId, reason }, ctx); }
  for (const summon of [...state.summons].filter(item => item.sourceInstanceId === sourceId)) retireSummon(state, catalog, summon.entityId, reason, ctx);
  removeOwnedStacks(state, catalog, sourceId, reason, ctx);
  for (const child of Object.values(state.sources).filter(item => item.parentSourceInstanceId === sourceId)) { if (reason === 'death' && child.executionKind === 'committed') child.parentSourceInstanceId = null; else removeSource(state, catalog, child.sourceInstanceId, reason, ctx); }
  for (const status of [...state.statuses].filter(item => item.sourceInstanceId === sourceId)) removeStatus(state, catalog, status.statusInstanceId, reason, ctx);
  state.modifiers = state.modifiers.filter(item => item.sourceInstanceId !== sourceId); state.shields = state.shields.filter(item => item.sourceInstanceId !== sourceId); state.augments = state.augments.filter(item => item.sourceInstanceId !== sourceId); state.force = state.force.filter(item => item.sourceInstanceId !== sourceId); delete state.castHistory[sourceId];
  delete state.sources[sourceId];
  const holder = state.entities[source.holderId]; const d = definition(catalog, source.sourceDefinitionId);
  if (source.executionKind === 'installed' && holder && d.kind === 'skill' && !Object.values(state.sources).some(other => other.executionKind === 'installed' && other.holderId === holder.id && other.sourceDefinitionId === d.id)) { if (holder.currentActionId && state.actions[holder.currentActionId]?.skillId === d.id) interruptAction(state, catalog, holder.id, 'source-uninstalled', ctx); holder.skills = holder.skills.filter(skillId => skillId !== d.id); delete holder.cooldowns[d.id]; }
  clampHealth(state, catalog);
  emit(state, catalog, { kind: 'source.removed', actorId: source.holderId, targetId: source.holderId, sourceInstanceId: sourceId, sourceDefinitionId: source.sourceDefinitionId, reason }, ctx);
}
function die(state: BattleData, catalog: CombatContentCatalog, entityId: string, ctx: EvaluationContext): void {
  const entity = state.entities[entityId]; if (!entity || entity.life === 'Dead' || entity.deathId !== null) return;
  entity.life = 'Dead'; entity.health = 0; entity.deathId = id(state, 'instance'); interruptAction(state, catalog, entityId, 'death', ctx);
  for (const source of [...Object.values(state.sources)]) if (source.executionKind !== 'committed' && !Object.values(state.actions).some(action => action.state === 'Committed' && action.actorId === entityId && action.skillId === source.sourceDefinitionId) && (source.holderId === entityId || (source.statusInstanceId === null && source.sourceEntityId === entityId))) removeSource(state, catalog, source.sourceInstanceId, 'death', ctx);
  state.shields = state.shields.filter(shield => shield.holderId !== entityId);
  emit(state, catalog, { kind: 'life.died', actorId: ctx.statusApplierId ?? ctx.holderId, targetId: entityId, reason: entity.deathId }, ctx);
}
function downed(state: BattleData, catalog: CombatContentCatalog, entityId: string, ctx: EvaluationContext): void {
  const entity = state.entities[entityId]; if (!entity || entity.health > 0 || !alive(state, entityId)) return;
  if (entity.kind === 'summon') { const summon = state.summons.find(item => item.entityId === entityId); if (summon) removeSource(state, catalog, summon.sourceInstanceId, 'destroyed', ctx); return; }
  emit(state, catalog, { kind: 'life.beforeDowned', actorId: ctx.statusApplierId ?? ctx.holderId, targetId: entityId }, ctx, true);
  if (entity.health > 0) return;
  entity.life = 'Downed'; entity.downedCount = checkedAdd(entity.downedCount, 1); interruptAction(state, catalog, entityId, 'downed', ctx);
  emit(state, catalog, { kind: 'life.downed', actorId: ctx.statusApplierId ?? ctx.holderId, targetId: entityId }, ctx);
  if (entity.deathRule === 'immediate') die(state, catalog, entityId, ctx);
}
function damage(state: BattleData, catalog: CombatContentCatalog, targetId: string, requested: number, damageType: 'physical' | 'fire' | 'lightning' | 'poison', penetration: number, canCritical: boolean, ctx: EvaluationContext): void {
  const target = state.entities[targetId]; if (!target || !alive(state, targetId)) return;
  const attackerId = ctx.statusApplierId ?? ctx.holderId;
  let critical = false;
  if (canCritical) { const roll = drawInteger(state.random, 'combat', 0, 9999); state.random = roll.streams; critical = roll.value < ctx.attackSnapshot.criticalChanceBps; if (critical) requested = multiplyDivideFloor(requested, ctx.attackSnapshot.criticalMultiplierBps, 10_000); }
  state.statistics.requestedDamage = checkedAdd(state.statistics.requestedDamage, requested);
  const armor = damageType === 'physical' ? multiplyDivideFloor(queryStat(state, catalog, targetId, 'armor'), 10_000 - penetration, 10_000) : 0;
  const afterArmor = multiplyDivideFloor(requested, 100, checkedAdd(100, armor));
  const afterDefense = multiplyDivideFloor(afterArmor, 10_000 - queryStat(state, catalog, targetId, 'damageReductionBps'), 10_000);
  let remaining = afterDefense; let absorbed = 0;
  const flags = { enemyCaused: state.entities[attackerId]?.team !== target.team, isCritical: critical, isActive: ctx.provenance.originalTags.includes('active'), isBasic: ctx.provenance.originalTags.includes('basic'), targetAlive: true };
  for (const active of activeShields(state, targetId)) {
    const shield = state.shields.find(item => item.shieldInstanceId === active.shieldInstanceId)!;
    const used = Math.min(shield.remaining, remaining); if (used === 0) continue;
    shield.remaining -= used; remaining -= used; absorbed = checkedAdd(absorbed, used);
    emit(state, catalog, { kind: 'shield.absorbed', actorId: attackerId, targetId, shieldInstanceId: shield.shieldInstanceId, values: { requestedDamage: requested, actualShieldAbsorbed: used, afterDefense }, flags }, ctx);
    if (shield.remaining === 0 && !shield.broken) { shield.broken = true; emit(state, catalog, { kind: 'shield.broken', actorId: attackerId, targetId, shieldInstanceId: shield.shieldInstanceId, values: { actualShieldAbsorbed: used }, flags }, ctx); }
    if (remaining === 0) break;
  }
  state.shields = state.shields.filter(shield => !shield.broken);
  clampHealth(state, catalog);
  const lost = Math.min(target.health, remaining); target.health -= lost;
  if (lost > 0) {
    emit(state, catalog, { kind: 'damage.healthLost', actorId: attackerId, targetId, values: { requestedDamage: requested, afterDefense, actualShieldAbsorbed: absorbed, actualHealthLoss: lost }, flags: { ...flags, targetAlive: target.health > 0 } }, ctx);
    if (target.health === 0) downed(state, catalog, targetId, ctx);
  }
}
function applyStatus(state: BattleData, catalog: CombatContentCatalog, effect: Extract<EffectPrimitive, { kind: 'applyStatus' }>, targetId: string, ctx: EvaluationContext, adjustments: readonly ActionAdjustment[]): void {
  const d = definition(catalog, effect.statusId); if (d.kind !== 'status') throw new Error('applyStatus requires status definition');
  assertSupported(catalog, d, state.contentMode);
  let duration = adjustedDuration(effect.duration, adjustments);
  if (d.resistancePolicy === 'targetTenacity' && duration.kind === 'ticks') duration = { kind: 'ticks', ticks: multiplyDivideFloor(duration.ticks, 10_000 - queryStat(state, catalog, targetId, 'controlResistanceBps'), 10_000) };
  if (duration.kind === 'ticks' && duration.ticks === 0) return;
  const stacks = Math.max(0, checkedAdd(effect.stacks, adjustments.filter((a): a is Extract<ActionAdjustment, { kind: 'statusStacks' }> => a.kind === 'statusStacks' && a.statusId === effect.statusId).reduce((sum, item) => checkedAdd(sum, item.value), 0)));
  if (stacks === 0) return;
  const applierId = ctx.statusApplierId ?? ctx.holderId;
  const matches = state.statuses.filter(item => item.definitionId === d.id && item.holderId === targetId && (d.identity === 'definition' || item.applierId === applierId));
  const same = d.stackPolicy.kind === 'strongest' ? matches.find(item => item.applierId === applierId) : matches[0];
  const expiresAtTick = expiry(state, duration);
  if (same && (d.stackPolicy.kind === 'refresh' || d.stackPolicy.kind === 'extend' || d.stackPolicy.kind === 'strongest')) {
    const accepted = Math.min(stacks, Math.max(0, d.stackPolicy.maximumStacks - same.stacks));
    if (accepted > 0) { const contribution = same.stackSources.find(item => item.applierId === applierId && item.sourceInstanceId === ctx.sourceInstanceId); if (contribution) contribution.stacks = checkedAdd(contribution.stacks, accepted); else same.stackSources.push({ applierId, sourceInstanceId: ctx.sourceInstanceId, stacks: accepted }); }
    same.stacks = checkedAdd(same.stacks, accepted);
    if (d.stackPolicy.kind === 'extend' && duration.kind === 'ticks') same.expiresAtTick = Math.min(checkedAdd(state.tick, d.stackPolicy.maximumDurationTicks), checkedAdd(same.expiresAtTick ?? state.tick, duration.ticks));
    else if (d.stackPolicy.kind !== 'strongest' || d.stackPolicy.equalPolicy === 'refreshDuration') same.expiresAtTick = expiresAtTick;
    same.attackSnapshot = cloneJson(snapshotStats(state, catalog, applierId, ctx.provenance.originalTags)); same.provenance = cloneJson(ctx.provenance);
    emit(state, catalog, { kind: 'status.applied', actorId: applierId, targetId, statusId: d.id }, ctx); return;
  }
  const accepted = d.stackPolicy.kind === 'independent' ? Math.min(stacks, Math.max(0, d.stackPolicy.maximumStacks - matches.reduce((sum, item) => sum + item.stacks, 0))) : Math.min(stacks, d.stackPolicy.maximumStacks);
  if (accepted === 0) return;
  capacity(state.statuses.length, 'statuses'); capacity(Object.keys(state.sources).length, 'sources');
  const sourceId = id(state, 'instance'); const statusId = id(state, 'instance');
  const source: InstalledSource = { executionKind: 'installed', sourceEntityId: applierId, sourceDefinitionId: d.id, sourceInstanceId: sourceId, lifecycleScope: 'encounter', duration, createdSequence: Number(sourceId.split(':')[1]), holderId: targetId, boundHolderId: targetId, installedTick: state.tick, expiresAtTick: null, remainingNodes: null, parentSourceInstanceId: null, statusInstanceId: statusId, previousCast: null, sharedBudgetId: null };
  const magnitude = d.mechanics.onInstall.reduce((sum, primitive) => primitive.kind === 'installModifier' ? checkedAdd(sum, Math.abs(primitive.modifier.value)) : sum, 0) || ctx.attackSnapshot.attack;
  const status: StatusInstance = { statusInstanceId: statusId, sourceInstanceId: sourceId, definitionId: d.id, holderId: targetId, applierId, stacks: accepted, stackSources: [{ applierId, sourceInstanceId: ctx.sourceInstanceId, stacks: accepted }], magnitude, appliedTick: state.tick, expiresAtTick, nextPeriodicTick: d.periodicIntervalTicks > 0 ? checkedAdd(state.tick, d.periodicIntervalTicks) : null, attackSnapshot: cloneJson(snapshotStats(state, catalog, applierId, ctx.provenance.originalTags)), provenance: cloneJson(ctx.provenance) };
  state.sources[sourceId] = source; state.statuses.push(status);
  const installContext = makeContext(state, catalog, targetId, ctx.provenance, source, ctx.event); installContext.statusApplierId = applierId; installContext.attackSnapshot = ctx.attackSnapshot;
  executeProgram(state, catalog, d.mechanics.onInstall, installContext, [], null);
  if (d.actionLock === 'untilRemoved' && statusActive(state, catalog, status)) interruptAction(state, catalog, targetId, 'control', ctx);
  emit(state, catalog, { kind: 'status.applied', actorId: applierId, targetId, statusId: d.id }, ctx);
}
function consumeStatus(state: BattleData, catalog: CombatContentCatalog, effect: Extract<EffectPrimitive, { kind: 'consumeStatus' }>, targetId: string, ctx: EvaluationContext): void {
  const matches = state.statuses.filter(item => item.holderId === targetId && item.definitionId === effect.statusId && statusActive(state, catalog, item) && (effect.sourceFilter === 'any' || item.stackSources.some(source => source.applierId === ctx.holderId))).sort((a, b) => a.appliedTick - b.appliedTick || compareStable(a.sourceInstanceId, b.sourceInstanceId));
  const availableStacks = (status: StatusInstance): number => status.stackSources.filter(source => effect.sourceFilter === 'any' || source.applierId === ctx.holderId).reduce((sum, source) => checkedAdd(sum, source.stacks), 0);
  const available = matches.reduce((sum, item) => checkedAdd(sum, availableStacks(item)), 0);
  const count = available < effect.minimumStacks ? 0 : Math.min(effect.maximumStacks, available); ctx.results[effect.resultKey] = checkedAdd(ctx.results[effect.resultKey] ?? 0, count);
  if (count === 0) return;
  let remaining = count; const appliers: string[] = [];
  for (const status of matches) { const used = Math.min(remaining, availableStacks(status)); if (used === 0) continue; status.stacks -= used; remaining -= used; let sourceRemaining = used; for (const contribution of status.stackSources) { if (effect.sourceFilter === 'self' && contribution.applierId !== ctx.holderId) continue; const take = Math.min(contribution.stacks, sourceRemaining); if (take > 0) { contribution.stacks -= take; sourceRemaining -= take; if (!appliers.includes(contribution.applierId)) appliers.push(contribution.applierId); } } status.stackSources = status.stackSources.filter(item => item.stacks > 0); if (status.stacks === 0) removeStatus(state, catalog, status.statusInstanceId, 'consumed', ctx); if (remaining === 0) break; }
  emit(state, catalog, { kind: 'status.consumed', actorId: ctx.holderId, targetId, statusId: effect.statusId, consumedApplierIds: appliers.sort(compareStable), values: { consumedStacks: count }, flags: { targetAlive: alive(state, targetId), isActive: ctx.provenance.originalTags.includes('active'), isBasic: ctx.provenance.originalTags.includes('basic') } }, ctx);
}
function addShield(state: BattleData, catalog: CombatContentCatalog, effect: Extract<EffectPrimitive, { kind: 'shield' }>, targetId: string, ctx: EvaluationContext, adjustments: readonly ActionAdjustment[]): void {
  const duration = adjustedDuration(effect.duration, adjustments); if (duration.kind === 'ticks' && duration.ticks === 0) return;
  const units = multiplyDivideFloor(amount(state, catalog, effect.amount, ctx), Math.max(0, 10_000 + ctx.attackSnapshot.shieldBps), 10_000); if (units === 0) return;
  const source = owned(state, ctx, effect.lifecycleScope, duration);
  const existing = effect.stackPolicy === 'refreshSource' ? state.shields.find(item => item.holderId === targetId && item.sourceInstanceId === source.sourceInstanceId && item.stackPolicy === 'refreshSource' && !item.broken) : null;
  if (existing) { existing.remaining = units; existing.initialAmount = units; existing.expiresAtTick = expiry(state, duration); return; }
  capacity(state.shields.length, 'shields'); const shieldId = id(state, 'instance'); state.shields.push({ ...source, createdSequence: Number(shieldId.split(':')[1]), shieldInstanceId: shieldId, holderId: targetId, remaining: units, initialAmount: units, expiresAtTick: expiry(state, duration), stackPolicy: effect.stackPolicy, broken: false });
}
function effectRejected(state: BattleData, catalog: CombatContentCatalog, ctx: EvaluationContext, reason: string): void {
  emit(state, catalog, { kind: 'effect.rejected', actorId: ctx.holderId, targetId: ctx.targetId, reason }, ctx);
}
/** Launched effects have their own exact owner. Parent removal normally cascades; death
 * detaches the committed owner so the already-launched program can finish its lifetime. */
function committedSource(state: BattleData, ctx: EvaluationContext, duration: Duration): InstalledSource {
  const casterId = ctx.statusApplierId ?? ctx.holderId; const parent = ctx.sourceInstanceId ? state.sources[ctx.sourceInstanceId] : null;
  if (!ctx.sourceDefinitionId || !state.entities[casterId] || state.entities[casterId]!.kind !== 'combatant') throw new Error('Committed effect requires a primary source owner');
  capacity(Object.keys(state.sources).length, 'sources'); const sourceId = id(state, 'instance');
  const source: InstalledSource = { executionKind: 'committed', sourceEntityId: casterId, sourceDefinitionId: ctx.sourceDefinitionId, sourceInstanceId: sourceId, lifecycleScope: 'encounter', duration: cloneJson(duration), createdSequence: Number(sourceId.slice(9)), holderId: casterId, boundHolderId: casterId, installedTick: state.tick, expiresAtTick: expiry(state, duration), remainingNodes: null, parentSourceInstanceId: parent?.sourceInstanceId ?? null, statusInstanceId: null, previousCast: null, sharedBudgetId: null };
  state.sources[sourceId] = source; return source;
}
function createZone(state: BattleData, catalog: CombatContentCatalog, effect: Extract<EffectPrimitive, { kind: 'zone' }>, targetId: string, ctx: EvaluationContext, adjustments: readonly ActionAdjustment[]): void {
  if (!state.arena) { effectRejected(state, catalog, ctx, 'arena-unbound'); return; }
  if (effect.duration.kind === 'ticks' && effect.duration.ticks === 0) return;
  if (ctx.provenance.depth >= ROOT_PROC_LIMITS.maxDepth) { truncate(state, catalog, ctx, 'maximum-zone-depth'); return; }
  if (state.zones.length >= MAX_BATTLE_ZONES) { effectRejected(state, catalog, ctx, 'zone-capacity'); return; }
  const source = committedSource(state, ctx, effect.duration); const zoneInstanceId = id(state, 'instance');
  state.zones.push({ zoneInstanceId, sourceInstanceId: source.sourceInstanceId, casterId: source.holderId, anchor: { ...state.entities[targetId]!.position }, radiusUnits: Math.max(0, checkedAdd(effect.radiusUnits, adjustmentSum(adjustments, 'areaRadiusUnits'))), createdTick: state.tick, expiresAtTick: source.expiresAtTick, nextPeriodicTick: checkedAdd(state.tick, effect.intervalTicks), effect: cloneJson(effect), adjustments: cloneJson(adjustments), attackSnapshot: cloneJson(ctx.attackSnapshot), provenance: cloneJson(ctx.provenance), intentId: targetId });
  emit(state, catalog, { kind: 'zone.created', actorId: source.holderId, targetId, sourceInstanceId: source.sourceInstanceId }, ctx);
}
function createSummon(state: BattleData, catalog: CombatContentCatalog, effect: Extract<EffectPrimitive, { kind: 'summon' }>, ctx: EvaluationContext): void {
  const casterId = ctx.statusApplierId ?? ctx.holderId; const caster = state.entities[casterId]; const d = definition(catalog, effect.summonId);
  if (!caster || caster.kind !== 'combatant' || d.kind !== 'summon' || effect.duration.kind !== 'ticks' || effect.duration.ticks < 1) throw new Error('Invalid summon program');
  const previous = state.summons.find(item => item.casterId === casterId); const position = summonPlacement(state, casterId, previous?.entityId ?? null);
  if (!position) { effectRejected(state, catalog, ctx, state.arena ? 'summon-placement-blocked' : 'arena-unbound'); return; }
  if (previous) removeSource(state, catalog, previous.sourceInstanceId, 'replaced', ctx);
  const source = committedSource(state, ctx, effect.duration); const entityId = id(state, 'entity').replace('entity:', 'summon:');
  const health = Math.max(1, multiplyDivideFloor(ctx.attackSnapshot.maxHealth, d.healthCoefficientBps, 10_000));
  state.entities[entityId] = { id: entityId, kind: 'summon', team: caster.team, position, baseStats: { ...STAT_DEFAULTS, maxHealth: health }, health, spirit: 0, maximumSpirit: 0, reservedSpirit: 0, life: 'Alive', recoveryUntilTick: 0, deathRule: 'immediate', deathId: null, downedCount: 0, skills: [], cooldowns: {}, currentActionId: null, lastCommittedTick: 0, basic: { coefficientBps: 0, cooldownTicks: 0, castTicks: 0, rangeUnits: 0, school: ctx.provenance.school ?? 'talisman' } };
  state.statistics.byEntity[entityId] = { damage: 0, absorbed: 0, healing: 0, kills: 0 };
  state.summons.push({ entityId, sourceInstanceId: source.sourceInstanceId, casterId, definitionId: d.id, createdTick: state.tick, expiresAtTick: source.expiresAtTick!, casterMaxHealth: ctx.attackSnapshot.maxHealth, role: d.role });
  emit(state, catalog, { kind: 'summon.created', actorId: casterId, targetId: entityId, sourceInstanceId: source.sourceInstanceId, sourceDefinitionId: d.id }, ctx);
}
function retireSummon(state: BattleData, catalog: CombatContentCatalog, entityId: string, reason: string, ctx: EvaluationContext): void {
  const summon = state.summons.find(item => item.entityId === entityId); if (!summon) return;
  state.summons = state.summons.filter(item => item.entityId !== entityId);
  for (const action of Object.values(state.actions)) if (action.state === 'Casting' && action.targetId === entityId) interruptAction(state, catalog, action.actorId, 'invalid-target', ctx);
  for (const source of [...Object.values(state.sources)]) if (source.holderId === entityId) removeSource(state, catalog, source.sourceInstanceId, 'summon-cleanup', ctx);
  state.shields = state.shields.filter(item => item.holderId !== entityId); state.modifiers = state.modifiers.filter(item => item.holderId !== entityId); state.force = state.force.filter(item => item.holderId !== entityId);
  for (const charge of state.augments) charge.recipientIds = charge.recipientIds.filter(id => id !== entityId);
  state.augments = state.augments.filter(item => item.recipientIds.length > 0);
  for (const [team, focus] of Object.entries(state.focusByTeam)) if (focus === entityId) delete state.focusByTeam[team];
  for (const ledger of [...state.triggerLedger].filter(item => item.targetKey === entityId)) {
    const aggregate = state.triggerLedger.find(item => item !== ledger && item.sourceInstanceId === ledger.sourceInstanceId && item.triggerId === ledger.triggerId && item.targetKey === RETIRED_SUMMON_TARGET);
    if (aggregate) { aggregate.activations = checkedAdd(aggregate.activations, ledger.activations); state.triggerLedger = state.triggerLedger.filter(item => item !== ledger); }
    else { ledger.targetKey = RETIRED_SUMMON_TARGET; ledger.cooldownUntilTick = 0; ledger.roots = []; }
  }
  emit(state, catalog, { kind: 'summon.removed', actorId: summon.casterId, targetId: entityId, sourceInstanceId: summon.sourceInstanceId, sourceDefinitionId: summon.definitionId, reason }, ctx);
  delete state.entities[entityId]; delete state.statistics.byEntity[entityId]; // Cumulative global damage/absorption totals remain authoritative.
}
function executeProgram(state: BattleData, catalog: CombatContentCatalog, effects: readonly EffectPrimitive[], ctx: EvaluationContext, adjustments: readonly ActionAdjustment[], effectLimit: number | null): void {
  if (effectLimit !== null && ctx.provenance.depth > ROOT_PROC_LIMITS.maxDepth) { truncate(state, catalog, ctx, 'maximum-proc-depth'); return; }
  for (const effect of effects) {
    if (effectLimit !== null) {
      const root = state.roots[ctx.provenance.rootActionId]; if (!root) throw new Error('Missing root budget');
      if (root.derivedEffects >= Math.min(ROOT_PROC_LIMITS.maxDerivedEffects, effectLimit)) { truncate(state, catalog, ctx, 'maximum-derived-effects'); continue; }
      root.derivedEffects = checkedAdd(root.derivedEffects, 1);
    }
    if (effect.kind === 'consumeStatus') ctx.results[effect.resultKey] = 0;
    let selector = effect.target;
    if (selector.kind === 'area') selector = { ...selector, radiusUnits: Math.max(0, checkedAdd(selector.radiusUnits, adjustmentSum(adjustments, 'areaRadiusUnits'))) };
    const chains = adjustmentSum(adjustments, 'additionalChainTargets');
    if (selector.kind === 'chain') selector = { ...selector, jumps: Math.max(0, checkedAdd(selector.jumps, chains)) };
    if (chains > 0 && selector.kind === 'intent' && (effect.kind === 'damage' || effect.kind === 'applyStatus')) selector = { kind: 'chain', team: 'enemy', start: 'intent', jumps: chains, maxRangeUnits: 600 };
    const targets = selectTargets(state, catalog, selector, ctx, effect.kind === 'rescue').filter(targetId => targetAllowed(state, effect, ctx, targetId) && conditionPasses(state, catalog, effect.condition, { ...ctx, targetId }) && (!ctx.spatialAnchor || ctx.spatialRadiusUnits === undefined || (state.entities[targetId]!.position.x - ctx.spatialAnchor.x) ** 2 + (state.entities[targetId]!.position.y - ctx.spatialAnchor.y) ** 2 <= ctx.spatialRadiusUnits ** 2));
    if (effect.kind === 'augmentNextAction') {
      if (effect.adjustment.kind === 'additionalChainTargets' && effect.adjustment.staggerTicks !== 0) throw new Error('Unsupported adjustment: additionalChainTargets.staggerTicks');
      if (targets.length > 0) { capacity(state.augments.length, 'charges'); const chargeId = id(state, 'instance'); state.augments.push({ ...owned(state, ctx, state.sources[ctx.sourceInstanceId ?? '']?.lifecycleScope ?? 'encounter', effect.duration), chargeId, recipientIds: targets, tags: cloneJson(effect.tags), uses: effect.uses, expiresAtTick: expiry(state, effect.duration), adjustment: cloneJson(effect.adjustment) }); }
      continue;
    }
    for (const targetId of targets) {
      const target = state.entities[targetId]; if (!target || !alive(state, targetId) && !(effect.kind === 'rescue' && target.life === 'Downed')) continue; const targetCtx = { ...ctx, targetId };
      switch (effect.kind) {
        case 'move': {
          const actor = state.entities[ctx.holderId]; const destination = actor && canAct(state, catalog, actor.id) && !actor.currentActionId ? allyMovementDestination(state, actor.id, targetId, effect.maximumDistanceUnits) : null;
          if (!destination) effectRejected(state, catalog, targetCtx, 'movement-unavailable');
          else { actor!.position = destination; emit(state, catalog, { kind: 'entity.moved', actorId: actor!.id, targetId }, targetCtx); } break;
        }
        case 'zone': createZone(state, catalog, effect, targetId, targetCtx, adjustments); break;
        case 'summon': createSummon(state, catalog, effect, targetCtx); break;
        case 'damage': { const stackCount = ctx.provenance.family === 'periodic' ? state.statuses.find(item => item.sourceInstanceId === ctx.sourceInstanceId)?.stacks ?? 1 : 1; const base = multiplyDivideFloor(amount(state, catalog, effect.amount, ctx), stackCount, 1); const units = multiplyDivideFloor(base, Math.max(0, checkedAdd(10_000, adjustmentSum(adjustments, 'bonusDamageBps'))), 10_000); damage(state, catalog, targetId, units, effect.damageType, effect.armorPenetrationBps, effect.canCritical, targetCtx); break; }
        case 'heal': {
          const requested = multiplyDivideFloor(amount(state, catalog, effect.amount, ctx), Math.max(0, checkedAdd(10_000, ctx.attackSnapshot.healingBps)), 10_000);
          const effective = Math.min(requested, Math.max(0, queryStat(state, catalog, targetId, 'maxHealth') - target.health)); target.health = checkedAdd(target.health, effective);
          emit(state, catalog, { kind: 'healing.resolved', actorId: ctx.holderId, targetId, values: { requestedHealing: requested, effectiveHealing: effective, overhealing: requested - effective }, flags: { targetAlive: true } }, targetCtx); break;
        }
        case 'shield': addShield(state, catalog, effect, targetId, targetCtx, adjustments); break;
        case 'applyStatus': applyStatus(state, catalog, effect, targetId, targetCtx, adjustments); break;
        case 'consumeStatus': consumeStatus(state, catalog, effect, targetId, ctx); break;
        case 'restoreResource': target.spirit = Math.min(target.maximumSpirit, checkedAdd(target.spirit, effect.units)); break;
        case 'installModifier': {
          if (!ctx.sourceInstanceId || !state.sources[ctx.sourceInstanceId]) throw new Error('Modifier installation requires owned source');
          const existing = state.modifiers.find(item => item.holderId === targetId && item.sourceInstanceId === ctx.sourceInstanceId && item.modifier.modifierId === effect.modifier.modifierId);
          if (existing) { existing.modifier = cloneJson(effect.modifier); existing.expiresAtTick = expiry(state, effect.modifier.duration); existing.installedTick = state.tick; }
          else { capacity(state.modifiers.length, 'modifiers'); state.modifiers.push({ sourceInstanceId: ctx.sourceInstanceId, holderId: targetId, modifier: cloneJson(effect.modifier), expiresAtTick: expiry(state, effect.modifier.duration), installedTick: state.tick }); }
          target.health = Math.min(target.health, queryStat(state, catalog, targetId, 'maxHealth')); break;
        }
        case 'dispel': {
          const count = Math.max(0, checkedAdd(effect.count, adjustmentSum(adjustments, 'dispelCount')));
          const candidates = state.statuses.filter(item => { if (item.holderId !== targetId) return false; const d = definition(catalog, item.definitionId); return d.kind === 'status' && (d.dispelCategory === effect.category || (effect.category === 'debuff' && ['poison', 'control'].includes(d.dispelCategory))); }).sort((a, b) => a.appliedTick - b.appliedTick || compareStable(a.sourceInstanceId, b.sourceInstanceId));
          for (const candidate of candidates.slice(0, count)) removeStatus(state, catalog, candidate.statusInstanceId, 'dispelled', targetCtx); break;
        }
        case 'interrupt': if (checkedAdd(effect.strength, adjustmentSum(adjustments, 'interruptStrength')) > 0) interruptAction(state, catalog, targetId, 'interrupted', targetCtx); break;
        case 'preventDowned': if (ctx.event?.kind === 'life.beforeDowned' && ctx.event.targetId === targetId && target.health === 0 && alive(state, targetId)) target.health = Math.max(1, multiplyDivideFloor(queryStat(state, catalog, targetId, 'maxHealth'), effect.healthFloorBps, 10_000)); break;
        case 'rescue': if (target.life === 'Downed' && target.deathId === null) { target.life = 'Recovered'; target.health = Math.max(1, multiplyDivideFloor(queryStat(state, catalog, targetId, 'maxHealth'), effect.healthBps, 10_000)); target.recoveryUntilTick = checkedAdd(state.tick, effect.recoveryLockTicks); emit(state, catalog, { kind: 'life.recovered', actorId: ctx.holderId, targetId }, targetCtx); } break;
        case 'storeForce': {
          if (ctx.event?.kind !== 'shield.absorbed' || !ctx.event.flags.enemyCaused || ctx.event.targetId !== targetId || !ctx.sourceInstanceId) break;
          const cap = multiplyDivideFloor(queryStat(state, catalog, targetId, 'maxHealth'), effect.maximumHealthBps, 10_000);
          const stored = state.force.filter(item => item.holderId === targetId).reduce((sum, item) => checkedAdd(sum, item.units), 0);
          const units = Math.min(Math.max(0, cap - stored), multiplyDivideFloor(ctx.event.values.actualShieldAbsorbed ?? 0, effect.coefficientBps, 10_000));
          if (units > 0) { const entry = state.force.find(item => item.sourceInstanceId === ctx.sourceInstanceId && item.holderId === targetId); if (entry) entry.units = checkedAdd(entry.units, units); else state.force.push({ sourceInstanceId: ctx.sourceInstanceId, holderId: targetId, units }); } break;
        }
        case 'releaseForce': {
          const entries = state.force.filter(item => item.holderId === ctx.holderId); const stored = entries.reduce((sum, item) => checkedAdd(sum, item.units), 0);
          const accepted = Math.min(stored, multiplyDivideFloor(queryStat(state, catalog, ctx.holderId, 'maxHealth'), effect.maximumHealthBps, 10_000)); if (accepted === 0) break;
          let remainder = accepted; for (const entry of entries) { const take = Math.min(entry.units, remainder); entry.units -= take; remainder -= take; if (remainder === 0) break; } state.force = state.force.filter(item => item.units > 0);
          emit(state, catalog, { kind: 'force.released', actorId: ctx.holderId, targetId, values: { forceUnits: accepted } }, targetCtx);
          damage(state, catalog, targetId, multiplyDivideFloor(accepted, effect.coefficientBps, 10_000), effect.damageType, 0, false, targetCtx); break;
        }
        case 'recordCast': {
          const event = ctx.event; if (!ctx.sourceInstanceId || event?.kind !== 'action.committed' || !event.direct || !event.flags.isActive || (event.values.paidSpirit ?? 0) <= 0 || event.school === null) break;
          const records = (state.castHistory[ctx.sourceInstanceId] ?? []).filter(record => record.tick > state.tick - effect.windowTicks);
          if (records.some(record => record.actionId === event.rootActionId)) break;
          records.push({ actionId: event.rootActionId, actorId: event.actorId, school: event.school, tick: state.tick, rootActionId: event.rootActionId, parentId: event.parentId });
          state.castHistory[ctx.sourceInstanceId] = records.slice(-effect.maximumRecords); const saved = state.castHistory[ctx.sourceInstanceId]!;
          emit(state, catalog, { kind: 'castHistory.recorded', actorId: ctx.holderId, targetId, values: { distinctCasterCount: new Set(saved.map(record => record.actorId)).size, distinctSchoolCount: new Set(saved.map(record => record.school)).size } }, targetCtx); break;
        }
      }
    }
  }
}
function install(state: BattleData, catalog: CombatContentCatalog, holderId: string, definitionId: string, options: SourceInstallOptions): string {
  const holder = state.entities[holderId]; if (!holder || holder.kind === 'summon' || !alive(state, holderId)) throw new Error('Cannot install on unavailable holder');
  const d = definition(catalog, definitionId); assertSupported(catalog, d, state.contentMode);
  if (!('mechanics' in d) || d.kind === 'status') throw new Error('Expected skill, talent, or tree node source');
  if (d.kind === 'skill' && !holder.skills.includes(d.id)) holder.skills.push(d.id);
  const boundHolderId = options.boundHolderId ?? holderId;
  if (!state.entities[boundHolderId] || state.entities[boundHolderId]!.team !== holder.team) throw new Error('Invalid source recipient binding');
  if (d.kind === 'talent' && d.recipientBinding === 'selectedTalisman' && !state.entities[boundHolderId]!.skills.some(skillId => { const skill = definition(catalog, skillId); return skill.kind === 'skill' && skill.school === 'talisman'; })) throw new Error('Recipient binding requires a talisman skill holder');
  capacity(Object.keys(state.sources).length, 'sources'); const sourceId = id(state, 'instance'); const duration = options.duration ?? infinite;
  let sharedBudgetId: string | null = null;
  if (d.kind === 'talent' && d.holderScope === 'team') { const key = `${holder.team}::${d.id}`; const existing = state.teamBudgets[key]; sharedBudgetId = existing?.budgetId ?? id(state, 'instance'); if (!existing) state.teamBudgets[key] = { budgetId: sharedBudgetId, definitionId: d.id, team: holder.team }; }
  const source: InstalledSource = { executionKind: 'installed', sourceEntityId: holderId, sourceDefinitionId: definitionId, sourceInstanceId: sourceId, lifecycleScope: options.lifecycleScope ?? d.lifecycleScope, duration: cloneJson(duration), createdSequence: Number(sourceId.split(':')[1]), holderId, boundHolderId, installedTick: state.tick, expiresAtTick: expiry(state, duration), remainingNodes: duration.kind === 'nodes' ? duration.nodes : null, parentSourceInstanceId: null, statusInstanceId: null, previousCast: null, sharedBudgetId };
  state.sources[sourceId] = source; const provenance = newRoot(state, holderId, d.tags); const ctx = makeContext(state, catalog, holderId, provenance, source);
  executeProgram(state, catalog, d.mechanics.onInstall, ctx, [], null); emit(state, catalog, { kind: 'source.installed', actorId: holderId, targetId: holderId }, ctx); return sourceId;
}
function actionAdjustments(state: BattleData, catalog: CombatContentCatalog, actorId: string, tags: readonly CombatTag[], targetId: string, root: Provenance) {
  return cloneJson(collectActionAdjustments(state, catalog, actorId, tags, targetId, root));
}
function canAct(state: BattleData, catalog: CombatContentCatalog, actorId: string): boolean { return actorActionBlock(state, catalog, actorId) === null; }
function legalIntent(state: BattleData, actorId: string, targetId: string, team: BattleAction['targetTeam'], range: number, allowDowned = false): boolean { return actionTargetBlock(state, actorId, targetId, team, range, allowDowned) === null; }
function actionRoot(action: BattleAction): Provenance { return { rootActionId: action.actionId, parentId: null, depth: 0, family: null, direct: true, originalTags: action.tags, originalActorId: action.actorId, school: action.school }; }
function commit(state: BattleData, catalog: CombatContentCatalog, action: BattleAction): void {
  if (action.state !== 'Casting') return;
  const actor = state.entities[action.actorId]!; const root = actionRoot(action); const source = Object.values(state.sources).find(item => item.executionKind === 'installed' && item.holderId === actor.id && item.sourceDefinitionId === action.skillId) ?? null;
  const ctx = makeContext(state, catalog, actor.id, root, source); ctx.intentId = action.targetId; ctx.targetId = action.targetId; ctx.attackSnapshot = action.attackSnapshot;
  const d = action.skillId === 'runtime.basic' ? null : definition(catalog, action.skillId);
  const active = d?.kind === 'skill' && d.activation === 'active' ? d.action : null;
  const current = actionAdjustments(state, catalog, actor.id, action.tags, action.targetId, root);
  const cost = costAfter(active?.spiritCostUnits ?? 0, current.adjustments);
  const range = Math.max(0, checkedAdd(active?.rangeUnits ?? actor.basic.rangeUnits, adjustmentSum(current.adjustments, 'rangeUnits')));
  if (!canAct(state, catalog, actor.id) || !legalIntent(state, actor.id, action.targetId, action.targetTeam, range, action.effects.some(effect => effect.kind === 'rescue')) || actor.spirit - (actor.reservedSpirit - action.reservedSpirit) < cost || (active && !conditionPasses(state, catalog, active.condition, ctx))) { interruptAction(state, catalog, actor.id, 'invalid-target', ctx); return; }
  actor.reservedSpirit -= action.reservedSpirit; action.reservedSpirit = 0; actor.spirit -= cost; action.paidSpirit = cost; action.state = 'Committed'; action.adjustments = current.adjustments; action.chargeIds = current.chargeIds; action.rangeUnits = range;
  actor.cooldowns[action.skillId] = checkedAdd(state.tick, action.cooldownTicks); actor.currentActionId = null;
  for (const chargeId of current.chargeIds) { const charge = state.augments.find(item => item.chargeId === chargeId); if (charge) charge.uses--; } state.augments = state.augments.filter(item => item.uses > 0);
  const idleTicks = state.tick - actor.lastCommittedTick; actor.lastCommittedTick = state.tick;
  const event = emit(state, catalog, { kind: 'action.committed', actorId: actor.id, targetId: action.targetId, values: { paidSpirit: cost, idleTicks }, flags: { isActive: action.tags.includes('active'), isBasic: action.tags.includes('basic'), targetAlive: true } }, ctx);
  ctx.event = event;
  executeProgram(state, catalog, action.effects, ctx, action.adjustments, null);
  action.state = 'Complete'; if (actor.life === 'Dead' && source && state.sources[source.sourceInstanceId]) removeSource(state, catalog, source.sourceInstanceId, 'death', ctx); emit(state, catalog, { kind: 'action.complete', actorId: actor.id, targetId: action.targetId }, ctx); drain(state, catalog);
}
function reject(state: BattleData, catalog: CombatContentCatalog, actorId: string, reason: string, targetId: string | null = null): void {
  const holderId = state.entities[actorId] ? actorId : Object.keys(state.entities).sort(compareStable)[0]!;
  const ctx = makeContext(state, catalog, holderId, newRoot(state, holderId));
  emit(state, catalog, { kind: 'command.rejected', actorId, targetId, reason }, ctx);
}
function validateArenaEntities(state: BattleState, arena: BattleArena): void {
  validateBattleArena(arena); const occupied = new Set<string>();
  for (const entity of Object.values(state.entities)) { if (!arenaWalkable(arena, entity.position)) throw new Error('Battle entity is outside the walkable arena grid'); const key = `${entity.position.x},${entity.position.y}`; if (entity.life !== 'Dead') { if (occupied.has(key)) throw new Error('Battle entities overlap'); occupied.add(key); } }
}
/** Arena geometry is bound once. Controller config and runtime must carry equal geometry. */
export function bindBattleArena(previous: BattleState, catalog: CombatContentCatalog, arena: BattleArena): BattleState {
  assertCatalog(previous, catalog); validateArenaEntities(previous, arena);
  if (previous.arena) { if (canonicalStringify(previous.arena) !== canonicalStringify(arena)) throw new Error('Battle arena mismatch'); return previous; }
  const state = draft(previous); state.arena = cloneJson(arena); return finishBattle(state, catalog);
}
/** Admission order: allocate every entity, then install each entity's skills and sources in
 * input order. Synchronous onInstall programs run once per installation. After all installs,
 * resolve omitted/full or ratio health in entity order, then drain queued triggers and clamp.
 * Health initialization changes neither base stats nor healing events/statistics. Explicit
 * absolute health retains its existing base-max validation and final derived-max clamp. */
export function createBattle(catalog: CombatContentCatalog, options: BattleOptions): BattleState {
  if (!options.entities.length || options.entities.length > MAX_ENTITIES) throw new Error('Battle requires 1–72 entities');
  const logCapacity = options.logCapacity ?? 256; assertNonNegativeInteger(logCapacity, 'logCapacity'); if (logCapacity > 10_000) throw new Error('Maximum display log capacity is 10000');
  const state: BattleData = { snapshotVersion: BATTLE_SNAPSHOT_VERSION, simulationVersion: BATTLE_SIMULATION_VERSION, contentVersion: catalog.contentVersion, catalogHash: catalogFingerprint(catalog), contentMode: options.contentMode ?? 'verified', tick: 0, ended: false, arena: options.arena ? cloneJson(options.arena) : null, zones: [], summons: [], sequences: createSequences(), random: createRandomStreams(options.seed), entities: {}, sources: {}, modifiers: [], shields: [], statuses: [], actions: {}, augments: [], force: [], castHistory: {}, triggerLedger: [], teamBudgets: {}, roots: {}, queue: [], focusByTeam: {}, logCapacity, log: [], statistics: { eventCount: 0, requestedDamage: 0, shieldAbsorbed: 0, healthLost: 0, requestedHealing: 0, effectiveHealing: 0, overhealing: 0, committedActions: 0, downed: 0, recovered: 0, deaths: 0, rejectedCommands: 0, truncatedProcs: 0, byEntity: {} } };
  for (const input of options.entities) if (input.id !== undefined) { if (!/^entity:[1-9]\d*$/.test(input.id)) throw new Error('Invalid entity ID'); const number = Number(input.id.slice(7)); assertNonNegativeInteger(number, 'entity ID'); state.sequences.nextEntity = Math.max(state.sequences.nextEntity, checkedAdd(number, 1)); }
  const allocated: string[] = [];
  for (const input of options.entities) {
    const entityId = input.id ?? id(state, 'entity'); if (state.entities[entityId]) throw new Error('Duplicate entity ID'); allocated.push(entityId);
    if (!input.team || input.team.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(input.team)) throw new Error('Invalid team');
    for (const value of Object.values(input.position)) if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000) throw new Error('Invalid position');
    const stats = { ...STAT_DEFAULTS, ...input.stats };
    for (const value of Object.values(stats)) if (!Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000) throw new Error('Invalid combat stat');
    if (stats.maxHealth < 1 || stats.attack < 0) throw new Error('Invalid health/attack');
    if (input.healthRatioBps !== undefined) {
      if (input.health !== undefined) throw new Error('Initial health and healthRatioBps are mutually exclusive');
      if (!Number.isSafeInteger(input.healthRatioBps) || input.healthRatioBps < 1 || input.healthRatioBps > 10_000) throw new RangeError('healthRatioBps must be an integer from 1 to 10000');
    }
    const maximumSpirit = input.maximumSpirit ?? 100; const spirit = input.spirit ?? maximumSpirit; const health = input.health ?? stats.maxHealth;
    for (const value of [maximumSpirit, spirit, health]) assertNonNegativeInteger(value, 'entity resource');
    if (spirit > maximumSpirit || health < 1 || health > stats.maxHealth) throw new Error('Invalid initial resources');
    const basic = input.basic ?? { coefficientBps: 10_000, cooldownTicks: 20, castTicks: 0, rangeUnits: 160, school: 'sword' };
    for (const value of [basic.coefficientBps, basic.cooldownTicks, basic.castTicks, basic.rangeUnits]) assertNonNegativeInteger(value, 'basic action');
    state.entities[entityId] = { id: entityId, kind: 'combatant', team: input.team, position: cloneJson(input.position), baseStats: cloneJson(stats), health, spirit, maximumSpirit, reservedSpirit: 0, life: 'Alive', recoveryUntilTick: 0, deathRule: input.deathRule ?? 'downed', deathId: null, downedCount: 0, skills: [...new Set(input.skills ?? [])], cooldowns: {}, currentActionId: null, lastCommittedTick: 0, basic: cloneJson(basic) };
    state.statistics.byEntity[entityId] = { damage: 0, absorbed: 0, healing: 0, kills: 0 };
  }
  if (state.arena) validateArenaEntities(state, state.arena);
  for (const [index, input] of options.entities.entries()) {
    const entityId = allocated[index]!;
    const sources = (input.sources ?? []).map(source => typeof source === 'string' ? { definitionId: source, options: undefined } : source);
    const skillOptions = new Map<string, SourceInstallOptions>();
    for (const source of sources) {
      if (!source || typeof source.definitionId !== 'string') throw new Error('Invalid initial source');
      if (source.options !== undefined && (source.options === null || typeof source.options !== 'object' || Array.isArray(source.options))) throw new Error('Invalid source install options');
      if (source.options !== undefined && (input.skills ?? []).includes(source.definitionId)) {
        if (skillOptions.has(source.definitionId)) throw new Error('Duplicate initial skill source options');
        skillOptions.set(source.definitionId, source.options);
      }
    }
    for (const skillId of input.skills ?? []) { const skill = definition(catalog, skillId); if (skill.kind !== 'skill') throw new Error('Entity skills must reference skill definitions'); install(state, catalog, entityId, skillId, skillOptions.get(skillId) ?? {}); }
    for (const source of sources) if (!(input.skills ?? []).includes(source.definitionId)) install(state, catalog, entityId, source.definitionId, source.options ?? {});
  }
  for (const [index, input] of options.entities.entries()) if (input.health === undefined) {
    const maximumHealth = queryStat(state, catalog, allocated[index]!, 'maxHealth');
    state.entities[allocated[index]!]!.health = input.healthRatioBps === undefined ? maximumHealth : Math.max(1, multiplyDivideFloor(maximumHealth, input.healthRatioBps, 10_000));
  }
  drain(state, catalog); return finishBattle(state, catalog);
}
export function issueCommand(previous: BattleState, catalog: CombatContentCatalog, command: BattleCommand): BattleState {
  assertCatalog(previous, catalog); const state = draft(previous);
  const actor = state.entities[command.actorId];
  if (command.kind === 'clearFocus' && actor) { delete state.focusByTeam[actor.team]; return finishBattle(state, catalog); }
  if (state.ended || !actor || !canAct(state, catalog, command.actorId)) { reject(state, catalog, command.actorId, state.ended ? 'battle-ended' : 'actor-unavailable'); return finishBattle(state, catalog); }
  if (command.kind === 'cast' || command.kind === 'basic') {
    if (actor.currentActionId) { reject(state, catalog, actor.id, 'actor-casting', command.targetId); return finishBattle(state, catalog); }
    let skillId: string; let tags: readonly CombatTag[]; let school: BattleAction['school']; let effects: readonly EffectPrimitive[]; let castTicks: number; let rangeUnits: number; let cost: number; let cooldownTicks: number; let targetTeam: BattleAction['targetTeam'];
    if (command.kind === 'basic') {
      skillId = 'runtime.basic'; school = actor.basic.school; tags = [school, 'basic', 'damage', 'physical']; cost = 0; cooldownTicks = actor.basic.cooldownTicks; castTicks = actor.basic.castTicks; rangeUnits = actor.basic.rangeUnits; targetTeam = 'enemy';
      effects = [{ kind: 'damage', target: intent, condition: always, amount: { kind: 'stat', stat: 'attack', coefficientBps: actor.basic.coefficientBps, flatUnits: 0 }, damageType: 'physical', tags: ['physical', 'basic'], armorPenetrationBps: 0, attackRead: 'castSnapshot', defenseRead: 'hitLive', rounding: 'floor', canCritical: true }];
    } else {
      if (!actor.skills.includes(command.skillId)) { reject(state, catalog, actor.id, 'unknown-skill', command.targetId); return finishBattle(state, catalog); }
      const d = definition(catalog, command.skillId); if (d.kind !== 'skill' || d.activation !== 'active') { reject(state, catalog, actor.id, 'not-active-skill', command.targetId); return finishBattle(state, catalog); }
      assertSupported(catalog, d, state.contentMode); skillId = d.id; school = d.school; tags = d.tags; effects = d.action.effects; cost = d.action.spiritCostUnits; cooldownTicks = d.action.cooldownTicks; castTicks = d.action.castTicks; rangeUnits = d.action.rangeUnits; targetTeam = d.action.targetTeam;
    }
    const readiness = queryCastReadiness(state, catalog, actor.id, command.kind === 'cast' ? command.skillId : null, command.targetId);
    if (!readiness.ready) { reject(state, catalog, actor.id, readiness.reason === 'cooldown' ? 'cooldown' : 'invalid-intent-or-resource', command.targetId); return finishBattle(state, catalog); }
    rangeUnits = readiness.rangeUnits; cost = readiness.spiritCostUnits; castTicks = readiness.castTicks;
    const root = newRoot(state, actor.id, tags); root.school = school;
    const current = actionAdjustments(state, catalog, actor.id, tags, command.targetId, root);
    const ctx = makeContext(state, catalog, actor.id, root); ctx.intentId = command.targetId; ctx.targetId = command.targetId;
    const action: BattleAction = { actionId: root.rootActionId, actorId: actor.id, skillId, targetId: command.targetId, requestTick: state.tick, castEndTick: checkedAdd(state.tick, castTicks), state: 'Casting', reservedSpirit: cost, paidSpirit: 0, cooldownTicks, rangeUnits, targetTeam, attackSnapshot: snapshotStats(state, catalog, actor.id, tags), tags: cloneJson(tags), school, adjustments: current.adjustments, chargeIds: current.chargeIds, effects: cloneJson(effects), reason: null };
    state.actions[action.actionId] = action; actor.currentActionId = action.actionId; actor.reservedSpirit = checkedAdd(actor.reservedSpirit, cost); emit(state, catalog, { kind: 'action.reserved', actorId: actor.id, targetId: command.targetId }, ctx);
    if (action.castEndTick <= state.tick) commit(state, catalog, action);
  } else {
    const ctx = makeContext(state, catalog, actor.id, newRoot(state, actor.id));
    if (command.kind === 'cancel' || command.kind === 'clearFocus') interruptAction(state, catalog, actor.id, 'cancelled', ctx);
    else if (!state.entities[command.targetId]) reject(state, catalog, actor.id, 'unknown-target', command.targetId);
    else if (command.kind === 'focus') { if (alive(state, command.targetId) && state.entities[command.targetId]!.team !== actor.team) state.focusByTeam[actor.team] = command.targetId; else reject(state, catalog, actor.id, 'invalid-focus', command.targetId); }
    else if (command.kind === 'guard') { if (alive(state, command.targetId) && state.entities[command.targetId]!.team === actor.team) emit(state, catalog, { kind: 'command.guard', actorId: actor.id, targetId: command.targetId }, ctx); else reject(state, catalog, actor.id, 'invalid-guard', command.targetId); }
    else if (command.kind === 'interrupt') { assertNonNegativeInteger(command.strength, 'interrupt strength'); if (command.strength > 0 && state.entities[command.targetId]!.team !== actor.team) interruptAction(state, catalog, command.targetId, 'interrupted', ctx); else reject(state, catalog, actor.id, 'invalid-interrupt', command.targetId); }
    else if (command.kind === 'finishDowned') { if (state.entities[command.targetId]!.life === 'Downed' && state.entities[command.targetId]!.team !== actor.team) die(state, catalog, command.targetId, ctx); else reject(state, catalog, actor.id, 'invalid-downed-target', command.targetId); }
  }
  drain(state, catalog); return finishBattle(state, catalog);
}
export function stepBattle(previous: BattleState, catalog: CombatContentCatalog, ticks = 1, options: BattleStepOptions = {}): BattleState {
  if (options.movement && ticks !== 1) throw new Error('Movement intents require exactly one tick');
  if (options.movement) { validateBattleArena(options.movement.arena); if (options.movement.intents.length > MAX_ENTITIES) throw new Error('Too many movement intents'); }
  assertCatalog(previous, catalog); assertNonNegativeInteger(ticks, 'ticks'); if (ticks > MAX_STEP_TICKS) throw new Error('Step exceeds explicit tick budget'); if (previous.ended || ticks === 0) return previous;
  const state = draft(options.movement ? bindBattleArena(previous, catalog, options.movement.arena) : previous);
  for (let count = 0; count < ticks; count++) {
    state.tick = checkedAdd(state.tick, 1);
    for (const status of [...state.statuses].sort((a, b) => compareStable(a.sourceInstanceId, b.sourceInstanceId))) if (status.expiresAtTick !== null && status.expiresAtTick <= state.tick) { const ctx = makeContext(state, catalog, status.holderId, { ...status.provenance, direct: false, family: 'status-expiry' }, state.sources[status.sourceInstanceId] ?? null); removeStatus(state, catalog, status.statusInstanceId, 'expired', ctx); }
    for (const source of [...Object.values(state.sources)]) if (state.sources[source.sourceInstanceId] && source.expiresAtTick !== null && source.expiresAtTick <= state.tick) { const ctx = makeContext(state, catalog, source.holderId, newRoot(state, source.holderId), source); removeSource(state, catalog, source.sourceInstanceId, 'expired', ctx); }
    state.shields = state.shields.filter(shield => shield.expiresAtTick === null || shield.expiresAtTick > state.tick); state.modifiers = state.modifiers.filter(modifier => modifier.expiresAtTick === null || modifier.expiresAtTick > state.tick); state.augments = state.augments.filter(charge => charge.expiresAtTick === null || charge.expiresAtTick > state.tick);
    clampHealth(state, catalog);
    for (const entity of Object.values(state.entities)) if (entity.life === 'Recovered' && state.tick >= entity.recoveryUntilTick) entity.life = 'Alive';
    drain(state, catalog);
    if (options.movement) {
      const occupied = occupiedBattleCells(state); const claimed = new Set<string>(); const seen = new Set<string>(); const arena = options.movement.arena;
      for (const movement of [...options.movement.intents].sort((a, b) => compareStable(a.actorId, b.actorId))) {
        const actor = state.entities[movement.actorId]; const destination = `${movement.to.x},${movement.to.y}`;
        if (seen.has(movement.actorId) || !actor || !canAct(state, catalog, movement.actorId) || actor.currentActionId || !arenaWalkable(arena, actor.position) || !arenaWalkable(arena, movement.to) || Math.abs(actor.position.x - movement.to.x) + Math.abs(actor.position.y - movement.to.y) !== arena.cellSizeUnits || occupied.has(destination) || claimed.has(destination)) { reject(state, catalog, movement.actorId, 'invalid-movement'); continue; }
        seen.add(movement.actorId); claimed.add(destination); actor.position = { ...movement.to };
      }
    }
    for (const status of [...state.statuses].sort((a, b) => compareStable(a.sourceInstanceId, b.sourceInstanceId))) {
      if (status.nextPeriodicTick === null || status.nextPeriodicTick > state.tick || !alive(state, status.holderId) || !statusActive(state, catalog, status)) continue;
      const d = definition(catalog, status.definitionId); if (d.kind !== 'status') throw new Error('Invalid status definition');
      status.nextPeriodicTick = checkedAdd(state.tick, d.periodicIntervalTicks);
      const ctx = makeContext(state, catalog, status.holderId, { ...status.provenance, parentId: status.statusInstanceId, direct: false, family: 'periodic', depth: status.provenance.depth + 1 }, state.sources[status.sourceInstanceId]!);
      ctx.statusApplierId = status.applierId; ctx.attackSnapshot = status.attackSnapshot; ctx.intentId = status.holderId;
      executeProgram(state, catalog, d.periodicEffects, ctx, [], ROOT_PROC_LIMITS.maxDerivedEffects); drain(state, catalog);
    }
    for (const zone of [...state.zones].sort((a, b) => Number(a.zoneInstanceId.slice(9)) - Number(b.zoneInstanceId.slice(9)))) {
      if (!state.zones.some(item => item.zoneInstanceId === zone.zoneInstanceId) || zone.nextPeriodicTick > state.tick) continue;
      zone.nextPeriodicTick = checkedAdd(state.tick, zone.effect.intervalTicks);
      const source = state.sources[zone.sourceInstanceId]; if (!source) continue;
      const ctx = makeContext(state, catalog, zone.casterId, { ...zone.provenance, parentId: zone.zoneInstanceId, direct: false, family: 'zone-periodic', depth: zone.provenance.depth + 1 }, source);
      ctx.attackSnapshot = zone.attackSnapshot; ctx.intentId = zone.intentId; ctx.spatialAnchor = zone.anchor; ctx.spatialRadiusUnits = zone.radiusUnits;
      executeProgram(state, catalog, zone.effect.effects, ctx, zone.adjustments, null); drain(state, catalog);
    }
    const due = Object.values(state.actions).filter(action => action.state === 'Casting' && action.castEndTick <= state.tick).sort((a, b) => a.castEndTick - b.castEndTick || Number(a.actionId.split(':')[1]) - Number(b.actionId.split(':')[1]));
    for (const action of due) commit(state, catalog, action);
    drain(state, catalog);
  }
  return finishBattle(state, catalog);
}
export function installCombatSource(previous: BattleState, catalog: CombatContentCatalog, holderId: string, definitionId: string, options: SourceInstallOptions = {}): BattleState { assertCatalog(previous, catalog); const state = draft(previous); if (state.ended) throw new Error('Battle ended'); install(state, catalog, holderId, definitionId, options); drain(state, catalog); return finishBattle(state, catalog); }
export function removeCombatSource(previous: BattleState, catalog: CombatContentCatalog, sourceInstanceId: string): BattleState { assertCatalog(previous, catalog); const state = draft(previous); const source = state.sources[sourceInstanceId]; if (source) { const ctx = makeContext(state, catalog, source.holderId, newRoot(state, source.holderId), source); removeSource(state, catalog, sourceInstanceId, 'uninstalled', ctx); drain(state, catalog); } return finishBattle(state, catalog); }
export function cleanupBattleScope(previous: BattleState, catalog: CombatContentCatalog, scope: LifecycleScope): BattleState {
  assertCatalog(previous, catalog); const state = draft(previous);
  const scopes: LifecycleScope[] = scope === 'character' ? ['character', 'run', 'encounter'] : scope === 'run' ? ['run', 'encounter'] : ['encounter'];
  for (const source of [...Object.values(state.sources)]) if (state.sources[source.sourceInstanceId] && scopes.includes(source.lifecycleScope)) { const ctx = makeContext(state, catalog, source.holderId, newRoot(state, source.holderId), source); removeSource(state, catalog, source.sourceInstanceId, `${scope}-cleanup`, ctx); }
  state.shields = state.shields.filter(shield => !scopes.includes(shield.lifecycleScope));
  state.modifiers = state.modifiers.filter(modifier => !scopes.includes(modifier.modifier.lifecycleScope));
  state.augments = state.augments.filter(charge => !scopes.includes(charge.lifecycleScope));
  drain(state, catalog);
  state.triggerLedger = state.triggerLedger.filter(ledger => { const source = state.sources[ledger.sourceInstanceId]; const shared = Object.values(state.teamBudgets).find(item => item.budgetId === ledger.sourceInstanceId); if (!source && !shared) return false; const trigger = mechanics(catalog, source ?? { sourceDefinitionId: shared!.definitionId })?.triggers.find(item => item.triggerId === ledger.triggerId); return scope === 'encounter' && trigger?.proc.activationScope === 'run'; });
  if (scope !== 'encounter') state.teamBudgets = {};
  return finishBattle(state, catalog);
}
/** Explicit node transition: finite node durations never silently behave as infinite. */
export function advanceBattleNode(previous: BattleState, catalog: CombatContentCatalog): BattleState {
  assertCatalog(previous, catalog); const state = draft(previous);
  for (const source of [...Object.values(state.sources)]) if (source.remainingNodes !== null) { source.remainingNodes--; if (source.remainingNodes <= 0) removeSource(state, catalog, source.sourceInstanceId, 'node-expired', makeContext(state, catalog, source.holderId, newRoot(state, source.holderId), source)); }
  drain(state, catalog); return finishBattle(state, catalog);
}
export function endBattle(previous: BattleState, catalog: CombatContentCatalog): BattleState {
  const state = draft(cleanupBattleScope(previous, catalog, 'encounter'));
  for (const actor of Object.values(state.entities)) if (actor.currentActionId) interruptAction(state, catalog, actor.id, 'encounter-ended', makeContext(state, catalog, actor.id, newRoot(state, actor.id)));
  state.queue = []; state.ended = true; return finishBattle(state, catalog);
}
