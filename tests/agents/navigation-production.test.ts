import { describe, expect, it } from 'vitest';
import { cardinalDistance, findCardinalPath, MAX_PATH_REQUESTS_PER_TICK, MOVEMENT_TICKS_PER_CELL, setTileWalkable } from '../../src/core/agents/navigation';
import { advanceTicks, cancelProduction, completeProduction, createSaveEnvelope, createWorld, dispatchCommand, domainHash, parseSave, serializeSave, setClockSpeed, setPauseReason, stableHash, validateWorldState, type ProductionPhase, type WorldState } from '../../src/core/kernel';
import legacyFixture from './fixtures/save-v1-in-progress.json';

const metadata = { buildId: 'navigation-tests', savedAt: '2026-10-01T00:00:00.000Z' };
function start(world = createWorld('navigation'), workerIndex = 1, commandId = 'nav.start', recipeId = 'craft.plank') {
  const result = dispatchCommand(world, { commandId, sequence: workerIndex, issuedTick: world.clock.simulationTick, kind: 'production.start', payload: { recipeId, workerId: world.disciples[workerIndex]!.id } });
  expect(result.result.status).toBe('accepted');
  return { world: result.world, id: result.result.transactionId! };
}
function atPhase(world: WorldState, id: string, phase: ProductionPhase): WorldState {
  for (let tick = 0; tick < 2000; tick += 1) {
    if (world.transactions[id]!.phase === phase) return world;
    world = advanceTicks(world, 1);
    expect(world.clock.pauseReasons).not.toContain('error');
  }
  throw new Error(`Did not reach ${phase}`);
}
function reload(world: WorldState): WorldState {
  const result = parseSave(serializeSave(createSaveEnvelope(world, metadata)));
  if (!result.ok) throw new Error(result.error.message);
  expect(result.migration).toBeNull();
  return result.world;
}

describe('deterministic cardinal navigation', () => {
  it('uses north-east-south-west ties and routes around obstacles without diagonal shortcuts', () => {
    let world = createWorld('path');
    world = setTileWalkable(world, { x: 5, y: 5 }, false);
    const path = findCardinalPath(world.map, { x: 6, y: 5 }, { x: 2, y: 5 })!;
    expect(path[0]).toEqual({ x: 6, y: 4 });
    expect(path).toHaveLength(6);
    expect(path).not.toContainEqual({ x: 5, y: 5 });
    let previous = { x: 6, y: 5 };
    for (const position of path) { expect(cardinalDistance(previous, position)).toBe(1); previous = position; }
    expect(findCardinalPath(world.map, { x: -1, y: 5 }, { x: 2, y: 5 })).toBeNull();
    expect(findCardinalPath(world.map, { x: 6, y: 5 }, { x: 14, y: 5 })).toBeNull();
    expect(() => setTileWalkable(world, { x: 14, y: 5 }, true)).toThrow();
  });
  it('saves route cells, validates cardinal continuity, and rejects forged teleport paths', () => {
    const started = start();
    const world = advanceTicks(started.world, 1);
    const navigation = world.transactions[started.id]!.navigation;
    expect(navigation.path.length).toBeGreaterThan(0);
    expect(navigation.movementTicks).toBe(1);
    expect(reload(world)).toEqual(world);
    world.transactions[started.id]!.navigation.path[0] = { x: 13, y: 9 };
    expect(validateWorldState(world)).toContain('Route contains a non-cardinal step or cycle');
    expect(() => createSaveEnvelope(world, metadata)).toThrow();
  });
  it('bounds path requests and lets deferred workers acquire paths on later ticks', () => {
    let world = createWorld('budget');
    // Make six adult workers and six independent seats without changing recipe costs.
    const template = world.disciples[1]!;
    for (let index = world.disciples.length; index < 7; index += 1) {
      const id = `entity:${world.sequences.nextEntity++}`;
      world.disciples.push({ ...template, id, position: { x: 6, y: 5 }, assignmentTransactionId: null });
    }
    const station = world.buildings.find((building) => building.blueprintId === 'workshop')!;
    for (let index = 1; index < 6; index += 1) world.buildings.push({ ...station, id: `entity:${world.sequences.nextEntity++}`, x: 11, y: index });
    const ids: string[] = [];
    for (let index = 1; index < 7; index += 1) { const result = start(world, index, `budget.${index}`); world = result.world; ids.push(result.id); }
    world = advanceTicks(world, 1);
    expect(ids.filter((id) => world.transactions[id]!.navigation.path.length > 0)).toHaveLength(MAX_PATH_REQUESTS_PER_TICK);
    world = advanceTicks(world, 1);
    expect(ids.filter((id) => world.transactions[id]!.navigation.path.length > 0)).toHaveLength(6);
    expect(validateWorldState(world)).toEqual([]);
  });
});

