import { emptyNavigation } from '../../src/core/agents/navigation';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { advanceTicks, advanceTicksWithStatus, canonicalStringify, cloneJson, createSaveEnvelope, createWorld, dispatchCommand, enqueueCommands,
  parseSave, SaveCapacityAdmissionError, serializeSave, stableHash, validateWorldState, type Command, type DomainEvent, type WorldState } from '../../src/core/kernel';
import { appendHistoryBatch, createHistoryArchive, getHistoryArchiveUsage, MAX_HISTORY_EXPANDED_CHARACTERS } from '../../src/core/history';
import { assessAutomaticWorkBudget, canonicalUtf8ByteLength, measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import { canonicalByteDelta, worldSaveByteDelta } from '../../src/core/world/save-byte-delta';
import { worldAutomaticBudgetInput } from '../../src/core/world/automatic-work-bridge';
import { startAutomaticProduction } from '../../src/core/economy/automatic-production';

function pressure(world: WorldState, bytes: number): WorldState {
  const candidate = { ...world, diagnostics: [{ code: 'INVARIANT_FAILURE' as const, tick: world.clock.simulationTick, message: '' }] };
  const missing = bytes - measureWorldSaveBytes(candidate, { saveVersion: 7 });
  if (missing < 0) throw new Error('Too small fixture target');
  candidate.diagnostics[0]!.message = 'x'.repeat(missing);
  expect(measureWorldSaveBytes(candidate, { saveVersion: 7 })).toBe(bytes);
  return candidate;
}
const startCommand = (world: WorldState, commandId: string): Command => ({ commandId, kind: 'production.start',
  payload: { recipeId: 'craft.plank', workerId: world.disciples[1]!.id }, sequence: 1, issuedTick: world.clock.simulationTick });
function autoWorld() {
  let world = createWorld('capacity-auto');
  for (const command of [{ kind: 'plan.set', plan: { workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'craft.plank', targetStock: 99 }] } },
    { kind: 'enabled.set', enabled: true }] as const) world = dispatchCommand(world, { commandId: command.kind, kind: 'sect-economy.command',
      sequence: 1, issuedTick: 0, payload: { command } }).world;
  const admitted = startAutomaticProduction(world, { workerId: 'entity:2', recipeId: 'craft.plank' });
  if (!admitted.ok) throw new Error(admitted.reason);
  return admitted;
}

