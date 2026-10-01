import { describe, expect, it } from 'vitest';
import {
  cleanupBattleScope, createBattle, installCombatSource, issueCommand, prepareCombatCatalog,
  queryStat, restoreBattle, serializeBattle, stepBattle,
  type BattleEntityInput, type BattleState,
} from '../../src/core/combat';
import type { SkillDefinition, TalentDefinition } from '../../src/core/combat/definitions';
import { combatCatalog } from '../../src/content/definitions';
import { base, mechanics, modifier, requiredCapabilities, ticks } from '../../src/content/definitions/helpers';

const A = 'entity:1';
const B = 'entity:2';
const C = 'entity:3';
const E = 'entity:4';
const TREE = 'node.body.houtu';
const healthEffect = modifier('admissionRunHealth', 'maxHealth', 2500);
const runMechanics = mechanics([{ ...healthEffect, modifier: { ...healthEffect.modifier, lifecycleScope: 'run' } }]);
const runHealth: TalentDefinition = {
  ...base('talent.test-admission-health', 15, requiredCapabilities(runMechanics)),
  kind: 'talent', lifecycleScope: 'run', holderScope: 'personal', category: 'general',
  buildId: 'build.xuanjia-huixiang', offerRole: 'support', maximumRank: 1,
  prerequisites: [], excludes: [], requiredSourceTags: [], providesSourceTags: [],
  teamStackPolicy: 'notApplicable', recipientBinding: 'holder', mechanics: runMechanics,
};
const skillMechanics = mechanics([modifier('admissionSkillHealth', 'maxHealth', 1000)]);
const healthSkill: SkillDefinition = {
  ...base('skill.test-admission-health', 10, requiredCapabilities(skillMechanics)),
  kind: 'skill', school: 'body', activation: 'passive', lifecycleScope: 'character',
  mechanics: skillMechanics,
};
const partyHealth: TalentDefinition = {
  ...runHealth, ...base('talent.test-admission-party-health', 15, ['installModifier']),
  mechanics: mechanics([{ ...runMechanics.onInstall[0]!, target: { kind: 'area', team: 'ally', center: 'self', radiusUnits: 400, limit: 6 } }]),
};
const catalog = prepareCombatCatalog({
  ...combatCatalog, talents: [...combatCatalog.talents, runHealth, partyHealth], skills: [...combatCatalog.skills, healthSkill],
});
function entity(id: string, overrides: Partial<BattleEntityInput> = {}): BattleEntityInput {
  return { id, team: id === E ? 'enemies' : 'allies', position: { x: 0, y: 0 }, stats: { attack: 100, maxHealth: 1000 }, ...overrides };
}
function create(entities: readonly BattleEntityInput[]): BattleState {
  return createBattle(catalog, { seed: 'admission-ratio-source-options', entities, contentMode: 'experimental', logCapacity: 1000 });
}
const sources = [TREE, { definitionId: runHealth.id, options: { duration: ticks(10), lifecycleScope: 'run' as const } }];

