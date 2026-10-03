import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import * as catalog from '../../src/content/sect-v9/catalog';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import * as construction from '../../src/core/sect-expansion/construction-record-validation';
import { captureSectHistoricalIdentitiesV10 } from '../../src/core/sect-expansion/history-identity';
import * as maintenance from '../../src/core/sect-expansion/maintenance-v10';
import { tickValidatedSectMaintenancePaymentV10 } from '../../src/core/sect-expansion/maintenance-runtime-v10';
import { applyValidatedSectUpgradeCommandV10, cancelValidatedSectUpgradesForLifecycleV10, tickValidatedSectUpgradeV10 } from '../../src/core/sect-expansion/upgrade-runtime';
import * as upgrade from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, SectUpgradeFrameV10, SectUpgradeResultV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { prepareValidatedV10CultivationClock } from '../../src/core/world/v10-cultivation-preparation';
import { captureFrozenV10RecordData } from '../../src/core/world/v10-frozen-record-capture';
import * as lifecycle from '../../src/core/world/v10-lifecycle-records';
import type { V10LifecycleRecordEvidence } from '../../src/core/world/v10-lifecycle-records';
import * as projection from '../../src/core/world/v10-sect-frame';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureProduce, fixtureSectCommand, fixtureUntil, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Exact former World-root prefix, including the standalone World-upgrade
 * validator's repeated checks. This oracle never substitutes validator results. */
function formerPrefix(world: WorldStateV10, evidence: V10LifecycleRecordEvidence): ReturnType<typeof upgrade.inspectWorldSectUpgradePrefixV10> {
  const identities = captureSectHistoricalIdentitiesV10(evidence, world);
  const frame = projection.projectV10SectFrame(world);
  const checkedConstruction = construction.validateWorldConstructionRecords(frame.construction, identities);
  if (checkedConstruction.length) return { frame, identities, issues: checkedConstruction };
  const l1 = maintenance.validateSectMaintenanceL1RecordsV10(frame);
  if (l1.length) return { frame, identities, issues: l1 };
  const research = maintenance.validateSectUpgradeResearchPrerequisitesV10(frame, identities);
  if (research.length) return { frame, identities, issues: research };
  return { frame, identities, issues: upgrade.validateWorldSectUpgradeRecordsV10(world, frame, evidence) };
}
function formerRoot(world: WorldStateV10): string[] {
  const prefix = vi.spyOn(upgrade, 'inspectWorldSectUpgradePrefixV10').mockImplementation(formerPrefix);
  try { return inspectUnregisteredWorldV10Records(world); }
  finally { prefix.mockRestore(); }
}
function comparePrefix(world: WorldStateV10): ReturnType<typeof upgrade.inspectWorldSectUpgradePrefixV10> {
  const before = canonicalStringify(world); const evidence = lifecycle.inspectV10LifecycleRecords(world);
  const expected = formerPrefix(world, evidence); const actual = upgrade.inspectWorldSectUpgradePrefixV10(world, evidence);
  expect(actual.issues).toEqual(expected.issues); expect(actual.frame).toEqual(expected.frame);
  expect(canonicalStringify(world)).toBe(before); return actual;
}
let origin: WorldStateV10;
beforeAll(() => { origin = createUnregisteredWorldV10('v10-upgrade-prefix'); });
const fresh = (): WorldStateV10 => cloneJson(origin);

