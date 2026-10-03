import { beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { MANAGEMENT_V9_IDENTITY } from '../../src/content/sect-v9/world-content';
import { SECT_RESOURCE_IDS } from '../../src/content/sect-v9/types';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { RESOURCE_IDS } from '../../src/core/economy/types';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import * as oldMaintenance from '../../src/core/sect-expansion/maintenance-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { lookupCommandReceipt } from '../../src/core/world/history-access';
import { createPrivateRuntimeV10 } from '../../src/core/world/runtime-instance-v10';
import { RUNTIME_VIEW_LIMITS_V10, type RuntimeFrameViewV10, type RuntimeReadonlyV10 } from '../../src/core/world/runtime-view-types-v10';
import * as views from '../../src/core/world/runtime-views-v10';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureProduce, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

/** Record-only fixture lift, not an exercised migration. All sect resources and
 * L1 history are earned by real old reducers; base inventory funding is explicit
 * in the existing fixture. Every new research/upgrade/production tick is v10. */
function records(source: WorldStateV9): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected old immutable L1'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old fixture cannot contain alternative medicine');
        return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): Extract<CommandV10, { kind: 'sect.command' }> {
  return { kind: 'sect.command', commandId: payload.command.commandId, issuedTick: world.clock.simulationTick, sequence: 0, payload };
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, command);
  if (result.result.status !== 'accepted') throw new Error(JSON.stringify(result.result)); return result.world;
}
function until(world: WorldStateV10, done: (world: WorldStateV10) => boolean, maximum = 1600): WorldStateV10 {
  let next = world;
  for (let index = 0; index < maximum && !done(next); index++) next = prepareNormalTickCandidateV10(next);
  if (!done(next)) throw new Error('Actual v10 view fixture did not finish');
  expect(inspectUnregisteredWorldV10Records(next)).toEqual([]); return next;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function dataKeys(value: unknown): string[] {
  return !value || typeof value !== 'object' ? [] : Object.entries(value).flatMap(([key, child]) => [key, ...dataKeys(child)]);
}
/** The only permitted `ledger` fields are primitive discriminators on exact
 * resource lines at these fixed DTO paths. A ledger object, extra row evidence
 * or a tag smuggled elsewhere still fails with its complete path. */
function invalidLedgerPaths(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return Object.entries(row).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    if (key !== 'ledger') return invalidLedgerPaths(child, childPath);
    const resourceIds: readonly string[] = child === 'base' ? RESOURCE_IDS : child === 'sect' ? SECT_RESOURCE_IDS : [];
    const expectedPath = /^\$\.recipes\.[0-9]+\.(inputs|outputs|deficits)\.[0-9]+\.ledger$/.test(childPath)
      || /^\$\.buildings\.[0-9]+\.maintenance\.(nextMaintenanceCosts|deficits)\.[0-9]+\.ledger$/.test(childPath)
      || /^\$\.jobs\.[0-9]+\.checkpoints\.[0-9]+\.consumed\.[0-9]+\.ledger$/.test(childPath)
      || /^\$\.recentTerminals\.[0-9]+\.(consumed|released)\.[0-9]+\.ledger$/.test(childPath);
    const exactResourceLine = Object.keys(row).sort().join(',') === 'ledger,quantity,resourceId'
      && typeof row.resourceId === 'string' && resourceIds.includes(row.resourceId)
      && typeof row.quantity === 'number' && Number.isSafeInteger(row.quantity) && row.quantity >= 0;
    return expectedPath && exactResourceLine ? [] : [childPath];
  });
}
const alchemyId = (world: WorldStateV10): string => world.sectExpansion.construction.buildings.find(row => row.definitionId === 'alchemy.v9')!.buildingId;
const upgradeRequest = (world: WorldStateV10) => ({ buildingId: alchemyId(world), workerId: 'entity:2' });
function training(world: WorldStateV10, commandId: string): CommandV10 {
  return { kind: 'cultivation.command', commandId, issuedTick: world.clock.simulationTick, sequence: 0,
    payload: { command: { kind: 'training.set', commandId, expectedRevision: world.cultivation.revision, discipleId: 'entity:2', mode: 'duty' } } };
}

