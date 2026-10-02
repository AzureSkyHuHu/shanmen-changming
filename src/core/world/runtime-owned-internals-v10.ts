/** INTERNAL owned idle leaf only. Never re-export from an application, kernel or
 * codec barrel. A carried value is not source admission or a discharge proof. */
import { isManagementV10Identity } from '../../content/sect-v10/world-content';
import { CALENDAR_TICKS_PER_MONTH, isPaused } from '../kernel/clock';
import { checkedAdd, isNonNegativeInteger } from '../kernel/numeric';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../sect-expansion/upgrade-types';
import { assessManagementCapacityV10, type ManagementCapacityV10 } from './management-capacity-v10';
import { captureV10RecordData } from './v10-sect-records';
import { V9_CULTIVATION_CLOCK_LIMIT } from './v9-cultivation-clock-types';

/** Deliberately NOT ManagementCapacityV10. Reserves may be larger than the next
 * exact query, and cannot be spent as recovery credit or terminal discharge. */
export interface CarriedIdleCapacityV10 {
  readonly kind: 'owned-v10-scalar-idle';
  readonly current: Readonly<Record<string, number>>;
  readonly reserved: Readonly<Record<string, number>>;
  readonly limits: Readonly<Record<string, number>>;
}
export interface OwnedIdleBoundaryV10 {
  readonly world: WorldStateV10;
  readonly capacity: CarriedIdleCapacityV10;
}
export interface CapturedIdleBoundaryV10 extends OwnedIdleBoundaryV10 {
  /** Exact only for this captured source, never for subsequently carried roots. */
  readonly assessment: ManagementCapacityV10;
}
export interface OwnedIdleLeafV10 {
  /** Always detach and fully assess, including another leaf's frozen output.
   * A failed capture clears the old cursor and requests ordinary strict work. */
  capture(input: unknown): CapturedIdleBoundaryV10 | null;
  /** No candidate, assessment, callback, stop flag or purported owner is accepted.
   * null means strict fallback; the retained complete boundary stays unchanged. */
  advance(): OwnedIdleBoundaryV10 | null;
  clear(): void;
}

const MAX = Number.MAX_SAFE_INTEGER;
const STORED_SCALARS = ['simulationTick', 'calendarTick', 'sect.constructionRevision', 'sect.productionRevision', 'sect.researchRevision'] as const;
const CLOCK_FIELDS: readonly string[] = ['simulationTick', 'calendarTick', 'encounterTick', 'mode', 'speed', 'pauseReasons'];
const elapsedDimension = (name: string): boolean => /^birthday\..+\.(?:elapsedTicks|archivedElapsedTicks)$/.test(name);

/** This is a rejecting prefilter on an OWNED descriptor snapshot, never an
 * admission predicate. The full fixed v10 query must additionally succeed. */