describe('exact per-boundary capacity accounting', () => {
  it('matches full canonical bytes across arrays, escaped keys, missing keys, numeric widths and Unicode', () => {
    const cases: [unknown, unknown][] = [
      [{ a: 1 }, { b: '"\\\n\t\u0000' }], [[], [0]], [[1, 22, 333], [22, 333]],
      [{ nested: { a: 9 }, '\n': '汉字🙂' }, { nested: { a: 10 }, '\\': '\ud800' }],
      [{ optional: null, same: ['hello'] }, { optional: [], same: ['hello'], added: { x: 99999 } }],
      [9, 10], [-0, 0], [{ n: 1e20 }, { n: 1e21 }],
    ];
    for (const [left, right] of cases) expect(canonicalByteDelta(left, right)).toBe(canonicalUtf8ByteLength(right) - canonicalUtf8ByteLength(left));
    const shared = Object.freeze({ text: '\u0000汉字', list: Object.freeze([1, 2]) });
    expect(canonicalByteDelta({ shared, a: 1 }, { shared, a: 100 })).toBe(2);
    let invoked = false;
    const getter = { get value() { invoked = true; return 1; } };
    expect(() => canonicalByteDelta({ value: 0 }, getter)).toThrow(); expect(invoked).toBe(false);
  });

  it('matches real movement, work, archive rollover and differing envelope metadata exactly', () => {
    let world = createWorld('delta-real');
    const oldOptions = { saveVersion: 7, metadata: { buildId: '旧', savedAt: '1' } };
    const newOptions = { saveVersion: 10, metadata: { buildId: '\u0000new', savedAt: 'longer' } };
    const first = dispatchCommand(world, startCommand(world, 'delta.start')).world;
    expect(worldSaveByteDelta(world, first, oldOptions, newOptions)).toBe(measureWorldSaveBytes(first, newOptions) - measureWorldSaveBytes(world, oldOptions));
    world = first;
    for (let step = 0; step < 280; step++) {
      const next = advanceTicks(world, 1);
      expect(worldSaveByteDelta(world, next, { saveVersion: 7 })).toBe(measureWorldSaveBytes(next, { saveVersion: 7 }) - measureWorldSaveBytes(world, { saveVersion: 7 }));
      world = next;
    }
    expect(world.history.production.count).toBe(1); expect(validateWorldState(world)).toEqual([]);
  });

  it('refuses growing commands and queues atomically, preserving exact prior receipts before budget checks', () => {
    const initial = createWorld(); const rejected = dispatchCommand(initial, { ...startCommand(initial, 'old.rejected'), payload: { recipeId: 'missing', workerId: 'entity:2' } });
    const world = pressure(rejected.world, 3_300_000); const bytes = canonicalStringify(world);
    const command = startCommand(world, 'new.work'); const blocked = dispatchCommand(world, command);
    expect(blocked.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED'); expect(blocked.world).toBe(world);
    expect(() => enqueueCommands(world, [{ ...command, issuedTick: 10 }])).toThrow(SaveCapacityAdmissionError);
    expect(canonicalStringify(world)).toBe(bytes);
    const replay = dispatchCommand(world, { ...startCommand(world, 'old.rejected'), payload: { recipeId: 'missing', workerId: 'entity:2' }, issuedTick: 999 });
    expect(replay.world).toBe(world); expect(replay.result).toEqual(rejected.result);
  });

  it('allows a previously reserved cancellation despite later headroom deficit', () => {
    const admitted = autoWorld(); const world = pressure(admitted.world, 3_300_000);
    const cancelled = dispatchCommand(world, { commandId: 'release', kind: 'production.cancel', sequence: 2, issuedTick: 0,
      payload: { transactionId: admitted.transactionId } });
    expect(cancelled.result.status).toBe('accepted'); expect(cancelled.world.inventory.wood.reserved).toBe(0);
    expect(cancelled.world.automaticProduction.pins[admitted.transactionId]!.retention).toBe('exact-receipt');
    expect(validateWorldState(cancelled.world)).toEqual([]);
  });

  it('preserves queued retry and all pre-tick ownership on a transient candidate refusal', () => {
    const initial = createWorld(); const command = startCommand(initial, 'queued.start');
    const queued = enqueueCommands(initial, [command]); const world = pressure(queued, 3_300_000);
    const result = advanceTicksWithStatus(world, 1);
    expect(result.capacityStop).toBe('SAVE_CAPACITY_EXCEEDED'); expect(result.world.clock.simulationTick).toBe(0);
    expect(result.world.pendingCommands).toEqual([command]); expect(result.world.commandReceipts).toEqual(world.commandReceipts);
    expect(result.world.inventory).toEqual(world.inventory); expect(result.world.sequences).toEqual(world.sequences);
    expect(result.world.clock.pauseReasons).toContain('save-capacity');
  });

  it('returns an ephemeral stop without adding even a pause to an exact-cap imported boundary', () => {
    const initial = createWorld(); initial.clock.simulationTick = 9; initial.clock.calendarTick = 9;
    const world = pressure(initial, SAVE_FILE_LIMIT_BYTES);
    expect(validateWorldState(world)).toEqual([]);
    const result = advanceTicksWithStatus(world, 1);
    expect(result.capacityStop).toBe('SAVE_CAPACITY_EXCEEDED'); expect(result.world).toBe(world);
    expect(result.world.clock.pauseReasons).toEqual([]); expect(result.world.clock.simulationTick).toBe(9);
    // This mutable caller is measured anew on the next invocation, not cached by identity.
    world.diagnostics[0]!.message = '';
    expect(advanceTicksWithStatus(world, 1).world.clock.simulationTick).toBe(10);
  });

  it('gates a small wire archive at the real decoded-character ceiling without discarding historical events', () => {
    // Validator-approved hostile history stress, not a causally played economy.
    const world = createWorld('expanded-capacity'); const events: DomainEvent[] = [];
    const repeated = 'x'.repeat(8192); let expanded = 0;
    const target = MAX_HISTORY_EXPANDED_CHARACTERS - 1;
    while (true) {
      const event: DomainEvent = { eventId: `event:${events.length + 1}`, kind: 'production.blocked', rootActionId: 'action:1', parentEventId: null,
        tick: 0, payload: { transactionId: 'instance:999999', reason: repeated } };
      const size = canonicalStringify(event).length;
      if (expanded + size > target) break;
      events.push(event); expanded += size;
    }
    const finalEvent: DomainEvent = { eventId: `event:${events.length + 1}`, kind: 'production.blocked', rootActionId: 'action:1', parentEventId: null,
      tick: 0, payload: { transactionId: 'instance:999999', reason: '' } };
    const padding = target - expanded - canonicalStringify(finalEvent).length;
    if (padding >= 0) { const filled = { ...finalEvent, payload: { ...finalEvent.payload, reason: 'y'.repeat(padding) } }; events.push(filled); expanded += canonicalStringify(filled).length; }
    world.history = appendHistoryBatch(createHistoryArchive(), { events }); world.sequences.nextEvent = events.length + 1; world.sequences.nextAction = 2;
    expect(getHistoryArchiveUsage(world.history).expandedCharacters).toBe(expanded);
    expect(validateWorldState(world)).toEqual([]);
    const budget = assessAutomaticWorkBudget(worldAutomaticBudgetInput(world, 2));
    expect(budget.actualFits).toBe(true); expect(budget.archiveSlotsFit).toBe(true);
    expect(budget.archiveExpansion.automaticAllowance).toBe(0); expect(budget.autoStartAllowance).toBe(0);
    const rejected = dispatchCommand(world, startCommand(world, 'near.decoded.cap'));
    expect(rejected.result.rejection?.code).toBe('SAVE_CAPACITY_EXCEEDED'); expect(rejected.world).toBe(world);
    expect(world.history.events.count).toBe(events.length);
  });
  it('reports invariant overflow without making an exact-cap valid boundary unsaveable', () => {
    const admitted = autoWorld(); const candidate = cloneJson(admitted.world);
    const job = candidate.automaticProduction.live[admitted.transactionId]!.transaction;
    const storage = candidate.buildings.find((building) => building.blueprintId === 'storage')!;
    job.activeTicks = job.requiredTicks; job.phase = 'AwaitingDelivery'; job.storageId = storage.id; job.navigation = emptyNavigation();
    candidate.disciples[1]!.position = { x: storage.x, y: storage.y };
    candidate.sequences.nextEvent = Number.MAX_SAFE_INTEGER;
    const world = pressure(candidate, SAVE_FILE_LIMIT_BYTES);
    expect(validateWorldState(world)).toEqual([]);
    const result = advanceTicksWithStatus(world, 1);
    expect(result.world).toBe(world); expect(result.capacityStop).toBeNull();
    expect(result.invariantStop).toMatchObject({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick });
    const text = serializeSave(createSaveEnvelope(result.world, { buildId: 'test', savedAt: 'now' }));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(SAVE_FILE_LIMIT_BYTES); expect(parseSave(text).ok).toBe(true);
  });

  it.each([null, 'preserved', { source: 'old audit' }])('preserves valid v6 inventory extension %j through mutating commands', (extension) => {
    const source = JSON.parse(readFileSync(new URL('./fixtures/save-v6-before-automatic-work.json', import.meta.url), 'utf8'));
    source.payload.inventory.legacyAudit = extension;
    const { checksum: _checksum, ...body } = source;
    const parsed = parseSave(canonicalStringify({ ...body, checksum: stableHash(body) }));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const result = dispatchCommand(parsed.world, { commandId: 'extension.discard', sequence: 1, issuedTick: parsed.world.clock.simulationTick,
      kind: 'inventory.discard', payload: { resourceId: 'wood', quantity: 1 } });
    expect(result.result.status).toBe('accepted'); expect((result.world.inventory as unknown as Record<string, unknown>).legacyAudit).toEqual(extension);
    expect(validateWorldState(result.world)).toEqual([]);
  });

});
