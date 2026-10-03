import type { BuildCommand } from '../core/builds/types';
import type { BreakthroughPreparation } from '../core/cultivation/types';
import { accumulateFrame, createFrameAccumulator, type SimulationSpeed } from '../core/kernel/clock';
import { isCommandV10 } from '../core/kernel/commands-v10';
import type { Command, PlayerCultivationCommand } from '../core/kernel/contracts';
import type { CommandV10, SectCommandV10 } from '../core/kernel/contracts-v10';
import { createSaveEnvelopeV10, SaveCodecErrorV10, serializeSaveV10 } from '../core/kernel/save-v10';
import type { SaveMetadata } from '../core/kernel/save';
import type { SectPlacementRequest } from '../core/sect-expansion/types';
import { createUnregisteredWorldV10 } from '../core/world/create-world-v10';
import type { CapacityLimitedResultV10 } from '../core/world/runtime-capacity-v10';
import { createPrivateRuntimeV10, type PrivateRuntimeInstanceV10, type RuntimeInstanceErrorV10,
  type RuntimeOperationV10, type RuntimeStampV10 } from '../core/world/runtime-instance-v10';
import type { RuntimeApplicationCommandV10, RuntimeBreakthroughPreviewV10, RuntimeBuildViewV10,
  RuntimeCultivationViewV10, RuntimeExpansionViewV10, RuntimeFrameViewV10, RuntimePlacementPreviewV10,
  RuntimeReadV10, RuntimeReadonlyV10, RuntimeUpgradePreviewV10, RuntimeUpgradeRequestV10 } from '../core/world/runtime-view-types-v10';
import { admitSaveWorldV10, captureSaveDataV10, type SaveErrorCodeV10 } from '../core/world/save-admission-v10';
import type { WorldStateV10 } from '../core/sect-expansion/upgrade-types';

/** Deliberately separate from the registered v7/v8 Session and platform codec. */
type WithoutId<T> = T extends unknown ? Omit<T, 'commandId'> : never;
type PlayerBody<T> = T extends unknown ? Omit<T, 'commandId' | 'sequence' | 'issuedTick'> : never;
export type SessionSelectionV10 = { kind: 'disciple' | 'building' | 'blueprint' | 'sect-building'; id: string } | null;
export type CultivationRequestV10 = WithoutId<PlayerCultivationCommand>;
export type BuildRequestV10 = WithoutId<BuildCommand>;
export type SectRequestV10 = { [D in SectCommandV10['domain']]: {
  domain: D; command: WithoutId<Extract<SectCommandV10, { domain: D }>['command']>;
} }[SectCommandV10['domain']];
export type SessionRequestV10 = PlayerBody<Extract<Command, { kind: 'production.start' | 'production.cancel' | 'inventory.discard' }>>
  | { kind: 'cultivation.command'; payload: { command: CultivationRequestV10 } }
  | { kind: 'build.command'; payload: { command: BuildRequestV10 } }
  | { kind: 'sect.command'; payload: SectRequestV10 };
export type SessionFailureV10 =
  | { readonly ok: false; readonly kind: 'session-rejection'; readonly code: 'CLOSED' | 'BUSY' | 'SESSION_HELD' | 'INVALID_REQUEST' | 'PREVIEW_STALE' | 'REPLACEMENT_STALE' | 'COUNTER_EXHAUSTED' }
  | { readonly ok: false; readonly kind: 'runtime-failure'; readonly error: RuntimeInstanceErrorV10; readonly stopped: RuntimeOperationV10['stopped'] }
  | { readonly ok: false; readonly kind: 'save-rejection'; readonly code: SaveErrorCodeV10 };
/** ok means a typed domain result was received; inspect result.status for acceptance.
 * Do not flatten sectResult, v10 rejection codes or runtime failures to v7 results. */
export type SessionCommandResultV10 = SessionFailureV10 | { readonly ok: true; readonly kind: 'command';
  readonly result: RuntimeReadonlyV10<CapacityLimitedResultV10>; readonly published: boolean };
