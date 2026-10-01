import { describe, expect, it } from 'vitest';
import { combatCatalog } from '../../src/content/definitions';
import { always, base, damage, mechanics, requiredCapabilities, self, ticks } from '../../src/content/definitions/helpers';
import type { ActionAdjustment, ActiveAction, CombatContentCatalog, Mechanics, SkillDefinition } from '../../src/core/combat/definitions';
import { createBattle, issueCommand, prepareCombatCatalog, queryCastReadiness, restoreBattle, serializeBattle, stepBattle } from '../../src/core/combat';
import type { BattleEntityInput } from '../../src/core/combat';
import { createCombatController, restoreCombatController, serializeCombatController, stepCombatController } from '../../src/core/combat/ai';

const A = 'entity:1'; const B = 'entity:2'; const E = 'entity:3';
const arena = { origin: { x: 0, y: 0 }, widthCells: 40, heightCells: 5, cellSizeUnits: 20, blockedCells: [] };
const authored = prepareCombatCatalog(combatCatalog);
function entity(id: string, team: string, x: number, extra: Partial<BattleEntityInput> = {}): BattleEntityInput { return { id, team, position: { x, y: 0 }, stats: { attack: 10, maxHealth: 100 }, basic: { coefficientBps: 10_000, cooldownTicks: 40, castTicks: 1, rangeUnits: 20, school: 'sword' }, ...extra }; }
function skill(id: string, action: Partial<ActiveAction> = {}, m: Mechanics = mechanics()): SkillDefinition { const effects = action.effects ?? [{ ...damage(10_000), canCritical: false }]; return { ...base(`skill.readiness-${id}`, 10, requiredCapabilities(m, effects)), kind: 'skill', activation: 'active', school: 'sword', lifecycleScope: 'character', tags: ['sword', 'active', 'damage'], ultimate: false, mechanics: m, action: { spiritCostUnits: 20, cooldownTicks: 60, castTicks: 4, rangeUnits: 40, targetTeam: 'enemy', target: { kind: 'intent' }, condition: always, effects, commitPolicy: 'castEndRevalidate', missRefundPolicy: 'none', launchedSourceDeathPolicy: 'resolveCommitted', ...action } }; }
function passive(id: string, m: Mechanics): SkillDefinition { return { ...base(`skill.readiness-${id}`, 10, requiredCapabilities(m)), kind: 'skill', activation: 'passive', school: 'sword', lifecycleScope: 'character', tags: ['sword', 'passive'], mechanics: m }; }
const rules = (...adjustments: ActionAdjustment[]) => mechanics([], [], adjustments.map((adjustment, index) => ({ ruleId: `fixture${index}`, tags: ['active'] as const, condition: always, adjustment })));
const add = (...skills: SkillDefinition[]): CombatContentCatalog => prepareCombatCatalog({ ...authored, skills: [...authored.skills, ...skills] });
const battle = (catalog: CombatContentCatalog, entities: BattleEntityInput[]) => createBattle(catalog, { seed: 'cast-readiness', contentMode: 'experimental', entities });

