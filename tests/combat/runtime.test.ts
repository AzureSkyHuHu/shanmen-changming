import { describe, expect, it } from 'vitest';
import {
  cleanupBattleScope, createBattle, installCombatSource, issueCommand, prepareCombatCatalog, queryStat,
  removeCombatSource, restoreBattle, serializeBattle, stepBattle,
  type BattleData, type BattleEntityInput, type BattleState,
} from '../../src/core/combat';
import { stableHash } from '../../src/core/kernel';
import type {
  ActiveAction, CombatContentCatalog, EffectPrimitive, Mechanics, ModifierSpec,
  SkillDefinition, StatusDefinition,
} from '../../src/core/combat/definitions';
import { combatCatalog as rawCombatCatalog } from '../../src/content/definitions';
import {
  always, apply, base, damage, infinite, mechanics, modifier, requiredCapabilities,
  self, ticks, trigger,
} from '../../src/content/definitions/helpers';

const combatCatalog = prepareCombatCatalog(rawCombatCatalog);
const A = 'entity:1';
const B = 'entity:2';
const C = 'entity:3';
const E = 'entity:4';
const F = 'entity:5';
const BASIC = { coefficientBps: 10_000, cooldownTicks: 1, castTicks: 1, rangeUnits: 600, school: 'sword' } as const;

function entity(id: string, team = 'allies', overrides: Partial<BattleEntityInput> = {}): BattleEntityInput {
  return {
    id, team, position: { x: 0, y: 0 }, stats: { attack: 100, maxHealth: 1000 },
    spirit: 100, maximumSpirit: 100, basic: BASIC, ...overrides,
  };
}

function fixtureCatalog(...skills: readonly SkillDefinition[]): CombatContentCatalog {
  return prepareCombatCatalog({ ...combatCatalog, skills: [...combatCatalog.skills, ...skills] });
}

function active(slug: string, effects: readonly EffectPrimitive[], overrides: Partial<ActiveAction> = {}, m: Mechanics = mechanics()): SkillDefinition {
  const action: ActiveAction = {
    spiritCostUnits: 10, cooldownTicks: 4, castTicks: 2, rangeUnits: 600,
    targetTeam: 'enemy', target: { kind: 'intent' }, condition: always, effects,
    commitPolicy: 'castEndRevalidate', missRefundPolicy: 'none', launchedSourceDeathPolicy: 'resolveCommitted',
    ...overrides,
  };
  return {
    ...base(`skill.test-${slug}`, 10, requiredCapabilities(m, effects), {
      cost: action.spiritCostUnits, cooldownTicks: action.cooldownTicks, castTicks: action.castTicks,
    }),
    kind: 'skill', school: 'sword', activation: 'active', lifecycleScope: 'character',
    tags: ['sword', 'active', 'damage'], ultimate: false, action, mechanics: m,
  };
}

function passive(slug: string, m: Mechanics): SkillDefinition {
  return {
    ...base(`skill.test-${slug}`, 10, requiredCapabilities(m)), kind: 'skill', school: 'sword',
    activation: 'passive', lifecycleScope: 'character', tags: ['sword', 'passive'], mechanics: m,
  };
}

function flatDamage(units: number): EffectPrimitive {
  return { ...damage(0), amount: { kind: 'flat', units }, canCritical: false };
}

function flatShield(units: number, durationTicks = 100): EffectPrimitive {
  return {
    kind: 'shield', target: self, condition: always, amount: { kind: 'flat', units },
    lifecycleScope: 'encounter', duration: ticks(durationTicks), stackPolicy: 'independent', rounding: 'floor',
  };
}

function statModifier(id: string, value: number, operation: ModifierSpec['operation'] = 'addFlat', extra: Partial<ModifierSpec> = {}): EffectPrimitive {
  const effect = modifier(id, 'attack', value, [], operation);
  return { ...effect, modifier: { ...effect.modifier, ...extra } };
}

function battle(catalog = combatCatalog, entities: readonly BattleEntityInput[] = [entity(A), entity(E, 'enemies')], logCapacity = 1000): BattleState {
  return createBattle(catalog, { seed: 'combat-runtime-conformance', entities, contentMode: 'experimental', logCapacity });
}

function cast(state: BattleState, catalog: CombatContentCatalog, actorId: string, skillId: string, targetId: string): BattleState {
  return issueCommand(state, catalog, { kind: 'cast', actorId, skillId, targetId });
}

function hit(state: BattleState, catalog: CombatContentCatalog, actorId = A, targetId = E): BattleState {
  const cooldownTicks = Math.max(0, (state.entities[actorId]!.cooldowns['runtime.basic'] ?? 0) - state.tick);
  const ready = cooldownTicks > 0 ? stepBattle(state, catalog, cooldownTicks) : state;
  const casting = issueCommand(ready, catalog, { kind: 'basic', actorId, targetId });
  const castTicks = ready.entities[actorId]!.basic.castTicks;
  return castTicks > 0 ? stepBattle(casting, catalog, castTicks) : casting;
}

function sourceIds(state: BattleState, definitionId: string): string[] {
  return Object.values(state.sources).filter((source) => source.sourceDefinitionId === definitionId).map((source) => source.sourceInstanceId);
}

function roundtrip(state: BattleState, catalog: CombatContentCatalog): BattleState {
  const serialized = serializeBattle(state);
  const restored = restoreBattle(serialized, catalog);
  expect(serializeBattle(restored)).toBe(serialized);
  return restored;
}

function hostileSnapshot(state: BattleState, mutate: (copy: BattleData) => void): string {
  const envelope = JSON.parse(serializeBattle(state)) as { state: BattleData; checksum: string };
  mutate(envelope.state);
  envelope.checksum = stableHash(envelope.state);
  return JSON.stringify(envelope);
}