describe('one fixed World-owned prerequisite composition', () => {
  it('retains exact results and fresh projection data without mutating or freezing callers', () => {
    const world = fresh(); const first = comparePrefix(world); const second = comparePrefix(world);
    expect(first.issues).toEqual([]); expect(second.frame).not.toBe(first.frame);
    (first.issues as { code: string; path: string }[]).push({ code: 'forged', path: 'frame' });
    Object.defineProperty(first.frame.construction.people[0]!, 'canWork', { value: false });
    expect(comparePrefix(world).issues).toEqual([]);
    expect(Object.isFrozen(world)).toBe(false); expect(Object.isFrozen(world.sectExpansion)).toBe(false);
    expect(inspectUnregisteredWorldV10Records(world)).toEqual(formerRoot(world));
    expect(inspectUnregisteredWorldV10Records(captureFrozenV10RecordData(world))).toEqual([]);
    expect(Object.hasOwn(upgrade, 'validateUpgradeDomainRecords')).toBe(false);
    expect(Object.hasOwn(upgrade, 'validateUpgradeAfterWorldPrefix')).toBe(false);
  });
  it('runs construction and research once, keeps L1 final recheck and all source reauthentications', () => {
    const world = fresh(); const evidence = lifecycle.inspectV10LifecycleRecords(world);
    const build = vi.spyOn(construction, 'validateWorldConstructionRecords');
    const l1 = vi.spyOn(maintenance, 'validateSectMaintenanceL1RecordsV10');
    const research = vi.spyOn(maintenance, 'validateSectUpgradeResearchPrerequisitesV10');
    const deaths = vi.spyOn(lifecycle, 'historicalDeathsOfV10LifecycleEvidence');
    const project = vi.spyOn(projection, 'projectV10SectFrame');
    const actual = upgrade.inspectWorldSectUpgradePrefixV10(world, evidence);
    expect(actual.issues).toEqual([]);
    expect(build).toHaveBeenCalledTimes(1); expect(l1).toHaveBeenCalledTimes(1); expect(research).toHaveBeenCalledTimes(1);
    expect(deaths).toHaveBeenCalledTimes(3); expect(project).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[0]![0]).toBe(actual.frame.construction);
    expect(l1.mock.calls[0]![0]).toBe(actual.frame); expect(research.mock.calls[0]![0]).toBe(actual.frame);
    for (const call of deaths.mock.calls) { expect(call[0]).toBe(evidence); expect(call[1]).toBe(world); }
    const final = vi.spyOn(maintenance, 'validateSectMaintenanceRecordsV10');
    expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); expect(final).toHaveBeenCalledTimes(1);
    expect(maintenance.validateSectMaintenanceRecordsV10({ ...actual.frame, maintenance: { nextId: 0, payments: [] } }))
      .toEqual([{ code: 'INVALID_DOMAIN', path: 'maintenance' }]);
  });
  it('does not accept foreign/forged lifecycle evidence or a later changed World', () => {
    const world = fresh(); const evidence = lifecycle.inspectV10LifecycleRecords(world);
    for (const token of [{}, { ...evidence }, JSON.parse(JSON.stringify(evidence))] as V10LifecycleRecordEvidence[]) {
      expect(() => upgrade.inspectWorldSectUpgradePrefixV10(world, token)).toThrow('Unauthenticated');
      expect(() => formerPrefix(world, token)).toThrow('Unauthenticated');
    }
    expect(() => upgrade.inspectWorldSectUpgradePrefixV10(cloneJson(world), evidence)).toThrow('Unauthenticated');
    world.seed += '.changed';
    expect(() => upgrade.inspectWorldSectUpgradePrefixV10(world, evidence)).toThrow('Changed');
    expect(() => formerPrefix(world, evidence)).toThrow('Changed');
  });
  it('walks the same frame descriptor gate once while retaining exact root-field checks', () => {
    const world = fresh(); const evidence = lifecycle.inspectV10LifecycleRecords(world);
    for (const [inspect, expectedReads] of [[formerPrefix, 3], [upgrade.inspectWorldSectUpgradePrefixV10, 2]] as const) {
      // Forward real descriptor reads. On this exact projected root, schemaVersion
      // is read once per full-tree gate and once by the separate exact-field guard.
      const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptor');
      try {
        const result = inspect(world, evidence);
        const rootReads = descriptors.mock.calls.filter(([object, key]) => object === result.frame && key === 'schemaVersion').length;
        expect(result.issues).toEqual([]); expect(rootReads).toBe(expectedReads);
      } finally { descriptors.mockRestore(); }
    }
  });
  it('preserves the genuine projection equality check instead of trusting a successful prefix', () => {
    const world = fresh(); const evidence = lifecycle.inspectV10LifecycleRecords(world);
    const project = projection.projectV10SectFrame;
    for (const inspect of [formerPrefix, upgrade.inspectWorldSectUpgradePrefixV10]) {
      const spy = vi.spyOn(projection, 'projectV10SectFrame').mockImplementationOnce(source => {
        const frame = project(source); return { ...frame, upgrade: { ...frame.upgrade, nextId: 999 } };
      });
      try { expect(inspect(world, evidence).issues).toEqual([{ code: 'INVALID_UPGRADE_WORLD_PROJECTION', path: 'upgrade' }]); }
      finally { spy.mockRestore(); }
    }
  });
  it('preserves late lifecycle catch classification and private body exception classification', () => {
    const world = fresh(); const evidence = lifecycle.inspectV10LifecycleRecords(world);
    const historical = lifecycle.historicalDeathsOfV10LifecycleEvidence;
    for (const inspect of [formerPrefix, upgrade.inspectWorldSectUpgradePrefixV10]) {
      let calls = 0;
      const spy = vi.spyOn(lifecycle, 'historicalDeathsOfV10LifecycleEvidence').mockImplementation((token, source) => {
        if (++calls === 2) throw Object.create(null);
        return historical(token, source);
      });
      try { expect(inspect(world, evidence).issues).toEqual([{ code: 'UPGRADE_DEATH_AUTHORITY_REQUIRED', path: 'upgrade' }]); }
      finally { spy.mockRestore(); }
      const cost = vi.spyOn(catalog, 'getSectBuildingDefinition').mockImplementation(() => { throw Object.create(null); });
      try { expect(inspect(world, evidence).issues).toEqual([{ code: 'INVALID_UPGRADE_RECORDS', path: 'upgrade' }]); }
      finally { cost.mockRestore(); }
    }
  });
});