describe('travel, work and delivery transactions', () => {
  it('moves to the assigned seat, works there, then delivers before exactly one debit and credit', () => {
    const initial = createWorld('order');
    const started = start(initial);
    let world = started.world;
    const workerId = world.transactions[started.id]!.workerId;
    const origin = world.disciples.find((disciple) => disciple.id === workerId)!.position;
    world = advanceTicks(world, MOVEMENT_TICKS_PER_CELL - 1);
    expect(world.disciples.find((disciple) => disciple.id === workerId)!.position).toEqual(origin);
    expect(world.transactions[started.id]!.activeTicks).toBe(0);
    world = advanceTicks(world, 1);
    expect(cardinalDistance(world.disciples.find((disciple) => disciple.id === workerId)!.position, origin)).toBe(1);
    expect(world.transactions[started.id]!.activeTicks).toBe(0);
    world = atPhase(world, started.id, 'Working');
    expect(world.disciples.find((disciple) => disciple.id === workerId)!.position).toEqual({ x: 11, y: 5 });
    expect(world.transactions[started.id]!.activeTicks).toBe(0);
    world = advanceTicks(world, 1);
    expect(world.transactions[started.id]!.activeTicks).toBe(1);
    world = atPhase(world, started.id, 'TravellingToStorage');
    expect(world.transactions[started.id]!.activeTicks).toBe(160);
    expect(world.inventory.plank.owned).toBe(0);
    expect(world.inventory.wood.owned).toBe(initial.inventory.wood.owned);
    expect(world.inventory.wood.reserved).toBe(3);
    expect(world.buildings.find((building) => building.blueprintId === 'workshop')!.stationTransactionId).toBeNull();
    expect(completeProduction(world, started.id)).toMatchObject({ ok: false, rejection: { code: 'WORKER_UNAVAILABLE' } });
    world = atPhase(world, started.id, 'AwaitingDelivery');
    expect(world.disciples.find((disciple) => disciple.id === workerId)!.position).toEqual({ x: 7, y: 5 });
    expect(world.inventory.plank.owned).toBe(0);
    world = advanceTicks(world, 1);
    expect(world.transactions[started.id]!.phase).toBe('Done');
    expect(world.inventory.plank.owned).toBe(2);
    expect(world.inventory.wood.owned).toBe(initial.inventory.wood.owned - 3);
    expect(world.inventory.wood.reserved).toBe(0);
    const duplicate = completeProduction(world, started.id);
    expect(duplicate.ok && duplicate.world).toBe(world);
    expect(world.events.filter((event) => event.kind === 'production.committed')).toHaveLength(1);
  });
  it('queues two workers for one seat and releases the seat before the first delivery', () => {
    const first = start(createWorld('one-seat'), 1, 'first');
    const second = start(first.world, 2, 'second');
    let world = advanceTicks(second.world, 1);
    expect(world.transactions[first.id]!.phase).toBe('TravellingToWork');
    expect(world.transactions[second.id]!.blockedReason).toBe('WAITING_FOR_STATION');
    expect(world.transactions[second.id]!.activeTicks).toBe(0);
    expect(world.buildings.find((building) => building.blueprintId === 'workshop')!.stationTransactionId).toBe(first.id);
    world = atPhase(world, first.id, 'TravellingToStorage');
    expect(world.transactions[second.id]!.phase).toBe('TravellingToWork');
    expect(world.buildings.find((building) => building.blueprintId === 'workshop')!.stationTransactionId).toBe(second.id);
    world = advanceTicks(world, 400);
    expect(world.inventory.plank.owned).toBe(4);
    expect(world.inventory.wood.reserved).toBe(0);
    expect(validateWorldState(world)).toEqual([]);
  });
  it('holds blocked delivery without consuming inputs and resumes when a path is restored', () => {
    const started = start(createWorld('delivery-blocked'));
    let world = atPhase(started.world, started.id, 'TravellingToStorage');
    for (const position of [{ x: 6, y: 5 }, { x: 8, y: 5 }, { x: 7, y: 4 }, { x: 7, y: 6 }]) world = setTileWalkable(world, position, false);
    world = advanceTicks(world, 40);
    expect(world.transactions[started.id]!.blockedReason).toBe('PATH_BLOCKED');
    expect(world.inventory.wood.reserved).toBe(3);
    expect(world.inventory.wood.owned).toBe(24);
    expect(world.inventory.plank.owned).toBe(0);
    expect(world.disciples[1]!.position).toEqual({ x: 11, y: 5 });
    const restored = setTileWalkable(reload(world), { x: 8, y: 5 }, true);
    world = atPhase(restored, started.id, 'Done');
    expect(world.inventory.plank.owned).toBe(2);
    expect(world.inventory.wood.owned).toBe(21);
  });
  it('invalidates a cached route when the map changes and never crosses the new obstacle', () => {
    const started = start(createWorld('change-route'), 1, 'reroute', 'gather.wood');
    let world = advanceTicks(started.world, 1);
    const blockedCell = world.transactions[started.id]!.navigation.path[0]!;
    world = setTileWalkable(world, blockedCell, false);
    expect(reload(world)).toEqual(world);
    for (let tick = 0; tick < 180; tick += 1) {
      world = advanceTicks(world, 1);
      expect(world.disciples[1]!.position).not.toEqual(blockedCell);
      expect(validateWorldState(world)).toEqual([]);
    }
    expect(world.transactions[started.id]!.phase).toBe('Done');
  });
  it.each(['WaitingForStation', 'TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery'] as const)('cancels safely during %s without teleporting or giving both inputs and outputs', (phase) => {
    const started = start(createWorld(`cancel-${phase}`));
    let world = atPhase(started.world, started.id, phase);
    if (phase === 'TravellingToWork' || phase === 'TravellingToStorage') world = advanceTicks(world, MOVEMENT_TICKS_PER_CELL + 1);
    const position = world.disciples[1]!.position;
    const cancelled = cancelProduction(world, started.id);
    if (!cancelled.ok) throw new Error('Cancel failed');
    world = advanceTicks(reload(cancelled.world), 500);
    expect(world.transactions[started.id]!.phase).toBe('Cancelled');
    expect(world.inventory.wood.owned).toBe(24);
    expect(world.inventory.wood.reserved).toBe(0);
    expect(world.inventory.plank.owned).toBe(0);
    expect(world.disciples[1]!.position).toEqual(position);
    expect(world.disciples[1]!.traveling).toBe(false);
    expect(world.buildings.every((building) => building.stationTransactionId === null)).toBe(true);
    const duplicate = cancelProduction(world, started.id);
    expect(duplicate.ok && duplicate.world).toBe(world);
  });
  it('pauses movement, work and delivery credit under every pause owner', () => {
    const started = start(createWorld('pause-travel'));
    for (const phase of ['TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery'] as const) {
      const world = atPhase(started.world, started.id, phase);
      const paused = { ...world, clock: setPauseReason(world.clock, 'player', true) };
      expect(advanceTicks(paused, 1000)).toBe(paused);
      expect(completeProduction(paused, started.id).ok).toBe(false);
    }
  });
  it('retains work through unavailable workers and missing stations, releasing and reacquiring seats', () => {
    const started = start(createWorld('recover-worker'));
    let world = advanceTicks(atPhase(started.world, started.id, 'Working'), 10);
    world = { ...world, disciples: world.disciples.map((disciple, index) => index === 1 ? { ...disciple, canWork: false } : disciple) };
    world = advanceTicks(world, 10);
    expect(world.transactions[started.id]!.activeTicks).toBe(10);
    expect(world.transactions[started.id]!.blockedReason).toBe('WORKER_UNAVAILABLE');
    expect(world.buildings.every((building) => building.stationTransactionId === null)).toBe(true);
    world = { ...world, disciples: world.disciples.map((disciple, index) => index === 1 ? { ...disciple, canWork: true } : disciple) };
    world = atPhase(world, started.id, 'Working');
    const workshop = world.buildings.find((building) => building.blueprintId === 'workshop')!;
    world = { ...world, buildings: world.buildings.filter((building) => building.id !== workshop.id) };
    world = advanceTicks(world, 1);
    expect(world.transactions[started.id]!.blockedReason).toBe('WORKSTATION_UNAVAILABLE');
    expect(world.transactions[started.id]!.activeTicks).toBe(10);
    expect(world.inventory.wood.reserved).toBe(3);
    world = reload(world);
    world = { ...world, buildings: [...world.buildings, { ...workshop, stationTransactionId: null }] };
    expect(atPhase(world, started.id, 'Done').inventory.plank.owned).toBe(2);
  });
  it.each(['dead', 'missing'] as const)('cancels a %s worker job and releases its materials and seat exactly once', (unavailable) => {
    const started = start(createWorld(`worker-${unavailable}`));
    let world = atPhase(started.world, started.id, 'Working');
    world = { ...world, disciples: unavailable === 'missing' ? world.disciples.filter((_, index) => index !== 1) : world.disciples.map((disciple, index) => index === 1 ? { ...disciple, lifeState: 'dead' as const } : disciple) };
    world = advanceTicks(world, 1);
    expect(world.transactions[started.id]!.phase).toBe('Cancelled');
    expect(world.inventory.wood.reserved).toBe(0);
    expect(world.inventory.wood.owned).toBe(24);
    expect(reload(world)).toEqual(world);
    expect(advanceTicks(world, 300).events.filter((event) => event.kind === 'production.cancelled')).toHaveLength(1);
  });
  it('retains finished work while storage is missing or full, then commits only after actual delivery', () => {
    const started = start(createWorld('storage-recovery'));
    let world = atPhase(started.world, started.id, 'TravellingToStorage');
    const storage = world.buildings.find((building) => building.blueprintId === 'storage')!;
    world = { ...world, buildings: world.buildings.filter((building) => building.id !== storage.id) };
    world = advanceTicks(world, 20);
    expect(world.transactions[started.id]!.blockedReason).toBe('STORAGE_UNAVAILABLE');
    expect(world.inventory.plank.owned).toBe(0);
    world = { ...reload(world), buildings: [...world.buildings, storage], inventory: { ...world.inventory, plank: { ...world.inventory.plank, capacity: 1 } } };
    world = advanceTicks(world, 60);
    expect(world.transactions[started.id]!.blockedReason).toBe('CAPACITY_EXCEEDED');
    expect(world.disciples[1]!.position).toEqual({ x: storage.x, y: storage.y });
    expect(world.inventory.wood.owned).toBe(24);
    world = { ...reload(world), inventory: { ...world.inventory, plank: { ...world.inventory.plank, capacity: 999 } } };
    world = advanceTicks(world, 1);
    expect(world.transactions[started.id]!.phase).toBe('Done');
    expect(world.inventory.plank.owned).toBe(2);
  });
  it.each([1, 7, 19, 63, 181, 187, 195])('resumes a tick-%i snapshot to the same final hash at 1x and3x', (tick) => {
    const started = start(createWorld('resume-route'));
    const checkpoint = advanceTicks(started.world, tick);
    const resumed = advanceTicks({ ...reload(checkpoint), clock: setClockSpeed(checkpoint.clock, 3) }, 400 - tick);
    const direct = advanceTicks(started.world, 400);
    expect(domainHash(resumed)).toBe(domainHash(direct));
    expect(resumed.inventory).toEqual(direct.inventory);
    expect(resumed.sequences).toEqual(direct.sequences);
  });
});

