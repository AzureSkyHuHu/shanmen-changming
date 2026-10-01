import type { CommandV8 as Command } from '../kernel/contracts-v8';
import type { AutomaticLiveJob, AutomaticProductionNotice, AutomaticTerminalPin } from '../economy/automatic-types';
import { STARTER_RECIPES } from '../economy/recipes';
import { PRODUCTION_BLOCKED_REASONS, PRODUCTION_PHASES, RESOURCE_IDS, type ProductionTransaction, type Reservation } from '../economy/types';
import type { CommandReceipt, DomainEvent } from '../kernel/contracts';
import { canonicalStringify } from '../kernel/serialization';
import { MAX_STOCK_TARGET, MAX_WORK_PRIORITIES, type DiscipleWorkPlan } from '../sect-economy/types';
import { canonicalUtf8ByteLength as size, jsonStringByteLength } from './canonical-bytes';

export interface SaveBudgetMap { width: number; height: number }
export const AUTOMATIC_JOURNAL_LIMIT = 64;
const MAXIMUM = Number.MAX_SAFE_INTEGER;
const DIGITS = String(MAXIMUM).length;
const ENTITY = `entity:${MAXIMUM}`;
const INSTANCE = `instance:${MAXIMUM}`;
const EVENT = `event:${MAXIMUM}`;
const ACTION = `action:${MAXIMUM}`;
const AUTO_JOB = `auto-job/${MAXIMUM}` as const;
const COMMAND = 'c'.repeat(128);
const longest = <T extends string>(values: readonly T[]): T => values.reduce((left, right) => jsonStringByteLength(left) >= jsonStringByteLength(right) ? left : right);
const RECIPES = Object.values(STARTER_RECIPES);
const RECIPE = longest(RECIPES.map((recipe) => recipe.recipeId));
const MAX_INPUTS = RECIPES.reduce((left, right) => size(left.inputs) >= size(right.inputs) ? left : right).inputs;
const MAX_WORK_TICKS = Math.max(...RECIPES.map((recipe) => recipe.workTicks));

function assertMap(map: SaveBudgetMap): void {
  if (!Number.isSafeInteger(map.width) || !Number.isSafeInteger(map.height)
    || map.width < 1 || map.height < 1 || map.width > 256 || map.height > 256) throw new RangeError('Invalid bounded navigation map');
}

/** An N-cell route, not an assumed short BFS route. Includes brackets and separators. */
export function navigationPathByteBudget(map: SaveBudgetMap): number {
  assertMap(map);
  return 1 + map.width * map.height * (12 + String(map.width - 1).length + String(map.height - 1).length);
}

/**
 * Both current map/list placement and raw archive fallback are included, even though
 * the same record is normally in just one. The extra allowance covers a new page,
 * separators, and every table-count digit growing to its maximum legal width.
 * A possible pool insertion is additional, not assumed free compression.
 */
export function retainedRecordBytes(record: unknown, key: string, poolText: readonly string[] = []): number {
  return size({ [key]: record }) + size([1, key, record]) + size(poolText) + 3 * DIGITS + 8;
}

function maxNavigation(map: SaveBudgetMap) {
  return { path: [], target: { x: map.width - 1, y: map.height - 1 }, routeVersion: MAXIMUM, movementTicks: 3, retryAtTick: MAXIMUM };
}

