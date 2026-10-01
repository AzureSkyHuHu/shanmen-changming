import { describe, expect, it } from 'vitest';
import {
  advanceTicks, allocateId, accumulateFrame, availableResource, CALENDAR_TICKS_PER_MONTH,
  canonicalStringify, cancelProduction, completeProduction, createFrameAccumulator, createRandomStreams,
  createSaveEnvelope, createSequences, createWorld, dispatchCommand, domainHash, drawInteger, enqueueCommands,
  mapNonZeroWordToBucket, MAX_DISCIPLES, multiplyDivideFloor, nextUint32, parseSave, RANDOM_ALGORITHM,
  RANDOM_WORD_DOMAIN_SIZE, serializeSave, SIMULATION_VERSION,
  setClockMode, setClockSpeed, setPauseReason, stableHash, STARTER_RECIPES, validateWorldState,
  type Command, type RandomStream, type WorldState,
} from '../../src/core/kernel';

const metadata = { buildId: 'test', savedAt: '2026-10-01T00:00:00.000Z' };
function start(world: WorldState, commandId = 'test.start', recipeId = 'craft.plank', workerIndex = 1, sequence = 1): Command {
  return { commandId, sequence, issuedTick: world.clock.simulationTick, kind: 'production.start', payload: { recipeId, workerId: world.disciples[workerIndex]!.id } };
}
function roundtrip(world: WorldState): WorldState {
  const loaded = parseSave(serializeSave(createSaveEnvelope(world, metadata)));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.world;
}
function withProduction(seed = 'test-world'): WorldState {
  const world = createWorld(seed);
  return dispatchCommand(world, start(world)).world;
}

