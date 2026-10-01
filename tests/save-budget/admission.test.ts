import { describe, expect, test } from 'vitest';
import { PRODUCTION_BLOCKED_REASONS, PRODUCTION_PHASES } from '../../src/core/economy/types';
import { STARTER_RECIPES } from '../../src/core/economy/recipes';
import { appendArchivedEvent, createHistoryArchive, getHistoryArchiveUsage, MAX_HISTORY_EXPANDED_CHARACTERS, MAX_HISTORY_EXPANDED_NODES } from '../../src/core/history';
import type { Command } from '../../src/core/kernel/contracts';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { automaticByteBoundFixtures } from '../../src/core/save-budget/bounds';
import { assessExpansionHeadroom } from '../../src/core/save-budget/retention';
import { AUTOMATIC_JOURNAL_LIMIT, NON_AUTOMATIC_HEADROOM_BYTES, SAVE_FILE_LIMIT_BYTES, assessAutomaticWorkBudget,
  automaticJobByteBudget, canonicalUtf8ByteLength, measureWorldSaveBytes, navigationPathByteBudget, pendingCommandByteBudget,
  assessHistorySlots, manualProductionByteObligations, verifyReservedRelease, verifySaveCandidate, type AutomaticSaveBudgetInput } from '../../src/core/save-budget';

const starterMap = { width: 14, height: 10 };
const minimalWorld = () => ({ seed: 'budget-test', simulationVersion: '0.7.0', contentVersion: 'starter-0.1.0', padding: '' });
function input(overrides: Partial<AutomaticSaveBudgetInput> = {}): AutomaticSaveBudgetInput {
  return { world: minimalWorld(), map: starterMap, liveAutomaticJobCount: 0, pendingCommands: [], maximumNewStarts: 2, ...overrides };
}
function worldWithBytes(bytes: number) {
  const world = minimalWorld();
  const remaining = bytes - measureWorldSaveBytes(world);
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw new RangeError('Fixture is too small');
  world.padding = 'a'.repeat(remaining);
  return world;
}
const cancel: Command = { commandId: 'cancel.1', issuedTick: 0, sequence: 1, kind: 'production.cancel', payload: { transactionId: 'auto-job/1' } };
const start: Command = { commandId: 'start.1', issuedTick: 0, sequence: 2, kind: 'production.start', payload: { workerId: 'entity:2', recipeId: 'gather.wood' } };

