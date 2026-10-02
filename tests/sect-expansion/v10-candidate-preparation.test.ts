import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V9_IDENTITY } from '../../src/content/sect-v9/world-content';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { isCommandV10, prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNoOptionalGrowthTickCandidateV10, prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { v10WorkOwners } from '../../src/core/world/v10-sect-frame';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, fundedRuntimeFixture, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Explicit record-test lift of genuine v9 histories with funded BASE inventory.
 * Not a migration/codec/runtime-admission fixture. Sect resources and work are real. */
function records(source: WorldStateV9 = fundedRuntimeFixture()): WorldStateV10 {
  recordChecked(source); const owned = cloneJson(source);
  const world: WorldStateV10 = { ...owned, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...owned.sectExpansion, schemaVersion: 2,
      construction: { ...owned.sectExpansion.construction, buildings: owned.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected immutable L1 construction');
        return { ...building, level: 1 as const };
      }) },
      production: { ...owned.sectExpansion.production, jobs: owned.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old source cannot contain L2 production');
        return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): Extract<CommandV10, { kind: 'sect.command' }> {
  return { kind: 'sect.command', commandId: payload.command.commandId, issuedTick: world.clock.simulationTick, sequence: 0, payload };
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const before = canonicalStringify(world); const result = prepareUnregisteredCommandCandidateV10(world, command);
  expect(canonicalStringify(world)).toBe(before);
  if (result.result.status !== 'accepted') throw new Error(JSON.stringify(result.result));
  expect(inspectUnregisteredWorldV10Records(result.world)).toEqual([]); return result.world;
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean, limit = 1600): WorldStateV10 {
  let next = world;
  for (let count = 0; count < limit && !done(next); count++) next = prepareNormalTickCandidateV10(next);
  if (!done(next)) throw new Error('Actual v10 candidate work did not finish');
  return next;
}
function upgrade(world: WorldStateV10, workerId = 'entity:2'): WorldStateV10 {
  return apply(world, sect(world, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: `candidate.upgrade.${world.sectExpansion.upgrade.nextId}`,
    expectedRevision: world.sectExpansion.upgrade.revision, workerId,
    buildingId: world.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } }));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}

