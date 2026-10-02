import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { CALENDAR_TICKS_PER_MONTH as MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { measureWorldSaveBytes } from '../../src/core/save-budget/envelope';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV10 as assess } from '../../src/core/world/management-capacity-v10';
import { advanceCapacityLimitedTicksV10 } from '../../src/core/world/runtime-capacity-v10';
import { carryScalarCapacityV10, createOwnedIdleLeafV10, type CarriedIdleCapacityV10 } from '../../src/core/world/runtime-owned-internals-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Explicit old-record lift, never migration/import authority. Earned construction,
 * production and research histories remain actual paid fixtures. */
function records(source: WorldStateV9 = createUnregisteredWorldV9('v10-owned-idle')): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No old L2 fixture'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function apply(world: WorldStateV10, input: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, input);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): WorldStateV10 {
  return apply(world, { kind: 'sect.command', commandId: payload.command.commandId, issuedTick: world.clock.simulationTick, sequence: 0, payload });
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean, limit = 1600): WorldStateV10 {
  let next = world;
  for (let n = 0; n < limit && !done(next); n++) next = prepareNormalTickCandidateV10(next);
  if (!done(next)) throw new Error('Real v10 fixture did not finish'); return next;
}
/** Explicit record-valid idle phase fixture, not a claim of playing these ticks. */
function atTick(source: WorldStateV10, tick: number): WorldStateV10 {
  const world = cloneJson(source); world.clock = { ...world.clock, simulationTick: tick, calendarTick: tick };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function birthday(tick: number, death = false): WorldStateV10 {
  const old = createUnregisteredWorldV9('v10-owned-birthday'); const actor = old.disciples[0]!;
  const profile = old.cultivation.disciples.find(member => member.discipleId === actor.id)!;
  actor.birthCalendarTick = tick - (death ? profile.lifespanMonths : profile.ageMonths) * MONTH;
  actor.ageMonths = Math.floor(-actor.birthCalendarTick / MONTH); profile.ageMonths = actor.ageMonths;
  return records(old);
}
function exactNext(source: WorldStateV10) {
  const before = canonicalStringify(source); const leaf = createOwnedIdleLeafV10(); const captured = leaf.capture(source);
  expect(captured).not.toBeNull(); const result = leaf.advance(); expect(result).not.toBeNull();
  const raw = prepareNormalTickCandidateV10(source); const strict = advanceCapacityLimitedTicksV10(source, 1);
  expect(strict.stopped).toBeNull(); expect(result!.world).toEqual(raw); expect(result!.world).toEqual(strict.world);
  const actual = assess(raw); expect(actual.fits).toBe(true); expect(result!.capacity.current).toEqual(actual.current);
  expect(result!.capacity.limits).toEqual(actual.limits);
  for (const key of Object.keys(actual.reserved)) expect(result!.capacity.reserved[key]!, key).toBeGreaterThanOrEqual(actual.reserved[key]!);
  expect(canonicalStringify(source)).toBe(before); return { captured: captured!, result: result!, leaf };
}

describe('internal owned fixed-v10 scalar leaf', () => {
  it('matches both raw preparation and the unchanged strict oracle, without freezing caller data', () => {
    const source = records(); const { captured, result, leaf } = exactNext(source);
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(source.clock)).toBe(false);
    expect(captured.world).not.toBe(source); expect(captured.world.history).not.toBe(source.history);
    expect(Object.isFrozen(captured.assessment.current)).toBe(true); expect(Object.isFrozen(result.world.clock)).toBe(true);
    expect(Object.isFrozen(result.capacity.reserved)).toBe(true);
    expect(result.world.cultivation).toBe(captured.world.cultivation);
    expect(result.world.sectExpansion.care).toBe(captured.world.sectExpansion.care);
    expect(result.world.sectExpansion.upgrade).toBe(captured.world.sectExpansion.upgrade);
    source.inventory.wood.owned++;
    expect(leaf.advance()!.world.inventory.wood.owned).toBe(captured.world.inventory.wood.owned);
    expect(result.capacity).not.toHaveProperty('fits'); expect(result.capacity).not.toHaveProperty('terminalDischargeProved');
  });
  it.each([10, 100, 1000])('charges exactly five stored decimal widths at %i, without charging derived birthday fields', end => {
    const base = atTick(records(), end - 1);
    const source: WorldStateV10 = { ...base, sectExpansion: { ...base.sectExpansion,
      construction: { ...base.sectExpansion.construction, revision: end - 1 },
      production: { ...base.sectExpansion.production, revision: end - 1 },
      research: { ...base.sectExpansion.research, revision: end - 1 } } };
    const { result, captured } = exactNext(source);
    expect(result.capacity.current.wireBytes! - captured.capacity.current.wireBytes!).toBe(5);
    expect(measureWorldSaveBytes(result.world, { saveVersion: 10 }) - measureWorldSaveBytes(source, { saveVersion: 10 })).toBe(5);
    expect(result.world.sectExpansion.care.revision).toBe(source.sectExpansion.care.revision);
    expect(result.world.sectExpansion.upgrade.revision).toBe(source.sectExpansion.upgrade.revision);
  });
  it('does not accept a candidate through an extra argument, a borrowed method or another owner', () => {
    const a = createOwnedIdleLeafV10(); const b = createOwnedIdleLeafV10(); const source = records();
    const first = a.capture(source)!; const forged = freeze({ ...first.world, seed: 'foreign-candidate' });
    expect(b.advance()).toBeNull();
    const next = Reflect.apply(a.advance, { root: forged }, [forged, first.assessment, true]);
    expect(next.world.seed).toBe(source.seed);
    const recaptured = b.capture(next.world)!;
    expect(recaptured.world).toEqual(next.world); expect(recaptured.world).not.toBe(next.world);
    expect(recaptured.assessment).toEqual(assess(next.world));
    a.clear(); expect(a.advance()).toBeNull(); expect(b.advance()!.world.clock.simulationTick).toBe(2);
  });
  it('rejects frozen foreign corruption, getters and unknown clock shape without changing the supplied data', () => {
    const source = records(); const malformed = freeze({ ...source, runtimeProtocol: 'foreign' });
    const leaf = createOwnedIdleLeafV10(); expect(leaf.capture(source)).not.toBeNull();
    expect(leaf.capture(malformed)).toBeNull(); expect(leaf.advance()).toBeNull();
    let reads = 0; const getter = Object.defineProperty(cloneJson(source), 'seed', { enumerable: true, get() { reads++; throw null; } });
    expect(leaf.capture(getter)).toBeNull(); expect(reads).toBe(0);
    const extension = { ...source, clock: { ...source.clock, extra: 1 } }; const before = canonicalStringify(extension);
    expect(leaf.capture(extension)).toBeNull(); expect(canonicalStringify(extension)).toBe(before);
    expect(leaf.capture({ ...source, contentIdentity: { ...source.contentIdentity, registryId: 'foreign' } })).toBeNull();
  });
  it('guards capture reflection reentrancy before any nested work or clearing', () => {
    const leaf = createOwnedIdleLeafV10(); let probes = 0;
    const hostile = new Proxy({}, { ownKeys() { probes++; throw null; } });
    const source = records(); const proxy = new Proxy(source, { ownKeys(target) {
      expect(leaf.capture(hostile)).toBeNull(); expect(leaf.advance()).toBeNull(); leaf.clear(); return Reflect.ownKeys(target);
    } });
    expect(leaf.capture(proxy)).not.toBeNull(); expect(probes).toBe(0); expect(leaf.advance()).not.toBeNull();
  });
  it.each(['month', 'birthday'] as const)('stops the narrow slice immediately before the %s transition', boundary => {
    const source = boundary === 'month' ? atTick(records(), MONTH - 2) : birthday(2);
    const { leaf, result } = exactNext(source); expect(leaf.advance()).toBeNull();
    const raw = prepareNormalTickCandidateV10(result.world); expect(raw.cultivationClock.transitions.at(-1)?.kind).toBe(boundary === 'month' ? 'month' : 'age-sync');
    expect(leaf.advance()).toBeNull(); expect(result.world.clock.calendarTick).toBe(source.clock.calendarTick + 1);
  });
  it('uses the exact planner decision boundary, allowing disabled/review-blocked/later decisions', () => {
    const source = records();
    expect(createOwnedIdleLeafV10().capture({ ...source, sectEconomy: { ...source.sectEconomy, enabled: true, nextDecisionTick: 1 } })).toBeNull();
    exactNext({ ...source, sectEconomy: { ...source.sectEconomy, enabled: true, nextDecisionTick: 2 } });
    exactNext({ ...source, sectEconomy: { ...source.sectEconomy, enabled: false, nextDecisionTick: 0 } });
    // The full source grammar requires unreviewed plans to remain disabled.
    exactNext({ ...source, sectEconomy: { ...source.sectEconomy, enabled: false, nextDecisionTick: 0 },
      automaticProduction: { ...source.automaticProduction, activationReviewRequired: true } });
    expect(createOwnedIdleLeafV10().capture({ ...source, sectEconomy: { ...source.sectEconomy, enabled: true, nextDecisionTick: 0 },
      automaticProduction: { ...source.automaticProduction, activationReviewRequired: true } })).toBeNull();
  });
  it('refuses paused, queued, planned and live legacy-work sources', () => {
    const source = records(); const leaf = createOwnedIdleLeafV10();
    expect(leaf.capture({ ...source, clock: { ...source.clock, pauseReasons: ['player'] } })).toBeNull();
    const input: CommandV10 = { kind: 'production.start', commandId: 'idle.legacy', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } };
    expect(leaf.capture({ ...source, pendingCommands: [input] })).toBeNull();
    const active = apply(source, input); expect(leaf.capture(active)).toBeNull();
    const planned = sect(source, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'idle.plan', expectedRevision: 0,
      placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } });
    expect(assess(planned).fits).toBe(true); expect(leaf.capture(planned)).toBeNull();
  });
  it('advances actual archived elapsed dimensions without changing any archived record', () => {
    let world = prepareNormalTickCandidateV10(birthday(1, true)); const pending = world.cultivation.pendingDeaths[0]!;
    world = apply(world, { kind: 'cultivation.command', commandId: 'idle.finalize', sequence: 0, issuedTick: world.clock.simulationTick,
      payload: { command: { kind: 'death.finalize', commandId: 'idle.finalize', expectedRevision: world.cultivation.revision,
        discipleId: pending.discipleId, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    const { captured, result } = exactNext(world);
    const dimension = `birthday.${pending.discipleId}.archivedElapsedTicks`;
    expect(result.capacity.current[dimension]).toBe(captured.capacity.current[dimension]! + 1);
    expect(result.world.legacy.archivedIdentities).toBe(captured.world.legacy.archivedIdentities);
  });
  it('falls back at a conservative wire ceiling without inventing a stop or releasing carried reserve', () => {
    let source = atTick(records(), 9);
    source = { ...source, sectExpansion: { ...source.sectExpansion,
      construction: { ...source.sectExpansion.construction, revision: 9 }, production: { ...source.sectExpansion.production, revision: 9 },
      research: { ...source.sectExpansion.research, revision: 9 } } };
    source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 9, message: '' });
    source.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - assess(source).costs.wireBytes!);
    const before = canonicalStringify(source); const leaf = createOwnedIdleLeafV10(); const captured = leaf.capture(source)!;
    expect(captured.assessment.fits).toBe(true); expect(leaf.advance()).toBeNull(); expect(leaf.advance()).toBeNull();
    expect(canonicalStringify(source)).toBe(before); expect(captured.world.clock.simulationTick).toBe(9);
    const strict = advanceCapacityLimitedTicksV10(source, 1); expect(strict.stopped).toBeNull(); expect(strict.world.clock.simulationTick).toBe(10);
    source.diagnostics[0]!.message += 'x'; expect(assess(source)).toMatchObject({ supported: true, actualFits: true, fits: false });
    expect(leaf.capture(source)).toBeNull(); expect(leaf.advance()).toBeNull();
  }, 60000);
});

