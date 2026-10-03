/** Internal retained v10 owner. Deliberately absent from engine, codec and app
 * barrels. Its stamps and diagnostics never authorize a save or an import. */
import { isPaused, setClockSpeed, type SimulationSpeed } from '../kernel/clock';
import { prepareUnregisteredCommandCandidateV10 } from '../kernel/commands-v10';
import { isNonNegativeInteger } from '../kernel/numeric';
import { prepareNormalTickCandidateV10, prepareNoOptionalGrowthTickCandidateV10 } from '../kernel/simulation-v10';
import { ownSectFields } from '../sect-expansion/layout';
import type { WorldStateV10 } from '../sect-expansion/upgrade-types';
import { assessManagementCapacityV10, type ManagementCapacityV10 } from './management-capacity-v10';
import { CAPACITY_LIMITED_V10_MAX_STEPS, type CapacityLimitedAdvanceV10, type CapacityLimitedResultV10,
  type CandidateCapacityDecisionV10 } from './runtime-capacity-v10';
import { decisionV10, refusedV10 } from './runtime-decision-v10';
import { createOwnedIdleLeafV10, type CarriedIdleCapacityV10 } from './runtime-owned-internals-v10';
import { createOwnedTickPipelineV10 } from './runtime-owned-ticks-v10';
// This helper only freezes an already-owned ordinary tree. It has no version,
// assessment or World assumptions; no v9 runtime/idle proof is reused here.
import { ownFrozenTree } from './runtime-owned-internals-v9';
import { actualDimensionsFitV10, deficitDoesNotIncreaseV10, hasTeachingV10, inspectTeachingContinuationV10,
  TEACHING_DETAIL_V10 } from './teaching-continuation-v10';
import { captureV10RecordData } from './v10-sect-records';
import { nextRuntimeApplicationCommandV10, projectRuntimeBuildV10, projectRuntimeCultivationV10, projectRuntimeExpansionV10,
  projectRuntimeFrameV10, projectRuntimeBreakthroughV10, projectRuntimePlacementV10, projectRuntimeUpgradeV10,
  validRuntimeApplicationCursorV10, validRuntimeBreakthroughQueryV10, validRuntimeDiscipleQueryV10,
  validRuntimePlacementQueryV10, validRuntimeUpgradeQueryV10 } from './runtime-views-v10';
import { RUNTIME_VIEW_LIMITS_V10 } from './runtime-view-types-v10';
import type { RuntimeApplicationCommandV10, RuntimeBreakthroughPreviewV10, RuntimeBuildViewV10,
  RuntimeCultivationViewV10, RuntimeExpansionViewV10, RuntimeFrameViewV10, RuntimePlacementPreviewV10,
  RuntimeReadV10, RuntimeReadonlyV10, RuntimeUpgradePreviewV10 } from './runtime-view-types-v10';

export interface RuntimeStampV10 { readonly generation: number; readonly publication: number }
export interface RuntimeInstanceMetricsV10 {
  /** Calls of this owner's checkSource only. Leaf entry queries, nested root
   * checks, teaching trials and fixed witness replays are excluded. A cached
   * private exact anchor or carried idle boundary does not increment this. */
  readonly sourceChecks: number;
  /** Calls of the unchanged strict arbitrary-candidate gate only. */
  readonly candidateChecks: number;
  /** Preparations through the original strict wrappers only. */
  readonly normalCandidates: number; readonly noOptionalCandidates: number; readonly exports: number;
  /** Published fixed scalar leaf ticks only; not total work or saved queries. */
  readonly fastTicks: number;
  /** Owned actual-tick leaf calls, including refusals. Successful capture and
   * every published candidate require that leaf's full fixed assessment. */
  readonly ownedCaptures: number; readonly ownedNormalAttempts: number; readonly ownedNoOptionalAttempts: number;
  /** Published actual reducer ticks, separate from the scalar idle fastTicks. */
  readonly ownedTicks: number;
}
type Metrics = { -readonly [K in keyof RuntimeInstanceMetricsV10]: RuntimeInstanceMetricsV10[K] };
type Stop = NonNullable<CapacityLimitedAdvanceV10['stopped']>;
export type RuntimeInstanceErrorV10 = 'closed' | 'reentrant' | 'invalid-source' | 'invalid-command' | 'invalid-steps'
  | 'invalid-control' | 'unsupported-continuation' | 'capacity' | 'snapshot-failed' | 'internal-failure'
  | 'invalid-query' | 'query-failed';