describe('exact diagnostic order, paths and independent descriptor contracts', () => {
  it('keeps construction then L1 then research ahead of upgrade failures', () => {
    const world = fresh();
    world.sectExpansion = { ...world.sectExpansion,
      construction: { ...world.sectExpansion.construction, nextId: 0 },
      maintenance: { ...world.sectExpansion.maintenance, nextId: 0 },
      research: { ...world.sectExpansion.research, nextId: 0 },
      upgrade: { ...world.sectExpansion.upgrade, nextId: 0 } };
    const stages = [
      [{ code: 'INVALID_IDENTITY', path: 'frame' }, 'INVALID_IDENTITY:frame'],
      [{ code: 'INVALID_DOMAIN', path: 'maintenance' }, 'INVALID_DOMAIN:maintenance'],
      [{ code: 'INVALID_DOMAIN', path: 'research' }, 'INVALID_DOMAIN:research'],
      [{ code: 'INVALID_UPGRADE_DOMAIN', path: 'upgrade' }, 'INVALID_UPGRADE_DOMAIN:upgrade'],
    ] as const;
    for (const [index, [issue, text]] of stages.entries()) {
      expect(comparePrefix(world).issues).toEqual([issue]);
      expect(inspectUnregisteredWorldV10Records(world)).toEqual([text]);
      expect(inspectUnregisteredWorldV10Records(world)).toEqual(formerRoot(world));
      if (index === 0) world.sectExpansion = { ...world.sectExpansion, construction: { ...world.sectExpansion.construction, nextId: 1 } };
      if (index === 1) world.sectExpansion = { ...world.sectExpansion, maintenance: { ...world.sectExpansion.maintenance, nextId: 1 } };
      if (index === 2) world.sectExpansion = { ...world.sectExpansion, research: { ...world.sectExpansion.research, nextId: 1 } };
    }
  });
  it('keeps standalone construction-prefixed paths and whole-frame-first error order', () => {
    const world = fresh(); world.sectExpansion = { ...world.sectExpansion,
      construction: { ...world.sectExpansion.construction, nextId: 0 } };
    const evidence = lifecycle.inspectV10LifecycleRecords(world); const frame = projection.projectV10SectFrame(world);
    expect(upgrade.validateSectUpgradeRecordsV10(frame)).toEqual([{ code: 'INVALID_IDENTITY', path: 'construction.frame' }]);
    expect(upgrade.validateWorldSectUpgradeRecordsV10(world, frame, evidence)).toEqual([{ code: 'INVALID_IDENTITY', path: 'construction.frame' }]);
    expect(comparePrefix(world).issues).toEqual([{ code: 'INVALID_IDENTITY', path: 'frame' }]);
    const badTree = { ...frame, upgrade: { ...frame.upgrade, revision: -1 } };
    expect(upgrade.validateSectUpgradeRecordsV10(badTree)).toEqual([{ code: 'INVALID_SHAPE', path: 'frame' }]);
    expect(upgrade.validateWorldSectUpgradeRecordsV10(world, badTree, evidence)).toEqual([{ code: 'INVALID_UPGRADE_WORLD_PROJECTION', path: 'upgrade' }]);
    const changedFrame = { ...frame, construction: { ...frame.construction, nextId: 1 } };
    expect(upgrade.validateWorldSectUpgradeRecordsV10(world, changedFrame, evidence)).toEqual([{ code: 'INVALID_UPGRADE_WORLD_PROJECTION', path: 'upgrade' }]);
  });
  it('retains the narrower construction depth gate even when the complete upgrade tree fits', () => {
    const world = fresh();
    // Invalid descriptor-pressure extension, not gameplay or an admitted save.
    const extra = JSON.parse(`${'['.repeat(17)}0${']'.repeat(17)}`) as unknown;
    (world.sectExpansion.construction as unknown as Record<string, unknown>).pressure = extra;
    expect(upgrade.isSectUpgradeDataTreeV10(projection.projectV10SectFrame(world))).toBe(true);
    expect(comparePrefix(world).issues).toEqual([{ code: 'INVALID_SHAPE', path: 'frame' }]);
  });
  it.each(['negative-number', 'long-string', 'too-many-fields', 'too-deep', 'alias'] as const)
  ('retains the separate complete upgrade descriptor rejection for %s', kind => {
    const world = fresh(); const domain = world.sectExpansion.upgrade as unknown as Record<string, unknown>;
    // Lifecycle evidence authenticates data identity only; these are deliberately
    // invalid record inputs, never full-root admissions or earned gameplay.
    if (kind === 'negative-number') domain.revision = -1;
    if (kind === 'long-string') domain.pressure = 'x'.repeat(257);
    if (kind === 'too-many-fields') for (let index = 0; index < 65; index++) domain[`extra${index}`] = 0;
    if (kind === 'too-deep') domain.pressure = JSON.parse(`${'['.repeat(29)}0${']'.repeat(29)}`) as unknown;
    if (kind === 'alias') { const child = {}; domain.first = child; domain.second = child; }
    expect(comparePrefix(world).issues).toEqual([{ code: 'INVALID_UPGRADE_WORLD_PROJECTION', path: 'upgrade' }]);
    expect(inspectUnregisteredWorldV10Records(world)).toEqual(formerRoot(world));
  });
  it('keeps all later maintenance, stock and legacy-reservation closure checks', () => {
    const stock = fresh(); stock.sectExpansion = { ...stock.sectExpansion, stock: { ...stock.sectExpansion.stock,
      'wound-powder': { ...stock.sectExpansion.stock['wound-powder'], owned: 1 } } };
    const reserved = fresh(); reserved.inventory.wood.reserved = 1;
    for (const [world, issues] of [[stock, ['V10 zero-genesis stock provenance differs']],
      [reserved, ['V10 shared reservation total differs']]] as const) {
      expect(comparePrefix(world).issues).toEqual([]);
      expect(inspectUnregisteredWorldV10Records(world)).toEqual(issues);
      expect(inspectUnregisteredWorldV10Records(world)).toEqual(formerRoot(world));
    }
  });
});