describe('schema-derived future obligation bounds', () => {
  test('path bound is map-derived at starter, maximum, and one-cell dimensions', () => {
    expect(navigationPathByteBudget(starterMap)).toBe(2101);
    expect(navigationPathByteBudget({ width: 256, height: 256 })).toBe(1_179_649);
    expect(navigationPathByteBudget({ width: 1, height: 1 })).toBe(15);
    expect(navigationPathByteBudget({ width: 256, height: 256 })).toBeGreaterThan(4096);
    for (const map of [{ width: 0, height: 1 }, { width: 257, height: 1 }, { width: 1.5, height: 1 }]) expect(() => navigationPathByteBudget(map)).toThrow();
  });

  test('maximum coordinate repeated-cell encoding attains the exact syntactic bound', () => {
    const map = { width: 256, height: 256 };
    // Size envelope fixture, not a legal traversal: every coordinate has maximum digits.
    const path = Array.from({ length: map.width * map.height }, () => ({ x: 255, y: 255 }));
    expect(new TextEncoder().encode(canonicalStringify(path)).byteLength).toBe(navigationPathByteBudget(map));
    const fixture = automaticByteBoundFixtures(map);
    fixture.live.transaction.navigation.path = path;
    const bounds = automaticJobByteBudget(map);
    expect(canonicalUtf8ByteLength({ [fixture.live.transaction.transactionId]: fixture.live })).toBeLessThanOrEqual(bounds.fixedLiveBytes + bounds.pathBytes);
  });

  test('a maximum-map legal Hamiltonian snake is also covered, without a short-route assumption', () => {
    const map = { width: 256, height: 256 };
    const path = Array.from({ length: map.height }, (_, y) => Array.from({ length: map.width }, (_, index) => ({ x: y % 2 ? map.width - 1 - index : index, y }))).flat();
    for (let index = 1; index < path.length; index += 1) expect(Math.abs(path[index]!.x - path[index - 1]!.x) + Math.abs(path[index]!.y - path[index - 1]!.y)).toBe(1);
    expect(canonicalUtf8ByteLength(path.slice(1))).toBeLessThan(navigationPathByteBudget(map));
    expect(canonicalUtf8ByteLength(path.slice(1))).toBeGreaterThan(1_000_000);
  });

  test('typed safe-integer/ID/schema maxima verify all four proposed loose targets', () => {
    const map = { width: 256, height: 256 };
    const fixture = automaticByteBoundFixtures(map);
    const budget = automaticJobByteBudget(map);
    expect(budget.fixedLiveBytes).toBeLessThanOrEqual(4096);
    expect(budget.pinAndEventBytes).toBeLessThanOrEqual(2048);
    expect(budget.cancellationReceiptBytes).toBeLessThanOrEqual(2048);
    expect(budget.noticeBytes).toBeLessThanOrEqual(1024);
    expect(canonicalUtf8ByteLength(fixture.notice)).toBe(budget.noticeBytes);
    expect(canonicalUtf8ByteLength(Array.from({ length: AUTOMATIC_JOURNAL_LIMIT }, () => fixture.notice))).toBe(budget.fullJournalBytes);
    expect(budget.totalBytes).toBe(budget.pathBytes + budget.fixedLiveBytes + budget.pinAndEventBytes + budget.cancellationReceiptBytes + budget.sideEffectsBytes);
    expect(Object.isFrozen(budget)).toBe(true);
  });

  test('all registered recipes, phases and reasons fit the typed fixed-field envelope', () => {
    const map = { width: 256, height: 256 };
    const fixture = automaticByteBoundFixtures(map);
    const maximum = canonicalUtf8ByteLength(fixture.live);
    for (const recipe of Object.values(STARTER_RECIPES)) for (const phase of PRODUCTION_PHASES) for (const reason of PRODUCTION_BLOCKED_REASONS) {
      const candidate = { transaction: { ...fixture.live.transaction, recipeId: recipe.recipeId, requiredTicks: recipe.workTicks,
        activeTicks: recipe.workTicks, phase, blockedReason: reason }, reservation: { ...fixture.live.reservation, lines: recipe.inputs } };
      expect(canonicalUtf8ByteLength(candidate)).toBeLessThanOrEqual(maximum);
    }
  });

  test('bounded pending effects accumulate; unknown domains do not receive invented bounds', () => {
    const economy: Command = { commandId: 'plan.1', sequence: 3, issuedTick: 100, kind: 'sect-economy.command', payload: { command: { kind: 'enabled.set', enabled: true } } };
    const queue = [start, cancel, economy];
    const budget = pendingCommandByteBudget(queue, starterMap);
    expect(budget.supported).toBe(true);
    expect(budget.bytes).toBe(queue.reduce((sum, command) => sum + pendingCommandByteBudget([command], starterMap).bytes, 0));
    expect(pendingCommandByteBudget(Array.from({ length: 1000 }, () => cancel), starterMap).bytes).toBe(1000 * pendingCommandByteBudget([cancel], starterMap).bytes);
    const unknown: Command = { commandId: 'retreat.1', sequence: 4, issuedTick: 100, kind: 'expedition.command', payload: { command: { commandId: 'retreat.1', kind: 'expedition.retreat' } } };
    const incomplete = pendingCommandByteBudget([...queue, unknown], starterMap);
    expect(incomplete.bytes).toBe(budget.bytes);
    expect(incomplete.supported).toBe(false);
    expect(incomplete.unsupportedKinds).toEqual(['expedition.command']);
  });

  test('maximum legal discard owns one event/receipt and no production settlement', () => {
    const command: Command = { commandId: 'd'.repeat(128), issuedTick: Number.MAX_SAFE_INTEGER,
      sequence: Number.MAX_SAFE_INTEGER, kind: 'inventory.discard', payload: { resourceId: 'herbs', quantity: Number.MAX_SAFE_INTEGER } };
    const budget = pendingCommandByteBudget([command], starterMap);
    expect(budget.supported).toBe(true);
    expect(budget.unsupportedKinds).toEqual([]);
    const eventId = `event:${Number.MAX_SAFE_INTEGER}`;
    const event = { eventId, kind: 'inventory.discarded', tick: Number.MAX_SAFE_INTEGER, rootActionId: `action:${Number.MAX_SAFE_INTEGER}`,
      parentEventId: null, payload: { commandId: command.commandId, ...command.payload } };
    const receipt = { commandId: command.commandId, fingerprint: canonicalStringify({ kind: command.kind, payload: command.payload }),
      result: { commandId: command.commandId, status: 'accepted', transactionId: null, eventIds: [eventId], rejection: null,
        discardResult: { ...command.payload } } };
    const actualRawRows = canonicalUtf8ByteLength([1, eventId, event]) + canonicalUtf8ByteLength([1, command.commandId, receipt]);
    expect(budget.bytes).toBeGreaterThan(actualRawRows);
    const assessment = assessAutomaticWorkBudget(input({ pendingCommands: [command] }));
    expect(assessment.unsupportedPendingKinds).toEqual([]);
    expect(assessment.archiveSlots.reserved).toEqual({ production: 0, commandReceipts: 1, events: 1 });
    expect(assessment.archiveExpansion.reservedCharacters).toBe(budget.bytes);
    expect(assessment.archiveExpansion.reservedNodes).toBe(budget.bytes + 64);
    expect(assessment.autoStartAllowance).toBe(2);
  });

  test('existing manual live work reserves large-map routes and preserves legacy extension bytes', () => {
    const fixture = automaticByteBoundFixtures(starterMap);
    const { origin: _origin, ...shape } = fixture.live.transaction;
    const transactionId = 'instance:1';
    const transaction = { ...shape, transactionId, commandId: '\u0000'.repeat(256), reservationId: 'instance:2', legacyAudit: '中'.repeat(1000) };
    const world = { ...minimalWorld(), transactions: { [transactionId]: transaction },
      reservations: { 'instance:2': { ...fixture.live.reservation, reservationId: 'instance:2', ownerTransactionId: transactionId } } };
    const small = manualProductionByteObligations(world, starterMap);
    const large = manualProductionByteObligations(world, { width: 256, height: 256 });
    expect(small.count).toBe(1);
    expect(large.bytes - small.bytes).toBeGreaterThan(1_170_000);
    const assessment = assessAutomaticWorkBudget(input({ world }));
    expect(assessment.manualObligationBytes).toBe(small.bytes);
    expect(assessment.archiveSlots.reserved).toEqual({ production: 1, commandReceipts: 1, events: 1 });
    const smaller = { ...world, transactions: { [transactionId]: { ...transaction, legacyAudit: '' } } };
    expect(small.bytes - manualProductionByteObligations(smaller, starterMap).bytes).toBe(6000);
  });
});