describe('battle action transaction', () => {
  const strike = active('strike', [flatDamage(100)]);
  const catalog = fixtureCatalog(strike);
  const create = () => battle(catalog, [entity(A, 'allies', { skills: [strike.id] }), entity(E, 'enemies')]);

  it('reserves spirit without spending it, then pays and starts cooldown only on commit', () => {
    const original = create();
    const reserved = cast(original, catalog, A, strike.id, E);
    expect(original.entities[A]!.reservedSpirit).toBe(0);
    expect(reserved.entities[A]!.spirit).toBe(100);
    expect(reserved.entities[A]!.reservedSpirit).toBe(10);
    expect(reserved.entities[A]!.cooldowns[strike.id] ?? 0).toBe(0);
    const beforeCommit = stepBattle(reserved, catalog, 1);
    expect(beforeCommit.entities[E]!.health).toBe(1000);
    const committed = stepBattle(beforeCommit, catalog, 1);
    expect(committed.entities[A]!.spirit).toBe(90);
    expect(committed.entities[A]!.reservedSpirit).toBe(0);
    expect(committed.entities[A]!.cooldowns[strike.id]).toBe(6);
    expect(committed.entities[E]!.health).toBe(900);
    expect(committed.log.filter((event) => event.kind === 'action.committed')).toHaveLength(1);
    expect(Object.values(committed.actions)[0]!.paidSpirit).toBe(10);
  });

  it('rejects a second overlapping intent without creating a second reservation', () => {
    const reserved = cast(create(), catalog, A, strike.id, E);
    const result = cast(reserved, catalog, A, strike.id, E);
    expect(result.entities[A]!.reservedSpirit).toBe(10);
    expect(Object.values(result.actions)).toHaveLength(1);
    expect(result.statistics.rejectedCommands).toBe(1);
    expect(stepBattle(result, catalog, 2).entities[A]!.spirit).toBe(90);
  });

  it('does not change the existing cooldown, spirit or action ledger when a cooldown command is rejected', () => {
    const committed = stepBattle(cast(create(), catalog, A, strike.id, E), catalog, 2);
    const rejected = cast(committed, catalog, A, strike.id, E);
    expect(rejected.entities[A]!.cooldowns).toEqual(committed.entities[A]!.cooldowns);
    expect(rejected.entities[A]!.cooldowns[strike.id]).toBe(6);
    expect(rejected.entities[A]!.spirit).toBe(90);
    expect(rejected.entities[A]!.reservedSpirit).toBe(0);
    expect(rejected.actions).toEqual(committed.actions);
    expect(rejected.statistics.rejectedCommands).toBe(committed.statistics.rejectedCommands + 1);
    expect(rejected.log.at(-1)).toMatchObject({ kind: 'command.rejected', reason: 'cooldown' });
    const ready = stepBattle(rejected, catalog, 4);
    const next = stepBattle(cast(ready, catalog, A, strike.id, E), catalog, 2);
    expect(next.entities[A]!.spirit).toBe(80);
    expect(next.statistics.committedActions).toBe(2);
  });

  it('cancellation and an enemy interrupt release the reservation without charging or cooldown', () => {
    for (const command of [
      { kind: 'cancel', actorId: A },
      { kind: 'interrupt', actorId: E, targetId: A, strength: 10 },
    ] as const) {
      const reserved = cast(create(), catalog, A, strike.id, E);
      const cancelled = issueCommand(reserved, catalog, command);
      const result = stepBattle(cancelled, catalog, 3);
      expect(result.entities[A]!.spirit).toBe(100);
      expect(result.entities[A]!.reservedSpirit).toBe(0);
      expect(result.entities[A]!.cooldowns[strike.id] ?? 0).toBe(0);
      expect(result.entities[E]!.health).toBe(1000);
      expect(result.log.filter((event) => event.kind === 'action.committed')).toHaveLength(0);
      expect(Object.values(result.actions)[0]!.state).toBe('Interrupted');
    }
  });

  it('invalidates a cast whose target dies during windup and refunds the reservation', () => {
    let state = battle(catalog, [
      entity(A, 'allies', { skills: [strike.id] }),
      entity(B),
      entity(E, 'enemies', { health: 50, deathRule: 'immediate' }),
      entity(F, 'enemies'),
    ]);
    state = cast(state, catalog, A, strike.id, E);
    state = hit(state, catalog, B, E);
    expect(state.entities[E]!.life).toBe('Dead');
    state = stepBattle(state, catalog, 1);
    expect(state.entities[A]!.spirit).toBe(100);
    expect(state.entities[A]!.reservedSpirit).toBe(0);
    expect(state.entities[A]!.cooldowns[strike.id] ?? 0).toBe(0);
    expect(Object.values(state.actions).find((action) => action.actorId === A)?.state).toBe('Invalidated');
  });

  it('rejects insufficient spirit, illegal team, missing skill and out-of-range targets', () => {
    const invalidStates = [
      battle(catalog, [entity(A, 'allies', { skills: [strike.id], spirit: 9 }), entity(E, 'enemies')]),
      battle(catalog, [entity(A, 'allies', { skills: [strike.id] }), entity(E)]),
      battle(catalog, [entity(A), entity(E, 'enemies')]),
      battle(catalog, [entity(A, 'allies', { skills: [strike.id] }), entity(E, 'enemies', { position: { x: 601, y: 0 } })]),
    ];
    for (const initial of invalidStates) {
      const state = cast(initial, catalog, A, strike.id, E);
      expect(state.statistics.rejectedCommands).toBe(1);
      expect(state.entities[A]!.reservedSpirit).toBe(0);
      expect(state.entities[E]!.health).toBe(1000);
      expect(Object.values(state.actions)).toHaveLength(0);
    }
  });
});

describe('damage, healing and owned contributions', () => {
  it.each([
    { chance: 0, critical: false, damagePerHit: 100 },
    { chance: 10_000, critical: true, damagePerHit: 150 },
  ])('honors the exact $chance-basis-point critical chance boundary', ({ chance, critical, damagePerHit }) => {
    let state = battle(combatCatalog, [
      entity(A, 'allies', { stats: { attack: 100, maxHealth: 1000, criticalChanceBps: chance, criticalMultiplierBps: 15_000 } }),
      entity(E, 'enemies', { stats: { attack: 100, maxHealth: 10_000 } }),
    ]);
    const initialDraws = state.random.combat.draws;
    for (let index = 0; index < 8; index += 1) state = hit(state, combatCatalog);
    const damageEvents = state.log.filter((event) => event.kind === 'damage.healthLost');
    expect(damageEvents).toHaveLength(8);
    expect(damageEvents.every((event) => event.flags.isCritical === critical)).toBe(true);
    expect(damageEvents.every((event) => event.values.requestedDamage === damagePerHit)).toBe(true);
    expect(state.statistics.healthLost).toBe(8 * damagePerHit);
    expect(state.entities[E]!.health).toBe(10_000 - 8 * damagePerHit);
    expect(state.random.combat.draws - initialDraws).toBe(8);
  });

  it('resolves defense before shield absorption and separates requested damage from real health loss', () => {
    const shield = passive('pipeline-shield', mechanics([flatShield(20)]));
    const strike = active('pipeline-strike', [flatDamage(100)]);
    const catalog = fixtureCatalog(shield, strike);
    let state = battle(catalog, [
      entity(A, 'allies', { skills: [strike.id] }),
      entity(E, 'enemies', { stats: { attack: 100, maxHealth: 1000, armor: 100, damageReductionBps: 2000 }, sources: [shield.id] }),
    ]);
    state = stepBattle(cast(state, catalog, A, strike.id, E), catalog, 2);
    expect(state.entities[E]!.health).toBe(980);
    expect(state.statistics.requestedDamage).toBe(100);
    expect(state.statistics.shieldAbsorbed).toBe(20);
    expect(state.statistics.healthLost).toBe(20);
    const damageEvent = state.log.find((event) => event.kind === 'damage.healthLost');
    expect(damageEvent?.values).toMatchObject({ requestedDamage: 100, afterDefense: 40, actualHealthLoss: 20, actualShieldAbsorbed: 20 });
  });

  it('uses cast-snapshot offense and hit-live defense', () => {
    const strike = active('snapshot-strike', [{ ...damage(10_000), canCritical: false }]);
    const attack = passive('late-attack', mechanics([statModifier('lateAttack', 100)]));
    const armor = passive('late-armor', mechanics([{
      ...modifier('lateArmor', 'armor', 100, [], 'addFlat'),
    }]));
    const catalog = fixtureCatalog(strike, attack, armor);
    let state = battle(catalog, [entity(A, 'allies', { skills: [strike.id] }), entity(E, 'enemies')]);
    state = cast(state, catalog, A, strike.id, E);
    state = installCombatSource(state, catalog, A, attack.id);
    state = installCombatSource(state, catalog, E, armor.id);
    state = stepBattle(state, catalog, 2);
    expect(queryStat(state, catalog, A, 'attack')).toBe(200);
    expect(state.entities[E]!.health).toBe(950);
  });

  it('applies flat, shared percentage, independent multiplier and bounds in order', () => {
    const one = passive('modifier-one', mechanics([statModifier('flat', 10), statModifier('percent', 1000, 'addPercentBps')]));
    const two = passive('modifier-two', mechanics([statModifier('flat', 10), statModifier('percent', 1000, 'addPercentBps')]));
    const bounds = passive('modifier-bounds', mechanics([
      statModifier('multiply', 15_000, 'multiplyBps'), statModifier('lower', 150, 'minimum'), statModifier('upper', 210, 'maximum'),
    ]));
    const catalog = fixtureCatalog(one, two, bounds);
    let state = battle(catalog, [entity(A, 'allies', { sources: [one.id, two.id, bounds.id] }), entity(E, 'enemies')]);
    expect(queryStat(state, catalog, A, 'attack')).toBe(210);
    const removedId = sourceIds(state, one.id)[0]!;
    state = removeCombatSource(state, catalog, removedId);
    expect(queryStat(state, catalog, A, 'attack')).toBe(181);
    expect(state.modifiers.some((entry) => entry.sourceInstanceId === removedId)).toBe(false);
    expect(sourceIds(state, two.id)).toHaveLength(1);
    state = removeCombatSource(state, catalog, sourceIds(state, two.id)[0]!);
    expect(queryStat(state, catalog, A, 'attack')).toBe(150);
  });

  it('retains independent instances of the same definition when one source is removed', () => {
    const source = passive('same-source', mechanics([statModifier('overlap', 10)]));
    const catalog = fixtureCatalog(source);
    let state = battle(catalog);
    state = installCombatSource(state, catalog, A, source.id);
    state = installCombatSource(state, catalog, A, source.id);
    const ids = sourceIds(state, source.id);
    expect(ids).toHaveLength(2);
    expect(queryStat(state, catalog, A, 'attack')).toBe(120);
    state = removeCombatSource(state, catalog, ids[0]!);
    expect(queryStat(state, catalog, A, 'attack')).toBe(110);
    expect(sourceIds(state, source.id)).toEqual([ids[1]]);
  });

  it('uses AND tag filters and reevaluates condition-dependent modifiers after shield changes', () => {
    const source = passive('conditional-modifier', mechanics([
      statModifier('tagged', 25, 'addFlat', { tags: ['sword', 'physical'] }),
      statModifier('shielded', 50, 'addFlat', { condition: { kind: 'compare', field: 'actor.shieldUnits', operator: 'gt', value: 0 } }),
      flatShield(10),
    ]));
    const catalog = fixtureCatalog(source);
    let state = battle(catalog, [entity(A, 'allies', { sources: [source.id] }), entity(E, 'enemies')]);
    expect(queryStat(state, catalog, A, 'attack')).toBe(150);
    expect(queryStat(state, catalog, A, 'attack', ['sword'])).toBe(150);
    expect(queryStat(state, catalog, A, 'attack', ['physical', 'sword'])).toBe(175);
    state = hit(state, catalog, E, A);
    expect(queryStat(state, catalog, A, 'attack')).toBe(100);
    expect(queryStat(state, catalog, A, 'attack', ['sword', 'physical'])).toBe(125);
  });

  it('emits a shield break once per shield identity and no life-damage event on a fully absorbed hit', () => {
    const shield = passive('one-break-shield', mechanics([flatShield(150)]));
    const catalog = fixtureCatalog(shield);
    let state = battle(catalog, [entity(A), entity(E, 'enemies', { sources: [shield.id] })]);
    state = hit(state, catalog);
    expect(state.entities[E]!.health).toBe(1000);
    expect(state.log.filter((event) => event.kind === 'damage.healthLost')).toHaveLength(0);
    expect(state.log.filter((event) => event.kind === 'shield.broken')).toHaveLength(0);
    state = hit(state, catalog);
    state = hit(state, catalog);
    const broken = state.log.filter((event) => event.kind === 'shield.broken');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.shieldInstanceId).not.toBeNull();
    expect(state.statistics.shieldAbsorbed).toBe(150);
    expect(state.statistics.healthLost).toBe(150);
  });

  it('tracks effective healing and overhealing without restoring beyond maximum health', () => {
    const heal = active('healing', [{ kind: 'heal', target: { kind: 'intent' }, condition: always, amount: { kind: 'flat', units: 150 }, rounding: 'floor' }], { targetTeam: 'ally' });
    const catalog = fixtureCatalog(heal);
    let state = battle(catalog, [entity(A, 'allies', { skills: [heal.id] }), entity(B, 'allies', { health: 950 }), entity(E, 'enemies')]);
    state = stepBattle(cast(state, catalog, A, heal.id, B), catalog, 2);
    expect(state.entities[B]!.health).toBe(1000);
    expect(state.statistics).toMatchObject({ requestedHealing: 150, effectiveHealing: 50, overhealing: 100 });
    expect(state.log.find((event) => event.kind === 'healing.resolved')?.values).toMatchObject({ requestedHealing: 150, effectiveHealing: 50, overhealing: 100 });
  });

  it('separates timed expiry from lifecycle cleanup and preserves character sources at run cleanup', () => {
    const source = passive('scope-source', mechanics([statModifier('ownedAttack', 10)]));
    const catalog = fixtureCatalog(source);
    let state = battle(catalog);
    state = installCombatSource(state, catalog, A, source.id);
    const characterId = sourceIds(state, source.id)[0]!;
    state = installCombatSource(state, catalog, A, source.id, { lifecycleScope: 'run', duration: ticks(3) });
    expect(queryStat(state, catalog, A, 'attack')).toBe(120);
    state = stepBattle(state, catalog, 3);
    expect(queryStat(state, catalog, A, 'attack')).toBe(110);
    state = installCombatSource(state, catalog, A, source.id, { lifecycleScope: 'run', duration: infinite });
    state = cleanupBattleScope(state, catalog, 'run');
    expect(sourceIds(state, source.id)).toEqual([characterId]);
    expect(queryStat(state, catalog, A, 'attack')).toBe(110);
  });
});