describe('pure shared cast readiness', () => {
  it('admits and lets AI select a discounted skill when spirit is below its base cost', () => {
    const strike = skill('discount', {}, rules({ kind: 'costReductionBps', value: 5000, minimumCostUnits: 1 })); const catalog = add(strike);
    const initial = battle(catalog, [entity(A, 'party', 0, { spirit: 10, skills: [strike.id] }), entity(E, 'enemy', 40)]);
    expect(queryCastReadiness(initial, catalog, A, strike.id, E)).toMatchObject({ ready: true, spiritCostUnits: 10, castTicks: 4 });
    const reserved = issueCommand(initial, catalog, { kind: 'cast', actorId: A, skillId: strike.id, targetId: E });
    expect(reserved.entities[A]!.reservedSpirit).toBe(10);
    const controller = stepCombatController(createCombatController(catalog, initial, { playerTeam: 'party', arena }), catalog);
    expect(controller.agents[A]!.lastChoice).toBe(strike.id); expect(controller.battle.entities[A]!.currentActionId).not.toBeNull();
    expect(stepBattle(reserved, catalog, 4).entities[A]!.spirit).toBe(0);
  });
  it('uses effective extended range and windup for both admission and AI, including haste', () => {
    const strike = skill('reach', { castTicks: 8 }, rules({ kind: 'rangeUnits', value: 60 }, { kind: 'castTimeTicks', value: -2 })); const catalog = add(strike);
    const initial = battle(catalog, [entity(A, 'party', 0, { skills: [strike.id], stats: { attack: 10, maxHealth: 100, hasteBps: 5000 } }), entity(E, 'enemy', 100)]);
    expect(queryCastReadiness(initial, catalog, A, strike.id, E)).toMatchObject({ ready: true, rangeUnits: 100, castTicks: 4 });
    const controller = stepCombatController(createCombatController(catalog, initial, { playerTeam: 'party', arena }), catalog);
    expect(controller.agents[A]!.desiredRangeUnits).toBe(100); expect(controller.battle.entities[A]!.position.x).toBe(0);
    expect(controller.battle.actions[controller.battle.entities[A]!.currentActionId!]!.castEndTick).toBe(4);
  });
  it('previews eligible charges repeatedly without allocating simulation identities or consuming anything', () => {
    const strike = skill('charge');
    const charge = passive('charge-source', mechanics([{ kind: 'augmentNextAction', target: self, condition: always, tags: ['active'], uses: 1, duration: ticks(100), adjustment: { kind: 'costReductionBps', value: 5000, minimumCostUnits: 1 } }]));
    const catalog = add(strike, charge); const initial = battle(catalog, [entity(A, 'party', 0, { spirit: 10, skills: [strike.id], sources: [charge.id] }), entity(E, 'enemy', 40)]);
    const bytes = serializeBattle(initial); const sequences = initial.sequences; const random = initial.random;
    for (let i = 0; i < 50; i++) expect(queryCastReadiness(initial, catalog, A, strike.id, E)).toMatchObject({ ready: true, spiritCostUnits: 10 });
    expect(serializeBattle(initial)).toBe(bytes); expect(initial.sequences).toBe(sequences); expect(initial.random).toBe(random); expect(initial.augments[0]!.uses).toBe(1);
    expect(initial.entities[A]!.reservedSpirit).toBe(0); expect(Object.keys(initial.actions)).toHaveLength(0);
    const reserved = issueCommand(initial, catalog, { kind: 'cast', actorId: A, skillId: strike.id, targetId: E });
    expect(reserved.augments[0]!.uses).toBe(1);
    const complete = stepBattle(reserved, catalog, 4); expect(complete.augments).toHaveLength(0); expect(complete.entities[A]!.spirit).toBe(0);
  });
  it('does not misclassify an unaffordable out-of-range action as a movement-ready skill', () => {
    const strike = skill('insufficient'); const catalog = add(strike); const initial = battle(catalog, [entity(A, 'party', 0, { spirit: 1, skills: [strike.id] }), entity(E, 'enemy', 100)]);
    expect(queryCastReadiness(initial, catalog, A, strike.id, E).reason).toBe('insufficient-spirit');
    expect(stepCombatController(createCombatController(catalog, initial, { playerTeam: 'party', arena }), catalog).agents[A]!.lastChoice).toBe('runtime.basic');
  });
  it('accounts for reservations, casting and cooldown without consuming them in the query', () => {
    const strike = skill('busy'); const catalog = add(strike); const initial = battle(catalog, [entity(A, 'party', 0, { skills: [strike.id] }), entity(E, 'enemy', 40)]);
    const reserved = issueCommand(initial, catalog, { kind: 'cast', actorId: A, skillId: strike.id, targetId: E });
    expect(queryCastReadiness(reserved, catalog, A, strike.id, E)).toMatchObject({ reason: 'actor-casting', availableSpiritUnits: 80 });
    const complete = stepBattle(reserved, catalog, 4);
    expect(queryCastReadiness(complete, catalog, A, strike.id, E)).toMatchObject({ reason: 'cooldown', cooldownRemainingTicks: 60 });
  });
  it('reports incompatible targets, dead/downed targets and actor life locks', () => {
    const strike = skill('life'); const catalog = add(strike); const initial = battle(catalog, [entity(A, 'party', 0, { skills: [strike.id] }), entity(B, 'party', 20), entity(E, 'enemy', 40, { health: 1 })]);
    expect(queryCastReadiness(initial, catalog, A, strike.id, null).reason).toBe('missing-target');
    expect(queryCastReadiness(initial, catalog, A, strike.id, B).reason).toBe('target-team');
    const downed = stepBattle(issueCommand(initial, catalog, { kind: 'cast', actorId: A, skillId: strike.id, targetId: E }), catalog, 64);
    expect(queryCastReadiness(downed, catalog, B, null, E).reason).toBe('target-downed');
    expect(queryCastReadiness(downed, catalog, E, null, A).reason).toBe('actor-downed');
  });
  it('reports death, control and post-rescue recovery locks without issuing actions', () => {
    const lock = skill('control', { castTicks: 0, effects: [{ kind: 'applyStatus', target: { kind: 'intent' }, condition: always, statusId: 'status.stagger', stacks: 1, duration: ticks(10) }] });
    const rescue = skill('rescue', { castTicks: 0, targetTeam: 'ally', effects: [{ kind: 'rescue', target: { kind: 'intent' }, condition: always, healthBps: 5000, recoveryLockTicks: 6 }] });
    const catalog = add(lock, rescue);
    const initial = battle(catalog, [entity(A, 'party', 0, { health: 1 }), entity(B, 'party', 20, { skills: [rescue.id] }), entity(E, 'enemy', 40, { skills: [lock.id] })]);
    const controlled = issueCommand(initial, catalog, { kind: 'cast', actorId: E, skillId: lock.id, targetId: A });
    expect(queryCastReadiness(controlled, catalog, A, null, E).reason).toBe('action-lock');
    // Create the downed ally with an in-range basic attack from a separate fixture.
    let downed = battle(catalog, [entity(A, 'party', 0, { health: 1 }), entity(B, 'party', 40, { skills: [rescue.id] }), entity(E, 'enemy', 20)]);
    downed = stepBattle(issueCommand(downed, catalog, { kind: 'basic', actorId: E, targetId: A }), catalog, 1);
    expect(queryCastReadiness(downed, catalog, B, rescue.id, A).ready).toBe(true);
    const recovered = issueCommand(downed, catalog, { kind: 'cast', actorId: B, skillId: rescue.id, targetId: A });
    expect(queryCastReadiness(recovered, catalog, A, null, E)).toMatchObject({ reason: 'recovery-lock', recoveryRemainingTicks: 6 });
    let dead = battle(catalog, [entity(A, 'party', 0, { health: 1, deathRule: 'immediate' }), entity(B, 'party', 40), entity(E, 'enemy', 20)]);
    dead = stepBattle(issueCommand(dead, catalog, { kind: 'basic', actorId: E, targetId: A }), catalog, 1);
    expect(queryCastReadiness(dead, catalog, A, null, E).reason).toBe('actor-dead');
    expect(queryCastReadiness(dead, catalog, E, null, A).reason).toBe('cooldown');
    expect(queryCastReadiness(stepBattle(dead, catalog, 40), catalog, E, null, A).reason).toBe('target-dead');
  });
  it('keeps identical readiness and deterministic progression after a controller restore', () => {
    const strike = skill('restore', {}, rules({ kind: 'rangeUnits', value: 60 }, { kind: 'costReductionBps', value: 5000, minimumCostUnits: 1 })); const catalog = add(strike);
    const initial = createCombatController(catalog, battle(catalog, [entity(A, 'party', 0, { spirit: 10, skills: [strike.id] }), entity(E, 'enemy', 100)]), { playerTeam: 'party', arena });
    const bytes = serializeCombatController(initial); const restored = restoreCombatController(bytes, catalog, initial.configHash);
    expect(queryCastReadiness(restored.battle, catalog, A, strike.id, E)).toEqual(queryCastReadiness(initial.battle, catalog, A, strike.id, E));
    expect(serializeCombatController(stepCombatController(restored, catalog, 5))).toBe(serializeCombatController(stepCombatController(initial, catalog, 5)));
    expect(serializeCombatController(initial)).toBe(bytes);
  });
});

