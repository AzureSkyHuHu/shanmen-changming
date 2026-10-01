import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAutomaticTransaction, liveProductionAt, recordAutomaticNotice,
  type AutomaticWorld as ProductionWorld } from '../../src/core/economy/automatic-production';
import type { ProductionWork } from '../../src/core/economy/automatic-types';
import { cancelProduction, completeProduction, startProduction, tickProduction } from '../../src/core/economy/production';
import { runProductionPhases, type ProductionContext, type ProductionProgress, type ProductionSite,
  type ProductionWorker } from '../../src/core/economy/production-context';
import { getRecipe } from '../../src/core/economy/recipes';
import type { ProductionBlockedReason } from '../../src/core/economy/types';
import { cardinalDistance, emptyNavigation, isWalkable, sameCell } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget, type WorkPathBudget } from '../../src/core/agents/work-navigation';
import { isPaused } from '../../src/core/kernel/clock';
import { appendEvent } from '../../src/core/kernel/events';
import { canonicalStringify, cloneJson, compareStable } from '../../src/core/kernel/serialization';
import { isCommand } from '../../src/core/kernel/commands';
import { isCommandV8 } from '../../src/core/kernel/command-shape-v8';
import { validateWorldState, validateWorldStateV8 } from '../../src/core/kernel/validation';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { createWorld } from '../../src/core/world/create-world';
import type { WorldStateV8 } from '../../src/core/world/v8-types';
import { createSaveEnvelope, parseSave, serializeSave } from '../../src/core/kernel/save';
import { createSaveEnvelopeV8, parseSaveV8, serializeSaveV8 } from '../../src/core/kernel/save-v8';
import { lookupProduction, recordWorldReceipt } from '../../src/core/world/history-access';
import type { GridPosition, WorldBuilding, WorldMap, WorldState } from '../../src/core/world/types';

/** Frozen pre-context phase implementation (2026-10-01). Keep independent of the new
 * runner and binding: whole canonical World traces are the compatibility oracle.
 * Settlement/admission are intentionally the unchanged legacy authoritative functions. */
function updateOrder<W extends ProductionWorld>(world: W, transaction: ProductionWork, traveling = false, position?: GridPosition): W {
  const next = isAutomaticTransaction(transaction)
    ? { ...world, automaticProduction: { ...world.automaticProduction, live: { ...world.automaticProduction.live,
      [transaction.transactionId]: { transaction, reservation: world.automaticProduction.live[transaction.transactionId]!.reservation } } } }
    : { ...world, transactions: { ...world.transactions, [transaction.transactionId]: transaction } };
  return { ...next, disciples: world.disciples.map((disciple) => disciple.id === transaction.workerId ? { ...disciple, traveling, ...(position ? { position: { ...position } } : {}) } : disciple) };
}
function releaseStation<W extends ProductionWorld>(world: W, id: string): W {
  return { ...world, buildings: world.buildings.map((building) => building.stationTransactionId === id ? { ...building, stationTransactionId: null } : building) };
}
function block<W extends ProductionWorld>(world: W, transaction: ProductionWork, reason: ProductionBlockedReason): W {
  const next = transaction.blockedReason !== reason
    ? isAutomaticTransaction(transaction)
      ? recordAutomaticNotice(world, { cycle: transaction.origin.cycle, workerId: transaction.workerId, recipeId: transaction.recipeId, kind: 'blocked', reason })
      : appendEvent(world, { kind: 'production.blocked', rootActionId: transaction.rootActionId, parentEventId: null, payload: { transactionId: transaction.transactionId, reason } }).world
    : world;
  return updateOrder(next, { ...transaction, state: 'Blocked', blockedReason: reason });
}
function running(transaction: ProductionWork): ProductionWork { return { ...transaction, state: 'Running', blockedReason: null }; }

/** Returns at a full movement boundary; arrival never awards work in the same tick. */
function travel<W extends ProductionWorld>(world: W, transaction: ProductionWork, target: GridPosition, budget: WorkPathBudget): W {
  const worker = world.disciples.find((disciple) => disciple.id === transaction.workerId)!;
  const effect = advanceWorkNavigationWithBudget({ map: world.map, position: worker.position, target,
    navigation: transaction.navigation, simulationTick: world.clock.simulationTick }, budget);
  if (effect.status === 'path-blocked') return block(world, { ...transaction, navigation: effect.navigation }, 'PATH_BLOCKED');
  if (effect.status === 'path-budget-exhausted') {
    return updateOrder(world, { ...(transaction.blockedReason === 'PATH_BLOCKED' ? transaction : running(transaction)), navigation: effect.navigation });
  }
  return updateOrder(world, { ...running(transaction),
    phase: effect.status === 'arrived' ? transaction.phase === 'TravellingToWork' ? 'Working' : 'AwaitingDelivery' : transaction.phase,
    navigation: effect.navigation }, effect.traveling, effect.position ?? undefined);
}
function candidates(world: ProductionWorld, blueprintId: string, position: GridPosition): WorldBuilding[] {
  return world.buildings.filter((building) => building.blueprintId === blueprintId && building.operational).sort((left, right) => cardinalDistance(position, left) - cardinalDistance(position, right) || compareStable(left.id, right.id));
}