export interface RuntimeOperationV10 {
  readonly ok: boolean; readonly error: RuntimeInstanceErrorV10 | null;
  readonly stamp: RuntimeStampV10; readonly stopped: Stop | null;
  /** An accepted actual-fit boundary may still lack future reserve. Snapshots
   * retain this explicit distinction; a future save gate must reject it. */
  readonly recoveryOnly: boolean | null; readonly metrics: RuntimeInstanceMetricsV10;
}
export interface RuntimeAdvanceV10 extends RuntimeOperationV10 { readonly advancedTicks: number }
export interface RuntimeCommandV10 extends RuntimeOperationV10 { readonly published: boolean; readonly result: CapacityLimitedResultV10 | null }
export interface RuntimeSnapshotV10 extends RuntimeOperationV10 { readonly world: WorldStateV10 | null }
export interface RuntimeReplaceV10 extends RuntimeOperationV10 {}
export interface RuntimeClockResultV10 extends RuntimeOperationV10 { readonly changed: boolean }
export type RuntimeClockControlV10 = { kind: 'speed'; speed: SimulationSpeed }
  | { kind: 'pause'; reason: 'player' | 'hidden'; paused: boolean };
export interface PrivateRuntimeInstanceV10 {
  advance(steps: number): RuntimeAdvanceV10;
  command(input: unknown): RuntimeCommandV10;
  snapshot(): RuntimeSnapshotV10;
  frame(): RuntimeReadV10<RuntimeFrameViewV10>;
  cultivation(discipleId: string | null): RuntimeReadV10<RuntimeCultivationViewV10>;
  build(discipleId: string | null): RuntimeReadV10<RuntimeBuildViewV10>;
  expansion(): RuntimeReadV10<RuntimeExpansionViewV10>;
  previewBreakthrough(input: unknown): RuntimeReadV10<RuntimeBreakthroughPreviewV10>;
  previewPlacement(input: unknown): RuntimeReadV10<RuntimePlacementPreviewV10>;
  previewUpgrade(input: unknown): RuntimeReadV10<RuntimeUpgradePreviewV10>;
  nextApplicationCommand(start: number): RuntimeReadV10<RuntimeApplicationCommandV10>;
  replace(input: unknown): RuntimeReplaceV10;
  invalidate(): RuntimeOperationV10;
  controlClock(input: unknown): RuntimeClockResultV10;
  close(): RuntimeOperationV10;
}
export type RuntimeCreationV10 =
  | { readonly ok: true; readonly instance: PrivateRuntimeInstanceV10; readonly recoveryOnly: boolean; readonly metrics: RuntimeInstanceMetricsV10 }
  | { readonly ok: false; readonly error: RuntimeInstanceErrorV10; readonly stopped: Stop; readonly metrics: RuntimeInstanceMetricsV10 };

const freshMetrics = (): Metrics => ({ sourceChecks: 0, candidateChecks: 0, normalCandidates: 0, noOptionalCandidates: 0,
  exports: 0, fastTicks: 0, ownedCaptures: 0, ownedNormalAttempts: 0, ownedNoOptionalAttempts: 0, ownedTicks: 0 });
const immutable = <T>(value: T): T => { ownFrozenTree(value, new WeakSet<object>()); return value; };
const invalidStop = (): Stop => ({ kind: 'invalid-records', details: ['Invalid bounded private v10 data or operation'] });
const errorForStop = (stop: Stop): RuntimeInstanceErrorV10 => stop.kind === 'capacity' ? 'capacity'
  : stop.kind === 'unsupported-continuation' ? 'unsupported-continuation' : 'internal-failure';
type SourceCheck = { ok: true; assessment: ManagementCapacityV10 }
  | { ok: false; error: RuntimeInstanceErrorV10; stopped: Stop };
