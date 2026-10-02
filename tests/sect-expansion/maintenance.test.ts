import { beforeAll, describe, expect, it } from 'vitest';
import type { SectBuildingId, SectRecipeId, SectResearchId } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { startProduction, tickProduction } from '../../src/core/economy/production';
import { tickClock } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { createConstructionFrame } from '../../src/core/sect-expansion/construction';
import type { ConstructionCommand } from '../../src/core/sect-expansion/construction-types';
import { validateConstructionFrame } from '../../src/core/sect-expansion/construction-validation';
import { sectReservationLines } from '../../src/core/sect-expansion/ledger';
import { applySectMaintenanceConstructionCommand, applySectMaintenanceProductionCommand, applySectMaintenanceResearchCommand,
  createSectMaintenanceFrame, sectMaintenanceResearchCompletion, sectMaintenanceStatus, tickSectMaintenance } from '../../src/core/sect-expansion/maintenance';
import { SECT_MAINTENANCE_LIMITS, type SectMaintenanceContext, type SectMaintenanceFrame, type SectMaintenanceResult } from '../../src/core/sect-expansion/maintenance-types';
import { SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND, validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';
import { createSectProductionFrame } from '../../src/core/sect-expansion/production';
import type { SectProductionCommand } from '../../src/core/sect-expansion/production-types';
import { validateSectProductionFrame } from '../../src/core/sect-expansion/production-validation';
import { createSectResearchFrame, applySectResearchCommand } from '../../src/core/sect-expansion/research';
import type { SectResearchCommand } from '../../src/core/sect-expansion/research-types';
import { SECT_RESEARCH_DESCRIPTOR_NODE_BOUND, sectAllLocalClaims, validateSectResearchFrame } from '../../src/core/sect-expansion/research-validation';
import { createWorld } from '../../src/core/world/create-world';
import { lookupProduction } from '../../src/core/world/history-access';
import type { WorldState } from '../../src/core/world/types';

const context = (frame: SectMaintenanceFrame, patch: Partial<SectMaintenanceContext> = {}): SectMaintenanceContext => ({
  simulationTick: frame.construction.lastSimulationTick, calendarTick: frame.construction.lastCalendarTick,
  mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch,
});
function accept(result: SectMaintenanceResult): SectMaintenanceFrame {
  if (!result.ok) throw new Error(`${result.code}: ${JSON.stringify(validateSectMaintenanceFrame(result.frame))}`);
  return result.frame;
}
function step(frame: SectMaintenanceFrame, patch: Partial<SectMaintenanceContext> = {}): SectMaintenanceFrame {
  const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1,
    calendarTick: frame.construction.lastCalendarTick + (patch.mode === 'combat' ? 0 : 1), ...patch });
  return accept(tickSectMaintenance(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
}
function until(frame: SectMaintenanceFrame, predicate: (frame: SectMaintenanceFrame) => boolean, limit = 1200): SectMaintenanceFrame {
  for (let n = 0; n < limit && !predicate(frame); n++) frame = step(frame);
  expect(predicate(frame)).toBe(true); return frame;
}
const prodCommand = (frame: SectMaintenanceFrame, recipeId: SectRecipeId = 'gather.stone.v9', workerId = 'entity:2'): SectProductionCommand => ({
  kind: 'production.start', commandId: `maintenance.produce:${frame.production.revision}`, expectedRevision: frame.production.revision, recipeId, workerId,
});
const start = (frame: SectMaintenanceFrame, recipe: SectRecipeId = 'gather.stone.v9', worker = 'entity:2'): SectMaintenanceFrame =>
  accept(applySectMaintenanceProductionCommand(frame, context(frame), prodCommand(frame, recipe, worker)));
const finish = (frame: SectMaintenanceFrame): SectMaintenanceFrame => until(frame, f => f.production.jobs.at(-1)!.terminal?.kind === 'completed');
const produce = (frame: SectMaintenanceFrame, recipe: SectRecipeId): SectMaintenanceFrame => finish(start(frame, recipe));
const cancelProduction = (frame: SectMaintenanceFrame): SectMaintenanceFrame => accept(applySectMaintenanceProductionCommand(frame, context(frame), {
  kind: 'production.cancel', commandId: `maintenance.cancel:${frame.production.revision}`, expectedRevision: frame.production.revision,
  jobId: frame.production.jobs.at(-1)!.transactionId,
}));
const researchCommand = (frame: SectMaintenanceFrame, researchId: SectResearchId = 'basic-medicine.v9'): SectResearchCommand => ({
  kind: 'research.start', commandId: `maintenance.research:${frame.research.revision}`, expectedRevision: frame.research.revision, researchId, workerId: 'entity:2',
});
const research = (frame: SectMaintenanceFrame, researchId: SectResearchId = 'basic-medicine.v9'): SectMaintenanceFrame =>
  accept(applySectMaintenanceResearchCommand(frame, context(frame), researchCommand(frame, researchId)));
const finishResearch = (frame: SectMaintenanceFrame): SectMaintenanceFrame => until(frame, f => f.research.jobs.at(-1)!.terminal?.kind === 'completed');
const cancelResearch = (frame: SectMaintenanceFrame): SectMaintenanceFrame => accept(applySectMaintenanceResearchCommand(frame, context(frame), {
  kind: 'research.cancel', commandId: `maintenance.cancel-research:${frame.research.revision}`, expectedRevision: frame.research.revision, jobId: frame.research.jobs.at(-1)!.jobId,
}));
function place(frame: SectMaintenanceFrame, definitionId: SectBuildingId = 'library.v9', x = 1, y = 1): SectMaintenanceFrame {
  return accept(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'blueprint.place',
    commandId: `maintenance.place:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
    placement: { definitionId, anchor: { x, y }, rotation: definitionId === 'alchemy.v9' ? 90 : 0 } }));
}
function beginBuilding(frame: SectMaintenanceFrame): SectMaintenanceFrame {
  return accept(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'construction.start',
    commandId: `maintenance.build:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
    blueprintId: frame.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' }));
}
function build(frame: SectMaintenanceFrame, definitionId: SectBuildingId = 'library.v9', x = 1, y = 1): SectMaintenanceFrame {
  const count = frame.construction.buildings.length;
  return until(beginBuilding(place(frame, definitionId, x, y)), f => f.construction.buildings.length === count + 1);
}
function legacyProduce(world: WorldState, recipe: string): WorldState {
  const begun = startProduction(world, `maintenance.legacy:${world.clock.simulationTick}`, recipe, 'entity:4');
  if (!begun.ok) throw new Error(begun.rejection.code); world = begun.world;
  for (let n = 0; n < 1000 && world.activeProductionTransactionIds.includes(begun.transactionId); n++) world = tickProduction({ ...world, clock: tickClock(world.clock) });
  const job = lookupProduction(world, begun.transactionId);
  expect(job).toMatchObject({ state: 'Committed', phase: 'Done', recipeId: recipe }); expect(job!.activeTicks).toBe(job!.requiredTicks); return world;
}
function project(world: WorldState): SectMaintenanceFrame {
  return createSectMaintenanceFrame(createSectResearchFrame(createSectProductionFrame(createConstructionFrame({ map: world.map,
    legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    people: world.disciples.map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState, canWork: person.canWork, away: false,
      productionTransactionId: person.assignmentTransactionId, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick,
  }))));
}
/** Boundary/pressure projection only. Real-economy fixtures below never use clock or stock edits. */
function atCalendar(frame: SectMaintenanceFrame, calendarTick: number): SectMaintenanceFrame {
  const delta = calendarTick - frame.construction.lastCalendarTick;
  return { ...frame, construction: { ...frame.construction, lastCalendarTick: calendarTick, lastSimulationTick: frame.construction.lastSimulationTick + delta } };
}
function wood(frame: SectMaintenanceFrame, owned: number): SectMaintenanceFrame {
  return { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger, inventory: { ...frame.construction.ledger.inventory,
    wood: { ...frame.construction.ledger.inventory.wood, owned } } } } };
}
const due = (frame: SectMaintenanceFrame, index = 0): number => sectMaintenanceStatus(frame, frame.construction.buildings[index]!.buildingId)!.dueCalendarTick;
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function failed(source: SectMaintenanceFrame, result: SectMaintenanceResult, code: string): void {
  expect(result).toMatchObject({ ok: false, code }); expect(result.frame).toBe(source);
}