/** Typed per-field maxima, not a claim that every maximum is simultaneously reachable. */
export function automaticByteBoundFixtures(map: SaveBudgetMap): {
  live: AutomaticLiveJob; pin: AutomaticTerminalPin; event: DomainEvent; notice: AutomaticProductionNotice; receipt: CommandReceipt;
} {
  assertMap(map);
  const live: AutomaticLiveJob = {
    transaction: {
      transactionId: AUTO_JOB, origin: { kind: 'sect-plan', cycle: MAXIMUM }, rootActionId: ACTION,
      recipeId: RECIPE, workerId: ENTITY, reservationId: INSTANCE, state: 'Blocked',
      activeTicks: MAX_WORK_TICKS, requiredTicks: MAX_WORK_TICKS, startedTick: MAXIMUM,
      completedTick: null, resultEventId: null, blockedReason: longest(PRODUCTION_BLOCKED_REASONS),
      phase: longest(PRODUCTION_PHASES), worksiteId: ENTITY, storageId: ENTITY, navigation: maxNavigation(map),
    },
    reservation: { reservationId: INSTANCE, ownerTransactionId: AUTO_JOB, lines: MAX_INPUTS.map((line) => ({ ...line })), state: 'reserved' },
  };
  const pin: AutomaticTerminalPin = {
    cycle: MAXIMUM, state: 'Cancelled', workerId: ENTITY, recipeId: RECIPE, rootActionId: ACTION,
    completedTick: MAXIMUM, resultEventId: EVENT, retention: 'pending-command',
  };
  const event: DomainEvent = {
    eventId: EVENT, tick: MAXIMUM, rootActionId: ACTION, parentEventId: null, kind: 'production.cancelled',
    payload: { transactionId: AUTO_JOB, recipeId: RECIPE, workerId: ENTITY, settledTick: MAXIMUM },
  };
  const notice: AutomaticProductionNotice = {
    eventId: EVENT, tick: MAXIMUM, cycle: MAXIMUM, workerId: ENTITY, recipeId: RECIPE,
    kind: 'committed', reason: longest(PRODUCTION_BLOCKED_REASONS),
  };
  const receipt: CommandReceipt = {
    commandId: COMMAND, fingerprint: canonicalStringify({ kind: 'production.cancel', payload: { transactionId: AUTO_JOB } }),
    result: { commandId: COMMAND, status: 'accepted', transactionId: AUTO_JOB, eventIds: [EVENT], rejection: null },
  };
  return { live, pin, event, notice, receipt };
}

export interface AutomaticJobByteBudget {
  pathBytes: number;
  fixedLiveBytes: number;
  pinAndEventBytes: number;
  cancellationReceiptBytes: number;
  sideEffectsBytes: number;
  fullJournalBytes: number;
  noticeBytes: number;
  totalBytes: number;
}

// Keyed only by validated primitive dimensions and this module's fixed source schema.
// The returned record is frozen; no mutable World/import identity is cached here.
const mapBudgets = new Map<string, Readonly<AutomaticJobByteBudget>>();
export function automaticJobByteBudget(map: SaveBudgetMap): AutomaticJobByteBudget {
  assertMap(map);
  const key = `${map.width}:${map.height}`;
  const cached = mapBudgets.get(key);
  if (cached) return cached;
  const fixtures = automaticByteBoundFixtures(map);
  const pathBytes = navigationPathByteBudget(map);
  // The empty path is replaced, not added; map entry braces are retained conservatively.
  const fixedLiveBytes = size({ [AUTO_JOB]: fixtures.live }) + 1 - 2;
  const pinAndEventBytes = size({ [AUTO_JOB]: fixtures.pin }) + 1 + retainedRecordBytes(fixtures.event, EVENT);
  const cancellationReceiptBytes = retainedRecordBytes(fixtures.receipt, COMMAND, [fixtures.receipt.fingerprint]);
  // Four sequence counters, automatic cursor/decision deadline, every resource's
  // owned/reserved value, two assignment owners,
  // worker x/y digits, and booleans. All are upper deltas, independent of present values.
  const sideEffectsBytes = (6 + 2 * RESOURCE_IDS.length) * DIGITS + 2 * jsonStringByteLength(AUTO_JOB)
    + String(map.width - 1).length + String(map.height - 1).length + 8;
  const noticeBytes = size(fixtures.notice);
  const fullJournalBytes = 1 + AUTOMATIC_JOURNAL_LIMIT * (noticeBytes + 1);
  const budget = Object.freeze({ pathBytes, fixedLiveBytes, pinAndEventBytes, cancellationReceiptBytes, sideEffectsBytes,
    fullJournalBytes, noticeBytes, totalBytes: pathBytes + fixedLiveBytes + pinAndEventBytes + cancellationReceiptBytes + sideEffectsBytes });
  mapBudgets.set(key, budget);
  return budget;
}