describe('explicit legacy movement migration', () => {
  it('migrates a genuine v1 in-progress snapshot without replay, reset or resource loss', () => {
    const bytes = JSON.stringify(legacyFixture);
    const result = parseSave(bytes);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.migration).toEqual({ sourceSaveVersion: 1, sourceSimulationVersion: '0.1.1', sourceChecksum: legacyFixture.checksum });
    expect(result.envelope.saveVersion).toBe(2);
    expect(result.world.inventory).toEqual(legacyFixture.payload.inventory);
    expect(result.world.randomStreams).toEqual(legacyFixture.payload.randomStreams);
    expect(result.world.events).toEqual(legacyFixture.payload.events);
    const transaction = Object.values(result.world.transactions)[0]!;
    expect(transaction.activeTicks).toBe(47);
    expect(transaction.phase).toBe('WaitingForStation');
    expect(result.world.disciples[1]!.position).toEqual(legacyFixture.payload.disciples[1]!.position);
    expect(result.world.sequences.nextEntity).toBe(legacyFixture.payload.sequences.nextEntity + 1);
    expect(result.world.sequences.nextInstance).toBe(legacyFixture.payload.sequences.nextInstance);
    const afterTravel = atPhase(result.world, transaction.transactionId, 'Working');
    expect(afterTravel.transactions[transaction.transactionId]!.activeTicks).toBe(47);
    const final = atPhase(reload(afterTravel), transaction.transactionId, 'Done');
    expect(final.inventory.wood.owned).toBe(21);
    expect(final.inventory.plank.owned).toBe(2);
    expect(JSON.stringify(legacyFixture)).toBe(bytes);
  });
  it('preserves fully worked legacy capacity-blocked orders but requires storage travel before settlement', () => {
    const copy = JSON.parse(JSON.stringify(legacyFixture)) as typeof legacyFixture;
    const transaction = Object.values(copy.payload.transactions)[0]!;
    transaction.activeTicks = transaction.requiredTicks;
    transaction.state = 'Blocked';
    // The static fixture inferred null narrowly; legacy JSON is deliberately edited here.
    Object.assign(transaction, { blockedReason: 'CAPACITY_EXCEEDED' });
    const { checksum: _checksum, ...body } = copy;
    const result = parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }));
    if (!result.ok) throw new Error(result.error.message);
    expect(Object.values(result.world.transactions)[0]!.phase).toBe('TravellingToStorage');
    expect(result.world.inventory.plank.owned).toBe(0);
    expect(completeProduction(result.world, transaction.transactionId).ok).toBe(false);
    const final = atPhase(result.world, transaction.transactionId, 'Done');
    expect(final.inventory.plank.owned).toBe(2);
  });
  it('keeps the old0.1.0 random mapping rejection distinct from supported v1 migration', () => {
    const { checksum: _checksum, ...fixture } = legacyFixture;
    const body = { ...fixture, simulationVersion: '0.1.0', payload: { ...fixture.payload, simulationVersion: '0.1.0' } };
    expect(parseSave(JSON.stringify({ ...body, checksum: stableHash(body) }))).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SIMULATION_VERSION' } });
  });
});
