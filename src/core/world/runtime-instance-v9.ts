import { restoreHistoryArchive } from '../history';
import { isPaused, setClockSpeed } from '../kernel/clock';
import { prepareUnregisteredCommandCandidateV9 } from '../kernel/commands-v9';
import { isNonNegativeInteger } from '../kernel/numeric';
import { prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9 } from '../kernel/simulation-v9';
import { assessTeachingManagementCapacityV9, type ManagementCapacityV9 } from './management-capacity-v9';
import type { CapacityLimitedAdvanceV9, CapacityLimitedResultV9, CandidateCapacityDecisionV9 } from './runtime-capacity-v9';
import { actualDimensionsFit, decision, refused, TEACHING_DETAIL } from './runtime-decision-v9';
import { carryScalarTick, detachData, ownFrozenTree, scalarIdleEligible, scalarTick, worldMayBeScalarIdle, type CarriedIdleCapacity } from './runtime-owned-internals-v9';
import { deficitDoesNotIncreaseV9, inspectTeachingContinuationV9 } from './teaching-continuation-v9';
import type { WorldStateV9 } from './v9-types';
import { nextRuntimeApplicationCommandV9, projectRuntimeBuildV9, projectRuntimeCultivationV9, projectRuntimeExpansionV9,
  projectRuntimeFrameV9, projectRuntimeBreakthroughV9, projectRuntimePlacementV9, validRuntimeBreakthroughQueryV9,
  validRuntimeClockControlV9, validRuntimeDiscipleQueryV9, validRuntimePlacementQueryV9 } from './runtime-views-v9';
import type { RuntimeApplicationCommandV9, RuntimeBreakthroughPreviewV9, RuntimeBuildViewV9, RuntimeClockResultV9,
  RuntimeCultivationViewV9, RuntimeExpansionViewV9, RuntimeFrameViewV9, RuntimePlacementPreviewV9,
  RuntimeReadV9, RuntimeReadonlyV9 } from './runtime-view-types-v9';

/** Internal experiment, deliberately absent from all public engine/codec barrels.
 * Stamps describe this instance's lifetime only; they are not transferable trust. */
export interface RuntimeStampV9 { readonly generation: number; readonly publication: number }
export interface RuntimeInstanceMetricsV9 {
  /** Top-level source/candidate capacity queries only. Excludes internal teaching
   * recovery assessments and reducer replays; never a total-cost measurement. */
  readonly fullQueries: number; readonly fastQueries: number;
  readonly normalCandidates: number; readonly noOptionalCandidates: number; readonly exports: number;
}
type Metrics = { -readonly [K in keyof RuntimeInstanceMetricsV9]: RuntimeInstanceMetricsV9[K] };
type Stop = NonNullable<CapacityLimitedAdvanceV9['stopped']>;
export type RuntimeInstanceErrorV9 = 'closed' | 'reentrant' | 'invalid-source' | 'invalid-command' | 'invalid-steps'
  | 'unsupported-continuation' | 'capacity' | 'snapshot-failed' | 'internal-failure'
  | 'invalid-query' | 'query-failed' | 'invalid-control';
export interface RuntimeOperationV9 {
  readonly ok: boolean; readonly error: RuntimeInstanceErrorV9 | null;
  readonly stamp: RuntimeStampV9; readonly stopped: Stop | null; readonly metrics: RuntimeInstanceMetricsV9;
}
export interface RuntimeAdvanceV9 extends RuntimeOperationV9 { readonly advancedTicks: number }
export interface RuntimeCommandV9 extends RuntimeOperationV9 { readonly published: boolean; readonly result: CapacityLimitedResultV9 | null }
export interface RuntimeSnapshotV9 extends RuntimeOperationV9 { readonly world: WorldStateV9 | null }
export interface RuntimeReplaceV9 extends RuntimeOperationV9 { readonly recoveryOnly: boolean | null }
export interface PrivateRuntimeInstanceV9 {
  advance(steps: number): RuntimeAdvanceV9;
  command(input: unknown): RuntimeCommandV9;
  replace(input: unknown): RuntimeReplaceV9;
  invalidate(): RuntimeOperationV9;
  snapshot(): RuntimeSnapshotV9;
  frame(): RuntimeReadV9<RuntimeFrameViewV9>;
  cultivation(discipleId: string | null): RuntimeReadV9<RuntimeCultivationViewV9>;
  build(discipleId: string | null): RuntimeReadV9<RuntimeBuildViewV9>;
  expansion(): RuntimeReadV9<RuntimeExpansionViewV9>;
  previewBreakthrough(input: unknown): RuntimeReadV9<RuntimeBreakthroughPreviewV9>;
  previewPlacement(input: unknown): RuntimeReadV9<RuntimePlacementPreviewV9>;
  nextApplicationCommand(start: number): RuntimeReadV9<RuntimeApplicationCommandV9>;
  controlClock(input: unknown): RuntimeClockResultV9;
  close(): RuntimeOperationV9;
}
export type RuntimeCreationV9 =
  | { readonly ok: true; readonly instance: PrivateRuntimeInstanceV9; readonly recoveryOnly: boolean; readonly metrics: RuntimeInstanceMetricsV9 }
  | { readonly ok: false; readonly error: RuntimeInstanceErrorV9; readonly stopped: Stop; readonly metrics: RuntimeInstanceMetricsV9 };

