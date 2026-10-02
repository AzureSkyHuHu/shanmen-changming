import { CALENDAR_TICKS_PER_MONTH, isPaused } from '../kernel/clock';
import type { CommandV9 } from '../kernel/contracts-v9';
import { assertNonNegativeInteger, checkedAdd } from '../kernel/numeric';
import { assessManagementCapacityV9, type ManagementCapacityV9 } from './management-capacity-v9';
import { advanceCapacityLimitedTicksV9, type CapacityLimitedAdvanceV9 } from './runtime-capacity-v9';
import { V9_CULTIVATION_CLOCK_LIMIT } from './v9-cultivation-clock-types';
import type { WorldStateV9 } from './v9-types';

export interface IdleCapacityLimitedAdvanceV9 extends CapacityLimitedAdvanceV9 {
  metrics: CapacityLimitedAdvanceV9['metrics'] & {
    /** Successful exact scalar queries, not whole-source authentication. */
    fastQueries: number;
  };
}

/** Deliberately NOT a ManagementCapacityV9: carried reserves can overestimate
 * current obligations and must never be used in a reserved-release comparison. */
interface CarriedIdleCapacity {
  current: Record<string, number>;
  readonly reserved: Readonly<Record<string, number>>;
  readonly limits: Readonly<Record<string, number>>;
}
const MAX = Number.MAX_SAFE_INTEGER;
const SCALARS = ['simulationTick', 'calendarTick', 'sect.constructionRevision', 'sect.productionRevision', 'sect.researchRevision'] as const;
const CLOCK_FIELDS: readonly string[] = ['simulationTick', 'calendarTick', 'encounterTick', 'mode', 'speed', 'pauseReasons'];

/** Snapshot data descriptors, never supplied property getters. A caller can use
 * Proxy reflection traps to mutate other caller objects during this walk; every
 * resulting detached snapshot is nevertheless validated in full. No claim to
 * identify all Proxies or atomically snapshot external mutable objects is made.
 * Capturing World BEFORE commands means command reflection cannot replace a
 * previously checked World field with an accessor before it is copied. */
function detachData<T>(value: T): T {
  const active = new WeakSet<object>();
  function copy(value: unknown): unknown {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
    if (typeof value !== 'object' || value === null || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
      throw new TypeError('Expected finite data-only JSON');
    }
    if (active.has(value)) throw new TypeError('Cyclic JSON cannot be measured');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
    let result: unknown;
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
        throw new TypeError('Expected a plain dense JSON array');
      }
      const array: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected a dense data-only JSON array');
        array.push(copy(descriptor.value));
      }
      result = array;
    } else {
      const object: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== 'string' || !descriptors[key]!.enumerable) throw new TypeError('Expected ordinary enumerable JSON properties');
        const descriptor = descriptors[key]!;
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessors cannot be measured or cached');
        Object.defineProperty(object, key, { value: copy(descriptor.value), enumerable: true, writable: true, configurable: true });
      }
      result = object;
    }
    active.delete(value); return result;
  }
  return copy(value) as T;
}

/** Only called on this invocation's JSON clone and newly allocated spines. The
 * private set establishes ownership; Object.isFrozen(external) grants no trust.
 * There is no persistent World/counter cache and no borrowed archive reference. */
function ownFrozenTree(value: unknown, owned: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || owned.has(value)) return;
  for (const key of Object.keys(value)) ownFrozenTree((value as Record<string, unknown>)[key], owned);
  Object.freeze(value); owned.add(value);
}

/** This proof is deliberately tied to the current .3 normal preparation:
 * clock +1; no cultivation transition; no planner/payment; three idle sect
 * revisions +1; no work. composeV9SectFrame only copies unchanged positions
 * and writes traveling=false, so already-false traveling is mandatory. */
