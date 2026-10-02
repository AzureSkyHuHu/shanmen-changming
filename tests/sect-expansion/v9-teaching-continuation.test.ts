import { describe, expect, it } from 'vitest';
import { createCultivationStateV3, previewBreakthroughV3 } from '../../src/core/cultivation/v3';
import type { PlayerCultivationCommand } from '../../src/core/kernel/contracts';
import { CALENDAR_TICKS_PER_MONTH as T, setPauseReason } from '../../src/core/kernel/clock';
import { dispatchUnregisteredCommandV9, prepareUnregisteredCommandCandidateV9 } from '../../src/core/kernel/commands-v9';
import type { CommandV9 } from '../../src/core/kernel/contracts-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9 } from '../../src/core/kernel/simulation-v9';
import { inspectUnregisteredWorldV9Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { deriveProgressionReservations } from '../../src/core/save-budget/progression-bounds';
import { assessHistorySlots } from '../../src/core/save-budget/retention';
import { deriveProgressionReservationsTimeV9 } from '../../src/core/save-budget/progression-time-v9';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV9, assessTeachingManagementCapacityV9 as capacity } from '../../src/core/world/management-capacity-v9';
import { advanceCapacityLimitedTicksV9, dispatchCapacityLimitedCommandV9, verifyCapacityLimitedCandidateV9 } from '../../src/core/world/runtime-capacity-v9';
import { createPrivateRuntimeV9, type PrivateRuntimeInstanceV9 } from '../../src/core/world/runtime-instance-v9';
import { authenticTeachingTransitionV9, inspectTeachingContinuationV9 } from '../../src/core/world/teaching-continuation-v9';
import { deriveV9BuildObligationFacts } from '../../src/core/world/v9-record-headroom';
import { V9_CULTIVATION_CLOCK_LIMIT } from '../../src/core/world/v9-cultivation-clock-types';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixtureApply, fixtureCommand, fixturePlace, fixtureStartConstruction, recordChecked } from './fixtures/v9-runtime';

const MAX = Number.MAX_SAFE_INTEGER;
const A = 'knowledge.lesson-a'; const B = 'knowledge.lesson-b';
/** Explicit authored knowledge/stat origins, not a claim of campaign acquisition. */
function origin(): WorldStateV9 {
  const world = createUnregisteredWorldV9('finite-teaching');
  world.cultivation = createCultivationStateV3(world.cultivation.disciples.map((profile, index) => ({ ...profile, cultivation: 120,
    knowledge: [{ knowledgeId: index % 2 ? B : A, teacherId: null, teachingId: null }] })));
  for (const row of Object.values(world.inventory)) row.owned = Math.min(80, row.capacity);
  return recordChecked(world);
}
function inner(world: WorldStateV9, command: PlayerCultivationCommand): CommandV9 {
  return fixtureCommand(world, { kind: 'cultivation.command', payload: { command } }, command.commandId);
}
function lesson(world: WorldStateV9, teacher = 'entity:1', student = 'entity:2', knowledgeId = A, id = 'lesson.start'): CommandV9 {
  return inner(world, { kind: 'teaching.begin', commandId: id, expectedRevision: world.cultivation.revision, discipleId: teacher, studentId: student, knowledgeId });
}
function accepted(world: WorldStateV9, command: CommandV9): WorldStateV9 {
  const applied = dispatchCapacityLimitedCommandV9(world, command); expect(applied.result.status, JSON.stringify(applied.result)).toBe('accepted');
  return recordChecked(applied.world);
}
function started(source = origin()): WorldStateV9 { return accepted(source, lesson(source)); }
/** Within-month arithmetic source fixture only. Full flows below never use it. */
function atPhase(source: WorldStateV9, phase: number): WorldStateV9 {
  const world = cloneJson(source); world.clock.calendarTick = phase; world.clock.simulationTick = phase; return recordChecked(world);
}
function birthday(source: WorldStateV9, ids: string[], residue: number, expiry = false): WorldStateV9 {
  const world = cloneJson(source);
  for (const id of ids) {
    const actor = world.disciples.find(actor => actor.id === id)!; const profile = world.cultivation.disciples.find(profile => profile.discipleId === id)!;
    actor.birthCalendarTick = residue - (expiry ? profile.lifespanMonths : profile.ageMonths) * T;
    actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / T); profile.ageMonths = actor.ageMonths;
  }
  return recordChecked(world);
}
function setRevision(world: WorldStateV9, domain: 'construction' | 'production' | 'research', revision: number): void {
  world.sectExpansion = { ...world.sectExpansion, [domain]: { ...world.sectExpansion[domain], revision } };
}
function proof(world: WorldStateV9) { return inspectTeachingContinuationV9(world, capacity(world)); }
function runtime(world: WorldStateV9): PrivateRuntimeInstanceV9 {
  const created = createPrivateRuntimeV9(world); expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error('Expected a private finite-teaching runtime'); return created.instance;
}
function freeze(value: unknown): void { if (typeof value !== 'object' || value === null) return; Object.values(value).forEach(freeze); Object.freeze(value); }

