import { describe, expect, it } from 'vitest';
import { combatCatalog as authored } from '../../src/content/definitions';
import { always, apply, area, base, damage, heal, intent, mechanics, requiredCapabilities, self, shield, ticks, trigger } from '../../src/content/definitions/helpers';
import type { ActiveAction, CombatContentCatalog, EffectPrimitive, Mechanics, SkillDefinition } from '../../src/core/combat/definitions';
import { bindBattleArena, cleanupBattleScope, combatDefinitionSupport, createBattle, installCombatSource, issueCommand, prepareCombatCatalog, removeCombatSource, restoreBattle, serializeBattle, stepBattle, RETIRED_SUMMON_TARGET } from '../../src/core/combat';
import type { BattleArena, BattleData, BattleEntityInput, BattleState } from '../../src/core/combat';
import { createCombatController, issueTacticalOrder, restoreCombatController, serializeCombatController, stepCombatController } from '../../src/core/combat/ai';
import { cloneJson, stableHash } from '../../src/core/kernel/serialization';
const A = 'entity:1', B = 'entity:2', E = 'entity:3', F = 'entity:4';
const arena: BattleArena = { origin: { x: 0, y: 0 }, widthCells: 16, heightCells: 8, cellSizeUnits: 20, blockedCells: [] };
const basic = { coefficientBps: 10_000, cooldownTicks: 1, castTicks: 0, rangeUnits: 600, school: 'sword' } as const;
function entity(id: string, team: string, x: number, extra: Partial<BattleEntityInput> = {}): BattleEntityInput { return { id, team, position: { x, y: 20 }, stats: { attack: 100, maxHealth: 1000 }, basic, ...extra }; }
function skill(name: string, effects: readonly EffectPrimitive[], extra: Partial<ActiveAction> = {}, m: Mechanics = mechanics()): SkillDefinition { return { ...base(`skill.advanced-${name}`, 10, requiredCapabilities(m, effects)), kind: 'skill', school: 'sword', activation: 'active', ultimate: false, lifecycleScope: 'character', tags: ['sword', 'active'], mechanics: m, action: { spiritCostUnits: 0, cooldownTicks: 1, castTicks: 0, rangeUnits: 600, targetTeam: 'enemy', target: intent, condition: always, effects, commitPolicy: 'castEndRevalidate', missRefundPolicy: 'none', launchedSourceDeathPolicy: 'resolveCommitted', ...extra } }; }
const catalog = (...skills: SkillDefinition[]): CombatContentCatalog => prepareCombatCatalog({ ...authored, skills: [...authored.skills, ...skills] });
function battle(content: CombatContentCatalog, skills: string[] = [], extra: Partial<BattleEntityInput> = {}, geometry = arena): BattleState { return createBattle(content, { seed: 'advanced-conformance', arena: geometry, contentMode: 'experimental', logCapacity: 1000, entities: [entity(A, 'allies', 0, { skills, ...extra }), entity(B, 'allies', 80), entity(E, 'enemies', 160), entity(F, 'enemies', 180)] }); }
const cast = (state: BattleState, content: CombatContentCatalog, actorId: string, skillId: string, targetId: string) => issueCommand(state, content, { kind: 'cast', actorId, skillId, targetId });
const flat = (units: number, target = intent): EffectPrimitive => ({ ...damage(0, 'physical', target), amount: { kind: 'flat', units }, canCritical: false });
const move = (maximumDistanceUnits = 120): EffectPrimitive => ({ kind: 'move', mode: 'toAlly', maximumDistanceUnits, target: intent, condition: always });
const field = (duration = 8, interval = 2, effects: readonly EffectPrimitive[] = [flat(10, area('enemy', 40, 'intent'))]): Extract<EffectPrimitive, { kind: 'zone' }> => ({ kind: 'zone', target: intent, condition: always, radiusUnits: 40, intervalTicks: interval, duration: ticks(duration), effects });
const decoy = (duration = 8): EffectPrimitive => ({ kind: 'summon', target: self, condition: always, summonId: 'summon.paper-decoy', maximumPerCaster: 1, duration: ticks(duration) });
function roundtrip(state: BattleState, content: CombatContentCatalog): BattleState { const text = serializeBattle(state); const restored = restoreBattle(text, content); expect(serializeBattle(restored)).toBe(text); return restored; }
const source = (state: BattleState, id: string) => Object.values(state.sources).find(item => item.sourceDefinitionId === id && item.executionKind === 'installed')!.sourceInstanceId;

