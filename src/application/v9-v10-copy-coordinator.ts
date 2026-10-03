import type { SaveMetadata } from '../core/kernel/save';
import { serializeSaveV10 } from '../core/kernel/save-v10';
import type { MigrationIssueV10 } from '../core/sect-expansion/upgrade-types';
import { prepareV9ToV10Migration } from '../core/world/migrate-v9-to-v10';
import { captureSaveDataV10 } from '../core/world/save-admission-v10';
import type { IndexedDbManagementV10Repository } from '../platform/persistence/indexeddb-management-v10-repository';
import { managementV10PersistenceErrorCode, type CampaignSlotId, type ManagementV10PersistenceErrorCode,
  type V9CopyCommitReceipt } from '../platform/persistence/management-v10-types';
import { CAMPAIGN_SLOT_IDS } from '../platform/persistence/types';
import type { BeginV10CopySourceV9, FinishV10CopySourceV9, ManagementSaveControllerV9,
  V10CopySourceOutcomeV9, V10CopySourceV9 } from './management-v9-save-controller';
import { ApplicationSessionV10, type PreparedSessionV10, type SessionFailureV10 } from './session-v10';
import type { SessionSourceV10 } from './session-v10';
import { ManagementSaveControllerV10, type CopyControllerTransferResultV10,
  type PreparedCopyControllerV10 } from './management-v10-save-controller';

export interface V9V10CopyOptions {
  readonly targetSlotId: CampaignSlotId;
  readonly ownerId: string;
  /** Also used for the fresh held v9 export; neither metadata clock advances simulation. */
  readonly metadata: SaveMetadata;
}
export type V9V10CopyFailure =
  | { readonly code: 'INVALID_REQUEST' | 'COPY_BUSY' | 'HOST_CLOSED' | 'HOST_CHANGED' | 'HOST_ALREADY_BOUND' | 'SOURCE_STALE' | 'INTERNAL_FAILURE' }
  | { readonly code: 'SOURCE_REJECTED'; readonly sourceCode: Extract<BeginV10CopySourceV9, { ok: false }>['code'] }
  | { readonly code: 'MIGRATION_REJECTED'; readonly issues: readonly MigrationIssueV10[] }
  | { readonly code: 'PREPARATION_REJECTED' | 'BIND_REJECTED'; readonly failure: SessionFailureV10 }
  | { readonly code: 'STORAGE_REJECTED'; readonly storageCode: ManagementV10PersistenceErrorCode };
export type V9V10CopyCleanupIssue =
  | 'PREPARED_DISCARD_FAILED' | 'SOURCE_CLEANUP_UNCONFIRMED' | 'SOURCE_HOLD_RELEASE_FAILED'
  | 'SOURCE_PROTECTION_FAILED' | 'SOURCE_LEASE_RELEASE_FAILED' | 'TARGET_LEASE_RELEASE_FAILED' | 'TARGET_SESSION_CLOSE_FAILED';
/** Ownership of the live target and its lease transfers together to this host. */
export interface V10CopyTargetBinding {
  readonly session: ApplicationSessionV10;
  readonly repository: IndexedDbManagementV10Repository;
  readonly receipt: V9CopyCommitReceipt;
}
export type V9V10CopyOutcome =
  | { readonly kind: 'rejected'; readonly committed: false; readonly reason: V9V10CopyFailure;
    readonly cleanup: readonly V9V10CopyCleanupIssue[] }
  | { readonly kind: 'committed-not-bound'; readonly committed: true; readonly receipt: V9CopyCommitReceipt;
    readonly bindingState: 'never-bound' | 'closed-after-bind';
    readonly reason: V9V10CopyFailure; readonly cleanup: readonly V9V10CopyCleanupIssue[] }
  | { readonly kind: 'committed-and-bound'; readonly committed: true; readonly binding: V10CopyTargetBinding;
    readonly receipt: V9CopyCommitReceipt; readonly cleanup: readonly V9V10CopyCleanupIssue[] };

