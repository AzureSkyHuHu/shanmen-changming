import { describe, expect, it } from 'vitest';
import { SECT_V9_CANDIDATE_IDENTITY } from '../../src/content/sect-v9/catalog';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { previewBreakthroughV3 } from '../../src/core/cultivation/v3';
import type { CultivationCommand } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9 } from '../../src/core/kernel/commands-v9';
import { drawInteger, RANDOM_ALGORITHM } from '../../src/core/kernel/random';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { advanceUnregisteredTicksV9 } from '../../src/core/kernel/simulation-v9';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { cultivationFrameOf, prepareCultivationWorldEvents } from '../../src/core/world/cultivation-preparation';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { worldEventCursor, worldEventsSince } from '../../src/core/world/history-access';
import { inspectV9LifecycleRecords } from '../../src/core/world/v9-lifecycle-records';
import { V9_CULTIVATION_CLOCK_LIMIT } from '../../src/core/world/v9-cultivation-clock-types';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { inspectV10LifecycleRecords } from '../../src/core/world/v10-lifecycle-records';
import { prepareValidatedV10CultivationClock, prepareValidatedV10CultivationCommand, readV10PreWorkDeaths,
  type V10CultivationTransitionEvidence } from '../../src/core/world/v10-cultivation-preparation';
import { projectV10SectFrame, v10SectContext } from '../../src/core/world/v10-sect-frame';

const MONTH = CALENDAR_TICKS_PER_MONTH;
/** Record-only lifted fixture. NOT migration, complete v10 admission or gameplay. */
function records(source = createUnregisteredWorldV9('v10-transition-records')): WorldStateV10 {
  if (source.sectExpansion.production.jobs.length) throw new Error('Fixture requires no sect production history');
  return { ...cloneJson(source), simulationVersion: '0.10.0', runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol,
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...cloneJson(source.sectExpansion), schemaVersion: 2,
      production: { ...cloneJson(source.sectExpansion.production), jobs: [] },
      construction: { ...cloneJson(source.sectExpansion.construction), buildings: source.sectExpansion.construction.buildings.map(value => ({ ...value, level: 1 })) },
      upgrade: { schemaVersion: 1, protocol: 'alchemy-l1-l2.1', catalogIdentity: cloneJson(SECT_V9_CANDIDATE_IDENTITY), revision: 0,
        nextId: 1, jobs: [], receipts: [] } } };
}
/** Explicit initial near-expiry and idle-within-month boundary; no skipped lifetime claim. */
function nearExpiry(tick = 1, ids = ['entity:4']): WorldStateV9 {
  const source = createUnregisteredWorldV9(`v10-expiry-${tick}`);
  source.clock.simulationTick = tick - 1; source.clock.calendarTick = tick - 1;
  for (const id of ids) {
    const actor = source.disciples.find(member => member.id === id)!;
    const profile = source.cultivation.disciples.find(member => member.discipleId === id)!;
    actor.birthCalendarTick = tick - profile.lifespanMonths * MONTH;
    actor.ageMonths = Math.floor((tick - 1 - actor.birthCalendarTick) / MONTH); profile.ageMonths = actor.ageMonths;
  }
  return source;
}
function apply(source: WorldStateV10, command: CultivationCommand): WorldStateV10 {
  const prepared = prepareValidatedV10CultivationCommand(source, command);
  expect(prepared.transition.ok).toBe(true);
  if (!prepared.transition.ok) throw new Error(prepared.transition.code);
  return prepared.world;
}
function confirm(source: WorldStateV10, id: string, forced = false): WorldStateV10 {
  return apply(source, { kind: 'breakthrough.confirm', commandId: id, expectedRevision: source.cultivation.revision,
    preview: previewBreakthroughV3(cultivationFrameOf(source), 'entity:1', { method: forced ? 'forced' : 'standard', arraySupport: 0 }) });
}
function readySource(fatal = false): WorldStateV10 {
  let source = records();
  source.clock.simulationTick = MONTH - 1; source.clock.calendarTick = MONTH - 1;
  const profile = source.cultivation.disciples.find(member => member.discipleId === 'entity:1')!;
  // Explicit cultivated initial fixture. Every attempt, clock row and outcome below uses a real reducer.
  profile.cultivation = 120;
  if (fatal) {
    profile.injury = 60; profile.understanding = 0; profile.foundation = 0; profile.mindset = 0;
    const preview = previewBreakthroughV3(cultivationFrameOf(source), profile.discipleId, { method: 'forced', arraySupport: 0 });
    let found = false;
    for (let state = 1; state < 10000; state++) {
      const stream = { algorithm: RANDOM_ALGORITHM, state, draws: 0 };
      const success = drawInteger({ ...source.randomStreams, events: stream }, 'events', 1, 10000);
      const death = drawInteger(success.streams, 'events', 1, 10000);
      if (success.value > preview.successBps && death.value <= preview.failureDeathBps) {
        source.randomStreams.events = stream; found = true; break;
      }
    }
    if (!found) throw new Error('Missing deterministic fatal fixture');
  }
  source = confirm(source, 'ready.confirm', fatal);
  return apply(source, { kind: 'breakthrough.begin', commandId: 'ready.begin', expectedRevision: source.cultivation.revision,
    attemptId: source.cultivation.attempts[0]!.attemptId });
}

