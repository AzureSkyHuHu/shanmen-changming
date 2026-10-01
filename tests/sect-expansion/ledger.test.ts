import { describe, expect, it } from 'vitest';
import { SECT_RESOURCE_IDS, type SectResourceLine, type SectStock } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { createInventory } from '../../src/core/economy/inventory';
import { RESOURCE_IDS } from '../../src/core/economy/types';
import { commitLedgerReservation, consumeLedgerReservationPart, normalizeLedgerLines, releaseLedgerReservation, reserveLedgerResources, validateLedgerContext,
  type LedgerContext, type LedgerOperationResult, type LedgerReservationIdentity } from '../../src/core/economy/ledger-operations';
import { commitSectReservation, consumeSectConstructionCheckpoint, normalizeSectResourceLines, releaseSectReservation, reserveSectResources, sectReservationLines,
  validateSectLedgerContext, type SectLedgerContext, type SectLedgerResult } from '../../src/core/sect-expansion/ledger';

const a = { reservationId: 'reserve.a', ownerTransactionId: 'transaction.a' };
const b = { reservationId: 'reserve.b', ownerTransactionId: 'transaction.b' };
const resources = ['ore', 'bar'] as const;
type Resource = typeof resources[number];
function generic(): LedgerContext<Resource> {
  return { ledger: { ore: { owned: 20, reserved: 0, capacity: 20 }, bar: { owned: 0, reserved: 0, capacity: 20 } }, reservations: [] };
}
function accept<R extends string>(result: LedgerOperationResult<R>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.rejection.code);
  return result;
}
function accepted(result: SectLedgerResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.rejection.code);
  expect(validateSectLedgerContext(result.context)).toBe(true);
  return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// Funded arithmetic fixtures only; this suite does not claim a playable construction journey.
function context(): SectLedgerContext {
  const inventory = createInventory();
  for (const id of RESOURCE_IDS) inventory[id] = { resourceId: id, owned: 20, reserved: 0, capacity: 100 };
  const stock: SectStock = { ...createEmptySectStock(), 'spirit-stone': { owned: 20, reserved: 0, capacity: 99 }, 'basic-insight': { owned: 20, reserved: 0, capacity: 99 } };
  return { inventory, stock, reservations: [] };
}
const wood = (quantity: number): SectResourceLine => ({ ledger: 'base', resourceId: 'wood', quantity });
const spirit = (quantity: number): SectResourceLine => ({ ledger: 'sect', resourceId: 'spirit-stone', quantity });
const powder = (quantity: number): SectResourceLine => ({ ledger: 'sect', resourceId: 'wound-powder', quantity });
const amount = (lines: readonly SectResourceLine[], ledger: 'base' | 'sect', resourceId: string): number => lines.find(line => line.ledger === ledger && line.resourceId === resourceId)?.quantity ?? 0;
function conservation(initial: SectLedgerContext, current: SectLedgerContext): void {
  for (const [ledger, ids] of [['base', RESOURCE_IDS], ['sect', SECT_RESOURCE_IDS]] as const) {
    for (const resourceId of ids) {
      const start = ledger === 'base' ? initial.inventory[resourceId as typeof RESOURCE_IDS[number]] : initial.stock[resourceId as typeof SECT_RESOURCE_IDS[number]];
      const now = ledger === 'base' ? current.inventory[resourceId as typeof RESOURCE_IDS[number]] : current.stock[resourceId as typeof SECT_RESOURCE_IDS[number]];
      const consumed = current.reservations.reduce((total, claim) => total + amount(sectReservationLines(claim, 'consumed'), ledger, resourceId), 0);
      const remaining = current.reservations.reduce((total, claim) => total + amount(sectReservationLines(claim, 'remainingReservation'), ledger, resourceId), 0);
      expect(now.owned + consumed).toBe(start.owned);
      expect(now.reserved).toBe(start.reserved + remaining);
      expect(now.owned).toBeGreaterThanOrEqual(now.reserved);
      expect(now.owned).toBeLessThanOrEqual(now.capacity);
    }
  }
}