interface HostState {
  source: ManagementSaveControllerV9 | null;
  generation: object;
  closed: boolean;
  target: V10CopyTargetBinding | null;
  pending: CopyOperation | null;
  closing: Promise<readonly V9V10CopyCleanupIssue[]> | null;
  readyForTransfer: boolean;
  sourceProtected: boolean;
  savedSource: SessionSourceV10 | null;
  transfer: CopyHostTransferOfferV10 | null;
  transferred: boolean;
}
interface CopyOperation {
  readonly host: HostState;
  readonly generation: object;
  readonly source: ManagementSaveControllerV9;
  readonly token: V10CopySourceV9;
  finishing: Promise<FinishV10CopySourceV9 | null> | null;
}
const hosts = new WeakMap<V9V10CopyHost, HostState>();
export interface CopyHostTransferOfferV10 { readonly kind: 'v10-copy-host-transfer' }
export interface CopyHostTransferSourceV10 {
  readonly binding: V10CopyTargetBinding;
  readonly source: SessionSourceV10;
  readonly savedSource: SessionSourceV10;
}
interface TransferOfferState extends CopyHostTransferSourceV10 {
  readonly view: CopyHostTransferSourceV10;
  readonly host: HostState;
  readonly generation: object;
  committing: PreparedCopyControllerV10 | null;
}
const transferOffers = new WeakMap<object, TransferOfferState>();
const sameSessionSource = (a: SessionSourceV10, b: SessionSourceV10): boolean => a.sessionEpoch === b.sessionEpoch
  && a.worldRevision === b.worldRevision && a.revision === b.revision;
function currentTransfer(offer: CopyHostTransferOfferV10): TransferOfferState | null {
  const state = transferOffers.get(offer);
  if (!state) return null;
  const host = state.host; const snapshot = state.binding.session.getSnapshot();
  return !host.closed && !host.transferred && host.readyForTransfer && host.sourceProtected
    && host.transfer === offer && host.generation === state.generation && host.target === state.binding
    && !snapshot.closed && !snapshot.holds.storageBusy && snapshot.runtimeFailure === null
    && sameSessionSource(snapshot, state.source) ? state : null;
}

function finishSource(operation: CopyOperation, outcome: V10CopySourceOutcomeV9): Promise<FinishV10CopySourceV9 | null> {
  // Host invalidation and the coordinator share one finish; neither consumes a
  // token twice or changes a cancelled finish into a bound finish afterwards.
  if (!operation.finishing) {
    let settle!: (result: FinishV10CopySourceV9 | null) => void;
    operation.finishing = new Promise(resolve => { settle = resolve; });
    // Publish ownership before finish can synchronously notify source listeners.
    try { void operation.source.finishV10CopySource(operation.token, outcome).then(settle, () => settle(null)); }
    catch { settle(null); }
  }
  return operation.finishing;
}
function sourceCleanup(result: FinishV10CopySourceV9 | null, issues: V9V10CopyCleanupIssue[], expectedBound = false): void {
  if (!result) { issues.push('SOURCE_CLEANUP_UNCONFIRMED'); return; }
  if (!result.ok && result.code !== 'SOURCE_PROTECTION_FAILED') { issues.push('SOURCE_CLEANUP_UNCONFIRMED'); return; }
  if (!result.ok) issues.push('SOURCE_PROTECTION_FAILED');
  // A stale bound request can finish successfully as cancellation while keeping
  // its source writer. Successful cleanup is not proof of successful retirement.
  // Keep the durable target receipt, but never authorize automatic adoption.
  else if (expectedBound && (!result.sourceCurrent || result.lease === 'retained')) issues.push('SOURCE_CLEANUP_UNCONFIRMED');
  if (!result.holdReleased) issues.push('SOURCE_HOLD_RELEASE_FAILED');
  if (result.lease === 'release-failed') issues.push('SOURCE_LEASE_RELEASE_FAILED');
}
/** Recheck both fences, including when the host has already become stale. */
function currentFailure(operation: CopyOperation): V9V10CopyFailure | null {
  const sourceCurrent = operation.source.isV10CopySourceCurrent(operation.token);
  const host = operation.host;
  if (host.closed) return { code: 'HOST_CLOSED' };
  if (host.generation !== operation.generation || host.source !== operation.source || host.pending !== operation) return { code: 'HOST_CHANGED' };
  return sourceCurrent ? null : { code: 'SOURCE_STALE' };
}

/** Concrete, deliberately small host contract for this disabled-entry path.
 * It owns one controller identity/generation and then one real prepared Session.
 * There is no injected binder, validator, World callback, route, or observer.
 * Replacing/closing a v9 host cancels only its pending copy, not the old Session.
 * A bound host owns target lease teardown; repositories remain caller-owned.
 */