/** Serialized phases own reservations and seats. Ordinary transit cells can be shared; work seats cannot.
 * A versioned tick orchestrator may share one budget across modules; legacy callers retain four requests per tick. */
function priorTickProduction<W extends ProductionWorld>(world: W, sharedPathBudget?: WorkPathBudget): W {
  if (world.clock.mode !== 'management' || isPaused(world.clock)) return world;
  let next = world;
  const budget = sharedPathBudget ?? createWorkPathBudget(world.clock.simulationTick);
  if (budget.simulationTick !== world.clock.simulationTick) throw new RangeError('Path budget belongs to another tick');
  const ids = [...world.activeProductionTransactionIds].sort((left, right) => liveProductionAt(world, left)!.transaction.startedTick - liveProductionAt(world, right)!.transaction.startedTick || compareStable(left, right));
  for (const id of ids) {
    let transaction = liveProductionAt(next, id)!.transaction;
    if (transaction.state !== 'Running' && transaction.state !== 'Blocked') continue;
    const worker = next.disciples.find((disciple) => disciple.id === transaction.workerId);
    const recipe = getRecipe(transaction.recipeId);
    if (!recipe) throw new Error('Production references a missing recipe');
    if (!worker || worker.lifeState === 'dead') {
      const cancelled = cancelProduction(next, id);
      if (!cancelled.ok) throw new Error('Cannot release unavailable worker reservation');
      next = cancelled.world;
      continue;
    }
    if (worker.assignmentTransactionId !== id) throw new Error('Production worker assignment mismatch');
    if (!worker.canWork) {
      next = releaseStation(next, id);
      transaction = { ...transaction, phase: transaction.activeTicks === transaction.requiredTicks ? 'TravellingToStorage' : 'WaitingForStation', worksiteId: null, navigation: emptyNavigation() };
      next = block(next, transaction, 'WORKER_UNAVAILABLE');
      continue;
    }
    if (transaction.activeTicks === transaction.requiredTicks && transaction.phase !== 'TravellingToStorage' && transaction.phase !== 'AwaitingDelivery') {
      next = releaseStation(next, id);
      transaction = { ...running(transaction), phase: 'TravellingToStorage', navigation: emptyNavigation() };
    }
    if (transaction.phase === 'WaitingForStation') {
      const sites = candidates(next, recipe.workstation, worker.position);
      const station = sites.find((building) => building.stationTransactionId === null || building.stationTransactionId === id);
      if (!station) { next = block(next, transaction, sites.length ? 'WAITING_FOR_STATION' : 'WORKSTATION_UNAVAILABLE'); continue; }
      next = { ...next, buildings: next.buildings.map((building) => building.id === station.id ? { ...building, stationTransactionId: id } : building) };
      transaction = { ...running(transaction), phase: 'TravellingToWork', worksiteId: station.id, navigation: emptyNavigation() };
    }
    if (transaction.phase === 'TravellingToWork' || transaction.phase === 'Working') {
      const station = next.buildings.find((building) => building.id === transaction.worksiteId && building.blueprintId === recipe.workstation && building.operational && building.stationTransactionId === id);
      if (!station) {
        next = releaseStation(next, id);
        next = block(next, { ...transaction, phase: 'WaitingForStation', worksiteId: null, navigation: emptyNavigation() }, 'WORKSTATION_UNAVAILABLE');
        continue;
      }
      if (transaction.phase === 'TravellingToWork' || !sameCell(worker.position, station) || !isWalkable(next.map, station)) {
        next = travel(next, { ...transaction, phase: 'TravellingToWork' }, station, budget);
        continue;
      }
      const activeTicks = Math.min(transaction.activeTicks + 1, transaction.requiredTicks);
      transaction = { ...running(transaction), activeTicks };
      if (activeTicks === transaction.requiredTicks) {
        next = releaseStation(next, id);
        transaction = { ...transaction, phase: 'TravellingToStorage', navigation: emptyNavigation() };
      }
      next = updateOrder(next, transaction);
      continue;
    }
    if (transaction.phase === 'TravellingToStorage' || transaction.phase === 'AwaitingDelivery') {
      const storage = next.buildings.find((building) => building.id === transaction.storageId && building.blueprintId === 'storage' && building.operational) ?? candidates(next, 'storage', worker.position)[0];
      if (!storage) { next = block(next, { ...transaction, phase: 'TravellingToStorage', storageId: null, navigation: emptyNavigation() }, 'STORAGE_UNAVAILABLE'); continue; }
      const changedStorage = transaction.storageId !== storage.id;
      transaction = { ...transaction, storageId: storage.id, ...(changedStorage ? { phase: 'TravellingToStorage', navigation: emptyNavigation() } : {}) };
      if (transaction.phase === 'TravellingToStorage' || !sameCell(worker.position, storage) || !isWalkable(next.map, storage)) {
        next = travel(next, { ...transaction, phase: 'TravellingToStorage' }, storage, budget);
        continue;
      }
      next = updateOrder(next, transaction);
      const completion = completeProduction(next, id);
      if (completion.ok) next = completion.world;
      else if (completion.rejection.code === 'CAPACITY_EXCEEDED') next = block(next, transaction, 'CAPACITY_EXCEEDED');
      else throw new Error(`Cannot commit production: ${completion.rejection.code}`);
    }
  }
  return next;
}


