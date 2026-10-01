import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorldV8, dispatchCommandV8, advanceTicksWithStatusV8, previewWorldEmergencyRetreatV8,
  createSaveEnvelopeV8, serializeSaveV8, parseSaveV8, validateWorldStateV8, previewWorldBreakthroughV8,
  type WorldStateV8, type CommandV8, type PlayerExpeditionCommandV8 } from '../../src/core/kernel/v8';
import { parseSave } from '../../src/core/kernel/save';
import { migrateWorldV7ToV8 } from '../../src/core/kernel/migrate-v7';
import { canonicalStringify, cloneJson, stableHash } from '../../src/core/kernel/serialization';
import type { ExpeditionCommand, ExpeditionReceipt } from '../../src/core/expeditions/types';
import { applyRegisteredExpeditionCommand } from '../../src/core/expeditions/versioned';
import { applyBuildCommandV2, applyBuildAuthorityCommandV2 } from '../../src/core/builds/v2';
import { copy } from '../../src/core/builds/shared';
import { getWorldBuildContentContext } from '../../src/core/world/content-access';
import { isCultivationWorkerAvailable } from '../../src/core/world/cultivation-bridge';
import { dispatchWorldCultivationV8 } from '../../src/core/world/cultivation-bridge-v8';
import { serializeCampaignV2, restoreCampaignV2 } from '../../src/core/campaign/v2';
import { measureProgressionRecord } from '../../src/core/save-budget/progression-bounds';
import { registeredWorldRun, dispatchWorldExpeditionV8 } from '../../src/core/expeditions/v8-world-adapter';
import { assessRegisteredExpeditionExitBudget as assess, isRegisteredExitCommandId,
  REGISTERED_EXPEDITION_EXIT_QUOTAS as QUOTA } from '../../src/core/world/expedition-exit-budget';
import { canonicalUtf8ByteLength, measureWorldSaveBytes, NON_AUTOMATIC_HEADROOM_BYTES, SAVE_FILE_LIMIT_BYTES } from '../../src/core/save-budget';
import { RESOURCE_IDS } from '../../src/core/economy/types';
import type { PlayerCultivationCommand } from '../../src/core/kernel/contracts';
import { returnClearanceReservation } from '../../src/core/world/expedition-return-capacity';