export class V9V10CopyHost {
  constructor(source: ManagementSaveControllerV9) {
    hosts.set(this, { source, generation: {}, closed: false, target: null, pending: null, closing: null,
      readyForTransfer: false, sourceProtected: false, savedSource: null, transfer: null, transferred: false });
  }
  getBoundTarget(): V10CopyTargetBinding | null { return hosts.get(this)!.target; }
  isClosed(): boolean { return hosts.get(this)!.closed; }
  /** Even replacing with the same controller creates a new host identity fence. */
  replaceSource(source: ManagementSaveControllerV9): boolean {
    const host = hosts.get(this)!;
    if (host.closed || host.target || host.transferred) return false;
    host.generation = {}; host.source = source;
    if (host.pending) void finishSource(host.pending, 'cancelled');
    return true;
  }
  /** Fixed, one-use ownership transfer. No caller-provided Session, receipt,
   * factory, validator, callback or World can activate an adopted controller. */
  async transferToController(): Promise<CopyControllerTransferResultV10> {
    const host = hosts.get(this)!;
    if (host.closed) return { ok: false, code: 'HOST_CLOSED' };
    if (!host.target || !host.savedSource || host.transferred) return { ok: false, code: 'NO_BOUND_TARGET' };
    if (!host.readyForTransfer) return { ok: false, code: 'COPY_PENDING' };
    if (!host.sourceProtected) return { ok: false, code: 'SOURCE_UNPROTECTED' };
    if (host.transfer) return { ok: false, code: 'TRANSFER_BUSY' };
    const snapshot = host.target.session.getSnapshot();
    if (snapshot.closed || snapshot.holds.storageBusy || snapshot.runtimeFailure !== null
      || snapshot.sessionEpoch !== host.savedSource.sessionEpoch) return { ok: false, code: 'SOURCE_CHANGED' };
    const offer: CopyHostTransferOfferV10 = Object.freeze({ kind: 'v10-copy-host-transfer' });
    const source = Object.freeze({ sessionEpoch: snapshot.sessionEpoch, worldRevision: snapshot.worldRevision, revision: snapshot.revision });
    const view = Object.freeze({ binding: host.target, source, savedSource: host.savedSource });
    const state: TransferOfferState = { ...view, view, host, generation: host.generation, committing: null };
    host.transfer = offer; transferOffers.set(offer, state);
    let prepared: PreparedCopyControllerV10 | null = null;
    try {
      const candidate = await ManagementSaveControllerV10.prepareCopyTransfer(offer);
      if (!candidate.ok) return host.closed ? { ok: false, code: 'HOST_CLOSED' } : candidate;
      prepared = candidate.token;
      if (!currentTransfer(offer)) return { ok: false, code: host.closed ? 'HOST_CLOSED' : 'SOURCE_CHANGED' };
      // Only this concrete synchronous host call opens the activation gate.
      // The fixed controller consumes its paired token and performs preallocated
      // assignments only; no notification or await separates the two owners.
      state.committing = prepared;
      const result = ManagementSaveControllerV10.activateCopyTransfer(prepared, offer);
      state.committing = null;
      if (!result.ok) return result;
      prepared = null; host.target = null; host.transferred = true; host.readyForTransfer = false;
      return result;
    } finally {
      state.committing = null;
      if (prepared) ManagementSaveControllerV10.discardCopyTransfer(prepared);
      transferOffers.delete(offer); if (host.transfer === offer) host.transfer = null;
    }
  }
  /** @internal Identity-authenticated read for the fixed controller preparer. */
  static readTransferOffer(offer: CopyHostTransferOfferV10): CopyHostTransferSourceV10 | null {
    return currentTransfer(offer)?.view ?? null;
  }
  /** @internal Cannot be opened by copied tokens or a direct activation call. */
  static isTransferActivationCurrent(offer: CopyHostTransferOfferV10, prepared: PreparedCopyControllerV10): boolean {
    const state = currentTransfer(offer); return state !== null && state.committing === prepared;
  }
  close(): Promise<readonly V9V10CopyCleanupIssue[]> {
    const host = hosts.get(this)!;
    if (host.closing) return host.closing;
    let settle!: (issues: readonly V9V10CopyCleanupIssue[]) => void;
    host.closing = new Promise(resolve => { settle = resolve; });
    // Synchronous invalidation precedes every asynchronous cleanup step.
    host.closed = true; host.generation = {}; host.source = null;
    const pending = host.pending; const target = host.target; host.target = null;
    const sourceFinish = pending ? finishSource(pending, 'cancelled') : null;
    void (async () => {
      const issues: V9V10CopyCleanupIssue[] = [];
      if (sourceFinish && pending) {
        sourceCleanup(await sourceFinish, issues);
        currentFailure(pending); // Expected stale: cleanup never restores authority.
      }
      if (target) {
        try { if (!target.session.close().ok) issues.push('TARGET_SESSION_CLOSE_FAILED'); }
        catch { issues.push('TARGET_SESSION_CLOSE_FAILED'); }
        try { await target.repository.releaseLease(target.receipt.lease); }
        catch { issues.push('TARGET_LEASE_RELEASE_FAILED'); }
      }
      settle(Object.freeze(issues));
    })();
    return host.closing;
  }
}

