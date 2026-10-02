/** INTERNAL per-runtime actual-tick pipeline. Never re-export from application,
 * kernel, save or codec barrels. Returned data is not a reusable certificate. */
import { isPaused } from '../kernel/clock';
import { prepareNoOptionalGrowthTickCandidateV10, prepareNormalTickCandidateV10 } from '../kernel/simulation-v10';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { assessManagementCapacityV10, type ManagementCapacityV10 } from './management-capacity-v10';
import { inspectReservedDischargeRecordsV10 } from './reserved-discharges-v10';
import { actualDimensionsFitV10, hasTeachingV10 } from './teaching-continuation-v10';
import { captureV10RecordData } from './v10-sect-records';

export interface OwnedTickBoundaryV10 {
  /** Deeply frozen descriptor snapshot owned by this factory. */
  readonly world: WorldStateV10;
  /** Exact for this world, deeply frozen, never a carried idle estimate. */
  readonly assessment: ManagementCapacityV10;
  /** Informational only. No method accepts this value back as authority. */
  readonly diagnostic: {
    readonly kind: 'owned-v10-actual-tick';
    readonly preparation: 'capture' | 'normal' | 'no-optional-growth';
    readonly sourceSimulationTick: number;
    readonly simulationTick: number;
  };
}
export interface OwnedTickPipelineV10 {
  /** Always detach and fully validate/assess, including foreign frozen outputs.
   * An unsuccessful replacement clears the cursor rather than reusing old work. */
  capture(input: unknown): OwnedTickBoundaryV10 | null;
  /** null requests the strict path; it never changes the retained boundary. */
  advanceNormal(): OwnedTickBoundaryV10 | null;
  /** Independently executes the fixed no-optional reducer on the retained source.
   * In particular a failed normal step cannot affect this preparation. */
  advanceNoOptional(): OwnedTickBoundaryV10 | null;
  clear(): void;
}

/** Full fixed query results only. Rechecking exact operands also makes explicit
 * that fitting wire bytes alone, or a supported recovery-only root, is not enough.
 * No recovery credits, monotonic deficits or owner-discharge evidence are used. */
function ordinaryAssessment(value: ManagementCapacityV10): boolean {
  if (!value.supported || !value.fits || !actualDimensionsFitV10(value)
    || value.sourceRecordIssues.length || value.unknowns.length || value.deficits.length) return false;
  const names = Object.keys(value.current);
  if (!names.length || Object.keys(value.reserved).length !== names.length
    || Object.keys(value.limits).length !== names.length || Object.keys(value.costs).length !== names.length) return false;
  return names.every(name => {
    const current = value.current[name]; const reserved = value.reserved[name]; const limit = value.limits[name];
    return Number.isSafeInteger(current) && current! >= 0 && Number.isSafeInteger(reserved) && reserved! >= 0
      && Number.isSafeInteger(limit) && limit! >= 0 && reserved! <= limit! && current! <= limit! - reserved!;
  });
}

/** The sole transition authority here is executing one of the actual fixed
 * reducers on this factory's own immutable source. There is NO supplied candidate,
 * trusted-source flag, callback, validator, budget, certificate or owner argument.
 * This removes redundant replay of an already executed ordinary tick, not its
 * complete record/capacity validation. Public arbitrary-candidate APIs retain
 * their independent complete replay and reserved-release/teaching checks.
 *
 * The enclosing runtime must bind the exact root AND its generation, call only
 * without a latched stop, and invalidate on commands/control/replace/close. This
 * leaf does not publish, handle commands, clear stops, save, import or recover. */
export function createOwnedTickPipelineV10(): OwnedTickPipelineV10 {
  let retained: OwnedTickBoundaryV10 | null = null; let busy = false;
  const owned = new WeakSet<object>();
  function freezeOwned(value: unknown): void {
    if (value === null || typeof value !== 'object' || owned.has(value)) return;
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value); owned.add(value);
  }
  function boundary(world: WorldStateV10, assessment: ManagementCapacityV10,
    preparation: OwnedTickBoundaryV10['diagnostic']['preparation'], sourceSimulationTick: number): OwnedTickBoundaryV10 {
    const result: OwnedTickBoundaryV10 = { world, assessment, diagnostic: {
      kind: 'owned-v10-actual-tick', preparation, sourceSimulationTick, simulationTick: world.clock.simulationTick,
    } };
    freezeOwned(result); return result;
  }
  function advance(preparation: 'normal' | 'no-optional-growth'): OwnedTickBoundaryV10 | null {
    if (busy || retained === null) return null;
    busy = true;
    try {
      const source = retained.world;
      if (!owned.has(source) || isPaused(source.clock) || hasTeachingV10(source)
        || !ordinaryAssessment(retained.assessment)) return null;
      const prepared = preparation === 'normal'
        ? prepareNormalTickCandidateV10(source) : prepareNoOptionalGrowthTickCandidateV10(source);
      if (prepared === source) return null;
      // Isolate even the real producer's output before assessment/publication.
      // Nothing, including failed paths, RNG or receipts, is installed early.
      const world = captureV10RecordData(prepared) as WorldStateV10;
      freezeOwned(world);
      const assessment = assessManagementCapacityV10(world);
      if (!ordinaryAssessment(assessment) || hasTeachingV10(world)
        || world.clock.simulationTick !== source.clock.simulationTick + 1
        || world.clock.calendarTick !== source.clock.calendarTick + 1) return null;
      // Endpoint fit alone does not replace the existing cross-boundary owner,
      // immutable-site, payment, work, terminal and lifecycle record comparisons.
      // Only redundant replay is omitted: this source's reducer just ran above.
      const records = inspectReservedDischargeRecordsV10(source, world);
      if (records.issues.length) return null;
      const result = boundary(world, assessment, preparation, source.clock.simulationTick);
      retained = result; return result;
    } catch { return null; }
    finally { busy = false; }
  }
  return Object.freeze({
    capture(input: unknown): OwnedTickBoundaryV10 | null {
      if (busy) return null;
      busy = true; retained = null;
      try {
        const world = captureV10RecordData(input) as WorldStateV10;
        freezeOwned(world);
        const assessment = assessManagementCapacityV10(world);
        if (!ordinaryAssessment(assessment) || hasTeachingV10(world)) return null;
        const result = boundary(world, assessment, 'capture', world.clock.simulationTick);
        retained = result; return result;
      } catch { return null; }
      finally { busy = false; }
    },
    advanceNormal(): OwnedTickBoundaryV10 | null { return advance('normal'); },
    advanceNoOptional(): OwnedTickBoundaryV10 | null { return advance('no-optional-growth'); },
    clear(): void { if (!busy) retained = null; },
  });
}