describe('carried arithmetic has no source or publication authority', () => {
  function capacity(): CarriedIdleCapacityV10 { return createOwnedIdleLeafV10().capture(records())!.capacity; }
  it('checks archived MAX independently from the stored calendar clock and does not double-charge decimal growth', () => {
    const source = capacity(); const name = 'birthday.synthetic.archivedElapsedTicks';
    const edge: CarriedIdleCapacityV10 = { ...source, current: { ...source.current, [name]: Number.MAX_SAFE_INTEGER },
      reserved: { ...source.reserved, [name]: 0 }, limits: { ...source.limits, [name]: Number.MAX_SAFE_INTEGER } };
    expect(carryScalarCapacityV10(edge)).toBeNull();
    const crossed = carryScalarCapacityV10({ ...edge, current: { ...edge.current, [name]: 9 } })!;
    expect(crossed.current[name]).toBe(10); expect(crossed.current.wireBytes).toBe(source.current.wireBytes);
    expect(edge.current[name]).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('rejects missing dimensions, extra reserve/limit keys, deficits and unsafe operands in every map', () => {
    const source = capacity();
    for (const map of ['current', 'reserved', 'limits'] as const) for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(carryScalarCapacityV10({ ...source, [map]: { ...source[map], buildRevision: value } })).toBeNull();
    }
    const missing = { ...source.current }; delete missing.calendarTick;
    expect(carryScalarCapacityV10({ ...source, current: missing })).toBeNull();
    expect(carryScalarCapacityV10({ ...source, reserved: { ...source.reserved, extra: 0 } })).toBeNull();
    expect(carryScalarCapacityV10({ ...source, limits: { ...source.limits, extra: 0 } })).toBeNull();
    expect(carryScalarCapacityV10({ ...source, reserved: { ...source.reserved, wireBytes: source.limits.wireBytes! } })).toBeNull();
    expect(carryScalarCapacityV10({ ...source, current: { ...source.current, wireBytes: Number.MAX_SAFE_INTEGER } })).toBeNull();
  });
});

let oldMedicine: WorldStateV9; let ready: WorldStateV10; let started: WorldStateV10; let traveling: WorldStateV10;
let working: WorldStateV10; let completed: WorldStateV10; let l2Paid: WorldStateV10;
describe('actual L2 maintenance and every live upgrade phase', () => {
  beforeAll(() => { oldMedicine = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let n = 0; n < 4; n++) beforeAll(() => { oldMedicine = fixtureProduce(oldMedicine, recipe); }, 60000);
  }
  beforeAll(() => {
    let world = records(oldMedicine);
    world = sect(world, { domain: 'research', command: { kind: 'research.start', commandId: 'idle.herbal',
      expectedRevision: world.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } });
    ready = until(world, value => value.sectExpansion.research.jobs.at(-1)!.terminal !== null);
    started = sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'idle.upgrade', expectedRevision: 0,
      buildingId: ready.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId, workerId: 'entity:2' } });
    traveling = until(started, value => value.sectExpansion.upgrade.jobs[0]!.phase === 'to-site');
    working = until(traveling, value => value.sectExpansion.upgrade.jobs[0]!.phase === 'working');
    completed = until(working, value => value.sectExpansion.upgrade.jobs[0]!.terminal !== null);
  }, 180000);
  it('rejects real live upgrade phases, including zero-work travel and blocked variants', () => {
    for (const source of [started, traveling, working]) {
      const before = canonicalStringify(source); expect(assess(source).supported).toBe(true);
      expect(createOwnedIdleLeafV10().capture(source)).toBeNull(); expect(canonicalStringify(source)).toBe(before);
      for (const blocked of ['PATH_BLOCKED', 'PATH_BUDGET', 'MAINTENANCE_UNPAID'] as const) {
        const variant: WorldStateV10 = { ...source, sectExpansion: { ...source.sectExpansion, upgrade: { ...source.sectExpansion.upgrade,
          jobs: source.sectExpansion.upgrade.jobs.map(job => ({ ...job, blocked })) } } };
        expect(createOwnedIdleLeafV10().capture(variant)).toBeNull();
      }
    }
  });
  it('uses a real completed L2 source while leaving upgrade/care revisions unchanged', () => {
    expect(completed.sectExpansion.upgrade.jobs[0]!.terminal?.kind).toBe('completed');
    expect(completed.sectExpansion.construction.buildings.every(building => building.level === 1)).toBe(true);
    exactNext(completed);
  });
  it('uses the latest actual L2 payment expiry and falls back at its precise boundary', () => {
    l2Paid = until(completed, value => value.sectExpansion.maintenance.payments.some(payment => payment.rate?.level === 2));
    const payment = l2Paid.sectExpansion.maintenance.payments.findLast(value => value.rate?.level === 2)!;
    const origin = l2Paid.sectExpansion.construction.buildings.find(value => value.buildingId === payment.buildingId)!;
    expect(payment.dueCalendarTick).toBeGreaterThan(origin.firstMaintenanceCalendarTick);
    const { result } = exactNext(l2Paid); expect(result.world.sectExpansion.maintenance).toEqual(l2Paid.sectExpansion.maintenance);
    const edge = until(l2Paid, value => value.clock.calendarTick === payment.dueCalendarTick - 2);
    const checked = exactNext(edge); expect(checked.leaf.advance()).toBeNull();
    const renewed = prepareNormalTickCandidateV10(checked.result.world);
    expect(renewed.sectExpansion.maintenance.payments.at(-1)).toMatchObject({ buildingId: payment.buildingId,
      paidCalendarTick: payment.dueCalendarTick, rate: { level: 2 } });
    expect(checked.result.world.sectExpansion.maintenance.payments).toEqual(edge.sectExpansion.maintenance.payments);
  }, 180000);
});