describe('status timing and trigger safety', () => {
  it('retains both appliers of merged sword marks and removes only the uninstalled source contribution', () => {
    let state = battle(combatCatalog, [
      entity(A, 'allies', { skills: ['skill.liuhen-jian', 'skill.guifeng'], sources: ['node.sword.liuhen'] }),
      entity(B, 'allies', { skills: ['skill.liuhen-jian'] }),
      entity(E, 'enemies', { stats: { attack: 100, maxHealth: 3000 } }),
    ]);
    const sourceA = Object.values(state.sources).find((source) => source.holderId === A && source.sourceDefinitionId === 'skill.liuhen-jian')!.sourceInstanceId;
    const sourceB = Object.values(state.sources).find((source) => source.holderId === B && source.sourceDefinitionId === 'skill.liuhen-jian')!.sourceInstanceId;
    state = stepBattle(cast(cast(state, combatCatalog, A, 'skill.liuhen-jian', E), combatCatalog, B, 'skill.liuhen-jian', E), combatCatalog, 8);
    const merged = state.statuses.filter((status) => status.definitionId === 'status.sword-mark');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.stacks).toBe(3);
    expect(merged[0]!.stackSources).toEqual([
      { applierId: A, sourceInstanceId: sourceA, stacks: 2 },
      { applierId: B, sourceInstanceId: sourceB, stacks: 1 },
    ]);
    const consumed = stepBattle(cast(state, combatCatalog, A, 'skill.guifeng', E), combatCatalog, 14);
    const event = consumed.log.find((event) => event.kind === 'status.consumed' && event.statusId === 'status.sword-mark');
    expect(event?.values.consumedStacks).toBe(3);
    expect(event?.consumedApplierIds).toEqual([A, B]);
    const removed = removeCombatSource(state, combatCatalog, sourceA);
    const remaining = removed.statuses.find((status) => status.definitionId === 'status.sword-mark')!;
    expect(remaining.stacks).toBe(1);
    expect(remaining.stackSources).toEqual([{ applierId: B, sourceInstanceId: sourceB, stacks: 1 }]);
    expect(remaining.applierId).toBe(B);
    expect(removed.sources[sourceB]).toBeDefined();
    expect(roundtrip(removed, combatCatalog).statuses).toEqual(removed.statuses);
  });

  it('scales each poison periodic tick by all three accepted stacks', () => {
    const poison = active('three-stack-periodic', [apply('status.poison', 3, 60)]);
    const catalog = fixtureCatalog(poison);
    let state = battle(catalog, [entity(A, 'allies', { skills: [poison.id] }), entity(E, 'enemies')]);
    state = stepBattle(cast(state, catalog, A, poison.id, E), catalog, 2);
    state = stepBattle(state, catalog, 20);
    expect(state.entities[E]!.health).toBe(940);
    state = stepBattle(state, catalog, 20);
    expect(state.entities[E]!.health).toBe(880);
    state = stepBattle(state, catalog, 20);
    expect(state.entities[E]!.health).toBe(880);
    const periodic = state.log.filter((event) => event.kind === 'damage.healthLost' && event.family === 'periodic');
    expect(periodic).toHaveLength(2);
    expect(periodic.every((event) => event.values.actualHealthLoss === 60)).toBe(true);
  });

  it('control interrupts and releases a pending reservation, blocks commands, then unlocks at exclusive expiry', () => {
    const slow = active('controlled-windup', [flatDamage(10)], { castTicks: 10 });
    const control = active('brief-control', [apply('status.stagger', 1, 4)], { castTicks: 1 });
    const catalog = fixtureCatalog(slow, control);
    let state = battle(catalog, [entity(A, 'allies', { skills: [slow.id] }), entity(E, 'enemies', { skills: [control.id] })]);
    state = cast(state, catalog, A, slow.id, E);
    state = stepBattle(cast(state, catalog, E, control.id, A), catalog, 1);
    expect(state.entities[A]!.spirit).toBe(100);
    expect(state.entities[A]!.reservedSpirit).toBe(0);
    expect(Object.values(state.actions).find((action) => action.actorId === A)?.state).toBe('Interrupted');
    state = cast(state, catalog, A, slow.id, E);
    expect(state.log.at(-1)).toMatchObject({ kind: 'command.rejected', reason: 'actor-unavailable' });
    state = stepBattle(state, catalog, 3);
    expect(state.statuses.some((status) => status.definitionId === 'status.stagger')).toBe(true);
    state = stepBattle(state, catalog, 1);
    expect(state.statuses.some((status) => status.definitionId === 'status.stagger')).toBe(false);
    expect(state.log.filter((event) => event.kind === 'control.ended')).toHaveLength(1);
    state = stepBattle(cast(state, catalog, A, slow.id, E), catalog, 10);
    expect(state.entities[A]!.spirit).toBe(90);
    expect(state.entities[E]!.health).toBe(990);
  });

  it('dispel removes a whole poison instance and prevents its future periodic damage', () => {
    const poison = active('dispellable-poison', [apply('status.poison', 3, 80)], { castTicks: 1 });
    const cleanse = active('poison-cleanse', [{ kind: 'dispel', condition: always, target: { kind: 'intent' }, category: 'poison', count: 1 }], { targetTeam: 'ally', castTicks: 1 });
    const catalog = fixtureCatalog(poison, cleanse);
    let state = battle(catalog, [entity(A), entity(B, 'allies', { skills: [cleanse.id] }), entity(E, 'enemies', { skills: [poison.id] })]);
    state = stepBattle(cast(state, catalog, E, poison.id, A), catalog, 1);
    const poisonSource = state.statuses.find((status) => status.definitionId === 'status.poison')!.sourceInstanceId;
    state = stepBattle(cast(state, catalog, B, cleanse.id, A), catalog, 1);
    state = stepBattle(state, catalog, 80);
    expect(state.entities[A]!.health).toBe(1000);
    expect(state.statuses).toHaveLength(0);
    expect(state.sources[poisonSource]).toBeUndefined();
    expect(state.log.filter((event) => event.kind === 'status.removed' && event.statusId === 'status.poison')).toHaveLength(1);
    expect(state.log.find((event) => event.kind === 'status.removed')?.reason).toBe('dispelled');
  });

  it('retains a losing strongest-status source and restores its contribution when the winner is removed', () => {
    const shock = active('competing-shock', [apply('status.shock', 1, 80)], { castTicks: 1 });
    const catalog = fixtureCatalog(shock);
    let state = battle(catalog, [
      entity(A, 'allies', { skills: [shock.id] }), entity(B, 'allies', { skills: [shock.id] }),
      entity(E, 'enemies', { stats: { attack: 100, maxHealth: 1000, armor: 100 } }),
    ]);
    state = stepBattle(cast(cast(state, catalog, A, shock.id, E), catalog, B, shock.id, E), catalog, 1);
    const statuses = state.statuses.filter((status) => status.definitionId === 'status.shock');
    expect(statuses).toHaveLength(2);
    expect(queryStat(state, catalog, E, 'armor')).toBe(98);
    const winner = statuses.find((status) => status.applierId === A)!;
    const fallback = statuses.find((status) => status.applierId === B)!;
    state = removeCombatSource(state, catalog, winner.sourceInstanceId);
    expect(state.sources[fallback.sourceInstanceId]).toBeDefined();
    expect(state.statuses.some((status) => status.statusInstanceId === fallback.statusInstanceId)).toBe(true);
    expect(queryStat(state, catalog, E, 'armor')).toBe(98);
    state = removeCombatSource(state, catalog, fallback.sourceInstanceId);
    expect(queryStat(state, catalog, E, 'armor')).toBe(100);
  });

  it('freezes listeners before effects install a new status, so it cannot hear the originating cast retroactively', () => {
    const template = combatCatalog.statuses.find((status) => status.id === 'status.medicine')!;
    const m = mechanics([], [trigger('lateListener', 'action.committed', always, [flatDamage(7)])]);
    const status: StatusDefinition = {
      ...template, ...base('status.test-late-listener', 18, requiredCapabilities(m)), mechanics: m,
    };
    const skill = active('install-listener', [flatDamage(10), apply(status.id, 1, 100, self)]);
    const catalog: CombatContentCatalog = { ...fixtureCatalog(skill), statuses: [...combatCatalog.statuses, status] };
    let state = battle(catalog, [entity(A, 'allies', { skills: [skill.id] }), entity(E, 'enemies')]);
    state = stepBattle(cast(state, catalog, A, skill.id, E), catalog, 2);
    expect(state.entities[E]!.health).toBe(990);
    expect(state.statuses.some((installed) => installed.definitionId === status.id)).toBe(true);
    expect(state.log.some((event) => event.family === 'lateListener')).toBe(false);
    state = hit(state, catalog);
    expect(state.entities[E]!.health).toBe(883);
    expect(state.log.filter((event) => event.kind === 'damage.healthLost' && event.family === 'lateListener')).toHaveLength(1);
  });

  it('uses the poison applier snapshot and expires before a coincident periodic tick', () => {
    const poison = active('short-poison', [apply('status.poison', 1, 40)]);
    const attack = passive('poison-attack-change', mechanics([statModifier('laterAttack', 900)]));
    const catalog = fixtureCatalog(poison, attack);
    let state = battle(catalog, [entity(A, 'allies', { skills: [poison.id] }), entity(E, 'enemies')]);
    state = stepBattle(cast(state, catalog, A, poison.id, E), catalog, 2);
    expect(state.statuses.find((status) => status.definitionId === 'status.poison')?.expiresAtTick).toBe(42);
    state = installCombatSource(state, catalog, A, attack.id);
    state = stepBattle(state, catalog, 20);
    expect(state.entities[E]!.health).toBe(980);
    state = stepBattle(state, catalog, 20);
    expect(state.entities[E]!.health).toBe(980);
    expect(state.statuses.filter((status) => status.definitionId === 'status.poison')).toHaveLength(0);
    expect(state.log.filter((event) => event.kind === 'status.removed' && event.statusId === 'status.poison')).toHaveLength(1);
  });

  it('keeps poison from different appliers as separate identities and clamps stacks per identity', () => {
    const poison = active('stack-poison', [apply('status.poison', 3, 100)], { cooldownTicks: 0, castTicks: 1 });
    const catalog = fixtureCatalog(poison);
    let state = battle(catalog, [entity(A, 'allies', { skills: [poison.id] }), entity(B, 'allies', { skills: [poison.id] }), entity(E, 'enemies')]);
    state = cast(cast(state, catalog, A, poison.id, E), catalog, B, poison.id, E);
    state = stepBattle(state, catalog, 1);
    state = stepBattle(cast(state, catalog, A, poison.id, E), catalog, 1);
    const poisons = state.statuses.filter((status) => status.definitionId === 'status.poison');
    expect(poisons).toHaveLength(2);
    expect(poisons.map((status) => status.applierId).sort()).toEqual([A, B]);
    expect(poisons.every((status) => status.stacks === 3)).toBe(true);
  });

  it('blocks default proc recursion and preserves immutable root/parent provenance', () => {
    const proc = passive('direct-only-proc', mechanics([], [trigger('directOnly', 'damage.healthLost', always, [flatDamage(10)])]));
    const catalog = fixtureCatalog(proc);
    let state = battle(catalog, [entity(A, 'allies', { sources: [proc.id] }), entity(E, 'enemies')]);
    state = hit(state, catalog);
    const hits = state.log.filter((event) => event.kind === 'damage.healthLost');
    expect(hits).toHaveLength(2);
    expect(state.entities[E]!.health).toBe(890);
    expect(hits[0]!.direct).toBe(true);
    expect(hits[1]!.direct).toBe(false);
    expect(hits[1]!.rootActionId).toBe(hits[0]!.rootActionId);
    expect(hits[1]!.parentId).not.toBeNull();
    expect(hits[1]!.family).toBe('directOnly');
    expect(hits[1]!.originalActorId).toBe(A);
  });

  it('enforces the self-family recursion guard even when an adversarial definition explicitly allowlists itself', () => {
    const original = trigger('selfLoop', 'damage.healthLost', always, [flatDamage(10)]);
    // Deliberately violates the authoring policy to prove the executor also guards recursion.
    const recursive = { ...original, proc: { ...original.proc, allowIndirectFamilies: ['selfLoop'], oncePerRoot: false, internalCooldownTicks: 0 } };
    const source = passive('self-family-loop', mechanics([], [recursive]));
    const catalog = fixtureCatalog(source);
    const state = hit(battle(catalog, [entity(A, 'allies', { sources: [source.id] }), entity(E, 'enemies')]), catalog);
    expect(state.entities[E]!.health).toBe(890);
    expect(state.log.filter((event) => event.kind === 'damage.healthLost')).toHaveLength(2);
    expect(state.triggerLedger.find((ledger) => ledger.triggerId === 'selfLoop')?.activations).toBe(1);
    expect(state.statistics.truncatedProcs).toBe(0);
  });

  it('shares the 64-derived-effect root budget across many independent listeners', () => {
    const sources = Array.from({ length: 3 }, (_, group) => passive(`budget-${group}`, mechanics([], Array.from({ length: 24 }, (_, index) =>
      trigger(`budget-${group}-${index}`, 'damage.healthLost', always, [flatDamage(1)]),
    ))));
    const catalog = fixtureCatalog(...sources);
    let state = battle(catalog, [entity(A, 'allies', { sources: sources.map((source) => source.id) }), entity(E, 'enemies')]);
    state = hit(state, catalog);
    const derived = state.log.filter((event) => event.kind === 'damage.healthLost' && !event.direct);
    expect(derived).toHaveLength(64);
    expect(new Set(derived.map((event) => event.rootActionId)).size).toBe(1);
    expect(state.statistics.truncatedProcs).toBeGreaterThan(0);
    expect(Object.values(state.roots).some((root) => root.exhausted && root.derivedEffects === 64)).toBe(true);
    const restored = roundtrip(state, catalog);
    expect(restored.roots).toEqual(state.roots);
    expect(restored.triggerLedger).toEqual(state.triggerLedger);
  });
});

