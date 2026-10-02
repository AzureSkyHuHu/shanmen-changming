import { describe, expect, it } from 'vitest';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { assessManagementCapacityV9 } from '../../src/core/world/management-capacity-v9';
import { advanceCapacityLimitedTicksV9, dispatchCapacityLimitedCommandV9, verifyCapacityLimitedCandidateV9 } from '../../src/core/world/runtime-capacity-v9';
import { inspectReservedDischargesV9 } from '../../src/core/world/sect-release-v9';
import { advanceV9CultivationClock } from '../../src/core/world/v9-cultivation-clock-bridge';
import { V9_CULTIVATION_CLOCK_LIMIT } from '../../src/core/world/v9-cultivation-clock-types';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCareStart, fixtureCommand, fixturePlace, fixtureProduce, fixtureResearchStart,
  fixtureSectCommand, fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

function pressure(source: WorldStateV9, excess = 700_000): WorldStateV9 {
  const world = cloneJson(source); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
  const a = assessManagementCapacityV9(world); expect(a.supported).toBe(true);
  world.diagnostics.at(-1)!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES + excess - a.costs.wireBytes!);
  return recordChecked(world);
}
function proof(before: WorldStateV9, after: WorldStateV9) {
  const a = assessManagementCapacityV9(before); const b = assessManagementCapacityV9(after);
  expect(a.supported).toBe(true); expect(b.supported, b.sourceRecordIssues.join(';')).toBe(true);
  return inspectReservedDischargesV9(before, after, { sect: a.sect!, progression: a.progression! }, { sect: b.sect!, progression: b.progression! });
}
let constructing: WorldStateV9; let library: WorldStateV9; let researching: WorldStateV9; let researched: WorldStateV9; let medicine: WorldStateV9;
describe('actual paid sect/lifecycle recovery through the limited publication gate', () => {
  it('prepares real construction and proves partial-payment cancellation preserves consumed materials', () => {
    constructing = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1));
    const source = pressure(fixtureUntil(constructing, value => value.sectExpansion.construction.jobs[0]!.activeTicks === 160));
    const job = source.sectExpansion.construction.jobs[0]!; const claim = source.sectExpansion.reservations[0]!;
    expect(claim.base.consumed.length).toBeGreaterThan(0);
    const input = fixtureSectCommand(source, { domain: 'construction', command: { kind: 'construction.cancel', commandId: 'runtime.cancel.half',
      expectedRevision: source.sectExpansion.construction.revision, blueprintId: job.blueprintId } });
    const after = dispatchCapacityLimitedCommandV9(source, input); expect(after.result.status).toBe('accepted');
    expect(proof(source, after.world).discharged).toContain(`sect.construction:${job.jobId}`);
    expect(after.world.inventory.wood.owned).toBe(source.inventory.wood.owned); expect(after.world.inventory.wood.reserved).toBe(0);
    expect(after.world.map.navVersion).toBe(source.map.navVersion + 1);
    library = fixtureUntil(constructing, value => !!value.sectExpansion.construction.jobs[0]!.terminal);
  });
  for (const [index, recipe] of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'].entries()) {
    it(`prepares actual research input checkpoint ${index + 1}`, () => {
      library = fixtureProduce(library, recipe as 'extract.spirit-stone.v9' | 'study.basic-insight.v9');
      expect(assessManagementCapacityV9(library).supported).toBe(true);
    });
  }
  it('authenticates real research cancellation and its paired paid-stock ownership', () => {
    researching = fixtureResearchStart(library); const source = pressure(researching); const job = source.sectExpansion.research.jobs[0]!;
    const input = fixtureSectCommand(source, { domain: 'research', command: { kind: 'research.cancel', commandId: 'runtime.cancel.research',
      expectedRevision: source.sectExpansion.research.revision, jobId: job.jobId } });
    const after = dispatchCapacityLimitedCommandV9(source, input); expect(after.result.status).toBe('accepted');
    expect(proof(source, after.world).discharged).toContain(`sect.research:${job.jobId}`);
    expect(after.world.sectExpansion.stock['basic-insight'].owned).toBe(source.sectExpansion.stock['basic-insight'].owned);
    expect(after.world.sectExpansion.stock['basic-insight'].reserved).toBe(0);
    researched = fixtureUntil(researching, value => !!value.sectExpansion.research.jobs[0]!.terminal);
  });
  it('prepares actual alchemy, paid research gate and delivered medicine', () => {
    const alchemy = fixtureStartConstruction(fixturePlace(researched, 'alchemy.v9', 10));
    medicine = fixtureProduce(fixtureUntil(alchemy, value => !!value.sectExpansion.construction.jobs.at(-1)!.terminal), 'craft.wound-powder.v9');
    expect(medicine.sectExpansion.stock['wound-powder'].owned).toBe(1);
  });
  it('authenticates requested care cancellation and preserves the actual delivered dose', () => {
    const source = pressure(fixtureCareStart(medicine)); const job = source.sectExpansion.care.jobs[0]!;
    const input = fixtureSectCommand(source, { domain: 'care', command: { kind: 'care.cancel', commandId: 'runtime.cancel.care', expectedRevision: source.sectExpansion.care.revision, jobId: job.jobId } });
    const after = dispatchCapacityLimitedCommandV9(source, input); expect(after.result.status).toBe('accepted');
    expect(proof(source, after.world).discharged).toContain(`sect.care:${job.jobId}`);
    expect(after.world.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 });
    expect(after.world.sectExpansion.care.jobs[0]!.terminal?.cancellation).toEqual({ kind: 'requested' });
    const tampered = cloneJson(after.world); const claim = tampered.sectExpansion.reservations.find(value => value.ownerTransactionId === job.jobId)!;
    tampered.sectExpansion = { ...tampered.sectExpansion, reservations: tampered.sectExpansion.reservations.map(value => value === claim ? { ...value, sect: { ...value.sect, settlement: null } } : value) };
    expect(verifyCapacityLimitedCandidateV9(source, tampered)).toMatchObject({ ok: false, reason: 'unsupported-source' });
  });
  it('authenticates real last-tick care completion with committed dose, effect and revision ownership', () => {
    const source = pressure(fixtureUntil(fixtureCareStart(medicine), value => value.sectExpansion.care.jobs[0]!.activeTicks === 39));
    const before = canonicalStringify(source); const after = advanceCapacityLimitedTicksV9(source, 1);
    expect(after.stopped).toBeNull(); expect(verifyCapacityLimitedCandidateV9(source, after.world)).toMatchObject({ ok: true, reason: 'reserved-recovery' });
    expect(proof(source, after.world).discharged).toContain(`sect.care:${source.sectExpansion.care.jobs[0]!.jobId}`);
    expect(after.world.sectExpansion.care.jobs[0]!.terminal?.effect).toMatchObject({ beforeInjury: 25, afterInjury: 5 });
    expect(after.world.sectExpansion.stock['wound-powder'].owned).toBe(0); expect(canonicalStringify(source)).toBe(before);
  });
  it('authenticates natural rest-healed cancellation without consuming the dose', () => {
    let source = cloneJson(medicine); source.cultivation.disciples.find(profile => profile.discipleId === 'entity:4')!.injury = 8;
    source = fixtureApply(source, fixtureCommand(source, { kind: 'cultivation.command', payload: { command: { kind: 'training.set', commandId: 'runtime.rest',
      expectedRevision: source.cultivation.revision, discipleId: 'entity:4', mode: 'rest' } } }, 'runtime.rest'));
    const month = (Math.floor(source.clock.calendarTick / CALENDAR_TICKS_PER_MONTH) + 1) * CALENDAR_TICKS_PER_MONTH;
    // Explicit idle within-month boundary fixture; no clock rows are skipped.
    source.clock = { ...source.clock, simulationTick: month - 1, calendarTick: month - 1 };
    source = pressure(fixtureCareStart(recordChecked(source), 'runtime.rest.care'));
    const after = advanceCapacityLimitedTicksV9(source, 1); expect(after.stopped).toBeNull();
    expect(after.world.sectExpansion.care.jobs[0]!.terminal?.cancellation?.kind).toBe('rest-healed');
    expect(proof(source, after.world).discharged).toContain(`sect.care:${source.sectExpansion.care.jobs[0]!.jobId}`);
    expect(after.world.sectExpansion.stock['wound-powder']).toMatchObject({ owned: 1, reserved: 0 });
  });
  it('authenticates patient pending-death cancellation and keeps full estate ownership reserved', () => {
    let source = cloneJson(medicine); const profile = source.cultivation.disciples.find(profile => profile.discipleId === 'entity:4')!;
    const actor = source.disciples.find(actor => actor.id === profile.discipleId)!;
    const month = (Math.floor(source.clock.calendarTick / CALENDAR_TICKS_PER_MONTH) + 1) * CALENDAR_TICKS_PER_MONTH;
    source.clock = { ...source.clock, simulationTick: month - 1, calendarTick: month - 1 };
    actor.birthCalendarTick = month - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor((source.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    source = pressure(fixtureCareStart(recordChecked(source), 'runtime.death.care'));
    const after = advanceCapacityLimitedTicksV9(source, 1); expect(after.stopped).toBeNull();
    expect(after.world.sectExpansion.care.jobs[0]!.terminal?.cancellation?.kind).toBe('death');
    const evidence = proof(source, after.world); expect(evidence.discharged).toContain(`sect.care:${source.sectExpansion.care.jobs[0]!.jobId}`);
    expect(evidence.discharged).not.toContain('disciple-lifecycle:entity:4');
    expect(assessManagementCapacityV9(after.world).progression!.owners.some(owner => owner.id === 'entity:4')).toBe(true);
  });
  it('suppresses rejected maintenance only on the replayed same tick and leaves renewal enabled for later', () => {
    const libraryId = medicine.sectExpansion.construction.buildings.find(building => building.definitionId === 'library.v9')!.buildingId;
    let source = medicine;
    for (let index = 0; index < 1300; index++) {
      const candidate = prepareNormalTickCandidateV9(source);
      if (candidate.sectExpansion.maintenance.payments.some(payment => payment.buildingId === libraryId && !source.sectExpansion.maintenance.payments.some(old => old.paymentId === payment.paymentId))) break;
      source = candidate;
    }
    const fallback = prepareNoOptionalGrowthTickCandidateV9(source);
    const delta = assessManagementCapacityV9(fallback).costs.wireBytes! - assessManagementCapacityV9(source).costs.wireBytes!;
    source = pressure(source, -delta); const before = canonicalStringify(source);
    const after = advanceCapacityLimitedTicksV9(source, 1); expect(after.stopped).toBeNull(); expect(after.metrics.noOptionalCandidates).toBe(1);
    expect(after.world.sectExpansion.maintenance).toEqual(source.sectExpansion.maintenance);
    expect(after.world.inventory.wood.owned).toBe(source.inventory.wood.owned); expect(canonicalStringify(source)).toBe(before);
    expect(after.world.clock.simulationTick).toBe(source.clock.simulationTick + 1);
  });
});