declare const privateWorld: unique symbol;
type PrivateWorld = WorldStateV9 & { readonly [privateWorld]: true };
/** Exact assessments can only describe their own root in their own generation. */
interface StrictAnchor { readonly root: PrivateWorld; readonly generation: number; readonly assessment: ManagementCapacityV9 }
/** Never assignable to StrictAnchor or ManagementCapacityV9, never used for
 * reserved discharge. Eligibility was proved at an exact root, then preserved
 * solely by the five-scalar transition. This object is never caller-supplied. */
interface IdleCarry { readonly root: PrivateWorld; readonly generation: number; readonly capacity: CarriedIdleCapacity }
const freshMetrics = (): Metrics => ({ fullQueries: 0, fastQueries: 0, normalCandidates: 0, noOptionalCandidates: 0, exports: 0 });
const immutable = <T>(value: T): T => { ownFrozenTree(value, new WeakSet<object>()); return value; };
const invalidStop = (): Stop => ({ kind: 'invalid-records', details: ['Invalid external v9 JSON data'] });
const capacityStop = (): Stop => ({ kind: 'capacity', details: ['Actual complete-boundary hard limit exceeded'] });
function sourceFailure(world: WorldStateV9, assessment: ManagementCapacityV9): { error: RuntimeInstanceErrorV9; stopped: Stop } | null {
  if (!assessment.supported) return { error: 'invalid-source', stopped: { kind: 'invalid-records', details: [...assessment.sourceRecordIssues, ...assessment.unknowns] } };
  const teaching = inspectTeachingContinuationV9(world, assessment);
  if (!teaching.supported) return { error: 'unsupported-continuation', stopped: { kind: 'unsupported-continuation', details: [TEACHING_DETAIL, ...teaching.unknowns] } };
  if (!actualDimensionsFit(assessment)) return { error: 'capacity', stopped: capacityStop() };
  return null;
}
type Prepared = { ok: true; root: PrivateWorld; assessment: ManagementCapacityV9; ownership: WeakSet<object> }
  | { ok: false; error: RuntimeInstanceErrorV9; stopped: Stop };
/** Independent preparation, including a new ownership set. Failed replacement
 * cannot freeze the caller or touch the old root, certificates, stop or cache. */
function prepareSource(input: unknown, metrics: Metrics): Prepared {
  let detached: unknown;
  try { detached = detachData(input); }
  catch { return { ok: false, error: 'invalid-source', stopped: invalidStop() }; }
  try {
    metrics.fullQueries++;
    const world = detached as WorldStateV9; const assessment = assessTeachingManagementCapacityV9(world);
    const failure = sourceFailure(world, assessment); if (failure) return { ok: false, ...failure };
    const ownership = new WeakSet<object>(); ownFrozenTree(world, ownership);
    return { ok: true, root: world as PrivateWorld, assessment, ownership };
  } catch { return { ok: false, error: 'invalid-source', stopped: invalidStop() }; }
}

/** Internal preparation only: preserve the archive module's authenticated,
 * recursively immutable archive rather than erasing its identity on adoption.
 * Every non-history field is still freshly descriptor-detached. External World
 * entrances and snapshot exports deliberately do NOT use this adapter. */
