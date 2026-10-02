import { describe, expect, it } from 'vitest';
import { createCultivationStateV3, previewBreakthroughV3 } from '../../src/core/cultivation/v3';
import type { PlayerCultivationCommand } from '../../src/core/kernel/contracts';
import { CALENDAR_TICKS_PER_MONTH, setPauseReason } from '../../src/core/kernel/clock';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { inspectUnregisteredWorldV9Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import type { MigrationIssueV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { admitSaveWorldV9, V9_SAVE_JSON_MAX_DEPTH } from '../../src/core/world/save-admission-v9';
import { inspectQuietV9ToV10Boundary } from '../../src/core/world/v10-migration-boundary';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCareStart, fixtureCommand, fixturePlace, fixtureProduce, fixtureResearchStart,
  fixtureSectCommand, fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture, recordChecked } from './fixtures/v9-runtime';

function inspectUnchanged(world: WorldStateV9): readonly MigrationIssueV10[] {
  const before = canonicalStringify(world);
  const issues = inspectQuietV9ToV10Boundary(world);
  expect(canonicalStringify(world)).toBe(before);
  return issues;
}
function admitted(world: WorldStateV9): WorldStateV9 {
  const result = admitSaveWorldV9(world);
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  return world;
}
function cultivation(world: WorldStateV9, command: PlayerCultivationCommand): WorldStateV9 {
  return fixtureApply(world, fixtureCommand(world, { kind: 'cultivation.command', payload: { command } }, command.commandId));
}
function scheduler(world: WorldStateV9, enabled: boolean, commandId: string): WorldStateV9 {
  return fixtureApply(world, fixtureCommand(world, { kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled } } }, commandId));
}
function planned(world: WorldStateV9): WorldStateV9 {
  return fixtureApply(world, fixtureCommand(world, { kind: 'sect-economy.command', payload: { command: { kind: 'plan.set',
    plan: { workerId: 'entity:2', enabled: true, priorities: [{ recipeId: 'gather.wood', targetStock: 999 }] } } } }, 'boundary.plan'));
}
/** Explicit authored knowledge origin; all lesson commands below are real. */
function teachingOrigin(): WorldStateV9 {
  const world = fundedRuntimeFixture();
  world.cultivation = createCultivationStateV3(world.cultivation.disciples.map((profile, index) => ({ ...profile,
    knowledge: [{ knowledgeId: index % 2 ? 'knowledge.boundary-b' : 'knowledge.boundary-a', teacherId: null, teachingId: null }] })));
  return recordChecked(world);
}
function startLesson(world: WorldStateV9, teacher = 'entity:1', student = 'entity:2', knowledgeId = 'knowledge.boundary-a', commandId = 'boundary.lesson'): WorldStateV9 {
  return cultivation(world, { kind: 'teaching.begin', commandId, expectedRevision: world.cultivation.revision,
    discipleId: teacher, studentId: student, knowledgeId });
}