let world: WorldState; let empty: SectMaintenanceFrame; let simpleLibrary: SectMaintenanceFrame; let materials: SectMaintenanceFrame;
let library: SectMaintenanceFrame; let readyFirst: SectMaintenanceFrame; let firstResearch: SectMaintenanceFrame;
let midpoint: SectMaintenanceFrame; let readySecond: SectMaintenanceFrame; let bothResearch: SectMaintenanceFrame;
let alchemy: SectMaintenanceFrame; let medicine: SectMaintenanceFrame;
// Bounded stages each retain actual reducer checkpoints. No timeout increase or seeded sect stock.
beforeAll(() => {
  world = createWorld('research-zero-stock');
  for (let n = 0; n < 10; n++) world = legacyProduce(world, 'gather.wood');
  for (let n = 0; n < 8; n++) world = legacyProduce(world, 'gather.herbs');
  for (let n = 0; n < 7; n++) world = legacyProduce(world, 'craft.plank');
  empty = project(world); simpleLibrary = build(empty); materials = empty;
});
beforeAll(() => {
  for (let n = 0; n < 3; n++) materials = produce(materials, 'gather.stone.v9');
  for (let n = 0; n < 3; n++) materials = produce(materials, 'extract.spirit-stone.v9');
});
beforeAll(() => {
  for (let n = 0; n < 3; n++) materials = produce(materials, 'extract.spirit-stone.v9');
  library = build(materials);
});
beforeAll(() => {
  readyFirst = produce(produce(library, 'study.basic-insight.v9'), 'study.basic-insight.v9');
  firstResearch = finishResearch(research(readyFirst));
});
beforeAll(() => { midpoint = produce(produce(firstResearch, 'study.basic-insight.v9'), 'study.basic-insight.v9'); });
beforeAll(() => {
  readySecond = produce(produce(midpoint, 'study.basic-insight.v9'), 'study.basic-insight.v9');
  bothResearch = finishResearch(research(readySecond, 'herbal-compatibility.v9'));
});
beforeAll(() => { alchemy = build(bothResearch, 'alchemy.v9', 9, 1); medicine = produce(alchemy, 'craft.wound-powder.v9'); });