describe('v9 phase-aware finite reservations, separate from old numeric evidence', () => {
  for (const phase of [0, 1, 1199]) for (const count of [1, 2]) it(`sums ${count} disjoint lesson months and subtracts phase ${phase} once`, () => {
    let world = atPhase(origin(), phase); world = started(world);
    if (count === 2) world = accepted(world, lesson(world, 'entity:3', 'entity:4', A, 'lesson.second'));
    const old = assessManagementCapacityV9(world); const next = capacity(world);
    expect(old.supported).toBe(true); expect(next.supported).toBe(true); expect(proof(world).supported).toBe(true);
    const sumMonths = count * 2; const horizon = sumMonths * T - phase;
    expect(old.progression!.totals.counterReserve.calendarTicks).toBe(sumMonths * T);
    expect(next.progression!.totals.counterReserve.calendarTicks).toBe(horizon);
    expect(next.clock).toMatchObject({ calendarTicks: horizon, monthRows: sumMonths, ageSyncRows: 0, additionalActions: 0 });
    for (const name of ['construction', 'production', 'research']) {
      expect(next.reserved[`sect.${name}Revision`]).toBe(old.reserved[`sect.${name}Revision`]! + horizon);
    }
    expect(next.reserved.simulationTick).toBe(horizon); expect(next.reserved.calendarTick).toBe(horizon);
    expect(next.reserved['sequence.nextAction']).toBe(old.reserved['sequence.nextAction']);
    expect(next.reserved.cultivationRevision).toBe(old.reserved.cultivationRevision);
    expect(next.clock!.lifecycleTriggerRows).toBe(world.disciples.length);
  });
  it('coalesces the real month tick for two disjoint lessons while keeping the summed-month upper bound', () => {
    let world = started(atPhase(origin(), T - 1)); world = accepted(world, lesson(world, 'entity:3', 'entity:4', A, 'coalesced.second'));
    const before = capacity(world); const step = advanceCapacityLimitedTicksV9(world, 1); expect(step.stopped).toBeNull();
    expect(step.world.cultivationClock.transitions).toHaveLength(1);
    expect(step.world.cultivation.disciples.filter(profile => profile.teaching).map(profile => profile.teaching!.completedMonths)).toEqual([1, 1]);
    const after = capacity(step.world); expect(before.clock!.calendarTicks).toBe(3 * T + 1); expect(after.clock!.calendarTicks).toBe(2 * T);
    expect(after.reserved['sequence.nextAction']).toBe(before.reserved['sequence.nextAction']! - 2);
    expect(after.current['sequence.nextAction']).toBe(before.current['sequence.nextAction']! + 1);
  });
  it('computes genuinely new numeric evidence using H rather than repairing an old failure (unreachable arithmetic fixture)', () => {
    const world = started(); const facts = deriveV9BuildObligationFacts(world);
    // Deliberately NOT a structurally valid .3 clock/history. This tests arithmetic,
    // never source admission or billions of allegedly simulated years.
    world.clock.calendarTick = MAX - 2399; world.clock.simulationTick = MAX - 2399;
    const old = deriveProgressionReservations({ world, buildFacts: facts }); const oldText = canonicalStringify(old);
    const current = deriveProgressionReservationsTimeV9({ world, buildFacts: facts });
    const horizon = 2 * T - world.clock.calendarTick % T;
    expect(horizon).toBeLessThanOrEqual(2399); expect(old.numeric.fits).toBe(false); expect(current.numeric.fits).toBe(true);
    expect(current.totals.counterReserve.calendarTicks).toBe(horizon); expect(canonicalStringify(old)).toBe(oldText);
    expect(old.numeric.diagnostics).toContain('Insufficient terminal World calendar tick headroom');
    expect(capacity(world).supported).toBe(false); expect(createPrivateRuntimeV9(world).ok).toBe(false);
  });
  for (const phase of [0, 1, 1199]) it(`spends exactly one per-tick horizon at phase ${phase} until a real month coalesces`, () => {
    const source = started(atPhase(origin(), phase)); const before = capacity(source); const result = advanceCapacityLimitedTicksV9(source, 1);
    expect(result.stopped).toBeNull(); const after = capacity(result.world);
    expect(after.reserved.calendarTick).toBe(before.reserved.calendarTick! - 1);
    for (const name of ['construction', 'production', 'research']) {
      expect(after.current[`sect.${name}Revision`]).toBe(before.current[`sect.${name}Revision`]! + 1);
      expect(after.reserved[`sect.${name}Revision`]).toBe(before.reserved[`sect.${name}Revision`]! - 1);
      expect(after.costs[`sect.${name}Revision`]).toBe(before.costs[`sect.${name}Revision`]);
    }
    expect(authenticTeachingTransitionV9(source, result.world)).toBe(true);
  });
  it('counts grouped off-month birthdays exactly in the finite interval and excludes a birthday at the current boundary', () => {
    let world = birthday(origin(), ['entity:1', 'entity:2'], 7); world = started(world);
    const first = capacity(world); expect(first.clock).toMatchObject({ monthRows: 2, ageSyncRows: 2, additionalActions: 2, additionalCultivationRevisions: 2 });
    const step = advanceCapacityLimitedTicksV9(world, 7); expect(step.stopped).toBeNull(); world = step.world;
    expect(world.cultivationClock.transitions).toHaveLength(1); expect(world.cultivationClock.transitions[0]!.kind).toBe('age-sync');
    const after = capacity(world); expect(after.clock!.ageSyncRows).toBe(1);
    expect(after.reserved['sequence.nextAction']).toBe(after.progression!.totals.sequenceReserve.nextAction + 1);
    expect(after.reserved.cultivationRevision).toBe(after.progression!.totals.counterReserve.cultivationRevisions + 1);
    expect(after.costs['sequence.nextAction']).toBe(first.costs['sequence.nextAction']);
  });
  it('preserves pauses and resumes at the same remaining horizon without spending IDs, rows or revisions', () => {
    let world = started(); world.clock = setPauseReason(world.clock, 'player', true); const before = canonicalStringify(world); const budget = capacity(world);
    const paused = advanceCapacityLimitedTicksV9(world, T); expect(paused.stopped).toBeNull(); expect(canonicalStringify(paused.world)).toBe(before);
    expect(capacity(paused.world).reserved).toEqual(budget.reserved);
    const instance = runtime(world); expect(instance.advance(T).advancedTicks).toBe(0);
    world = cloneJson(world); world.clock = setPauseReason(world.clock, 'player', false); expect(instance.replace(world).ok).toBe(true);
    expect(instance.advance(1).advancedTicks).toBe(1); expect(instance.snapshot().world).toEqual(advanceCapacityLimitedTicksV9(world, 1).world);
  });
});

