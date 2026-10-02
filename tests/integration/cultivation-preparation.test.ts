import { describe, expect, it } from 'vitest';
import type { CultivationCommand } from '../../src/core/cultivation/v3';
import { applyCultivationCommandV3 } from '../../src/core/cultivation/v3';
import { classifyAutomaticHandle, startAutomaticProduction } from '../../src/core/economy/automatic-production';
import { tickProduction } from '../../src/core/economy/production';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason, tickClock } from '../../src/core/kernel/clock';
import { dispatchCommandV8 } from '../../src/core/kernel/commands-v8';
import type { CommandResult, PlayerCultivationCommand } from '../../src/core/kernel/contracts';
import type { CommandV8 } from '../../src/core/kernel/contracts-v8';
import { createSaveEnvelopeV8, parseSaveV8, serializeSaveV8 } from '../../src/core/kernel/save-v8';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { advanceTicksWithStatusV8 } from '../../src/core/kernel/simulation-v8';
import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { advanceWorldCultivationV8, dispatchWorldCultivationV8, previewWorldBreakthroughV8 } from '../../src/core/world/cultivation-bridge-v8';
import { cultivationFrameOf, prepareCultivationClockAdvance, prepareCultivationWorldEvents, projectCultivationDisciples } from '../../src/core/world/cultivation-preparation';
import { lookupProduction, recordWorldReceipt, restoreWorldHistory, worldEventCursor, worldEventsSince } from '../../src/core/world/history-access';
import { prepareWorldEstateSettlement } from '../../src/core/world/legacy-bridge';
import type { WorldStateV8 } from '../../src/core/world/v8-types';
import * as frozen from './fixtures/pre-extraction-cultivation-bridge-v8';
import { prepareWorldEstateSettlement as frozenEstate } from './fixtures/pre-extraction-legacy-bridge';

type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
type CultureCommand = Extract<CommandV8, { kind: 'cultivation.command' }>;
const metadata = { buildId: 'cultivation-preparation-oracle', savedAt: '2026-10-02T05:00:00Z' };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function command(world: WorldStateV8, body: Body<PlayerCultivationCommand>, commandId = `port:${world.cultivation.revision}`): CultureCommand {
  return { kind: 'cultivation.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { command: { ...body, commandId, expectedRevision: world.cultivation.revision } as PlayerCultivationCommand } };
}
function cultivate(world: WorldStateV8, body: Body<PlayerCultivationCommand>): WorldStateV8 {
  const applied = dispatchCommandV8(world, command(world, body));
  expect(applied.result.status, JSON.stringify(applied.result)).toBe('accepted');
  expect(validateWorldStateV8(applied.world)).toEqual([]); return applied.world;
}
function reload(world: WorldStateV8): WorldStateV8 {
  const parsed = parseSaveV8(serializeSaveV8(createSaveEnvelopeV8(world, metadata)));
  expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message); return parsed.world;
}
/** Near-expiry chronology is a declared pressure fixture. Pending and finalized
 * death records, production cancellation and inheritance are always real actions. */
function expireAt(world: WorldStateV8, index: number, tick: number): void {
  const profile = world.cultivation.disciples[index]!; const actor = world.disciples[index]!;
  actor.birthCalendarTick = tick - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH);
  profile.ageMonths = actor.ageMonths;
}
function clocked(world: WorldStateV8): WorldStateV8 { return { ...world, clock: tickClock(world.clock) }; }
function compareAdvance(world: WorldStateV8): WorldStateV8 {
  const before = canonicalStringify(world); freeze(world);
  const expected = frozen.advanceWorldCultivationV8(world); const actual = advanceWorldCultivationV8(world);
  expect(canonicalStringify(actual)).toBe(canonicalStringify(expected));
  expect(canonicalStringify(world)).toBe(before); return actual;
}
function compareCommand(world: WorldStateV8, input: CultivationCommand) {
  const before = canonicalStringify(world); freeze(world);
  const expected = frozen.dispatchWorldCultivationV8(world, input, { commandId: input.commandId });
  const actual = dispatchWorldCultivationV8(world, input, { commandId: input.commandId });
  expect(canonicalStringify(actual)).toBe(canonicalStringify(expected));
  expect(canonicalStringify(world)).toBe(before); return actual;
}
/** The unchanged outer command receipt is required before strict estate checks.
 * This narrow test assembly is not an alternate World admission implementation. */