function receiptFor(command: Command, transactionId: string | null, eventIds: string[]): CommandReceipt {
  return { commandId: command.commandId, fingerprint: canonicalStringify({ kind: command.kind, payload: command.payload }),
    result: { commandId: command.commandId, status: 'accepted', transactionId, eventIds, rejection: null } };
}
function receiptBudget(command: Command, transactionId: string | null, eventIds: string[], economy = false): number {
  const accepted = receiptFor(command, transactionId, eventIds);
  if (economy) accepted.result.economyResult = { kind: 'enabled.set', workerId: ENTITY };
  const rejected: CommandReceipt = { ...accepted, result: {
    commandId: command.commandId, status: 'rejected', transactionId: null, eventIds: [],
    rejection: { code: 'SECT_ECONOMY_REJECTED', economyCode: 'INVALID_COMMAND', resourceId: 'herbs' },
  } };
  return Math.max(retainedRecordBytes(accepted, command.commandId, [accepted.fingerprint]),
    retainedRecordBytes(rejected, command.commandId, [rejected.fingerprint]));
}

/** Bounded dispatch/settlement costs. Unbounded future manual blocked history is not promised. */
export function pendingCommandByteBudget(commands: readonly Command[], map: SaveBudgetMap): {
  bytes: number; supported: boolean; unsupportedKinds: string[];
} {
  if (!commands.length) return { bytes: 0, supported: true, unsupportedKinds: [] };
  const auto = automaticJobByteBudget(map);
  const fixtures = automaticByteBoundFixtures(map);
  const unsupported = new Set<string>();
  let bytes = 0;
  for (const command of commands) {
    if (command.kind === 'inventory.discard') {
      const receipt = receiptFor(command, null, [EVENT]);
      receipt.result.discardResult = { ...command.payload };
      const event: DomainEvent = { eventId: EVENT, kind: 'inventory.discarded', tick: MAXIMUM,
        rootActionId: ACTION, parentEventId: null, payload: { commandId: command.commandId, ...command.payload } };
      bytes += retainedRecordBytes(event, EVENT)
        + Math.max(retainedRecordBytes(receipt, command.commandId, [receipt.fingerprint]), receiptBudget(command, null, []))
        + 3 * DIGITS + 8;
    } else if (command.kind === 'production.cancel') {
      bytes += auto.pinAndEventBytes + receiptBudget(command, command.payload.transactionId, [EVENT]) + auto.sideEffectsBytes;
    } else if (command.kind === 'production.start') {
      const { origin: _origin, ...automaticTransaction } = fixtures.live.transaction;
      const transaction: ProductionTransaction = { ...automaticTransaction, transactionId: INSTANCE, commandId: command.commandId };
      const reservation: Reservation = { ...fixtures.live.reservation, ownerTransactionId: INSTANCE };
      const liveBytes = size({ [INSTANCE]: transaction }) + size({ [INSTANCE]: reservation }) + size([INSTANCE]) + auto.pathBytes;
      const terminal = { transaction: { ...transaction, completedTick: MAXIMUM, resultEventId: EVENT, state: 'Committed', phase: 'Done' },
        reservation: { ...reservation, state: 'committed' } };
      const event = { ...fixtures.event, payload: { transactionId: INSTANCE, recipeId: RECIPE, workerId: ENTITY } };
      // Reserve both the future live representation and its lossless terminal fallback.
      bytes += liveBytes + retainedRecordBytes(terminal, INSTANCE, [RECIPE, ...RESOURCE_IDS])
        + 2 * retainedRecordBytes(event, EVENT, [RECIPE]) + receiptBudget(command, INSTANCE, [EVENT]) + auto.sideEffectsBytes;
    } else if (command.kind === 'sect-economy.command') {
      const plan: DiscipleWorkPlan = { workerId: ENTITY, enabled: false, priorities: Array.from({ length: MAX_WORK_PRIORITIES }, () => ({ recipeId: RECIPE, targetStock: MAX_STOCK_TARGET })) };
      bytes += size(plan) + 1 + receiptBudget(command, null, [], true) + DIGITS + 2;
    } else unsupported.add(command.kind);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Pending obligations exceed safe byte range');
  }
  return { bytes, supported: unsupported.size === 0, unsupportedKinds: [...unsupported].sort() };
}