function checkSource(world: WorldStateV10, measured: Metrics): SourceCheck {
  measured.sourceChecks++;
  // The fixed query includes inspectUnregisteredWorldV10Records on the entire
  // captured source. There is no caller-supplied validator or assessment input.
  const assessment = assessManagementCapacityV10(world);
  if (!assessment.supported) return { ok: false, error: 'invalid-source', stopped: { kind: 'invalid-records',
    details: [...assessment.sourceRecordIssues, ...assessment.unknowns] } };
  if (!actualDimensionsFitV10(assessment)) return { ok: false, error: 'capacity', stopped: { kind: 'capacity',
    details: ['Actual complete-boundary hard limit exceeded'] } };
  const teaching = inspectTeachingContinuationV10(world);
  if (!teaching.supported) return { ok: false, error: 'unsupported-continuation', stopped: { kind: 'unsupported-continuation',
    details: [TEACHING_DETAIL_V10, ...teaching.unknowns] } };
  return { ok: true, assessment };
}
type Prepared = { ok: true; world: WorldStateV10; assessment: ManagementCapacityV10 }
  | { ok: false; error: RuntimeInstanceErrorV10; stopped: Stop };
function prepareSource(input: unknown, measured: Metrics): Prepared {
  try {
    const world = captureV10RecordData(input) as WorldStateV10;
    const checked = checkSource(world, measured);
    if (!checked.ok) return checked;
    immutable(world);
    return { ok: true, world, assessment: checked.assessment };
  } catch { return { ok: false, error: 'invalid-source', stopped: invalidStop() }; }
}
function validClockControl(value: unknown): value is RuntimeClockControlV10 {
  return ownSectFields(value, ['kind', 'speed']) && value.kind === 'speed' && (value.speed === 1 || value.speed === 3)
    || ownSectFields(value, ['kind', 'reason', 'paused']) && value.kind === 'pause'
      && (value.reason === 'player' || value.reason === 'hidden') && typeof value.paused === 'boolean';
}
function candidateStop(decision: CandidateCapacityDecisionV10): Stop {
  return { kind: decision.reason === 'unsupported-continuation' ? 'unsupported-continuation'
    : decision.reason === 'unsupported-source' || decision.reason === 'unsupported-transition' ? 'invalid-records' : 'capacity',
  details: [...decision.details] };
}

/** Construction and replace are the only external World entrances. Capture is
 * descriptor-based and bounded, then complete records/capacity/teaching are
 * checked. External freezing and apparent provenance grant no authority. */