function withReceipt(world: WorldStateV8, input: CultureCommand): WorldStateV8 {
  const operation = compareCommand(world, input.payload.command);
  expect(operation.ok).toBe(true); if (!operation.ok) throw new Error(operation.code);
  const result: CommandResult = { commandId: input.commandId, status: 'accepted', transactionId: null,
    eventIds: operation.eventIds, rejection: null, cultivationResult: operation.result };
  return recordWorldReceipt(operation.world, { commandId: input.commandId,
    fingerprint: canonicalStringify({ kind: input.kind, payload: input.payload }), result });
}
function pendingDeath(heir: boolean): WorldStateV8 {
  let world = createWorldV8(`port-estate-${heir}`);
  if (heir) world = cultivate(world, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' });
  world = cloneJson(world); expireAt(world, 0, 1);
  expect(validateWorldStateV8(world)).toEqual([]);
  const pending = compareAdvance(clocked(world)); expect(validateWorldStateV8(pending)).toEqual([]); return pending;
}
function finalizeCommand(world: WorldStateV8): CultureCommand {
  const pending = world.cultivation.pendingDeaths[0]!;
  return command(world, { kind: 'death.finalize', discipleId: pending.discipleId, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true });
}

describe('schema-3 preparation without World version publication authority', () => {
  it('prepares a genuine off-month pending death using only structural fields, leaving every World obligation untouched', () => {
    const world = createWorldV8('port-structural'); expireAt(world, 0, 17);
    world.clock.calendarTick = 17; world.clock.simulationTick = 17;
    const source = freeze({ ...cultivationFrameOf(world), clock: world.clock, disciples: world.disciples });
    const before = canonicalStringify(source); const frame = prepareCultivationClockAdvance(source);
    expect(frame).not.toBeNull(); if (!frame) throw new Error('Expected birthday candidate');
    expect(Object.keys(frame).sort()).toEqual(['cultivation', 'inventory', 'randomStreams', 'sequences']);
    expect(frame.cultivation.pendingDeaths).toHaveLength(1);
    expect(frame.cultivation.disciples[0]!.lifeState).toBe('pendingDeath');
    expect(source.disciples[0]!.lifeState).toBe('alive'); expect(source.clock.pauseReasons).toEqual([]);
    expect(frame.randomStreams).toEqual(source.randomStreams);
    const events = prepareCultivationWorldEvents(source, frame);
    expect(events).toEqual(frame.cultivation.events.map(event => ({ eventId: event.eventId, kind: event.kind,
      tick: 17, rootActionId: event.rootActionId, parentEventId: null,
      payload: { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month } })));
    const actors = projectCultivationDisciples(source.disciples.map(actor => ({ ...actor, independentMarker: 'kept' })), frame.cultivation);
    expect(actors[0]).toMatchObject({ lifeState: 'pendingDeath', canWork: false, independentMarker: 'kept' });
    expect(canonicalStringify(source)).toBe(before);
    expect(world.legacy.estates).toEqual([]); expect(world.builds.retiredDisciples).toEqual([]);
  });

  it('does not treat a prepared domain frame as aggregate reservation admission', () => {
    const world = createWorldV8('port-reservation-authority');
    world.inventory.wood.reserved = 1;
    expect(validateWorldStateV8(world)).toEqual(['Reservation totals do not match inventory']);
    const source = freeze({ ...cultivationFrameOf(world), clock: { ...world.clock, calendarTick: 1200, simulationTick: 1200 }, disciples: world.disciples });
    const frame = prepareCultivationClockAdvance(source);
    expect(frame).not.toBeNull(); if (!frame) throw new Error('Expected monthly candidate');
    expect(frame.inventory.wood.reserved).toBe(1); expect(prepareCultivationWorldEvents(source, frame)).toEqual([]);
    const candidate = { ...world, ...frame, clock: source.clock, disciples: projectCultivationDisciples(world.disciples, frame.cultivation) };
    expect(validateWorldStateV8(candidate)).toEqual(['Reservation totals do not match inventory']);
    expect(source.inventory.wood.reserved).toBe(1);
  });

  it('keeps unchanged/combat boundaries as no-op candidates and does not fabricate an unpaused clock', () => {
    const world = createWorldV8('port-no-op');
    expect(prepareCultivationClockAdvance(world)).toBeNull(); expect(compareAdvance(world)).toBe(world);
    const combat = { ...world, clock: { ...world.clock, mode: 'combat' as const } };
    expect(prepareCultivationClockAdvance(combat)).toBeNull(); expect(compareAdvance(combat)).toBe(combat);
    const paused = { ...world, clock: setPauseReason(world.clock, 'hidden', true) };
    expect(tickClock(paused.clock)).toBe(paused.clock); expect(compareAdvance(paused)).toBe(paused);
    expect(advanceTicksWithStatusV8(paused, 1200).world).toEqual(paused);
  });
});

describe('frozen pre-extraction v8 lifecycle publication oracle', () => {
  it('matches the exact monthly frame, preserves other pause owners and does not double-age an off-month birthday', () => {
    let world = cultivate(createWorldV8('port-month'), { kind: 'training.set', discipleId: 'entity:2', mode: 'training' });
    world = cloneJson(world); world.disciples[1]!.birthCalendarTick += 17;
    world.disciples[1]!.ageMonths--; world.cultivation.disciples[1]!.ageMonths--;
    const age = world.disciples[1]!.ageMonths;
    world.clock.calendarTick = 16; world.clock.simulationTick = 16;
    expect(validateWorldStateV8(world)).toEqual([]);
    world = compareAdvance(clocked(world));
    expect(world.disciples[1]!.ageMonths).toBe(age + 1); expect(world.cultivation.disciples[1]!.cultivation).toBe(0);
    world = { ...world, clock: { ...world.clock, calendarTick: 1200, simulationTick: 1200 } };
    world = compareAdvance(world);
    expect(world.disciples[1]!.ageMonths).toBe(age + 1);
    expect(world.cultivation.disciples[1]!.cultivation).toBe(8 + Math.floor(world.disciples[1]!.aptitude / 10));
    expect(world.cultivation.calendarMonth).toBe(1); expect(reload(world)).toEqual(world);
  });

  it('cancels real delivery before output on the expiry month, with exact event IDs, positions, reservation release and pause', () => {
    const started = dispatchCommandV8(createWorldV8('port-delivery'), { kind: 'production.start', commandId: 'port:production',
      sequence: 0, issuedTick: 0, payload: { recipeId: 'craft.plank', workerId: 'entity:2' } });
    expect(started.result.status).toBe('accepted'); const id = started.result.transactionId!;
    let world = started.world;
    for (let tick = 0; tick < 800 && world.transactions[id]?.phase !== 'AwaitingDelivery'; tick++) world = tickProduction(advanceWorldCultivationV8(clocked(world)));
    expect(world.transactions[id]!.phase).toBe('AwaitingDelivery');
    world = cloneJson(world); world.clock.simulationTick = 1199; world.clock.calendarTick = 1199; expireAt(world, 1, 1200);
    expect(validateWorldStateV8(world)).toEqual([]);
    const position = cloneJson(world.disciples[1]!.position); const cursor = worldEventCursor(world);
    const next = compareAdvance(clocked(world));
    expect(lookupProduction(next, id)).toMatchObject({ state: 'Cancelled', phase: 'Cancelled', completedTick: 1200 });
    expect(next.inventory.plank.owned).toBe(0); expect(next.inventory.wood.owned).toBe(24); expect(next.inventory.wood.reserved).toBe(0);
    expect(next.disciples[1]).toMatchObject({ lifeState: 'pendingDeath', canWork: false, traveling: false, assignmentTransactionId: null, position });
    expect(next.buildings.every(site => site.stationTransactionId !== id)).toBe(true);
    expect(next.clock.pauseReasons).toEqual(['cultivation']); expect(tickProduction(next)).toBe(next);
    expect(worldEventsSince(next, cursor).map(event => event.kind)).toEqual(['cultivation.expiryPending', 'production.cancelled']);
    expect(reload(next)).toEqual(next);
  });

  it('preserves automatic cancellation receipt pins when a cultivation command takes the worker', () => {
    let world = createWorldV8('port-automatic');
    for (const [suffix, input] of [['plan', { kind: 'plan.set', plan: { workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'craft.plank', targetStock: 999 }] } }],
      ['enable', { kind: 'enabled.set', enabled: true }]] as const) {
      const result = dispatchCommandV8(world, { kind: 'sect-economy.command', commandId: `port:auto:${suffix}`, sequence: 0, issuedTick: 0, payload: { command: input } });
      expect(result.result.status).toBe('accepted'); world = result.world;
    }
    const started = startAutomaticProduction(world, { workerId: 'entity:2', recipeId: 'craft.plank' });
    expect(started.ok).toBe(true); if (!started.ok) throw new Error(started.reason); world = started.world;
    const input = command(world, { kind: 'training.set', discipleId: 'entity:2', mode: 'training' });
    const next = withReceipt(world, input); const actual = dispatchCommandV8(world, input);
    expect(actual.result.status).toBe('accepted'); expect(actual.world).toEqual(next);
    expect(classifyAutomaticHandle(next, started.transactionId).kind).toBe('pinned');
    expect(next.automaticProduction.pins[started.transactionId]).toMatchObject({ state: 'Cancelled', retention: 'exact-receipt' });
    expect(next.inventory.wood.reserved).toBe(0); expect(next.activeProductionTransactionIds).toEqual([]);
    const restored = reload(next); expect(dispatchCommandV8(restored, input).world).toBe(restored);
  });

  it('keeps breakthrough resolution RNG, build milestones, result identities and player pause exactly frozen', () => {
    let world = createWorldV8('port-breakthrough'); world.cultivation.disciples[1]!.cultivation = 120;
    const preview = previewWorldBreakthroughV8(world, 'entity:2');
    world = cultivate(world, { kind: 'breakthrough.confirm', preview });
    const attemptId = world.cultivation.attempts[0]!.attemptId;
    world = cultivate(world, { kind: 'breakthrough.begin', attemptId });
    world = compareAdvance({ ...world, clock: { ...world.clock, calendarTick: 1200, simulationTick: 1200 } });
    expect(world.cultivation.attempts[0]!.phase).toBe('DecisionReady'); expect(world.clock.pauseReasons).toContain('cultivation');
    world = { ...world, clock: setPauseReason(world.clock, 'player', true) };
    const beforeRng = cloneJson(world.randomStreams);
    const input = command(world, { kind: 'breakthrough.resolve', attemptId, acknowledgeRisk: true });
    const next = withReceipt(world, input);
    expect(next.randomStreams.events.draws).toBeGreaterThan(beforeRng.events.draws);
    expect(next.clock.pauseReasons).toEqual(['player']); expect(reload(next)).toEqual(next);
    expect(dispatchCommandV8(world, input).world).toEqual(next);
    expect(dispatchCommandV8(next, input).world).toBe(next);
  });

  it.each([true, false])('keeps real finalization, item inheritance, archival and exact retries with living heir=%s', heir => {
    const pending = pendingDeath(heir); const input = finalizeCommand(pending);
    const unretired = withReceipt(pending, input); const before = canonicalStringify(unretired); freeze(unretired);
    const expected = frozenEstate(unretired); const actual = prepareWorldEstateSettlement(unretired);
    expect(canonicalStringify(actual)).toBe(canonicalStringify(expected)); expect(actual.ok).toBe(true);
    if (!actual.ok) throw new Error(actual.details.join('; '));
    if (!expected.ok) throw new Error(expected.details.join('; '));
    const next = actual.candidate; expect(validateWorldStateV8(next)).toEqual([]);
    const estate = next.legacy.estates[0]!;
    expect(actual.settledDeathIds).toEqual([pending.cultivation.pendingDeaths[0]!.deathId]); expect(actual.pendingDeathIds).toEqual([]);
    expect(estate.settledOwner).toEqual(heir ? { kind: 'disciple', discipleId: 'entity:2' } : { kind: 'sect-estate' });
    expect(estate.itemInstanceIds.length).toBeGreaterThan(0);
    expect(next.builds.equipment.filter(item => estate.itemInstanceIds.includes(item.instanceId)).every(item => canonicalStringify(item.owner) === canonicalStringify(estate.settledOwner))).toBe(true);
    expect(next.disciples.some(actor => actor.id === 'entity:1')).toBe(false);
    expect(next.legacy.archivedIdentities[0]).toMatchObject({ discipleId: 'entity:1', presentationId: 'disciple-0' });
    expect(next.randomStreams).toEqual(unretired.randomStreams); expect(next.sequences).toEqual(unretired.sequences);
    // cloneJson in the chronology fixture loses the codec's private seal. Merely
    // freezing it cannot authenticate it; both old and new estate paths restore
    // that raw archive. A codec-restored archive can instead be shared by identity.
    expect(expected.candidate.history).not.toBe(unretired.history); expect(next.history).not.toBe(unretired.history);
    expect(next.history).toEqual(unretired.history); expect(canonicalStringify(unretired)).toBe(before);
    const authenticated = restoreWorldHistory(unretired); const shared = prepareWorldEstateSettlement(authenticated);
    const frozenShared = frozenEstate(authenticated);
    expect(shared.ok && shared.candidate.history === authenticated.history).toBe(true);
    expect(frozenShared.ok && frozenShared.candidate.history === authenticated.history).toBe(true);
    expect(dispatchCommandV8(pending, input).world).toEqual(next);
    const restored = reload(next); expect(dispatchCommandV8(restored, input).world).toBe(restored);
    expect(prepareWorldEstateSettlement(restored)).toMatchObject({ ok: true, candidate: restored, settledDeathIds: [], pendingDeathIds: [] });
  });

  it('keeps complete estate byte rejection and source immutability after real finalization', () => {
    const pending = pendingDeath(true); const unretired = withReceipt(pending, finalizeCommand(pending));
    const unpadded = { ...unretired, lifecycleAudit: '' };
    const nearCap = { ...unpadded, lifecycleAudit: 'x'.repeat(SAVE_FILE_LIMIT_BYTES - measureWorldSaveBytes(unpadded, { saveVersion: 8 })) };
    expect(measureWorldSaveBytes(nearCap, { saveVersion: 8 })).toBe(SAVE_FILE_LIMIT_BYTES);
    const before = canonicalStringify(nearCap); freeze(nearCap);
    const expected = frozenEstate(nearCap); const actual = prepareWorldEstateSettlement(nearCap);
    expect(actual).toEqual(expected); expect(actual).toMatchObject({ ok: false, code: 'SAVE_CAPACITY_EXCEEDED' });
    expect(canonicalStringify(nearCap)).toBe(before);
  });

  it.each([
    ['combat wins over invalid inner identity/revision', (world: WorldStateV8) => { world.clock.mode = 'combat'; }, 'DISCIPLE_UNAVAILABLE'],
    ['revision wins over unknown disciple', (_world: WorldStateV8) => {}, 'REVISION_CONFLICT'],
    ['invalid frame wins over revision', (world: WorldStateV8) => { world.inventory.wood.reserved = 1000; }, 'INVALID_STATE'],
  ] as const)('preserves command rejection order: %s', (_name, change, expected) => {
    const world = createWorldV8('port-errors'); change(world);
    const input: CultivationCommand = { kind: 'training.set', commandId: 'port:rejected', expectedRevision: 99, discipleId: 'entity:missing', mode: 'training' };
    expect(compareCommand(world, input)).toEqual({ ok: false, code: expected });
  });

  it.each([
    ['missing identity precedes skipped month', (world: WorldStateV8) => { world.cultivation.disciples.pop(); world.clock.calendarTick = 2400; }, 'Missing cultivation identity'],
    ['skipped month', (world: WorldStateV8) => { world.clock.calendarTick = 2400; }, 'Cultivation calendar skipped a month'],
    ['monthly revision exhaustion', (world: WorldStateV8) => { world.clock.calendarTick = 1200; world.cultivation.revision = Number.MAX_SAFE_INTEGER; }, 'Cultivation month failed: overflow'],
  ] as const)('preserves clock preparation failure order and source: %s', (_name, change, message) => {
    const world = createWorldV8('port-clock-errors'); change(world); const before = canonicalStringify(world); freeze(world);
    expect(() => frozen.advanceWorldCultivationV8(world)).toThrow(message);
    expect(() => advanceWorldCultivationV8(world)).toThrow(message);
    expect(canonicalStringify(world)).toBe(before);
  });

  it('does not leak an otherwise valid prepared command after legacy owner cleanup fails', () => {
    const world = createWorldV8('port-owner-failure'); world.activeProductionTransactionIds.push('instance:missing');
    const input = command(world, { kind: 'training.set', discipleId: 'entity:2', mode: 'training' }).payload.command;
    const before = canonicalStringify(world); freeze(world);
    const prepared = applyCultivationCommandV3(cultivationFrameOf(world), input); expect(prepared.ok).toBe(true);
    expect(() => frozen.dispatchWorldCultivationV8(world, input)).toThrow('Missing production obligation');
    expect(() => dispatchWorldCultivationV8(world, input)).toThrow('Missing production obligation');
    expect(canonicalStringify(world)).toBe(before);
  });
});
