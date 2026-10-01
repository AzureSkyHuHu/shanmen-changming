import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { getSectBuildingDefinition } from '../../src/content/sect-v9/catalog';
import { createWorkPathBudget, advanceWorkNavigationWithBudget } from '../../src/core/agents/work-navigation';
import { emptyNavigation, sameCell } from '../../src/core/agents/navigation';
import { startProduction, tickProduction } from '../../src/core/economy/production';
import { tickClock } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { applyConstructionCommand, constructionClaims, constructionEffectiveMap, createConstructionFrame, previewConstructionPlacement, tickConstruction } from '../../src/core/sect-expansion/construction';
import { CONSTRUCTION_LIMITS, type ConstructionCommand, type ConstructionContext, type ConstructionFrame, type ConstructionPerson, type ConstructionResult } from '../../src/core/sect-expansion/construction-types';
import { CONSTRUCTION_DESCRIPTOR_NODE_BOUND, validateConstructionFrame } from '../../src/core/sect-expansion/construction-validation';
import { reserveSectResources } from '../../src/core/sect-expansion/ledger';
import type { SectPlacementRequest } from '../../src/core/sect-expansion/types';
import { createWorld } from '../../src/core/world/create-world';
import type { WorldState } from '../../src/core/world/types';

const request = (x = 1, y = 1): SectPlacementRequest => ({ definitionId: 'library.v9', anchor: { x, y }, rotation: 0 });
function context(frame: ConstructionFrame, patch: Partial<ConstructionContext> = {}): ConstructionContext {
  return { simulationTick: frame.lastSimulationTick, calendarTick: frame.lastCalendarTick, mode: 'management', paused: false,
    expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch };
}
function accept(result: ConstructionResult): ConstructionFrame {
  if (!result.ok) throw new Error(`Construction rejected: ${result.code}; source issues ${JSON.stringify(validateConstructionFrame(result.frame))}`);
  return result.frame;
}
function command(frame: ConstructionFrame, body: Omit<Extract<ConstructionCommand, { kind: 'blueprint.place' }>, 'commandId' | 'expectedRevision'>
  | Omit<Extract<ConstructionCommand, { kind: 'construction.start' }>, 'commandId' | 'expectedRevision'>
  | Omit<Extract<ConstructionCommand, { kind: 'construction.cancel' }>, 'commandId' | 'expectedRevision'>, id = `command:${frame.revision}`): ConstructionCommand {
  return { commandId: id, expectedRevision: frame.revision, ...body };
}
function place(frame: ConstructionFrame, placement = request()): ConstructionFrame {
  return accept(applyConstructionCommand(frame, context(frame), command(frame, { kind: 'blueprint.place', placement })));
}
function start(frame: ConstructionFrame, workerId = 'entity:2', bp = frame.blueprints.at(-1)!.blueprintId): ConstructionFrame {
  return accept(applyConstructionCommand(frame, context(frame), command(frame, { kind: 'construction.start', blueprintId: bp, workerId })));
}
function cancel(frame: ConstructionFrame, bp = frame.blueprints.at(-1)!.blueprintId): ConstructionFrame {
  return accept(applyConstructionCommand(frame, context(frame), command(frame, { kind: 'construction.cancel', blueprintId: bp })));
}
function step(frame: ConstructionFrame, patch: Partial<ConstructionContext> = {}): ConstructionFrame {
  const ctx = context(frame, { simulationTick: frame.lastSimulationTick + 1, calendarTick: frame.lastCalendarTick + 1, ...patch });
  return accept(tickConstruction(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
}
function until(frame: ConstructionFrame, predicate: (value: ConstructionFrame) => boolean, max = 1200): ConstructionFrame {
  let current = frame;
  for (let tick = 0; tick < max && !predicate(current); tick++) current = step(current);
  expect(predicate(current)).toBe(true); return current;
}
function actor(frame: ConstructionFrame, patch: Partial<ConstructionPerson>, workerId = 'entity:2'): ConstructionFrame {
  return { ...frame, people: frame.people.map(person => person.id === workerId ? { ...person, ...patch } : person) };
}
function produce(world: WorldState, recipeId: string, commandId: string): WorldState {
  const begin = startProduction(world, commandId, recipeId, 'entity:4');
  if (!begin.ok) throw new Error(begin.rejection.code);
  let current = begin.world;
  for (let ticks = 0; ticks < 1000 && current.activeProductionTransactionIds.includes(begin.transactionId); ticks++) {
    current = tickProduction({ ...current, clock: tickClock(current.clock) });
  }
  expect(current.activeProductionTransactionIds).not.toContain(begin.transactionId);
  return current;
}
function project(world: WorldState): ConstructionFrame {
  return createConstructionFrame({ map: world.map,
    legacyStations: world.buildings.map(station => ({ id: station.id, blueprintId: station.blueprintId, x: station.x, y: station.y, operational: station.operational })),
    people: world.disciples.map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState, canWork: person.canWork,
      away: false, productionTransactionId: person.assignmentTransactionId, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick });
}
let prepared: ConstructionFrame; let twoSites: ConstructionFrame;
beforeAll(() => {
  // Real starter production, real travel, real work, real delivery. No post-start resource grants.
  let world = createWorld('construction-real-starter');
  world = produce(world, 'craft.plank', 'prepare.plank.1'); world = produce(world, 'craft.plank', 'prepare.plank.2');
  prepared = project(world);
  world = produce(world, 'gather.wood', 'prepare.wood.1'); world = produce(world, 'gather.wood', 'prepare.wood.2');
  world = produce(world, 'craft.plank', 'prepare.plank.3'); world = produce(world, 'craft.plank', 'prepare.plank.4');
  twoSites = project(world);
});
const initial = (): ConstructionFrame => cloneJson(prepared);
function unchangedRejection(frame: ConstructionFrame, ctx: ConstructionContext, cmd: ConstructionCommand, code: string): void {
  const before = canonicalStringify(frame); const result = applyConstructionCommand(frame, ctx, cmd);
  expect(result).toMatchObject({ ok: false, code }); expect(result.frame).toBe(frame); expect(canonicalStringify(frame)).toBe(before);
}

describe('isolated catalog-owned construction on the actual starter map', () => {
  it('uses a soft bounded blueprint without materials or collision, then rechecks all current state at start', () => {
    const raw = project(createWorld('construction-no-grants')); const before = canonicalStringify(raw);
    let frame = place(raw);
    expect(frame.ledger).toEqual(raw.ledger); expect(frame.map.navVersion).toBe(raw.map.navVersion);
    expect(constructionEffectiveMap(frame).tiles.filter(tile => tile.walkable)).toHaveLength(140);
    expect(canonicalStringify(raw)).toBe(before);
    unchangedRejection(frame, context(frame), command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' }), 'INSUFFICIENT_INVENTORY');
    frame = cancel(frame); expect(frame.blueprints[0]!.status).toBe('cancelled'); expect(frame.ledger.reservations).toEqual([]);
  });
  it('builds one real library after storage/site travel and exactly 320 productive ticks, with two real debits', () => {
    const origin = initial(); let frame = start(place(origin));
    const startFrame = cloneJson(frame); const originalWood = frame.ledger.inventory.wood.owned;
    expect(constructionClaims(frame).map(claim => claim.kind)).toEqual(['worker', 'seat', 'entrance']);
    expect(constructionEffectiveMap(frame).tiles.filter(tile => tile.walkable)).toHaveLength(136);
    expect(frame.map.tiles.filter(tile => tile.walkable)).toHaveLength(140);
    frame = until(frame, value => value.jobs[0]!.phase === 'working');
    const visit = frame.jobs[0]!;
    expect(visit.origin).toEqual({ x: 6, y: 5 }); expect(visit.storageVisit!.tick - visit.startedTick).toBe(4);
    expect(visit.storageVisit!.position).toEqual({ x: 7, y: 5 }); expect(visit.siteVisit!.position).toEqual({ x: 1, y: 3 });
    expect(visit.siteVisit!.tick).toBeGreaterThan(visit.storageVisit!.tick); expect(visit.activeTicks).toBe(0);
    frame = until(frame, value => value.jobs[0]!.activeTicks === 159);
    expect(frame.ledger.inventory.wood.owned).toBe(originalWood); expect(frame.ledger.inventory.wood.reserved).toBe(8);
    frame = step(frame);
    expect(frame.jobs[0]!.activeTicks).toBe(160); expect(frame.ledger.inventory.wood.owned).toBe(originalWood - 4); expect(frame.ledger.inventory.wood.reserved).toBe(4);
    frame = until(frame, value => value.jobs[0]!.phase === 'completed');
    expect(frame.jobs[0]!.activeTicks).toBe(getSectBuildingDefinition('library.v9')!.levels[0]!.workTicks);
    expect(frame.buildings).toHaveLength(1); expect(frame.jobs[0]!.terminal!.buildingId).toBe(frame.buildings[0]!.buildingId);
    expect(frame.buildings[0]!.firstMaintenanceCalendarTick).toBe(frame.lastCalendarTick + 1200);
    expect(frame.ledger.inventory.wood).toMatchObject({ owned: originalWood - 8, reserved: 0 });
    expect(frame.ledger.inventory.stone.owned).toBe(origin.ledger.inventory.stone.owned - 4);
    expect(frame.ledger.inventory.plank.owned).toBe(0); expect(constructionClaims(frame)).toEqual([]);
    expect(frame.people.find(person => person.id === 'entity:2')!.position).toEqual({ x: 1, y: 3 });
    expect(frame.map.navVersion).toBe(origin.map.navVersion + 2); expect(frame.nextId).toBe(startFrame.nextId);
    expect(validateConstructionFrame(frame)).toEqual([]); expect(startFrame.jobs[0]!.activeTicks).toBe(0);
  });
  it('same-cell storage arrival still consumes its own boundary and never earns construction work', () => {
    let frame = start(place(actor(initial(), { position: { x: 7, y: 5 } })));
    expect(frame.jobs[0]!.storageVisit).toBeNull(); const started = frame.lastSimulationTick;
    frame = step(frame);
    expect(frame.jobs[0]!.phase).toBe('to-site'); expect(frame.jobs[0]!.storageVisit!.tick).toBe(started + 1);
    expect(frame.jobs[0]!.siteVisit).toBeNull(); expect(frame.jobs[0]!.activeTicks).toBe(0);
    expect(validateConstructionFrame(frame)).toEqual([]);
  });
  it.each(['storage', 'site'] as const)('rejects a saved %s journey shorter than actual cardinal movement allows', leg => {
    const frame = until(start(place(initial())), value => value.jobs[0]!.phase === 'working');
    expect(validateConstructionFrame(frame)).toEqual([]);
    const job = frame.jobs[0]!;
    const impossible = { ...frame, jobs: [{ ...job, ...(leg === 'storage'
      ? { storageVisit: { ...job.storageVisit!, tick: job.startedTick + 1 } }
      : { siteVisit: { ...job.siteVisit!, tick: job.storageVisit!.tick + 1 } }) }] };
    expect(validateConstructionFrame(impossible)).toContainEqual({ code: 'IMPOSSIBLE_TRAVEL_DURATION', path: job.jobId });
    const cmd = command(impossible, { kind: 'construction.cancel', blueprintId: impossible.blueprints[0]!.blueprintId });
    unchangedRejection(impossible, context(impossible), cmd, 'INVALID_FRAME');
  });
  it.each(['to-storage', 'to-site', 'before-half', 'after-half'] as const)('cancels %s with only the unpaid release and no teleport', stage => {
    let frame = start(place(initial()));
    if (stage === 'to-storage') frame = actor(frame, { position: { x: 10, y: 6 } }); // Explicit position/route pressure fixture.
    if (stage === 'to-site') frame = until(frame, value => value.jobs[0]!.phase === 'to-site');
    if (stage === 'before-half') frame = until(frame, value => value.jobs[0]!.activeTicks === 159);
    if (stage === 'after-half') frame = until(frame, value => value.jobs[0]!.activeTicks === 161);
    if (stage === 'to-storage' || stage === 'to-site') { for (let n = 0; n < 4; n++) frame = step(frame); }
    const position = cloneJson(frame.people.find(person => person.id === 'entity:2')!.position); const owned = frame.ledger.inventory.wood.owned;
    const pending = frame.ledger.inventory.wood.reserved; const cmd = command(frame, { kind: 'construction.cancel', blueprintId: frame.blueprints[0]!.blueprintId });
    const cancelled = accept(applyConstructionCommand(frame, context(frame), cmd));
    expect(cancelled.people.find(person => person.id === 'entity:2')!.position).toEqual(position);
    expect(cancelled.ledger.inventory.wood).toMatchObject({ owned, reserved: 0 }); expect(cancelled.buildings).toHaveLength(0);
    expect(cancelled.jobs[0]!.terminal!.released).toContainEqual({ ledger: 'base', resourceId: 'wood', quantity: pending });
    expect(cancelled.jobs[0]!.terminal!.consumed).toEqual(frame.ledger.reservations[0]!.base.consumed.map(line => ({ ledger: 'base', ...line })));
    expect(constructionClaims(cancelled)).toEqual([]); expect(constructionEffectiveMap(cancelled).tiles.filter(tile => tile.walkable)).toHaveLength(140);
    expect(applyConstructionCommand(cancelled, context(cancelled), cmd)).toMatchObject({ ok: true, repeated: true, frame: cancelled });
    unchangedRejection(cancelled, context(cancelled), command(cancelled, { kind: 'construction.cancel', blueprintId: cancelled.blueprints[0]!.blueprintId }), 'TRANSACTION_FINISHED');
  });
  it('rejects an overlapping soft claim and preserves last available materials against a competing order', () => {
    let frame = place(initial());
    unchangedRejection(frame, context(frame), command(frame, { kind: 'blueprint.place', placement: request(2, 1) }), 'PLACEMENT_CHANGED');
    frame = place(frame, request(9, 1)); frame = start(frame, 'entity:2', frame.blueprints[0]!.blueprintId);
    unchangedRejection(frame, context(frame), command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[1]!.blueprintId, workerId: 'entity:3' }), 'INSUFFICIENT_INVENTORY');
    unchangedRejection(frame, context(frame), command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[1]!.blueprintId, workerId: 'entity:2' }), 'WORKER_UNAVAILABLE');
    const extra = reserveSectResources(frame.ledger, { reservationId: 'other.reserve', ownerTransactionId: 'other.work' }, [{ ledger: 'base', resourceId: 'plank', quantity: 1 }], 'on-completion');
    expect(extra).toMatchObject({ ok: false, rejection: { code: 'INSUFFICIENT_INVENTORY' } });
  });
  it('supports independent funded sites and invalidates all local routes when collision changes', () => {
    let frame = start(place(cloneJson(twoSites)));
    frame = step(frame); frame = step(frame); expect(frame.jobs[0]!.navigation.path.length).toBeGreaterThan(0);
    frame = place(frame, request(9, 1)); const oldVersion = frame.map.navVersion;
    frame = start(frame, 'entity:4'); expect(frame.map.navVersion).toBe(oldVersion + 1);
    expect(frame.jobs.every(job => job.navigation.path.length === 0 && job.navigation.routeVersion === null)).toBe(true);
    frame = until(frame, value => value.buildings.length === 2);
    expect(new Set(frame.buildings.map(building => building.buildingId)).size).toBe(2); expect(constructionClaims(frame)).toEqual([]);
  });
  it.each([
    { productionTransactionId: 'production:1' }, { cultivationOwnerId: 'seclusion:1' }, { otherOwnerId: 'care:1' },
    { away: true }, { canWork: false }, { lifeState: 'pendingDeath' as const }, { lifeState: 'dead' as const },
  ])('rejects an ineligible or externally owned worker %s before reservation', patch => {
    const frame = actor(place(initial()), patch);
    unchangedRejection(frame, context(frame), command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' }), 'WORKER_UNAVAILABLE');
  });
  it.each(['worker', 'seat', 'entrance'] as const)('honors explicit external %s ownership', kind => {
    const frame = place(initial()); const token = kind === 'worker' ? 'entity:2' : kind === 'seat' ? frame.blueprints[0]!.blueprintId : '1,3';
    const ctx = context(frame, { externalClaims: [{ kind, key: token, ownerId: 'external:1' }] });
    unchangedRejection(frame, ctx, command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' }), 'CLAIM_CONFLICT');
  });
  it('pauses, combat and expeditions never earn work; clock gaps cannot buy elapsed progress', () => {
    let frame = until(start(place(initial())), value => value.jobs[0]!.activeTicks === 12);
    const sameTick = context(frame, { paused: true });
    expect(tickConstruction(frame, sameTick, createWorkPathBudget(sameTick.simulationTick))).toMatchObject({ ok: true, repeated: true, frame });
    const gap = context(frame, { simulationTick: frame.lastSimulationTick + 100, calendarTick: frame.lastCalendarTick + 100 });
    expect(tickConstruction(frame, gap, createWorkPathBudget(gap.simulationTick))).toMatchObject({ ok: false, code: 'CLOCK_GAP', frame });
    frame = step(frame, { mode: 'combat', calendarTick: frame.lastCalendarTick }); expect(frame.jobs[0]!.activeTicks).toBe(12);
    frame = step(frame, { expeditionActive: true }); expect(frame.jobs[0]!.activeTicks).toBe(12);
    frame = step(frame); expect(frame.jobs[0]!.activeTicks).toBe(13); expect(frame.jobs[0]!.workSpans).toHaveLength(2);
  });
  it('current-state placement rejects stale preview, roads, water, people, entrances and disconnected home anchors', () => {
    const original = initial(); expect(previewConstructionPlacement(original, context(original), request()).ok).toBe(true);
    let frame = actor(place(original), { position: { x: 1, y: 1 } }, 'entity:3');
    unchangedRejection(frame, context(frame), command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' }), 'PLACEMENT_CHANGED');
    for (const placement of [request(6, 1), request(6, 7), { ...request(8, 0), rotation: 90 as const }]) {
      unchangedRejection(original, context(original), command(original, { kind: 'blueprint.place', placement }), 'PLACEMENT_CHANGED');
    }
    frame = { ...original, map: { ...original.map, tiles: original.map.tiles.map(tile => tile.x === 1 && tile.y === 1 ? { ...tile, terrain: 'water' as const } : tile) } };
    unchangedRejection(frame, context(frame), command(frame, { kind: 'blueprint.place', placement: request() }), 'PLACEMENT_CHANGED');
    // Explicit starter-map obstacle pressure fixture: a library would close the wall's only two-cell gap.
    frame = { ...original, map: { ...original.map, tiles: original.map.tiles.map(tile => tile.x === 3 && tile.y !== 1 && tile.y !== 2 ? { ...tile, walkable: false } : tile) } };
    unchangedRejection(frame, context(frame), command(frame, { kind: 'blueprint.place', placement: { ...request(2, 1), rotation: 270 } }), 'PLACEMENT_CHANGED');
  });
  it('invalidates and waits for a newly blocked route instead of walking through the obstacle', () => {
    let frame = start(place(initial())); frame = until(frame, value => value.jobs[0]!.phase === 'to-site'); frame = step(frame);
    const position = cloneJson(frame.people.find(person => person.id === 'entity:2')!.position);
    // Explicit external obstacle pressure fixture on the actual map, with authoritative nav invalidation.
    frame = { ...frame, map: { ...frame.map, navVersion: frame.map.navVersion + 1,
      tiles: frame.map.tiles.map(tile => tile.x === 3 ? { ...tile, walkable: false } : tile) } };
    frame = step(frame); expect(frame.jobs[0]!.blocked).toBe('PATH_BLOCKED'); expect(frame.jobs[0]!.activeTicks).toBe(0);
    expect(frame.people.find(person => person.id === 'entity:2')!.position).toEqual(position);
    const cancelled = cancel(frame); expect(cancelled.people.find(person => person.id === 'entity:2')!.position).toEqual(position);
  });
  it('shares the four-request budget and neither hides an independent BFS nor grants work on budget exhaustion', () => {
    let frame = actor(start(place(initial())), { position: { x: 10, y: 6 } }); // Travel pressure fixture.
    const ctx = context(frame, { simulationTick: frame.lastSimulationTick + 1, calendarTick: frame.lastCalendarTick + 1 });
    const budget = createWorkPathBudget(ctx.simulationTick);
    for (let i = 0; i < 4; i++) advanceWorkNavigationWithBudget({ map: frame.map, position: { x: 0, y: 0 }, target: { x: 1, y: 0 }, navigation: emptyNavigation(), simulationTick: ctx.simulationTick }, budget);
    expect(budget.remaining).toBe(0); const position = frame.people.find(person => person.id === 'entity:2')!.position;
    frame = accept(tickConstruction(frame, ctx, budget)); expect(frame.jobs[0]!.blocked).toBe('PATH_BUDGET'); expect(frame.jobs[0]!.activeTicks).toBe(0);
    expect(frame.people.find(person => person.id === 'entity:2')!.position).toEqual(position);
    frame = step(frame); expect(frame.jobs[0]!.navigation.path.length).toBeGreaterThan(0);
  });
  it.each(['person', 'terrain'] as const)('completion rechecks %s conflicts before the remainder and never crushes a person', obstacle => {
    let frame = until(start(place(initial())), value => value.jobs[0]!.activeTicks === 319);
    const priorPosition = frame.people.find(person => person.id === 'entity:3')!.position;
    if (obstacle === 'person') frame = actor(frame, { position: { x: 1, y: 1 } }, 'entity:3');
    else frame = { ...frame, map: { ...frame.map, navVersion: frame.map.navVersion + 1, tiles: frame.map.tiles.map(tile => tile.x === 1 && tile.y === 1 ? { ...tile, walkable: false } : tile) } };
    frame = step(frame); expect(frame.jobs[0]!.activeTicks).toBe(320); expect(frame.jobs[0]!.blocked).toBe('PLACEMENT_CHANGED');
    expect(frame.buildings).toHaveLength(0); expect(frame.ledger.inventory.wood.reserved).toBe(4); expect(frame.ledger.reservations[0]!.base.checkpoints).toHaveLength(1);
    if (obstacle === 'person') {
      expect(frame.people.find(person => person.id === 'entity:3')!.position).toEqual({ x: 1, y: 1 });
      frame = actor(frame, { position: priorPosition }, 'entity:3'); frame = step(frame); expect(frame.buildings).toHaveLength(1); expect(frame.jobs[0]!.activeTicks).toBe(320);
    } else {
      const cancelled = cancel(frame); expect(cancelled.buildings).toHaveLength(0); expect(cancelled.ledger.inventory.wood.reserved).toBe(0); expect(cancelled.jobs[0]!.terminal!.consumed).toContainEqual({ ledger: 'base', resourceId: 'wood', quantity: 4 });
    }
  });
  it('does not refund completed construction and returns exact original command retries after terminal completion', () => {
    let frame = place(initial()); const cmd = command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' });
    frame = accept(applyConstructionCommand(frame, context(frame), cmd)); frame = until(frame, value => value.buildings.length === 1);
    const before = canonicalStringify(frame);
    expect(applyConstructionCommand(frame, context(frame), cmd)).toMatchObject({ ok: true, repeated: true, frame });
    unchangedRejection(frame, context(frame), { ...cmd, expectedRevision: frame.revision }, 'IDENTITY_CONFLICT');
    unchangedRejection(frame, context(frame), command(frame, { kind: 'construction.cancel', blueprintId: frame.blueprints[0]!.blueprintId }), 'TRANSACTION_FINISHED');
    expect(canonicalStringify(frame)).toBe(before);
  });
  it('rejects stale commands and caller prices, work, research or completion flags without any source mutation', () => {
    const frame = place(initial());
    unchangedRejection(frame, context(frame), { commandId: 'stale', expectedRevision: 0, kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' }, 'STALE_REVISION');
    const base = command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' });
    for (const extra of [{ costs: [] }, { workComplete: true }, { requiredResearch: [] }, { researchCompleted: true }, { activeTicks: 320 }]) {
      unchangedRejection(frame, context(frame), { ...base, ...extra } as ConstructionCommand, 'INVALID_COMMAND');
    }
    const alchemy = { ...request(9, 1), definitionId: 'alchemy.v9' as const };
    unchangedRejection(frame, context(frame), command(frame, { kind: 'blueprint.place', placement: alchemy }), 'RESEARCH_AUTHORITY_REQUIRED');
  });
  it.each(['to-storage', 'to-site', 'working', 'half', 'completed', 'cancelled'] as const)('save-shaped %s roundtrips continue to exactly the same domain result', phase => {
    let frame = start(place(initial()));
    if (phase === 'to-site') frame = until(frame, value => value.jobs[0]!.phase === 'to-site');
    if (phase === 'working') frame = until(frame, value => value.jobs[0]!.activeTicks === 5);
    if (phase === 'half') frame = until(frame, value => value.jobs[0]!.activeTicks === 160);
    if (phase === 'completed') frame = until(frame, value => value.jobs[0]!.phase === 'completed');
    if (phase === 'cancelled') frame = cancel(frame);
    const restored = JSON.parse(JSON.stringify(frame)) as ConstructionFrame; expect(validateConstructionFrame(restored)).toEqual([]);
    const terminal = (value: ConstructionFrame): boolean => value.jobs[0]!.terminal !== null;
    const uninterrupted = until(frame, terminal); const continued = until(restored, terminal);
    expect(canonicalStringify(continued)).toBe(canonicalStringify(uninterrupted));
    // This is domain JSON continuation, explicitly not a v9 World codec or provenance validation.
  });
  it('bounds retained terminal history without silent truncation and preserves the cancellation path', () => {
    let frame = initial();
    for (let n = 0; n < CONSTRUCTION_LIMITS.records; n++) frame = cancel(place(frame));
    expect(frame.blueprints).toHaveLength(CONSTRUCTION_LIMITS.records); expect(frame.receipts).toHaveLength(CONSTRUCTION_LIMITS.records * 2);
    unchangedRejection(frame, context(frame), command(frame, { kind: 'blueprint.place', placement: request() }), 'CAPACITY_EXCEEDED');
    const restored = JSON.parse(JSON.stringify(frame)); expect(validateConstructionFrame(restored)).toEqual([]);
  });
  it('rejects global active-job and numeric pressure before admission while retaining an ordinary cancel', () => {
    let frame = place(initial());
    const cmd = command(frame, { kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' });
    unchangedRejection(frame, context(frame, { externalActiveJobs: 36 }), cmd, 'CAPACITY_EXCEEDED');
    // Explicit structurally valid ID/revision pressure fixtures, not a naturally played world.
    for (const pressure of [{ nextId: Number.MAX_SAFE_INTEGER - 2 }, { revision: Number.MAX_SAFE_INTEGER - 1 }]) {
      const pressured = { ...frame, ...pressure };
      unchangedRejection(pressured, context(pressured), command(pressured, { kind: 'construction.start', blueprintId: frame.blueprints[0]!.blueprintId, workerId: 'entity:2' }), 'CAPACITY_EXCEEDED');
      expect(cancel(pressured).blueprints[0]!.status).toBe('cancelled');
    }
    frame = start(frame);
    const ctx = context(frame, { simulationTick: frame.lastSimulationTick + 1, calendarTick: frame.lastCalendarTick + 1 });
    const forged = { simulationTick: ctx.simulationTick, remaining: 4 } as ReturnType<typeof createWorkPathBudget>;
    expect(tickConstruction(frame, ctx, forged)).toMatchObject({ ok: false, code: 'INVALID_CONTEXT', frame });
  });
  it('reserves every cancellation revision at equality and rejects the next tick or start without stranding claims', () => {
    let source = start(place(cloneJson(twoSites))); source = place(source, request(9, 1));
    source = start(source, 'entity:4');
    // Explicit numeric pressure import. All following cancellations are real commands, with no counter rewrites.
    let frame = { ...source, revision: Number.MAX_SAFE_INTEGER - 3 };
    expect(validateConstructionFrame(frame)).toEqual([]);
    frame = step(frame); expect(frame.revision).toBe(Number.MAX_SAFE_INTEGER - 2);
    const ctx = context(frame, { simulationTick: frame.lastSimulationTick + 1, calendarTick: frame.lastCalendarTick + 1 });
    expect(tickConstruction(frame, ctx, createWorkPathBudget(ctx.simulationTick))).toMatchObject({ ok: false, code: 'CAPACITY_EXCEEDED', frame });
    const first = frame.blueprints[0]!.blueprintId; const second = frame.blueprints[1]!.blueprintId;
    frame = cancel(frame, first); expect(frame.revision).toBe(Number.MAX_SAFE_INTEGER - 1); expect(frame.ledger.inventory.wood.reserved).toBe(8);
    frame = cancel(frame, second); expect(frame.revision).toBe(Number.MAX_SAFE_INTEGER); expect(frame.ledger.inventory.wood.reserved).toBe(0);
    expect(frame.ledger.inventory.plank.reserved).toBe(0); expect(constructionClaims(frame)).toEqual([]);
    const planned = { ...place(start(place(cloneJson(twoSites))), request(9, 1)), revision: Number.MAX_SAFE_INTEGER - 2 };
    unchangedRejection(planned, context(planned), command(planned, { kind: 'construction.start', blueprintId: planned.blueprints[1]!.blueprintId, workerId: 'entity:4' }), 'CAPACITY_EXCEEDED');
    const allCancelled = cancel(cancel(planned, planned.blueprints[0]!.blueprintId), planned.blueprints[1]!.blueprintId);
    expect(allCancelled.revision).toBe(Number.MAX_SAFE_INTEGER); expect(allCancelled.ledger.inventory.wood.reserved).toBe(0);
  });
  it('admits a new soft claim only when all three real cancellations fit, with equality/+1 coverage', () => {
    let source = start(place(cloneJson(twoSites))); source = start(place(source, request(9, 1)), 'entity:4');
    // Exact headroom admits the third soft blueprint and all three terminal command receipts.
    let frame = place({ ...source, revision: Number.MAX_SAFE_INTEGER - 4 }, request(0, 6));
    expect(frame.revision).toBe(Number.MAX_SAFE_INTEGER - 3);
    for (const bp of frame.blueprints) frame = cancel(frame, bp.blueprintId);
    expect(frame.revision).toBe(Number.MAX_SAFE_INTEGER); expect(frame.blueprints.every(bp => bp.status === 'cancelled')).toBe(true);
    expect(frame.ledger.inventory.wood.reserved).toBe(0); expect(frame.ledger.inventory.plank.reserved).toBe(0);
    const over = { ...source, revision: Number.MAX_SAFE_INTEGER - 3 };
    unchangedRejection(over, context(over), command(over, { kind: 'blueprint.place', placement: request(0, 6) }), 'CAPACITY_EXCEEDED');
  });
  it('spends final revision headroom only when a real completed work tick discharges the obligation', () => {
    const source = until(start(place(initial())), value => value.jobs[0]!.activeTicks === 319);
    const frame = step({ ...source, revision: Number.MAX_SAFE_INTEGER - 1 });
    expect(frame.revision).toBe(Number.MAX_SAFE_INTEGER); expect(frame.jobs[0]!.terminal!.kind).toBe('completed');
    expect(frame.jobs[0]!.activeTicks).toBe(320); expect(frame.buildings).toHaveLength(1); expect(frame.ledger.inventory.wood.reserved).toBe(0);
  });
  it('rejects an arithmetic-valid orphan reservation and a second blueprint borrowing another job', () => {
    const source = start(place(initial()));
    const orphan = { ...source, blueprints: [], jobs: [], receipts: [] };
    expect(validateConstructionFrame(orphan)).toContainEqual({ code: 'ORPHAN_RESERVATION', path: source.jobs[0]!.reservationId });
    const two = place(source, request(9, 1)); const first = two.jobs[0]!;
    const borrowed = { ...two, blueprints: two.blueprints.map((bp, index) => index === 1 ? { ...bp, status: 'started' as const, jobId: first.jobId } : bp) };
    expect(validateConstructionFrame(borrowed)).toContainEqual({ code: 'ORPHAN_BLUEPRINT', path: two.blueprints[1]!.blueprintId });
    expect(applyConstructionCommand(borrowed, context(borrowed), command(borrowed, { kind: 'construction.cancel', blueprintId: two.blueprints[1]!.blueprintId }))).toMatchObject({ ok: false, code: 'INVALID_FRAME', frame: borrowed });
  });
  it('rejects completed calendar evidence that would grant an already expired first month', () => {
    const source = until(start(place(initial())), value => value.buildings.length === 1);
    const job = source.jobs[0]!; const calendarTick = job.startedCalendarTick;
    const corrupted = { ...source, jobs: [{ ...job, terminal: { ...job.terminal!, calendarTick } }],
      buildings: source.buildings.map(building => ({ ...building, completedCalendarTick: calendarTick, firstMaintenanceCalendarTick: calendarTick + 1200 })) };
    expect(validateConstructionFrame(corrupted)).toContainEqual({ code: 'IMPOSSIBLE_CALENDAR_DURATION', path: job.jobId });
    expect(validateConstructionFrame(source)).toEqual([]);
  });
  it('enforces calendar travel/work minima on active and cancelled states without counting combat gaps', () => {
    const source = until(start(place(initial())), value => value.jobs[0]!.activeTicks === 10);
    const job = source.jobs[0]!;
    // Actual origin (6,5), storage (7,5), entrance (1,3): 4 + 32 travel ticks, then 10 work ticks.
    expect(source.lastCalendarTick - job.startedCalendarTick).toBe(46);
    expect(validateConstructionFrame({ ...source, lastCalendarTick: job.startedCalendarTick + 45 })).toContainEqual({ code: 'IMPOSSIBLE_CALENDAR_DURATION', path: job.jobId });
    const cancelled = cancel(source);
    const corrupted = { ...cancelled, jobs: cancelled.jobs.map(value => ({ ...value, terminal: { ...value.terminal!, calendarTick: value.startedCalendarTick + 45 } })) };
    expect(validateConstructionFrame(corrupted)).toContainEqual({ code: 'IMPOSSIBLE_CALENDAR_DURATION', path: job.jobId });
    const combat = step(source, { mode: 'combat', calendarTick: source.lastCalendarTick });
    expect(combat.jobs[0]!.activeTicks).toBe(10); expect(combat.lastCalendarTick).toBe(source.lastCalendarTick); expect(validateConstructionFrame(combat)).toEqual([]);
  });
  it('reserves all active route-invalidation increments and rejects +1 imported exhaustion', () => {
    let source = start(place(cloneJson(twoSites))); source = place(source, request(9, 1));
    const ready = { ...source, map: { ...source.map, navVersion: Number.MAX_SAFE_INTEGER - 3 } };
    let frame = start(ready, 'entity:4'); expect(frame.map.navVersion).toBe(Number.MAX_SAFE_INTEGER - 2);
    expect(validateConstructionFrame(frame)).toEqual([]);
    const impossible = { ...frame, map: { ...frame.map, navVersion: Number.MAX_SAFE_INTEGER - 1 } };
    expect(validateConstructionFrame(impossible)).toContainEqual({ code: 'NAVIGATION_OBLIGATION', path: 'map.navVersion' });
    unchangedRejection(impossible, context(impossible), command(impossible, { kind: 'construction.cancel', blueprintId: frame.blueprints[0]!.blueprintId }), 'INVALID_FRAME');
    frame = cancel(frame, frame.blueprints[0]!.blueprintId); expect(frame.map.navVersion).toBe(Number.MAX_SAFE_INTEGER - 1);
    frame = cancel(frame, frame.blueprints[1]!.blueprintId); expect(frame.map.navVersion).toBe(Number.MAX_SAFE_INTEGER);
    expect(frame.ledger.inventory.wood.reserved).toBe(0); expect(frame.ledger.inventory.plank.reserved).toBe(0);
    const overStart = { ...source, map: { ...source.map, navVersion: Number.MAX_SAFE_INTEGER - 2 } };
    unchangedRejection(overStart, context(overStart), command(overStart, { kind: 'construction.start', blueprintId: source.blueprints[1]!.blueprintId, workerId: 'entity:4' }), 'CAPACITY_EXCEEDED');
    const finished = cancel(cancel(overStart, overStart.blueprints[0]!.blueprintId), overStart.blueprints[1]!.blueprintId);
    expect(finished.ledger.inventory.wood.reserved).toBe(0);
  });
  it('retains all cancellations across the previous hidden reader cap without replacing the World save gate', () => {
    const initialSource = initial();
    const source: ConstructionFrame = { ...initialSource, people: initialSource.people.filter(person => person.id === 'entity:2') };
    let claimed = source;
    // Create every soft claim through real commands on the small starter-map projection first.
    for (const [x, y] of [[1, 1], [9, 1], [0, 6], [10, 6]] as const) claimed = place(claimed, request(x, y));
    const originals = new Map(source.map.tiles.map(tile => [`${tile.x},${tile.y}`, tile]));
    // Explicit reader-capacity pressure projection: preserve that entire starter area and pad
    // only the map to 223×224 before real cancellations. No work or material evidence is invented.
    const pressureMap = { ...source.map, width: 223, height: 224, tiles: Array.from({ length: 223 * 224 }, (_, index) => {
      const x = index % 223; const y = Math.floor(index / 223);
      return originals.get(`${x},${y}`) ?? { x, y, terrain: 'grass' as const, walkable: true };
    }) };
    const emptyPressure = { ...source, map: pressureMap };
    const nodes = (value: unknown): number => value !== null && typeof value === 'object'
      ? 1 + Object.values(value).reduce<number>((count, child) => count + nodes(child), 0) : 1;
    expect(nodes(emptyPressure)).toBe(249888); expect(validateConstructionFrame(emptyPressure)).toEqual([]);
    let frame: ConstructionFrame = { ...claimed, map: pressureMap };
    expect(nodes(frame)).toBe(249988); expect(validateConstructionFrame(frame)).toEqual([]);
    frame = cancel(frame, frame.blueprints[0]!.blueprintId); expect(nodes(frame)).toBe(249996);
    frame = cancel(frame, frame.blueprints[1]!.blueprintId); expect(nodes(frame)).toBe(250004);
    frame = cancel(frame, frame.blueprints[2]!.blueprintId); frame = cancel(frame, frame.blueprints[3]!.blueprintId);
    expect(frame.blueprints.every(bp => bp.status === 'cancelled')).toBe(true); expect(frame.receipts).toHaveLength(8);
    expect(frame.ledger).toEqual(source.ledger); expect(frame.people).toEqual(source.people);
    expect(CONSTRUCTION_DESCRIPTOR_NODE_BOUND).toBe(7630017); expect(nodes(frame)).toBeLessThan(CONSTRUCTION_DESCRIPTOR_NODE_BOUND);
  });
  it('rejects malformed/accessor data, tampered costs, orphan terminal evidence and forged effective work', () => {
    const source = start(place(initial())); const sourceText = canonicalStringify(source);
    let reads = 0; const bad = { ...source, get revision() { reads++; return 0; } };
    expect(validateConstructionFrame(bad).length).toBeGreaterThan(0); expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = { ...source }; cyclic.ledger = cyclic;
    expect(validateConstructionFrame(cyclic).length).toBeGreaterThan(0);
    expect(validateConstructionFrame({ ...source, jobs: [null] }).length).toBeGreaterThan(0);
    expect(validateConstructionFrame({ ...source, map: { ...source.map, tiles: [null, ...source.map.tiles.slice(1)] } }).length).toBeGreaterThan(0);
    expect(validateConstructionFrame({ ...source, receipts: [] }).length).toBeGreaterThan(0);
    expect(validateConstructionFrame({ ...source, jobs: source.jobs.map(job => ({ ...job, activeTicks: 320 })) }).length).toBeGreaterThan(0);
    const altered = cloneJson(source); (altered.ledger.reservations[0]!.base.lines[0] as { quantity: number }).quantity = 1;
    expect(validateConstructionFrame(altered).length).toBeGreaterThan(0); expect(canonicalStringify(source)).toBe(sourceText);
  });
  it('worker loss suspends progress and explicit cancellation releases ownership without resurrecting or relocating', () => {
    let frame = until(start(place(initial())), value => value.jobs[0]!.activeTicks === 170);
    frame = actor(frame, { lifeState: 'dead' }); const position = frame.people.find(person => person.id === 'entity:2')!.position;
    frame = step(frame); expect(frame.jobs[0]!.activeTicks).toBe(170); expect(frame.jobs[0]!.blocked).toBe('WORKER_UNAVAILABLE');
    frame = cancel(frame); expect(frame.people.find(person => person.id === 'entity:2')).toMatchObject({ lifeState: 'dead', position });
    expect(constructionClaims(frame)).toEqual([]); expect(frame.ledger.inventory.wood.reserved).toBe(0);
  });
  it('cancellation refuses an unsafe external position rather than teleporting through changed terrain', () => {
    let frame = start(place(initial()));
    const position = frame.people.find(person => person.id === 'entity:2')!.position;
    frame = { ...frame, map: { ...frame.map, navVersion: frame.map.navVersion + 1, tiles: frame.map.tiles.map(tile => sameCell(tile, position) ? { ...tile, walkable: false } : tile) } };
    unchangedRejection(frame, context(frame), command(frame, { kind: 'construction.cancel', blueprintId: frame.blueprints[0]!.blueprintId }), 'PLACEMENT_CHANGED');
  });
});
