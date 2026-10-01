import { describe, expect, it } from 'vitest';
import { combatCatalog as authoredCatalog } from '../../src/content/definitions';
import { always, apply, base, damage, heal, mechanics, requiredCapabilities } from '../../src/content/definitions/helpers';
import type { ActiveAction, CombatContentCatalog, EffectPrimitive, SkillDefinition } from '../../src/core/combat/definitions';
import { createBattle, issueCommand, prepareCombatCatalog, stepBattle } from '../../src/core/combat';
import type { BattleArena, BattleEntityInput, BattleState } from '../../src/core/combat';
import { createCombatController, issueTacticalOrder, restoreCombatController, serializeCombatController, stepCombatController } from '../../src/core/combat/ai';
import { stableHash } from '../../src/core/kernel/serialization';
const catalog = prepareCombatCatalog(authoredCatalog);
const A = 'entity:1'; const B = 'entity:2'; const E = 'entity:3'; const F = 'entity:4';
const arena: BattleArena = { origin: { x: 0, y: 0 }, widthCells: 12, heightCells: 5, cellSizeUnits: 20, blockedCells: [] };
function entity(id: string, team: string, x: number, y = 0, extra: Partial<BattleEntityInput> = {}): BattleEntityInput { return { id, team, position: { x, y }, stats: { attack: 10, maxHealth: 100 }, basic: { coefficientBps: 10_000, cooldownTicks: 2, castTicks: 0, rangeUnits: 20, school: 'sword' }, ...extra }; }
function battle(entities: readonly BattleEntityInput[], content = catalog): BattleState { return createBattle(content, { seed: 'controller-conformance', entities, contentMode: 'experimental' }); }
function active(id: string, effects: readonly EffectPrimitive[], options: Partial<ActiveAction> = {}): SkillDefinition { const m = mechanics(); return { ...base(`skill.ai-${id}`, 10, requiredCapabilities(m, effects)), kind: 'skill', school: 'sword', activation: 'active', ultimate: false, lifecycleScope: 'character', tags: ['sword', 'active'], mechanics: m, action: { spiritCostUnits: 10, cooldownTicks: 100, castTicks: 0, rangeUnits: 200, targetTeam: 'enemy', target: { kind: 'intent' }, condition: always, effects, commitPolicy: 'castEndRevalidate', missRefundPolicy: 'none', launchedSourceDeathPolicy: 'resolveCommitted', ...options } }; }
const add = (...skills: SkillDefinition[]): CombatContentCatalog => prepareCombatCatalog({ ...catalog, skills: [...catalog.skills, ...skills] });