const copyFailures = new WeakMap<object, V9V10CopyFailure>();
class CopyFailure extends Error {
  constructor(reason: V9V10CopyFailure) { super(reason.code); copyFailures.set(this, reason); }
}
function check(operation: CopyOperation): void {
  const failure = currentFailure(operation); if (failure) throw new CopyFailure(failure);
}
function capturedOptions(input: V9V10CopyOptions): V9V10CopyOptions | null {
  const captured = captureSaveDataV10(input);
  if (!captured.ok || captured.value === null || typeof captured.value !== 'object' || Array.isArray(captured.value)) return null;
  const value = captured.value as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'metadata,ownerId,targetSlotId'
    || !CAMPAIGN_SLOT_IDS.includes(value.targetSlotId as CampaignSlotId)
    || typeof value.ownerId !== 'string' || !value.ownerId.trim() || value.ownerId.length > 128
    || value.metadata === null || typeof value.metadata !== 'object' || Array.isArray(value.metadata)) return null;
  // The fixed source codec and pure migration independently admit metadata.
  return value as unknown as V9V10CopyOptions;
}
function freezeReceipt(receipt: V9CopyCommitReceipt): void {
  Object.freeze(receipt.sourceBackup); Object.freeze(receipt.snapshot); Object.freeze(receipt.lease);
  Object.freeze(receipt.slot.autoSnapshotIds); Object.freeze(receipt.slot); Object.freeze(receipt);
}

/** One copy attempt, with one explicit durable target commit and one bind.
 * The supplied repository is already open and fixed to the isolated v10 DB.
 * No operation in this class opens, overwrites or deletes the old database.
 */
export class V9V10CopyCoordinator {
  #running = false;
  constructor(private readonly host: V9V10CopyHost, private readonly repository: IndexedDbManagementV10Repository) {}

