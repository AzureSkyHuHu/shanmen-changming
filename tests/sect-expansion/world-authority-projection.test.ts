import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import type { SectRecipeId } from '../../src/content/sect-v9/types';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { startProduction, tickProduction } from '../../src/core/economy/production';
import { startAutomaticProduction } from '../../src/core/economy/automatic-production';
import { dispatchCommandV8 } from '../../src/core/kernel/commands-v8';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason, tickClock } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { createSaveEnvelopeV8, parseSaveV8, serializeSaveV8 } from '../../src/core/kernel/save-v8';
import { createConstructionFrame } from '../../src/core/sect-expansion/construction';
import { validateConstructionFrame } from '../../src/core/sect-expansion/construction-validation';
import { validateWorldConstructionRecords } from '../../src/core/sect-expansion/construction-record-validation';
import { captureSectHistoricalIdentitiesV8, isArchivedSectWorkerReference, type SectHistoricalIdentitySource } from '../../src/core/sect-expansion/history-identity';
import { reserveSectResources } from '../../src/core/sect-expansion/ledger';
import { createSectMaintenanceFrame, applySectMaintenanceConstructionCommand, applySectMaintenanceProductionCommand,
  applySectMaintenanceResearchCommand, tickSectMaintenance } from '../../src/core/sect-expansion/maintenance';
import type { SectMaintenanceFrame, SectMaintenanceResult } from '../../src/core/sect-expansion/maintenance-types';
import { validateSectMaintenanceFrame, validateSectMaintenanceOwnerClosure, validateWorldSectMaintenanceRecords } from '../../src/core/sect-expansion/maintenance-validation';
import { createSectProductionFrame } from '../../src/core/sect-expansion/production';
import { validateSectProductionFrame } from '../../src/core/sect-expansion/production-validation';
import { validateWorldMaintainedSectProductionRecords } from '../../src/core/sect-expansion/production-runtime';
import { createSectResearchFrame } from '../../src/core/sect-expansion/research';
import { validateSectResearchFrame, validateWorldMaintainedSectResearchRecords } from '../../src/core/sect-expansion/research-validation';
import type { SectEconomyCommand } from '../../src/core/sect-economy/types';
import type { SectExpansionOwnedRecords } from '../../src/core/sect-expansion/world-records-types';
import { advanceWorldCultivationV8, dispatchWorldCultivationV8 } from '../../src/core/world/cultivation-bridge-v8';
import { dispatchWorldSectEconomyV8 } from '../../src/core/world/automatic-work-bridge-v8';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { prepareWorldEstateSettlement } from '../../src/core/world/legacy-bridge';
import { projectWorldSectAuthoritiesV8, projectWorldSectRecordsV8 } from '../../src/core/world/v9-sect-authority-projection';
import type { WorldStateV8 } from '../../src/core/world/v8-types';

const ctx = (f: SectMaintenanceFrame) => ({ simulationTick: f.construction.lastSimulationTick, calendarTick: f.construction.lastCalendarTick,
  mode: 'management' as const, paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [] });