type Pair<W extends ProductionWorld> = { current: W; prior: W };
function pair<W extends ProductionWorld>(world: W): Pair<W> { return { current: world, prior: cloneJson(world) }; }
function tickClock<W extends ProductionWorld>(world: W): W {
  return { ...world, clock: { ...world.clock, simulationTick: world.clock.simulationTick + 1,
    calendarTick: world.clock.calendarTick + (world.clock.mode === 'management' ? 1 : 0),
    encounterTick: world.clock.encounterTick + (world.clock.mode === 'combat' ? 1 : 0) } };
}
function mapPair<W extends ProductionWorld>(worlds: Pair<W>, edit: (world: W) => W): Pair<W> {
  return { current: edit(worlds.current), prior: edit(worlds.prior) };
}
function step<W extends ProductionWorld>(worlds: Pair<W>, spent = 0): Pair<W> {
  const advance = (source: W, runner: typeof tickProduction): W => {
    const world = tickClock(source); const budget = createWorkPathBudget(world.clock.simulationTick);
    for (let n = 0; n < spent; n += 1) advanceWorkNavigationWithBudget({ map: world.map,
      position: { x: 0, y: 0 }, target: { x: 1, y: 0 }, navigation: emptyNavigation(), simulationTick: world.clock.simulationTick }, budget);
    return runner(world, budget);
  };
  const next = { current: advance(worlds.current, tickProduction), prior: advance(worlds.prior, priorTickProduction) };
  // Includes IDs, full manual/archive records, automatic notices/pins, exact receipts,
  // reservations/resources, real positions, site owners and all unrelated domains.
  expect(canonicalStringify(next.current)).toBe(canonicalStringify(next.prior));
  return next;
}
function until<W extends ProductionWorld>(worlds: Pair<W>, predicate: (world: W) => boolean, limit = 700): Pair<W> {
  for (let count = 0; !predicate(worlds.current) && count < limit; count += 1) worlds = step(worlds);
  expect(predicate(worlds.current)).toBe(true);
  return worlds;
}
function begin<W extends ProductionWorld>(world: W, workerId = 'entity:2', commandId = 'context.start', recipeId = 'craft.plank'): W {
  const operation = startProduction(world, commandId, recipeId, workerId);
  if (!operation.ok) throw new Error(operation.rejection.code);
  return recordWorldReceipt(operation.world, { commandId, fingerprint: canonicalStringify({ kind: 'production.start', payload: { recipeId, workerId } }),
    result: { commandId, status: 'accepted', transactionId: operation.transactionId, eventIds: operation.eventIds, rejection: null } });
}
function publicCancel<W extends ProductionWorld>(world: W, transactionId: string, commandId = 'context.cancel'): W {
  const operation = cancelProduction(world, transactionId, { commandId });
  if (!operation.ok) throw new Error(operation.rejection.code);
  return recordWorldReceipt(operation.world, { commandId, fingerprint: canonicalStringify({ kind: 'production.cancel', payload: { transactionId } }),
    result: { commandId, status: 'accepted', transactionId, eventIds: operation.eventIds, rejection: null } });
}
function editTiles<W extends ProductionWorld>(world: W, positions: GridPosition[], walkable: boolean): W {
  return { ...world, map: { ...world.map, navVersion: world.map.navVersion + 1,
    tiles: world.map.tiles.map(tile => positions.some(position => sameCell(tile, position)) ? { ...tile, walkable } : tile) } };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const entry of Object.values(value)) freeze(entry); }
  return value;
}
function assertValid(world: ProductionWorld): void {
  expect(('contentIdentity' in world ? validateWorldStateV8 : validateWorldState)(world)).toEqual([]);
}

const saveMetadata = { buildId: 'production-context-tests', savedAt: '2026-10-01T22:00:00Z' };
function saveText(world: WorldState | WorldStateV8): string {
  return 'contentIdentity' in world ? serializeSaveV8(createSaveEnvelopeV8(world, saveMetadata)) : serializeSave(createSaveEnvelope(world, saveMetadata));
}
function reload(world: WorldState | WorldStateV8): WorldState | WorldStateV8 {
  const text = saveText(world);
  const parsed = 'contentIdentity' in world ? parseSaveV8(text) : parseSave(text);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(saveText(parsed.world)).toBe(text);
  return parsed.world;
}

// A real historical automatic save contributes durable receipts, an exact terminal
// pin and two live canonical jobs. It is not generated by the extracted runner.
function automaticFixture(): WorldState {
  return (JSON.parse(readFileSync(new URL('./fixtures/save-v7-active-automatic.json', import.meta.url), 'utf8')) as { payload: WorldState }).payload;
}

