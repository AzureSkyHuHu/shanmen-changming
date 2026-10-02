import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { recordAutomaticNotice } from '../../src/core/economy/automatic-production';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10, prepareNoOptionalGrowthTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { deriveProgressionReservationsTimeV9 } from '../../src/core/save-budget/progression-time-v9';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { inspectReservedDischargesV10 } from '../../src/core/world/reserved-discharges-v10';
import { inspectReservedDischargesV10 as fixedSectRelease } from '../../src/core/world/sect-release-v10';
import { deriveV10BuildObligationFacts } from '../../src/core/world/v10-build-obligations';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, fundedRuntimeFixture, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Explicit record-only lift of genuine old work with labelled BASE test funding.
 * Not migration, codec, runtime publication or an invented sect resource source. */
function records(source: WorldStateV9 = fundedRuntimeFixture()): WorldStateV10 {
  recordChecked(source); const owned = cloneJson(source);
  const world: WorldStateV10 = { ...owned, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...owned.sectExpansion, schemaVersion: 2,
      construction: { ...owned.sectExpansion.construction, buildings: owned.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable L1 origin'); return { ...building, level: 1 as const };
      }) },
      production: { ...owned.sectExpansion.production, jobs: owned.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old fixture contains unsupported recipe');
        return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  return checked(world);
}
function checked(world: WorldStateV10): WorldStateV10 {
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): CommandV10 {
  return { kind: 'sect.command', commandId: payload.command.commandId, sequence: 0, issuedTick: world.clock.simulationTick, payload };
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, command);
  if (result.result.status !== 'accepted') throw new Error(JSON.stringify(result.result)); return checked(result.world);
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean, maximum = 1600): WorldStateV10 {
  let next = world;
  for (let tick = 0; tick < maximum && !done(next); tick++) next = prepareNormalTickCandidateV10(next);
  if (!done(next)) throw new Error('Real v10 candidate did not reach requested boundary'); return next;
}
function cancelUpgrade(world: WorldStateV10, commandId = 'discharge.upgrade.cancel'): WorldStateV10 {
  return apply(world, sect(world, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId,
    expectedRevision: world.sectExpansion.upgrade.revision, jobId: world.sectExpansion.upgrade.jobs[0]!.jobId } }));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function proof(before: WorldStateV10, after: WorldStateV10, label: string) {
  const result = inspectReservedDischargesV10(before, after);
  expect(result, result.unknowns.join('; ')).toMatchObject({ supported: true, unknowns: [] });
  expect(result.discharged).toContain(label); return result;
}

