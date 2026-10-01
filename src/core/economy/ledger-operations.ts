import { isNonNegativeInteger } from '../kernel/numeric';

export interface LedgerLine<R extends string> { readonly resourceId: R; readonly quantity: number }
export interface LedgerBalance { readonly owned: number; readonly reserved: number; readonly capacity: number }
export interface LedgerReservationIdentity { readonly reservationId: string; readonly ownerTransactionId: string }
export interface LedgerCheckpoint<R extends string> { readonly checkpointId: string; readonly lines: readonly LedgerLine<R>[] }
export type LedgerSettlement<R extends string> =
  | { readonly kind: 'committed'; readonly operationId: string; readonly outputs: readonly LedgerLine<R>[] }
  | { readonly kind: 'released'; readonly operationId: string };
export interface LedgerClaim<R extends string> extends LedgerReservationIdentity {
  readonly lines: readonly LedgerLine<R>[];
  readonly consumed: readonly LedgerLine<R>[];
  readonly remainingReservation: readonly LedgerLine<R>[];
  readonly checkpoints: readonly LedgerCheckpoint<R>[];
  readonly settlement: LedgerSettlement<R> | null;
}
export interface LedgerContext<R extends string, E extends LedgerBalance = LedgerBalance> {
  readonly ledger: Readonly<Record<R, E>>;
  readonly reservations: readonly LedgerClaim<R>[];
}
export type LedgerRejectionCode = 'INVALID_RESOURCE_LINE' | 'INVALID_LEDGER' | 'INVALID_RESERVATION' | 'IDENTITY_CONFLICT'
  | 'INSUFFICIENT_INVENTORY' | 'CAPACITY_EXCEEDED' | 'TRANSACTION_FINISHED';
export interface LedgerRejection<R extends string> { readonly code: LedgerRejectionCode; readonly resourceId?: R }
export type LedgerOperationResult<R extends string, E extends LedgerBalance = LedgerBalance> =
  | { readonly ok: true; readonly context: LedgerContext<R, E>; readonly reservation: LedgerClaim<R>; readonly repeated: boolean }
  | { readonly ok: false; readonly rejection: LedgerRejection<R> };

/** Descriptor-only guards preserve caller types and never evaluate an own accessor. */
export function isLedgerDataRecord(value: unknown, keys?: readonly string[]): boolean {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (keys && (ownKeys.length !== keys.length || !keys.every(key => Object.hasOwn(value, key)))) return false;
  return ownKeys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}
export function isLedgerDataArray(value: unknown): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return false;
  return keys.every(key => {
    if (key === 'length') return true;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}
const identityString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const isLedgerReservationIdentity = (value: LedgerReservationIdentity): boolean => isLedgerDataRecord(value, ['reservationId', 'ownerTransactionId'])
  && identityString(value.reservationId) && identityString(value.ownerTransactionId);
const validResources = <R extends string>(resources: readonly R[]): boolean => isLedgerDataArray(resources) && resources.length > 0
  && resources.every(identityString) && new Set(resources).size === resources.length;
const fail = <R extends string>(code: LedgerRejectionCode, resourceId?: R): { ok: false; rejection: LedgerRejection<R> } =>
  ({ ok: false, rejection: { code, ...(resourceId === undefined ? {} : { resourceId }) } });

/** The supplied finite set defines both membership and canonical order. Empty deltas are valid. */
export function normalizeLedgerLines<R extends string>(resources: readonly R[], lines: readonly LedgerLine<NoInfer<R>>[]): LedgerLine<R>[] | null {
  if (!validResources(resources) || !isLedgerDataArray(lines)) return null;
  const totals = new Map<R, number>();
  for (const line of lines) {
    if (!isLedgerDataRecord(line, ['resourceId', 'quantity']) || !resources.includes(line.resourceId) || !isNonNegativeInteger(line.quantity) || line.quantity === 0) return null;
    const quantity = (totals.get(line.resourceId) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity)) return null;
    totals.set(line.resourceId, quantity);
  }
  return resources.filter(id => totals.has(id)).map(resourceId => ({ resourceId, quantity: totals.get(resourceId)! }));
}
function sameLines<R extends string>(left: readonly LedgerLine<R>[], right: readonly LedgerLine<R>[]): boolean {
  return left.length === right.length && left.every((line, index) => line.resourceId === right[index]!.resourceId && line.quantity === right[index]!.quantity);
}
function canonical<R extends string>(resources: readonly R[], lines: readonly LedgerLine<R>[]): boolean {
  const normalized = normalizeLedgerLines(resources, lines);
  return normalized !== null && sameLines(lines, normalized);
}
function subtract<R extends string>(resources: readonly R[], total: readonly LedgerLine<R>[], spent: readonly LedgerLine<R>[]): LedgerLine<R>[] | null {
  const quantities = new Map(total.map(line => [line.resourceId, line.quantity]));
  for (const line of spent) {
    const quantity = (quantities.get(line.resourceId) ?? 0) - line.quantity;
    if (quantity < 0) return null;
    quantities.set(line.resourceId, quantity);
  }
  return resources.filter(id => (quantities.get(id) ?? 0) > 0).map(resourceId => ({ resourceId, quantity: quantities.get(resourceId)! }));
}