describe('deterministic primitives', () => {
  it('locks the v2 nonzero generator to its golden uint32 recurrence vector', () => {
    let stream: RandomStream = { algorithm: RANDOM_ALGORITHM, state: 1, draws: 0 };
    const values: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const next = nextUint32(stream); stream = next.stream; values.push(next.value);
    }
    expect(values).toEqual([270369, 67634689, 2647435461, 307599695, 2398689233]);
    expect(stream.draws).toBe(5);
  });
  it('keeps serialized streams independent', () => {
    const original = createRandomStreams('same-seed');
    const other = drawInteger(original, 'offers', 1, 100).streams;
    expect(original.offers.draws).toBe(0);
    expect(drawInteger(other, 'economy', 0, 999).value).toBe(drawInteger(original, 'economy', 0, 999).value);
    expect(drawInteger(JSON.parse(JSON.stringify(other)), 'offers', 1, 100)).toEqual(drawInteger(other, 'offers', 1, 100));
  });
  it('retains ID sequence continuity and floors integer ratios', () => {
    const first = allocateId(createSequences(), 'entity');
    expect(first.id).toBe('entity:1');
    expect(allocateId(JSON.parse(JSON.stringify(first.sequences)), 'entity').id).toBe('entity:2');
    expect(multiplyDivideFloor(5, 3, 2)).toBe(7);
    expect(() => multiplyDivideFloor(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow();
  });
  it('hashes canonical keys independently of insertion order and rejects non-JSON', () => {
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
    expect(() => canonicalStringify({ value: Infinity })).toThrow();
    expect(() => canonicalStringify({ value: undefined })).toThrow();
  });
  it('maps every reduced-width nonzero domain to equal-sized buckets without modulo bias', () => {
    for (const domainSize of [3, 7, 15, 31]) {
      for (let span = 1; span <= domainSize; span += 1) {
        const counts = Array.from({ length: span }, () => 0);
        let rejected = 0;
        for (let word = 1; word <= domainSize; word += 1) {
          const bucket = mapNonZeroWordToBucket(word, span, domainSize);
          if (bucket === null) rejected += 1;
          else counts[bucket] = counts[bucket]! + 1;
        }
        expect(counts).toEqual(Array.from({ length: span }, () => Math.floor(domainSize / span)));
        expect(rejected).toBe(domainSize % span);
      }
    }
  });
  it('reaches both supported range endpoints and rejects a 2^32-value range', () => {
    // Reverse xorshift's three reversible xor/shift stages to obtain endpoint fixtures.
    function stateBeforeWord(word: number): number {
      let beforeLastShift = word;
      for (let shift = 5; shift < 32; shift += 5) beforeLastShift ^= word << shift;
      const beforeRightShift = beforeLastShift ^ (beforeLastShift >>> 17);
      return (beforeRightShift ^ (beforeRightShift << 13) ^ (beforeRightShift << 26)) >>> 0;
    }
    const streams = createRandomStreams('domain-endpoints');
    const low = { ...streams, economy: { ...streams.economy, state: stateBeforeWord(1) } };
    const high = { ...streams, economy: { ...streams.economy, state: stateBeforeWord(0xffffffff) } };
    expect(nextUint32(low.economy).value).toBe(1);
    expect(nextUint32(high.economy).value).toBe(0xffffffff);
    expect(drawInteger(low, 'economy', 0, RANDOM_WORD_DOMAIN_SIZE - 1).value).toBe(0);
    expect(drawInteger(high, 'economy', 0, RANDOM_WORD_DOMAIN_SIZE - 1).value).toBe(RANDOM_WORD_DOMAIN_SIZE - 1);
    expect(() => drawInteger(streams, 'economy', 0, 0xffffffff)).toThrow(RangeError);
    expect(() => mapNonZeroWordToBucket(0, 2)).toThrow(RangeError);
    expect(() => mapNonZeroWordToBucket(1, 0x100000000)).toThrow(RangeError);
    expect(streams.economy.draws).toBe(0);
  });
});

describe('seeded starter world', () => {
  it('creates the same four mixed-age disciples and map for a seed', () => {
    const first = createWorld('map-test');
    expect(first).toEqual(createWorld('map-test'));
    expect(first.map).not.toEqual(createWorld('another-map').map);
    expect(first.disciples).toHaveLength(4);
    expect(first.disciples.filter((disciple) => disciple.canWork).length).toBeGreaterThanOrEqual(2);
    expect(new Set(first.disciples.map((disciple) => disciple.ageMonths)).size).toBe(4);
    expect(validateWorldState(first)).toEqual([]);
  });
  it('places housing, food, wood, ore and the first route on traversable tiles', () => {
    const world = createWorld('reachable');
    for (const building of world.buildings) {
      expect(world.map.tiles.find((tile) => tile.x === building.x && tile.y === building.y)?.walkable).toBe(true);
    }
    expect(world.buildings.map((building) => building.blueprintId)).toEqual(expect.arrayContaining(['housing', 'kitchen', 'forest', 'mine', 'spirit-vein']));
    expect(world.unlocks).toContain('route.first-breakthrough');
  });
  it('rejects snapshots above the full-entity cap', () => {
    const world = createWorld('cap');
    world.disciples = Array.from({ length: MAX_DISCIPLES + 1 }, (_, index) => ({ ...world.disciples[0]!, id: `entity:${index + 100}` }));
    expect(validateWorldState(world)).not.toEqual([]);
  });
});

describe('fixed ticks, frame accumulation and pause ownership', () => {
  function throughFrames(speed: 1 | 3, framePattern: number[]): WorldState {
    let world = withProduction('frames');
    world = { ...world, clock: setClockSpeed(world.clock, speed) };
    let accumulator = createFrameAccumulator();
    let frame = 0;
    while (world.clock.simulationTick < 400) {
      const result = accumulateFrame(accumulator, framePattern[frame % framePattern.length]!, world.clock, 17);
      accumulator = result.accumulator;
      world = advanceTicks(world, Math.min(result.ticks, 400 - world.clock.simulationTick));
      frame += 1;
    }
    return world;
  }
  it('arrives at the same domain hash at 1x, 3x and jittered frames', () => {
    const baseline = domainHash(advanceTicks(withProduction('frames'), 400));
    expect(domainHash(throughFrames(1, [50]))).toBe(baseline);
    expect(domainHash(throughFrames(3, [16, 100, 34, 150]))).toBe(baseline);
    expect(domainHash(throughFrames(1, [100]))).toBe(baseline);
  });
  it('keeps other pause owners and discards wall time while paused', () => {
    let world = withProduction('paused');
    world = { ...world, clock: setPauseReason(setPauseReason(world.clock, 'player', true), 'hidden', true) };
    world = { ...world, clock: setPauseReason(world.clock, 'player', false) };
    expect(world.clock.pauseReasons).toEqual(['hidden']);
    expect(advanceTicks(world, 100)).toBe(world);
    expect(accumulateFrame(createFrameAccumulator(), 50000, world.clock).ticks).toBe(0);
    world = { ...world, clock: setPauseReason(world.clock, 'hidden', false) };
    expect(domainHash(advanceTicks(world, 400))).toBe(domainHash(advanceTicks(withProduction('paused'), 400)));
  });
  it('retains catch-up backlog rather than dropping simulation ticks', () => {
    const clock = createWorld().clock;
    const first = accumulateFrame(createFrameAccumulator(), 1000, clock, 3);
    expect(first.ticks).toBe(3);
    expect(first.accumulator.remainderMicroseconds).toBe(850000);
    expect(accumulateFrame(first.accumulator, 0, clock, 100).ticks).toBe(17);
  });
  it('keeps combat time separate from calendar age and production work', () => {
    const initial = withProduction('combat');
    const result = advanceTicks({ ...initial, clock: setClockMode(initial.clock, 'combat') }, CALENDAR_TICKS_PER_MONTH);
    expect(result.clock.calendarTick).toBe(0);
    expect(result.clock.encounterTick).toBe(CALENDAR_TICKS_PER_MONTH);
    expect(result.disciples[0]!.ageMonths).toBe(initial.disciples[0]!.ageMonths);
    expect(Object.values(result.transactions)[0]!.activeTicks).toBe(0);
  });
});

describe('command idempotency and atomic resource accounting', () => {
  it('returns the original result for duplicate IDs without duplicate reservations or events', () => {
    const original = createWorld('double-click');
    const command = start(original);
    const first = dispatchCommand(original, command);
    const second = dispatchCommand(first.world, command);
    expect(second.world).toBe(first.world);
    expect(second.result).toEqual(first.result);
    expect(first.world.inventory.wood.owned).toBe(original.inventory.wood.owned);
    expect(first.world.inventory.wood.reserved).toBe(3);
    expect(Object.values(first.world.transactions)).toHaveLength(1);
    expect(first.world.events).toHaveLength(1);
    expect(original.inventory.wood.reserved).toBe(0);
  });
  it('detaches returned accepted results and duplicate responses from stored receipts', () => {
    const original = createWorld('receipt-alias');
    const command = start(original);
    const first = dispatchCommand(original, command);
    const stored = JSON.parse(JSON.stringify(first.world.commandReceipts[command.commandId]!.result));
    first.result.eventIds.push('event:999999');
    first.result.transactionId = 'instance:999999';
    expect(first.world.commandReceipts[command.commandId]!.result).toEqual(stored);
    const retry = dispatchCommand(first.world, command);
    expect(retry.result).toEqual(stored);
    retry.result.eventIds.length = 0;
    retry.result.status = 'rejected';
    expect(dispatchCommand(retry.world, command).result).toEqual(stored);
    expect(roundtrip(retry.world)).toEqual(first.world);
  });
  it('detaches nested rejection results from stored receipts on initial and duplicate replies', () => {
    const world = createWorld('rejection-alias');
    const command = start(world, 'bad-worker', 'craft.plank', 0);
    const first = dispatchCommand(world, command);
    expect(first.result.rejection?.code).toBe('WORKER_UNAVAILABLE');
    first.result.rejection!.code = 'COMMAND_CONFLICT';
    first.result.eventIds.push('event:123');
    const retry = dispatchCommand(first.world, command);
    expect(retry.result.rejection?.code).toBe('WORKER_UNAVAILABLE');
    expect(retry.result.eventIds).toEqual([]);
    retry.result.rejection!.code = 'INVALID_COMMAND';
    expect(dispatchCommand(retry.world, command).result.rejection?.code).toBe('WORKER_UNAVAILABLE');
    expect(roundtrip(retry.world)).toEqual(first.world);
  });
  it('rejects the same ID with different payload, including after save/reload', () => {
    const original = createWorld('conflict');
    const first = dispatchCommand(original, start(original));
    const changed = start(original, 'test.start', 'gather.wood');
    const result = dispatchCommand(roundtrip(first.world), changed);
    expect(result.result.rejection?.code).toBe('COMMAND_CONFLICT');
    expect(result.world).toEqual(first.world);
  });
  it('does not consume resources, sequences or RNG on insufficient inventory', () => {
    const original = createWorld('poor');
    const world = { ...original, inventory: { ...original.inventory, wood: { ...original.inventory.wood, owned: 2 } } };
    const result = dispatchCommand(world, start(world));
    expect(result.result.rejection?.code).toBe('INSUFFICIENT_INVENTORY');
    expect(result.world.inventory).toEqual(world.inventory);
    expect(result.world.randomStreams).toEqual(world.randomStreams);
    expect(result.world.sequences).toEqual(world.sequences);
    expect(result.world.events).toEqual([]);
  });
  it('uses stable command ordering when two workers compete for the same materials', () => {
    const initial = createWorld('competition');
    const world = { ...initial, inventory: { ...initial.inventory, wood: { ...initial.inventory.wood, owned: 3 } } };
    const first = start(world, 'order.one', 'craft.plank', 1, 1);
    const second = start(world, 'order.two', 'craft.plank', 2, 2);
    const forward = advanceTicks(world, 1, [first, second]);
    const reversed = advanceTicks(world, 1, [second, first]);
    expect(forward).toEqual(reversed);
    expect(forward.commandReceipts['order.one']!.result.status).toBe('accepted');
    expect(forward.commandReceipts['order.two']!.result.rejection?.code).toBe('INSUFFICIENT_INVENTORY');
    expect(availableResource(forward.inventory.wood)).toBe(0);
  });
  it('releases only reserved inputs and never duplicates output when cancelled twice', () => {
    const initial = createWorld('cancel');
    const started = dispatchCommand(initial, start(initial));
    const partial = advanceTicks(started.world, 40);
    const cancelled = cancelProduction(partial, started.result.transactionId!);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.world.inventory).toEqual(initial.inventory);
    const reloaded = roundtrip(cancelled.world);
    const again = cancelProduction(reloaded, started.result.transactionId!);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.world).toBe(reloaded);
    expect(advanceTicks(again.world, 400).inventory).toEqual(initial.inventory);
  });
  it('commits one debit and one credit and rejects cancellation after completion', () => {
    const initial = createWorld('commit');
    const started = dispatchCommand(initial, start(initial));
    const complete = advanceTicks(started.world, STARTER_RECIPES['craft.plank']!.workTicks + 100);
    expect(complete.inventory.wood.owned).toBe(initial.inventory.wood.owned - 3);
    expect(complete.inventory.wood.reserved).toBe(0);
    expect(complete.inventory.plank.owned).toBe(2);
    const retry = completeProduction(complete, started.result.transactionId!);
    expect(retry.ok && retry.world === complete).toBe(true);
    const cancel = cancelProduction(complete, started.result.transactionId!);
    expect(cancel.ok).toBe(false);
    if (!cancel.ok) expect(cancel.rejection.code).toBe('TRANSACTION_FINISHED');
    expect(complete.events.filter((event) => event.kind === 'production.committed')).toHaveLength(1);
  });
  it('blocks on output capacity without consuming input or silently losing output', () => {
    const original = createWorld('full');
    const full = { ...original, inventory: { ...original.inventory, plank: { ...original.inventory.plank, capacity: 1 } } };
    const started = dispatchCommand(full, start(full));
    const blocked = advanceTicks(started.world, 200);
    expect(blocked.transactions[started.result.transactionId!]!.state).toBe('Blocked');
    expect(blocked.inventory.wood.owned).toBe(original.inventory.wood.owned);
    expect(blocked.inventory.wood.reserved).toBe(3);
    expect(blocked.inventory.plank.owned).toBe(0);
    expect(blocked.events.filter((event) => event.kind === 'production.blocked')).toHaveLength(1);
    expect(roundtrip(blocked)).toEqual(blocked);
  });
  it('retains future queued commands and only executes them on their issued boundary', () => {
    const initial = createWorld('future');
    const future = { ...start(initial), issuedTick: 5 };
    const partial = advanceTicks(initial, 3, [future]);
    expect(partial.pendingCommands).toHaveLength(1);
    expect(partial.events).toHaveLength(0);
    expect(advanceTicks(roundtrip(partial), 3)).toEqual(advanceTicks(initial, 6, [future]));
  });
  it('takes a detached immutable snapshot of caller-owned queued commands and payloads', () => {
    const initial = createWorld('caller-mutation');
    const future = start(initial, 'queued.original');
    if (future.kind !== 'production.start') throw new Error('Expected a production start');
    future.issuedTick = 5;
    const expected = JSON.parse(JSON.stringify(future)) as Command;
    const queued = enqueueCommands(initial, [future]);
    expect(queued.pendingCommands[0]).not.toBe(future);
    expect(queued.pendingCommands[0]!.payload).not.toBe(future.payload);
    expect(Object.isFrozen(queued.pendingCommands[0])).toBe(true);
    expect(Object.isFrozen(queued.pendingCommands[0]!.payload)).toBe(true);
    future.commandId = 'queued.changed';
    future.issuedTick = 0;
    future.sequence = 999;
    future.payload.recipeId = 'gather.herbs';
    future.payload.workerId = initial.disciples[2]!.id;
    expect(queued.pendingCommands).toEqual([expected]);
    expect(advanceTicks(queued, 6)).toEqual(advanceTicks(initial, 6, [expected]));
  });
});

