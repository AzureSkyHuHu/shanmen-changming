import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { deliveredPowderJobs } from '../../src/core/sect-expansion/care-runtime';
import { applyValidatedCareCommandV10, deliveredPowderJobsV10, sectCareClaimsV10, tickValidatedCareV10, v10CarePatientEligible } from '../../src/core/sect-expansion/care-runtime-v10';
import type { SectCareCommand, SectCareJob } from '../../src/core/sect-expansion/care-types';
import { isSectCareCommandV10, validateCareOwnerClosureV10, validateCareRecordsV10 } from '../../src/core/sect-expansion/care-validation-v10';
import { captureSectHistoricalIdentitiesV10 } from '../../src/core/sect-expansion/history-identity';
import { tickValidatedSectMaintenancePaymentV10 } from '../../src/core/sect-expansion/maintenance-runtime-v10';
import { validateSectMaintenanceRecordsV10 } from '../../src/core/sect-expansion/maintenance-v10';
import { applyValidatedSectProductionCommandV10, tickValidatedSectProductionV10, validateSectProductionRecordsV10, validateSectProductionReceiptsV10 } from '../../src/core/sect-expansion/production-runtime-v10';
import { applyValidatedSectUpgradeCommandV10, tickValidatedSectUpgradeV10 } from '../../src/core/sect-expansion/upgrade-runtime';
import { createSectUpgradeStateV10, sectUpgradeAllLocalClaimsV10, validateSectUpgradeRecordsV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { inspectV10CultivationClockRecords } from '../../src/core/world/v10-cultivation-clock-records';
import { inspectV10LifecycleRecords } from '../../src/core/world/v10-lifecycle-records';
import { composeV10SectFrame, projectV10SectFrame, v10SectContext } from '../../src/core/world/v10-sect-frame';
import { projectV9SectFrame } from '../../src/core/world/v9-sect-bridge';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCommand, fixtureProduce, fixtureSectCommand, fixtureUntil, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

const patientId = 'entity:4';
const injury = (world: WorldStateV10): number => world.cultivation.disciples.find(profile => profile.discipleId === patientId)!.injury;
const last = (world: WorldStateV10): SectCareJob => world.sectExpansion.care.jobs.at(-1)!;
/** Explicit component-record fixture, NOT migration or complete v10 World admission.
 * v9 source work is real; the later local upgrade/production/care steps authenticate
 * their domain records without claiming the missing full root clock/capacity path. */
function lift(source: WorldStateV9): WorldStateV10 {
  recordChecked(source);
  return { ...cloneJson(source), simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...cloneJson(source.sectExpansion), schemaVersion: 2,
      construction: { ...cloneJson(source.sectExpansion.construction), buildings: source.sectExpansion.construction.buildings.map(building => ({ ...building, level: 1 as const })) },
      production: { ...cloneJson(source.sectExpansion.production), jobs: source.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old source cannot supply alternative medicine');
        return cloneJson({ ...job, recipeId: job.recipeId });
      }) }, upgrade: createSectUpgradeStateV10() } };
}
function checked(world: WorldStateV10): WorldStateV10 {
  const frame = projectV10SectFrame(world);
  expect(validateSectUpgradeRecordsV10(frame)).toEqual([]);
  expect(validateSectMaintenanceRecordsV10(frame)).toEqual([]);
  expect(validateSectProductionRecordsV10(frame)).toEqual([]);
  expect(validateSectProductionReceiptsV10(frame)).toEqual([]);
  expect(validateCareRecordsV10(world, frame)).toEqual([]);
  expect(validateCareOwnerClosureV10(world, frame)).toEqual([]);
  return world;
}
function command(world: WorldStateV10, value: SectCareCommand): WorldStateV10 {
  const result = applyValidatedCareCommandV10(world, projectV10SectFrame(world), v10SectContext(world), value);
  if ('code' in result) throw new Error(result.code); return checked(result.world);
}
const start = (world: WorldStateV10, id = `care10.start.${world.sectExpansion.care.nextId}`, target = patientId): WorldStateV10 => command(world,
  { kind: 'care.start', commandId: id, expectedRevision: world.sectExpansion.care.revision, patientId: target });