/** Component fixture built from real prior paid v9 work. Only base stock in the
 * existing funded fixture is explicitly enlarged. No sect material, work span,
 * payment or upgrade progress is synthesized; this is not migration evidence. */
function lift(source: WorldStateV9): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  return { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => ({ ...building, level: 1 as const })) },
      production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No old L2 source'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: upgrade.createSectUpgradeStateV10() } };
}
function accepted(result: SectUpgradeResultV10): SectUpgradeFrameV10 {
  if (!result.ok) throw new Error(result.code); return result.frame;
}
function step(world: WorldStateV10): WorldStateV10 {
  const prepared = prepareValidatedV10CultivationClock(world);
  const released = accepted(cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, prepared.evidence));
  const maintained = tickValidatedSectMaintenancePaymentV10(released, prepared.context);
  return projection.composeV10SectFrame(prepared.world, accepted(tickValidatedSectUpgradeV10(maintained, prepared.context,
    createWorkPathBudget(prepared.context.simulationTick))));
}
describe('actual paid upgrade, maintenance and death record comparisons', () => {
  let old: WorldStateV9; let ready: WorldStateV10; let started: WorldStateV10; let half: WorldStateV10; let complete: WorldStateV10;
  beforeAll(() => { old = medicineRuntimeFixture(); }, 30000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let count = 0; count < 4; count++) beforeAll(() => { old = fixtureProduce(old, recipe); }, 30000);
  }
  beforeAll(() => {
    old = fixtureApply(old, fixtureSectCommand(old, { domain: 'research', command: { kind: 'research.start', commandId: 'prefix.herbal',
      expectedRevision: old.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
    old = fixtureUntil(old, world => world.sectExpansion.research.jobs.at(-1)!.terminal !== null); ready = lift(old);
    const frame = projection.projectV10SectFrame(ready);
    started = projection.composeV10SectFrame(ready, accepted(applyValidatedSectUpgradeCommandV10(frame, projection.v10SectContext(ready),
      { kind: 'upgrade.start', commandId: 'prefix.start', expectedRevision: frame.upgrade.revision,
        buildingId: frame.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId, workerId: 'entity:4' })));
  }, 30000);
  beforeAll(() => {
    let current = started;
    for (let count = 0; count < 1200 && current.sectExpansion.upgrade.jobs[0]!.terminal === null; count++) {
      current = step(current);
      if (current.sectExpansion.upgrade.jobs[0]!.activeTicks === 200) half = current;
    }
    complete = current; expect(half.sectExpansion.upgrade.jobs[0]!.activeTicks).toBe(200);
    expect(complete.sectExpansion.upgrade.jobs[0]!.terminal?.kind).toBe('completed');
  }, 60000);
  it('matches exact issues on real start, half-checkpoint and completion, including corrupt prerequisites', () => {
    for (const world of [ready, started, half, complete]) expect(comparePrefix(world).issues).toEqual([]);
    const corrupt = cloneJson(half);
    corrupt.sectExpansion = { ...corrupt.sectExpansion, upgrade: { ...corrupt.sectExpansion.upgrade,
      jobs: corrupt.sectExpansion.upgrade.jobs.map(job => ({ ...job, checkpoints: job.checkpoints.map((checkpoint, index) =>
        index === 0 ? { ...checkpoint, tick: checkpoint.tick + 1 } : checkpoint) })) } };
    expect(comparePrefix(corrupt).issues.length).toBeGreaterThan(0);
    const both = cloneJson(corrupt); both.sectExpansion = { ...both.sectExpansion,
      research: { ...both.sectExpansion.research, nextId: 0 } };
    expect(comparePrefix(both).issues).toEqual([{ code: 'INVALID_DOMAIN', path: 'research' }]);
  });
  it('keeps final L2 historical-rate/payment checks beyond the prefix', () => {
    let current = complete;
    const paid = (world: WorldStateV10) => world.sectExpansion.maintenance.payments.some(payment => payment.rate?.level === 2);
    for (let count = 0; count < 1300 && !paid(current); count++) current = step(current);
    expect(paid(current)).toBe(true); const checked = comparePrefix(current); expect(checked.issues).toEqual([]);
    expect(maintenance.validateSectMaintenanceRecordsV10(checked.frame)).toEqual([]);
    const damaged = cloneJson(current); const payment = damaged.sectExpansion.maintenance.payments.find(value => value.rate?.level === 2)!;
    damaged.sectExpansion = { ...damaged.sectExpansion, maintenance: { ...damaged.sectExpansion.maintenance,
      payments: damaged.sectExpansion.maintenance.payments.map(value => value === payment ? { ...value, rate: { level: 2 as const, upgradeJobId: 'sect-upgrade:999' } } : value) } };
    const prefix = comparePrefix(damaged); expect(prefix.issues).toEqual([]);
    expect(maintenance.validateSectMaintenanceRecordsV10(prefix.frame)).toEqual([{ code: 'INVALID_MAINTENANCE_RATE', path: payment.paymentId }]);
  }, 120000);
  it('retains requested refunds and exact World-bound death cancellation at half payment', () => {
    const frame = projection.projectV10SectFrame(half); const jobId = frame.upgrade.jobs[0]!.jobId;
    const cancelled = projection.composeV10SectFrame(half, accepted(applyValidatedSectUpgradeCommandV10(frame, projection.v10SectContext(half),
      { kind: 'upgrade.cancel', commandId: 'prefix.cancel', expectedRevision: frame.upgrade.revision, jobId })));
    expect(comparePrefix(cancelled).issues).toEqual([]);
    // Explicit near-expiry initial boundary and an idle within-month jump, as in
    // the established death component harness; no simulated-lifetime claim.
    let near = cloneJson(half); const target = Math.ceil((near.clock.calendarTick + 1) / CALENDAR_TICKS_PER_MONTH) * CALENDAR_TICKS_PER_MONTH;
    near.clock = { ...near.clock, simulationTick: target - 1, calendarTick: target - 1 };
    const actor = near.disciples.find(value => value.id === 'entity:4')!;
    const profile = near.cultivation.disciples.find(value => value.discipleId === actor.id)!;
    actor.birthCalendarTick = target - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor((target - 1 - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    near = projection.composeV10SectFrame(near, tickValidatedSectMaintenancePaymentV10(projection.projectV10SectFrame(near), projection.v10SectContext(near)));
    const prepared = prepareValidatedV10CultivationClock(near);
    const death = projection.composeV10SectFrame(prepared.world, accepted(cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, prepared.evidence)));
    const inspection = comparePrefix(death); expect(inspection.issues).toEqual([]);
    expect(upgrade.validateSectUpgradeRecordsV10(inspection.frame, inspection.identities).length).toBeGreaterThan(0);
    const changed = cloneJson(death); const terminal = changed.sectExpansion.upgrade.jobs[0]!.terminal!;
    changed.sectExpansion = { ...changed.sectExpansion, upgrade: { ...changed.sectExpansion.upgrade,
      jobs: changed.sectExpansion.upgrade.jobs.map(job => ({ ...job, terminal: { ...terminal, tick: terminal.tick - 1, calendarTick: terminal.calendarTick - 1 } })) } };
    expect(comparePrefix(changed).issues.length).toBeGreaterThan(0);
  });
});
