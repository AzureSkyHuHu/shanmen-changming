import { SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';
export { SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND } from './descriptor-bounds';
import type { SectHistoricalIdentitySource } from './history-identity';
import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import { isLedgerDataArray, isLedgerDataRecord } from '../economy/ledger-operations';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, compareStable } from '../kernel/serialization';
import { validateConstructionRecords, validateWorldConstructionRecords } from './construction-record-validation';
import type { ConstructionValidationIssue } from './construction-types';
import { ownSectFields } from './layout';
import { normalizeSectResourceLines, sectReservationLines } from './ledger';
import { sectMaintenanceClockFits } from './maintenance-periods';
import { SECT_MAINTENANCE_LIMITS, type SectMaintenanceFrame, type SectMaintenancePayment } from './maintenance-types';
import { validateMaintainedSectProductionRecords, validateWorldMaintainedSectProductionRecords, validateSectProductionReceipts } from './production-runtime';
import { validateSectResearchConsumerGates } from './research-consumer-gates';
import { sectAllLocalClaims, sectClaimsConflict, validateMaintainedSectResearchRecords, validateWorldMaintainedSectResearchRecords } from './research-validation';

const integer = isNonNegativeInteger;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
function plainTree(value: unknown, depth = 0, budget = { left: SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND }): boolean {
  if (--budget.left < 0 || depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return value.length <= 256;
  if (Array.isArray(value)) return isLedgerDataArray(value) && value.length <= 65536 && value.every(child => plainTree(child, depth + 1, budget));
  return isLedgerDataRecord(value) && Object.values(value as Record<string, unknown>).every(child => plainTree(child, depth + 1, budget));
}
/** Acyclic: shape → construction → maintenance accounting/periods → production → research
 * evidence → research consumer gates → exact four-owner closure → shared claims/headroom. */
export function validateSectMaintenanceFrame(input: unknown): readonly ConstructionValidationIssue[] {
  const records = validateRecords(input);
  return records.length ? records : validateSectMaintenanceOwnerClosure(input as SectMaintenanceFrame);
}
/** Internal composable leaf: authenticates all four domains' records, prices, paid intervals and
 * consumer references, but deliberately does not close the owner union. A future five-owner root
 * must authenticate its additional owner before doing its own exact closure. This is not admission. */
export function validateWorldSectMaintenanceRecords(input: unknown, identities: SectHistoricalIdentitySource): readonly ConstructionValidationIssue[] {
  return validateRecords(input, identities);
}
function validateRecords(input: unknown, identities?: SectHistoricalIdentitySource): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path: string): readonly ConstructionValidationIssue[] => [{ code, path }];
  if (!plainTree(input) || !ownSectFields(input, ['schemaVersion', 'construction', 'production', 'research', 'maintenance']) || input.schemaVersion !== 1)
    return fail('INVALID_SHAPE', 'frame');
  const frame = input as unknown as SectMaintenanceFrame; const authority = frame.construction;
  const construction = identities ? validateWorldConstructionRecords(authority, identities) : validateConstructionRecords(authority);
  if (construction.length) return construction.map(issue => ({ ...issue, path: `construction.${issue.path}` }));
  const payments = validateSectMaintenanceRecords(frame); if (payments.length) return payments;
  for (const building of authority.buildings) {
    if (!sectMaintenanceClockFits(frame, building.completedTick, building.completedCalendarTick)) return fail('INVALID_MAINTENANCE_CLOCK', building.buildingId);
  }
  const production = identities ? validateWorldMaintainedSectProductionRecords(frame, identities) : validateMaintainedSectProductionRecords(frame); if (production.length) return production;
  const receipts = validateSectProductionReceipts(frame); if (receipts.length) return receipts;
  const research = identities ? validateWorldMaintainedSectResearchRecords(frame, identities) : validateMaintainedSectResearchRecords(frame); if (research.length) return research;
  const gates = validateSectResearchConsumerGates(frame); if (gates.length) return gates;
  return [];
}
/** Exact FOUR-owner closure and shared live claims, only after all records are authenticated.
 * Do not call this for a future care owner or filter its reservations to make this pass. */
