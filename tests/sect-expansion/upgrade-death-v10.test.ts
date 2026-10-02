import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY, managementV10BuildContext } from '../../src/content/sect-v10/world-content';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { captureSectHistoricalIdentitiesV10 } from '../../src/core/sect-expansion/history-identity';
import { sectReservationLines } from '../../src/core/sect-expansion/ledger';
import { tickValidatedSectMaintenancePaymentV10 } from '../../src/core/sect-expansion/maintenance-runtime-v10';
import { applySectUpgradeCommandV10, applyValidatedSectUpgradeCommandV10, cancelValidatedSectUpgradesForLifecycleV10,
  tickValidatedSectUpgradeV10 } from '../../src/core/sect-expansion/upgrade-runtime';
import { createSectUpgradeStateV10, isSectUpgradeCommandV10, sectUpgradeClaimsV10, validateSectUpgradeRecordsV10,
  validateWorldSectUpgradeRecordsV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, SectUpgradeFrameV10, SectUpgradeResultV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { prepareEstateResponsibilities, prepareEstateSettlement } from '../../src/core/world/estate-preparation';
import { prepareValidatedV10CultivationClock, prepareValidatedV10CultivationCommand,
  type V10CultivationTransitionEvidence } from '../../src/core/world/v10-cultivation-preparation';
import { inspectV10LifecycleRecords, type V10LifecycleRecordEvidence } from '../../src/core/world/v10-lifecycle-records';
import { composeV10SectFrame, projectV10SectFrame, v10SectContext, v10WorkOwners } from '../../src/core/world/v10-sect-frame';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixturePlace, fixtureProduce, fixtureSectCommand, fixtureStartConstruction,
  fixtureUntil, medicineRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

const MONTH = CALENDAR_TICKS_PER_MONTH;
const workerId = 'entity:4';
/** Real prior v9 paid work, with the existing fixture's explicitly funded base stock.
 * Component-only v10 lift: this is not migration, whole-root admission or gameplay. */
function lift(source: WorldStateV9): WorldStateV10 {
  recordChecked(source);
  return { ...cloneJson(source), simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...cloneJson(source.sectExpansion), schemaVersion: 2,
      construction: { ...cloneJson(source.sectExpansion.construction), buildings: source.sectExpansion.construction.buildings.map(building => ({ ...building, level: 1 as const })) },
      production: { ...cloneJson(source.sectExpansion.production), jobs: source.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('Old source cannot contain L2 medicine');
        return cloneJson({ ...job, recipeId: job.recipeId });
      }) }, upgrade: createSectUpgradeStateV10() } };
}
function accept(result: SectUpgradeResultV10): SectUpgradeFrameV10 {
  if (!result.ok) throw new Error(result.code); return result.frame;
}
function start(world: WorldStateV10, person = workerId, index = 0): WorldStateV10 {
  const buildingId = world.sectExpansion.construction.buildings.filter(building => building.definitionId === 'alchemy.v9')[index]!.buildingId;
  return composeV10SectFrame(world, accept(applyValidatedSectUpgradeCommandV10(projectV10SectFrame(world), v10SectContext(world),
    { kind: 'upgrade.start', commandId: `death-test.start.${world.sectExpansion.upgrade.nextId}`, expectedRevision: world.sectExpansion.upgrade.revision,
      workerId: person, buildingId })));
}
/** Real clock/cultivation preparation and upgrade movement/work; no estate or root capacity
 * publication is implied by this component harness. All workers are alive in this setup. */
function step(world: WorldStateV10): WorldStateV10 {
  const prepared = prepareValidatedV10CultivationClock(world);
  const released = accept(cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, prepared.evidence));
  const maintained = tickValidatedSectMaintenancePaymentV10(released, prepared.context);
  return composeV10SectFrame(prepared.world, accept(tickValidatedSectUpgradeV10(maintained, prepared.context,
    createWorkPathBudget(prepared.context.simulationTick))));
}
/** Explicit near-expiry initial-boundary fixture and idle jump only within this month.
 * Birthday residue stays zero, preserving all genuine prior month source rows. No work,
 * consumption, visit, lifecycle token or skipped lifetime is fabricated. */