export type SessionControlResultV10 = SessionFailureV10 | { readonly ok: true; readonly changed: boolean; readonly ephemeral: boolean };
// Readonly belongs to each value protocol. Do not recursively remap the complete
// recursive World schema in a generic transport wrapper (cold export is already
// detached and frozen by RuntimeSnapshotV10). Fixed DTOs retain deep-readonly types.
export type SessionValueV10<T> = SessionFailureV10 | { readonly ok: true; readonly value: T };
export interface SessionHoldsV10 { staging: boolean; storageBusy: boolean; storage: boolean; overlay: boolean; review: boolean; player: boolean; hidden: boolean }
/** Local optimistic-concurrency fence, never a World identity or save authority. */
export interface SessionSourceV10 { readonly sessionEpoch: number; readonly worldRevision: number; readonly revision: number }
export interface SessionProjectionV10 {
  revision: number; worldRevision: number; sessionEpoch: number; stamp: RuntimeStampV10;
  frame: RuntimeFrameViewV10; cultivation: RuntimeCultivationViewV10; build: RuntimeBuildViewV10; expansion: RuntimeExpansionViewV10;
  selection: SessionSelectionV10; lastCommand: SessionCommandResultV10 | null;
  stopped: RuntimeOperationV10['stopped']; runtimeFailure: RuntimeInstanceErrorV10 | null;
  holds: SessionHoldsV10; paused: boolean; closed: boolean;
}
export interface BreakthroughProposalV10 { readonly kind: 'breakthrough'; readonly sessionEpoch: number; readonly stamp: RuntimeStampV10; readonly view: RuntimeReadonlyV10<RuntimeBreakthroughPreviewV10> }
export interface PlacementProposalV10 { readonly kind: 'placement'; readonly sessionEpoch: number; readonly stamp: RuntimeStampV10; readonly view: RuntimeReadonlyV10<RuntimePlacementPreviewV10> }
export interface UpgradeProposalV10 { readonly kind: 'upgrade'; readonly sessionEpoch: number; readonly stamp: RuntimeStampV10; readonly view: RuntimeReadonlyV10<RuntimeUpgradePreviewV10> }
export interface PreparedReplacementV10 extends SessionSourceV10 { readonly kind: 'v10-prepared-replacement' }
export interface PreparedSessionV10 { readonly kind: 'v10-prepared-session'; readonly preview: RuntimeReadonlyV10<SessionProjectionV10> }
type StagedSession = { session: ApplicationSessionV10; boundSnapshot: RuntimeReadonlyV10<SessionProjectionV10>;
  answer: SessionValueV10<ApplicationSessionV10>; discarded: SessionControlResultV10 };
const stagedSessions = new WeakMap<object, StagedSession>();
type Replacement = { token: PreparedReplacementV10; prepared: Prepared; snapshot: RuntimeReadonlyV10<SessionProjectionV10>; holds: SessionHoldsV10;
  proposals: WeakSet<object>; accumulator: ReturnType<typeof createFrameAccumulator>; result: SessionControlResultV10 };
type Proposal = RuntimeReadonlyV10<BreakthroughProposalV10 | PlacementProposalV10 | UpgradeProposalV10>;
type Views = Pick<RuntimeReadonlyV10<SessionProjectionV10>, 'frame' | 'cultivation' | 'build' | 'expansion'>;
type Prepared = { owner: PrivateRuntimeInstanceV10; views: Views; selection: SessionSelectionV10;
  sequence: number; stamp: RuntimeStampV10 };
const preparationFailures = new WeakMap<object, SessionFailureV10>();
const preparationFailure = (error: unknown): SessionFailureV10 | undefined =>
  error !== null && (typeof error === 'object' || typeof error === 'function') ? preparationFailures.get(error) : undefined;