describe('actual paid L1 building maintenance', () => {
  it('earns both research nodes using the same library and actual medicine from zero new stock', () => {
    expect(empty.construction.ledger.stock).toEqual(createEmptySectStock()); expect(empty.construction.ledger.inventory.plank.owned).toBe(14);
    expect(bothResearch.research.jobs.map(job => [job.researchId, job.activeTicks])).toEqual([['basic-medicine.v9', 240], ['herbal-compatibility.v9', 400]]);
    expect(new Set(bothResearch.research.jobs.map(job => job.site.buildingId)).size).toBe(1);
    expect(bothResearch.construction.buildings).toHaveLength(1);
    expect(bothResearch.production.jobs.filter(job => job.recipeId === 'study.basic-insight.v9')).toHaveLength(6);
    expect(bothResearch.maintenance.payments.length).toBeGreaterThanOrEqual(2);
    expect(bothResearch.construction.buildings[0]!.firstMaintenanceCalendarTick).toBe(library.construction.buildings[0]!.firstMaintenanceCalendarTick);
    expect(medicine.construction.jobs.every(job => job.activeTicks === 320 && job.terminal?.kind === 'completed')).toBe(true);
    expect(medicine.production.jobs.at(-1)).toMatchObject({ activeTicks: 160, terminal: { kind: 'completed', outputs: [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }] } });
    expect(medicine.construction.ledger.stock['wound-powder'].owned).toBe(1);
    for (const payment of medicine.maintenance.payments) {
      const claim = medicine.construction.ledger.reservations.find(value => value.reservationId === payment.reservationId)!;
      expect(sectReservationLines(claim, 'consumed')).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 1 }]);
      expect(claim.base.settlement).toEqual({ kind: 'committed', operationId: `maintain:${payment.paymentId}`, outputs: [] });
      expect(payment.dueCalendarTick - payment.paidCalendarTick).toBe(1200);
    }
    const woodCosts = 3 + 16 + medicine.maintenance.payments.length;
    expect(medicine.construction.ledger.inventory.wood.owned).toBe(empty.construction.ledger.inventory.wood.owned - woodCosts);
    expect(sectAllLocalClaims(medicine)).toEqual([]); expect(validateSectMaintenanceFrame(medicine)).toEqual([]);
  });
  it('charges exactly on the due boundary, keeps the construction date immutable and repeats without payment', () => {
    const before = freeze(atCalendar(simpleLibrary, due(simpleLibrary) - 2)); const text = canonicalStringify(before);
    const lastPaid = step(before); expect(lastPaid.maintenance.payments).toEqual([]);
    const renewed = step(lastPaid); const payment = renewed.maintenance.payments[0]!;
    expect(payment).toMatchObject({ predecessorPaymentId: null, previousDueCalendarTick: due(simpleLibrary), paidCalendarTick: due(simpleLibrary), dueCalendarTick: due(simpleLibrary) + 1200 });
    expect(renewed.construction.ledger.inventory.wood.owned).toBe(before.construction.ledger.inventory.wood.owned - 1);
    expect(renewed.construction.buildings).toEqual(before.construction.buildings);
    expect(tickSectMaintenance(renewed, context(renewed), createWorkPathBudget(renewed.construction.lastSimulationTick))).toEqual({ ok: true, frame: renewed, repeated: true, jobId: null });
    expect(step(renewed).maintenance).toEqual(renewed.maintenance); expect(canonicalStringify(before)).toBe(text);
  });
  it('does not borrow reserved wood, consumes no failed IDs, and retries after a genuine cancellation frees stock', () => {
    const before = start(wood(atCalendar(simpleLibrary, due(simpleLibrary) - 1), 1));
    expect(before.construction.ledger.inventory.wood).toMatchObject({ owned: 1, reserved: 1 });
    const expired = step(before); expect(expired.maintenance).toEqual(before.maintenance);
    expect(expired.construction.ledger.reservations).toHaveLength(before.construction.ledger.reservations.length);
    expect(sectMaintenanceStatus(expired, expired.construction.buildings[0]!.buildingId)).toMatchObject({ operational: false, renewalBlock: 'INSUFFICIENT_INVENTORY', deficits: [{ ledger: 'base', resourceId: 'wood', quantity: 1 }] });
    const cancelled = cancelProduction(expired); const resumed = step(cancelled);
    expect(resumed.maintenance.payments).toHaveLength(1); expect(resumed.construction.ledger.inventory.wood).toMatchObject({ owned: 0, reserved: 0 });
    expect(resumed.maintenance.payments[0]!.paidCalendarTick).toBe(expired.construction.lastCalendarTick + 1);
  });
  it('renews competing expired library/alchemy buildings in stable ID order with only one available wood', () => {
    const later = Math.max(due(alchemy), due(alchemy, 1)) + 2400;
    const before = wood(atCalendar(alchemy, later), 1); const prior = before.maintenance.payments.length;
    const after = step(before); expect(after.maintenance.payments).toHaveLength(prior + 1);
    const ids = alchemy.construction.buildings.map(value => value.buildingId).sort();
    expect(after.maintenance.payments.at(-1)!.buildingId).toBe(ids[0]);
    expect(sectMaintenanceStatus(after, ids[0]!)!.operational).toBe(true); expect(sectMaintenanceStatus(after, ids[1]!)!.operational).toBe(false);
    expect(step(after).maintenance).toEqual(after.maintenance);
  });
  it('suspends while away and pays only one present period on return regardless of missed periods', () => {
    const before = atCalendar(simpleLibrary, due(simpleLibrary) - 1); const firstAway = step(before, { expeditionActive: true });
    const longAway = atCalendar(firstAway, due(simpleLibrary) + 6 * 1200);
    const stillAway = step(longAway, { expeditionActive: true }); expect(stillAway.maintenance.payments).toEqual([]);
    const returned = step(stillAway); expect(returned.maintenance.payments).toHaveLength(1);
    expect(returned.maintenance.payments[0]).toMatchObject({ previousDueCalendarTick: due(simpleLibrary), paidCalendarTick: returned.construction.lastCalendarTick,
      dueCalendarTick: returned.construction.lastCalendarTick + 1200 });
    expect(returned.construction.ledger.inventory.wood.owned).toBe(before.construction.ledger.inventory.wood.owned - 1);
  });
  it('does not renew in combat or while paused and never advances a paused clock', () => {
    const expired = atCalendar(simpleLibrary, due(simpleLibrary)); const combat = step(expired, { mode: 'combat' });
    expect(combat.construction.lastCalendarTick).toBe(expired.construction.lastCalendarTick); expect(combat.maintenance).toEqual(expired.maintenance);
    expect(tickSectMaintenance(combat, context(combat, { paused: true }), createWorkPathBudget(combat.construction.lastSimulationTick))).toMatchObject({ ok: true, repeated: true });
    const ctx = context(combat, { paused: true, simulationTick: combat.construction.lastSimulationTick + 1, calendarTick: combat.construction.lastCalendarTick + 1 });
    failed(combat, tickSectMaintenance(combat, ctx, createWorkPathBudget(ctx.simulationTick)), 'STALE_CLOCK'); expect(step(combat).maintenance.payments).toHaveLength(1);
  });
  it('continues JSON at an unpaid boundary and after renewal without duplicate claims or IDs', () => {
    const before = wood(atCalendar(simpleLibrary, due(simpleLibrary) - 1), 0); const expired = step(before);
    expect(step(JSON.parse(JSON.stringify(expired)))).toEqual(step(expired));
    const resumed = step(wood(expired, 2)); const clone = JSON.parse(JSON.stringify(resumed)) as SectMaintenanceFrame;
    expect(step(clone)).toEqual(step(resumed)); expect(finish(start(clone, 'study.basic-insight.v9'))).toEqual(finish(start(resumed, 'study.basic-insight.v9')));
  });
  it('keeps earned research after all buildings expire and denies new use without a paid period', () => {
    const expired = wood(atCalendar(medicine, Math.max(due(medicine), due(medicine, 1)) + 1), 0);
    expect(sectMaintenanceResearchCompletion(expired, 'basic-medicine.v9')!.terminal?.kind).toBe('completed');
    expect(sectMaintenanceResearchCompletion(expired, 'herbal-compatibility.v9')!.terminal?.kind).toBe('completed');
    failed(expired, applySectMaintenanceProductionCommand(expired, context(expired), prodCommand(expired, 'craft.wound-powder.v9')), 'WORKSTATION_UNAVAILABLE');
  });
  it('retains one shared clock, all positions and the same exhausted four-path budget', () => {
    const begun = start(atCalendar(simpleLibrary, due(simpleLibrary) - 1), 'study.basic-insight.v9', 'entity:3');
    const ctx = context(begun, { simulationTick: begun.construction.lastSimulationTick + 1, calendarTick: begun.construction.lastCalendarTick + 1 });
    const budget = createWorkPathBudget(ctx.simulationTick);
    for (let n = 0; n < 4; n++) advanceWorkNavigationWithBudget({ map: begun.construction.map, position: { x: 0, y: 0 }, target: { x: 1, y: 0 }, navigation: emptyNavigation(), simulationTick: ctx.simulationTick }, budget);
    const next = accept(tickSectMaintenance(begun, ctx, budget)); expect(next.maintenance.payments).toHaveLength(1); expect(budget.remaining).toBe(0);
    expect(next.construction.lastSimulationTick).toBe(ctx.simulationTick); expect(next.construction.lastCalendarTick).toBe(ctx.calendarTick);
    expect(next.construction.people).toEqual(begun.construction.people); expect(next.production.jobs.at(-1)!.activeTicks).toBe(0);
    expect(next.production.revision).toBe(begun.production.revision + 1); expect(next.research.revision).toBe(begun.research.revision + 1);
  });
});