function nearExpiry(source: WorldStateV10, ids = [workerId]): WorldStateV10 {
  let world = cloneJson(source);
  const target = Math.ceil((world.clock.calendarTick + 1) / MONTH) * MONTH;
  world.clock = { ...world.clock, simulationTick: target - 1, calendarTick: target - 1 };
  for (const id of ids) {
    const actor = world.disciples.find(value => value.id === id)!;
    const profile = world.cultivation.disciples.find(value => value.discipleId === id)!;
    actor.birthCalendarTick = target - profile.lifespanMonths * MONTH;
    actor.ageMonths = Math.floor((target - 1 - actor.birthCalendarTick) / MONTH); profile.ageMonths = actor.ageMonths;
  }
  // The paid interval really covers the next tick, including the would-be 400th work tick.
  world = composeV10SectFrame(world, tickValidatedSectMaintenancePaymentV10(projectV10SectFrame(world), v10SectContext(world)));
  inspectV10LifecycleRecords(world);
  expect(validateSectUpgradeRecordsV10(projectV10SectFrame(world))).toEqual([]);
  return world;
}
function cancelDeath(source: WorldStateV10): WorldStateV10 {
  const prepared = prepareValidatedV10CultivationClock(source);
  return composeV10SectFrame(prepared.world, accept(cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, prepared.evidence)));
}
function checked(world: WorldStateV10): void {
  expect(validateWorldSectUpgradeRecordsV10(world, projectV10SectFrame(world), inspectV10LifecycleRecords(world))).toEqual([]);
}
let old: WorldStateV9; let ready: WorldStateV10; let doubleReady: WorldStateV10;
const boundaries = new Map<number, WorldStateV10>();
beforeAll(() => { old = medicineRuntimeFixture(); }, 30000);
for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
  for (let n = 0; n < 4; n++) beforeAll(() => { old = fixtureProduce(old, recipe); }, 30000);
}
beforeAll(() => {
  old = fixtureApply(old, fixtureSectCommand(old, { domain: 'research', command: { kind: 'research.start', commandId: 'death-test.herbal',
    expectedRevision: old.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
  old = fixtureUntil(old, value => value.sectExpansion.research.jobs.at(-1)!.terminal !== null);
  ready = lift(old); checked(ready);
}, 30000);
beforeAll(() => {
  let world = start(ready); boundaries.set(0, world);
  for (let n = 0; n < 1200 && world.sectExpansion.upgrade.jobs[0]!.activeTicks < 399; n++) {
    world = step(world);
    const count = world.sectExpansion.upgrade.jobs[0]!.activeTicks;
    if ([199, 200, 399].includes(count)) boundaries.set(count, world);
  }
  expect([...boundaries.keys()]).toEqual([0, 199, 200, 399]); checked(world);
}, 30000);
beforeAll(() => {
  let two = fixtureStartConstruction(fixturePlace(old, 'alchemy.v9', 4));
  two = fixtureUntil(two, value => value.sectExpansion.construction.jobs.at(-1)!.terminal !== null);
  doubleReady = lift(two);
}, 30000);

describe('actual v10 pre-work upgrade death cancellation, component integration', () => {
  it.each([0, 199, 200, 399])('cancels actual %i-work upgrade at exact expiry with the exact unconsumed refund', activeTicks => {
    const source = nearExpiry(boundaries.get(activeTicks)!); const before = canonicalStringify(source);
    const prior = source.sectExpansion.upgrade.jobs[0]!;
    const prepared = prepareValidatedV10CultivationClock(source);
    const untouched = canonicalStringify(prepared.world);
    const result = cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, prepared.evidence);
    const frame = accept(result); const world = composeV10SectFrame(prepared.world, frame); const job = frame.upgrade.jobs[0]!;
    const death = world.cultivation.pendingDeaths.find(value => value.discipleId === workerId)!;
    expect(job).toMatchObject({ activeTicks, phase: 'cancelled', blocked: null, terminal: {
      kind: 'cancelled', previousPhase: prior.phase, resultLevel: 1, cancellation: { kind: 'death', deathId: death.deathId },
      tick: source.clock.simulationTick + 1, calendarTick: source.clock.calendarTick + 1, upgradeRevision: source.sectExpansion.upgrade.revision + 1 } });
    expect(job.terminal!.released.map(line => line.quantity)).toEqual(activeTicks < 200 ? [6, 6] : [3, 3]);
    expect(job.terminal!.consumed.map(line => line.quantity)).toEqual(activeTicks < 200 ? [] : [3, 3]);
    expect(job.storageVisit).toEqual(prior.storageVisit); expect(job.siteVisits).toEqual(prior.siteVisits);
    expect(job.workSpans).toEqual(prior.workSpans); expect(job.checkpoints).toEqual(prior.checkpoints); expect(job.navigation).toEqual(emptyNavigation());
    const claim = frame.construction.ledger.reservations.find(value => value.reservationId === job.reservationId)!;
    expect(sectReservationLines(claim, 'remainingReservation')).toEqual([]);
    expect(claim.base.settlement).toEqual({ kind: 'released', operationId: `cancel:${job.jobId}` });
    expect(claim.sect.settlement).toEqual(claim.base.settlement);
    for (const resource of ['stone', 'plank'] as const) {
      expect(world.inventory[resource].owned).toBe(source.inventory[resource].owned);
      expect(world.inventory[resource].reserved).toBe(source.inventory[resource].reserved - (activeTicks < 200 ? 6 : 3));
    }
    expect(frame.upgrade.receipts.at(-1)).toEqual({ command: { kind: 'upgrade.cancel',
      commandId: `system/v10/death/${death.deathId}/${job.jobId}`, expectedRevision: source.sectExpansion.upgrade.revision, jobId: job.jobId },
      revision: source.sectExpansion.upgrade.revision + 1, jobId: job.jobId });
    expect(sectUpgradeClaimsV10(frame)).toEqual([]); expect(v10WorkOwners(world)).toEqual([]);
    expect(world.disciples.find(value => value.id === workerId)).toMatchObject({ position: source.disciples.find(value => value.id === workerId)!.position, traveling: false });
    expect(world.map).toEqual(source.map); expect(world.sectExpansion.construction.buildings).toEqual(source.sectExpansion.construction.buildings);
    expect(world.sectExpansion.maintenance).toEqual(source.sectExpansion.maintenance); expect(world.randomStreams).toEqual(source.randomStreams);
    expect(world.sectExpansion.upgrade.nextId).toBe(source.sectExpansion.upgrade.nextId);
    checked(world);
    expect(validateSectUpgradeRecordsV10(frame).length).toBeGreaterThan(0);
    expect(canonicalStringify(source)).toBe(before); expect(canonicalStringify(prepared.world)).toBe(untouched);
    // Repeat from the exact immutable stage produces the same candidate, not another debit.
    expect(cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, prepared.evidence)).toEqual(result);
    const paused = prepareValidatedV10CultivationClock(world);
    expect(paused.advanced).toBe(false);
    expect(accept(cancelValidatedSectUpgradesForLifecycleV10(paused.frame, paused.context, paused.evidence)).upgrade).toEqual(frame.upgrade);
    expect(accept(tickValidatedSectUpgradeV10(frame, prepared.context, createWorkPathBudget(prepared.context.simulationTick))).upgrade).toEqual(frame.upgrade);
  });

  it('proves a paid 399 boundary would complete next tick if alive, but expiry prevents the remainder debit', () => {
    const source = nearExpiry(boundaries.get(399)!);
    // Control changes only the explicit lifespan boundary, retaining the genuine 399 work history.
    const control = cloneJson(source); const actor = control.disciples.find(value => value.id === workerId)!;
    const profile = control.cultivation.disciples.find(value => value.discipleId === workerId)!;
    actor.birthCalendarTick += MONTH; actor.ageMonths--; profile.ageMonths--;
    const completed = step(control); expect(completed.sectExpansion.upgrade.jobs[0]!.terminal?.kind).toBe('completed');
    expect(completed.sectExpansion.upgrade.jobs[0]!.activeTicks).toBe(400);
    const cancelled = cancelDeath(source); expect(cancelled.sectExpansion.upgrade.jobs[0]!.activeTicks).toBe(399);
    expect(cancelled.sectExpansion.upgrade.jobs[0]!.checkpoints).toHaveLength(1); checked(cancelled);
  });

  it('rejects forged/copied/record-only/foreign proof and replacement frame or context', () => {
    const source = nearExpiry(boundaries.get(200)!); const prepared = prepareValidatedV10CultivationClock(source);
    const proofs = [{}, { ...prepared.evidence }, JSON.parse(JSON.stringify(prepared.evidence)), inspectV10LifecycleRecords(source), inspectV10LifecycleRecords(prepared.world)];
    for (const evidence of proofs) expect(cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context,
      evidence as V10CultivationTransitionEvidence)).toMatchObject({ ok: false, code: 'INVALID_CONTEXT', frame: prepared.frame });
    expect(validateWorldSectUpgradeRecordsV10(prepared.world, prepared.frame, inspectV10LifecycleRecords(prepared.world))
      .some(issue => issue.code === 'INVALID_UPGRADE_LIFETIME')).toBe(true);
    const foreign = prepareValidatedV10CultivationClock(cloneJson(source));
    expect(cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, foreign.evidence).ok).toBe(false);
    expect(cancelValidatedSectUpgradesForLifecycleV10(cloneJson(prepared.frame), prepared.context, prepared.evidence).ok).toBe(false);
    expect(cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, { ...prepared.context }, prepared.evidence).ok).toBe(false);
    const system = { kind: 'upgrade.cancel' as const, commandId: `system/v10/death/${prepared.world.cultivation.pendingDeaths[0]!.deathId}/sect-upgrade:1`,
      expectedRevision: source.sectExpansion.upgrade.revision, jobId: 'sect-upgrade:1' };
    expect(isSectUpgradeCommandV10(system)).toBe(false);
    expect(applyValidatedSectUpgradeCommandV10(prepared.frame, prepared.context, system)).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    expect(applySectUpgradeCommandV10(projectV10SectFrame(source), v10SectContext(source), system).ok).toBe(false);
  });

  it.each(['source', 'world', 'frame', 'context'] as const)('rejects %s mutation after preparing actual expiry', part => {
    const source = nearExpiry(boundaries.get(0)!); const prepared = prepareValidatedV10CultivationClock(source);
    if (part === 'source') source.seed += '.changed';
    if (part === 'world') prepared.world.cultivation.pendingDeaths[0]!.deathId = 'instance:99999';
    if (part === 'frame') (prepared.frame.upgrade as { revision: number }).revision++;
    if (part === 'context') (prepared.context as { paused: boolean }).paused = false;
    const before = canonicalStringify(prepared.frame);
    const result = cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, prepared.evidence);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_CONTEXT' }); expect(result.frame).toBe(prepared.frame);
    expect(canonicalStringify(prepared.frame)).toBe(before);
  });

  it('cancels multiple actual deaths in job order, and a second unsafe position aborts the entire batch', () => {
    const both = start(start(doubleReady, workerId, 0), 'entity:2', 1);
    const source = nearExpiry(both, [workerId, 'entity:2']); const world = cancelDeath(source);
    const jobs = world.sectExpansion.upgrade.jobs;
    expect(jobs.map(job => job.terminal?.kind)).toEqual(['cancelled', 'cancelled']);
    expect(jobs.map(job => job.terminal?.upgradeRevision)).toEqual([3, 4]);
    expect(world.sectExpansion.upgrade.receipts.slice(-2).map(receipt => receipt.jobId)).toEqual(jobs.map(job => job.jobId));
    expect(world.sectExpansion.upgrade.receipts.slice(-2).map(receipt => receipt.command.commandId)).toEqual(jobs.map(job => {
      const death = world.cultivation.pendingDeaths.find(value => value.discipleId === job.workerId)!;
      return `system/v10/death/${death.deathId}/${job.jobId}`;
    }));
    checked(world);
    const unsafe = cloneJson(source);
    // Deliberately malformed spatial source exercises rollback; no root admission is claimed.
    unsafe.disciples.find(value => value.id === 'entity:2')!.position = { x: 10, y: 1 };
    const prepared = prepareValidatedV10CultivationClock(unsafe); const before = canonicalStringify(prepared.frame);
    const result = cancelValidatedSectUpgradesForLifecycleV10(prepared.frame, prepared.context, prepared.evidence);
    expect(result).toMatchObject({ ok: false, code: 'UNSAFE_POSITION' }); expect(result.frame).toBe(prepared.frame);
    expect(canonicalStringify(prepared.frame)).toBe(before); expect(prepared.frame.upgrade.receipts).toHaveLength(2);
    expect(prepared.frame.upgrade.jobs.every(job => job.terminal === null)).toBe(true);
  });

  it('uses exact World-bound unavailable anchors, never an identity-only historical upper bound', () => {
    const world = cancelDeath(nearExpiry(boundaries.get(200)!)); const frame = projectV10SectFrame(world);
    const evidence = inspectV10LifecycleRecords(world); const identities = captureSectHistoricalIdentitiesV10(evidence, world);
    expect(validateWorldSectUpgradeRecordsV10(world, frame, evidence)).toEqual([]);
    expect(validateSectUpgradeRecordsV10(frame, identities).length).toBeGreaterThan(0);
    for (const token of [{}, { ...evidence }, JSON.parse(JSON.stringify(evidence))])
      expect(validateWorldSectUpgradeRecordsV10(world, frame, token as V10LifecycleRecordEvidence).length).toBeGreaterThan(0);
    const copied = cloneJson(world);
    expect(validateWorldSectUpgradeRecordsV10(copied, projectV10SectFrame(copied), evidence).length).toBeGreaterThan(0);
    const changedFrame = cloneJson(frame) as any; changedFrame.upgrade.jobs[0].terminal.tick--;
    expect(validateWorldSectUpgradeRecordsV10(world, changedFrame, evidence)[0]!.code).toBe('INVALID_UPGRADE_WORLD_PROJECTION');
    for (const mutation of ['death-id', 'worker', 'system-id', 'terminal-earlier', 'terminal-calendar', 'requested-system'] as const) {
      const changed = cloneJson(world) as any; const job = changed.sectExpansion.upgrade.jobs[0];
      if (mutation === 'death-id') job.terminal.cancellation.deathId = 'instance:99999';
      if (mutation === 'worker') job.workerId = 'entity:3';
      if (mutation === 'system-id') changed.sectExpansion.upgrade.receipts.at(-1).command.commandId = 'player.cancel';
      if (mutation === 'terminal-earlier') { job.terminal.tick--; job.terminal.calendarTick--; }
      if (mutation === 'terminal-calendar') job.terminal.calendarTick--;
      if (mutation === 'requested-system') job.terminal.cancellation = { kind: 'requested' };
      expect(validateWorldSectUpgradeRecordsV10(changed, projectV10SectFrame(changed), inspectV10LifecycleRecords(changed)).length).toBeGreaterThan(0);
    }
    world.seed += '.mutated'; expect(validateWorldSectUpgradeRecordsV10(world, projectV10SectFrame(world), evidence).length).toBeGreaterThan(0);
  });

  it('rejects a coherent zero-work start and death cancellation at the worker’s exact expiry boundary', () => {
    const genuine = cancelDeath(nearExpiry(boundaries.get(0)!)); checked(genuine);
    const world = cloneJson(genuine); const job = world.sectExpansion.upgrade.jobs[0]!;
    expect(job.activeTicks).toBe(0); expect(job.storageVisit).toBeNull();
    expect(job.siteVisits).toEqual([]); expect(job.workSpans).toEqual([]); expect(job.checkpoints).toEqual([]);
    // The exact receipt, death ID, full refund, revisions, origin and terminal position
    // remain coherent. Only move the zero-work start to its death cancellation tick.
    // A player start/cancel can normally share a tick, but this worker was already
    // unavailable before that tick's work and cannot start at its own expiry boundary.
    world.sectExpansion = { ...world.sectExpansion, upgrade: { ...world.sectExpansion.upgrade,
      jobs: [{ ...job, startedTick: job.terminal!.tick, startedCalendarTick: job.terminal!.calendarTick }] } };
    const issues = validateWorldSectUpgradeRecordsV10(world, projectV10SectFrame(world), inspectV10LifecycleRecords(world));
    expect(issues).toEqual([{ code: 'INVALID_UPGRADE_LIFETIME', path: job.jobId }]);
    expect(world.sectExpansion.upgrade.receipts).toEqual(genuine.sectExpansion.upgrade.receipts);
    expect(world.sectExpansion.reservations).toEqual(genuine.sectExpansion.reservations);
  });

  it('rejects requested-cancel laundering of both reason and receipt at the worker’s exact expiry tick', () => {
    const genuine = cancelDeath(nearExpiry(boundaries.get(200)!)); checked(genuine);
    const world = cloneJson(genuine); const upgrade = world.sectExpansion.upgrade;
    const job = upgrade.jobs[0]!; const terminal = job.terminal;
    if (terminal?.kind !== 'cancelled') throw new Error('Expected genuine death cancellation');
    world.sectExpansion = { ...world.sectExpansion, upgrade: { ...upgrade,
      jobs: [{ ...job, terminal: { ...terminal, cancellation: { kind: 'requested' } } }],
      receipts: upgrade.receipts.map((receipt, index) => index === upgrade.receipts.length - 1
        ? { ...receipt, command: { ...receipt.command, commandId: 'player.cancel' } } : receipt) } };
    expect(isSectUpgradeCommandV10(world.sectExpansion.upgrade.receipts.at(-1)!.command)).toBe(true);
    expect(world.sectExpansion.reservations).toEqual(genuine.sectExpansion.reservations);
    expect(world.sectExpansion.upgrade.jobs[0]!.workSpans).toEqual(job.workSpans);
    expect(validateWorldSectUpgradeRecordsV10(world, projectV10SectFrame(world), inspectV10LifecycleRecords(world)))
      .toEqual([{ code: 'INVALID_UPGRADE_LIFETIME', path: job.jobId }]);
  });

  it('preserves requested cancellation before own expiry and during another worker’s death pause', () => {
    const source = nearExpiry(boundaries.get(200)!);
    const requested = accept(applyValidatedSectUpgradeCommandV10(projectV10SectFrame(source), v10SectContext(source), {
      kind: 'upgrade.cancel', commandId: 'player.before-expiry', expectedRevision: source.sectExpansion.upgrade.revision, jobId: 'sect-upgrade:1' }));
    const earlier = cancelDeath(composeV10SectFrame(source, requested)); checked(earlier);
    expect(earlier.sectExpansion.upgrade.jobs[0]!.terminal).toMatchObject({ kind: 'cancelled', cancellation: { kind: 'requested' },
      tick: earlier.clock.simulationTick - 1 });
    const other = prepareValidatedV10CultivationClock(nearExpiry(boundaries.get(200)!, ['entity:3']));
    expect(other.context.paused).toBe(true);
    const unaffected = accept(cancelValidatedSectUpgradesForLifecycleV10(other.frame, other.context, other.evidence));
    expect(unaffected.upgrade.jobs[0]!.terminal).toBeNull();
    const cancelled = accept(applyValidatedSectUpgradeCommandV10(unaffected, other.context, {
      kind: 'upgrade.cancel', commandId: 'player.unrelated-pause', expectedRevision: unaffected.upgrade.revision, jobId: 'sect-upgrade:1' }));
    const unrelated = composeV10SectFrame(other.world, cancelled); checked(unrelated);
    expect(unrelated.sectExpansion.upgrade.jobs[0]!.terminal).toMatchObject({ kind: 'cancelled', cancellation: { kind: 'requested' },
      tick: unrelated.clock.simulationTick });
  });

  it('finalizes and archives genuine cancelled history through the fixed estate reducers', () => {
    const pending = cancelDeath(nearExpiry(boundaries.get(200)!)); const death = pending.cultivation.pendingDeaths.find(value => value.discipleId === workerId)!;
    const upgrade = cloneJson(pending.sectExpansion.upgrade);
    const finalized = prepareValidatedV10CultivationCommand(pending, { kind: 'death.finalize', commandId: 'death-test.finalize',
      expectedRevision: pending.cultivation.revision, discipleId: workerId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true });
    expect(finalized.transition.ok).toBe(true);
    // Finalization has no new unavailable boundary and cannot perform delayed cleanup.
    expect(accept(cancelValidatedSectUpgradesForLifecycleV10(finalized.frame, finalized.context, finalized.evidence)).upgrade).toEqual(upgrade);
    expect(() => inspectV10LifecycleRecords(finalized.world)).toThrow();
    const responsibilities = prepareEstateResponsibilities(finalized.world); if (!responsibilities.ok) throw new Error(responsibilities.details.join('; '));
    const source = { ...finalized.world, legacy: responsibilities.legacy };
    expect(v10WorkOwners(source)).toEqual([]);
    const settlement = prepareEstateSettlement(source, managementV10BuildContext(source.contentIdentity));
    if (!settlement.ok) throw new Error(settlement.details.join('; '));
    const archived: WorldStateV10 = { ...source, ...settlement.frame, sectEconomy: { ...source.sectEconomy,
      plans: source.sectEconomy.plans.filter(plan => !settlement.retiredDiscipleIds.includes(plan.workerId)) } };
    expect(archived.disciples.some(value => value.id === workerId)).toBe(false);
    expect(archived.cultivation.archivedDisciples.some(value => value.discipleId === workerId)).toBe(true);
    expect(archived.sectExpansion.upgrade).toEqual(upgrade); checked(archived); checked(JSON.parse(JSON.stringify(archived)) as WorldStateV10);
    const identity = captureSectHistoricalIdentitiesV10(inspectV10LifecycleRecords(archived), archived);
    expect(validateSectUpgradeRecordsV10(projectV10SectFrame(archived), identity).length).toBeGreaterThan(0);
  });
});