describe('source and candidate role/transition authentication', () => {
  it('rejects unsupported chains atomically and preserves deterministic .3 cycle rejection receipts', () => {
    const world = started(); const command = lesson(world, 'entity:2', 'entity:3', B, 'lesson.chain'); const before = canonicalStringify(world);
    const legacy = dispatchUnregisteredCommandV9(world, command); expect(legacy.result.status).toBe('accepted');
    const gated = dispatchCapacityLimitedCommandV9(world, command); expect(gated.result.rejection?.code).toBe('UNSUPPORTED_CONTINUATION');
    expect(gated.world).toBe(world); expect(canonicalStringify(world)).toBe(before);
    expect(proof(legacy.world).supported).toBe(false); expect(createPrivateRuntimeV9(legacy.world).ok).toBe(false);
    expect(advanceCapacityLimitedTicksV9(legacy.world, 1).stopped?.kind).toBe('unsupported-continuation');
    const cycle = lesson(world, 'entity:2', 'entity:1', B, 'lesson.cycle');
    const oldCycle = dispatchUnregisteredCommandV9(world, cycle); const gatedCycle = dispatchCapacityLimitedCommandV9(world, cycle);
    expect(gatedCycle.result).toEqual({ commandId: cycle.commandId, status: 'rejected', transactionId: null, eventIds: [],
      rejection: { code: 'CULTIVATION_REJECTED', cultivationCode: 'DISCIPLE_UNAVAILABLE' } });
    expect(gatedCycle).toEqual(oldCycle);
    // Unlike an unsupported capacity candidate, this is the real domain's
    // rejection. The established .3 boundary records its deterministic receipt.
    const { commandReceipts: recorded, ...afterDomains } = gatedCycle.world;
    const { commandReceipts: previousReceipts, ...beforeDomains } = world;
    expect(afterDomains).toEqual(beforeDomains);
    expect(recorded).toEqual({ ...previousReceipts, [cycle.commandId]: { commandId: cycle.commandId,
      fingerprint: canonicalStringify({ kind: cycle.kind, payload: cycle.payload }), result: gatedCycle.result } });
    const retry = dispatchCapacityLimitedCommandV9(gatedCycle.world, cycle); const oldRetry = dispatchUnregisteredCommandV9(oldCycle.world, cycle);
    expect(retry.world).toBe(gatedCycle.world); expect(oldRetry.world).toBe(oldCycle.world);
    expect(retry.result).toEqual(gatedCycle.result); expect(retry).toEqual(oldRetry);
    expect(canonicalStringify(world)).toBe(before);
  });
  it('rejects student breakthroughs which the real .3 reducer can accept and would indefinitely block teaching', () => {
    const world = started(); const command = inner(world, { kind: 'breakthrough.confirm', commandId: 'student.attempt', expectedRevision: world.cultivation.revision,
      preview: previewBreakthroughV3(world, 'entity:2') });
    const old = dispatchUnregisteredCommandV9(world, command); expect(old.result.status).toBe('accepted');
    expect(proof(old.world).supported).toBe(false); expect(createPrivateRuntimeV9(old.world).ok).toBe(false);
    const gated = dispatchCapacityLimitedCommandV9(world, command); expect(gated.result.rejection?.code).toBe('UNSUPPORTED_CONTINUATION'); expect(gated.world).toBe(world);
    const instance = runtime(world); expect(instance.command(command).published).toBe(false); expect(instance.snapshot().world).toEqual(world);
  });
  it('never admits forged progress, deadlines, lesson identity/participants/knowledge or owner drops even at roomy capacity', () => {
    const world = started(); const before = canonicalStringify(world);
    const mutations: ((world: WorldStateV9) => void)[] = [
      world => { world.cultivation.disciples[0]!.teaching!.completedMonths = 1; },
      world => { world.cultivation.disciples[0]!.teaching!.requiredMonths = 1; },
      world => { world.cultivation.disciples[0]!.teaching!.teachingId = 'instance:999'; },
      world => { world.cultivation.disciples[0]!.teaching!.studentId = 'entity:4'; },
      world => { world.cultivation.disciples[0]!.teaching!.knowledgeId = B; },
      world => { world.cultivation.disciples[0]!.teaching = null; },
      world => { world.clock.calendarTick += 10; world.clock.simulationTick += 10; },
    ];
    for (const mutate of mutations) { const forged = cloneJson(world); mutate(forged); expect(verifyCapacityLimitedCandidateV9(world, forged).ok).toBe(false); }
    expect(canonicalStringify(world)).toBe(before);
  });
  it('does not treat a conservative frozen source or unchanged teaching root as deficient-capacity release', () => {
    const source = started(); setRevision(source, 'construction', MAX - 2 * T + 1); recordChecked(source); freeze(source);
    expect(capacity(source).fits).toBe(false); expect(createPrivateRuntimeV9(source).ok).toBe(false);
    expect(verifyCapacityLimitedCandidateV9(source, cloneJson(source)).ok).toBe(false);
  });
});

