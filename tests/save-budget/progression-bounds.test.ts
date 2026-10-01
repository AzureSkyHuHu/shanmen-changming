import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWorld } from '../../src/core/world/create-world';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { advanceTicksWithStatusV8 } from '../../src/core/kernel/simulation-v8';
import { drawInteger } from '../../src/core/kernel/random';
import { createBuildFrameV2, applyBuildAuthorityCommandV2 } from '../../src/core/builds/v2';
import type { BuildAuthorityCommandV2 } from '../../src/core/builds/v2-types';
import { applyCultivationCommandV3, createCultivationStateV3, createCultivatorV3, previewBreakthroughV3, stepCultivationMonthsV3 } from '../../src/core/cultivation/v3';
import type { CultivationCommand, CultivationFrame } from '../../src/core/cultivation/v3';
import type { WorldStateV8 } from '../../src/core/world/v8-types';
import { getWorldBuildContentContext } from '../../src/core/world/content-access';
import { worldBuildHistoryObligationFacts } from '../../src/core/world/progression-obligations';
import { prepareWorldEstateSettlement } from '../../src/core/world/legacy-bridge';
import { dispatchWorldCultivationV8 } from '../../src/core/world/cultivation-bridge-v8';
import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { appendHistoryBatch, createHistoryArchive, getHistoryArchiveUsage } from '../../src/core/history/archive';
import { canonicalUtf8ByteLength } from '../../src/core/save-budget/canonical-bytes';
import { assessBuildHistoryObligations } from '../../src/core/save-budget/build-obligations';
import { deriveProgressionReservations, measureProgressionRecord, verifyProgressionReservationDischarges } from '../../src/core/save-budget/progression-bounds';
import type { ProgressionReservation, ProgressionReservationAssessment } from '../../src/core/save-budget/progression-bounds';

type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
const fresh = () => migrateWorldV7ToV8(createWorld('progression-terminal-bounds'));
const budget = (world: WorldStateV8) => deriveProgressionReservations({ world, buildFacts: worldBuildHistoryObligationFacts(world) });
function life(assessment: ProgressionReservationAssessment, id: string) {
  const found = assessment.owners.find(owner => owner.kind === 'disciple-lifecycle' && owner.id === id);
  expect(found).toBeDefined(); return found!;
}
function checkRecord(owner: ProgressionReservation, label: string, actual: unknown, previous?: unknown) {
  const bound = owner.records.find(record => record.label === label);
  expect(bound, label).toBeDefined();
  const observed = measureProgressionRecord(actual);
  const used = previous === undefined ? { bytes: 0, decodedCharacters: 0, decodedNodes: 0 } : measureProgressionRecord(previous);
  expect(bound!.bytes, label).toBeGreaterThanOrEqual(observed.bytes - used.bytes);
  expect(bound!.decodedCharacters, label).toBeGreaterThanOrEqual(observed.decodedCharacters - used.decodedCharacters);
  expect(bound!.decodedNodes, label).toBeGreaterThanOrEqual(observed.decodedNodes - used.decodedNodes);
}
function publish(world: WorldStateV8, frame: CultivationFrame): WorldStateV8 {
  const events = frame.cultivation.events.slice(world.cultivation.events.length).map(event => ({ eventId: event.eventId, kind: event.kind,
    tick: world.clock.simulationTick, rootActionId: event.rootActionId, parentEventId: null,
    payload: { discipleId: event.discipleId, relatedId: event.relatedId, month: event.month } }));
  return { ...world, ...frame, disciples: world.disciples.map(actor => {
    const profile = frame.cultivation.disciples.find(profile => profile.discipleId === actor.id)!;
    return { ...actor, ageMonths: profile.ageMonths, lifeState: profile.lifeState, canWork: profile.lifeState === 'alive' && actor.canWork };
  }), events: [...world.events, ...events] };
}
function cultivate(world: WorldStateV8, body: Body<CultivationCommand>, commandId = `proof:cultivation:${world.cultivation.revision}`): WorldStateV8 {
  const result = applyCultivationCommandV3(world, { ...body, commandId, expectedRevision: world.cultivation.revision } as CultivationCommand);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code);
  return publish(world, result.frame);
}
function build(world: WorldStateV8, body: Body<BuildAuthorityCommandV2>, commandId: string): WorldStateV8 {
  const result = applyBuildAuthorityCommandV2({ builds: world.builds, sequences: world.sequences }, { ...body, commandId, expectedRevision: world.builds.revision } as BuildAuthorityCommandV2,
    getWorldBuildContentContext(world)!);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.code);
  return { ...world, builds: cloneJson(result.frame.builds), sequences: cloneJson(result.frame.sequences) } as WorldStateV8;
}
/** Legal boundary-pressure setup, not a claim that the test played a full natural
 * lifetime. Only the initial birth/age projection changes. No death/event/estate
 * evidence is fabricated; the real v8 tick and lifespan reducers create it. */
