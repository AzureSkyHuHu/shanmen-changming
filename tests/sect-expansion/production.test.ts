import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import type { SectRecipeId } from '../../src/content/sect-v9/types';
import { advanceWorkNavigationWithBudget, createWorkPathBudget, type WorkPathBudget } from '../../src/core/agents/work-navigation';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { startProduction, tickProduction } from '../../src/core/economy/production';
import { tickClock } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { applyConstructionCommand, createConstructionFrame, tickConstruction } from '../../src/core/sect-expansion/construction';
import type { ConstructionContext, ConstructionFrame, ConstructionPerson } from '../../src/core/sect-expansion/construction-types';
import { reserveSectResources } from '../../src/core/sect-expansion/ledger';
import { applySectProductionCommand, createSectProductionFrame, sectProductionClaims, tickSectProduction } from '../../src/core/sect-expansion/production';
import { SECT_PRODUCTION_LIMITS, type SectProductionCommand, type SectProductionFrame, type SectProductionResult } from '../../src/core/sect-expansion/production-types';
import { SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND, validateSectProductionFrame } from '../../src/core/sect-expansion/production-validation';
import { createWorld } from '../../src/core/world/create-world';
import type { WorldState } from '../../src/core/world/types';

function constructionContext(frame: ConstructionFrame, patch: Partial<ConstructionContext> = {}): ConstructionContext {
  return { simulationTick: frame.lastSimulationTick, calendarTick: frame.lastCalendarTick, mode: 'management', paused: false,
    expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch };
}
const context = (frame: SectProductionFrame, patch: Partial<ConstructionContext> = {}): ConstructionContext => constructionContext(frame.construction, patch);
function accept(result: SectProductionResult): SectProductionFrame {
  if (!result.ok) throw new Error(`Production rejected: ${result.code}; source: ${JSON.stringify(validateSectProductionFrame(result.frame))}`);
  return result.frame;
}
const startCommand = (frame: SectProductionFrame, recipeId: SectRecipeId = 'gather.stone.v9', workerId = 'entity:2'): Extract<SectProductionCommand, { kind: 'production.start' }> => ({
  kind: 'production.start', commandId: `production.command:${frame.production.revision}`, expectedRevision: frame.production.revision, recipeId, workerId,
});
const cancelCommand = (frame: SectProductionFrame, jobId = frame.production.jobs.at(-1)!.transactionId): SectProductionCommand => ({
  kind: 'production.cancel', commandId: `production.command:${frame.production.revision}`, expectedRevision: frame.production.revision, jobId,
});
const start = (frame: SectProductionFrame, recipeId: SectRecipeId = 'gather.stone.v9', workerId = 'entity:2'): SectProductionFrame => accept(applySectProductionCommand(frame, context(frame), startCommand(frame, recipeId, workerId)));
const cancel = (frame: SectProductionFrame, jobId = frame.production.jobs.at(-1)!.transactionId): SectProductionFrame => accept(applySectProductionCommand(frame, context(frame), cancelCommand(frame, jobId)));
function step(frame: SectProductionFrame, patch: Partial<ConstructionContext> = {}): SectProductionFrame {
  const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1, ...patch });
  return accept(tickSectProduction(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
}
function until(frame: SectProductionFrame, predicate: (value: SectProductionFrame) => boolean, maximum = 900): SectProductionFrame {
  let current = frame;
  for (let n = 0; n < maximum && !predicate(current); n++) current = step(current);
  expect(predicate(current)).toBe(true); return current;
}
function finish(frame: SectProductionFrame): SectProductionFrame { return until(frame, value => value.production.jobs.at(-1)!.state === 'Committed'); }
function actor(frame: SectProductionFrame, patch: Partial<ConstructionPerson>, workerId = 'entity:2'): SectProductionFrame {
  return { ...frame, construction: { ...frame.construction, people: frame.construction.people.map(person => person.id === workerId ? { ...person, ...patch } : person) } };
}
function produce(world: WorldState, recipeId: string, commandId: string): WorldState {
  const begin = startProduction(world, commandId, recipeId, 'entity:4');
  if (!begin.ok) throw new Error(begin.rejection.code);
  let current = begin.world;
  for (let n = 0; n < 1000 && current.activeProductionTransactionIds.includes(begin.transactionId); n++) current = tickProduction({ ...current, clock: tickClock(current.clock) });
  expect(current.activeProductionTransactionIds).not.toContain(begin.transactionId); return current;
}
function project(world: WorldState): ConstructionFrame {
  return createConstructionFrame({ map: world.map, legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    people: world.disciples.map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState, canWork: person.canWork,
      away: false, productionTransactionId: person.assignmentTransactionId, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick });
}
function buildLibrary(source: ConstructionFrame): ConstructionFrame {
  const placed = applyConstructionCommand(source, constructionContext(source), { kind: 'blueprint.place', commandId: 'library.place', expectedRevision: source.revision,
    placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } });
  if (!placed.ok) throw new Error(placed.code);
  const begun = applyConstructionCommand(placed.frame, constructionContext(placed.frame), { kind: 'construction.start', commandId: 'library.start',
    expectedRevision: placed.frame.revision, blueprintId: placed.relatedId!, workerId: 'entity:2' });
  if (!begun.ok) throw new Error(begun.code);
  let frame = begun.frame;
  for (let n = 0; n < 800 && frame.buildings.length === 0; n++) {
    const ctx = constructionContext(frame, { simulationTick: frame.lastSimulationTick + 1, calendarTick: frame.lastCalendarTick + 1 });
    const result = tickConstruction(frame, ctx, createWorkPathBudget(ctx.simulationTick));
    if (!result.ok) throw new Error(result.code); frame = result.frame;
  }
  expect(frame.buildings).toHaveLength(1); return frame;
}
let preparedWorld: WorldState; let prepared: SectProductionFrame; let library: SectProductionFrame;
beforeAll(() => {
  // Genuine legacy work/travel/delivery earns all planks and additional wood/herbs. New stock
  // remains exactly zero; no job's activeTicks/completion flag or resources are manufactured.
  let world = createWorld('sect-production-real-starter');
  for (const [index, recipe] of ['gather.wood', 'gather.herbs', 'craft.plank', 'craft.plank', 'craft.plank'].entries()) world = produce(world, recipe, `earn:${index}`);
  preparedWorld = world; prepared = createSectProductionFrame(project(world)); library = createSectProductionFrame(buildLibrary(project(world)));
});
const initial = (): SectProductionFrame => cloneJson(prepared);
function rejection(frame: SectProductionFrame, command: SectProductionCommand, code: string, ctx = context(frame)): void {
  const before = canonicalStringify(frame); const result = applySectProductionCommand(frame, ctx, command);
  expect(result).toMatchObject({ ok: false, frame, code }); expect(result.frame).toBe(frame); expect(canonicalStringify(frame)).toBe(before);
}