  async copy(input: V9V10CopyOptions): Promise<V9V10CopyOutcome> {
    const rejected = (reason: V9V10CopyFailure): V9V10CopyOutcome => Object.freeze({ kind: 'rejected', committed: false, reason, cleanup: Object.freeze([]) });
    if (this.#running) return rejected({ code: 'COPY_BUSY' });
    // Descriptor capture can invoke Proxy reflection. Guard BEFORE capturing,
    // even if that reflection recursively requests another copy.
    this.#running = true;
    try {
      const options = capturedOptions(input); if (!options) return rejected({ code: 'INVALID_REQUEST' });
      const host = hosts.get(this.host);
      if (!host || host.closed) return rejected({ code: 'HOST_CLOSED' });
      if (host.target) return rejected({ code: 'HOST_ALREADY_BOUND' });
      if (host.pending) return rejected({ code: 'COPY_BUSY' });
      const source = host.source; const generation = host.generation;
      if (!source) return rejected({ code: 'HOST_CHANGED' });
      let operation: CopyOperation | null = null;
      let prepared: PreparedSessionV10 | null = null;
      let receipt: V9CopyCommitReceipt | null = null;
      let binding: V10CopyTargetBinding | null = null;
      let reason: V9V10CopyFailure = { code: 'INTERNAL_FAILURE' };
      const cleanup: V9V10CopyCleanupIssue[] = [];
      try {
        const acquired = source.beginV10CopySource(options.metadata);
        if (!acquired.ok) throw new CopyFailure({ code: 'SOURCE_REJECTED', sourceCode: acquired.code });
        operation = { host, source, generation, token: acquired.token, finishing: null };
        // Do not overwrite a newer operation installed by a reentrant host change.
        if (host.pending === null) host.pending = operation;
        check(operation);
        const migration = prepareV9ToV10Migration(operation.token.sourceText, options.metadata);
        check(operation);
        if (!migration.ok) throw new CopyFailure({ code: 'MIGRATION_REJECTED', issues: migration.issues });
        const candidate = ApplicationSessionV10.prepareSession(migration.world);
        if (!candidate.ok) throw new CopyFailure({ code: 'PREPARATION_REJECTED', failure: candidate });
        prepared = candidate.value;
        const targetText = serializeSaveV10(migration.envelope);
        // All target owner/projections and the final target text exist before the
        // repository can start a durable lease/backup/snapshot/pointer transaction.
        check(operation);
        receipt = await this.repository.commitV9Copy({ sourceText: operation.token.sourceText,
          targetText, targetSlotId: options.targetSlotId, ownerId: options.ownerId, signal: operation.token.signal });
        // Record the durable receipt FIRST. Staleness here is never a rollback.
        freezeReceipt(receipt);
        check(operation);
        const bound = ApplicationSessionV10.bindPreparedSession(prepared);
        if (!bound.ok) throw new CopyFailure({ code: 'BIND_REJECTED', failure: bound });
        prepared = null;
        binding = Object.freeze({ session: bound.value, repository: this.repository, receipt });
        // No callback/await/observer separates consuming the prepared token and
        // publishing this fixed host binding plus ownership of the target lease.
        const boundSource = bound.value.getSnapshot();
        host.savedSource = Object.freeze({ sessionEpoch: boundSource.sessionEpoch, worldRevision: boundSource.worldRevision, revision: boundSource.revision });
        host.target = binding; host.source = null; host.pending = null;
      } catch (error) {
        const ownedFailure = error !== null && (typeof error === 'object' || typeof error === 'function') ? copyFailures.get(error) : undefined;
        const storageCode = managementV10PersistenceErrorCode(error);
        reason = ownedFailure ?? (storageCode ? { code: 'STORAGE_REJECTED', storageCode } : { code: 'INTERNAL_FAILURE' });
        // A rejected commit may have been cancelled by a changed source/host.
        // Prefer that actionable fence reason, but never lose an obtained receipt.
        if (operation) reason = currentFailure(operation) ?? reason;
      } finally {
        if (prepared) {
          try { if (!ApplicationSessionV10.discardPreparedSession(prepared).ok) cleanup.push('PREPARED_DISCARD_FAILED'); }
          catch { cleanup.push('PREPARED_DISCARD_FAILED'); }
        }
        if (operation) {
          // 'bound' follows BOTH a durable receipt and an actual successful bind.
          sourceCleanup(await finishSource(operation, binding ? 'bound' : 'failed'), cleanup, binding !== null);
          currentFailure(operation); // Expected stale after finishing the token.
        }
        if (receipt && !binding) {
          try { await this.repository.releaseLease(receipt.lease); }
          catch { cleanup.push('TARGET_LEASE_RELEASE_FAILED'); }
          if (operation) currentFailure(operation);
        }
        // The host can close while source-lease cleanup is awaited. Binding did
        // happen, but its ownership no longer exists when this result is returned.
        // The host, not this coordinator, now owns target Session/lease teardown.
        if (binding && host.closed && host.closing) {
          cleanup.push(...await host.closing);
          if (operation) currentFailure(operation);
        }
        if (operation && host.pending === operation) host.pending = null;
      }
      const frozenCleanup = Object.freeze(cleanup);
      if (receipt && binding && host.target === binding && !host.closed) {
        host.sourceProtected = !cleanup.includes('SOURCE_PROTECTION_FAILED') && !cleanup.includes('SOURCE_CLEANUP_UNCONFIRMED');
        host.readyForTransfer = true;
        return Object.freeze({ kind: 'committed-and-bound', committed: true, receipt, binding, cleanup: frozenCleanup });
      }
      if (receipt) return Object.freeze({ kind: 'committed-not-bound', committed: true, receipt,
        bindingState: binding ? 'closed-after-bind' : 'never-bound', reason: binding ? { code: 'HOST_CLOSED' as const } : reason, cleanup: frozenCleanup });
      return Object.freeze({ kind: 'rejected', committed: false, reason, cleanup: frozenCleanup });
    } finally { this.#running = false; }
  }
}