let oldMedicine: WorldStateV9; let researching: WorldStateV10; let researchAlmost: WorldStateV10; let ready: WorldStateV10;
let started: WorldStateV10; let half: WorldStateV10; let almost: WorldStateV10; let completed: WorldStateV10;
beforeAll(() => { oldMedicine = medicineRuntimeFixture(); }, 60000);
for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
  for (let index = 0; index < 4; index++) beforeAll(() => { oldMedicine = fixtureProduce(oldMedicine, recipe); }, 60000);
}
beforeAll(() => {
  const source = records(oldMedicine);
  researching = apply(source, sect(source, { domain: 'research', command: { kind: 'research.start', commandId: 'discharge.herbal',
    expectedRevision: source.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
  researchAlmost = until(researching, world => world.sectExpansion.research.jobs.at(-1)!.activeTicks === 399);
  ready = prepareNormalTickCandidateV10(researchAlmost);
  started = apply(ready, sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'discharge.upgrade.start',
    expectedRevision: ready.sectExpansion.upgrade.revision, workerId: 'entity:2',
    buildingId: ready.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } }));
  half = until(started, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 200);
  almost = until(half, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 399);
  completed = prepareNormalTickCandidateV10(almost);
}, 120000);

describe('fixed v10 authentic reserved terminal discharges', () => {
  it('retains a planned obligation when it becomes a paid construction owner', () => {
    const base = records();
    const planned = apply(base, sect(base, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'discharge.plan',
      expectedRevision: base.sectExpansion.construction.revision, placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } }));
    const blueprintId = planned.sectExpansion.construction.blueprints[0]!.blueprintId;
    const construction = apply(planned, sect(planned, { domain: 'construction', command: { kind: 'construction.start', commandId: 'discharge.construct',
      expectedRevision: planned.sectExpansion.construction.revision, blueprintId, workerId: 'entity:2' } }));
    expect(inspectReservedDischargesV10(planned, construction)).toEqual({ supported: true, discharged: [], unknowns: [] });
    const cancelledPlan = apply(planned, sect(planned, { domain: 'construction', command: { kind: 'construction.cancel', commandId: 'discharge.plan.cancel',
      expectedRevision: planned.sectExpansion.construction.revision, blueprintId } }));
    proof(planned, cancelledPlan, `sect.planned-blueprint:${blueprintId}`);
    const cancelledWork = apply(construction, sect(construction, { domain: 'construction', command: { kind: 'construction.cancel', commandId: 'discharge.construct.cancel',
      expectedRevision: construction.sectExpansion.construction.revision, blueprintId } }));
    proof(construction, cancelledWork, `sect.construction:${construction.sectExpansion.construction.jobs[0]!.jobId}`);
  });
  it('proves actual research cancellation and final tick completion from their exact sources', () => {
    const id = researching.sectExpansion.research.jobs.at(-1)!.jobId;
    const cancelled = apply(researching, sect(researching, { domain: 'research', command: { kind: 'research.cancel', commandId: 'discharge.research.cancel',
      expectedRevision: researching.sectExpansion.research.revision, jobId: id } }));
    proof(researching, cancelled, `sect.research:${id}`); proof(researchAlmost, ready, `sect.research:${id}`);
    expect(inspectReservedDischargesV10(researching, ready).supported).toBe(false);
  });
  it('proves pre-payment and half-paid upgrade cancellation without refunding consumed inputs', () => {
    for (const source of [started, half]) {
      const before = canonicalStringify(source); const after = cancelUpgrade(source);
      const id = source.sectExpansion.upgrade.jobs[0]!.jobId;
      proof(source, after, `sect.upgrade:${id}`);
      expect(after.inventory.stone.owned).toBe(source.inventory.stone.owned);
      expect(after.inventory.plank.owned).toBe(source.inventory.plank.owned);
      expect(after.inventory.stone.reserved).toBe(0); expect(after.inventory.plank.reserved).toBe(0);
      expect(after.sectExpansion.upgrade.jobs[0]!.terminal!.consumed.length).toBe(source === half ? 2 : 0);
      expect(after.sectExpansion.construction.buildings).toEqual(source.sectExpansion.construction.buildings);
      expect(canonicalStringify(source)).toBe(before);
    }
  });
  it('proves upgrade completion only on its real last work tick and keeps immutable L1 construction', () => {
    const id = almost.sectExpansion.upgrade.jobs[0]!.jobId;
    proof(almost, completed, `sect.upgrade:${id}`);
    expect(completed.sectExpansion.upgrade.jobs[0]!.terminal).toMatchObject({ kind: 'completed', resultLevel: 2 });
    expect(completed.sectExpansion.construction.buildings).toEqual(almost.sectExpansion.construction.buildings);
    const noOptional = prepareNoOptionalGrowthTickCandidateV10(almost);
    proof(almost, noOptional, `sect.upgrade:${id}`);
    expect(inspectReservedDischargesV10(half, completed).supported).toBe(false);
  });
  it('rejects a root-valid unrelated edit spliced into an otherwise real cancellation', () => {
    const after = cancelUpgrade(half); const forged = cloneJson(after);
    forged.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: forged.clock.simulationTick, message: 'unrelated candidate splice' });
    checked(forged);
    expect(inspectReservedDischargesV10(half, forged)).toMatchObject({ supported: false, discharged: [],
      unknowns: ['No exact actual v10 command or single-tick candidate witness'] });
  });
  it('refuses missing owner history, receipt, paired settlement, forged refund or changed site provenance', () => {
    const after = cancelUpgrade(half); const id = half.sectExpansion.upgrade.jobs[0]!.jobId;
    const variants: WorldStateV10[] = [];
    const erased = cloneJson(after); erased.sectExpansion = { ...erased.sectExpansion, upgrade: { ...erased.sectExpansion.upgrade, jobs: [] } }; variants.push(erased);
    const missingReceipt = cloneJson(after); missingReceipt.sectExpansion = { ...missingReceipt.sectExpansion,
      upgrade: { ...missingReceipt.sectExpansion.upgrade, receipts: missingReceipt.sectExpansion.upgrade.receipts.slice(0, -1) } }; variants.push(missingReceipt);
    const claim = cloneJson(after); claim.sectExpansion = { ...claim.sectExpansion, reservations: claim.sectExpansion.reservations.map(value => value.ownerTransactionId === id
      ? { ...value, sect: { ...value.sect, settlement: null } } : value) }; variants.push(claim);
    const refund = cloneJson(after); refund.inventory.stone.owned += 3; variants.push(refund);
    const site = cloneJson(after); site.sectExpansion = { ...site.sectExpansion, upgrade: { ...site.sectExpansion.upgrade,
      jobs: site.sectExpansion.upgrade.jobs.map(job => ({ ...job, site: { ...job.site, sourceJobId: 'invented-origin' } })) } }; variants.push(site);
    for (const invalid of variants) expect(inspectReservedDischargesV10(half, invalid)).toMatchObject({ supported: false, discharged: [] });
  });
  it('keeps L2 productiveSite and its upgrade source whole for both actual medicine recipes', () => {
    for (const [ordinal, recipeId] of ['craft.wound-powder.v9', 'craft.wound-powder-alt.v9'].entries()) {
      const source = apply(completed, sect(completed, { domain: 'production', command: { kind: 'production.start', commandId: `discharge.powder.${ordinal}`,
        expectedRevision: completed.sectExpansion.production.revision, recipeId: recipeId as 'craft.wound-powder.v9' | 'craft.wound-powder-alt.v9', workerId: 'entity:2' } }));
      const job = source.sectExpansion.production.jobs.at(-1)!;
      expect(job.productiveSite).toMatchObject({ level: 2, upgradeJobId: completed.sectExpansion.upgrade.jobs[0]!.jobId });
      const after = apply(source, sect(source, { domain: 'production', command: { kind: 'production.cancel', commandId: `discharge.powder.cancel.${ordinal}`,
        expectedRevision: source.sectExpansion.production.revision, jobId: job.transactionId } }));
      proof(source, after, `sect.production:${job.transactionId}`);
      expect(after.sectExpansion.production.jobs.at(-1)!.productiveSite).toEqual(job.productiveSite);
      for (const sourceField of ['upgradeJobId', 'sourceJobId', 'firstMaintenanceCalendarTick'] as const) {
        const bad = cloneJson(after);
        bad.sectExpansion = { ...bad.sectExpansion, production: { ...bad.sectExpansion.production,
          jobs: bad.sectExpansion.production.jobs.map(value => value.transactionId === job.transactionId
            ? { ...value, productiveSite: { ...value.productiveSite, [sourceField]: sourceField === 'firstMaintenanceCalendarTick' ? 0 : 'invented' } } as SectProductionJobV10 : value) } };
        expect(inspectReservedDischargesV10(source, bad)).toMatchObject({ supported: false, discharged: [] });
      }
    }
  });
  it('authenticates real care cancellation and complete healing with retained delivered-dose evidence', () => {
    const source = apply(completed, sect(completed, { domain: 'care', command: { kind: 'care.start', commandId: 'discharge.care',
      expectedRevision: completed.sectExpansion.care.revision, patientId: 'entity:4' } }));
    const id = source.sectExpansion.care.jobs[0]!.jobId;
    const cancelled = apply(source, sect(source, { domain: 'care', command: { kind: 'care.cancel', commandId: 'discharge.care.cancel',
      expectedRevision: source.sectExpansion.care.revision, jobId: id } }));
    proof(source, cancelled, `sect.care:${id}`);
    const last = until(source, world => world.sectExpansion.care.jobs[0]!.activeTicks === 39);
    const after = prepareNormalTickCandidateV10(last); proof(last, after, `sect.care:${id}`);
    expect(after.sectExpansion.care.jobs[0]!.terminal?.effect).toMatchObject({ beforeInjury: 25, afterInjury: 5 });
  });
  it('captures ordinary descriptors without mutating or freezing callers and keeps a fixed alias', () => {
    const before = cloneJson(half); const after = cancelUpgrade(before);
    const a = canonicalStringify(before); const b = canonicalStringify(after);
    const first = inspectReservedDischargesV10(before, after);
    expect(first.supported).toBe(true); expect(Object.isFrozen(before)).toBe(false); expect(Object.isFrozen(after)).toBe(false);
    expect(canonicalStringify(before)).toBe(a); expect(canonicalStringify(after)).toBe(b);
    first.discharged.length = 0;
    expect(fixedSectRelease(freeze(before), freeze(after)).discharged).toHaveLength(1);
    expect(fixedSectRelease).toBe(inspectReservedDischargesV10);
    expect(inspectReservedDischargesV10(after, after)).toEqual({ supported: true, discharged: [], unknowns: [] });
  });
  it('rejects old versions, getters, aliases and hostile thrown objects before trusting candidate reads', () => {
    const after = cancelUpgrade(half); let getterCalls = 0; let messageCalls = 0;
    const getter = cloneJson(half); Object.defineProperty(getter, 'sectExpansion', { enumerable: true, get: () => { getterCalls++; return half.sectExpansion; } });
    expect(inspectReservedDischargesV10(getter, after).supported).toBe(false); expect(getterCalls).toBe(0);
    const hostile = new Proxy(half, { ownKeys() { throw Object.defineProperty({}, 'message', { get() { messageCalls++; return 'do not read'; } }); } });
    expect(inspectReservedDischargesV10(hostile, after).supported).toBe(false); expect(messageCalls).toBe(0);
    const alias = cloneJson(half); alias.disciples[1]!.position = alias.disciples[0]!.position;
    expect(inspectReservedDischargesV10(alias, after).supported).toBe(false);
    expect(inspectReservedDischargesV10(fundedRuntimeFixture() as unknown as WorldStateV10, after).supported).toBe(false);
  });
});