describe('pure quiet v9 source diagnostics, without a v10 admission claim', () => {
  it('accepts a fully funded fresh source without advancing, converting or freezing it', () => {
    const source = admitted(createUnregisteredWorldV9('boundary-fresh'));
    expect(inspectUnchanged(source)).toEqual([]);
    expect(source.simulationVersion).toBe('0.9.0'); expect(source.sectExpansion.schemaVersion).toBe(1);
    expect(Object.hasOwn(source.sectExpansion, 'upgrade')).toBe(false);
    expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(source.inventory)).toBe(false);
  });

  it('preserves training/rest, disabled-but-enabled individual plans, review state, player/hidden pause and speed', () => {
    let source = planned(createUnregisteredWorldV9('boundary-settings'));
    source = cultivation(source, { kind: 'training.set', commandId: 'boundary.training', expectedRevision: source.cultivation.revision,
      discipleId: 'entity:2', mode: 'training' });
    source = cultivation(source, { kind: 'training.set', commandId: 'boundary.rest', expectedRevision: source.cultivation.revision,
      discipleId: 'entity:4', mode: 'rest' });
    // Legal settings fixture, not a manufactured progression or work history.
    source.automaticProduction.activationReviewRequired = true;
    source.sectEconomy.nextDecisionTick = 20;
    source.clock = { ...setPauseReason(setPauseReason(source.clock, 'hidden', true), 'player', true), speed: 3 };
    expect(inspectUnchanged(admitted(source))).toEqual([]);
    expect(source.sectEconomy.plans[0]!.enabled).toBe(true);
    expect(source.clock).toMatchObject({ speed: 3, pauseReasons: ['player', 'hidden'], simulationTick: 0 });
  });

  it('reports legacy work and worker assignments, then allows genuine cancelled archive history', () => {
    const initial = createUnregisteredWorldV9('boundary-legacy');
    const source = fixtureApply(initial, fixtureCommand(initial,
      { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }, 'boundary.legacy.start'));
    const issues = inspectUnchanged(admitted(source));
    expect(issues).toContainEqual({ code: 'ACTIVE_WORK', path: 'activeProductionTransactionIds[0]' });
    expect(issues).toContainEqual({ code: 'ACTIVE_WORK', path: 'disciples[1].assignmentTransactionId' });
    const cancelled = fixtureApply(source, fixtureCommand(source, { kind: 'production.cancel',
      payload: { transactionId: source.activeProductionTransactionIds[0]! } }, 'boundary.legacy.cancel'));
    expect(cancelled.history.production.count).toBe(1);
    expect(inspectUnchanged(admitted(cancelled))).toEqual([]);
  });

  it('reports enabled automatic scheduling even with no live jobs and keeps its live job after disabling', () => {
    let source = scheduler(planned(createUnregisteredWorldV9('boundary-auto')), true, 'boundary.auto.enable');
    expect(inspectUnchanged(admitted(source))).toEqual([{ code: 'AUTOMATIC_WORK_ENABLED', path: 'sectEconomy.enabled' }]);
    source = recordChecked(prepareNormalTickCandidateV9(source));
    const id = source.activeProductionTransactionIds[0]!;
    expect(id).toMatch(/^auto-job\//);
    source = scheduler(source, false, 'boundary.auto.disable');
    const issues = inspectUnchanged(admitted(source));
    expect(issues).toContainEqual({ code: 'ACTIVE_WORK', path: `automaticProduction.live[${JSON.stringify(id)}]` });
    expect(issues.some(issue => issue.code === 'AUTOMATIC_WORK_ENABLED')).toBe(false);
    const cancelled = fixtureApply(source, fixtureCommand(source, { kind: 'production.cancel', payload: { transactionId: id } }, 'boundary.auto.cancel'));
    expect(Object.keys(cancelled.automaticProduction.pins)).toContain(id);
    expect(inspectUnchanged(admitted(cancelled))).toEqual([]);
    expect(cancelled.sectEconomy.plans).toEqual(source.sectEconomy.plans);
    expect(cancelled.sectEconomy.nextDecisionTick).toBe(source.sectEconomy.nextDecisionTick);
  });

  it('lists all independent planned blueprints without cancelling them', () => {
    let source = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
    source = fixturePlace(source, 'library.v9', 10);
    expect(inspectUnchanged(admitted(source))).toEqual([
      { code: 'PLANNED_BLUEPRINT', path: 'sectExpansion.construction.blueprints[0]' },
      { code: 'PLANNED_BLUEPRINT', path: 'sectExpansion.construction.blueprints[1]' },
    ]);
    for (const blueprint of source.sectExpansion.construction.blueprints) {
      source = fixtureApply(source, fixtureSectCommand(source, { domain: 'construction', command: { kind: 'construction.cancel',
        commandId: `boundary.cancel.${blueprint.blueprintId}`, expectedRevision: source.sectExpansion.construction.revision, blueprintId: blueprint.blueprintId } }));
    }
    expect(inspectUnchanged(admitted(source))).toEqual([]);
    expect(source.sectExpansion.construction.blueprints.every(blueprint => blueprint.status === 'cancelled')).toBe(true);
  });

  it('preserves genuine permanent loadout history and the fixed old build identity', () => {
    let source = createUnregisteredWorldV9('boundary-build'); const disciple = source.builds.disciples[0]!;
    const loadout = cloneJson(disciple.loadout); loadout.activeSkillIds = [loadout.activeSkillIds[1], loadout.activeSkillIds[0]];
    source = fixtureApply(source, fixtureCommand(source, { kind: 'build.command', payload: { command: { kind: 'loadout.set',
      commandId: 'boundary.loadout', expectedRevision: source.builds.revision, discipleId: disciple.discipleId, loadout } } }, 'boundary.loadout'));
    expect(source.builds.history).toHaveLength(1);
    expect(inspectUnchanged(admitted(source))).toEqual([]);
  });
});