describe('pure shared allowance and candidate admission', () => {
  test('two proposals consume one shared budget; one byte below the second allows only one', () => {
    const empty = assessAutomaticWorkBudget(input());
    const exactTwo = SAVE_FILE_LIMIT_BYTES - empty.reservedBytes - 2 * empty.perNewJobBytes;
    expect(assessAutomaticWorkBudget(input({ world: worldWithBytes(exactTwo) })).autoStartAllowance).toBe(2);
    expect(assessAutomaticWorkBudget(input({ world: worldWithBytes(exactTwo + 1) })).autoStartAllowance).toBe(1);
    const exactOne = SAVE_FILE_LIMIT_BYTES - empty.reservedBytes - empty.perNewJobBytes;
    expect(assessAutomaticWorkBudget(input({ world: worldWithBytes(exactOne) })).autoStartAllowance).toBe(1);
    expect(assessAutomaticWorkBudget(input({ world: worldWithBytes(exactOne + 1) })).autoStartAllowance).toBe(0);
  });

  test('allowance is capped by shared source limit, worker slots and all live obligations', () => {
    expect(assessAutomaticWorkBudget(input({ maximumNewStarts: 100 })).autoStartAllowance).toBe(2);
    expect(assessAutomaticWorkBudget(input({ maximumNewStarts: 1 })).autoStartAllowance).toBe(1);
    expect(assessAutomaticWorkBudget(input({ maximumNewStarts: 0 })).autoStartAllowance).toBe(0);
    const all = assessAutomaticWorkBudget(input({ liveAutomaticJobCount: 36 }));
    expect(all.liveObligationBytes).toBe(36 * all.perLiveJobBytes);
    expect(all.autoStartAllowance).toBe(0);
    expect(all.generalHeadroomBytes).toBe(NON_AUTOMATIC_HEADROOM_BYTES);
    expect(assessAutomaticWorkBudget(input({ liveAutomaticJobCount: 35 })).autoStartAllowance).toBe(1);
  });

  test('new-start allowance funds a full current route as well as its newly live future reserve', () => {
    const empty = assessAutomaticWorkBudget(input());
    const boundary = SAVE_FILE_LIMIT_BYTES - empty.reservedBytes - empty.perNewJobBytes;
    const before = input({ world: worldWithBytes(boundary), maximumNewStarts: 1 });
    expect(assessAutomaticWorkBudget(before).autoStartAllowance).toBe(1);
    const maximumLive = empty.perNewJobBytes - empty.perLiveJobBytes;
    expect(maximumLive).toBeGreaterThan(navigationPathByteBudget(starterMap));
    const after = input({ world: worldWithBytes(boundary + maximumLive), liveAutomaticJobCount: 1, maximumNewStarts: 0 });
    expect(verifySaveCandidate(after).ok).toBe(true);
  });

  test('an edge-admitted typed live-pair insertion still fits after its route materializes', () => {
    // Boundary arithmetic fixture. Cross-domain World validity is tested by integration.
    const world = { ...minimalWorld(), automaticProduction: { schemaVersion: 1, nextCycle: 1,
      activationReviewRequired: false, live: {}, journal: [], pins: {} } };
    const initial = assessAutomaticWorkBudget(input({ world, maximumNewStarts: 1 }));
    const edge = SAVE_FILE_LIMIT_BYTES - initial.reservedBytes - initial.perNewJobBytes;
    world.padding = 'a'.repeat(edge - measureWorldSaveBytes(world));
    expect(assessAutomaticWorkBudget(input({ world, maximumNewStarts: 1 })).autoStartAllowance).toBe(1);
    const live = automaticByteBoundFixtures(starterMap).live;
    live.transaction.navigation.path = Array.from({ length: starterMap.height }, (_, y) =>
      Array.from({ length: starterMap.width }, (_, x) => ({ x: y % 2 ? starterMap.width - 1 - x : x, y }))).flat().slice(1);
    const candidate = { ...world, automaticProduction: { ...world.automaticProduction, nextCycle: Number.MAX_SAFE_INTEGER,
      live: { [live.transaction.transactionId]: live } } };
    expect(verifySaveCandidate(input({ world: candidate, liveAutomaticJobCount: 1, maximumNewStarts: 0 })).ok).toBe(true);
  });

  test('large-map future routes can exhaust headroom before current state approaches the cap', () => {
    const result = assessAutomaticWorkBudget(input({ map: { width: 256, height: 256 }, liveAutomaticJobCount: 3 }));
    expect(result.actualFits).toBe(true);
    expect(result.obligationsFit).toBe(false);
    expect(result.autoStartAllowance).toBe(0);
    expect(result.reason).toBe('headroom');
  });

  test('full and empty journal reserve the same maximum combined journal cost', () => {
    const bounds = automaticJobByteBudget(starterMap);
    const empty = assessAutomaticWorkBudget(input({ journalBytes: 2 }));
    const full = assessAutomaticWorkBudget(input({ journalBytes: bounds.fullJournalBytes }));
    expect(empty.journalReserveBytes).toBe(bounds.fullJournalBytes - 2);
    expect(full.journalReserveBytes).toBe(0);
  });

  test('exact cap remains exportable but not growth-admissible; one byte over is distinguished', () => {
    const exact = assessAutomaticWorkBudget(input({ world: worldWithBytes(SAVE_FILE_LIMIT_BYTES) }));
    expect(exact.actualFits).toBe(true);
    expect(exact.obligationsFit).toBe(false);
    expect(exact.reason).toBe('headroom');
    const over = verifySaveCandidate(input({ world: worldWithBytes(SAVE_FILE_LIMIT_BYTES + 1) }));
    expect(over).toMatchObject({ ok: false, transient: true, code: 'SAVE_CAPACITY_EXCEEDED', budget: { actualFits: false, reason: 'save-cap' } });
  });

  test('complete candidates must fit remaining commitments, not just their serialized bytes', () => {
    const initial = assessAutomaticWorkBudget(input());
    const edge = SAVE_FILE_LIMIT_BYTES - initial.reservedBytes;
    expect(verifySaveCandidate(input({ world: worldWithBytes(edge), maximumNewStarts: 0 })).ok).toBe(true);
    const candidate = input({ world: worldWithBytes(edge + 1), maximumNewStarts: 0 });
    const before = canonicalStringify(candidate);
    const first = verifySaveCandidate(candidate);
    const retry = verifySaveCandidate(candidate);
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ ok: false, transient: true, budget: { actualFits: true, obligationsFit: false } });
    expect(canonicalStringify(candidate)).toBe(before);
  });

  test('queued future commands own distinct headroom even before receipt dispatch', () => {
    const base = assessAutomaticWorkBudget(input());
    const queued = assessAutomaticWorkBudget(input({ pendingCommands: [start, cancel] }));
    expect(queued.reservedBytes - base.reservedBytes).toBe(pendingCommandByteBudget([start, cancel], starterMap).bytes);
    expect(queued.pendingObligationBytes).toBeGreaterThan(queued.perNewJobBytes);
    const many = assessAutomaticWorkBudget(input({ pendingCommands: Array.from({ length: 10_000 }, () => cancel) }));
    expect(many.autoStartAllowance).toBe(0);
    expect(many.obligationsFit).toBe(false);
  });

  test('unsupported imported pending kinds disable starts without claiming actual overflow', () => {
    const pending: Command = { commandId: 'retreat.1', sequence: 1, issuedTick: 100, kind: 'expedition.command', payload: { command: { commandId: 'retreat.1', kind: 'expedition.retreat' } } };
    const assessment = assessAutomaticWorkBudget(input({ pendingCommands: [pending] }));
    expect(assessment).toMatchObject({ actualFits: true, obligationsFit: false, autoStartAllowance: 0, reason: 'unsupported-pending' });
    expect(verifySaveCandidate(input({ pendingCommands: [pending] }))).toMatchObject({ ok: false, transient: true, code: 'SAVE_OBLIGATION_UNBOUNDED' });
  });

  test('finite archive row limits reserve cancellation and receipt slots independently of bytes', () => {
    const world = { ...minimalWorld(), history: { production: { count: 0 }, commandReceipts: { count: 99_999 }, events: { count: 99_999 } }, commandReceipts: {}, events: [] };
    // A scalar row-accounting fixture, not a forged archive passed to admission.
    const one = assessHistorySlots(world, 0, 0, []);
    expect(one.automaticAllowance).toBe(1);
    const none = assessHistorySlots(world, 1, 0, []);
    expect(none.automaticAllowance).toBe(0);
    expect(none.fits).toBe(true);
    const over = assessHistorySlots(world, 2, 0, []);
    expect(over.fits).toBe(false);
    expect(over.automaticAllowance).toBe(0);
  });

  test('live receipt/event tails and queued command settlement slots cannot be spent twice', () => {
    const world = { ...minimalWorld(), history: { production: { count: 99_999 }, commandReceipts: { count: 99_999 }, events: { count: 99_999 } },
      commandReceipts: { 'old.1': {} }, events: [{}] };
    const result = assessHistorySlots(world, 0, 0, [start]);
    expect(result.current).toEqual({ production: 99_999, commandReceipts: 100_000, events: 100_000 });
    expect(result.reserved).toEqual({ production: 1, commandReceipts: 2, events: 2 });
    expect(result.fits).toBe(false);
    expect(result.automaticAllowance).toBe(0);
  });

  test('archive expansion reads authenticated counters and reserves live-tail rows too', () => {
    const event = { eventId: 'event:1', tick: 1, rootActionId: 'action:1', parentEventId: null,
      kind: 'production.blocked' as const, payload: { transactionId: 'instance:1', reason: 'PATH_BLOCKED' } };
    const history = appendArchivedEvent(createHistoryArchive(), event);
    const tail = { ...event, eventId: 'event:2' };
    const world = { ...minimalWorld(), history, events: [tail], commandReceipts: {} };
    const usage = getHistoryArchiveUsage(history);
    const result = assessAutomaticWorkBudget(input({ world }));
    expect(result.archiveExpansion.currentCharacters).toBe(usage.expandedCharacters);
    expect(result.archiveExpansion.currentNodes).toBe(usage.expandedNodes);
    expect(result.archiveExpansion.reservedCharacters).toBe(canonicalUtf8ByteLength(tail));
    expect(result.archiveExpansion.reservedNodes).toBe(canonicalUtf8ByteLength(tail) + 32);
    expect(result.archiveExpansionFit).toBe(true);
  });

  test('expanded node and character ceilings each independently gate future starts', () => {
    const perJob = 100 + 64;
    const nodes = assessExpansionHeadroom({ expandedCharacters: 0, expandedNodes: MAX_HISTORY_EXPANDED_NODES - perJob }, 0, 0, 100);
    expect(nodes.automaticAllowance).toBe(1);
    expect(assessExpansionHeadroom({ expandedCharacters: 0, expandedNodes: MAX_HISTORY_EXPANDED_NODES - perJob + 1 }, 0, 0, 100).automaticAllowance).toBe(0);
    const characters = assessExpansionHeadroom({ expandedCharacters: MAX_HISTORY_EXPANDED_CHARACTERS - perJob, expandedNodes: 0 }, 0, 0, 100);
    expect(characters.automaticAllowance).toBe(1);
    expect(assessExpansionHeadroom({ expandedCharacters: MAX_HISTORY_EXPANDED_CHARACTERS - 100, expandedNodes: 0 }, 101, 0, 100).fits).toBe(false);
    const charged = assessExpansionHeadroom({ expandedCharacters: 0, expandedNodes: MAX_HISTORY_EXPANDED_NODES - 100 }, 36, 2, 100);
    expect(charged.fits).toBe(true);
    expect(assessExpansionHeadroom({ expandedCharacters: 0, expandedNodes: MAX_HISTORY_EXPANDED_NODES - 100 }, 37, 2, 100).fits).toBe(false);
  });

  test('a reserved live cancellation can fit near capacity even while general headroom is exhausted', () => {
    const before = input({ world: worldWithBytes(SAVE_FILE_LIMIT_BYTES - 1500), liveAutomaticJobCount: 1, maximumNewStarts: 0 });
    const after = input({ world: worldWithBytes(SAVE_FILE_LIMIT_BYTES - 500), liveAutomaticJobCount: 0, maximumNewStarts: 0 });
    expect(verifySaveCandidate(after).ok).toBe(false);
    expect(verifyReservedRelease(before, after).ok).toBe(true);
    expect(verifyReservedRelease(before, input({ ...after, world: worldWithBytes(SAVE_FILE_LIMIT_BYTES + 1) })).ok).toBe(false);
    expect(verifyReservedRelease(after, before).ok).toBe(false);
  });

  test('invalid counts fail closed rather than generating fractional or negative allowance', () => {
    for (const liveAutomaticJobCount of [-1, 0.5, 37, Infinity]) expect(() => assessAutomaticWorkBudget(input({ liveAutomaticJobCount }))).toThrow();
    expect(() => assessAutomaticWorkBudget(input({ maximumNewStarts: -1 }))).toThrow();
    expect(() => assessAutomaticWorkBudget(input({ journalBytes: -1 }))).toThrow();
    expect(() => assessAutomaticWorkBudget(input({ journalBytes: Number.MAX_SAFE_INTEGER }))).toThrow();
  });
});
