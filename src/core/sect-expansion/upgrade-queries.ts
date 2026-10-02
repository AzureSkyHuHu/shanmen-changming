import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import { cloneJson } from '../kernel/serialization';
import { validateSectMaintenanceRecordsV10 } from './maintenance-v10';
import type { SectHistoricalIdentitySource } from './history-identity';
import type { ConstructionContext } from './construction-types';
import { sectBuildingL1PaidRangeV10, inspectSectUpgradeStartV10, sectUpgradeCostsV10, sectUpgradeGateFromRecordsV10,
  validateSectUpgradeRecordsV10 } from './upgrade-validation';
import type { SectBuildingLevelEvidenceV10, SectBuildingStatusV10, SectUpgradeFrameV10, SectUpgradePreviewV10 } from './upgrade-types';

import { sectBuildingLevelAtFromUpgradeRecordsV10 } from './upgrade-level-records';
export { sectBuildingLevelAtFromUpgradeRecordsV10 } from './upgrade-level-records';

/** Authenticated-record query, not a standalone validator or World/save admission. The root also authenticates L2 payments,
 * production, care, lifecycle and complete six-owner/capacity closure before exposing queries. */
export function sectBuildingLevelAtV10(frame: SectUpgradeFrameV10, buildingId: string,
  tick: number, phase: 'maintenance' | 'after-upgrade'): SectBuildingLevelEvidenceV10 | null {
  return sectBuildingLevelAtFromUpgradeRecordsV10(frame, buildingId, tick, phase);
}
export function sectBuildingStatusV10(frame: SectUpgradeFrameV10, buildingId: string): SectBuildingStatusV10 | null {
  const building = frame.construction.buildings.find(value => value.buildingId === buildingId);
  const tick = frame.construction.lastSimulationTick;
  const calendarTick = frame.construction.lastCalendarTick;
  const level = sectBuildingLevelAtFromUpgradeRecordsV10(frame, buildingId, tick, 'after-upgrade');
  if (!building || !level) return null;
  const payments = frame.maintenance.payments.filter(value => value.buildingId === buildingId);
  const latest = payments.at(-1);
  const dueCalendarTick = latest?.dueCalendarTick ?? building.firstMaintenanceCalendarTick;
  // Upgrade records prove L1 intervals only. L2 payments are consumed here as a query leaf;
  // the fixed World root must authenticate them in its subsequent maintenance stage.
  const paid = latest ? latest.paidTick <= tick && latest.paidCalendarTick <= calendarTick && calendarTick < latest.dueCalendarTick
    : sectBuildingL1PaidRangeV10(frame, buildingId, tick, tick, calendarTick, calendarTick);
  const active = frame.upgrade.jobs.find(value => value.buildingId === buildingId && value.terminal === null);
  const costs = getSectBuildingDefinition(building.definitionId)!.levels.find(value => value.level === level.level)!.maintenance.costs;
  const deficits = costs.flatMap(line => {
    const entry = line.ledger === 'base' ? frame.construction.ledger.inventory[line.resourceId] : frame.construction.ledger.stock[line.resourceId];
    const quantity = Math.max(0, line.quantity - (entry.owned - entry.reserved));
    return quantity ? [{ ...line, quantity }] : [];
  });
  return cloneJson({ buildingId, level, activeUpgradeJobId: active?.jobId ?? null, paid, operational: paid && !active,
    dueCalendarTick, nextMaintenanceCosts: costs, deficits });
}
/** Pure preview AFTER root record authentication. Does not allocate, reserve or become an admission token. */
export function previewSectUpgradeV10(frame: SectUpgradeFrameV10, context: ConstructionContext,
  buildingId: string, workerId: string): SectUpgradePreviewV10 {
  const costs = sectUpgradeCostsV10();
  const rejection = inspectSectUpgradeStartV10(frame, context, buildingId, workerId);
  const building = frame.construction.buildings.find(value => value.buildingId === buildingId);
  const latest = building ? frame.maintenance.payments.filter(value => value.buildingId === buildingId).at(-1) : undefined;
  return { buildingId, workerId, revision: frame.upgrade.revision, simulationTick: frame.construction.lastSimulationTick,
    eligible: rejection === null, rejection, costs, halfCosts: costs.map(line => ({ ...line, quantity: 3 })),
    remainingCosts: costs.map(line => ({ ...line, quantity: 3 })), requiredTicks: 400,
    researchGate: sectUpgradeGateFromRecordsV10(frame, frame.construction.lastSimulationTick),
    dueCalendarTick: building ? latest?.dueCalendarTick ?? building.firstMaintenanceCalendarTick : null };
}

/** Safe isolated-domain counterparts. These validate domain history, including optional
 * authenticated retired identities; they are still not World/lifecycle/capacity admission. */
export function sectBuildingLevelAtFromIsolatedFrameV10(frame: SectUpgradeFrameV10, buildingId: string,
  tick: number, phase: 'maintenance' | 'after-upgrade', identities?: SectHistoricalIdentitySource): SectBuildingLevelEvidenceV10 | null {
  if (validateSectUpgradeRecordsV10(frame, identities).length) return null;
  return sectBuildingLevelAtV10(frame, buildingId, tick, phase);
}
export function sectBuildingStatusFromIsolatedFrameV10(frame: SectUpgradeFrameV10, buildingId: string,
  identities?: SectHistoricalIdentitySource): SectBuildingStatusV10 | null {
  if (validateSectUpgradeRecordsV10(frame, identities).length || validateSectMaintenanceRecordsV10(frame).length) return null;
  return sectBuildingStatusV10(frame, buildingId);
}
export function previewSectUpgradeFromIsolatedFrameV10(frame: SectUpgradeFrameV10, context: ConstructionContext,
  buildingId: string, workerId: string, identities?: SectHistoricalIdentitySource): SectUpgradePreviewV10 {
  if (validateSectUpgradeRecordsV10(frame, identities).length) {
    const costs = sectUpgradeCostsV10();
    return { buildingId, workerId, revision: 0, simulationTick: 0, eligible: false, rejection: 'INVALID_FRAME', costs,
      halfCosts: costs.map(line => ({ ...line, quantity: 3 })), remainingCosts: costs.map(line => ({ ...line, quantity: 3 })),
      requiredTicks: 400, researchGate: null, dueCalendarTick: null };
  }
  return previewSectUpgradeV10(frame, context, buildingId, workerId);
}