/**
 * Arithmetic validation, not World/save provenance. The owner supplies the canonical claim book.
 * Aggregate reservations may also include legacy claims absent from this additive book; tracked
 * remaining claims must fit inside that aggregate. No command-supplied claim/flag is authority.
 * Own accessors, exotic prototypes, unknown fields and sparse arrays are rejected before reads.
 * These local shape checks do not replace the bounded save reader or canonical World authority.
 */
export function validateLedgerContext<R extends string, E extends LedgerBalance>(resources: readonly R[], context: LedgerContext<NoInfer<R>, E>): boolean {
  if (!validResources(resources) || !isLedgerDataRecord(context, ['ledger', 'reservations']) || !isLedgerDataRecord(context.ledger, resources) || !isLedgerDataArray(context.reservations)
    || Object.keys(context.ledger).length !== resources.length || !resources.every(id => Object.hasOwn(context.ledger, id))) return false;
  for (const id of resources) {
    const entry = context.ledger[id];
    if (!isLedgerDataRecord(entry) || !(isLedgerDataRecord(entry, ['owned', 'reserved', 'capacity'])
      || isLedgerDataRecord(entry, ['resourceId', 'owned', 'reserved', 'capacity'])) || !isNonNegativeInteger(entry.owned) || !isNonNegativeInteger(entry.reserved) || !isNonNegativeInteger(entry.capacity)
      || entry.reserved > entry.owned || entry.owned > entry.capacity) return false;
    const resource = Object.getOwnPropertyDescriptor(entry, 'resourceId');
    if (resource && resource.value !== id) return false;
  }
  const reservationIds = new Set<string>(); const owners = new Set<string>();
  const remaining: LedgerLine<R>[] = [];
  for (const claim of context.reservations) {
    if (!isLedgerDataRecord(claim, ['reservationId', 'ownerTransactionId', 'lines', 'consumed', 'remainingReservation', 'checkpoints', 'settlement'])
      || !identityString(claim.reservationId) || !identityString(claim.ownerTransactionId) || reservationIds.has(claim.reservationId) || owners.has(claim.ownerTransactionId)
      || !canonical(resources, claim.lines) || !canonical(resources, claim.consumed) || !canonical(resources, claim.remainingReservation)
      || !isLedgerDataArray(claim.checkpoints)) return false;
    reservationIds.add(claim.reservationId); owners.add(claim.ownerTransactionId);
    const checkpointIds = new Set<string>(); const paid: LedgerLine<R>[] = [];
    for (const checkpoint of claim.checkpoints) {
      if (!isLedgerDataRecord(checkpoint, ['checkpointId', 'lines']) || !identityString(checkpoint.checkpointId) || checkpointIds.has(checkpoint.checkpointId) || !canonical(resources, checkpoint.lines)) return false;
      checkpointIds.add(checkpoint.checkpointId); paid.push(...checkpoint.lines);
    }
    const paidLines = normalizeLedgerLines(resources, paid);
    if (!paidLines) return false;
    const unpaid = subtract(resources, claim.lines, paidLines);
    if (!unpaid) return false;
    if (claim.settlement === null) {
      if (!sameLines(claim.consumed, paidLines) || !sameLines(claim.remainingReservation, unpaid)) return false;
    } else {
      const settlement = claim.settlement;
      if (!isLedgerDataRecord(settlement) || !identityString(settlement.operationId) || checkpointIds.has(settlement.operationId) || claim.remainingReservation.length !== 0) return false;
      if (settlement.kind === 'committed') {
        if (!isLedgerDataRecord(settlement, ['kind', 'operationId', 'outputs']) || !canonical(resources, settlement.outputs) || !sameLines(claim.consumed, claim.lines)) return false;
      } else if (settlement.kind !== 'released' || !isLedgerDataRecord(settlement, ['kind', 'operationId']) || !sameLines(claim.consumed, paidLines)) return false;
    }
    remaining.push(...claim.remainingReservation);
  }
  const totals = normalizeLedgerLines(resources, remaining);
  return totals !== null && totals.every(line => line.quantity <= context.ledger[line.resourceId].reserved);
}
function success<R extends string, E extends LedgerBalance>(context: LedgerContext<R, E>, reservation: LedgerClaim<R>, repeated: boolean): LedgerOperationResult<R, E> {
  return { ok: true, context, reservation, repeated };
}
function publish<R extends string, E extends LedgerBalance>(context: LedgerContext<R, E>, ledger: Readonly<Record<R, E>>, reservation: LedgerClaim<R>): LedgerOperationResult<R, E> {
  return success({ ledger, reservations: context.reservations.map(claim => claim.reservationId === reservation.reservationId ? reservation : claim) }, reservation, false);
}
function ownedClaim<R extends string>(claims: readonly LedgerClaim<R>[], identity: LedgerReservationIdentity): LedgerClaim<R> | undefined {
  return isLedgerReservationIdentity(identity) ? claims.find(claim => claim.reservationId === identity.reservationId && claim.ownerTransactionId === identity.ownerTransactionId) : undefined;
}