const cancel = (world: WorldStateV10, id = `care10.cancel.${world.sectExpansion.care.nextId}`): WorldStateV10 => command(world,
  { kind: 'care.cancel', commandId: id, expectedRevision: world.sectExpansion.care.revision, jobId: last(world).jobId });
function nextClock(world: WorldStateV10): WorldStateV10 {
  return { ...world, clock: { ...world.clock, simulationTick: world.clock.simulationTick + 1, calendarTick: world.clock.calendarTick + 1 } };
}
function careStep(world: WorldStateV10): WorldStateV10 {
  const next = nextClock(world);
  return tickValidatedCareV10(next, projectV10SectFrame(next), v10SectContext(next), createWorkPathBudget(next.clock.simulationTick));
}
function finish(world: WorldStateV10): WorldStateV10 {
  for (let n = 0; n < 200 && !last(world).terminal; n++) world = careStep(world);
  expect(last(world).terminal?.kind).toBe('completed'); return checked(world);
}
/** Each local domain step advances one actual simulation tick and shared path budget.
 * Whole-World cultivation/month progression is explicitly outside this component harness. */
function domainStep(world: WorldStateV10): WorldStateV10 {
  const next = nextClock(world); const context = v10SectContext(next); const budget = createWorkPathBudget(context.simulationTick);
  let frame = tickValidatedSectMaintenancePaymentV10(projectV10SectFrame(next), context);
  const upgrade = tickValidatedSectUpgradeV10(frame, context, budget); if (!upgrade.ok) throw new Error(upgrade.code);
  frame = tickValidatedSectProductionV10(upgrade.frame, context, budget);
  return composeV10SectFrame(next, frame);
}
function withCare(world: WorldStateV10, job: SectCareJob): WorldStateV10 {
  return { ...world, sectExpansion: { ...world.sectExpansion, care: { ...world.sectExpansion.care,
    jobs: world.sectExpansion.care.jobs.map(value => value.jobId === job.jobId ? job : value) } } };
}
const corrupt = <T>(value: T, patch: Record<string, unknown>): T => ({ ...value, ...patch });
let oldMedicine: WorldStateV9; let oldReady: WorldStateV9; let l1: WorldStateV10; let activeUpgrade: WorldStateV10; let ready: WorldStateV10;
beforeAll(() => { oldMedicine = medicineRuntimeFixture(); oldReady = oldMedicine; }, 30000);
for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
  for (let n = 0; n < 4; n++) beforeAll(() => { oldReady = fixtureProduce(oldReady, recipe); }, 30000);
}
beforeAll(() => {
  oldReady = fixtureApply(oldReady, fixtureSectCommand(oldReady, { domain: 'research', command: { kind: 'research.start', commandId: 'care10.herbal',
    expectedRevision: oldReady.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
  oldReady = fixtureUntil(oldReady, world => world.sectExpansion.research.jobs.at(-1)!.terminal !== null);
  l1 = checked(lift(oldReady));
  const upgrade = applyValidatedSectUpgradeCommandV10(projectV10SectFrame(l1), v10SectContext(l1), { kind: 'upgrade.start', commandId: 'care10.upgrade',
    expectedRevision: 0, buildingId: l1.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId, workerId: patientId });
  if (!upgrade.ok) throw new Error(upgrade.code); activeUpgrade = composeV10SectFrame(l1, upgrade.frame); ready = activeUpgrade;
  for (let n = 0; n < 1000 && ready.sectExpansion.upgrade.jobs[0]!.terminal === null; n++) ready = domainStep(ready);
  expect(ready.sectExpansion.upgrade.jobs[0]!.terminal?.kind).toBe('completed'); checked(ready);
}, 30000);
beforeAll(() => {
  const result = applyValidatedSectProductionCommandV10(projectV10SectFrame(ready), v10SectContext(ready), { kind: 'production.start', commandId: 'care10.alt',
    expectedRevision: ready.sectExpansion.production.revision, recipeId: 'craft.wound-powder-alt.v9', workerId: 'entity:2' });
  if (!result.ok) throw new Error(result.code); ready = composeV10SectFrame(ready, result.frame);
  for (let n = 0; n < 1000 && !ready.sectExpansion.production.jobs.at(-1)!.terminal; n++) ready = domainStep(ready);
  expect(ready.sectExpansion.production.jobs.at(-1)!.terminal?.kind).toBe('completed'); checked(ready);
}, 30000);

describe('fixed v10 two-recipe care component, genuine local work and paired settlements', () => {
  it('selects only the two exact delivered recipes and leaves v9 selection unchanged', () => {
    const frame = projectV10SectFrame(ready); const jobs = deliveredPowderJobsV10(frame, ready.clock.simulationTick);
    expect(jobs.map(job => job.recipeId)).toEqual(['craft.wound-powder.v9', 'craft.wound-powder-alt.v9']);
    expect(deliveredPowderJobs(projectV9SectFrame(oldReady), oldReady.clock.simulationTick).map(job => job.recipeId)).toEqual(['craft.wound-powder.v9']);
    const alt = jobs[1]!;
    for (const patch of [{ recipeId: 'study.basic-insight.v9' }, { recipeId: 'craft.wound-powder-alt.v9.fake' }, { deliveryVisit: null },
      { terminal: { ...alt.terminal!, kind: 'cancelled' } }, { terminal: { ...alt.terminal!, outputs: [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 2 }] } }]) {
      const isolated = { ...frame, production: { ...frame.production, jobs: [corrupt(alt, patch)] } };
      expect(deliveredPowderJobsV10(isolated, ready.clock.simulationTick)).toEqual([]);
    }
    expect(deliveredPowderJobsV10({ ...frame, production: { ...frame.production, jobs: [alt] } }, alt.terminal!.tick - 1)).toEqual([]);
    const forgedWork = { ...frame, production: { ...frame.production, jobs: frame.production.jobs.map(job => job === alt ? { ...job, workSpans: [] } : job) } };
    expect(validateSectProductionRecordsV10(forgedWork).length).toBeGreaterThan(0);
  });
  it('rejects stock without delivered output and excludes a patient actively upgrading', () => {
    const noSource = { ...ready, sectExpansion: { ...ready.sectExpansion, production: { ...ready.sectExpansion.production, jobs: [] } } };
    const request: SectCareCommand = { kind: 'care.start', commandId: 'care10.no-source', expectedRevision: 0, patientId };
    expect(applyValidatedCareCommandV10(noSource, projectV10SectFrame(noSource), v10SectContext(noSource), request)).toEqual({ code: 'NO_AVAILABLE_DOSE' });
    expect(v10CarePatientEligible(activeUpgrade, patientId)).toBe(false);
    expect(applyValidatedCareCommandV10(activeUpgrade, projectV10SectFrame(activeUpgrade), v10SectContext(activeUpgrade), request)).toEqual({ code: 'PATIENT_UNAVAILABLE' });
  });
  it('walks to storage, excludes arrival, then consumes base followed by alternative at exactly 40 work ticks', () => {
    const original = canonicalStringify(ready); const rng = cloneJson(ready.randomStreams); let world = start(ready);
    expect(world.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 2, reserved: 1 });
    while (last(world).phase === 'to-storage') world = careStep(world);
    expect(last(world).activeTicks).toBe(0); expect(injury(world)).toBe(25);
    for (let n = 0; n < 39; n++) world = careStep(world);
    expect(last(world).terminal).toBeNull(); expect(injury(world)).toBe(25);
    world = checked(careStep(world)); expect(injury(world)).toBe(5);
    expect(last(world).terminal?.effect).toMatchObject({ effectId: 'care.wound-powder.reduce-injury.v9.1', beforeInjury: 25, afterInjury: 5 });
    const firstDose = last(world).doseProductionJobId; world = start(world);
    expect(last(world).doseProductionJobId).not.toBe(firstDose); expect(last(world).previousCancelledCareId).toBeNull();
    world = finish(world); expect(injury(world)).toBe(0); expect(world.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 0, reserved: 0 });
    expect(world.sectExpansion.care.jobs.map(job => job.activeTicks)).toEqual([40, 40]);
    expect(world.sectExpansion.care.jobs[0]!.terminal!.consumed).not.toBe(world.sectExpansion.care.jobs[1]!.terminal!.consumed);
    expect(sectCareClaimsV10(world)).toEqual([]); expect(world.randomStreams).toEqual(rng); expect(canonicalStringify(ready)).toBe(original);
  });
  it('reuses oldest cancelled dose, preserves positions and JSON continuation, and exactly retries', () => {
    let started = start(ready, 'care10.reuse.first'); started = careStep(started);
    const position = cloneJson(started.disciples.find(actor => actor.id === patientId)!.position);
    const cancelled = cancel(started); expect(cancelled.disciples.find(actor => actor.id === patientId)!.position).toEqual(position);
    const restarted = start(cancelled, 'care10.reuse.second');
    expect(last(restarted).doseProductionJobId).toBe(last(cancelled).doseProductionJobId);
    expect(last(restarted).previousCancelledCareId).toBe(last(cancelled).jobId);
    const done = finish(restarted); expect(finish(JSON.parse(JSON.stringify(restarted)) as WorldStateV10)).toEqual(done);
    const receipt = restarted.sectExpansion.care.receipts.at(-1)!;
    const repeated = applyValidatedCareCommandV10(done, projectV10SectFrame(done), v10SectContext(done), receipt.command);
    expect(repeated).toMatchObject({ world: done, repeated: true }); if (!('code' in repeated)) expect(repeated.world).toBe(done);
    expect(applyValidatedCareCommandV10(done, projectV10SectFrame(done), v10SectContext(done), { ...receipt.command, expectedRevision: 999 })).toEqual({ code: 'IDENTITY_CONFLICT' });
    expect(validateCareRecordsV10(withCare(restarted, { ...last(restarted), previousCancelledCareId: null }), projectV10SectFrame(restarted)).length).toBeGreaterThan(0);
  });
  it('reuses the alternative physical dose after cancellation without reviving consumed base medicine', () => {
    const baseDone = finish(start(ready)); const alt = start(baseDone, 'care10.alt-cancel.start');
    const altSource = ready.sectExpansion.production.jobs.find(job => job.recipeId === 'craft.wound-powder-alt.v9')!;
    expect(last(alt).doseProductionJobId).toBe(altSource.transactionId);
    const stopped = cancel(careStep(alt), 'care10.alt-cancel.cancel');
    expect(stopped.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 });
    const reused = start(stopped, 'care10.alt-cancel.reuse');
    expect(last(reused).doseProductionJobId).toBe(altSource.transactionId);
    expect(last(reused).previousCancelledCareId).toBe(last(stopped).jobId);
    const finished = finish(reused); expect(injury(finished)).toBe(0);
    expect(finished.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 0, reserved: 0 });
  });
  it('uses the shared claims once and rejects live-dose reuse, impossible work and effect tampering', () => {
    const live = start(ready); const frame = projectV10SectFrame(live);
    expect(sectUpgradeAllLocalClaimsV10(frame).filter(claim => claim.ownerId === last(live).jobId)).toHaveLength(2);
    expect(validateCareOwnerClosureV10(live, frame)).toEqual([]);
    const done = finish(live);
    for (const changed of [withCare(done, { ...last(done), activeTicks: 39 }), withCare(done, { ...last(done), visits: [] }),
      withCare(done, { ...last(done), terminal: { ...last(done).terminal!, effect: { ...last(done).terminal!.effect!, afterInjury: 0 } } }),
      withCare(done, { ...last(done), doseProductionJobId: 'sect-production:999' })]) {
      expect(validateCareRecordsV10(changed, projectV10SectFrame(changed)).length).toBeGreaterThan(0);
    }
    const used = start(done); const forged = withCare(used, { ...last(used), doseProductionJobId: last(done).doseProductionJobId });
    expect(validateCareRecordsV10(forged, projectV10SectFrame(forged))).toContainEqual({ code: 'INVALID_CARE_DOSE_PROVENANCE', path: last(forged).jobId });
  });
  it('counts all six owners bidirectionally and rejects missing, duplicate and orphan paired reservations', () => {
    const world = start(ready); const frame = projectV10SectFrame(world); const own = frame.construction.ledger.reservations.find(claim => claim.ownerTransactionId === last(world).jobId)!;
    const missing = { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger, reservations: frame.construction.ledger.reservations.filter(claim => claim !== own) } } };
    expect(validateCareOwnerClosureV10(world, missing)[0]?.code).toBe('OWNER_RESERVATION_DIFFERS');
    const duplicated = { ...frame, construction: { ...frame.construction, ledger: { ...frame.construction.ledger, reservations: [...frame.construction.ledger.reservations, cloneJson(own)] } } };
    expect(validateCareOwnerClosureV10(world, duplicated)[0]?.code).toBe('OWNER_RESERVATION_DIFFERS');
    const missingUpgrade = { ...frame, upgrade: { ...frame.upgrade, jobs: [] } };
    expect(validateCareOwnerClosureV10(world, missingUpgrade)[0]?.code).toBe('ORPHAN_RESERVATION');
  });
  it('preserves pause, shared path exhaustion, storage interruption and safe cancellation', () => {
    const started = start(ready); const context = { ...v10SectContext(started), paused: true };
    expect(tickValidatedCareV10(started, projectV10SectFrame(started), context, createWorkPathBudget(context.simulationTick))).toBe(started);
    const next = nextClock(started); const budget = createWorkPathBudget(next.clock.simulationTick);
    for (let n = 0; n < 4; n++) advanceWorkNavigationWithBudget({ map: next.map, position: { x: 8, y: 5 }, target: { x: 7, y: 5 }, navigation: emptyNavigation(), simulationTick: next.clock.simulationTick }, budget);
    const exhausted = tickValidatedCareV10(next, projectV10SectFrame(next), v10SectContext(next), budget);
    expect(last(exhausted).blocked).toBe('PATH_BUDGET'); expect(last(exhausted).activeTicks).toBe(0);
    const blocked = careStep({ ...started, buildings: started.buildings.map(site => site.blueprintId === 'storage' ? { ...site, operational: false } : site) });
    expect(last(blocked).blocked).toBe('STORAGE_UNAVAILABLE'); expect(last(blocked).activeTicks).toBe(0);
    expect(cancel(blocked).sectExpansion.stock['wound-powder']).toMatchObject({ owned: 2, reserved: 0 });
  });
  it('keeps command shapes strict and reserves local terminal headroom', () => {
    const request: SectCareCommand = { kind: 'care.start', commandId: 'care10.bounds', expectedRevision: 0, patientId };
    for (const patch of [{ price: [] }, { doseProductionJobId: 'fake' }, { effect: { injury: 0 } }, { eligible: true }]) expect(isSectCareCommandV10({ ...request, ...patch })).toBe(false);
    let reads = 0; const hostile = { ...request }; Object.defineProperty(hostile, 'patientId', { enumerable: true, get: () => { reads++; return patientId; } });
    expect(isSectCareCommandV10(hostile)).toBe(false); expect(reads).toBe(0);
    const pressure = { ...ready, sectExpansion: { ...ready.sectExpansion, care: { ...ready.sectExpansion.care, nextId: Number.MAX_SAFE_INTEGER - 1 } } };
    expect(applyValidatedCareCommandV10(pressure, projectV10SectFrame(pressure), v10SectContext(pressure), request)).toEqual({ code: 'CAPACITY_EXCEEDED' });
  });
});