function nearLifespanEnd(world: WorldStateV8, discipleId: string): WorldStateV8 {
  const next = cloneJson(world);
  const profile = next.cultivation.disciples.find(profile => profile.discipleId === discipleId)!;
  const actor = next.disciples.find(actor => actor.id === discipleId)!;
  actor.birthCalendarTick = next.clock.calendarTick + 1 - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((next.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH);
  profile.ageMonths = actor.ageMonths; actor.canWork = true;
  expect(validateWorldStateV8(next)).toEqual([]);
  return next;
}
/** Return the real finalized lifespan stage before atomic estate settlement.
 * prepareWorldEstateSettlement owns deriving estate rows from this death fact. */
function die(world: WorldStateV8, discipleId: string): WorldStateV8 {
  const profile = world.cultivation.disciples.find(profile => profile.discipleId === discipleId)!;
  expect(profile.ageMonths + 1).toBe(profile.lifespanMonths);
  const advanced = advanceTicksWithStatusV8(world, 1);
  expect(advanced.capacityStop).toBeNull(); expect(advanced.invariantStop).toBeNull();
  const pending = advanced.world.cultivation.pendingDeaths.find(death => death.discipleId === discipleId)!;
  expect(pending).toMatchObject({ discipleId, cause: 'lifespan' });
  expect(advanced.world.cultivation.events.some(event => event.kind === 'cultivation.expiryPending'
    && event.discipleId === discipleId && event.relatedId === pending.deathId)).toBe(true);
  expect(validateWorldStateV8(advanced.world)).toEqual([]);
  const finalized = dispatchWorldCultivationV8(advanced.world, { kind: 'death.finalize', commandId: `proof:lifespan:${advanced.world.cultivation.revision}`,
    expectedRevision: advanced.world.cultivation.revision, discipleId, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true });
  expect(finalized.ok, JSON.stringify(finalized)).toBe(true); if (!finalized.ok) throw new Error(finalized.code);
  expect(finalized.world.cultivation.deaths.find(death => death.deathId === pending.deathId)).toMatchObject({ discipleId, cause: 'lifespan' });
  // This is the World cultivation adapter, not dispatchCommandV8: retirement
  // must still be owed so the following settlement assertions exercise new work.
  expect(finalized.world.builds.retiredDisciples).toEqual(world.builds.retiredDisciples);
  expect(finalized.world.cultivation.archivedDisciples).toEqual(world.cultivation.archivedDisciples);
  expect(finalized.world.legacy.estates.some(estate => estate.deathId === pending.deathId)).toBe(false);
  return finalized.world;
}
function settle(world: WorldStateV8): WorldStateV8 {
  const result = prepareWorldEstateSettlement(world);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.details.join('; '));
  return result.candidate;
}

/** These are real valid domain fixtures, not a claim of campaign grant provenance.
 * Tests below execute the domain reducers and compare their retained records. */
