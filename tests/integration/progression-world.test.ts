import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getBuildProgress } from '../../src/core/builds';
import type { BuildCommand } from '../../src/core/builds';
import { EXPEDITION_COMBAT_CATALOG } from '../../src/core/expeditions/encounter-catalog';
import { advanceTicks, cloneJson, createSaveEnvelope, createWorld, dispatchCommand, parseSave, previewWorldBreakthrough,
  serializeSave, validateWorldState, type Command, type PlayerCultivationCommand, type WorldState } from '../../src/core/kernel';
import { validateLegacyWorldStateV3 } from '../../src/core/kernel/validation';
import { openSaveRepository } from '../../src/platform/persistence';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';

const v3Text = readFileSync(new URL('./fixtures/save-v3-in-progress.json', import.meta.url), 'utf8');
const emptyV3Text = readFileSync(new URL('./fixtures/save-v3-empty-archive.json', import.meta.url), 'utf8');
const metadata = { buildId: 'progression-world-tests', savedAt: '2026-10-01T09:00:00Z' };
type CultureInput = PlayerCultivationCommand extends infer C ? C extends PlayerCultivationCommand ? Omit<C, 'commandId' | 'expectedRevision'> : never : never;
type BuildInput = BuildCommand extends infer C ? C extends BuildCommand ? Omit<C, 'commandId' | 'expectedRevision'> : never : never;
function checked(world: WorldState, command: Command) {
  const result = dispatchCommand(world, command);
  expect(result.result.status, JSON.stringify(result.result.rejection)).toBe('accepted');
  expect(validateWorldState(result.world)).toEqual([]);
  return { ...result, command };
}
function culture(world: WorldState, input: CultureInput, commandId = `cult:${Object.keys(world.commandReceipts).length + 1}`) {
  return checked(world, { kind: 'cultivation.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { command: { ...input, commandId, expectedRevision: world.cultivation.revision } as PlayerCultivationCommand } });
}
function build(world: WorldState, input: BuildInput, commandId = `build:${Object.keys(world.commandReceipts).length + 1}`) {
  return checked(world, { kind: 'build.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { command: { ...input, commandId, expectedRevision: world.builds.revision } as BuildCommand } });
}
function reload(world: WorldState) {
  const parsed = parseSave(serializeSave(createSaveEnvelope(world, metadata)));
  expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.world;
}
function depart(world: WorldState, squadIds: string[]) {
  const commandId = `depart:${Object.keys(world.commandReceipts).length + 1}`;
  return checked(world, { kind: 'expedition.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { command: { commandId, kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial', squadIds } } } });
}

describe('permanent build World authority', () => {
  it('creates deterministic registered starters with shared IDs and no unearned points', () => {
    const world = createWorld('permanent-build-world');
    expect(world).toEqual(createWorld('permanent-build-world'));
    expect(world.builds.disciples.map((d) => d.school)).toEqual(['sword', 'body', 'alchemy', 'talisman']);
    expect(world.builds.equipment).toHaveLength(12);
    expect(world.builds.disciples.flatMap((d) => d.sources)).toHaveLength(24);
    expect(world.sequences.nextInstance).toBe(37);
    for (const d of world.disciples) expect(getBuildProgress({ builds: world.builds, sequences: world.sequences }, d.id, EXPEDITION_COMBAT_CATALOG).earnedPoints).toBe(0);
    expect(reload(world)).toEqual(world);
  });

  it('awards realm milestones once from successful cultivation and atomically spends the resulting tree point', () => {
    let world = createWorld('milestone-world');
    const discipleId = world.disciples[1]!.id;
    world.cultivation.disciples[1]!.cultivation = 120;
    world.randomStreams.events = { ...world.randomStreams.events, state: 1, draws: 0 };
    const confirmed = culture(world, { kind: 'breakthrough.confirm', preview: previewWorldBreakthrough(world, discipleId) });
    const attemptId = confirmed.result.cultivationResult!.relatedId!;
    world = culture(confirmed.world, { kind: 'breakthrough.begin', attemptId }).world;
    world = advanceTicks(world, 1200);
    const resolved = culture(world, { kind: 'breakthrough.resolve', attemptId, acknowledgeRisk: true });
    expect(resolved.result.cultivationResult?.outcome).toBe('success');
    expect(resolved.world.builds.awards).toEqual([{ milestoneId: `realm/${discipleId}/qi`, discipleId, ruleId: 'realm.qi', treePoints: 1, learningCredits: 2 }]);
    expect(resolved.world.builds.receipts[0]!.commandId).toBe(`system/realm/${discipleId}/qi`);
    expect(dispatchCommand(resolved.world, resolved.command).world).toBe(resolved.world);
    const school = resolved.world.builds.disciples.find((d) => d.discipleId === discipleId)!.school;
    const node = EXPEDITION_COMBAT_CATALOG.treeNodes.find((n) => n.school === school && n.tier === 1)!;
    const allocated = build(reload(resolved.world), { kind: 'tree.respec', discipleId, nodeIds: [node.id] });
    expect(allocated.result.buildResult?.kind).toBe('tree.respec');
    expect(allocated.world.builds.disciples.find((d) => d.discipleId === discipleId)!.allocatedNodeIds).toEqual([node.id]);
    expect(getBuildProgress({ builds: allocated.world.builds, sequences: allocated.world.sequences }, discipleId, EXPEDITION_COMBAT_CATALOG)).toMatchObject({ earnedPoints: 1, allocatedPoints: 1, availablePoints: 0 });
    expect(dispatchCommand(allocated.world, allocated.command).world).toBe(allocated.world);
    expect(reload(allocated.world)).toEqual(allocated.world);
  });

  it('rejects authority grants and namespace collisions through the public kernel wrapper', () => {
    const world = createWorld();
    const discipleId = world.disciples[1]!.id;
    const forged = { commandId: 'grant:fake', sequence: 0, issuedTick: 0, kind: 'build.command', payload: { command: {
      commandId: 'grant:fake', expectedRevision: 0, kind: 'milestone.award', discipleId, milestoneId: 'fake-milestone', ruleId: 'realm.qi',
    } } };
    expect(dispatchCommand(world, forged).result.rejection?.code).toBe('INVALID_COMMAND');
    expect(dispatchCommand(world, { ...forged, commandId: `system/realm/${discipleId}/qi` }).result.rejection?.code).toBe('INVALID_COMMAND');
    expect(world.builds.awards).toEqual([]);
    const noPoints = dispatchCommand(world, { commandId: 'no-points', sequence: 0, issuedTick: 0, kind: 'build.command', payload: { command: {
      commandId: 'no-points', expectedRevision: 0, kind: 'tree.respec', discipleId,
      nodeIds: [EXPEDITION_COMBAT_CATALOG.treeNodes.find((node) => node.school === 'body' && node.tier === 1)!.id],
    } } });
    expect(noPoints.result.rejection).toEqual({ code: 'BUILD_REJECTED', buildCode: 'INSUFFICIENT_POINTS' });
    expect(reload(noPoints.world)).toEqual(noPoints.world);
  });

  it('retains away activity ownership while aging and blocks free training/rest/build changes', () => {
    let world = createWorld('away-progression');
    const trainingId = world.disciples[1]!.id; const restingId = world.disciples[2]!.id;
    world.cultivation.disciples[2]!.injury = 40;
    world = culture(world, { kind: 'training.set', discipleId: trainingId, mode: 'training' }).world;
    world = culture(world, { kind: 'training.set', discipleId: restingId, mode: 'rest' }).world;
    const initial = cloneJson(world);
    world = depart(world, [trainingId, restingId]).world;
    expect(world.cultivation.disciples[1]!.activityOwner?.kind).toBe('expedition');
    const lockedBuild = dispatchCommand(world, { commandId: 'away-build', sequence: 1, issuedTick: 0, kind: 'build.command', payload: { command: {
      commandId: 'away-build', expectedRevision: world.builds.revision, kind: 'tree.respec', discipleId: trainingId, nodeIds: [],
    } } });
    expect(lockedBuild.result.rejection).toEqual({ code: 'BUILD_REJECTED', buildCode: 'EXPEDITION_LOCKED' });
    const lockedTraining = dispatchCommand(lockedBuild.world, { commandId: 'away-training', sequence: 2, issuedTick: 0, kind: 'cultivation.command', payload: { command: {
      commandId: 'away-training', expectedRevision: world.cultivation.revision, kind: 'training.set', discipleId: trainingId, mode: 'duty',
    } } });
    expect(lockedTraining.result.rejection).toEqual({ code: 'CULTIVATION_REJECTED', cultivationCode: 'ACTIVITY_LOCKED' });
    world = advanceTicks(lockedTraining.world, 1200);
    expect(world.cultivation.disciples[1]!.ageMonths).toBe(initial.cultivation.disciples[1]!.ageMonths + 1);
    expect(world.cultivation.disciples[1]!.cultivation).toBe(initial.cultivation.disciples[1]!.cultivation);
    expect(world.cultivation.disciples[2]!.injury).toBe(40);
    expect(world.cultivation.disciples[1]!.trainingMode).toBe('training');
    expect(world.cultivation.disciples[2]!.trainingMode).toBe('rest');
    expect(world.clock.pauseReasons).toContain('expedition');
    expect(reload(world)).toEqual(world);
  });

  it('rejects missing ownership and duplicate cross-domain source IDs on import', () => {
    const world = depart(createWorld('activity-import'), ['entity:2']).world;
    const missingLock = cloneJson(world); missingLock.cultivation.disciples[1]!.activityOwner = null;
    expect(validateWorldState(missingLock).length).toBeGreaterThan(0);
    const lostSource = cloneJson(world);
    const sources = lostSource.builds.disciples[1]!.sources;
    sources[0] = { ...sources[0]!, sourceInstanceId: lostSource.builds.equipment[0]!.instanceId };
    expect(validateWorldState(lostSource).length).toBeGreaterThan(0);
  });
});

describe('frozen v3 source compatibility', () => {
  it('adds registered builds/activity fields without rewriting old escrows, source IDs, RNG or original text', () => {
    const source = JSON.parse(v3Text);
    expect(source.saveVersion).toBe(3); expect(source.payload.simulationVersion).toBe('0.3.0');
    expect(validateLegacyWorldStateV3(source.payload)).toEqual([]);
    const result = parseSave(v3Text);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.saveVersion).toBe(7);
    expect(result.migration).toEqual({ sourceSaveVersion: 3, sourceSimulationVersion: '0.3.0', sourceChecksum: source.checksum });
    expect(result.world.inventory).toEqual(source.payload.inventory);
    expect(result.world.randomStreams).toEqual(source.payload.randomStreams);
    expect(result.world.transactions).toEqual(source.payload.transactions);
    expect(result.world.cultivation.attempts).toEqual(source.payload.cultivation.attempts);
    expect(result.world.cultivation.schemaVersion).toBe(2);
    expect(result.world.cultivation.disciples.map(({ activityOwner: _owner, ...profile }) => profile)).toEqual(source.payload.cultivation.disciples);
    expect(result.world.cultivation.disciples.every((d) => d.activityOwner === null)).toBe(true);
    expect(result.world.sequences).toEqual({ ...source.payload.sequences, nextInstance: source.payload.sequences.nextInstance + 36 });
    expect(result.world.expedition.run).toBeNull();
    expect(result.world.builds.awards).toEqual([]);
    expect(reload(result.world)).toEqual(result.world);
    expect(JSON.parse(v3Text)).toEqual(source);
  });

  it('migrates a genuine valid empty-v3 archive without inventing identities, equipment or IDs', () => {
    const source = JSON.parse(emptyV3Text);
    expect(source.saveVersion).toBe(3);
    expect(validateLegacyWorldStateV3(source.payload)).toEqual([]);
    const result = parseSave(emptyV3Text);
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.world.disciples).toEqual([]);
    expect(result.world.cultivation.disciples).toEqual([]);
    expect(result.world.builds.disciples).toEqual([]);
    expect(result.world.builds.equipment).toEqual([]);
    expect(result.world.sequences).toEqual(source.payload.sequences);
    expect(reload(result.world)).toEqual(result.world);
  });

  it('retains the original stored v3 generation and creates the current version only on explicit save', async () => {
    const repository = await openSaveRepository({ indexedDB: new FakeIDBFactory(), now: () => 1000 });
    try {
      const imported = await repository.importSave(v3Text, { ownerId: 'v3-source' });
      const loaded = await repository.loadSlot(imported.slot.slotId);
      expect(loaded.envelope.saveVersion).toBe(7);
      expect(loaded.snapshot.text).toBe(v3Text);
      expect((await repository.exportSlot(imported.slot.slotId)).text).toBe(v3Text);
      const saved = await repository.saveWorld(imported.slot.slotId, loaded.world, metadata, { expectedRevision: 1, lease: imported.lease });
      expect(JSON.parse(saved.snapshot.text).saveVersion).toBe(7);
      expect(await repository.exportRawSnapshot(imported.slot.slotId, imported.snapshot.id)).toBe(v3Text);
    } finally { repository.close(); }
  });
});