export function validateSectMaintenanceOwnerClosure(frame: SectMaintenanceFrame): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path: string): readonly ConstructionValidationIssue[] => [{ code, path }];
  const authority = frame.construction;
  for (const claim of authority.ledger.reservations) {
    const owners = authority.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + frame.production.jobs.filter(job => job.transactionId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + frame.research.jobs.filter(job => job.jobId === claim.ownerTransactionId && job.reservationId === claim.reservationId).length
      + frame.maintenance.payments.filter(payment => payment.paymentId === claim.ownerTransactionId && payment.reservationId === claim.reservationId).length;
    if (owners !== 1) return fail('ORPHAN_RESERVATION', claim.reservationId);
  }
  if (authority.jobs.filter(job => job.terminal === null).length + frame.production.jobs.filter(job => job.terminal === null).length
    + frame.research.jobs.filter(job => job.terminal === null).length > 36) return fail('JOB_LIMIT', 'frame');
  if (sectClaimsConflict(sectAllLocalClaims(frame))) return fail('CLAIM_CONFLICT', 'frame');
  return [];
}
function validateSectMaintenanceRecords(frame: SectMaintenanceFrame): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path: string): readonly ConstructionValidationIssue[] => [{ code, path }];
  const domain = frame.maintenance; const authority = frame.construction;
  if (!ownSectFields(domain, ['nextId', 'payments']) || !integer(domain.nextId) || domain.nextId < 1
    || !isLedgerDataArray(domain.payments) || domain.payments.length > SECT_MAINTENANCE_LIMITS.payments) return fail('INVALID_DOMAIN', 'maintenance');
  const allocations = new Set<number>(); const latest = new Map<string, SectMaintenancePayment>();
  const allocation = (value: unknown, prefix: string): number | null => {
    if (typeof value !== 'string' || value.length > 128 || !value.startsWith(`${prefix}:`)) return null;
    const suffix = value.slice(prefix.length + 1); const n = Number(suffix);
    if (!integer(n) || n < 1 || String(n) !== suffix || n >= domain.nextId || allocations.has(n)
      || authority.people.some(person => person.id === value) || authority.legacyStations.some(site => site.id === value)) return null;
    allocations.add(n); return n;
  };
  let previous: SectMaintenancePayment | null = null; let previousAllocation = 0;
  for (const payment of domain.payments) {
    if (!ownSectFields(payment, ['paymentId', 'reservationId', 'buildingId', 'sourceJobId', 'predecessorPaymentId', 'previousDueCalendarTick', 'paidTick', 'paidCalendarTick', 'dueCalendarTick'])
      || !integer(payment.previousDueCalendarTick) || !integer(payment.paidTick) || !integer(payment.paidCalendarTick) || !integer(payment.dueCalendarTick)
      || !(payment.predecessorPaymentId === null || typeof payment.predecessorPaymentId === 'string')) return fail('INVALID_PAYMENT', 'maintenance.payments');
    const n = allocation(payment.paymentId, 'sect-maintenance'); const r = allocation(payment.reservationId, 'sect-maintenance-reservation');
    if (n === null || r !== n + 1 || n <= previousAllocation) return fail('INVALID_PAYMENT_ID', payment.paymentId);
    previousAllocation = n + 1;
    const building = authority.buildings.find(value => value.buildingId === payment.buildingId);
    const source = authority.jobs.find(value => value.jobId === payment.sourceJobId);
    if (!building || building.level !== 1 || building.sourceJobId !== payment.sourceJobId || source?.terminal?.kind !== 'completed'
      || source.resultBuildingId !== building.buildingId || source.terminal.buildingId !== building.buildingId) return fail('INVALID_MAINTENANCE_SOURCE', payment.paymentId);
    const definition = getSectBuildingDefinition(building.definitionId)!.levels[0]!;
    const predecessor = latest.get(payment.buildingId);
    const beforeTick = predecessor?.paidTick ?? building.completedTick;
    const beforeCalendar = predecessor?.paidCalendarTick ?? building.completedCalendarTick;
    if (payment.predecessorPaymentId !== (predecessor?.paymentId ?? null)
      || payment.previousDueCalendarTick !== (predecessor?.dueCalendarTick ?? building.firstMaintenanceCalendarTick)
      || payment.paidCalendarTick < payment.previousDueCalendarTick || payment.paidTick <= beforeTick
      || payment.paidCalendarTick - beforeCalendar > payment.paidTick - beforeTick
      || payment.paidTick > authority.lastSimulationTick || payment.paidCalendarTick > authority.lastCalendarTick
      || authority.lastCalendarTick - payment.paidCalendarTick > authority.lastSimulationTick - payment.paidTick
      || payment.paidCalendarTick > Number.MAX_SAFE_INTEGER - definition.maintenance.intervalTicks
      || payment.dueCalendarTick !== payment.paidCalendarTick + definition.maintenance.intervalTicks) return fail('INVALID_MAINTENANCE_PERIOD', payment.paymentId);
    if (previous && (payment.paidTick < previous.paidTick || payment.paidCalendarTick < previous.paidCalendarTick
      || payment.paidTick > previous.paidTick && payment.paidCalendarTick === previous.paidCalendarTick
      || payment.paidCalendarTick - previous.paidCalendarTick > payment.paidTick - previous.paidTick
      || payment.paidTick === previous.paidTick && (payment.paidCalendarTick !== previous.paidCalendarTick || compareStable(previous.buildingId, payment.buildingId) >= 0)))
      return fail('INVALID_MAINTENANCE_ORDER', payment.paymentId);
    const claim = authority.ledger.reservations.find(value => value.ownerTransactionId === payment.paymentId && value.reservationId === payment.reservationId);
    if (!claim || claim.policy !== 'on-completion' || !same(sectReservationLines(claim, 'lines'), normalizeSectResourceLines(definition.maintenance.costs))
      || !same(sectReservationLines(claim, 'consumed'), normalizeSectResourceLines(definition.maintenance.costs))
      || sectReservationLines(claim, 'remainingReservation').length || claim.base.checkpoints.length || claim.sect.checkpoints.length
      || claim.base.settlement?.kind !== 'committed' || claim.sect.settlement?.kind !== 'committed'
      || claim.base.settlement.operationId !== `maintain:${payment.paymentId}` || claim.sect.settlement.operationId !== `maintain:${payment.paymentId}`
      || claim.base.settlement.outputs.length || claim.sect.settlement.outputs.length) return fail('INVALID_MAINTENANCE_PAYMENT', payment.paymentId);
    latest.set(payment.buildingId, payment); previous = payment;
  }
  return [];
}