describe('finite generic ledger arithmetic, separate from World authority', () => {
  it('normalizes duplicates in the explicit resource order without changing source lines', () => {
    const lines = freeze([{ resourceId: 'bar' as const, quantity: 1 }, { resourceId: 'ore' as const, quantity: 2 }, { resourceId: 'ore' as const, quantity: 3 }]);
    expect(normalizeLedgerLines(resources, lines)).toEqual([{ resourceId: 'ore', quantity: 5 }, { resourceId: 'bar', quantity: 1 }]);
    expect(normalizeLedgerLines(resources, [])).toEqual([]);
    expect(normalizeLedgerLines(['ore', 'ore'], [])).toBeNull();
    expect(normalizeLedgerLines([], [])).toBeNull();
    expect(normalizeLedgerLines(resources, [{ resourceId: 'wood' as Resource, quantity: 1 }])).toBeNull();
    expect(lines).toHaveLength(3);
  });
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe line quantity %s', quantity => {
    expect(normalizeLedgerLines(resources, [{ resourceId: 'ore', quantity }])).toBeNull();
  });
  it('rejects duplicate addition overflow before a reservation changes', () => {
    const source = freeze(generic());
    const lines = [{ resourceId: 'ore' as const, quantity: Number.MAX_SAFE_INTEGER }, { resourceId: 'ore' as const, quantity: 1 }];
    expect(normalizeLedgerLines(resources, lines)).toBeNull();
    expect(reserveLedgerResources(resources, source, a, lines)).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESOURCE_LINE' } });
    expect(source.ledger.ore.reserved).toBe(0);
  });
  it.each([
    { owned: -1, reserved: 0, capacity: 20 }, { owned: 1, reserved: 2, capacity: 20 },
    { owned: 21, reserved: 0, capacity: 20 }, { owned: 1, reserved: 0.5, capacity: 20 },
    { owned: 1, reserved: 0, capacity: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects physically invalid source entries before even a no-op', entry => {
    const source = { ...generic(), ledger: { ...generic().ledger, ore: entry } };
    expect(validateLedgerContext(resources, source)).toBe(false);
    expect(reserveLedgerResources(resources, source, a, [])).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
  });
  it('rejects extra ledger entries instead of widening the explicit resource set', () => {
    const source = { ...generic(), ledger: { ...generic().ledger, wood: { owned: 1, reserved: 0, capacity: 1 } } };
    expect(validateLedgerContext(resources, source)).toBe(false);
  });
  it('rejects line, array and permitted-set accessors without executing them', () => {
    let reads = 0;
    const line = { resourceId: 'ore' as const, quantity: 1 };
    Object.defineProperty(line, 'quantity', { enumerable: true, get() { reads++; return 1; } });
    expect(normalizeLedgerLines(resources, [line])).toBeNull();
    const lines = [{ resourceId: 'ore' as const, quantity: 1 }];
    Object.defineProperty(lines, '0', { enumerable: true, get() { reads++; return line; } });
    expect(normalizeLedgerLines(resources, lines)).toBeNull();
    const permitted: Resource[] = ['ore', 'bar'];
    Object.defineProperty(permitted, '0', { enumerable: true, get() { reads++; return 'ore'; } });
    expect(normalizeLedgerLines(permitted, [])).toBeNull();
    expect(reads).toBe(0);
  });
  it('rejects identity, source and entry accessors before reading them', () => {
    let reads = 0;
    const identity = { ...a };
    Object.defineProperty(identity, 'ownerTransactionId', { enumerable: true, get() { reads++; return a.ownerTransactionId; } });
    expect(reserveLedgerResources(resources, generic(), identity, [])).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESERVATION' } });
    const source = generic();
    Object.defineProperty(source, 'ledger', { enumerable: true, get() { reads++; return generic().ledger; } });
    expect(reserveLedgerResources(resources, source, a, [])).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    const entrySource = generic();
    Object.defineProperty(entrySource.ledger.ore, 'owned', { enumerable: true, get() { reads++; return 20; } });
    expect(validateLedgerContext(resources, entrySource)).toBe(false);
    expect(reads).toBe(0);
  });
  it('rejects claim, checkpoint and settlement accessors even for an exact retry', () => {
    let reads = 0;
    const reserved = accept(reserveLedgerResources(resources, generic(), a, [{ resourceId: 'ore', quantity: 5 }]));
    const claim = { ...reserved.reservation };
    Object.defineProperty(claim, 'remainingReservation', { enumerable: true, get() { reads++; return reserved.reservation.remainingReservation; } });
    expect(releaseLedgerReservation(resources, { ...reserved.context, reservations: [claim] }, a, 'cancel')).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    const checkpoint = { checkpointId: 'half', lines: [{ resourceId: 'ore' as const, quantity: 3 }] };
    Object.defineProperty(checkpoint, 'lines', { enumerable: true, get() { reads++; return []; } });
    const paid = { ...reserved.reservation, checkpoints: [checkpoint] };
    expect(consumeLedgerReservationPart(resources, { ...reserved.context, reservations: [paid] }, a, 'half', [])).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    const committed = accept(commitLedgerReservation(resources, reserved.context, a, 'finish', []));
    const settlement = { kind: 'committed' as const, operationId: 'finish', outputs: [] };
    Object.defineProperty(settlement, 'outputs', { enumerable: true, get() { reads++; return []; } });
    expect(commitLedgerReservation(resources, { ...committed.context, reservations: [{ ...committed.reservation, settlement }] }, a, 'finish', [])).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    expect(reads).toBe(0);
  });
  it('rejects nonplain identities, sparse arrays and unknown fields rather than interpreting flags', () => {
    const nonplain = { ...a }; Object.setPrototypeOf(nonplain, null);
    expect(reserveLedgerResources(resources, generic(), nonplain, [])).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESERVATION' } });
    const identity = { ...a, paid: true };
    expect(reserveLedgerResources(resources, generic(), identity, [])).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESERVATION' } });
    const lines = [{ resourceId: 'ore' as const, quantity: 1, paid: true }];
    expect(normalizeLedgerLines(resources, lines)).toBeNull();
    const sparse = [{ resourceId: 'ore' as const, quantity: 1 }]; delete sparse[0];
    expect(normalizeLedgerLines(resources, sparse)).toBeNull();
    const reserved = accept(reserveLedgerResources(resources, generic(), a, [{ resourceId: 'ore', quantity: 5 }]));
    const source = { ...reserved.context, reservations: [{ ...reserved.reservation, paid: true }] };
    expect(releaseLedgerReservation(resources, source, a, 'cancel')).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
  });
  it('binds one reservation and normalized body to one transaction identity', () => {
    const source = freeze(generic());
    const first = accept(reserveLedgerResources(resources, source, a, [{ resourceId: 'ore', quantity: 5 }]));
    const repeat = accept(reserveLedgerResources(resources, first.context, a, [{ resourceId: 'ore', quantity: 2 }, { resourceId: 'ore', quantity: 3 }]));
    expect(repeat.repeated).toBe(true); expect(repeat.context).toBe(first.context);
    for (const identity of [{ ...a, ownerTransactionId: b.ownerTransactionId }, { ...a, reservationId: b.reservationId }]) {
      expect(reserveLedgerResources(resources, first.context, identity, [{ resourceId: 'ore', quantity: 5 }])).toMatchObject({ ok: false, rejection: { code: 'IDENTITY_CONFLICT' } });
    }
    expect(reserveLedgerResources(resources, first.context, a, [{ resourceId: 'ore', quantity: 6 }])).toMatchObject({ ok: false, rejection: { code: 'IDENTITY_CONFLICT' } });
    expect(source.ledger.ore).toEqual({ owned: 20, reserved: 0, capacity: 20 });
  });
  it('takes amounts only from the owned stored claim, rejecting wrong owners and over-consumption', () => {
    const reserved = accept(reserveLedgerResources(resources, generic(), a, [{ resourceId: 'ore', quantity: 5 }]));
    const source = freeze(reserved.context);
    const wrongOwner = { ...a, ownerTransactionId: b.ownerTransactionId };
    for (const result of [releaseLedgerReservation(resources, source, wrongOwner, 'cancel'), commitLedgerReservation(resources, source, wrongOwner, 'finish', []),
      consumeLedgerReservationPart(resources, source, wrongOwner, 'half', [{ resourceId: 'ore', quantity: 1 }]),
      consumeLedgerReservationPart(resources, source, a, 'half', [{ resourceId: 'ore', quantity: 6 }])]) expect(result).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESERVATION' } });
    expect(source.ledger.ore.reserved).toBe(5);
  });
  it('binds checkpoint identity to its exact normalized payment and preserves past retries', () => {
    const reserved = accept(reserveLedgerResources(resources, generic(), a, [{ resourceId: 'ore', quantity: 5 }]));
    const half = accept(consumeLedgerReservationPart(resources, reserved.context, a, 'half', [{ resourceId: 'ore', quantity: 3 }]));
    expect(half.reservation.consumed).toEqual([{ resourceId: 'ore', quantity: 3 }]);
    expect(half.reservation.remainingReservation).toEqual([{ resourceId: 'ore', quantity: 2 }]);
    const repeat = accept(consumeLedgerReservationPart(resources, half.context, a, 'half', [{ resourceId: 'ore', quantity: 1 }, { resourceId: 'ore', quantity: 2 }]));
    expect(repeat.context).toBe(half.context);
    expect(consumeLedgerReservationPart(resources, half.context, a, 'half', [{ resourceId: 'ore', quantity: 2 }])).toMatchObject({ ok: false, rejection: { code: 'IDENTITY_CONFLICT' } });
    const cancelled = accept(releaseLedgerReservation(resources, half.context, a, 'cancel'));
    expect(accept(consumeLedgerReservationPart(resources, cancelled.context, a, 'half', [{ resourceId: 'ore', quantity: 3 }])).context).toBe(cancelled.context);
    expect(cancelled.context.ledger.ore).toEqual({ owned: 17, reserved: 0, capacity: 20 });
  });
  it('does not allow forged remaining quantities or settlement flags to pass arithmetic validation', () => {
    const reserved = accept(reserveLedgerResources(resources, generic(), a, [{ resourceId: 'ore', quantity: 5 }]));
    for (const claim of [
      { ...reserved.reservation, remainingReservation: [{ resourceId: 'ore' as const, quantity: 6 }] },
      { ...reserved.reservation, settlement: { kind: 'released' as const, operationId: 'cancel' } },
      { ...reserved.reservation, consumed: [{ resourceId: 'ore' as const, quantity: 1 }] },
    ]) {
      const malformed = { ...reserved.context, reservations: [claim] };
      expect(validateLedgerContext(resources, malformed)).toBe(false);
      expect(releaseLedgerReservation(resources, malformed, a, 'cancel')).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    }
  });
  it('respects other tracked and external reservation totals', () => {
    const source = generic(); const external = { ...source, ledger: { ...source.ledger, ore: { ...source.ledger.ore, reserved: 12 } } };
    const first = accept(reserveLedgerResources(resources, external, a, [{ resourceId: 'ore', quantity: 5 }]));
    expect(reserveLedgerResources(resources, first.context, b, [{ resourceId: 'ore', quantity: 4 }])).toMatchObject({ ok: false, rejection: { code: 'INSUFFICIENT_INVENTORY' } });
    const second = accept(reserveLedgerResources(resources, first.context, b, [{ resourceId: 'ore', quantity: 3 }]));
    const cancelled = accept(releaseLedgerReservation(resources, second.context, a, 'cancel'));
    expect(cancelled.context.ledger.ore.reserved).toBe(15);
    expect(releaseLedgerReservation(resources, cancelled.context, { ...b, ownerTransactionId: a.ownerTransactionId }, 'cancel')).toMatchObject({ ok: false });
  });
  it('checks same-resource capacity after debit and keeps competing reservations intact', () => {
    const first = accept(reserveLedgerResources(resources, generic(), a, [{ resourceId: 'ore', quantity: 5 }]));
    const second = accept(reserveLedgerResources(resources, first.context, b, [{ resourceId: 'ore', quantity: 10 }]));
    const source = freeze(second.context);
    expect(commitLedgerReservation(resources, source, a, 'finish', [{ resourceId: 'ore', quantity: 6 }])).toMatchObject({ ok: false, rejection: { code: 'CAPACITY_EXCEEDED' } });
    const committed = accept(commitLedgerReservation(resources, source, a, 'finish', [{ resourceId: 'ore', quantity: 5 }]));
    expect(committed.context.ledger.ore).toEqual({ owned: 20, reserved: 10, capacity: 20 });
    expect(source.ledger.ore.reserved).toBe(15);
  });
  it('checks output overflow and does not return a partly debited candidate', () => {
    const initial = generic(); const source = { ...initial, ledger: { ...initial.ledger, ore: { owned: Number.MAX_SAFE_INTEGER, reserved: 0, capacity: Number.MAX_SAFE_INTEGER } } };
    const reserved = accept(reserveLedgerResources(resources, source, a, []));
    expect(commitLedgerReservation(resources, reserved.context, a, 'finish', [{ resourceId: 'ore', quantity: 1 }])).toMatchObject({ ok: false, rejection: { code: 'CAPACITY_EXCEEDED' } });
    expect(reserved.context.ledger.ore.owned).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('binds final operation kind, identity and output body, even on terminal repeats', () => {
    const reserved = accept(reserveLedgerResources(resources, generic(), a, [{ resourceId: 'ore', quantity: 5 }]));
    const partial = accept(consumeLedgerReservationPart(resources, reserved.context, a, 'half', [{ resourceId: 'ore', quantity: 3 }]));
    for (const result of [commitLedgerReservation(resources, partial.context, a, 'half', []), releaseLedgerReservation(resources, partial.context, a, 'half')]) expect(result).toMatchObject({ ok: false, rejection: { code: 'IDENTITY_CONFLICT' } });
    const committed = accept(commitLedgerReservation(resources, partial.context, a, 'finish', [{ resourceId: 'bar', quantity: 2 }]));
    expect(committed.context.ledger.ore.owned).toBe(15);
    expect(committed.reservation.consumed).toEqual([{ resourceId: 'ore', quantity: 5 }]);
    expect(accept(commitLedgerReservation(resources, committed.context, a, 'finish', [{ resourceId: 'bar', quantity: 1 }, { resourceId: 'bar', quantity: 1 }])).context).toBe(committed.context);
    expect(commitLedgerReservation(resources, committed.context, a, 'finish', [{ resourceId: 'bar', quantity: 3 }])).toMatchObject({ ok: false, rejection: { code: 'IDENTITY_CONFLICT' } });
    expect(commitLedgerReservation(resources, committed.context, a, 'different', [{ resourceId: 'bar', quantity: 2 }])).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
    expect(releaseLedgerReservation(resources, committed.context, a, 'finish')).toMatchObject({ ok: false, rejection: { code: 'IDENTITY_CONFLICT' } });
    expect(releaseLedgerReservation(resources, committed.context, a, 'cancel')).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
  });
});

describe('additive two-ledger candidates', () => {
  it('canonicalizes tagged duplicates in base-then-sect order and rejects unknown ledger/resource pairs', () => {
    const lines = freeze([spirit(1), wood(2), spirit(2), { ledger: 'base' as const, resourceId: 'plank' as const, quantity: 1 }, wood(3)]);
    expect(normalizeSectResourceLines(lines)).toEqual([wood(5), { ledger: 'base', resourceId: 'plank', quantity: 1 }, spirit(3)]);
    for (const line of [
      { ledger: 'unknown', resourceId: 'wood', quantity: 1 }, { ledger: 'base', resourceId: 'spirit-stone', quantity: 1 },
      { ledger: 'sect', resourceId: 'wood', quantity: 1 }, { ledger: 'sect', resourceId: '__proto__', quantity: 1 },
    ]) {
      expect(normalizeSectResourceLines([line as SectResourceLine])).toBeNull();
      expect(reserveSectResources(context(), a, [line as SectResourceLine], 'on-completion')).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESOURCE_LINE' } });
    }
  });
  it('rejects tagged accessors and unknown fields without reading or silently dropping them', () => {
    let reads = 0;
    const line = wood(1);
    Object.defineProperty(line, 'ledger', { enumerable: true, get() { reads++; return 'base'; } });
    expect(normalizeSectResourceLines([line])).toBeNull();
    expect(reserveSectResources(context(), a, [line], 'on-completion')).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESOURCE_LINE' } });
    const unknownLine = { ...wood(1), paid: true };
    expect(normalizeSectResourceLines([unknownLine])).toBeNull();
    const identity = { ...a };
    Object.defineProperty(identity, 'reservationId', { enumerable: true, get() { reads++; return a.reservationId; } });
    expect(reserveSectResources(context(), identity, [wood(1)], 'on-completion')).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESERVATION' } });
    expect(reads).toBe(0);
  });
  it('rejects paired source/claim accessors and unknown-field claims before both-ledger arithmetic', () => {
    let reads = 0;
    const reserved = accepted(reserveSectResources(context(), a, [wood(5), spirit(3)], 'construction-checkpoints'));
    const source = { ...reserved.context };
    Object.defineProperty(source, 'inventory', { enumerable: true, get() { reads++; return reserved.context.inventory; } });
    expect(releaseSectReservation(source, a, 'cancel')).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    const claim = { ...reserved.reservation };
    Object.defineProperty(claim, 'base', { enumerable: true, get() { reads++; return reserved.reservation.base; } });
    expect(consumeSectConstructionCheckpoint({ ...reserved.context, reservations: [claim] }, a, 'half')).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    const nested = { ...reserved.reservation.sect };
    Object.defineProperty(nested, 'ownerTransactionId', { enumerable: true, get() { reads++; return a.ownerTransactionId; } });
    expect(releaseSectReservation({ ...reserved.context, reservations: [{ ...reserved.reservation, sect: nested }] }, a, 'cancel')).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    const unknown = { ...reserved.reservation, paid: true };
    expect(releaseSectReservation({ ...reserved.context, reservations: [unknown] }, a, 'cancel')).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    expect(reads).toBe(0);
  });
  it('rolls back both ledgers when the second reservation fails', () => {
    const source = freeze(context()); const before = structuredClone(source);
    expect(reserveSectResources(source, a, [wood(4), spirit(21)], 'on-completion')).toMatchObject({ ok: false, rejection: { code: 'INSUFFICIENT_INVENTORY', ledger: 'sect', resourceId: 'spirit-stone' } });
    expect(source).toEqual(before);
    expect(reserveSectResources(source, a, [wood(21), spirit(4)], 'on-completion')).toMatchObject({ ok: false, rejection: { code: 'INSUFFICIENT_INVENTORY', ledger: 'base' } });
    expect(source).toEqual(before);
  });
  it('rolls back base debit/output when the second ledger output is full and remains cancellable', () => {
    const initial = context(); const full = { ...initial, stock: { ...initial.stock, 'wound-powder': { owned: 99, reserved: 0, capacity: 99 as const } } };
    const reserved = accepted(reserveSectResources(full, a, [wood(4), spirit(2)], 'on-completion'));
    const source = freeze(reserved.context); const before = structuredClone(source);
    expect(commitSectReservation(source, a, 'finish', [{ ledger: 'base', resourceId: 'stone', quantity: 3 }, powder(1)])).toMatchObject({ ok: false, rejection: { code: 'CAPACITY_EXCEEDED', ledger: 'sect' } });
    expect(source).toEqual(before);
    const cancelled = accepted(releaseSectReservation(source, a, 'cancel'));
    expect(cancelled.context.inventory.wood).toEqual(full.inventory.wood);
    expect(cancelled.context.stock).toEqual(full.stock);
  });
  it('rolls back sect spending/output when base output capacity fails', () => {
    const initial = context(); const full = { ...initial, inventory: { ...initial.inventory, stone: { ...initial.inventory.stone, owned: 100 } } };
    const reserved = accepted(reserveSectResources(full, a, [wood(4), spirit(2)], 'on-completion'));
    const source = freeze(reserved.context); const before = structuredClone(source);
    expect(commitSectReservation(source, a, 'finish', [{ ledger: 'base', resourceId: 'stone', quantity: 1 }, powder(1)])).toMatchObject({ ok: false, rejection: { code: 'CAPACITY_EXCEEDED', ledger: 'base' } });
    expect(source).toEqual(before);
  });
  it('reserves exactly the remaining available materials across competing owners', () => {
    const initial = context(); const source = { ...initial, inventory: { ...initial.inventory, wood: { ...initial.inventory.wood, owned: 10 } } };
    const first = accepted(reserveSectResources(source, a, [wood(6), spirit(12)], 'on-completion'));
    expect(reserveSectResources(first.context, b, [wood(5), spirit(1)], 'on-completion')).toMatchObject({ ok: false });
    expect(reserveSectResources(first.context, b, [wood(4), spirit(9)], 'on-completion')).toMatchObject({ ok: false });
    const second = accepted(reserveSectResources(first.context, b, [wood(4), spirit(8)], 'on-completion'));
    const released = accepted(releaseSectReservation(second.context, a, 'cancel.a'));
    expect(released.context.inventory.wood.reserved).toBe(4);
    expect(released.context.stock['spirit-stone'].reserved).toBe(8);
    expect(releaseSectReservation(released.context, { ...b, ownerTransactionId: a.ownerTransactionId }, 'cancel.b')).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESERVATION' } });
  });
  it('allows untracked legacy base reservations without releasing them or duplicating base authority', () => {
    const initial = context(); const source = { ...initial, inventory: { ...initial.inventory, wood: { ...initial.inventory.wood, reserved: 12 } } };
    const reserved = accepted(reserveSectResources(source, a, [wood(5)], 'on-completion'));
    const released = accepted(releaseSectReservation(reserved.context, a, 'cancel'));
    expect(released.context.inventory.wood.reserved).toBe(12);
    expect(Object.keys(released.context.stock)).toEqual([...SECT_RESOURCE_IDS]);
    expect(Object.keys(released.context.inventory)).toEqual([...RESOURCE_IDS]);
    expect(released.context.reservations[0]).not.toHaveProperty('inventory');
  });
  it('rejects identity and policy/body conflicts before any two-ledger mutation', () => {
    const first = accepted(reserveSectResources(context(), a, [wood(5), spirit(3)], 'construction-checkpoints'));
    const source = freeze(first.context);
    const repeat = accepted(reserveSectResources(source, a, [spirit(1), wood(2), spirit(2), wood(3)], 'construction-checkpoints'));
    expect(repeat.context).toBe(source); expect(repeat.repeated).toBe(true);
    for (const result of [reserveSectResources(source, a, [wood(5), spirit(3)], 'on-completion'), reserveSectResources(source, a, [wood(6), spirit(3)], 'construction-checkpoints'),
      reserveSectResources(source, { ...a, ownerTransactionId: b.ownerTransactionId }, [wood(5), spirit(3)], 'construction-checkpoints'),
      reserveSectResources(source, { ...a, reservationId: b.reservationId }, [wood(5), spirit(3)], 'construction-checkpoints')]) expect(result).toMatchObject({ ok: false, rejection: { code: 'IDENTITY_CONFLICT' } });
  });
  it('cancels before the first checkpoint without consuming or recreating the reservation', () => {
    const initial = context(); const reserved = accepted(reserveSectResources(initial, a, [wood(5), spirit(3)], 'construction-checkpoints'));
    const cancelled = accepted(releaseSectReservation(reserved.context, a, 'cancel'));
    expect(cancelled.context.inventory).toEqual(initial.inventory); expect(cancelled.context.stock).toEqual(initial.stock);
    const repeat = accepted(reserveSectResources(cancelled.context, a, [wood(5), spirit(3)], 'construction-checkpoints'));
    expect(repeat.context).toBe(cancelled.context); expect(repeat.reservation.base.settlement?.kind).toBe('released');
    expect(consumeSectConstructionCheckpoint(cancelled.context, a, 'half')).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
    conservation(initial, cancelled.context);
  });
  it('pays ceil-half of normalized costs, cancels only the remainder, and preserves both histories across JSON', () => {
    const initial = freeze(context());
    const reserved = accepted(reserveSectResources(initial, a, [wood(2), spirit(1), wood(3), spirit(2)], 'construction-checkpoints'));
    const half = accepted(consumeSectConstructionCheckpoint(reserved.context, a, 'half'));
    expect(sectReservationLines(half.reservation, 'consumed')).toEqual([wood(3), spirit(2)]);
    expect(sectReservationLines(half.reservation, 'remainingReservation')).toEqual([wood(2), spirit(1)]);
    conservation(initial, half.context);
    const saved = JSON.parse(JSON.stringify(half.context)) as SectLedgerContext;
    const repeatedHalf = accepted(consumeSectConstructionCheckpoint(saved, a, 'half'));
    expect(repeatedHalf.context).toBe(saved);
    const cancelled = accepted(releaseSectReservation(saved, a, 'cancel'));
    expect(cancelled.context.inventory.wood).toMatchObject({ owned: 17, reserved: 0 });
    expect(cancelled.context.stock['spirit-stone']).toMatchObject({ owned: 18, reserved: 0 });
    expect(sectReservationLines(cancelled.reservation, 'consumed')).toEqual([wood(3), spirit(2)]);
    expect(sectReservationLines(cancelled.reservation, 'remainingReservation')).toEqual([]);
    conservation(initial, cancelled.context);
    expect(accepted(releaseSectReservation(cancelled.context, a, 'cancel')).context).toBe(cancelled.context);
    expect(accepted(consumeSectConstructionCheckpoint(cancelled.context, a, 'half')).context).toBe(cancelled.context);
    expect(releaseSectReservation(cancelled.context, a, 'different')).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
    expect(consumeSectConstructionCheckpoint(cancelled.context, a, 'remainder')).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
  });
  it('conserves both ledgers through competing checkpoints, cancel, completion and every exact retry', () => {
    const initial = freeze(context());
    let current = accepted(reserveSectResources(initial, a, [wood(5), spirit(3)], 'construction-checkpoints')).context;
    current = accepted(reserveSectResources(current, b, [wood(7), spirit(5)], 'construction-checkpoints')).context;
    conservation(initial, current);
    for (const identity of [a, b]) {
      current = accepted(consumeSectConstructionCheckpoint(current, identity, 'half')).context;
      conservation(initial, current);
      expect(accepted(consumeSectConstructionCheckpoint(current, identity, 'half')).context).toBe(current);
    }
    current = accepted(releaseSectReservation(current, a, 'cancel.a')).context;
    conservation(initial, current);
    expect(commitSectReservation(current, b, 'finish.b', [])).toMatchObject({ ok: false, rejection: { code: 'INVALID_CHECKPOINT' } });
    current = accepted(consumeSectConstructionCheckpoint(current, b, 'remainder')).context;
    conservation(initial, current);
    expect(accepted(consumeSectConstructionCheckpoint(current, b, 'remainder')).context).toBe(current);
    current = accepted(commitSectReservation(current, b, 'finish.b', [])).context;
    conservation(initial, current);
    expect(accepted(commitSectReservation(current, b, 'finish.b', [])).context).toBe(current);
    expect(accepted(consumeSectConstructionCheckpoint(current, b, 'half')).context).toBe(current);
    expect(accepted(consumeSectConstructionCheckpoint(current, b, 'remainder')).context).toBe(current);
    expect(releaseSectReservation(current, b, 'cancel.b')).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
    expect(current.inventory.wood).toMatchObject({ owned: 10, reserved: 0 });
    expect(current.stock['spirit-stone']).toMatchObject({ owned: 13, reserved: 0 });
  });
  it('drops zero remainder lines but records the exact second checkpoint', () => {
    const initial = context(); const reserved = accepted(reserveSectResources(initial, a, [wood(1), spirit(1)], 'construction-checkpoints'));
    expect(consumeSectConstructionCheckpoint(reserved.context, a, 'remainder')).toMatchObject({ ok: false, rejection: { code: 'INVALID_CHECKPOINT' } });
    const half = accepted(consumeSectConstructionCheckpoint(reserved.context, a, 'half'));
    expect(sectReservationLines(half.reservation, 'remainingReservation')).toEqual([]);
    const remainder = accepted(consumeSectConstructionCheckpoint(half.context, a, 'remainder'));
    expect(remainder.reservation.base.checkpoints[1]).toEqual({ checkpointId: 'construction.remainder', lines: [] });
    expect(remainder.reservation.sect.checkpoints[1]).toEqual({ checkpointId: 'construction.remainder', lines: [] });
    const committed = accepted(commitSectReservation(remainder.context, a, 'finish', []));
    conservation(initial, committed.context);
    expect(commitSectReservation(committed.context, a, 'finish', [wood(1)])).toMatchObject({ ok: false });
  });
  it('computes the two halves at the safe-integer maximum without cost-plus-one overflow', () => {
    const initial = context(); const maximum = Number.MAX_SAFE_INTEGER;
    const source = { ...initial, inventory: { ...initial.inventory, wood: { resourceId: 'wood' as const, owned: maximum, reserved: 0, capacity: maximum } } };
    const reserved = accepted(reserveSectResources(source, a, [wood(maximum)], 'construction-checkpoints'));
    const half = accepted(consumeSectConstructionCheckpoint(reserved.context, a, 'half'));
    expect(sectReservationLines(half.reservation, 'consumed')).toEqual([wood(4503599627370496)]);
    expect(sectReservationLines(half.reservation, 'remainingReservation')).toEqual([wood(4503599627370495)]);
    const remainder = accepted(consumeSectConstructionCheckpoint(half.context, a, 'remainder'));
    const committed = accepted(commitSectReservation(remainder.context, a, 'finish', []));
    expect(committed.context.inventory.wood).toMatchObject({ owned: 0, reserved: 0 });
    expect(sectReservationLines(committed.reservation, 'consumed')).toEqual([wood(maximum)]);
  });
  it('rejects nonconstruction checkpoints and preserves exact production commit/cancel behavior', () => {
    const reserved = accepted(reserveSectResources(context(), a, [wood(5), spirit(3)], 'on-completion'));
    expect(consumeSectConstructionCheckpoint(reserved.context, a, 'half')).toMatchObject({ ok: false, rejection: { code: 'INVALID_CHECKPOINT' } });
    const committed = accepted(commitSectReservation(reserved.context, a, 'finish', [powder(2)]));
    expect(committed.context.inventory.wood.owned).toBe(15); expect(committed.context.stock['spirit-stone'].owned).toBe(17);
    expect(committed.context.stock['wound-powder'].owned).toBe(2);
    expect(accepted(commitSectReservation(committed.context, a, 'finish', [powder(1), powder(1)])).context).toBe(committed.context);
    expect(commitSectReservation(committed.context, a, 'finish', [powder(3)])).toMatchObject({ ok: false, rejection: { code: 'IDENTITY_CONFLICT' } });
    expect(commitSectReservation(committed.context, a, 'different', [powder(2)])).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
    expect(releaseSectReservation(committed.context, a, 'cancel')).toMatchObject({ ok: false, rejection: { code: 'TRANSACTION_FINISHED' } });
  });
  it('allows same-resource sect output at capacity only after its own inputs are debited', () => {
    const initial = context(); const full = { ...initial, stock: { ...initial.stock, 'spirit-stone': { owned: 99, reserved: 0, capacity: 99 as const } } };
    const first = accepted(reserveSectResources(full, a, [wood(2), spirit(5)], 'on-completion'));
    const second = accepted(reserveSectResources(first.context, b, [spirit(94)], 'on-completion'));
    const source = freeze(second.context);
    expect(commitSectReservation(source, a, 'finish', [spirit(6)])).toMatchObject({ ok: false, rejection: { code: 'CAPACITY_EXCEEDED', ledger: 'sect' } });
    const committed = accepted(commitSectReservation(source, a, 'finish', [spirit(5)]));
    expect(committed.context.stock['spirit-stone']).toEqual({ owned: 99, reserved: 94, capacity: 99 });
    expect(source.stock['spirit-stone'].reserved).toBe(99);
  });
  it('rejects malformed or mismatched paired claims rather than accepting a bare paid flag', () => {
    const reserved = accepted(reserveSectResources(context(), a, [wood(5), spirit(3)], 'construction-checkpoints'));
    const claim = reserved.reservation;
    const badClaims = [
      { ...claim, ownerTransactionId: b.ownerTransactionId },
      { ...claim, sect: { ...claim.sect, ownerTransactionId: b.ownerTransactionId } },
      { ...claim, base: { ...claim.base, remainingReservation: [{ resourceId: 'wood' as const, quantity: 4 }] } },
      { ...claim, sect: { ...claim.sect, settlement: { kind: 'released' as const, operationId: 'cancel' } } },
    ];
    for (const bad of badClaims) {
      const source = freeze({ ...reserved.context, reservations: [bad] });
      expect(validateSectLedgerContext(source)).toBe(false);
      for (const result of [releaseSectReservation(source, a, 'cancel'), consumeSectConstructionCheckpoint(source, a, 'half'), commitSectReservation(source, a, 'finish', [])]) expect(result).toMatchObject({ ok: false, rejection: { code: 'INVALID_LEDGER' } });
    }
  });
  it('requires exact paired checkpoint bodies and fully accounted sect reservations', () => {
    const reserved = accepted(reserveSectResources(context(), a, [wood(5), spirit(3)], 'construction-checkpoints'));
    const half = accepted(consumeSectConstructionCheckpoint(reserved.context, a, 'half'));
    const malformed = { ...half.context, reservations: [{ ...half.reservation, sect: { ...half.reservation.sect, checkpoints: [{ checkpointId: 'other', lines: [{ resourceId: 'spirit-stone' as const, quantity: 2 }] }] } }] };
    expect(validateSectLedgerContext(malformed)).toBe(false);
    const stray = context(); const stock = { ...stray.stock, 'wound-powder': { owned: 1, reserved: 1, capacity: 99 as const } };
    expect(validateSectLedgerContext({ ...stray, stock })).toBe(false);
    expect(validateSectLedgerContext({ ...stray, stock: { ...stray.stock, wood: { owned: 1, reserved: 0, capacity: 99 } } as SectStock })).toBe(false);
  });
  it('does not let identity-shaped caller fields replace stored unpaid quantities', () => {
    const first = accepted(reserveSectResources(context(), a, [wood(5), spirit(3)], 'construction-checkpoints'));
    const second = accepted(reserveSectResources(first.context, b, [wood(6), spirit(4)], 'on-completion'));
    const half = accepted(consumeSectConstructionCheckpoint(second.context, a, 'half'));
    const misleading = { ...a, remainingReservation: [wood(11), spirit(7)], state: 'reserved' } as LedgerReservationIdentity;
    expect(releaseSectReservation(half.context, misleading, 'cancel.a')).toMatchObject({ ok: false, rejection: { code: 'INVALID_RESERVATION' } });
    const released = accepted(releaseSectReservation(half.context, a, 'cancel.a'));
    expect(released.context.inventory.wood).toMatchObject({ owned: 17, reserved: 6 });
    expect(released.context.stock['spirit-stone']).toMatchObject({ owned: 18, reserved: 4 });
    expect(released.context.reservations[1]).toBe(half.context.reservations[1]);
  });
});