function accept(result: SectMaintenanceResult): SectMaintenanceFrame {
  if (!result.ok) throw new Error(`${result.code}: ${JSON.stringify(validateSectMaintenanceFrame(result.frame))}`);
  return result.frame;
}
function startWorldProduction(world: WorldStateV8, commandId: string, recipeId: string, workerId: string) {
  const result = dispatchCommandV8(world, { kind: 'production.start', commandId, sequence: world.sequences.nextAction,
    issuedTick: world.clock.simulationTick, payload: { recipeId, workerId } });
  if (result.result.status !== 'accepted' || result.result.transactionId === null) throw new Error(JSON.stringify(result.result));
  expect(validateWorldStateV8(result.world)).toEqual([]);
  return { world: result.world, transactionId: result.result.transactionId };
}
function records(frame: SectMaintenanceFrame): SectExpansionOwnedRecords {
  const c = frame.construction;
  return { schemaVersion: 1, construction: { schemaVersion: c.schemaVersion, catalogIdentity: c.catalogIdentity, revision: c.revision,
    nextId: c.nextId, blueprints: c.blueprints, jobs: c.jobs, buildings: c.buildings, receipts: c.receipts },
    stock: c.ledger.stock, reservations: c.ledger.reservations, production: frame.production, research: frame.research, maintenance: frame.maintenance };
}
function empty(world: WorldStateV8): SectMaintenanceFrame {
  const view = projectWorldSectAuthoritiesV8(world);
  return createSectMaintenanceFrame(createSectResearchFrame(createSectProductionFrame(createConstructionFrame({
    map: view.map, people: view.people, legacyStations: view.legacyStations, ledger: { inventory: view.inventory, stock: createEmptySectStock(), reservations: [] },
    simulationTick: view.clock.simulationTick, calendarTick: view.clock.calendarTick,
  }))));
}
function until(frame: SectMaintenanceFrame, done: (f: SectMaintenanceFrame) => boolean): SectMaintenanceFrame {
  for (let n = 0; n < 900 && !done(frame); n++) {
    const context = { ...ctx(frame), simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 };
    frame = accept(tickSectMaintenance(frame, context, createWorkPathBudget(context.simulationTick)));
  }
  expect(done(frame)).toBe(true); return frame;
}
function produce(frame: SectMaintenanceFrame, recipeId: SectRecipeId): SectMaintenanceFrame {
  const next = accept(applySectMaintenanceProductionCommand(frame, ctx(frame), { kind: 'production.start', recipeId, workerId: 'entity:2',
    commandId: `history.prod:${frame.production.revision}`, expectedRevision: frame.production.revision }));
  return until(next, f => f.production.jobs.at(-1)!.terminal !== null);
}
function place(frame: SectMaintenanceFrame, x = 1, y = 1): SectMaintenanceFrame {
  return accept(applySectMaintenanceConstructionCommand(frame, ctx(frame), { kind: 'blueprint.place', commandId: `history.place:${frame.construction.revision}`,
    expectedRevision: frame.construction.revision, placement: { definitionId: 'library.v9', anchor: { x, y }, rotation: 0 } }));
}
function begin(frame: SectMaintenanceFrame): SectMaintenanceFrame {
  return accept(applySectMaintenanceConstructionCommand(frame, ctx(frame), { kind: 'construction.start', commandId: `history.build:${frame.construction.revision}`,
    expectedRevision: frame.construction.revision, blueprintId: frame.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' }));
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

let source: WorldStateV8; let history: SectMaintenanceFrame; let liveConstruction: SectMaintenanceFrame;
let liveProduction: SectMaintenanceFrame; let liveResearch: SectMaintenanceFrame; let retired: WorldStateV8;
/** Contract fixture, NOT an integrated v9 engine. Domain commands/work and the old World death /
 * estate reducers are real. This boundary harness explicitly synchronizes their terminal outputs
 * solely to test authority projection; it does not establish World execution or v9 persistence. */
beforeAll(() => {
  source = createWorldV8('world-sect-history-port');
  for (let i = 0; i < 3; i++) {
    const started = startWorldProduction(source, `history.plank:${i}`, 'craft.plank', 'entity:3');
    source = started.world;
    for (let n = 0; n < 500 && source.activeProductionTransactionIds.length; n++)
      source = tickProduction(advanceWorldCultivationV8({ ...source, clock: tickClock(source.clock) }));
    expect(source.activeProductionTransactionIds).toEqual([]);
  }
  expect(validateWorldStateV8(source)).toEqual([]);
  history = begin(place(empty(source))); liveConstruction = history;
  history = until(history, f => f.construction.jobs[0]!.terminal !== null);
});
beforeAll(() => { history = produce(produce(history, 'extract.spirit-stone.v9'), 'extract.spirit-stone.v9'); });
beforeAll(() => { history = produce(produce(history, 'study.basic-insight.v9'), 'study.basic-insight.v9'); });
beforeAll(() => {
  history = accept(applySectMaintenanceResearchCommand(history, ctx(history), { kind: 'research.start', researchId: 'basic-medicine.v9', workerId: 'entity:2',
    commandId: 'history.research:0', expectedRevision: history.research.revision })); liveResearch = history;
  history = until(history, f => f.research.jobs[0]!.terminal !== null);
  history = accept(applySectMaintenanceProductionCommand(history, ctx(history), { kind: 'production.start', recipeId: 'gather.stone.v9', workerId: 'entity:2',
    commandId: 'history.cancelled:0', expectedRevision: history.production.revision })); liveProduction = history;
  history = accept(applySectMaintenanceProductionCommand(history, ctx(history), { kind: 'production.cancel', jobId: history.production.jobs.at(-1)!.transactionId,
    commandId: 'history.cancelled:1', expectedRevision: history.production.revision }));
});
beforeAll(() => {
  while (source.clock.simulationTick < history.construction.lastSimulationTick)
    source = advanceWorldCultivationV8({ ...source, clock: tickClock(source.clock) });
  source = { ...source, map: history.construction.map, inventory: history.construction.ledger.inventory,
    disciples: source.disciples.map(actor => ({ ...actor, position: history.construction.people.find(person => person.id === actor.id)!.position })) };
  expect(validateWorldStateV8(source)).toEqual([]);
  // Explicit synthetic age boundary only. Expiry, acknowledgement and estate removal are real.
  source = cloneJson(source); const actor = source.disciples.find(value => value.id === 'entity:2')!;
  const profile = source.cultivation.disciples.find(value => value.discipleId === actor.id)!;
  actor.birthCalendarTick = source.clock.calendarTick + 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((source.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  const pending = advanceWorldCultivationV8({ ...source, clock: tickClock(source.clock) });
  expect(pending.cultivation.pendingDeaths).toHaveLength(1);
  const death = pending.cultivation.pendingDeaths[0]!;
  const final = dispatchWorldCultivationV8(pending, { kind: 'death.finalize', commandId: 'history.finalize', expectedRevision: pending.cultivation.revision,
    discipleId: actor.id, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true });
  if (!final.ok) throw new Error(final.code);
  const settled = prepareWorldEstateSettlement(final.world); if (!settled.ok) throw new Error(settled.details.join('; '));
  retired = settled.candidate; expect(validateWorldStateV8(retired)).toEqual([]);
});

describe('World-derived sect authority prerequisite', () => {
  it('borrows the actual map, clocks, balances and live positions without changing either input', () => {
    const world = freeze(createWorldV8('read-only-source')); const own = freeze(records(empty(world)));
    const before = canonicalStringify({ world, own }); const result = projectWorldSectRecordsV8(world, own);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.authority.clock).toBe(world.clock); expect(result.frame.construction.map).toBe(world.map);
    expect(result.frame.construction.ledger.inventory).toBe(world.inventory);
    expect(result.frame.construction.people[0]!.position).toBe(world.disciples[0]!.position);
    expect(canonicalStringify({ world, own })).toBe(before);
    expect(Object.keys(own.construction).sort()).toEqual(['blueprints', 'buildings', 'catalogIdentity', 'jobs', 'nextId', 'receipts', 'revision', 'schemaVersion']);
    expect(Object.keys(own)).not.toContain('people'); expect(Object.keys(own)).not.toContain('inventory');
  });
  it('derives pause and cultivation roles without inventing an unpaused clock or changing actual eligibility', () => {
    let world = createWorldV8('read-only-rest'); const original = world.disciples[1]!;
    const rest = dispatchWorldCultivationV8(world, { kind: 'training.set', commandId: 'read-only-rest', expectedRevision: world.cultivation.revision,
      discipleId: original.id, mode: 'rest' }); if (!rest.ok) throw new Error(rest.code); world = rest.world;
    world = { ...world, clock: setPauseReason(world.clock, 'player', true) };
    const view = projectWorldSectAuthoritiesV8(freeze(world));
    expect(view.context.paused).toBe(true); expect(view.context.simulationTick).toBe(world.clock.simulationTick);
    expect(view.people.find(person => person.id === original.id)!.canWork).toBe(false);
    expect(world.disciples[1]!.canWork).toBe(true); expect(world.cultivation.disciples[1]!.trainingMode).toBe('rest');
  });
  it('preserves the actual traveling-state rejection even without a current assignment', () => {
    const initial = createWorldV8('traveling-without-assignment');
    const world = freeze({ ...initial, disciples: initial.disciples.map(actor => actor.id === 'entity:2' ? { ...actor, traveling: true } : actor) });
    expect(validateWorldStateV8(world)).toEqual([]);
    expect(startProduction(world, 'travel.legacy', 'gather.wood', 'entity:2')).toMatchObject({ ok: false, rejection: { code: 'WORKER_UNAVAILABLE' } });
    const authority = projectWorldSectAuthoritiesV8(world); const frame = empty(world);
    expect(authority.people.find(person => person.id === 'entity:2')).toMatchObject({ canWork: false, away: false, productionTransactionId: null });
    expect(applySectMaintenanceProductionCommand(frame, authority.context, { kind: 'production.start', commandId: 'travel.sect',
      expectedRevision: frame.production.revision, recipeId: 'gather.stone.v9', workerId: 'entity:2' })).toMatchObject({ ok: false, code: 'WORKER_UNAVAILABLE' });
    expect(world.disciples[1]!.traveling).toBe(true);
  });
  it('projects actual manual and automatic workers and exclusive station entrances', () => {
    let world = createWorldV8('shared-source-owners');
    const manual = startWorldProduction(world, 'source.manual', 'craft.plank', 'entity:2'); world = manual.world;
    const commands: SectEconomyCommand[] = [{ kind: 'plan.set', plan: { workerId: 'entity:3', enabled: true, priorities: [{ recipeId: 'gather.herbs', targetStock: 999 }] } },
      { kind: 'enabled.set', enabled: true }];
    for (const command of commands) {
      const configured = dispatchWorldSectEconomyV8(world, command); if (!configured.ok) throw new Error(configured.code); world = configured.world;
    }
    const auto = startAutomaticProduction(world, { recipeId: 'gather.herbs', workerId: 'entity:3' }); if (!auto.ok) throw new Error(auto.reason);
    world = tickProduction({ ...auto.world, clock: tickClock(auto.world.clock) });
    const view = projectWorldSectAuthoritiesV8(world);
    expect(view.context.externalActiveJobs).toBe(2);
    expect(view.context.externalClaims.filter(claim => claim.kind === 'worker')).toEqual(expect.arrayContaining([
      { kind: 'worker', key: 'entity:2', ownerId: manual.transactionId }, { kind: 'worker', key: 'entity:3', ownerId: auto.transactionId },
    ]));
    const ownedSites = world.buildings.filter(site => site.stationTransactionId !== null);
    for (const site of ownedSites) expect(view.context.externalClaims).toEqual(expect.arrayContaining([
      { kind: 'seat', key: site.id, ownerId: site.stationTransactionId }, { kind: 'entrance', key: `${site.x},${site.y}`, ownerId: site.stationTransactionId },
    ]));
    expect(view.inventory.wood.reserved).toBe(3); expect(view.people.find(person => person.id === 'entity:3')!.productionTransactionId).toBe(auto.transactionId);
  });
  it('retains real completed construction, production and research plus cancelled production after actual estate removal', () => {
    expect(retired.disciples.some(actor => actor.id === 'entity:2')).toBe(false);
    expect(retired.cultivation.archivedDisciples.some(actor => actor.discipleId === 'entity:2')).toBe(true);
    expect(retired.legacy.archivedIdentities.some(actor => actor.discipleId === 'entity:2')).toBe(true);
    const result = projectWorldSectRecordsV8(freeze(retired), freeze(records(history)));
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.frame.construction.people).toHaveLength(3);
    expect(result.frame.construction.jobs[0]!.terminal?.kind).toBe('completed');
    expect(result.frame.research.jobs[0]!.terminal?.kind).toBe('completed');
    expect(result.frame.production.jobs.at(-1)!.terminal?.kind).toBe('cancelled');
    expect(validateSectMaintenanceOwnerClosure(result.frame)).toEqual([]);
    expect(validateSectMaintenanceFrame(result.frame)[0]).toEqual({ code: 'INVALID_JOB', path: 'construction.jobs' });
  });
  it('keeps all standalone roots strict with their established first rejection', () => {
    const noWorker = { ...history, construction: { ...history.construction, people: history.construction.people.filter(person => person.id !== 'entity:2') } };
    expect(validateConstructionFrame(noWorker.construction)[0]).toEqual({ code: 'INVALID_JOB', path: 'jobs' });
    expect(validateSectProductionFrame({ schemaVersion: 1, construction: noWorker.construction, production: noWorker.production })[0]).toEqual({ code: 'INVALID_JOB', path: 'construction.jobs' });
    expect(validateSectResearchFrame({ schemaVersion: 1, construction: noWorker.construction, production: noWorker.production, research: noWorker.research })[0]).toEqual({ code: 'INVALID_JOB', path: 'construction.jobs' });
    expect(validateSectMaintenanceFrame(noWorker)[0]).toEqual({ code: 'INVALID_JOB', path: 'construction.jobs' });
    expect(validateSectMaintenanceFrame({ ...noWorker, unknown: true })[0]).toEqual({ code: 'INVALID_SHAPE', path: 'frame' });
  });
  it.each(['construction', 'production', 'research'] as const)('never turns an archived identity into an active %s worker', kind => {
    const identities = captureSectHistoricalIdentitiesV8(retired);
    const original = kind === 'construction' ? liveConstruction : kind === 'production' ? liveProduction : liveResearch;
    const frame = { ...original, construction: { ...original.construction, people: original.construction.people.filter(person => person.id !== 'entity:2') } };
    const issues = kind === 'construction' ? validateWorldConstructionRecords(frame.construction, identities)
      : kind === 'production' ? validateWorldMaintainedSectProductionRecords(frame, identities) : validateWorldMaintainedSectResearchRecords(frame, identities);
    expect(issues[0]).toEqual({ code: 'INVALID_JOB', path: kind === 'construction' ? 'jobs' : `${kind}.jobs` });
  });
  it('cannot authorize history through arbitrary, JSON-copied or prototype-spoofed identity lists', () => {
    const token = captureSectHistoricalIdentitiesV8(retired); const end = history.construction.jobs[0]!.terminal!;
    expect(isArchivedSectWorkerReference(token, 'entity:2', end)).toBe(true);
    for (const fake of [{ ids: ['entity:2'] }, JSON.parse(JSON.stringify(token)), Object.create(Object.getPrototypeOf(token))])
      expect(isArchivedSectWorkerReference(fake as SectHistoricalIdentitySource, 'entity:2', end)).toBe(false);
    const constructor = Object.getPrototypeOf(token).constructor;
    expect(Reflect.set(constructor, 'permits', () => true)).toBe(false);
    expect(Reflect.set(constructor, 'fromWorldV8', () => token)).toBe(false);
    expect(Reflect.set(Object.getPrototypeOf(token), 'constructor', class Forged {})).toBe(false);
    // Deliberately bypass static types to exercise the hostile reflective runtime boundary.
    const reflected = Reflect.construct(constructor,
      [new Map([['entity:999', { tick: 999999, month: 999999 }]])]) as SectHistoricalIdentitySource;
    expect(isArchivedSectWorkerReference(reflected, 'entity:999', end)).toBe(false);
    const forged = { ...history.construction, jobs: history.construction.jobs.map(job => ({ ...job, workerId: 'entity:999' })) };
    expect(validateWorldConstructionRecords(forged, reflected)[0]).toEqual({ code: 'INVALID_JOB', path: 'jobs' });
    expect(isArchivedSectWorkerReference(token, 'entity:999', end)).toBe(false);
    expect(isArchivedSectWorkerReference(token, 'entity:2', null)).toBe(false);
    expect(isArchivedSectWorkerReference(token, 'entity:2', { ...end, tick: retired.clock.simulationTick + 1 })).toBe(false);
  });
  it('rejects a cancelled job moved beyond actual death by changing only its same-month calendar', () => {
    let later = cloneJson(retired);
    const monthEnd = (Math.floor(retired.clock.calendarTick / CALENDAR_TICKS_PER_MONTH) + 1) * CALENDAR_TICKS_PER_MONTH - 1;
    const target = Math.min(retired.clock.calendarTick + 50, monthEnd);
    expect(target).toBeGreaterThan(retired.clock.calendarTick);
    while (later.clock.calendarTick < target) later = advanceWorldCultivationV8({ ...later, clock: tickClock(later.clock) });
    expect(validateWorldStateV8(later)).toEqual([]);
    expect(projectWorldSectRecordsV8(later, records(history)).ok).toBe(true);
    const cancelled = history.production.jobs.at(-1)!; expect(cancelled.terminal?.kind).toBe('cancelled');
    const terminal = { ...cancelled.terminal!, calendarTick: later.clock.calendarTick };
    expect(Math.floor(terminal.calendarTick / CALENDAR_TICKS_PER_MONTH)).toBe(retired.cultivation.deaths[0]!.month);
    const own = records(history);
    const forged = { ...own, production: { ...own.production, jobs: own.production.jobs.map(job => job.transactionId === cancelled.transactionId ? { ...job, terminal } : job) } };
    expect(projectWorldSectRecordsV8(later, forged)).toEqual({ ok: false, issues: [{ code: 'INVALID_JOB', path: 'production.jobs' }] });
    const token = captureSectHistoricalIdentitiesV8(later);
    expect(isArchivedSectWorkerReference(token, 'entity:2', terminal)).toBe(false);
    expect(isArchivedSectWorkerReference(token, 'entity:2', { tick: retired.clock.simulationTick, calendarTick: retired.clock.calendarTick - 1 })).toBe(false);
  });
  it.each(['legacy', 'cultivation', 'estate'] as const)('requires the actual matching %s retirement evidence', kind => {
    const world = cloneJson(retired);
    if (kind === 'legacy') world.legacy.archivedIdentities = [];
    else if (kind === 'cultivation') world.cultivation.archivedDisciples = [];
    else world.legacy.estates = [];
    expect(projectWorldSectRecordsV8(world, records(history))).toEqual({ ok: false, issues: [{ code: 'INVALID_WORLD_AUTHORITY', path: 'world' }] });
  });
  it('separates the record leaf from exact four-owner closure without filtering a fifth reservation', () => {
    const world = createWorldV8('strict-owner-union'); const frame = empty(world);
    const claim = reserveSectResources(frame.construction.ledger, { reservationId: 'sect-care-reservation:2', ownerTransactionId: 'sect-care:1' }, [], 'on-completion');
    if (!claim.ok) throw new Error(claim.rejection.code);
    const candidate = { ...frame, construction: { ...frame.construction, ledger: claim.context } };
    expect(validateWorldSectMaintenanceRecords(candidate, captureSectHistoricalIdentitiesV8(world))).toEqual([]);
    expect(validateSectMaintenanceOwnerClosure(candidate)).toEqual([{ code: 'ORPHAN_RESERVATION', path: 'sect-care-reservation:2' }]);
    expect(validateSectMaintenanceFrame(candidate)).toEqual([{ code: 'ORPHAN_RESERVATION', path: 'sect-care-reservation:2' }]);
    expect(projectWorldSectRecordsV8(world, records(candidate))).toEqual({ ok: false, issues: [{ code: 'ORPHAN_RESERVATION', path: 'sect-care-reservation:2' }] });
  });
  it('rejects duplicated World authorities and injected zero-genesis stock', () => {
    const world = createWorldV8('reject-shadow-authority'); const own = records(empty(world));
    for (const value of [{ ...own, people: [] }, { ...own, inventory: world.inventory }, { ...own, construction: { ...own.construction, map: world.map } },
      { ...own, construction: { ...own.construction, lastSimulationTick: 0 } }])
      expect(projectWorldSectRecordsV8(world, value)).toEqual({ ok: false, issues: [{ code: 'INVALID_OWNED_RECORDS', path: 'sectExpansion' }] });
    const stock = { ...own.stock, 'wound-powder': { ...own.stock['wound-powder'], owned: 1 } };
    expect(projectWorldSectRecordsV8(world, { ...own, stock })).toEqual({ ok: false, issues: [{ code: 'SECT_STOCK_PROVENANCE', path: 'stock.wound-powder' }] });
    const mislabeled = { ...world, sectExpansion: own };
    expect(projectWorldSectRecordsV8(mislabeled, own)).toEqual({ ok: false, issues: [{ code: 'INVALID_WORLD_AUTHORITY', path: 'world' }] });
  });
  it('does not borrow legacy reserved balances for a second expansion owner', () => {
    const base = createWorldV8('separate-base-owners');
    const manual = startWorldProduction(base, 'base.reserved', 'craft.plank', 'entity:3');
    const world = manual.world; const frame = empty(world);
    const begun = accept(applySectMaintenanceProductionCommand(frame, { ...ctx(frame), ...projectWorldSectAuthoritiesV8(world).context }, {
      kind: 'production.start', commandId: 'sect.reserved', expectedRevision: 0, recipeId: 'gather.stone.v9', workerId: 'entity:2',
    }));
    expect(world.inventory.wood.reserved).toBe(3); expect(begun.construction.ledger.inventory.wood.reserved).toBe(4);
    expect(projectWorldSectRecordsV8(world, records(begun))).toEqual({ ok: false,
      issues: [{ code: 'SOURCE_VERSION_RESERVATION_BOUNDARY', path: 'reservations' }] });
    expect(world.inventory.wood.reserved).toBe(3);
  });
  it('rejects hostile record and World getters without invoking them', () => {
    const world = createWorldV8('getter-source'); const own = records(empty(world)); let calls = 0;
    const bad = { ...own }; Object.defineProperty(bad, 'construction', { enumerable: true, get() { calls++; throw new Error('read'); } });
    expect(projectWorldSectRecordsV8(world, bad)).toMatchObject({ ok: false });
    const badWorld = { ...world }; Object.defineProperty(badWorld, 'legacy', { enumerable: true, get() { calls++; throw new Error('read'); } });
    expect(projectWorldSectRecordsV8(badWorld, own)).toMatchObject({ ok: false }); expect(calls).toBe(0);
  });
  it('reconstructs transient history authority after real v8 serialization without saving a second people list', () => {
    const text = serializeSaveV8(createSaveEnvelopeV8(retired, { buildId: 'history-projection-test', savedAt: '2026-10-02T00:00:00Z' }));
    const restored = parseSaveV8(text); if (!restored.ok) throw new Error(restored.error.message);
    const result = projectWorldSectRecordsV8(restored.world, JSON.parse(JSON.stringify(records(history))));
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const prior = projectWorldSectRecordsV8(retired, records(history)); if (!prior.ok) throw new Error(JSON.stringify(prior.issues));
    expect(result.frame).toEqual(prior.frame); expect(text).not.toContain('historicalIdentities'); expect(text).not.toContain('sectExpansion');
    expect(restored.envelope.saveVersion).toBe(8); expect(restored.world.simulationVersion).toBe('0.8.0');
  });
});
