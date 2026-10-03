import type { SaveMetadata } from '../core/kernel/save';
import type { MigrationBlockV10 } from '../core/sect-expansion/upgrade-types';
import { prepareV9ToV10Migration } from '../core/world/migrate-v9-to-v10';
import type { TextKey } from '../i18n';
import { openManagementV10Repository, type IndexedDbManagementV10Repository } from '../platform/persistence/indexeddb-management-v10-repository';
import { managementV10PersistenceErrorCode, type CampaignSlotId, type ManagementV10RepositoryOptions } from '../platform/persistence/management-v10-types';
import { CAMPAIGN_SLOT_IDS } from '../platform/persistence/types';
import { ManagementSaveControllerV9 } from './management-v9-save-controller';
import type { AdoptedManagementServiceV10, ManagementSaveControllerV10 } from './management-v10-save-controller';
import { ApplicationSessionV9 } from './session-v9';
import type { ApplicationSessionV10, SessionSourceV10 } from './session-v10';
import { V9V10CopyCoordinator, V9V10CopyHost, type V9V10CopyOutcome, type V9V10CopyCleanupIssue } from './v9-v10-copy-coordinator';

export interface CopySlotV10 { readonly slotId: CampaignSlotId; readonly revision: number | null; readonly savedAt: string | null }
export interface CopyReviewV10 {
  readonly source: CopySlotV10; readonly targetSlotId: CampaignSlotId; readonly dirty: boolean;
  readonly blockers: readonly MigrationBlockV10[];
}
export interface CopyReceiptV10 {
  readonly slotId: CampaignSlotId; readonly revision: number;
  /** Durable storage and a mounted game are separate facts. */
  readonly mounted: boolean;
}
export interface ManagementCopyStatusV10 {
  readonly phase: 'idle' | 'selecting' | 'review' | 'completed' | 'disposed'; readonly busy: boolean;
  readonly sources: readonly CopySlotV10[]; readonly targets: readonly CopySlotV10[];
  readonly selectedSource: CampaignSlotId | null; readonly loadedSource: CopySlotV10 | null;
  readonly selectedTarget: CampaignSlotId | null; readonly review: CopyReviewV10 | null;
  readonly notice: 'stale' | 'unavailable' | 'source-unreadable' | 'source-readonly' | 'occupied' | 'failed' | 'cancelled' | 'cleanup' | null;
  readonly sourceNotice: TextKey | null; readonly committed: CopyReceiptV10 | null;
  readonly cleanup: readonly V9V10CopyCleanupIssue[];
}
interface ReviewOwnership {
  readonly review: CopyReviewV10; readonly source: SessionSourceV10; readonly destination: SessionSourceV10; readonly metadata: SaveMetadata;
}
const emptyRows = (): readonly CopySlotV10[] => Object.freeze(CAMPAIGN_SLOT_IDS.map(slotId => Object.freeze({ slotId, revision: null, savedAt: null })));
const boundary = (value: SessionSourceV10): SessionSourceV10 => ({ sessionEpoch: value.sessionEpoch, worldRevision: value.worldRevision, revision: value.revision });
const same = (a: SessionSourceV10, b: SessionSourceV10): boolean => a.sessionEpoch === b.sessionEpoch && a.worldRevision === b.worldRevision && a.revision === b.revision;
const rows = (input: readonly { readonly slotId: CampaignSlotId; readonly slot: { readonly revision: number; readonly savedAt: string } | null }[]): readonly CopySlotV10[] =>
  Object.freeze(input.map(({ slotId, slot }) => Object.freeze({ slotId, revision: slot?.revision ?? null, savedAt: slot?.savedAt ?? null })));

/** Explicit-entry lifetime, outside React effects. Construction/startup do not
 * touch v9 storage. The source Session is never attached to a simulation pump.
 * Existing controllers/coordinator retain all admission and commit authority. */