function detachInternalCandidate(candidate: WorldStateV9): WorldStateV9 {
  if (candidate === null || typeof candidate !== 'object' || Object.getPrototypeOf(candidate) !== Object.prototype) {
    throw new TypeError('Expected a plain internal v9 candidate');
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  if (!Object.hasOwn(descriptors, 'history')) throw new TypeError('Expected own candidate history');
  const history = descriptors.history;
  if (!history || !history.enumerable || !Object.hasOwn(history, 'value')) throw new TypeError('Expected candidate history data');
  const remaining: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError('Expected candidate JSON keys');
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected candidate JSON data');
    if (key !== 'history') Object.defineProperty(remaining, key, { value: descriptor.value, enumerable: true, writable: true, configurable: true });
  }
  const detached = detachData(remaining);
  // restoreHistoryArchive alone authenticates this identity; Object.isFrozen,
  // a supplied marker, and the candidate's apparent origin grant no authority.
  return { ...detached, history: restoreHistoryArchive(history.value) } as WorldStateV9;
}

/** Construction is the only external World entrance besides validated replace.
 * There are no trusted-World, assessment, callback, owner or proof-flag inputs.
 * External freezing proves nothing; every entrance captures data descriptors and
 * performs the complete current .3 source/capacity/limited-teaching checks. */