describe('life transitions settle once', () => {
  it('runs one-use last-breath prevention before downed and never replenishes it on restore', () => {
    let state = battle(combatCatalog, [entity(A, 'allies', { health: 50, sources: ['skill.yuxi'] }), entity(E, 'enemies')]);
    state = hit(state, combatCatalog, E, A);
    expect(state.entities[A]!.life).toBe('Alive');
    expect(state.entities[A]!.health).toBe(100);
    expect(state.statistics.downed).toBe(0);
    state = roundtrip(state, combatCatalog);
    state = hit(state, combatCatalog, E, A);
    expect(state.entities[A]!.life).toBe('Downed');
    expect(state.entities[A]!.health).toBe(0);
    expect(state.statistics.downed).toBe(1);
    expect(state.statistics.deaths).toBe(0);
  });

  it('separates downing, recovery lock and permanent death with one death identity', () => {
    const rescue = active('rescue', [{ kind: 'rescue', target: { kind: 'intent' }, condition: always, healthBps: 2000, recoveryLockTicks: 3 }], { targetTeam: 'ally', castTicks: 1 });
    const catalog = fixtureCatalog(rescue);
    let state = battle(catalog, [entity(A, 'allies', { health: 50 }), entity(B, 'allies', { skills: [rescue.id] }), entity(E, 'enemies', { stats: { attack: 250, maxHealth: 1000 } })]);
    state = hit(state, catalog, E, A);
    expect(state.entities[A]!.life).toBe('Downed');
    expect(state.entities[A]!.deathId).toBeNull();
    expect(state.statistics.deaths).toBe(0);
    state = stepBattle(cast(state, catalog, B, rescue.id, A), catalog, 1);
    expect(state.entities[A]!.life).toBe('Recovered');
    expect(state.entities[A]!.health).toBe(200);
    expect(state.statistics.recovered).toBe(1);
    const rejected = issueCommand(state, catalog, { kind: 'basic', actorId: A, targetId: E });
    expect(rejected.statistics.rejectedCommands).toBe(state.statistics.rejectedCommands + 1);
    state = stepBattle(rejected, catalog, 3);
    expect(state.entities[A]!.life).toBe('Alive');
    state = hit(state, catalog, E, A);
    expect(state.statistics.downed).toBe(2);
    state = issueCommand(state, catalog, { kind: 'finishDowned', actorId: E, targetId: A });
    const deathId = state.entities[A]!.deathId;
    expect(deathId).not.toBeNull();
    state = issueCommand(state, catalog, { kind: 'finishDowned', actorId: E, targetId: A });
    expect(state.entities[A]!.life).toBe('Dead');
    expect(state.entities[A]!.deathId).toBe(deathId);
    expect(state.statistics.deaths).toBe(1);
    expect(state.log.filter((event) => event.kind === 'life.died' && event.targetId === A)).toHaveLength(1);
  });

  it('revalidates two simultaneous lethal actions so death and kill totals settle only once', () => {
    const strike = active('lethal', [flatDamage(100)], { castTicks: 1 });
    const catalog = fixtureCatalog(strike);
    let state = battle(catalog, [entity(A, 'allies', { skills: [strike.id] }), entity(B, 'allies', { skills: [strike.id] }), entity(E, 'enemies', { health: 50, deathRule: 'immediate' }), entity(F, 'enemies')]);
    state = stepBattle(cast(cast(state, catalog, A, strike.id, E), catalog, B, strike.id, E), catalog, 1);
    expect(state.entities[E]!.life).toBe('Dead');
    expect(state.statistics.deaths).toBe(1);
    expect(state.statistics.healthLost).toBe(50);
    expect(Object.values(state.statistics.byEntity).reduce((sum, entry) => sum + entry.kills, 0)).toBe(1);
    expect(Object.values(state.actions).filter((action) => action.state === 'Invalidated')).toHaveLength(1);
    expect(state.entities[A]!.spirit + state.entities[B]!.spirit).toBe(190);
  });
});