const freeze = <T>(value: T): RuntimeReadonlyV10<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as RuntimeReadonlyV10<T>;
};
const failure = (code: Extract<SessionFailureV10, { kind: 'session-rejection' }>['code']): SessionFailureV10 => Object.freeze({ ok: false, kind: 'session-rejection', code });
const runtimeFailure = (error: RuntimeInstanceErrorV10, stopped: RuntimeOperationV10['stopped'] = null): SessionFailureV10 => freeze({ ok: false as const, kind: 'runtime-failure' as const, error, stopped });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const sameStamp = (a: RuntimeStampV10, b: RuntimeStampV10): boolean => a.generation === b.generation && a.publication === b.publication;
const success = (changed = false, ephemeral = false): SessionControlResultV10 => Object.freeze({ ok: true, changed, ephemeral });
function unwrap<T>(read: RuntimeReadV10<T>): RuntimeReadonlyV10<T> {
  if (!read.ok) throw new SessionPreparationErrorV10(runtimeFailure(read.error, read.stopped));
  return read.value;
}
/** Constructor failure is machine readable. Replacement reports the same union. */
export class SessionPreparationErrorV10 extends TypeError {
  readonly failure: SessionFailureV10;
  constructor(reason: SessionFailureV10) { super('Unable to prepare internal v10 Session'); this.name = 'SessionPreparationErrorV10'; this.failure = reason; preparationFailures.set(this, reason); }
}
function validSelection(selection: SessionSelectionV10, views: Pick<Views, 'frame' | 'expansion'>): SessionSelectionV10 {
  if (!selection) return null;
  const found = selection.kind === 'disciple' ? views.frame.disciples.some(row => row.id === selection.id)
    : selection.kind === 'blueprint' ? views.expansion.blueprints.some(row => row.blueprintId === selection.id)
      : selection.kind === 'sect-building' ? views.expansion.buildings.some(row => row.buildingId === selection.id)
        : views.frame.buildings.some(row => row.id === selection.id);
  return found ? { ...selection } : null;
}
function readViews(owner: PrivateRuntimeInstanceV10, requested: SessionSelectionV10): { views: Views; selection: SessionSelectionV10; stamp: RuntimeStampV10; stopped: RuntimeOperationV10['stopped'] } {
  const frameRead = owner.frame(); const frame = unwrap(frameRead); const expansion = unwrap(owner.expansion());
  const selection = validSelection(requested, { frame, expansion }); const id = selection?.kind === 'disciple' ? selection.id : null;
  const cultivation = unwrap(owner.cultivation(id)); const build = unwrap(owner.build(id));
  return { views: { frame, expansion, cultivation, build }, selection, stamp: frameRead.stamp, stopped: frameRead.stopped };
}
function closeQuietly(owner: PrivateRuntimeInstanceV10): void { try { owner.close(); } catch { /* Closing cannot roll back a committed replacement. */ } }
function prepare(input: unknown): Prepared {
  // Cold entrance only. Use the exact headless-save subset, not recovery-only runtime admission.
  const admitted = admitSaveWorldV10(input);
  if (!admitted.ok) throw new SessionPreparationErrorV10(freeze({ ok: false as const, kind: 'save-rejection' as const, code: admitted.error.code }));
  const created = createPrivateRuntimeV10(admitted.world);
  if (!created.ok) throw new SessionPreparationErrorV10(runtimeFailure(created.error, created.stopped));
  const owner = created.instance;
  try {
    if (created.recoveryOnly) throw new SessionPreparationErrorV10(freeze({ ok: false as const, kind: 'save-rejection' as const, code: 'UNSUPPORTED_SCOPE' as const }));
    // Admission/preparation must preserve every World byte. Staging, visibility
    // and storage pauses live in Session only; never inject a clock command here.
    const frame = unwrap(owner.frame());
    const initial: SessionSelectionV10 = frame.disciples[1] ? { kind: 'disciple', id: frame.disciples[1].id } : null;
    const projected = readViews(owner, initial);
    const identity = unwrap(owner.nextApplicationCommand(0));
    return { owner, ...projected, sequence: identity.sequence };
  } catch (error) { closeQuietly(owner); throw error; }
}
/** Capture caller-owned request data before inspecting or spreading any properties. */
function createCommand(input: unknown, identity: RuntimeReadonlyV10<RuntimeApplicationCommandV10>): CommandV10 | null {
  const capture = captureSaveDataV10(input); if (!capture.ok || !record(capture.value)) return null;
  const body = capture.value; if (!fields(body, ['kind', 'payload']) || !record(body.payload)) return null;
  let payload: Record<string, unknown> = body.payload;
  switch (body.kind) {
    case 'production.start': case 'production.cancel': case 'inventory.discard': break;
    case 'cultivation.command': case 'build.command':
      if (!fields(payload, ['command']) || !record(payload.command) || Object.hasOwn(payload.command, 'commandId')) return null;
      payload = { command: { ...payload.command, commandId: identity.commandId } }; break;
    case 'sect.command':
      if (!fields(payload, ['domain', 'command']) || !record(payload.command) || Object.hasOwn(payload.command, 'commandId')) return null;
      payload = { domain: payload.domain, command: { ...payload.command, commandId: identity.commandId } }; break;
    default: return null; // No expedition, campaign or new automatic-work command port.
  }
  const command = { ...identity, kind: body.kind, payload };
  return isCommandV10(command) ? command : null;
}

/** Owns methods only, never a reachable World. Views are the fixed runtime DTOs.
 * No injected factory/selector/trust flag and no root getter are accepted. */
export class ApplicationSessionV10 {
  #owner: PrivateRuntimeInstanceV10;
  #snapshot: RuntimeReadonlyV10<SessionProjectionV10>;
  #selection: SessionSelectionV10;
  #views: Views;
  #stamp: RuntimeStampV10;
  #stopped: RuntimeOperationV10['stopped'] = null;
  #runtimeFailure: RuntimeInstanceErrorV10 | null = null;
  #sequence: number;
  #epoch = 0;
  #revision = 0;
  #worldRevision = 0;
  #lastCommand: SessionCommandResultV10 | null = null;
  #baseline: number | null = null;
  #accumulator = createFrameAccumulator();
  #foreground = { visible: true, focused: true };
  #holds: SessionHoldsV10;
  #listeners = new Set<() => void>();
  #proposals = new WeakSet<object>();
  #replacement: Replacement | null = null;
  #busy = false;
  #closed = false;

