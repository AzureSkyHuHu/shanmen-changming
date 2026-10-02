import { beforeAll, describe, expect, it } from 'vitest';
import { MANAGEMENT_V10_CONTENT_VERSION, MANAGEMENT_V10_IDENTITY } from '../../src/content/sect-v10/world-content';
import { createCultivationStateV3 } from '../../src/core/cultivation/v3';
import { iterateArchivedCommandReceipts } from '../../src/core/history/archive';
import { CALENDAR_TICKS_PER_MONTH as T, setPauseReason } from '../../src/core/kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import type { CommandV10, SectCommandV10 } from '../../src/core/kernel/contracts-v10';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNoOptionalGrowthTickCandidateV10, prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import { inspectUnregisteredWorldV10Records } from '../../src/core/kernel/validation';
import { SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget/admission';
import { createSectUpgradeStateV10 } from '../../src/core/sect-expansion/upgrade-validation';
import type { SectProductionJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { assessManagementCapacityV10 as capacity } from '../../src/core/world/management-capacity-v10';
import { authenticTeachingTransitionV10, inspectTeachingContinuationV10 as proof } from '../../src/core/world/teaching-continuation-v10';
import { v10WorkOwners } from '../../src/core/world/v10-sect-frame';
import type { WorldStateV9 } from '../../src/core/world/v9-types';
import { fixturePlace, fixtureProduce, fixtureResearchStart, fixtureStartConstruction, fixtureUntil, recordChecked } from './fixtures/v9-runtime';

const A = 'knowledge.v10-lesson-a'; const B = 'knowledge.v10-lesson-b'; const MAX = Number.MAX_SAFE_INTEGER;
/** Authored knowledge and base-stock initial conditions; no invented acquisition. */
function origin(): WorldStateV9 {
  const world = createUnregisteredWorldV9('finite-v10-teaching');
  world.cultivation = createCultivationStateV3(world.cultivation.disciples.map((profile, index) => ({ ...profile,
    knowledge: [{ knowledgeId: index % 2 ? B : A, teacherId: null, teachingId: null }] })));
  for (const entry of Object.values(world.inventory)) entry.owned = Math.min(80, entry.capacity);
  return recordChecked(world);
}
/** Exact record-only test lift. This does not exercise or authorize migration. */
function lift(source = origin()): WorldStateV10 {
  recordChecked(source); const old = cloneJson(source);
  const world: WorldStateV10 = { ...old, simulationVersion: '0.10.0', runtimeProtocol: 'management-v10-alchemy-upgrade.1',
    contentVersion: MANAGEMENT_V10_CONTENT_VERSION, contentIdentity: cloneJson(MANAGEMENT_V10_IDENTITY),
    sectExpansion: { ...old.sectExpansion, schemaVersion: 2,
      construction: { ...old.sectExpansion.construction, buildings: old.sectExpansion.construction.buildings.map(building => {
        if (building.level !== 1) throw new Error('Expected genuine immutable L1 origin'); return { ...building, level: 1 as const };
      }) }, production: { ...old.sectExpansion.production, jobs: old.sectExpansion.production.jobs.map((job): SectProductionJobV10 => {
        if (job.recipeId === 'craft.wound-powder-alt.v9') throw new Error('No L2 in v9 source'); return { ...job, recipeId: job.recipeId };
      }) }, upgrade: createSectUpgradeStateV10() } };
  expect(inspectUnregisteredWorldV10Records(world)).toEqual([]); return world;
}
function apply(world: WorldStateV10, command: CommandV10): WorldStateV10 {
  const result = prepareUnregisteredCommandCandidateV10(world, command);
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function sect(world: WorldStateV10, payload: SectCommandV10): CommandV10 {
  return { kind: 'sect.command', commandId: payload.command.commandId, issuedTick: world.clock.simulationTick, sequence: 0, payload };
}
function lesson(world: WorldStateV10, teacher = 'entity:1', student = 'entity:2', knowledgeId = A, commandId = 'lesson.begin'): CommandV10 {
  return { kind: 'cultivation.command', commandId, issuedTick: world.clock.simulationTick, sequence: 0,
    payload: { command: { kind: 'teaching.begin', commandId, expectedRevision: world.cultivation.revision,
      discipleId: teacher, studentId: student, knowledgeId } } };
}
function startLesson(world = lift()): WorldStateV10 { return apply(world, lesson(world)); }
function until(source: WorldStateV10, done: (world: WorldStateV10) => boolean, limit = 1600): WorldStateV10 {
  let world = source;
  for (let count = 0; count < limit && !done(world); count++) world = prepareNormalTickCandidateV10(world);
  if (!done(world)) throw new Error('Real v10 work did not finish within fixture bound'); return world;
}
function startUpgrade(world: WorldStateV10, commandId = 'lesson.upgrade'): WorldStateV10 {
  return apply(world, sect(world, { domain: 'upgrade', command: { kind: 'upgrade.start', commandId,
    expectedRevision: world.sectExpansion.upgrade.revision, workerId: 'entity:2',
    buildingId: world.sectExpansion.construction.buildings.find(building => building.definitionId === 'alchemy.v9')!.buildingId } }));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function economy(world: WorldStateV10, commandId: string): WorldStateV10 {
  return apply(world, { kind: 'sect-economy.command', commandId, issuedTick: world.clock.simulationTick, sequence: 0,
    payload: { command: { kind: 'enabled.set', enabled: false } } });
}

describe('fixed v10 finite teaching continuation', () => {
  for (const phase of [0, 1, T - 1]) for (const pairs of [1, 2]) it(`funds ${pairs} disjoint lesson pairs at phase ${phase} without upgrade elapsed ticks`, () => {
    // Explicit within-month arithmetic source only; continuation tests below run every actual tick.
    const old = origin(); old.clock.calendarTick = phase; old.clock.simulationTick = phase;
    let world = startLesson(lift(old));
    if (pairs === 2) world = apply(world, lesson(world, 'entity:3', 'entity:4', A, 'lesson.second'));
    const assessment = capacity(world); const horizon = pairs * 2 * T - phase;
    expect(assessment.supported, assessment.sourceRecordIssues.join(';')).toBe(true);
    expect(assessment.clock!.calendarTicks).toBe(horizon);
    for (const domain of ['construction', 'production', 'research']) expect(assessment.reserved[`sect.${domain}Revision`]).toBe(horizon);
    expect(assessment.reserved['sect.upgradeRevision']).toBe(0);
    const before = canonicalStringify(world); expect(proof(world)).toMatchObject({ supported: true, recoveryActions: [], unknowns: [] });
    expect(canonicalStringify(world)).toBe(before);
    const next = prepareNoOptionalGrowthTickCandidateV10(world); const after = capacity(next);
    const releasedParallelMonths = phase === T - 1 ? (pairs - 1) * T : 0;
    expect(after.clock!.calendarTicks).toBe(horizon - 1 - releasedParallelMonths);
    expect(next.sectExpansion.upgrade.revision).toBe(world.sectExpansion.upgrade.revision);
    expect(authenticTeachingTransitionV10(world, next)).toBe(true);
    for (const domain of ['construction', 'production', 'research']) expect(after.costs[`sect.${domain}Revision`]).toBe(assessment.costs[`sect.${domain}Revision`]! - releasedParallelMonths);
  });
  it('keeps a player pause and the full unpaid-time horizon without altering any domain', () => {
    const world = startLesson(); world.clock = setPauseReason(world.clock, 'player', true);
    const source = canonicalStringify(world); expect(proof(world).supported).toBe(true);
    expect(prepareNoOptionalGrowthTickCandidateV10(world)).toBe(world);
    expect(capacity(world).clock!.calendarTicks).toBe(2 * T); expect(canonicalStringify(world)).toBe(source);
  });
  it('rejects a real supported-domain teaching chain instead of claiming disjoint pair support', () => {
    const source = startLesson(); const chain = apply(source, lesson(source, 'entity:2', 'entity:3', B, 'lesson.chain'));
    expect(proof(chain).supported).toBe(false);
    expect(proof(chain).unknowns.some(issue => issue.includes('overlap') || issue.includes('role'))).toBe(true);
  });
  it('replays actual lesson commands and both real tick variants; forged progress or disappearance is not a witness', () => {
    const source = lift(); const started = startLesson(source); expect(authenticTeachingTransitionV10(source, started)).toBe(true);
    for (const next of [prepareNormalTickCandidateV10(started), prepareNoOptionalGrowthTickCandidateV10(started)]) {
      expect(authenticTeachingTransitionV10(started, next)).toBe(true);
      const forged = cloneJson(next); forged.cultivation.disciples[0]!.teaching!.completedMonths++;
      expect(authenticTeachingTransitionV10(started, forged)).toBe(false);
    }
    const dropped = cloneJson(started); dropped.cultivation.disciples[0]!.teaching = null;
    expect(authenticTeachingTransitionV10(started, dropped)).toBe(false);
  });
  it('derives its own source capacity and rejects exact finite numeric exhaustion', () => {
    const source = startLesson(); const reserve = capacity(source).reserved['sequence.nextAction']!;
    source.sequences.nextAction = MAX - reserve;
    expect(capacity(source).fits).toBe(true); expect(proof(source).supported).toBe(true);
    const short = cloneJson(source); short.sequences.nextAction++;
    const before = canonicalStringify(short); expect(proof(short).supported).toBe(false); expect(canonicalStringify(short)).toBe(before);
    const malformed = Object.defineProperty(cloneJson(source), 'seed', { enumerable: true, get() { throw new Error('Never invoke'); } });
    expect(proof(malformed).supported).toBe(false);
  });
  it('avoids current and truly archived World recovery command IDs using bounded identity search', () => {
    let world = lift(); world = apply(world, { kind: 'production.start', commandId: 'collision.work', issuedTick: 0, sequence: 0,
      payload: { recipeId: 'craft.plank', workerId: 'entity:3' } });
    world = startLesson(world); const prefix = `teaching-recovery.${world.sequences.nextAction}`;
    world = economy(world, `${prefix}.0`);
    world = economy(world, `${prefix}.1`);
    for (let n = 0; n < 63; n++) world = economy(world, `zz.collision.${n}`);
    expect([...iterateArchivedCommandReceipts(world.history)].some(receipt => receipt.commandId === `${prefix}.0`)).toBe(true);
    expect(world.commandReceipts[`${prefix}.1`]?.commandId).toBe(`${prefix}.1`);
    const route = proof(world); expect(route.supported, route.unknowns.join(';')).toBe(true);
    expect(route.recoveryActions).toHaveLength(1); expect(route.recoveryActions[0]!.commandId).toBe(`${prefix}.2`);
    const recovered = apply(world, route.recoveryActions[0]!); expect(recovered.activeProductionTransactionIds).toEqual([]);
    expect(capacity(recovered).clock!.calendarTicks).toBe(2 * T);
  }, 30000);
});

// Genuine v9 construction/basic research is unchanged setup. Herbal research and
// all upgrade/recovery/lesson continuations below use real complete v10 candidates.
let old: WorldStateV9; let ready: WorldStateV10; let half: WorldStateV10;
describe('sixth-owner teaching recovery with earned alchemy upgrade history', () => {
  beforeAll(() => {
    old = fixtureStartConstruction(fixturePlace(origin(), 'library.v9', 1));
    old = fixtureUntil(old, world => !!world.sectExpansion.construction.jobs.at(-1)!.terminal);
  }, 60000);
  for (const recipe of ['extract.spirit-stone.v9', 'study.basic-insight.v9'] as const) {
    for (let count = 0; count < 6; count++) beforeAll(() => { old = fixtureProduce(old, recipe); }, 60000);
  }
  beforeAll(() => {
    old = fixtureResearchStart(old); old = fixtureUntil(old, world => !!world.sectExpansion.research.jobs.at(-1)!.terminal);
    old = fixtureStartConstruction(fixturePlace(old, 'alchemy.v9', 10));
    old = fixtureUntil(old, world => !!world.sectExpansion.construction.jobs.at(-1)!.terminal);
    let world = lift(old);
    world = apply(world, sect(world, { domain: 'research', command: { kind: 'research.start', commandId: 'lesson.herbal',
      expectedRevision: world.sectExpansion.research.revision, researchId: 'herbal-compatibility.v9', workerId: 'entity:2' } }));
    ready = until(world, value => !!value.sectExpansion.research.jobs.at(-1)!.terminal);
    half = until(startUpgrade(ready), value => value.sectExpansion.upgrade.jobs[0]!.activeTicks === 200);
  }, 120000);

  it('cancels upgrade before another unrelated owner, avoids upgrade receipt collision, and never spends lesson time', () => {
    // The first starter may teach but is under working age. Keep the two actual
    // adult workers free instead of manufacturing canWork or training authority.
    let world = apply(ready, lesson(ready, 'entity:1', 'entity:4', A, 'lesson.upgrade-route'));
    world = apply(world, { kind: 'production.start', commandId: 'lesson.unrelated-work', issuedTick: world.clock.simulationTick, sequence: 0,
      payload: { recipeId: 'gather.wood', workerId: 'entity:3' } });
    const collision = `teaching-recovery.${world.sequences.nextAction}.0`;
    world = startUpgrade(world, collision);
    const frozen = freeze(cloneJson(world)); const before = canonicalStringify(frozen); const budget = capacity(frozen);
    const route = proof(frozen); expect(route.supported, route.unknowns.join(';')).toBe(true);
    expect(route.recoveryActions).toHaveLength(2);
    expect(route.recoveryActions[0]).toMatchObject({ kind: 'sect.command', payload: { domain: 'upgrade', command: { kind: 'upgrade.cancel' } } });
    expect(route.recoveryActions[0]!.commandId).toBe(`teaching-recovery.${world.sequences.nextAction}.1`);
    expect(route.recoveryActions[1]!.kind).toBe('production.cancel'); expect(canonicalStringify(frozen)).toBe(before);
    expect(budget.reserved['sect.upgradeRevision']).toBe(1);
    expect(budget.clock!.calendarTicks).toBe(2 * T - world.clock.calendarTick % T);
    const original = world;
    for (const command of route.recoveryActions) {
      const next = apply(world, command); expect(authenticTeachingTransitionV10(world, next)).toBe(true); world = next;
    }
    expect(v10WorkOwners(world)).toEqual([]); expect(world.clock).toEqual(original.clock);
    expect(world.randomStreams).toEqual(original.randomStreams); expect(world.map).toEqual(original.map);
    expect(world.sectExpansion.upgrade.jobs[0]!.terminal?.kind).toBe('cancelled');
    expect(world.sectExpansion.upgrade.revision).toBe(original.sectExpansion.upgrade.revision + 1);
    expect(capacity(world).clock!.calendarTicks).toBe(budget.clock!.calendarTicks);
    const next = prepareNoOptionalGrowthTickCandidateV10(world);
    expect(next.sectExpansion.upgrade.revision).toBe(world.sectExpansion.upgrade.revision);
    expect(capacity(next).clock!.calendarTicks).toBe(budget.clock!.calendarTicks - 1);
    expect(proof(world)).toMatchObject({ supported: true, recoveryActions: [] });
  }, 30000);

  it('certifies the actual half-paid cancellation, exact replay, refund, claims and untouched teaching', () => {
    const world = apply(half, lesson(half, 'entity:3', 'entity:4', A, 'lesson.half-route'));
    const worked = prepareNoOptionalGrowthTickCandidateV10(world);
    expect(worked.sectExpansion.upgrade.jobs[0]!.activeTicks).toBe(201);
    expect(worked.sectExpansion.upgrade.revision).toBe(world.sectExpansion.upgrade.revision + 1);
    expect(authenticTeachingTransitionV10(world, worked)).toBe(true);
    const route = proof(world); expect(route.supported, route.unknowns.join(';')).toBe(true); expect(route.recoveryActions).toHaveLength(1);
    const action = route.recoveryActions[0]!; const next = apply(world, action); const job = next.sectExpansion.upgrade.jobs[0]!;
    expect(job.terminal?.released.map(line => line.quantity)).toEqual([3, 3]);
    expect(job.terminal?.consumed.map(line => line.quantity)).toEqual([3, 3]);
    expect(job.workSpans).toEqual(world.sectExpansion.upgrade.jobs[0]!.workSpans); expect(job.checkpoints).toHaveLength(1);
    expect(next.sectExpansion.upgrade.receipts.at(-1)!.command).toEqual(action.kind === 'sect.command' ? action.payload.command : null);
    expect(next.commandReceipts[route.recoveryActions[0]!.commandId]).toBeUndefined();
    expect(next.cultivation).toEqual(world.cultivation); expect(v10WorkOwners(next)).toEqual([]);
    expect(next.disciples.find(actor => actor.id === 'entity:2')!.position).toEqual(world.disciples.find(actor => actor.id === 'entity:2')!.position);
    expect(authenticTeachingTransitionV10(world, next)).toBe(true);
    expect(prepareUnregisteredCommandCandidateV10(next, route.recoveryActions[0]!).world).toBe(next);
    const forged = cloneJson(next); forged.inventory.wood.owned--;
    expect(authenticTeachingTransitionV10(world, forged)).toBe(false);
    const missing = cloneJson(next); missing.sectExpansion = { ...missing.sectExpansion,
      upgrade: { ...missing.sectExpansion.upgrade, receipts: missing.sectExpansion.upgrade.receipts.slice(0, -1) } };
    expect(authenticTeachingTransitionV10(world, missing)).toBe(false);
  }, 30000);

  it('rejects a lesson participant claimed by upgrade and an unreachable upgrade cancellation', () => {
    const busy = prepareUnregisteredCommandCandidateV10(half, lesson(half, 'entity:1', 'entity:2', A, 'lesson.busy'));
    expect(busy.result.status).toBe('rejected');
    const source = apply(half, lesson(half, 'entity:3', 'entity:4', A, 'lesson.unsafe-cancel'));
    const invalid = cloneJson(source); const worker = invalid.disciples.find(actor => actor.id === 'entity:2')!;
    invalid.map = { ...invalid.map, navVersion: invalid.map.navVersion + 1, tiles: invalid.map.tiles.map(tile =>
      tile.x === worker.position.x && tile.y === worker.position.y ? { ...tile, walkable: false } : tile) };
    expect(proof(invalid).supported).toBe(false);
    const overlapping = cloneJson(source); overlapping.sectExpansion = { ...overlapping.sectExpansion,
      upgrade: { ...overlapping.sectExpansion.upgrade, jobs: overlapping.sectExpansion.upgrade.jobs.map(job => ({ ...job, workerId: 'entity:3' })) } };
    expect(proof(overlapping).supported).toBe(false);
  });

  it('accepts recovery-only byte pressure only when real upgrade cancellation restores every finite lesson reserve', () => {
    let world = apply(half, lesson(half, 'entity:3', 'entity:4', A, 'lesson.byte-pressure'));
    world.diagnostics.push({ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' });
    const route = proof(world); expect(route.supported, route.unknowns.join(';')).toBe(true);
    const recovered = apply(world, route.recoveryActions[0]!); const reserve = capacity(recovered);
    expect(capacity(world).costs.wireBytes!).toBeGreaterThan(reserve.costs.wireBytes!);
    world.diagnostics.at(-1)!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - reserve.costs.wireBytes! - 100);
    const before = canonicalStringify(world); expect(capacity(world)).toMatchObject({ supported: true, actualFits: true, fits: false });
    const constrained = proof(world); expect(constrained.supported, constrained.unknowns.join(';')).toBe(true);
    world = apply(world, constrained.recoveryActions[0]!); expect(capacity(world).fits).toBe(true);
    expect(capacity(world).clock!.calendarTicks).toBe(reserve.clock!.calendarTicks);
    expect(before).not.toBe(canonicalStringify(world));
  }, 30000);

  let continuation: WorldStateV10; let lessonEnd: number; let cancelledRevision: number;
  it('begins the complete real lesson continuation after the actual funded upgrade cancellation', () => {
    const world = apply(half, lesson(half, 'entity:3', 'entity:4', A, 'lesson.full-continuation'));
    const route = proof(world); expect(route.supported, route.unknowns.join(';')).toBe(true);
    continuation = apply(world, route.recoveryActions[0]!);
    lessonEnd = (Math.floor(continuation.clock.calendarTick / T) + 2) * T;
    cancelledRevision = continuation.sectExpansion.upgrade.revision;
    expect(capacity(continuation).clock!.calendarTicks).toBe(lessonEnd - continuation.clock.calendarTick);
  });
  for (let batch = 0; batch < 40; batch++) it(`runs real bounded no-optional lesson checkpoint ${batch + 1}/40`, () => {
    const ticks = Math.min(60, lessonEnd - continuation.clock.calendarTick); const before = capacity(continuation);
    for (let tick = 0; tick < ticks; tick++) {
      const source = continuation; continuation = prepareNoOptionalGrowthTickCandidateV10(source);
      expect(continuation.clock.calendarTick).toBe(source.clock.calendarTick + 1);
      if (tick === 0) expect(authenticTeachingTransitionV10(source, continuation)).toBe(true);
    }
    expect(capacity(continuation).clock!.calendarTicks).toBe(before.clock!.calendarTicks - ticks);
    expect(continuation.sectExpansion.upgrade.revision).toBe(cancelledRevision);
  }, 30000);
  it('finishes the real student knowledge once, retaining paid upgrade history without any L2 completion', () => {
    expect(continuation.clock.calendarTick).toBe(lessonEnd);
    expect(continuation.cultivation.disciples.find(profile => profile.discipleId === 'entity:3')!.teaching).toBeNull();
    expect(continuation.cultivation.disciples.find(profile => profile.discipleId === 'entity:4')!.knowledge.filter(knowledge => knowledge.knowledgeId === A))
      .toEqual([expect.objectContaining({ teacherId: 'entity:3' })]);
    expect(continuation.cultivation.events.filter(event => event.kind === 'cultivation.taught' && event.discipleId === 'entity:4')).toHaveLength(1);
    expect(continuation.sectExpansion.upgrade.jobs[0]!.terminal).toMatchObject({ kind: 'cancelled', resultLevel: 1 });
    expect(continuation.sectExpansion.upgrade.jobs[0]!.activeTicks).toBe(200);
    expect(capacity(continuation).clock!.calendarTicks).toBe(0);
    expect(inspectUnregisteredWorldV10Records(continuation)).toEqual([]);
  });
});