describe('pending expiry and final lifecycle ownership', () => {
  it('cancels the upgrade before its would-be final tick but retains lifecycle through pending expiry', () => {
    const source = cloneJson(almost); const month = CALENDAR_TICKS_PER_MONTH;
    const target = Math.ceil((source.clock.calendarTick + 1) / month) * month;
    // Explicit near-expiry initial condition; no fabricated intervening months.
    source.clock.simulationTick = target - 1; source.clock.calendarTick = target - 1;
    const actor = source.disciples.find(value => value.id === 'entity:2')!;
    const profile = source.cultivation.disciples.find(value => value.discipleId === actor.id)!;
    actor.birthCalendarTick = target - profile.lifespanMonths * month; actor.ageMonths = profile.lifespanMonths - 1; profile.ageMonths = actor.ageMonths;
    checked(source); const pending = prepareNormalTickCandidateV10(source);
    const job = pending.sectExpansion.upgrade.jobs[0]!; const death = pending.cultivation.pendingDeaths.find(value => value.discipleId === actor.id)!;
    const evidence = proof(source, pending, `sect.upgrade:${job.jobId}`);
    expect(job).toMatchObject({ activeTicks: 399, terminal: { kind: 'cancelled', resultLevel: 1, cancellation: { kind: 'death', deathId: death.deathId } } });
    expect(evidence.discharged).not.toContain(`disciple-lifecycle:${actor.id}`);
    const owners = deriveProgressionReservationsTimeV9({ world: pending, buildFacts: deriveV10BuildObligationFacts(pending) }).owners;
    expect(owners.some(owner => owner.kind === 'disciple-lifecycle' && owner.id === actor.id)).toBe(true);
    const settled = apply(pending, { kind: 'cultivation.command', commandId: 'discharge.finalize', issuedTick: target, sequence: 0,
      payload: { command: { kind: 'death.finalize', commandId: 'discharge.finalize', expectedRevision: pending.cultivation.revision,
        discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    proof(pending, settled, `disciple-lifecycle:${actor.id}`);
    expect(settled.sectExpansion.upgrade).toEqual(pending.sectExpansion.upgrade);
    const estate = settled.legacy.estates.find(value => value.discipleId === actor.id)!;
    expect(estate.settledMonth).not.toBeNull(); expect(estate.transferCommandIds).toHaveLength(estate.itemInstanceIds.length);
    expect(settled.cultivation.archivedDisciples.some(value => value.discipleId === actor.id)).toBe(true);
    expect(settled.builds.retiredDisciples.some(value => value.discipleId === actor.id)).toBe(true);
    expect(settled.legacy.archivedIdentities.some(value => value.discipleId === actor.id)).toBe(true);
    for (const missing of ['estate', 'transfers', 'retirement', 'cultivation-archive', 'world-archive'] as const) {
      const bad = cloneJson(settled);
      if (missing === 'estate') bad.legacy.estates = bad.legacy.estates.filter(value => value.discipleId !== actor.id);
      if (missing === 'transfers') bad.legacy.estates = bad.legacy.estates.map(value => value.discipleId === actor.id ? { ...value, transferCommandIds: [] } : value);
      if (missing === 'retirement') bad.builds = { ...bad.builds, retiredDisciples: bad.builds.retiredDisciples.filter(value => value.discipleId !== actor.id) };
      if (missing === 'cultivation-archive') bad.cultivation.archivedDisciples = bad.cultivation.archivedDisciples.filter(value => value.discipleId !== actor.id);
      if (missing === 'world-archive') bad.legacy.archivedIdentities = bad.legacy.archivedIdentities.filter(value => value.discipleId !== actor.id);
      expect(inspectReservedDischargesV10(pending, bad)).toMatchObject({ supported: false, discharged: [] });
    }
  });
});

function automatic(world: WorldStateV10): WorldStateV10 {
  let next = apply(world, { kind: 'sect-economy.command', commandId: 'discharge.auto.plan', sequence: 0, issuedTick: world.clock.simulationTick,
    payload: { command: { kind: 'plan.set', plan: { workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'craft.plank', targetStock: 99 }] } } } });
  next = apply(next, { kind: 'sect-economy.command', commandId: 'discharge.auto.enable', sequence: 0, issuedTick: next.clock.simulationTick,
    payload: { command: { kind: 'enabled.set', enabled: true } } });
  return prepareNormalTickCandidateV10(next);
}

describe('retained legacy production through actual v10 candidates', () => {
  it('authenticates archived manual and pinned automatic cancellation without old wrappers', () => {
    const base = records(); const manual = apply(base, { kind: 'production.start', commandId: 'discharge.manual.start', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'craft.plank', workerId: 'entity:2' } });
    for (const source of [manual, automatic(base)]) {
      const id = source.activeProductionTransactionIds[0]!;
      const after = apply(source, { kind: 'production.cancel', commandId: 'discharge.legacy.cancel', sequence: 0,
        issuedTick: source.clock.simulationTick, payload: { transactionId: id } });
      proof(source, after, `${id.startsWith('auto-job/') ? 'automatic' : 'manual'}-production:${id}`);
    }
  });
  it('requires actual work and payment for an unpinned automatic completion', () => {
    let source = automatic(records()); const id = source.activeProductionTransactionIds[0] as `auto-job/${number}`;
    let after = prepareNormalTickCandidateV10(source);
    for (let index = 0; index < 500 && after.automaticProduction.live[id]; index++) { source = after; after = prepareNormalTickCandidateV10(source); }
    expect(source.automaticProduction.live[id]).toBeDefined(); expect(after.automaticProduction.live[id]).toBeUndefined();
    proof(source, after, `automatic-production:${id}`);
    expect(after.inventory.wood.owned).toBe(source.inventory.wood.owned - 3);
    expect(after.inventory.plank.owned).toBe(source.inventory.plank.owned + 2);
  }, 30000); // Full real 160-work-tick/path/root replay; keep all payment assertions.
  it('refuses a structurally valid automatic retirement notice with no actual completion or payment', () => {
    const source = automatic(records()); const id = source.activeProductionTransactionIds[0] as `auto-job/${number}`;
    const pair = source.automaticProduction.live[id]!;
    let forged = cloneJson(prepareNormalTickCandidateV10(source)); delete forged.automaticProduction.live[id];
    forged.activeProductionTransactionIds = [];
    forged.disciples = forged.disciples.map(actor => actor.assignmentTransactionId === id ? { ...actor, assignmentTransactionId: null, traveling: false } : actor);
    forged.buildings = forged.buildings.map(site => site.stationTransactionId === id ? { ...site, stationTransactionId: null } : site);
    for (const line of pair.reservation.lines) forged.inventory[line.resourceId].reserved -= line.quantity;
    forged = recordAutomaticNotice(forged, { cycle: pair.transaction.origin.cycle, workerId: pair.transaction.workerId,
      recipeId: pair.transaction.recipeId, kind: 'committed', reason: null });
    checked(forged);
    expect(inspectReservedDischargesV10(source, forged)).toMatchObject({ supported: false, discharged: [] });
  });
});