function domainFixture(count = 4, maximumIds = false): WorldStateV8 {
  const world = fresh();
  const ids = Array.from({ length: count }, (_, index) => maximumIds ? `entity:${Number.MAX_SAFE_INTEGER - 100 + index}` : `entity:${index + 1}`);
  const sequences = maximumIds ? { nextEntity: Number.MAX_SAFE_INTEGER - 10, nextInstance: Number.MAX_SAFE_INTEGER - 1000,
    nextEvent: Number.MAX_SAFE_INTEGER - 1000, nextAction: Number.MAX_SAFE_INTEGER - 1000 } : world.sequences;
  const frame = createBuildFrameV2({ contentMode: 'experimental', sequences, disciples: ids.map(discipleId => ({ discipleId, school: 'alchemy' })) }, getWorldBuildContentContext(world)!);
  world.builds = cloneJson(frame.builds) as WorldStateV8['builds']; world.sequences = cloneJson(frame.sequences);
  world.cultivation = createCultivationStateV3(ids.map(id => createCultivatorV3(id, { aptitude: 100, understanding: 100, foundation: 100, mindset: 100 })));
  const actor = world.disciples[0]!;
  world.disciples = ids.map((id, index) => ({ ...cloneJson(actor), id, ageMonths: 216, aptitude: 100, birthCalendarTick: -216 * 1200,
    nameKey: `disciple.${index}`, presentationId: 'disciple-0' }));
  world.sectEconomy.plans = [];
  return world;
}
function withLesson(world: WorldStateV8, teacherId: string): WorldStateV8 {
  const profiles = cloneJson(world.cultivation.disciples);
  profiles.find(profile => profile.discipleId === teacherId)!.knowledge.push({ knowledgeId: 'knowledge.clear-heart', teacherId: null, teachingId: null });
  world = { ...world, cultivation: createCultivationStateV3(profiles) };
  return build(world, { kind: 'skill.grantKnowledge', discipleId: teacherId, acquisitionId: `archive/${teacherId}`, skillId: 'skill.qingxin',
    provenance: { kind: 'archive', knowledgeId: 'knowledge.clear-heart' } }, `archive/${teacherId}`);
}
function grantTeaching(world: WorldStateV8, teachingId: string): WorldStateV8 {
  const taught = world.cultivation.events.find(event => event.kind === 'cultivation.taught' && event.relatedId === teachingId)!;
  const knowledge = world.cultivation.disciples.find(profile => profile.discipleId === taught.discipleId)!.knowledge.find(knowledge => knowledge.teachingId === teachingId)!;
  const acquisitionId = `teaching/${teachingId}/${taught.discipleId}`;
  return build(world, { kind: 'skill.grantKnowledge', discipleId: taught.discipleId, skillId: 'skill.qingxin', acquisitionId,
    provenance: { kind: 'teaching', knowledgeId: knowledge.knowledgeId, teacherId: knowledge.teacherId!, teachingId } }, acquisitionId);
}