describe('source-owned ally locomotion', () => {
  it('moves the caster next to the ally during its committed effect list and leaves the ally still', () => {
    const assist = skill('assist', [move(), shield(1000, 10, intent)], { targetTeam: 'ally' }); const content = catalog(assist); const initial = battle(content, [assist.id]);
    const moved = cast(initial, content, A, assist.id, B);
    expect(moved.entities[A]!.position).toEqual({ x: 60, y: 20 }); expect(moved.entities[B]!.position).toEqual(initial.entities[B]!.position); expect(moved.shields[0]!.holderId).toBe(B); expect(moved.random).toEqual(initial.random); roundtrip(moved, content);
  });
  it('does not teleport through blockers, occupied corridors, or exceed the path-length bound', () => {
    const assist = skill('bounded-assist', [move(60)], { targetTeam: 'ally' }); const content = catalog(assist);
    const wall = { ...arena, blockedCells: Array.from({ length: 8 }, (_, y) => ({ x: 1, y })) };
    expect(cast(battle(content, [assist.id], {}, wall), content, A, assist.id, B).entities[A]!.position.x).toBe(0);
    const occupied = createBattle(content, { seed: 'occupied', arena: { ...arena, heightCells: 1 }, contentMode: 'experimental', entities: [entity(A, 'ally', 0, { skills: [assist.id], position: { x: 0, y: 0 } }), entity(B, 'ally', 80, { position: { x: 80, y: 0 } }), entity(E, 'enemy', 20, { position: { x: 20, y: 0 } })] });
    expect(cast(occupied, content, A, assist.id, B).entities[A]!.position.x).toBe(0);
    const detour = { ...arena, blockedCells: [{ x: 1, y: 1 }] }; const failed = cast(battle(content, [assist.id], {}, detour), content, A, assist.id, B);
    expect(failed.entities[A]!.position.x).toBe(0); expect(failed.log.some(event => event.reason === 'movement-unavailable')).toBe(true);
  });
  it('permits a bounded deterministic detour and treats an already adjacent caster as settled', () => {
    const assist = skill('detour', [move(100)], { targetTeam: 'ally' }); const content = catalog(assist); const state = cast(battle(content, [assist.id], {}, { ...arena, blockedCells: [{ x: 1, y: 1 }] }), content, A, assist.id, B);
    expect(state.entities[A]!.position).toEqual({ x: 80, y: 0 }); const again = cast(stepBattle(state, content), content, A, assist.id, B); expect(again.entities[A]!.position).toEqual(state.entities[A]!.position);
  });
  it('revalidates control and range before commitment, and cannot move an unrelated windup', () => {
    const assist = skill('windup-assist', [move()], { targetTeam: 'ally', castTicks: 2 }); const hold = skill('lock', [apply('status.stagger', 1, 4)]); const content = catalog(assist, hold);
    let state = battle(content, [assist.id]); state = installCombatSource(state, content, E, hold.id); state = cast(state, content, A, assist.id, B); state = cast(state, content, E, hold.id, A); state = stepBattle(state, content, 3);
    expect(state.entities[A]!.position.x).toBe(0); expect(Object.values(state.actions).find(action => action.actorId === A)!.state).toBe('Interrupted');
  });
  it('does not let a triggered move displace a source occupied by an unrelated windup', () => {
    const windup = skill('unrelated-windup', [flat(1)], { castTicks: 10 }); const guardian: SkillDefinition = { ...base('skill.advanced-guard-move', 10, ['move']), kind: 'skill', school: 'body', activation: 'passive', lifecycleScope: 'character', tags: ['passive'], mechanics: mechanics([], [trigger('guard-move', 'command.guard', always, [move()])]) }; const content = catalog(windup, guardian);
    let state = battle(content, [windup.id, guardian.id]); state = cast(state, content, A, windup.id, E); state = issueCommand(state, content, { kind: 'guard', actorId: A, targetId: B });
    expect(state.entities[A]!.position.x).toBe(0); expect(state.entities[A]!.currentActionId).not.toBeNull(); expect(state.log.some(event => event.reason === 'movement-unavailable')).toBe(true); roundtrip(state, content);
  });
  it('binds one owned arena and rejects controller/runtime geometry mismatch', () => {
    const content = catalog(); const state = battle(content); expect(bindBattleArena(state, content, arena)).toBe(state);
    expect(() => bindBattleArena(state, content, { ...arena, widthCells: 17 })).toThrow(/mismatch/);
    expect(() => createCombatController(content, state, { arena: { ...arena, widthCells: 17 }, playerTeam: 'allies' })).toThrow(/mismatch/);
  });
});

