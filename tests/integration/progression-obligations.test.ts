import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWorld } from '../../src/core/world/create-world';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { cloneJson } from '../../src/core/kernel/serialization';
import { applyCultivationCommandV3, previewBreakthroughV3, stepCultivationMonthsV3 } from '../../src/core/cultivation/v3';
import { applyBuildAuthorityCommandV2, createBuildFrameV2 } from '../../src/core/builds/v2';
import { getWorldBuildContentContext } from '../../src/core/world/content-access';
import { assessBuildHistoryObligations } from '../../src/core/save-budget/build-obligations';
import { copy } from '../../src/core/expeditions/shared';
import { assessWorldBuildHistoryObligations, worldBuildHistoryObligationFacts } from '../../src/core/world/progression-obligations';
import type { WorldStateV8 } from '../../src/core/world/v8-types';

function fresh() { return migrateWorldV7ToV8(createWorld('progression-obligation-facts')); }
function fixture(filename: string) { return migrateWorldV7ToV8((JSON.parse(readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8')) as { payload: unknown }).payload); }
function frame(world: WorldStateV8) { return { cultivation: world.cultivation, inventory: world.inventory, randomStreams: world.randomStreams, sequences: world.sequences }; }

describe('World-derived build history obligations (not a whole-save byte proof)', () => {
  it('derives all four future retirements and twelve current item transfers without mutating the World', () => {
    const world = fresh(); const before = cloneJson(world);
    expect(assessWorldBuildHistoryObligations(world)).toMatchObject({ reservedCommands: 16, fits: true,
      breakdown: { retirements: 4, transfers: 12, teachingGrants: 0, realmAwards: 0, runUnlocks: 0, firstVictoryAwards: 0 } });
    expect(world).toEqual(before);
  });

  it('reserves one unlock and only genuine not-yet-earned first-victory recipients for an active legacy run', () => {
    const world = fixture('save-v7-active-battle.json'); const run = world.expedition.run!;
    const facts = worldBuildHistoryObligationFacts(world);
    expect(facts.activeRun).toEqual({ runId: run.runId, firstVictoryDiscipleIds: run.members.filter(member => member.alive).map(member => member.discipleId) });
    const budget = assessWorldBuildHistoryObligations(world);
    expect(budget.breakdown.runUnlocks).toBe(1); expect(budget.breakdown.firstVictoryAwards).toBe(run.members.length);
    const ended = fixture('save-v7-ended-clear.json');
    expect(assessWorldBuildHistoryObligations(ended).breakdown).toMatchObject({ runUnlocks: 0, firstVictoryAwards: 0 });
  });

  it('preserves an accepted breakthrough award obligation until cancellation releases it', () => {
    const world = fresh(); world.cultivation.disciples[1]!.cultivation = 120;
    const discipleId = world.cultivation.disciples[1]!.discipleId;
    const preview = previewBreakthroughV3(frame(world), discipleId);
    const confirmed = applyCultivationCommandV3(frame(world), { kind: 'breakthrough.confirm', commandId: 'promise:confirm', expectedRevision: world.cultivation.revision, preview });
    expect(confirmed.ok).toBe(true); if (!confirmed.ok) throw new Error(confirmed.code);
    const active = { ...world, ...confirmed.frame };
    expect(worldBuildHistoryObligationFacts(active).realmMilestoneIds).toEqual([`realm/${discipleId}/qi`]);
    const cancelled = applyCultivationCommandV3(frame(active), { kind: 'breakthrough.cancel', commandId: 'promise:cancel', expectedRevision: active.cultivation.revision, attemptId: confirmed.result.relatedId! });
    expect(cancelled.ok).toBe(true); if (!cancelled.ok) throw new Error(cancelled.code);
    expect(assessWorldBuildHistoryObligations({ ...active, ...cancelled.frame }).breakdown.realmAwards).toBe(0);
  });

  it('does not release teaching capacity in the intermediate plan-cleared, grant-uncommitted frame', () => {
    // This component fixture uses genuine domain commands to assemble the
    // teacher's permanent knowledge. Full paid-claim publication is a separate gate.
    const previous = createWorld('pending-teaching-grant');
    previous.cultivation.disciples[0]!.knowledge.push({ knowledgeId: 'knowledge.sun-piercing', teacherId: null, teachingId: null });
    let world = migrateWorldV7ToV8(previous);
    const context = getWorldBuildContentContext(world)!;
    const builds = createBuildFrameV2({ disciples: world.disciples.map(member => ({ discipleId: member.id, school: 'sword' as const })),
      contentMode: 'experimental', sequences: world.sequences }, context);
    const learned = applyBuildAuthorityCommandV2(builds, { kind: 'skill.grantKnowledge', commandId: 'promise/archive', expectedRevision: builds.builds.revision,
      discipleId: 'entity:1', skillId: 'skill.guanri-jianjue', acquisitionId: 'archive/sun-piercing/entity:1', provenance: { kind: 'archive', knowledgeId: 'knowledge.sun-piercing' } }, context);
    expect(learned.ok).toBe(true); if (!learned.ok) throw new Error(learned.code);
    world = { ...world, builds: copy(learned.frame.builds), sequences: copy(learned.frame.sequences) };
    const started = applyCultivationCommandV3(frame(world), { kind: 'teaching.begin', commandId: 'promise:teach', expectedRevision: world.cultivation.revision,
      discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.sun-piercing' });
    expect(started.ok).toBe(true); if (!started.ok) throw new Error(started.code);
    world = { ...world, ...started.frame };
    const teachingId = world.cultivation.disciples[0]!.teaching!.teachingId;
    expect(worldBuildHistoryObligationFacts(world).teachingIds).toEqual([teachingId]);
    const completed = stepCultivationMonthsV3(frame(world), 2);
    expect(completed.processedMonths).toBe(2); world = { ...world, ...completed.frame };
    expect(world.cultivation.disciples[0]!.teaching).toBeNull();
    expect(worldBuildHistoryObligationFacts(world).teachingIds).toEqual([teachingId]);
    const before = assessWorldBuildHistoryObligations(world);
    const granted = applyBuildAuthorityCommandV2({ builds: world.builds, sequences: world.sequences }, { kind: 'skill.grantKnowledge',
      commandId: `teaching/${teachingId}`, expectedRevision: world.builds.revision, discipleId: 'entity:2', skillId: 'skill.guanri-jianjue',
      acquisitionId: `teaching/${teachingId}/entity:2`, provenance: { kind: 'teaching', knowledgeId: 'knowledge.sun-piercing', teacherId: 'entity:1', teachingId } }, context);
    expect(granted.ok).toBe(true); if (!granted.ok) throw new Error(granted.code);
    const after = assessWorldBuildHistoryObligations({ ...world, builds: copy(granted.frame.builds), sequences: copy(granted.frame.sequences) });
    expect(after.breakdown.teachingGrants).toBe(0);
    expect(after.historyCount + after.reservedCommands).toBe(before.historyCount + before.reservedCommands);
  });

  it('does not infer a permanent build obligation from a coincidentally matching legacy knowledge ID', () => {
    const previous = createWorld('legacy-knowledge-only');
    previous.cultivation.disciples[0]!.knowledge.push({ knowledgeId: 'knowledge.sun-piercing', teacherId: null, teachingId: null });
    let world = migrateWorldV7ToV8(previous);
    const started = applyCultivationCommandV3(frame(world), { kind: 'teaching.begin', commandId: 'legacy:teach', expectedRevision: world.cultivation.revision,
      discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.sun-piercing' });
    expect(started.ok).toBe(true); if (!started.ok) throw new Error(started.code);
    world = { ...world, ...started.frame };
    expect(worldBuildHistoryObligationFacts(world).teachingIds).toEqual([]);
    world = { ...world, ...stepCultivationMonthsV3(frame(world), 2).frame };
    expect(worldBuildHistoryObligationFacts(world).teachingIds).toEqual([]);
  });

  it('reassesses actual heir chains and reports an existing imported row deficit instead of inventing room', () => {
    const world = fresh();
    const heir = applyCultivationCommandV3(frame(world), { kind: 'legacy.setHeir', commandId: 'promise:heir', expectedRevision: world.cultivation.revision,
      discipleId: 'entity:1', heirId: 'entity:2' });
    expect(heir.ok).toBe(true); if (!heir.ok) throw new Error(heir.code);
    expect(assessWorldBuildHistoryObligations({ ...world, ...heir.frame }).breakdown.transfers).toBe(15);
    // An unchanged v7 schema legally permits fresh no-op player/build commands
    // up to its history limit. This module must report their promised-row deficit.
    const facts = worldBuildHistoryObligationFacts(world);
    expect(facts.maximumCommands).toBe(1024);
    expect(assessBuildHistoryObligations({ ...facts, historyCount: 1010 })).toMatchObject({ remainingCommands: 14, reservedCommands: 16, availableCommands: -2, fits: false });
  });
});