// Exact-revision fixture changes only the initial counter headroom, not the work
// or elapsed-time proof. Every subsequent one of the 2400 ticks is actually run.
let longWorld: WorldStateV9; let longRuntime: PrivateRuntimeInstanceV9;
describe('full two-month real continuation at exact three-revision headroom', () => {
  it('admits exact headroom and atomically refuses one-short entry and a new teaching command', () => {
    const source = origin(); for (const domain of ['construction', 'production', 'research'] as const) setRevision(source, domain, MAX - 2 * T);
    const input = lesson(source); longWorld = accepted(source, input); expect(capacity(longWorld).fits).toBe(true); longRuntime = runtime(longWorld);
    for (const domain of ['construction', 'production', 'research'] as const) {
      const short = cloneJson(source); setRevision(short, domain, short.sectExpansion[domain].revision + 1); const text = canonicalStringify(short);
      const rejected = dispatchCapacityLimitedCommandV9(short, lesson(short)); expect(rejected.result.status).toBe('rejected'); expect(rejected.world).toBe(short); expect(canonicalStringify(short)).toBe(text);
      const recordOnly = prepareUnregisteredCommandCandidateV9(short, lesson(short)); expect(recordOnly.result.status).toBe('accepted');
      expect(createPrivateRuntimeV9(recordOnly.world).ok).toBe(false); expect(advanceCapacityLimitedTicksV9(recordOnly.world, 1).world).toBe(recordOnly.world);
    }
  });
  for (let checkpoint = 0; checkpoint < 40; checkpoint++) it(`runs all real fixed ticks ${(checkpoint * 60) + 1}–${(checkpoint + 1) * 60} with strict/private equality`, () => {
    const before = capacity(longWorld); const oracle = advanceCapacityLimitedTicksV9(longWorld, 60); const actual = longRuntime.advance(60);
    expect(oracle.stopped).toBeNull(); expect(actual.stopped).toBeNull(); expect(actual.advancedTicks).toBe(60); expect(actual.metrics.fastQueries).toBe(0);
    const snapshot = longRuntime.snapshot(); expect(snapshot.world).toEqual(oracle.world); longWorld = oracle.world;
    expect(longWorld.clock.simulationTick).toBe((checkpoint + 1) * 60); const after = capacity(longWorld);
    expect(after.reserved.calendarTick).toBe(before.reserved.calendarTick! - 60);
    for (const domain of ['construction', 'production', 'research']) expect(after.costs[`sect.${domain}Revision`]).toBe(MAX);
  });
  it('commits exactly one taught event and provenance after the real second month, releasing only genuine teaching', () => {
    const student = longWorld.cultivation.disciples.find(profile => profile.discipleId === 'entity:2')!;
    expect(longWorld.cultivation.disciples[0]!.teaching).toBeNull(); expect(longWorld.cultivationClock.transitions.map(row => row.tick)).toEqual([T, 2 * T]);
    expect(student.knowledge.filter(entry => entry.knowledgeId === A)).toEqual([{ knowledgeId: A, teacherId: 'entity:1', teachingId: longWorld.cultivation.events.find(event => event.kind === 'cultivation.teachingStarted')!.relatedId }]);
    expect(longWorld.cultivation.events.filter(event => event.kind === 'cultivation.taught')).toHaveLength(1);
    expect(capacity(longWorld).progression!.owners.some(owner => owner.kind === 'teaching')).toBe(false); expect(capacity(longWorld).clock!.calendarTicks).toBe(0);
    expect(longWorld.events.filter(event => event.kind === 'cultivation.taught')).toHaveLength(1); recordChecked(longWorld);
  });
});

