import { beforeAll, describe, expect, it } from 'vitest';
import type { SectRecipeId, SectResearchId } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { cardinalDistance, emptyNavigation } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { startProduction, tickProduction } from '../../src/core/economy/production';
import { tickClock } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { createConstructionFrame } from '../../src/core/sect-expansion/construction';
import type { ConstructionContext } from '../../src/core/sect-expansion/construction-types';
import { sectReservationLines } from '../../src/core/sect-expansion/ledger';
import { applySectMaintenanceConstructionCommand, applySectMaintenanceProductionCommand, applySectMaintenanceResearchCommand,
  createSectMaintenanceFrame, tickSectMaintenance } from '../../src/core/sect-expansion/maintenance';
import type { SectMaintenanceFrame, SectMaintenanceResult } from '../../src/core/sect-expansion/maintenance-types';
import { tickValidatedSectMaintenancePaymentV10 } from '../../src/core/sect-expansion/maintenance-runtime-v10';
import { validateSectMaintenanceRecordsV10 } from '../../src/core/sect-expansion/maintenance-v10';
import { validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';
import { createSectProductionFrame } from '../../src/core/sect-expansion/production';
import { createSectResearchFrame } from '../../src/core/sect-expansion/research';
import { applySectUpgradeCommandV10, tickSectUpgradeV10 } from '../../src/core/sect-expansion/upgrade-runtime';
import { previewSectUpgradeFromIsolatedFrameV10 as previewSectUpgradeV10, sectBuildingLevelAtFromIsolatedFrameV10 as sectBuildingLevelAtV10, sectBuildingStatusFromIsolatedFrameV10 as sectBuildingStatusV10 } from '../../src/core/sect-expansion/upgrade-queries';
import { createSectUpgradeStateV10, isSectUpgradeCommandV10, isSectUpgradeDataTreeV10, sectUpgradeClaimsV10,
  validateSectUpgradeRecordsV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, SectUpgradeCommandV10, SectUpgradeFrameV10, SectUpgradeResultV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createWorld } from '../../src/core/world/create-world';
import { lookupProduction } from '../../src/core/world/history-access';
import type { WorldState } from '../../src/core/world/types';

const context = (frame: { construction: { lastSimulationTick: number; lastCalendarTick: number } }, patch: Partial<ConstructionContext> = {}): ConstructionContext => ({
  simulationTick: frame.construction.lastSimulationTick, calendarTick: frame.construction.lastCalendarTick,
  mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [], ...patch,
});
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
function produce(frame: SectMaintenanceFrame, recipeId: SectRecipeId): SectMaintenanceFrame {
  const started = oldAccept(applySectMaintenanceProductionCommand(frame, context(frame), { kind: 'production.start',
    commandId: `upgrade-fixture.production:${frame.production.revision}`, expectedRevision: frame.production.revision, recipeId, workerId: 'entity:2' }));
  return oldUntil(started, value => value.production.jobs.at(-1)!.terminal !== null);
}
function research(frame: SectMaintenanceFrame, researchId: SectResearchId): SectMaintenanceFrame {
  const started = oldAccept(applySectMaintenanceResearchCommand(frame, context(frame), { kind: 'research.start',
    commandId: `upgrade-fixture.research:${frame.research.revision}`, expectedRevision: frame.research.revision, researchId, workerId: 'entity:2' }));
  return oldUntil(started, value => value.research.jobs.at(-1)!.terminal !== null);
}
function build(frame: SectMaintenanceFrame, definitionId: 'library.v9' | 'alchemy.v9', x: number): SectMaintenanceFrame {
  const placed = oldAccept(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'blueprint.place',
    commandId: `upgrade-fixture.place:${frame.construction.revision}`, expectedRevision: frame.construction.revision,
    placement: { definitionId, anchor: { x, y: 1 }, rotation: 0 } }));
  const started = oldAccept(applySectMaintenanceConstructionCommand(placed, context(placed), { kind: 'construction.start',
    commandId: `upgrade-fixture.build:${placed.construction.revision}`, expectedRevision: placed.construction.revision,
    blueprintId: placed.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' }));
  return oldUntil(started, value => value.construction.jobs.at(-1)!.terminal !== null);
}
function legacyProduce(world: WorldState, recipeId: string): WorldState {
  const result = startProduction(world, `upgrade-fixture.legacy:${world.clock.simulationTick}`, recipeId, 'entity:4');
  if (!result.ok) throw new Error(result.rejection.code);
  world = result.world;
  for (let n = 0; n < 1000 && world.activeProductionTransactionIds.includes(result.transactionId); n++) world = tickProduction({ ...world, clock: tickClock(world.clock) });
  expect(lookupProduction(world, result.transactionId)).toMatchObject({ state: 'Committed', phase: 'Done', recipeId }); return world;
}
function project(world: WorldState): SectMaintenanceFrame {
  return createSectMaintenanceFrame(createSectResearchFrame(createSectProductionFrame(createConstructionFrame({ map: world.map,
    legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    people: world.disciples.map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState, canWork: person.canWork, away: false,
      productionTransactionId: person.assignmentTransactionId, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick,
  }))));
}
/** Explicit standalone domain lift, not a World migration or a v10 admission certificate. */
function lift(source: SectMaintenanceFrame): SectUpgradeFrameV10 {
  expect(validateSectMaintenanceFrame(source)).toEqual([]);
  if (source.construction.buildings.some(building => building.level !== 1)) throw new Error('Not an immutable L1 origin');
  return cloneJson({ schemaVersion: 2, construction: { ...source.construction, buildings: source.construction.buildings.map(building => ({ ...building, level: 1 as const })) },
    production: { ...source.production, jobs: source.production.jobs.map((job): SectProductionJobV10 => {
      if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('The old fixture cannot contain an L2 alternative recipe');
      return { ...job, recipeId: job.recipeId };
    }) }, research: source.research, maintenance: source.maintenance,
    care: { revision: 0, nextId: 1, jobs: [], receipts: [] }, upgrade: createSectUpgradeStateV10() });
}
function accept(result: SectUpgradeResultV10): SectUpgradeFrameV10 {
  if (!result.ok) throw new Error(`${result.code}: ${JSON.stringify(validateSectUpgradeRecordsV10(result.frame))}`);
  return result.frame;
}
const target = (frame: SectUpgradeFrameV10): string => frame.construction.buildings.find(value => value.definitionId === 'alchemy.v9')!.buildingId;
const command = (frame: SectUpgradeFrameV10): SectUpgradeCommandV10 => ({ kind: 'upgrade.start', commandId: `upgrade-test.start:${frame.upgrade.revision}`,
  expectedRevision: frame.upgrade.revision, buildingId: target(frame), workerId: 'entity:2' });
const start = (frame: SectUpgradeFrameV10): SectUpgradeFrameV10 => accept(applySectUpgradeCommandV10(frame, context(frame), command(frame)));
const cancelCommand = (frame: SectUpgradeFrameV10): SectUpgradeCommandV10 => ({ kind: 'upgrade.cancel', commandId: `upgrade-test.cancel:${frame.upgrade.revision}`,
  expectedRevision: frame.upgrade.revision, jobId: frame.upgrade.jobs.at(-1)!.jobId });
const cancel = (frame: SectUpgradeFrameV10): SectUpgradeFrameV10 => accept(applySectUpgradeCommandV10(frame, context(frame), cancelCommand(frame)));
/** The enclosing domain harness advances the single clock first, as the v10 root must.
 * These tests do not claim the missing complete World/lifecycle/capacity stages ran. */
function step(frame: SectUpgradeFrameV10, patch: Partial<ConstructionContext> = {}): SectUpgradeFrameV10 {
  const projected: SectUpgradeFrameV10 = { ...frame, construction: { ...frame.construction,
    lastSimulationTick: frame.construction.lastSimulationTick + 1, lastCalendarTick: frame.construction.lastCalendarTick + 1 } };
  const ctx = context(projected, patch);
  return accept(tickSectUpgradeV10(projected, ctx, createWorkPathBudget(ctx.simulationTick)));
}
function until(frame: SectUpgradeFrameV10, predicate: (frame: SectUpgradeFrameV10) => boolean): SectUpgradeFrameV10 {
  for (let n = 0; n < 1600 && !predicate(frame); n++) frame = step(frame);
  expect(predicate(frame)).toBe(true); return frame;
}
/** Explicit idle-clock boundary fixture, not a claim of intervening World simulation. */
function idleAt(frame: SectUpgradeFrameV10, tick: number): SectUpgradeFrameV10 {
  if (tick < frame.construction.lastSimulationTick) throw new Error('Cannot backdate an idle boundary');
  return cloneJson({ ...frame, construction: { ...frame.construction, lastSimulationTick: tick, lastCalendarTick: tick } });
}
function failed(source: SectUpgradeFrameV10, result: SectUpgradeResultV10, code: string): void {
  expect(result).toMatchObject({ ok: false, code }); expect(result.frame).toBe(source);
}
let world: WorldState; let old: SectMaintenanceFrame; let empty: SectMaintenanceFrame; let oldReady: SectMaintenanceFrame;
let ready: SectUpgradeFrameV10; let begun: SectUpgradeFrameV10; let arrived: SectUpgradeFrameV10;
let recordPressure: SectUpgradeFrameV10;
let at199: SectUpgradeFrameV10; let at200: SectUpgradeFrameV10; let at399: SectUpgradeFrameV10; let done: SectUpgradeFrameV10;
beforeAll(() => {
  world = createWorld('upgrade-real-materials');
  for (let n = 0; n < 10; n++) world = legacyProduce(world, 'gather.wood');
  for (let n = 0; n < 8; n++) world = legacyProduce(world, 'gather.herbs');
  for (let n = 0; n < 10; n++) world = legacyProduce(world, 'craft.plank');
  empty = project(world); old = empty;
});
beforeAll(() => { for (let n = 0; n < 5; n++) old = produce(old, 'gather.stone.v9'); });
beforeAll(() => { for (let n = 0; n < 3; n++) old = produce(old, 'extract.spirit-stone.v9'); });
beforeAll(() => { for (let n = 0; n < 3; n++) old = produce(old, 'extract.spirit-stone.v9'); old = build(old, 'library.v9', 1); });
beforeAll(() => { old = research(produce(produce(old, 'study.basic-insight.v9'), 'study.basic-insight.v9'), 'basic-medicine.v9'); });
beforeAll(() => { old = produce(produce(old, 'study.basic-insight.v9'), 'study.basic-insight.v9'); });
beforeAll(() => { old = research(produce(produce(old, 'study.basic-insight.v9'), 'study.basic-insight.v9'), 'herbal-compatibility.v9'); });
beforeAll(() => { oldReady = build(old, 'alchemy.v9', 10); ready = lift(oldReady); begun = start(ready); arrived = until(begun, value => value.upgrade.jobs[0]!.phase === 'working'); });
beforeAll(() => { at199 = until(arrived, value => value.upgrade.jobs[0]!.activeTicks === 199); at200 = step(at199); });
beforeAll(() => { at399 = until(at200, value => value.upgrade.jobs[0]!.activeTicks === 399); done = step(at399); });

beforeAll(() => { recordPressure = ready; });
// Exact row-limit fixture built by the same actual start/cancel reducers, in bounded setup batches.
for (let batch = 0; batch < 7; batch++) beforeAll(() => {
  for (let n = 0; n < 18; n++) recordPressure = cancel(start(recordPressure));
});

// These fixtures use safe standalone wrappers; the frozen validated ports are root-only stages.
describe('v10 bounded upgrade domain, without World admission', () => {
  it('earns both prerequisite researches and six stone/plank using real legacy and sect reducers', () => {
    expect(empty.construction.ledger.stock).toEqual(createEmptySectStock());
    expect(ready.research.jobs.map(job => [job.researchId, job.activeTicks])).toEqual([['basic-medicine.v9', 240], ['herbal-compatibility.v9', 400]]);
    expect(ready.construction.ledger.inventory.stone.owned).toBeGreaterThanOrEqual(6);
    expect(ready.construction.ledger.inventory.plank.owned).toBe(6);
    expect(validateSectUpgradeRecordsV10(ready)).toEqual([]);
    expect(ready.upgrade).toEqual(createSectUpgradeStateV10());
  });
  it('reserves both costs atomically, owns the three exact claims and keeps immutable L1 origin', () => {
    const job = begun.upgrade.jobs[0]!;
    expect(job).toMatchObject({ jobId: 'sect-upgrade:1', reservationId: 'sect-upgrade-reservation:2', fromLevel: 1, toLevel: 2, activeTicks: 0 });
    expect(begun.upgrade.nextId).toBe(3); expect(begun.upgrade.revision).toBe(1);
    for (const resource of ['stone', 'plank'] as const) expect(begun.construction.ledger.inventory[resource]).toMatchObject({ owned: ready.construction.ledger.inventory[resource].owned, reserved: 6 });
    expect(sectUpgradeClaimsV10(begun)).toEqual([{ kind: 'worker', key: job.workerId, ownerId: job.jobId },
      { kind: 'seat', key: target(begun), ownerId: job.jobId }, { kind: 'entrance', key: job.entranceToken, ownerId: job.jobId }]);
    expect(begun.construction.buildings).toEqual(ready.construction.buildings);
    expect(begun.construction.map).toEqual(ready.construction.map);
    expect(sectBuildingStatusV10(begun, target(begun))).toMatchObject({ level: { level: 1 }, paid: true, operational: false });
  });
  it('travels warehouse then real entrance, with no work on either arrival boundary', () => {
    const job = arrived.upgrade.jobs[0]!;
    expect(job.activeTicks).toBe(0); expect(job.storageVisit!.tick).toBeGreaterThan(job.startedTick);
    expect(job.storageVisit!.tick - job.startedTick).toBeGreaterThanOrEqual(Math.max(1, cardinalDistance(job.origin, job.storagePosition) * 4));
    expect(job.siteVisits[0]!.tick - job.storageVisit!.tick).toBeGreaterThanOrEqual(Math.max(1, cardinalDistance(job.storagePosition, job.site.position) * 4));
    expect(arrived.construction.people.find(person => person.id === job.workerId)!.position).toEqual(job.site.position);
    expect(job.navigation).toEqual(emptyNavigation()); expect(job.workSpans).toEqual([]);
  });
  it('joins exact 200/400 work ordinals to paired checkpoints and commits without creating another building', () => {
    expect(at199.upgrade.jobs[0]!.checkpoints).toEqual([]);
    const half = at200.upgrade.jobs[0]!.checkpoints[0]!;
    expect(half).toMatchObject({ activeTicks: 200, checkpointId: 'construction.half', tick: at200.construction.lastSimulationTick });
    expect(at399.upgrade.jobs[0]!.checkpoints).toHaveLength(1);
    const job = done.upgrade.jobs[0]!; const claim = done.construction.ledger.reservations.at(-1)!;
    expect(job).toMatchObject({ activeTicks: 400, phase: 'completed', terminal: { resultLevel: 2, previousPhase: 'working', cancellation: null } });
    expect(job.checkpoints[1]!.tick).toBe(job.terminal!.tick);
    expect(claim.base.checkpoints.map(value => value.checkpointId)).toEqual(['construction.half', 'construction.remainder']);
    expect(claim.sect.checkpoints).toEqual([{ checkpointId: 'construction.half', lines: [] }, { checkpointId: 'construction.remainder', lines: [] }]);
    expect(claim.base.settlement).toEqual({ kind: 'committed', operationId: `complete:${job.jobId}`, outputs: [] });
    expect(sectReservationLines(claim, 'remainingReservation')).toEqual([]);
    for (const resource of ['stone', 'plank'] as const) expect(done.construction.ledger.inventory[resource]).toMatchObject({ owned: ready.construction.ledger.inventory[resource].owned - 6, reserved: 0 });
    expect(done.construction.buildings).toEqual(ready.construction.buildings); expect(done.construction.map.navVersion).toBe(ready.construction.map.navVersion);
    expect(sectUpgradeClaimsV10(done)).toEqual([]); expect(done.upgrade.receipts).toHaveLength(1);
  });
  it.each([0, 199, 200, 399])('refunds only genuinely remaining material at %i work ticks, keeping worker position', ticks => {
    const source = ({ 0: begun, 199: at199, 200: at200, 399: at399 })[ticks as 0 | 199 | 200 | 399];
    const cancelled = cancel(source); const job = cancelled.upgrade.jobs[0]!; const remaining = ticks < 200 ? 6 : 3;
    expect(job.terminal).toMatchObject({ kind: 'cancelled', resultLevel: 1, cancellation: { kind: 'requested' } });
    expect(job.terminal!.released.map(line => line.quantity)).toEqual([remaining, remaining]);
    for (const resource of ['stone', 'plank'] as const) expect(cancelled.construction.ledger.inventory[resource]).toMatchObject({ owned: ready.construction.ledger.inventory[resource].owned - (6 - remaining), reserved: 0 });
    expect(cancelled.construction.people).toEqual(source.construction.people);
    expect(cancelled.construction.buildings).toEqual(ready.construction.buildings);
    expect(sectBuildingLevelAtV10(cancelled, target(cancelled), cancelled.construction.lastSimulationTick, 'after-upgrade')?.level).toBe(1);
    expect(sectUpgradeClaimsV10(cancelled)).toEqual([]);
    expect(applySectUpgradeCommandV10(cancelled, context(cancelled), cancelCommand(source))).toMatchObject({ ok: true, repeated: true });
  });
  it('derives historical phase level exactly, including maintenance-before-upgrade at the same tick', () => {
    const tick = done.upgrade.jobs[0]!.terminal!.tick; const buildingId = target(done);
    expect(sectBuildingLevelAtV10(done, buildingId, tick - 1, 'after-upgrade')?.level).toBe(1);
    expect(sectBuildingLevelAtV10(done, buildingId, tick, 'maintenance')?.level).toBe(1);
    expect(sectBuildingLevelAtV10(done, buildingId, tick, 'after-upgrade')).toEqual({ level: 2, constructionJobId: done.construction.buildings.at(-1)!.sourceJobId, upgradeJobId: 'sect-upgrade:1' });
    expect(sectBuildingLevelAtV10(step(done), buildingId, tick + 1, 'maintenance')?.level).toBe(2);
    const status = sectBuildingStatusV10(done, buildingId)!;
    expect(status.dueCalendarTick).toBe(ready.construction.buildings.at(-1)!.firstMaintenanceCalendarTick);
    expect(status.nextMaintenanceCosts).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 1 }]);
    failed(done, applySectUpgradeCommandV10(done, context(done), command(done)), 'ALREADY_UPGRADED');
    failed(done, applySectUpgradeCommandV10(done, context(done), cancelCommand(done)), 'TRANSACTION_FINISHED');
  });
  it('rejects forged L1 origin gates before any upgrade exists or a preview claims eligibility', () => {
    const frame = cloneJson(ready) as any;
    frame.construction.blueprints.at(-1).researchGate.completionJobId = frame.research.jobs[1].jobId;
    expect(validateSectUpgradeRecordsV10(frame).some(issue => issue.code === 'INVALID_UPGRADE_L1_RESEARCH_SOURCE')).toBe(true);
    expect(previewSectUpgradeV10(frame, context(frame), target(frame), 'entity:2')).toMatchObject({ eligible: false, rejection: 'INVALID_FRAME' });
    failed(frame, applySectUpgradeCommandV10(frame, context(frame), command(frame)), 'INVALID_FRAME');
  });
  it('replays exact bodies before stale-revision or fresh capacity checks, rejects ID collisions', () => {
    const sourceText = canonicalStringify(ready);
    expect(applySectUpgradeCommandV10(done, context(done, { externalActiveJobs: 36 }), command(ready))).toMatchObject({ ok: true, repeated: true });
    failed(begun, applySectUpgradeCommandV10(begun, context(begun), { ...command(ready), workerId: 'entity:3' } as SectUpgradeCommandV10), 'IDENTITY_CONFLICT');
    failed(ready, applySectUpgradeCommandV10(ready, context(ready), { ...command(ready), commandId: ready.research.receipts[0]!.command.commandId }), 'IDENTITY_CONFLICT');
    expect(canonicalStringify(ready)).toBe(sourceText);
  });
  it('previews without reserving and detaches all accepted output objects from caller-owned source', () => {
    const text = canonicalStringify(ready); const preview = previewSectUpgradeV10(ready, context(ready), target(ready), 'entity:2');
    expect(preview).toMatchObject({ eligible: true, rejection: null, requiredTicks: 400 });
    expect(canonicalStringify(ready)).toBe(text);
    const result = start(ready) as any; result.construction.people[0].position.x = 13; result.upgrade.jobs[0].site.position.x = 13;
    expect(canonicalStringify(ready)).toBe(text);
  });
  it('checks worker, seat, entrance and total work claims without quietly cancelling owners', () => {
    const site = begun.upgrade.jobs[0]!.site;
    for (const claim of [{ kind: 'worker' as const, key: 'entity:2', ownerId: 'external' }, { kind: 'seat' as const, key: target(ready), ownerId: 'external' },
      { kind: 'entrance' as const, key: `${site.position.x},${site.position.y}`, ownerId: 'external' }]) failed(ready,
      applySectUpgradeCommandV10(ready, context(ready, { externalClaims: [claim] }), command(ready)), 'CLAIM_CONFLICT');
    failed(ready, applySectUpgradeCommandV10(ready, context(ready, { externalActiveJobs: 36 }), command(ready)), 'CAPACITY_EXCEEDED');
    failed(begun, applySectUpgradeCommandV10(begun, context(begun), command(begun)), 'UPGRADE_ACTIVE');
  });
  it('rejects a real pending delivery even after that production job released its seat', () => {
    const started = oldAccept(applySectMaintenanceProductionCommand(oldReady, context(oldReady), { kind: 'production.start', commandId: 'upgrade-fixture.delivery',
      expectedRevision: oldReady.production.revision, recipeId: 'craft.wound-powder.v9', workerId: 'entity:2' }));
    const delivery = oldUntil(started, value => value.production.jobs.at(-1)!.phase === 'TravellingToStorage');
    const frame = lift(delivery); expect(frame.production.jobs.at(-1)!.seatSiteId).toBeNull();
    failed(frame, applySectUpgradeCommandV10(frame, context(frame), { ...command(frame), workerId: 'entity:3' } as SectUpgradeCommandV10), 'BUILDING_BUSY');
  });
  it('uses a shared exhausted navigation budget, and paused/no-op stages do not increment upgrade revision', () => {
    const projected = { ...begun, construction: { ...begun.construction, lastSimulationTick: begun.construction.lastSimulationTick + 1, lastCalendarTick: begun.construction.lastCalendarTick + 1 } };
    const ctx = context(projected); const budget = createWorkPathBudget(ctx.simulationTick);
    for (let n = 0; n < 4; n++) advanceWorkNavigationWithBudget({ map: projected.construction.map, position: { x: 0, y: 0 }, target: { x: 1, y: 0 }, navigation: emptyNavigation(), simulationTick: ctx.simulationTick }, budget);
    const blocked = accept(tickSectUpgradeV10(projected, ctx, budget));
    expect(blocked.upgrade.jobs[0]!.blocked).toBe('PATH_BUDGET'); expect(blocked.construction.people).toEqual(projected.construction.people);
    const paused = accept(tickSectUpgradeV10(blocked, context(blocked, { paused: true }), createWorkPathBudget(ctx.simulationTick)));
    expect(paused).toEqual(blocked);
    expect(step(done).upgrade.revision).toBe(done.upgrade.revision);
  });
  it('records a fresh site visit after losing the work position, without work on reacquisition', () => {
    const displaced = cloneJson(at200) as any; const person = displaced.construction.people.find((value: any) => value.id === 'entity:2'); person.position = { x: 9, y: 3 };
    const reentered = until(displaced, value => value.upgrade.jobs[0]!.siteVisits.length === 2);
    expect(reentered.upgrade.jobs[0]!.activeTicks).toBe(200);
    expect(step(reentered).upgrade.jobs[0]!.workSpans.at(-1)!.visitIndex).toBe(1);
  });
  it('never processes a dying worker’s would-be 400th tick and refuses fabricated death authorization', () => {
    const pending = cloneJson(at399) as any; pending.construction.people.find((value: any) => value.id === 'entity:2').lifeState = 'pendingDeath';
    failed(pending, tickSectUpgradeV10(pending, context(pending), createWorkPathBudget(pending.construction.lastSimulationTick)), 'WORKER_UNAVAILABLE');
    expect(pending.upgrade.jobs[0].activeTicks).toBe(399);
    const cancelled = cloneJson(cancel(at200)) as any; cancelled.upgrade.jobs[0].terminal.cancellation = { kind: 'death', deathId: 'death:1' };
    expect(validateSectUpgradeRecordsV10(cancelled).some(issue => issue.code === 'UPGRADE_DEATH_AUTHORITY_REQUIRED')).toBe(true);
    const missing = cloneJson(done) as any; missing.construction.people = missing.construction.people.filter((value: any) => value.id !== 'entity:2');
    expect(validateSectUpgradeRecordsV10(missing).length).toBeGreaterThan(0);
  });
  it('keeps the last cancellation revision and returns the original source on unsafe cancellation', () => {
    const pressure = cloneJson(begun) as any; pressure.upgrade.revision = Number.MAX_SAFE_INTEGER - 1;
    pressure.construction.lastSimulationTick = Number.MAX_SAFE_INTEGER - 20; pressure.construction.lastCalendarTick = Number.MAX_SAFE_INTEGER - 20;
    expect(cancel(pressure).upgrade.revision).toBe(Number.MAX_SAFE_INTEGER);
    const unsafe = cloneJson(at200) as any; unsafe.construction.people.find((value: any) => value.id === 'entity:2').position = { x: 10, y: 1 };
    failed(unsafe, applySectUpgradeCommandV10(unsafe, context(unsafe), cancelCommand(unsafe)), 'UNSAFE_POSITION');
  });
  it.each(['empty', 'begun', '199', '200', '399', 'done'] as const)('round trips the %s boundary without changing deterministic continuation', label => {
    const frame = ({ empty: ready, begun, '199': at199, '200': at200, '399': at399, done })[label];
    const text = canonicalStringify(frame); const restored = JSON.parse(JSON.stringify(frame)) as SectUpgradeFrameV10;
    expect(validateSectUpgradeRecordsV10(restored)).toEqual([]); expect(step(restored)).toEqual(step(frame)); expect(canonicalStringify(frame)).toBe(text);
  });
  it.each(['direct-level', 'price', 'checkpoint-id', 'checkpoint-price', 'checkpoint-clock', 'terminal-clock', '400-live', 'gate', 'prerequisite', 'l1-gate', 'l1-retroactive-gate', 'site', 'allocation', 'origin-clock', 'receipt', 'extra'] as const)('rejects forged %s evidence', mutation => {
    const frame = cloneJson(done) as any; const job = frame.upgrade.jobs[0]; const claim = frame.construction.ledger.reservations.at(-1);
    if (mutation === 'direct-level') frame.construction.buildings.at(-1).level = 2;
    if (mutation === 'price') claim.base.lines[0].quantity = 5;
    if (mutation === 'checkpoint-id') claim.base.checkpoints[0].checkpointId = 'upgrade.half';
    if (mutation === 'checkpoint-price') claim.base.checkpoints[0].lines[0].quantity = 2;
    if (mutation === 'checkpoint-clock') job.checkpoints[0].tick--;
    if (mutation === 'terminal-clock') job.terminal.tick--;
    if (mutation === '400-live') { job.terminal = null; job.phase = 'working'; }
    if (mutation === 'gate') job.researchGate.completionJobId = frame.research.jobs[0].jobId;
    if (mutation === 'prerequisite') frame.research.jobs[1].prerequisites[0].completionJobId = frame.research.jobs[1].jobId;
    if (mutation === 'l1-gate') frame.construction.blueprints.at(-1).researchGate.completionJobId = frame.research.jobs[1].jobId;
    if (mutation === 'l1-retroactive-gate') frame.construction.blueprints.at(-1).placedTick = frame.research.jobs[0].terminal.tick - 1;
    if (mutation === 'site') job.site.sourceJobId = frame.construction.jobs[0].jobId;
    if (mutation === 'allocation') frame.upgrade.nextId += 2;
    if (mutation === 'origin-clock') job.startedCalendarTick--;
    if (mutation === 'receipt') frame.upgrade.receipts[0].command.workerId = 'entity:3';
    if (mutation === 'extra') job.operational = true;
    expect(validateSectUpgradeRecordsV10(frame).length).toBeGreaterThan(0);
    failed(frame, applySectUpgradeCommandV10(frame, context(frame), command(frame)), 'INVALID_FRAME');
  });
  it('retains cancellable paid-work history when the inherited maintenance period expires', () => {
    const gap = cloneJson(at200) as any;
    const due = gap.construction.buildings.at(-1).firstMaintenanceCalendarTick;
    // Explicit idle-clock pressure; all actual visits/spans/checkpoints remain unchanged.
    gap.construction.lastSimulationTick = due - 1; gap.construction.lastCalendarTick = due - 1;
    const blocked = step(gap);
    expect(blocked.upgrade.jobs[0]).toMatchObject({ blocked: 'MAINTENANCE_UNPAID', activeTicks: 200, terminal: null });
    expect(blocked.construction.ledger).toEqual(at200.construction.ledger);
    expect(step(blocked).upgrade.revision).toBe(blocked.upgrade.revision);
    const cancelled = cancel(blocked);
    expect(sectBuildingStatusV10(cancelled, target(cancelled))).toMatchObject({ paid: false, operational: false, dueCalendarTick: due, level: { level: 1 } });
    expect(cancelled.upgrade.jobs[0]!.terminal!.released.map(line => line.quantity)).toEqual([3, 3]);
  });
  it('preserves the final receipt slot for cancellation at the exact finite record limit', () => {
    expect(recordPressure.upgrade.jobs).toHaveLength(126);
    expect(recordPressure.upgrade.receipts).toHaveLength(252);
    const penultimate = cancel(start(recordPressure));
    const last = start(penultimate);
    expect(last.upgrade.receipts).toHaveLength(255);
    expect(last.upgrade.receipts.length + last.upgrade.jobs.filter(job => !job.terminal).length).toBe(256);
    const finished = cancel(last);
    expect(finished.upgrade.jobs).toHaveLength(128); expect(finished.upgrade.receipts).toHaveLength(256); expect(finished.upgrade.nextId).toBe(257);
    expect(finished.construction.ledger.inventory).toEqual(ready.construction.ledger.inventory);
    failed(finished, applySectUpgradeCommandV10(finished, context(finished), command(finished)), 'CAPACITY_EXCEEDED');
    expect(applySectUpgradeCommandV10(finished, context(finished), cancelCommand(last))).toMatchObject({ ok: true, repeated: true });
  });
  it('renews a genuinely completed L2 at its inherited due, exact paired cost and one idempotent payment', () => {
    const buildingId = target(done); const due = done.construction.buildings.at(-1)!.firstMaintenanceCalendarTick;
    const source = idleAt(done, due); const text = canonicalStringify(source);
    expect(validateSectUpgradeRecordsV10(source)).toEqual([]);
    const renewed = tickValidatedSectMaintenancePaymentV10(source, context(source));
    const payments = renewed.maintenance.payments.filter(payment => payment.buildingId === buildingId);
    const payment = payments.at(-1)!;
    expect(payment).toMatchObject({ paidTick: due, paidCalendarTick: due, previousDueCalendarTick: due,
      dueCalendarTick: due + 1200, predecessorPaymentId: null, rate: { level: 2, upgradeJobId: 'sect-upgrade:1' } });
    const claim = renewed.construction.ledger.reservations.find(value => value.reservationId === payment.reservationId)!;
    expect(sectReservationLines(claim, 'consumed')).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 1 }]);
    expect(claim.base.settlement).toEqual({ kind: 'committed', operationId: `maintain:${payment.paymentId}`, outputs: [] });
    expect(claim.sect.settlement).toEqual({ kind: 'committed', operationId: `maintain:${payment.paymentId}`, outputs: [] });
    expect(renewed.construction.ledger.inventory.herbs.owned).toBe(source.construction.ledger.inventory.herbs.owned - 1);
    expect(validateSectUpgradeRecordsV10(renewed)).toEqual([]); expect(validateSectMaintenanceRecordsV10(renewed)).toEqual([]);
    expect(tickValidatedSectMaintenancePaymentV10(renewed, context(renewed))).toBe(renewed);
    expect(renewed.construction.buildings).toEqual(done.construction.buildings); expect(canonicalStringify(source)).toBe(text);
  });
  it.each([-1, 0, 1])('charges the true historical rate when completion has due offset %i', offset => {
    const buildingId = target(at399); const due = at399.construction.buildings.at(-1)!.firstMaintenanceCalendarTick;
    let source = at399;
    if (offset === 1) { const atDue = idleAt(source, due); source = tickValidatedSectMaintenancePaymentV10(atDue, context(atDue)); }
    const completionBoundary = idleAt(source, due + offset);
    const maintained = tickValidatedSectMaintenancePaymentV10(completionBoundary, context(completionBoundary));
    const completed = accept(tickSectUpgradeV10(maintained, context(maintained), createWorkPathBudget(due + offset)));
    expect(completed.upgrade.jobs[0]!.terminal).toMatchObject({ kind: 'completed', tick: due + offset });
    const paymentBoundary = offset === -1 ? idleAt(completed, due) : completed;
    const paid = tickValidatedSectMaintenancePaymentV10(paymentBoundary, context(paymentBoundary));
    const payment = paid.maintenance.payments.filter(value => value.buildingId === buildingId).at(-1)!;
    expect(payment.paidTick).toBe(due); expect(payment.dueCalendarTick).toBe(due + 1200);
    if (offset === -1) expect(payment.rate).toEqual({ level: 2, upgradeJobId: 'sect-upgrade:1' });
    else expect(Object.hasOwn(payment, 'rate')).toBe(false);
    expect(validateSectUpgradeRecordsV10(paid)).toEqual([]); expect(validateSectMaintenanceRecordsV10(paid)).toEqual([]);
    const nextBoundary = idleAt(paid, due + 1200);
    const nextPayment = tickValidatedSectMaintenancePaymentV10(nextBoundary, context(nextBoundary));
    expect(nextPayment.maintenance.payments.filter(value => value.buildingId === buildingId).at(-1)!.rate).toEqual({ level: 2, upgradeJobId: 'sect-upgrade:1' });
    expect(nextPayment.construction.buildings).toEqual(at399.construction.buildings);
  });
  it('renews active-upgrade L1 despite its claims and keeps both upgrade materials reserved', () => {
    const source = idleAt(at200, at200.construction.buildings.at(-1)!.firstMaintenanceCalendarTick);
    const claims = sectUpgradeClaimsV10(source);
    const renewed = tickValidatedSectMaintenancePaymentV10(source, context(source));
    const payment = renewed.maintenance.payments.filter(value => value.buildingId === target(source)).at(-1)!;
    expect(Object.hasOwn(payment, 'rate')).toBe(false);
    const claim = renewed.construction.ledger.reservations.find(value => value.reservationId === payment.reservationId)!;
    expect(sectReservationLines(claim, 'consumed')).toEqual([{ ledger: 'base', resourceId: 'wood', quantity: 1 }]);
    expect(sectUpgradeClaimsV10(renewed)).toEqual(claims);
    for (const resource of ['stone', 'plank'] as const) expect(renewed.construction.ledger.inventory[resource]).toEqual(source.construction.ledger.inventory[resource]);
    expect(validateSectUpgradeRecordsV10(renewed)).toEqual([]); expect(validateSectMaintenanceRecordsV10(renewed)).toEqual([]);
    expect(accept(tickSectUpgradeV10(renewed, context(renewed), createWorkPathBudget(renewed.construction.lastSimulationTick))).upgrade.jobs[0]!.activeTicks).toBe(201);
  });
  it('does not allocate or debit a failed renewal, including retry while wood remains unavailable', () => {
    const source = idleAt(done, done.construction.buildings.at(-1)!.firstMaintenanceCalendarTick);
    // Explicit available-material pressure. Nothing pretends the depleted wood was earned/spent by a World transition.
    const starved = { ...source, construction: { ...source.construction, ledger: { ...source.construction.ledger,
      inventory: { ...source.construction.ledger.inventory, wood: { ...source.construction.ledger.inventory.wood, owned: 0 } } } } };
    expect(validateSectUpgradeRecordsV10(starved)).toEqual([]);
    expect(tickValidatedSectMaintenancePaymentV10(starved, context(starved))).toBe(starved);
    const later = idleAt(starved, starved.construction.lastSimulationTick + 1);
    const retried = tickValidatedSectMaintenancePaymentV10(later, context(later));
    expect(retried).toBe(later); expect(retried.maintenance).toEqual(source.maintenance);
    expect(retried.construction.ledger.reservations).toEqual(source.construction.ledger.reservations);
    expect(sectBuildingStatusV10(retried, target(retried))).toMatchObject({ paid: false, operational: false });
  });
  it('enforces exact player command grammar and never invokes accessors during hostile capture', () => {
    let reads = 0; const accessor = Object.defineProperty({}, 'kind', { enumerable: true, get: () => { reads++; return 'upgrade.start'; } });
    expect(isSectUpgradeCommandV10(accessor)).toBe(false); expect(reads).toBe(0);
    for (const commandId of ['', '__proto__', 'constructor', 'prototype', 'system/v10/death/death:1/sect-upgrade:1', 'prefix/id', 'x'.repeat(129)])
      expect(isSectUpgradeCommandV10({ ...command(ready), commandId })).toBe(false);
    expect(isSectUpgradeCommandV10({ ...command(ready), claimedPayment: 6 })).toBe(false);
    expect(isSectUpgradeCommandV10({ ...command(ready), expectedRevision: Infinity })).toBe(false);
    const alias = {}; expect(isSectUpgradeDataTreeV10({ a: alias, b: alias })).toBe(false);
    expect(isSectUpgradeDataTreeV10(new Array(5))).toBe(false);
    expect(isSectUpgradeDataTreeV10({ value: undefined })).toBe(false);
    expect(isSectUpgradeDataTreeV10(Object.create(null))).toBe(false);
    expect(isSectUpgradeDataTreeV10({ [Symbol('x')]: 1 })).toBe(false);
    expect(isSectUpgradeDataTreeV10(new Proxy({}, { ownKeys: () => { throw new Error('hostile'); } }))).toBe(false);
  });
});
