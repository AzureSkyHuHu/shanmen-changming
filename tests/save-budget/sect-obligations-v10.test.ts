import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getSectRecipeDefinition, SECT_V9_CANDIDATE_IDENTITY } from '../../src/content/sect-v9/catalog';
import type { SectRecipeId, SectResearchId, SectResourceLine } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import type { LedgerClaim } from '../../src/core/economy/ledger-operations';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { navigationPathByteBudget } from '../../src/core/save-budget/bounds';
import * as recordMeasures from '../../src/core/save-budget/progression-bounds';
import { deriveSectRecordObligations, deriveSectReservationsV9 } from '../../src/core/save-budget/sect-obligations-v9';
import { deriveSectReservationsV10 } from '../../src/core/save-budget/sect-obligations-v10';
import { deriveSectUpgradeObligationsV10 } from '../../src/core/save-budget/upgrade-obligations-v10';
import type { SectCareJob } from '../../src/core/sect-expansion/care-types';
import { createConstructionFrame } from '../../src/core/sect-expansion/construction';
import type { ConstructionContext } from '../../src/core/sect-expansion/construction-types';
import type { SectLedgerReservation } from '../../src/core/sect-expansion/ledger';
import { applySectMaintenanceConstructionCommand, applySectMaintenanceProductionCommand,
  applySectMaintenanceResearchCommand, createSectMaintenanceFrame, tickSectMaintenance } from '../../src/core/sect-expansion/maintenance';
