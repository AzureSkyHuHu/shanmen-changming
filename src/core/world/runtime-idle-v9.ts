import type { CommandV9 } from '../kernel/contracts-v9';
import { assertNonNegativeInteger } from '../kernel/numeric';
import { assessManagementCapacityV9, type ManagementCapacityV9 } from './management-capacity-v9';
import { advanceCapacityLimitedTicksV9, type CapacityLimitedAdvanceV9 } from './runtime-capacity-v9';
import { detachData, ownFrozenTree, worldMayBeScalarIdle, scalarIdleEligible, carryScalarTick, scalarTick, type CarriedIdleCapacity } from './runtime-owned-internals-v9';
import type { WorldStateV9 } from './v9-types';

export interface IdleCapacityLimitedAdvanceV9 extends CapacityLimitedAdvanceV9 {
  metrics: CapacityLimitedAdvanceV9['metrics'] & {
    /** Successful exact scalar queries, not whole-source authentication. */
    fastQueries: number;
  };
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