let lastClock: WorldStateV9;
describe('real final .3 clock slot with complete historical owners', () => {
  it('settles every actual disciple at one real pending-death boundary before generating long idle clock history', () => {
    let world = fundedRuntimeFixture();
    for (const actor of world.disciples) {
      const profile = world.cultivation.disciples.find(profile => profile.discipleId === actor.id)!;
      actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
      actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    }
    world = prepareNormalTickCandidateV9(recordChecked(world)); expect(world.cultivation.pendingDeaths).toHaveLength(4);
    for (const death of [...world.cultivation.pendingDeaths]) {
      const id = `clock.finalize.${death.discipleId}`;
      world = fixtureApply(world, fixtureCommand(world, { kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', commandId: id,
        expectedRevision: world.cultivation.revision, discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } }, id));
    }
    expect(world.disciples).toEqual([]); expect(world.legacy.estates.every(estate => estate.settledMonth !== null)).toBe(true); lastClock = world;
  });
  // Run every revision-producing month through the real .3 bridge. Skipped
  // within-month intervals are idle, with no living/work/teaching obligations.
  for (let group = 0; group < 8; group++) it(`creates authenticated idle clock history checkpoint ${group + 1}`, () => {
    const target = Math.min(V9_CULTIVATION_CLOCK_LIMIT - 2, (group + 1) * 1024);
    for (let month = lastClock.cultivation.calendarMonth + 1; month <= target; month++) {
      const tick = month * CALENDAR_TICKS_PER_MONTH;
      lastClock = advanceV9CultivationClock({ ...lastClock, clock: { ...lastClock.clock, simulationTick: tick, calendarTick: tick } });
    }
    recordChecked(lastClock);
  });
  it('admits the genuine last row, then atomically stops the next required row while immediate commands remain callable', () => {
    expect(lastClock.cultivationClock.transitions).toHaveLength(V9_CULTIVATION_CLOCK_LIMIT - 1);
    const target = (lastClock.cultivation.calendarMonth + 1) * CALENDAR_TICKS_PER_MONTH;
    const source = recordChecked({ ...lastClock, clock: { ...lastClock.clock, simulationTick: target - 1, calendarTick: target - 1 } });
    const final = advanceCapacityLimitedTicksV9(source, 1); expect(final.stopped).toBeNull(); expect(final.world.cultivationClock.transitions).toHaveLength(V9_CULTIVATION_CLOCK_LIMIT);
    const later = recordChecked({ ...final.world, clock: { ...final.world.clock, simulationTick: target + CALENDAR_TICKS_PER_MONTH - 1, calendarTick: target + CALENDAR_TICKS_PER_MONTH - 1 } });
    const before = canonicalStringify(later); const stopped = advanceCapacityLimitedTicksV9(later, 1);
    expect(stopped.world).toBe(later); expect(stopped.stopped?.kind).toBe('capacity'); expect(canonicalStringify(later)).toBe(before);
    const input = fixtureCommand(later, { kind: 'inventory.discard', payload: { resourceId: 'grain', quantity: 1 } }, 'clock.discard');
    expect(dispatchCapacityLimitedCommandV9(later, input).result.status).toBe('accepted');
  });
});
