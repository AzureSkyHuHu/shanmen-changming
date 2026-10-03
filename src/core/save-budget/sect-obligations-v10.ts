import { resolveSectCatalogIdentity } from '../../content/sect-v9/catalog';
import { isManagementV10Identity } from '../../content/sect-v10/world-content';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../sect-expansion/upgrade-types';
import { canonicalUtf8ByteLength } from './canonical-bytes';
import { deriveSectRecordObligations, type SectObligationAssessmentV9, type SectRecordMeasureV9,
  type SectReservationV9 } from './sect-obligations-v9';
import { deriveSectUpgradeObligationsV10, type SectUpgradeObligationAssessmentV10,
  type SectUpgradeOwnerBoundV10 } from './upgrade-obligations-v10';

export type SectReservationV10 = SectReservationV9 | (SectUpgradeOwnerBoundV10 & {
  readonly kind: 'upgrade'; readonly id: string; readonly workerId: string;
});
export interface SectObligationTotalsV10 extends SectRecordMeasureV9 {
  readonly rows: SectReservationV9['rows'] & { readonly upgradeJobs: number; readonly upgradeReceipts: number };
  readonly counters: SectReservationV9['counters'] & { readonly upgradeRevisions: number; readonly upgradeNextId: number };
}
export interface SectObligationAssessmentV10 {
  readonly scope: 'sect-v10-record-peaks-and-immediate-recovery';
  readonly admitted: false;
  readonly importAuthorized: false;
  readonly eventualCompletionSupported: false;
  readonly supported: boolean;
  /** Each leaf is derived internally from the same actual full World. */
  readonly existing: SectObligationAssessmentV9 | null;
  readonly upgrade: SectUpgradeObligationAssessmentV10 | null;
  readonly owners: readonly SectReservationV10[];
  /** Each leaf's shared width is already included here exactly once. */
  readonly totals: SectObligationTotalsV10;
  /** Informational subtotal only; never add this to totals again. */
  readonly shared: SectRecordMeasureV9;
  readonly unknowns: readonly string[];
  readonly excluded: readonly string[];
}

const METRICS = ['bytes', 'decodedCharacters', 'decodedNodes'] as const;
const zero = (): SectRecordMeasureV9 => ({ bytes: 0, decodedCharacters: 0, decodedNodes: 0 });
const emptyTotals = (): SectObligationTotalsV10 => ({ ...zero(),
  rows: { constructionJobs: 0, constructionBuildings: 0, constructionReceipts: 0, productionReceipts: 0,
    researchReceipts: 0, careReceipts: 0, pairedClaims: 0, upgradeJobs: 0, upgradeReceipts: 0 },
  counters: { constructionRevision: 0, productionRevision: 0, researchRevision: 0, careRevision: 0,
    cultivationRevision: 0, constructionNextId: 0, navVersion: 0, upgradeRevisions: 0, upgradeNextId: 0 },
});
function sum(a: number, b: number): number {
  if (![a, b].every(value => Number.isSafeInteger(value) && value >= 0) || a > Number.MAX_SAFE_INTEGER - b) {
    throw new RangeError('Sect v10 sizing exceeds finite safe range');
  }
  return a + b;
}
function sumMeasures(a: SectRecordMeasureV9, b: SectRecordMeasureV9): SectRecordMeasureV9 {
  const result = zero(); for (const key of METRICS) result[key] = sum(a[key], b[key]); return result;
}
const EXCLUDED = Object.freeze([
  'This is structural sect sizing only, not complete World provenance, owner closure, valid gameplay, save/import or command admission',
  'Whole-v10 envelope bytes, reader limits, progression/teaching/lifecycle headroom and exact terminal discharge remain unimplemented here',
  'Leaf shared-width subtotals are already charged in totals; existing complete records and terminal history are not reclaimed',
  'Synthetic independent field maxima are not reachable game states, payment evidence, L2 provenance or authority',
  'Optional new starts/maintenance, unbounded waiting and eventual completion require separate full-candidate checks',
]);