describe('historical paid-interval evidence', () => {
  it('admits real contiguous work across a renewal without rewriting its original site proof', () => {
    const begun = start(atCalendar(simpleLibrary, due(simpleLibrary) - 80), 'study.basic-insight.v9');
    const completed = finish(begun); const job = completed.production.jobs.at(-1)!;
    expect(completed.maintenance.payments).toHaveLength(1);
    expect(job.workSpans.some(span => span.firstCalendarTick < due(simpleLibrary) && span.lastCalendarTick >= due(simpleLibrary))).toBe(true);
    expect(job.productiveSite.firstMaintenanceCalendarTick).toBe(due(simpleLibrary));
    expect(validateSectMaintenanceFrame(completed)).toEqual([]);
  });
  it('blocks productive work through an unpaid gap, resumes after payment and rejects gap-spanning forged evidence', () => {
    let frame = start(wood(atCalendar(simpleLibrary, due(simpleLibrary) - 12), 0), 'study.basic-insight.v9');
    frame = until(frame, f => f.construction.lastCalendarTick === due(simpleLibrary));
    const active = frame.production.jobs.at(-1)!.activeTicks;
    const waiting = step(step(frame)); expect(waiting.production.jobs.at(-1)!.activeTicks).toBe(active);
    expect(waiting.production.jobs.at(-1)!.blockedReason).toBe('WORKSTATION_UNAVAILABLE');
    const resumed = step(wood(waiting, 1)); const paidTick = resumed.maintenance.payments[0]!.paidTick;
    const completed = finish(resumed); expect(completed.production.jobs.at(-1)!.workSpans).toHaveLength(2);
    const forged = cloneJson(completed) as any; const job = forged.production.jobs.at(-1); const second = job.workSpans[1];
    const unpaid = completed.maintenance.payments[0]!.paidCalendarTick - 1;
    expect(second.firstCalendarTick).toBeGreaterThanOrEqual(unpaid + 1);
    // Move only the second span into the unpaid gap, keeping its length and total paid input intact.
    const shift = second.firstCalendarTick - unpaid;
    second.firstCalendarTick -= shift; second.lastCalendarTick -= shift; second.firstTick -= shift; second.lastTick -= shift;
    expect(validateSectMaintenanceFrame(forged)).toContainEqual({ code: 'INVALID_WORK_EVIDENCE', path: job.transactionId });
    expect(paidTick).toBe(resumed.construction.lastSimulationTick);
  });
  it('cannot use a later payment to authorize already-recorded production work', () => {
    const renewed = step(atCalendar(simpleLibrary, due(simpleLibrary) - 1));
    const started = start(renewed, 'study.basic-insight.v9'); const worked = until(started, f => f.production.jobs.at(-1)!.activeTicks === 2);
    const forged = cloneJson(worked) as any; const payment = forged.maintenance.payments[0];
    payment.paidTick = worked.construction.lastSimulationTick; payment.paidCalendarTick = worked.construction.lastCalendarTick; payment.dueCalendarTick = payment.paidCalendarTick + 1200;
    // Payment remains a genuine correctly priced committed claim, but is too late for start/visit/work.
    expect(validateSectMaintenanceFrame(forged).length).toBeGreaterThan(0);
  });
  it('blocks research at expiry and authenticates the exact payment boundary for resumed work', () => {
    const before = research(wood(atCalendar(readyFirst, due(readyFirst) - 60), 0));
    let expired = until(before, f => f.construction.lastCalendarTick === due(readyFirst));
    const amount = expired.research.jobs.at(-1)!.activeTicks;
    expired = step(expired); expect(expired.research.jobs.at(-1)!.activeTicks).toBe(amount);
    expect(expired.research.jobs.at(-1)!.blocked).toBe('WORKSTATION_UNAVAILABLE');
    const renewed = step(wood(expired, 1)); const complete = finishResearch(renewed);
    expect(complete.research.jobs.at(-1)!.terminal?.kind).toBe('completed'); expect(validateSectMaintenanceFrame(complete)).toEqual([]);
    const forged = cloneJson(complete) as any; const payment = forged.maintenance.payments[0];
    payment.paidTick++; payment.paidCalendarTick++; payment.dueCalendarTick++;
    // At least the first resumed arrival or work tick precedes this delayed payment.
    expect(validateSectMaintenanceFrame(forged).length).toBeGreaterThan(0);
  });
  it('allows cancellation of expired research without consumption or duplicate refund', () => {
    const begun = research(wood(atCalendar(readyFirst, due(readyFirst) - 1), 0)); const expired = step(begun);
    const original = canonicalStringify(expired); const cancelled = cancelResearch(expired);
    expect(cancelled.research.jobs.at(-1)!.terminal).toMatchObject({ kind: 'cancelled', consumed: [] });
    expect(cancelled.construction.ledger.stock['basic-insight']).toMatchObject({ owned: 2, reserved: 0 });
    const receipt = cancelled.research.receipts.at(-1)!;
    expect(applySectMaintenanceResearchCommand(cancelled, context(cancelled), receipt.command)).toMatchObject({ ok: true, repeated: true, frame: cancelled });
    expect(canonicalStringify(expired)).toBe(original);
  });
  it('rechecks paid alchemy at final delivery and preserves pending medicine through shortage', () => {
    const begun = start(atCalendar(alchemy, due(alchemy, 1) - 210), 'craft.wound-powder.v9');
    const waiting = until(begun, f => f.production.jobs.at(-1)!.phase === 'AwaitingDelivery');
    const expired = wood(atCalendar(waiting, due(waiting, 1)), 0); const blocked = step(expired);
    expect(blocked.production.jobs.at(-1)!.terminal).toBeNull(); expect(blocked.production.jobs.at(-1)!.blockedReason).toBe('WORKSTATION_UNAVAILABLE');
    expect(blocked.construction.ledger.stock['wound-powder'].owned).toBe(alchemy.construction.ledger.stock['wound-powder'].owned);
    const returned = step(wood(blocked, 2)); // Both buildings may be due; stable payments precede delivery.
    expect(returned.production.jobs.at(-1)!.terminal?.kind).toBe('completed');
    expect(returned.construction.ledger.stock['wound-powder'].owned).toBe(1);
  });
});

