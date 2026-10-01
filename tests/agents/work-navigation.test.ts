import { describe, expect, it } from 'vitest';
import { BLOCKED_PATH_RETRY_TICKS, cardinalDistance, emptyNavigation, findCardinalPath, isWalkable,
  MAX_PATH_REQUESTS_PER_TICK, MOVEMENT_TICKS_PER_CELL, sameCell } from '../../src/core/agents/navigation';
import { advanceWorkNavigation, advanceWorkNavigationWithBudget, createWorkPathBudget,
  type WorkNavigationEffect, type WorkNavigationInput, type WorkPathBudget } from '../../src/core/agents/work-navigation';
import { startProduction, tickProduction } from '../../src/core/economy/production';
import type { AutomaticWorld } from '../../src/core/economy/automatic-production';
import { checkedAdd } from '../../src/core/kernel/numeric';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { createWorld } from '../../src/core/world/create-world';
import type { GridPosition, WorldMap } from '../../src/core/world/types';

function map(blocked: GridPosition[] = []): WorldMap {
  return { width: 5, height: 4, seed: 'work-navigation', generationVersion: 1, navVersion: 7,
    tiles: Array.from({ length: 20 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), terrain: 'grass' as const,
      walkable: !blocked.some(cell => cell.x === index % 5 && cell.y === Math.floor(index / 5)) })) };
}
function input(overrides: Partial<WorkNavigationInput> = {}): WorkNavigationInput {
  return { map: map(), position: { x: 1, y: 1 }, target: { x: 3, y: 1 }, navigation: emptyNavigation(), simulationTick: 1, ...overrides };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Frozen pre-extraction production travel decisions; path search stays in the existing BFS. */
function legacyTravel(source: WorkNavigationInput, remaining: number): WorkNavigationEffect {
  const { map, position, target, simulationTick } = source;
  let navigation = source.navigation;
  const targetChanged = navigation.target === null || !sameCell(navigation.target, target);
  const versionChanged = navigation.routeVersion !== map.navVersion;
  const first = navigation.path[0];
  const invalidStep = first !== undefined && (!isWalkable(map, first) || cardinalDistance(position, first) !== 1);
  if (targetChanged || versionChanged || invalidStep) navigation = { ...emptyNavigation(), target: { x: target.x, y: target.y } };
  if (!isWalkable(map, position) || !isWalkable(map, target)) {
    return { status: 'path-blocked', navigation: { ...navigation, path: [], routeVersion: map.navVersion, movementTicks: 0,
      retryAtTick: checkedAdd(simulationTick, BLOCKED_PATH_RETRY_TICKS) }, position: null, traveling: false, pathRequestsUsed: 0 };
  }
  if (sameCell(position, target)) return { status: 'arrived', navigation: emptyNavigation(), position: null, traveling: false, pathRequestsUsed: 0 };
  let pathRequestsUsed: 0 | 1 = 0;
  if (navigation.path.length === 0) {
    if (simulationTick < navigation.retryAtTick) return { status: 'path-blocked', navigation, position: null, traveling: false, pathRequestsUsed };
    if (remaining === 0) return { status: 'path-budget-exhausted', navigation, position: null, traveling: false, pathRequestsUsed };
    pathRequestsUsed = 1;
    const path = findCardinalPath(map, position, target);
    navigation = { ...navigation, target: { x: target.x, y: target.y }, routeVersion: map.navVersion, path: path ?? [], movementTicks: 0,
      retryAtTick: path ? 0 : checkedAdd(simulationTick, BLOCKED_PATH_RETRY_TICKS) };
    if (!path) return { status: 'path-blocked', navigation, position: null, traveling: false, pathRequestsUsed };
  }
  const movementTicks = navigation.movementTicks + 1;
  if (movementTicks < MOVEMENT_TICKS_PER_CELL) return { status: 'moving', navigation: { ...navigation, movementTicks }, position: null, traveling: true, pathRequestsUsed };
  const nextPosition = navigation.path[0]!;
  const path = navigation.path.slice(1);
  const arrived = sameCell(nextPosition, target);
  return { status: arrived ? 'arrived' : 'moving', navigation: arrived ? emptyNavigation() : { ...navigation, path, movementTicks: 0 },
    position: nextPosition, traveling: !arrived, pathRequestsUsed };
}

function step(source: WorkNavigationInput, remaining = MAX_PATH_REQUESTS_PER_TICK): WorkNavigationEffect {
  const before = cloneJson(source);
  const result = advanceWorkNavigation(freeze(source), remaining);
  expect(result).toEqual(legacyTravel(source, remaining));
  expect(source).toEqual(before);
  return result;
}

describe('pure shared work navigation matches legacy travel decisions', () => {
  it('arrives at an already occupied target without spending budget or retaining movement', () => {
    const source = input({ target: { x: 1, y: 1 } });
    expect(step(source, 0)).toEqual({ status: 'arrived', navigation: emptyNavigation(), position: null, traveling: false, pathRequestsUsed: 0 });
  });

  it('starts the existing fixed cardinal path with exactly one elapsed movement tick', () => {
    const source = input({ target: { x: 2, y: 0 } });
    const result = step(source);
    expect(result).toMatchObject({ status: 'moving', position: null, traveling: true, pathRequestsUsed: 1,
      navigation: { path: [{ x: 1, y: 0 }, { x: 2, y: 0 }], target: source.target, routeVersion: 7, movementTicks: 1, retryAtTick: 0 } });
  });

  it('takes four ticks per cell, continues cached paths at zero budget, and resets on arrival', () => {
    let source = input();
    for (let tick = 1; tick <= 8; tick += 1) {
      const result = step(source, tick === 1 ? 4 : 0);
      expect(result.pathRequestsUsed).toBe(tick === 1 ? 1 : 0);
      expect(result.position).toEqual(tick % 4 === 0 ? { x: 1 + tick / 4, y: 1 } : null);
      expect(result.status).toBe(tick === 8 ? 'arrived' : 'moving');
      expect(result.navigation.movementTicks).toBe(tick % 4);
      source = { ...source, navigation: result.navigation, position: result.position ?? source.position, simulationTick: tick + 1 };
    }
    expect(source.navigation).toEqual(emptyNavigation());
  });

  it.each(['target', 'version', 'obstacle', 'non-cardinal'] as const)('discards partial movement when the %s changes', change => {
    let source = input();
    const planned = step(source);
    source = { ...source, navigation: { ...planned.navigation, movementTicks: 3 }, simulationTick: 4 };
    if (change === 'target') source = { ...source, target: { x: 1, y: 3 } };
    if (change === 'version') source = { ...source, map: { ...source.map, navVersion: 8 } };
    if (change === 'obstacle') source = { ...source, map: map([{ x: 2, y: 1 }]) };
    if (change === 'non-cardinal') source = { ...source, navigation: { ...source.navigation, path: [{ x: 4, y: 1 }, { x: 3, y: 1 }] } };
    const result = step(source);
    expect(result).toMatchObject({ status: 'moving', position: null, pathRequestsUsed: 1, navigation: { movementTicks: 1 } });
    expect(cardinalDistance(source.position, result.navigation.path[0]!)).toBe(1);
    expect(isWalkable(source.map, result.navigation.path[0]!)).toBe(true);
    expect(result.navigation.target).toEqual(source.target);
    expect(result.navigation.routeVersion).toBe(source.map.navVersion);
  });

  it('invalidates a changed route before budget deferral, then starts from zero movement', () => {
    const planned = step(input());
    const source = input({ navigation: { ...planned.navigation, movementTicks: 3 }, map: { ...map(), navVersion: 8 }, simulationTick: 4 });
    const deferred = step(source, 0);
    expect(deferred).toEqual({ status: 'path-budget-exhausted', navigation: { ...emptyNavigation(), target: source.target },
      position: null, traveling: false, pathRequestsUsed: 0 });
    expect(step({ ...source, navigation: deferred.navigation, simulationTick: 5 }).navigation.movementTicks).toBe(1);
  });

  it('waits exactly twenty ticks between failed path requests without teleporting', () => {
    const source = input({ map: map([0, 1, 2, 3].map(y => ({ x: 2, y }))) });
    const blocked = step(source);
    expect(blocked).toMatchObject({ status: 'path-blocked', position: null, traveling: false, pathRequestsUsed: 1,
      navigation: { path: [], movementTicks: 0, retryAtTick: 21, routeVersion: 7 } });
    for (let tick = 2; tick < 21; tick += 1) {
      expect(step({ ...source, simulationTick: tick, navigation: blocked.navigation })).toMatchObject({
        status: 'path-blocked', position: null, pathRequestsUsed: 0, navigation: { retryAtTick: 21 } });
    }
    expect(step({ ...source, simulationTick: 21, navigation: blocked.navigation })).toMatchObject({
      status: 'path-blocked', position: null, pathRequestsUsed: 1, navigation: { retryAtTick: 41 } });
    expect(step({ ...source, simulationTick: 21, navigation: blocked.navigation }, 0).status).toBe('path-budget-exhausted');
  });

  it('retries immediately after an authoritative navVersion change opens a route', () => {
    const blocked = step(input({ map: map([0, 1, 2, 3].map(y => ({ x: 2, y }))) }));
    const result = step(input({ simulationTick: 2, navigation: blocked.navigation, map: { ...map(), navVersion: 8 } }));
    expect(result).toMatchObject({ status: 'moving', pathRequestsUsed: 1, navigation: { movementTicks: 1, retryAtTick: 0, routeVersion: 8 } });
  });

  it.each(['origin', 'target', 'outside'] as const)('blocks an impassable %s without a path request or movement', kind => {
    const source = input(kind === 'outside' ? { target: { x: -1, y: 1 } } : { map: map([{ x: kind === 'origin' ? 1 : 3, y: 1 }]) });
    expect(step(source)).toMatchObject({ status: 'path-blocked', position: null, traveling: false, pathRequestsUsed: 0,
      navigation: { path: [], movementTicks: 0, retryAtTick: 21 } });
  });

  it('does not let later edits to an effect mutate its source navigation or coordinates', () => {
    const planned = step(input());
    const source = freeze(input({ navigation: planned.navigation }));
    const before = cloneJson(source);
    const result = step(source, 0);
    result.navigation.path[0]!.x = 4;
    result.navigation.target!.x = 4;
    expect(source).toEqual(before);
  });
});

describe('one internally owned bounded path budget for all jobs in a tick', () => {
  it('allows only four first paths across six jobs and serves deferred jobs next tick', () => {
    const budget = createWorkPathBudget(1);
    const jobs = Array.from({ length: 6 }, () => input());
    const first = jobs.map(job => advanceWorkNavigationWithBudget(job, budget));
    expect(first.map(effect => effect.pathRequestsUsed)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(first.map(effect => effect.status)).toEqual(['moving', 'moving', 'moving', 'moving', 'path-budget-exhausted', 'path-budget-exhausted']);
    expect(budget.remaining).toBe(0);
    const nextBudget = createWorkPathBudget(2);
    const second = jobs.map((job, index) => advanceWorkNavigationWithBudget({ ...job, navigation: first[index]!.navigation, simulationTick: 2 }, nextBudget));
    expect(second.map(effect => effect.pathRequestsUsed)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(nextBudget.remaining).toBe(2);
    expect(second.every(effect => effect.status === 'moving')).toBe(true);
  });

  it('charges unsuccessful searches but not blocked endpoints, same-cell arrivals, or retry waits', () => {
    const budget = createWorkPathBudget(1);
    const blocked = input({ map: map([0, 1, 2, 3].map(y => ({ x: 2, y }))) });
    const result = advanceWorkNavigationWithBudget(blocked, budget);
    expect(budget.remaining).toBe(3);
    advanceWorkNavigationWithBudget({ ...blocked, navigation: result.navigation }, budget);
    advanceWorkNavigationWithBudget(input({ target: { x: 1, y: 1 } }), budget);
    advanceWorkNavigationWithBudget(input({ map: map([{ x: 3, y: 1 }]) }), budget);
    expect(budget.remaining).toBe(3);
  });

  it('rejects cross-tick reuse and forged budgets before they can author movement', () => {
    const budget = createWorkPathBudget(1);
    expect(() => advanceWorkNavigationWithBudget(input({ simulationTick: 2 }), budget)).toThrow(RangeError);
    expect(budget.remaining).toBe(4);
    expect(() => advanceWorkNavigationWithBudget(input(), { simulationTick: 1, remaining: 4 } as WorkPathBudget)).toThrow(RangeError);
    expect(() => Object.assign(budget, { remaining: 100 })).toThrow(TypeError);
    expect(budget.remaining).toBe(4);
  });
});

describe('navigation rejects invalid numeric inputs before any debit or source edit', () => {
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid tick %s', simulationTick => {
    expect(() => createWorkPathBudget(simulationTick)).toThrow(RangeError);
    expect(() => advanceWorkNavigation(input({ simulationTick }), 4)).toThrow(RangeError);
  });

  it.each([-1, 0.5, NaN, Infinity, 5])('rejects invalid remaining request count %s', remaining => {
    expect(() => advanceWorkNavigation(input(), remaining)).toThrow(RangeError);
  });

  it('rejects malformed maps, coordinates and navigation counters without debiting', () => {
    const fixtures: WorkNavigationInput[] = [
      input({ map: { ...map(), width: 257 } }), input({ map: { ...map(), height: 0 } }), input({ map: { ...map(), navVersion: -1 } }),
      input({ position: { x: 0.5, y: 1 } }), input({ target: { x: Infinity, y: 1 } }),
      input({ navigation: { ...emptyNavigation(), movementTicks: 4 } }), input({ navigation: { ...emptyNavigation(), retryAtTick: -1 } }),
      input({ navigation: { ...emptyNavigation(), routeVersion: -1 } }), input({ navigation: { ...emptyNavigation(), path: [{ x: NaN, y: 1 }] } }),
      input({ navigation: { ...emptyNavigation(), path: new Array<GridPosition>(2) } }),
    ];
    const budget = createWorkPathBudget(1);
    for (const fixture of fixtures) expect(() => advanceWorkNavigationWithBudget(freeze(fixture), budget)).toThrow(RangeError);
    expect(budget.remaining).toBe(4);
  });

  it('throws safely at the retry tick ceiling without consuming the shared budget', () => {
    const simulationTick = Number.MAX_SAFE_INTEGER;
    const budget = createWorkPathBudget(simulationTick);
    const source = freeze(input({ simulationTick, map: map([0, 1, 2, 3].map(y => ({ x: 2, y }))) }));
    const before = cloneJson(source);
    expect(() => advanceWorkNavigationWithBudget(source, budget)).toThrow(RangeError);
    expect(budget.remaining).toBe(4);
    expect(source).toEqual(before);
  });
});

function begin<W extends AutomaticWorld>(source: W, workerIndex = 1, recipeId = 'craft.plank'): W {
  const started = startProduction(source, `shared-path.${workerIndex}`, recipeId, source.disciples[workerIndex]!.id);
  if (!started.ok) throw new Error(started.rejection.code);
  return started.world;
}
function nextTick<W extends AutomaticWorld>(source: W): W {
  return { ...source, clock: { ...source.clock, simulationTick: source.clock.simulationTick + 1, calendarTick: source.clock.calendarTick + 1 } };
}

describe('production remains the versioned authority and a backward-compatible navigation wrapper', () => {
  it.each(['v7', 'v8'] as const)('keeps %s default and explicit-budget Worlds byte-identical through actual work and delivery', version => {
    const created = createWorld(`navigation-port-${version}`);
    let implicit = begin(version === 'v7' ? created : migrateWorldV7ToV8(created));
    let explicit = cloneJson(implicit);
    const original = cloneJson(implicit);
    for (let tick = 0; tick < 300 && implicit.activeProductionTransactionIds.length; tick += 1) {
      const source = nextTick(explicit);
      implicit = tickProduction(nextTick(implicit));
      explicit = tickProduction(source, createWorkPathBudget(source.clock.simulationTick));
      expect(canonicalStringify(explicit)).toBe(canonicalStringify(implicit));
    }
    expect(implicit.activeProductionTransactionIds).toEqual([]);
    expect(implicit.inventory.plank.owned).toBe(2);
    expect(implicit.inventory.wood.owned).toBe(original.inventory.wood.owned - 3);
    expect(implicit.events.filter(event => event.kind === 'production.committed')).toHaveLength(1);
    expect(implicit.commandReceipts).toEqual(original.commandReceipts);
    expect(implicit.randomStreams).toEqual(original.randomStreams);
  });

  it('shares the same four requests with unrelated work and preserves production order', () => {
    const source = freeze(begin(nextTick(begin(createWorld('shared-budget-production'), 1, 'craft.plank')), 2, 'gather.wood'));
    const before = cloneJson(source);
    const budget = createWorkPathBudget(source.clock.simulationTick);
    for (let request = 0; request < 3; request += 1) advanceWorkNavigationWithBudget(input({ simulationTick: source.clock.simulationTick }), budget);
    const next = tickProduction(source, budget);
    const [firstId, secondId] = source.activeProductionTransactionIds;
    expect(next.transactions[firstId!]!.navigation.movementTicks).toBe(1);
    expect(next.transactions[secondId!]!.navigation.path).toEqual([]);
    expect(next.transactions[secondId!]!.navigation.movementTicks).toBe(0);
    expect(next.disciples[2]!.position).toEqual(source.disciples[2]!.position);
    expect(next.transactions[firstId!]!.activeTicks).toBe(0);
    expect(next.transactions[secondId!]!.activeTicks).toBe(0);
    expect(next.sequences).toEqual(source.sequences);
    expect(next.events).toEqual(source.events);
    expect(budget.remaining).toBe(0);
    expect(source).toEqual(before);
  });

  it('does not grant same-cell productive work until the next tick', () => {
    let source = createWorld('same-cell-production');
    const station = source.buildings.find(building => building.blueprintId === 'workshop')!;
    source = begin({ ...source, disciples: source.disciples.map((worker, index) => index === 1 ? { ...worker, position: { x: station.x, y: station.y } } : worker) });
    const id = source.activeProductionTransactionIds[0]!;
    const budget = createWorkPathBudget(source.clock.simulationTick);
    const arrived = tickProduction(source, budget);
    expect(arrived.transactions[id]).toMatchObject({ phase: 'Working', activeTicks: 0, navigation: emptyNavigation() });
    expect(budget.remaining).toBe(4);
    expect(tickProduction(nextTick(arrived)).transactions[id]!.activeTicks).toBe(1);
  });

  it('retains an existing PATH_BLOCKED reason under exhausted budget without duplicate events', () => {
    let source = createWorld('blocked-budget-production');
    source = begin({ ...source, map: { ...source.map, tiles: source.map.tiles.map(tile => ({ ...tile, walkable: tile.x !== 8 })) } });
    source = tickProduction(source);
    const id = source.activeProductionTransactionIds[0]!;
    expect(source.transactions[id]!.blockedReason).toBe('PATH_BLOCKED');
    const retry = { ...source, clock: { ...source.clock, simulationTick: BLOCKED_PATH_RETRY_TICKS } };
    const budget = createWorkPathBudget(retry.clock.simulationTick);
    for (let request = 0; request < 4; request += 1) advanceWorkNavigationWithBudget(input({ simulationTick: retry.clock.simulationTick }), budget);
    const deferred = tickProduction(retry, budget);
    expect(deferred.transactions[id]).toEqual(retry.transactions[id]);
    expect(deferred.events).toEqual(retry.events);
    expect(deferred.sequences).toEqual(retry.sequences);
    expect(deferred.disciples[1]!.position).toEqual(retry.disciples[1]!.position);
  });

  it('cannot bypass pause or management mode with an available budget', () => {
    const source = begin(createWorld('paused-navigation-port'));
    const budget = createWorkPathBudget(source.clock.simulationTick);
    const paused = { ...source, clock: { ...source.clock, pauseReasons: ['player' as const] } };
    const combat = { ...source, clock: { ...source.clock, mode: 'combat' as const } };
    expect(tickProduction(paused, budget)).toBe(paused);
    expect(tickProduction(combat, budget)).toBe(combat);
    expect(budget.remaining).toBe(4);
    expect(() => tickProduction(source, createWorkPathBudget(1))).toThrow(RangeError);
  });

  it('cannot use a forged budget callback to teleport an assigned production worker', () => {
    const source = freeze(begin(createWorld('forged-navigation-budget')));
    const before = cloneJson(source);
    let called = false;
    const forged = { simulationTick: source.clock.simulationTick, remaining: 4,
      advance: () => { called = true; return { status: 'arrived', navigation: emptyNavigation(), position: { x: 11, y: 5 }, traveling: false, pathRequestsUsed: 0 }; } };
    expect(() => tickProduction(source, forged as unknown as WorkPathBudget)).toThrow(RangeError);
    expect(called).toBe(false);
    expect(source).toEqual(before);
  });
});