describe('anchored, owned periodic fields', () => {
  it('keeps a fixed creation anchor after intent movement and expires before its boundary pulse', () => {
    const zone = skill('field', [field()]); const content = catalog(zone); let state = cast(battle(content, [zone.id]), content, A, zone.id, E);
    state = stepBattle(state, content, 1, { movement: { arena, intents: [{ actorId: E, to: { x: 160, y: 40 } }] } });
    state = stepBattle(state, content, 1, { movement: { arena, intents: [{ actorId: E, to: { x: 160, y: 60 } }] } });
    state = stepBattle(state, content, 1, { movement: { arena, intents: [{ actorId: E, to: { x: 160, y: 80 } }] } });
    expect(state.zones[0]!.anchor).toEqual({ x: 160, y: 20 }); state = stepBattle(roundtrip(state, content), content, 5);
    expect(state.entities[E]!.health).toBe(990); expect(state.entities[F]!.health).toBe(970); expect(state.zones).toHaveLength(0); expect(state.log.filter(event => event.kind === 'zone.removed')).toHaveLength(1);
  });
  it('continues committed fields after caster death with detached exact ownership and stable attribution', () => {
    const zone = skill('posthumous-field', [field()]); const content = catalog(zone); let state = battle(content, [zone.id], { deathRule: 'immediate', health: 50 }); state = cast(state, content, A, zone.id, E);
    const owner = state.zones[0]!.sourceInstanceId; state = issueCommand(state, content, { kind: 'basic', actorId: E, targetId: A });
    expect(state.entities[A]!.life).toBe('Dead'); expect(state.sources[owner]!.parentSourceInstanceId).toBeNull(); expect(state.entities[A]!.skills).toEqual([]);
    state = stepBattle(roundtrip(state, content), content, 8); expect(state.entities[E]!.health).toBe(970); expect(state.sources[owner]).toBeUndefined(); expect(state.log.filter(event => event.kind === 'damage.healthLost' && event.targetId === E).every(event => event.actorId === A)).toBe(true); roundtrip(state, content);
  });
  it('does not retain ordinary installed sources after a completed historical action and later caster death', () => {
    const zone = skill('historical-field', [field()]); const strike = skill('historical-strike', [flat(1)]); const content = catalog(zone, strike);
    let state = battle(content, [zone.id, strike.id, 'skill.jianxin'], { deathRule: 'immediate', health: 50 });
    state = cast(state, content, A, zone.id, E); state = cast(state, content, A, strike.id, E); expect(Object.values(state.actions).every(action => action.state === 'Complete')).toBe(true);
    state = issueCommand(state, content, { kind: 'basic', actorId: E, targetId: A });
    expect(Object.values(state.sources).filter(source => source.holderId === A && source.executionKind === 'installed')).toEqual([]);
    expect(state.modifiers.filter(modifier => modifier.holderId === A)).toEqual([]); expect(state.zones).toHaveLength(1); expect(state.entities[A]!.skills).toEqual([]); roundtrip(state, content);
  });
  it('finishes an atomic committed effect list after synchronous retaliation, then death-cleans the origin before returning', () => {
    const retaliation = trigger('last-retaliation', 'life.beforeDowned', always, [flat(10000, { kind: 'eventActor' })]);
    const defender: SkillDefinition = { ...base('skill.advanced-last-retaliation', 10, ['damage']), kind: 'skill', school: 'body', activation: 'passive', lifecycleScope: 'character', tags: ['passive'], mechanics: mechanics([], [retaliation]) };
    const strike = skill('atomic-death', [field(), flat(10000), flat(7, area('enemy', 40, 'intent')), shield(1000, 10, area('ally', 600))]); const content = catalog(strike, defender);
    let state = battle(content, [strike.id], { deathRule: 'immediate', health: 50 }); state = installCombatSource(state, content, E, defender.id); state = cast(state, content, A, strike.id, E);
    expect(state.entities[A]!.life).toBe('Dead'); expect(state.entities[F]!.health).toBe(993); expect(Object.values(state.actions).every(action => action.state !== 'Committed')).toBe(true);
    expect(Object.values(state.sources).filter(source => source.holderId === A && source.executionKind === 'installed')).toEqual([]); expect(state.shields).toHaveLength(0); expect(state.zones).toHaveLength(1); expect(state.sources[state.zones[0]!.sourceInstanceId]!.parentSourceInstanceId).toBeNull(); roundtrip(state, content);
  });
  it('removes only one origin’s field and owned status/shield contributions on uninstall or source expiry', () => {
    const zone = skill('owned-field', [field(10, 1, [apply('status.poison', 1, 20, area('enemy', 40, 'intent'))])]); const content = catalog(zone);
    let state = battle(content, [zone.id]); state = installCombatSource(state, content, B, zone.id, { duration: ticks(3) }); state = cast(state, content, A, zone.id, E); state = cast(state, content, B, zone.id, E); state = stepBattle(state, content);
    state = removeCombatSource(state, content, source(state, zone.id)); expect(state.zones).toHaveLength(1); expect(state.statuses.every(status => status.stackSources.every(owner => owner.applierId === B))).toBe(true);
    state = stepBattle(state, content, 2); expect(state.zones).toHaveLength(0); expect(state.statuses).toHaveLength(0); roundtrip(state, content);
  });
  it('does not spend the derived-proc cap on legal baseline pulses', () => {
    const reaction = trigger('field-echo', 'damage.healthLost', always, [flat(1)]); const passive: SkillDefinition = { ...base('skill.advanced-echo', 10, ['damage']), kind: 'skill', school: 'sword', activation: 'passive', lifecycleScope: 'character', tags: ['passive'], mechanics: mechanics([], [{ ...reaction, proc: { ...reaction.proc, oncePerRoot: false, allowIndirectFamilies: ['zone-periodic'] } }]) };
    const zone = skill('long-field', [field(101, 1, [flat(1, area('enemy', 1, 'intent'))])]); const content = catalog(zone, passive); let state = battle(content, [zone.id, passive.id]); state = cast(state, content, A, zone.id, E); state = stepBattle(state, content, 101);
    expect(state.entities[E]!.health).toBe(836); expect(state.roots[Object.keys(state.actions)[0]!]!.derivedEffects).toBe(64); expect(state.statistics.truncatedProcs).toBe(1); expect(state.zones).toHaveLength(0); roundtrip(state, content);
  });
  it('bounds nested fields by depth, preserves proc RNG/ICD state across resume, and cleans once', () => {
    const nested = field(6, 2, [field(3, 1, [{ ...damage(1000, 'physical', area('enemy', 40, 'intent')), canCritical: true }])]);
    const zone = skill('nested-field', [nested]); const content = catalog(zone); let state = cast(battle(content, [zone.id], { stats: { attack: 100, maxHealth: 1000, criticalChanceBps: 5000 } }), content, A, zone.id, E); state = stepBattle(state, content, 3);
    expect(stepBattle(roundtrip(state, content), content, 10)).toEqual(stepBattle(state, content, 10));
    state = cleanupBattleScope(state, content, 'encounter'); expect(state.zones).toHaveLength(0); const clean = cleanupBattleScope(state, content, 'encounter'); expect(clean.log.filter(event => event.kind === 'zone.removed')).toHaveLength(state.log.filter(event => event.kind === 'zone.removed').length); roundtrip(clean, content);
  });
  it('resolves field healing through the same live spatial radius and derived max-health cap', () => {
    const zone = skill('healing-field', [field(6, 2, [heal(1000, area('ally', 40, 'intent'))])], { targetTeam: 'ally' }); const content = catalog(zone); let state = battle(content, [zone.id]); const edited = cloneJson(state) as BattleData; edited.entities[B]!.health = 100; state = cast(edited, content, A, zone.id, B); state = stepBattle(state, content, 6);
    expect(state.entities[B]!.health).toBe(120); expect(state.statistics.effectiveHealing).toBe(20);
  });
});