describe('pure save envelopes', () => {
  it('restores mid-production to an exact final world and next ID/RNG state', () => {
    const initial = withProduction('save-resume');
    const halfway = advanceTicks(initial, 79);
    const resumed = advanceTicks(roundtrip(halfway), 321);
    const direct = advanceTicks(initial, 400);
    expect(resumed).toEqual(direct);
    expect(canonicalStringify(resumed)).toBe(canonicalStringify(direct));
    expect(allocateId(resumed.sequences, 'entity')).toEqual(allocateId(direct.sequences, 'entity'));
    expect(drawInteger(resumed.randomStreams, 'economy', 0, 100)).toEqual(drawInteger(direct.randomStreams, 'economy', 0, 100));
  });
  it('produces a detached snapshot and does not include locale/UI settings', () => {
    const world = withProduction('detached');
    const envelope = createSaveEnvelope(world, metadata);
    envelope.payload.inventory.wood.owned = 123;
    expect(world.inventory.wood.owned).toBe(24);
    expect(serializeSave(envelope)).not.toContain('locale');
  });
  it('detects damaged bytes, newer versions and malformed JSON', () => {
    const envelope = createSaveEnvelope(createWorld('bad-save'), metadata);
    const damaged = { ...envelope, seed: 'tampered' };
    expect(parseSave(JSON.stringify(damaged))).toMatchObject({ ok: false, error: { code: 'CHECKSUM_MISMATCH' } });
    expect(parseSave(JSON.stringify({ ...envelope, saveVersion: 999 }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SAVE_VERSION' } });
    expect(parseSave('{bad')).toMatchObject({ ok: false, error: { code: 'INVALID_JSON' } });
  });
  it('explicitly rejects the prior integer-mapping simulation version without rewriting its bytes', () => {
    const current = createSaveEnvelope(createWorld('prior-rng-version'), metadata);
    expect(SIMULATION_VERSION).toBe('0.2.0');
    expect(RANDOM_ALGORITHM).toBe('xorshift32-nonzero-v2');
    const { checksum: _checksum, ...currentBody } = current;
    const previousBody = {
      ...currentBody, simulationVersion: '0.1.0', payload: {
        ...current.payload, simulationVersion: '0.1.0',
        randomStreams: Object.fromEntries(Object.entries(current.payload.randomStreams).map(([name, stream]) => [name, { ...stream, algorithm: 'xorshift32-v1' }])),
      },
    };
    const previousBytes = JSON.stringify({ ...previousBody, checksum: stableHash(previousBody) });
    const preservedBytes = previousBytes;
    expect(parseSave(previousBytes)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SIMULATION_VERSION' } });
    expect(previousBytes).toBe(preservedBytes);
    expect(parseSave(serializeSave(current)).ok).toBe(true);
    const incompatibleBody = { ...previousBody, simulationVersion: SIMULATION_VERSION, payload: { ...previousBody.payload, simulationVersion: SIMULATION_VERSION } };
    expect(parseSave(JSON.stringify({ ...incompatibleBody, checksum: stableHash(incompatibleBody) }))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it.each(['missing', 'wrong-fingerprint', 'wrong-transaction'] as const)('rejects completed imports with a %s originating receipt', (problem) => {
    const initial = withProduction(`receipt-${problem}`);
    const transaction = Object.values(initial.transactions)[0]!;
    const complete = advanceTicks(initial, transaction.requiredTicks + 100);
    const envelope = createSaveEnvelope(complete, metadata);
    if (problem === 'missing') envelope.payload.commandReceipts = {};
    else if (problem === 'wrong-fingerprint') envelope.payload.commandReceipts[transaction.commandId]!.fingerprint = canonicalStringify({ kind: 'production.start', payload: { recipeId: 'gather.herbs', workerId: transaction.workerId } });
    else envelope.payload.commandReceipts[transaction.commandId]!.result.transactionId = 'instance:9999';
    const { checksum: _checksum, ...body } = envelope;
    expect(validateWorldState(envelope.payload)).toContain('Transaction is missing its matching originating command receipt');
    expect(parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it('rejects two transactions claiming the same originating command ID', () => {
    const world = createWorld('duplicate-command-ownership');
    const first = dispatchCommand(world, start(world, 'origin.first', 'craft.plank', 1));
    const second = dispatchCommand(first.world, start(first.world, 'origin.second', 'craft.plank', 2));
    const envelope = createSaveEnvelope(advanceTicks(second.world, 500), metadata);
    envelope.payload.transactions[second.result.transactionId!]!.commandId = 'origin.first';
    const { checksum: _checksum, ...body } = envelope;
    expect(validateWorldState(envelope.payload)).toContain('Duplicate transaction originating command ID');
    expect(parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it('rejects forged inconsistent reservations even with a recomputed checksum', () => {
    const envelope = createSaveEnvelope(withProduction('forged'), metadata);
    envelope.payload.inventory.wood.reserved = 0;
    const { checksum: _checksum, ...body } = envelope;
    expect(parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it('rejects duplicate reservations whose claimed transaction does not point back', () => {
    const envelope = createSaveEnvelope(withProduction('duplicate-reservation'), metadata);
    const transaction = Object.values(envelope.payload.transactions)[0]!;
    const original = envelope.payload.reservations[transaction.reservationId]!;
    const duplicateId = allocateId(envelope.payload.sequences, 'instance');
    envelope.payload.sequences = duplicateId.sequences;
    envelope.payload.reservations[duplicateId.id] = { ...original, reservationId: duplicateId.id };
    envelope.payload.inventory.wood.reserved += 3;
    const { checksum: _checksum, ...body } = envelope;
    expect(validateWorldState(envelope.payload)).toContain('Reservation ownership is not bidirectional');
    expect(parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    const cancelled = cancelProduction(envelope.payload, transaction.transactionId);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    // Even an invalid state passed directly to a reducer cannot then masquerade as a valid save.
    expect(validateWorldState(cancelled.world)).toContain('Reservation ownership is not bidirectional');
    expect(() => createSaveEnvelope(cancelled.world, metadata)).toThrow();
  });
  it.each(['Committed', 'Cancelled'] as const)('rejects a %s transaction with an active reservation', (terminalState) => {
    const initial = withProduction(`terminal-${terminalState}`);
    const transaction = Object.values(initial.transactions)[0]!;
    let terminal: WorldState;
    if (terminalState === 'Committed') terminal = advanceTicks(initial, transaction.requiredTicks + 100);
    else {
      const cancelled = cancelProduction(initial, transaction.transactionId);
      if (!cancelled.ok) throw new Error('Cancellation failed');
      terminal = cancelled.world;
    }
    const envelope = createSaveEnvelope(terminal, metadata);
    envelope.payload.reservations[transaction.reservationId]!.state = 'reserved';
    envelope.payload.inventory.wood.reserved += 3;
    const { checksum: _checksum, ...body } = envelope;
    expect(validateWorldState(envelope.payload)).not.toEqual([]);
    expect(parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it.each(['future-birth', 'inconsistent-age'] as const)('rejects a checksummed import with %s', (problem) => {
    const envelope = createSaveEnvelope(createWorld('bad-birth'), metadata);
    const disciple = envelope.payload.disciples[0]!;
    if (problem === 'future-birth') disciple.birthCalendarTick = envelope.payload.clock.calendarTick + 1;
    else disciple.ageMonths += 1;
    const { checksum: _checksum, ...body } = envelope;
    expect(validateWorldState(envelope.payload)).not.toEqual([]);
    expect(parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }))).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
  });
  it('keeps normal ages consistent through a calendar-month boundary and roundtrip', () => {
    const initial = createWorld('normal-age');
    const before = advanceTicks(initial, CALENDAR_TICKS_PER_MONTH - 1);
    expect(before.disciples.map((disciple) => disciple.ageMonths)).toEqual(initial.disciples.map((disciple) => disciple.ageMonths));
    expect(validateWorldState(before)).toEqual([]);
    const after = advanceTicks(roundtrip(before), 1);
    expect(after.disciples.map((disciple) => disciple.ageMonths)).toEqual(initial.disciples.map((disciple) => disciple.ageMonths + 1));
    expect(roundtrip(after)).toEqual(after);
  });
  it('updates an imported off-boundary birthday on its exact calendar tick', () => {
    const initial = createWorld('off-boundary-birth');
    const disciple = initial.disciples[0]!;
    disciple.birthCalendarTick += 17;
    disciple.ageMonths -= 1;
    const before = advanceTicks(roundtrip(initial), 16);
    expect(before.disciples[0]!.ageMonths).toBe(disciple.ageMonths);
    expect(validateWorldState(before)).toEqual([]);
    const birthday = advanceTicks(before, 1);
    expect(birthday.disciples[0]!.ageMonths).toBe(disciple.ageMonths + 1);
    expect(roundtrip(birthday)).toEqual(birthday);
  });
  it.each(['alive', 'dead'] as const)('rolls back lifetime overflow for an %s disciple to a valid exportable boundary', (lifeState) => {
    const initial = createWorld(`lifetime-overflow-${lifeState}`);
    const disciple = initial.disciples[0]!;
    disciple.birthCalendarTick = -Number.MAX_SAFE_INTEGER;
    disciple.lifeState = lifeState;
    disciple.ageMonths = lifeState === 'alive' ? Math.floor(Number.MAX_SAFE_INTEGER / CALENDAR_TICKS_PER_MONTH) : 0;
    expect(validateWorldState(initial)).toEqual([]);
    const restored = roundtrip(initial);
    const stopped = advanceTicks(restored, 1);
    expect(stopped.clock.simulationTick).toBe(0);
    expect(stopped.clock.calendarTick).toBe(0);
    expect(stopped.clock.pauseReasons).toContain('error');
    expect(stopped.diagnostics).toEqual([{ code: 'INVARIANT_FAILURE', tick: 0, message: 'Safe integer overflow' }]);
    expect(stopped.disciples).toEqual(initial.disciples);
    expect(stopped.inventory).toEqual(initial.inventory);
    expect(stopped.sequences).toEqual(initial.sequences);
    expect(stopped.randomStreams).toEqual(initial.randomStreams);
    expect(roundtrip(stopped)).toEqual(stopped);
  });
});