function worldMayBeScalarIdle(world: WorldStateV9): boolean {
  // The strict validator currently preserves some nested clock extensions.
  // They remain legal there; unknown shape only excludes this narrow fast path.
  if (Object.keys(world.clock).length !== CLOCK_FIELDS.length || Object.keys(world.clock).some(key => !CLOCK_FIELDS.includes(key))) return false;
  if (world.runtimeProtocol !== 'fresh-management-v9-unregistered.3' || world.clock.mode !== 'management'
    || isPaused(world.clock) || world.pendingCommands.length || world.expedition.run !== null
    || world.activeProductionTransactionIds.length || Object.keys(world.automaticProduction.live).length
    || world.cultivation.pendingDeaths.length || world.builds.disciples.some(actor => actor.lock !== null)
    || world.cultivationClock.transitions.length >= V9_CULTIVATION_CLOCK_LIMIT) return false;
  if (world.cultivation.disciples.some(actor => actor.lifeState !== 'alive' || actor.activeAttemptId !== null
      || actor.teaching !== null || actor.activityOwner !== null || actor.pendingDeathId !== null)
    || world.disciples.some(actor => actor.traveling || actor.assignmentTransactionId !== null)) return false;
  const records = world.sectExpansion;
  if (records.construction.blueprints.some(bp => bp.status === 'planned')
    || records.construction.jobs.some(job => job.terminal === null) || records.production.jobs.some(job => job.terminal === null)
    || records.research.jobs.some(job => job.terminal === null) || records.care.jobs.some(job => job.terminal === null)) return false;
  const scalars = [world.clock.simulationTick, world.clock.calendarTick, records.construction.revision, records.production.revision, records.research.revision];
  // Stay out of all existing terminal/navigation/maintenance headroom edges;
  // the strict implementation retains their precise rejection ordering.
  if (scalars.some(value => !Number.isSafeInteger(value) || value < 0 || value > MAX - CALENDAR_TICKS_PER_MONTH)) return false;
  const tick = world.clock.simulationTick + 1; const calendar = world.clock.calendarTick + 1;
  if (world.sectEconomy.enabled && !world.automaticProduction.activationReviewRequired && tick >= world.sectEconomy.nextDecisionTick) return false;
  if (Math.floor(calendar / CALENDAR_TICKS_PER_MONTH) !== world.cultivation.calendarMonth) return false;
  for (const actor of world.disciples) {
    const profile = world.cultivation.disciples.find(profile => profile.discipleId === actor.id);
    if (!profile) return false;
    try {
      if (Math.floor(checkedAdd(calendar, -actor.birthCalendarTick) / CALENDAR_TICKS_PER_MONTH) !== profile.ageMonths) return false;
    } catch { return false; }
  }
  for (const building of records.construction.buildings) {
    const latest = records.maintenance.payments.filter(payment => payment.buildingId === building.buildingId).at(-1);
    if (calendar >= (latest?.dueCalendarTick ?? building.firstMaintenanceCalendarTick)) return false;
  }
  return true;
}

function scalarIdleEligible(world: WorldStateV9, source: ManagementCapacityV9): boolean {
  // Unchanging lifecycle obligations are allowed. Committed progression and any
  // planned owner are outside this slice, even if their next work is not due.
  return worldMayBeScalarIdle(world) && source.progression !== null && source.sect !== null && source.clock !== null
    && source.clock.calendarTicks === 0 && source.progression.owners.every(owner => owner.kind === 'disciple-lifecycle')
    && source.sect.owners.length === 0;
}

/** Exactly five nonnegative JSON integers change. Decimal JSON widths are their
 * UTF-8 byte widths (also at 9→10/99→100); no strings, node counts or row counts
 * change. Progression/sect shared-width reserves can only decrease here. Keep
 * the old, larger reserves rather than inventing a release of those margins. */
function carryScalarTick(capacity: CarriedIdleCapacity): CarriedIdleCapacity | null {
  const current = { ...capacity.current }; let bytes = 0;
  for (const name of SCALARS) {
    const prior = current[name];
    if (!Number.isSafeInteger(prior) || prior! < 0 || prior! >= MAX) return null;
    const next = prior! + 1;
    bytes += JSON.stringify(next).length - JSON.stringify(prior).length;
    current[name] = next;
  }
  if (!Number.isSafeInteger(current.wireBytes) || current.wireBytes! > MAX - bytes) return null;
  current.wireBytes! += bytes;
  for (const [name, value] of Object.entries(current)) {
    const reserve = capacity.reserved[name]; const limit = capacity.limits[name];
    if (![value, reserve, limit].every(value => Number.isSafeInteger(value) && value! >= 0)
      || reserve! > limit! || value > limit! - reserve!) return null;
  }
  return { current, reserved: capacity.reserved, limits: capacity.limits };
}