describe('representative authored build chains', () => {
  it('does not spend shared team budgets on an unavailable bound talisman and resumes after recovery', () => {
    const paid = active('bound-paid', [flatDamage(1)], { castTicks: 0, cooldownTicks: 0 });
    const rescue = active('bound-rescue', [{ kind: 'rescue', target: { kind: 'intent' }, condition: always, healthBps: 5000, recoveryLockTicks: 0 }], { targetTeam: 'ally', castTicks: 0, cooldownTicks: 0 });
    const content = fixtureCatalog(paid, rescue);
    let state = battle(content, [entity(A, 'allies', { skills: [paid.id] }), entity(B, 'allies', { skills: [paid.id, rescue.id] }), entity(C, 'allies', { health: 50, skills: ['skill.yinlei'] }), entity(E, 'enemies', { stats: { attack: 100, maxHealth: 5000 } })]);
    state = installCombatSource(state, content, A, 'talent.yifa-tongming', { boundHolderId: C });
    state = hit(state, content, E, C); expect(state.entities[C]!.life).toBe('Downed');
    state = cast(cast(state, content, A, paid.id, E), content, B, paid.id, E);
    expect(state.triggerLedger.some(ledger => ledger.triggerId === 'distinctCasterRune')).toBe(false);
    state = cast(state, content, B, rescue.id, C); expect(state.entities[C]!.life).toBe('Recovered');
    state = cast(cast(state, content, A, paid.id, E), content, B, paid.id, E);
    expect(state.triggerLedger.find(ledger => ledger.triggerId === 'distinctCasterRune')?.activations).toBe(1);
    expect(state.statuses.filter(status => status.holderId === C && status.definitionId === 'status.rune').reduce((sum, status) => sum + status.stacks, 0)).toBe(1);
    state = stepBattle(roundtrip(state, content), content, 40);
    state = cast(state, content, C, 'skill.yinlei', E); expect(state.entities[C]!.currentActionId).not.toBeNull();
    state = cast(state, content, A, paid.id, E);
    expect(state.triggerLedger.find(ledger => ledger.triggerId === 'distinctCasterRune')?.activations).toBe(2);
  });
  it('preserves a duplicate team talent shared cooldown when its winning source is uninstalled', () => {
    let state = battle(combatCatalog, [
      entity(A, 'allies', { sources: ['talent.bingjian-shouyu'] }),
      entity(B, 'allies', { sources: ['talent.bingjian-shouyu'] }), entity(E, 'enemies'),
    ]);
    const winner = Object.values(state.sources).find((source) => source.holderId === A && source.sourceDefinitionId === 'talent.bingjian-shouyu')!.sourceInstanceId;
    state = issueCommand(state, combatCatalog, { kind: 'guard', actorId: A, targetId: B });
    expect(state.shields.reduce((sum, shield) => sum + shield.remaining, 0)).toBe(120);
    expect(state.triggerLedger.filter((ledger) => ledger.triggerId === 'guardParty')).toHaveLength(1);
    expect(Object.values(state.teamBudgets)).toHaveLength(1);
    const budget = Object.values(state.teamBudgets)[0]!;
    expect(state.triggerLedger.find((ledger) => ledger.triggerId === 'guardParty')).toMatchObject({ sourceInstanceId: budget.budgetId, activations: 1, cooldownUntilTick: 160 });
    state = removeCombatSource(state, combatCatalog, winner);
    expect(state.shields).toHaveLength(0);
    state = roundtrip(state, combatCatalog);
    state = issueCommand(state, combatCatalog, { kind: 'guard', actorId: B, targetId: A });
    expect(state.shields).toHaveLength(0);
    expect(state.triggerLedger.find((ledger) => ledger.triggerId === 'guardParty')?.activations).toBe(1);
    expect(Object.values(state.teamBudgets)[0]!.budgetId).toBe(budget.budgetId);
    state = stepBattle(state, combatCatalog, 160);
    state = issueCommand(state, combatCatalog, { kind: 'guard', actorId: B, targetId: A });
    expect(state.shields.reduce((sum, shield) => sum + shield.remaining, 0)).toBe(120);
    expect(state.triggerLedger.find((ledger) => ledger.triggerId === 'guardParty')?.activations).toBe(2);
  });

  it('sword marks feed guifeng, spirit refund and exactly one crossed-edge follow-up', () => {
    let state = battle(combatCatalog, [
      entity(A, 'allies', { skills: ['skill.liuhen-jian', 'skill.guifeng'], sources: ['node.sword.liuhen', 'talent.xigui-jianmai', 'talent.cuofeng'] }),
      entity(B, 'allies', { skills: ['skill.liuhen-jian'] }),
      entity(E, 'enemies', { stats: { attack: 100, maxHealth: 3000 } }),
    ]);
    state = cast(cast(state, combatCatalog, A, 'skill.liuhen-jian', E), combatCatalog, B, 'skill.liuhen-jian', E);
    state = stepBattle(state, combatCatalog, 8);
    expect(state.statuses.find((status) => status.definitionId === 'status.sword-mark')?.stacks).toBe(3);
    state = stepBattle(cast(state, combatCatalog, A, 'skill.guifeng', E), combatCatalog, 14);
    expect(state.entities[A]!.spirit).toBe(79);
    expect(state.entities[E]!.health).toBe(2570);
    expect(state.statuses.some((status) => status.definitionId === 'status.sword-mark')).toBe(false);
    expect(state.statuses.some((status) => status.definitionId === 'status.crossed-edge' && status.holderId === A)).toBe(true);
    state = hit(state, combatCatalog);
    expect(state.entities[E]!.health).toBe(2440);
    expect(state.statuses.some((status) => status.definitionId === 'status.crossed-edge')).toBe(false);
    state = hit(state, combatCatalog);
    expect(state.entities[E]!.health).toBe(2340);
  });

  it('poison consumed by another caster grants medicine, renews living targets and shields an ally', () => {
    let state = battle(combatCatalog, [
      entity(A, 'allies', { health: 500, skills: ['skill.qingwu', 'skill.huichun'], sources: ['skill.yaoli', 'talent.wenyao-yuxing', 'talent.yuhuo-zhaolu'] }),
      entity(B, 'allies', { skills: ['skill.fenzhang'], sources: ['talent.yaoyan-yanmian'] }),
      entity(E, 'enemies', { stats: { attack: 100, maxHealth: 3000 } }),
    ]);
    state = stepBattle(cast(state, combatCatalog, A, 'skill.qingwu', E), combatCatalog, 14);
    state = stepBattle(cast(state, combatCatalog, B, 'skill.fenzhang', E), combatCatalog, 20);
    expect(state.statuses.some((status) => status.definitionId === 'status.medicine' && status.holderId === A && status.stacks === 1)).toBe(true);
    expect(state.statuses.some((status) => status.definitionId === 'status.poison' && status.holderId === E && status.applierId === B)).toBe(true);
    expect(state.shields.filter((shield) => shield.holderId === A).reduce((sum, shield) => sum + shield.remaining, 0)).toBe(50);
    const consumed = state.log.find((event) => event.kind === 'status.consumed' && event.statusId === 'status.poison');
    expect(consumed?.consumedApplierIds).toEqual([A]);
    expect(consumed?.values.consumedStacks).toBe(1);
    state = stepBattle(cast(state, combatCatalog, A, 'skill.huichun', A), combatCatalog, 16);
    expect(state.entities[A]!.health).toBe(680);
    expect(state.statistics.effectiveHealing).toBe(180);
    expect(state.statuses.some((status) => status.definitionId === 'status.medicine')).toBe(false);
  });

  it('does not let queued poison renewal recreate a status on a target killed by detonation', () => {
    let state = battle(combatCatalog, [
      entity(A, 'allies', { skills: ['skill.qingwu'] }),
      entity(B, 'allies', { skills: ['skill.fenzhang'], sources: ['talent.yaoyan-yanmian'] }),
      entity(E, 'enemies', { health: 100, deathRule: 'immediate' }),
      entity(F, 'enemies', { position: { x: 900, y: 0 } }),
    ]);
    state = stepBattle(cast(state, combatCatalog, A, 'skill.qingwu', E), combatCatalog, 14);
    state = stepBattle(cast(state, combatCatalog, B, 'skill.fenzhang', E), combatCatalog, 20);
    expect(state.entities[E]!.life).toBe('Dead');
    expect(state.statistics.deaths).toBe(1);
    expect(state.statuses.some((status) => status.holderId === E)).toBe(false);
  });

  it('hostile shield absorption stores real force, releases it once and protects another ally', () => {
    let state = battle(combatCatalog, [
      entity(A, 'allies', { skills: ['skill.baoyue'], sources: ['skill.xujin', 'talent.fanzhen', 'talent.humai'] }),
      entity(B),
      entity(E, 'enemies'),
    ]);
    state = stepBattle(cast(state, combatCatalog, A, 'skill.baoyue', A), combatCatalog, 10);
    state = hit(state, combatCatalog, E, A);
    expect(state.entities[A]!.health).toBe(1000);
    expect(state.force.filter((entry) => entry.holderId === A).reduce((sum, entry) => sum + entry.units, 0)).toBe(40);
    state = hit(state, combatCatalog);
    expect(state.entities[E]!.health).toBe(868);
    expect(state.force.filter((entry) => entry.holderId === A).reduce((sum, entry) => sum + entry.units, 0)).toBe(0);
    expect(state.shields.filter((shield) => shield.holderId === B).reduce((sum, shield) => sum + shield.remaining, 0)).toBe(60);
    expect(state.log.filter((event) => event.kind === 'force.released')).toHaveLength(1);
    state = hit(state, combatCatalog);
    expect(state.entities[E]!.health).toBe(768);
    expect(state.log.filter((event) => event.kind === 'force.released')).toHaveLength(1);
  });

  it('three genuine paid party casts produce a shared discount and bind runes to the selected talisman', () => {
    let state = battle(combatCatalog, [
      entity(A, 'allies', { skills: ['skill.liuhen-jian'], sources: ['talent.sanyao-hepai'] }),
      entity(B, 'allies', { health: 500, skills: ['skill.huichun'] }),
      entity(C, 'allies', { skills: ['skill.yinlei'], sources: ['skill.fumai'] }),
      entity(E, 'enemies', { stats: { attack: 100, maxHealth: 3000 } }),
    ]);
    state = installCombatSource(state, combatCatalog, A, 'talent.yifa-tongming', { boundHolderId: C });
    state = cast(state, combatCatalog, A, 'skill.liuhen-jian', E);
    state = cast(state, combatCatalog, B, 'skill.huichun', B);
    state = cast(state, combatCatalog, C, 'skill.yinlei', E);
    state = stepBattle(state, combatCatalog, 18);
    const history = Object.values(state.castHistory).flat();
    expect(history).toHaveLength(3);
    expect(new Set(history.map((record) => record.actorId))).toEqual(new Set([A, B, C]));
    expect(new Set(history.map((record) => record.school))).toEqual(new Set(['sword', 'alchemy', 'talisman']));
    const discounts = state.augments.filter((charge) => charge.adjustment.kind === 'costReductionBps');
    expect(discounts).toHaveLength(1);
    expect(discounts[0]!.uses).toBe(3);
    expect([...discounts[0]!.recipientIds].sort()).toEqual([A, B, C]);
    expect(state.statuses.filter((status) => status.definitionId === 'status.rune' && status.holderId === C).reduce((sum, status) => sum + status.stacks, 0)).toBe(2);
    expect(state.statuses.some((status) => status.definitionId === 'status.rune' && status.holderId !== C)).toBe(false);
    expect(state.log.filter((event) => event.kind === 'castHistory.recorded').at(-1)?.values.distinctCasterCount).toBe(3);
  });
});