describe('fixed v10 projection leaves and query protocol', () => {
  it('projects fresh fixed identities and bounded detached values without exporting authority', () => {
    // Admission deliberately freezes its returned snapshot. Exercise query-only
    // isolation with a mutable copy rather than attributing that freeze to views.
    const source = cloneJson(createUnregisteredWorldV10('v10-view-fresh')); const before = canonicalStringify(source);
    const frame = views.projectRuntimeFrameV10(source); const cultivation = views.projectRuntimeCultivationV10(source, 'entity:4');
    const build = views.projectRuntimeBuildV10(source, 'entity:2'); const expansion = views.projectRuntimeExpansionV10(source);
    expect(frame.simulationVersion).toBe('0.10.0'); expect(frame.contentIdentity).toEqual(MANAGEMENT_V10_IDENTITY);
    expect(build.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY); expect(build.selected?.equipment).toHaveLength(3);
    expect(cultivation.selected?.injury).toBe(25); expect(expansion.recipes).toHaveLength(5);
    expect(expansion.recipes.find(row => row.recipeId === 'craft.wound-powder-alt.v9')).toMatchObject({ researchSatisfied: false, sites: [] });
    const forbidden = ['history', 'receipts', 'commandReceipts', 'reservations', 'randomStreams', 'sequences', 'workSpans',
      'siteVisits', 'payments', 'authorityReceipts', 'retiredDisciples', 'archivedDisciples'];
    for (const view of [frame, cultivation, build, expansion]) {
      for (const key of forbidden) expect(dataKeys(view)).not.toContain(key);
      expect(invalidLedgerPaths(view)).toEqual([]);
    }
    expect(frame.map).not.toBe(source.map); expect(frame.disciples[0]!.position).not.toBe(source.disciples[0]!.position);
    frame.disciples[0]!.position.x = 99; frame.clock.pauseReasons.push('player'); build.selected!.loadout.equipment.weaponId = 'test.only';
    expect(canonicalStringify(source)).toBe(before); expect(Object.isFrozen(source)).toBe(false);
    const readonlyFrame: RuntimeReadonlyV10<RuntimeFrameViewV10> = frame;
    expectTypeOf(readonlyFrame.disciples).toEqualTypeOf<ReadonlyArray<RuntimeReadonlyV10<RuntimeFrameViewV10['disciples'][number]>>>();
    const frozenSource = freeze(cloneJson(source)); expect(views.projectRuntimeFrameV10(frozenSource).seed).toBe(source.seed);
    expect(views.projectRuntimeBuildV10(frozenSource, null).selected).toBeNull();
  });
  it('permits only exact resource-line ledger tags while rejecting authority objects and off-path tags', () => {
    expect(invalidLedgerPaths({ recipes: [{ inputs: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }] }] })).toEqual([]);
    expect(invalidLedgerPaths({ ledger: { inventory: {}, reservations: [] } })).toEqual(['$.ledger']);
    expect(invalidLedgerPaths({ metadata: { ledger: 'base' } })).toEqual(['$.metadata.ledger']);
    expect(invalidLedgerPaths({ recipes: [{ inputs: [{ ledger: { inventory: {} }, resourceId: 'wood', quantity: 2 }] }] }))
      .toEqual(['$.recipes.0.inputs.0.ledger']);
    expect(invalidLedgerPaths({ recipes: [{ inputs: [{ ledger: 'base', resourceId: 'wood', quantity: 2, reservations: [] }] }] }))
      .toEqual(['$.recipes.0.inputs.0.ledger']);
    expect(invalidLedgerPaths({ recipes: [{ inputs: [{ ledger: 'sect', resourceId: 'wood', quantity: 2 }] }] }))
      .toEqual(['$.recipes.0.inputs.0.ledger']);
  });
  it('does not borrow placement requests or write prices/gates into the source', () => {
    const world = createUnregisteredWorldV10('v10-placement-leaf'); const before = canonicalStringify(world);
    const request = { definitionId: 'library.v9' as const, anchor: { x: 1, y: 1 }, rotation: 0 as const };
    const view = views.projectRuntimePlacementV10(world, request);
    expect(view).toMatchObject({ allowed: true, requiredTicks: 320, scope: 'placement-and-research' });
    expect(view.request).not.toBe(request); expect(view.request.anchor).not.toBe(request.anchor);
    expect(views.projectRuntimePlacementV10(world, { ...request, definitionId: 'alchemy.v9' })).toMatchObject({ allowed: false, code: 'RESEARCH_AUTHORITY_REQUIRED' });
    Reflect.set(view.request.anchor, 'x', 90); expect(request.anchor).toEqual({ x: 1, y: 1 });
    expect(canonicalStringify(world)).toBe(before);
  });
  it('rejects malformed queries, callbacks, getters, inherited fields, prices and gates', () => {
    let reads = 0;
    const query = { buildingId: 'sect-building:4', workerId: 'entity:2' };
    expect(views.validRuntimeUpgradeQueryV10(query)).toBe(true);
    for (const malformed of [null, [], () => { reads++; }, new Array(2), { ...query, costs: [] }, { ...query, researchGate: {} },
      { ...query, workerId: null }, { ...query, buildingId: 'entity:1' }, { ...query, buildingId: 'sect-building:01' },
      { ...query, buildingId: 'sect-building:' + '1'.repeat(128) }, Object.assign(Object.create({ inherited: true }), query),
      { get buildingId() { reads++; return query.buildingId; }, workerId: query.workerId }]) expect(views.validRuntimeUpgradeQueryV10(malformed)).toBe(false);
    expect(views.validRuntimeBreakthroughQueryV10({ get discipleId() { reads++; return 'entity:2'; }, preparation: { method: 'standard', arraySupport: 0 } })).toBe(false);
    expect(views.validRuntimeBreakthroughQueryV10({ discipleId: 'entity:2', preparation: { method: 'standard', arraySupport: 0, costs: [] } })).toBe(false);
    expect(views.validRuntimePlacementQueryV10({ definitionId: 'library.v9', anchor: { get x() { reads++; return 1; }, y: 1 }, rotation: 0 })).toBe(false);
    expect(reads).toBe(0);
  });
  for (const start of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) it(`rejects invalid cursor ${start}`, () => {
    expect(views.validRuntimeApplicationCursorV10(start)).toBe(false);
    expect(views.nextRuntimeApplicationCommandV10(createUnregisteredWorldV10('v10-cursor'), start)).toBeNull();
  });
  it('reserves a safe next cursor and never returns an overflowing sequence at the integer boundary', () => {
    const world = createUnregisteredWorldV10('v10-last-safe-cursor'); const before = canonicalStringify(world);
    const last = Number.MAX_SAFE_INTEGER - 1;
    expect(views.validRuntimeApplicationCursorV10(last)).toBe(true);
    expect(views.nextRuntimeApplicationCommandV10(world, last)).toEqual({ commandId: `app-command.${last}`, sequence: last, issuedTick: 0 });
    expect(Number.isSafeInteger(last + 1)).toBe(true);
    expect(views.validRuntimeApplicationCursorV10(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(views.nextRuntimeApplicationCommandV10(world, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(views.nextRuntimeApplicationCommandV10(world, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(canonicalStringify(world)).toBe(before);
  });
  it('searches archived and live receipts by exact identity without parsing huge suffixes', () => {
    let world = createUnregisteredWorldV10('v10-archive-query');
    for (let index = 0; index < 70; index++) world = apply(world, training(world, `app-command.${index}`));
    expect(world.history.commandReceipts.count).toBeGreaterThan(0);
    const before = canonicalStringify(world); expect(views.nextRuntimeApplicationCommandV10(world, 0)?.sequence).toBe(70);
    expect(canonicalStringify(world)).toBe(before);
    world = apply(world, training(world, 'app-command.999999999999999999999999999999999999999'));
    expect(views.nextRuntimeApplicationCommandV10(world, 70)?.sequence).toBe(70);
    world = apply(world, training(world, `app-command.${Number.MAX_SAFE_INTEGER - 1}`));
    expect(views.nextRuntimeApplicationCommandV10(world, Number.MAX_SAFE_INTEGER - 1)).toBeNull();
    expect(views.nextRuntimeApplicationCommandV10(world, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

let oldMedicine: WorldStateV9; let medicine: WorldStateV10; let ready: WorldStateV10;
let active: WorldStateV10; let beforeHalf: WorldStateV10; let half: WorldStateV10; let almost: WorldStateV10;
let completed: WorldStateV10; let paidL2: WorldStateV10;
let delivery: WorldStateV10; let powder: WorldStateV10;
describe('genuine v10 upgrade, paid rates, delivery and retired-worker projection', () => {
  beforeAll(() => { oldMedicine = medicineRuntimeFixture(); }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let index = 0; index < 4; index++) beforeAll(() => { oldMedicine = fixtureProduce(oldMedicine, recipe); }, 60000);
  }
  beforeAll(() => {
    medicine = records(oldMedicine);
    const started = apply(medicine, sect(medicine, { domain: 'research', command: { kind: 'research.start', commandId: 'app-command.0',
      expectedRevision: medicine.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
    ready = until(started, world => world.sectExpansion.research.jobs.at(-1)!.terminal !== null);
    active = apply(ready, sect(ready, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId: 'app-command.1',
      expectedRevision: ready.sectExpansion.upgrade.revision, ...upgradeRequest(ready) } }));
    beforeHalf = until(active, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 199);
    half = until(beforeHalf, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 200);
    almost = until(half, world => world.sectExpansion.upgrade.jobs[0]!.activeTicks === 399);
    completed = until(almost, world => world.sectExpansion.upgrade.jobs[0]!.terminal !== null);
  }, 120000);
  beforeAll(() => {
    paidL2 = until(completed, world => world.sectExpansion.maintenance.payments.some(payment => payment.rate?.level === 2));
    const noGrain = apply(paidL2, { kind: 'inventory.discard', commandId: 'view.no-grain', issuedTick: paidL2.clock.simulationTick,
      sequence: 0, payload: { resourceId: 'grain', quantity: paidL2.inventory.grain.owned - paidL2.inventory.grain.reserved } });
    const started = apply(noGrain, sect(noGrain, { domain: 'production', command: { kind: 'production.start', commandId: 'view.alternative',
      expectedRevision: noGrain.sectExpansion.production.revision, recipeId: 'craft.wound-powder-alt.v9', workerId: 'entity:2' } }));
    delivery = until(started, world => world.sectExpansion.production.jobs.at(-1)!.phase === 'TravellingToStorage');
    powder = until(delivery, world => world.sectExpansion.production.jobs.at(-1)!.terminal !== null);
  }, 120000);
  it('uses exact fixed upgrade costs and research, and reports declined preview without executing', () => {
    const before = canonicalStringify(medicine); const missing = views.projectRuntimeUpgradeV10(medicine, upgradeRequest(medicine));
    expect(missing).toMatchObject({ eligible: false, rejection: 'RESEARCH_AUTHORITY_REQUIRED', researchGate: null, requiredTicks: 400 });
    const preview = views.projectRuntimeUpgradeV10(ready, upgradeRequest(ready));
    expect(preview).toMatchObject({ eligible: true, rejection: null, scope: 'upgrade-start-conditions', requiredTicks: 400,
      costs: [{ ledger: 'base', resourceId: 'stone', quantity: 6 }, { ledger: 'base', resourceId: 'plank', quantity: 6 }],
      researchGate: { researchId: 'herbal-compatibility.v9' } });
    expect(preview.halfCosts.map(row => row.quantity)).toEqual([3, 3]);
    expect(canonicalStringify(medicine)).toBe(before);
    const library = ready.sectExpansion.construction.buildings.find(row => row.definitionId === 'library.v9')!;
    expect(views.projectRuntimeUpgradeV10(ready, { buildingId: library.buildingId, workerId: 'entity:2' })).toMatchObject({ eligible: false, rejection: 'UNSUPPORTED_UPGRADE' });
    const declined = prepareUnregisteredCommandCandidateV10(medicine, sect(medicine, { domain: 'upgrade', command: { kind: 'upgrade.start',
      commandId: 'view.declined', expectedRevision: medicine.sectExpansion.upgrade.revision, ...upgradeRequest(medicine) } }));
    expect(declined.result.status).toBe('rejected'); expect(declined.world).toBe(medicine);
  });
  it('projects the active upgrade owner and skips its receipt without rewriting L1 construction', () => {
    const view = views.projectRuntimeExpansionV10(active); const building = view.buildings.find(row => row.definitionId === 'alchemy.v9')!;
    expect(view.jobs).toContainEqual(expect.objectContaining({ domain: 'upgrade', fromLevel: 1, toLevel: 2, requiredTicks: 400, activeTicks: 0 }));
    expect(building).toMatchObject({ level: 1, activeUpgradeJobId: active.sectExpansion.upgrade.jobs[0]!.jobId,
      maintenance: { paid: true, operational: false } });
    expect(view.recipes.find(row => row.recipeId === 'craft.wound-powder.v9')!.sites).toEqual([]);
    expect(views.projectRuntimeCultivationV10(active, 'entity:2').selected).toMatchObject({ workerAvailable: false, workOwner: { kind: 'upgrade' } });
    expect(views.projectRuntimeBreakthroughV10(active, { discipleId: 'entity:2', preparation: { method: 'standard', arraySupport: 0 } }).workOwner?.kind).toBe('upgrade');
    expect(views.projectRuntimeUpgradeV10(active, upgradeRequest(active))).toMatchObject({ eligible: false, rejection: 'UPGRADE_ACTIVE' });
    expect(lookupCommandReceipt(active, 'app-command.1')).toBeUndefined();
    expect(views.nextRuntimeApplicationCommandV10(active, 0)?.sequence).toBe(2);
    expect(active.sectExpansion.construction.buildings).toEqual(ready.sectExpansion.construction.buildings);
  });
  it('projects only actually recorded upgrade checkpoints with exact paired consumption and a two-row bound', () => {
    const upgrade = (world: WorldStateV10) => {
      const job = views.projectRuntimeExpansionV10(world).jobs.find(row => row.domain === 'upgrade');
      if (!job || job.domain !== 'upgrade') throw new Error('Missing real active upgrade'); return job;
    };
    expect(upgrade(active).checkpoints).toEqual([]); expect(upgrade(beforeHalf).checkpoints).toEqual([]);
    const actual = half.sectExpansion.upgrade.jobs[0]!; const recorded = actual.checkpoints[0]!;
    const claim = half.sectExpansion.reservations.find(row => row.reservationId === actual.reservationId && row.ownerTransactionId === actual.jobId)!;
    const checkpoint = upgrade(half).checkpoints[0]!;
    expect(checkpoint).toEqual({ checkpointId: recorded.checkpointId, activeTicks: recorded.activeTicks, tick: recorded.tick,
      consumed: claim.base.checkpoints[0]!.lines.map(line => ({ ledger: 'base', resourceId: line.resourceId, quantity: line.quantity })) });
    expect(checkpoint).toMatchObject({ checkpointId: 'construction.half', activeTicks: 200,
      consumed: [{ ledger: 'base', resourceId: 'stone', quantity: 3 }, { ledger: 'base', resourceId: 'plank', quantity: 3 }] });
    expect(Object.keys(checkpoint).sort()).toEqual(['activeTicks', 'checkpointId', 'consumed', 'tick']);
    expect(upgrade(almost).checkpoints).toEqual([checkpoint]);
    expect(views.projectRuntimeExpansionV10(completed).jobs.some(row => row.domain === 'upgrade')).toBe(false);
    expect(completed.sectExpansion.upgrade.jobs[0]!.checkpoints).toHaveLength(2);
    expect(RUNTIME_VIEW_LIMITS_V10.upgradeCheckpoints).toBe(2);
    expect(invalidLedgerPaths(views.projectRuntimeExpansionV10(half))).toEqual([]);
    // Deliberately violates the selector's owned-source precondition solely to
    // prove the local output-bound guard; this is not an admitted World fixture.
    const overBound = cloneJson(half); const job = overBound.sectExpansion.upgrade.jobs[0]!;
    Reflect.set(job, 'checkpoints', [job.checkpoints[0], job.checkpoints[0], job.checkpoints[0]]);
    expect(() => views.projectRuntimeExpansionV10(overBound)).toThrow(RangeError);
  });
  it('copies authentic upgrade cancellation refunds and completion consumption without inferring policy', () => {
    const cancel = (source: WorldStateV10) => apply(source, sect(source, { domain: 'upgrade', command: { kind: 'upgrade.cancel',
      commandId: `view.cancel.${source.sectExpansion.upgrade.jobs[0]!.activeTicks}`, expectedRevision: source.sectExpansion.upgrade.revision,
      jobId: source.sectExpansion.upgrade.jobs[0]!.jobId } }));
    const cancelledEarly = cancel(beforeHalf); const cancelledHalf = cancel(half);
    for (const source of [cancelledEarly, cancelledHalf, completed]) {
      const view = views.projectRuntimeExpansionV10(source); const terminal = view.recentTerminals.find(row => row.domain === 'upgrade');
      if (!terminal || terminal.domain !== 'upgrade') throw new Error('Missing upgrade terminal summary');
      const actual = source.sectExpansion.upgrade.jobs[0]!.terminal!;
      expect(terminal.consumed).toEqual(actual.consumed); expect(terminal.released).toEqual(actual.released);
      expect(terminal.consumed).not.toBe(actual.consumed); expect(terminal.released).not.toBe(actual.released);
      expect(invalidLedgerPaths(view)).toEqual([]);
      expect(view.recentTerminals.length).toBeLessThanOrEqual(RUNTIME_VIEW_LIMITS_V10.recentTerminals);
    }
    const early = views.projectRuntimeExpansionV10(cancelledEarly).recentTerminals.find(row => row.domain === 'upgrade')!;
    const midway = views.projectRuntimeExpansionV10(cancelledHalf).recentTerminals.find(row => row.domain === 'upgrade')!;
    const complete = views.projectRuntimeExpansionV10(completed).recentTerminals.find(row => row.domain === 'upgrade')!;
    expect(early).toMatchObject({ kind: 'cancelled', consumed: [], released: [
      { ledger: 'base', resourceId: 'stone', quantity: 6 }, { ledger: 'base', resourceId: 'plank', quantity: 6 }] });
    expect(midway).toMatchObject({ kind: 'cancelled', consumed: [
      { ledger: 'base', resourceId: 'stone', quantity: 3 }, { ledger: 'base', resourceId: 'plank', quantity: 3 }], released: [
      { ledger: 'base', resourceId: 'stone', quantity: 3 }, { ledger: 'base', resourceId: 'plank', quantity: 3 }] });
    expect(complete).toMatchObject({ kind: 'completed', released: [], consumed: [
      { ledger: 'base', resourceId: 'stone', quantity: 6 }, { ledger: 'base', resourceId: 'plank', quantity: 6 }] });
    const before = canonicalStringify(cancelledHalf);
    if (midway.domain !== 'upgrade') throw new Error('Missing upgrade refund');
    expect(Reflect.set(midway.consumed[0]!, 'quantity', 99)).toBe(true);
    expect(Reflect.set(midway.released[0]!, 'quantity', 99)).toBe(true);
    expect(canonicalStringify(cancelledHalf)).toBe(before);
    expect(views.projectRuntimeExpansionV10(cancelledHalf).recentTerminals.find(row => row.domain === 'upgrade')!.released)
      .toEqual(cancelledHalf.sectExpansion.upgrade.jobs[0]!.terminal!.released);
    const owner = createPrivateRuntimeV10(cancelledHalf); if (!owner.ok) throw new Error(owner.error);
    const read = owner.instance.expansion(); if (!read.ok) throw new Error(read.error);
    const frozen = read.value.recentTerminals.find(row => row.domain === 'upgrade');
    if (!frozen || frozen.domain !== 'upgrade') throw new Error('Missing frozen upgrade refund');
    expect(Object.isFrozen(frozen.released)).toBe(true); expect(Reflect.set(frozen.released[0]!, 'quantity', 99)).toBe(false);
    owner.instance.close();
  });
  it('detaches checkpoint rows and freezes them only at the existing runtime owner boundary', () => {
    const before = canonicalStringify(half); const view = views.projectRuntimeExpansionV10(half);
    const job = view.jobs.find(row => row.domain === 'upgrade'); if (!job || job.domain !== 'upgrade') throw new Error('Missing upgrade');
    expect(Reflect.set(job.checkpoints[0]!, 'tick', 0)).toBe(true);
    expect(Reflect.set(job.checkpoints[0]!.consumed[0]!, 'quantity', 99)).toBe(true);
    expect(canonicalStringify(half)).toBe(before);
    const owner = createPrivateRuntimeV10(half); if (!owner.ok) throw new Error(owner.error);
    const read = owner.instance.expansion(); if (!read.ok) throw new Error(read.error);
    const frozen = read.value.jobs.find(row => row.domain === 'upgrade');
    if (!frozen || frozen.domain !== 'upgrade') throw new Error('Missing frozen upgrade');
    expect(Object.isFrozen(frozen.checkpoints)).toBe(true); expect(Object.isFrozen(frozen.checkpoints[0]!.consumed)).toBe(true);
    expect(Reflect.set(frozen.checkpoints[0]!, 'tick', 0)).toBe(false);
    expect(Reflect.set(frozen.checkpoints[0]!.consumed[0]!, 'quantity', 99)).toBe(false);
    expect(frozen.checkpoints[0]!.tick).toBe(half.sectExpansion.upgrade.jobs[0]!.checkpoints[0]!.tick);
    expect(read.metrics.exports).toBe(0); owner.instance.close();
  });
  it('shows genuine L2 source while preserving the L1 paid period and fixed L2 next costs', () => {
    const before = canonicalStringify(completed); const oldValidator = vi.spyOn(oldMaintenance, 'validateSectMaintenanceFrame');
    const view = views.projectRuntimeExpansionV10(completed); views.projectRuntimePlacementV10(completed, { definitionId: 'alchemy.v9', anchor: { x: 14, y: 1 }, rotation: 0 });
    const building = view.buildings.find(row => row.definitionId === 'alchemy.v9')!;
    expect(building).toMatchObject({ level: 2, activeUpgradeJobId: null, levelEvidence: { level: 2, upgradeJobId: completed.sectExpansion.upgrade.jobs[0]!.jobId },
      maintenance: { paid: true, operational: true, currentPeriod: { level: 1 }, nextMaintenanceCosts: [
        { ledger: 'base', resourceId: 'wood', quantity: 2 }, { ledger: 'base', resourceId: 'herbs', quantity: 1 }] } });
    expect(completed.sectExpansion.construction.buildings.find(row => row.buildingId === building.buildingId)!.level).toBe(1);
    expect(view.recentTerminals.find(row => row.domain === 'upgrade')).toMatchObject({ kind: 'completed', resultLevel: 2 });
    expect(view.recentTerminals.length).toBeLessThanOrEqual(RUNTIME_VIEW_LIMITS_V10.recentTerminals);
    expect(oldValidator).not.toHaveBeenCalled(); oldValidator.mockRestore(); expect(canonicalStringify(completed)).toBe(before);
    expect(views.projectRuntimeUpgradeV10(completed, upgradeRequest(completed))).toMatchObject({ eligible: false, rejection: 'ALREADY_UPGRADED' });
    const renewed = views.projectRuntimeExpansionV10(paidL2).buildings.find(row => row.buildingId === building.buildingId)!;
    expect(renewed.maintenance.currentPeriod).toMatchObject({ level: 2, upgradeJobId: completed.sectExpansion.upgrade.jobs[0]!.jobId });
  });
  it('isolates nested expansion and upgrade DTO mutations from source, catalog and later queries', () => {
    const before = [ready, active, completed, delivery].map(canonicalStringify);
    const baseline = views.projectRuntimeExpansionV10(completed); const expansion = views.projectRuntimeExpansionV10(completed);
    const building = expansion.buildings.find(row => row.definitionId === 'alchemy.v9')!;
    Reflect.set(building.levelEvidence, 'upgradeJobId', 'test.only');
    Reflect.set(building.footprint.cells[0]!, 'x', 255);
    Reflect.set(building.maintenance.currentPeriod!, 'dueCalendarTick', 0);
    Reflect.set(building.maintenance.nextMaintenanceCosts[0]!, 'quantity', 99);
    expansion.stock[0]!.owned = 99;
    expansion.completedResearch[0]!.completionJobId = 'test.only';
    expansion.recentTerminals[0]!.actorId = 'test.only';
    const recipe = expansion.recipes.find(row => row.recipeId === 'craft.wound-powder-alt.v9')!;
    Reflect.set(recipe.inputs[0]!, 'quantity', 99); Reflect.set(recipe.outputs[0]!, 'quantity', 99);
    Reflect.set(recipe.researchGate!, 'completionJobId', 'test.only'); Reflect.set(recipe.sites[0]!, 'upgradeJobId', 'test.only');
    const activeView = views.projectRuntimeExpansionV10(active);
    activeView.workOwners[0]!.workerId = 'test.only'; Reflect.set(activeView.jobs[0]!, 'activeTicks', 400);
    const deliveryView = views.projectRuntimeExpansionV10(delivery);
    const producer = deliveryView.jobs.find(row => row.domain === 'production');
    if (!producer || producer.domain !== 'production') throw new Error('Missing actual delivery view');
    Reflect.set(producer.site, 'sourceJobId', 'test.only');
    const request = upgradeRequest(ready); const requestBefore = cloneJson(request);
    const originalPreview = views.projectRuntimeUpgradeV10(ready, request); const preview = views.projectRuntimeUpgradeV10(ready, request);
    for (const costs of [preview.costs, preview.halfCosts, preview.remainingCosts]) Reflect.set(costs[0]!, 'quantity', 99);
    Reflect.set(preview.researchGate!, 'completionJobId', 'test.only');
    expect([ready, active, completed, delivery].map(canonicalStringify)).toEqual(before);
    expect(request).toEqual(requestBefore);
    expect(views.projectRuntimeExpansionV10(completed)).toEqual(baseline);
    expect(views.projectRuntimeUpgradeV10(ready, request)).toEqual(originalPreview);
    expect(views.projectRuntimeExpansionV10(active).workOwners[0]!.workerId).toBe('entity:2');
    expect(views.projectRuntimeExpansionV10(delivery).jobs.find(row => row.domain === 'production'))
      .toMatchObject({ site: { sourceJobId: completed.sectExpansion.construction.buildings.find(row => row.definitionId === 'alchemy.v9')!.sourceJobId } });
  });
  it('exposes alternative recipe and exact delivery source without claiming dispatch admission', () => {
    const view = views.projectRuntimeExpansionV10(delivery); const alternative = view.recipes.find(row => row.recipeId === 'craft.wound-powder-alt.v9')!;
    expect(delivery.inventory.grain.owned).toBe(0);
    expect(alternative).toMatchObject({ researchSatisfied: true, requiredTicks: 200, scope: 'catalog-and-authenticated-sites',
      inputs: [{ ledger: 'base', resourceId: 'herbs', quantity: 5 }, { ledger: 'base', resourceId: 'wood', quantity: 2 }] });
    expect(alternative.sites[0]).toMatchObject({ level: 2, upgradeJobId: completed.sectExpansion.upgrade.jobs[0]!.jobId });
    expect(view.jobs.find(row => row.domain === 'production')).toMatchObject({ recipeId: 'craft.wound-powder-alt.v9', phase: 'TravellingToStorage', site: { level: 2 } });
    expect(views.projectRuntimeExpansionV10(powder).stock.find(row => row.resourceId === 'wound-powder')!.owned).toBe(2);
    const keys = dataKeys(view); for (const key of ['workSpans', 'siteVisits', 'payments', 'receipts', 'reservations', 'history']) expect(keys).not.toContain(key);
    expect(invalidLedgerPaths(view)).toEqual([]);
  });
  it('keeps all production lifetime phases busy for an L1 upgrade, including released-seat delivery', () => {
    const started = apply(ready, sect(ready, { domain: 'production', command: { kind: 'production.start', commandId: 'view.base-delivery',
      expectedRevision: ready.sectExpansion.production.revision, recipeId: 'craft.wound-powder.v9', workerId: 'entity:2' } }));
    const delivering = until(started, world => world.sectExpansion.production.jobs.at(-1)!.phase === 'TravellingToStorage');
    expect(delivering.sectExpansion.production.jobs.at(-1)!.seatSiteId).toBeNull();
    expect(views.projectRuntimeUpgradeV10(delivering, { buildingId: alchemyId(delivering), workerId: 'entity:3' }))
      .toMatchObject({ eligible: false, rejection: 'BUILDING_BUSY' });
  }, 60000);
  it('reports exact old and alternative dose sources through real care jobs and terminal summaries', () => {
    let source = powder;
    for (const [index, recipeId] of ['craft.wound-powder.v9', 'craft.wound-powder-alt.v9'].entries()) {
      source = apply(source, sect(source, { domain: 'care', command: { kind: 'care.start', commandId: `app-command.${index + 2}`,
        expectedRevision: source.sectExpansion.care.revision, patientId: 'entity:4' } }));
      const care = views.projectRuntimeExpansionV10(source).jobs.find(row => row.domain === 'care');
      expect(care).toMatchObject({ domain: 'care', doseSource: { recipeId, site: { level: index === 0 ? 1 : 2 } } });
      expect(views.projectRuntimeBuildV10(source, 'entity:4').selected?.locked).toBe(true);
      source = until(source, world => world.sectExpansion.care.jobs.at(-1)!.terminal !== null);
      expect(views.projectRuntimeExpansionV10(source).recentTerminals.find(row => row.domain === 'care'))
        .toMatchObject({ kind: 'completed', afterInjury: index === 0 ? 5 : 0, doseSource: { recipeId } });
    }
    expect(views.nextRuntimeApplicationCommandV10(source, 0)?.sequence).toBe(4);
  }, 60000);
  it('retains genuine completed source IDs after retiring the upgrader, without leaking archives', () => {
    const source = cloneJson(completed); const month = CALENDAR_TICKS_PER_MONTH;
    const target = Math.ceil((source.clock.calendarTick + 1) / month) * month;
    source.clock.simulationTick = target - 1; source.clock.calendarTick = target - 1;
    const actor = source.disciples.find(row => row.id === 'entity:2')!;
    const profile = source.cultivation.disciples.find(row => row.discipleId === actor.id)!;
    actor.birthCalendarTick = target - profile.lifespanMonths * month; actor.ageMonths = profile.lifespanMonths - 1; profile.ageMonths = actor.ageMonths;
    expect(inspectUnregisteredWorldV10Records(source)).toEqual([]);
    const pending = prepareNormalTickCandidateV10(source); const death = pending.cultivation.pendingDeaths.find(row => row.discipleId === actor.id)!;
    const retired = apply(pending, { kind: 'cultivation.command', commandId: 'view.retire', issuedTick: target, sequence: 0,
      payload: { command: { kind: 'death.finalize', commandId: 'view.retire', expectedRevision: pending.cultivation.revision,
        discipleId: actor.id, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    expect(inspectUnregisteredWorldV10Records(retired)).toEqual([]);
    const view = views.projectRuntimeExpansionV10(retired);
    expect(view.buildings.find(row => row.definitionId === 'alchemy.v9')!.level).toBe(2);
    expect(view.recentTerminals.find(row => row.domain === 'upgrade')!.actorId).toBe('entity:2');
    expect(views.projectRuntimeCultivationV10(retired, 'entity:2').selected).toBeNull();
    expect(views.projectRuntimeBuildV10(retired, 'entity:2')).toMatchObject({ contentIdentity: MANAGEMENT_V9_IDENTITY, selected: null });
    expect(dataKeys(view)).not.toContain('archivedDisciples');
  });
});
