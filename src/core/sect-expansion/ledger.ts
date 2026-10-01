import { SECT_RESOURCE_IDS, type SectResourceId, type SectResourceLine, type SectStock, type SectStockEntry } from '../../content/sect-v9/types';
import { validateSectStock } from '../../content/sect-v9/validation';
import { RESOURCE_IDS, type InventoryEntry, type InventoryLedger, type ResourceId } from '../economy/types';
import { commitLedgerReservation, consumeLedgerReservationPart, normalizeLedgerLines, releaseLedgerReservation, reserveLedgerResources, validateLedgerContext, isLedgerDataArray, isLedgerDataRecord, isLedgerReservationIdentity,
  type LedgerClaim, type LedgerContext, type LedgerLine, type LedgerOperationResult, type LedgerRejectionCode, type LedgerReservationIdentity } from '../economy/ledger-operations';

export type SectPaymentPolicy = 'on-completion' | 'construction-checkpoints';
export type SectConstructionCheckpoint = 'half' | 'remainder';
export interface SectLedgerReservation extends LedgerReservationIdentity {
  readonly policy: SectPaymentPolicy;
  readonly base: LedgerClaim<ResourceId>;
  readonly sect: LedgerClaim<SectResourceId>;
}
export interface SectLedgerContext {
  /** The caller's existing six-resource authority; never copied into sect stock. */
  readonly inventory: InventoryLedger;
  readonly stock: SectStock;
  readonly reservations: readonly SectLedgerReservation[];
}
export type SectLedgerResult =
  | { readonly ok: true; readonly context: SectLedgerContext; readonly reservation: SectLedgerReservation; readonly repeated: boolean }
  | { readonly ok: false; readonly rejection: { readonly code: LedgerRejectionCode | 'INVALID_CHECKPOINT' | 'INVALID_POLICY'; readonly ledger?: 'base' | 'sect'; readonly resourceId?: ResourceId | SectResourceId } };
const fail = (code: Extract<SectLedgerResult, { ok: false }>['rejection']['code']): SectLedgerResult => ({ ok: false, rejection: { code } });
const validPolicy = (policy: SectPaymentPolicy): boolean => policy === 'on-completion' || policy === 'construction-checkpoints';
const sameIdentity = (left: LedgerReservationIdentity, right: LedgerReservationIdentity): boolean => left.reservationId === right.reservationId && left.ownerTransactionId === right.ownerTransactionId;
const findClaim = (context: SectLedgerContext, identity: LedgerReservationIdentity): SectLedgerReservation | undefined =>
  isLedgerReservationIdentity(identity) ? context.reservations.find(claim => sameIdentity(claim, identity)) : undefined;
const checkpointId = (checkpoint: SectConstructionCheckpoint): string => `construction.${checkpoint}`;

/** Tagged membership is checked before splitting. Unknown ledgers are never silently discarded. */
export function normalizeSectResourceLines(lines: readonly SectResourceLine[]): SectResourceLine[] | null {
  if (!isLedgerDataArray(lines)) return null;
  const base: LedgerLine<ResourceId>[] = []; const sect: LedgerLine<SectResourceId>[] = [];
  for (const line of lines) {
    if (!isLedgerDataRecord(line, ['ledger', 'resourceId', 'quantity'])) return null;
    if (line.ledger === 'base') base.push({ resourceId: line.resourceId, quantity: line.quantity });
    else if (line.ledger === 'sect') sect.push({ resourceId: line.resourceId, quantity: line.quantity });
    else return null;
  }
  const normalizedBase = normalizeLedgerLines(RESOURCE_IDS, base); const normalizedSect = normalizeLedgerLines(SECT_RESOURCE_IDS, sect);
  return normalizedBase && normalizedSect ? tagged(normalizedBase, normalizedSect) : null;
}
function tagged(base: readonly LedgerLine<ResourceId>[], sect: readonly LedgerLine<SectResourceId>[]): SectResourceLine[] {
  return [...base.map(line => ({ ledger: 'base' as const, ...line })), ...sect.map(line => ({ ledger: 'sect' as const, ...line }))];
}
function split(lines: readonly SectResourceLine[]): { base: LedgerLine<ResourceId>[]; sect: LedgerLine<SectResourceId>[] } {
  const base: LedgerLine<ResourceId>[] = []; const sect: LedgerLine<SectResourceId>[] = [];
  for (const line of lines) {
    if (line.ledger === 'base') base.push({ resourceId: line.resourceId, quantity: line.quantity });
    else sect.push({ resourceId: line.resourceId, quantity: line.quantity });
  }
  return { base, sect };
}
export function sectReservationLines(reservation: SectLedgerReservation, field: 'lines' | 'consumed' | 'remainingReservation'): SectResourceLine[] {
  return tagged(reservation.base[field], reservation.sect[field]);
}
/** Divide before adding: ceil(cost / 2) is safe even when cost is MAX_SAFE_INTEGER. */
function paymentLines<R extends string>(lines: readonly LedgerLine<R>[], checkpoint: SectConstructionCheckpoint): LedgerLine<R>[] {
  return lines.map(line => ({ resourceId: line.resourceId, quantity: checkpoint === 'half' ? Math.ceil(line.quantity / 2) : Math.floor(line.quantity / 2) })).filter(line => line.quantity > 0);
}
function sameLines<R extends string>(left: readonly LedgerLine<R>[], right: readonly LedgerLine<R>[]): boolean {
  return left.length === right.length && left.every((line, index) => line.resourceId === right[index]!.resourceId && line.quantity === right[index]!.quantity);
}
function baseContext(context: SectLedgerContext): LedgerContext<ResourceId, InventoryEntry> {
  return { ledger: context.inventory, reservations: context.reservations.map(claim => claim.base) };
}
function sectContext(context: SectLedgerContext): LedgerContext<SectResourceId, SectStockEntry> {
  return { ledger: context.stock, reservations: context.reservations.map(claim => claim.sect) };
}

