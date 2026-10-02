import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import { isLedgerDataArray } from '../economy/ledger-operations';
import { isNonNegativeInteger } from '../kernel/numeric';
import { canonicalStringify, compareStable } from '../kernel/serialization';
import type { ConstructionValidationIssue } from './construction-types';
import type { SectHistoricalIdentitySource } from './history-identity';
import { ownSectFields } from './layout';
import { normalizeSectResourceLines, sectReservationLines } from './ledger';
import { sectMaintenanceClockFits } from './maintenance-periods';
import { SECT_MAINTENANCE_LIMITS } from './maintenance-types';
import { validateMaintainedSectResearchSourceRecords } from './research-validation';
import { sectBuildingLevelAtFromUpgradeRecordsV10 } from './upgrade-level-records';
import type { SectMaintenancePaymentV10, SectUpgradeFrameV10 } from './upgrade-types';

const integer = isNonNegativeInteger;
const same = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const paymentFields = ['paymentId', 'reservationId', 'buildingId', 'sourceJobId', 'predecessorPaymentId',
  'previousDueCalendarTick', 'paidTick', 'paidCalendarTick', 'dueCalendarTick'] as const;

/** Fixed acyclic v10 stage, after descriptor/construction/paired-ledger authentication.
 * Checks the COMPLETE maintenance history's shape, IDs, origins, clocks and period chains,
 * and authenticates every untagged L1 settlement. Only alchemy may carry the exact L2 tag;
 * its upgrade provenance and L2 settlement belong to the later fixed v10 rate stage.
 * This is not admission, a whole-maintenance validator, or an owner-closure certificate. */
export function validateSectMaintenanceL1RecordsV10(frame: SectUpgradeFrameV10): readonly ConstructionValidationIssue[] {
  const fail = (code: string, path: string): readonly ConstructionValidationIssue[] => [{ code, path }];
  const domain = frame.maintenance; const authority = frame.construction;
  if (!ownSectFields(domain, ['nextId', 'payments']) || !integer(domain.nextId) || domain.nextId < 1
    || !isLedgerDataArray(domain.payments) || domain.payments.length > SECT_MAINTENANCE_LIMITS.payments) return fail('INVALID_DOMAIN', 'maintenance');
  const allocations = new Set<number>(); const latest = new Map<string, SectMaintenancePaymentV10>();
  const allocation = (value: unknown, prefix: string): number | null => {
    if (!id(value) || !value.startsWith(`${prefix}:`)) return null;
    const suffix = value.slice(prefix.length + 1); const n = Number(suffix);
    if (!integer(n) || n < 1 || String(n) !== suffix || n >= domain.nextId || allocations.has(n)
      || authority.people.some(person => person.id === value) || authority.legacyStations.some(site => site.id === value)) return null;
    allocations.add(n); return n;
  };
  let previous: SectMaintenancePaymentV10 | null = null; let previousAllocation = 0;
  for (const payment of domain.payments) {
    if (!ownSectFields(payment, paymentFields, false)) return fail('INVALID_PAYMENT', 'maintenance.payments');
    // Presence is significant: rate: undefined/null is not an old L1 payment.
    const tagged = Object.hasOwn(payment, 'rate');
    if (!ownSectFields(payment, tagged ? [...paymentFields, 'rate'] : paymentFields)
      || !id(payment.buildingId) || !id(payment.sourceJobId)
      || !integer(payment.previousDueCalendarTick) || !integer(payment.paidTick) || !integer(payment.paidCalendarTick) || !integer(payment.dueCalendarTick)
      || !(payment.predecessorPaymentId === null || id(payment.predecessorPaymentId))) return fail('INVALID_PAYMENT', 'maintenance.payments');
    if (tagged && (!ownSectFields(payment.rate, ['level', 'upgradeJobId']) || payment.rate.level !== 2
      || !id(payment.rate.upgradeJobId) || !/^sect-upgrade:[1-9][0-9]*$/.test(payment.rate.upgradeJobId)
      || !integer(Number(payment.rate.upgradeJobId.slice('sect-upgrade:'.length))))) return fail('INVALID_MAINTENANCE_RATE', payment.paymentId);
    const n = allocation(payment.paymentId, 'sect-maintenance'); const r = allocation(payment.reservationId, 'sect-maintenance-reservation');
    if (n === null || r !== n + 1 || n <= previousAllocation) return fail('INVALID_PAYMENT_ID', payment.paymentId);
    previousAllocation = n + 1;
    const building = authority.buildings.find(value => value.buildingId === payment.buildingId);
    const source = authority.jobs.find(value => value.jobId === payment.sourceJobId);
    if (!building || building.level !== 1 || building.sourceJobId !== payment.sourceJobId || source?.terminal?.kind !== 'completed'
      || source.resultBuildingId !== building.buildingId || source.terminal.buildingId !== building.buildingId) return fail('INVALID_MAINTENANCE_SOURCE', payment.paymentId);
    const definition = getSectBuildingDefinition(building.definitionId)?.levels[0];
    if (!definition || definition.level !== 1) return fail('INVALID_MAINTENANCE_SOURCE', payment.paymentId);
    if (tagged && building.definitionId !== 'alchemy.v9') return fail('INVALID_MAINTENANCE_RATE', payment.paymentId);
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
    if (!tagged) {
      const claim = authority.ledger.reservations.find(value => value.ownerTransactionId === payment.paymentId && value.reservationId === payment.reservationId);
      const costs = normalizeSectResourceLines(definition.maintenance.costs);
      if (!claim || claim.policy !== 'on-completion' || !same(sectReservationLines(claim, 'lines'), costs)
        || !same(sectReservationLines(claim, 'consumed'), costs)
        || sectReservationLines(claim, 'remainingReservation').length || claim.base.checkpoints.length || claim.sect.checkpoints.length
        || claim.base.settlement?.kind !== 'committed' || claim.sect.settlement?.kind !== 'committed'
        || claim.base.settlement.operationId !== `maintain:${payment.paymentId}` || claim.sect.settlement.operationId !== `maintain:${payment.paymentId}`
        || claim.base.settlement.outputs.length || claim.sect.settlement.outputs.length) return fail('INVALID_MAINTENANCE_PAYMENT', payment.paymentId);
    }
    latest.set(payment.buildingId, payment); previous = payment;
  }
  for (const building of authority.buildings) {
    if (!sectMaintenanceClockFits(frame, building.completedTick, building.completedCalendarTick)) return fail('INVALID_MAINTENANCE_CLOCK', building.buildingId);
  }
  return [];
}

