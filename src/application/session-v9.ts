import type { BuildCommand } from '../core/builds/types';
import type { BreakthroughPreparation } from '../core/cultivation/types';
import { accumulateFrame, createFrameAccumulator, type SimulationSpeed } from '../core/kernel/clock';
import { isCommandV9 } from '../core/kernel/commands-v9';
import type { Command, PlayerCultivationCommand } from '../core/kernel/contracts';
import type { CommandV9, SectCommandV9 } from '../core/kernel/contracts-v9';
import { createSaveEnvelopeV9, SaveCodecErrorV9, serializeSaveV9 } from '../core/kernel/save-v9';
import type { SaveMetadata } from '../core/kernel/save';
import type { SectPlacementRequest } from '../core/sect-expansion/types';
import { createUnregisteredWorldV9 } from '../core/world/create-world-v9';
import type { CapacityLimitedResultV9 } from '../core/world/runtime-capacity-v9';
import { createPrivateRuntimeV9, type PrivateRuntimeInstanceV9, type RuntimeInstanceErrorV9,
  type RuntimeOperationV9, type RuntimeStampV9 } from '../core/world/runtime-instance-v9';
import type { RuntimeApplicationCommandV9, RuntimeBreakthroughPreviewV9, RuntimeBuildViewV9,
  RuntimeCultivationViewV9, RuntimeExpansionViewV9, RuntimeFrameViewV9, RuntimePlacementPreviewV9,
  RuntimeReadV9, RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import { admitSaveWorldV9, captureSaveDataV9, type SaveErrorCodeV9 } from '../core/world/save-admission-v9';
import type { WorldStateV9 } from '../core/world/v9-types';

/** Deliberately separate from the registered v7/v8 Session and platform codec. */
type WithoutId<T> = T extends unknown ? Omit<T, 'commandId'> : never;
type PlayerBody<T> = T extends unknown ? Omit<T, 'commandId' | 'sequence' | 'issuedTick'> : never;
export type SessionSelectionV9 = { kind: 'disciple' | 'building' | 'blueprint' | 'sect-building'; id: string } | null;
export type CultivationRequestV9 = WithoutId<PlayerCultivationCommand>;
export type BuildRequestV9 = WithoutId<BuildCommand>;
export type SectRequestV9 = { [D in SectCommandV9['domain']]: {
  domain: D; command: WithoutId<Extract<SectCommandV9, { domain: D }>['command']>;
} }[SectCommandV9['domain']];
export type SessionRequestV9 = PlayerBody<Extract<Command, { kind: 'production.start' | 'production.cancel' | 'inventory.discard' }>>
  | { kind: 'cultivation.command'; payload: { command: CultivationRequestV9 } }
  | { kind: 'build.command'; payload: { command: BuildRequestV9 } }
  | { kind: 'sect.command'; payload: SectRequestV9 };
export type SessionFailureV9 =
  | { readonly ok: false; readonly kind: 'session-rejection'; readonly code: 'CLOSED' | 'BUSY' | 'SESSION_HELD' | 'INVALID_REQUEST' | 'PREVIEW_STALE' | 'REPLACEMENT_STALE' | 'COUNTER_EXHAUSTED' }
  | { readonly ok: false; readonly kind: 'runtime-failure'; readonly error: RuntimeInstanceErrorV9; readonly stopped: RuntimeOperationV9['stopped'] }
  | { readonly ok: false; readonly kind: 'save-rejection'; readonly code: SaveErrorCodeV9 };
/** ok means a typed domain result was received; inspect result.status for acceptance.
 * Do not flatten sectResult, v9 rejection codes or runtime failures to v7 results. */
export type SessionCommandResultV9 = SessionFailureV9 | { readonly ok: true; readonly kind: 'command';
  readonly result: RuntimeReadonlyV9<CapacityLimitedResultV9>; readonly published: boolean };
export type SessionControlResultV9 = SessionFailureV9 | { readonly ok: true; readonly changed: boolean; readonly ephemeral: boolean };
// Readonly belongs to each value protocol. Do not recursively remap the complete
// recursive World schema in a generic transport wrapper (cold export is already
// detached and frozen by RuntimeSnapshotV9). Fixed DTOs retain deep-readonly types.
export type SessionValueV9<T> = SessionFailureV9 | { readonly ok: true; readonly value: T };
export interface SessionHoldsV9 { storageBusy: boolean; storage: boolean; overlay: boolean; review: boolean; player: boolean; hidden: boolean }
export interface SessionProjectionV9 {
  revision: number; worldRevision: number; sessionEpoch: number; stamp: RuntimeStampV9;
  frame: RuntimeFrameViewV9; cultivation: RuntimeCultivationViewV9; build: RuntimeBuildViewV9; expansion: RuntimeExpansionViewV9;
  selection: SessionSelectionV9; lastCommand: SessionCommandResultV9 | null;
  stopped: RuntimeOperationV9['stopped']; runtimeFailure: RuntimeInstanceErrorV9 | null;
  holds: SessionHoldsV9; paused: boolean; closed: boolean;
}
export interface BreakthroughProposalV9 { readonly kind: 'breakthrough'; readonly sessionEpoch: number; readonly stamp: RuntimeStampV9; readonly view: RuntimeReadonlyV9<RuntimeBreakthroughPreviewV9> }
export interface PlacementProposalV9 { readonly kind: 'placement'; readonly sessionEpoch: number; readonly stamp: RuntimeStampV9; readonly view: RuntimeReadonlyV9<RuntimePlacementPreviewV9> }
export interface PreparedReplacementV9 { readonly kind: 'v9-prepared-replacement'; readonly sessionEpoch: number; readonly revision: number }
type Replacement = { token: PreparedReplacementV9; prepared: Prepared; snapshot: RuntimeReadonlyV9<SessionProjectionV9>; holds: SessionHoldsV9;
  proposals: WeakSet<object>; accumulator: ReturnType<typeof createFrameAccumulator>; result: SessionControlResultV9 };
type Proposal = RuntimeReadonlyV9<BreakthroughProposalV9 | PlacementProposalV9>;
type Views = Pick<RuntimeReadonlyV9<SessionProjectionV9>, 'frame' | 'cultivation' | 'build' | 'expansion'>;
type Prepared = { owner: PrivateRuntimeInstanceV9; views: Views; selection: SessionSelectionV9;
  sequence: number; stamp: RuntimeStampV9; ephemeralPlayer: boolean; ephemeralHidden: boolean };
const freeze = <T>(value: T): RuntimeReadonlyV9<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as RuntimeReadonlyV9<T>;
};
const failure = (code: Extract<SessionFailureV9, { kind: 'session-rejection' }>['code']): SessionFailureV9 => Object.freeze({ ok: false, kind: 'session-rejection', code });
const runtimeFailure = (error: RuntimeInstanceErrorV9, stopped: RuntimeOperationV9['stopped'] = null): SessionFailureV9 => freeze({ ok: false as const, kind: 'runtime-failure' as const, error, stopped });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const sameStamp = (a: RuntimeStampV9, b: RuntimeStampV9): boolean => a.generation === b.generation && a.publication === b.publication;
const success = (changed = false, ephemeral = false): SessionControlResultV9 => Object.freeze({ ok: true, changed, ephemeral });
function unwrap<T>(read: RuntimeReadV9<T>): RuntimeReadonlyV9<T> {
  if (!read.ok) throw new SessionPreparationErrorV9(runtimeFailure(read.error, read.stopped));
  return read.value;
}
/** Constructor failure is machine readable. Replacement reports the same union. */
export class SessionPreparationErrorV9 extends TypeError {
  readonly failure: SessionFailureV9;
  constructor(reason: SessionFailureV9) { super('Unable to prepare internal v9 Session'); this.name = 'SessionPreparationErrorV9'; this.failure = reason; }
}
function validSelection(selection: SessionSelectionV9, views: Pick<Views, 'frame' | 'expansion'>): SessionSelectionV9 {
  if (!selection) return null;
  const found = selection.kind === 'disciple' ? views.frame.disciples.some(row => row.id === selection.id)
    : selection.kind === 'blueprint' ? views.expansion.blueprints.some(row => row.blueprintId === selection.id)
      : selection.kind === 'sect-building' ? views.expansion.buildings.some(row => row.buildingId === selection.id)
        : views.frame.buildings.some(row => row.id === selection.id);
  return found ? { ...selection } : null;
}
function readViews(owner: PrivateRuntimeInstanceV9, requested: SessionSelectionV9): { views: Views; selection: SessionSelectionV9; stamp: RuntimeStampV9; stopped: RuntimeOperationV9['stopped'] } {
  const frameRead = owner.frame(); const frame = unwrap(frameRead); const expansion = unwrap(owner.expansion());
  const selection = validSelection(requested, { frame, expansion }); const id = selection?.kind === 'disciple' ? selection.id : null;
  const cultivation = unwrap(owner.cultivation(id)); const build = unwrap(owner.build(id));
  return { views: { frame, expansion, cultivation, build }, selection, stamp: frameRead.stamp, stopped: frameRead.stopped };
}
function closeQuietly(owner: PrivateRuntimeInstanceV9): void { try { owner.close(); } catch { /* Closing cannot roll back a committed replacement. */ } }
function prepare(input: unknown, replacement: boolean, hidden: boolean): Prepared {
  // Cold entrance only. Use the exact headless-save subset, not recovery-only runtime admission.
  const admitted = admitSaveWorldV9(input);
  if (!admitted.ok) throw new SessionPreparationErrorV9(freeze({ ok: false as const, kind: 'save-rejection' as const, code: admitted.error.code }));
  const created = createPrivateRuntimeV9(admitted.world);
  if (!created.ok) throw new SessionPreparationErrorV9(runtimeFailure(created.error, created.stopped));
  const owner = created.instance;
  try {
    if (created.recoveryOnly) throw new SessionPreparationErrorV9(freeze({ ok: false as const, kind: 'save-rejection' as const, code: 'UNSUPPORTED_SCOPE' as const }));
    let ephemeralPlayer = false; let ephemeralHidden = false;
    if (replacement) {
      for (const [reason, paused] of [['hidden', hidden], ['player', true]] as const) {
        const controlled = owner.controlClock({ kind: 'pause', reason, paused });
        if (!controlled.ok) {
          if (controlled.error !== 'capacity' || !paused) throw new SessionPreparationErrorV9(runtimeFailure(controlled.error, controlled.stopped));
          if (reason === 'player') ephemeralPlayer = true; else ephemeralHidden = true;
        }
      }
    }
    const frame = unwrap(owner.frame());
    const initial: SessionSelectionV9 = frame.disciples[1] ? { kind: 'disciple', id: frame.disciples[1].id } : null;
    const projected = readViews(owner, initial);
    const identity = unwrap(owner.nextApplicationCommand(0));
    return { owner, ...projected, sequence: identity.sequence, ephemeralPlayer, ephemeralHidden };
  } catch (error) { closeQuietly(owner); throw error; }
}
/** Capture caller-owned request data before inspecting or spreading any properties. */
function createCommand(input: unknown, identity: RuntimeReadonlyV9<RuntimeApplicationCommandV9>): CommandV9 | null {
  const capture = captureSaveDataV9(input); if (!capture.ok || !record(capture.value)) return null;
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
  return isCommandV9(command) ? command : null;
}