describe('real death cleanup cannot be forged into a lesson release', () => {
  for (const [role, id] of [['teacher', 'entity:1'], ['student', 'entity:2'], ['unrelated', 'entity:3']] as const) it(`handles ${role} lifespan expiry and genuine finalization`, () => {
    const world = started(birthday(origin(), [id], 1, true)); const before = capacity(world);
    const step = advanceCapacityLimitedTicksV9(world, 1); expect(step.stopped, JSON.stringify(step.stopped)).toBeNull();
    expect(step.world.cultivation.pendingDeaths.some(death => death.discipleId === id)).toBe(true);
    expect(step.world.clock.pauseReasons).toContain('cultivation'); expect(authenticTeachingTransitionV9(world, step.world)).toBe(true);
    const teacher = step.world.cultivation.disciples.find(profile => profile.discipleId === 'entity:1')!;
    expect(teacher.teaching === null).toBe(role !== 'unrelated');
    const next = capacity(step.world); expect(next.clock!.lifecycleTriggerRows).toBe(before.clock!.lifecycleTriggerRows - 1);
    expect(next.progression!.owners.some(owner => owner.kind === 'disciple-lifecycle' && owner.id === id)).toBe(true);
    if (role === 'unrelated') {
      const route = proof(step.world); expect(route.supported).toBe(true);
      expect(route.recoveryActions.some(command => command.kind === 'cultivation.command' && command.payload.command.kind === 'death.finalize')).toBe(true);
      expect(next.clock!.calendarTicks).toBe(before.clock!.calendarTicks - 1);
    }
    const death = step.world.cultivation.pendingDeaths.find(death => death.discipleId === id)!;
    const command = inner(step.world, { kind: 'death.finalize', commandId: `death.${role}`, expectedRevision: step.world.cultivation.revision,
      discipleId: id, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true });
    const settled = accepted(step.world, command); expect(settled.disciples.some(actor => actor.id === id)).toBe(false);
    expect(settled.legacy.archivedIdentities.some(actor => actor.discipleId === id)).toBe(true);
    expect(settled.cultivation.events.filter(event => event.kind === 'cultivation.died' && event.discipleId === id)).toHaveLength(1);
    expect(dispatchCapacityLimitedCommandV9(settled, command).world).toBe(settled);
    const forged = cloneJson(world); forged.cultivation.disciples[0]!.teaching = null;
    // Unrelated genuine death cannot authenticate a teaching owner drop.
    if (role === 'unrelated') {
      const fakeAfter = cloneJson(step.world); fakeAfter.cultivation.disciples[0]!.teaching = null;
      expect(verifyCapacityLimitedCandidateV9(world, fakeAfter).ok).toBe(false);
    }
    expect(verifyCapacityLimitedCandidateV9(world, forged).ok).toBe(false);
  });
});

