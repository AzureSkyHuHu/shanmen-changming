import { beforeAll, describe, expect, it } from 'vitest';
import { getSectRecipeDefinition } from '../../src/content/sect-v9/catalog';
import type { SectRecipeId, SectResearchId } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { cardinalDistance } from '../../src/core/agents/navigation';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { createConstructionFrame } from '../../src/core/sect-expansion/construction';
import type { ConstructionContext } from '../../src/core/sect-expansion/construction-types';
import { normalizeSectResourceLines, sectReservationLines } from '../../src/core/sect-expansion/ledger';
import { applySectMaintenanceConstructionCommand, applySectMaintenanceProductionCommand, applySectMaintenanceResearchCommand,
  createSectMaintenanceFrame, tickSectMaintenance } from '../../src/core/sect-expansion/maintenance';
import { tickValidatedSectMaintenancePaymentV10 } from '../../src/core/sect-expansion/maintenance-runtime-v10';
import type { SectMaintenanceFrame, SectMaintenanceResult } from '../../src/core/sect-expansion/maintenance-types';
import { validateSectMaintenanceRecordsV10 } from '../../src/core/sect-expansion/maintenance-v10';
import { validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';
import { createSectProductionFrame } from '../../src/core/sect-expansion/production';
import type { SectProductionCommand } from '../../src/core/sect-expansion/production-types';
import type { SectProductionResultV10 } from '../../src/core/sect-expansion/production-types-v10';
import { applyValidatedSectProductionCommandV10, sectProductionClaimsV10, sectProductionSitesAtStartV10,
  sectProductionSitesV10, tickValidatedSectProductionV10, validateSectProductionRecordsV10,
  validateSectProductionReceiptsV10 } from '../../src/core/sect-expansion/production-runtime-v10';
import { createSectResearchFrame } from '../../src/core/sect-expansion/research';
import { validateSectResearchConsumerGatesV10 } from '../../src/core/sect-expansion/research-consumer-gates-v10';
import { applyValidatedSectUpgradeCommandV10, tickValidatedSectUpgradeV10 } from '../../src/core/sect-expansion/upgrade-runtime';
import { createSectUpgradeStateV10, validateSectUpgradeRecordsV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, SectUpgradeFrameV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createWorld } from '../../src/core/world/create-world';

const context = (frame: { construction: { lastSimulationTick: number; lastCalendarTick: number } }, patch: Partial<ConstructionContext> = {}): ConstructionContext => ({
  simulationTick: frame.construction.lastSimulationTick, calendarTick: frame.construction.lastCalendarTick,
  mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch,
});
const lastJob = (frame: SectUpgradeFrameV10): SectProductionJobV10 => frame.production.jobs.at(-1)!;
function oldAccept(result: SectMaintenanceResult): SectMaintenanceFrame {
  if (!result.ok) throw new Error(`${result.code}: ${JSON.stringify(validateSectMaintenanceFrame(result.frame))}`);
  return result.frame;
}
function oldUntil(frame: SectMaintenanceFrame, predicate: (frame: SectMaintenanceFrame) => boolean): SectMaintenanceFrame {
  for (let n = 0; n < 1600 && !predicate(frame); n++) {
    const ctx = context(frame, { simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 });
    frame = oldAccept(tickSectMaintenance(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
  }
  expect(predicate(frame)).toBe(true); return frame;
}
function oldProduce(frame: SectMaintenanceFrame, recipeId: SectRecipeId): SectMaintenanceFrame {
  const started = oldAccept(applySectMaintenanceProductionCommand(frame, context(frame), { kind: 'production.start',
    commandId: `v10-production.fixture.produce:${frame.production.nextId}`, expectedRevision: frame.production.revision, recipeId, workerId: 'entity:2' }));
  return oldUntil(started, value => value.production.jobs.at(-1)!.terminal !== null);
}
function oldResearch(frame: SectMaintenanceFrame, researchId: SectResearchId): SectMaintenanceFrame {
  const started = oldAccept(applySectMaintenanceResearchCommand(frame, context(frame), { kind: 'research.start',
    commandId: `v10-production.fixture.research:${frame.research.nextId}`, expectedRevision: frame.research.revision, researchId, workerId: 'entity:2' }));
  return oldUntil(started, value => value.research.jobs.at(-1)!.terminal !== null);
}
function oldBuild(frame: SectMaintenanceFrame, definitionId: 'library.v9' | 'alchemy.v9', x: number): SectMaintenanceFrame {
  const placed = oldAccept(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'blueprint.place',
    commandId: `v10-production.fixture.place:${frame.construction.nextId}`, expectedRevision: frame.construction.revision,
    placement: { definitionId, anchor: { x, y: 1 }, rotation: 0 } }));
  const started = oldAccept(applySectMaintenanceConstructionCommand(placed, context(placed), { kind: 'construction.start',
    commandId: `v10-production.fixture.build:${placed.construction.nextId}`, expectedRevision: placed.construction.revision,
    blueprintId: placed.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' }));
  return oldUntil(started, value => value.construction.jobs.at(-1)!.terminal !== null);
}
/** Explicit funded BASE-ledger domain fixture. All sect stock, construction, research,
 * upgrade, work, navigation and settlements below are produced by real reducers.
 * This is not an end-to-end World, codec, migration, care or full-game acceptance. */
function fundedDomain(): SectMaintenanceFrame {
  const world = createWorld('v10-production-domain-record-fixture');
  for (const entry of Object.values(world.inventory)) entry.owned = Math.min(entry.capacity, 80);
  world.inventory.grain.owned = 1;
  return createSectMaintenanceFrame(createSectResearchFrame(createSectProductionFrame(createConstructionFrame({
    map: world.map, legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    people: world.disciples.map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState, canWork: person.canWork,
      away: false, productionTransactionId: null, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: 0, calendarTick: 0,
  }))));
}
/** Explicit isolated record lift. No claim that a World identity or migration was accepted. */
function lift(source: SectMaintenanceFrame): SectUpgradeFrameV10 {
  expect(validateSectMaintenanceFrame(source)).toEqual([]);
  return cloneJson({ schemaVersion: 2, construction: { ...source.construction, buildings: source.construction.buildings.map(building => ({ ...building, level: 1 as const })) },
    production: { ...source.production, jobs: source.production.jobs.map((job): SectProductionJobV10 => {
      if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old domain cannot produce the alternative');
      return { ...job, recipeId: job.recipeId };
    }) }, research: source.research, maintenance: source.maintenance, care: { revision: 0, nextId: 1, jobs: [], receipts: [] }, upgrade: createSectUpgradeStateV10() });
}
/** These fixed leaves authenticate this test's supported domain history. They are not a
 * complete root admission routine and deliberately provide no validator callback to runtime. */
function checked(frame: SectUpgradeFrameV10): SectUpgradeFrameV10 {
  expect(validateSectUpgradeRecordsV10(frame)).toEqual([]);
  expect(validateSectMaintenanceRecordsV10(frame)).toEqual([]);
  expect(validateSectProductionRecordsV10(frame)).toEqual([]);
  expect(validateSectProductionReceiptsV10(frame)).toEqual([]);
  expect(validateSectResearchConsumerGatesV10(frame)).toEqual([]);
  return frame;
}
function accept(result: SectProductionResultV10): SectUpgradeFrameV10 {
  if (!result.ok) throw new Error(result.code); return result.frame;
}
function startCommand(frame: SectUpgradeFrameV10, recipeId: SectRecipeId = 'craft.wound-powder-alt.v9'): Extract<SectProductionCommand, { kind: 'production.start' }> {
  return { kind: 'production.start', commandId: `v10-production.start:${frame.production.nextId}`, expectedRevision: frame.production.revision, recipeId, workerId: 'entity:2' };
}
const start = (frame: SectUpgradeFrameV10, recipeId?: SectRecipeId): SectUpgradeFrameV10 => accept(applyValidatedSectProductionCommandV10(frame, context(frame), startCommand(frame, recipeId)));
function cancel(frame: SectUpgradeFrameV10): SectUpgradeFrameV10 {
  return accept(applyValidatedSectProductionCommandV10(frame, context(frame), { kind: 'production.cancel', commandId: `v10-production.cancel:${frame.production.nextId}`,
    expectedRevision: frame.production.revision, jobId: lastJob(frame).transactionId }));
}
function step(frame: SectUpgradeFrameV10, patch: Partial<ConstructionContext> = {}): SectUpgradeFrameV10 {
  let next: SectUpgradeFrameV10 = { ...frame, construction: { ...frame.construction,
    lastSimulationTick: frame.construction.lastSimulationTick + 1, lastCalendarTick: frame.construction.lastCalendarTick + 1 } };
  const ctx = context(next, patch); const budget = createWorkPathBudget(ctx.simulationTick);
  next = tickValidatedSectMaintenancePaymentV10(next, ctx);
  return tickValidatedSectProductionV10(next, ctx, budget);
}
function until(frame: SectUpgradeFrameV10, predicate: (value: SectUpgradeFrameV10) => boolean): SectUpgradeFrameV10 {
  for (let n = 0; n < 1600 && !predicate(frame); n++) frame = step(frame);
  expect(predicate(frame)).toBe(true); return checked(frame);
}
const withJob = (frame: SectUpgradeFrameV10, job: SectProductionJobV10): SectUpgradeFrameV10 => ({ ...frame, production: { ...frame.production,
  jobs: frame.production.jobs.map(value => value.transactionId === job.transactionId ? job : value) } });
/** Corruption helper only; never a runtime conversion or authority assertion. */
const corrupt = <T>(value: T, patch: Record<string, unknown>): T => ({ ...value, ...patch });

let old: SectMaintenanceFrame; let l1: SectUpgradeFrameV10; let begun: SectUpgradeFrameV10; let l2: SectUpgradeFrameV10;
let started: SectUpgradeFrameV10; let arrived: SectUpgradeFrameV10; let delivery: SectUpgradeFrameV10; let awaiting: SectUpgradeFrameV10; let completed: SectUpgradeFrameV10;
beforeAll(() => { old = oldBuild(fundedDomain(), 'library.v9', 1); });
for (let batch = 0; batch < 3; batch++) beforeAll(() => { for (let n = 0; n < 2; n++) old = oldProduce(old, 'extract.spirit-stone.v9'); });
for (let batch = 0; batch < 3; batch++) beforeAll(() => { for (let n = 0; n < 2; n++) old = oldProduce(old, 'study.basic-insight.v9'); });
beforeAll(() => { old = oldResearch(old, 'basic-medicine.v9'); });
beforeAll(() => { old = oldResearch(old, 'herbal-compatibility.v9'); });
beforeAll(() => { old = oldBuild(old, 'alchemy.v9', 10); old = oldProduce(old, 'craft.wound-powder.v9'); l1 = checked(lift(old)); });
beforeAll(() => {
  const result = applyValidatedSectUpgradeCommandV10(l1, context(l1), { kind: 'upgrade.start', commandId: 'v10-production.fixture.upgrade', expectedRevision: 0,
    buildingId: l1.construction.buildings.at(-1)!.buildingId, workerId: 'entity:2' });
  if (!result.ok) throw new Error(result.code); begun = checked(result.frame); let next = begun;
  for (let n = 0; n < 1600 && next.upgrade.jobs[0]!.terminal === null; n++) {
    next = { ...next, construction: { ...next.construction, lastSimulationTick: next.construction.lastSimulationTick + 1, lastCalendarTick: next.construction.lastCalendarTick + 1 } };
    const ctx = context(next); next = tickValidatedSectMaintenancePaymentV10(next, ctx);
    const advanced = tickValidatedSectUpgradeV10(next, ctx, createWorkPathBudget(ctx.simulationTick));
    if (!advanced.ok) throw new Error(advanced.code); next = advanced.frame;
  }
  expect(next.upgrade.jobs[0]!.terminal?.kind).toBe('completed'); l2 = checked(next);
});
beforeAll(() => { started = checked(start(l2)); arrived = until(started, frame => lastJob(frame).phase === 'Working'); });
beforeAll(() => { delivery = until(arrived, frame => lastJob(frame).phase === 'TravellingToStorage'); awaiting = until(delivery, frame => lastJob(frame).phase === 'AwaitingDelivery'); completed = checked(step(awaiting)); });

describe('v10 production: fixed domain stages with genuinely executed research and upgrade', () => {
  it('starts L2 alternative at upgrade completion equality with its own independent herbal gate', () => {
    const upgrade = l2.upgrade.jobs[0]!; const job = lastJob(started);
    expect(l2.research.jobs.map(job => [job.researchId, job.activeTicks])).toEqual([['basic-medicine.v9', 240], ['herbal-compatibility.v9', 400]]);
    expect(upgrade.activeTicks).toBe(400);
    expect(job.startedTick).toBe(upgrade.terminal!.tick);
    expect(job.productiveSite).toMatchObject({ kind: 'placed', level: 2, upgradeJobId: upgrade.jobId });
    expect(job.researchGate).toEqual({ researchId: 'herbal-compatibility.v9', completionJobId: l2.research.jobs[1]!.jobId });
    expect(l2.construction.blueprints.at(-1)!.researchGate).toEqual({ researchId: 'basic-medicine.v9', completionJobId: l2.research.jobs[0]!.jobId });
  });
  it('consumes exact five herbs/two wood with zero grain only after 200 work ticks and genuine delivery', () => {
    const job = lastJob(completed); const claim = completed.construction.ledger.reservations.find(claim => claim.reservationId === job.reservationId)!;
    expect(started.construction.ledger.inventory.grain.owned).toBe(0); expect(completed.construction.ledger.inventory.grain.owned).toBe(0);
    expect(job).toMatchObject({ requiredTicks: 200, activeTicks: 200, state: 'Committed', phase: 'Done', terminal: { previousPhase: 'AwaitingDelivery' } });
    expect(sectReservationLines(claim, 'consumed')).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 5 }]);
    expect(job.terminal!.outputs).toEqual([{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }]);
    expect(completed.construction.ledger.stock['wound-powder'].owned).toBe(l2.construction.ledger.stock['wound-powder'].owned + 1);
    expect(job.terminal!.tick).toBeGreaterThan(job.deliveryVisit!.tick);
    expect(sectProductionClaimsV10(completed)).toEqual([]);
  });
  it('keeps old L1 historical proof unchanged after later real upgrade and allows terminal/start equality', () => {
    const historical = l1.production.jobs.at(-1)!; const preserved = l2.production.jobs.find(job => job.transactionId === historical.transactionId)!;
    expect(preserved).toEqual(historical); expect(preserved.productiveSite.level).toBe(1);
    expect(Object.hasOwn(preserved.productiveSite, 'upgradeJobId')).toBe(false);
    expect(historical.terminal!.tick).toBe(begun.upgrade.jobs[0]!.startedTick);
    const recipe = getSectRecipeDefinition('craft.wound-powder.v9')!;
    expect(sectProductionSitesAtStartV10(l2, recipe, historical.startedTick)).toContainEqual(historical.productiveSite);
    expect(sectProductionSitesV10(l2, recipe)[0]).toMatchObject({ level: 2 });
    expect(validateSectProductionRecordsV10(l2)).toEqual([]);
  });
  it('keeps base powder available on real L2 with basic medicine and the original 160-tick cost', () => {
    // Explicit material branch of the funded domain fixture; no new provenance is fabricated.
    const funded = cloneJson(l2); funded.construction.ledger.inventory.grain.owned = 1;
    const base = checked(start(funded, 'craft.wound-powder.v9'));
    expect(lastJob(base)).toMatchObject({ recipeId: 'craft.wound-powder.v9', requiredTicks: 160, productiveSite: { level: 2 }, researchGate: { researchId: 'basic-medicine.v9' } });
    const done = until(base, frame => lastJob(frame).terminal !== null);
    expect(lastJob(done).terminal!.consumed).toEqual(normalizeSectResourceLines(getSectRecipeDefinition('craft.wound-powder.v9')!.inputs));
  });
  it('rejects alternative start on L1 and excludes an active upgrade from current sites', () => {
    expect(applyValidatedSectProductionCommandV10(l1, context(l1), startCommand(l1))).toMatchObject({ ok: false, code: 'WORKSTATION_UNAVAILABLE' });
    expect(sectProductionSitesV10(begun, getSectRecipeDefinition('craft.wound-powder.v9')!)).toEqual([]);
    expect(applyValidatedSectProductionCommandV10(begun, context(begun), { ...startCommand(begun, 'craft.wound-powder.v9'), workerId: 'entity:3' })).toMatchObject({ ok: false, code: 'WORKSTATION_UNAVAILABLE' });
  });
  it('awards no work on arrival and preserves real work/delivery Manhattan-time evidence', () => {
    expect(lastJob(arrived).activeTicks).toBe(0);
    const job = lastJob(completed); const storage = completed.construction.legacyStations.find(site => site.blueprintId === 'storage')!;
    expect(job.workVisit!.tick - job.startedTick).toBeGreaterThanOrEqual(Math.max(1, cardinalDistance(job.origin, job.productiveSite.position) * 4));
    expect(job.workSpans[0]!.firstTick).toBeGreaterThan(job.workVisit!.tick);
    expect(job.deliveryVisit!.tick - job.workSpans.at(-1)!.lastTick).toBeGreaterThanOrEqual(Math.max(1, cardinalDistance(job.productiveSite.position, storage) * 4));
    expect(lastJob(delivery).seatSiteId).toBeNull(); expect(lastJob(awaiting).seatSiteId).toBeNull();
  });
  it.each(['TravellingToStorage', 'AwaitingDelivery'] as const)('keeps %s inside the production lifetime despite released seat', phase => {
    const source = phase === 'TravellingToStorage' ? delivery : awaiting;
    const upgrade = source.upgrade.jobs[0]!;
    // Intentionally corrupt an extra upgrade interval; record leaf must catch overlap even
    // though its independent upgrade validator would also reject a second L2 attempt.
    const overlap = { ...source, upgrade: { ...source.upgrade, jobs: [...source.upgrade.jobs,
      { ...upgrade, jobId: 'sect-upgrade:3', startedTick: source.construction.lastSimulationTick,
        startedCalendarTick: source.construction.lastCalendarTick, terminal: null }] } };
    expect(validateSectProductionRecordsV10(overlap)).toContainEqual({ code: 'PRODUCTION_UPGRADE_OVERLAP', path: lastJob(source).transactionId });
  });
  it('cannot replace true L2 provenance with a flag, wrong upgrade ID, or an upgraded historical L1 proof', () => {
    const job = lastJob(started);
    for (const patch of [{ upgradeJobId: 'sect-upgrade:999' }, { upgradeJobId: undefined }, { upgradeJobId: null }, { level: 1 }, { sourceJobId: 'sect-construction:999' }, { firstMaintenanceCalendarTick: undefined }]) {
      expect(validateSectProductionRecordsV10(withJob(started, corrupt(job, { productiveSite: corrupt(job.productiveSite, patch) }))).length).toBeGreaterThan(0);
    }
    const historical = l2.production.jobs.at(-1)!;
    expect(validateSectProductionRecordsV10(withJob(l2, corrupt(historical, { productiveSite: { ...historical.productiveSite, level: 2, upgradeJobId: l2.upgrade.jobs[0]!.jobId } }))).length).toBeGreaterThan(0);
  });
  it('rejects malformed proof values and accessors before canonical serialization reads them', () => {
    const job = lastJob(started);
    for (const productiveSite of [null, undefined, [], { ...job.productiveSite, position: { x: undefined, y: 3 } }]) {
      expect(validateSectProductionRecordsV10(withJob(started, corrupt(job, { productiveSite })))).toContainEqual({ code: 'INVALID_SITE_SOURCE', path: job.transactionId });
    }
    let reads = 0; const productiveSite = { ...job.productiveSite };
    Object.defineProperty(productiveSite, 'level', { enumerable: true, get: () => { reads++; return 2; } });
    expect(validateSectProductionRecordsV10(withJob(started, corrupt(job, { productiveSite })))).toContainEqual({ code: 'INVALID_SITE_SOURCE', path: job.transactionId });
    expect(reads).toBe(0);
  });
  it('rejects swapped base/alternative research references in the fixed consumer join', () => {
    const job = lastJob(started);
    const forged = withJob(started, corrupt(job, { researchGate: { researchId: 'basic-medicine.v9', completionJobId: l2.research.jobs[0]!.jobId } }));
    expect(validateSectResearchConsumerGatesV10(forged)).toContainEqual({ code: 'INVALID_RESEARCH_GATE', path: job.transactionId });
  });
  it('refuses missing independently completed research even when a genuine L2 source is present', () => {
    const missing = { ...l2, research: { ...l2.research, jobs: l2.research.jobs.filter(job => job.researchId !== 'herbal-compatibility.v9') } };
    expect(applyValidatedSectProductionCommandV10(missing, context(missing), startCommand(missing))).toMatchObject({ ok: false, code: 'RESEARCH_AUTHORITY_REQUIRED' });
  });
  it('preserves input reservations and produces nothing when storage is full, with cancellation still possible', () => {
    const source = cloneJson(awaiting);
    const full: SectUpgradeFrameV10 = { ...source, construction: { ...source.construction, ledger: { ...source.construction.ledger,
      stock: { ...source.construction.ledger.stock, 'wound-powder': { ...source.construction.ledger.stock['wound-powder'], owned: source.construction.ledger.stock['wound-powder'].capacity } } } } };
    const blocked = step(full); const job = lastJob(blocked);
    expect(job).toMatchObject({ phase: 'AwaitingDelivery', state: 'Blocked', blockedReason: 'CAPACITY_EXCEEDED', terminal: null });
    const claim = blocked.construction.ledger.reservations.find(claim => claim.reservationId === job.reservationId)!;
    expect(sectReservationLines(claim, 'consumed')).toEqual([]); expect(claim.base.settlement).toBeNull();
    const cancelled = checked(cancel(blocked));
    expect(lastJob(cancelled).terminal).toMatchObject({ kind: 'cancelled', consumed: [], outputs: [] });
    expect(lastJob(cancelled).terminal!.released).toEqual(sectReservationLines(claim, 'lines'));
  });
  it('rechecks the fixed gate at delivery and does not settle when it has been corrupted', () => {
    const job = lastJob(awaiting); const broken = withJob(awaiting, corrupt(job, { researchGate: { researchId: 'herbal-compatibility.v9', completionJobId: 'sect-research:999' } }));
    const blocked = step(broken);
    expect(lastJob(blocked)).toMatchObject({ terminal: null, blockedReason: 'WORKSTATION_UNAVAILABLE' });
    expect(blocked.construction.ledger.stock['wound-powder']).toEqual(broken.construction.ledger.stock['wound-powder']);
  });
  it('keeps claims, input identity and exact command replay independent of cross-domain revision magnitudes', () => {
    const unchanged = canonicalStringify(l2); const command = startCommand(l2);
    const replay = applyValidatedSectProductionCommandV10(started, context(started), command);
    expect(replay).toMatchObject({ ok: true, repeated: true, jobId: lastJob(started).transactionId });
    expect(applyValidatedSectProductionCommandV10(started, context(started), { ...command, workerId: 'entity:3' })).toMatchObject({ ok: false, code: 'IDENTITY_CONFLICT' });
    expect(canonicalStringify(l2)).toBe(unchanged);
    const reorderedCounters = { ...completed, production: { ...completed.production, revision: completed.production.revision + 9999 } };
    expect(validateSectProductionRecordsV10(reorderedCounters)).toEqual([]);
  });
  it.each(['work', 'navigation', 'cost', 'receipt', 'delivery', 'terminal'] as const)('retains original %s record rejection strength', kind => {
    const frame = cloneJson(completed); const job = lastJob(frame);
    if (kind === 'work') expect(validateSectProductionRecordsV10(withJob(frame, { ...job, activeTicks: job.activeTicks - 1 })).length).toBeGreaterThan(0);
    if (kind === 'navigation') expect(validateSectProductionRecordsV10(withJob(frame, { ...job, navigation: { ...job.navigation, movementTicks: 4 } })).length).toBeGreaterThan(0);
    if (kind === 'cost') {
      const altered = { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger, reservations: frame.construction.ledger.reservations.map(claim => claim.reservationId !== job.reservationId ? claim
        : { ...claim, base: { ...claim.base, lines: [{ resourceId: 'herbs' as const, quantity: 3 }] } }) } } };
      expect(validateSectProductionRecordsV10(altered)).toContainEqual({ code: 'INVALID_COST_SOURCE', path: job.transactionId });
    }
    if (kind === 'receipt') expect(validateSectProductionReceiptsV10({ ...frame, production: { ...frame.production, receipts: frame.production.receipts.slice(0, -1) } })).toContainEqual({ code: 'MISSING_RECEIPT', path: job.transactionId });
    if (kind === 'delivery') expect(validateSectProductionRecordsV10(withJob(frame, { ...job, deliveryVisit: { ...job.deliveryVisit!, tick: job.workSpans.at(-1)!.lastTick, calendarTick: job.workSpans.at(-1)!.lastCalendarTick } })).length).toBeGreaterThan(0);
    if (kind === 'terminal') expect(validateSectProductionRecordsV10(withJob(frame, { ...job, terminal: { ...job.terminal!, tick: job.deliveryVisit!.tick, calendarTick: job.deliveryVisit!.calendarTick } })).length).toBeGreaterThan(0);
  });
});