function idleShape(world: WorldStateV10): boolean {
  const protocol = MANAGEMENT_V10_PROTOCOL;
  if (world.simulationVersion !== protocol.simulationVersion || world.runtimeProtocol !== protocol.runtimeProtocol
    || world.contentVersion !== protocol.contentVersion || !isManagementV10Identity(world.contentIdentity)) return false;
  // Some nested clock extensions are legal to the strict inspector. They remain
  // legal there; an unknown shape simply does not enter this fixed scalar proof.
  if (Object.keys(world.clock).length !== CLOCK_FIELDS.length || Object.keys(world.clock).some(key => !CLOCK_FIELDS.includes(key))) return false;
  if (world.clock.mode !== 'management' || isPaused(world.clock) || world.pendingCommands.length || world.expedition.run !== null
    || world.activeProductionTransactionIds.length || Object.keys(world.automaticProduction.live).length
    || Object.values(world.transactions).some(job => job.state === 'Running' || job.state === 'Blocked')
    || world.cultivation.pendingDeaths.length || world.builds.disciples.some(member => member.lock !== null)
    || world.cultivationClock.transitions.length >= V9_CULTIVATION_CLOCK_LIMIT) return false;
  if (world.cultivation.disciples.some(member => member.lifeState !== 'alive' || member.activeAttemptId !== null
      || member.teaching !== null || member.activityOwner !== null || member.pendingDeathId !== null)
    || world.disciples.some(actor => actor.traveling || actor.assignmentTransactionId !== null)) return false;
  const records = world.sectExpansion;
  if (records.construction.blueprints.some(plan => plan.status === 'planned')
    || records.construction.jobs.some(job => job.terminal === null) || records.production.jobs.some(job => job.terminal === null)
    || records.research.jobs.some(job => job.terminal === null) || records.care.jobs.some(job => job.terminal === null)
    || records.upgrade.jobs.some(job => job.terminal === null)) return false;
  const scalars = [world.clock.simulationTick, world.clock.calendarTick, records.construction.revision,
    records.production.revision, records.research.revision];
  // Leave all near-MAX navigation, maintenance and terminal rejection ordering
  // to the strict path; this narrower window is an exclusion, not a new limit.
  if (scalars.some(value => !isNonNegativeInteger(value) || value > MAX - CALENDAR_TICKS_PER_MONTH)) return false;
  const tick = world.clock.simulationTick + 1; const calendar = world.clock.calendarTick + 1;
  if (world.sectEconomy.enabled && !world.automaticProduction.activationReviewRequired && tick >= world.sectEconomy.nextDecisionTick) return false;
  if (Math.floor(calendar / CALENDAR_TICKS_PER_MONTH) !== world.cultivation.calendarMonth) return false;
  for (const actor of world.disciples) {
    const profile = world.cultivation.disciples.find(member => member.discipleId === actor.id);
    if (!profile || Math.floor(checkedAdd(calendar, -actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH) !== profile.ageMonths) return false;
  }
  for (const building of records.construction.buildings) {
    // The origin remains L1 after upgrade. The last ACTUAL payment, including an
    // L2-tagged one, owns expiry; never derive a fresh period from origin.level.
    const latest = records.maintenance.payments.filter(payment => payment.buildingId === building.buildingId).at(-1);
    if (calendar >= (latest?.dueCalendarTick ?? building.firstMaintenanceCalendarTick)) return false;
  }
  return true;
}
function eligibleAssessment(value: ManagementCapacityV10): boolean {
  return value.supported && value.fits && value.actualFits && value.sourceRecordIssues.length === 0 && value.unknowns.length === 0
    && value.deficits.length === 0 && value.progression !== null && value.progression.supported
    && value.progression.owners.every(owner => owner.kind === 'disciple-lifecycle')
    && value.sect !== null && value.sect.supported && value.sect.owners.length === 0
    && value.clock !== null && value.clock.supported && value.clock.calendarTicks === 0;
}
function operandsFit(capacity: CarriedIdleCapacityV10): boolean {
  const names = Object.keys(capacity.current);
  if (!names.length || Object.keys(capacity.reserved).length !== names.length || Object.keys(capacity.limits).length !== names.length) return false;
  return names.every(name => Object.hasOwn(capacity.reserved, name) && Object.hasOwn(capacity.limits, name)
    && isNonNegativeInteger(capacity.current[name]) && isNonNegativeInteger(capacity.reserved[name]) && isNonNegativeInteger(capacity.limits[name])
    && capacity.reserved[name]! <= capacity.limits[name]!
    && capacity.current[name]! <= capacity.limits[name]! - capacity.reserved[name]!);
}

/** Arithmetic only, intentionally accepts no World and confers no authority.
 * Production ownership never accepts the result of a caller's invocation.
 * Only five stored integers incur decimal wire growth. Birthday elapsed values
 * are derived capacity dimensions: increment and check them WITHOUT wire charge.
 * All other current dimensions/limits stay exact. With no finite progression or
 * sect owner, only shared-width reserves can change, and they cannot increase. */
export function carryScalarCapacityV10(capacity: CarriedIdleCapacityV10): CarriedIdleCapacityV10 | null {
  if (!operandsFit(capacity)) return null;
  const current = { ...capacity.current }; let bytes = 0;
  for (const name of STORED_SCALARS) {
    const prior = current[name];
    if (!isNonNegativeInteger(prior) || prior >= MAX) return null;
    current[name] = prior + 1;
    bytes += String(prior + 1).length - String(prior).length;
  }
  for (const name of Object.keys(current)) if (elapsedDimension(name)) {
    const prior = current[name]!;
    if (!isNonNegativeInteger(prior) || prior >= MAX) return null;
    current[name] = prior + 1;
  }
  if (!isNonNegativeInteger(current.wireBytes) || current.wireBytes > MAX - bytes) return null;
  current.wireBytes += bytes;
  const next: CarriedIdleCapacityV10 = { kind: 'owned-v10-scalar-idle', current: Object.freeze(current),
    reserved: capacity.reserved, limits: capacity.limits };
  return operandsFit(next) ? Object.freeze(next) : null;
}
function scalarTick(world: WorldStateV10): WorldStateV10 {
  const records = world.sectExpansion;
  return { ...world, clock: { ...world.clock, simulationTick: world.clock.simulationTick + 1, calendarTick: world.clock.calendarTick + 1 },
    sectExpansion: { ...records,
      construction: { ...records.construction, revision: records.construction.revision + 1 },
      production: { ...records.production, revision: records.production.revision + 1 },
      research: { ...records.research, revision: records.research.revision + 1 } } };
}

/** Per-runtime private ownership. Only descriptor capture and this fixed producer
 * can install roots. External Object.isFrozen, structural equality, diagnostics,
 * borrowed methods and objects from another factory never establish ownership.
 * The enclosing runtime must bind its exact root/generation to this cursor, call
 * only when there is no latched stop, and clear on commands/control/replacement/
 * invalidation/close. The leaf neither publishes, sets stops, nor handles recovery.
 * Non-idle source/teaching admission remains the existing strict runtime's job. */
export function createOwnedIdleLeafV10(): OwnedIdleLeafV10 {
  let root: WorldStateV10 | null = null; let capacity: CarriedIdleCapacityV10 | null = null; let busy = false;
  const owned = new WeakSet<object>();
  function freezeOwned(value: unknown): void {
    if (value === null || typeof value !== 'object' || owned.has(value)) return;
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value); owned.add(value);
  }
  return Object.freeze({
    capture(input: unknown): CapturedIdleBoundaryV10 | null {
      if (busy) return null;
      busy = true; root = null; capacity = null;
      try {
        const world = captureV10RecordData(input) as WorldStateV10;
        if (!idleShape(world)) return null;
        const assessment = assessManagementCapacityV10(world);
        if (!eligibleAssessment(assessment)) return null;
        const initial: CarriedIdleCapacityV10 = { kind: 'owned-v10-scalar-idle', current: { ...assessment.current },
          reserved: { ...assessment.reserved }, limits: { ...assessment.limits } };
        if (!operandsFit(initial)) return null;
        freezeOwned(world); freezeOwned(initial); freezeOwned(assessment);
        root = world; capacity = initial;
        return Object.freeze({ world, capacity: initial, assessment });
      } catch { return null; }
      finally { busy = false; }
    },
    advance(): OwnedIdleBoundaryV10 | null {
      if (busy || root === null || capacity === null) return null;
      busy = true;
      try {
        if (!owned.has(root) || !idleShape(root)) return null;
        const carried = carryScalarCapacityV10(capacity);
        if (carried === null) return null;
        const world = scalarTick(root); freezeOwned(world);
        const result = Object.freeze({ world, capacity: carried });
        root = world; capacity = carried; return result;
      } catch { return null; }
      finally { busy = false; }
    },
    clear(): void { if (!busy) { root = null; capacity = null; } },
  });
}