export function createPrivateRuntimeV9(input: unknown): RuntimeCreationV9 {
  const metrics = freshMetrics(); let prepared: Prepared | null = prepareSource(input, metrics);
  if (!prepared.ok) return immutable({ ...prepared, metrics });
  let root: PrivateWorld | null = prepared.root;
  let ownership = prepared.ownership;
  let generation = 1; let publication = 0; let busy = false; let stop: Stop | null = null;
  let exact: StrictAnchor | null = { root, generation, assessment: prepared.assessment };
  const initialRecoveryOnly = !prepared.assessment.fits; prepared = null;
  let carry: IdleCarry | null = null;
  let exported: { root: PrivateWorld; world: WorldStateV9 } | null = null;
  // Exactly one slot for each fixed view. Keys and outputs never come from a
  // caller cache, and no arbitrary selector/callback is accepted by the facade.
  type ViewSlot = 'frame' | 'cultivation' | 'build' | 'expansion';
  const views = new Map<ViewSlot, { keys: readonly unknown[]; value: unknown }>();
  const stamp = (): RuntimeStampV9 => ({ generation, publication });
  const outcome = (measured: Metrics, error: RuntimeInstanceErrorV9 | null = null): RuntimeOperationV9 =>
    ({ ok: error === null, error, stamp: stamp(), stopped: stop, metrics: measured });
  // The guard must run before even descriptor reflection or argument coercion.
  // Closure methods do not use caller-controlled `this` or an object-ID registry.
  const blocked = (): RuntimeInstanceErrorV9 | null => busy ? 'reentrant' : root === null ? 'closed' : null;
  const exactFor = (measured: Metrics): StrictAnchor => {
    if (!root || !ownership.has(root)) throw new Error('Missing private owned root');
    if (exact?.root === root && exact.generation === generation) return exact;
    measured.fullQueries++;
    const assessment = assessTeachingManagementCapacityV9(root); const failure = sourceFailure(root, assessment);
    if (failure) throw new Error('Owned source no longer satisfies the internal source contract');
    exact = { root, generation, assessment }; return exact;
  };
  /** Callbacks are this module's fixed implementations, never public inputs. */
  const readFixed = <I, T>(input: unknown, valid: (value: unknown) => value is I,
    project: (world: WorldStateV9, argument: I) => T,
    cache?: { slot: ViewSlot; keys: (world: WorldStateV9, argument: I) => readonly unknown[] }): RuntimeReadV9<T> => {
    const measured = freshMetrics(); const denied = blocked();
    if (denied) return immutable({ ...outcome(measured, denied), ok: false as const, error: denied, value: null });
    busy = true;
    try {
      let captured: unknown;
      try { captured = detachData(input); }
      catch { return immutable({ ...outcome(measured, 'invalid-query'), ok: false as const, error: 'invalid-query' as const, value: null }); }
      if (!valid(captured)) return immutable({ ...outcome(measured, 'invalid-query'), ok: false as const, error: 'invalid-query' as const, value: null });
      if (!exact && !carry) exactFor(measured);
      const keys = cache?.keys(root!, captured); const previous = cache ? views.get(cache.slot) : undefined;
      let value: RuntimeReadonlyV9<T>;
      if (keys && previous && previous.keys.length === keys.length && keys.every((key, index) => key === previous.keys[index])) {
        value = previous.value as RuntimeReadonlyV9<T>;
      } else {
        value = immutable(detachData(project(root!, captured))) as RuntimeReadonlyV9<T>;
        // Save only after mapping, detachment and recursive freezing all succeed.
        if (cache && keys) views.set(cache.slot, { keys, value });
      }
      // Do not walk an already frozen cached DTO to freeze its tiny wrapper.
      return Object.freeze({ ...immutable(outcome(measured)), ok: true as const, error: null, value });
    } catch { return immutable({ ...outcome(measured, 'query-failed'), ok: false as const, error: 'query-failed' as const, value: null }); }
    finally { busy = false; }
  };
  const noArgument = (value: unknown): value is null => value === null;
  const publish = (next: PrivateWorld, assessment: ManagementCapacityV9 | null, nextCarry: CarriedIdleCapacity | null): void => {
    if (!Number.isSafeInteger(publication + 1)) throw new RangeError('Runtime publication stamp exhausted');
    root = next; publication++; stop = null; exported = null;
    exact = assessment ? { root, generation, assessment } : null;
    carry = nextCarry ? { root, generation, capacity: nextCarry } : null;
  };
  const failTick = (failure: CandidateCapacityDecisionV9 | null, error: unknown): Stop => {
    if (failure) return { kind: failure.reason === 'unsupported-continuation' ? 'unsupported-continuation'
      : failure.reason === 'unsupported-source' ? 'invalid-records' : 'capacity', details: [...failure.details] };
    // These errors come from internal preparation on detached owned data, never
    // from the caller capture catch. Still contain hostile/mock thrown values.
    try { return { kind: error instanceof RangeError ? 'capacity' : 'invalid-records',
      details: [error instanceof Error ? error.message : 'Invalid tick candidate'] }; }
    catch { return { kind: 'invalid-records', details: ['Invalid tick candidate'] }; }
  };
  const instance: PrivateRuntimeInstanceV9 = {
    frame() {
      return readFixed(null, noArgument, projectRuntimeFrameV9, { slot: 'frame', keys: world => [world] });
    },
    cultivation(discipleId) {
      return readFixed(discipleId, validRuntimeDiscipleQueryV9, projectRuntimeCultivationV9, { slot: 'cultivation', keys: (world, id) => [id,
        world.cultivation, world.inventory, world.disciples, world.builds, world.activeProductionTransactionIds,
        world.sectExpansion.construction.jobs, world.sectExpansion.production.jobs, world.sectExpansion.research.jobs, world.sectExpansion.care.jobs] });
    },
    build(discipleId) {
      return readFixed(discipleId, validRuntimeDiscipleQueryV9, projectRuntimeBuildV9, { slot: 'build', keys: (world, id) => [id,
        world.builds, world.cultivation.disciples, world.sectExpansion.care.jobs] });
    },
    expansion() {
      return readFixed(null, noArgument, projectRuntimeExpansionV9, { slot: 'expansion', keys: world => [world] });
    },
    previewBreakthrough(input) { return readFixed(input, validRuntimeBreakthroughQueryV9, projectRuntimeBreakthroughV9); },
    previewPlacement(input) { return readFixed(input, validRuntimePlacementQueryV9, projectRuntimePlacementV9); },
    nextApplicationCommand(start) {
      const read = readFixed(start, (value): value is number => typeof value === 'number' && isNonNegativeInteger(value),
        nextRuntimeApplicationCommandV9);
      if (!read.ok) return read;
      if (read.value === null) return Object.freeze({ ...read, ok: false as const, error: 'capacity' as const, value: null });
      return Object.freeze({ ...read, value: read.value });
    },
    controlClock(input) {
      const measured = freshMetrics(); const denied = blocked();
      const failed = (error: RuntimeInstanceErrorV9): RuntimeClockResultV9 => immutable({ ...outcome(measured, error),
        ok: false as const, error, changed: false as const });
      if (denied) return failed(denied);
      busy = true;
      try {
        let captured: unknown;
        try { captured = detachData(input); } catch { return failed('invalid-control'); }
        if (!validRuntimeClockControlV9(captured)) return failed('invalid-control');
        const boundary = root!;
        const same = captured.kind === 'speed' ? boundary.clock.speed === captured.speed
          : boundary.clock.pauseReasons.includes(captured.reason) === captured.paused;
        if (same) {
          if (!exact && !carry) exactFor(measured);
          return immutable({ ...outcome(measured), ok: true as const, error: null, changed: false });
        }
        if (!Number.isSafeInteger(publication + 1)) return failed('capacity');
        // Internal construction fixes all fields except this one approved control.
        // In particular it cannot clear a domain-owned pause, rewrite tick/mode,
        // consume IDs or manufacture a command/tick witness for teaching.
        const clock = captured.kind === 'speed' ? setClockSpeed(boundary.clock, captured.speed)
          : { ...boundary.clock, pauseReasons: captured.paused ? [...boundary.clock.pauseReasons, captured.reason]
            : boundary.clock.pauseReasons.filter(reason => reason !== captured.reason) };
        const next = { ...boundary, clock };
        // Do not disturb the old exact/carry cache on refusal. A carried estimate
        // is never substituted for the exact before-state capacity comparison.
        let previous = exact?.root === boundary && exact.generation === generation ? exact.assessment : null;
        if (!previous) { measured.fullQueries++; previous = assessTeachingManagementCapacityV9(boundary); }
        const oldFailure = sourceFailure(boundary, previous); if (oldFailure) return failed(oldFailure.error);
        measured.fullQueries++; const assessment = assessTeachingManagementCapacityV9(next);
        const failure = sourceFailure(next, assessment); if (failure) return failed(failure.error);
        // Unlike a domain action, an exact clock-only change discharges nothing.
        // Recovery-only sources may remove a pause/change equal-width speed, but
        // cannot worsen any deficient dimension to persist an extra pause string.
        if (!assessment.fits && !deficitDoesNotIncreaseV9(previous, assessment)) return failed('capacity');
        ownFrozenTree(next, ownership);
        const result: RuntimeClockResultV9 = immutable({ ok: true as const, error: null, changed: true,
          stamp: { generation, publication: publication + 1 }, stopped: stop, metrics: measured });
        root = next; publication++; exact = { root, generation, assessment }; carry = null; exported = null;
        // Deliberately not publish(): UI clock controls must preserve stop.
        return result;
      } catch { return failed('internal-failure'); }
      finally { busy = false; }
    },
    advance(steps) {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable({ ...outcome(measured, denied), advancedTicks: 0 });
      busy = true; let advancedTicks = 0;
      try {
        if (!isNonNegativeInteger(steps)) return immutable({ ...outcome(measured, 'invalid-steps'), advancedTicks });
        // Invalidation reauthenticates once even for a paused/stopped/zero-step read.
        if (!exact && !carry) exactFor(measured);
        if (stop) return immutable({ ...outcome(measured, stop.kind === 'capacity' ? 'capacity' : stop.kind === 'unsupported-continuation' ? 'unsupported-continuation' : 'internal-failure'), advancedTicks });
        for (let index = 0; index < steps; index++) {
          const boundary = root!;
          if (isPaused(boundary.clock)) break;
          let idle = carry?.root === boundary && carry.generation === generation ? carry.capacity : null;
          if (!idle && exact?.root === boundary && exact.generation === generation && exact.assessment.fits
            && scalarIdleEligible(boundary, exact.assessment)) {
            idle = { current: { ...exact.assessment.current }, reserved: exact.assessment.reserved, limits: exact.assessment.limits };
          }
          if (idle && worldMayBeScalarIdle(boundary)) {
            const nextCapacity = carryScalarTick(idle);
            if (nextCapacity) {
              const candidate = scalarTick(boundary); ownFrozenTree(candidate, ownership);
              publish(candidate as PrivateWorld, null, nextCapacity); measured.fastQueries++; advancedTicks++; continue;
            }
          }
          // A conservative carried reserve can never be a discharge before-state.
          // Refresh this exact current root once; reuse an already exact anchor.
          const previous = exactFor(measured);
          let failure: CandidateCapacityDecisionV9 | null = null; let error: unknown;
          for (const prepare of [prepareNormalTickCandidateV9, prepareNoOptionalGrowthTickCandidateV9]) {
            try {
              if (prepare === prepareNormalTickCandidateV9) measured.normalCandidates++; else measured.noOptionalCandidates++;
              // Detach ordinary candidate data; only the history module's
              // authenticated immutable archive can retain its identity.
              const candidate = detachInternalCandidate(prepare(boundary)); measured.fullQueries++;
              const assessment = assessTeachingManagementCapacityV9(candidate);
              const checked = decision(boundary, candidate, previous.assessment, assessment);
              if (!checked.ok) { failure = checked; continue; }
              ownFrozenTree(candidate, ownership); publish(candidate as PrivateWorld, assessment, null);
              failure = null; error = undefined; advancedTicks++; break;
            } catch (caught) { error = caught; }
          }
          if (root === boundary) { stop = immutable(failTick(failure, error)); break; }
        }
        return immutable({ ...outcome(measured, stop ? (stop.kind === 'capacity' ? 'capacity' : 'internal-failure') : null), advancedTicks });
      } catch {
        stop = immutable({ kind: 'invalid-records', details: ['Private v9 operation failed without publishing its candidate'] });
        return immutable({ ...outcome(measured, 'internal-failure'), advancedTicks });
      } finally { busy = false; }
    },
    command(input) {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable({ ...outcome(measured, denied), result: null, published: false });
      busy = true;
      try {
        let captured: unknown;
        try { captured = detachData(input); }
        catch { return immutable({ ...outcome(measured, 'invalid-command'), result: null, published: false }); }
        if (!exact && !carry) exactFor(measured);
        const boundary = root!; const candidate = prepareUnregisteredCommandCandidateV9(boundary, captured);
        // Retry/conflict priority remains in the unchanged preparation. Results
        // must be detached even when they originate inside a private receipt.
        if (candidate.world === boundary) return immutable({ ...outcome(measured), result: detachData(candidate.result), published: false });
        const previous = exactFor(measured); const next = detachInternalCandidate(candidate.world); measured.fullQueries++;
        const assessment = assessTeachingManagementCapacityV9(next); const checked = decision(boundary, next, previous.assessment, assessment);
        if (!checked.ok) return immutable({ ...outcome(measured), result: refused(candidate.result.commandId, checked.code!), published: false });
        // Prepare output before publication: even an unexpected export failure
        // cannot publish a command whose caller never received a result.
        const result = immutable(detachData(candidate.result)); ownFrozenTree(next, ownership);
        publish(next as PrivateWorld, assessment, null);
        return immutable({ ...outcome(measured), result, published: true });
      } catch { return immutable({ ...outcome(measured, 'internal-failure'), result: null, published: false }); }
      finally { busy = false; }
    },
    replace(input) {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable({ ...outcome(measured, denied), recoveryOnly: null });
      busy = true;
      try {
        const next = prepareSource(input, measured);
        // Rejection details describe the input without changing the saved stop.
        if (!next.ok) return immutable({ ...outcome(measured, next.error), recoveryOnly: null });
        if (!Number.isSafeInteger(generation + 1) || !Number.isSafeInteger(publication + 1)) return immutable({ ...outcome(measured, 'capacity'), recoveryOnly: null });
        generation++; publication++; root = next.root; ownership = next.ownership;
        exact = { root, generation, assessment: next.assessment }; carry = null; exported = null; stop = null; views.clear();
        return immutable({ ...outcome(measured), recoveryOnly: !next.assessment.fits });
      } finally { busy = false; }
    },
    invalidate() {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable(outcome(measured, denied));
      busy = true;
      try {
        if (!Number.isSafeInteger(generation + 1)) return immutable(outcome(measured, 'capacity'));
        generation++; exact = null; carry = null;
        return immutable(outcome(measured));
      } finally { busy = false; }
    },
    snapshot() {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable({ ...outcome(measured, denied), world: null });
      busy = true;
      try {
        if (!exact && !carry) exactFor(measured);
        if (!exported || exported.root !== root) {
          const world = detachData(root!); immutable(world); measured.exports++;
          exported = { root: root!, world };
        }
        // The export is already privately created and deeply frozen. Freeze only
        // this small wrapper, so a cached snapshot does not walk the tree again.
        return Object.freeze({ ...immutable(outcome(measured)), world: exported.world });
      } catch { return immutable({ ...outcome(measured, 'snapshot-failed'), world: null }); }
      finally { busy = false; }
    },
    close() {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable(outcome(measured, denied));
      busy = true;
      try {
        if (!Number.isSafeInteger(generation + 1)) return immutable(outcome(measured, 'capacity'));
        generation++; root = null; exact = null; carry = null; exported = null; ownership = new WeakSet<object>(); stop = null; views.clear();
        return immutable(outcome(measured));
      } finally { busy = false; }
    },
  };
  // Only methods escape. No owned World or private assessment is reachable from
  // this frozen facade; snapshot() returns its own independently frozen copy.
  Object.freeze(instance);
  return immutable({ ok: true as const, instance, recoveryOnly: initialRecoveryOnly, metrics });
}
