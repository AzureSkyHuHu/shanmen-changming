import type { SectStock } from '../../content/sect-v9/types';
import type { ConstructionFrame } from './construction-types';
import type { SectLedgerReservation } from './ledger';
import type { SectMaintenanceState } from './maintenance-types';
import type { SectProductionState } from './production-types';
import type { SectResearchState } from './research-types';

/** Candidate ownership contract, not a registered World/save schema. The live map, people,
 * cultivation, clocks, base inventory and legacy sites belong exclusively to World. Domain
 * historical timestamps remain evidence; no second current-clock or spatial snapshot is saved. */
export interface SectExpansionOwnedRecords {
  readonly schemaVersion: 1;
  readonly construction: Pick<ConstructionFrame, 'schemaVersion' | 'catalogIdentity' | 'revision' | 'nextId'
    | 'blueprints' | 'jobs' | 'buildings' | 'receipts'>;
  readonly stock: SectStock;
  readonly reservations: readonly SectLedgerReservation[];
  readonly production: SectProductionState;
  readonly research: SectResearchState;
  readonly maintenance: SectMaintenanceState;
}