import { tickValidatedSectMaintenancePaymentV10 } from '../../src/core/sect-expansion/maintenance-runtime-v10';
import type { SectMaintenanceFrame, SectMaintenanceResult } from '../../src/core/sect-expansion/maintenance-types';
import { validateSectMaintenanceRecordsV10 } from '../../src/core/sect-expansion/maintenance-v10';
import { validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';
import { createSectProductionFrame } from '../../src/core/sect-expansion/production';
import { applyValidatedSectProductionCommandV10, tickValidatedSectProductionV10,
  validateSectProductionRecordsV10, validateSectProductionReceiptsV10 } from '../../src/core/sect-expansion/production-runtime-v10';
import { createSectResearchFrame } from '../../src/core/sect-expansion/research';
import { validateSectResearchConsumerGatesV10 } from '../../src/core/sect-expansion/research-consumer-gates-v10';
import { applyValidatedSectUpgradeCommandV10, tickValidatedSectUpgradeV10 } from '../../src/core/sect-expansion/upgrade-runtime';
import { MANAGEMENT_V10_PROTOCOL, type SectProductionJobV10, type SectUpgradeFrameV10,
  type WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createSectUpgradeStateV10, validateSectUpgradeRecordsV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { createWorld } from '../../src/core/world/create-world';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { composeV10SectFrame } from '../../src/core/world/v10-sect-frame';
import type { WorldStateV9 } from '../../src/core/world/v9-types';

const MAX = Number.MAX_SAFE_INTEGER;
const METRICS = ['bytes', 'decodedCharacters', 'decodedNodes'] as const;
const ZERO = { bytes: 0, decodedCharacters: 0, decodedNodes: 0 };
const measure = recordMeasures.measureProgressionRecord;
const corrupt = <T>(source: T, patch: Record<string, unknown>): T => ({ ...source, ...patch });

/** A sizing-only World carrier. This does not implement migration, validate the
 * complete v10 World, or claim that the domain fixture earned its BASE funds. */
function carrier(): WorldStateV10 {
  const old = createUnregisteredWorldV9('v10-shared-sizing');
  return { ...old, simulationVersion: MANAGEMENT_V10_PROTOCOL.simulationVersion,
    runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol, contentVersion: MANAGEMENT_V10_PROTOCOL.contentVersion,
    contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY), sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: [] },
      production: { ...old.sectExpansion.production, jobs: [] }, upgrade: createSectUpgradeStateV10() } };
}
function worldFor(frame: SectUpgradeFrameV10): WorldStateV10 {
  const world = carrier();
  return composeV10SectFrame({ ...world, clock: { ...world.clock,
    simulationTick: frame.construction.lastSimulationTick, calendarTick: frame.construction.lastCalendarTick } }, frame);
}
function context(frame: { construction: { lastSimulationTick: number; lastCalendarTick: number } }): ConstructionContext {
  return { simulationTick: frame.construction.lastSimulationTick, calendarTick: frame.construction.lastCalendarTick,
    mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [] };
}
function acceptOld(result: SectMaintenanceResult): SectMaintenanceFrame {
  if (!result.ok) throw new Error(result.code); return result.frame;
}
function oldUntil(frame: SectMaintenanceFrame, done: (value: SectMaintenanceFrame) => boolean): SectMaintenanceFrame {
  for (let tick = 0; tick < 1600 && !done(frame); tick++) {
    const ctx = { ...context(frame), simulationTick: frame.construction.lastSimulationTick + 1,
      calendarTick: frame.construction.lastCalendarTick + 1 };
    frame = acceptOld(tickSectMaintenance(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
  }
  expect(done(frame)).toBe(true); return frame;
}
function oldBuild(frame: SectMaintenanceFrame, definitionId: 'library.v9' | 'alchemy.v9', x: number): SectMaintenanceFrame {
  frame = acceptOld(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'blueprint.place',
    commandId: `sizing.place.${x}`, expectedRevision: frame.construction.revision,
    placement: { definitionId, anchor: { x, y: 1 }, rotation: 0 } }));
  frame = acceptOld(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'construction.start',
    commandId: `sizing.build.${x}`, expectedRevision: frame.construction.revision,
    blueprintId: frame.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' }));
  return oldUntil(frame, value => value.construction.jobs.at(-1)!.terminal !== null);
}
function oldProduce(frame: SectMaintenanceFrame, recipeId: SectRecipeId): SectMaintenanceFrame {
  frame = acceptOld(applySectMaintenanceProductionCommand(frame, context(frame), { kind: 'production.start',
    commandId: `sizing.produce.${frame.production.nextId}`, expectedRevision: frame.production.revision, recipeId, workerId: 'entity:2' }));
  return oldUntil(frame, value => value.production.jobs.at(-1)!.terminal !== null);
}
function oldResearch(frame: SectMaintenanceFrame, researchId: SectResearchId): SectMaintenanceFrame {
  frame = acceptOld(applySectMaintenanceResearchCommand(frame, context(frame), { kind: 'research.start',
    commandId: `sizing.research.${frame.research.nextId}`, expectedRevision: frame.research.revision, researchId, workerId: 'entity:2' }));
  return oldUntil(frame, value => value.research.jobs.at(-1)!.terminal !== null);
}
function fundedDomain(): SectMaintenanceFrame {
  const world = createWorld('v10-shared-sizing-domain');
  for (const balance of Object.values(world.inventory)) balance.owned = Math.min(balance.capacity, 80);
  return createSectMaintenanceFrame(createSectResearchFrame(createSectProductionFrame(createConstructionFrame({
    map: world.map, legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId,
      x: site.x, y: site.y, operational: site.operational })),
    people: world.disciples.map(actor => ({ id: actor.id, position: actor.position, lifeState: actor.lifeState, canWork: actor.canWork,
      away: false, productionTransactionId: null, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: 0, calendarTick: 0,
  }))));
}
function liftDomain(source: SectMaintenanceFrame): SectUpgradeFrameV10 {
  expect(validateSectMaintenanceFrame(source)).toEqual([]);
  return cloneJson({ schemaVersion: 2,
    construction: { ...source.construction, buildings: source.construction.buildings.map(building => ({ ...building, level: 1 as const })) },
    production: { ...source.production, jobs: source.production.jobs.map((job): SectProductionJobV10 => {
      if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old fixture cannot have L2 production');
      return { ...job, recipeId: job.recipeId };
    }) }, research: source.research, maintenance: source.maintenance,
    care: { revision: 0, nextId: 1, jobs: [], receipts: [] }, upgrade: createSectUpgradeStateV10() });
}
function checked(frame: SectUpgradeFrameV10): SectUpgradeFrameV10 {
  expect(validateSectUpgradeRecordsV10(frame)).toEqual([]);
  expect(validateSectMaintenanceRecordsV10(frame)).toEqual([]);
  expect(validateSectProductionRecordsV10(frame)).toEqual([]);
  expect(validateSectProductionReceiptsV10(frame)).toEqual([]);
  expect(validateSectResearchConsumerGatesV10(frame)).toEqual([]);
  return frame;
}
function step(frame: SectUpgradeFrameV10): SectUpgradeFrameV10 {
  frame = { ...frame, construction: { ...frame.construction,
    lastSimulationTick: frame.construction.lastSimulationTick + 1, lastCalendarTick: frame.construction.lastCalendarTick + 1 } };
  const ctx = context(frame); const budget = createWorkPathBudget(ctx.simulationTick);
  frame = tickValidatedSectMaintenancePaymentV10(frame, ctx);
  const upgraded = tickValidatedSectUpgradeV10(frame, ctx, budget);
  if (!upgraded.ok) throw new Error(upgraded.code);
  return tickValidatedSectProductionV10(upgraded.frame, ctx, budget);
}
function until(frame: SectUpgradeFrameV10, done: (value: SectUpgradeFrameV10) => boolean): SectUpgradeFrameV10 {
  for (let tick = 0; tick < 1600 && !done(frame); tick++) frame = step(frame);
  expect(done(frame)).toBe(true); return checked(frame);
}
function start(frame: SectUpgradeFrameV10, recipeId: 'craft.wound-powder.v9' | 'craft.wound-powder-alt.v9'): SectUpgradeFrameV10 {
  const result = applyValidatedSectProductionCommandV10(frame, context(frame), { kind: 'production.start',
    commandId: `sizing.l2.${recipeId}`, expectedRevision: frame.production.revision, recipeId, workerId: 'entity:2' });
  if (!result.ok) throw new Error(result.code); return checked(result.frame);
}
function cancel(frame: SectUpgradeFrameV10): SectUpgradeFrameV10 {
  const job = frame.production.jobs.at(-1)!;
  const result = applyValidatedSectProductionCommandV10(frame, context(frame), { kind: 'production.cancel', commandId: 'sizing.l2.cancel',
    expectedRevision: frame.production.revision, jobId: job.transactionId });
  if (!result.ok) throw new Error(result.code); return checked(result.frame);
}
function productionRecords(world: WorldStateV10, id: string) {
  const job = world.sectExpansion.production.jobs.find(value => value.transactionId === id)!;
  const actor = world.disciples.find(value => value.id === job.workerId)!;
  return { job, claim: world.sectExpansion.reservations.find(value => value.reservationId === job.reservationId)!,
    worker: { position: actor.position, traveling: actor.traveling } };
}

describe('fixed historical v9 wrapper after structural extraction', () => {
  it('retains the exact result shape and old identity accepted set', () => {
    const source = createUnregisteredWorldV9('v9-obligation-compatibility');
    const result = deriveSectReservationsV9(source);
    expect(result).toEqual(deriveSectRecordObligations(source));
    expect(Object.keys(result).sort()).toEqual(['scope', 'supported', 'owners', 'totals', 'shared', 'unknowns', 'excluded'].sort());
    expect(result.owners).toEqual([]); expect(result.totals.bytes).toBe(result.shared.bytes);
    // Historical sizing checked only simulationVersion/runtimeProtocol/catalog.
    // Keep this deliberately non-World-valid sizing input accepted by that wrapper.
    const historicalSurface = corrupt(source, { contentVersion: 'sizing-only', contentIdentity: {},
      sectExpansion: { ...source.sectExpansion, schemaVersion: 2, upgrade: createSectUpgradeStateV10() } });
    expect(deriveSectReservationsV9(historicalSurface)).toEqual(result);
    for (const protocol of ['fresh-management-v9-unregistered.1', 'fresh-management-v9-unregistered.2', 'fresh-management-v9-unregistered.4']) {
      expect(deriveSectReservationsV9(corrupt(source, { runtimeProtocol: protocol })).unknowns).toEqual(['Unsupported internal v9 record identity']);
    }
  });
  it('keeps descriptor, exact identity, map and owner errors in their old order', () => {
    const source = createUnregisteredWorldV9('v9-obligation-errors');
    const badMap = { ...source, map: { ...source.map, width: 0 } };
    expect(deriveSectReservationsV9(badMap).unknowns).toEqual(['Invalid bounded navigation map']);
    expect(deriveSectReservationsV9(corrupt(badMap, { simulationVersion: '0.10.0' })).unknowns).toEqual(['Unsupported internal v9 record identity']);
    let reads = 0;
    const getter = corrupt(badMap, { simulationVersion: '0.10.0' });
    Object.defineProperty(getter, 'seed', { enumerable: true, get() { reads++; return 'must not read'; } });
    expect(deriveSectReservationsV9(getter).unknowns).toEqual(['JSON accessors cannot be measured or cached']);
    expect(reads).toBe(0);
    const missing: WorldStateV9 = { ...source, sectExpansion: { ...source.sectExpansion,
      construction: { ...source.sectExpansion.construction, blueprints: [{ blueprintId: 'bp', definitionId: 'library.v9',
        anchor: { x: 0, y: 0 }, rotation: 0, placedTick: 0, placedCalendarTick: 0, status: 'started', jobId: 'missing', endedTick: null }] } } };
    expect(deriveSectReservationsV9(missing).unknowns).toEqual(['Started blueprint lacks live construction owner']);
    expect(deriveSectReservationsV9(corrupt(missing, { map: badMap.map })).unknowns).toEqual(['Invalid bounded navigation map']);
    expect(deriveSectReservationsV9(corrupt(missing, { sectExpansion: { ...missing.sectExpansion,
      construction: { ...missing.sectExpansion.construction, catalogIdentity: {} } } })).unknowns).toEqual(['Unsupported internal v9 record identity']);
  });
  it('does not let the fixed v9 wrapper receive new identity through structural typing', () => {
    const source = carrier();
    // @ts-expect-error The fixed v9 wrapper must continue to reject a v10 World type.
    expect(deriveSectReservationsV9(source).unknowns).toEqual(['Unsupported internal v9 record identity']);
  });
});

let old: SectMaintenanceFrame; let begun: SectUpgradeFrameV10; let l2: SectUpgradeFrameV10;
describe('v10 fixed composition with genuine L2 domain records', () => {
  beforeAll(() => { old = oldBuild(fundedDomain(), 'library.v9', 1); });
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let batch = 0; batch < 3; batch++) beforeAll(() => { old = oldProduce(oldProduce(old, recipe), recipe); });
  }
  beforeAll(() => { old = oldResearch(old, 'basic-medicine.v9'); });
  beforeAll(() => { old = oldResearch(old, 'herbal-compatibility.v9'); });
  beforeAll(() => { old = oldBuild(old, 'alchemy.v9', 10); });
  beforeAll(() => {
    const frame = liftDomain(old);
    const result = applyValidatedSectUpgradeCommandV10(frame, context(frame), { kind: 'upgrade.start', commandId: 'sizing.upgrade',
      expectedRevision: frame.upgrade.revision, buildingId: frame.construction.buildings.at(-1)!.buildingId, workerId: 'entity:2' });
    if (!result.ok) throw new Error(result.code); begun = checked(result.frame);
    l2 = until(begun, value => value.upgrade.jobs[0]!.terminal !== null);
  });
  it.each(['craft.wound-powder.v9', 'craft.wound-powder-alt.v9'] as const)('preserves actual %s L2 proof in all three measured sizing branches', recipeId => {
    const frame = start(l2, recipeId); const source = worldFor(frame); const job = frame.production.jobs.at(-1)!;
    const before = canonicalStringify(source); const recipe = getSectRecipeDefinition(recipeId)!;
    const observed: SectProductionJobV10[] = [];
    vi.spyOn(recordMeasures, 'measureProgressionRecord').mockImplementation(value => {
      if (value && typeof value === 'object' && 'transactionId' in value && value.transactionId === job.transactionId) {
        observed.push(value as SectProductionJobV10);
      }
      return measure(value);
    });
    const assessment = deriveSectReservationsV10(source);
    expect(assessment.supported, assessment.unknowns.join(';')).toBe(true);
    expect(assessment.existing).toEqual(deriveSectRecordObligations(source));
    expect(assessment.upgrade).toEqual(deriveSectUpgradeObligationsV10(source));
    const witnesses = [observed.find(value => value.terminal === null && value.navigation.routeVersion === MAX),
      observed.find(value => value.terminal?.kind === 'completed'), observed.find(value => value.terminal?.kind === 'cancelled')];
    expect(witnesses.every(Boolean)).toBe(true);
    for (const value of witnesses) {
      expect(value!.productiveSite).toEqual(job.productiveSite);
      expect(value!.researchGate).toEqual(job.researchGate);
      expect(value!.productiveSite).toMatchObject({ level: 2, upgradeJobId: l2.upgrade.jobs[0]!.jobId });
      expect(value!.activeTicks).toBe(recipe.workTicks); expect(value!.requiredTicks).toBe(recipe.workTicks);
      expect(value!.workSpans).toHaveLength(recipe.workTicks);
    }
    expect(witnesses[1]!.terminal!.consumed).toEqual(recipe.inputs);
    expect(witnesses[1]!.terminal!.outputs).toEqual(recipe.outputs);
    expect(witnesses[2]!.terminal!.released).toEqual(recipe.inputs);
    expect(witnesses[2]!.terminal!.outputs).toEqual([]);
    expect(job.researchGate?.researchId).toBe(recipeId === 'craft.wound-powder-alt.v9' ? 'herbal-compatibility.v9' : 'basic-medicine.v9');
    expect(canonicalStringify(source)).toBe(before);
    const owner = assessment.owners.find(value => value.kind === 'production')!;
    for (const metric of METRICS) expect(owner[metric]).toBe(Math.max(...owner.branches.map(branch => branch[metric])));
    const path = owner.branches.find(branch => branch.kind === 'live-peak')!.records.find(record => record.label === 'production.job')!;
    expect('routeCells' in path && path.routeCells).toBe(source.map.width * source.map.height);
    expect(path.bytes).toBeGreaterThan(navigationPathByteBudget(source.map));
  });
  it.each(['craft.wound-powder.v9', 'craft.wound-powder-alt.v9'] as const)('bounds real %s completion/cancellation with unchanged retained evidence', recipeId => {
    const frame = start(l2, recipeId); const source = worldFor(frame); const assessment = deriveSectReservationsV10(source);
    const job = frame.production.jobs.at(-1)!; const before = measure(productionRecords(source, job.transactionId));
    const owner = assessment.owners.find(value => value.kind === 'production')!;
    const finished = until(frame, value => value.production.jobs.at(-1)!.terminal !== null);
    const cancelled = cancel(frame);
    for (const terminal of [finished, cancelled]) {
      // Compare the real owner's replaced records. An unrelated optional library
      // maintenance renewal, if due during this run, is outside its obligation.
      // The actual source passed to sizing above still contains the COMPLETE book.
      const actual = measure(productionRecords(worldFor(terminal), job.transactionId));
      for (const metric of METRICS) expect(owner[metric] + assessment.shared[metric]).toBeGreaterThanOrEqual(Math.max(0, actual[metric] - before[metric]));
      expect(terminal.production.jobs.at(-1)!.productiveSite).toEqual(job.productiveSite);
      expect(terminal.production.jobs.at(-1)!.researchGate).toEqual(job.researchGate);
      expect(deriveSectReservationsV10(worldFor(terminal)).owners).toEqual([]);
      expect(terminal.construction.ledger.reservations.map(claim => claim.reservationId))
        .toEqual(expect.arrayContaining(frame.construction.ledger.reservations.map(claim => claim.reservationId)));
      expect(terminal.construction.ledger.reservations.filter(claim => claim.reservationId === job.reservationId)).toHaveLength(1);
    }
    expect(finished.production.jobs.at(-1)!.activeTicks).toBe(recipeId === 'craft.wound-powder-alt.v9' ? 200 : 160);
  });
  it('combines all six structural owner kinds, rows/counters and shared widths exactly once', () => {
    const source = sixOwnerFixture(); const before = canonicalStringify(source);
    const result = deriveSectReservationsV10(source);
    expect(result.supported, result.unknowns.join(';')).toBe(true);
    expect(result.owners.map(owner => owner.kind)).toEqual(['planned-blueprint', 'construction', 'production', 'research', 'care', 'upgrade']);
    expect(result.upgrade!.shared.bytes).toBeGreaterThan(0);
    for (const metric of METRICS) {
      expect(result.totals[metric]).toBe(result.existing!.totals[metric] + result.upgrade!.totals[metric]);
      expect(result.shared[metric]).toBe(result.existing!.shared[metric] + result.upgrade!.shared[metric]);
      expect(result.totals[metric]).toBe(result.shared[metric] + result.owners.reduce((sum, owner) => sum + owner[metric], 0));
    }
    expect(result.totals.rows).toEqual({ constructionJobs: 1, constructionBuildings: 2, constructionReceipts: 3,
      productionReceipts: 1, researchReceipts: 1, careReceipts: 1, pairedClaims: 1, upgradeJobs: 0, upgradeReceipts: 1 });
    expect(result.totals.counters).toEqual({ constructionRevision: 3, productionRevision: 1, researchRevision: 1,
      careRevision: 1, cultivationRevision: 1, constructionNextId: 3, navVersion: 3, upgradeRevisions: 1, upgradeNextId: 0 });
    expect(canonicalStringify(source)).toBe(before);
    expect(result).toMatchObject({ admitted: false, importAuthorized: false, eventualCompletionSupported: false });
  });
  it('keeps the full paired book and passes local upgrade unsupported results through closed', () => {
    const source = worldFor(begun); const result = deriveSectReservationsV10(source);
    const original = canonicalStringify(source);
    const invalid = { ...source, sectExpansion: { ...source.sectExpansion,
      upgrade: { ...source.sectExpansion.upgrade, jobs: [{ ...source.sectExpansion.upgrade.jobs[0]!, activeTicks: 400 }] } } };
    const rejected = deriveSectReservationsV10(invalid);
    expect(rejected).toMatchObject({ supported: false, owners: [], totals: ZERO, shared: ZERO, upgrade: { supported: false } });
    expect(rejected.unknowns).toEqual(rejected.upgrade!.unknowns);
    // Extra inert claims are intentionally invalid owner-closure/row-pressure data.
    // They must remain visible to the local 384-row ceiling rather than be filtered.
    const claims = [...source.sectExpansion.reservations];
    while (claims.length < 385) claims.push(cloneJson(claims[0]!));
    const fullBook = { ...source, sectExpansion: { ...source.sectExpansion, reservations: claims } };
    expect(deriveSectReservationsV10(fullBook)).toMatchObject({ supported: true, admitted: false,
      upgrade: { headroom: { fits: false, diagnostics: ['Shared paired reservation limit exceeded'] } } });
    const missing = { ...source, sectExpansion: { ...source.sectExpansion,
      reservations: source.sectExpansion.reservations.filter(claim => claim.reservationId !== source.sectExpansion.upgrade.jobs[0]!.reservationId) } };
    expect(deriveSectReservationsV10(missing)).toMatchObject({ supported: false, owners: [], upgrade: { supported: false } });
    expect(result.upgrade!.owners).toHaveLength(1); expect(canonicalStringify(source)).toBe(original);
  });
  it('remeasures real stock/inventory, worker fields, clocks and revisions without caching or dropping terminal history', () => {
    const source = worldFor(begun); const initial = deriveSectReservationsV10(source); const snapshot = canonicalStringify(source);
    const wider = cloneJson(source);
    wider.clock.simulationTick = MAX; wider.clock.calendarTick = MAX; wider.cultivation.revision = MAX;
    for (const balance of Object.values(wider.inventory)) Object.assign(balance, { owned: MAX, reserved: MAX, capacity: MAX });
    for (const balance of Object.values(wider.sectExpansion.stock)) Object.assign(balance, { owned: 99, reserved: 99, capacity: 99 });
    wider.disciples.find(actor => actor.id === begun.upgrade.jobs[0]!.workerId)!.position = { x: wider.map.width - 1, y: wider.map.height - 1 };
    const changed = deriveSectReservationsV10(wider);
    expect(changed.supported).toBe(true); expect(changed.shared.bytes).toBeLessThan(initial.shared.bytes);
    expect(changed.owners[0]!.bytes).toBeLessThanOrEqual(initial.owners[0]!.bytes);
    expect(canonicalStringify(source)).toBe(snapshot);
    const complete = worldFor(l2); const retained = canonicalStringify(complete.sectExpansion);
    expect(deriveSectReservationsV10(complete)).toMatchObject({ supported: true, owners: [], upgrade: { totals: ZERO, shared: ZERO } });
    expect(canonicalStringify(complete.sectExpansion)).toBe(retained);
  });
});