describe('action augment ownership and definition-driven capability gate', () => {
  it('detects in-place edits to a caller-owned catalog while a prepared owned copy stays unchanged', () => {
    const skill = active('mutable-catalog', [flatDamage(10)]);
    if (skill.activation !== 'active') throw new Error('The mutable catalog fixture must be active');
    const mutableAction = { ...skill.action };
    const mutableSkill: SkillDefinition = { ...skill, action: mutableAction };
    const callerCatalog: CombatContentCatalog = { ...rawCombatCatalog, skills: [...rawCombatCatalog.skills, mutableSkill] };
    const prepared = prepareCombatCatalog(callerCatalog);
    const entities = [entity(A, 'allies', { skills: [skill.id] }), entity(E, 'enemies')];
    const callerState = battle(callerCatalog, entities);
    const preparedState = battle(prepared, entities);
    mutableAction.spiritCostUnits = 99;
    expect(() => cast(callerState, callerCatalog, A, skill.id, E)).toThrow(/catalog/i);
    const preparedSkill = prepared.skills.find((definition) => definition.id === skill.id)!;
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(preparedSkill)).toBe(true);
    if (preparedSkill.activation !== 'active') throw new Error('The prepared fixture must retain its active definition');
    expect(Object.isFrozen(preparedSkill.action)).toBe(true);
    expect(preparedSkill.action.spiritCostUnits).toBe(10);
    const result = stepBattle(cast(preparedState, prepared, A, skill.id, E), prepared, 2);
    expect(result.entities[A]!.spirit).toBe(90);
    expect(result.entities[E]!.health).toBe(990);
  });

  it('consumes a party-shared augment only on commit, and applies its uses budget across recipients', () => {
    const strike = active('discount-strike', [flatDamage(1)], { cooldownTicks: 0, castTicks: 1 });
    const discount = passive('shared-discount', mechanics([{
      kind: 'augmentNextAction', condition: always,
      target: { kind: 'area', team: 'ally', center: 'self', radiusUnits: 600, limit: 6 },
      tags: ['active'], uses: 2, duration: ticks(100),
      adjustment: { kind: 'costReductionBps', value: 2000, minimumCostUnits: 1 },
    }]));
    const catalog = fixtureCatalog(strike, discount);
    let state = battle(catalog, [
      entity(A, 'allies', { skills: [strike.id], sources: [discount.id] }),
      entity(B, 'allies', { skills: [strike.id] }), entity(C, 'allies', { skills: [strike.id] }), entity(E, 'enemies'),
    ]);
    expect(state.augments).toHaveLength(1);
    state = cast(state, catalog, A, strike.id, E);
    expect(state.augments[0]!.uses).toBe(2);
    state = issueCommand(state, catalog, { kind: 'cancel', actorId: A });
    expect(state.augments[0]!.uses).toBe(2);
    state = cast(cast(state, catalog, A, strike.id, E), catalog, B, strike.id, E);
    state = stepBattle(state, catalog, 1);
    expect(state.entities[A]!.spirit).toBe(92);
    expect(state.entities[B]!.spirit).toBe(92);
    expect(state.augments.reduce((sum, charge) => sum + charge.uses, 0)).toBe(0);
    state = stepBattle(cast(state, catalog, C, strike.id, E), catalog, 1);
    expect(state.entities[C]!.spirit).toBe(90);
  });

  it('installs active-skill mechanics from data instead of switching on known definition names', () => {
    const strike = active('renamed-rule', [flatDamage(100)], {}, mechanics([], [], [{
      ruleId: 'fixtureCost', tags: ['active'], condition: always,
      adjustment: { kind: 'costReductionBps', value: 5000, minimumCostUnits: 1 },
    }]));
    const catalog = fixtureCatalog(strike);
    let state = battle(catalog, [entity(A, 'allies', { skills: [strike.id] }), entity(E, 'enemies')]);
    expect(sourceIds(state, strike.id)).toHaveLength(1);
    state = stepBattle(cast(state, catalog, A, strike.id, E), catalog, 2);
    expect(state.entities[A]!.spirit).toBe(95);
    expect(state.entities[E]!.health).toBe(900);
  });

  it('requires explicit experimental execution for definition-only authored content', () => {
    expect(() => createBattle(combatCatalog, {
      seed: 'verified-content-gate', entities: [entity(A, 'allies', { skills: ['skill.liuhen-jian'] }), entity(E, 'enemies')],
    })).toThrow();
    expect(() => battle(combatCatalog, [entity(A, 'allies', { skills: ['skill.liuhen-jian'] }), entity(E, 'enemies')])).not.toThrow();
  });

  it.each<EffectPrimitive>([
    { kind: 'zone', target: self, condition: always, radiusUnits: 40, intervalTicks: 0, duration: ticks(10), effects: [flatDamage(1)] },
    { kind: 'summon', target: self, condition: always, summonId: 'summon.paper-decoy', maximumPerCaster: 1, duration: infinite },
    { kind: 'applyStatus', target: self, condition: always, statusId: 'status.poison', stacks: 1, duration: { kind: 'nodes', nodes: 1 } },
    { kind: 'augmentNextAction', target: self, condition: always, tags: ['active'], uses: 1, duration: ticks(10), adjustment: { kind: 'additionalChainTargets', value: 1, staggerTicks: 16 } },
  ])('rejects unsupported or ambiguous effect parameters in experimental mode: $kind', (effect) => {
    const invalid = active(`invalid-${effect.kind}`, [effect]); const catalog = fixtureCatalog(invalid);
    expect(() => battle(catalog, [entity(A, 'allies', { skills: [invalid.id] }), entity(E, 'enemies')])).toThrow();
  });
});