/** These lifecycle branches use real v9 clock/death reducers first, then the fixed v10
 * record wrappers verify the unchanged care history. This is preservation evidence,
 * not a claim that a new v10 World lifecycle transition was executed here. */
describe('v10 care preserves genuine old rest/death/retired evidence and namespace', () => {
  it('accepts real rest-healed release only with the matching month source', () => {
    let old = cloneJson(oldMedicine); old.cultivation.disciples.find(profile => profile.discipleId === patientId)!.injury = 7;
    const id = 'care10.real-rest'; old = fixtureApply(old, fixtureCommand(old, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: id,
      expectedRevision: old.cultivation.revision, discipleId: patientId, mode: 'rest' } } }, id));
    const target = Math.ceil((old.clock.calendarTick + 1) / CALENDAR_TICKS_PER_MONTH) * CALENDAR_TICKS_PER_MONTH;
    old.clock = { ...old.clock, simulationTick: target - 1, calendarTick: target - 1 };
    old = fixtureApply(old, fixtureSectCommand(old, { domain: 'care', command: { kind: 'care.start', commandId: 'care10.before-month', expectedRevision: 0, patientId } }));
    old = recordChecked(prepareNormalTickCandidateV9(old)); const world = lift(old); const frame = projectV10SectFrame(world);
    expect(last(world).terminal?.cancellation?.kind).toBe('rest-healed'); expect(world.sectExpansion.stock['wound-powder'].reserved).toBe(0);
    inspectV10CultivationClockRecords(world); expect(validateCareRecordsV10(world, frame)).toEqual([]);
    expect(world.sectExpansion.care.receipts.at(-1)!.command.commandId).toBe(`system/v9/healed/${old.cultivation.calendarMonth}/${last(world).jobId}`);
    const reason = last(world).terminal!.cancellation!; if (reason.kind !== 'rest-healed') throw new Error('Expected real month reason');
    const changed = withCare(world, { ...last(world), terminal: { ...last(world).terminal!, cancellation: { ...reason, beforeRevision: reason.beforeRevision + 1 } } });
    expect(validateCareRecordsV10(changed, projectV10SectFrame(changed))[0]?.code).toBe('INVALID_CARE_HEAL_SOURCE');
  }, 30000);
  it('retains real death release and requires authenticated retired identity references', () => {
    let old = cloneJson(oldMedicine); const profile = old.cultivation.disciples.find(value => value.discipleId === patientId)!;
    const actor = old.disciples.find(value => value.id === patientId)!;
    const target = Math.ceil((old.clock.calendarTick + 1) / CALENDAR_TICKS_PER_MONTH) * CALENDAR_TICKS_PER_MONTH;
    old.clock = { ...old.clock, simulationTick: target - 1, calendarTick: target - 1 };
    actor.birthCalendarTick = target - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor((target - 1 - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    old = fixtureApply(old, fixtureSectCommand(old, { domain: 'care', command: { kind: 'care.start', commandId: 'care10.before-death', expectedRevision: 0, patientId } }));
    old = recordChecked(prepareNormalTickCandidateV9(old)); const death = old.cultivation.pendingDeaths.find(value => value.discipleId === patientId)!;
    const id = 'care10.finalize'; old = fixtureApply(old, fixtureCommand(old, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', commandId: id,
      expectedRevision: old.cultivation.revision, discipleId: patientId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } }, id));
    const world = lift(old); const frame = projectV10SectFrame(world); const identities = captureSectHistoricalIdentitiesV10(inspectV10LifecycleRecords(world), world);
    expect(last(world).terminal?.cancellation).toEqual({ kind: 'death', deathId: death.deathId });
    expect(world.sectExpansion.care.receipts.at(-1)!.command.commandId).toBe(`system/v9/death/${death.deathId}/${last(world).jobId}`);
    expect(validateCareRecordsV10(world, frame, identities)).toEqual([]); expect(validateCareRecordsV10(world, frame)[0]?.code).toBe('INVALID_CARE_PATIENT_REFERENCE');
    expect(v10CarePatientEligible(world, patientId)).toBe(false);
    const corrupted = { ...world, sectExpansion: { ...world.sectExpansion, care: { ...world.sectExpansion.care,
      receipts: world.sectExpansion.care.receipts.map(receipt => receipt.command.kind === 'care.cancel' ? { ...receipt, command: { ...receipt.command, commandId: `system/v10/death/${death.deathId}/${last(world).jobId}` } } : receipt) } } };
    expect(validateCareRecordsV10(corrupted, projectV10SectFrame(corrupted), identities)[0]?.code).toBe('INVALID_CARE_DEATH_SOURCE');
  }, 30000);
});