describe('authoritative arena locomotion', () => {
  it('moves one cardinal cell without spending combat randomness or mutating the prior state', () => {
    const original = battle([entity(A, 'ally', 0), entity(E, 'enemy', 100)]);
    const moved = stepBattle(original, catalog, 1, { movement: { arena, intents: [{ actorId: A, to: { x: 20, y: 0 } }] } });
    expect(original.entities[A]!.position).toEqual({ x: 0, y: 0 }); expect(moved.entities[A]!.position).toEqual({ x: 20, y: 0 }); expect(moved.random).toEqual(original.random);
    expect(() => stepBattle(original, catalog, 2, { movement: { arena, intents: [] } })).toThrow(/one tick/);
  });
  it('rejects diagonal, long, out-of-bounds and blocked steps', () => {
    const original = battle([entity(A, 'ally', 0), entity(E, 'enemy', 100)]);
    for (const to of [{ x: 20, y: 20 }, { x: 40, y: 0 }, { x: -20, y: 0 }]) expect(stepBattle(original, catalog, 1, { movement: { arena, intents: [{ actorId: A, to }] } }).entities[A]!.position).toEqual(original.entities[A]!.position);
    const blocked = { ...arena, blockedCells: [{ x: 1, y: 0 }] };
    expect(stepBattle(original, catalog, 1, { movement: { arena: blocked, intents: [{ actorId: A, to: { x: 20, y: 0 } }] } }).entities[A]!.position.x).toBe(0);
  });
  it('resolves simultaneous free-cell conflicts by stable ID and disallows occupied-cell swaps', () => {
    const original = battle([entity(A, 'ally', 0), entity(B, 'ally', 40), entity(E, 'enemy', 100)]);
    const moved = stepBattle(original, catalog, 1, { movement: { arena, intents: [{ actorId: B, to: { x: 20, y: 0 } }, { actorId: A, to: { x: 20, y: 0 } }] } });
    expect(moved.entities[A]!.position.x).toBe(20); expect(moved.entities[B]!.position.x).toBe(40);
    const swap = stepBattle(moved, catalog, 1, { movement: { arena, intents: [{ actorId: A, to: { x: 40, y: 0 } }, { actorId: B, to: { x: 20, y: 0 } }] } });
    expect(swap.entities[A]!.position.x).toBe(20); expect(swap.entities[B]!.position.x).toBe(40);
  });
  it('does not move an actor during a windup, and range is revalidated after target movement', () => {
    const strike = active('windup', [{ ...damage(10_000), canCritical: false }], { castTicks: 2, rangeUnits: 20 }); const content = add(strike);
    let state = battle([entity(A, 'ally', 0, 0, { skills: [strike.id] }), entity(E, 'enemy', 20)], content);
    state = issueCommand(state, content, { kind: 'cast', actorId: A, skillId: strike.id, targetId: E });
    state = stepBattle(state, content, 1, { movement: { arena, intents: [{ actorId: A, to: { x: 0, y: 20 } }, { actorId: E, to: { x: 40, y: 0 } }] } });
    expect(state.entities[A]!.position).toEqual({ x: 0, y: 0 }); expect(state.entities[E]!.position.x).toBe(40);
    state = stepBattle(state, content); expect(state.entities[A]!.spirit).toBe(100); expect(state.entities[A]!.reservedSpirit).toBe(0); expect(Object.values(state.actions)[0]!.state).toBe('Invalidated');
  });
  it('blocks movement during control and permits it at the exclusive expiration boundary', () => {
    const control = active('control', [apply('status.stagger', 1, 2)]); const content = add(control);
    let state = battle([entity(A, 'ally', 0), entity(E, 'enemy', 100, 0, { skills: [control.id] })], content);
    state = issueCommand(state, content, { kind: 'cast', actorId: E, skillId: control.id, targetId: A });
    state = stepBattle(state, content, 1, { movement: { arena, intents: [{ actorId: A, to: { x: 20, y: 0 } }] } }); expect(state.entities[A]!.position.x).toBe(0);
    state = stepBattle(state, content, 1, { movement: { arena, intents: [{ actorId: A, to: { x: 20, y: 0 } }] } }); expect(state.entities[A]!.position.x).toBe(20);
  });
  it('keeps downed bodies blocking while permanent-dead bodies release their cells', () => {
    const kill = active('kill', [{ ...damage(100_000), canCritical: false }]); const content = add(kill);
    let state = battle([entity(A, 'ally', 0, 0, { skills: [kill.id] }), entity(E, 'enemy', 20)], content);
    state = issueCommand(state, content, { kind: 'cast', actorId: A, skillId: kill.id, targetId: E }); expect(state.entities[E]!.life).toBe('Downed');
    state = stepBattle(state, content, 1, { movement: { arena, intents: [{ actorId: A, to: { x: 20, y: 0 } }] } }); expect(state.entities[A]!.position.x).toBe(0);
    state = issueCommand(state, content, { kind: 'finishDowned', actorId: A, targetId: E });
    state = stepBattle(state, content, 1, { movement: { arena, intents: [{ actorId: A, to: { x: 20, y: 0 } }] } }); expect(state.entities[A]!.position.x).toBe(20);
  });
});