function scalarTick(world: WorldStateV9): WorldStateV9 {
  const records = world.sectExpansion;
  return { ...world, clock: { ...world.clock, simulationTick: world.clock.simulationTick + 1, calendarTick: world.clock.calendarTick + 1 },
    sectExpansion: { ...records,
      construction: { ...records.construction, revision: records.construction.revision + 1 },
      production: { ...records.production, revision: records.production.revision + 1 },
      research: { ...records.research, revision: records.research.revision + 1 } } };
}

/** Additive, unregistered batch experiment. Every external call freshly checks
 * descriptors and complete source records; caller objects are never frozen.
 * Commands, unknown transitions and every uncertain capacity boundary use the
 * unchanged strict oracle. In particular strict fallback freshly assesses its
 * source, so a conservative carried vector can NEVER authorize deficit release.
 * This is not a session, import capability, active-work cache or 20Hz promise. */
export function advanceIdleCapacityLimitedTicksV9(world: WorldStateV9, steps: number, commands: readonly CommandV9[] = []): IdleCapacityLimitedAdvanceV9 {
  assertNonNegativeInteger(steps, 'steps');
  let fullQueries = 0; let fastQueries = 0;
  let detachedCommands: readonly CommandV9[] = [];
  const strict = (boundary: WorldStateV9, remaining: number): IdleCapacityLimitedAdvanceV9 => {
    const result = advanceCapacityLimitedTicksV9(boundary, remaining, detachedCommands);
    return { ...result,
      // The private clone is not a publication when no tick/command succeeded.
      world: fastQueries === 0 && result.world === boundary ? world : result.world,
      metrics: { ...result.metrics, fullQueries: fullQueries + result.metrics.fullQueries, fastQueries } };
  };
  let owned: WorldStateV9; let assessment: ManagementCapacityV9;
  try {
    owned = detachData(world); detachedCommands = detachData(commands);
  } catch {
    // Reflection traps can throw arbitrary hostile values, including Errors
    // whose message getter throws or Proxies with a getPrototypeOf trap. Do not
    // inspect the exception or send the hostile original through strict again.
    return { world, stopped: { kind: 'invalid-records', details: ['Invalid external v9 JSON data'] }, commandResults: [],
      metrics: { fullQueries, normalCandidates: 0, noOptionalCandidates: 0, fastQueries } };
  }
  if (!Array.isArray(detachedCommands) || detachedCommands.length) return strict(owned, steps);
  // Performance-only negative probe on detached data. Passing this probe grants
  // NO authority: complete source validation and capacity assessment follow.
  // Missing/malformed fields or definite work/clock edges go straight to strict
  // without imposing an additional full query on every active-work call.
  try { if (!worldMayBeScalarIdle(owned)) return strict(owned, steps); }
  catch { return strict(owned, steps); }
  try {
    fullQueries++;
    assessment = assessManagementCapacityV9(owned);
    if (!assessment.supported || !assessment.fits || !scalarIdleEligible(owned, assessment)) return strict(owned, steps);
  } catch { return strict(owned, steps); }
  // Assess while the clone is mutable; no imported/frozen caller object enters
  // an incremental cache. Only now claim and recursively freeze our own tree.
  const ownership = new WeakSet<object>(); ownFrozenTree(owned, ownership);
  let capacity: CarriedIdleCapacity = { current: { ...assessment.current }, reserved: assessment.reserved, limits: assessment.limits };
  for (let index = 0; index < steps; index++) {
    if (!scalarIdleEligible(owned, assessment)) return strict(owned, steps - index);
    const nextCapacity = carryScalarTick(capacity);
    if (!nextCapacity) return strict(owned, steps - index);
    const candidate = scalarTick(owned);
    ownFrozenTree(candidate, ownership);
    owned = candidate; capacity = nextCapacity; fastQueries++;
  }
  return { world: fastQueries ? owned : world, stopped: null, commandResults: [],
    metrics: { fullQueries, normalCandidates: 0, noOptionalCandidates: 0, fastQueries } };
}