/** Deliberately simultaneous, unreachable sizing records. This fixture proves
 * arithmetic and data retention only; it must never be submitted as gameplay or
 * claimed to pass complete World validation, capacity admission or migration. */
function sixOwnerFixture(): WorldStateV10 {
  const source = worldFor(start(l2, 'craft.wound-powder-alt.v9'));
  const records = source.sectExpansion; const bp = records.construction.blueprints;
  const care: SectCareJob = { jobId: 'sect-care:1', reservationId: 'sect-care-reservation:2', patientId: 'entity:4',
    doseProductionJobId: records.production.jobs.at(-1)!.transactionId, previousCancelledCareId: null,
    startedTick: source.clock.simulationTick, startedCalendarTick: source.clock.calendarTick, origin: { x: 0, y: 0 },
    storageId: source.buildings.find(site => site.blueprintId === 'storage')!.id, storagePosition: { x: 0, y: 0 },
    phase: 'to-storage', activeTicks: 0, visits: [], workSpans: [], navigation: emptyNavigation(), blocked: null, terminal: null };
  const upgrade = begun.upgrade.jobs[0]!;
  const reservations = records.reservations.map(claim => claim.reservationId === upgrade.reservationId
    ? begun.construction.ledger.reservations.find(value => value.reservationId === upgrade.reservationId)! : claim);
  return cloneJson({ ...source, sectExpansion: { ...records,
    construction: { ...records.construction, blueprints: [
      { ...bp[0]!, status: 'planned', jobId: null, endedTick: null }, { ...bp[1]!, status: 'started', endedTick: null },
    ], jobs: records.construction.jobs.map((job, index) => index === 1 ? { ...job, terminal: null, phase: 'working' } : job) },
    research: { ...records.research, jobs: records.research.jobs.map((job, index) => index === 0 ? { ...job, terminal: null, phase: 'working' } : job) },
    care: { ...records.care, jobs: [care] }, upgrade: begun.upgrade,
    reservations: [...reservations, syntheticClaim(care.reservationId, care.jobId, [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }])],
  } });
}
function syntheticClaim(reservationId: string, ownerTransactionId: string, lines: readonly SectResourceLine[]): SectLedgerReservation {
  function side<R extends string>(ledger: 'base' | 'sect'): LedgerClaim<R> {
    const values = lines.filter(line => line.ledger === ledger).map(line => ({ resourceId: line.resourceId as R, quantity: line.quantity }));
    return { reservationId, ownerTransactionId, lines: values, consumed: [], remainingReservation: values, checkpoints: [], settlement: null };
  }
  return { reservationId, ownerTransactionId, policy: 'on-completion', base: side('base'), sect: side('sect') };
}