// Expensive genuine setup is shared. Existing v9 fixtures prepare only the unchanged
// prior history; every herbal research/upgrade/alternative medicine/care tick below
// uses the new complete-record candidate APIs, without codec/publication claims.
let oldMedicine: WorldStateV9; let researchStart: WorldStateV10; let ready: WorldStateV10;
let upgradeStart: WorldStateV10; let half: WorldStateV10; let almost: WorldStateV10; let completed: WorldStateV10;
let powderStart: WorldStateV10; let delivered: WorldStateV10; let careStart: WorldStateV10; let healed: WorldStateV10;
beforeAll(() => { oldMedicine = medicineRuntimeFixture(); }, 60000);
for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
  for (let n = 0; n < 4; n++) beforeAll(() => { oldMedicine = fixtureProduce(oldMedicine, recipe); }, 60000);
}
beforeAll(() => {
  const source = records(oldMedicine);
  researchStart = apply(source, sect(source, { domain: 'research', command: { kind: 'research.start', commandId: 'candidate.herbal',
    expectedRevision: source.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
  ready = until(researchStart, world => world.sectExpansion.research.jobs.at(-1)!.terminal !== null);
}, 120000);
beforeAll(() => {
  upgradeStart = upgrade(ready);
  half = until(upgradeStart, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 200);
  almost = until(half, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 399);
  completed = prepareNormalTickCandidateV10(almost);
}, 120000);
beforeAll(() => {
  let source = completed;
  // Consume the older genuine physical dose so the later care must select the
  // alternative recipe's output instead of winning solely by stocked quantity.
  source = apply(source, sect(source, { domain: 'care', command: { kind: 'care.start', commandId: 'candidate.old-dose',
    expectedRevision: source.sectExpansion.care.revision, patientId: 'entity:4' } }));
  source = until(source, world => world.sectExpansion.care.jobs.at(-1)!.terminal !== null);
  source = apply(source, { kind: 'inventory.discard', commandId: 'candidate.no-grain', issuedTick: source.clock.simulationTick, sequence: 0,
    payload: { resourceId: 'grain', quantity: source.inventory.grain.owned - source.inventory.grain.reserved } });
  powderStart = apply(source, sect(source, { domain: 'production', command: { kind: 'production.start', commandId: 'candidate.alternative',
    expectedRevision: source.sectExpansion.production.revision, recipeId: 'craft.wound-powder-alt.v9', workerId: 'entity:2' } }));
  delivered = until(powderStart, world => world.sectExpansion.production.jobs.at(-1)!.terminal !== null);
  careStart = apply(delivered, sect(delivered, { domain: 'care', command: { kind: 'care.start', commandId: 'candidate.new-dose',
    expectedRevision: delivered.sectExpansion.care.revision, patientId: 'entity:4' } }));
  healed = until(careStart, world => world.sectExpansion.care.jobs.at(-1)!.terminal !== null);
}, 120000);

describe('internal complete-record v10 candidate preparation', () => {
  it('executes real research, upgrade checkpoints, zero-grain alternative delivery and the unchanged care effect', () => {
    expect(ready.sectExpansion.research.jobs.at(-1)).toMatchObject({ researchId: 'herbal-compatibility.v9', activeTicks: 400, terminal: { kind: 'completed' } });
    expect(half.sectExpansion.upgrade.jobs[0]!.checkpoints).toHaveLength(1);
    expect(completed.sectExpansion.upgrade.jobs[0]).toMatchObject({ activeTicks: 400, terminal: { kind: 'completed', resultLevel: 2 } });
    expect(completed.sectExpansion.construction.buildings).toEqual(ready.sectExpansion.construction.buildings);
    expect(completed.map.navVersion).toBe(ready.map.navVersion);
    expect(delivered.inventory.grain.owned).toBe(0);
    expect(delivered.sectExpansion.production.jobs.at(-1)).toMatchObject({ recipeId: 'craft.wound-powder-alt.v9', activeTicks: 200,
      productiveSite: { level: 2, upgradeJobId: completed.sectExpansion.upgrade.jobs[0]!.jobId }, terminal: { kind: 'completed' } });
    expect(careStart.sectExpansion.care.jobs.at(-1)!.doseProductionJobId).toBe(delivered.sectExpansion.production.jobs.at(-1)!.transactionId);
    expect(healed.cultivation.disciples.find(profile => profile.discipleId === 'entity:4')!.injury).toBe(0);
    expect(healed.sectExpansion.care.jobs.at(-1)).toMatchObject({ activeTicks: 40, terminal: { kind: 'completed' } });
    expect(healed.builds.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
    expect(inspectUnregisteredWorldV10Records(healed)).toEqual([]);
  });
  it.each(['research', 'upgrade', 'production', 'care'] as const)('is deterministic, source-immutable and JSON save-shape resumable during %s', kind => {
    const source = kind === 'research' ? researchStart : kind === 'upgrade' ? half : kind === 'production' ? powderStart : careStart;
    const frozen = freeze(cloneJson(source)); const before = canonicalStringify(frozen);
    const first = prepareNormalTickCandidateV10(frozen); const second = prepareNormalTickCandidateV10(frozen);
    expect(first).toEqual(second); expect(canonicalStringify(frozen)).toBe(before);
    const roundtrip: WorldStateV10 = JSON.parse(JSON.stringify(source));
    expect(prepareNormalTickCandidateV10(roundtrip)).toEqual(first);
    expect(Object.keys(first.sectExpansion).sort()).toEqual(['care', 'construction', 'maintenance', 'production', 'research', 'reservations', 'schemaVersion', 'stock', 'upgrade']);
    expect(first.sectExpansion.construction).not.toHaveProperty('map');
    expect(first.sectExpansion.construction).not.toHaveProperty('people');
  });
  it('keeps paused boundaries exact and permits a funded no-optional work tick without changing saved settings', () => {
    const paused = { ...half, clock: setPauseReason(half.clock, 'player', true) };
    expect(prepareNormalTickCandidateV10(paused)).toBe(paused);
    expect(prepareNoOptionalGrowthTickCandidateV10(paused)).toBe(paused);
    const candidate = prepareNoOptionalGrowthTickCandidateV10(half);
    expect(candidate.sectExpansion.upgrade.jobs[0]!.activeTicks).toBe(201);
    expect(candidate.sectEconomy).toEqual(half.sectEconomy);
    expect(candidate.sectExpansion.maintenance).toEqual(half.sectExpansion.maintenance);
    expect(half.sectExpansion.upgrade.jobs[0]!.activeTicks).toBe(200);
  });
  it('returns an exact upgrade retry before due/revision checks, rejects conflicts and uses one domain receipt owner', () => {
    const command = sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'candidate.upgrade.1', expectedRevision: 0,
      workerId: 'entity:2', buildingId: ready.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } });
    const result = prepareUnregisteredCommandCandidateV10(half, { ...command, issuedTick: half.clock.simulationTick + 999 });
    expect(result.world).toBe(half); expect(result.result).toMatchObject({ status: 'accepted', sectResult: { domain: 'upgrade', repeated: true } });
    expect(half.commandReceipts[command.commandId]).toBeUndefined();
    const conflict = prepareUnregisteredCommandCandidateV10(half, { ...command, payload: { ...command.payload, command: {
      ...command.payload.command, workerId: 'entity:3' } } });
    expect(conflict.world).toBe(half); expect(conflict.result.rejection?.code).toBe('COMMAND_CONFLICT');
    const parsed: WorldStateV10 = JSON.parse(JSON.stringify(half));
    expect(prepareUnregisteredCommandCandidateV10(parsed, command).world).toBe(parsed);
  });
  it('rejects upgrade extra fields, system namespaces, mismatched IDs and persisted queues atomically', () => {
    const valid = sect(half, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'candidate.cancel',
      expectedRevision: half.sectExpansion.upgrade.revision, jobId: half.sectExpansion.upgrade.jobs[0]!.jobId } });
    expect(isCommandV10(valid)).toBe(true);
    for (const invalid of [
      { ...valid, payload: { ...valid.payload, command: { ...valid.payload.command, deathId: 'invented' } } },
      { ...valid, commandId: 'different' },
      { ...valid, commandId: 'system/v10/death/fake/job', payload: { ...valid.payload, command: { ...valid.payload.command, commandId: 'system/v10/death/fake/job' } } },
    ]) { expect(isCommandV10(invalid)).toBe(false); expect(prepareUnregisteredCommandCandidateV10(half, invalid).world).toBe(half); }
    const queued = cloneJson(half); queued.pendingCommands.push({ kind: 'production.start', commandId: 'queued', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:3' } });
    expect(() => prepareNormalTickCandidateV10(queued)).toThrow();
    expect(prepareUnregisteredCommandCandidateV10(queued, valid).result.rejection?.code).toBe('INVALID_WORLD_RECORDS');
  });
  it('cancels real paid upgrade work and forbids concurrent cultivation/legacy work ownership', () => {
    const before = canonicalStringify(half);
    const busy = prepareUnregisteredCommandCandidateV10(half, { kind: 'cultivation.command', commandId: 'candidate.busy',
      sequence: 0, issuedTick: half.clock.simulationTick, payload: { command: { kind: 'training.set', commandId: 'candidate.busy',
        expectedRevision: half.cultivation.revision, discipleId: 'entity:2', mode: 'training' } } });
    expect(busy.result.status).toBe('rejected');
    const command = sect(half, { domain: 'upgrade', command: { kind: 'upgrade.cancel', commandId: 'candidate.cancel',
      expectedRevision: half.sectExpansion.upgrade.revision, jobId: half.sectExpansion.upgrade.jobs[0]!.jobId } });
    const cancelled = apply(half, command);
    expect(cancelled.sectExpansion.upgrade.jobs[0]!.terminal?.released.map(line => line.quantity)).toEqual([3, 3]);
    expect(cancelled.inventory.stone.reserved).toBe(0); expect(cancelled.inventory.plank.reserved).toBe(0);
    expect(v10WorkOwners(cancelled)).toEqual([]); expect(canonicalStringify(half)).toBe(before);
  });
});

describe('unchanged supported command families and actual lifecycle boundaries', () => {
  it('preserves real legacy production, discard, economy, build and cultivation command results', () => {
    let world = records();
    const start: CommandV10 = { kind: 'production.start', commandId: 'family.production', issuedTick: 0, sequence: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:2' } };
    world = apply(world, start); world = prepareNormalTickCandidateV10(world);
    world = apply(world, { kind: 'production.cancel', commandId: 'family.cancel', issuedTick: world.clock.simulationTick, sequence: 1,
      payload: { transactionId: world.activeProductionTransactionIds[0]! } });
    world = apply(world, { kind: 'inventory.discard', commandId: 'family.discard', issuedTick: world.clock.simulationTick, sequence: 2,
      payload: { resourceId: 'wood', quantity: 1 } });
    world = apply(world, { kind: 'sect-economy.command', commandId: 'family.economy', issuedTick: world.clock.simulationTick, sequence: 3,
      payload: { command: { kind: 'enabled.set', enabled: true } } });
    const loadout = cloneJson(world.builds.disciples.find(member => member.discipleId === 'entity:2')!.loadout);
    loadout.activeSkillIds = [loadout.activeSkillIds[1], loadout.activeSkillIds[0]];
    world = apply(world, { kind: 'build.command', commandId: 'family.build', issuedTick: world.clock.simulationTick, sequence: 4,
      payload: { command: { kind: 'loadout.set', commandId: 'family.build', expectedRevision: world.builds.revision, discipleId: 'entity:2', loadout } } });
    world = apply(world, { kind: 'cultivation.command', commandId: 'family.cultivation', issuedTick: world.clock.simulationTick, sequence: 5,
      payload: { command: { kind: 'training.set', commandId: 'family.cultivation', expectedRevision: world.cultivation.revision, discipleId: 'entity:4', mode: 'rest' } } });
    expect(world.builds.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
    expect(prepareUnregisteredCommandCandidateV10(world, start).world).toBe(world);
    expect(Object.keys(world.commandReceipts)).toHaveLength(6);
  });
  it('routes real construction movement and cancellation through the narrow L1 leaf', () => {
    let world = records();
    world = apply(world, sect(world, { domain: 'construction', command: { kind: 'blueprint.place', commandId: 'candidate.place',
      expectedRevision: world.sectExpansion.construction.revision, placement: { definitionId: 'library.v9', anchor: { x: 1, y: 1 }, rotation: 0 } } }));
    const blueprintId = world.sectExpansion.construction.blueprints[0]!.blueprintId;
    world = apply(world, sect(world, { domain: 'construction', command: { kind: 'construction.start', commandId: 'candidate.build',
      expectedRevision: world.sectExpansion.construction.revision, blueprintId, workerId: 'entity:2' } }));
    const started = world;
    for (let n = 0; n < 8; n++) world = prepareNormalTickCandidateV10(world);
    expect(world.clock.simulationTick).toBe(8); expect(started.clock.simulationTick).toBe(0);
    world = apply(world, sect(world, { domain: 'construction', command: { kind: 'construction.cancel', commandId: 'candidate.build.cancel',
      expectedRevision: world.sectExpansion.construction.revision, blueprintId } }));
    expect(world.sectExpansion.construction.jobs[0]!.terminal?.kind).toBe('cancelled');
  });
  it('omits only automatic starts from a separately prepared unchanged boundary', () => {
    let source = records();
    source = apply(source, { kind: 'sect-economy.command', commandId: 'optional.plan', issuedTick: 0, sequence: 0,
      payload: { command: { kind: 'plan.set', plan: { workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 99 }] } } } });
    source = apply(source, { kind: 'sect-economy.command', commandId: 'optional.enable', issuedTick: 0, sequence: 1,
      payload: { command: { kind: 'enabled.set', enabled: true } } });
    const before = canonicalStringify(source); const normal = prepareNormalTickCandidateV10(source); const recovery = prepareNoOptionalGrowthTickCandidateV10(source);
    expect(normal.activeProductionTransactionIds).toHaveLength(1); expect(recovery.activeProductionTransactionIds).toEqual([]);
    expect(recovery.sectEconomy).toEqual(source.sectEconomy); expect(recovery.automaticProduction).toEqual(source.automaticProduction);
    expect(canonicalStringify(source)).toBe(before);
  });
  it('performs a natural month boundary and lets pending death pause the already-advanced tick before work', () => {
    const old = fundedRuntimeFixture(); const month = CALENDAR_TICKS_PER_MONTH;
    // Explicit near-expiry initial condition, without fabricating lifespan simulation.
    old.clock.simulationTick = month - 1; old.clock.calendarTick = month - 1;
    const actor = old.disciples.find(member => member.id === 'entity:4')!;
    const profile = old.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    actor.birthCalendarTick = month - profile.lifespanMonths * month; actor.ageMonths = profile.lifespanMonths - 1; profile.ageMonths = actor.ageMonths;
    const source = records(old); const before = canonicalStringify(source); const pending = prepareNormalTickCandidateV10(source);
    expect(pending.clock.simulationTick).toBe(month); expect(pending.clock.pauseReasons).toContain('cultivation');
    expect(pending.cultivationClock.transitions.at(-1)).toMatchObject({ kind: 'month', tick: month });
    expect(pending.sectExpansion.construction.revision).toBe(source.sectExpansion.construction.revision);
    expect(prepareNormalTickCandidateV10(pending)).toBe(pending); expect(canonicalStringify(source)).toBe(before);
    const death = pending.cultivation.pendingDeaths[0]!;
    const settled = apply(pending, { kind: 'cultivation.command', commandId: 'candidate.finalize', issuedTick: month, sequence: 0,
      payload: { command: { kind: 'death.finalize', commandId: 'candidate.finalize', expectedRevision: pending.cultivation.revision,
        discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    expect(settled.legacy.archivedIdentities.some(identity => identity.discipleId === death.discipleId)).toBe(true);
    expect(settled.builds.retiredDisciples.some(member => member.discipleId === death.discipleId)).toBe(true);
    expect(settled.cultivation.archivedDisciples.some(member => member.discipleId === death.discipleId)).toBe(true);
    expect(settled.disciples.some(member => member.id === death.discipleId)).toBe(false);
    expect(inspectUnregisteredWorldV10Records(settled)).toEqual([]);
  });
  it('reconciles upgrade death before its would-be final work tick, then archives with original history intact', () => {
    const source = cloneJson(almost); const month = CALENDAR_TICKS_PER_MONTH;
    const target = Math.ceil((source.clock.calendarTick + 1) / month) * month;
    source.clock.simulationTick = target - 1; source.clock.calendarTick = target - 1;
    const actor = source.disciples.find(member => member.id === 'entity:2')!;
    const profile = source.cultivation.disciples.find(member => member.discipleId === actor.id)!;
    actor.birthCalendarTick = target - profile.lifespanMonths * month; actor.ageMonths = profile.lifespanMonths - 1; profile.ageMonths = actor.ageMonths;
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    const pending = prepareNormalTickCandidateV10(source); const job = pending.sectExpansion.upgrade.jobs[0]!;
    const death = pending.cultivation.pendingDeaths.find(value => value.discipleId === actor.id)!;
    expect(job).toMatchObject({ activeTicks: 399, terminal: { kind: 'cancelled', cancellation: { kind: 'death', deathId: death.deathId } } });
    expect(pending.sectExpansion.upgrade.receipts.at(-1)!.command.commandId).toBe(`system/v10/death/${death.deathId}/${job.jobId}`);
    expect(pending.clock.pauseReasons).toContain('cultivation'); expect(v10WorkOwners(pending)).toEqual([]);
    const settled = apply(pending, { kind: 'cultivation.command', commandId: 'candidate.upgrade-death', issuedTick: target, sequence: 0,
      payload: { command: { kind: 'death.finalize', commandId: 'candidate.upgrade-death', expectedRevision: pending.cultivation.revision,
        discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    expect(settled.sectExpansion.upgrade).toEqual(pending.sectExpansion.upgrade);
    expect(settled.sectExpansion.production).toEqual(pending.sectExpansion.production);
    expect(inspectUnregisteredWorldV10Records(JSON.parse(JSON.stringify(settled)))).toEqual([]);
  });
});