describe('bounded progression terminal records', () => {
  test('initial reserve has exactly D + actual item-chain rows, with explicit exclusions', () => {
    const world = fresh(); const result = budget(world);
    expect(result.supported, result.unknowns.join('; ')).toBe(true);
    expect(result.totals.buildRows).toBe(16);
    expect(result.totals.buildRows).toBe(assessBuildHistoryObligations(worldBuildHistoryObligationFacts(world)).reservedCommands);
    expect(result.totals.cultivationRows).toEqual({ receipts: 4, events: 8, pendingDeaths: 4, deaths: 4, archivedDisciples: 4, authorityReceipts: 4 });
    expect(result.totals.legacyRows).toEqual({ estates: 4, archivedIdentities: 4 });
    expect(result.excluded.join(' ')).toContain('whole-World 4MiB');
    expect(result.excluded.join(' ')).toContain('run/battle');
  });

  test('actual reducer retirement, source removals, transfers and both archives fit their typed records', () => {
    const world = nearLifespanEnd(fresh(), 'entity:1'); const before = budget(world); const source = cloneJson(world);
    const dead = die(world, 'entity:1'); const after = settle(dead); const owner = life(before, 'entity:1');
    expect(validateWorldStateV8(after)).toEqual([]);
    expect(after.builds.history.length - dead.builds.history.length).toBe(4);
    expect(after.builds.retiredDisciples.length - dead.builds.retiredDisciples.length).toBe(1);
    expect(after.cultivation.archivedDisciples.length - dead.cultivation.archivedDisciples.length).toBe(1);
    expect(after.legacy.archivedIdentities.length - dead.legacy.archivedIdentities.length).toBe(1);
    expect(after.legacy.estates.length - dead.legacy.estates.length).toBe(1);
    const receipt = after.builds.receipts.find(receipt => receipt.commandId.endsWith('/retire'))!;
    checkRecord(owner, 'retirement:build.receipt+escaped-fingerprint+source-operations', receipt);
    expect(receipt.operations).toHaveLength(world.builds.disciples[0]!.sources.length);
    checkRecord(owner, 'retirement:build.history', after.builds.history.find(entry => entry.command.kind === 'disciple.retire'));
    checkRecord(owner, 'retirement:build.summary+retained-learned-provenance', after.builds.retiredDisciples[0]);
    checkRecord(owner, 'archive:cultivation.authority-receipt+escaped-fingerprint', after.cultivation.authorityReceipts.at(-1));
    checkRecord(owner, 'archive:cultivation.profile+knowledge+talents', after.cultivation.archivedDisciples[0]);
    checkRecord(owner, 'archive:World.identity+actual-escaped-name', after.legacy.archivedIdentities[0]);
    checkRecord(owner, 'estate:record+item-list+transfer-provenance+pending-run+terminal-owner', after.legacy.estates[0]);
    for (const entry of after.builds.history.filter(entry => entry.command.kind === 'equipment.transfer')) {
      if (entry.command.kind !== 'equipment.transfer') continue;
      checkRecord(owner, `transfer:${entry.command.itemInstanceId}:build.history`, entry);
      checkRecord(owner, `transfer:${entry.command.itemInstanceId}:build.receipt+escaped-fingerprint+source-operations`, after.builds.receipts.find(receipt => receipt.commandId === entry.command.commandId));
    }
    const next = budget(after);
    expect(canonicalUtf8ByteLength(after) - canonicalUtf8ByteLength(world)).toBeLessThanOrEqual(before.totals.bytes - next.totals.bytes);
    expect(verifyProgressionReservationDischarges({ world, assessment: before }, { world: after, assessment: next }))
      .toMatchObject({ supported: true, discharged: ['disciple-lifecycle:entity:1'] });
    expect(world).toEqual(source);
  });

  test('item and relic reservations follow the future heir, survive the first death, and are not charged twice', () => {
    const source = createWorld('progression-inheritance');
    source.cultivation.disciples[0]!.relicIds = ['relic:first', 'r'.repeat(128)];
    let world = nearLifespanEnd(migrateWorldV7ToV8(source), 'entity:1');
    world = cultivate(world, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' });
    world = cultivate(world, { kind: 'legacy.setHeir', discipleId: 'entity:2', heirId: 'entity:3' });
    const before = budget(world);
    // First owner's three items traverse three owners; second owner's three
    // traverse two; the remaining six traverse one: 21 transfers + 4 retirements.
    expect(before.totals.buildRows).toBe(25);
    const inherited = world.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === 'entity:1').map(item => item.instanceId);
    const heir = life(before, 'entity:2');
    for (const id of inherited) expect(heir.records.some(record => record.label === `transfer:${id}:build.history`)).toBe(true);
    const dead = die(world, 'entity:1'); const pending = budget(dead);
    expect(life(pending, 'entity:1').buildRows).toBe(4);
    const settled = settle(dead); const after = budget(settled);
    expect(settled.builds.history.length - dead.builds.history.length).toBe(4);
    expect(settled.builds.retiredDisciples.length - dead.builds.retiredDisciples.length).toBe(1);
    expect(settled.cultivation.archivedDisciples.length - dead.cultivation.archivedDisciples.length).toBe(1);
    expect(after.totals.buildRows).toBe(21);
    expect(life(after, 'entity:2').buildRows).toBe(7);
    expect(life(after, 'entity:3').buildRows).toBe(10);
    expect(settled.cultivation.disciples.find(profile => profile.discipleId === 'entity:2')!.relicIds).toHaveLength(2);
    expect(canonicalUtf8ByteLength(settled) + after.totals.bytes).toBeLessThanOrEqual(canonicalUtf8ByteLength(world) + before.totals.bytes);
    expect(budget(settle(settled))).toEqual(after);
  });

  test('maximum generated IDs, escaped legacy display text and fingerprints are measured rather than character-guessed', () => {
    let world = domainFixture(2, true); const [teacher, student] = world.disciples;
    world.disciples[0]!.nameKey = '\u0000"\\\n雪\ud800'.repeat(1000);
    world = withLesson(world, teacher!.id);
    world = cultivate(world, { kind: 'teaching.begin', discipleId: teacher!.id, studentId: student!.id, knowledgeId: 'knowledge.clear-heart' }, 'z'.repeat(128));
    const before = budget(world); expect(before.supported, before.unknowns.join(';')).toBe(true);
    const teaching = before.owners.find(owner => owner.kind === 'teaching')!;
    const step = stepCultivationMonthsV3(world, 2); expect(step.processedMonths).toBe(2);
    const taught = grantTeaching(publish(world, step.frame), teaching.id);
    checkRecord(teaching, 'teaching-grant:build.receipt+escaped-fingerprint+source-operations', taught.builds.receipts.at(-1));
    const identity = { discipleId: teacher!.id, nameKey: world.disciples[0]!.nameKey, presentationId: 'disciple-0', birthCalendarTick: teacher!.birthCalendarTick,
      ageMonths: 218, aptitude: 100, school: 'alchemy', realm: 'mortal', deathId: `instance:${Number.MAX_SAFE_INTEGER - 800}`, archivedMonth: 2 };
    checkRecord(life(before, teacher!.id), 'archive:World.identity+actual-escaped-name', identity);
    expect(measureProgressionRecord(identity).bytes).toBeGreaterThan(measureProgressionRecord(identity).decodedCharacters);
    expect(taught.builds.receipts.at(-1)!.fingerprint).toContain('"authority":true');
  });

  test('same-month expiry, teaching and ready breakthrough retain every independent event and realm row', () => {
    let world = domainFixture(6); world = withLesson(world, 'entity:3');
    world = cultivate(world, { kind: 'teaching.begin', discipleId: 'entity:3', studentId: 'entity:4', knowledgeId: 'knowledge.clear-heart' });
    const firstMonth = stepCultivationMonthsV3(world, 1); expect(firstMonth.processedMonths).toBe(1); world = publish(world, firstMonth.frame);
    world.cultivation.disciples[0]!.ageMonths = 959; world.cultivation.disciples[1]!.ageMonths = 959;
    world.cultivation.disciples[4]!.cultivation = 120;
    const preview = previewBreakthroughV3(world, 'entity:5');
    world = cultivate(world, { kind: 'breakthrough.confirm', preview });
    const attemptId = world.cultivation.disciples[4]!.activeAttemptId!;
    world = cultivate(world, { kind: 'breakthrough.begin', attemptId });
    const before = budget(world); expect(before.supported, before.unknowns.join(';')).toBe(true);
    expect(before.totals.buildRows).toBe(6 + 18 + 1 + 1);
    const step = stepCultivationMonthsV3(world, 1); expect(step.processedMonths).toBe(1);
    let next = publish(world, step.frame);
    const newEvents = next.cultivation.events.slice(world.cultivation.events.length);
    expect(newEvents.map(event => event.kind).sort()).toEqual(['cultivation.expiryPending', 'cultivation.expiryPending', 'cultivation.ready', 'cultivation.taught'].sort());
    expect(before.totals.cultivationRows.events).toBeGreaterThanOrEqual(newEvents.length);
    expect(before.totals.archiveRows.events).toBeGreaterThanOrEqual(newEvents.length);
    const teaching = before.owners.find(owner => owner.kind === 'teaching')!;
    expect(budget(next).owners.some(owner => owner.kind === 'teaching' && owner.id === teaching.id)).toBe(true);
    next = grantTeaching(next, teaching.id);
    // Fix only the future random input; no draw has happened and preview does not
    // commit a particular RNG state. Select a genuine reducer success branch.
    for (let state = 1; state < 100; state += 1) {
      next.randomStreams.events.state = state;
      if (drawInteger(next.randomStreams, 'events', 1, 10000).value <= preview.successBps) break;
    }
    next = cultivate(next, { kind: 'breakthrough.resolve', attemptId, acknowledgeRisk: true });
    expect(next.cultivation.attempts.find(attempt => attempt.attemptId === attemptId)!.outcome).toBe('success');
    next = build(next, { kind: 'milestone.award', discipleId: 'entity:5', milestoneId: 'realm/entity:5/qi', ruleId: 'realm.qi' }, 'system/realm/entity:5/qi');
    const attemptOwner = before.owners.find(owner => owner.kind === 'breakthrough')!;
    checkRecord(attemptOwner, 'award:realm/entity:5/qi:build.history', next.builds.history.at(-1));
    checkRecord(attemptOwner, 'breakthrough:terminal-attempt+sample+actual-preview+legacy-fields', next.cultivation.attempts.find(attempt => attempt.attemptId === attemptId), world.cultivation.attempts.find(attempt => attempt.attemptId === attemptId));
    expect(budget(next).totals.buildRows).toBe(24);
  });

  test('a non-permanent legacy teaching still owes cultivation knowledge and event copies', () => {
    let world = domainFixture(2);
    world.cultivation.disciples[0]!.knowledge.push({ knowledgeId: 'knowledge.old', teacherId: null, teachingId: null });
    world.cultivation = createCultivationStateV3(world.cultivation.disciples);
    world = cultivate(world, { kind: 'teaching.begin', discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.old' });
    expect(worldBuildHistoryObligationFacts(world).teachingIds).toEqual([]);
    const result = budget(world); const teaching = result.owners.find(owner => owner.kind === 'teaching')!;
    expect(teaching.buildRows).toBe(0); expect(teaching.cultivationRows.events).toBe(1); expect(teaching.archiveRows.events).toBe(1);
    expect(teaching.sequenceReserve.nextAction).toBe(2);
  });

  test('teaching plan disappearance and partial retirement are not terminal release evidence', () => {
    let world = withLesson(domainFixture(2), 'entity:1');
    world = cultivate(world, { kind: 'teaching.begin', discipleId: 'entity:1', studentId: 'entity:2', knowledgeId: 'knowledge.clear-heart' });
    const before = budget(world); const teaching = before.owners.find(owner => owner.kind === 'teaching')!;
    const lost = cloneJson(world); lost.cultivation.disciples[0]!.teaching = null;
    expect(verifyProgressionReservationDischarges({ world, assessment: before }, { world: lost, assessment: budget(lost) }))
      .toMatchObject({ supported: false, unknowns: [`Missing complete terminal evidence for teaching:${teaching.id}`] });
    const step = stepCultivationMonthsV3(world, 2); const intermediate = publish(world, step.frame);
    expect(budget(intermediate).owners.find(owner => owner.kind === 'teaching')!.buildRows).toBe(1);
    const granted = grantTeaching(intermediate, teaching.id);
    expect(verifyProgressionReservationDischarges({ world, assessment: before }, { world: granted, assessment: budget(granted) }))
      .toMatchObject({ supported: true, discharged: [`teaching:${teaching.id}`] });
    const dead = die(nearLifespanEnd(fresh(), 'entity:1'), 'entity:1'); const deathId = dead.cultivation.deaths.at(-1)!.deathId;
    const partial = build(dead, { kind: 'disciple.retire', discipleId: 'entity:1', deathId }, `death/${deathId}/retire`);
    const partialFacts = worldBuildHistoryObligationFacts(dead);
    expect(deriveProgressionReservations({ world: partial, buildFacts: partialFacts })).toMatchObject({ supported: false, owners: [] });
  });

  test('exact World archive decoded charges agree with codec accounting, including its 32-node per-row charge', () => {
    const world = nearLifespanEnd(fresh(), 'entity:1'); const next = die(world, 'entity:1'); const event = next.events.at(-1)!;
    const usage = getHistoryArchiveUsage(appendHistoryBatch(createHistoryArchive(), { events: [event] }));
    const record = measureProgressionRecord(event);
    expect(usage.expandedCharacters).toBe(record.decodedCharacters);
    expect(usage.expandedNodes).toBe(record.decodedNodes + 32);
    const commitment = life(budget(world), 'entity:1');
    checkRecord(commitment, 'death:World.event-copy', event);
    expect(commitment.archiveBytes).toBeLessThan(commitment.bytes);
  });

  test('unsupported terminal namespaces and exhausted IDs fail closed with no partial allowance', () => {
    const world = fresh(); const facts = worldBuildHistoryObligationFacts(world);
    world.builds.equipment[0]!.instanceId = 'i'.repeat(120);
    const changedFacts = { ...facts, equipment: facts.equipment.map((item, index) => index === 0 ? { ...item, itemInstanceId: 'i'.repeat(120) } : item) };
    const result = deriveProgressionReservations({ world, buildFacts: changedFacts });
    expect(result).toMatchObject({ supported: false, owners: [], totals: { bytes: 0 } });
    expect(result.unknowns.join(';')).toContain('identity exceeds legal width');
    const exhausted = fresh(); exhausted.sequences.nextEvent = Number.MAX_SAFE_INTEGER;
    expect(budget(exhausted)).toMatchObject({ supported: true, numeric: { fits: false, diagnostics: ['Insufficient terminal nextEvent headroom'] } });
  });

  test('run-build discharge requires first-victory awards as well as Ended and unlock', () => {
    const fixture = (name: string) => migrateWorldV7ToV8(JSON.parse(readFileSync(new URL(`../integration/fixtures/${name}`, import.meta.url), 'utf8')).payload);
    const before = fixture('save-v7-active-battle.json'); const after = fixture('save-v7-ended-clear.json');
    expect(before.expedition.run!.runId).toBe(after.expedition.run!.runId);
    expect(verifyProgressionReservationDischarges({ world: before, assessment: budget(before) }, { world: after, assessment: budget(after) }))
      .toMatchObject({ supported: true, discharged: ['run-build:run:1'] });
    const missing = cloneJson(after); const survivor = missing.expedition.run!.members.find(member => member.alive)!.discipleId;
    missing.builds.awards = missing.builds.awards.filter(award => award.discipleId !== survivor || award.ruleId !== 'expedition.first-victory');
    expect(verifyProgressionReservationDischarges({ world: before, assessment: budget(before) }, { world: missing, assessment: budget(missing) }))
      .toMatchObject({ supported: false, unknowns: ['Missing complete terminal evidence for run-build:run:1'] });
  });

  test('root events RNG state width has its own measured delta, independent of sample record slack', () => {
    const small = fresh(); small.randomStreams.events.state = 1;
    const large = cloneJson(small); large.randomStreams.events.state = 0xffffffff;
    const before = budget(small); const after = budget(large);
    const requiredGrowth = String(0xffffffff).length - String(1).length;
    for (const commitment of before.owners) {
      const prior = commitment.records.find(record => record.label === 'shared-counter-width-growth')!;
      const next = after.owners.find(owner => owner.id === commitment.id && owner.kind === commitment.kind)!.records
        .find(record => record.label === 'shared-counter-width-growth')!;
      expect(prior.bytes - next.bytes).toBe(requiredGrowth);
      expect(prior.decodedCharacters - next.decodedCharacters).toBe(requiredGrowth);
      expect(prior.decodedNodes).toBe(next.decodedNodes);
    }
    expect(before.totals.bytes - after.totals.bytes).toBe(requiredGrowth * before.owners.length);
    expect(small.randomStreams.events.state).toBe(1);
  });

  test('input order, deep freezing and rejected accessor inputs never mutate or allocate identities', () => {
    const world = fresh(); const before = canonicalStringify(world); const normal = budget(world);
    world.disciples.reverse(); world.cultivation.disciples.reverse(); world.builds.disciples.reverse(); world.builds.equipment.reverse();
    expect(budget(world)).toEqual(normal);
    const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } };
    const pristine = fresh(); freeze(pristine); expect(budget(pristine)).toEqual(normal); expect(canonicalStringify(pristine)).toBe(before);
    let called = false;
    const hostile = Object.defineProperty({}, 'world', { enumerable: true, get() { called = true; return pristine; } });
    expect(deriveProgressionReservations(hostile as { world: WorldStateV8; buildFacts: ReturnType<typeof worldBuildHistoryObligationFacts> })).toMatchObject({ supported: false });
    expect(called).toBe(false); expect(Object.isFrozen(normal)).toBe(true); expect(Object.isFrozen(normal.owners[0]!.records)).toBe(true);
  });
});