export function reserveLedgerResources<R extends string, E extends LedgerBalance>(resources: readonly R[], context: LedgerContext<NoInfer<R>, E>, identity: LedgerReservationIdentity, lines: readonly LedgerLine<NoInfer<R>>[]): LedgerOperationResult<R, E> {
  if (!validateLedgerContext(resources, context)) return fail('INVALID_LEDGER');
  if (!isLedgerReservationIdentity(identity)) return fail('INVALID_RESERVATION');
  const normalized = normalizeLedgerLines(resources, lines);
  if (!normalized) return fail('INVALID_RESOURCE_LINE');
  const existing = context.reservations.find(claim => claim.reservationId === identity.reservationId || claim.ownerTransactionId === identity.ownerTransactionId);
  if (existing) return existing.reservationId === identity.reservationId && existing.ownerTransactionId === identity.ownerTransactionId && sameLines(existing.lines, normalized)
    ? success(context, existing, true) : fail('IDENTITY_CONFLICT');
  for (const line of normalized) if (context.ledger[line.resourceId].owned - context.ledger[line.resourceId].reserved < line.quantity) return fail('INSUFFICIENT_INVENTORY', line.resourceId);
  const ledger: Record<R, E> = { ...context.ledger };
  for (const line of normalized) ledger[line.resourceId] = { ...ledger[line.resourceId], reserved: ledger[line.resourceId].reserved + line.quantity };
  const reservation: LedgerClaim<R> = { reservationId: identity.reservationId, ownerTransactionId: identity.ownerTransactionId,
    lines: normalized, consumed: [], remainingReservation: normalized.map(line => ({ ...line })), checkpoints: [], settlement: null };
  return success({ ledger, reservations: [...context.reservations, reservation] }, reservation, false);
}