describe('battle-only decoys', () => {
  it('creates real positive HP with deterministic identity/placement and forbids actions/source installation', () => {
    const summon = skill('decoy', [decoy()], { targetTeam: 'self' }); const content = catalog(summon); const state = cast(battle(content, [summon.id], { stats: { attack: 0, maxHealth: 1 } }), content, A, summon.id, A); const unit = state.entities[state.summons[0]!.entityId]!;
    expect(unit.id).toMatch(/^summon:/); expect(unit.health).toBe(1); expect(unit.position).toEqual({ x: 0, y: 0 }); expect(unit.kind).toBe('summon');
    expect(issueCommand(state, content, { kind: 'basic', actorId: unit.id, targetId: E }).statistics.rejectedCommands).toBe(1); expect(() => installCombatSource(state, content, unit.id, 'skill.jianxin')).toThrow(); roundtrip(state, content);
  });
  it('enforces per-caster cap and deterministic simultaneous casts/replacement without reusing IDs', () => {
    const summon = skill('replace-decoy', [decoy(20)], { targetTeam: 'self', castTicks: 2 }); const content = catalog(summon); let state = battle(content, [summon.id]); state = installCombatSource(state, content, B, summon.id);
    state = cast(state, content, A, summon.id, A); state = cast(state, content, B, summon.id, B); state = stepBattle(state, content, 2); const firstIds = state.summons.map(item => item.entityId); expect(new Set(firstIds).size).toBe(2);
    state = stepBattle(state, content); state = cast(state, content, A, summon.id, A); state = stepBattle(state, content, 2); expect(state.summons).toHaveLength(2); expect(state.entities[firstIds[0]!]).toBeUndefined(); expect(state.summons[1]!.entityId).not.toBe(firstIds[0]); roundtrip(state, content);
  });
  it('retires on actual HP loss without campaign death/downed/reward events and invalidates pending attacks', () => {
    const summon = skill('targetable-decoy', [decoy()], { targetTeam: 'self' }); const slow = skill('slow-hit', [flat(100)], { castTicks: 3 }); const content = catalog(summon, slow); let state = battle(content, [summon.id]); state = installCombatSource(state, content, F, slow.id); state = cast(state, content, A, summon.id, A); const targetId = state.summons[0]!.entityId;
    state = cast(state, content, F, slow.id, targetId); for (let hit = 0; hit < 3; hit++) { state = issueCommand(state, content, { kind: 'basic', actorId: E, targetId }); if (hit < 2) state = stepBattle(state, content); }
    expect(state.entities[targetId]).toBeUndefined(); expect(state.statistics.healthLost).toBe(250); expect(state.statistics.deaths).toBe(0); expect(state.statistics.downed).toBe(0); expect(state.statistics.byEntity[E]!.kills).toBe(0); expect(state.statistics.byEntity[targetId]).toBeUndefined(); expect(Object.values(state.actions).find(action => action.actorId === F)!.state).toBe('Invalidated'); roundtrip(state, content);
  });
  it('keeps committed decoys after caster death but removes them at exclusive expiry and encounter cleanup', () => {
    const summon = skill('last-decoy', [decoy(3)], { targetTeam: 'self' }); const content = catalog(summon); let state = cast(battle(content, [summon.id], { health: 50, deathRule: 'immediate' }), content, A, summon.id, A); state = issueCommand(state, content, { kind: 'basic', actorId: E, targetId: A });
    expect(state.summons).toHaveLength(1); state = stepBattle(roundtrip(state, content), content, 3); expect(state.summons).toHaveLength(0); expect(state.log.filter(event => event.kind === 'summon.removed')).toHaveLength(1); roundtrip(state, content);
  });
  it('rejects occupied placement rather than stacking a decoy on an actor', () => {
    const summon = skill('blocked-decoy', [decoy()], { targetTeam: 'self' }); const content = catalog(summon); const state = createBattle(content, { seed: 'blocked-placement', contentMode: 'experimental', arena: { ...arena, widthCells: 2, heightCells: 1 }, entities: [entity(A, 'ally', 0, { position: { x: 0, y: 0 }, skills: [summon.id] }), entity(E, 'enemy', 20, { position: { x: 20, y: 0 } })] });
    const result = cast(state, content, A, summon.id, A); expect(result.summons).toHaveLength(0); expect(result.log.some(event => event.reason === 'summon-placement-blocked')).toBe(true);
  });
  it('aggregates retired-target activation history without resetting proc caps or growing entities/statistics', () => {
    const proc = trigger('decoy-hit', 'damage.healthLost', always, [flat(1)]); const passive: SkillDefinition = { ...base('skill.advanced-decoy-listener', 10, ['damage']), kind: 'skill', school: 'sword', activation: 'passive', lifecycleScope: 'character', tags: ['passive'], mechanics: mechanics([], [{ ...proc, proc: { ...proc.proc, perTarget: true, maximumActivations: 3 } }]) };
    const summon = skill('repeated-decoy', [decoy(2)], { targetTeam: 'self' }); const content = catalog(summon, passive); let state = battle(content, [summon.id], { stats: { attack: 1, maxHealth: 100 } }); state = installCombatSource(state, content, E, passive.id);
    for (let index = 0; index < 20; index++) { state = cast(state, content, A, summon.id, A); state = issueCommand(state, content, { kind: 'basic', actorId: E, targetId: state.summons[0]!.entityId }); state = stepBattle(state, content); }
    expect(Object.keys(state.entities)).toHaveLength(4); expect(Object.keys(state.statistics.byEntity)).toHaveLength(4); const retired = state.triggerLedger.filter(item => item.targetKey === RETIRED_SUMMON_TARGET); expect(retired).toHaveLength(1); expect(retired[0]!.activations).toBe(3); roundtrip(state, content);
  });
});

