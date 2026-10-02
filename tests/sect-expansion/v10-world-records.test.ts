import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V9_IDENTITY } from '../../src/content/sect-v9/world-content';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { appendHistoryBatch, createHistoryArchive, iterateArchivedCommandReceipts, iterateArchivedEvents, iterateArchivedProduction, lookupArchivedCommandReceipt } from '../../src/core/history';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { inspectUnregisteredWorldV9Records, inspectUnregisteredWorldV10Records, validateWorldState, validateWorldStateV8 } from '../../src/core/kernel/validation';
import { reserveSectResources } from '../../src/core/sect-expansion/ledger';
import { applyValidatedSectUpgradeCommandV10 } from '../../src/core/sect-expansion/upgrade-runtime';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { MANAGEMENT_V10_PROTOCOL, type SectProductionJobV10, type WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { composeV10SectFrame, projectV10SectFrame, v10SectContext } from '../../src/core/world/v10-sect-frame';
import { captureV10RecordData } from '../../src/core/world/v10-sect-records';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCareStart, fixtureCommand, fixturePlace, fixtureProduce, fixtureSectCommand,
  fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Genuine strict fresh/quiet v9 World, lifted ONLY as record-test input. This is
 * not a migration, runtime or save admission. No book/history/clock rows are removed. */
function records(source = createUnregisteredWorldV9('v10-record-root')): WorldStateV10 {
  expect(inspectUnregisteredWorldV9Records(source)).toEqual([]);
  expect(source.activeProductionTransactionIds).toEqual([]);
  expect([...source.sectExpansion.construction.jobs, ...source.sectExpansion.production.jobs,
    ...source.sectExpansion.research.jobs, ...source.sectExpansion.care.jobs].every(job => job.terminal !== null)).toBe(true);
  const owned = cloneJson(source);
  return { ...owned, simulationVersion: '0.10.0', runtimeProtocol: MANAGEMENT_V10_PROTOCOL.runtimeProtocol,
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...owned.sectExpansion, schemaVersion: 2,
      construction: { ...owned.sectExpansion.construction, buildings: owned.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Record fixture requires immutable L1 origins');
        return { ...building, level: 1 as const };
      }) },
      production: { ...owned.sectExpansion.production, jobs: owned.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old fixture cannot contain L2 production');
        return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function unchanged(world: unknown): string[] {
  const before = canonicalStringify(world); const result = inspectUnregisteredWorldV10Records(world);
  expect(canonicalStringify(world)).toBe(before); return result;
}
function startedUpgrade(world: WorldStateV10): WorldStateV10 {
  const frame = projectV10SectFrame(world);
  const result = applyValidatedSectUpgradeCommandV10(frame, v10SectContext(world), { kind: 'upgrade.start', commandId: 'root.upgrade.start',
    expectedRevision: frame.upgrade.revision, buildingId: frame.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId,
    workerId: 'entity:2' });
  if (!result.ok) throw new Error(result.code);
  return composeV10SectFrame(world, result.frame);
}

describe('fixed internal whole-v10 record boundary', () => {
  it('accepts the genuine fresh record lift without mutating/freezing input, and pins the old build identity', () => {
    const world = records(); const history = world.history;
    expect(unchanged(world)).toEqual([]); expect(world.history).toBe(history);
    expect(Object.isFrozen(world)).toBe(false); expect(Object.isFrozen(history)).toBe(false);
    expect(world.builds.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
    expect(world.contentIdentity).toEqual(MANAGEMENT_V10_IDENTITY);
    expect(unchanged(freeze(cloneJson(world)))).toEqual([]);
  });
  it('rejects a new World identity written into unchanged permanent build history', () => {
    const world = records(); world.builds.contentIdentity = cloneJson(MANAGEMENT_V10_IDENTITY);
    expect(unchanged(world).length).toBeGreaterThan(0);
  });
  for (const [key, value] of [
    ['simulationVersion', '0.9.0'], ['simulationVersion', '0.11.0'], ['runtimeProtocol', 'fresh-management-v9-unregistered.3'],
    ['runtimeProtocol', 'management-v10-alchemy-upgrade.2'], ['contentVersion', 'shanmen-management-0.9.0-care.3'],
    ['contentIdentity', MANAGEMENT_V9_IDENTITY],
  ] as const) it(`rejects mixed/unknown ${key} ${String(value)}`, () => {
    expect(unchanged({ ...records(), [key]: cloneJson(value) }).length).toBeGreaterThan(0);
  });
  it('requires exact root/sect/construction/upgrade fields and schema', () => {
    const world = records();
    const invalid = [
      { ...world, arbitrary: true },
      { ...world, sectExpansion: { ...world.sectExpansion, schemaVersion: 1 } },
      { ...world, sectExpansion: { ...world.sectExpansion, levels: {} } },
      { ...world, sectExpansion: { ...world.sectExpansion, construction: { ...world.sectExpansion.construction, map: cloneJson(world.map) } } },
      { ...world, sectExpansion: { ...world.sectExpansion, upgrade: { ...world.sectExpansion.upgrade, levels: [] } } },
      { ...world, sectExpansion: { ...world.sectExpansion, upgrade: { ...world.sectExpansion.upgrade, protocol: 'alchemy-l1-l2.2' } } },
    ];
    for (const value of invalid) expect(unchanged(value).length).toBeGreaterThan(0);
  });
  it('keeps management clocks synchronized and combat/expedition/campaign closed', () => {
    const world = records();
    for (const value of [
      { ...world, clock: { ...world.clock, mode: 'combat' } },
      { ...world, clock: { ...world.clock, simulationTick: 1, encounterTick: 1 } },
      { ...world, expedition: { ...world.expedition, routeId: 'route.qingfeng-trial' } },
      { ...world, campaign: { ...world.campaign, settledRunEvidence: [{}] } },
    ]) expect(unchanged(value).length).toBeGreaterThan(0);
    world.pendingCommands.push({ kind: 'production.start', commandId: 'queued', issuedTick: 0, sequence: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } });
    expect(unchanged(world)).toEqual(['The internal v10 queue is not registered']);
  });
  it('rejects campaign events and rejected departure receipts as well as accepted activity', () => {
    const event = records(); event.sequences.nextAction++; event.sequences.nextEvent++;
    event.events.push({ eventId: 'event:1', rootActionId: 'action:1', parentEventId: null, tick: 0, kind: 'campaign.committed', payload: {} });
    expect(unchanged(event)).toEqual(['Internal v10 campaign events are closed']);
    const receipt = records(); receipt.commandReceipts.closed = { commandId: 'closed', fingerprint: canonicalStringify({ kind: 'expedition.command', payload: {} }),
      result: { commandId: 'closed', status: 'rejected', transactionId: null, eventIds: [], rejection: { code: 'INVALID_COMMAND' } } };
    expect(unchanged(receipt)).toEqual(['Internal v10 campaign/departure receipts are closed']);
  });
  it('closes base reserved totals and zero-genesis sect stock without hiding foreign owners', () => {
    const base = records(); base.inventory.wood.reserved = 1;
    expect(unchanged(base)).toEqual(['V10 shared reservation total differs']);
    const stock = records();
    expect(unchanged({ ...stock, sectExpansion: { ...stock.sectExpansion, stock: { ...stock.sectExpansion.stock,
      'wound-powder': { ...stock.sectExpansion.stock['wound-powder'], owned: 1 } } } })).toEqual(['V10 zero-genesis stock provenance differs']);
    const orphan = records(); const frame = projectV10SectFrame(orphan);
    const reserved = reserveSectResources(frame.construction.ledger, { ownerTransactionId: 'sect-upgrade:1', reservationId: 'sect-upgrade-reservation:2' }, [], 'construction-checkpoints');
    if (!reserved.ok) throw new Error(reserved.rejection.code);
    const candidate = composeV10SectFrame(orphan, { ...frame, construction: { ...frame.construction, ledger: reserved.context } });
    expect(unchanged(candidate)).toEqual(['ORPHAN_RESERVATION:sect-upgrade-reservation:2']);
  });
  it('keeps old v9 negatives and version labels exact', () => {
    const old = createUnregisteredWorldV9('root-old-negative');
    expect(inspectUnregisteredWorldV9Records(old)).toEqual([]);
    expect(inspectUnregisteredWorldV9Records(Object.assign(cloneJson(old), { extra: 1 }))).toEqual(['Invalid internal v9 root fields']);
    const upgradedShape = { ...old, sectExpansion: { ...old.sectExpansion, upgrade: createSectUpgradeStateV10() } };
    expect(inspectUnregisteredWorldV9Records(upgradedShape)).toEqual(['Invalid v9 owned records']);
    const fresh = records(old);
    expect(validateWorldState(fresh)).toEqual(['Legacy World contains reserved v9 fields']);
    expect(validateWorldStateV8(fresh)).toEqual(['Legacy World contains reserved v9 fields']);
    // Exact version guards are checked from unknown; no relabelled v9 type assertion.
    expect(inspectUnregisteredWorldV10Records(old)).toEqual(['Unsupported world identity/version']);
  });
});

describe('bounded descriptor-only record capture', () => {
  it('never invokes getters/toJSON or reads a caller-thrown error', () => {
    let reads = 0; const getter = (): never => { reads++; throw new Error('Do not read'); };
    const root = Object.defineProperty(records(), 'seed', { enumerable: true, get: getter });
    const nested = records(); Object.defineProperty(nested.sectExpansion.upgrade, 'jobs', { enumerable: true, get: getter });
    const toJSON = Object.defineProperty(records(), 'toJSON', { enumerable: true, get: getter });
    const error = new Proxy({}, { get: getter, getPrototypeOf: getter });
    const proxy = new Proxy({}, { ownKeys() { throw error; } });
    for (const value of [root, nested, toJSON, proxy]) expect(inspectUnregisteredWorldV10Records(value)).toEqual(['Invalid internal v10 records']);
    expect(reads).toBe(0);
  });
  it('rejects malformed data, aliases, symbols, hidden/sparse arrays, cycles and excessive depth', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const alias = {}; const shared = { a: alias, b: alias };
    const symbol = { [Symbol('hidden')]: 0 };
    const hidden = Object.defineProperty([0], '0', { value: 0, enumerable: false });
    const deep = JSON.parse(`${'['.repeat(130)}0${']'.repeat(130)}`) as unknown;
    for (const value of [undefined, NaN, Infinity, new Date(), cyclic, shared, symbol, hidden, new Array(0xffffffff), deep]) {
      expect(inspectUnregisteredWorldV10Records(value)).toEqual(['Invalid internal v10 records']);
    }
    expect(inspectUnregisteredWorldV10Records(null)).toEqual(['Invalid internal v10 root fields']);
  });
  it('detaches captured values without freezing the caller and rechecks later mutations', () => {
    const source = records(); const detached = captureV10RecordData(source);
    expect(detached).toEqual(source); expect(detached).not.toBe(source);
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    source.inventory.wood.reserved = 1;
    expect(inspectUnregisteredWorldV10Records(source).length).toBeGreaterThan(0);
    expect(inspectUnregisteredWorldV10Records(detached)).toEqual([]);
    expect(Object.isFrozen(source.inventory.wood)).toBe(false);
  });
});

let medicine: WorldStateV9; let readySource: WorldStateV9; let ready: WorldStateV10;
beforeAll(() => { medicine = medicineRuntimeFixture(); });
beforeAll(() => {
  medicine = fixtureUntil(fixtureCareStart(medicine, 'root.care'), world => world.sectExpansion.care.jobs.at(-1)!.terminal !== null);
  readySource = medicine;
});
// Basic medicine consumed the original two of each resource. Earn all four new
// units for herbal compatibility through actual delivery/ledger/World clock work.
for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
  for (let n = 0; n < 4; n++) beforeAll(() => { readySource = fixtureProduce(readySource, recipe); });
}
beforeAll(() => {
  const source = fixtureApply(readySource, fixtureSectCommand(readySource, { domain: 'research', command: { kind: 'research.start', commandId: 'root.herbal',
    expectedRevision: readySource.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
  ready = records(fixtureUntil(source, world => world.sectExpansion.research.jobs.at(-1)!.terminal !== null));
});

describe('genuine full historical books and the sixth owner', () => {
  it('accepts real construction, maintenance, medicine and care effect/clock history intact', () => {
    const world = records(medicine);
    expect(world.sectExpansion.care.jobs[0]!.terminal?.effect).toMatchObject({ beforeInjury: 25, afterInjury: 5 });
    expect(world.cultivationClock.transitions.length).toBeGreaterThan(0);
    expect(unchanged(world)).toEqual([]);
    expect(world.sectExpansion.reservations).toEqual(medicine.sectExpansion.reservations);
    expect(world.builds).toEqual(medicine.builds);
  });
  it('retains genuine start/cancel upgrade records, all six owners and the exact paired reservation', () => {
    const started = startedUpgrade(ready);
    expect(unchanged(started)).toEqual([]);
    expect(started.sectExpansion.reservations).toHaveLength(ready.sectExpansion.reservations.length + 1);
    const frame = projectV10SectFrame(started);
    const result = applyValidatedSectUpgradeCommandV10(frame, v10SectContext(started), { kind: 'upgrade.cancel', commandId: 'root.upgrade.cancel',
      expectedRevision: frame.upgrade.revision, jobId: frame.upgrade.jobs[0]!.jobId });
    if (!result.ok) throw new Error(result.code);
    const cancelled = composeV10SectFrame(started, result.frame);
    expect(unchanged(cancelled)).toEqual([]);
    expect(cancelled.sectExpansion.upgrade.jobs[0]!.terminal?.released).toHaveLength(2);
    expect(cancelled.inventory).toEqual(ready.inventory);
  });
  it('rejects missing, duplicate or forged sixth owners rather than filtering their reservation', () => {
    const started = startedUpgrade(ready); const job = started.sectExpansion.upgrade.jobs[0]!;
    const missing = { ...started, sectExpansion: { ...started.sectExpansion, upgrade: createSectUpgradeStateV10() } };
    expect(unchanged(missing)).toEqual([`ORPHAN_RESERVATION:${job.reservationId}`]);
    const noClaim = { ...started, sectExpansion: { ...started.sectExpansion, reservations: started.sectExpansion.reservations.filter(claim => claim.reservationId !== job.reservationId) } };
    expect(unchanged(noClaim).length).toBeGreaterThan(0);
    const duplicate = { ...started, sectExpansion: { ...started.sectExpansion, upgrade: { ...started.sectExpansion.upgrade,
      jobs: [cloneJson(job), cloneJson(job)] } } };
    expect(unchanged(duplicate).length).toBeGreaterThan(0);
    const forged = { ...ready, sectExpansion: { ...ready.sectExpansion, upgrade: { ...ready.sectExpansion.upgrade,
      jobs: [{ ...cloneJson(job), terminal: { kind: 'completed', resultLevel: 2 } }] } } };
    expect(unchanged(forged).length).toBeGreaterThan(0);
  });
  it('rejects duplicate worker ownership against existing legacy production', () => {
    const started = startedUpgrade(ready);
    const actor = started.disciples.find(actor => actor.id === 'entity:2')!; actor.assignmentTransactionId = 'instance:999';
    expect(unchanged(started).length).toBeGreaterThan(0);
  });
  it('rejects all changed paired historical clocks and immutable construction levels', () => {
    const world = records(medicine);
    const bp = world.sectExpansion.construction.blueprints[0]!;
    expect(unchanged({ ...world, sectExpansion: { ...world.sectExpansion, construction: { ...world.sectExpansion.construction,
      blueprints: world.sectExpansion.construction.blueprints.map(value => value === bp ? { ...value, placedCalendarTick: value.placedTick + 1 } : value) } } }).length).toBeGreaterThan(0);
    const origin = world.sectExpansion.construction.buildings[0]!;
    expect(unchanged({ ...world, sectExpansion: { ...world.sectExpansion, construction: { ...world.sectExpansion.construction,
      buildings: world.sectExpansion.construction.buildings.map(value => value === origin ? { ...value, level: 2 } : value) } } }).length).toBeGreaterThan(0);
  });
  it('rejects missing cultivation clock rows even if the component work records look complete', () => {
    const world = records(medicine); world.cultivationClock = { ...world.cultivationClock, transitions: [] };
    expect(unchanged(world).length).toBeGreaterThan(0);
  });
});

describe('exact-source restored archive and lifecycle joins', () => {
  it('retains permanent-build loadout history with the old content context', () => {
    let source = createUnregisteredWorldV9('root.build'); const member = source.builds.disciples[0]!;
    const loadout = cloneJson(member.loadout); loadout.activeSkillIds = [loadout.activeSkillIds[1], loadout.activeSkillIds[0]];
    source = fixtureApply(source, fixtureCommand(source, { kind: 'build.command', payload: { command: { kind: 'loadout.set',
      commandId: 'root.loadout', expectedRevision: source.builds.revision, discipleId: member.discipleId, loadout } } }, 'root.loadout'));
    const world = records(source); expect(world.builds.history).toHaveLength(1); expect(unchanged(world)).toEqual([]);
  });
  it('accepts a real retired construction worker and rejects orphaning its archived identity', () => {
    let source = fundedRuntimeFixture(); const actor = source.disciples[1]!; const profile = source.cultivation.disciples[1]!;
    actor.birthCalendarTick = 600 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    source = fixtureStartConstruction(fixturePlace(recordChecked(source), 'library.v9', 1));
    source = fixtureUntil(source, value => value.sectExpansion.construction.jobs[0]!.terminal !== null);
    source = fixtureUntil(source, value => value.cultivation.pendingDeaths.length > 0);
    const death = source.cultivation.pendingDeaths[0]!;
    source = fixtureApply(source, fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize',
      commandId: 'root.finalize', expectedRevision: source.cultivation.revision, discipleId: death.discipleId, deathId: death.deathId,
      cause: 'lifespan', acknowledgeDeath: true } } }, 'root.finalize'));
    const world = records(source); expect(world.legacy.archivedIdentities).toHaveLength(1); expect(unchanged(world)).toEqual([]);
    world.legacy.archivedIdentities = [];
    expect(unchanged(world).length).toBeGreaterThan(0);
  });
  it('checks sect command IDs against actual archived World receipts, including raw archives', () => {
    let source = createUnregisteredWorldV9('root.archive');
    for (let n = 0; n < 65; n++) {
      const commandId = `root.archive.${n}`;
      source = fixtureApply(source, fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId,
        expectedRevision: source.cultivation.revision, discipleId: 'entity:2', mode: 'duty' } } }, commandId));
    }
    source = fixturePlace(source, 'library.v9', 1);
    source = fixtureApply(source, fixtureSectCommand(source, { domain: 'construction', command: { kind: 'construction.cancel', commandId: 'root.archive.cancel-plan',
      expectedRevision: source.sectExpansion.construction.revision, blueprintId: source.sectExpansion.construction.blueprints[0]!.blueprintId } }));
    const world = records(source); expect(lookupArchivedCommandReceipt(world.history, 'root.archive.0')).toBeDefined();
    expect(unchanged(world)).toEqual([]); expect(unchanged(cloneJson(world))).toEqual([]);
    const collision = { ...world, sectExpansion: { ...world.sectExpansion, construction: { ...world.sectExpansion.construction,
      receipts: world.sectExpansion.construction.receipts.map((receipt, index) => index === 0 ? { ...receipt, command: { ...receipt.command, commandId: 'root.archive.0' } } : receipt) } } };
    expect(unchanged(collision)).toEqual(['V10 command identity has multiple owners']);
  });
  it('genuine old system/v9 death cancellations keep their original source namespace', () => {
    let source = fundedRuntimeFixture(); const actor = source.disciples[1]!; const profile = source.cultivation.disciples[1]!;
    actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    source = fixtureStartConstruction(fixturePlace(recordChecked(source), 'library.v9', 1));
    source = recordChecked(prepareNormalTickCandidateV9(source));
    const death = source.cultivation.pendingDeaths[0]!;
    source = fixtureApply(source, fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize',
      commandId: 'root.cancel-finalize', expectedRevision: source.cultivation.revision, discipleId: death.discipleId, deathId: death.deathId,
      cause: 'lifespan', acknowledgeDeath: true } } }, 'root.cancel-finalize'));
    const world = records(source);
    expect(world.sectExpansion.construction.receipts.at(-1)!.command.commandId).toMatch(/^system\/v9\/death\//);
    expect(unchanged(world)).toEqual([]);
    for (const commandId of ['system/v10/death/forged/job', 'system/unknown/death/job']) {
      const old = { ...source, sectExpansion: { ...source.sectExpansion, construction: { ...source.sectExpansion.construction,
        receipts: source.sectExpansion.construction.receipts.map((receipt, index, receipts) => index === receipts.length - 1
          ? { ...receipt, command: { ...receipt.command, commandId } } : receipt) } } };
      // Old accepted records remain exact. A future migration must report that this
      // unsupported journal cannot enter v10, rather than silently relabelling it.
      expect(inspectUnregisteredWorldV9Records(old)).toEqual([]);
      expect(unchanged(records(old))).toEqual(['Unsupported v10 legacy-domain system namespace']);
    }
    const forgedV9 = { ...world, sectExpansion: { ...world.sectExpansion, construction: { ...world.sectExpansion.construction,
      receipts: world.sectExpansion.construction.receipts.map((receipt, index, receipts) => index === receipts.length - 1
        ? { ...receipt, command: { ...receipt.command, commandId: 'system/v9/death/forged/job' } } : receipt) } } };
    expect(unchanged(forgedV9)).toEqual(['Lifecycle cancellation source differs']);

  });
});