/**
 * Validates internal arithmetic and paired lifecycle, not provenance, catalog price, work/travel,
 * building effects, ID allocation, persistence capacity or eligibility. Future World integration
 * must supply canonical records, prove those obligations and publish this candidate only once.
 * The base aggregate can include existing production reservations; sect stock must be fully
 * explained by this book. A command passes identities, never an alleged unpaid quantity/flag.
 */
export function validateSectLedgerContext(context: SectLedgerContext): boolean {
  if (!isLedgerDataRecord(context, ['inventory', 'stock', 'reservations']) || !isLedgerDataArray(context.reservations) || !isLedgerDataRecord(context.inventory) || validateSectStock(context.stock).length !== 0) return false;
  for (const claim of context.reservations) {
    if (!isLedgerDataRecord(claim, ['reservationId', 'ownerTransactionId', 'policy', 'base', 'sect'])
      || !isLedgerDataRecord(claim.base) || !isLedgerDataRecord(claim.sect) || !validPolicy(claim.policy)
      || !sameIdentity(claim, claim.base) || !sameIdentity(claim, claim.sect)) return false;
  }
  if (!validateLedgerContext(RESOURCE_IDS, baseContext(context)) || !validateLedgerContext(SECT_RESOURCE_IDS, sectContext(context))) return false;
  if (RESOURCE_IDS.some(id => context.inventory[id].resourceId !== id)) return false;
  for (const claim of context.reservations) {
    const base = claim.base; const sect = claim.sect;
    if (base.checkpoints.length !== sect.checkpoints.length || base.checkpoints.some((checkpoint, index) => checkpoint.checkpointId !== sect.checkpoints[index]!.checkpointId)
      || (base.settlement === null) !== (sect.settlement === null)
      || (base.settlement && sect.settlement && (base.settlement.kind !== sect.settlement.kind || base.settlement.operationId !== sect.settlement.operationId))) return false;
    if (claim.policy === 'on-completion') {
      if (base.checkpoints.length !== 0) return false;
    } else {
      if (base.checkpoints.length > 2) return false;
      for (const [index, stage] of (['half', 'remainder'] as const).entries()) {
        if (index >= base.checkpoints.length) continue;
        if (base.checkpoints[index]!.checkpointId !== checkpointId(stage) || !sameLines(base.checkpoints[index]!.lines, paymentLines(base.lines, stage))
          || !sameLines(sect.checkpoints[index]!.lines, paymentLines(sect.lines, stage))) return false;
      }
      if (base.settlement?.kind === 'committed' && (base.checkpoints.length !== 2 || base.settlement.outputs.length !== 0
        || sect.settlement?.kind !== 'committed' || sect.settlement.outputs.length !== 0)) return false;
    }
  }
  for (const id of SECT_RESOURCE_IDS) {
    const reserved = context.reservations.reduce((total, claim) => total + (claim.sect.remainingReservation.find(line => line.resourceId === id)?.quantity ?? 0), 0);
    if (reserved !== context.stock[id].reserved) return false;
  }
  return true;
}
function combine(context: SectLedgerContext, policy: SectPaymentPolicy, base: LedgerOperationResult<ResourceId, InventoryEntry>, sect: LedgerOperationResult<SectResourceId, SectStockEntry>): SectLedgerResult {
  if (!base.ok) return { ok: false, rejection: { ...base.rejection, ledger: 'base' } };
  if (!sect.ok) return { ok: false, rejection: { ...sect.rejection, ledger: 'sect' } };
  const identity = { reservationId: base.reservation.reservationId, ownerTransactionId: base.reservation.ownerTransactionId };
  const existing = findClaim(context, identity);
  if (base.repeated && sect.repeated && existing) return { ok: true, context, reservation: existing, repeated: true };
  const reservation: SectLedgerReservation = { ...identity, policy, base: base.reservation, sect: sect.reservation };
  const candidate: SectLedgerContext = { inventory: base.context.ledger, stock: sect.context.ledger,
    reservations: existing ? context.reservations.map(claim => sameIdentity(claim, identity) ? reservation : claim) : [...context.reservations, reservation] };
  return { ok: true, context: candidate, reservation, repeated: false };
}

