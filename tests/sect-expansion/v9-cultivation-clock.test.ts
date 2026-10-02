import { describe, expect, it } from 'vitest';
import type { CultivationCommand } from '../../src/core/cultivation/types';
import { recordWorldReceipt } from '../../src/core/world/history-access';
import { applyCultivationCommandV3 } from '../../src/core/cultivation/v3';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9 } from '../../src/core/kernel/commands-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { advanceUnregisteredTicksV9 } from '../../src/core/kernel/simulation-v9';
import { inspectUnregisteredWorldV9Records, validateWorldState, validateWorldStateV8 } from '../../src/core/kernel/validation';
import { createWorld } from '../../src/core/world/create-world';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { composeV9CultivationFrame } from '../../src/core/world/v9-cultivation-bridge';
import { advanceV9CultivationClock } from '../../src/core/world/v9-cultivation-clock-bridge';
import { inspectV9CultivationClockRecords } from '../../src/core/world/v9-cultivation-clock-records';
import { V9_CULTIVATION_CLOCK_LIMIT } from '../../src/core/world/v9-cultivation-clock-types';
import type { WorldStateV9 } from '../../src/core/world/v9-types';

const MONTH = CALENDAR_TICKS_PER_MONTH;
function valid(world: WorldStateV9): WorldStateV9 { expect(inspectUnregisteredWorldV9Records(world)).toEqual([]); return world; }
function ticks(world: WorldStateV9, count = 1): WorldStateV9 {
  const result = advanceUnregisteredTicksV9(world, count); expect(result.stopped, JSON.stringify(result.stopped)).toBeNull(); return valid(result.world);
}
function command(world: WorldStateV9, id: string, mode: 'rest' | 'duty' = 'duty'): WorldStateV9 {
  const result = dispatchUnregisteredCommandV9(world, { kind: 'cultivation.command', commandId: id, issuedTick: world.clock.simulationTick, sequence: 0,
    payload: { command: { kind: 'training.set', commandId: id, expectedRevision: world.cultivation.revision, discipleId: 'entity:1', mode } } });
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return valid(result.world);
}
/** Explicit within-month idle boundary fixture, not a claim to have simulated skipped ticks. */
function boundary(world: WorldStateV9, tick: number): WorldStateV9 {
  const next = cloneJson(world); next.clock.simulationTick = tick; next.clock.calendarTick = tick; return valid(next);
}
function birthday(world: WorldStateV9, ids: readonly string[], residue: number, expiry = false): WorldStateV9 {
  const next = cloneJson(world);
  for (const id of ids) {
    const actor = next.disciples.find(actor => actor.id === id)!; const profile = next.cultivation.disciples.find(profile => profile.discipleId === id)!;
    actor.birthCalendarTick = residue - (expiry ? profile.lifespanMonths : profile.ageMonths) * MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / MONTH); profile.ageMonths = actor.ageMonths;
  }
  return valid(next);
}
function finalize(world: WorldStateV9, id: string): WorldStateV9 {
  const death = world.cultivation.pendingDeaths.find(death => death.discipleId === id)!; const commandId = `finalize.${id.replace(':', '.')}`;
  const result = dispatchUnregisteredCommandV9(world, { kind: 'cultivation.command', commandId, issuedTick: world.clock.simulationTick, sequence: 0,
    payload: { command: { kind: 'death.finalize', commandId, expectedRevision: world.cultivation.revision, discipleId: id,
      deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return valid(result.world);
}

// Fast boundary cases use genuine reducers for every revision-producing transition.
describe('fresh .3 complete bounded cultivation revision ownership', () => {
  it('starts with no rows, rejects .2 and rejects the reserved root on old versions', () => {
    const world = createUnregisteredWorldV9('clock-fresh'); expect(world.runtimeProtocol).toBe('fresh-management-v9-unregistered.3');
    expect(world.cultivationClock).toEqual({ transitions: [] });
    expect(inspectUnregisteredWorldV9Records({ ...world, runtimeProtocol: 'fresh-management-v9-unregistered.2' } as unknown as WorldStateV9).length).toBeGreaterThan(0);
    expect(validateWorldState({ ...createWorld(), cultivationClock: { transitions: [] } })).toContain('Legacy World contains reserved v9 fields');
    expect(validateWorldStateV8({ ...createWorldV8(), cultivationClock: { transitions: [] } })).toContain('Legacy World contains reserved v9 fields');
  });
  it('counts accepted no-op commands once, including duplicate talent grants, but not exact retries', () => {
    let world = command(createUnregisteredWorldV9('clock-noop'), 'noop.one'); world = command(world, 'noop.two');
    expect(world.cultivation.revision).toBe(2); expect(world.cultivationClock.transitions).toEqual([]);
    for (const commandId of ['talent.one', 'talent.two']) {
      const result = applyCultivationCommandV3(world, { kind: 'talent.grant', commandId, expectedRevision: world.cultivation.revision,
        discipleId: 'entity:1', talentId: 'cultivation.resilient-body' });
      expect(result.ok).toBe(true); if (!result.ok) throw new Error('grant failed'); world = valid(composeV9CultivationFrame(world, result.frame));
    }
    expect(world.cultivation.revision).toBe(4); expect(world.cultivation.events).toHaveLength(1);
    const replay = dispatchUnregisteredCommandV9(world, { kind: 'cultivation.command', commandId: 'noop.one', issuedTick: 0, sequence: 0,
      payload: { command: { kind: 'training.set', commandId: 'noop.one', expectedRevision: 0, discipleId: 'entity:1', mode: 'duty' } } });
    expect(replay.result.status).toBe('accepted'); expect(replay.world).toBe(world);
  });
  it('emits no row on ordinary ticks and one month row for simultaneous month birthdays', () => {
    let world = ticks(createUnregisteredWorldV9('clock-month'), 3); expect(world.cultivation.revision).toBe(0);
    world = command(world, 'before.month', 'rest'); world = ticks(boundary(world, MONTH - 1));
    expect(world.cultivationClock.transitions).toEqual([{ kind: 'month', tick: MONTH, beforeRevision: 1, rootActionId: 'action:2' }]);
    world = command(world, 'after.month'); expect(world.cultivation.revision).toBe(3);
    expect(ticks(cloneJson(world), 2)).toEqual(ticks(world, 2));
  });
  it('groups simultaneous off-month birthdays into one increment and survives JSON continuation', () => {
    const source = birthday(createUnregisteredWorldV9('clock-birthday'), ['entity:1', 'entity:2'], 7);
    const world = ticks(boundary(source, 6)); expect(world.cultivationClock.transitions).toEqual([{ kind: 'age-sync', tick: 7, beforeRevision: 0, rootActionId: 'action:1' }]);
    expect(ticks(cloneJson(world), 1)).toEqual(ticks(world, 1));
    expect(world.cultivation.revision).toBe(1);
  });
  it('retains exact lifetime evidence after several archive increments and never invents post-death birthdays', () => {
    const source = birthday(createUnregisteredWorldV9('clock-archive'), ['entity:1', 'entity:2'], 1, true);
    const pending = ticks(source); expect(pending.cultivation.pendingDeaths).toHaveLength(2);
    const first = finalize(pending, 'entity:1'); const archived = finalize(first, 'entity:2');
    expect(archived.cultivation.revision).toBe(5); expect(archived.cultivation.authorityReceipts.map(receipt => receipt.revision)).toEqual([3, 5]);
    const next = ticks(boundary(archived, MONTH - 1)); expect(next.cultivationClock.transitions).toHaveLength(2);
    expect(next.cultivationClock.transitions[1]).toMatchObject({ kind: 'month', beforeRevision: 5, tick: MONTH });
    expect(inspectUnregisteredWorldV9Records(cloneJson(next))).toEqual([]);
    const fake = cloneJson(next); fake.cultivationClock.transitions.push({ kind: 'age-sync', tick: MONTH + 1, beforeRevision: 6, rootActionId: `action:${fake.sequences.nextAction}` });
    fake.sequences.nextAction++; fake.cultivation.revision++; fake.clock.simulationTick++; fake.clock.calendarTick++;
    expect(inspectUnregisteredWorldV9Records(fake).length).toBeGreaterThan(0);
  });
  const corruptions: [string, (world: WorldStateV9) => void][] = [
    ['duplicate owner', world => { world.cultivationClock.transitions[0]!.beforeRevision--; }],
    ['gap', world => { world.cultivation.revision++; }],
    ['missing month', world => { world.cultivationClock.transitions.pop(); world.cultivation.revision--; }],
    ['wrong month tick', world => { world.cultivationClock.transitions[0]!.tick--; }],
    ['fake kind', world => { world.cultivationClock.transitions[0]!.kind = 'age-sync'; }],
    ['unallocated root', world => { world.cultivationClock.transitions[0]!.rootActionId = `action:${world.sequences.nextAction}`; }],
    ['reordered commands', world => { world.cultivation.receipts.reverse(); }],
    ['noncanonical receipt', world => { world.cultivation.receipts[0]!.fingerprint += ' '; }],
    ['huge revision', world => { world.cultivation.revision = Number.MAX_SAFE_INTEGER; }],
    ['huge month', world => { world.clock.simulationTick = Number.MAX_SAFE_INTEGER; world.clock.calendarTick = Number.MAX_SAFE_INTEGER; }],
  ];
  for (const [label, corrupt] of corruptions) it(`rejects ${label} using a finite index`, () => {
    let world = command(createUnregisteredWorldV9(`clock-${label}`), 'first'); world = command(world, 'second');
    world = ticks(boundary(world, MONTH - 1)); const bad = cloneJson(world); corrupt(bad);
    expect(inspectUnregisteredWorldV9Records(bad).length).toBeGreaterThan(0);
  });
  it('rejects missing and fake birthday rows even when revision totals are adjusted with them', () => {
    const world = ticks(boundary(birthday(createUnregisteredWorldV9('clock-missing-birthday'), ['entity:1'], 7), 6));
    const missing = cloneJson(world); missing.cultivationClock.transitions = []; missing.cultivation.revision = 0;
    expect(inspectUnregisteredWorldV9Records(missing).length).toBeGreaterThan(0);
    const fake = cloneJson(world); fake.cultivationClock.transitions[0]!.tick = 6;
    expect(inspectUnregisteredWorldV9Records(fake).length).toBeGreaterThan(0);
  });
  it('binds emitted expiry events to the exact birthday transition and action', () => {
    const world = ticks(boundary(birthday(createUnregisteredWorldV9('clock-event'), ['entity:1'], 7, true), 6));
    const badTick = cloneJson(world); badTick.events = badTick.events.map(event => event.kind === 'cultivation.expiryPending' ? { ...event, tick: 6 } : event);
    expect(inspectUnregisteredWorldV9Records(badTick).length).toBeGreaterThan(0);
    const badRoot = cloneJson(world); badRoot.cultivationClock.transitions[0]!.rootActionId = `action:${badRoot.sequences.nextAction++}`;
    expect(inspectUnregisteredWorldV9Records(badRoot).length).toBeGreaterThan(0);
  });
  it('rejects clock row reordering independently of alleged revisions', () => {
    let world = ticks(boundary(createUnregisteredWorldV9('clock-order'), MONTH - 1));
    world = ticks(boundary(world, MONTH * 2 - 1)); const bad = cloneJson(world); bad.cultivationClock.transitions.reverse();
    expect(inspectUnregisteredWorldV9Records(bad).length).toBeGreaterThan(0);
  });
});

/** Explicit bounded history-pressure fixture: every early death/archive comes from
 * real reducers; only event-free all-deceased month rows are expanded arithmetically.
 * This is not a claim to simulate 9.8 million World ticks or 682 years of gameplay. */
function terminalClockPressure(rows: number): WorldStateV9 {
  let world = createUnregisteredWorldV9('clock-capacity');
  world = birthday(world, world.disciples.map(actor => actor.id), MONTH, true);
  world = ticks(boundary(world, MONTH - 1));
  for (const id of world.disciples.map(actor => actor.id)) world = finalize(world, id);
  const next = cloneJson(world);
  for (let month = 2; month <= rows; month++) {
    next.cultivationClock.transitions.push({ kind: 'month', tick: month * MONTH, beforeRevision: next.cultivation.revision++, rootActionId: `action:${next.sequences.nextAction++}` });
  }
  next.cultivation.calendarMonth = rows; next.clock.simulationTick = (rows + 1) * MONTH - 1; next.clock.calendarTick = next.clock.simulationTick;
  return valid(next);
}
describe('clock record last-slot atomicity', () => {
  it('consumes the final row once, stops before the next month, preserves JSON/retry and keeps immediate cancellation possible', () => {
    const source = terminalClockPressure(V9_CULTIVATION_CLOCK_LIMIT - 1);
    const placed = dispatchUnregisteredCommandV9(source, { kind: 'sect.command', commandId: 'capacity.blueprint', issuedTick: source.clock.simulationTick, sequence: 0,
      payload: { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'capacity.blueprint', expectedRevision: 0,
        placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } } });
    expect(placed.result.status).toBe('accepted');
    const full = ticks(placed.world); expect(full.cultivationClock.transitions).toHaveLength(V9_CULTIVATION_CLOCK_LIMIT);
    const last = boundary(full, (V9_CULTIVATION_CLOCK_LIMIT + 1) * MONTH - 1); const text = canonicalStringify(last);
    const stopped = advanceUnregisteredTicksV9(last, 1); expect(stopped.stopped?.kind).toBe('record-capacity'); expect(stopped.world).toBe(last);
    expect(canonicalStringify(last)).toBe(text); expect(advanceUnregisteredTicksV9(cloneJson(last), 1).world).toEqual(last);
    const cancelled = dispatchUnregisteredCommandV9(last, { kind: 'sect.command', commandId: 'capacity.cancel', issuedTick: last.clock.simulationTick, sequence: 0,
      payload: { domain: 'construction', command: { kind: 'construction.cancel', commandId: 'capacity.cancel', expectedRevision: last.sectExpansion.construction.revision,
        blueprintId: last.sectExpansion.construction.blueprints[0]!.blueprintId } } });
    expect(cancelled.result.status).toBe('accepted'); expect(cancelled.world.cultivationClock.transitions).toEqual(last.cultivationClock.transitions);
  });
  it('reserves before invoking a transition reducer and never mutates the source on exhaustion', () => {
    const source = terminalClockPressure(V9_CULTIVATION_CLOCK_LIMIT); const candidate = { ...source, clock: { ...source.clock,
      simulationTick: source.clock.simulationTick + 1, calendarTick: source.clock.calendarTick + 1 } };
    const before = canonicalStringify(candidate); expect(() => advanceV9CultivationClock(candidate)).toThrow('Cultivation clock record capacity exhausted');
    expect(canonicalStringify(candidate)).toBe(before); expect(() => inspectV9CultivationClockRecords(source)).not.toThrow();
  });
});


describe('accepted no-op receipts still require their historical living source', () => {
  function withForgedAcceptedNoop(world: WorldStateV9, command: CultivationCommand, relatedId: string | null): WorldStateV9 {
    const next = cloneJson(world); const result = { commandId: command.commandId, kind: command.kind, relatedId, outcome: 'accepted' as const };
    next.cultivation.receipts.push({ commandId: command.commandId, fingerprint: canonicalStringify(command), result });
    next.cultivation.revision++; next.sequences.nextAction++;
    return recordWorldReceipt(next, { commandId: command.commandId,
      fingerprint: canonicalStringify({ kind: 'cultivation.command', payload: { command } }),
      result: { commandId: command.commandId, status: 'accepted', transactionId: null, rejection: null, eventIds: [], cultivationResult: result } });
  }
  for (const kind of ['training.set', 'legacy.setHeir', 'talent.grant'] as const) it(`rejects a canonical forged ${kind} no-op after genuine death and archive`, () => {
    let world = birthday(createUnregisteredWorldV9(`clock-dead-${kind}`), ['entity:1'], 1, true);
    const grant = applyCultivationCommandV3(world, { kind: 'talent.grant', commandId: 'living.grant', expectedRevision: 0,
      discipleId: 'entity:1', talentId: 'cultivation.resilient-body' });
    expect(grant.ok).toBe(true); if (!grant.ok) throw new Error('grant failed'); world = valid(composeV9CultivationFrame(world, grant.frame));
    world = finalize(ticks(world), 'entity:1'); const sourceId = world.cultivation.archivedDisciples[0]!.talents[0]!.sourceInstanceId;
    const common = { commandId: `forged.${kind}`, expectedRevision: world.cultivation.revision, discipleId: 'entity:1' };
    const forgedCommand: CultivationCommand = kind === 'training.set' ? { ...common, kind, mode: 'duty' }
      : kind === 'legacy.setHeir' ? { ...common, kind, heirId: null } : { ...common, kind, talentId: 'cultivation.resilient-body' };
    const forged = withForgedAcceptedNoop(world, forgedCommand, kind === 'talent.grant' ? sourceId : null);
    expect(inspectUnregisteredWorldV9Records(forged)).toContain('Invalid legacy combat controller');
    expect(() => inspectV9CultivationClockRecords(forged)).toThrow('Invalid v9 cultivation clock: command source requires a living disciple');
    expect(inspectUnregisteredWorldV9Records(world)).toEqual([]);
  });
  it('also rejects the eventless no-op during the genuine pending-death interval', () => {
    const pending = ticks(birthday(createUnregisteredWorldV9('clock-pending-noop'), ['entity:1'], 1, true));
    const forged = withForgedAcceptedNoop(pending, { kind: 'training.set', commandId: 'forged.pending', expectedRevision: pending.cultivation.revision,
      discipleId: 'entity:1', mode: 'duty' }, null);
    expect(inspectUnregisteredWorldV9Records(forged)).toContain('Invalid legacy combat controller');
    expect(() => inspectV9CultivationClockRecords(forged)).toThrow('Invalid v9 cultivation clock: command source requires a living disciple');
  });
});


describe('decision-pause closing chronology', () => {
  it('requires lifespan finalization at its exact paused boundary and permits the next real tick afterward', () => {
    const pending = ticks(birthday(createUnregisteredWorldV9('clock-close-pause'), ['entity:1'], 1, true));
    const archived = finalize(pending, 'entity:1'); expect(archived.clock.simulationTick).toBe(1);
    expect(ticks(archived, 1).clock.simulationTick).toBe(2);
    const forged = cloneJson(archived); forged.clock = { ...forged.clock, simulationTick: 2, calendarTick: 2 };
    forged.events = forged.events.map(event => event.kind === 'cultivation.died' ? { ...event, tick: 2 } : event);
    expect(inspectUnregisteredWorldV9Records(forged)).toContain('Invalid legacy combat controller');
    expect(() => inspectV9CultivationClockRecords(forged)).toThrow('Invalid v9 cultivation clock: death decision closed after its paused boundary');
  });
});