/** Real first-month expiry, unrelated to the production worker. This explicit
 * initial birthday setup retains every actual lifecycle/clock record thereafter. */
function legacyPauseOrigin(): WorldStateV9 {
  const world = createUnregisteredWorldV9('root.legacy-pause');
  const actor = world.disciples.find(actor => actor.id === 'entity:4')!;
  const profile = world.cultivation.disciples.find(profile => profile.discipleId === actor.id)!;
  actor.birthCalendarTick = 1000 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
  return recordChecked(world);
}
function settleOtherActor(world: WorldStateV9): WorldStateV9 {
  const death = world.cultivation.pendingDeaths.find(death => death.discipleId === 'entity:4')!;
  expect(world.clock.simulationTick).toBe(1000); expect(death).toBeDefined();
  return fixtureApply(world, fixtureCommand(world, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize',
    commandId: 'root.legacy-pause.finalize', expectedRevision: world.cultivation.revision, discipleId: death.discipleId, deathId: death.deathId,
    cause: 'lifespan', acknowledgeDeath: true } } }, 'root.legacy-pause.finalize'));
}
function automaticPlan(world: WorldStateV9): WorldStateV9 {
  let next = fixtureApply(world, fixtureCommand(world, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set', plan: {
    workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: world.inventory.wood.owned + 1 }] } } } }, 'root.auto.plan'));
  next = fixtureApply(next, fixtureCommand(next, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } }, 'root.auto.enable'));
  next = fixtureUntil(next, value => value.activeProductionTransactionIds.some(id => id.startsWith('auto-job/')));
  return fixtureApply(next, fixtureCommand(next, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } }, 'root.auto.disable'));
}