describe('phase context preserves frozen pre-extraction canonical traces', () => {
  it.each(['v7', 'v8'] as const)('keeps %s manual travel, work, delivery, archive and repeated settlement exact', version => {
    const source = createWorld(`phase-oracle-${version}`);
    const started = begin(version === 'v7' ? source : migrateWorldV7ToV8(source));
    const id = started.activeProductionTransactionIds[0]!;
    const input = canonicalStringify(started);
    let worlds = pair(freeze(started));
    for (const phase of ['TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery'] as const) {
      worlds = until(worlds, world => lookupProduction(world, id)?.phase === phase);
      expect(worlds.current.inventory.plank.owned).toBe(0);
      expect(worlds.current.inventory.wood).toMatchObject({ owned: 24, reserved: 3 });
      assertValid(worlds.current);
      // Actual versioned wire text and restore continuity match the old runner.
      expect(saveText(worlds.current)).toBe(saveText(worlds.prior));
      worlds = mapPair(worlds, reload);
    }
    expect(worlds.current.disciples[1]!.position).toEqual({ x: 7, y: 5 });
    worlds = step(worlds);
    expect(worlds.current.inventory.wood).toMatchObject({ owned: 21, reserved: 0 });
    expect(worlds.current.inventory.plank.owned).toBe(2);
    expect(worlds.current.history.production.count).toBe(1);
    expect(worlds.current.reservations).toEqual({});
    expect(worlds.current.transactions).toEqual({});
    expect(worlds.current.commandReceipts).toEqual(started.commandReceipts);
    expect(worlds.current.sequences).toEqual(worlds.prior.sequences);
    expect(worlds.current.events.map(event => event.kind)).toEqual(['production.started', 'production.committed']);
    expect(completeProduction(worlds.current, id)).toEqual(completeProduction(worlds.prior, id));
    expect(cancelProduction(worlds.current, id)).toEqual({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
    expect(completeProduction(worlds.current, id)).toMatchObject({ ok: true, world: worlds.current });
    expect(canonicalStringify(started)).toBe(input);
    assertValid(worlds.current);
  });

  it('re-reads the candidate so a later job claims the seat released earlier in the same tick', () => {
    const started = begin(begin(createWorld('phase-seat'), 'entity:2', 'seat.first'), 'entity:3', 'seat.second');
    const [first, second] = started.activeProductionTransactionIds;
    // Reverse the active index to prove startedTick/ID ordering owns traversal.
    let worlds = step(pair({ ...started, activeProductionTransactionIds: [...started.activeProductionTransactionIds].reverse() }));
    expect(worlds.current.transactions[second!]!.blockedReason).toBe('WAITING_FOR_STATION');
    const noticeCount = worlds.current.events.length;
    worlds = step(worlds);
    expect(worlds.current.events).toHaveLength(noticeCount);
    worlds = until(worlds, world => world.transactions[first!]!.phase === 'TravellingToStorage');
    expect(worlds.current.transactions[second!]!.phase).toBe('TravellingToWork');
    expect(worlds.current.buildings.find(building => building.blueprintId === 'workshop')!.stationTransactionId).toBe(second);
    worlds = until(worlds, world => world.activeProductionTransactionIds.length === 0);
    expect(worlds.current.inventory.plank.owned).toBe(4);
    expect(worlds.current.history.production.count).toBe(2);
    assertValid(worlds.current);
  });

  it.each(['v7', 'v8'] as const)('preserves %s real automatic retirement, pending pins, prior exact receipts and notices', version => {
    const fixture = automaticFixture();
    const source = version === 'v7' ? fixture : migrateWorldV7ToV8(fixture);
    const targets = [...source.activeProductionTransactionIds];
    const queued = { ...source, pendingCommands: targets.map((transactionId, sequence) => ({
      commandId: `context.future.${sequence}`, sequence, issuedTick: 900, kind: 'production.cancel' as const, payload: { transactionId },
    })) };
    let worlds = pair(queued);
    worlds = until(worlds, world => world.activeProductionTransactionIds.length === 0);
    expect(worlds.current.automaticProduction.live).toEqual({});
    expect(worlds.current.automaticProduction.pins['auto-job/1']).toEqual(source.automaticProduction.pins['auto-job/1']);
    for (const id of ['auto-job/2', 'auto-job/3'] as const) {
      expect(worlds.current.automaticProduction.pins[id]).toMatchObject({ state: 'Committed', retention: 'pending-command', resultEventId: null });
      expect(cancelProduction(worlds.current, id)).toEqual({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
    }
    expect(worlds.current.history).toEqual(source.history);
    expect(worlds.current.commandReceipts).toEqual(source.commandReceipts);
    expect(worlds.current.events).toEqual(source.events);
    expect(worlds.current.automaticProduction.journal.slice(-2).map(notice => notice.kind)).toEqual(['committed', 'committed']);
    assertValid(worlds.current);
  });

  it.each(['TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery'] as const)('retains pause/combat and guarded completion at %s', phase => {
    const started = begin(createWorld(`phase-pause-${phase}`)); const id = started.activeProductionTransactionIds[0]!;
    let worlds = until(pair(started), world => lookupProduction(world, id)!.phase === phase);
    for (const clock of [{ ...worlds.current.clock, pauseReasons: ['player' as const] }, { ...worlds.current.clock, mode: 'combat' as const }]) {
      const current = { ...worlds.current, clock }; const prior = { ...worlds.prior, clock };
      // No budget inspection takes place at a paused/non-management boundary.
      expect(tickProduction(current, createWorkPathBudget(0))).toBe(current);
      expect(priorTickProduction(prior, createWorkPathBudget(0))).toBe(prior);
      expect(completeProduction(current, id)).toEqual({ ok: false, rejection: { code: 'WORKER_UNAVAILABLE' } });
    }
    worlds = mapPair(worlds, world => publicCancel(world, id));
    expect(canonicalStringify(worlds.current)).toBe(canonicalStringify(worlds.prior));
    expect(cancelProduction(worlds.current, id)).toMatchObject({ ok: true, world: worlds.current });
    expect(worlds.current.inventory.wood).toMatchObject({ owned: 24, reserved: 0 });
    expect(worlds.current.inventory.plank.owned).toBe(0);
    assertValid(worlds.current);
  });

  it('retains effective work and releases/reclaims ownership around unavailable workers and sites', () => {
    const started = begin(createWorld('phase-unavailable')); const id = started.activeProductionTransactionIds[0]!;
    let worlds = until(pair(started), world => world.transactions[id]!.activeTicks === 9);
    worlds = step(mapPair(worlds, world => ({ ...world, disciples: world.disciples.map(member => member.id === 'entity:2' ? { ...member, canWork: false } : member) })));
    expect(worlds.current.transactions[id]).toMatchObject({ activeTicks: 9, phase: 'WaitingForStation', worksiteId: null, blockedReason: 'WORKER_UNAVAILABLE' });
    expect(worlds.current.buildings.every(site => site.stationTransactionId === null)).toBe(true);
    worlds = mapPair(worlds, world => ({ ...world, disciples: world.disciples.map(member => ({ ...member, canWork: member.id === 'entity:2' ? true : member.canWork })) }));
    worlds = until(worlds, world => world.transactions[id]!.phase === 'Working');
    worlds = step(mapPair(worlds, world => ({ ...world, buildings: world.buildings.map(site => site.blueprintId === 'workshop' ? { ...site, operational: false } : site) })));
    expect(worlds.current.transactions[id]).toMatchObject({ activeTicks: 9, blockedReason: 'WORKSTATION_UNAVAILABLE' });
    worlds = step(worlds);
    worlds = mapPair(worlds, world => ({ ...world, buildings: world.buildings.map(site => ({ ...site, operational: true })) }));
    worlds = until(worlds, world => world.activeProductionTransactionIds.length === 0);
    expect(worlds.current.inventory.plank.owned).toBe(2);
    assertValid(worlds.current);
  });

  it('keeps storage unavailability and capacity rejection side-effect order until actual delivery', () => {
    const started = begin(createWorld('phase-storage')); const id = started.activeProductionTransactionIds[0]!;
    let worlds = until(pair(started), world => world.transactions[id]!.phase === 'TravellingToStorage');
    worlds = step(mapPair(worlds, world => ({ ...world, buildings: world.buildings.map(site => site.blueprintId === 'storage' ? { ...site, operational: false } : site) })));
    expect(worlds.current.transactions[id]).toMatchObject({ phase: 'TravellingToStorage', blockedReason: 'STORAGE_UNAVAILABLE', storageId: null });
    worlds = step(worlds);
    worlds = mapPair(worlds, world => ({ ...world, buildings: world.buildings.map(site => ({ ...site, operational: true })),
      inventory: { ...world.inventory, plank: { ...world.inventory.plank, owned: world.inventory.plank.capacity } } }));
    worlds = until(worlds, world => world.transactions[id]!.blockedReason === 'CAPACITY_EXCEEDED');
    expect(worlds.current.transactions[id]!.phase).toBe('AwaitingDelivery');
    expect(worlds.current.inventory.wood).toMatchObject({ owned: 24, reserved: 3 });
    expect(worlds.current.events.filter(event => event.kind === 'production.blocked').map(event => event.payload.reason)).toEqual(['STORAGE_UNAVAILABLE', 'CAPACITY_EXCEEDED']);
    const events = worlds.current.events.length;
    worlds = step(worlds); expect(worlds.current.events).toHaveLength(events);
    worlds = step(mapPair(worlds, world => ({ ...world, inventory: { ...world.inventory, plank: { ...world.inventory.plank, owned: 0 } } })));
    expect(worlds.current.inventory.plank.owned).toBe(2);
    assertValid(worlds.current);
  });

  it.each(['missing', 'dead'] as const)('cancels a %s worker without changing its last real position or releasing twice', missing => {
    const started = begin(createWorld(`phase-worker-${missing}`)); const id = started.activeProductionTransactionIds[0]!;
    let worlds = until(pair(started), world => world.transactions[id]!.phase === 'Working');
    const position = worlds.current.disciples[1]!.position;
    // Deliberately isolated guard fixture: a missing/dead view is not exported as a
    // valid lifespan World. The unchanged production authority must still release it.
    worlds = step(mapPair(worlds, world => ({ ...world, disciples: missing === 'missing'
      ? world.disciples.filter(member => member.id !== 'entity:2')
      : world.disciples.map(member => member.id === 'entity:2' ? { ...member, lifeState: 'dead' as const } : member) })));
    expect(lookupProduction(worlds.current, id)!.state).toBe('Cancelled');
    expect(worlds.current.inventory.wood).toMatchObject({ owned: 24, reserved: 0 });
    if (missing === 'dead') expect(worlds.current.disciples[1]!.position).toEqual(position);
    expect(cancelProduction(worlds.current, id)).toMatchObject({ ok: true, world: worlds.current });
    worlds = step(worlds); expect(worlds.current.history.production.count).toBe(1);
  });

  it('keeps automatic blocked notice deduplication and promotes cancellation pins exactly once', () => {
    const fixture = automaticFixture(); const id = 'auto-job/2';
    let worlds = pair({ ...fixture, pendingCommands: [{ commandId: 'context.future.cancel', sequence: 0, issuedTick: 900,
      kind: 'production.cancel' as const, payload: { transactionId: id } }] });
    worlds = step(mapPair(worlds, world => ({ ...world, disciples: world.disciples.map(member => member.id === 'entity:3' ? { ...member, canWork: false } : member) })));
    expect(worlds.current.automaticProduction.journal.at(-1)).toMatchObject({ kind: 'blocked', reason: 'WORKER_UNAVAILABLE' });
    const count = worlds.current.automaticProduction.journal.length;
    worlds = step(worlds); expect(worlds.current.automaticProduction.journal).toHaveLength(count);
    worlds = step(mapPair(worlds, world => ({ ...world, disciples: world.disciples.filter(member => member.id !== 'entity:3') })));
    expect(worlds.current.automaticProduction.pins[id]).toMatchObject({ state: 'Cancelled', retention: 'pending-command', resultEventId: null });
    worlds = mapPair(worlds, world => publicCancel(world, id));
    expect(worlds.current.automaticProduction.pins[id]).toMatchObject({ state: 'Cancelled', retention: 'exact-receipt' });
    expect(canonicalStringify(worlds.current)).toBe(canonicalStringify(worlds.prior));
    const before = canonicalStringify(worlds.current);
    expect(cancelProduction(worlds.current, id, { commandId: 'context.cancel' })).toEqual(cancelProduction(worlds.prior, id, { commandId: 'context.cancel' }));
    expect(canonicalStringify(worlds.current)).toBe(before);
  });

  it('preserves route invalidation, blocked retry windows and a budget already consumed by other work', () => {
    const started = begin(createWorld('phase-path')); const id = started.activeProductionTransactionIds[0]!;
    let worlds = step(pair(started), 4);
    expect(worlds.current.transactions[id]!.navigation.path).toEqual([]);
    expect(worlds.current.transactions[id]!.activeTicks).toBe(0);
    worlds = step(worlds);
    const obstructed = worlds.current.transactions[id]!.navigation.path[0]!;
    worlds = step(mapPair(worlds, world => editTiles(world, [obstructed], false)));
    expect(worlds.current.transactions[id]!.navigation.path).not.toContainEqual(obstructed);
    worlds = mapPair(worlds, world => editTiles(world, [obstructed], true));
    worlds = until(worlds, world => world.transactions[id]!.phase === 'TravellingToStorage');
    const ring = [{ x: 6, y: 5 }, { x: 8, y: 5 }, { x: 7, y: 4 }, { x: 7, y: 6 }];
    worlds = step(mapPair(worlds, world => editTiles(world, ring, false)));
    expect(worlds.current.transactions[id]!.blockedReason).toBe('PATH_BLOCKED');
    const retryTick = worlds.current.transactions[id]!.navigation.retryAtTick;
    const count = worlds.current.events.length;
    for (let tick = 0; tick < 5; tick += 1) worlds = step(worlds);
    expect(worlds.current.transactions[id]!.navigation.retryAtTick).toBe(retryTick);
    expect(worlds.current.events).toHaveLength(count);
    worlds = mapPair(worlds, world => editTiles(world, [ring[1]!], true));
    worlds = until(worlds, world => world.activeProductionTransactionIds.length === 0);
    expect(worlds.current.inventory.plank.owned).toBe(2);
    assertValid(worlds.current);
  });
});

interface HarnessJob extends ProductionProgress { proof: 'test-only-canonical-job' }
interface HarnessWorker extends ProductionWorker { traveling: boolean }
interface HarnessSite extends ProductionSite { anchor: GridPosition }
/** No WorldState, inventory, ledger, reservation, automatic source or event IDs. */
interface Harness {
  tick: number;
  paused: boolean;
  management: boolean;
  grid: WorldMap;
  active: string[];
  jobs: Record<string, HarnessJob>;
  people: Record<string, HarnessWorker>;
  benches: HarnessSite[];
  depots: HarnessSite[];
  completed: string[];
  notices: ProductionBlockedReason[];
}
const harnessContext: ProductionContext<Harness, HarnessJob> = {
  view: state => ({ simulationTick: state.tick, paused: state.paused, management: state.management,
    map: state.grid, activeTransactionIds: state.active }),
  job: (state, id) => state.jobs[id]!,
  recipe: (_state, id) => id === 'test.outside-work' ? { workstation: 'external-bench' } : undefined,
  worker: (state, id) => state.people[id],
  workSites: (state, recipe) => recipe.workstation === 'external-bench' ? state.benches : [],
  storageSites: state => state.depots,
  writeProgress: (state, job, traveling = false, position) => ({ ...state, jobs: { ...state.jobs, [job.transactionId]: job },
    people: { ...state.people, [job.workerId]: { ...state.people[job.workerId]!, traveling,
      ...(position ? { position: { ...position } } : {}) } } }),
  claimSite: (state, siteId, id) => ({ ...state, benches: state.benches.map(site => site.id === siteId ? { ...site, ownerTransactionId: id } : site) }),
  releaseSites: (state, id) => ({ ...state, benches: state.benches.map(site => site.ownerTransactionId === id ? { ...site, ownerTransactionId: null } : site) }),
  blockedNotice: (state, _job, reason) => ({ ...state, notices: [...state.notices, reason] }),
  cancel: (state, id) => ({ ok: true, world: { ...state, active: state.active.filter(activeId => activeId !== id) } }),
  complete: (state, id) => {
    const job = state.jobs[id]!; const worker = state.people[job.workerId];
    const depot = state.depots.find(site => site.id === job.storageId);
    if (state.paused || !state.management || job.phase !== 'AwaitingDelivery' || job.activeTicks !== job.requiredTicks
      || !worker || worker.assignmentTransactionId !== id || worker.lifeState !== 'alive' || !worker.canWork
      || worker.traveling || !depot || !sameCell(worker.position, depot.position) || !isWalkable(state.grid, worker.position)) {
      return { ok: false, rejection: { code: 'WORKER_UNAVAILABLE' } };
    }
    return { ok: true, world: { ...state, active: state.active.filter(activeId => activeId !== id), completed: [...state.completed, id],
      jobs: { ...state.jobs, [id]: { ...job, state: 'Committed', phase: 'Done', navigation: emptyNavigation() } },
      people: { ...state.people, [job.workerId]: { ...worker, assignmentTransactionId: null } } } };
  },
};
function harness(): Harness {
  const anchors = [{ x: 2, y: 1 }, { x: 4, y: 1 }];
  return {
    tick: 0, paused: false, management: true,
    grid: { width: 5, height: 3, seed: 'typed-resource-free', generationVersion: 1, navVersion: 0,
      tiles: Array.from({ length: 15 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), terrain: 'grass',
        walkable: !anchors.some(anchor => anchor.x === index % 5 && anchor.y === Math.floor(index / 5)) })) },
    active: ['test-job'],
    jobs: { 'test-job': { transactionId: 'test-job', recipeId: 'test.outside-work', workerId: 'test-person', state: 'Running',
      activeTicks: 0, requiredTicks: 2, startedTick: 0, phase: 'WaitingForStation', blockedReason: null,
      worksiteId: null, storageId: null, navigation: emptyNavigation(), proof: 'test-only-canonical-job' } },
    people: { 'test-person': { position: { x: 0, y: 1 }, lifeState: 'alive', canWork: true, traveling: false, assignmentTransactionId: 'test-job' } },
    benches: [{ id: 'bench', anchor: anchors[0]!, position: { x: 1, y: 1 }, ownerTransactionId: null }],
    depots: [{ id: 'depot', anchor: anchors[1]!, position: { x: 3, y: 1 }, ownerTransactionId: null }],
    completed: [], notices: [],
  };
}
function stepHarness(state: Harness, context = harnessContext): Harness {
  return runProductionPhases({ ...state, tick: state.tick + 1 }, context);
}

describe('resource-independent typed phase context', () => {
  it('works and delivers at distinct external entrances without touching impassable anchors', () => {
    const source = freeze(harness()); const before = canonicalStringify(source);
    let state = source;
    expect(harnessContext.complete(state, 'test-job')).toEqual({ ok: false, rejection: { code: 'WORKER_UNAVAILABLE' } });
    for (let tick = 0; tick < 4; tick += 1) state = stepHarness(state);
    expect(state.people['test-person']!.position).toEqual({ x: 1, y: 1 });
    expect(state.jobs['test-job']).toMatchObject({ phase: 'Working', activeTicks: 0, proof: 'test-only-canonical-job' });
    state = stepHarness(state);
    expect(state.jobs['test-job']!.activeTicks).toBe(1);
    state = stepHarness(state);
    expect(state.jobs['test-job']).toMatchObject({ phase: 'TravellingToStorage', activeTicks: 2 });
    expect(state.benches[0]!.ownerTransactionId).toBeNull();
    for (let tick = 0; tick < 30 && state.jobs['test-job']!.phase !== 'AwaitingDelivery'; tick += 1) {
      state = stepHarness(state);
      expect(state.completed).toEqual([]);
      expect(state.people['test-person']!.position).not.toEqual(state.benches[0]!.anchor);
      expect(state.people['test-person']!.position).not.toEqual(state.depots[0]!.anchor);
    }
    expect(state.jobs['test-job']!.phase).toBe('AwaitingDelivery');
    expect(state.people['test-person']!.position).toEqual(state.depots[0]!.position);
    state = stepHarness(state); state = stepHarness(state);
    expect(state.completed).toEqual(['test-job']);
    expect(state.active).toEqual([]);
    expect(state.notices).toEqual([]);
    expect(canonicalStringify(source)).toBe(before);
  });

  it('uses external distance then stable IDs and keeps a selected operational storage over a nearer one', () => {
    let state = harness();
    state.benches = [
      { ...state.benches[0]!, id: 'bench-z', position: { x: 0, y: 0 } },
      { ...state.benches[0]!, id: 'bench-a', position: { x: 1, y: 1 } },
    ];
    state = stepHarness(state);
    expect(state.jobs['test-job']!.worksiteId).toBe('bench-a');
    for (let tick = 0; tick < 20 && state.jobs['test-job']!.storageId === null; tick += 1) state = stepHarness(state);
    expect(state.jobs['test-job']!.storageId).toBe('depot');
    state = { ...state, depots: [{ id: 'closer', anchor: { x: 4, y: 2 }, position: { ...state.people['test-person']!.position }, ownerTransactionId: null }, ...state.depots] };
    state = stepHarness(state);
    expect(state.jobs['test-job']!.storageId).toBe('depot');
    state = { ...state, depots: state.depots.filter(site => site.id !== 'depot') };
    state = stepHarness(state);
    expect(state.jobs['test-job']!.storageId).toBe('closer');
    expect(state.completed).toEqual([]);
  });

  it('invalidates a route when the external entrance changes and never follows a stale destination', () => {
    let state = stepHarness(harness());
    expect(state.jobs['test-job']!.navigation.target).toEqual({ x: 1, y: 1 });
    state = { ...state, benches: state.benches.map(site => ({ ...site, position: { x: 1, y: 0 } })) };
    state = stepHarness(state);
    expect(state.jobs['test-job']!.navigation.target).toEqual({ x: 1, y: 0 });
    expect(state.jobs['test-job']!.navigation.path.at(-1)).toEqual({ x: 1, y: 0 });
    expect(state.jobs['test-job']!.activeTicks).toBe(0);
  });

  it('keeps canonical lookup and settlement rejection order, with no partial source edits', () => {
    const source = freeze(harness());
    const wrongAssignment = { ...source, people: { 'test-person': { ...source.people['test-person']!, assignmentTransactionId: null } } };
    expect(() => stepHarness(wrongAssignment)).toThrow('Production worker assignment mismatch');
    const missingRecipe = { ...harnessContext, recipe: () => undefined };
    expect(() => stepHarness({ ...source, people: {} }, missingRecipe)).toThrow('Production references a missing recipe');
    const cancelDenied: ProductionContext<Harness, HarnessJob> = { ...harnessContext,
      cancel: () => ({ ok: false, rejection: { code: 'INVALID_RESERVATION' } }) };
    expect(() => stepHarness({ ...source, people: {} }, cancelDenied)).toThrow('Cannot release unavailable worker reservation');
    let state = source;
    for (let tick = 0; tick < 40 && state.jobs['test-job']!.phase !== 'AwaitingDelivery'; tick += 1) state = stepHarness(state);
    const completionDenied: ProductionContext<Harness, HarnessJob> = { ...harnessContext,
      complete: () => ({ ok: false, rejection: { code: 'INVALID_RESERVATION' } }) };
    const before = canonicalStringify(state);
    expect(() => stepHarness(freeze(state), completionDenied)).toThrow('Cannot commit production: INVALID_RESERVATION');
    expect(canonicalStringify(state)).toBe(before);
    expect(() => runProductionPhases(source, harnessContext, createWorkPathBudget(1))).toThrow('Path budget belongs to another tick');
  });
});

describe('legacy authority remains closed after phase extraction', () => {
  it.each(['v7', 'v8'] as const)('rejects %s sect recipes, tagged command authority and tagged reservation meanings', version => {
    const source = createWorld(`phase-admission-${version}`);
    const world = version === 'v7' ? source : migrateWorldV7ToV8(source);
    const before = canonicalStringify(world);
    for (const recipeId of ['gather.stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'craft.wound-powder.v9', 'craft.wound-powder-alt.v9']) {
      expect(startProduction(world, 'attempt.sect', recipeId, 'entity:2')).toEqual({ ok: false, rejection: { code: 'UNKNOWN_RECIPE' } });
    }
    const command = { commandId: 'attempt.tagged', sequence: 0, issuedTick: 0, kind: 'production.start',
      payload: { workerId: 'entity:2', recipeId: 'craft.plank' } };
    const shape = version === 'v7' ? isCommand : isCommandV8;
    expect(shape(command)).toBe(true);
    for (const extra of [{ context: { catalog: 'sect-v9' } }, { origin: { kind: 'sect-plan', cycle: 1 } }, { ledger: 'sect' }, { researchUnlocked: true }]) {
      expect(shape({ ...command, payload: { ...command.payload, ...extra } })).toBe(false);
    }
    expect(shape({ ...command, kind: 'sect.command', payload: { kind: 'production.start', recipeId: 'gather.stone.v9' } })).toBe(false);
    expect(canonicalStringify(world)).toBe(before);
    const started = begin(world); const id = started.activeProductionTransactionIds[0]!;
    const validate = version === 'v7' ? validateWorldState : validateWorldStateV8;
    expect(validate(started)).toEqual([]);
    const sectRecipe = cloneJson(started); sectRecipe.transactions[id]!.recipeId = 'gather.stone.v9';
    expect(validate(sectRecipe)).toContain('Invalid production transaction');
    const taggedReservation = cloneJson(started);
    const reservation = taggedReservation.reservations[taggedReservation.transactions[id]!.reservationId]!;
    Object.assign(reservation.lines[0]!, { ledger: 'base' });
    expect(validate(taggedReservation)).toContain('Reservation does not match locked recipe inputs');
    const sectResource = cloneJson(started);
    Object.assign(sectResource.reservations[sectResource.transactions[id]!.reservationId]!.lines[0]!, { ledger: 'sect', resourceId: 'wound-powder' });
    expect(validate(sectResource).length).toBeGreaterThan(0);
  });
});