type Body<T> = T extends T ? Omit<T, 'commandId'> : never;
const MAX = Number.MAX_SAFE_INTEGER;
function act(world: WorldStateV8, body: Body<PlayerExpeditionCommandV8>, commandId = `exit:${world.clock.simulationTick}:${world.expedition.run?.revision ?? 0}`): WorldStateV8 {
  const result = dispatchCommandV8(world, { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'expedition.command', payload: { command: { ...body, commandId } as PlayerExpeditionCommandV8 } });
  expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function step(world: WorldStateV8, ticks: number): WorldStateV8 {
  const result = advanceTicksWithStatusV8(world, ticks);
  expect(result.invariantStop, JSON.stringify(result.invariantStop)).toBeNull(); expect(result.capacityStop).toBeNull(); return result.world;
}
function depart(world = createWorldV8('registered-exit')): WorldStateV8 {
  return act(world, { kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial', squadIds: world.disciples.slice(0, 2).map(actor => actor.id) } });
}
function restore(world: WorldStateV8): WorldStateV8 {
  const source = serializeSaveV8(createSaveEnvelopeV8(world, { buildId: 'registered-exit-test', savedAt: '2026-10-01T19:00:00Z' }));
  const restored = parseSaveV8(source); expect(restored.ok, restored.ok ? '' : restored.error.message).toBe(true);
  if (!restored.ok) throw new Error(restored.error.message);
  expect(canonicalStringify(restored.world)).toBe(canonicalStringify(world)); return restored.world;
}
function expectFunded(world: WorldStateV8) {
  const budget = assess(world); expect(budget.unknowns).toEqual([]); expect(budget.violations).toEqual([]);
  expect(budget.supported).toBe(true); expect(budget.fits).toBe(true); return budget;
}
function appendReplayableNoEffectRow(world: WorldStateV8, commandId: string): WorldStateV8 {
  const registered = registeredWorldRun(world); const checkpoint = registered.run.admittedCheckpoint!;
  const transition = applyRegisteredExpeditionCommand(registered, { commandId, kind: 'time.admit', expectedRevision: registered.run.revision,
    checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth });
  if (!transition.ok) throw new Error(transition.code);
  expect(transition.effects).toEqual([]);
  return { ...world, expedition: { ...world.expedition, run: transition.expedition.run } };
}
/** Bulk imported-history stress. Every appended row is the known no-effect
 * prepaid time.admit shape; each resulting large World is fully replay-validated
 * below. Constructing a prefix does not need to clone/replay all earlier rows. */
function importedNoEffectRows(world: WorldStateV8, total: number, commandId: (revision: number) => string): WorldStateV8 {
  const run = world.expedition.run!; const checkpoint = run.admittedCheckpoint!;
  const commandLog = [...run.commandLog]; const receipts = [...run.receipts]; let revision = run.revision;
  while (commandLog.length < total) {
    const command: ExpeditionCommand = { kind: 'time.admit', commandId: commandId(revision), expectedRevision: revision,
      checkpointId: checkpoint.checkpointId, expectedCalendarMonth: checkpoint.expectedCalendarMonth };
    revision += 1;
    const receipt: ExpeditionReceipt = { commandId: command.commandId, commandHash: stableHash(command), kind: command.kind,
      revision, effectIds: [], resultId: checkpoint.checkpointId };
    commandLog.push(command); receipts.push(receipt);
  }
  return { ...world, expedition: { ...world.expedition, run: { ...run, revision, commandLog, receipts } } };
}
function core(world: WorldStateV8, command: CommandV8): WorldStateV8 {
  const result = dispatchCommandV8(world, command); expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); return result.world;
}
function deliver(world: WorldStateV8, recipeId: string, serial: string): WorldStateV8 {
  const worker = world.disciples.find(actor => actor.canWork && actor.lifeState === 'alive' && !actor.traveling
    && !actor.assignmentTransactionId && isCultivationWorkerAvailable(world, actor.id));
  expect(worker).toBeDefined(); const workerId = worker!.id;
  world = core(world, { commandId: `exit:produce:${serial}`, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'production.start', payload: { workerId, recipeId } });
  for (let guard = 0; guard < 5 && world.disciples.find(actor => actor.id === workerId)!.assignmentTransactionId; guard++) world = step(world, 600);
  expect(world.disciples.find(actor => actor.id === workerId)!.assignmentTransactionId).toBeNull(); return world;
}
function cultivate(world: WorldStateV8, command: PlayerCultivationCommand): WorldStateV8 {
  return core(world, { commandId: command.commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
    kind: 'cultivation.command', payload: { command } });
}
/** A reader-valid import stress, not an elapsed-time gameplay transition. */
function shiftedWorldMonth(world: WorldStateV8): WorldStateV8 {
  const changed = cloneJson(world); changed.clock.calendarTick += 1200; changed.clock.simulationTick += 1200; changed.cultivation.calendarMonth += 1;
  for (const actor of changed.disciples) if (actor.lifeState === 'alive') {
    actor.ageMonths = Math.floor((changed.clock.calendarTick - actor.birthCalendarTick) / 1200);
    changed.cultivation.disciples.find(profile => profile.discipleId === actor.id)!.ageMonths = actor.ageMonths;
  }
  return changed;
}
let travelling: WorldStateV8; let atNode: WorldStateV8; let inEncounter: WorldStateV8; let ending: WorldStateV8;
beforeAll(() => {
  travelling = depart(); atNode = step(travelling, 1200);
  inEncounter = step(act(atNode, { kind: 'expedition.continue' }), 17);
  const preview = previewWorldEmergencyRetreatV8(inEncounter)!;
  ending = act(inEncounter, { kind: 'expedition.emergency-retreat', expectedBasisStamp: preview.basisStamp, acknowledgeLoss: true });
}, 30_000);

describe('standalone registered v8 paid-exit budget', () => {
  it('composes both run copies and the entire encounter quota without replacing the unrelated named margin', () => {
    const before = canonicalStringify(travelling); const budget = expectFunded(travelling);
    expect(QUOTA.runBytes).toBe(192 * 1024); expect(QUOTA.worldEncounterBytes).toBe(256 * 1024);
    expect(budget.peak.fixedWorldBytes).toBe(measureWorldSaveBytes(travelling, { saveVersion: 8 })
      - canonicalUtf8ByteLength(travelling.expedition.run) - canonicalUtf8ByteLength(travelling.expedition.battle));
    expect(budget.peak.twoRunCopiesBytes).toBe(2 * QUOTA.runBytes);
    expect(budget.peak.worldEncounterBytes).toBe(QUOTA.worldEncounterBytes);
    expect(budget.peak.retainedGeneralHeadroomBytes).toBe(NON_AUTOMATIC_HEADROOM_BYTES);
    const p = budget.peak;
    expect(p.totalBytes).toBe(p.fixedWorldBytes + p.twoRunCopiesBytes + p.worldEncounterBytes + p.registeredProofWrapperBytes
      + p.progressionBytes + p.productionBytes + p.clearanceBytes + p.additionalWorldBytes + p.retainedGeneralHeadroomBytes);
    expect(budget.run.finishDeltaBytes).toBe(budget.run.records.filter(record => record.placement === 'run').reduce((sum, record) => sum + record.bytes, 0));
    expect(budget.run.maximumFinishedBytes).toBe(budget.run.currentBytes + budget.run.finishDeltaBytes);
    expect(budget.plan).toMatchObject({ entry: 'finish-checkpoint-then-retreat', calendarTicks: 2400, monthBoundaries: 2,
      requiredRunCommands: 7, requiredUnpaidMeal: 2, maximumDiscardOperations: 6 });
    expect(Object.isFrozen(budget)).toBe(true); expect(Object.isFrozen(budget.run.records)).toBe(true);
    expect(canonicalStringify(travelling)).toBe(before);
  });
  it('prices the actual remaining travel and return in every ordinary exit phase', () => {
    const halfTravel = step(travelling, 600);
    expect(expectFunded(halfTravel).plan).toMatchObject({ calendarTicks: 1800, monthBoundaries: 2 });
    expect(expectFunded(atNode).plan).toMatchObject({ entry: 'safe-retreat', calendarTicks: 1200, monthBoundaries: 1 });
    expect(expectFunded(inEncounter).plan).toMatchObject({ entry: 'emergency-retreat', calendarTicks: 1200 });
    expect(expectFunded(ending).plan).toMatchObject({ entry: 'finish-return', calendarTicks: 1200 });
    const halfReturn = step(act(ending, { kind: 'expedition.continue' }), 600);
    expect(expectFunded(halfReturn).plan).toMatchObject({ entry: 'finish-return', calendarTicks: 600 });
    const ended = step(halfReturn, 600); const budget = expectFunded(ended);
    expect(budget.plan).toMatchObject({ entry: 'already-ended', calendarTicks: 0, requiredRunCommands: 0 });
    expect(budget.run.finishDeltaBytes).toBe(0);
    expect(budget.peak.twoRunCopiesBytes).toBe(canonicalUtf8ByteLength(ended.expedition.run));
  }, 30_000);
  it('restores interrupted real emergency retreat and return, with full derived effect IDs and no invented victory', () => {
    let world = restore(inEncounter); const before = expectFunded(world);
    const commandId = 'r'.repeat(before.plan!.commandIdMaximumLength);
    expect(`${world.expedition.run!.runId}/command/${commandId}`).toHaveLength(120);
    expect(isRegisteredExitCommandId(world.expedition.run!.runId, commandId)).toBe(true);
    expect(isRegisteredExitCommandId(world.expedition.run!.runId, `${commandId}x`)).toBe(false);
    expect(isRegisteredExitCommandId(world.expedition.run!.runId, 'bad/id')).toBe(false);
    expect(isRegisteredExitCommandId(world.expedition.run!.runId, 'constructor')).toBe(false);
    const preview = previewWorldEmergencyRetreatV8(world)!;
    world = restore(act(world, { kind: 'expedition.emergency-retreat', expectedBasisStamp: preview.basisStamp, acknowledgeLoss: true }, commandId));
    expect(world.expedition.effectReceipts.some(receipt => receipt.effectId === `${world.expedition.run!.runId}/command/${commandId}`)).toBe(true);
    world = restore(step(act(world, { kind: 'expedition.continue' }), 600)); expectFunded(world);
    world = restore(step(world, 600)); expectFunded(world);
    expect(world.expedition.run?.phase).toBe('Ended'); expect(world.expedition.run?.settlement?.reason).toBe('emergencyRetreat');
    expect(world.campaign.progress.clears).toEqual([]); expect(world.expedition.history).toHaveLength(1);
    expect(canonicalUtf8ByteLength(world.expedition.run)).toBeLessThanOrEqual(before.run.maximumFinishedBytes);
    expect(measureWorldSaveBytes(world, { saveVersion: 8 })).toBeLessThanOrEqual(before.peak.totalBytes);
  }, 30_000);
  it('keeps a reached-but-uncommitted checkpoint paid and restores the real death/retreat/shared-proof path', () => {
    const initial = createWorldV8('exit-checkpoint-expiry'); const actor = initial.disciples[0]!;
    const profile = initial.cultivation.disciples.find(profile => profile.discipleId === actor.id)!;
    // Explicit chronological boundary fixture, never a fabricated result or battle.
    actor.ageMonths = profile.lifespanMonths - 1; actor.birthCalendarTick = -actor.ageMonths * 1200; profile.ageMonths = actor.ageMonths;
    expect(validateWorldStateV8(initial)).toEqual([]);
    let world = restore(step(depart(initial), 1200));
    expect(world.expedition.run?.phase).toBe('Travelling'); expect(world.expedition.travel?.targetCalendarTick).toBe(world.clock.calendarTick);
    const budget = expectFunded(world);
    expect(budget.plan).toMatchObject({ calendarTicks: 1200, requiredRunCommands: 7 });
    expect(budget.costs.runTravelLedger).toBe(world.expedition.run!.travelLedger.length + 2);
    const death = world.cultivation.pendingDeaths.find(death => death.discipleId === actor.id)!;
    // Reader-valid imported alias is outside the adapter's allocated-ID proof.
    const imported = cloneJson(world); const alias = 'foreign-death';
    imported.cultivation.pendingDeaths.find(entry => entry.deathId === death.deathId)!.deathId = alias;
    imported.cultivation.disciples.find(entry => entry.discipleId === actor.id)!.pendingDeathId = alias;
    for (const event of imported.cultivation.events) if (event.relatedId === death.deathId) event.relatedId = alias;
    imported.events = imported.events.map(event => event.payload.relatedId === death.deathId
      ? { ...event, payload: { ...event.payload, relatedId: alias } } : event);
    expect(validateWorldStateV8(imported)).toEqual([]);
    expect(assess(imported)).toMatchObject({ supported: false, fits: false }); expect(assess(imported).unknowns.join()).toContain('away-death allocation namespace');
    const result = dispatchCommandV8(world, { commandId: 'exit:confirm-death', sequence: world.sequences.nextAction,
      issuedTick: world.clock.simulationTick, kind: 'cultivation.command', payload: { command: { commandId: 'exit:confirm-death',
        kind: 'death.finalize', expectedRevision: world.cultivation.revision, discipleId: actor.id, deathId: death.deathId, cause: 'lifespan', acknowledgeDeath: true } } });
    expect(result.result.status, JSON.stringify(result.result)).toBe('accepted'); world = restore(step(result.world, 1));
    expect(world.expedition.run?.phase).toBe('AtNode'); world = restore(act(world, { kind: 'expedition.retreat' }));
    world = restore(step(act(world, { kind: 'expedition.continue' }), 1200));
    expect(world.expedition.run?.phase).toBe('Ended'); expect(world.campaign.settledRunEvidence).toHaveLength(1);
    expect(world.campaign.settledRunEvidence[0]!.run).toEqual(world.expedition.run);
    expect(world.campaign.progress.clears).toEqual([]); expect(validateWorldStateV8(world)).toEqual([]);
    expect(canonicalUtf8ByteLength(world.expedition.run)).toBeLessThanOrEqual(budget.run.maximumFinishedBytes);
    const originalEnded = canonicalStringify(world);
    const nextRun = depart(deliver(world, 'cook.meal', 'transfer-namespace'));
    expectFunded(nextRun); // Completed old adapter namespaces remain legitimate.
    const authorityAlias = cloneJson(nextRun); const authority = authorityAlias.cultivation.authorityReceipts.find(receipt => receipt.command.kind === 'disciple.archive')!;
    const archiveAliasId = `death/instance:${authorityAlias.sequences.nextInstance}/archive`;
    authority.command.commandId = archiveAliasId; authority.fingerprint = canonicalStringify(authority.command);
    expect(validateWorldStateV8(authorityAlias)).toEqual([]); const authorityBefore = canonicalStringify(authorityAlias);
    expect(assess(authorityAlias).unknowns.join()).toContain(`identity already occupied: cultivation:${archiveAliasId}`);
    expect(canonicalStringify(authorityAlias)).toBe(authorityBefore);
    const aliased = cloneJson(nextRun);
    const owned = aliased.builds.equipment.find(item => item.owner.kind === 'disciple' && item.owner.discipleId === aliased.expedition.run!.members[0]!.discipleId)!;
    const transfer = aliased.builds.history.find(entry => entry.command.kind === 'equipment.transfer' && entry.command.reason.kind === 'death')!;
    if (transfer.command.kind !== 'equipment.transfer') throw new Error('Missing actual old estate transfer');
    const occupiedTransferId = `death/instance:${aliased.sequences.nextInstance}/item/${owned.instanceId}`;
    // Reader-valid imported alias changes the independent transfer key, not its old command ID, owner or estate facts.
    transfer.command.transferId = occupiedTransferId;
    aliased.builds.receipts.find(receipt => receipt.commandId === transfer.command.commandId)!.fingerprint = canonicalStringify({ command: transfer.command, authority: transfer.authority });
    expect(validateWorldStateV8(aliased)).toEqual([]);
    const preserved = canonicalStringify(aliased); expect(assess(aliased).unknowns.join()).toContain(`identity already occupied: build-transfer:${occupiedTransferId}`);
    expect(canonicalStringify(aliased)).toBe(preserved); expect(canonicalStringify(world)).toBe(originalEnded);
  }, 60_000);
  it('leaves an exact inclusive wire boundary funded, diagnoses one excess byte and independent ID deficits', () => {
    const world = cloneJson(travelling); const original = expectFunded(world);
    for (const name of ['nextAction', 'nextEvent', 'nextInstance'] as const) {
      const reserve = original.costs[`sequence.${name}`]! - world.sequences[name]; world.sequences[name] = MAX - reserve;
    }
    expect(validateWorldStateV8(world)).toEqual([]); const exactIds = expectFunded(world);
    for (const name of ['nextAction', 'nextEvent', 'nextInstance']) expect(exactIds.costs[`sequence.${name}`]).toBe(MAX);
    world.diagnostics = [{ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' }];
    const padding = SAVE_FILE_LIMIT_BYTES - assess(world).peak.totalBytes; expect(padding).toBeGreaterThan(0);
    world.diagnostics[0]!.message = 'x'.repeat(padding); const exact = expectFunded(world);
    expect(exact.costs.wireBytes).toBe(SAVE_FILE_LIMIT_BYTES); expect(exact.actualFits).toBe(true);
    const over = cloneJson(world); over.diagnostics[0]!.message += 'x'; over.sequences.nextAction += 1; over.sequences.nextEvent += 1;
    const refused = assess(over); expect(refused.supported).toBe(true); expect(refused.actualFits).toBe(true); expect(refused.fits).toBe(false);
    expect(refused.violations).toEqual(expect.arrayContaining(['wireBytes', 'sequence.nextAction', 'sequence.nextEvent']));
  }, 30_000);
  it('can spend a paid full-resource discard and restore terminal settlement near the composed cap', () => {
    let world = act(ending, { kind: 'expedition.continue' });
    // Capacity fixture only: all preceding battle/retreat/return transitions are real.
    world = { ...world, inventory: { ...world.inventory, meal: { ...world.inventory.meal, owned: world.inventory.meal.capacity } } };
    world = step(world, 1200); expect(world.expedition.blockedReason).toBe('INVENTORY_FULL');
    expect(returnClearanceReservation(world).discardResourceIds).toEqual(['meal']);
    world = { ...world, diagnostics: [{ code: 'INVARIANT_FAILURE', tick: world.clock.simulationTick, message: '' }] };
    world.diagnostics[0]!.message = 'x'.repeat(SAVE_FILE_LIMIT_BYTES - assess(world).peak.totalBytes);
    const before = expectFunded(world); expect(before.costs.wireBytes).toBe(SAVE_FILE_LIMIT_BYTES);
    const cleared = dispatchCommandV8(world, { commandId: 'exit:full-discard', sequence: world.sequences.nextAction,
      issuedTick: world.clock.simulationTick, kind: 'inventory.discard', payload: { resourceId: 'meal', quantity: world.inventory.meal.owned } });
    expect(cleared.result.status, JSON.stringify(cleared.result)).toBe('accepted');
    world = restore(step(cleared.world, 1)); expect(world.expedition.run?.phase).toBe('Ended');
    expect(measureWorldSaveBytes(world, { saveVersion: 8 })).toBeLessThanOrEqual(before.peak.totalBytes);
  }, 30_000);
  it('checks the encounter product quota at equality and one byte beyond, without changing combat results', () => {
    const world = cloneJson(inEncounter); const battle = world.expedition.battle!;
    // Reader-valid diagnostic stress. It changes no combat entity/outcome/RNG.
    const diagnostic = { tick: 0, actorId: battle.participants[0]!.battleEntityId, reason: '' };
    battle.controller = { ...battle.controller, diagnostics: [diagnostic] };
    diagnostic.reason = 'x'.repeat(QUOTA.worldEncounterBytes - canonicalUtf8ByteLength(battle));
    expect(validateWorldStateV8(world)).toEqual([]); expect(expectFunded(world).costs.worldEncounterQuota).toBe(QUOTA.worldEncounterBytes);
    const over = cloneJson(world); const controller = over.expedition.battle!.controller;
    over.expedition.battle!.controller = { ...controller, diagnostics: controller.diagnostics.map(entry => ({ ...entry, reason: `${entry.reason}x` })) };
    const refused = assess(over); expect(refused.supported).toBe(true); expect(refused.violations).toContain('worldEncounterQuota');
    expect(refused.actualFits).toBe(true); expect(refused.fits).toBe(false);
  });
  it('reserves indispensable run rows at equality and fails closed on crowded imported run bytes', () => {
    const reserve = expectFunded(travelling).plan!.requiredRunCommands;
    const smoke = importedNoEffectRows(travelling, travelling.expedition.run!.commandLog.length + 1, () => 'bulk:smoke');
    expect(smoke.expedition.run).toEqual(appendReplayableNoEffectRow(travelling, 'bulk:smoke').expedition.run);
    const rows = importedNoEffectRows(travelling, QUOTA.runCommands - reserve, revision => `row:${revision}`);
    expect(validateWorldStateV8(rows)).toEqual([]); const exact = assess(rows);
    expect(exact.supported).toBe(true); expect(exact.costs.runCommands).toBe(QUOTA.runCommands); expect(exact.violations).not.toContain('runCommands');
    const overRows = assess(appendReplayableNoEffectRow(rows, 'row:excess'));
    expect(overRows.violations).toEqual(expect.arrayContaining(['runCommands', 'runReceipts']));
    const large = importedNoEffectRows(travelling, 500, revision => `large:${revision}:`.padEnd(120, 'x'));
    expect(canonicalUtf8ByteLength(large.expedition.run)).toBeGreaterThan(QUOTA.runBytes);
    expect(validateWorldStateV8(large)).toEqual([]);
    const oversized = assess(large); expect(oversized.supported).toBe(true); expect(oversized.fits).toBe(false); expect(oversized.violations).toContain('runQuota');
  }, 30_000);
  it('retreats from a genuine RewardPending offer and preserves its real forfeiture through restoration', () => {
    let world = createWorldV8('five-route-playable');
    for (let index = 0; index < 3; index++) world = deliver(world, 'cook.meal', `reward:${index}`);
    world = act(world, { kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial', squadIds: world.disciples.map(actor => actor.id) } });
    world = step(world, 1200); world = restore(step(act(world, { kind: 'expedition.continue' }), 5000));
    expect(world.expedition.run?.phase).toBe('RewardPending');
    expect(world.expedition.run?.encounterResults[0]?.outcome).toBe('victory');
    const budget = expectFunded(world); expect(budget.plan).toMatchObject({ entry: 'safe-retreat', calendarTicks: 1200 });
    const offerId = world.expedition.run!.currentOfferId;
    const offer = world.expedition.run!.offers.find(offer => offer.offerId === offerId)!;
    const nextTravel = act(world, { kind: 'expedition.supplies', offerId: offer.offerId, offerRevision: offer.revision }, 'exit:cursor-import-branch');
    expect(nextTravel.expedition.run?.phase).toBe('Travelling'); expect(nextTravel.expedition.travel).toBeNull();
    const skewedTravel = shiftedWorldMonth(nextTravel); expect(validateWorldStateV8(skewedTravel)).toEqual([]);
    expect(assess(skewedTravel).unknowns.join()).toContain('Unaligned');
    // Enter a real second encounter, then stress only a cloned import's independent result key.
    const secondNode = step(act(nextTravel, { kind: 'expedition.continue' }), 1200);
    expect(secondNode.expedition.run?.phase).toBe('AtNode');
    const secondEncounter = act(secondNode, { kind: 'expedition.continue' });
    expect(secondEncounter.expedition.run?.phase).toBe('InEncounter'); expect(secondEncounter.expedition.battle).not.toBeNull(); expectFunded(secondEncounter);
    const collision = cloneJson(secondEncounter); const run = collision.expedition.run!;
    if (run.schemaVersion !== 3) throw new Error('Expected current registered run');
    const occupiedResultId = `${run.runId}/result/${run.nodeIndex + 1}`;
    const firstEncounterId = run.encounterResults[0]!.encounterId;
    const commandLog = run.commandLog.map(command => command.kind === 'encounter.resolve' && command.result.encounterId === firstEncounterId
      ? { ...command, result: { ...command.result, resultId: occupiedResultId } } : command);
    collision.expedition.run = { ...run, commandLog,
      receipts: run.receipts.map((receipt, index) => commandLog[index] !== run.commandLog[index]
        ? { ...receipt, resultId: occupiedResultId, commandHash: stableHash(commandLog[index]) } : receipt),
      encounterResults: run.encounterResults.map(result => result.encounterId === firstEncounterId ? { ...result, resultId: occupiedResultId } : result) };
    expect(validateWorldStateV8(collision)).toEqual([]); const collisionBefore = canonicalStringify(collision);
    expect(assess(collision).unknowns.join()).toContain(`identity already occupied: run-result:${occupiedResultId}`);
    const blockedPreview = previewWorldEmergencyRetreatV8(collision)!;
    expect(dispatchWorldExpeditionV8(collision, { commandId: 'exit:result-collision', kind: 'expedition.emergency-retreat',
      expectedBasisStamp: blockedPreview.basisStamp, acknowledgeLoss: true })).toMatchObject({ ok: false });
    expect(canonicalStringify(collision)).toBe(collisionBefore);
    world = restore(act(world, { kind: 'expedition.retreat' }));
    expect(world.expedition.run!.offers.find(offer => offer.offerId === offerId)?.resolution).toBe('forfeited');
    world = restore(step(act(world, { kind: 'expedition.continue' }), 1200));
    expect(world.expedition.run?.phase).toBe('Ended'); expect(world.expedition.run?.settlement?.reason).toBe('safeRetreat');
    expect(world.campaign.progress.clears).toEqual([]); expect(world.expedition.run?.rewardCounters.committed).toBe(0);
    expect(canonicalUtf8ByteLength(world.expedition.run)).toBeLessThanOrEqual(budget.run.maximumFinishedBytes);
  }, 60_000);
  it('actually cancels existing production, fully discards all six resources, then restores the paid return', () => {
    let world = deliver(createWorldV8('exit-six-resources'), 'craft.plank', 'plank');
    const supplies = RESOURCE_IDS.map(resourceId => ({ resourceId, quantity: resourceId === 'meal' ? 8 : 1 }));
    world = act(world, { kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial',
      squadIds: world.disciples.slice(0, 2).map(actor => actor.id), supplies } });
    world = act(step(world, 1200), { kind: 'expedition.retreat' });
    world = core(world, { commandId: 'exit:start-home-job', sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
      kind: 'production.start', payload: { workerId: world.disciples[2]!.id, recipeId: 'cook.meal' } });
    const planned = expectFunded(world); expect(planned.plan!.cancelProductionIds).toHaveLength(1);
    for (const transactionId of planned.plan!.cancelProductionIds) world = core(world, { commandId: 'exit:cancel-home-job',
      sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick, kind: 'production.cancel', payload: { transactionId } });
    expect(world.activeProductionTransactionIds).toEqual([]); expect(world.inventory.grain.reserved).toBe(0);
    world = act(world, { kind: 'expedition.continue' });
    // Explicit full-stock capacity stress, with all six cargo lines genuinely carried.
    world = cloneJson(world); for (const resourceId of RESOURCE_IDS) world.inventory[resourceId].owned = world.inventory[resourceId].capacity;
    world = restore(step(world, 1200)); expect(world.expedition.blockedReason).toBe('INVENTORY_FULL');
    expect(returnClearanceReservation(world).discardResourceIds).toEqual([...RESOURCE_IDS]);
    const incoming = cloneJson(world.expedition.run!.settlement!.unusedSupplies); let discards = 0;
    for (const resourceId of RESOURCE_IDS) {
      const before = expectFunded(world);
      world = core(world, { commandId: `exit:discard:${resourceId}`, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
        kind: 'inventory.discard', payload: { resourceId, quantity: world.inventory[resourceId].owned } });
      discards++; const after = expectFunded(world);
      expect(after.plan!.maximumDiscardOperations).toBe(6 - discards);
      for (const key of ['wireBytes', 'archiveReceiptRows', 'archiveEventRows', 'archiveCharacters', 'archiveNodes', 'sequence.nextAction', 'sequence.nextEvent'])
        expect(after.costs[key], key).toBeLessThanOrEqual(before.costs[key]!);
    }
    world = restore(step(world, 1)); expect(discards).toBe(6); expect(world.expedition.run?.phase).toBe('Ended');
    for (const resourceId of RESOURCE_IDS) expect(world.inventory[resourceId].owned).toBe(incoming.find(line => line.resourceId === resourceId)?.quantity ?? 0);
  }, 60_000);
  it('keeps a naturally reached home breakthrough decision cancellable and completes the real exit without a draw', () => {
    let world = deliver(createWorldV8('exit-home-decision'), 'cook.meal', 'home-meals');
    const discipleId = world.disciples[2]!.id;
    // Readiness fixture only. All confirmations, seclusion, month work and cancellation are real commands.
    world = cloneJson(world); world.cultivation.disciples.find(profile => profile.discipleId === discipleId)!.cultivation = 120;
    const preview = previewWorldBreakthroughV8(world, discipleId, { method: 'standard', arraySupport: 0 });
    world = cultivate(world, { commandId: 'exit:attempt-confirm', kind: 'breakthrough.confirm', expectedRevision: world.cultivation.revision, preview });
    const attemptId = world.cultivation.disciples.find(profile => profile.discipleId === discipleId)!.activeAttemptId!;
    world = cultivate(world, { commandId: 'exit:attempt-begin', kind: 'breakthrough.begin', expectedRevision: world.cultivation.revision, attemptId });
    world = depart(world); expect(expectFunded(world).plan!.cancelAttemptIds).toContain(attemptId);
    world = restore(step(world, 1200));
    expect(world.cultivation.attempts.find(attempt => attempt.attemptId === attemptId)).toMatchObject({ phase: 'DecisionReady', sample: null });
    expect(world.expedition.run?.phase).toBe('Travelling'); expect(expectFunded(world).plan!.cancelAttemptIds).toContain(attemptId);
    const random = canonicalStringify(world.randomStreams);
    world = cultivate(world, { commandId: 'exit:attempt-cancel', kind: 'breakthrough.cancel', expectedRevision: world.cultivation.revision, attemptId });
    expect(canonicalStringify(world.randomStreams)).toBe(random); expect(expectFunded(world).plan!.cancelAttemptIds).toEqual([]);
    world = step(world, world.expedition.travel!.targetCalendarTick - world.clock.calendarTick);
    world = act(world, { kind: 'expedition.retreat' }); world = restore(step(act(world, { kind: 'expedition.continue' }), 1200));
    expect(world.expedition.run?.phase).toBe('Ended'); expect(world.cultivation.attempts.find(attempt => attempt.attemptId === attemptId)?.phase).toBe('Cancelled');
    expect(world.campaign.progress.clears).toEqual([]);
  }, 60_000);
  it('recognizes only canonical allocated namespaces and never shortens a recovery identity', () => {
    for (const runId of ['custom-run', 'run:01', 'run:0', `run:${MAX}`, 'run:9007199254740992']) expect(isRegisteredExitCommandId(runId, 'recover')).toBe(false);
    expect(isRegisteredExitCommandId(`run:${MAX - 1}`, 'recover')).toBe(true);
    const high = cloneJson(travelling); high.sequences.nextAction = Number(high.expedition.run!.runId.slice(4));
    const result = assess(high); expect(result.supported).toBe(false); expect(result.fits).toBe(false);
    expect(validateWorldStateV8(high).length).toBeGreaterThan(0);
    expect(result.unknowns.join()).toContain('Invalid source World:');
  });
  it.each(['settle', 'month', 'world-deaths'] as const)('refuses a reader-valid imported row occupying the future %s identity', kind => {
    const run = travelling.expedition.run!;
    const id = kind === 'settle' ? `${run.runId}/settle` : kind === 'month' ? `${run.runId}/month/${run.travelLedger.length + 1}`
      : `${run.runId}/world-deaths/${run.revision + 1}`;
    const crowded = appendReplayableNoEffectRow(travelling, id); expect(validateWorldStateV8(crowded)).toEqual([]);
    const before = canonicalStringify(crowded); const refused = assess(crowded);
    expect(refused).toMatchObject({ supported: false, fits: false }); expect(refused.unknowns.join()).toContain(`identity already occupied: run:${id}`);
    expect(canonicalStringify(crowded)).toBe(before);
    if (kind === 'settle') {
      const actual = applyRegisteredExpeditionCommand(registeredWorldRun(crowded), { commandId: id, expectedRevision: crowded.expedition.run!.revision,
        kind: 'run.settle', settlementId: `${run.runId}/settlement` });
      expect(actual).toMatchObject({ ok: false, code: 'COMMAND_CONFLICT' });
    }
  });
  it('refuses a valid imported build no-op occupying the still-required squad unlock', () => {
    const world = atNode; const member = world.builds.disciples[2]!; const commandId = `${world.expedition.run!.runId}/build-unlock`;
    const changed = applyBuildCommandV2({ builds: world.builds, sequences: world.sequences }, { kind: 'loadout.set', commandId,
      expectedRevision: world.builds.revision, discipleId: member.discipleId, loadout: copy(member.loadout) }, getWorldBuildContentContext(world)!);
    if (!changed.ok) throw new Error(changed.code);
    const imported: WorldStateV8 = { ...world, builds: copy(changed.frame.builds), sequences: copy(changed.frame.sequences) };
    expect(validateWorldStateV8(imported)).toEqual([]); const before = canonicalStringify(imported);
    expect(assess(imported).unknowns.join()).toContain(`identity already occupied: build:${commandId}`); expect(canonicalStringify(imported)).toBe(before);
  });
  it.each(['archive', 'combat'] as const)('refuses an imported cultivation receipt in a future death %s namespace', kind => {
    const deathId = `instance:${atNode.sequences.nextInstance}`;
    const commandId = kind === 'archive' ? `death/${deathId}/archive` : `${atNode.expedition.run!.runId}/death/${deathId}`;
    const result = dispatchWorldCultivationV8(atNode, { kind: 'training.set', commandId, expectedRevision: atNode.cultivation.revision,
      discipleId: atNode.disciples[2]!.id, mode: 'duty' });
    if (!result.ok) throw new Error(result.code);
    let imported = result.world;
    if (kind === 'combat') {
      const commandId = 'exit:imported-combat-boundary';
      const body = { kind: 'expedition.continue' as const, commandId };
      const refused = dispatchCommandV8(result.world, { commandId, sequence: result.world.sequences.nextAction,
        issuedTick: result.world.clock.simulationTick, kind: 'expedition.command', payload: { command: body } });
      expect(refused.result.rejection?.code).toBe('SAVE_OBLIGATION_UNBOUNDED'); expect(refused.world).toBe(result.world);
      // Import-only fixture: the authentic adapter constructs the full battle;
      // public admission above correctly refuses to publish this known collision.
      const boundary = dispatchWorldExpeditionV8(result.world, body);
      expect(boundary.ok).toBe(true); if (!boundary.ok) throw new Error(boundary.code); imported = boundary.world;
    }
    expect(validateWorldStateV8(imported)).toEqual([]); const before = canonicalStringify(imported);
    expect(assess(imported).unknowns.join()).toContain(`identity already occupied: cultivation:${commandId}`); expect(canonicalStringify(imported)).toBe(before);
  });
  it('refuses a reader-valid month mismatch before admitting an unpaid return checkpoint', () => {
    const imported = shiftedWorldMonth(ending); expect(imported.expedition.travel).toBeNull(); expect(validateWorldStateV8(imported)).toEqual([]);
    const before = canonicalStringify(imported); expect(assess(imported)).toMatchObject({ supported: false, fits: false });
    expect(assess(imported).unknowns.join()).toContain('Unaligned'); expect(canonicalStringify(imported)).toBe(before);
  });
  it('includes the complete campaign reader wrapper, character limit and typed future growth', () => {
    const budget = expectFunded(travelling); const text = serializeCampaignV2(travelling.campaign.progress);
    expect(restoreCampaignV2(text)).toEqual(travelling.campaign.progress);
    const wrapper = measureProgressionRecord(JSON.parse(text)); const state = measureProgressionRecord(travelling.campaign.progress);
    const growth = budget.run.records.filter(record => record.label.includes('first-clear record') || record.label === 'campaign revision width');
    expect(wrapper.decodedNodes - state.decodedNodes).toBe(4);
    expect(budget.costs.campaignReaderNodes).toBe(wrapper.decodedNodes + growth.reduce((sum, record) => sum + record.nodes, 0));
    expect(budget.costs.campaignReaderCharacters).toBe(text.length + growth.reduce((sum, record) => sum + record.characters, 0));
    expect(budget.limits.campaignReaderNodes).toBe(200_000); expect(budget.limits.campaignReaderCharacters).toBe(2_000_000);
  });
  it('detects an occupied future milestone key even under an unrelated old award command ID', () => {
    let world = createWorldV8('exit-milestone-namespace');
    const attained = world.cultivation.disciples[0]!; const target = world.cultivation.disciples[2]!;
    // Explicit reader-valid attained-realm import fixture. No battle or victory is fabricated.
    attained.realm = 'qi'; attained.lifespanMonths = 1320;
    const milestoneId = `realm/${target.discipleId}/qi`;
    const awarded = applyBuildAuthorityCommandV2({ builds: world.builds, sequences: world.sequences }, { kind: 'milestone.award',
      commandId: 'historical:attained-realm', expectedRevision: world.builds.revision, discipleId: attained.discipleId,
      milestoneId, ruleId: 'realm.qi' }, getWorldBuildContentContext(world)!);
    if (!awarded.ok) throw new Error(awarded.code);
    world = { ...world, builds: copy(awarded.frame.builds), sequences: copy(awarded.frame.sequences) };
    expect(validateWorldStateV8(world)).toEqual([]); target.cultivation = 120;
    const preview = previewWorldBreakthroughV8(world, target.discipleId, { method: 'standard', arraySupport: 0 });
    world = cultivate(world, { commandId: 'exit:future-realm', kind: 'breakthrough.confirm', expectedRevision: world.cultivation.revision, preview });
    const commandId = 'exit:imported-milestone-boundary';
    const body = { kind: 'expedition.depart' as const, commandId,
      request: { routeId: 'route.qingfeng-trial' as const, squadIds: world.disciples.slice(0, 2).map(actor => actor.id) } };
    const refused = dispatchCommandV8(world, { commandId, sequence: world.sequences.nextAction, issuedTick: world.clock.simulationTick,
      kind: 'expedition.command', payload: { command: body } });
    expect(refused.result.rejection?.code).toBe('SAVE_OBLIGATION_UNBOUNDED'); expect(refused.world).toBe(world);
    // Keep the imported negative boundary reachable by the authentic lower-level
    // adapter for reader/certificate testing, without weakening public admission.
    const boundary = dispatchWorldExpeditionV8(world, body);
    expect(boundary.ok).toBe(true); if (!boundary.ok) throw new Error(boundary.code); world = boundary.world;
    expect(validateWorldStateV8(world)).toEqual([]);
    const before = canonicalStringify(world); expect(assess(world).unknowns.join()).toContain(`identity already occupied: build-milestone:${milestoneId}`);
    expect(canonicalStringify(world)).toBe(before);
  });
  it('refuses a reader-valid imported running controller with no actual permanent survivor', () => {
    const source = act(atNode, { kind: 'expedition.continue' }); expectFunded(source);
    const imported = cloneJson(source); const encounter = imported.expedition.battle!; const battle = encounter.controller.battle;
    const participants = new Set(encounter.participants.map(participant => participant.battleEntityId)); let nextInstance = battle.sequences.nextInstance;
    // Import-only negative fixture: no victory, reward, or death is submitted as gameplay.
    const entities: typeof battle.entities = Object.fromEntries(Object.entries(battle.entities).map(([id, entity]) => [id, participants.has(id)
      ? { ...entity, life: 'Dead' as const, health: 0, deathId: `instance:${nextInstance++}` } : entity] as const));
    encounter.controller = { ...encounter.controller, battle: { ...battle, entities, sequences: { ...battle.sequences, nextInstance } } };
    expect(encounter.controller.outcome.status).toBe('running'); expect(validateWorldStateV8(imported)).toEqual([]);
    const before = canonicalStringify(imported); expect(assess(imported)).toMatchObject({ supported: false, fits: false });
    expect(assess(imported).unknowns.join()).toContain('no non-permanently-dead participant');
    const preview = previewWorldEmergencyRetreatV8(imported)!;
    expect(dispatchWorldExpeditionV8(imported, { commandId: 'exit:no-survivor', kind: 'expedition.emergency-retreat',
      expectedBasisStamp: preview.basisStamp, acknowledgeLoss: true })).toMatchObject({ ok: false });
    expect(canonicalStringify(imported)).toBe(before); expectFunded(source);
  });
  it('fails closed for old run protocols, pending optional work, missing runs, unknown identities and accessor input', () => {
    expect(assess(createWorldV8('no-run'))).toMatchObject({ supported: false, fits: false });
    const queued = cloneJson(travelling); queued.pendingCommands.push({ commandId: 'queued:optional', sequence: 1, issuedTick: 10,
      kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: false } } });
    expect(assess(queued)).toMatchObject({ supported: false, fits: false }); expect(assess(queued).unknowns.join()).toContain('Queued');
    const text = readFileSync(new URL('./fixtures/save-v7-active-battle.json', import.meta.url), 'utf8'); const parsed = parseSave(text);
    if (!parsed.ok) throw new Error(parsed.error.message); const old = migrateWorldV7ToV8(parsed.world); const oldBytes = canonicalStringify(old);
    expect(assess(old)).toMatchObject({ supported: false, fits: false }); expect(canonicalStringify(old)).toBe(oldBytes);
    const unknown = cloneJson(travelling); unknown.expedition.protocol = 'future' as typeof unknown.expedition.protocol;
    expect(assess(unknown)).toMatchObject({ supported: false, fits: false });
    let called = false; const accessor = Object.defineProperty({}, 'expedition', { enumerable: true, get() { called = true; return travelling.expedition; } });
    expect(assess(accessor as WorldStateV8)).toMatchObject({ supported: false, fits: false }); expect(called).toBe(false);
  }, 30_000);
});