export function consumeLedgerReservationPart<R extends string, E extends LedgerBalance>(resources: readonly R[], context: LedgerContext<NoInfer<R>, E>, identity: LedgerReservationIdentity, checkpointId: string, lines: readonly LedgerLine<NoInfer<R>>[]): LedgerOperationResult<R, E> {
  if (!validateLedgerContext(resources, context)) return fail('INVALID_LEDGER');
  const claim = ownedClaim(context.reservations, identity);
  if (!claim || !identityString(checkpointId)) return fail('INVALID_RESERVATION');
  const normalized = normalizeLedgerLines(resources, lines);
  if (!normalized) return fail('INVALID_RESOURCE_LINE');
  const existing = claim.checkpoints.find(checkpoint => checkpoint.checkpointId === checkpointId);
  if (existing) return sameLines(existing.lines, normalized) ? success(context, claim, true) : fail('IDENTITY_CONFLICT');
  if (claim.settlement) return fail(claim.settlement.operationId === checkpointId ? 'IDENTITY_CONFLICT' : 'TRANSACTION_FINISHED');
  const remainingReservation = subtract(resources, claim.remainingReservation, normalized);
  const consumed = normalizeLedgerLines(resources, [...claim.consumed, ...normalized]);
  if (!remainingReservation || !consumed) return fail('INVALID_RESERVATION');
  const ledger: Record<R, E> = { ...context.ledger };
  for (const line of normalized) {
    const entry = ledger[line.resourceId];
    ledger[line.resourceId] = { ...entry, owned: entry.owned - line.quantity, reserved: entry.reserved - line.quantity };
  }
  return publish(context, ledger, { ...claim, consumed, remainingReservation, checkpoints: [...claim.checkpoints, { checkpointId, lines: normalized }] });
}

/** Release only this canonical owner's unpaid claim; consumed units never become owned again. */
export function releaseLedgerReservation<R extends string, E extends LedgerBalance>(resources: readonly R[], context: LedgerContext<NoInfer<R>, E>, identity: LedgerReservationIdentity, operationId: string): LedgerOperationResult<R, E> {
  if (!validateLedgerContext(resources, context)) return fail('INVALID_LEDGER');
  const claim = ownedClaim(context.reservations, identity);
  if (!claim || !identityString(operationId)) return fail('INVALID_RESERVATION');
  if (claim.checkpoints.some(checkpoint => checkpoint.checkpointId === operationId)) return fail('IDENTITY_CONFLICT');
  if (claim.settlement) return claim.settlement.kind === 'released' && claim.settlement.operationId === operationId
    ? success(context, claim, true) : fail(claim.settlement.operationId === operationId ? 'IDENTITY_CONFLICT' : 'TRANSACTION_FINISHED');
  const ledger: Record<R, E> = { ...context.ledger };
  for (const line of claim.remainingReservation) ledger[line.resourceId] = { ...ledger[line.resourceId], reserved: ledger[line.resourceId].reserved - line.quantity };
  return publish(context, ledger, { ...claim, remainingReservation: [], settlement: { kind: 'released', operationId } });
}

/** Debit remaining inputs before checking physical output capacity, including same-resource output. */
export function commitLedgerReservation<R extends string, E extends LedgerBalance>(resources: readonly R[], context: LedgerContext<NoInfer<R>, E>, identity: LedgerReservationIdentity, operationId: string, outputs: readonly LedgerLine<NoInfer<R>>[]): LedgerOperationResult<R, E> {
  if (!validateLedgerContext(resources, context)) return fail('INVALID_LEDGER');
  const claim = ownedClaim(context.reservations, identity);
  if (!claim || !identityString(operationId)) return fail('INVALID_RESERVATION');
  const normalized = normalizeLedgerLines(resources, outputs);
  if (!normalized) return fail('INVALID_RESOURCE_LINE');
  if (claim.checkpoints.some(checkpoint => checkpoint.checkpointId === operationId)) return fail('IDENTITY_CONFLICT');
  if (claim.settlement) return claim.settlement.kind === 'committed' && claim.settlement.operationId === operationId && sameLines(claim.settlement.outputs, normalized)
    ? success(context, claim, true) : fail(claim.settlement.operationId === operationId ? 'IDENTITY_CONFLICT' : 'TRANSACTION_FINISHED');
  const ledger: Record<R, E> = { ...context.ledger };
  for (const line of claim.remainingReservation) {
    const entry = ledger[line.resourceId];
    ledger[line.resourceId] = { ...entry, owned: entry.owned - line.quantity, reserved: entry.reserved - line.quantity };
  }
  for (const line of normalized) {
    const entry = ledger[line.resourceId]; const owned = entry.owned + line.quantity;
    if (!Number.isSafeInteger(owned) || owned > entry.capacity) return fail('CAPACITY_EXCEEDED', line.resourceId);
    ledger[line.resourceId] = { ...entry, owned };
  }
  return publish(context, ledger, { ...claim, consumed: claim.lines.map(line => ({ ...line })), remainingReservation: [], settlement: { kind: 'committed', operationId, outputs: normalized } });
}