describe('decoy controller policy and snapshot rejection', () => {
  it('prefers a decoy automatically but honors explicit focus and primary-ally healing priority', () => {
    const summon = skill('ai-decoy', [decoy(50)], { targetTeam: 'self' }); const healing = skill('ai-heal', [heal(1000)], { targetTeam: 'ally' }); const content = catalog(summon, healing); let state = battle(content, [summon.id]); state = cast(state, content, A, summon.id, A); const decoyId = state.summons[0]!.entityId;
    let controller = createCombatController(content, state, { playerTeam: 'enemies', arena, decisionIntervalTicks: 1 }); let stepped = stepCombatController(controller, content); expect(Object.values(stepped.battle.actions).find(action => action.actorId === E)!.targetId).toBe(decoyId);
    controller = issueTacticalOrder(controller, content, { kind: 'focus', actorId: E, targetId: B }); stepped = stepCombatController(controller, content); expect(Object.values(stepped.battle.actions).find(action => action.actorId === E)!.targetId).toBe(B);
    const raw = cloneJson(state) as BattleData; raw.entities[decoyId]!.health = 1; raw.entities[B]!.health = 100; state = installCombatSource(raw, content, B, healing.id); controller = createCombatController(content, state, { playerTeam: 'allies', arena }); stepped = stepCombatController(controller, content); expect(Object.values(stepped.battle.actions).find(action => action.actorId === B)!.targetId).toBe(B); expect(Object.keys(controller.agents)).not.toContain(decoyId); expect(Object.keys(controller.config.policies)).not.toContain(decoyId);
  });
  it('lets a guard’s current threat outrank a decoy', () => {
    const summon = skill('guard-decoy', [decoy(50)], { targetTeam: 'self' }); const windup = skill('guard-windup', [flat(1)], { castTicks: 20 }); const content = catalog(summon, windup); let state = battle(content); state = installCombatSource(state, content, E, summon.id); state = installCombatSource(state, content, F, windup.id); state = cast(state, content, E, summon.id, E); state = cast(state, content, F, windup.id, B);
    let controller = createCombatController(content, state, { playerTeam: 'allies', arena }); controller = issueTacticalOrder(controller, content, { kind: 'guard', actorId: A, targetId: B }); controller = stepCombatController(controller, content);
    expect(Object.values(controller.battle.actions).find(action => action.actorId === A)!.targetId).toBe(F);
  });
  it('cleans focused-summon orders immediately after a manual lethal cast and can save before another tick', () => {
    const summon = skill('focused-decoy', [decoy(50)], { targetTeam: 'self' }); const kill = skill('focused-kill', [flat(10000)]); const content = catalog(summon, kill); let state = battle(content, [summon.id]); state = installCombatSource(state, content, E, kill.id); state = cast(state, content, A, summon.id, A); const targetId = state.summons[0]!.entityId;
    let controller = createCombatController(content, state, { playerTeam: 'enemies', arena }); controller = issueTacticalOrder(controller, content, { kind: 'focus', actorId: E, targetId }); controller = issueTacticalOrder(controller, content, { kind: 'cast', actorId: E, skillId: kill.id, targetId });
    expect(controller.orders).toEqual([]); expect(controller.battle.entities[targetId]).toBeUndefined(); expect(restoreCombatController(serializeCombatController(controller), content)).toEqual(controller);
  });
  it('settles primary-team elimination despite a live decoy and roundtrips the completed controller', () => {
    const summon = skill('outcome-decoy', [decoy(50)], { targetTeam: 'self' }); const kill = skill('outcome-kill', [flat(10000)]); const content = catalog(summon, kill); let state = battle(content, [summon.id]); state = installCombatSource(state, content, E, kill.id); state = cast(state, content, A, summon.id, A); state = cast(state, content, E, kill.id, A); state = stepBattle(state, content); state = cast(state, content, E, kill.id, B);
    const controller = createCombatController(content, state, { playerTeam: 'allies', arena }); expect(controller.outcome.status).toBe('defeat'); expect(controller.battle.summons).toHaveLength(0); expect(restoreCombatController(serializeCombatController(controller), content)).toEqual(controller);
  });
  it('rejects forged zones, summon ownership/lifetimes, action-capable decoys and missing live references', () => {
    const summon = skill('snapshot-decoy', [decoy(20)], { targetTeam: 'self' }); const zone = skill('snapshot-zone', [field(20)]); const content = catalog(summon, zone); let state = cast(battle(content, [summon.id, zone.id]), content, A, summon.id, A); state = cast(state, content, A, zone.id, E);
    const mutations: ((value: BattleData) => void)[] = [value => { value.zones[0]!.anchor.x = -20; }, value => { value.zones[0]!.nextPeriodicTick = value.tick; }, value => { value.zones[0]!.radiusUnits = 999; }, value => { value.zones[0]!.casterId = E; }, value => { value.summons[0]!.expiresAtTick = 0; }, value => { value.summons[0]!.casterId = B; }, value => { value.entities[value.summons[0]!.entityId]!.skills = [summon.id]; }, value => { value.summons.push({ ...value.summons[0]! }); }, value => { value.sources[value.zones[0]!.sourceInstanceId]!.executionKind = 'installed'; }, value => { delete value.entities[E]; }];
    for (const mutate of mutations) { const envelope = JSON.parse(serializeBattle(state)) as { state: BattleData; checksum: string }; mutate(envelope.state); envelope.checksum = stableHash(envelope.state); expect(() => restoreBattle(JSON.stringify(envelope), content)).toThrow(); }
  });
  it('admits actual authored primitives without modifying certification and still blocks ambiguous stagger', () => {
    const content = catalog(); for (const id of ['skill.yuanhu', 'skill.wanjian-chaozong', 'skill.yaowang-ding', 'skill.zhikui']) expect(combatDefinitionSupport(content, id).supported).toBe(true);
    expect(combatDefinitionSupport(content, 'talent.zoumai-chengfu').supported).toBe(false); expect(combatDefinitionSupport(content, 'skill.zhikui', 'verified').supported).toBe(false);
  });
});