/** Fixed new wrapper only: no relabelled v9 World, filtered book, certificate,
 * caller policy, supplied measurement or validation callback. Ordinary descriptor
 * errors fail before typed reads; this does not promise hostile-Proxy capture or
 * replace the enclosing root's bounded complete-source validation.
 *
 * Six owner kinds are planned-blueprint/construction/production/research/care/
 * upgrade. The actual full World is passed unchanged to both structural leaves. */
export function deriveSectReservationsV10(world: WorldStateV10): SectObligationAssessmentV10 {
  let existing: SectObligationAssessmentV9 | null = null;
  let upgrade: SectUpgradeObligationAssessmentV10 | null = null;
  const unsupported = (unknowns: readonly string[]): SectObligationAssessmentV10 => ({
    scope: 'sect-v10-record-peaks-and-immediate-recovery', admitted: false, importAuthorized: false,
    eventualCompletionSupported: false, supported: false, existing, upgrade,
    owners: [], totals: emptyTotals(), shared: zero(), unknowns, excluded: EXCLUDED,
  });
  try {
    canonicalUtf8ByteLength(world);
    const protocol = MANAGEMENT_V10_PROTOCOL;
    const records = world.sectExpansion;
    if (world.simulationVersion !== protocol.simulationVersion || world.runtimeProtocol !== protocol.runtimeProtocol
      || world.contentVersion !== protocol.contentVersion || !isManagementV10Identity(world.contentIdentity)
      || records.schemaVersion !== protocol.sectSchemaVersion
      || records.construction.schemaVersion !== 1
      || !resolveSectCatalogIdentity(records.construction.catalogIdentity)
      || records.upgrade.schemaVersion !== protocol.upgradeSchemaVersion || records.upgrade.protocol !== protocol.upgradeProtocol
      || !resolveSectCatalogIdentity(records.upgrade.catalogIdentity)) return unsupported(['Unsupported internal v10 record identity']);

    existing = deriveSectRecordObligations(world);
    upgrade = deriveSectUpgradeObligationsV10(world);
    if (!existing.supported || !upgrade.supported) return unsupported([...existing.unknowns, ...upgrade.unknowns]);
    const upgradeOwners: SectReservationV10[] = upgrade.owners.map(owner => {
      const job = records.upgrade.jobs.find(job => job.jobId === owner.jobId);
      if (!job) throw new TypeError('Missing derived upgrade sizing owner');
      return { ...owner, kind: 'upgrade', id: owner.jobId, workerId: job.workerId };
    });
    const local = existing.totals; const added = upgrade.totals;
    const totals: SectObligationTotalsV10 = {
      // Upgrade totals ALREADY include upgrade.shared. Do not add it a second time.
      ...sumMeasures(local, added),
      rows: { ...local.rows, constructionBuildings: sum(local.rows.constructionBuildings, added.rows.buildings),
        pairedClaims: sum(local.rows.pairedClaims, added.rows.pairedClaims),
        upgradeJobs: added.rows.upgradeJobs, upgradeReceipts: added.rows.upgradeReceipts },
      counters: { ...local.counters, navVersion: sum(local.counters.navVersion, added.counters.navVersion),
        upgradeRevisions: added.counters.upgradeRevisions, upgradeNextId: added.counters.upgradeNextId },
    };
    return { scope: 'sect-v10-record-peaks-and-immediate-recovery', admitted: false, importAuthorized: false,
      eventualCompletionSupported: false, supported: true, existing, upgrade,
      owners: [...existing.owners, ...upgradeOwners], totals, shared: sumMeasures(existing.shared, upgrade.shared),
      unknowns: [], excluded: EXCLUDED };
  } catch {
    // Do not inspect a caller-thrown object or potentially hostile Error.message.
    return unsupported(['Unsupported v10 sect sizing source; complete v10 validation is required']);
  }
}