export function createPrivateRuntimeV10(input: unknown): RuntimeCreationV10 {
  const metrics = freshMetrics(); let prepared: Prepared | null = prepareSource(input, metrics);
  if (!prepared.ok) return immutable({ ...prepared, metrics });
  let root: WorldStateV10 | null = prepared.world;
  let recoveryOnly: boolean | null = !prepared.assessment.fits;
  let generation = 1; let publication = 0; let busy = false; let stop: Stop | null = null;
  // A fixed slot retains at most one argument/result. Exact root identity AND
  // generation bind every entry; no caller keys, cache or selector are accepted.
  type ViewSlot = 'frame' | 'cultivation' | 'build' | 'expansion';
  const views = new Map<ViewSlot, { world: WorldStateV10; generation: number; argument: unknown; value: unknown }>();
  const clearViews = (): void => { views.clear(); };
  // These are private closure bindings, never caller-provided certificates. An
  // exact anchor and a conservative carry deliberately have different types.
  let exactAnchor: { world: WorldStateV10; generation: number; assessment: ManagementCapacityV10 } | null =
    { world: root, generation, assessment: prepared.assessment };
  const initialRecoveryOnly = recoveryOnly; prepared = null;
  const idle = createOwnedIdleLeafV10();
  const ticks = createOwnedTickPipelineV10();
  let idleCursor: { world: WorldStateV10; generation: number; capacity: CarriedIdleCapacityV10 } | null = null;
  // This cursor says only which exact private root the actual reducer factory
  // retains. The factory accepts neither it nor an assessment as an input.
  let tickCursor: { world: WorldStateV10; generation: number } | null = null;
  const anchored = (): boolean => exactAnchor !== null && exactAnchor.world === root && exactAnchor.generation === generation;
  const carried = (): boolean => idleCursor !== null && idleCursor.world === root && idleCursor.generation === generation;
  const tickBound = (): boolean => tickCursor !== null && tickCursor.world === root && tickCursor.generation === generation;
  const clearTicks = (): void => { ticks.clear(); tickCursor = null; };
  const clearProofs = (): void => { idle.clear(); idleCursor = null; clearTicks(); exactAnchor = null; };
  const anchor = (world: WorldStateV10, assessment: ManagementCapacityV10): void => {
    exactAnchor = { world, generation, assessment };
  };
  const exactSource = (measured: Metrics): SourceCheck => {
    if (anchored()) return { ok: true, assessment: exactAnchor!.assessment };
    const checked = checkSource(root!, measured);
    if (checked.ok) anchor(root!, checked.assessment);
    return checked;
  };
  // Rejecting hint only. It avoids cloning clearly active/recovery sources into
  // the leaf; the leaf still captures and fully queries every actual entry.
  const mayCaptureIdle = (): boolean => {
    if (!anchored()) return false;
    const assessment = exactAnchor!.assessment;
    return assessment.fits && assessment.progression !== null
      && assessment.progression.owners.every(owner => owner.kind === 'disciple-lifecycle')
      && assessment.sect !== null && assessment.sect.owners.length === 0
      && assessment.clock !== null && assessment.clock.calendarTicks === 0
      && root!.activeProductionTransactionIds.length === 0 && root!.cultivation.pendingDeaths.length === 0;
  };
  const stamp = (): RuntimeStampV10 => ({ generation, publication });
  const outcome = (measured: Metrics, error: RuntimeInstanceErrorV10 | null = null): RuntimeOperationV10 =>
    ({ ok: error === null, error, stamp: stamp(), stopped: stop, recoveryOnly, metrics: measured });
  // Run before input reflection/coercion, even on methods borrowed with an
  // arbitrary `this`. There is no caller callback, owner token or ID registry.
  const blocked = (): RuntimeInstanceErrorV10 | null => busy ? 'reentrant' : root === null ? 'closed' : null;
  const canPublish = (): boolean => Number.isSafeInteger(publication + 1);
  const canGenerate = (): boolean => Number.isSafeInteger(generation + 1);
  const checkedCandidate = (before: WorldStateV10, candidate: WorldStateV10, measured: Metrics): CandidateCapacityDecisionV10 => {
    measured.candidateChecks++;
    return decisionV10(before, candidate);
  };
  /** The validator/projector pair is fixed by this module, never supplied by a
   * caller. Private roots were already fully checked or preserved by the private
   * carry. A view is not a fresh source check, snapshot or command certificate. */
  const readFixed = <I, T>(input: unknown, valid: (value: unknown) => value is I,
    project: (world: WorldStateV10, argument: I) => T, slot?: ViewSlot): RuntimeReadV10<T> => {
    const measured = freshMetrics(); const denied = blocked();
    const failed = (error: RuntimeInstanceErrorV10): RuntimeReadV10<T> =>
      immutable({ ...outcome(measured, error), ok: false as const, error, value: null });
    if (denied) return failed(denied);
    busy = true;
    try {
      let argument: unknown;
      try { argument = captureV10RecordData(input); } catch { return failed('invalid-query'); }
      if (!valid(argument)) return failed('invalid-query');
      const previous = slot ? views.get(slot) : undefined;
      let value: RuntimeReadonlyV10<T>;
      if (previous && previous.world === root && previous.generation === generation && previous.argument === argument) {
        value = previous.value as RuntimeReadonlyV10<T>;
      } else {
        // These fixed projections allocate their DTO records. Freeze only that
        // bounded result, never export/capture the private World on a UI read.
        value = immutable(project(root!, argument)) as RuntimeReadonlyV10<T>;
        // A failed projection/freeze cannot displace a good entry. Previews and
        // cursor searches remain uncached; the four fixed slots are the bound.
        if (slot) {
          if (!views.has(slot) && views.size >= RUNTIME_VIEW_LIMITS_V10.cacheEntries) throw new RangeError('Private v10 view cache is full');
          views.set(slot, { world: root!, generation, argument, value });
        }
      }
      // Repeated reads freeze only the tiny wrapper, not an already-frozen DTO.
      return Object.freeze({ ...immutable(outcome(measured)), ok: true as const, error: null, value });
    } catch { return failed('query-failed'); }
    finally { busy = false; }
  };
  const noArgument = (value: unknown): value is null => value === null;
  const instance: PrivateRuntimeInstanceV10 = {
    frame() { return readFixed(null, noArgument, projectRuntimeFrameV10, 'frame'); },
    cultivation(discipleId) { return readFixed(discipleId, validRuntimeDiscipleQueryV10, projectRuntimeCultivationV10, 'cultivation'); },
    build(discipleId) { return readFixed(discipleId, validRuntimeDiscipleQueryV10, projectRuntimeBuildV10, 'build'); },
    expansion() { return readFixed(null, noArgument, projectRuntimeExpansionV10, 'expansion'); },
    previewBreakthrough(input) { return readFixed(input, validRuntimeBreakthroughQueryV10, projectRuntimeBreakthroughV10); },
    previewPlacement(input) { return readFixed(input, validRuntimePlacementQueryV10, projectRuntimePlacementV10); },
    previewUpgrade(input) { return readFixed(input, validRuntimeUpgradeQueryV10, projectRuntimeUpgradeV10); },
    nextApplicationCommand(start) {
      const read = readFixed(start, validRuntimeApplicationCursorV10, nextRuntimeApplicationCommandV10);
      if (!read.ok) return read;
      if (read.value === null) return Object.freeze({ ...read, ok: false as const, error: 'capacity' as const, value: null });
      return Object.freeze({ ...read, value: read.value });
    },
    advance(steps) {
      const measured = freshMetrics(); const denied = blocked(); let advancedTicks = 0;
      if (denied) return immutable({ ...outcome(measured, denied), advancedTicks });
      busy = true;
      try {
        if (typeof steps !== 'number' || !isNonNegativeInteger(steps) || steps > CAPACITY_LIMITED_V10_MAX_STEPS)
          return immutable({ ...outcome(measured, 'invalid-steps'), advancedTicks });
        if (!carried()) {
          const source = exactSource(measured);
          if (!source.ok) return immutable({ ...outcome(measured, source.error), advancedTicks });
        }
        if (stop) return immutable({ ...outcome(measured, errorForStop(stop)), advancedTicks });
        for (let index = 0; index < steps; index++) {
          if (isPaused(root!.clock)) break;
          if (!canPublish()) { stop = immutable({ kind: 'capacity', details: ['Private v10 publication stamp exhausted'] }); break; }
          let idleFailed = false;
          if (!carried() && mayCaptureIdle()) {
            const captured = idle.capture(root!);
            if (captured) {
              // capture owns a DETACHED root. All three private bindings adopt
              // that exact identity together, with no logical publication.
              clearTicks(); root = captured.world; clearViews(); anchor(root, captured.assessment);
              idleCursor = { world: root, generation, capacity: captured.capacity };
            } else idleFailed = true;
          }
          if (carried()) {
            const next = idle.advance();
            if (next) {
              root = next.world; clearViews(); exactAnchor = null;
              idleCursor = { world: root, generation, capacity: next.capacity };
              recoveryOnly = false; publication++; advancedTicks++; measured.fastTicks++;
              continue;
            }
            idleFailed = true;
          }
          if (idleFailed) {
            // Carry is never passed to a gate, deficit comparison or discharge.
            // Any leaf refusal means fresh exact source work followed by the
            // same normal-before-fallback order; refusal alone cannot safe-stop.
            clearProofs(); const source = exactSource(measured);
            if (!source.ok) return immutable({ ...outcome(measured, source.error), advancedTicks });
          }
          // A rejecting hint only. Recovery and teaching remain on the original
          // strict path. capture independently owns/authenticates every entry;
          // neither the anchor nor a carried estimate is passed as authority.
          if (!tickBound() && anchored() && exactAnchor!.assessment.fits && !hasTeachingV10(root!)) {
            clearTicks(); measured.ownedCaptures++;
            try {
              const captured = ticks.capture(root!);
              if (captured) {
                root = captured.world; clearViews(); anchor(root, captured.assessment);
                tickCursor = { world: root, generation };
              }
            } catch { clearTicks(); }
          }
          const boundary = root!;
          let failure: Stop = invalidStop(); let published = false;
          for (const prepare of [prepareNormalTickCandidateV10, prepareNoOptionalGrowthTickCandidateV10]) {
            if (tickBound()) {
              try {
                if (prepare === prepareNormalTickCandidateV10) measured.ownedNormalAttempts++;
                else measured.ownedNoOptionalAttempts++;
                const next = prepare === prepareNormalTickCandidateV10 ? ticks.advanceNormal() : ticks.advanceNoOptional();
                if (next) {
                  // The fixed factory executed the real reducer and checked the
                  // complete resulting boundary before retaining it. No arbitrary
                  // candidate, diagnostic or caller-supplied proof is accepted.
                  idle.clear(); idleCursor = null;
                  root = next.world; clearViews(); anchor(root, next.assessment);
                  tickCursor = { world: root, generation };
                  recoveryOnly = false; publication++; stop = null;
                  published = true; advancedTicks++; measured.ownedTicks++; break;
                }
              } catch {
                // Unexpected helper failure is also only a strict-path request.
                // Never inspect thrown data or reuse an uncertain leaf cursor.
                clearTicks();
              }
            }
            try {
              if (prepare === prepareNormalTickCandidateV10) measured.normalCandidates++; else measured.noOptionalCandidates++;
              // Both attempts start from exactly this immutable complete boundary.
              // No archive identity or arbitrary frozen candidate is exempted.
              // A refused owned normal MUST try strict normal before any fallback:
              // genuine reserved discharge may be admitted only by that gate.
              const prepared = prepare(boundary);
              if (prepared === boundary) { failure = invalidStop(); continue; }
              const candidate = captureV10RecordData(prepared) as WorldStateV10;
              if (candidate.clock.simulationTick !== boundary.clock.simulationTick + 1
                || candidate.clock.calendarTick !== boundary.clock.calendarTick + 1) { failure = invalidStop(); continue; }
              const checked = checkedCandidate(boundary, candidate, measured);
              if (!checked.ok) { failure = candidateStop(checked); continue; }
              immutable(candidate);
              // All fallible candidate work is finished before publishing.
              clearProofs(); root = candidate; clearViews(); anchor(root, checked.assessment);
              recoveryOnly = !checked.assessment.fits; publication++; stop = null;
              published = true; advancedTicks++; break;
            } catch { failure = invalidStop(); }
          }
          if (!published) { clearTicks(); stop = immutable(failure); break; }
        }
        return immutable({ ...outcome(measured, stop ? errorForStop(stop) : null), advancedTicks });
      } catch {
        clearProofs();
        stop = immutable(invalidStop());
        return immutable({ ...outcome(measured, 'internal-failure'), advancedTicks });
      } finally { busy = false; }
    },
    command(input) {
      const measured = freshMetrics(); const denied = blocked();
      const failed = (error: RuntimeInstanceErrorV10): RuntimeCommandV10 => immutable({ ...outcome(measured, error), result: null, published: false });
      if (denied) return failed(denied);
      busy = true;
      try {
        clearProofs();
        let captured: unknown;
        try { captured = captureV10RecordData(input); } catch { return failed('invalid-command'); }
        const boundary = root!; const source = exactSource(measured);
        if (!source.ok) return failed(source.error);
        const prepared = prepareUnregisteredCommandCandidateV10(boundary, captured);
        // Retry/conflict/no-write results retain the stop and stamp. Even these
        // results are captured separately from the private receipt/history tree.
        if (prepared.world === boundary) return immutable({ ...outcome(measured),
          result: captureV10RecordData(prepared.result) as CapacityLimitedResultV10, published: false });
        if (!canPublish()) return failed('capacity');
        const candidate = captureV10RecordData(prepared.world) as WorldStateV10;
        const checked = checkedCandidate(boundary, candidate, measured);
        if (!checked.ok) return immutable({ ...outcome(measured), result: refusedV10(prepared.result.commandId, checked.code!), published: false });
        const result = captureV10RecordData(prepared.result) as CapacityLimitedResultV10;
        immutable(candidate);
        const response: RuntimeCommandV10 = immutable({ ...outcome(measured),
          stamp: { generation, publication: publication + 1 }, stopped: null, recoveryOnly: !checked.assessment.fits, result, published: true });
        root = candidate; clearViews(); anchor(root, checked.assessment);
        recoveryOnly = !checked.assessment.fits; publication++; stop = null;
        return response;
      } catch { return failed('internal-failure'); }
      finally { busy = false; }
    },
    snapshot() {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable({ ...outcome(measured, denied), world: null });
      busy = true;
      try {
        // Export has no cached identity or trusted-object shortcut. Validate the
        // actual detached export; never return the private root or assessment.
        const world = captureV10RecordData(root!) as WorldStateV10;
        const checked = checkSource(world, measured);
        if (!checked.ok) return immutable({ ...outcome(measured, checked.error), world: null });
        measured.exports++;
        return immutable({ ...outcome(measured), recoveryOnly: !checked.assessment.fits, world });
      } catch { return immutable({ ...outcome(measured, 'snapshot-failed'), world: null }); }
      finally { busy = false; }
    },
    replace(input) {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable(outcome(measured, denied));
      busy = true;
      try {
        clearProofs();
        const next = prepareSource(input, measured);
        if (!next.ok) return immutable(outcome(measured, next.error));
        if (!canGenerate() || !canPublish()) return immutable(outcome(measured, 'capacity'));
        const response = immutable({ ...outcome(measured), stamp: { generation: generation + 1, publication: publication + 1 },
          stopped: null, recoveryOnly: !next.assessment.fits });
        root = next.world; generation++; clearViews(); anchor(root, next.assessment);
        publication++; recoveryOnly = !next.assessment.fits; stop = null;
        return response;
      } catch { return immutable(outcome(measured, 'internal-failure')); }
      finally { busy = false; }
    },
    invalidate() {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable(outcome(measured, denied));
      busy = true;
      try {
        clearProofs();
        if (!canGenerate()) return immutable(outcome(measured, 'capacity'));
        // Invalidation changes the lifetime epoch, not the complete World/stop.
        const response = immutable({ ...outcome(measured), stamp: { generation: generation + 1, publication } });
        generation++; clearViews(); return response;
      } finally { busy = false; }
    },
    controlClock(input) {
      const measured = freshMetrics(); const denied = blocked();
      const failed = (error: RuntimeInstanceErrorV10): RuntimeClockResultV10 => immutable({ ...outcome(measured, error), changed: false });
      if (denied) return failed(denied);
      busy = true;
      try {
        clearProofs();
        let captured: unknown;
        try { captured = captureV10RecordData(input); } catch { return failed('invalid-control'); }
        if (!validClockControl(captured)) return failed('invalid-control');
        const boundary = root!; const previous = exactSource(measured);
        if (!previous.ok) return failed(previous.error);
        const same = captured.kind === 'speed' ? boundary.clock.speed === captured.speed
          : boundary.clock.pauseReasons.includes(captured.reason) === captured.paused;
        if (same) return immutable({ ...outcome(measured), changed: false });
        if (!canPublish()) return failed('capacity');
        const clock = captured.kind === 'speed' ? setClockSpeed(boundary.clock, captured.speed)
          : { ...boundary.clock, pauseReasons: captured.paused ? [...boundary.clock.pauseReasons, captured.reason]
            : boundary.clock.pauseReasons.filter(reason => reason !== captured.reason) };
        const candidate = captureV10RecordData({ ...boundary, clock }) as WorldStateV10;
        const checked = checkSource(candidate, measured);
        if (!checked.ok) return failed(checked.error);
        // Exact fixed clock-only changes have no domain reducer/discharge witness.
        // They may preserve/reduce deficits, never claim reserved recovery credit.
        if (!checked.assessment.fits && !deficitDoesNotIncreaseV10(previous.assessment, checked.assessment)) return failed('capacity');
        immutable(candidate);
        const response = immutable({ ...outcome(measured), changed: true, stamp: { generation, publication: publication + 1 },
          recoveryOnly: !checked.assessment.fits });
        root = candidate; clearViews(); anchor(root, checked.assessment); publication++; recoveryOnly = !checked.assessment.fits;
        // UI clock controls cannot clear a retained safe-stop or domain pause.
        return response;
      } catch { return failed('internal-failure'); }
      finally { busy = false; }
    },
    close() {
      const measured = freshMetrics(); const denied = blocked();
      if (denied) return immutable(outcome(measured, denied));
      busy = true;
      try {
        clearProofs();
        if (!canGenerate()) return immutable(outcome(measured, 'capacity'));
        const response = immutable({ ...outcome(measured), stamp: { generation: generation + 1, publication }, stopped: null, recoveryOnly: null });
        generation++; root = null; clearViews(); recoveryOnly = null; stop = null;
        return response;
      } finally { busy = false; }
    },
  };
  Object.freeze(instance);
  return immutable({ ok: true as const, instance, recoveryOnly: initialRecoveryOnly, metrics });
}
