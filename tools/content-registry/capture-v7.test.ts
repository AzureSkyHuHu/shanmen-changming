/** Explicit one-time capture; not included in the ordinary test suite. */
import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { combatCatalog } from '../../src/content/definitions';
import * as rules from '../../src/core/builds/rules';
import { EXPEDITION_ENCOUNTERS, STARTER_ROUTE, STARTER_ROUTE_ID } from '../../src/core/expeditions/encounter-catalog';
import { AUTHORED_TALENT_IDS, FALLBACK_SUPPLIES, MAX_COMMANDS, MAX_ENCOUNTERS, MAX_SQUAD, MAX_MONTHS_PER_NODE } from '../../src/core/expeditions/shared';
import { BATTLE_SIMULATION_VERSION, BATTLE_SNAPSHOT_VERSION } from '../../src/core/combat/runtime/types';
import { COMBAT_CONTROLLER_VERSION } from '../../src/core/combat/ai/types';
import { stableHash } from '../../src/core/kernel/serialization';

it('captures the verified v7 data without changing live imports', () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  expect(commit).toBe('98e7026c9dfef68754a3ad9369d70aa3c2475195');
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'src/core/builds', 'src/core/expeditions', 'src/core/combat/runtime', 'src/core/combat/ai'], { encoding: 'utf8' }).trim().split('\n').filter(file => file.endsWith('.ts'));
  const sourceHashes = Object.fromEntries(files.sort().map(file => [file, createHash('sha256').update(execFileSync('git', ['show', `${commit}:${file}`])).digest('hex')]));
  const data = {
    schemaVersion: 1, id: 'content.legacy-v7', sourceCommit: commit,
    worldContentVersion: 'starter-0.1.0', combat: combatCatalog, combatFingerprint: stableHash(combatCatalog),
    encounters: EXPEDITION_ENCOUNTERS, routes: [{ id: STARTER_ROUTE_ID, specification: STARTER_ROUTE }],
    buildRules: { version: rules.BUILD_RULES_VERSION, schools: rules.BUILD_SCHOOLS, equipmentSlots: rules.EQUIPMENT_SLOTS,
      equipment: rules.EQUIPMENT_DEFINITIONS, lessons: rules.SKILL_LEARNING_RULES, starterSkills: rules.STARTER_SKILLS,
      milestones: rules.MILESTONE_RULE_IDS, maximumAllocatedPoints: rules.MAX_ALLOCATED_POINTS, maximumCommands: rules.MAX_BUILD_COMMANDS,
      maximumDisciples: rules.MAX_BUILD_DISCIPLES, maximumEquipment: rules.MAX_BUILD_EQUIPMENT,
      basics: rules.BUILD_SCHOOLS.map(school => ({ id: rules.basicId(school), definition: rules.basicDefinition(school) })) },
    offerRules: { protocol: 'offers.legacy-12-v1', authoredTalentIds: AUTHORED_TALENT_IDS, fallbackSupplies: FALLBACK_SUPPLIES,
      maximumCommands: MAX_COMMANDS, maximumEncounters: MAX_ENCOUNTERS, maximumSquad: MAX_SQUAD, maximumMonthsPerNode: MAX_MONTHS_PER_NODE },
    protocols: { combatRuntime: BATTLE_SIMULATION_VERSION, combatSnapshot: BATTLE_SNAPSHOT_VERSION,
      controller: COMBAT_CONTROLLER_VERSION, builds: 'build-rules-v1', expedition: 'expedition-v1', admission: 'starter-authored-12-v1' },
    sourceHashes,
  };
  writeFileSync(resolve('src/content/registry/legacy-v7.json'), JSON.stringify(data, null, 2) + '\n');
  console.log(JSON.stringify({ captured: data.id, combatFingerprint: data.combatFingerprint, contentFingerprint: stableHash(data), sourceFiles: files.length }));
});