describe('initial health ratio and source admission', () => {
  it('initializes healthy and wounded members against both permanent tree and temporary run max-health modifiers', () => {
    const state = create([
      entity(A, { healthRatioBps: 10_000, sources }),
      entity(B, { healthRatioBps: 5000, sources }),
      entity(C, { healthRatioBps: 3333, sources }), entity(E),
    ]);
    expect([A, B, C].map(id => queryStat(state, catalog, id, 'maxHealth'))).toEqual([1300, 1300, 1300]);
    expect([A, B, C].map(id => state.entities[id]!.health)).toEqual([1300, 650, 433]);
    expect([A, B, C].map(id => state.entities[id]!.baseStats.maxHealth)).toEqual([1000, 1000, 1000]);
    expect(state.statistics).toMatchObject({ requestedHealing: 0, effectiveHealing: 0, overhealing: 0 });
    expect(state.log.some(event => event.kind === 'healing.resolved')).toBe(false);
    expect(state.random).toEqual(create([entity(A), entity(B), entity(C), entity(E)]).random);
    const runSources = Object.values(state.sources).filter(source => source.sourceDefinitionId === runHealth.id);
    expect(runSources).toHaveLength(3);
    expect(runSources.every(source => source.lifecycleScope === 'run' && source.expiresAtTick === 10)).toBe(true);
  });

  it('supports the actual tree bonus by itself with full and wounded ratios', () => {
    const state = create([entity(A, { healthRatioBps: 10_000, sources: [TREE] }), entity(B, { healthRatioBps: 4000, sources: [TREE] })]);
    expect(state.entities[A]!.health).toBe(1050);
    expect(state.entities[B]!.health).toBe(420);
  });

  it('waits for later entities initial party contributions before resolving any ratio', () => {
    const state = create([
      entity(A, { healthRatioBps: 10_000, sources: [TREE] }),
      entity(B, { healthRatioBps: 5000, sources: [TREE, { definitionId: partyHealth.id, options: { duration: ticks(10) } }] }),
    ]);
    expect(state.entities[A]!.health).toBe(1300);
    expect(state.entities[B]!.health).toBe(650);
  });

  it('applies ratio only once; source expiry and cleanup only clamp existing health', () => {
    const initial = create([entity(A, { healthRatioBps: 10_000, sources }), entity(B, { healthRatioBps: 5000, sources })]);
    const expired = stepBattle(initial, catalog, 10);
    const cleaned = cleanupBattleScope(initial, catalog, 'run');
    for (const state of [expired, cleaned]) {
      expect(queryStat(state, catalog, B, 'maxHealth')).toBe(1050);
      expect(state.entities[A]!.health).toBe(1050);
      expect(state.entities[B]!.health).toBe(650);
      expect(state.statistics.effectiveHealing).toBe(0);
    }
    const reinstalled = installCombatSource(expired, catalog, B, runHealth.id);
    expect(queryStat(reinstalled, catalog, B, 'maxHealth')).toBe(1300);
    expect(reinstalled.entities[B]!.health).toBe(650);
  });

  it('preserves omitted full-health and explicit absolute-health semantics', () => {
    const full = create([entity(A, { sources })]);
    const ratio = create([entity(A, { sources, healthRatioBps: 10_000 })]);
    expect(serializeBattle(ratio)).toBe(serializeBattle(full));
    const explicit = create([entity(A, { sources, health: 1000 }), entity(B, { sources, health: 400 })]);
    expect(explicit.entities[A]!.health).toBe(1000);
    expect(explicit.entities[B]!.health).toBe(400);
    expect(() => create([entity(A, { sources, health: 1001 })])).toThrow(/initial resources/i);
    const plain = create([entity(A), entity(B, { health: 700 })]);
    expect([plain.entities[A]!.health, plain.entities[B]!.health]).toEqual([1000, 700]);
  });

  it('uses checked floor rounding with a one-HP minimum for valid nonzero fractions', () => {
    const state = create([entity(A, { stats: { attack: 1, maxHealth: 1 }, healthRatioBps: 1 }), entity(B, { stats: { attack: 1, maxHealth: 1003 }, sources, healthRatioBps: 5000 })]);
    expect(state.entities[A]!.health).toBe(1);
    expect(state.entities[A]!.life).toBe('Alive');
    expect(queryStat(state, catalog, B, 'maxHealth')).toBe(1303);
    expect(state.entities[B]!.health).toBe(651);
  });

  it('rejects zero, negative, excessive, nonintegral, nonfinite and malformed ratios', () => {
    for (const invalid of [0, -1, 10_001, 0.5, 9999.5, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, '5000', true]) {
      expect(() => create([entity(A, { healthRatioBps: invalid as number })])).toThrow(/healthRatioBps/);
    }
    expect(() => create([entity(A, { health: 1000, healthRatioBps: 10_000 })])).toThrow(/mutually exclusive/);
    expect(() => create([entity(A, { health: 0, healthRatioBps: 5000 })])).toThrow(/mutually exclusive/);
  });

  it('preserves string-source IDs and order when equivalent structured entries are used', () => {
    const legacy = create([entity(A, { skills: [healthSkill.id], sources: [healthSkill.id, TREE, runHealth.id] }), entity(E)]);
    const structured = create([entity(A, { skills: [healthSkill.id], sources: [{ definitionId: healthSkill.id }, { definitionId: TREE }, { definitionId: runHealth.id }] }), entity(E)]);
    expect(serializeBattle(structured)).toBe(serializeBattle(legacy));
    expect(Object.values(structured.sources).map(source => source.sourceDefinitionId)).toEqual([healthSkill.id, TREE, runHealth.id]);
  });

  it('uses source options once for a skill also declared in skills', () => {
    const state = create([entity(A, { skills: [healthSkill.id], sources: [{ definitionId: healthSkill.id, options: { duration: ticks(3), lifecycleScope: 'encounter', boundHolderId: B } }] }), entity(B)]);
    expect(Object.values(state.sources)).toHaveLength(1);
    expect(Object.values(state.sources)[0]).toMatchObject({ sourceDefinitionId: healthSkill.id, boundHolderId: B, lifecycleScope: 'encounter', expiresAtTick: 3 });
    expect(state.log.filter(event => event.kind === 'source.installed')).toHaveLength(1);
    expect(state.entities[A]!.health).toBe(1100);
    expect(stepBattle(state, catalog, 3).entities[A]!.health).toBe(1000);
    expect(() => create([entity(A, { skills: [healthSkill.id], sources: [{ definitionId: healthSkill.id, options: {} }, { definitionId: healthSkill.id, options: {} }] })])).toThrow(/Duplicate initial skill source options/);
  });

  it('installs a selected-bound source once, preserves its mapping, and triggers once for the actual recipient', () => {
    const state = create([
      entity(A, { healthRatioBps: 10_000, skills: ['skill.liuhen-jian'], sources: [TREE, { definitionId: 'talent.yifa-tongming', options: { boundHolderId: C } }] }),
      entity(B, { healthRatioBps: 5000, skills: ['skill.huichun'] }),
      entity(C, { skills: ['skill.yinlei'] }), entity(E),
    ]);
    const boundSources = Object.values(state.sources).filter(source => source.sourceDefinitionId === 'talent.yifa-tongming');
    expect(boundSources).toHaveLength(1);
    expect(boundSources[0]).toMatchObject({ holderId: A, boundHolderId: C });
    expect(state.log.filter(event => event.kind === 'source.installed' && event.sourceDefinitionId === 'talent.yifa-tongming')).toHaveLength(1);
    expect(Object.values(state.teamBudgets)).toHaveLength(1);
    expect(Object.values(state.random).every(stream => stream.draws === 0)).toBe(true);
    const act = (initial: BattleState): BattleState => {
      const first = issueCommand(initial, catalog, { kind: 'cast', actorId: A, targetId: E, skillId: 'skill.liuhen-jian' });
      const second = issueCommand(first, catalog, { kind: 'cast', actorId: B, targetId: B, skillId: 'skill.huichun' });
      return stepBattle(second, catalog, 20);
    };
    const result = act(state);
    expect(result.triggerLedger.find(ledger => ledger.triggerId === 'distinctCasterRune')?.activations).toBe(1);
    expect(result.statuses.filter(status => status.definitionId === 'status.rune').map(status => [status.holderId, status.stacks])).toEqual([[C, 1]]);
    const restored = restoreBattle(serializeBattle(state), catalog);
    expect(restored.sources).toEqual(state.sources);
    expect(serializeBattle(act(restored))).toBe(serializeBattle(result));
  });

  it('rejects invalid selected bindings during the single admission transaction', () => {
    for (const boundHolderId of [A, E, 'entity:999']) {
      expect(() => create([entity(A, { sources: [{ definitionId: 'talent.yifa-tongming', options: { boundHolderId } }] }), entity(E)])).toThrow(/binding/);
    }
  });

  it('roundtrips initial ratios as resolved HP and replays expiry without reinitialization', () => {
    const state = create([entity(A, { healthRatioBps: 5000, sources }), entity(E)]);
    const snapshot = serializeBattle(state);
    expect(snapshot).not.toContain('healthRatioBps');
    const restored = restoreBattle(snapshot, catalog);
    expect(serializeBattle(restored)).toBe(snapshot);
    expect(serializeBattle(stepBattle(restored, catalog, 12))).toBe(serializeBattle(stepBattle(state, catalog, 12)));
    expect(restored.entities[A]!.health).toBe(650);
  });
});
