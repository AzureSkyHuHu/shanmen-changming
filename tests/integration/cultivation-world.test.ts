import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import {
  advanceTicks, lookupProduction, CALENDAR_TICKS_PER_MONTH, createSaveEnvelope, createWorld, dispatchCommand, domainHash, parseSave,
  previewWorldBreakthrough, serializeSave, SAVE_VERSION, setClockMode, setPauseReason, stableHash, validateWorldState,
  type Command, type PlayerCultivationCommand, type WorldState,
} from '../../src/core/kernel';
import { openSaveRepository } from '../../src/platform/persistence';

const metadata = { buildId: 'cultivation-world-tests', savedAt: '2026-10-01T08:00:00Z' };
const v2Text = readFileSync(new URL('./fixtures/save-v2-in-progress.json', import.meta.url), 'utf8');
const v1Text = readFileSync(new URL('../agents/fixtures/save-v1-in-progress.json', import.meta.url), 'utf8');
type Input = PlayerCultivationCommand extends infer C ? C extends PlayerCultivationCommand ? Omit<C, 'commandId' | 'expectedRevision'> : never : never;
function culture(world: WorldState, input: Input, commandId = `culture:${world.cultivation.revision}`) {
  const command: Command = { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick, kind: 'cultivation.command',
    payload: { command: { ...input, commandId, expectedRevision: world.cultivation.revision } as PlayerCultivationCommand } };
  const result = dispatchCommand(world, command);
  expect(result.result.status).toBe('accepted');
  expect(validateWorldState(result.world)).toEqual([]);
  return { ...result, command };
}
function reload(world: WorldState): WorldState {
  const parsed = parseSave(serializeSave(createSaveEnvelope(world, metadata)));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.world;
}
function readyCandidate(seed = 'world-cultivation'): WorldState {
  const world = createWorld(seed);
  world.cultivation.disciples[1]!.cultivation = 120;
  return world;
}
function prepareRetreat(world = readyCandidate()) {
  const discipleId = world.disciples[1]!.id;
  const preview = previewWorldBreakthrough(world, discipleId);
  const confirmed = culture(world, { kind: 'breakthrough.confirm', preview });
  const attemptId = confirmed.result.cultivationResult!.relatedId!;
  return { ...culture(confirmed.world, { kind: 'breakthrough.begin', attemptId }), discipleId, attemptId };
}
function startProduction(world: WorldState, workerIndex = 1) {
  const result = dispatchCommand(world, { commandId: 'production.fixture', sequence: 0, issuedTick: world.clock.simulationTick,
    kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: world.disciples[workerIndex]!.id } });
  expect(result.result.status).toBe('accepted');
  return { world: result.world, transactionId: result.result.transactionId! };
}
function legacyVariant(transform: (world: Record<string, unknown>) => void): string {
  const { checksum: _checksum, ...envelope } = JSON.parse(v2Text) as Record<string, unknown>;
  transform(envelope.payload as Record<string, unknown>);
  return JSON.stringify({ ...envelope, checksum: stableHash(envelope) });
}