describe('strict maintenance source and ownership validation', () => {
  it.each(['free', 'missing-record', 'source', 'building', 'early', 'future-tick', 'future-calendar', 'price', 'operation', 'partial', 'output', 'first-date', 'flag', 'unsafe-time', 'id', 'predecessor'] as const)(
    'rejects forged %s payment without changing the source', kind => {
      const earned = step(atCalendar(simpleLibrary, due(simpleLibrary) - 1)); const frame = cloneJson(earned) as any;
      const payment = frame.maintenance.payments[0]; const claim = frame.construction.ledger.reservations.at(-1);
      if (kind === 'free') frame.construction.ledger.reservations.pop();
      if (kind === 'missing-record') frame.maintenance.payments = [];
      if (kind === 'source') payment.sourceJobId = 'sect-construction:999';
      if (kind === 'building') payment.buildingId = 'sect-building:999';
      if (kind === 'early') { payment.paidTick--; payment.paidCalendarTick--; payment.dueCalendarTick--; }
      if (kind === 'future-tick') payment.paidTick++;
      if (kind === 'future-calendar') { payment.paidCalendarTick++; payment.dueCalendarTick++; }
      if (kind === 'price') { claim.base.lines[0].quantity = 2; claim.base.consumed[0].quantity = 2; }
      if (kind === 'operation') { claim.base.settlement.operationId = 'free'; claim.sect.settlement.operationId = 'free'; }
      if (kind === 'partial') { claim.base.settlement = null; claim.sect.settlement = null; }
      if (kind === 'output') claim.base.settlement.outputs = [{ resourceId: 'wood', quantity: 1 }];
      if (kind === 'first-date') frame.construction.buildings[0].firstMaintenanceCalendarTick = payment.dueCalendarTick;
      if (kind === 'flag') payment.paid = true;
      if (kind === 'unsafe-time') payment.dueCalendarTick = Number.MAX_SAFE_INTEGER + 1;
      if (kind === 'id') payment.paymentId = 'sect-maintenance:01';
      if (kind === 'predecessor') payment.predecessorPaymentId = payment.paymentId;
      const text = canonicalStringify(frame); expect(validateSectMaintenanceFrame(frame).length).toBeGreaterThan(0);
      const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 });
      failed(frame, tickSectMaintenance(frame, ctx, createWorkPathBudget(ctx.simulationTick)), 'INVALID_FRAME'); expect(canonicalStringify(frame)).toBe(text);
    });
  it('anchors the construction-paid first period to the current clock even before any renewal', () => {
    const forged = { ...simpleLibrary, construction: { ...simpleLibrary.construction,
      lastCalendarTick: simpleLibrary.construction.lastCalendarTick + 10 } };
    expect(validateSectMaintenanceFrame(forged)).toContainEqual({ code: 'INVALID_MAINTENANCE_CLOCK', path: simpleLibrary.construction.buildings[0]!.buildingId });
  });
  it('rejects historical work moved beyond succeeding payment clocks while retaining its early calendar', () => {
    const completed = produce(simpleLibrary, 'study.basic-insight.v9');
    const first = step(atCalendar(completed, due(completed) - 1));
    const second = step(atCalendar(first, due(first) + 1200 - 1));
    const frame = atCalendar(second, second.construction.lastCalendarTick + 4000);
    expect(validateSectMaintenanceFrame(frame)).toEqual([]);
    const forged = cloneJson(frame) as any; const job = forged.production.jobs.at(-1);
    job.startedTick += 3000; job.workVisit.tick += 3000; job.deliveryVisit.tick += 3000; job.terminal.tick += 3000;
    for (const span of job.workSpans) { span.firstTick += 3000; span.lastTick += 3000; }
    expect(validateSectMaintenanceFrame(forged).length).toBeGreaterThan(0);
  });
  it('rejects payment clocks whose remaining calendar delta cannot fit the remaining simulation delta', () => {
    const paid = step(atCalendar(simpleLibrary, due(simpleLibrary) - 1));
    const advanced = atCalendar(paid, paid.construction.lastCalendarTick + 10);
    expect(validateSectMaintenanceFrame(advanced)).toEqual([]);
    const forged = cloneJson(advanced) as any;
    forged.maintenance.payments[0].paidTick = forged.construction.lastSimulationTick;
    expect(validateSectMaintenanceFrame(forged)).toContainEqual({ code: 'INVALID_MAINTENANCE_PERIOD', path: forged.maintenance.payments[0].paymentId });
    const ctx = context(forged, { simulationTick: forged.construction.lastSimulationTick + 1, calendarTick: forged.construction.lastCalendarTick + 1 });
    failed(forged, tickSectMaintenance(forged, ctx, createWorkPathBudget(ctx.simulationTick)), 'INVALID_FRAME');
  });
  it('rejects duplicate predecessor periods and reordered immutable payments', () => {
    const one = step(atCalendar(simpleLibrary, due(simpleLibrary) - 1)); const two = step(atCalendar(one, due(one) - 1));
    const forged = cloneJson(two) as any; forged.maintenance.payments[1].predecessorPaymentId = null;
    forged.maintenance.payments[1].previousDueCalendarTick = due(simpleLibrary);
    expect(validateSectMaintenanceFrame(forged).length).toBeGreaterThan(0);
    expect(validateSectMaintenanceFrame({ ...two, maintenance: { ...two.maintenance, payments: [...two.maintenance.payments].reverse() } }).length).toBeGreaterThan(0);
  });
  it('allows same-tick shared-calendar payments but rejects another payment on a later combat-only clock', () => {
    const bothDue = wood(atCalendar(alchemy, Math.max(due(alchemy), due(alchemy, 1)) + 1), 2);
    const paid = step(bothDue); const pair = paid.maintenance.payments.slice(-2);
    expect(pair[0]!.paidTick).toBe(pair[1]!.paidTick); expect(pair[0]!.paidCalendarTick).toBe(pair[1]!.paidCalendarTick);
    expect(validateSectMaintenanceFrame(paid)).toEqual([]);
    const forged = cloneJson(paid) as any; forged.maintenance.payments.at(-1).paidTick++; forged.construction.lastSimulationTick++;
    expect(validateSectMaintenanceFrame(forged)).toContainEqual({ code: 'INVALID_MAINTENANCE_ORDER', path: forged.maintenance.payments.at(-1).paymentId });
  });
  it('rejects unowned committed maintenance claims in the reverse direction', () => {
    const renewed = step(atCalendar(simpleLibrary, due(simpleLibrary) - 1)); const frame = cloneJson(renewed) as any;
    const claim = cloneJson(frame.construction.ledger.reservations.at(-1));
    for (const value of [claim, claim.base, claim.sect]) { value.reservationId = 'sect-maintenance-reservation:98'; value.ownerTransactionId = 'sect-maintenance:97'; }
    claim.base.settlement.operationId = 'maintain:sect-maintenance:97'; claim.sect.settlement.operationId = 'maintain:sect-maintenance:97';
    frame.construction.ledger.reservations.push(claim);
    expect(validateSectMaintenanceFrame(frame)).toContainEqual({ code: 'ORPHAN_RESERVATION', path: 'sect-maintenance-reservation:98' });
  });
  it('does not invoke accessors, callbacks, exotic or sparse payment data', () => {
    let reads = 0; const getter = Object.defineProperty({}, 'payments', { enumerable: true, get: () => { reads++; return []; } });
    for (const maintenance of [getter, new Date(), { nextId: 1, payments: [,] }, { nextId: 1, payments: [], validate: () => true }])
      expect(validateSectMaintenanceFrame({ ...simpleLibrary, maintenance }).length).toBeGreaterThan(0);
    expect(reads).toBe(0);
  });
  it('does not widen any old public root or admit caller maintenance authority', () => {
    expect(validateSectResearchFrame(medicine)).toEqual([{ code: 'INVALID_SHAPE', path: 'frame' }]);
    const { maintenance: _maintenance, ...stripped } = medicine;
    expect(validateSectResearchFrame(stripped).length).toBeGreaterThan(0);
    expect(validateSectProductionFrame({ schemaVersion: 1, construction: medicine.construction, production: medicine.production }).length).toBeGreaterThan(0);
    expect(validateConstructionFrame(medicine.construction).length).toBeGreaterThan(0); // Alchemy still requires its genuine research-owning root.
    expect(applySectResearchCommand(medicine, context(medicine), researchCommand(medicine))).toMatchObject({ ok: false, code: 'INVALID_FRAME' });
    for (const extra of [{ maintenance: medicine.maintenance }, { paid: true }, { validate: () => true }]) {
      failed(readyFirst, applySectMaintenanceResearchCommand(readyFirst, context(readyFirst), { ...researchCommand(readyFirst), ...extra } as SectResearchCommand), 'INVALID_COMMAND');
      failed(simpleLibrary, applySectMaintenanceProductionCommand(simpleLibrary, context(simpleLibrary), { ...prodCommand(simpleLibrary), ...extra } as SectProductionCommand), 'INVALID_COMMAND');
    }
  });
  it('replays exact commands before new competing claims and keeps stale/conflicting commands strict', () => {
    const command = prodCommand(simpleLibrary); const begun = accept(applySectMaintenanceProductionCommand(simpleLibrary, context(simpleLibrary), command));
    const foreign = context(begun, { externalActiveJobs: 36, externalClaims: [{ kind: 'worker', key: 'entity:2', ownerId: 'foreign' }] });
    expect(applySectMaintenanceProductionCommand(begun, foreign, command)).toMatchObject({ ok: true, repeated: true, frame: begun });
    failed(begun, applySectMaintenanceProductionCommand(begun, context(begun), { ...command, workerId: 'entity:3' } as SectProductionCommand), 'IDENTITY_CONFLICT');
    failed(begun, applySectMaintenanceProductionCommand(begun, context(begun), { ...command, commandId: 'new' }), 'STALE_REVISION');
  });
});