export function reserveSectResources(context: SectLedgerContext, identity: LedgerReservationIdentity, lines: readonly SectResourceLine[], policy: SectPaymentPolicy): SectLedgerResult {
  if (!validateSectLedgerContext(context)) return fail('INVALID_LEDGER');
  if (!validPolicy(policy)) return fail('INVALID_POLICY');
  const normalized = normalizeSectResourceLines(lines);
  if (!normalized) return fail('INVALID_RESOURCE_LINE');
  const existing = findClaim(context, identity);
  if (existing && existing.policy !== policy) return fail('IDENTITY_CONFLICT');
  const amounts = split(normalized);
  const base = reserveLedgerResources(RESOURCE_IDS, baseContext(context), identity, amounts.base);
  if (!base.ok) return { ok: false, rejection: { ...base.rejection, ledger: 'base' } };
  const sect = reserveLedgerResources(SECT_RESOURCE_IDS, sectContext(context), identity, amounts.sect);
  return combine(context, policy, base, sect);
}

/** These are paid accounting checkpoints only. The future construction owner proves work time. */
export function consumeSectConstructionCheckpoint(context: SectLedgerContext, identity: LedgerReservationIdentity, checkpoint: SectConstructionCheckpoint): SectLedgerResult {
  if (!validateSectLedgerContext(context)) return fail('INVALID_LEDGER');
  const claim = findClaim(context, identity);
  if (!claim) return fail('INVALID_RESERVATION');
  if (claim.policy !== 'construction-checkpoints' || (checkpoint !== 'half' && checkpoint !== 'remainder')) return fail('INVALID_CHECKPOINT');
  if (checkpoint === 'remainder' && claim.base.checkpoints.length === 0) return fail('INVALID_CHECKPOINT');
  const id = checkpointId(checkpoint);
  const base = consumeLedgerReservationPart(RESOURCE_IDS, baseContext(context), identity, id, paymentLines(claim.base.lines, checkpoint));
  if (!base.ok) return { ok: false, rejection: { ...base.rejection, ledger: 'base' } };
  const sect = consumeLedgerReservationPart(SECT_RESOURCE_IDS, sectContext(context), identity, id, paymentLines(claim.sect.lines, checkpoint));
  return combine(context, claim.policy, base, sect);
}

export function releaseSectReservation(context: SectLedgerContext, identity: LedgerReservationIdentity, operationId: string): SectLedgerResult {
  if (!validateSectLedgerContext(context)) return fail('INVALID_LEDGER');
  const claim = findClaim(context, identity);
  if (!claim) return fail('INVALID_RESERVATION');
  const base = releaseLedgerReservation(RESOURCE_IDS, baseContext(context), identity, operationId);
  if (!base.ok) return { ok: false, rejection: { ...base.rejection, ledger: 'base' } };
  const sect = releaseLedgerReservation(SECT_RESOURCE_IDS, sectContext(context), identity, operationId);
  return combine(context, claim.policy, base, sect);
}

export function commitSectReservation(context: SectLedgerContext, identity: LedgerReservationIdentity, operationId: string, outputs: readonly SectResourceLine[]): SectLedgerResult {
  if (!validateSectLedgerContext(context)) return fail('INVALID_LEDGER');
  const claim = findClaim(context, identity);
  if (!claim) return fail('INVALID_RESERVATION');
  const normalized = normalizeSectResourceLines(outputs);
  if (!normalized) return fail('INVALID_RESOURCE_LINE');
  if (claim.policy === 'construction-checkpoints' && (claim.base.checkpoints.length !== 2 || normalized.length !== 0)) return fail('INVALID_CHECKPOINT');
  const amounts = split(normalized);
  const base = commitLedgerReservation(RESOURCE_IDS, baseContext(context), identity, operationId, amounts.base);
  if (!base.ok) return { ok: false, rejection: { ...base.rejection, ledger: 'base' } };
  const sect = commitLedgerReservation(SECT_RESOURCE_IDS, sectContext(context), identity, operationId, amounts.sect);
  return combine(context, claim.policy, base, sect);
}