export class ManagementCopyEntryV10 {
  private status: ManagementCopyStatusV10 = Object.freeze({ phase: 'idle', busy: false, sources: emptyRows(), targets: emptyRows(),
    selectedSource: null, loadedSource: null, selectedTarget: null, review: null, notice: null, sourceNotice: null, committed: null, cleanup: Object.freeze([]) });
  private readonly listeners = new Set<() => void>();
  private sourceSession: ApplicationSessionV9 | null = null;
  private source: ManagementSaveControllerV9 | null = null;
  private stopSourceObservers: (() => void) | null = null;
  private repository: IndexedDbManagementV10Repository | null = null;
  private host: V9V10CopyHost | null = null;
  private adopted: AdoptedManagementServiceV10 | null = null;
  private ownedReview: ReviewOwnership | null = null;
  private generation = 0;
  private pending: Promise<boolean> | null = null;
  private cancelling: Promise<void> | null = null;
  private disposed: Promise<void> | null = null;
  private stopped = false;
  private readonly ownerId = globalThis.crypto?.randomUUID?.() ?? `copy-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  constructor(private readonly destination: ApplicationSessionV10, private readonly saves: ManagementSaveControllerV10,
    /** Synchronous ownership acceptance by the entry; never a validator/binder. */
    private readonly accept: (service: AdoptedManagementServiceV10) => boolean,
    private readonly options: ManagementV10RepositoryOptions = {}) {}
  readonly getSnapshot = (): ManagementCopyStatusV10 => this.status;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ManagementCopyStatusV10>): void {
    const cleanup = patch.cleanup ?? this.status.cleanup;
    // Cleanup uncertainty is cumulative and independent of later workflow
    // feedback. A failed adoption or cancellation cannot erase this warning.
    this.status = Object.freeze({ ...this.status, ...patch, ...(cleanup.length ? { notice: 'cleanup' as const } : {}) });
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* Observers do not own this operation. */ } }
  }
  private detachSourceObservers(): void { this.stopSourceObservers?.(); this.stopSourceObservers = null; }
  private watchSource(source: ManagementSaveControllerV9, session: ApplicationSessionV9): void {
    this.detachSourceObservers();
    const stopController = source.subscribe(() => this.observeSource());
    const stopSession = session.subscribe(() => this.observeSource());
    this.stopSourceObservers = () => { stopController(); stopSession(); };
  }
  private observeSource(): void {
    // Owned read/review/copy holds publish intermediate source states. Inspect
    // only settled boundaries; run() rechecks once it releases its own fence.
    if (this.stopped || this.pending || this.cancelling || this.adopted || !this.stopSourceObservers || !this.status.loadedSource || !this.source || !this.sourceSession) return;
    const state = this.source.getSnapshot(); const snapshot = this.sourceSession.getSnapshot();
    const chosen = this.status.loadedSource;
    let notice: ManagementCopyStatusV10['notice'] = null;
    if (state.readOnly || snapshot.holds.storage) notice = 'source-readonly';
    else if (snapshot.closed || snapshot.runtimeFailure) notice = 'source-unreadable';
    else if (state.boundSlot !== chosen.slotId || state.slots.find(row => row.slotId === chosen.slotId)?.slot?.revision !== chosen.revision
      || this.ownedReview && !same(this.ownedReview.source, snapshot)) notice = 'stale';
    if (!notice) return;
    this.ownedReview = null;
    const existing = this.status.review;
    const review = notice === 'source-readonly' && existing && !existing.blockers.includes('READ_ONLY_SOURCE')
      ? Object.freeze({ ...existing, blockers: Object.freeze([...existing.blockers, 'READ_ONLY_SOURCE' as const]) }) : existing;
    if (this.status.notice === notice && this.status.sourceNotice === state.notice && review === existing) return;
    this.update({ notice, sourceNotice: state.notice, review });
  }
  private available(): boolean {
    const snapshot = this.destination.getSnapshot(); const saves = this.saves.getSnapshot();
    return !this.stopped && !this.pending && !this.cancelling && !this.adopted && !snapshot.closed
      && !snapshot.holds.storageBusy && !saves.busy && saves.mode === 'browser';
  }
  private run(work: (current: () => boolean) => Promise<boolean>): Promise<boolean> {
    if (!this.available()) return Promise.resolve(false);
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation;
    // Publish the in-flight fence before observers or work can re-enter.
    let settle!: (result: boolean) => void;
    const pending = new Promise<boolean>(resolve => { settle = resolve; }); this.pending = pending;
    this.update({ busy: true, notice: null });
    void Promise.resolve().then(async () => {
      if (!current()) return false;
      try { return await work(current); }
      catch (error) {
        if (current()) this.update({ notice: managementV10PersistenceErrorCode(error) === 'SLOT_OCCUPIED' ? 'occupied' : 'failed' });
        return false;
      }
    }).then(result => {
      if (this.pending === pending) this.pending = null;
      if (current()) this.observeSource();
      // Source invalidation publication may synchronously cancel/dispose or
      // start another operation. Its generation and busy state now own the UI.
      if (current() && !this.pending && !this.cancelling) this.update({ busy: false });
      settle(result);
    }, () => { if (this.pending === pending) this.pending = null; if (current() && !this.pending && !this.cancelling) this.update({ busy: false, notice: 'failed' }); settle(false); });
    return pending;
  }
  /** The first intentional action may list manifests; it never reads a slot. */
  open(): Promise<boolean> {
    if (this.status.phase !== 'idle') return Promise.resolve(false);
    return this.run(async current => {
      this.update({ phase: 'selecting', sources: emptyRows(), targets: emptyRows(), selectedSource: null, loadedSource: null,
        selectedTarget: null, review: null, sourceNotice: null });
      if (!current()) return false;
      const session = new ApplicationSessionV9(); this.sourceSession = session;
      const source = new ManagementSaveControllerV9(session, { ...(this.options.indexedDB ? { indexedDB: this.options.indexedDB } : {}), ...(this.options.now ? { now: this.options.now } : {}) }); this.source = source;
      this.watchSource(source, session);
      await source.start(); if (!current()) return false;
      if (source.getSnapshot().mode !== 'browser') { this.update({ notice: 'unavailable', sourceNotice: source.getSnapshot().notice }); return false; }
      const repository = await openManagementV10Repository(this.options);
      if (!current()) { repository.close(); return false; } this.repository = repository;
      const targets = await repository.listSlots(); if (!current()) return false;
      this.update({ sources: rows(source.getSnapshot().slots), targets: rows(targets) }); return true;
    });
  }
  selectSource(slotId: CampaignSlotId | null): boolean {
    if (!this.available() || this.status.phase === 'idle' || !this.repository || slotId !== null && !this.status.sources.some(row => row.slotId === slotId && row.revision !== null)) return false;
    this.ownedReview = null;
    this.update({ selectedSource: slotId, loadedSource: null, selectedTarget: null, review: null, phase: 'selecting', notice: null, sourceNotice: null }); return true;
  }
  /** Explicit revision-fenced read into a separate, non-running v9 Session. */
  readSource(): Promise<boolean> {
    const chosen = this.status.sources.find(row => row.slotId === this.status.selectedSource);
    if (!chosen || chosen.revision === null || !this.source || !this.repository) return Promise.resolve(false);
    // Capture the selected non-empty revision before the async closure. Never
    // replace this fence with a newly refreshed manifest revision.
    const expectedRevision = chosen.revision;
    return this.run(async current => {
      const source = this.source!; const before = this.sourceSession!.getSnapshot().sessionEpoch;
      // A prior bound target may have retired this source. An explicit new read
      // can make it usable again and must restore observation before loading.
      if (!this.stopSourceObservers) this.watchSource(source, this.sourceSession!);
      this.ownedReview = null; this.update({ review: null, loadedSource: null, selectedTarget: null, phase: 'selecting' });
      if (!current()) return false;
      await source.load(chosen.slotId, false, expectedRevision); if (!current()) return false;
      const status = source.getSnapshot();
      if (status.boundSlot !== chosen.slotId || this.sourceSession!.getSnapshot().sessionEpoch === before
        || status.slots.find(row => row.slotId === chosen.slotId)?.slot?.revision !== expectedRevision) {
        this.update({ notice: 'source-unreadable', sourceNotice: status.notice }); return false;
      }
      this.update({ loadedSource: chosen, sourceNotice: status.notice, notice: status.readOnly ? 'source-readonly' : null }); return true;
    });
  }
  selectTarget(slotId: CampaignSlotId | null): boolean {
    if (!this.available() || !this.status.loadedSource || slotId !== null && !this.status.targets.some(row => row.slotId === slotId && row.revision === null)) return false;
    this.ownedReview = null; this.update({ selectedTarget: slotId, review: null, phase: 'selecting', notice: null }); return true;
  }
  review(): Promise<boolean> {
    const chosen = this.status.loadedSource; const targetSlotId = this.status.selectedTarget;
    if (!chosen || !targetSlotId || !this.source || !this.sourceSession || !this.repository) return Promise.resolve(false);
    return this.run(async current => {
      this.ownedReview = null; this.update({ review: null }); if (!current()) return false;
      const source = this.source!; const sourceSession = this.sourceSession!;
      const destination = boundary(this.destination.getSnapshot());
      const targets = await this.repository!.listSlots(); if (!current()) return false;
      this.update({ targets: rows(targets) }); if (!current()) return false;
      if (targets.find(row => row.slotId === targetSlotId)?.slot !== null) { this.update({ notice: 'occupied' }); return false; }
      if (!same(destination, this.destination.getSnapshot())) { this.update({ notice: 'stale' }); return false; }
      const metadata = Object.freeze({ buildId: 'management-copy-0.10.0', savedAt: new Date().toISOString() });
      let blockers: readonly MigrationBlockV10[];
      const token = source.beginV10CopySource(metadata);
      if (!token.ok) {
        if (token.code !== 'READ_ONLY_SOURCE') { this.update({ notice: 'source-unreadable', sourceNotice: source.getSnapshot().notice }); return false; }
        blockers = Object.freeze(['READ_ONLY_SOURCE']);
      } else {
        try {
          const migration = prepareV9ToV10Migration(token.token.sourceText, metadata);
          blockers = Object.freeze(migration.ok ? [] : [...new Set(migration.issues.map(issue => issue.code))]);
        } finally {
          const finished = await source.finishV10CopySource(token.token, 'cancelled');
          if (!finished.ok || !finished.holdReleased || finished.lease === 'release-failed') {
            const issues: V9V10CopyCleanupIssue[] = [];
            if (!finished.ok) issues.push(finished.code === 'SOURCE_PROTECTION_FAILED' ? 'SOURCE_PROTECTION_FAILED' : 'SOURCE_CLEANUP_UNCONFIRMED');
            if ('holdReleased' in finished && !finished.holdReleased) issues.push('SOURCE_HOLD_RELEASE_FAILED');
            if ('lease' in finished && finished.lease === 'release-failed') issues.push('SOURCE_LEASE_RELEASE_FAILED');
            this.update({ notice: 'cleanup', cleanup: Object.freeze([...new Set([...this.status.cleanup, ...issues])]) }); return false;
          }
        }
      }
      if (!current()) return false;
      if (!same(destination, this.destination.getSnapshot())) { this.update({ notice: 'stale' }); return false; }
      const review: CopyReviewV10 = Object.freeze({ source: chosen, targetSlotId, dirty: this.saves.getSnapshot().dirty, blockers });
      this.ownedReview = { review, source: boundary(sourceSession.getSnapshot()), destination, metadata };
      this.update({ phase: 'review', review }); return true;
    });
  }
  isReviewCurrent(review: CopyReviewV10): boolean {
    const owned = this.ownedReview;
    return this.available() && owned?.review === review && this.status.review === review && !!this.sourceSession && !!this.source
      && same(owned.source, this.sourceSession.getSnapshot()) && same(owned.destination, this.destination.getSnapshot())
      && this.saves.getSnapshot().dirty === review.dirty && !this.source.getSnapshot().readOnly;
  }
  confirm(review: CopyReviewV10, replaceDirtyConfirmed: boolean): Promise<boolean> {
    const owned = this.ownedReview;
    if (!owned || !this.isReviewCurrent(review) || review.blockers.length || review.dirty && !replaceDirtyConfirmed) {
      if (!this.stopped && !this.pending && !this.cancelling && !this.adopted) {
        this.observeSource();
        if (!this.source?.getSnapshot().readOnly && !review.blockers.length && (!owned || !this.isReviewCurrent(review))) this.update({ notice: 'stale' });
      }
      return Promise.resolve(false);
    }
    return this.run(async current => {
      // The reviewed destination is held only for this operation; no unrelated
      // hold is released if its Session epoch changes underneath it.
      if (!same(owned.destination, this.destination.getSnapshot()) || !this.destination.setStorageBusy(true).ok) return false;
      const held = boundary(this.destination.getSnapshot());
      let holdOwned = this.destination.getSnapshot().holds.storageBusy;
      const stopWatching = this.destination.subscribe(() => { const snapshot = this.destination.getSnapshot();
        if (snapshot.sessionEpoch !== held.sessionEpoch || !snapshot.holds.storageBusy) holdOwned = false; });
      const host = new V9V10CopyHost(this.source!); this.host = host;
      const stillCurrent = () => current() && holdOwned && same(held, this.destination.getSnapshot()) && this.destination.getSnapshot().holds.storageBusy;
      try {
        if (!stillCurrent()) return false;
        const outcome = await new V9V10CopyCoordinator(host, this.repository!).copy({ targetSlotId: review.targetSlotId, ownerId: this.ownerId, metadata: owned.metadata });
        // A durable-but-unbound attempt can retain a usable source writer.
        // Keep observing it so another reviewed target is safe without reopening.
        if (outcome.kind === 'committed-and-bound') this.detachSourceObservers();
        this.record(outcome); // A receipt survives cancellation and late results.
        if (!stillCurrent() || outcome.kind !== 'committed-and-bound') return false;
        const transfer = await host.transferToController();
        if (!transfer.ok) { this.update({ notice: 'failed' }); return false; }
        if (!stillCurrent()) { await transfer.service.dispose(); return false; }
        this.adopted = transfer.service;
        // Mark before synchronous mount publication so old-panel cleanup cannot
        // cancel or dispose the newly transferred service.
        this.update({ phase: 'completed', review: null });
        let accepted = false;
        try { if (stillCurrent()) accepted = this.accept(transfer.service); } catch { /* Preserve the committed target. */ }
        if (!accepted || !current()) { await transfer.service.dispose(); this.adopted = null; this.update({ notice: 'failed' }); return false; }
        this.update({ committed: Object.freeze({ slotId: outcome.receipt.slot.slotId, revision: outcome.receipt.slot.revision, mounted: true }) });
        this.detachSourceObservers(); this.source?.stop(); this.sourceSession?.close(); this.source = null; this.sourceSession = null;
        return true;
      } finally {
        const cleanup = await host.close();
        if (cleanup.length) this.update({ cleanup: Object.freeze([...new Set([...this.status.cleanup, ...cleanup])]), notice: 'cleanup' });
        if (this.host === host) this.host = null;
        const snapshot = this.destination.getSnapshot(); stopWatching();
        if (holdOwned && !snapshot.closed && snapshot.sessionEpoch === held.sessionEpoch && snapshot.holds.storageBusy) this.destination.setStorageBusy(false);
        this.ownedReview = null;
      }
    });
  }
  private record(outcome: V9V10CopyOutcome): void {
    this.update({ cleanup: Object.freeze([...new Set([...this.status.cleanup, ...outcome.cleanup])]),
      ...(outcome.committed ? { committed: Object.freeze({ slotId: outcome.receipt.slot.slotId, revision: outcome.receipt.slot.revision, mounted: false }) } : {}),
      notice: outcome.cleanup.length ? 'cleanup' : outcome.kind === 'rejected'
        ? outcome.reason.code === 'STORAGE_REJECTED' && outcome.reason.storageCode === 'SLOT_OCCUPIED' ? 'occupied' : 'failed' : null });
  }
  /** Closing a dialog cancels pending work. A durable receipt is never cleared
   * or described as a rollback. Adopted lifetime belongs to entry disposal. */
  cancel(): Promise<void> { return this.adopted ? Promise.resolve() : this.cleanup(false); }
  private cleanup(dispose: boolean): Promise<void> {
    if (this.cancelling) return this.cancelling;
    let settle!: () => void; let reject!: (error: unknown) => void;
    const cancelling = new Promise<void>((resolve, failed) => { settle = resolve; reject = failed; }); this.cancelling = cancelling;
    this.generation++; this.ownedReview = null;
    const pending = this.pending; const host = this.host;
    this.detachSourceObservers();
    const closedHost = host?.close(); this.source?.stop();
    this.update({ busy: true, review: null });
    void (async () => {
      await pending;
      const issues = await closedHost ?? [];
      let failed = false;
      try {
        if (dispose && this.adopted) { const result = await this.adopted.dispose(); failed = !result.storageStopped || !result.sessionClosed; }
      } finally {
        this.detachSourceObservers(); this.source?.stop(); this.sourceSession?.close(); this.source = null; this.sourceSession = null; this.host = null;
        this.repository?.close(); this.repository = null;
      }
      if (failed) throw new Error('Copied service cleanup was incomplete.');
      this.update({ phase: dispose || this.stopped ? 'disposed' : 'idle', busy: false, selectedSource: null, loadedSource: null, selectedTarget: null,
        review: null, notice: issues.length ? 'cleanup' : 'cancelled', cleanup: Object.freeze([...new Set([...this.status.cleanup, ...issues])]) });
    })().then(() => { this.cancelling = null; settle(); }, error => { this.cancelling = null; this.update({ busy: false, notice: 'cleanup' }); reject(error); });
    return cancelling;
  }
  dispose(): Promise<void> {
    if (this.disposed) return this.disposed;
    this.stopped = true; this.disposed = this.cleanup(true); return this.disposed;
  }
}