let journey: WorldStateV9;
describe('real construction, research, production and care boundaries', () => {
  it('rejects genuine construction and accepts its completed building and payment history', () => {
    journey = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1));
    expect(inspectUnchanged(admitted(journey))).toContainEqual({ code: 'ACTIVE_WORK', path: 'sectExpansion.construction.jobs[0]' });
    journey = fixtureUntil(journey, world => !!world.sectExpansion.construction.jobs[0]!.terminal);
    expect(inspectUnchanged(admitted(journey))).toEqual([]);
  });
  for (const [index, recipe] of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'].entries()) {
    it(`keeps genuine completed research-material work ${index + 1}`, () => {
      journey = fixtureProduce(journey, recipe as 'extract.spirit-stone.v9' | 'study.basic-insight.v9');
      expect(inspectUnchanged(admitted(journey))).toEqual([]);
    });
  }
  it('rejects genuine research until its normal completion', () => {
    journey = fixtureResearchStart(journey);
    expect(inspectUnchanged(admitted(journey))).toContainEqual({ code: 'ACTIVE_WORK', path: 'sectExpansion.research.jobs[0]' });
    journey = fixtureUntil(journey, world => !!world.sectExpansion.research.jobs[0]!.terminal);
    expect(inspectUnchanged(admitted(journey))).toEqual([]);
  });
  it('keeps genuine research-gated alchemy construction history', () => {
    journey = fixtureStartConstruction(fixturePlace(journey, 'alchemy.v9', 10));
    journey = fixtureUntil(journey, world => !!world.sectExpansion.construction.jobs.at(-1)!.terminal);
    expect(inspectUnchanged(admitted(journey))).toEqual([]);
  });
  it('rejects genuine powder work after the seat is released but before storage delivery', () => {
    journey = fixtureApply(journey, fixtureSectCommand(journey, { domain: 'production', command: { kind: 'production.start',
      commandId: 'boundary.powder', expectedRevision: journey.sectExpansion.production.revision,
      recipeId: 'craft.wound-powder.v9', workerId: 'entity:2' } }));
    journey = fixtureUntil(journey, world => world.sectExpansion.production.jobs.at(-1)!.phase === 'TravellingToStorage');
    const index = journey.sectExpansion.production.jobs.length - 1;
    expect(journey.sectExpansion.production.jobs[index]!.seatSiteId).toBeNull();
    expect(inspectUnchanged(admitted(journey))).toContainEqual({ code: 'ACTIVE_WORK', path: `sectExpansion.production.jobs[${index}]` });
    journey = fixtureUntil(journey, world => !!world.sectExpansion.production.jobs.at(-1)!.terminal);
    expect(inspectUnchanged(admitted(journey))).toEqual([]);
    expect(journey.sectExpansion.stock['wound-powder'].owned).toBe(1);
  });
  it('rejects genuine care until normal completion, preserving its effect and dose history', () => {
    journey = fixtureCareStart(journey, 'boundary.care');
    expect(inspectUnchanged(admitted(journey))).toContainEqual({ code: 'ACTIVE_WORK', path: 'sectExpansion.care.jobs[0]' });
    journey = fixtureUntil(journey, world => !!world.sectExpansion.care.jobs[0]!.terminal);
    expect(journey.sectExpansion.care.jobs[0]!.terminal?.effect).toMatchObject({ beforeInjury: 25, afterInjury: 5 });
    expect(inspectUnchanged(admitted(journey))).toEqual([]);
  });
  it('allows expired maintenance without prepayment, changing due dates, healing or clearing history', () => {
    journey = fixtureApply(journey, fixtureCommand(journey, { kind: 'inventory.discard',
      payload: { resourceId: 'wood', quantity: journey.inventory.wood.owned } }, 'boundary.expire.wood'));
    const alchemy = journey.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!;
    const latest = journey.sectExpansion.maintenance.payments.filter(payment => payment.buildingId === alchemy.buildingId).at(-1);
    const due = latest?.dueCalendarTick ?? alchemy.firstMaintenanceCalendarTick;
    journey = fixtureUntil(journey, world => world.clock.calendarTick >= due);
    expect(journey.inventory.wood.owned).toBe(0);
    expect(inspectUnchanged(admitted(journey))).toEqual([]);
  });
});