describe('isolated manual v9 candidate production, without World/save registration', () => {
  it('earns stone, spirit stone and insight from zero new stock through real construction, travel, work and storage', () => {
    let frame = cloneJson(library); const original = cloneJson(frame); const base = frame.construction.ledger.inventory;
    expect(frame.construction.ledger.stock).toEqual(createEmptySectStock());
    expect(frame.construction.jobs[0]!.terminal?.kind).toBe('completed');
    expect(frame.construction.jobs[0]!.activeTicks).toBe(320);
    frame = finish(start(frame, 'gather.stone.v9'));
    expect(frame.construction.ledger.inventory.stone.owned).toBe(base.stone.owned + 3);
    expect(frame.construction.ledger.inventory.wood.owned).toBe(base.wood.owned - 1);
    frame = finish(start(frame, 'extract.spirit-stone.v9'));
    frame = finish(start(frame, 'study.basic-insight.v9'));
    expect(frame.construction.ledger.stock['spirit-stone']).toMatchObject({ owned: 1, reserved: 0 });
    expect(frame.construction.ledger.stock['basic-insight']).toMatchObject({ owned: 1, reserved: 0 });
    expect(frame.construction.ledger.stock['wound-powder'].owned).toBe(0);
    expect(frame.construction.ledger.inventory.stone.owned).toBe(base.stone.owned + 1);
    expect(frame.construction.ledger.inventory.herbs.owned).toBe(base.herbs.owned - 3);
    expect(frame.construction.ledger.inventory.plank.owned).toBe(base.plank.owned - 1);
    expect(frame.production.jobs.map(job => job.activeTicks)).toEqual([160, 240, 240]);
    expect(frame.production.jobs[0]!.productiveSite.position).toEqual({ x: 7, y: 8 });
    expect(frame.production.jobs[1]!.productiveSite.position).toEqual({ x: 7, y: 0 });
    const study = frame.production.jobs[2]!;
    expect(study.productiveSite).toMatchObject({ kind: 'placed', position: { x: 1, y: 3 }, sourceJobId: frame.construction.jobs[0]!.jobId });
    expect(study.terminal!.calendarTick).toBeLessThan(study.productiveSite.firstMaintenanceCalendarTick!);
    for (const job of frame.production.jobs) {
      expect(job.workVisit!.tick).toBeGreaterThan(job.startedTick); expect(job.deliveryVisit!.tick).toBeGreaterThan(job.workSpans.at(-1)!.lastTick);
      expect(job.terminal!.tick).toBeGreaterThan(job.deliveryVisit!.tick); expect(job.terminal!.position).toEqual({ x: 7, y: 5 });
    }
    expect(frame.construction.people.every(person => person.productionTransactionId === null)).toBe(true);
    expect(sectProductionClaims(frame)).toEqual([]); expect(validateSectProductionFrame(frame)).toEqual([]);
    expect(library).toEqual(original); expect(preparedWorld.activeProductionTransactionIds).toEqual([]);
  });
  it.each(['craft.wound-powder.v9', 'craft.wound-powder-alt.v9'] as const)('fails closed for research-gated medicine %s', recipe => {
    const frame = cloneJson(library); rejection(frame, startCommand(frame, recipe), 'RESEARCH_AUTHORITY_REQUIRED');
    rejection(frame, { ...startCommand(frame, recipe), researchCompleted: true } as unknown as SectProductionCommand, 'INVALID_COMMAND');
  });
  it('requires genuine completed library evidence and never treats blueprint or alleged level as completion', () => {
    const frame = initial(); rejection(frame, startCommand(frame, 'study.basic-insight.v9'), 'WORKSTATION_UNAVAILABLE');
    const fake = { ...frame, construction: { ...frame.construction, buildings: cloneJson(library.construction.buildings) } };
    expect(validateSectProductionFrame(fake).length).toBeGreaterThan(0);
    rejection(fake, startCommand(fake, 'study.basic-insight.v9'), 'INVALID_FRAME');
  });
  it('reserves inputs at start and awards no work on site arrival or output before actual storage delivery', () => {
    const source = initial(); const owned = source.construction.ledger.inventory.wood.owned;
    let frame = start(source); expect(frame.construction.ledger.inventory.wood).toMatchObject({ owned, reserved: 1 });
    frame = until(frame, value => value.production.jobs[0]!.phase === 'Working');
    expect(frame.production.jobs[0]!.activeTicks).toBe(0); expect(frame.production.jobs[0]!.workVisit!.position).toEqual({ x: 7, y: 8 });
    frame = until(frame, value => value.production.jobs[0]!.phase === 'TravellingToStorage');
    expect(frame.production.jobs[0]!.productiveSite.siteId).toBe('entity:10'); expect(frame.production.jobs[0]!.seatSiteId).toBeNull();
    expect(sectProductionClaims(frame).some(claim => claim.kind === 'seat')).toBe(false);
    expect(frame.construction.ledger.inventory.wood).toMatchObject({ owned, reserved: 1 });
    expect(frame.construction.ledger.inventory.stone).toEqual(source.construction.ledger.inventory.stone);
    frame = until(frame, value => value.production.jobs[0]!.phase === 'AwaitingDelivery');
    expect(frame.production.jobs[0]!.state).toBe('Running'); frame = step(frame);
    expect(frame.production.jobs[0]!.state).toBe('Committed'); expect(frame.construction.ledger.inventory.wood).toMatchObject({ owned: owned - 1, reserved: 0 });
  });
  it.each(['WaitingForStation', 'TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery'] as const)('cancels %s exactly once, preserving the last safe position', phase => {
    let frame = start(initial()); frame = until(frame, value => value.production.jobs[0]!.phase === phase);
    const position = cloneJson(frame.construction.people.find(person => person.id === 'entity:2')!.position);
    const cmd = cancelCommand(frame); const before = canonicalStringify(frame); const next = accept(applySectProductionCommand(frame, context(frame), cmd));
    expect(next.construction.people.find(person => person.id === 'entity:2')!.position).toEqual(position);
    expect(next.construction.ledger.inventory.wood).toMatchObject({ owned: frame.construction.ledger.inventory.wood.owned, reserved: 0 });
    expect(next.production.jobs[0]!.terminal).toMatchObject({ kind: 'cancelled', consumed: [], outputs: [], released: [{ ledger: 'base', resourceId: 'wood', quantity: 1 }] });
    expect(sectProductionClaims(next)).toEqual([]); expect(canonicalStringify(frame)).toBe(before);
    expect(applySectProductionCommand(next, context(next), cmd)).toMatchObject({ ok: true, repeated: true, frame: next });
    rejection(next, cancelCommand(next), 'TRANSACTION_FINISHED');
  });
  it('exact command body and revision retries never allocate or debit twice', () => {
    const source = initial(); const cmd = startCommand(source); const frame = accept(applySectProductionCommand(source, context(source), cmd));
    expect(applySectProductionCommand(frame, context(frame), cmd)).toMatchObject({ ok: true, frame, repeated: true });
    rejection(frame, { ...cmd, expectedRevision: frame.production.revision }, 'IDENTITY_CONFLICT');
    rejection(frame, { ...startCommand(frame), expectedRevision: 0 }, 'STALE_REVISION');
    const done = finish(frame); expect(applySectProductionCommand(done, context(done), cmd)).toMatchObject({ ok: true, repeated: true, frame: done });
    rejection(done, cancelCommand(done), 'TRANSACTION_FINISHED');
  });
  it.each(['recipe', 'catalog', 'cost', 'proof', 'receipt', 'orphan'] as const)('rejects unknown or tampered %s authority without changing the source', kind => {
    let frame = start(initial());
    if (kind === 'recipe') frame = { ...frame, production: { ...frame.production, jobs: [{ ...frame.production.jobs[0]!, recipeId: 'fake.recipe' as SectRecipeId }] } };
    if (kind === 'catalog') frame = { ...frame, construction: { ...frame.construction, catalogIdentity: { ...frame.construction.catalogIdentity, fingerprint: 'tampered' } } };
    if (kind === 'cost') {
      const claim = frame.construction.ledger.reservations[0]!;
      frame = { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger,
        inventory: { ...frame.construction.ledger.inventory, wood: { ...frame.construction.ledger.inventory.wood, reserved: 2 } },
        reservations: [{ ...claim, base: { ...claim.base, lines: [{ resourceId: 'wood', quantity: 2 }], remainingReservation: [{ resourceId: 'wood', quantity: 2 }] } }] } } };
    }
    if (kind === 'proof') frame = { ...frame, production: { ...frame.production, jobs: [{ ...frame.production.jobs[0]!, productiveSite: { ...frame.production.jobs[0]!.productiveSite, position: { x: 0, y: 0 } } }] } };
    if (kind === 'receipt') frame = { ...frame, production: { ...frame.production, receipts: [] } };
    if (kind === 'orphan') {
      const reserve = reserveSectResources(frame.construction.ledger, { reservationId: 'unowned:1', ownerTransactionId: 'unowned:2' }, [], 'on-completion');
      if (!reserve.ok) throw new Error(reserve.rejection.code);
      frame = { ...frame, construction: { ...frame.construction, ledger: reserve.context } };
    }
    expect(validateSectProductionFrame(frame).length).toBeGreaterThan(0); rejection(frame, cancelCommand(frame), 'INVALID_FRAME');
  });
  it('rejects unknown recipes and client costs, callbacks or outputs before assigning IDs', () => {
    const frame = initial(); rejection(frame, { ...startCommand(frame), recipeId: 'unknown' as SectRecipeId }, 'UNKNOWN_RECIPE');
    for (const extra of [{ inputs: [] }, { outputs: [] }, { complete: () => true }, { requiredTicks: 0 }]) rejection(frame, { ...startCommand(frame), ...extra }, 'INVALID_COMMAND');
  });
  it('strict reader rejects accessors, sparse arrays and extra fields without invoking getters', () => {
    const frame = initial(); let reads = 0;
    const getter = { ...frame, production: Object.defineProperty({}, 'jobs', { enumerable: true, get: () => { reads++; return []; } }) };
    expect(validateSectProductionFrame(getter).length).toBeGreaterThan(0); expect(reads).toBe(0);
    expect(validateSectProductionFrame({ ...frame, production: { ...frame.production, jobs: Array(1) } }).length).toBeGreaterThan(0);
    expect(validateSectProductionFrame({ ...frame, transactions: {} }).length).toBeGreaterThan(0);
  });
  it('rolls both ledgers back at sect capacity, then genuinely delivers after capacity is restored', () => {
    // Explicit storage-capacity pressure fixture, not earned play or resource provenance.
    let frame = initial(); frame = { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger,
      stock: { ...frame.construction.ledger.stock, 'spirit-stone': { owned: 99, reserved: 0, capacity: 99 } } } } };
    frame = until(start(frame, 'extract.spirit-stone.v9'), value => value.production.jobs[0]!.blockedReason === 'CAPACITY_EXCEEDED');
    const before = cloneJson(frame.construction.ledger);
    expect(frame.production.jobs[0]!.terminal).toBeNull(); frame = step(frame); expect(frame.construction.ledger).toEqual(before);
    const cancelled = cancel(frame); expect(cancelled.construction.ledger.inventory.stone.owned).toBe(before.inventory.stone.owned);
    expect(cancelled.construction.ledger.inventory.herbs.owned).toBe(before.inventory.herbs.owned);
    expect(cancelled.construction.ledger.stock['spirit-stone'].owned).toBe(99);
    frame = { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger,
      stock: { ...frame.construction.ledger.stock, 'spirit-stone': { owned: 98, reserved: 0, capacity: 99 } } } } };
    frame = step(frame); expect(frame.production.jobs[0]!.state).toBe('Committed');
    expect(frame.construction.ledger.inventory.stone.owned).toBe(before.inventory.stone.owned - 2);
    expect(frame.construction.ledger.inventory.herbs.owned).toBe(before.inventory.herbs.owned - 1);
    expect(frame.construction.ledger.stock['spirit-stone'].owned).toBe(99);
  });
  it('base-ledger overflow also keeps the reserved wood intact and cancellable', () => {
    let frame = initial(); // Explicit full-base-storage pressure fixture.
    frame = { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger,
      inventory: { ...frame.construction.ledger.inventory, stone: { resourceId: 'stone', owned: 999, reserved: 0, capacity: 999 } } } } };
    frame = until(start(frame), value => value.production.jobs[0]!.blockedReason === 'CAPACITY_EXCEEDED');
    expect(frame.construction.ledger.inventory.wood.reserved).toBe(1);
    const next = cancel(frame); expect(next.construction.ledger.inventory.wood.owned).toBe(frame.construction.ledger.inventory.wood.owned);
  });
  it.each(['start', 'seat', 'work', 'commit'] as const)('first prepaid library interval expires before %s and never manufactures maintenance payment', stage => {
    let frame = cloneJson(library); const due = frame.construction.buildings[0]!.firstMaintenanceCalendarTick;
    if (stage === 'work') frame = until(start(frame, 'study.basic-insight.v9'), value => value.production.jobs[0]!.activeTicks === 5);
    if (stage === 'commit') frame = until(start(frame, 'study.basic-insight.v9'), value => value.production.jobs[0]!.phase === 'AwaitingDelivery');
    // Explicit imported clock-boundary pressure fixture; no claim that skipped ticks were played.
    const jump = due - (stage === 'start' ? 0 : 1) - frame.construction.lastCalendarTick;
    frame = { ...frame, construction: { ...frame.construction, lastSimulationTick: frame.construction.lastSimulationTick + jump, lastCalendarTick: frame.construction.lastCalendarTick + jump } };
    expect(validateSectProductionFrame(frame)).toEqual([]);
    if (stage === 'start') { rejection(frame, startCommand(frame, 'study.basic-insight.v9'), 'WORKSTATION_UNAVAILABLE'); return; }
    if (stage === 'seat') frame = start(frame, 'study.basic-insight.v9');
    const activeTicks = frame.production.jobs[0]!.activeTicks; const ledger = cloneJson(frame.construction.ledger);
    frame = step(frame); expect(frame.production.jobs[0]!.activeTicks).toBe(activeTicks);
    expect(frame.production.jobs[0]!.blockedReason).toBe('WORKSTATION_UNAVAILABLE'); expect(frame.construction.ledger).toEqual(ledger);
    frame = cancel(frame); expect(frame.production.jobs[0]!.state).toBe('Cancelled'); expect(frame.construction.ledger.stock['basic-insight'].owned).toBe(0);
  });
  it('one site has one seat/entrance, releases it for delivery, and keeps productive provenance', () => {
    let frame = start(initial()); frame = start(frame, 'gather.stone.v9', 'entity:4'); frame = step(frame);
    expect(frame.production.jobs[0]!.seatSiteId).not.toBeNull(); expect(frame.production.jobs[1]!.blockedReason).toBe('WAITING_FOR_STATION');
    frame = until(frame, value => value.production.jobs[0]!.phase === 'TravellingToStorage');
    expect(frame.production.jobs[0]!.productiveSite.siteId).toBe(frame.production.jobs[1]!.seatSiteId);
    frame = until(frame, value => value.production.jobs[0]!.state === 'Committed');
    expect(frame.production.jobs[1]!.activeTicks).toBeLessThan(160); frame = finish(frame);
    expect(frame.production.jobs.every(job => job.state === 'Committed')).toBe(true);
  });
  it.each(['worker', 'seat', 'entrance'] as const)('rechecks an authoritative external %s claim at start and during work', kind => {
    let frame = initial(); const token = kind === 'worker' ? 'entity:2' : kind === 'seat' ? 'entity:10' : '7,8';
    const externalClaims = [{ kind, key: token, ownerId: 'research-or-away:1' }];
    rejection(frame, startCommand(frame), 'CLAIM_CONFLICT', context(frame, { externalClaims }));
    frame = until(start(frame), value => value.production.jobs[0]!.activeTicks === 3);
    const ticks = frame.production.jobs[0]!.activeTicks; frame = step(frame, { externalClaims });
    expect(frame.production.jobs[0]!.activeTicks).toBe(ticks); expect(frame.production.jobs[0]!.state).toBe('Blocked');
    frame = cancel(frame); expect(frame.production.jobs[0]!.state).toBe('Cancelled');
  });
  it.each([{ away: true }, { cultivationOwnerId: 'seclusion:1' }, { productionTransactionId: 'legacy:1' }, { otherOwnerId: 'care:1' },
    { canWork: false }, { lifeState: 'pendingDeath' as const }, { lifeState: 'dead' as const }])('honors projected lifecycle and ownership %s, including cancellation after loss', patch => {
    const unavailable = actor(initial(), patch); rejection(unavailable, startCommand(unavailable), 'WORKER_UNAVAILABLE');
    let frame = actor(start(initial()), patch); frame = step(frame); expect(frame.production.jobs[0]!.activeTicks).toBe(0);
    expect(frame.production.jobs[0]!.state).toBe('Blocked'); frame = cancel(frame); expect(frame.production.jobs[0]!.state).toBe('Cancelled');
  });
  it('existing legacy reservations remain unavailable and are never copied into the new reservation book', () => {
    const old = startProduction(preparedWorld, 'legacy.pending', 'craft.plank', 'entity:4'); if (!old.ok) throw new Error(old.rejection.code);
    let frame = createSectProductionFrame(project(old.world)); const oldReserved = frame.construction.ledger.inventory.wood.reserved;
    frame = start(frame); expect(frame.construction.ledger.inventory.wood.reserved).toBe(oldReserved + 1);
    expect(frame.construction.ledger.reservations).toHaveLength(1); frame = cancel(frame);
    expect(frame.construction.ledger.inventory.wood.reserved).toBe(oldReserved);
    expect(frame.construction.people.find(person => person.id === 'entity:4')!.productionTransactionId).toBe(old.transactionId);
    // Explicit low-available-balance pressure projection with the same true old reservation.
    frame = { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger,
      inventory: { ...frame.construction.ledger.inventory, wood: { ...frame.construction.ledger.inventory.wood, owned: oldReserved } } } } };
    rejection(frame, startCommand(frame), 'INSUFFICIENT_INVENTORY');
  });
  it('shares construction worker ownership and the same four-request tick budget', () => {
    const source = initial(); const placed = applyConstructionCommand(source.construction, context(source), { kind: 'blueprint.place', commandId: 'shared.place', expectedRevision: 0,
      placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } }); if (!placed.ok) throw new Error(placed.code);
    const begun = applyConstructionCommand(placed.frame, constructionContext(placed.frame), { kind: 'construction.start', commandId: 'shared.start', expectedRevision: placed.frame.revision,
      blueprintId: placed.relatedId!, workerId: 'entity:2' }); if (!begun.ok) throw new Error(begun.code);
    let frame = createSectProductionFrame(begun.frame); rejection(frame, startCommand(frame), 'CLAIM_CONFLICT');
    frame = start(frame, 'gather.stone.v9', 'entity:4');
    const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 });
    const budget = createWorkPathBudget(ctx.simulationTick);
    for (let n = 0; n < 3; n++) advanceWorkNavigationWithBudget({ map: frame.construction.map, position: { x: 0, y: 0 }, target: { x: 13, y: 9 }, navigation: emptyNavigation(), simulationTick: ctx.simulationTick }, budget);
    const next = accept(tickSectProduction(frame, ctx, budget)); expect(budget.remaining).toBe(0);
    expect(next.construction.jobs[0]!.navigation.path.length).toBeGreaterThan(0);
    expect(next.production.jobs[0]!.navigation.path).toEqual([]); expect(next.production.jobs[0]!.activeTicks).toBe(0);
    expect(tickSectProduction(frame, ctx, { simulationTick: ctx.simulationTick, remaining: 4 } as WorkPathBudget)).toMatchObject({ ok: false, code: 'INVALID_CONTEXT', frame });
  });
  it('pause/combat/expedition ticks grant no work, and clock gaps or old budgets cannot buy progress', () => {
    let frame = until(start(initial()), value => value.production.jobs[0]!.activeTicks === 5); const same = context(frame, { paused: true });
    expect(tickSectProduction(frame, same, createWorkPathBudget(same.simulationTick))).toMatchObject({ ok: true, repeated: true, frame });
    frame = step(frame, { mode: 'combat', calendarTick: frame.construction.lastCalendarTick }); frame = step(frame, { expeditionActive: true });
    expect(frame.production.jobs[0]!.activeTicks).toBe(5); frame = step(frame); expect(frame.production.jobs[0]!.activeTicks).toBe(6);
    expect(frame.production.jobs[0]!.workSpans).toHaveLength(2);
    const next = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 });
    expect(tickSectProduction(frame, { ...next, paused: true }, createWorkPathBudget(next.simulationTick))).toMatchObject({ ok: false, code: 'STALE_CLOCK' });
    expect(tickSectProduction(frame, { ...next, simulationTick: next.simulationTick + 1 }, createWorkPathBudget(next.simulationTick + 1))).toMatchObject({ ok: false, code: 'CLOCK_GAP' });
    expect(tickSectProduction(frame, next, createWorkPathBudget(next.simulationTick - 1))).toMatchObject({ ok: false, code: 'INVALID_CONTEXT' });
  });
  it.each(['TravellingToWork', 'Working', 'TravellingToStorage', 'AwaitingDelivery'] as const)('JSON-shaped interruption at %s exactly matches uninterrupted continuation', phase => {
    const frame = until(start(initial()), value => value.production.jobs[0]!.phase === phase);
    const restored = JSON.parse(JSON.stringify(frame)) as SectProductionFrame; expect(validateSectProductionFrame(restored)).toEqual([]);
    expect(finish(restored)).toEqual(finish(frame));
  });
  it('station shutdown still permits cancellation, and unsafe terrain never teleports or silently releases', () => {
    let frame = until(start(initial()), value => value.production.jobs[0]!.activeTicks === 4);
    frame = { ...frame, construction: { ...frame.construction, legacyStations: frame.construction.legacyStations.map(site => site.blueprintId === 'mine' ? { ...site, operational: false } : site) } };
    frame = step(frame); expect(frame.production.jobs[0]!.blockedReason).toBe('WORKSTATION_UNAVAILABLE');
    const cancelled = cancel(frame); expect(cancelled.production.jobs[0]!.state).toBe('Cancelled');
    const position = frame.construction.people.find(person => person.id === 'entity:2')!.position;
    const unsafe = { ...frame, construction: { ...frame.construction, map: { ...frame.construction.map, navVersion: frame.construction.map.navVersion + 1,
      tiles: frame.construction.map.tiles.map(tile => tile.x === position.x && tile.y === position.y ? { ...tile, walkable: false } : tile) } } };
    rejection(unsafe, cancelCommand(unsafe), 'UNSAFE_POSITION');
  });
  it('local revision and ID exact boundaries reserve all outstanding cancellations without new IDs', () => {
    // Explicit valid imported numeric-pressure fixtures, not an earned counter history.
    const MAX = Number.MAX_SAFE_INTEGER; let frame = initial();
    frame = { ...frame, production: { ...frame.production, revision: MAX - 3, nextId: MAX - 4 } };
    frame = start(frame);
    rejection(frame, startCommand(frame, 'extract.spirit-stone.v9', 'entity:4'), 'CAPACITY_EXCEEDED');
    const allocated = frame.production.nextId;
    frame = cancel(frame); expect(frame.production.revision).toBe(MAX - 1); expect(frame.production.nextId).toBe(allocated);
  });
  it('rejects insufficient revision headroom before reserving and admits the exact two-cancellation boundary', () => {
    const MAX = Number.MAX_SAFE_INTEGER; const source = initial();
    let frame = { ...source, production: { ...source.production, revision: MAX - 4, nextId: MAX - 4 } };
    frame = start(frame); frame = start(frame, 'extract.spirit-stone.v9', 'entity:4');
    expect(frame.production.revision).toBe(MAX - 2); expect(frame.production.nextId).toBe(MAX);
    frame = cancel(frame, frame.production.jobs[0]!.transactionId); frame = cancel(frame, frame.production.jobs[1]!.transactionId);
    expect(frame.production.revision).toBe(MAX); expect(frame.production.nextId).toBe(MAX); expect(validateSectProductionFrame(frame)).toEqual([]);
    const insufficient = { ...source, production: { ...source.production, revision: MAX - 1 } };
    rejection(insufficient, startCommand(insufficient), 'CAPACITY_EXCEEDED');
    const noIds = { ...source, production: { ...source.production, nextId: MAX - 1 } };
    rejection(noIds, startCommand(noIds), 'CAPACITY_EXCEEDED');
  });
  it('finite receipt/record and descriptor bounds retain the last real cancellation, without history truncation', () => {
    const seed = initial(); const one = cancel(start(seed));
    // Replay-equivalent pressure fixture: these same-boundary, zero-work start/cancel pairs
    // change only canonical IDs, receipts and revision. This is not an earned-play history.
    // Compare three actual reducer pairs first, then construct the larger prefix linearly.
    function pressure(count: number): SectProductionFrame {
      const jobs = Array.from({ length: count }, (_, index) => ({ ...cloneJson(one.production.jobs[0]!),
        transactionId: `sect-production:${index * 2 + 1}`, reservationId: `sect-production-reservation:${index * 2 + 2}` }));
      const reservations = jobs.map(job => {
        const claim = cloneJson(one.construction.ledger.reservations[0]!);
        const identity = { reservationId: job.reservationId, ownerTransactionId: job.transactionId };
        const settlement = { kind: 'released' as const, operationId: `cancel:${job.transactionId}` };
        return { ...claim, ...identity, base: { ...claim.base, ...identity, settlement }, sect: { ...claim.sect, ...identity, settlement } };
      });
      const receipts = jobs.flatMap((job, index) => [
        { command: { kind: 'production.start' as const, commandId: `production.command:${index * 2}`, expectedRevision: index * 2,
          recipeId: job.recipeId, workerId: job.workerId }, revision: index * 2 + 1, jobId: job.transactionId },
        { command: { kind: 'production.cancel' as const, commandId: `production.command:${index * 2 + 1}`, expectedRevision: index * 2 + 1,
          jobId: job.transactionId }, revision: index * 2 + 2, jobId: job.transactionId },
      ]);
      return { ...seed, construction: { ...seed.construction, ledger: { ...seed.construction.ledger, reservations } },
        production: { revision: count * 2, nextId: count * 2 + 1, jobs, receipts } };
    }
    let replay = seed;
    for (let n = 0; n < 3; n++) replay = cancel(start(replay));
    expect(pressure(3)).toEqual(replay);
    let frame = pressure(SECT_PRODUCTION_LIMITS.records - 1); expect(validateSectProductionFrame(frame)).toEqual([]);
    const sourceText = canonicalStringify(frame); const pressureSource = frame;
    frame = start(frame); expect(frame.production.receipts).toHaveLength(SECT_PRODUCTION_LIMITS.receipts - 1);
    const before = frame.production.jobs.length; frame = cancel(frame);
    expect(canonicalStringify(pressureSource)).toBe(sourceText);
    expect(frame.production.receipts).toHaveLength(SECT_PRODUCTION_LIMITS.receipts); expect(frame.production.jobs).toHaveLength(before);
    expect(validateSectProductionFrame(JSON.parse(JSON.stringify(frame)))).toEqual([]);
    const nodes = (value: unknown): number => 1 + (value !== null && typeof value === 'object' ? Object.values(value).reduce<number>((sum, child) => sum + nodes(child), 0) : 0);
    expect(nodes(frame)).toBeLessThan(SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND);
    expect(SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND).toBeGreaterThan(36 * 65536 * 3 + 128 * 240 * 5);
    rejection(frame, startCommand(frame), 'CAPACITY_EXCEEDED');
  });
});