describe('internal actual v10 cultivation preparation, not whole-source admission', () => {
  it('calls the real clock once, preserves ordinary no-op cultivation and all sources', () => {
    const source = records(); const before = canonicalStringify(source);
    const prepared = prepareValidatedV10CultivationClock(source);
    expect(prepared.advanced).toBe(true); expect(prepared.world.clock.calendarTick).toBe(1);
    expect(prepared.world.cultivationClock.transitions).toEqual([]);
    expect(prepared.world.cultivation).toBe(source.cultivation);
    expect(prepared.world.sequences).toEqual(source.sequences); expect(prepared.world.randomStreams).toEqual(source.randomStreams);
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([]);
    expect(canonicalStringify(source)).toBe(before);
  });
  it('does not run cultivation or allocate a row while paused at a month boundary', () => {
    const source = records(nearExpiry(MONTH)); source.clock = setPauseReason(source.clock, 'player', true);
    const before = canonicalStringify(source); const prepared = prepareValidatedV10CultivationClock(source);
    expect(prepared.advanced).toBe(false); expect(prepared.world).toBe(source);
    expect(prepared.context.paused).toBe(true); expect(prepared.world.cultivationClock.transitions).toEqual([]);
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([]);
    expect(canonicalStringify(source)).toBe(before);
  });
  for (const tick of [1, MONTH]) it(`authenticates one real ${tick === 1 ? 'birthday' : 'month'} expiry row before work and pauses immediately`, () => {
    const source = records(nearExpiry(tick, ['entity:3', 'entity:4'])); const before = canonicalStringify(source);
    const prepared = prepareValidatedV10CultivationClock(source);
    expect(prepared.world.cultivationClock.transitions).toEqual([{ kind: tick === 1 ? 'age-sync' : 'month', tick,
      beforeRevision: source.cultivation.revision, rootActionId: `action:${source.sequences.nextAction}` }]);
    expect(prepared.world.cultivation.revision).toBe(source.cultivation.revision + 1);
    expect(prepared.world.sequences.nextAction).toBe(source.sequences.nextAction + 1);
    const facts = readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context);
    expect(facts).toHaveLength(2); expect(Object.isFrozen(facts)).toBe(true);
    for (const fact of facts) {
      expect(fact).toMatchObject({ cause: 'lifespan', unavailableKind: 'cultivation.expiryPending', unavailableTick: tick, unavailableCalendarTick: tick });
      expect(prepared.world.cultivation.pendingDeaths).toContainEqual(expect.objectContaining({ discipleId: fact.discipleId, deathId: fact.deathId }));
      expect(prepared.frame.construction.people.find(person => person.id === fact.discipleId)).toMatchObject({ lifeState: 'pendingDeath', canWork: false });
    }
    expect(prepared.world.clock.pauseReasons).toContain('cultivation'); expect(prepared.context.paused).toBe(true);
    expect(prepared.world.sectExpansion).toEqual(source.sectExpansion);
    expect(prepared.world.randomStreams).toEqual(source.randomStreams); expect(prepared.world.legacy).toEqual(source.legacy);
    const repeated = prepareValidatedV10CultivationClock(prepared.world);
    expect(repeated.advanced).toBe(false); expect(repeated.world).toBe(prepared.world);
    expect(readV10PreWorkDeaths(repeated.evidence, repeated.frame, repeated.context)).toEqual([]);
    expect(canonicalStringify(source)).toBe(before);
  });
  it('pauses the actual DecisionReady month before all downstream work or further clockwork', () => {
    const source = readySource(); const before = canonicalStringify(source);
    const prepared = prepareValidatedV10CultivationClock(source);
    expect(prepared.world.cultivation.attempts[0]!.phase).toBe('DecisionReady');
    expect(prepared.world.inventory.meal.owned).toBe(source.inventory.meal.owned - 1);
    expect(prepared.world.clock.pauseReasons).toContain('cultivation'); expect(prepared.context.paused).toBe(true);
    expect(prepared.world.sectExpansion).toEqual(source.sectExpansion);
    expect(prepared.world.randomStreams).toEqual(source.randomStreams);
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([]);
    expect(prepareValidatedV10CultivationClock(prepared.world).world).toBe(prepared.world);
    expect(canonicalStringify(source)).toBe(before);
  });
  it('authenticates a newly sampled breakthrough death without invoking completed-record retirement checks', () => {
    const source = prepareValidatedV10CultivationClock(readySource(true)).world;
    const before = canonicalStringify(source);
    const prepared = prepareValidatedV10CultivationCommand(source, { kind: 'breakthrough.resolve', commandId: 'fatal.resolve',
      expectedRevision: source.cultivation.revision, attemptId: source.cultivation.attempts[0]!.attemptId, acknowledgeRisk: true });
    expect(prepared.transition).toMatchObject({ ok: true, replayed: false, result: { outcome: 'death' } });
    const death = prepared.world.cultivation.deaths[0]!;
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([expect.objectContaining({
      discipleId: 'entity:1', deathId: death.deathId, cause: 'breakthrough', unavailableKind: 'cultivation.died', unavailableTick: MONTH })]);
    expect(prepared.world.disciples.find(actor => actor.id === death.discipleId)).toMatchObject({ lifeState: 'dead', canWork: false });
    expect(prepared.world.legacy.estates).toEqual([]); expect(prepared.world.cultivation.archivedDisciples).toEqual([]);
    expect(() => inspectV10LifecycleRecords(prepared.world)).toThrow();
    expect(canonicalStringify(source)).toBe(before);
  });
  it('finalizes an old pending death with real mirrors, but provides no delayed cancellation authority; exact retries remain inert', () => {
    const initial = nearExpiry(); const source = prepareValidatedV10CultivationClock(records(initial)).world;
    const death = source.cultivation.pendingDeaths[0]!;
    const command = { kind: 'death.finalize', commandId: 'expiry.finalize', expectedRevision: source.cultivation.revision,
      discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } satisfies CultivationCommand;
    const before = canonicalStringify(source); const prepared = prepareValidatedV10CultivationCommand(source, command);
    expect(prepared.transition).toMatchObject({ ok: true, replayed: false, result: { outcome: 'death' } });
    expect(worldEventsSince(prepared.world, worldEventCursor(source))).toEqual(prepareCultivationWorldEvents(source, cultivationFrameOf(prepared.world)));
    expect(worldEventsSince(prepared.world, worldEventCursor(source)).map(event => event.kind)).toEqual(['cultivation.died']);
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([]);
    expect(canonicalStringify(source)).toBe(before);
    // The unchanged v9 root supplies a genuinely settled archive fixture, not migration.
    const pendingV9 = advanceUnregisteredTicksV9(initial, 1).world;
    const settled = dispatchUnregisteredCommandV9(pendingV9, { kind: 'cultivation.command', commandId: command.commandId,
      issuedTick: 1, sequence: 0, payload: { command } });
    expect(settled.result.status).toBe('accepted'); const complete = records(settled.world);
    const retry = prepareValidatedV10CultivationCommand(complete, command);
    expect(retry.transition).toMatchObject({ ok: true, replayed: true }); expect(retry.world).toBe(complete);
    expect(readV10PreWorkDeaths(retry.evidence, retry.frame, retry.context)).toEqual([]);
  });
  it('returns failed commands with no source change or new authority', () => {
    const source = records(); const before = canonicalStringify(source);
    const prepared = prepareValidatedV10CultivationCommand(source, { kind: 'death.finalize', commandId: 'missing.death',
      expectedRevision: source.cultivation.revision, discipleId: 'entity:1', deathId: 'instance:999', cause: 'lifespan', acknowledgeDeath: true });
    expect(prepared.transition.ok).toBe(false); expect(prepared.world).toBe(source);
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([]);
    expect(canonicalStringify(source)).toBe(before);
  });
  it('does not turn a caller-supplied combat death into supported management authority', () => {
    const source = records(); const before = canonicalStringify(source);
    expect(() => prepareValidatedV10CultivationCommand(source, { kind: 'death.finalize', commandId: 'invented.combat.death',
      expectedRevision: source.cultivation.revision, discipleId: 'entity:1', deathId: 'combat:invented',
      cause: 'combat', acknowledgeDeath: true })).toThrow();
    expect(canonicalStringify(source)).toBe(before);
  });
  it('checks the exact appended mirror suffix across the real World archive boundary', () => {
    let source = records(nearExpiry()); source.cultivation.disciples[0]!.cultivation = 120;
    for (let index = 0; index < 32; index++) {
      source = confirm(source, `mirror.confirm.${index}`);
      source = apply(source, { kind: 'breakthrough.cancel', commandId: `mirror.cancel.${index}`, expectedRevision: source.cultivation.revision,
        attemptId: source.cultivation.attempts.at(-1)!.attemptId });
    }
    expect(source.events).toHaveLength(64); const cursor = worldEventCursor(source);
    const prepared = prepareValidatedV10CultivationClock(source);
    expect(prepared.world.history.events.count).toBe(1); expect(prepared.world.events).toHaveLength(64);
    const suffix = worldEventsSince(prepared.world, cursor);
    expect(suffix).toEqual(prepareCultivationWorldEvents({ cultivation: source.cultivation, clock: prepared.world.clock }, cultivationFrameOf(prepared.world)));
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)[0]!.unavailableEventId).toBe(suffix[0]!.eventId);
    (prepared.world.events.at(-1)! as { rootActionId: string }).rootActionId = 'action:9999';
    expect(() => readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toThrow();
  });
  it('rejects copied/JSON/forged/v9/record-only tokens and foreign equivalent frames or contexts', () => {
    const source = records(nearExpiry()); const prepared = prepareValidatedV10CultivationClock(source);
    const forgeries = [{}, { ...prepared.evidence }, JSON.parse(JSON.stringify(prepared.evidence)),
      inspectV9LifecycleRecords(createUnregisteredWorldV9()), inspectV10LifecycleRecords(source)];
    for (const token of forgeries) expect(() => readV10PreWorkDeaths(token as V10CultivationTransitionEvidence, prepared.frame, prepared.context)).toThrow();
    expect(() => readV10PreWorkDeaths(prepared.evidence, projectV10SectFrame(prepared.world), prepared.context)).toThrow();
    expect(() => readV10PreWorkDeaths(prepared.evidence, prepared.frame, v10SectContext(prepared.world))).toThrow();
    const other = prepareValidatedV10CultivationClock(source);
    expect(() => readV10PreWorkDeaths(prepared.evidence, other.frame, other.context)).toThrow();
  });
  for (const part of ['source', 'candidate', 'frame', 'context', 'mirror', 'death-record'] as const) it(`rejects ${part} mutation after the actual reducer call`, () => {
    const source = records(nearExpiry()); const prepared = prepareValidatedV10CultivationClock(source);
    if (part === 'source') source.seed += '.mutated';
    if (part === 'candidate') prepared.world.seed += '.mutated';
    if (part === 'frame') (prepared.frame.construction as unknown as { lastSimulationTick: number }).lastSimulationTick++;
    if (part === 'context') (prepared.context as unknown as { paused: boolean }).paused = false;
    if (part === 'mirror') (prepared.world.events.at(-1)!.payload as { month: number }).month = 99;
    if (part === 'death-record') prepared.world.cultivation.pendingDeaths[0]!.deathId = 'instance:9999';
    expect(() => readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toThrow();
  });
  it('rechecks mutable source descendants below a shallow-frozen preparation root', () => {
    const source = Object.freeze(records()); const prepared = prepareValidatedV10CultivationClock(source);
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([]);
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([]);
    expect(Object.isFrozen(source.clock)).toBe(false);
    source.clock.speed = 3;
    expect(() => readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toThrow('Changed v10 cultivation transition binding');
    expect(Object.isFrozen(source.clock)).toBe(false);
  });
  it('rejects a mutable binding getter introduced after successful evidence reads without executing it', () => {
    const source = records(); const prepared = prepareValidatedV10CultivationClock(source);
    expect(readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toEqual([]);
    Object.freeze(prepared.context); let reads = 0;
    Object.defineProperty(prepared.world.clock, 'speed', { enumerable: true, get: () => { reads++; return 1; } });
    expect(() => readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toThrow();
    expect(reads).toBe(0);
  });
  it('binds the actual command result, even when only its result summary is changed', () => {
    const source = records(); const prepared = prepareValidatedV10CultivationCommand(source, { kind: 'training.set', commandId: 'train.noop',
      expectedRevision: source.cultivation.revision, discipleId: 'entity:1', mode: 'duty' });
    if (!prepared.transition.ok) throw new Error(prepared.transition.code);
    prepared.transition.result.outcome = 'death';
    expect(() => readV10PreWorkDeaths(prepared.evidence, prepared.frame, prepared.context)).toThrow();
  });
});

/** Pressure-only event-free month-row expansion AFTER genuine death/archive reducers.
 * Not a claim to have simulated millions of ticks or a migration acceptance fixture. */
function fullClock(): WorldStateV10 {
  let world = advanceUnregisteredTicksV9(nearExpiry(MONTH, ['entity:1', 'entity:2', 'entity:3', 'entity:4']), 1).world;
  for (const death of [...world.cultivation.pendingDeaths]) {
    const commandId = `capacity.finalize.${death.discipleId}`;
    const result = dispatchUnregisteredCommandV9(world, { kind: 'cultivation.command', commandId, issuedTick: MONTH, sequence: 0,
      payload: { command: { kind: 'death.finalize', commandId, expectedRevision: world.cultivation.revision,
        discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    expect(result.result.status).toBe('accepted'); world = result.world;
  }
  const source = records(world);
  for (let month = 2; month <= V9_CULTIVATION_CLOCK_LIMIT; month++) source.cultivationClock.transitions.push({ kind: 'month', tick: month * MONTH,
    beforeRevision: source.cultivation.revision++, rootActionId: `action:${source.sequences.nextAction++}` });
  source.cultivation.calendarMonth = V9_CULTIVATION_CLOCK_LIMIT;
  source.clock.simulationTick = (V9_CULTIVATION_CLOCK_LIMIT + 1) * MONTH - 1; source.clock.calendarTick = source.clock.simulationTick;
  return source;
}
describe('finite v10 clock-row preflight', () => {
  it('refuses the next row before schema-3 work and leaves all source state intact', () => {
    const source = fullClock(); expect(source.disciples).toEqual([]);
    inspectV10LifecycleRecords(source); const before = canonicalStringify(source);
    expect(() => prepareValidatedV10CultivationClock(source)).toThrow('Cultivation clock record capacity exhausted');
    expect(canonicalStringify(source)).toBe(before);
    source.clock = setPauseReason(source.clock, 'player', true);
    expect(prepareValidatedV10CultivationClock(source).world).toBe(source);
  });
});