describe('default expedition combat controller', () => {
  it('approaches, fights and resolves victory without manual action commands', () => {
    const initial = battle([entity(A, 'ally', 0, 0, { stats: { attack: 50, maxHealth: 500 } }), entity(E, 'enemy', 160)]);
    const controller = createCombatController(catalog, initial, { playerTeam: 'ally', arena, maximumTicks: 200, decisionIntervalTicks: 1, movementIntervalTicks: 1 });
    const finished = stepCombatController(controller, catalog, 200);
    expect(finished.outcome.status).toBe('victory'); expect(finished.battle.ended).toBe(true); expect(finished.battle.statistics.healthLost).toBeGreaterThanOrEqual(100); expect(finished.battle.statistics.committedActions).toBeGreaterThan(0); expect(finished.battle.entities[A]!.position.x).toBeGreaterThan(0);
    expect(stepCombatController(finished, catalog, 100)).toBe(finished);
  });
  it('resolves defeat without treating a downed disciple as permanently dead', () => {
    const initial = battle([entity(A, 'ally', 0), entity(E, 'enemy', 20, 0, { stats: { attack: 100, maxHealth: 1000 } })]);
    const result = stepCombatController(createCombatController(catalog, initial, { playerTeam: 'ally', arena, maximumTicks: 50, decisionIntervalTicks: 1 }), catalog, 50);
    expect(result.outcome.status).toBe('defeat'); expect(result.battle.entities[A]!.life).toBe('Downed'); expect(result.battle.entities[A]!.deathId).toBeNull(); expect(result.battle.statistics.deaths).toBe(0);
    expect(restoreCombatController(serializeCombatController(result), catalog, result.configHash)).toEqual(result);
  });
  it('guard preference selects an enemy threatening the protected ally over a nearer enemy', () => {
    const threat = active('guard-threat', [{ ...damage(1000), canCritical: false }], { castTicks: 50 }); const content = add(threat);
    const wide = { coefficientBps: 10_000, cooldownTicks: 20, castTicks: 0, rangeUnits: 200, school: 'sword' } as const;
    let initial = battle([entity(A, 'ally', 100, 0, { basic: wide }), entity(B, 'ally', 0), entity(E, 'enemy', 80), entity(F, 'enemy', 180, 0, { skills: [threat.id] })], content);
    initial = issueCommand(initial, content, { kind: 'cast', actorId: F, skillId: threat.id, targetId: B });
    let controller = createCombatController(content, initial, { playerTeam: 'ally', arena });
    controller = issueTacticalOrder(controller, content, { kind: 'guard', actorId: A, targetId: B }); controller = stepCombatController(controller, content);
    expect(Object.values(controller.battle.actions).find(action => action.actorId === A)?.targetId).toBe(F);
  });
  it('uses stable target ties and explicit skill priority with no skill-name branching', () => {
    const first = active('first', [{ ...damage(1000), canCritical: false }]); const preferred = active('preferred', [{ ...damage(1000), canCritical: false }]); const content = add(first, preferred);
    const initial = battle([entity(A, 'ally', 40, 20, { skills: [first.id, preferred.id] }), entity(E, 'enemy', 20, 20), entity(F, 'enemy', 60, 20)], content);
    const controller = createCombatController(content, initial, { playerTeam: 'ally', arena, policies: { [A]: { skillPriority: [preferred.id, first.id] } } });
    const stepped = stepCombatController(controller, content);
    const ownAction = Object.values(stepped.battle.actions).find(action => action.actorId === A)!;
    expect(ownAction.skillId).toBe(preferred.id); expect(ownAction.targetId).toBe(E);
  });
  it('heals the low-health ally below policy threshold before taking offensive action', () => {
    const healing = active('heal', [heal(20_000)], { targetTeam: 'ally' }); const content = add(healing);
    const initial = battle([entity(A, 'ally', 0, 0, { stats: { attack: 10, maxHealth: 100 }, skills: [healing.id] }), entity(B, 'ally', 20, 0, { health: 10 }), entity(E, 'enemy', 160)], content);
    const result = stepCombatController(createCombatController(content, initial, { playerTeam: 'ally', arena, policies: { [A]: { healBelowBps: 5000 } } }), content);
    expect(result.battle.entities[B]!.health).toBe(30); expect(result.battle.statistics.effectiveHealing).toBe(20); expect(Object.values(result.battle.actions).find(action => action.actorId === A)?.skillId).toBe(healing.id);
  });
  it('prioritizes a timely authored interrupt opportunity rather than using raw interrupt authority', () => {
    const slow = active('slow', [{ ...damage(1000), canCritical: false }], { castTicks: 20 });
    const interrupt = active('interrupt', [{ kind: 'interrupt', target: { kind: 'intent' }, condition: always, strength: 1 }], { castTicks: 1 }); const content = add(slow, interrupt);
    let initial = battle([entity(A, 'ally', 0, 0, { skills: [interrupt.id] }), entity(E, 'enemy', 40, 0, { skills: [slow.id] })], content);
    initial = issueCommand(initial, content, { kind: 'cast', actorId: E, skillId: slow.id, targetId: A });
    const result = stepCombatController(createCombatController(content, initial, { playerTeam: 'ally', arena }), content);
    expect(Object.values(result.battle.actions).find(action => action.actorId === E)?.state).toBe('Interrupted'); expect(result.battle.entities[E]!.spirit).toBe(100); expect(result.battle.entities[A]!.spirit).toBe(90);
  });
  it('honors focus and clears its underlying runtime target exactly at expiry', () => {
    const wide = { coefficientBps: 10_000, cooldownTicks: 20, castTicks: 0, rangeUnits: 200, school: 'sword' } as const;
    let controller = createCombatController(catalog, battle([entity(A, 'ally', 0, 0, { basic: wide }), entity(E, 'enemy', 40), entity(F, 'enemy', 160)]), { playerTeam: 'ally', arena });
    controller = issueTacticalOrder(controller, catalog, { kind: 'focus', actorId: A, targetId: F, durationTicks: 2 });
    controller = stepCombatController(controller, catalog); expect(Object.values(controller.battle.actions).find(action => action.actorId === A)?.targetId).toBe(F); expect(controller.battle.focusByTeam.ally).toBe(F);
    controller = stepCombatController(controller, catalog); expect(controller.battle.focusByTeam.ally).toBeUndefined(); expect(controller.orders.some(order => order.kind === 'focus')).toBe(false);
  });
  it('paces guard commands across the team and holds automatic actions/movement until order expiry', () => {
    let controller = createCombatController(catalog, battle([entity(A, 'ally', 0, 0, { sources: ['talent.bingjian-shouyu'] }), entity(B, 'ally', 20), entity(E, 'enemy', 160)]), { playerTeam: 'ally', arena, guardCooldownTicks: 50 });
    controller = issueTacticalOrder(controller, catalog, { kind: 'guard', actorId: A, targetId: B });
    const count = controller.battle.log.filter(event => event.kind === 'command.guard').length;
    controller = issueTacticalOrder(controller, catalog, { kind: 'guard', actorId: B, targetId: A }); expect(controller.battle.log.filter(event => event.kind === 'command.guard')).toHaveLength(count); expect(controller.diagnostics.at(-1)?.reason).toBe('guard-command-cooldown');
    controller = issueTacticalOrder(controller, catalog, { kind: 'hold', actorId: A, durationTicks: 3 }); controller = stepCombatController(controller, catalog, 2); expect(controller.battle.entities[A]!.position.x).toBe(0); expect(Object.values(controller.battle.actions).some(action => action.actorId === A)).toBe(false);
    controller = stepCombatController(controller, catalog); expect(controller.orders.some(order => order.actorId === A && order.kind === 'hold')).toBe(false);
  });
  it('does not admit focus/guard orders or spend pacing for a control-locked issuer', () => {
    const controlSkill = active('tactical-control', [apply('status.stagger', 1, 2)]); const content = add(controlSkill);
    let initial = battle([entity(A, 'ally', 0), entity(B, 'ally', 20), entity(E, 'enemy', 160, 0, { skills: [controlSkill.id] })], content);
    initial = issueCommand(initial, content, { kind: 'cast', actorId: E, skillId: controlSkill.id, targetId: A });
    let controller = createCombatController(content, initial, { playerTeam: 'ally', arena });
    controller = issueTacticalOrder(controller, content, { kind: 'focus', actorId: A, targetId: E });
    controller = issueTacticalOrder(controller, content, { kind: 'guard', actorId: A, targetId: B });
    expect(controller.orders).toEqual([]); expect(controller.guardReadyAt).toEqual({}); expect(controller.nextOrderSequence).toBe(1); expect(controller.battle.focusByTeam.ally).toBeUndefined();
    controller = stepCombatController(controller, content, 2);
    controller = issueTacticalOrder(controller, content, { kind: 'focus', actorId: A, targetId: E }); controller = issueTacticalOrder(controller, content, { kind: 'guard', actorId: A, targetId: B });
    expect(controller.orders).toHaveLength(2); expect(controller.guardReadyAt.ally).toBe(82); expect(controller.nextOrderSequence).toBe(3);
  });
  it('does not admit focus/guard during recovery, but an immediate-duration hold remains explicit', () => {
    const rescue = active('tactical-rescue', [{ kind: 'rescue', condition: always, target: { kind: 'intent' }, healthBps: 5000, recoveryLockTicks: 3 }], { targetTeam: 'ally' }); const content = add(rescue);
    let initial = battle([entity(A, 'ally', 20, 20, { health: 10 }), entity(B, 'ally', 0, 20, { skills: [rescue.id] }), entity(E, 'enemy', 40, 20)], content);
    initial = issueCommand(initial, content, { kind: 'basic', actorId: E, targetId: A }); expect(initial.entities[A]!.life).toBe('Downed');
    initial = issueCommand(initial, content, { kind: 'cast', actorId: B, skillId: rescue.id, targetId: A }); expect(initial.entities[A]!.life).toBe('Recovered');
    let controller = createCombatController(content, initial, { playerTeam: 'ally', arena });
    controller = issueTacticalOrder(controller, content, { kind: 'focus', actorId: A, targetId: E }); controller = issueTacticalOrder(controller, content, { kind: 'guard', actorId: A, targetId: B });
    expect(controller.orders).toEqual([]); expect(controller.guardReadyAt).toEqual({}); expect(controller.nextOrderSequence).toBe(1);
    controller = issueTacticalOrder(controller, content, { kind: 'hold', actorId: A, durationTicks: 2 }); expect(controller.orders[0]!.expiresAtTick).toBe(2);
    controller = stepCombatController(controller, content, 3); expect(controller.orders).toEqual([]);
    controller = issueTacticalOrder(controller, content, { kind: 'guard', actorId: A, targetId: B }); expect(controller.orders[0]?.kind).toBe('guard'); expect(controller.guardReadyAt.ally).toBe(83);
  });
  it('returns a bounded draw for unreachable combat and gives the same replay after saving mid-approach', () => {
    const walled = { ...arena, blockedCells: Array.from({ length: arena.heightCells }, (_, y) => ({ x: 4, y })) };
    const initial = createCombatController(catalog, battle([entity(A, 'ally', 0), entity(E, 'enemy', 160)]), { playerTeam: 'ally', arena: walled, maximumTicks: 30, decisionIntervalTicks: 1, movementIntervalTicks: 1 });
    const middle = stepCombatController(initial, catalog, 4); const restored = restoreCombatController(serializeCombatController(middle), catalog, middle.configHash);
    expect(serializeCombatController(restored)).toBe(serializeCombatController(middle));
    const finished = stepCombatController(middle, catalog, 40); expect(stepCombatController(restored, catalog, 40)).toEqual(finished); expect(finished.outcome).toMatchObject({ status: 'draw', reason: 'timeout', resolvedTick: 30 });
    let singles = initial; for (let tick = 0; tick < 30; tick++) singles = stepCombatController(singles, catalog); expect(singles).toEqual(finished);
  });
  it('rejects arena/config replacement on restore even after a forged checksum', () => {
    const initial = createCombatController(catalog, battle([entity(A, 'ally', 0), entity(E, 'enemy', 160)]), { playerTeam: 'ally', arena });
    const envelope = JSON.parse(serializeCombatController(initial)) as { checksum: string; state: { config: { arena: { cellSizeUnits: number } }; configHash: string } };
    envelope.state.config.arena.cellSizeUnits = 10; envelope.state.configHash = stableHash(envelope.state.config); envelope.checksum = stableHash(envelope.state);
    expect(() => restoreCombatController(JSON.stringify(envelope), catalog, initial.configHash)).toThrow();
    expect(() => createCombatController(catalog, initial.battle, { playerTeam: 'ally', arena: { ...arena, cellSizeUnits: 3 } })).toThrow();
  });
});