let recoveryWorld: WorldStateV9; let recoveryRuntime: PrivateRuntimeInstanceV9;
describe('explicit funded cancellation then actual lesson continuation', () => {
  it('derives callable cancellations for unrelated blocked legacy production and supply-blocked seclusion without auto-cancelling either', () => {
    // This within-month setup is an arithmetic boundary fixture. The month and
    // all post-cancellation ticks below use actual reducers, not month jumps.
    let world = atPhase(origin(), T - 1);
    const attemptId = 'recover.attempt'; world = fixtureApply(world, inner(world, { kind: 'breakthrough.confirm', commandId: attemptId,
      expectedRevision: world.cultivation.revision, preview: previewBreakthroughV3(world, 'entity:4') }));
    world = fixtureApply(world, inner(world, { kind: 'breakthrough.begin', commandId: 'recover.begin', expectedRevision: world.cultivation.revision,
      attemptId: world.cultivation.attempts[0]!.attemptId }));
    world = fixtureApply(world, fixtureCommand(world, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:3' } }, 'recover.work'));
    world.inventory.meal.owned = world.inventory.meal.reserved;
    world.buildings = world.buildings.map(site => site.blueprintId === 'workshop' ? { ...site, operational: false } : site);
    world = started(recordChecked(world));
    world = recordChecked(prepareNormalTickCandidateV9(world));
    expect(world.cultivation.attempts[0]).toMatchObject({ phase: 'InSeclusion', blockedMonths: 1, blockedReason: 'SUPPLY_SHORTAGE' });
    const jobId = world.activeProductionTransactionIds[0]!; expect(world.transactions[jobId]!.state).toBe('Blocked');
    const before = canonicalStringify(world); const route = proof(world); expect(route.supported, route.unknowns.join(';')).toBe(true);
    expect(route.recoveryActions.map(command => command.kind)).toEqual(['production.cancel', 'cultivation.command']);
    expect(canonicalStringify(world)).toBe(before); expect(world.cultivation.attempts[0]!.phase).toBe('InSeclusion');
    // The no-optional reducer DOES run old production; cancellation is a real
    // prerequisite in the route, never an assumed free blocked-event history.
    const uncancelled = prepareNoOptionalGrowthTickCandidateV9(world); expect(uncancelled.activeProductionTransactionIds).toContain(jobId);
    for (const action of route.recoveryActions) world = accepted(world, action);
    expect(world.activeProductionTransactionIds).toEqual([]); expect(world.cultivation.attempts[0]!.phase).toBe('Cancelled');
    expect(world.cultivation.attempts[0]!.completedMonths).toBe(0); expect(world.cultivation.attempts[0]!.sample).toBeNull();
    expect(proof(world).recoveryActions).toEqual([]); expect(capacity(world).clock!.calendarTicks).toBe(T);
    recoveryWorld = world; recoveryRuntime = runtime(world);
  });
  for (let checkpoint = 0; checkpoint < 20; checkpoint++) it(`executes real recovered tick checkpoint ${checkpoint + 1}/20`, () => {
    const oracle = advanceCapacityLimitedTicksV9(recoveryWorld, 60); expect(oracle.stopped).toBeNull();
    const actual = recoveryRuntime.advance(60); expect(actual.stopped).toBeNull(); expect(actual.advancedTicks).toBe(60);
    expect(recoveryRuntime.snapshot().world).toEqual(oracle.world); recoveryWorld = oracle.world;
  });
  it('finishes the lesson after explicit recovery without completing or sampling the cancelled attempt', () => {
    expect(recoveryWorld.clock.calendarTick).toBe(2 * T); expect(recoveryWorld.cultivation.disciples[0]!.teaching).toBeNull();
    expect(recoveryWorld.cultivation.disciples[1]!.knowledge.some(entry => entry.knowledgeId === A && entry.teacherId === 'entity:1')).toBe(true);
    expect(recoveryWorld.cultivation.attempts[0]).toMatchObject({ phase: 'Cancelled', completedMonths: 0, blockedMonths: 1, sample: null });
  });
  it('rejects a source whose unrelated construction cannot really cancel at its current position', () => {
    let world = fixtureStartConstruction(fixturePlace(origin(), 'library.v9', 1));
    // Construction occupies entity:2, so use the other disjoint pair.
    const command = lesson(world, 'entity:3', 'entity:4', A, 'blocked-cancel.lesson');
    world = fixtureApply(world, command); const worker = world.disciples.find(actor => actor.id === 'entity:2')!;
    world.map = { ...world.map, navVersion: world.map.navVersion + 1,
      tiles: world.map.tiles.map(tile => tile.x === worker.position.x && tile.y === worker.position.y ? { ...tile, walkable: false } : tile) };
    // External terrain fixture is honestly checked. Whether strict source shape
    // already rejects it or actual cancellation rejects PLACEMENT_CHANGED, it
    // can never be admitted merely because an owner has a terminal allowance.
    const assessment = capacity(world); expect(inspectTeachingContinuationV9(world, assessment).supported).toBe(false);
    expect(createPrivateRuntimeV9(world).ok).toBe(false); expect(advanceCapacityLimitedTicksV9(world, 1).world).toBe(world);
  });
});

describe('independent finite-teaching capacity edges', () => {
  it('funds exact action-ID headroom including grouped birthdays and rejects one-short without spending anything', () => {
    let world = started(birthday(origin(), ['entity:1', 'entity:2'], 7)); const required = capacity(world).reserved['sequence.nextAction']!;
    world.sequences.nextAction = MAX - required; recordChecked(world); expect(capacity(world).fits).toBe(true); expect(proof(world).supported).toBe(true);
    const short = cloneJson(world); short.sequences.nextAction++; recordChecked(short); const text = canonicalStringify(short);
    expect(capacity(short).deficits.some(row => row.dimension === 'sequence.nextAction')).toBe(true); expect(createPrivateRuntimeV9(short).ok).toBe(false);
    expect(advanceCapacityLimitedTicksV9(short, 1).world).toBe(short); expect(canonicalStringify(short)).toBe(text);
  });
  it('keeps bytes independent of revisions and refuses one-byte-short finite reserve while actual bytes still fit', () => {
    let world = started(); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    const measured = capacity(world); world.diagnostics.at(-1)!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - measured.costs.wireBytes!);
    world = recordChecked(world); expect(capacity(world).costs.wireBytes).toBe(SAVE_FILE_LIMIT_BYTES); expect(proof(world).supported).toBe(true);
    const short = cloneJson(world); short.diagnostics.at(-1)!.message += 'x'; const budget = capacity(short);
    expect(budget.actualFits).toBe(true); expect(budget.deficits.map(row => row.dimension)).toContain('wireBytes'); expect(createPrivateRuntimeV9(short).ok).toBe(false);
    expect(advanceCapacityLimitedTicksV9(short, 1).world).toBe(short);
  });
  for (const extra of [0, 1]) it(`exposes independent clock row and structural-node edge +${extra} as an explicitly invalid chronology fixture`, () => {
    const world = started(); const reserved = capacity(world).reserved.cultivationClockTransitions!;
    // Row-only arithmetic pressure, not genuine history or admission evidence.
    world.cultivationClock.transitions = Array.from({ length: V9_CULTIVATION_CLOCK_LIMIT - reserved + extra }, (_, index) => ({
      kind: 'month', tick: (index + 1) * T, beforeRevision: index + 1, rootActionId: `action:${index + 2}`,
    }));
    const measured = capacity(world); expect(measured.supported).toBe(false); expect(measured.actualFits).toBe(true);
    expect(measured.costs.cultivationClockTransitions).toBe(V9_CULTIVATION_CLOCK_LIMIT + extra);
    expect(measured.deficits.some(row => row.dimension === 'cultivationClockTransitions')).toBe(extra === 1);
    expect(measured.deficits.some(row => row.dimension === 'cultivationClockStructuralNodes')).toBe(extra === 1);
    expect(createPrivateRuntimeV9(world).ok).toBe(false);
  });
  it('never turns fabricated archive counters into source or release authority', () => {
    const world = started(); const reserved = capacity(world).reserved.archiveEventRows!;
    // Independent archive count arithmetic only: no packed rows are fabricated.
    const malformed = cloneJson(world); malformed.history = { ...malformed.history, events: { ...malformed.history.events, count: 100_000 - reserved - malformed.events.length + 1 } };
    const slots = assessHistorySlots(malformed, 0, 0, []);
    expect(slots.current.events + reserved).toBeGreaterThan(slots.limitPerTable);
    const equal = cloneJson(world); equal.history = { ...equal.history, events: { ...equal.history.events, count: 100_000 - reserved - equal.events.length } };
    expect(assessHistorySlots(equal, 0, 0, []).current.events + reserved).toBe(100_000);
    expect(capacity(malformed).supported).toBe(false); expect(createPrivateRuntimeV9(malformed).ok).toBe(false);
    expect(verifyCapacityLimitedCandidateV9(world, malformed).ok).toBe(false);
  });
});


describe('reachable pressure recovery retains required lesson time', () => {
  it('admits an existing deficient lesson only when a real funded cancellation restores the full horizon', () => {
    let world = origin();
    world = fixtureApply(world, fixtureCommand(world, { kind: 'production.start', payload: { recipeId: 'craft.plank', workerId: 'entity:3' } }, 'pressure.work'));
    world = started(world); world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: 0, message: '' });
    const route = proof(world); expect(route.supported).toBe(true); expect(route.recoveryActions).toHaveLength(1);
    const recovered = prepareUnregisteredCommandCandidateV9(world, route.recoveryActions[0]!).world;
    const current = capacity(world); const terminal = capacity(recovered); expect(current.costs.wireBytes!).toBeGreaterThan(terminal.costs.wireBytes!);
    world.diagnostics.at(-1)!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - terminal.costs.wireBytes! - 100);
    const constrained = capacity(world); expect(constrained.actualFits).toBe(true); expect(constrained.fits).toBe(false);
    const witness = proof(world); expect(witness.supported, witness.unknowns.join(';')).toBe(true); expect(witness.recoveryActions).toHaveLength(1);
    const created = createPrivateRuntimeV9(world); expect(created.ok).toBe(true); if (!created.ok) throw new Error('Recovery-only source refused');
    expect(created.recoveryOnly).toBe(true); const before = canonicalStringify(world);
    // Creation did not cancel the job, mutate positions, or spend teaching time.
    expect(created.instance.snapshot().world).toEqual(world); expect(canonicalStringify(world)).toBe(before);
    const applied = created.instance.command(witness.recoveryActions[0]!); expect(applied.published).toBe(true);
    const after = created.instance.snapshot().world!; expect(after.activeProductionTransactionIds).toEqual([]); expect(capacity(after).fits).toBe(true);
    expect(capacity(after).clock!.calendarTicks).toBe(2 * T); expect(after.cultivation.disciples[0]!.teaching!.completedMonths).toBe(0);
  });
});