describe('progression, pending lifecycle and settled history', () => {
  it('rejects real Reserved, InSeclusion and DecisionReady attempts and preserves the resolved result', () => {
    let source = fundedRuntimeFixture();
    // Explicit zero-history cultivation fixture; confirmation, seclusion, decision
    // and resolution are the actual domain operations, with all real clock ticks.
    source.cultivation.disciples[1]!.cultivation = 120;
    source = cultivation(recordChecked(source), { kind: 'breakthrough.confirm', commandId: 'boundary.confirm',
      expectedRevision: source.cultivation.revision, preview: previewBreakthroughV3(source, 'entity:2') });
    const expected = { code: 'ACTIVE_PROGRESSION', path: 'cultivation.attempts[0]' };
    expect(source.cultivation.attempts[0]!.phase).toBe('Reserved');
    expect(inspectUnchanged(admitted(source))).toContainEqual(expected);
    source = cultivation(source, { kind: 'breakthrough.begin', commandId: 'boundary.begin',
      expectedRevision: source.cultivation.revision, attemptId: source.cultivation.attempts[0]!.attemptId });
    expect(source.cultivation.attempts[0]!.phase).toBe('InSeclusion');
    expect(inspectUnchanged(admitted(source))).toContainEqual(expected);
    source = fixtureUntil(source, world => world.cultivation.attempts[0]!.phase === 'DecisionReady');
    expect(inspectUnchanged(admitted(source))).toContainEqual(expected);
    source = cultivation(source, { kind: 'breakthrough.resolve', commandId: 'boundary.resolve',
      expectedRevision: source.cultivation.revision, attemptId: source.cultivation.attempts[0]!.attemptId, acknowledgeRisk: true });
    expect(source.cultivation.attempts[0]!.phase).toBe('Resolved');
    expect(inspectUnchanged(admitted(source))).toEqual([]);
  });

  it('rejects supported disjoint teaching without silently resolving or cancelling it', () => {
    const source = startLesson(teachingOrigin());
    expect(inspectUnchanged(admitted(source))).toEqual([{ code: 'ACTIVE_PROGRESSION', path: 'cultivation.disciples[0].teaching' }]);
  });

  it('rejects a real pending death and allows the genuine settled estate, retirement and archive', () => {
    let source = createUnregisteredWorldV9('boundary-lifecycle'); const actor = source.disciples[1]!; const profile = source.cultivation.disciples[1]!;
    // Explicit zero-history age boundary; the pending death, estate and archive
    // are created by the real tick and acknowledged finalization command.
    actor.birthCalendarTick = 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
    actor.ageMonths = Math.floor(-actor.birthCalendarTick / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
    source = recordChecked(prepareNormalTickCandidateV9(recordChecked(source)));
    expect(inspectUnchanged(admitted(source))).toContainEqual({ code: 'PENDING_LIFECYCLE', path: 'cultivation.pendingDeaths[0]' });
    const death = source.cultivation.pendingDeaths[0]!;
    source = cultivation(source, { kind: 'death.finalize', commandId: 'boundary.finalize', expectedRevision: source.cultivation.revision,
      discipleId: death.discipleId, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true });
    expect(source.legacy.estates[0]!.settledMonth).not.toBeNull();
    expect(source.builds.retiredDisciples).toHaveLength(1); expect(source.cultivation.archivedDisciples).toHaveLength(1);
    expect(inspectUnchanged(admitted(source))).toEqual([]);
  });
});

describe('original strict admission precedes all quiet-boundary reads', () => {
  it.each(['fresh-management-v9-unregistered.1', 'fresh-management-v9-unregistered.2'])('rejects unsupported source %s without relabelling it', protocol => {
    const source = Object.assign(createUnregisteredWorldV9(), { runtimeProtocol: protocol }) as WorldStateV9;
    expect(inspectUnchanged(source)).toEqual([{ code: 'UNSUPPORTED_SOURCE', path: '$' }]);
  });
  it('rejects old simulation and mismatched content identities', () => {
    const simulation = Object.assign(createUnregisteredWorldV9(), { simulationVersion: '0.8.0' }) as WorldStateV9;
    expect(inspectUnchanged(simulation)).toEqual([{ code: 'UNSUPPORTED_SOURCE', path: 'simulationVersion' }]);
    const content = createUnregisteredWorldV9(); content.contentIdentity.compositeFingerprint = '00000000';
    expect(inspectUnchanged(content)).toEqual([{ code: 'UNSUPPORTED_SOURCE', path: 'contentIdentity' }]);
  });
  it('rejects record-valid unsupported teaching rather than treating a record-only pass as save authority', () => {
    let source = startLesson(teachingOrigin());
    source = startLesson(source, 'entity:2', 'entity:3', 'knowledge.boundary-b', 'boundary.chain');
    expect(inspectUnregisteredWorldV9Records(source)).toEqual([]);
    expect(admitSaveWorldV9(source)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCOPE' } });
    expect(inspectUnchanged(source)).toEqual([{ code: 'UNSUPPORTED_SOURCE', path: '$' }]);
  });
  it('rejects a real planned source with deliberately deficient future revision headroom', () => {
    let source = fixturePlace(fundedRuntimeFixture(), 'library.v9', 1);
    // Intentionally valid pressure fixture, not organic play. Record validity
    // does not imply funded continuation; never cancel its plan to make it fit.
    source = { ...source, sectExpansion: { ...source.sectExpansion, construction: {
      ...source.sectExpansion.construction, revision: Number.MAX_SAFE_INTEGER - 1 } } };
    expect(inspectUnregisteredWorldV9Records(source)).toEqual([]);
    expect(admitSaveWorldV9(source)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SCOPE' } });
    expect(inspectUnchanged(source)).toEqual([{ code: 'UNSUPPORTED_SOURCE', path: '$' }]);
  });

  const invalidFixtures: [string, (world: WorldStateV9) => void][] = [
    ['pending command', world => { world.pendingCommands.push({ kind: 'production.start', commandId: 'queued', sequence: 0,
      issuedTick: 0, payload: { recipeId: 'craft.plank', workerId: 'entity:2' } }); }],
    ['activity owner', world => { world.cultivation.disciples[1]!.activityOwner = { kind: 'expedition', runId: 'action:1', lockId: 'instance:1' }; }],
    ['build lock', world => { world.builds.disciples[1]!.lock = { runId: 'action:1', lockId: 'instance:1', loadoutHash: 'fake' }; }],
    ['unarchived corpse', world => { world.disciples[1]!.lifeState = 'dead'; world.cultivation.disciples[1]!.lifeState = 'dead'; }],
    ['unsettled estate', world => { world.legacy.estates.push({ estateId: 'estate/fake', deathId: 'fake', discipleId: 'entity:2', beneficiaryId: null,
      itemInstanceIds: [], pendingRunId: null, transferCommandIds: [], recordedMonth: 0, settledMonth: null, settledOwner: null }); }],
    ['dangling worker assignment', world => { world.disciples[1]!.assignmentTransactionId = 'instance:999'; }],
    ['dangling station claim', world => { world.buildings[0]!.stationTransactionId = 'instance:999'; }],
    ['unsupported expedition', world => { world.expedition.routeId = 'route.qingfeng-trial'; }],
    ['unfunded inventory reservation', world => { world.inventory.wood.reserved = 1; }],
  ];
  for (const [label, corrupt] of invalidFixtures) it(`intentionally invalid fixture: ${label} cannot bypass original admission`, () => {
    const source = createUnregisteredWorldV9(); corrupt(source);
    expect(admitSaveWorldV9(source)).toMatchObject({ ok: false, error: { code: 'INVALID_WORLD' } });
    expect(inspectUnchanged(source)).toEqual([{ code: 'INVALID_SOURCE', path: '$' }]);
  });

  it('never invokes top-level/nested getters, toJSON or caller-thrown error accessors', () => {
    let reads = 0; const getter = (): never => { reads++; throw new Error('Do not execute'); };
    const top = Object.defineProperty(createUnregisteredWorldV9(), 'pendingCommands', { enumerable: true, get: getter });
    const nested = createUnregisteredWorldV9(); Object.defineProperty(nested.inventory.wood, 'owned', { enumerable: true, get: getter });
    const toJSON = Object.defineProperty(createUnregisteredWorldV9(), 'toJSON', { enumerable: true, get: getter });
    const error = new Proxy({}, { get: getter, getPrototypeOf: getter });
    const proxy = new Proxy({}, { ownKeys() { throw error; } }) as WorldStateV9;
    for (const source of [top, nested, toJSON, proxy]) expect(inspectQuietV9ToV10Boundary(source)).toEqual([{ code: 'INVALID_SOURCE', path: '$' }]);
    expect(reads).toBe(0);
  });
  it('rejects malformed, sparse, cyclic, exotic and over-deep values before domain iteration', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const source = createUnregisteredWorldV9(); source.pendingCommands = new Array(0xffffffff);
    const deep = JSON.parse(`${'['.repeat(V9_SAVE_JSON_MAX_DEPTH + 2)}0${']'.repeat(V9_SAVE_JSON_MAX_DEPTH + 2)}`) as unknown;
    for (const value of [null, undefined, NaN, Infinity, new Date(), cyclic, source, deep]) {
      expect(inspectQuietV9ToV10Boundary(value as WorldStateV9)).toEqual([{ code: 'INVALID_SOURCE', path: '$' }]);
    }
  });
  it('retains the original bounded byte rejection without attempting a quiet scan', () => {
    const source = createUnregisteredWorldV9(); source.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: 'x'.repeat(SAVE_FILE_LIMIT_BYTES) });
    expect(inspectQuietV9ToV10Boundary(source)).toEqual([{ code: 'CAPACITY_EXCEEDED', path: '$' }]);
  });
});