describe('authoritative World cultivation integration', () => {
  it('advances training exactly once per management month and never during combat or hidden pause', () => {
    let world = createWorld('monthly-training');
    const discipleId = world.disciples[1]!.id;
    world = culture(world, { kind: 'training.set', discipleId, mode: 'training' }).world;
    const originalAge = world.disciples[1]!.ageMonths;
    world = advanceTicks(world, CALENDAR_TICKS_PER_MONTH - 1);
    expect(world.cultivation.disciples[1]!.cultivation).toBe(0);
    world = advanceTicks(world, 1);
    const units = 8 + Math.floor(world.disciples[1]!.aptitude / 10);
    expect(world.cultivation.disciples[1]!.cultivation).toBe(units);
    expect(world.cultivation.calendarMonth).toBe(1);
    expect(world.disciples[1]!.ageMonths).toBe(originalAge + 1);
    expect(world.cultivation.disciples[1]!.ageMonths).toBe(originalAge + 1);
    const combat = advanceTicks({ ...world, clock: setClockMode(world.clock, 'combat') }, 1200);
    expect(combat.cultivation).toEqual(world.cultivation);
    const hidden = { ...world, clock: setPauseReason(world.clock, 'hidden', true) };
    expect(advanceTicks(hidden, 1200)).toEqual(hidden);
    expect(reload(combat)).toEqual(combat);
  });

  it('preserves exact off-boundary birthdays without double aging at the monthly boundary', () => {
    let world = createWorld('off-boundary-cultivation');
    const projected = world.disciples[0]!;
    projected.birthCalendarTick += 17; projected.ageMonths -= 1;
    world.cultivation.disciples[0]!.ageMonths = projected.ageMonths;
    world = culture(world, { kind: 'training.set', discipleId: projected.id, mode: 'training' }).world;
    const startingAge = projected.ageMonths;
    world = advanceTicks(reload(world), 16);
    expect(world.disciples[0]!.ageMonths).toBe(startingAge);
    world = advanceTicks(world, 1);
    expect(world.disciples[0]!.ageMonths).toBe(startingAge + 1);
    expect(world.cultivation.disciples[0]!.cultivation).toBe(0);
    world = advanceTicks(world, 1200 - 17);
    expect(world.disciples[0]!.ageMonths).toBe(startingAge + 1);
    expect(world.cultivation.disciples[0]!.ageMonths).toBe(startingAge + 1);
    expect(world.cultivation.disciples[0]!.cultivation).toBeGreaterThan(0);
    world = advanceTicks(reload(world), 17);
    expect(world.disciples[0]!.ageMonths).toBe(startingAge + 2);
    expect(world.cultivation.calendarMonth).toBe(1);
    expect(validateWorldState(world)).toEqual([]);
  });

  it('owns its decision pause independently and resolves through direct kernel commands while paused', () => {
    const prepared = prepareRetreat();
    let waiting = advanceTicks(prepared.world, 5000);
    expect(waiting.clock.calendarTick).toBe(1200);
    expect(waiting.clock.pauseReasons).toContain('cultivation');
    expect(waiting.cultivation.attempts[0]!.phase).toBe('DecisionReady');
    waiting = { ...waiting, clock: setPauseReason(waiting.clock, 'player', true) };
    const resolved = culture(reload(waiting), { kind: 'breakthrough.resolve', attemptId: prepared.attemptId, acknowledgeRisk: true });
    expect(resolved.world.clock.pauseReasons).toEqual(['player']);
    expect(resolved.result.cultivationResult?.outcome).not.toBe('accepted');
    expect(dispatchCommand(resolved.world, resolved.command).world).toBe(resolved.world);
    expect(reload(resolved.world)).toEqual(resolved.world);
  });

  it('combines production and breakthrough escrow exactly and cancels conflicting jobs through production cleanup', () => {
    let initial = readyCandidate();
    initial.cultivation.disciples[2]!.cultivation = 120;
    const started = startProduction(initial);
    const preview = previewWorldBreakthrough(started.world, started.world.disciples[2]!.id);
    const confirmed = culture(started.world, { kind: 'breakthrough.confirm', preview });
    expect(confirmed.world.inventory.wood.reserved).toBe(3);
    expect(confirmed.world.inventory.herbs.reserved).toBe(2);
    expect(validateWorldState(confirmed.world)).toEqual([]);
    const corrupted = structuredClone(confirmed.world);
    corrupted.inventory.wood.reserved += 1;
    expect(validateWorldState(corrupted)).toContain('Reservation totals do not match inventory');
    const training = culture(confirmed.world, { kind: 'training.set', discipleId: confirmed.world.disciples[1]!.id, mode: 'training' });
    expect(lookupProduction(training.world, started.transactionId)!.state).toBe('Cancelled');
    expect(training.world.inventory.wood.reserved).toBe(0);
    expect(training.world.inventory.herbs.reserved).toBe(2);
    expect(training.world.buildings.every((b) => b.stationTransactionId !== started.transactionId)).toBe(true);
    expect(training.world.disciples[1]!.traveling).toBe(false);
    const rejected = dispatchCommand(training.world, { commandId: 'busy-production', sequence: 1, issuedTick: training.world.clock.simulationTick,
      kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: training.world.disciples[1]!.id } });
    expect(rejected.result.rejection?.code).toBe('WORKER_UNAVAILABLE');
  });

  it('settles lifespan expiry and cancels delivery before production could commit on the same monthly tick', () => {
    const started = startProduction(createWorld('expiry-before-delivery'));
    let world = started.world;
    for (let guard = 0; guard < 1000 && world.transactions[started.transactionId]!.phase !== 'AwaitingDelivery'; guard++) world = advanceTicks(world, 1);
    expect(world.transactions[started.transactionId]!.phase).toBe('AwaitingDelivery');
    world = { ...world, clock: { ...world.clock, simulationTick: 1199, calendarTick: 1199 } };
    world.disciples[1]!.ageMonths = 959;
    world.disciples[1]!.birthCalendarTick = 1200 - 960 * 1200;
    world.cultivation.disciples[1]!.ageMonths = 959;
    expect(validateWorldState(world)).toEqual([]);
    world = advanceTicks(world, 1);
    expect(world.clock.calendarTick).toBe(1200);
    expect(world.cultivation.calendarMonth).toBe(1);
    expect(world.disciples[1]!.lifeState).toBe('pendingDeath');
    expect(lookupProduction(world, started.transactionId)!.state).toBe('Cancelled');
    expect(world.inventory.plank.owned).toBe(0);
    expect(world.inventory.wood.owned).toBe(24);
    expect(world.inventory.wood.reserved).toBe(0);
    expect(world.clock.pauseReasons).toContain('cultivation');
    const pending = world.cultivation.pendingDeaths[0]!;
    const finalized = culture(reload(world), { kind: 'death.finalize', discipleId: pending.discipleId, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true });
    expect(finalized.world.disciples[1]!.lifeState).toBe('dead');
    expect(finalized.world.cultivation.deaths).toHaveLength(1);
    expect(dispatchCommand(finalized.world, finalized.command).world).toBe(finalized.world);
  });

  it('requires explicit public command identities/revisions and rejects authority-only grants or combat death', () => {
    const world = createWorld();
    const input = { commandId: 'inner', expectedRevision: 0, kind: 'training.set', discipleId: world.disciples[1]!.id, mode: 'training' };
    expect(dispatchCommand(world, { commandId: 'outer', sequence: 0, issuedTick: 0, kind: 'cultivation.command', payload: { command: input } }).result.rejection?.code).toBe('INVALID_COMMAND');
    for (const command of [
      { commandId: 'grant', expectedRevision: 0, kind: 'talent.grant', discipleId: world.disciples[1]!.id, talentId: 'cultivation.steady-breath' },
      { commandId: 'death', expectedRevision: 0, kind: 'death.finalize', discipleId: world.disciples[1]!.id, deathId: 'death:test', cause: 'combat', acknowledgeDeath: true },
    ]) expect(dispatchCommand(world, { commandId: command.commandId, sequence: 0, issuedTick: 0, kind: 'cultivation.command', payload: { command } }).result.rejection?.code).toBe('INVALID_COMMAND');
    const stale = dispatchCommand(world, { commandId: 'stale', sequence: 0, issuedTick: 0, kind: 'cultivation.command', payload: { command: { ...input, commandId: 'stale', expectedRevision: 10 } } });
    expect(stale.result.rejection).toEqual({ code: 'CULTIVATION_REJECTED', cultivationCode: 'REVISION_CONFLICT' });
    expect(reload(stale.world)).toEqual(stale.world);
  });

  it('preserves authoritative mirrors, global event identity, and deterministic mid-retreat replay', () => {
    const prepared = prepareRetreat();
    const partial = advanceTicks(prepared.world, 400);
    const uninterrupted = advanceTicks(partial, 800);
    const restored = advanceTicks(reload(partial), 800);
    expect(domainHash(restored)).toBe(domainHash(uninterrupted));
    const left = culture(uninterrupted, { kind: 'breakthrough.resolve', attemptId: prepared.attemptId, acknowledgeRisk: true }, 'resolve:replay');
    const right = culture(restored, { kind: 'breakthrough.resolve', attemptId: prepared.attemptId, acknowledgeRisk: true }, 'resolve:replay');
    expect(domainHash(left.world)).toBe(domainHash(right.world));
    expect(new Set(left.world.events.map((event) => event.eventId)).size).toBe(left.world.events.length);
    const damaged = structuredClone(left.world); damaged.disciples[0]!.ageMonths += 1;
    expect(validateWorldState(damaged).length).toBeGreaterThan(0);
    const missingEvent = structuredClone(left.world);
    missingEvent.events = missingEvent.events.filter((event) => event.eventId !== missingEvent.cultivation.events[0]!.eventId);
    expect(validateWorldState(missingEvent).length).toBeGreaterThan(0);
  });
});