function pressurePayments(seed: SectMaintenanceFrame, count: number): SectMaintenanceFrame {
  // Explicit finite-history boundary fixture. Every receipt/wood debit is still an actual reducer payment;
  // large calendar advances are projected boundary inputs, not claimed as replayed gameplay ticks.
  return advancePaymentPeriods(wood(seed, 400), count);
}
function advancePaymentPeriods(seed: SectMaintenanceFrame, count: number): SectMaintenanceFrame {
  let frame = seed;
  for (let i = 0; i < count; i++) frame = step(atCalendar(frame, due(frame) - 1));
  return frame;
}
describe('finite maintenance history and cancellation headroom', () => {
  it('reaches 128 actual receipts, expires safely on exhaustion and retains the last cancellation', () => {
    const before = pressurePayments(simpleLibrary, SECT_MAINTENANCE_LIMITS.payments - 1);
    const last = step(atCalendar(before, due(before) - 1)); expect(last.maintenance.payments).toHaveLength(128);
    const begun = start(atCalendar(last, due(last) - 1)); const expired = step(begun);
    expect(expired.maintenance).toEqual(last.maintenance); expect(expired.construction.ledger.inventory.wood).toEqual(begun.construction.ledger.inventory.wood);
    expect(sectMaintenanceStatus(expired, expired.construction.buildings[0]!.buildingId)).toMatchObject({ operational: false, renewalBlock: 'HISTORY_EXHAUSTED' });
    const cancelled = cancelProduction(JSON.parse(JSON.stringify(expired))); expect(cancelled.production.jobs.at(-1)!.terminal?.kind).toBe('cancelled');
    expect(cancelled.maintenance.payments).toEqual(last.maintenance.payments); expect(validateSectMaintenanceFrame(cancelled)).toEqual([]);
    const over = { ...last, maintenance: { ...last.maintenance, payments: [...last.maintenance.payments, last.maintenance.payments[0]!] } };
    expect(validateSectMaintenanceFrame(over)).toContainEqual({ code: 'INVALID_DOMAIN', path: 'maintenance' });
  });
  it.each([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER])('exhausted next ID %s skips payment while preserving cancellation', nextId => {
    const seed = { ...simpleLibrary, maintenance: { nextId, payments: [] } };
    const begun = start(atCalendar(seed, due(seed) - 1)); const after = step(begun);
    expect(after.maintenance).toEqual(seed.maintenance); expect(sectMaintenanceStatus(after, after.construction.buildings[0]!.buildingId)!.renewalBlock).toBe('ID_LIMIT');
    expect(cancelProduction(after).production.jobs.at(-1)!.terminal?.kind).toBe('cancelled');
  });
  it('uses the last safe pair of IDs exactly once', () => {
    const seed = { ...simpleLibrary, maintenance: { nextId: Number.MAX_SAFE_INTEGER - 2, payments: [] } };
    const after = step(atCalendar(seed, due(seed) - 1));
    expect(after.maintenance.nextId).toBe(Number.MAX_SAFE_INTEGER);
    expect(after.maintenance.payments[0]).toMatchObject({ paymentId: `sect-maintenance:${Number.MAX_SAFE_INTEGER - 2}`, reservationId: `sect-maintenance-reservation:${Number.MAX_SAFE_INTEGER - 1}` });
    expect(validateSectMaintenanceFrame(after)).toEqual([]);
  });
  it('does not overflow the paid-through calendar and rejects forged unsafe integers', () => {
    const seed = atCalendar(simpleLibrary, Number.MAX_SAFE_INTEGER - 1000);
    const after = step(seed); expect(after.maintenance.payments).toEqual([]);
    expect(sectMaintenanceStatus(after, after.construction.buildings[0]!.buildingId)!.renewalBlock).toBe('CLOCK_LIMIT');
    expect(validateSectMaintenanceFrame({ ...after, maintenance: { nextId: Number.MAX_SAFE_INTEGER + 1, payments: [] } }).length).toBeGreaterThan(0);
  });
  it('retains exact revision cancellation headroom instead of spending it on a tick or new job', () => {
    const live = start(simpleLibrary); const frame = { ...live, production: { ...live.production, revision: Number.MAX_SAFE_INTEGER - 1 } };
    expect(validateSectMaintenanceFrame(frame)).toEqual([]);
    const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 });
    failed(frame, tickSectMaintenance(frame, ctx, createWorkPathBudget(ctx.simulationTick)), 'CAPACITY_EXCEEDED');
    const cancelled = cancelProduction(frame); expect(cancelled.production.revision).toBe(Number.MAX_SAFE_INTEGER); expect(validateSectMaintenanceFrame(cancelled)).toEqual([]);
  });
  it('adds only the actual payment shape to the unchanged descriptor bound', () => {
    expect(SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND).toBe(SECT_RESEARCH_DESCRIPTOR_NODE_BOUND + 3 + 128 * 10);
    const nodes = (value: unknown): number => value !== null && typeof value === 'object'
      ? 1 + Object.values(value).reduce<number>((sum, child) => sum + nodes(child), 0) : 1;
    expect(nodes(medicine)).toBeLessThan(SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND);
  });
});