describe('deterministic replay, snapshots and bounded logs', () => {
  it('bounds completed actions and old root references beyond 256 actions while preserving totals and replay', () => {
    const proc = passive('retained-ledger', mechanics([], [trigger('retainedEcho', 'damage.healthLost', always, [flatDamage(1)])]));
    const catalog = fixtureCatalog(proc);
    let state = battle(catalog, [entity(A, 'allies', { sources: [proc.id] }), entity(E, 'enemies', { stats: { attack: 100, maxHealth: 100_000 } })], 2);
    state = hit(state, catalog);
    const oldestAction = Object.keys(state.actions)[0]!;
    for (let index = 1; index < 300; index += 1) state = hit(state, catalog);
    expect(state.statistics.committedActions).toBe(300);
    expect(state.statistics.rejectedCommands).toBe(0);
    expect(state.statistics.requestedDamage).toBe(30_300);
    expect(state.statistics.healthLost).toBe(30_300);
    expect(state.statistics.byEntity[A]!.damage).toBe(30_300);
    expect(state.entities[E]!.health).toBe(69_700);
    expect(state.log.length).toBeLessThanOrEqual(2);
    expect(Object.keys(state.actions).length).toBeLessThanOrEqual(256);
    expect(Object.keys(state.roots).length).toBeLessThanOrEqual(256);
    expect(state.actions[oldestAction]).toBeUndefined();
    expect(state.roots[oldestAction]).toBeUndefined();
    expect(Object.keys(state.actions).every((actionId) => state.roots[actionId] !== undefined)).toBe(true);
    const ledger = state.triggerLedger.find((entry) => entry.triggerId === 'retainedEcho')!;
    expect(ledger.activations).toBe(300);
    expect(ledger.roots.length).toBeLessThanOrEqual(256);
    expect(ledger.roots.every((rootId) => state.roots[rootId] !== undefined)).toBe(true);
    expect(ledger.roots).not.toContain(oldestAction);
    const restored = roundtrip(state, catalog);
    const continued = hit(state, catalog);
    expect(hit(restored, catalog)).toEqual(continued);
    expect(continued.statistics.healthLost).toBe(30_401);
    expect(Object.keys(continued.roots).length).toBeLessThanOrEqual(256);
  });

  it('matches replay and restored mid-cast continuation, including RNG, IDs, ledger and provenance', () => {
    const strike = active('replay-strike', [damage(10_000), apply('status.poison', 1, 80)], { castTicks: 3, cooldownTicks: 4 });
    const proc = passive('replay-proc', mechanics([], [trigger('replayEcho', 'damage.healthLost', always, [flatDamage(3)], 5)]));
    const catalog = fixtureCatalog(strike, proc);
    const create = () => battle(catalog, [
      entity(A, 'allies', { stats: { attack: 100, maxHealth: 1000, criticalChanceBps: 5000, criticalMultiplierBps: 15_000 }, skills: [strike.id], sources: [proc.id] }),
      entity(E, 'enemies', { stats: { attack: 100, maxHealth: 10_000 } }),
    ]);
    const start = stepBattle(cast(create(), catalog, A, strike.id, E), catalog, 1);
    const continueBattle = (initial: BattleState) => {
      let state = stepBattle(initial, catalog, 10);
      state = cast(state, catalog, A, strike.id, E);
      state = stepBattle(state, catalog, 25);
      state = hit(state, catalog);
      return stepBattle(state, catalog, 60);
    };
    const expected = continueBattle(start);
    const restored = continueBattle(roundtrip(start, catalog));
    const replayed = continueBattle(stepBattle(cast(create(), catalog, A, strike.id, E), catalog, 1));
    expect(restored).toEqual(expected);
    expect(replayed).toEqual(expected);
    expect(serializeBattle(restored)).toBe(serializeBattle(expected));
    expect(expected.log.every((event, index, log) => index === 0 || log[index - 1]!.sequence < event.sequence)).toBe(true);
  });

  it('tick batching does not change periodic state, events, random draws or expiry boundaries', () => {
    const poison = active('batch-poison', [apply('status.poison', 2, 80)]);
    const catalog = fixtureCatalog(poison);
    const initial = cast(battle(catalog, [entity(A, 'allies', { skills: [poison.id] }), entity(E, 'enemies')]), catalog, A, poison.id, E);
    const batched = stepBattle(initial, catalog, 100);
    let single = initial;
    for (let index = 0; index < 100; index += 1) single = stepBattle(single, catalog);
    expect(single).toEqual(batched);
  });

  it('retains lifetime totals when diagnostic events are evicted from the bounded log', () => {
    let state = battle(combatCatalog, [entity(A), entity(E, 'enemies', { stats: { attack: 100, maxHealth: 10_000 } })], 3);
    for (let index = 0; index < 12; index += 1) state = hit(state, combatCatalog);
    expect(state.log.length).toBeLessThanOrEqual(3);
    expect(state.statistics.healthLost).toBe(1200);
    expect(state.statistics.requestedDamage).toBe(1200);
    expect(state.statistics.committedActions).toBe(12);
    expect(state.statistics.eventCount).toBeGreaterThan(state.log.length);
    expect(state.statistics.byEntity[A]!.damage).toBe(1200);
    const restored = roundtrip(state, combatCatalog);
    expect(restored.statistics).toEqual(state.statistics);
    expect(restored.log).toEqual(state.log);
  });

  it('rejects snapshot version and catalog identity mismatches instead of silently changing replay', () => {
    const state = battle();
    const snapshot = serializeBattle(state);
    const parsed = JSON.parse(snapshot) as Record<string, unknown>;
    expect(() => restoreBattle(JSON.stringify({ ...parsed, snapshotVersion: 999 }), combatCatalog)).toThrow();
    expect(() => restoreBattle(snapshot, { ...combatCatalog, contentVersion: 'incompatible-content' })).toThrow();
    expect(() => restoreBattle('{broken', combatCatalog)).toThrow();
  });

  it('rejects modified snapshot state when the original checksum no longer matches', () => {
    const state = battle();
    const envelope = JSON.parse(serializeBattle(state)) as { state: { entities: Record<string, { health: number }> } };
    envelope.state.entities[A]!.health = 999;
    expect(() => restoreBattle(JSON.stringify(envelope), combatCatalog)).toThrow(/checksum/);
    expect(state.entities[A]!.health).toBe(1000);
  });

  it('rejects forged basic-action programs even when the attacker recomputes the checksum', () => {
    const state = issueCommand(battle(), combatCatalog, { kind: 'basic', actorId: A, targetId: E });
    const original = Object.values(state.actions)[0]!.effects[0]!;
    if (original.kind !== 'damage') throw new Error('The basic attack fixture must be damage');
    const replacements: readonly EffectPrimitive[] = [
      { kind: 'heal', condition: always, target: self, amount: { kind: 'flat', units: 999 }, rounding: 'floor' },
      { ...original, target: self },
      { ...original, target: { kind: 'area', team: 'enemy', center: 'self', radiusUnits: 600, limit: 6 } },
      { ...original, amount: { kind: 'flat', units: 999_999 } },
      { ...original, armorPenetrationBps: 10_000 },
    ];
    for (const replacement of replacements) {
      const text = hostileSnapshot(state, (copy) => { Object.values(copy.actions)[0]!.effects = [replacement]; });
      expect(() => restoreBattle(text, combatCatalog)).toThrow();
    }
  });

  it('rejects missing, malformed and dangling source nullable fields with a recomputed checksum', () => {
    const source = passive('snapshot-source-shape', mechanics([statModifier('attack', 1)]));
    const catalog = fixtureCatalog(source);
    const state = battle(catalog, [entity(A, 'allies', { sources: [source.id] }), entity(E, 'enemies')]);
    const mutations: readonly ((copy: BattleData) => void)[] = [
      (copy) => { delete (Object.values(copy.sources)[0]! as unknown as Record<string, unknown>).parentSourceInstanceId; },
      (copy) => { (Object.values(copy.sources)[0]! as unknown as Record<string, unknown>).expiresAtTick = 'forever'; },
      (copy) => { (Object.values(copy.sources)[0]! as unknown as Record<string, unknown>).remainingNodes = false; },
      (copy) => { Object.values(copy.sources)[0]!.parentSourceInstanceId = 'instance:999999'; },
      (copy) => { Object.values(copy.sources)[0]!.statusInstanceId = 'instance:999999'; },
    ];
    for (const mutate of mutations) expect(() => restoreBattle(hostileSnapshot(state, mutate), catalog)).toThrow();
  });

  it('rejects self-parent and multi-source parent cycles even with valid source references and checksum', () => {
    const source = passive('snapshot-parent-cycle', mechanics([statModifier('attack', 1)]));
    const catalog = fixtureCatalog(source);
    let state = battle(catalog);
    state = installCombatSource(state, catalog, A, source.id);
    state = installCombatSource(state, catalog, A, source.id);
    const selfCycle = hostileSnapshot(state, (copy) => {
      const source = Object.values(copy.sources)[0]!;
      source.parentSourceInstanceId = source.sourceInstanceId;
    });
    const pairCycle = hostileSnapshot(state, (copy) => {
      const [first, second] = Object.values(copy.sources);
      first!.parentSourceInstanceId = second!.sourceInstanceId;
      second!.parentSourceInstanceId = first!.sourceInstanceId;
    });
    expect(() => restoreBattle(selfCycle, catalog)).toThrow();
    expect(() => restoreBattle(pairCycle, catalog)).toThrow();
  });

  it('rejects augment adjustments substituted for their source-defined program despite a valid checksum', () => {
    const discount = passive('snapshot-augment', mechanics([{
      kind: 'augmentNextAction', target: self, condition: always, tags: ['active'], uses: 2, duration: ticks(100),
      adjustment: { kind: 'costReductionBps', value: 2000, minimumCostUnits: 1 },
    }]));
    const catalog = fixtureCatalog(discount);
    const state = battle(catalog, [entity(A, 'allies', { sources: [discount.id] }), entity(E, 'enemies')]);
    expect(state.augments).toHaveLength(1);
    const inflatedDiscount = hostileSnapshot(state, (copy) => {
      copy.augments[0]!.adjustment = { kind: 'costReductionBps', value: 10_000, minimumCostUnits: 1 };
    });
    const arbitraryDamage = hostileSnapshot(state, (copy) => {
      copy.augments[0]!.adjustment = { kind: 'bonusDamageBps', value: 999_999 };
    });
    expect(() => restoreBattle(inflatedDiscount, catalog)).toThrow();
    expect(() => restoreBattle(arbitraryDamage, catalog)).toThrow();
  });
});