describe('v10 legacy settlement versus global pre-work decisions', () => {
  it.each(['live mirror', 'archived mirror'] as const)('rejects a real committed manual pair retimed to another actor expiry, with %s', representation => {
    let source = legacyPauseOrigin();
    source = fixtureApply(source, fixtureCommand(source, { kind: 'production.start',
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'root.manual.complete'));
    source = fixtureUntil(source, world => world.activeProductionTransactionIds.length === 0);
    const completed = [...iterateArchivedProduction(source.history)].find(pair => pair.transaction.state === 'Committed')!.transaction;
    expect(completed.completedTick).toBeLessThan(1000);
    source = fixtureUntil(source, world => world.clock.simulationTick === 999);
    source = fixtureApply(source, fixtureCommand(source, { kind: 'production.start', payload: { recipeId: 'gather.wood', workerId: 'entity:2' } }, 'root.manual.cancel-start'));
    source = recordChecked(prepareNormalTickCandidateV9(source));
    const id = source.activeProductionTransactionIds[0]!;
    source = fixtureApply(source, fixtureCommand(source, { kind: 'production.cancel', payload: { transactionId: id } }, 'root.manual.cancel-at-pause'));
    source = settleOtherActor(source);
    expect([...iterateArchivedProduction(source.history)].some(pair => pair.transaction.state === 'Cancelled' && pair.transaction.completedTick === 1000)).toBe(true);
    expect(unchanged(records(source))).toEqual([]); // A real cancellation at that tick stays legal.
    const production = [...iterateArchivedProduction(source.history)].map(pair => pair.transaction.transactionId === completed.transactionId
      ? { ...pair, transaction: { ...pair.transaction, completedTick: 1000 } } : pair);
    const retime = (event: WorldStateV9['events'][number]): WorldStateV9['events'][number] => event.eventId === completed.resultEventId ? { ...event, tick: 1000 } : event;
    const archivedEvents = [...iterateArchivedEvents(source.history)];
    const corrupted: WorldStateV9 = { ...source,
      history: appendHistoryBatch(createHistoryArchive(), { production, commandReceipts: [...iterateArchivedCommandReceipts(source.history)],
        events: (representation === 'archived mirror' ? [...archivedEvents, ...source.events] : archivedEvents).map(retime) }),
      events: representation === 'archived mirror' ? [] : source.events.map(retime) };
    // Preserve old acceptance and all source/price/receipt/worker fields. Only the
    // completed pair and its exact settlement mirror were moved to the real pause.
    expect(inspectUnregisteredWorldV9Records(corrupted)).toEqual([]);
    expect(unchanged(records(corrupted))).toEqual(['V10 legacy production occurs on a pre-work decision-pause tick']);
  });
  it('rejects a genuine automatic committed notice moved to a real other-actor pause', () => {
    let source = automaticPlan(legacyPauseOrigin());
    source = fixtureUntil(source, world => world.activeProductionTransactionIds.length === 0);
    const committed = source.automaticProduction.journal.find(notice => notice.kind === 'committed')!;
    expect(committed).toBeDefined(); expect(committed.tick).toBeLessThan(1000);
    source = settleOtherActor(fixtureUntil(source, world => world.cultivation.pendingDeaths.length > 0));
    expect(unchanged(records(source))).toEqual([]);
    const corrupted = { ...source, automaticProduction: { ...source.automaticProduction,
      journal: source.automaticProduction.journal.map(notice => notice.eventId === committed.eventId ? { ...notice, tick: 1000 } : notice) } };
    expect(inspectUnregisteredWorldV9Records(corrupted)).toEqual([]);
    expect(unchanged(records(corrupted))).toEqual(['V10 legacy production occurs on a pre-work decision-pause tick']);
  });
  it('preserves automatic command cancellation/pin settlement and its retry receipt at a pause boundary', () => {
    let source = fixtureUntil(legacyPauseOrigin(), world => world.clock.simulationTick === 998);
    source = automaticPlan(source); expect(source.clock.simulationTick).toBe(999);
    const id = source.activeProductionTransactionIds[0]!;
    source = recordChecked(prepareNormalTickCandidateV9(source));
    const command = fixtureCommand(source, { kind: 'production.cancel', payload: { transactionId: id } }, 'root.auto.cancel-at-pause');
    source = fixtureApply(source, command); source = fixtureApply(source, command);
    expect(source.automaticProduction.pins[id as `auto-job/${number}`]).toMatchObject({ state: 'Cancelled', completedTick: 1000, retention: 'exact-receipt' });
    source = settleOtherActor(source);
    expect(unchanged(records(source))).toEqual([]);
    const started = source.automaticProduction.journal.find(notice => notice.kind === 'started')!;
    const forgedStart = { ...source, automaticProduction: { ...source.automaticProduction,
      journal: source.automaticProduction.journal.map(notice => notice.eventId === started.eventId ? { ...notice, tick: 1000 } : notice) } };
    expect(inspectUnregisteredWorldV9Records(forgedStart)).toEqual([]);
    expect(unchanged(records(forgedStart))).toEqual(['V10 legacy production occurs on a pre-work decision-pause tick']);
  });
});
