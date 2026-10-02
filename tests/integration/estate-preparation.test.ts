import { describe, expect, it } from 'vitest';
import { applyBuildAuthorityCommandV2, applyBuildCommandV2, createBuildFrameV2 } from '../../src/core/builds/v2';
import type { BuildCommand } from '../../src/core/builds/types';
import type { BuildContentContext } from '../../src/core/builds/v2-types';
import { reconcileWorldExpeditionDeathsV8 } from '../../src/core/expeditions/v8-world-adapter';
import { copy } from '../../src/core/expeditions/shared';
import { applyCultivationCommandV3 } from '../../src/core/cultivation/v3';
import { appendHistoryBatch } from '../../src/core/history';
import { CALENDAR_TICKS_PER_MONTH } from '../../src/core/kernel/clock';
import { dispatchCommandV8 } from '../../src/core/kernel/commands-v8';
import type { CommandResult, PlayerCultivationCommand } from '../../src/core/kernel/contracts';
import type { CommandV8 } from '../../src/core/kernel/contracts-v8';
import { createSaveEnvelopeV8, parseSaveV8, serializeSaveV8 } from '../../src/core/kernel/save-v8';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { advanceTicksWithStatusV8 } from '../../src/core/kernel/simulation-v8';
import { validateWorldStateV8 } from '../../src/core/kernel/validation';
import { measureWorldSaveBytes, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import { getWorldBuildContentContext } from '../../src/core/world/content-access';
import { createWorldV8 } from '../../src/core/world/create-world-v8';
import { dispatchWorldCultivationV8 } from '../../src/core/world/cultivation-bridge-v8';
import { cultivationFrameOf, prepareCultivationClockAdvance, projectCultivationDisciples } from '../../src/core/world/cultivation-preparation';
import { prepareEstateResponsibilities, prepareEstateSettlement } from '../../src/core/world/estate-preparation';
import { lookupProduction, recordWorldReceipt, restoreWorldHistory, worldEventCursor, worldEventsSince } from '../../src/core/world/history-access';
import { prepareWorldEstateSettlement } from '../../src/core/world/legacy-bridge';
import { assessWorldBuildHistoryObligations } from '../../src/core/world/progression-obligations';
import type { WorldStateV8 } from '../../src/core/world/v8-types';
import { prepareWorldEstateSettlement as frozenEstate } from './fixtures/pre-extraction-legacy-bridge';

type Body<T> = T extends T ? Omit<T, 'commandId' | 'expectedRevision'> : never;
type CultureCommand = Extract<CommandV8, { kind: 'cultivation.command' }>;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function cultureCommand(world: WorldStateV8, body: Body<PlayerCultivationCommand>): CultureCommand {
  const commandId = `estate-port:${world.cultivation.revision}`;
  return { kind: 'cultivation.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { command: { ...body, commandId, expectedRevision: world.cultivation.revision } as PlayerCultivationCommand } };
}
function accepted(world: WorldStateV8, command: CommandV8): WorldStateV8 {
  const operation = dispatchCommandV8(world, command);
  expect(operation.result.status, JSON.stringify(operation.result)).toBe('accepted');
  expect(validateWorldStateV8(operation.world)).toEqual([]); return operation.world;
}
function advance(world: WorldStateV8, ticks: number): WorldStateV8 {
  const operation = advanceTicksWithStatusV8(world, ticks);
  expect(operation.invariantStop, JSON.stringify(operation.invariantStop)).toBeNull(); expect(operation.capacityStop).toBeNull();
  expect(validateWorldStateV8(operation.world)).toEqual([]); return operation.world;
}
/** Declared near-lifespan chronology fixture. No death/event/estate is fabricated. */
function expireAt(world: WorldStateV8, discipleId: string, tick: number): void {
  const actor = world.disciples.find(member => member.id === discipleId)!;
  const profile = world.cultivation.disciples.find(member => member.discipleId === discipleId)!;
  actor.birthCalendarTick = tick - profile.lifespanMonths * CALENDAR_TICKS_PER_MONTH;
  actor.ageMonths = Math.floor((world.clock.calendarTick - actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH); profile.ageMonths = actor.ageMonths;
}
function starting(heir = true): WorldStateV8 {
  let world = createWorldV8('estate-preparation');
  if (heir) world = accepted(world, cultureCommand(world, { kind: 'legacy.setHeir', discipleId: 'entity:1', heirId: 'entity:2' }));
  world = cloneJson(world); expireAt(world, 'entity:1', 1);
  expect(validateWorldStateV8(world)).toEqual([]); return world;
}
function finalizeCommand(world: WorldStateV8, discipleId = 'entity:1'): CultureCommand {
  const pending = world.cultivation.pendingDeaths.find(death => death.discipleId === discipleId)!;
  return cultureCommand(world, { kind: 'death.finalize', discipleId, deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true });
}
/** Exact existing command-owned intermediate, deliberately stopped before estate
 * admission. This is not a second World validator or a fabricated death fixture. */
function finalizedBeforeEstate(pending: WorldStateV8, input = finalizeCommand(pending)): WorldStateV8 {
  const operation = dispatchWorldCultivationV8(pending, input.payload.command, { commandId: input.commandId });
  expect(operation.ok).toBe(true); if (!operation.ok) throw new Error(operation.code);
  const reconciled = reconcileWorldExpeditionDeathsV8(operation.world);
  const result: CommandResult = { commandId: input.commandId, status: 'accepted', transactionId: null,
    eventIds: worldEventsSince(reconciled, worldEventCursor(pending)).map(event => event.eventId), rejection: null, cultivationResult: operation.result };
  return recordWorldReceipt(reconciled, { commandId: input.commandId,
    fingerprint: canonicalStringify({ kind: input.kind, payload: input.payload }), result });
}
function rawFinalized(heir = true): WorldStateV8 { return finalizedBeforeEstate(advance(starting(heir), 1)); }
function structural(world: WorldStateV8) {
  return { ...cultivationFrameOf(world), builds: world.builds, legacy: world.legacy, disciples: world.disciples,
    activeProductionTransactionIds: world.activeProductionTransactionIds, transactions: world.transactions, automaticProduction: world.automaticProduction };
}
function registered(world: WorldStateV8): WorldStateV8 {
  const responsibilities = prepareEstateResponsibilities(structural(world));
  expect(responsibilities.ok).toBe(true); if (!responsibilities.ok) throw new Error(responsibilities.details.join('; '));
  return { ...world, legacy: responsibilities.legacy };
}
function compare(world: WorldStateV8) {
  const before = canonicalStringify(world); freeze(world);
  const expected = frozenEstate(world); const actual = prepareWorldEstateSettlement(world);
  expect(canonicalStringify(actual)).toBe(canonicalStringify(expected));
  expect(canonicalStringify(world)).toBe(before); return actual;
}
function success(world: WorldStateV8) {
  const result = compare(world); expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.details.join('; ')); return result;
}
function reload(world: WorldStateV8): WorldStateV8 {
  const result = parseSaveV8(serializeSaveV8(createSaveEnvelopeV8(world, { buildId: 'estate-preparation', savedAt: '2026-10-02T06:00:00Z' })));
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.world;
}
function depart(world: WorldStateV8, squadIds: string[]): WorldStateV8 {
  const commandId = 'estate-port:depart';
  return accepted(world, { kind: 'expedition.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { command: { kind: 'expedition.depart', commandId, request: { routeId: 'route.qingfeng-trial', squadIds } } } });
}
function expedition(world: WorldStateV8, kind: 'expedition.continue' | 'expedition.retreat'): WorldStateV8 {
  const commandId = `estate-port:run:${world.expedition.run!.revision}`;
  return accepted(world, { kind: 'expedition.command', commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    payload: { command: { kind, commandId } } });
}

describe('unadmitted estate preparation and strict v8 publication', () => {
  it.each([true, false])('registers a real lifespan estate and prepares ordered physical transfers with heir=%s', heir => {
    const world = rawFinalized(heir); const source = freeze(structural(world)); const before = canonicalStringify(source);
    const responsibility = prepareEstateResponsibilities(source);
    expect(responsibility.ok).toBe(true); if (!responsibility.ok) throw new Error(responsibility.details.join('; '));
    const death = source.cultivation.deaths[0]!;
    const items = source.builds.equipment.filter(item => item.owner.kind === 'disciple' && item.owner.discipleId === 'entity:1').map(item => item.instanceId);
    expect(items.length).toBeGreaterThan(0);
    expect(responsibility.legacy.estates).toEqual([{ estateId: `estate/${death.deathId}`, deathId: death.deathId, discipleId: 'entity:1', beneficiaryId: heir ? 'entity:2' : null,
      itemInstanceIds: items, pendingRunId: null, transferCommandIds: [], recordedMonth: death.month, settledMonth: null, settledOwner: null }]);
    expect(source.legacy.estates).toEqual([]);
    const prepared = prepareEstateSettlement({ ...source, legacy: responsibility.legacy,
      disciples: source.disciples.map(actor => ({ ...actor, retainedActorField: 'kept' })) }, getWorldBuildContentContext(world)!);
    expect(prepared.ok).toBe(true); if (!prepared.ok) throw new Error(prepared.details.join('; '));
    expect(Object.keys(prepared.frame).sort()).toEqual(['builds', 'cultivation', 'disciples', 'inventory', 'legacy', 'randomStreams', 'sequences']);
    expect(prepared.retiredDiscipleIds).toEqual(['entity:1']); expect(prepared.settledDeathIds).toEqual([death.deathId]); expect(prepared.pendingDeathIds).toEqual([]);
    expect(prepared.frame.disciples.every(actor => actor.retainedActorField === 'kept')).toBe(true);
    expect(prepared.frame.builds.history.slice(source.builds.history.length).map(entry => entry.command.commandId))
      .toEqual([`death/${death.deathId}/retire`, ...items.map(id => `death/${death.deathId}/item/${id}`)]);
    expect(prepared.frame.legacy.estates[0]!.settledOwner).toEqual(heir ? { kind: 'disciple', discipleId: 'entity:2' } : { kind: 'sect-estate' });
    expect(prepared.frame.cultivation.authorityReceipts.at(-1)!.command.commandId).toBe(`death/${death.deathId}/archive`);
    expect(prepared.frame.randomStreams).toEqual(source.randomStreams); expect(prepared.frame.sequences).toEqual(source.sequences);
    expect(canonicalStringify(source)).toBe(before);
    const actual = success(world).candidate; expect(validateWorldStateV8(actual)).toEqual([]);
    const rowsBefore = assessWorldBuildHistoryObligations(registered(world)); const rowsAfter = assessWorldBuildHistoryObligations(actual);
    expect(rowsAfter.historyCount + rowsAfter.reservedCommands).toBeLessThanOrEqual(rowsBefore.historyCount + rowsBefore.reservedCommands);
    expect(actual.events).toEqual(world.events); expect(actual.commandReceipts).toEqual(world.commandReceipts);
    const restored = reload(actual); const retry = success(restored);
    expect(retry.candidate).toEqual(restored); expect(retry.settledDeathIds).toEqual([]); expect(retry.pendingDeathIds).toEqual([]);
  });

  it('keeps preparation distinct from aggregate reservation admission without deleting reserved resources', () => {
    const world = registered(rawFinalized()); world.inventory.wood.reserved = 1;
    const source = freeze(structural(world)); const before = canonicalStringify(source);
    const result = prepareEstateSettlement(source, getWorldBuildContentContext(world)!);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.details.join('; '));
    expect(result.frame.inventory.wood.reserved).toBe(1);
    expect(validateWorldStateV8({ ...world, ...result.frame })).toEqual(['Reservation totals do not match inventory']);
    expect(compare(world)).toEqual({ ok: false, code: 'INVALID_STATE', details: ['Reservation totals do not match inventory'] });
    expect(canonicalStringify(source)).toBe(before);
  });

  it('authenticates raw history, shares only authenticated history, and retains retired identity after JSON reload', () => {
    let world = rawFinalized();
    // Place the actual lifecycle prefix in the immutable archive without changing
    // event order or identity, then test wire restoration rather than Object.freeze.
    world = { ...world, history: appendHistoryBatch(world.history, { events: world.events }), events: [] };
    const raw = cloneJson(world); freeze(raw);
    const result = success(raw); expect(result.candidate.history).not.toBe(raw.history); expect(result.candidate.history).toEqual(raw.history);
    const authenticated = restoreWorldHistory(raw); const shared = success(authenticated);
    expect(shared.candidate.history).toBe(authenticated.history);
    const restored = reload(shared.candidate);
    expect(restored.legacy.archivedIdentities[0]).toMatchObject({ discipleId: 'entity:1', nameKey: 'disciple.starter.1', presentationId: 'disciple-0' });
    expect(restored.builds.retiredDisciples[0]!.deathId).toBe(restored.cultivation.archivedDisciples[0]!.deathId);
    expect(restored.disciples.some(actor => actor.id === 'entity:1')).toBe(false);
    expect(worldEventsSince(restored, 0)).toEqual(worldEventsSince(world, 0));
    const invalid = { ...raw, history: { ...raw.history, events: { ...raw.history.events, count: raw.history.events.count + 1 } } };
    const before = canonicalStringify(invalid); freeze(invalid);
    expect(() => frozenEstate(invalid)).toThrow(); expect(() => prepareWorldEstateSettlement(invalid)).toThrow();
    expect(canonicalStringify(invalid)).toBe(before);
  });

  it('transfers to a genuinely locked living heir without altering or auto-equipping that locked build', () => {
    const pending = advance(depart(starting(), ['entity:2', 'entity:3']), 1);
    const raw = finalizedBeforeEstate(pending); const heir = cloneJson(raw.builds.disciples.find(member => member.discipleId === 'entity:2')!);
    expect(heir.lock).not.toBeNull(); const result = success(raw);
    expect(result.candidate.legacy.estates[0]!.settledOwner).toEqual({ kind: 'disciple', discipleId: 'entity:2' });
    expect(result.candidate.builds.disciples.find(member => member.discipleId === 'entity:2')).toEqual(heir);
    expect(result.candidate.expedition).toEqual(raw.expedition); expect(validateWorldStateV8(result.candidate)).toEqual([]);
  });

  it('defers a genuinely locked deceased traveler through the return leg and retires only after real unlock', () => {
    let world = starting();
    // Expiry on the already-paid return leg keeps this a short no-battle journey.
    expireAt(world, 'entity:1', CALENDAR_TICKS_PER_MONTH + 1);
    world = advance(depart(world, ['entity:1', 'entity:2']), CALENDAR_TICKS_PER_MONTH);
    expect(world.expedition.run?.phase).toBe('AtNode'); world = expedition(world, 'expedition.retreat'); world = expedition(world, 'expedition.continue');
    world = advance(world, 1); const input = finalizeCommand(world); const raw = finalizedBeforeEstate(world, input);
    const deferred = success(raw); expect(deferred.settledDeathIds).toEqual([]); expect(deferred.pendingDeathIds).toEqual([raw.cultivation.deaths[0]!.deathId]);
    expect(deferred.candidate.builds).toEqual(raw.builds); expect(deferred.candidate.cultivation).toEqual(raw.cultivation);
    expect(deferred.candidate.legacy.estates[0]!.pendingRunId).toBe(raw.expedition.run!.runId);
    world = accepted(world, input); expect(world).toEqual(deferred.candidate); world = reload(world);
    world = advance(world, CALENDAR_TICKS_PER_MONTH - 1);
    expect(world.expedition.run?.phase).toBe('Ended'); expect(world.expedition.run?.locked).toBe(false);
    expect(world.legacy.estates[0]!.pendingRunId).toBeNull(); expect(world.legacy.estates[0]!.settledMonth).not.toBeNull();
    const operations = world.builds.history.map(entry => entry.command.kind);
    expect(operations.indexOf('expedition.unlock')).toBeLessThan(operations.indexOf('disciple.retire'));
    expect(world.builds.retiredDisciples).toHaveLength(1); expect(world.cultivation.archivedDisciples).toHaveLength(1);
    expect(dispatchCommandV8(reload(world), input).result.status).toBe('accepted'); expect(success(world).settledDeathIds).toEqual([]);
  });
});

/** Imported-history pressure fixture: repeat only the replayable no-effect
 * loadout command. Two genuine domain calls establish its exact row/receipt
 * shape before batching the prefix. This large prefix checks row obligations,
 * not end-to-end admission: the current full-history validator has quadratic
 * replay cost and cannot complete the wrapper/oracle case within five seconds. */
function withBuildRows(source: WorldStateV8, count: number): WorldStateV8 {
  const world = cloneJson(source); const context = getWorldBuildContentContext(world)!;
  const loadout = world.builds.disciples.find(member => member.discipleId === 'entity:2')!.loadout;
  const nextCommand = (): BuildCommand => ({ kind: 'loadout.set', commandId: `estate-pressure:${world.builds.revision}`,
    expectedRevision: world.builds.revision, discipleId: 'entity:2', loadout });
  for (let index = 0; index < 2; index++) {
    const command = nextCommand(); const result = applyBuildCommandV2({ builds: world.builds, sequences: world.sequences }, command, context);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code);
    expect(result.receipt).toEqual({ commandId: command.commandId, fingerprint: canonicalStringify({ command, authority: false }), authority: false,
      revision: command.expectedRevision + 1, operations: [], resultId: null });
    world.builds = copy(result.frame.builds); world.sequences = copy(result.frame.sequences);
  }
  while (world.builds.history.length < count) {
    const command = nextCommand(); world.builds.revision++;
    world.builds.history.push({ authority: false, command, sequencesBefore: cloneJson(world.sequences) });
    world.builds.receipts.push({ commandId: command.commandId, fingerprint: canonicalStringify({ command, authority: false }), authority: false,
      revision: world.builds.revision, operations: [], resultId: null });
  }
  return world;
}

describe('estate preparation failures, ordering and source isolation', () => {
  it('requires actual legacy cancellation before retirement and preserves cancellation, death and command event order', () => {
    let world = createWorldV8('estate-port-cancellation'); expireAt(world, 'entity:2', 1);
    const started = dispatchCommandV8(world, { kind: 'production.start', commandId: 'estate-port:work', sequence: 0, issuedTick: 0,
      payload: { recipeId: 'craft.plank', workerId: 'entity:2' } });
    expect(started.result.status).toBe('accepted'); world = started.world;
    const jobId = started.result.transactionId!; const sourceBefore = canonicalStringify(world); freeze(world);
    const clock = { ...world.clock, simulationTick: 1, calendarTick: 1 };
    const pendingFrame = prepareCultivationClockAdvance({ ...structural(world), clock });
    expect(pendingFrame).not.toBeNull(); if (!pendingFrame) throw new Error('Missing actual expiry');
    const pending = pendingFrame.cultivation.pendingDeaths[0]!;
    const death = applyCultivationCommandV3(pendingFrame, { kind: 'death.finalize', commandId: 'estate-port:unpublished-death',
      expectedRevision: pendingFrame.cultivation.revision, discipleId: 'entity:2', deathId: pending.deathId, cause: 'lifespan', acknowledgeDeath: true });
    expect(death.ok).toBe(true); if (!death.ok) throw new Error(death.code);
    const unsafeSource = { ...structural(world), ...death.frame, disciples: projectCultivationDisciples(world.disciples, death.frame.cultivation) };
    const responsibility = prepareEstateResponsibilities(unsafeSource);
    expect(responsibility.ok).toBe(true); if (!responsibility.ok) throw new Error(responsibility.details.join('; '));
    expect(prepareEstateSettlement({ ...unsafeSource, legacy: responsibility.legacy }, getWorldBuildContentContext(world)!))
      .toEqual({ ok: false, code: 'INVALID_STATE', details: ['Estate owner retains executable work'] });
    expect(canonicalStringify(world)).toBe(sourceBefore);
    const cancelled = advance(world, 1); expect(lookupProduction(cancelled, jobId)).toMatchObject({ state: 'Cancelled', completedTick: 1 });
    expect(cancelled.inventory.wood.reserved).toBe(0); expect(cancelled.builds.retiredDisciples).toEqual([]);
    const command = finalizeCommand(cancelled, 'entity:2'); const raw = finalizedBeforeEstate(cancelled, command); const settled = success(raw).candidate;
    expect(worldEventsSince(settled, worldEventCursor(world)).map(event => event.kind)).toEqual(['cultivation.expiryPending', 'production.cancelled', 'cultivation.died']);
    expect(settled.activeProductionTransactionIds).toEqual([]); expect(settled.builds.retiredDisciples.map(member => member.discipleId)).toEqual(['entity:2']);
    expect(accepted(cancelled, command)).toEqual(settled);
    const replay = dispatchCommandV8(reload(settled), command); expect(replay.result.status).toBe('accepted'); expect(replay.world).toEqual(settled);
  });

  it.each(['assignment', 'travel', 'manual-index', 'automatic-index'] as const)('keeps the concrete %s work guard before any retirement', guard => {
    const world = registered(rawFinalized()); const source = structural(world); const actor = source.disciples[0]!;
    if (guard === 'assignment') actor.assignmentTransactionId = 'instance:blocked';
    if (guard === 'travel') actor.traveling = true;
    const guarded = {
      ...source,
      activeProductionTransactionIds: guard === 'manual-index' ? ['instance:blocked'] : guard === 'automatic-index' ? ['auto-job/1'] : source.activeProductionTransactionIds,
      transactions: guard === 'manual-index' ? { 'instance:blocked': { workerId: actor.id } } : source.transactions,
      automaticProduction: guard === 'automatic-index' ? { live: { 'auto-job/1': { transaction: { transactionId: 'auto-job/1', workerId: actor.id } } } } : source.automaticProduction,
    };
    const before = canonicalStringify(guarded); freeze(guarded);
    expect(prepareEstateSettlement(guarded, getWorldBuildContentContext(world)!)).toEqual({ ok: false, code: 'INVALID_STATE', details: ['Estate owner retains executable work'] });
    expect(canonicalStringify(guarded)).toBe(before); expect(source.builds.retiredDisciples).toEqual([]);
  });

  it('preserves registration failure before initial aggregate validation', () => {
    const world = rawFinalized(); world.cultivation.disciples = world.cultivation.disciples.filter(member => member.discipleId !== 'entity:1');
    world.inventory.wood.reserved = 1;
    expect(compare(world)).toEqual({ ok: false, code: 'INVALID_STATE', details: ['Death responsibility lacks its full profile'] });
  });

  it('preserves initial estate ownership failure before aggregate totals and domain execution', () => {
    const world = registered(rawFinalized()); world.inventory.wood.reserved = 1;
    world.legacy.estates[0]!.itemInstanceIds.push('instance:missing');
    expect(compare(world)).toEqual({ ok: false, code: 'INVALID_STATE', details: ['Pending estate changed locked ownership'] });
  });

  it.each(['nextAction', 'nextEvent', 'nextEntity', 'nextInstance'] as const)('rejects invalid %s before estate work and leaves the source untouched', counter => {
    const world = rawFinalized(); world.sequences[counter] = 0;
    expect(compare(world)).toEqual({ ok: false, code: 'INVALID_STATE', details: ['Invalid sequences'] });
  });

  it('keeps cultivation revision overflow atomic after otherwise successful build retirement and transfers', () => {
    const world = registered(rawFinalized()); world.cultivation.revision = Number.MAX_SAFE_INTEGER;
    expect(validateWorldStateV8(world)).toEqual([]);
    expect(compare(world)).toEqual({ ok: false, code: 'CULTIVATION_REJECTED', details: ['OVERFLOW'] });
    expect(world.builds.retiredDisciples).toEqual([]); expect(world.cultivation.archivedDisciples).toEqual([]);
  });

  it('does not publish partial item transfer when the complete estate exceeds the wire cap', () => {
    const raw = rawFinalized(); const unpadded = { ...raw, estateAudit: '' };
    const source = { ...unpadded, estateAudit: 'x'.repeat(SAVE_FILE_LIMIT_BYTES - measureWorldSaveBytes(unpadded, { saveVersion: 8 })) };
    expect(measureWorldSaveBytes(source, { saveVersion: 8 })).toBe(SAVE_FILE_LIMIT_BYTES);
    expect(compare(source)).toMatchObject({ ok: false, code: 'SAVE_CAPACITY_EXCEEDED', details: ['Complete estate candidate does not fit its actual or build-row boundary'] });
    expect(source.legacy.estates).toEqual([]); expect(source.cultivation.archivedDisciples).toEqual([]);
  });

  it('reports real registered-content row headroom exhaustion in a declared imported-history pressure fixture', () => {
    const world = withBuildRows(registered(rawFinalized()), 1022);
    const before = canonicalStringify(world); freeze(world);
    expect(assessWorldBuildHistoryObligations(world)).toMatchObject({ historyCount: 1022, maximumCommands: 1024, remainingCommands: 2, fits: false });
    expect(canonicalStringify(world)).toBe(before);
    expect(world.builds.retiredDisciples).toEqual([]); expect(world.legacy.estates[0]!.settledMonth).toBeNull();
  });

  it('keeps partial retirement and transfer failure atomic in a genuine reduced-cap domain-only harness', () => {
    const world = registered(rawFinalized());
    // Explicit standalone domain context. It is not registered World content and
    // is never passed to a World validator, publisher, save codec or command API.
    const registeredContext = getWorldBuildContentContext(world)!;
    const context: BuildContentContext = freeze({ ...registeredContext, rules: { ...registeredContext.rules, maximumCommands: 2 } });
    const builds = createBuildFrameV2(world.builds.origin, context);
    const source = freeze({ ...structural(world), builds: copy(builds.builds) }); const before = canonicalStringify(source);
    const estate = source.legacy.estates[0]!;
    expect(source.builds.equipment).toEqual(world.builds.equipment); expect(estate.itemInstanceIds.length).toBeGreaterThan(1);
    const namespace = `death/${estate.deathId}`;
    const retired = applyBuildAuthorityCommandV2({ builds: source.builds, sequences: source.sequences },
      { commandId: `${namespace}/retire`, expectedRevision: 0, kind: 'disciple.retire', discipleId: estate.discipleId, deathId: estate.deathId }, context);
    expect(retired.ok).toBe(true); if (!retired.ok) throw new Error(retired.code);
    const transfer = (itemInstanceId: string, expectedRevision: number) => ({ commandId: `${namespace}/item/${itemInstanceId}`, expectedRevision,
      kind: 'equipment.transfer' as const, transferId: `${namespace}/item/${itemInstanceId}`, itemInstanceId,
      fromOwner: { kind: 'disciple' as const, discipleId: estate.discipleId }, toOwner: { kind: 'disciple' as const, discipleId: 'entity:2' },
      reason: { kind: 'death' as const, deathId: estate.deathId } });
    const moved = applyBuildAuthorityCommandV2(retired.frame, transfer(estate.itemInstanceIds[0]!, 1), context);
    expect(moved.ok).toBe(true); if (!moved.ok) throw new Error(moved.code);
    expect(applyBuildAuthorityCommandV2(moved.frame, transfer(estate.itemInstanceIds[1]!, 2), context)).toMatchObject({ ok: false, code: 'COMMAND_LIMIT' });
    expect(prepareEstateSettlement(source, context)).toEqual({ ok: false, code: 'SAVE_CAPACITY_EXCEEDED', details: ['SAVE_CAPACITY_EXCEEDED'] });
    expect(canonicalStringify(source)).toBe(before); expect(source.builds.retiredDisciples).toEqual([]);
    expect(source.legacy.estates[0]!.settledMonth).toBeNull(); expect(source.cultivation.archivedDisciples).toEqual([]);
  });

  it('rejects a new lifespan finalization with exhausted action IDs without publishing its retirement', () => {
    const world = advance(starting(), 1); world.sequences.nextAction = Number.MAX_SAFE_INTEGER;
    expect(validateWorldStateV8(world)).toEqual([]); const input = finalizeCommand(world); const before = canonicalStringify(world); freeze(world);
    const result = dispatchCommandV8(world, input);
    expect(result.result.status).toBe('rejected'); expect(result.world).toBe(world); expect(canonicalStringify(world)).toBe(before);
    expect(world.cultivation.deaths).toEqual([]); expect(world.builds.retiredDisciples).toEqual([]);
  });
});