describe('new fixed v10 guard and fail-closed data boundary', () => {
  it('checks exact v10 identity and every pinned local identity without relabelling old records', () => {
    const source = carrier();
    expect(deriveSectReservationsV10(source).supported).toBe(true);
    for (const patch of [
      { simulationVersion: '0.9.0' }, { runtimeProtocol: 'fresh-management-v9-unregistered.3' }, { runtimeProtocol: 'management-v10-alchemy-upgrade.2' },
      { contentVersion: 'unknown' }, { contentIdentity: { ...MANAGEMENT_V10_IDENTITY, compositeFingerprint: 'unknown' } },
      { contentIdentity: { ...MANAGEMENT_V10_IDENTITY, extra: 0 } },
      { sectExpansion: { ...source.sectExpansion, schemaVersion: 1 } },
      { sectExpansion: { ...source.sectExpansion, construction: { ...source.sectExpansion.construction, schemaVersion: 2 } } },
      { sectExpansion: { ...source.sectExpansion, construction: { ...source.sectExpansion.construction, catalogIdentity: { ...SECT_V9_CANDIDATE_IDENTITY, fingerprint: 'bad' } } } },
      { sectExpansion: { ...source.sectExpansion, upgrade: { ...source.sectExpansion.upgrade, schemaVersion: 2 } } },
      { sectExpansion: { ...source.sectExpansion, upgrade: { ...source.sectExpansion.upgrade, protocol: 'alchemy-l1-l2.2' } } },
      { sectExpansion: { ...source.sectExpansion, upgrade: { ...source.sectExpansion.upgrade, catalogIdentity: {} } } },
    ]) expect(deriveSectReservationsV10(corrupt(source, patch))).toMatchObject({ supported: false, owners: [], totals: ZERO,
      unknowns: ['Unsupported internal v10 record identity'], existing: null, upgrade: null });
  });
  it('does not execute getters, inspect thrown messages or silently discard unsupported data', () => {
    let reads = 0; const getter = (): never => { reads++; throw new Error('must not read'); };
    const source = carrier(); const accessor = cloneJson(source);
    Object.defineProperty(accessor.sectExpansion.upgrade, 'revision', { enumerable: true, get: getter });
    const error = new Proxy({}, { get: getter, getPrototypeOf: getter });
    const reflection = new Proxy(source, { ownKeys() { throw error; } });
    const cyclic = cloneJson(source); Object.assign(cyclic, { self: cyclic });
    const sparse = cloneJson(source); delete (sparse.disciples as unknown[])[0];
    const unknown = corrupt(source, { notARecord: undefined });
    for (const value of [accessor, reflection, cyclic, sparse, unknown]) {
      expect(deriveSectReservationsV10(value)).toMatchObject({ supported: false, admitted: false, owners: [], totals: ZERO, shared: ZERO });
    }
    expect(reads).toBe(0);
  });
});