describe('successful funded sect-domain cancellation routes', () => {
  for (const domain of ['construction', 'production'] as const) it(`preserves real ${domain} cancellation evidence and resumes lesson ticks`, () => {
    let world = origin();
    if (domain === 'construction') world = fixtureStartConstruction(fixturePlace(world, 'library.v9', 1));
    else world = fixtureApply(world, fixtureCommand(world, { kind: 'sect.command', payload: { domain: 'production', command: {
      kind: 'production.start', commandId: 'sect-recovery.work', expectedRevision: world.sectExpansion.production.revision,
      recipeId: 'gather.stone.v9', workerId: 'entity:2' } } }, 'sect-recovery.work'));
    // Work movement is real and remains exclusively owned by unrelated entity:2.
    world = recordChecked(prepareNormalTickCandidateV9(world));
    world = accepted(world, lesson(world, 'entity:3', 'entity:4', A, `sect-recovery.${domain}.lesson`));
    const source = canonicalStringify(world); const route = proof(world); expect(route.supported, route.unknowns.join(';')).toBe(true);
    expect(route.recoveryActions).toHaveLength(1); expect(route.recoveryActions[0]).toMatchObject({ kind: 'sect.command', payload: { domain } });
    const originalJob = domain === 'construction' ? world.sectExpansion.construction.jobs[0]! : world.sectExpansion.production.jobs[0]!;
    expect(originalJob.terminal).toBeNull(); const priorPosition = world.disciples.find(actor => actor.id === 'entity:2')!.position;
    const initialHorizon = capacity(world).clock!.calendarTicks; const instance = runtime(world);
    const applied = dispatchCapacityLimitedCommandV9(world, route.recoveryActions[0]!); expect(applied.result.status).toBe('accepted');
    const privateResult = instance.command(route.recoveryActions[0]!); expect(privateResult.published).toBe(true);
    expect(privateResult.result).toEqual(applied.result); expect(instance.snapshot().world).toEqual(applied.world);
    expect(canonicalStringify(world)).toBe(source); world = applied.world;
    const job = domain === 'construction' ? world.sectExpansion.construction.jobs[0]! : world.sectExpansion.production.jobs[0]!;
    expect(job.terminal?.kind).toBe('cancelled'); expect(world.sectExpansion[domain].receipts.at(-1)!.command.kind).toBe(`${domain}.cancel`);
    const claim = world.sectExpansion.reservations.find(claim => claim.reservationId === job.reservationId)!;
    expect(claim.base.settlement?.kind).toBe('released'); expect(claim.sect.settlement?.kind).toBe('released');
    expect(world.disciples.find(actor => actor.id === 'entity:2')!.position).toEqual(priorPosition);
    expect(capacity(world).clock!.calendarTicks).toBe(initialHorizon); expect(proof(world).recoveryActions).toEqual([]);
    const oracle = advanceCapacityLimitedTicksV9(world, 8); expect(oracle.stopped).toBeNull();
    const continued = instance.advance(8); expect(continued.advancedTicks).toBe(8); expect(continued.stopped).toBeNull();
    expect(instance.snapshot().world).toEqual(oracle.world); expect(capacity(oracle.world).clock!.calendarTicks).toBe(initialHorizon - 8);
  });
});

