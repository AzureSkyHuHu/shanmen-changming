import { describe, expect, it } from 'vitest';
import { createCombatController, stepCombatController } from '../../src/core/combat/ai';
import { combatDefinitionSupport, createBattle } from '../../src/core/combat/runtime';
import type { BattleEntityInput } from '../../src/core/combat/runtime';
import { CAMPAIGN_ENCOUNTERS, CAMPAIGN_EQUIPMENT, CAMPAIGN_KNOWLEDGE, CAMPAIGN_RECRUITS, CAMPAIGN_ROUTES,
  campaignEn, campaignZhCN, createCampaignState, recordCampaignVictory } from '../../src/core/campaign';
import { EXPEDITION_ENCOUNTERS, expeditionEncounter, STARTER_ROUTE } from '../../src/core/expeditions/encounter-catalog';
import { createExpedition } from '../../src/core/expeditions';
import { stableHash } from '../../src/core/kernel/serialization';
import { copy } from '../../src/core/campaign/shared';
import { fallback, finishReturn, options, outcome, runToNode, transition } from '../expeditions/fixtures';
import { catalog } from './helpers';

describe('small mechanically differentiated campaign catalog', () => {
  it('uses known gear slots, existing supported skills, finite budgets, and full bilingual text', () => {
    expect(CAMPAIGN_ROUTES).toHaveLength(5); expect(new Set(CAMPAIGN_ROUTES.map(route => route.mechanism)).size).toBe(5);
    const encounterIds = new Set([...EXPEDITION_ENCOUNTERS, ...CAMPAIGN_ENCOUNTERS].map(encounter => encounter.id));
    const keys: string[] = [];
    for (const route of CAMPAIGN_ROUTES) {
      keys.push(route.nameKey, route.descriptionKey, route.counterplayKey);
      expect(route.specification.encounterCount).toBe(3);
      for (const id of [...route.specification.regularEncounterIds, route.specification.bossEncounterId]) expect(encounterIds.has(id)).toBe(true);
      for (const id of route.firstClear.knowledgeIds) expect(CAMPAIGN_KNOWLEDGE.some(knowledge => knowledge.id === id)).toBe(true);
      if (route.firstClear.equipmentId) expect(CAMPAIGN_EQUIPMENT.some(equipment => equipment.id === route.firstClear.equipmentId)).toBe(true);
    }
    for (const definition of [...CAMPAIGN_EQUIPMENT, ...CAMPAIGN_KNOWLEDGE, ...CAMPAIGN_ENCOUNTERS]) keys.push(definition.nameKey, definition.descriptionKey);
    for (const knowledge of CAMPAIGN_KNOWLEDGE) {
      expect(catalog.skills.find(skill => skill.id === knowledge.skillId)?.school).toBe(knowledge.school);
      expect(combatDefinitionSupport(catalog, knowledge.skillId, 'experimental').supported).toBe(true);
    }
    for (const recruit of CAMPAIGN_RECRUITS) { keys.push(recruit.nameKey); expect(recruit.ageMonths).toBeLessThan(recruit.lifespanMonths); }
    keys.push('campaign.enemy.stormAdept', 'campaign.completed', 'campaign.recovery.description');
    for (const key of keys) { expect(campaignZhCN[key], key).toBeTruthy(); expect(campaignEn[key], key).toBeTruthy(); }
    expect(Object.keys(campaignZhCN).sort()).toEqual(Object.keys(campaignEn).sort());
  });
  it.each(CAMPAIGN_ENCOUNTERS.map(definition => [definition.id, definition] as const))('admits and executes actual runtime/controller definitions: %s', (_id, definition) => {
    const allies: BattleEntityInput[] = [{ id: 'entity:1', team: 'sect', position: { x: 80, y: 160 },
      stats: { attack: 12, maxHealth: 600 }, skills: ['skill.liuhen-jian', 'skill.guifeng', 'skill.jianxin'], maximumSpirit: 150, deathRule: 'downed' }];
    const enemies: BattleEntityInput[] = definition.enemies.map((enemy, index) => {
      const { nameKey: _key, ...input } = enemy; return { ...input, id: `entity:${index + 2}`, team: 'foe' };
    });
    const battle = createBattle(catalog, { seed: definition.id, entities: [...allies, ...enemies], contentMode: 'experimental', logCapacity: 256 });
    const controller = createCombatController(catalog, battle, { playerTeam: 'sect', arena: copy(definition.arena), maximumTicks: definition.maximumTicks });
    const advanced = stepCombatController(controller, catalog, 200);
    expect(advanced.elapsedTicks).toBeGreaterThan(0);
    expect(advanced.battle.statistics.committedActions).toBeGreaterThan(0);
    expect(advanced.battle.statistics.rejectedCommands).toBe(0);
    if (definition.enemies.some(enemy => enemy.skills?.includes('skill.xujin'))) {
      expect(Object.values(advanced.battle.sources).some(source => source.sourceDefinitionId === 'talent.fanzhen')).toBe(true);
    }
  });
  it('earns campaign rewards from three real combat victories and completed expedition settlement', () => {
    const origin = options({ runId: 'run-real-campaign', route: copy(STARTER_ROUTE) });
    // Deliberately strong test party exercises wiring, not balance certification.
    for (const member of origin.members) { member.loadout.stats = { attack: 100, maxHealth: 500 }; member.health = 500; }
    let run = createExpedition(origin, catalog);
    for (let index = 0; index < 3; index++) {
      run = transition(runToNode(run), { kind: 'encounter.begin' }).state;
      const boundary = run.currentEncounter!; const definition = expeditionEncounter(boundary.encounterDefinitionId);
      const entities: BattleEntityInput[] = boundary.squad.map((member, slot) => ({
        id: member.discipleId, team: 'sect', position: { x: 80, y: 80 * (slot + 1) }, stats: member.loadout.stats,
        health: member.health, spirit: member.spirit, maximumSpirit: member.loadout.maximumSpirit,
        skills: [...member.loadout.activeSkillIds, member.loadout.passiveSkillId], basic: member.loadout.basic, deathRule: 'downed',
      }));
      for (const [slot, enemy] of definition.enemies.entries()) {
        const { nameKey: _key, ...input } = enemy; entities.push({ ...input, id: `entity:${slot + 20}`, team: 'foe' });
      }
      let controller = createCombatController(catalog, createBattle(catalog, { seed: boundary.seed, entities, contentMode: 'experimental', logCapacity: 0 }),
        { playerTeam: 'sect', arena: copy(definition.arena), maximumTicks: definition.maximumTicks });
      for (let step = 0; step < 80 && controller.outcome.status === 'running'; step++) controller = stepCombatController(controller, catalog, 60);
      expect(controller.outcome.status).toBe('victory');
      const result = outcome(run, {
        validation: { kind: 'validatedCombatOutcome', battleId: `battle:${index + 1}`, battleSnapshotHash: stableHash(controller.battle) },
        members: boundary.squad.map(member => {
          const entity = controller.battle.entities[member.discipleId]!;
          return { discipleId: member.discipleId, alive: true, permanentDeathId: null, health: Math.max(1, entity.health), spirit: entity.spirit, injury: 0, durability: 100 };
        }), securedLoot: copy(definition.securedLoot), unsecuredLoot: copy(definition.unsecuredLoot), unlockIds: copy(definition.unlockIds),
      });
      run = transition(run, { kind: 'encounter.resolve', result }).state;
      if (run.phase === 'RewardPending') run = fallback(run);
    }
    run = finishReturn(run);
    const reward = recordCampaignVictory(createCampaignState(), 'route.qingfeng-trial', run, catalog);
    expect(reward.ok).toBe(true); if (!reward.ok) throw new Error(reward.code);
    expect(reward.state.clears).toHaveLength(1); expect(reward.state.clears[0]!.settlementId).toBe(run.settlement!.settlementId);
  });
});
