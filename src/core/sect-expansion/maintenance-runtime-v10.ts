import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import { compareStable } from '../kernel/serialization';
import type { ConstructionContext } from './construction-types';
import { commitSectReservation, reserveSectResources } from './ledger';
import { sectBuildingPaidAt } from './maintenance-periods';
import { SECT_MAINTENANCE_LIMITS } from './maintenance-types';
import { sectBuildingLevelAtFromUpgradeRecordsV10 } from './upgrade-level-records';
import type { SectMaintenancePaymentV10, SectUpgradeFrameV10 } from './upgrade-types';

/** Fixed internal candidate stage, AFTER source authentication and construction clock
 * advancement, BEFORE upgrade work. Root validates complete candidate records/capacity.
 * Inventory-only renewals remain allowed while an upgrade owns the building/workstation.
 * No catch-up debt, new free period, failed ID allocation or persisted operational flag. */
export function tickValidatedSectMaintenancePaymentV10(frame: SectUpgradeFrameV10, context: ConstructionContext): SectUpgradeFrameV10 {
  if (context.simulationTick !== frame.construction.lastSimulationTick || context.calendarTick !== frame.construction.lastCalendarTick
    || context.simulationTick !== context.calendarTick) throw new RangeError('V10 maintenance clock differs');
  if (context.mode !== 'management' || context.paused || context.expeditionActive) return frame;
  let next = frame;
  for (const building of frame.construction.buildings.slice().sort((a, b) => compareStable(a.buildingId, b.buildingId))) {
    if (sectBuildingPaidAt(next, building.buildingId, context.simulationTick, context.calendarTick)) continue;
    const level = sectBuildingLevelAtFromUpgradeRecordsV10(next, building.buildingId, context.simulationTick, 'maintenance');
    if (!level) throw new TypeError('Missing v10 historical building level');
    const definition = getSectBuildingDefinition(building.definitionId)!.levels.find(value => value.level === level.level)!;
    if (next.maintenance.payments.length >= SECT_MAINTENANCE_LIMITS.payments
      || next.construction.ledger.reservations.length >= SECT_MAINTENANCE_LIMITS.pairedClaims
      || next.maintenance.nextId > Number.MAX_SAFE_INTEGER - 2
      || context.calendarTick > Number.MAX_SAFE_INTEGER - definition.maintenance.intervalTicks) continue;
    const paymentId = `sect-maintenance:${next.maintenance.nextId}`;
    const reservationId = `sect-maintenance-reservation:${next.maintenance.nextId + 1}`;
    const identity = { reservationId, ownerTransactionId: paymentId };
    const reserved = reserveSectResources(next.construction.ledger, identity, definition.maintenance.costs, 'on-completion');
    if (!reserved.ok) continue;
    const paid = commitSectReservation(reserved.context, identity, `maintain:${paymentId}`, []);
    if (!paid.ok) continue;
    const previous = next.maintenance.payments.filter(payment => payment.buildingId === building.buildingId).at(-1);
    const payment: SectMaintenancePaymentV10 = {
      paymentId, reservationId, buildingId: building.buildingId, sourceJobId: building.sourceJobId,
      predecessorPaymentId: previous?.paymentId ?? null,
      previousDueCalendarTick: previous?.dueCalendarTick ?? building.firstMaintenanceCalendarTick,
      paidTick: context.simulationTick, paidCalendarTick: context.calendarTick,
      dueCalendarTick: context.calendarTick + definition.maintenance.intervalTicks,
      ...(level.level === 2 ? { rate: { level: 2 as const, upgradeJobId: level.upgradeJobId } } : {}),
    };
    next = { ...next, construction: { ...next.construction, ledger: paid.context }, maintenance: {
      nextId: next.maintenance.nextId + 2, payments: [...next.maintenance.payments, payment],
    } };
  }
  return next;
}