let survivingWorld: WorldStateV9; let survivingRuntime: PrivateRuntimeInstanceV9;
describe('surviving lesson genuinely finishes after unrelated death', () => {
  it('executes the real unrelated expiry tick, retains teaching, and explicitly finalizes that death', () => {
    survivingWorld = started(birthday(origin(), ['entity:3'], 1, true)); survivingRuntime = runtime(survivingWorld);
    const expected = advanceCapacityLimitedTicksV9(survivingWorld, 1); expect(expected.stopped).toBeNull();
    const actual = survivingRuntime.advance(1); expect(actual.advancedTicks).toBe(1); expect(actual.stopped).toBeNull();
    expect(survivingRuntime.snapshot().world).toEqual(expected.world); survivingWorld = expected.world;
    expect(survivingWorld.clock.pauseReasons).toContain('cultivation'); expect(survivingWorld.cultivation.disciples[0]!.teaching!.completedMonths).toBe(0);
    const route = proof(survivingWorld); expect(route.supported).toBe(true); expect(route.recoveryActions).toHaveLength(1);
    expect(route.recoveryActions[0]).toMatchObject({ kind: 'cultivation.command', payload: { command: { kind: 'death.finalize', discipleId: 'entity:3' } } });
    const settled = dispatchCapacityLimitedCommandV9(survivingWorld, route.recoveryActions[0]!); expect(settled.result.status).toBe('accepted');
    const privateSettled = survivingRuntime.command(route.recoveryActions[0]!); expect(privateSettled.published).toBe(true); expect(privateSettled.result).toEqual(settled.result);
    expect(survivingRuntime.snapshot().world).toEqual(settled.world); survivingWorld = settled.world;
    expect(survivingWorld.clock.pauseReasons).not.toContain('cultivation'); expect(survivingWorld.clock.calendarTick).toBe(1);
    expect(survivingWorld.legacy.archivedIdentities.some(actor => actor.discipleId === 'entity:3')).toBe(true);
    expect(capacity(survivingWorld).clock!.calendarTicks).toBe(2 * T - 1);
  });
  // These are all 2399 remaining real fixed ticks, with no arithmetic month jump.
  for (let checkpoint = 0; checkpoint < 40; checkpoint++) it(`runs surviving lesson checkpoint ${checkpoint + 1}/40`, () => {
    const ticks = Math.min(60, 2 * T - 1 - checkpoint * 60); const before = capacity(survivingWorld);
    const oracle = advanceCapacityLimitedTicksV9(survivingWorld, ticks); expect(oracle.stopped).toBeNull();
    const actual = survivingRuntime.advance(ticks); expect(actual.advancedTicks).toBe(ticks); expect(actual.stopped).toBeNull();
    expect(survivingRuntime.snapshot().world).toEqual(oracle.world); survivingWorld = oracle.world;
    expect(capacity(survivingWorld).clock!.calendarTicks).toBe(before.clock!.calendarTicks - ticks);
    expect(survivingWorld.cultivation.deaths.filter(death => death.discipleId === 'entity:3')).toHaveLength(1);
  });
  it('commits surviving student knowledge and one taught event while preserving the unrelated complete death archive', () => {
    expect(survivingWorld.clock.calendarTick).toBe(2 * T); expect(survivingWorld.cultivation.disciples.find(actor => actor.discipleId === 'entity:1')!.teaching).toBeNull();
    const student = survivingWorld.cultivation.disciples.find(actor => actor.discipleId === 'entity:2')!;
    expect(student.knowledge.filter(knowledge => knowledge.knowledgeId === A)).toHaveLength(1);
    expect(student.knowledge.find(knowledge => knowledge.knowledgeId === A)!.teacherId).toBe('entity:1');
    expect(survivingWorld.cultivation.events.filter(event => event.kind === 'cultivation.taught' && event.discipleId === 'entity:2')).toHaveLength(1);
    expect(survivingWorld.cultivation.archivedDisciples.filter(actor => actor.discipleId === 'entity:3')).toHaveLength(1);
    expect(survivingWorld.builds.retiredDisciples.filter(actor => actor.discipleId === 'entity:3')).toHaveLength(1);
    expect(survivingWorld.legacy.estates.find(estate => estate.discipleId === 'entity:3')!.settledMonth).not.toBeNull();
    expect(capacity(survivingWorld).clock!.calendarTicks).toBe(0); recordChecked(survivingWorld);
  });
});