describe('commit-time revalidation stays live and shared charges remain exclusive', () => {
  it('revalidates an expired discount during windup and releases the original reservation', () => {
    const strike = skill('expiry-cost'); const discount = passive('expiry-discount', rules({ kind: 'costReductionBps', value: 5000, minimumCostUnits: 1 })); const catalog = add(strike, discount);
    const initial = battle(catalog, [entity(A, 'party', 0, { spirit: 10, skills: [strike.id], sources: [{ definitionId: discount.id, options: { duration: ticks(2) } }] }), entity(E, 'enemy', 40)]);
    expect(queryCastReadiness(initial, catalog, A, strike.id, E).spiritCostUnits).toBe(10);
    const reserved = issueCommand(initial, catalog, { kind: 'cast', actorId: A, skillId: strike.id, targetId: E });
    const restored = restoreBattle(serializeBattle(reserved), catalog); const complete = stepBattle(restored, catalog, 4);
    expect(complete.entities[A]!.spirit).toBe(10); expect(complete.entities[A]!.reservedSpirit).toBe(0); expect(complete.entities[E]!.health).toBe(100); expect(complete.statistics.committedActions).toBe(0);
  });
  it('does not preserve an expired range extension through windup', () => {
    const strike = skill('expiry-range'); const reach = passive('expiry-reach', rules({ kind: 'rangeUnits', value: 60 })); const catalog = add(strike, reach);
    const initial = battle(catalog, [entity(A, 'party', 0, { skills: [strike.id], sources: [{ definitionId: reach.id, options: { duration: ticks(2) } }] }), entity(E, 'enemy', 100)]);
    const complete = stepBattle(issueCommand(initial, catalog, { kind: 'cast', actorId: A, skillId: strike.id, targetId: E }), catalog, 4);
    expect(complete.statistics.committedActions).toBe(0); expect(complete.entities[A]!.reservedSpirit).toBe(0); expect(complete.entities[A]!.spirit).toBe(100);
  });
  it('consumes the last party charge only once when two admitted casts contend at commitment', () => {
    const strike = skill('contention'); const discount = passive('shared-charge', mechanics([{ kind: 'augmentNextAction', target: { kind: 'area', team: 'ally', center: 'self', radiusUnits: 200, limit: 6 }, condition: always, tags: ['active'], uses: 1, duration: ticks(100), adjustment: { kind: 'costReductionBps', value: 5000, minimumCostUnits: 1 } }])); const catalog = add(strike, discount);
    let state = battle(catalog, [entity(A, 'party', 0, { spirit: 10, skills: [strike.id], sources: [discount.id] }), entity(B, 'party', 20, { spirit: 10, skills: [strike.id] }), entity(E, 'enemy', 40)]);
    expect(queryCastReadiness(state, catalog, A, strike.id, E).ready).toBe(true); expect(queryCastReadiness(state, catalog, B, strike.id, E).ready).toBe(true);
    for (const actorId of [A, B]) state = issueCommand(state, catalog, { kind: 'cast', actorId, skillId: strike.id, targetId: E });
    expect(state.augments[0]!.uses).toBe(1); expect(state.entities[A]!.reservedSpirit).toBe(10); expect(state.entities[B]!.reservedSpirit).toBe(10);
    state = stepBattle(restoreBattle(serializeBattle(state), catalog), catalog, 4);
    expect(state.statistics.committedActions).toBe(1); expect(state.augments).toHaveLength(0); expect(state.entities[A]!.spirit).toBe(0); expect(state.entities[B]!.spirit).toBe(10); expect(state.entities[B]!.reservedSpirit).toBe(0);
  });
});