function cancelBuilding(frame: SectMaintenanceFrame): SectMaintenanceFrame {
  return accept(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'construction.cancel',
    commandId: `maintenance.cancel-build:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
    blueprintId: frame.construction.blueprints.at(-1)!.blueprintId }));
}
/** Linear same-clock pressure prefixes, verified below against three actual reducer cycles.
 * They only repeat cancelled transactions, never create free materials or completed work. */
function cancelledProductionPrefix(seed: SectMaintenanceFrame, count: number): SectMaintenanceFrame {
  const one = cancelProduction(start(seed)); const template = one.production.jobs.at(-1)!;
  const jobs = Array.from({ length: count }, (_, index) => ({ ...cloneJson(template),
    transactionId: `sect-production:${seed.production.nextId + index * 2}`, reservationId: `sect-production-reservation:${seed.production.nextId + index * 2 + 1}` }));
  const claims = jobs.map(job => {
    const claim = cloneJson(one.construction.ledger.reservations.at(-1)!); const identity = { ownerTransactionId: job.transactionId, reservationId: job.reservationId };
    const settlement = { kind: 'released' as const, operationId: `cancel:${job.transactionId}` };
    return { ...claim, ...identity, base: { ...claim.base, ...identity, settlement }, sect: { ...claim.sect, ...identity, settlement } };
  });
  const receipts = jobs.flatMap((job, index) => {
    const revision = seed.production.revision + index * 2;
    return [{ command: { kind: 'production.start' as const, commandId: `maintenance.produce:${revision}`, expectedRevision: revision,
      recipeId: job.recipeId, workerId: job.workerId }, revision: revision + 1, jobId: job.transactionId },
    { command: { kind: 'production.cancel' as const, commandId: `maintenance.cancel:${revision + 1}`, expectedRevision: revision + 1,
      jobId: job.transactionId }, revision: revision + 2, jobId: job.transactionId }];
  });
  return { ...seed, construction: { ...seed.construction, ledger: { ...seed.construction.ledger,
    reservations: [...seed.construction.ledger.reservations, ...claims] } }, production: {
    revision: seed.production.revision + count * 2, nextId: seed.production.nextId + count * 2,
    jobs: [...seed.production.jobs, ...jobs], receipts: [...seed.production.receipts, ...receipts],
  } };
}
function cancelledConstructionPrefix(seed: SectMaintenanceFrame, count: number): SectMaintenanceFrame {
  const one = cancelBuilding(beginBuilding(place(seed, 'library.v9', 9, 1))); const source = one.construction;
  const blueprints = Array.from({ length: count }, (_, index) => ({ ...cloneJson(source.blueprints.at(-1)!),
    blueprintId: `sect-blueprint:${seed.construction.nextId + index * 4}`, jobId: `sect-construction:${seed.construction.nextId + index * 4 + 1}` }));
  const jobs = blueprints.map((bp, index) => ({ ...cloneJson(source.jobs.at(-1)!), blueprintId: bp.blueprintId, jobId: bp.jobId,
    reservationId: `sect-reservation:${seed.construction.nextId + index * 4 + 2}`, resultBuildingId: `sect-building:${seed.construction.nextId + index * 4 + 3}`,
    seatToken: bp.blueprintId,
  }));
  const claims = jobs.map(job => {
    const claim = cloneJson(source.ledger.reservations.at(-1)!); const identity = { ownerTransactionId: job.jobId, reservationId: job.reservationId };
    const settlement = { kind: 'released' as const, operationId: `cancel:${job.jobId}` };
    return { ...claim, ...identity, base: { ...claim.base, ...identity, settlement }, sect: { ...claim.sect, ...identity, settlement } };
  });
  const receipts = jobs.flatMap((job, index) => {
    const revision = seed.construction.revision + index * 3;
    return [{ command: { kind: 'blueprint.place' as const, commandId: `maintenance.place:${revision}`, expectedRevision: revision,
      placement: { definitionId: 'library.v9' as const, anchor: { x: 9, y: 1 }, rotation: 0 as const } }, revision: revision + 1, relatedId: job.blueprintId },
    { command: { kind: 'construction.start' as const, commandId: `maintenance.build:${revision + 1}`, expectedRevision: revision + 1,
      blueprintId: job.blueprintId, workerId: job.workerId }, revision: revision + 2, relatedId: job.jobId },
    { command: { kind: 'construction.cancel' as const, commandId: `maintenance.cancel-build:${revision + 2}`, expectedRevision: revision + 2,
      blueprintId: job.blueprintId }, revision: revision + 3, relatedId: job.blueprintId }];
  });
  return { ...seed, construction: { ...seed.construction, nextId: seed.construction.nextId + count * 4,
    revision: seed.construction.revision + count * 3, map: { ...seed.construction.map, navVersion: seed.construction.map.navVersion + count * 2 },
    blueprints: [...seed.construction.blueprints, ...blueprints], jobs: [...seed.construction.jobs, ...jobs], receipts: [...seed.construction.receipts, ...receipts],
    ledger: { ...seed.construction.ledger, reservations: [...seed.construction.ledger.reservations, ...claims] },
  } };
}
describe('384 shared paired-ledger ceiling', () => {
  let nearlyFull: SectMaintenanceFrame; let paidCount = 0;
  beforeAll(() => {
    nearlyFull = cancelResearch(research(readyFirst));
    nearlyFull = cancelledConstructionPrefix(nearlyFull, 127);
    // Keep one production record/receipt pair for a real live, cancellable final transaction.
    nearlyFull = cancelledProductionPrefix(nearlyFull, 127 - nearlyFull.production.jobs.length);
    nearlyFull = wood(nearlyFull, 400);
    expect(validateSectMaintenanceFrame(nearlyFull)).toEqual([]);
  });
  // Every payment is still executed and retained; split the expensive 384-owner boundary
  // setup into bounded actual checkpoints rather than widening a test timeout.
  for (const count of [16, 16, 16, 16, 16, 16, 16, 15]) beforeAll(() => {
    nearlyFull = advancePaymentPeriods(nearlyFull, count); paidCount += count;
    expect(nearlyFull.maintenance.payments).toHaveLength(paidCount);
    expect(nearlyFull.construction.ledger.inventory.wood.owned).toBe(400 - paidCount);
    expect(validateSectMaintenanceFrame(nearlyFull)).toEqual([]);
  });
  it('proves the pressure prefixes equal three real start/cancel cycles', () => {
    let construction = readyFirst; let production = readyFirst;
    for (let n = 0; n < 3; n++) {
      construction = cancelBuilding(beginBuilding(place(construction, 'library.v9', 9, 1)));
      production = cancelProduction(start(production));
    }
    expect(cancelledConstructionPrefix(readyFirst, 3)).toEqual(construction);
    expect(cancelledProductionPrefix(readyFirst, 3)).toEqual(production);
  });
  it('never takes the 385th claim, and cancellation still works at full history', () => {
    expect(nearlyFull.maintenance.payments).toHaveLength(127);
    const frame = start(nearlyFull);
    expect(frame.construction.ledger.reservations).toHaveLength(384);
    const before = atCalendar(frame, due(frame) - 1); const after = step(before);
    expect(after.maintenance).toEqual(before.maintenance); expect(after.construction.ledger.reservations).toHaveLength(384);
    expect(after.construction.ledger.inventory.wood).toEqual(before.construction.ledger.inventory.wood);
    expect(sectMaintenanceStatus(after, after.construction.buildings[0]!.buildingId)!.renewalBlock).toBe('HISTORY_EXHAUSTED');
    const cancelled = cancelProduction(JSON.parse(JSON.stringify(after))); expect(cancelled.construction.ledger.reservations).toHaveLength(384);
    expect(cancelled.production.jobs).toHaveLength(128); expect(cancelled.production.jobs.at(-1)!.terminal?.kind).toBe('cancelled');
    expect(validateSectMaintenanceFrame(cancelled)).toEqual([]);
  });
});