/** Historical upgrade-work query only. All clock anchors remain visible, including L2
 * payments. A tagged period can never fund L1 upgrade work. The root authenticates the
 * complete history first; no filtered old-schema frame or callback is accepted here. */
export function sectBuildingL1PaidRangeV10(frame: SectUpgradeFrameV10, buildingId: string,
  firstTick: number, lastTick: number, firstCalendarTick: number, lastCalendarTick: number): boolean {
  const building = frame.construction.buildings.find(value => value.buildingId === buildingId);
  if (!building || building.level !== 1 || ![firstTick, lastTick, firstCalendarTick, lastCalendarTick].every(integer)
    || firstTick !== firstCalendarTick || lastTick !== lastCalendarTick || firstTick > lastTick
    || lastTick > frame.construction.lastSimulationTick || lastCalendarTick > frame.construction.lastCalendarTick
    || !sectMaintenanceClockFits(frame, firstTick, firstCalendarTick) || !sectMaintenanceClockFits(frame, lastTick, lastCalendarTick)) return false;
  const periods = [{ tick: building.completedTick, start: building.completedCalendarTick, end: building.firstMaintenanceCalendarTick, l1: true },
    ...frame.maintenance.payments.filter(payment => payment.buildingId === buildingId)
      .map(payment => ({ tick: payment.paidTick, start: payment.paidCalendarTick, end: payment.dueCalendarTick, l1: !Object.hasOwn(payment, 'rate') }))];
  let calendar = firstCalendarTick;
  for (const period of periods) {
    if (period.end <= calendar) continue;
    const tick = firstTick + (calendar - firstCalendarTick);
    if (!period.l1 || period.start > calendar || period.tick > tick || calendar - period.start > tick - period.tick) return false;
    if (period.end > lastCalendarTick) return true;
    calendar = period.end;
  }
  return false;
}

/** Fixed one-source research stage. Call after the L1 stage has authenticated every
 * library payment. Library cannot upgrade, so the unchanged research evidence leaf sees
 * its entire authentic paid history even when unrelated alchemy L2 payments exist.
 * This does not validate upgrade jobs, production, owner closure or World admission. */
export function validateSectUpgradeResearchPrerequisitesV10(frame: SectUpgradeFrameV10,
  identities?: SectHistoricalIdentitySource): readonly ConstructionValidationIssue[] {
  return validateMaintainedSectResearchSourceRecords(frame, identities);
}

/** Final fixed maintenance record stage AFTER genuine upgrade records are authenticated.
 * Root order is construction/ledger → L1 maintenance → research → upgrade → this stage.
 * The independent historical-level leaf avoids a maintenance↔upgrade validator cycle.
 * Rechecking the early stage does not replace the preceding upgrade stage or make this
 * a public admission validator; owner closure, consumers and World bounds follow later. */
export function validateSectMaintenanceRecordsV10(frame: SectUpgradeFrameV10): readonly ConstructionValidationIssue[] {
  const early = validateSectMaintenanceL1RecordsV10(frame); if (early.length) return early;
  const fail = (code: string, path: string): readonly ConstructionValidationIssue[] => [{ code, path }];
  for (const payment of frame.maintenance.payments) {
    const level = sectBuildingLevelAtFromUpgradeRecordsV10(frame, payment.buildingId, payment.paidTick, 'maintenance');
    if (!level || (level.level === 1 ? Object.hasOwn(payment, 'rate') : payment.rate?.upgradeJobId !== level.upgradeJobId))
      return fail('INVALID_MAINTENANCE_RATE', payment.paymentId);
    if (level.level === 1) continue; // The early stage already authenticated this exact L1 settlement.
    const claim = frame.construction.ledger.reservations.find(value => value.ownerTransactionId === payment.paymentId && value.reservationId === payment.reservationId);
    const costs = normalizeSectResourceLines(getSectBuildingDefinition('alchemy.v9')!.levels[1]!.maintenance.costs);
    if (!claim || claim.policy !== 'on-completion' || !same(sectReservationLines(claim, 'lines'), costs)
      || !same(sectReservationLines(claim, 'consumed'), costs)
      || sectReservationLines(claim, 'remainingReservation').length || claim.base.checkpoints.length || claim.sect.checkpoints.length
      || claim.base.settlement?.kind !== 'committed' || claim.sect.settlement?.kind !== 'committed'
      || claim.base.settlement.operationId !== `maintain:${payment.paymentId}` || claim.sect.settlement.operationId !== `maintain:${payment.paymentId}`
      || claim.base.settlement.outputs.length || claim.sect.settlement.outputs.length) return fail('INVALID_MAINTENANCE_PAYMENT', payment.paymentId);
  }
  return [];
}