describe('nested healing ultimate decisions', () => {
  function controller(health: number, healBelowBps = 6500) { return createCombatController(authored, battle(authored, [entity(A, 'party', 0, { skills: ['skill.yaowang-ding'] }), entity(B, 'party', 20, { health }), entity(E, 'enemy', 600)]), { playerTeam: 'party', arena, policies: { [A]: { allowUltimates: true, healBelowBps } } }); }
  it('does not spend the authored zone-healing ultimate on full allies, even at a 100% threshold', () => {
    const next = stepCombatController(controller(100, 10_000), authored);
    expect(next.agents[A]!.lastChoice).toBe('runtime.basic'); expect(next.battle.entities[A]!.reservedSpirit).toBe(0);
  });
  it('casts the authored zone-healing ultimate on a sufficiently injured ally', () => {
    const next = stepCombatController(controller(40), authored);
    expect(next.agents[A]!.lastChoice).toBe('skill.yaowang-ding'); const action = next.battle.actions[next.battle.entities[A]!.currentActionId!]!;
    expect(action.targetId).toBe(B); expect(action.reservedSpirit).toBe(60);
  });
  it('respects the healing threshold for nested effects', () => { expect(stepCombatController(controller(80), authored).agents[A]!.lastChoice).toBe('runtime.basic'); });
});
