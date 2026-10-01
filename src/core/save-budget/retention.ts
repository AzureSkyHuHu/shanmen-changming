import { emptyNavigation } from '../agents/navigation';
import type { ProductionTransaction, Reservation } from '../economy/types';
import { getHistoryArchiveUsage } from '../history/archive';
import { MAX_HISTORY_EXPANDED_CHARACTERS, MAX_HISTORY_EXPANDED_NODES, MAX_HISTORY_RECORDS_PER_TABLE, type HistoryArchive } from '../history/types';
import type { Command, CommandReceipt, DomainEvent } from '../kernel/contracts';
import { canonicalStringify } from '../kernel/serialization';
import { automaticJobByteBudget, retainedRecordBytes, type SaveBudgetMap } from './bounds';
import { canonicalUtf8ByteLength } from './canonical-bytes';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value as RecordValue : null;
}
function property(value: unknown, key: string): unknown {
  if (!record(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new TypeError('Save obligation inputs must be data-only');
  return descriptor?.value;
}
function values(value: unknown): unknown[] { return record(value) ? Object.values(value as RecordValue) : []; }

/** Existing manual jobs have future settlement obligations even when automatic work is off. */
export function manualProductionByteObligations(world: unknown, map: SaveBudgetMap): { bytes: number; archiveBytes: number; count: number } {
  const transactions = values(property(world, 'transactions')) as ProductionTransaction[];
  const reservations = record(property(world, 'reservations')) ?? {};
  const maximum = Number.MAX_SAFE_INTEGER;
  const eventId = `event:${maximum}`;
  const commandId = 'c'.repeat(128);
  const auto = automaticJobByteBudget(map);
  let bytes = 0; let archiveBytes = 0; let count = 0;
  for (const transaction of transactions) {
    if (transaction.state !== 'Running' && transaction.state !== 'Blocked') continue;
    const reservation = reservations[transaction.reservationId] as Reservation | undefined;
    if (!reservation) throw new TypeError('Live manual job lacks its settlement reservation');
    const terminal = {
      // Preserve accepted legacy extension fields and their actual escaped bytes.
      transaction: { ...transaction, completedTick: maximum, resultEventId: eventId, state: 'Cancelled', phase: 'Cancelled',
        navigation: emptyNavigation(), blockedReason: null },
      reservation: { ...reservation, state: 'committed' },
    };
    const event: DomainEvent = { eventId, tick: maximum, rootActionId: transaction.rootActionId, parentEventId: null,
      kind: 'production.cancelled', payload: { transactionId: transaction.transactionId, recipeId: transaction.recipeId, workerId: transaction.workerId } };
    const receipt: CommandReceipt = { commandId, fingerprint: canonicalStringify({ kind: 'production.cancel', payload: { transactionId: transaction.transactionId } }),
      result: { commandId, status: 'accepted', transactionId: transaction.transactionId, eventIds: [eventId], rejection: null } };
    // Full future path and fixed live width are deliberately additional to the current
    // representation. Terminal raw fallback retains unknown valid historical fields.
    const retained = retainedRecordBytes(terminal, transaction.transactionId, [transaction.recipeId, ...reservation.lines.map((line) => line.resourceId)])
      + retainedRecordBytes(event, eventId, [transaction.recipeId]) + retainedRecordBytes(receipt, commandId, [receipt.fingerprint]);
    archiveBytes += retained;
    bytes += auto.pathBytes + auto.fixedLiveBytes + auto.sideEffectsBytes + retained;
    count += 1;
  }
  if (!Number.isSafeInteger(bytes)) throw new RangeError('Manual settlement obligation exceeds safe byte range');
  return { bytes, archiveBytes, count };
}

export interface HistorySlotCounts { production: number; commandReceipts: number; events: number }
export interface HistorySlotAssessment {
  limitPerTable: number;
  current: HistorySlotCounts;
  reserved: HistorySlotCounts;
  /** Shared number of new auto jobs whose one durable cancellation+receipt can fit. */
  automaticAllowance: number;
  fits: boolean;
}
function count(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_HISTORY_RECORDS_PER_TABLE) {
    throw new RangeError('Invalid history row count');
  }
  return value;
}

/** Conservatively count live tails too, leaving the archive's finite row caps untouched. */
export function assessHistorySlots(world: unknown, liveAutomaticJobCount: number, manualLiveCount: number, pending: readonly Command[]): HistorySlotAssessment {
  const history = property(world, 'history');
  const events = property(world, 'events');
  const current: HistorySlotCounts = {
    production: count(property(property(history, 'production'), 'count')),
    commandReceipts: count(property(property(history, 'commandReceipts'), 'count')) + values(property(world, 'commandReceipts')).length,
    events: count(property(property(history, 'events'), 'count')) + (Array.isArray(events) ? events.length : 0),
  };
  const reserved: HistorySlotCounts = {
    production: manualLiveCount,
    commandReceipts: manualLiveCount + liveAutomaticJobCount,
    events: manualLiveCount + liveAutomaticJobCount,
  };
  for (const command of pending) {
    if (command.kind === 'production.start') { reserved.production += 1; reserved.events += 2; reserved.commandReceipts += 2; }
    else if (command.kind === 'inventory.discard') { reserved.events += 1; reserved.commandReceipts += 1; }
    else if (command.kind === 'production.cancel') { reserved.production += 1; reserved.events += 1; reserved.commandReceipts += 1; }
    else if (command.kind === 'sect-economy.command') reserved.commandReceipts += 1;
  }
  const room = {
    production: MAX_HISTORY_RECORDS_PER_TABLE - current.production - reserved.production,
    commandReceipts: MAX_HISTORY_RECORDS_PER_TABLE - current.commandReceipts - reserved.commandReceipts,
    events: MAX_HISTORY_RECORDS_PER_TABLE - current.events - reserved.events,
  };
  return { limitPerTable: MAX_HISTORY_RECORDS_PER_TABLE, current, reserved,
    automaticAllowance: Math.max(0, Math.min(room.commandReceipts, room.events)),
    fits: room.production >= 0 && room.commandReceipts >= 0 && room.events >= 0 };
}

export interface HistoryExpansionAssessment {
  characterLimit: number;
  nodeLimit: number;
  currentCharacters: number;
  currentNodes: number;
  reservedCharacters: number;
  reservedNodes: number;
  perNewAutomaticJob: number;
  automaticAllowance: number;
  fits: boolean;
}

/**
 * UTF-8 canonical bytes conservatively bound canonical UTF-16 characters AND JSON
 * value-node count. Add the codec's 32-node accounting surcharge per future row.
 * The intentionally loose node bound avoids decoding/rescanning historical pages.
 */
export function assessExpansionHeadroom(current: { expandedCharacters: number; expandedNodes: number },
  recordBytes: number, futureRows: number, perNewAutomaticRecordBytes: number): HistoryExpansionAssessment {
  for (const value of [current.expandedCharacters, current.expandedNodes, recordBytes, futureRows, perNewAutomaticRecordBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid archive expansion obligation');
  }
  const reservedCharacters = recordBytes;
  const reservedNodes = recordBytes + 32 * futureRows;
  const perNewAutomaticJob = perNewAutomaticRecordBytes + 64;
  if (!Number.isSafeInteger(reservedNodes) || !Number.isSafeInteger(perNewAutomaticJob)) throw new RangeError('Archive expansion obligation exceeds safe range');
  const characterRoom = MAX_HISTORY_EXPANDED_CHARACTERS - current.expandedCharacters - reservedCharacters;
  const nodeRoom = MAX_HISTORY_EXPANDED_NODES - current.expandedNodes - reservedNodes;
  return {
    characterLimit: MAX_HISTORY_EXPANDED_CHARACTERS, nodeLimit: MAX_HISTORY_EXPANDED_NODES,
    currentCharacters: current.expandedCharacters, currentNodes: current.expandedNodes,
    reservedCharacters, reservedNodes, perNewAutomaticJob,
    automaticAllowance: Math.max(0, Math.floor(Math.min(characterRoom, nodeRoom) / perNewAutomaticJob)),
    fits: characterRoom >= 0 && nodeRoom >= 0,
  };
}

export function assessHistoryExpansion(world: unknown, map: SaveBudgetMap, liveAutomaticJobCount: number,
  manualArchiveBytes: number, pendingBytes: number, slots: HistorySlotAssessment): HistoryExpansionAssessment {
  const history = property(world, 'history');
  const current = history === undefined ? { expandedCharacters: 0, expandedNodes: 0 }
    : getHistoryArchiveUsage(history as HistoryArchive);
  const tailEvents = property(world, 'events');
  const tails = [...values(property(world, 'commandReceipts')), ...(Array.isArray(tailEvents) ? tailEvents : [])];
  const tailBytes = tails.reduce<number>((sum, entry) => sum + canonicalUtf8ByteLength(entry), 0);
  const auto = automaticJobByteBudget(map);
  const perNewAutomaticRecordBytes = auto.pinAndEventBytes + auto.cancellationReceiptBytes;
  const recordBytes = tailBytes + liveAutomaticJobCount * perNewAutomaticRecordBytes + manualArchiveBytes + pendingBytes;
  const futureRows = tails.length + slots.reserved.production + slots.reserved.commandReceipts + slots.reserved.events;
  return assessExpansionHeadroom(current, recordBytes, futureRows, perNewAutomaticRecordBytes);
}