  constructor(world: unknown = createUnregisteredWorldV10()) {
    const prepared = prepare(world);
    this.#owner = prepared.owner; this.#selection = prepared.selection; this.#views = prepared.views;
    this.#stamp = prepared.stamp; this.#sequence = prepared.sequence;
    this.#holds = { staging: false, storageBusy: false, storage: false, overlay: false, review: false, player: false, hidden: false };
    try { this.#snapshot = this.#project(); }
    catch (error) { closeQuietly(prepared.owner); throw error; }
  }
  /** No independently advanceable instance escapes before binding. All objects
   * needed by the successful bind are allocated here, before durable writes. */
  static prepareSession(world: unknown): SessionValueV10<PreparedSessionV10> {
    let candidate: ApplicationSessionV10 | null = null;
    try {
      candidate = new ApplicationSessionV10(world);
      const boundSnapshot = candidate.#snapshot;
      candidate.#holds.staging = true; candidate.#snapshot = candidate.#project();
      const token = Object.freeze({ kind: 'v10-prepared-session' as const, preview: candidate.#snapshot });
      const answer = Object.freeze({ ok: true as const, value: candidate });
      const returned = Object.freeze({ ok: true as const, value: token });
      stagedSessions.set(token, { session: candidate, boundSnapshot, answer, discarded: success(true) });
      candidate = null; return returned;
    } catch (error) {
      if (candidate) closeQuietly(candidate.#owner);
      return preparationFailure(error) ?? runtimeFailure('internal-failure');
    }
  }
  static bindPreparedSession(token: PreparedSessionV10): SessionValueV10<ApplicationSessionV10> {
    const staged = stagedSessions.get(token);
    if (!staged) return failure('REPLACEMENT_STALE');
    stagedSessions.delete(token); staged.session.#holds.staging = false;
    staged.session.#snapshot = staged.boundSnapshot; return staged.answer;
  }
  static discardPreparedSession(token: PreparedSessionV10): SessionControlResultV10 {
    const staged = stagedSessions.get(token);
    if (!staged) return failure('REPLACEMENT_STALE');
    stagedSessions.delete(token); closeQuietly(staged.session.#owner); return staged.discarded;
  }
  #denied(): SessionFailureV10 | null { return this.#closed ? failure('CLOSED') : this.#busy ? failure('BUSY') : null; }
  #exclusive<T>(operation: () => T): T | SessionFailureV10 {
    const denied = this.#denied(); if (denied) return denied;
    this.#busy = true; try { return operation(); } finally { this.#busy = false; }
  }
  #paused(): boolean {
    return this.#closed || !this.#foreground.visible || !this.#foreground.focused || this.#stopped !== null || this.#runtimeFailure !== null || this.#views.frame.clock.pauseReasons.length > 0 || Object.values(this.#holds).some(Boolean);
  }
  #project(): RuntimeReadonlyV10<SessionProjectionV10> {
    return freeze({ ...this.#views, revision: this.#revision, worldRevision: this.#worldRevision, sessionEpoch: this.#epoch,
      stamp: this.#stamp, selection: this.#selection, lastCommand: this.#lastCommand, stopped: this.#stopped,
      runtimeFailure: this.#runtimeFailure, holds: { ...this.#holds }, paused: this.#paused(), closed: this.#closed });
  }
  #notify(): void {
    try {
      for (const listener of [...this.#listeners]) { try { listener(); } catch { /* One UI subscriber must not partially roll back or starve others. */ } }
    } catch { /* Notification preparation cannot reverse an already committed swap. */ }
  }
  #headroom(epoch = false): boolean {
    return Number.isSafeInteger(this.#revision + 1) && Number.isSafeInteger(this.#worldRevision + 1) && (!epoch || Number.isSafeInteger(this.#epoch + 1));
  }
  #discardPrepared(): void {
    const discarded = this.#replacement; this.#replacement = null;
    if (discarded) closeQuietly(discarded.prepared.owner);
  }
  #publish(refresh = true): void {
    this.#discardPrepared();
    if (refresh) {
      try {
        const read = readViews(this.#owner, this.#selection);
        if (!sameStamp(this.#stamp, read.stamp)) this.#worldRevision++;
        this.#views = read.views; this.#selection = read.selection; this.#stamp = read.stamp; this.#stopped = read.stopped; this.#runtimeFailure = null;
      } catch (error) {
        // A failed read after an already committed operation is an explicit UI
        // safety hold. Preserve the last complete DTO set, never mix generations.
        const reason = preparationFailure(error);
        this.#runtimeFailure = reason?.kind === 'runtime-failure' ? reason.error : 'query-failed';
        this.#baseline = null;
      }
    }
    this.#revision++; this.#snapshot = this.#project(); this.#notify();
  }
  readonly getSnapshot = (): RuntimeReadonlyV10<SessionProjectionV10> => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#closed) return () => {};
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  };
  readonly getEngineVersion = (): 10 => 10;
  /** Explicit cold boundary only. No projection, frame or ordinary command calls it. */
  exportWorld(): SessionValueV10<WorldStateV10> {
    return this.#exclusive(() => {
      const result = this.#owner.snapshot();
      return result.ok && result.world ? Object.freeze({ ok: true as const, value: result.world }) : runtimeFailure(result.error ?? 'snapshot-failed', result.stopped);
    });
  }
  /** Headless text only. No save-store, import router or registered codec changes. */
  exportSave(metadata: SaveMetadata): SessionValueV10<string> {
    return this.#exclusive(() => {
      const exported = this.#owner.snapshot();
      if (!exported.ok || !exported.world) return runtimeFailure(exported.error ?? 'snapshot-failed', exported.stopped);
      try { return Object.freeze({ ok: true as const, value: serializeSaveV10(createSaveEnvelopeV10(exported.world, metadata)) }); }
      catch (error) { return error instanceof SaveCodecErrorV10 ? freeze({ ok: false as const, kind: 'save-rejection' as const, code: error.code }) : runtimeFailure('snapshot-failed'); }
    });
  }
  select(input: SessionSelectionV10): SessionControlResultV10 {
    return this.#exclusive(() => {
      if (this.#holds.storageBusy || this.#runtimeFailure) return failure('SESSION_HELD');
      const captured = captureSaveDataV10(input); if (!captured.ok) return failure('INVALID_REQUEST');
      const value = captured.value;
      if (value !== null && (!record(value) || !fields(value, ['kind', 'id']) || (value.kind !== 'disciple' && value.kind !== 'building' && value.kind !== 'blueprint' && value.kind !== 'sect-building') || typeof value.id !== 'string')) return failure('INVALID_REQUEST');
      // Reconstruct the discriminant without coercing external objects.
      const next: SessionSelectionV10 = value === null ? null : record(value) && typeof value.id === 'string' && (value.kind === 'disciple' || value.kind === 'building' || value.kind === 'blueprint' || value.kind === 'sect-building') ? { kind: value.kind, id: value.id } : null;
      if (next && !validSelection(next, this.#views)) return failure('INVALID_REQUEST');
      if (next?.kind === this.#selection?.kind && next?.id === this.#selection?.id) return success();
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      try {
        const read = readViews(this.#owner, next); this.#views = read.views; this.#selection = read.selection;
        this.#publish(false); return success(true);
      } catch { return runtimeFailure('query-failed', this.#stopped); }
    });
  }
  #submit(input: unknown, allowReview = false): SessionCommandResultV10 {
    if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
    if (this.#commandHeld(allowReview)) return failure('SESSION_HELD');
    const identity = this.#owner.nextApplicationCommand(this.#sequence);
    if (!identity.ok) return runtimeFailure(identity.error, identity.stopped);
    const command = createCommand(input, identity.value); if (!command) return failure('INVALID_REQUEST');
    this.#sequence = identity.value.sequence + 1;
    const wasPaused = this.#paused(); const outcome = this.#owner.command(command);
    this.#stopped = outcome.stopped;
    const result: SessionCommandResultV10 = outcome.ok && outcome.result !== null
      ? freeze({ ok: true as const, kind: 'command' as const, result: outcome.result, published: outcome.published })
      : runtimeFailure(outcome.error ?? 'internal-failure', outcome.stopped);
    this.#lastCommand = result; this.#publish();
    if (wasPaused !== this.#paused()) this.#baseline = null;
    return result;
  }
  dispatch(request: SessionRequestV10): SessionCommandResultV10 { return this.#exclusive(() => this.#submit(request)); }
  dispatchCultivation(request: CultivationRequestV10): SessionCommandResultV10 { return this.dispatch({ kind: 'cultivation.command', payload: { command: request } }); }
  dispatchBuild(request: BuildRequestV10): SessionCommandResultV10 { return this.dispatch({ kind: 'build.command', payload: { command: request } }); }
  dispatchSect(request: SectRequestV10): SessionCommandResultV10 { return this.dispatch({ kind: 'sect.command', payload: request }); }
  #commandHeld(allowReview = false): boolean {
    return this.#holds.staging || this.#holds.storageBusy || this.#holds.storage || this.#holds.overlay
      || this.#holds.review && !allowReview || this.#holds.player || this.#holds.hidden
      || !this.#foreground.visible || !this.#foreground.focused || this.#runtimeFailure !== null;
  }
  prepareBreakthrough(discipleId: string, preparation: BreakthroughPreparation = { method: 'standard', arraySupport: 0 }): SessionValueV10<BreakthroughProposalV10> {
    return this.#exclusive(() => {
      const read = this.#owner.previewBreakthrough({ discipleId, preparation }); if (!read.ok) return runtimeFailure(read.error, read.stopped);
      const proposal = freeze({ kind: 'breakthrough' as const, sessionEpoch: this.#epoch, stamp: read.stamp, view: read.value });
      this.#proposals.add(proposal); return Object.freeze({ ok: true as const, value: proposal });
    });
  }
  preparePlacement(request: SectPlacementRequest): SessionValueV10<PlacementProposalV10> {
    return this.#exclusive(() => {
      const read = this.#owner.previewPlacement(request); if (!read.ok) return runtimeFailure(read.error, read.stopped);
      const proposal = freeze({ kind: 'placement' as const, sessionEpoch: this.#epoch, stamp: read.stamp, view: read.value });
      this.#proposals.add(proposal); return Object.freeze({ ok: true as const, value: proposal });
    });
  }
  prepareUpgrade(request: RuntimeUpgradeRequestV10): SessionValueV10<UpgradeProposalV10> {
    return this.#exclusive(() => {
      const read = this.#owner.previewUpgrade(request); if (!read.ok) return runtimeFailure(read.error, read.stopped);
      const proposal = freeze({ kind: 'upgrade' as const, sessionEpoch: this.#epoch, stamp: read.stamp, view: read.value });
      this.#proposals.add(proposal); return Object.freeze({ ok: true as const, value: proposal });
    });
  }
  isProposalCurrent(proposal: Proposal): boolean {
    // WeakSet membership precedes any property reads: copied/hostile objects do not get inspected.
    return !this.#closed && !this.#runtimeFailure && this.#proposals.has(proposal) && proposal.sessionEpoch === this.#epoch && sameStamp(proposal.stamp, this.#stamp);
  }
  confirmBreakthrough(proposal: RuntimeReadonlyV10<BreakthroughProposalV10>): SessionCommandResultV10 {
    return this.#exclusive(() => {
      if (!this.isProposalCurrent(proposal) || proposal.kind !== 'breakthrough') return failure('PREVIEW_STALE');
      if (this.#commandHeld(true)) return failure('SESSION_HELD');
      this.#proposals.delete(proposal);
      return this.#submit({ kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.confirm',
        expectedRevision: proposal.view.preview.stateRevision, preview: proposal.view.preview } } }, true);
    });
  }
  confirmPlacement(proposal: RuntimeReadonlyV10<PlacementProposalV10>): SessionCommandResultV10 {
    return this.#exclusive(() => {
      if (!this.isProposalCurrent(proposal) || proposal.kind !== 'placement') return failure('PREVIEW_STALE');
      if (this.#commandHeld(true)) return failure('SESSION_HELD');
      this.#proposals.delete(proposal);
      return this.#submit({ kind: 'sect.command', payload: { domain: 'construction', command: { kind: 'blueprint.place',
        expectedRevision: proposal.view.expectedRevision, placement: proposal.view.request } } }, true);
    });
  }
  confirmUpgrade(proposal: RuntimeReadonlyV10<UpgradeProposalV10>): SessionCommandResultV10 {
    return this.#exclusive(() => {
      if (!this.isProposalCurrent(proposal) || proposal.kind !== 'upgrade') return failure('PREVIEW_STALE');
      if (this.#commandHeld(true)) return failure('SESSION_HELD');
      this.#proposals.delete(proposal);
      return this.#submit({ kind: 'sect.command', payload: { domain: 'upgrade', command: {
        kind: 'upgrade.start', expectedRevision: proposal.view.revision,
        buildingId: proposal.view.buildingId, workerId: proposal.view.workerId } } }, true);
    });
  }
  #pause(reason: 'player' | 'hidden', paused: boolean): SessionControlResultV10 {
    if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
    const result = this.#owner.controlClock({ kind: 'pause', reason, paused });
    if (!result.ok && !(paused && result.error === 'capacity')) return runtimeFailure(result.error ?? 'internal-failure', result.stopped);
    const ephemeral = !result.ok; const changed = result.changed || this.#holds[reason] !== ephemeral;
    this.#holds[reason] = ephemeral; this.#stopped = result.stopped;
    if (changed) { this.#baseline = null; this.#publish(result.ok && result.changed); }
    return success(changed, ephemeral);
  }
  setPaused(reason: 'player' | 'hidden', paused: boolean): SessionControlResultV10 {
    return this.#exclusive(() => {
      if (this.#holds.storageBusy) return failure('SESSION_HELD');
      if ((reason !== 'player' && reason !== 'hidden') || typeof paused !== 'boolean') return failure('INVALID_REQUEST');
      if (reason === 'player' && (this.#holds.storageBusy || this.#holds.storage || this.#holds.overlay || this.#holds.review)) return failure('SESSION_HELD');
      return this.#pause(reason, paused);
    });
  }
  togglePlayerPause(): SessionControlResultV10 { return this.setPaused('player', !(this.#holds.player || this.#views.frame.clock.pauseReasons.includes('player'))); }
  setSpeed(speed: SimulationSpeed): SessionControlResultV10 {
    return this.#exclusive(() => {
      if (speed !== 1 && speed !== 3) return failure('INVALID_REQUEST');
      if (this.#holds.storageBusy || this.#holds.storage || this.#holds.overlay || this.#holds.review) return failure('SESSION_HELD');
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      const result = this.#owner.controlClock({ kind: 'speed', speed });
      if (!result.ok) return runtimeFailure(result.error ?? 'internal-failure', result.stopped);
      this.#stopped = result.stopped;
      if (result.changed) { this.#baseline = null; this.#publish(); }
      return success(result.changed);
    });
  }
  setForeground(input: Partial<{ visible: boolean; focused: boolean }>): SessionControlResultV10 {
    return this.#exclusive(() => {
      const capture = captureSaveDataV10(input);
      if (!capture.ok || !record(capture.value) || Object.entries(capture.value).some(([key, value]) => !['visible', 'focused'].includes(key) || typeof value !== 'boolean')) return failure('INVALID_REQUEST');
      const next = { visible: typeof capture.value.visible === 'boolean' ? capture.value.visible : this.#foreground.visible,
        focused: typeof capture.value.focused === 'boolean' ? capture.value.focused : this.#foreground.focused };
      const changed = next.visible !== this.#foreground.visible || next.focused !== this.#foreground.focused;
      if (!changed) return success();
      if (this.#holds.storageBusy) {
        this.#foreground = next; this.#baseline = null; return success(changed, true);
      }
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      this.#foreground = next; this.#baseline = null;
      // Browser visibility is an ephemeral application hold. In particular,
      // binding/releasing storage must not rewrite a persisted hidden reason.
      this.#publish(false); return success(true, true);
    });
  }
  #hold(kind: 'storageBusy' | 'storage' | 'overlay' | 'review', held: boolean): SessionControlResultV10 {
    return this.#exclusive(() => {
      if (typeof held !== 'boolean') return failure('INVALID_REQUEST');
      if (this.#holds[kind] === held) return success();
      if (this.#holds.storageBusy && kind !== 'storageBusy') return failure('SESSION_HELD');
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      this.#holds[kind] = held; this.#baseline = null; this.#publish(false); return success(true, held);
    });
  }
  setStorageBusy(busy: boolean): SessionControlResultV10 { return this.#hold('storageBusy', busy); }
  setStorageReadOnly(readOnly: boolean): SessionControlResultV10 { return this.#hold('storage', readOnly); }
  setOverlayPaused(paused: boolean): SessionControlResultV10 { return this.#hold('overlay', paused); }
  setReviewPaused(paused: boolean): SessionControlResultV10 { return this.#hold('review', paused); }
  /** Fresh scalar-only local diagnostic read; no publication or World access. */
  readonly getFrameDiagnostics = (): Readonly<{ pendingMicroseconds: number; baselineEstablished: boolean }> =>
    Object.freeze({ pendingMicroseconds: this.#accumulator.remainderMicroseconds, baselineEstablished: this.#baseline !== null });
  resetFrameBaseline(): void { if (!this.#busy) this.#baseline = null; }
  /** The platform supplies time. At most 20 fixed ticks per call; backlog is kept.
   * Hidden/paused intervals are discarded, retaining an incomplete pre-pause tick. */
  frame(timestamp: number): SessionValueV10<number> {
    return this.#exclusive(() => {
      if (!Number.isFinite(timestamp)) return failure('INVALID_REQUEST');
      if (this.#paused()) { this.#baseline = null; return Object.freeze({ ok: true as const, value: 0 }); }
      if (this.#baseline === null || timestamp < this.#baseline) { this.#baseline = timestamp; return Object.freeze({ ok: true as const, value: 0 }); }
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      let accumulated: ReturnType<typeof accumulateFrame>;
      try { accumulated = accumulateFrame(this.#accumulator, timestamp - this.#baseline,
        { ...this.#views.frame.clock, pauseReasons: [...this.#views.frame.clock.pauseReasons] }, 20); }
      catch { this.#baseline = null; return failure('INVALID_REQUEST'); }
      this.#baseline = timestamp; this.#accumulator = accumulated.accumulator;
      if (accumulated.ticks === 0) return Object.freeze({ ok: true as const, value: 0 });
      const result = this.#owner.advance(accumulated.ticks); this.#stopped = result.stopped;
      // A paused domain boundary may stop partway through the allocated batch.
      // Like the existing Session, the unused batch is discarded at that pause.
      this.#publish();
      if (this.#paused()) this.#baseline = null;
      return result.ok ? Object.freeze({ ok: true as const, value: result.advancedTicks }) : runtimeFailure(result.error ?? 'internal-failure', result.stopped);
    });
  }
  /** Retry DTO preparation after a contained query failure, without advancing. */
  refresh(): SessionControlResultV10 {
    return this.#exclusive(() => {
      if (this.#holds.storageBusy) return failure('SESSION_HELD');
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      this.#publish(); return this.#runtimeFailure ? runtimeFailure(this.#runtimeFailure, this.#stopped) : success(true);
    });
  }
  #prepareReplacement(world: unknown): SessionValueV10<PreparedReplacementV10> {
    if (this.#holds.storageBusy && this.#replacement) return failure('SESSION_HELD');
    if (!this.#headroom(true)) return failure('COUNTER_EXHAUSTED');
    this.#discardPrepared();
    let prepared: Prepared | null = null;
    try {
      prepared = prepare(world);
      const holds: SessionHoldsV10 = { staging: false, storageBusy: this.#holds.storageBusy, storage: this.#holds.storage,
        overlay: this.#holds.overlay, review: false, player: false, hidden: false };
      // Every fallible/allocation-bearing replacement component precedes swap.
      const epoch = this.#epoch + 1; const revision = this.#revision + 1; const worldRevision = this.#worldRevision + 1;
      const proposals = new WeakSet<object>(); const accumulator = createFrameAccumulator(); const liveHolds = { ...holds };
      const snapshot = freeze({ ...prepared.views, revision, worldRevision, sessionEpoch: epoch, stamp: prepared.stamp,
        selection: prepared.selection, lastCommand: null, stopped: null, runtimeFailure: null, holds,
        paused: !this.#foreground.visible || !this.#foreground.focused || prepared.views.frame.clock.pauseReasons.length > 0 || Object.values(holds).some(Boolean), closed: false });
      const token = Object.freeze({ kind: 'v10-prepared-replacement' as const, sessionEpoch: this.#epoch,
        worldRevision: this.#worldRevision, revision: this.#revision });
      const result = success(true); const answer = Object.freeze({ ok: true as const, value: token });
      const replacement: Replacement = { token, prepared, snapshot, holds: liveHolds, proposals, accumulator, result };
      this.#replacement = replacement; prepared = null;
      return answer;
    } catch (error) {
      if (prepared) closeQuietly(prepared.owner);
      return preparationFailure(error) ?? runtimeFailure('internal-failure');
    }
  }
  /** A single private candidate. Acquire storageBusy before preparing; commit
   * while it remains held, then release it. Any intervening publication stales
   * the token and closes its owner. Starting another preparation closes the
   * previous candidate. Failed preparation changes no live Session state. */
  prepareReplacement(world: unknown): SessionValueV10<PreparedReplacementV10> {
    return this.#exclusive(() => this.#prepareReplacement(world));
  }
  #commitReplacement(token: PreparedReplacementV10): SessionControlResultV10 {
    const candidate = this.#replacement;
    // Compare identity before reading caller-controlled token properties.
    if (!candidate || candidate.token !== token) return failure('REPLACEMENT_STALE');
    if (candidate.token.sessionEpoch !== this.#epoch || candidate.token.worldRevision !== this.#worldRevision || candidate.token.revision !== this.#revision) {
      this.#replacement = null; closeQuietly(candidate.prepared.owner); return failure('REPLACEMENT_STALE');
    }
    const { prepared, snapshot } = candidate; const previous = this.#owner;
    this.#owner = prepared.owner; this.#views = prepared.views; this.#selection = prepared.selection; this.#stamp = prepared.stamp;
    this.#sequence = prepared.sequence; this.#epoch = snapshot.sessionEpoch; this.#revision = snapshot.revision; this.#worldRevision = snapshot.worldRevision;
    this.#holds = candidate.holds; this.#lastCommand = null; this.#stopped = null; this.#runtimeFailure = null;
    this.#proposals = candidate.proposals; this.#accumulator = candidate.accumulator; this.#baseline = null; this.#snapshot = snapshot;
    this.#replacement = null; closeQuietly(previous); this.#notify(); return candidate.result;
  }
  commitReplacement(token: PreparedReplacementV10): SessionControlResultV10 {
    const denied = this.#denied(); if (denied) return denied;
    this.#busy = true;
    try { return this.#commitReplacement(token); }
    finally { this.#busy = false; }
  }
  discardReplacement(token: PreparedReplacementV10): SessionControlResultV10 {
    return this.#exclusive(() => {
      if (!this.#replacement || this.#replacement.token !== token) return failure('REPLACEMENT_STALE');
      const discarded = this.#replacement; this.#replacement = null; closeQuietly(discarded.prepared.owner); return success(true);
    });
  }
  replaceWorld(world: unknown): SessionControlResultV10 {
    return this.#exclusive(() => {
      const prepared = this.#prepareReplacement(world); return prepared.ok ? this.#commitReplacement(prepared.value) : prepared;
    });
  }
  close(): SessionControlResultV10 {
    return this.#exclusive(() => {
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      this.#closed = true; this.#baseline = null; this.#proposals = new WeakSet<object>();
      if (this.#replacement) { closeQuietly(this.#replacement.prepared.owner); this.#replacement = null; }
      closeQuietly(this.#owner); this.#publish(false); this.#listeners.clear(); return success(true);
    });
  }
}