/** Owns methods only, never a reachable World. Views are the fixed runtime DTOs.
 * No injected factory/selector/trust flag and no root getter are accepted. */
export class ApplicationSessionV9 {
  #owner: PrivateRuntimeInstanceV9;
  #snapshot: RuntimeReadonlyV9<SessionProjectionV9>;
  #selection: SessionSelectionV9;
  #views: Views;
  #stamp: RuntimeStampV9;
  #stopped: RuntimeOperationV9['stopped'] = null;
  #runtimeFailure: RuntimeInstanceErrorV9 | null = null;
  #sequence: number;
  #epoch = 0;
  #revision = 0;
  #worldRevision = 0;
  #lastCommand: SessionCommandResultV9 | null = null;
  #baseline: number | null = null;
  #accumulator = createFrameAccumulator();
  #foreground = { visible: true, focused: true };
  #holds: SessionHoldsV9;
  #listeners = new Set<() => void>();
  #proposals = new WeakSet<object>();
  #replacement: Replacement | null = null;
  #busy = false;
  #closed = false;

  constructor(world: unknown = createUnregisteredWorldV9()) {
    const prepared = prepare(world, false, false);
    this.#owner = prepared.owner; this.#selection = prepared.selection; this.#views = prepared.views;
    this.#stamp = prepared.stamp; this.#sequence = prepared.sequence;
    this.#holds = { storageBusy: false, storage: false, overlay: false, review: false, player: false, hidden: false };
    try { this.#snapshot = this.#project(); }
    catch (error) { closeQuietly(prepared.owner); throw error; }
  }
  #denied(): SessionFailureV9 | null { return this.#closed ? failure('CLOSED') : this.#busy ? failure('BUSY') : null; }
  #exclusive<T>(operation: () => T): T | SessionFailureV9 {
    const denied = this.#denied(); if (denied) return denied;
    this.#busy = true; try { return operation(); } finally { this.#busy = false; }
  }
  #paused(): boolean {
    return this.#closed || !this.#foreground.visible || !this.#foreground.focused || this.#stopped !== null || this.#runtimeFailure !== null || this.#views.frame.clock.pauseReasons.length > 0 || Object.values(this.#holds).some(Boolean);
  }
  #project(): RuntimeReadonlyV9<SessionProjectionV9> {
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
        this.#runtimeFailure = error instanceof SessionPreparationErrorV9 && error.failure.kind === 'runtime-failure' ? error.failure.error : 'query-failed';
        this.#baseline = null;
      }
    }
    this.#revision++; this.#snapshot = this.#project(); this.#notify();
  }
  readonly getSnapshot = (): RuntimeReadonlyV9<SessionProjectionV9> => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#closed) return () => {};
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  };
  readonly getEngineVersion = (): 9 => 9;
  /** Explicit cold boundary only. No projection, frame or ordinary command calls it. */
  exportWorld(): SessionValueV9<WorldStateV9> {
    return this.#exclusive(() => {
      const result = this.#owner.snapshot();
      return result.ok && result.world ? Object.freeze({ ok: true as const, value: result.world }) : runtimeFailure(result.error ?? 'snapshot-failed', result.stopped);
    });
  }
  /** Headless text only. No save-store, import router or registered codec changes. */
  exportSave(metadata: SaveMetadata): SessionValueV9<string> {
    return this.#exclusive(() => {
      const exported = this.#owner.snapshot();
      if (!exported.ok || !exported.world) return runtimeFailure(exported.error ?? 'snapshot-failed', exported.stopped);
      try { return Object.freeze({ ok: true as const, value: serializeSaveV9(createSaveEnvelopeV9(exported.world, metadata)) }); }
      catch (error) { return error instanceof SaveCodecErrorV9 ? freeze({ ok: false as const, kind: 'save-rejection' as const, code: error.code }) : runtimeFailure('snapshot-failed'); }
    });
  }
  select(input: SessionSelectionV9): SessionControlResultV9 {
    return this.#exclusive(() => {
      if (this.#holds.storageBusy || this.#runtimeFailure) return failure('SESSION_HELD');
      const captured = captureSaveDataV9(input); if (!captured.ok) return failure('INVALID_REQUEST');
      const value = captured.value;
      if (value !== null && (!record(value) || !fields(value, ['kind', 'id']) || (value.kind !== 'disciple' && value.kind !== 'building' && value.kind !== 'blueprint' && value.kind !== 'sect-building') || typeof value.id !== 'string')) return failure('INVALID_REQUEST');
      // Reconstruct the discriminant without coercing external objects.
      const next: SessionSelectionV9 = value === null ? null : record(value) && typeof value.id === 'string' && (value.kind === 'disciple' || value.kind === 'building' || value.kind === 'blueprint' || value.kind === 'sect-building') ? { kind: value.kind, id: value.id } : null;
      if (next && !validSelection(next, this.#views)) return failure('INVALID_REQUEST');
      if (next?.kind === this.#selection?.kind && next?.id === this.#selection?.id) return success();
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      try {
        const read = readViews(this.#owner, next); this.#views = read.views; this.#selection = read.selection;
        this.#publish(false); return success(true);
      } catch { return runtimeFailure('query-failed', this.#stopped); }
    });
  }
  #submit(input: unknown, allowReview = false): SessionCommandResultV9 {
    if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
    if (this.#holds.storageBusy || this.#holds.storage || this.#holds.overlay || (this.#holds.review && !allowReview) || this.#holds.player || this.#holds.hidden || this.#runtimeFailure) return failure('SESSION_HELD');
    const identity = this.#owner.nextApplicationCommand(this.#sequence);
    if (!identity.ok) return runtimeFailure(identity.error, identity.stopped);
    const command = createCommand(input, identity.value); if (!command) return failure('INVALID_REQUEST');
    this.#sequence = identity.value.sequence + 1;
    const wasPaused = this.#paused(); const outcome = this.#owner.command(command);
    this.#stopped = outcome.stopped;
    const result: SessionCommandResultV9 = outcome.ok && outcome.result !== null
      ? freeze({ ok: true as const, kind: 'command' as const, result: outcome.result, published: outcome.published })
      : runtimeFailure(outcome.error ?? 'internal-failure', outcome.stopped);
    this.#lastCommand = result; this.#publish();
    if (wasPaused !== this.#paused()) this.#baseline = null;
    return result;
  }
  dispatch(request: SessionRequestV9): SessionCommandResultV9 { return this.#exclusive(() => this.#submit(request)); }
  dispatchCultivation(request: CultivationRequestV9): SessionCommandResultV9 { return this.dispatch({ kind: 'cultivation.command', payload: { command: request } }); }
  dispatchBuild(request: BuildRequestV9): SessionCommandResultV9 { return this.dispatch({ kind: 'build.command', payload: { command: request } }); }
  dispatchSect(request: SectRequestV9): SessionCommandResultV9 { return this.dispatch({ kind: 'sect.command', payload: request }); }
  prepareBreakthrough(discipleId: string, preparation: BreakthroughPreparation = { method: 'standard', arraySupport: 0 }): SessionValueV9<BreakthroughProposalV9> {
    return this.#exclusive(() => {
      const read = this.#owner.previewBreakthrough({ discipleId, preparation }); if (!read.ok) return runtimeFailure(read.error, read.stopped);
      const proposal = freeze({ kind: 'breakthrough' as const, sessionEpoch: this.#epoch, stamp: read.stamp, view: read.value });
      this.#proposals.add(proposal); return Object.freeze({ ok: true as const, value: proposal });
    });
  }
  preparePlacement(request: SectPlacementRequest): SessionValueV9<PlacementProposalV9> {
    return this.#exclusive(() => {
      const read = this.#owner.previewPlacement(request); if (!read.ok) return runtimeFailure(read.error, read.stopped);
      const proposal = freeze({ kind: 'placement' as const, sessionEpoch: this.#epoch, stamp: read.stamp, view: read.value });
      this.#proposals.add(proposal); return Object.freeze({ ok: true as const, value: proposal });
    });
  }
  isProposalCurrent(proposal: Proposal): boolean {
    // WeakSet membership precedes any property reads: copied/hostile objects do not get inspected.
    return !this.#closed && !this.#runtimeFailure && this.#proposals.has(proposal) && proposal.sessionEpoch === this.#epoch && sameStamp(proposal.stamp, this.#stamp);
  }
  confirmBreakthrough(proposal: RuntimeReadonlyV9<BreakthroughProposalV9>): SessionCommandResultV9 {
    return this.#exclusive(() => {
      if (!this.isProposalCurrent(proposal) || proposal.kind !== 'breakthrough') return failure('PREVIEW_STALE');
      return this.#submit({ kind: 'cultivation.command', payload: { command: { kind: 'breakthrough.confirm',
        expectedRevision: proposal.view.preview.stateRevision, preview: proposal.view.preview } } }, true);
    });
  }
  confirmPlacement(proposal: RuntimeReadonlyV9<PlacementProposalV9>): SessionCommandResultV9 {
    return this.#exclusive(() => {
      if (!this.isProposalCurrent(proposal) || proposal.kind !== 'placement') return failure('PREVIEW_STALE');
      return this.#submit({ kind: 'sect.command', payload: { domain: 'construction', command: { kind: 'blueprint.place',
        expectedRevision: proposal.view.expectedRevision, placement: proposal.view.request } } }, true);
    });
  }
  #pause(reason: 'player' | 'hidden', paused: boolean): SessionControlResultV9 {
    if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
    const result = this.#owner.controlClock({ kind: 'pause', reason, paused });
    if (!result.ok && !(paused && result.error === 'capacity')) return runtimeFailure(result.error, result.stopped);
    const ephemeral = !result.ok; const changed = result.changed || this.#holds[reason] !== ephemeral;
    this.#holds[reason] = ephemeral; this.#stopped = result.stopped;
    if (changed) { this.#baseline = null; this.#publish(result.ok && result.changed); }
    return success(changed, ephemeral);
  }
  setPaused(reason: 'player' | 'hidden', paused: boolean): SessionControlResultV9 {
    return this.#exclusive(() => {
      if (this.#holds.storageBusy) return failure('SESSION_HELD');
      if ((reason !== 'player' && reason !== 'hidden') || typeof paused !== 'boolean') return failure('INVALID_REQUEST');
      if (reason === 'player' && (this.#holds.storageBusy || this.#holds.storage || this.#holds.overlay || this.#holds.review)) return failure('SESSION_HELD');
      return this.#pause(reason, paused);
    });
  }
  togglePlayerPause(): SessionControlResultV9 { return this.setPaused('player', !(this.#holds.player || this.#views.frame.clock.pauseReasons.includes('player'))); }
  setSpeed(speed: SimulationSpeed): SessionControlResultV9 {
    return this.#exclusive(() => {
      if (speed !== 1 && speed !== 3) return failure('INVALID_REQUEST');
      if (this.#holds.storageBusy || this.#holds.storage || this.#holds.overlay || this.#holds.review) return failure('SESSION_HELD');
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      const result = this.#owner.controlClock({ kind: 'speed', speed });
      if (!result.ok) return runtimeFailure(result.error, result.stopped);
      this.#stopped = result.stopped;
      if (result.changed) { this.#baseline = null; this.#publish(); }
      return success(result.changed);
    });
  }
  setForeground(input: Partial<{ visible: boolean; focused: boolean }>): SessionControlResultV9 {
    return this.#exclusive(() => {
      const capture = captureSaveDataV9(input);
      if (!capture.ok || !record(capture.value) || Object.entries(capture.value).some(([key, value]) => !['visible', 'focused'].includes(key) || typeof value !== 'boolean')) return failure('INVALID_REQUEST');
      const next = { visible: typeof capture.value.visible === 'boolean' ? capture.value.visible : this.#foreground.visible,
        focused: typeof capture.value.focused === 'boolean' ? capture.value.focused : this.#foreground.focused };
      if (this.#holds.storageBusy) {
        const changed = next.visible !== this.#foreground.visible || next.focused !== this.#foreground.focused;
        this.#foreground = next; this.#baseline = null; return success(changed, true);
      }
      this.#foreground = next; this.#baseline = null;
      const result = this.#pause('hidden', !next.visible || !next.focused);
      if (result.ok) { this.#baseline = null; }
      else if (!next.visible || !next.focused) {
        // Even an unexpected clock failure must never accrue hidden wall time.
        this.#foreground = next; this.#holds.hidden = true; this.#baseline = null;
        if (this.#headroom()) this.#publish(false);
      }
      return result;
    });
  }
  #hold(kind: 'storageBusy' | 'storage' | 'overlay' | 'review', held: boolean): SessionControlResultV9 {
    return this.#exclusive(() => {
      if (typeof held !== 'boolean') return failure('INVALID_REQUEST');
      if (this.#holds[kind] === held) return success();
      if (this.#holds.storageBusy && kind !== 'storageBusy') return failure('SESSION_HELD');
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      if (kind === 'storageBusy' && !held) {
        const hidden = !this.#foreground.visible || !this.#foreground.focused;
        const reconciled = this.#pause('hidden', hidden);
        if (!reconciled.ok) {
          // A failed visible reconciliation may leave a persisted hidden pause.
          // For hidden state the ephemeral hold independently prevents time.
          this.#holds.hidden = hidden || this.#holds.hidden;
          this.#runtimeFailure = reconciled.kind === 'runtime-failure' ? reconciled.error : 'internal-failure';
        }
      }
      this.#holds[kind] = held; this.#baseline = null; this.#publish(false); return success(true, held);
    });
  }
  setStorageBusy(busy: boolean): SessionControlResultV9 { return this.#hold('storageBusy', busy); }
  setStorageReadOnly(readOnly: boolean): SessionControlResultV9 { return this.#hold('storage', readOnly); }
  setOverlayPaused(paused: boolean): SessionControlResultV9 { return this.#hold('overlay', paused); }
  setReviewPaused(paused: boolean): SessionControlResultV9 { return this.#hold('review', paused); }
  resetFrameBaseline(): void { if (!this.#busy) this.#baseline = null; }
  /** The platform supplies time. At most 20 fixed ticks per call; backlog is kept.
   * Hidden/paused intervals are discarded, retaining an incomplete pre-pause tick. */
  frame(timestamp: number): SessionValueV9<number> {
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
  refresh(): SessionControlResultV9 {
    return this.#exclusive(() => {
      if (this.#holds.storageBusy) return failure('SESSION_HELD');
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      this.#publish(); return this.#runtimeFailure ? runtimeFailure(this.#runtimeFailure, this.#stopped) : success(true);
    });
  }
  #prepareReplacement(world: unknown): SessionValueV9<PreparedReplacementV9> {
    if (this.#holds.storageBusy && this.#replacement) return failure('SESSION_HELD');
    if (!this.#headroom(true)) return failure('COUNTER_EXHAUSTED');
    this.#discardPrepared();
    let prepared: Prepared | null = null;
    try {
      prepared = prepare(world, true, !this.#foreground.visible || !this.#foreground.focused);
      const holds: SessionHoldsV9 = { storageBusy: this.#holds.storageBusy, storage: this.#holds.storage,
        overlay: this.#holds.overlay, review: false, player: prepared.ephemeralPlayer, hidden: prepared.ephemeralHidden };
      // Every fallible/allocation-bearing replacement component precedes swap.
      const epoch = this.#epoch + 1; const revision = this.#revision + 1; const worldRevision = this.#worldRevision + 1;
      const proposals = new WeakSet<object>(); const accumulator = createFrameAccumulator(); const liveHolds = { ...holds };
      const snapshot = freeze({ ...prepared.views, revision, worldRevision, sessionEpoch: epoch, stamp: prepared.stamp,
        selection: prepared.selection, lastCommand: null, stopped: null, runtimeFailure: null, holds,
        paused: prepared.views.frame.clock.pauseReasons.length > 0 || Object.values(holds).some(Boolean), closed: false });
      const token = Object.freeze({ kind: 'v9-prepared-replacement' as const, sessionEpoch: this.#epoch, revision: this.#revision });
      const result = success(true); const answer = Object.freeze({ ok: true as const, value: token });
      const replacement: Replacement = { token, prepared, snapshot, holds: liveHolds, proposals, accumulator, result };
      this.#replacement = replacement; prepared = null;
      return answer;
    } catch (error) {
      if (prepared) closeQuietly(prepared.owner);
      return error instanceof SessionPreparationErrorV9 ? error.failure : runtimeFailure('internal-failure');
    }
  }
  /** A single private candidate. Acquire storageBusy before preparing; commit
   * while it remains held, then release it. Any intervening publication stales
   * the token and closes its owner. Starting another preparation closes the
   * previous candidate. Failed preparation changes no live Session state. */
  prepareReplacement(world: unknown): SessionValueV9<PreparedReplacementV9> {
    return this.#exclusive(() => this.#prepareReplacement(world));
  }
  #commitReplacement(token: PreparedReplacementV9): SessionControlResultV9 {
    const candidate = this.#replacement;
    // Compare identity before reading caller-controlled token properties.
    if (!candidate || candidate.token !== token) return failure('REPLACEMENT_STALE');
    if (candidate.token.sessionEpoch !== this.#epoch || candidate.token.revision !== this.#revision) {
      this.#replacement = null; closeQuietly(candidate.prepared.owner); return failure('REPLACEMENT_STALE');
    }
    const { prepared, snapshot } = candidate; const previous = this.#owner;
    this.#owner = prepared.owner; this.#views = prepared.views; this.#selection = prepared.selection; this.#stamp = prepared.stamp;
    this.#sequence = prepared.sequence; this.#epoch = snapshot.sessionEpoch; this.#revision = snapshot.revision; this.#worldRevision = snapshot.worldRevision;
    this.#holds = candidate.holds; this.#lastCommand = null; this.#stopped = null; this.#runtimeFailure = null;
    this.#proposals = candidate.proposals; this.#accumulator = candidate.accumulator; this.#baseline = null; this.#snapshot = snapshot;
    this.#replacement = null; closeQuietly(previous); this.#notify(); return candidate.result;
  }
  commitReplacement(token: PreparedReplacementV9): SessionControlResultV9 {
    return this.#exclusive(() => this.#commitReplacement(token));
  }
  discardReplacement(token: PreparedReplacementV9): SessionControlResultV9 {
    return this.#exclusive(() => {
      if (!this.#replacement || this.#replacement.token !== token) return failure('REPLACEMENT_STALE');
      const discarded = this.#replacement; this.#replacement = null; closeQuietly(discarded.prepared.owner); return success(true);
    });
  }
  replaceWorld(world: unknown): SessionControlResultV9 {
    return this.#exclusive(() => {
      const prepared = this.#prepareReplacement(world); return prepared.ok ? this.#commitReplacement(prepared.value) : prepared;
    });
  }
  close(): SessionControlResultV9 {
    return this.#exclusive(() => {
      if (!this.#headroom()) return failure('COUNTER_EXHAUSTED');
      this.#closed = true; this.#baseline = null; this.#proposals = new WeakSet<object>();
      if (this.#replacement) { closeQuietly(this.#replacement.prepared.owner); this.#replacement = null; }
      closeQuietly(this.#owner); this.#publish(false); this.#listeners.clear(); return success(true);
    });
  }
}