describe('truthful v1/v2 migration through cultivation to current schema', () => {
  it('migrates the genuine v2 fixture without changing source bytes, jobs, birth offsets, RNG, inventory or existing IDs', () => {
    const source = JSON.parse(v2Text);
    const parsed = parseSave(v2Text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.saveVersion).toBe(7);
    expect(parsed.migration).toEqual({ sourceSaveVersion: 2, sourceSimulationVersion: '0.2.0', sourceChecksum: source.checksum });
    expect(parsed.world.cultivation.calendarMonth).toBe(0);
    expect(parsed.world.inventory).toEqual(source.payload.inventory);
    expect(parsed.world.randomStreams).toEqual(source.payload.randomStreams);
    expect(parsed.world.sequences).toEqual({ ...source.payload.sequences, nextInstance: source.payload.sequences.nextInstance + 36 });
    expect(parsed.world.transactions).toEqual(source.payload.transactions);
    expect(parsed.world.disciples.map((d) => d.birthCalendarTick)).toEqual(source.payload.disciples.map((d: { birthCalendarTick: number }) => d.birthCalendarTick));
    expect(parsed.world.disciples.map((d) => d.ageMonths)).toEqual(parsed.world.cultivation.disciples.map((d) => d.ageMonths));
    const advanced = advanceTicks(parsed.world, 1170);
    expect(advanced.disciples[0]!.ageMonths).toBe(parsed.world.disciples[0]!.ageMonths + 1);
    expect(advanced.cultivation.calendarMonth).toBe(1);
    expect(reload(advanced)).toEqual(advanced);
    expect(JSON.parse(v2Text)).toEqual(source);
  });

  it('retains the genuine v1 source fixture and chains navigation then cultivation migration', () => {
    const source = JSON.parse(v1Text);
    const result = parseSave(v1Text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migration).toEqual({ sourceSaveVersion: 1, sourceSimulationVersion: '0.1.1', sourceChecksum: source.checksum });
    expect(result.world.cultivation.disciples).toHaveLength(4);
    expect(result.world.transactions['instance:1']!.activeTicks).toBe(47);
    expect(result.world.inventory).toEqual(source.payload.inventory);
    expect(result.world.randomStreams).toEqual(source.payload.randomStreams);
    expect(result.world.sequences).toEqual({ ...source.payload.sequences, nextEntity: source.payload.sequences.nextEntity + 1, nextInstance: source.payload.sequences.nextInstance + 36 });
    expect(JSON.parse(v1Text).checksum).toBe('b4d448f7');
  });

  it('archives legacy dead characters with an explicit unknown cause and pauses overage survivors without killing them', () => {
    const historicalDead = legacyVariant((world) => {
      const d = (world.disciples as Array<Record<string, unknown>>)[3]!; d.lifeState = 'dead';
    });
    const dead = parseSave(historicalDead);
    expect(dead.ok).toBe(true);
    if (dead.ok) {
      expect(dead.world.cultivation.deaths[0]!.cause).toBe('legacy-unknown');
      expect(dead.world.disciples[3]!.lifeState).toBe('dead');
      expect(dead.world.disciples[3]!.canWork).toBe(false);
    }
    const overageText = legacyVariant((world) => {
      const d = (world.disciples as Array<Record<string, unknown>>)[3]!;
      d.ageMonths = 1200; d.birthCalendarTick = (world.clock as { calendarTick: number }).calendarTick - 1200 * 1200;
    });
    const overage = parseSave(overageText);
    expect(overage.ok).toBe(true);
    if (overage.ok) {
      expect(overage.world.disciples[3]!.ageMonths).toBe(1200);
      expect(overage.world.disciples[3]!.lifeState).toBe('pendingDeath');
      expect(overage.world.cultivation.deaths).toEqual([]);
      expect(overage.world.clock.pauseReasons).toContain('cultivation');
      expect(advanceTicks(overage.world, 1200)).toEqual(overage.world);
      expect(reload(overage.world)).toEqual(overage.world);
    }
  });

  it('preserves stored v2 text on read/export and creates current v4 only through an explicit save', async () => {
    const repository = await openSaveRepository({ indexedDB: new FakeIDBFactory(), now: () => 1000 });
    try {
      const imported = await repository.importSave(v2Text, { ownerId: 'v2-test-tab' });
      const loaded = await repository.loadSlot(imported.slot.slotId);
      expect(loaded.envelope.saveVersion).toBe(7);
      expect(loaded.snapshot.text).toBe(v2Text);
      expect((await repository.exportSlot(imported.slot.slotId)).text).toBe(v2Text);
      const saved = await repository.saveWorld(imported.slot.slotId, loaded.world, metadata, { expectedRevision: 1, lease: imported.lease });
      expect(saved.slot.revision).toBe(2);
      expect(JSON.parse(saved.snapshot.text).saveVersion).toBe(7);
      expect(await repository.exportRawSnapshot(imported.slot.slotId, imported.snapshot.id)).toBe(v2Text);
    } finally { repository.close(); }
  });

  it('rejects future schema, invalid source checksum and inconsistent current authority without modifying source', () => {
    const future = JSON.parse(v2Text); future.saveVersion = SAVE_VERSION + 1;
    expect(parseSave(JSON.stringify(future))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    const damaged = JSON.parse(v2Text); damaged.checksum = '00000000';
    expect(parseSave(JSON.stringify(damaged))).toMatchObject({ ok: false, error: { code: 'CHECKSUM_MISMATCH' } });
    const envelope = createSaveEnvelope(createWorld(), metadata);
    envelope.payload.cultivation.disciples[0]!.ageMonths += 1;
    const { checksum: _checksum, ...body } = envelope;
    expect(parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
});
