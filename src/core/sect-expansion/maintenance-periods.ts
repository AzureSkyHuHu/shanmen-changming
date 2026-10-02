import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import type { ConstructionBuilding } from './construction-types';
import { SECT_MAINTENANCE_LIMITS, type SectMaintenanceFrame, type SectMaintenanceStatus } from './maintenance-types';

/** All known anchors belong to one clock. Both preceding AND succeeding anchors constrain
 * historical time pairs; matching only the paid interval's lower bound permits backdating. */
export function sectMaintenanceClockFits(frame: SectMaintenanceFrame, tick: number, calendarTick: number): boolean {
  const anchors = [
    ...frame.construction.buildings.map(building => ({ tick: building.completedTick, calendar: building.completedCalendarTick })),
    ...frame.maintenance.payments.map(payment => ({ tick: payment.paidTick, calendar: payment.paidCalendarTick })),
    { tick: frame.construction.lastSimulationTick, calendar: frame.construction.lastCalendarTick },
  ];
  return anchors.every(anchor => {
    const simulation = tick - anchor.tick; const calendar = calendarTick - anchor.calendar;
    return simulation >= 0 ? calendar >= 0 && calendar <= simulation : calendar <= 0 && calendar >= simulation;
  });
}
/** Leaf queries only. The four-domain owner authenticates construction and every paid record
 * before calling these. Never call a whole-frame validator, accept a callback or trust a flag. */
export function sectBuildingPaidRange(frame: SectMaintenanceFrame, buildingId: string,
  firstTick: number, lastTick: number, firstCalendarTick: number, lastCalendarTick: number): boolean {
  const building = frame.construction.buildings.find(value => value.buildingId === buildingId);
  if (!building || firstTick > lastTick || firstCalendarTick > lastCalendarTick
    || lastTick - firstTick !== lastCalendarTick - firstCalendarTick
    || !sectMaintenanceClockFits(frame, firstTick, firstCalendarTick) || !sectMaintenanceClockFits(frame, lastTick, lastCalendarTick)) return false;
  const periods = [{ tick: building.completedTick, start: building.completedCalendarTick, end: building.firstMaintenanceCalendarTick },
    ...frame.maintenance.payments.filter(payment => payment.buildingId === buildingId)
      .map(payment => ({ tick: payment.paidTick, start: payment.paidCalendarTick, end: payment.dueCalendarTick }))];
  let calendar = firstCalendarTick;
  for (const period of periods) {
    if (period.end <= calendar) continue;
    const tick = firstTick + (calendar - firstCalendarTick);
    if (period.start > calendar || period.tick > tick || calendar - period.start > tick - period.tick) return false;
    if (period.end > lastCalendarTick) return true;
    calendar = period.end;
  }
  return false;
}
export function sectBuildingPaidAt(frame: SectMaintenanceFrame, buildingId: string, tick: number, calendarTick: number): boolean {
  return sectBuildingPaidRange(frame, buildingId, tick, tick, calendarTick, calendarTick);
}
export function sectMaintenanceStatusFromRecords(frame: SectMaintenanceFrame, building: ConstructionBuilding): SectMaintenanceStatus {
  const level = getSectBuildingDefinition(building.definitionId)!.levels.find(value => value.level === building.level)!;
  const latest = frame.maintenance.payments.filter(payment => payment.buildingId === building.buildingId).at(-1);
  const dueCalendarTick = latest?.dueCalendarTick ?? building.firstMaintenanceCalendarTick;
  const deficits = level.maintenance.costs.flatMap(line => {
    const entry = line.ledger === 'base' ? frame.construction.ledger.inventory[line.resourceId] : frame.construction.ledger.stock[line.resourceId];
    const quantity = Math.max(0, line.quantity - (entry.owned - entry.reserved));
    return quantity ? [{ ...line, quantity }] : [];
  });
  const renewalBlock = frame.maintenance.payments.length >= SECT_MAINTENANCE_LIMITS.payments
    || frame.construction.ledger.reservations.length >= SECT_MAINTENANCE_LIMITS.pairedClaims ? 'HISTORY_EXHAUSTED'
    : frame.maintenance.nextId > Number.MAX_SAFE_INTEGER - 2 ? 'ID_LIMIT'
    : frame.construction.lastCalendarTick > Number.MAX_SAFE_INTEGER - level.maintenance.intervalTicks ? 'CLOCK_LIMIT'
    : deficits.length ? 'INSUFFICIENT_INVENTORY' : null;
  return { buildingId: building.buildingId,
    operational: sectBuildingPaidAt(frame, building.buildingId, frame.construction.lastSimulationTick, frame.construction.lastCalendarTick),
    dueCalendarTick, deficits, renewalBlock };
}
