import { SECT_V9_CANDIDATE } from '../content/sect-v9/catalog';
import type { SectResourceLine } from '../content/sect-v9/types';
import type { RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import { messageSpecifications, type TextKey, type TranslationParams } from '../i18n';
import type { ApplicationSessionV9, BreakthroughProposalV9, SessionCommandResultV9, SessionControlResultV9, SessionProjectionV9 } from './session-v9';

/** Presentation-only ports. Neither one can expose or replace a World. */
export type ManagementSessionV9 = Pick<ApplicationSessionV9, 'getSnapshot' | 'subscribe' | 'select' | 'dispatch' | 'dispatchSect'
  | 'preparePlacement' | 'confirmPlacement' | 'isProposalCurrent' | 'prepareBreakthrough' | 'setReviewPaused' | 'refresh'>;
export type ManagementSnapshotV9 = RuntimeReadonlyV9<SessionProjectionV9>;
export type ManagementDomainV9 = keyof SessionProjectionV9['expansion']['revisions'] | 'cultivation';
export type ManagementTextV9 = { key: TextKey; parameters?: TranslationParams };
export type ManagementTranslatorV9 = (key: TextKey, parameters?: TranslationParams) => string;
export const MANAGEMENT_BASE_RECIPES_V9 = Object.freeze(['gather.wood', 'gather.herbs', 'craft.plank', 'gather.grain', 'farm.grain', 'cook.meal']);
export const MANAGEMENT_SECT_RECIPES_V9 = Object.freeze(SECT_V9_CANDIDATE.recipes.filter(recipe => recipe.recipeId !== 'craft.wound-powder-alt.v9'));
export const MANAGEMENT_RESEARCH_V9 = SECT_V9_CANDIDATE.research.find(row => row.id === 'basic-medicine.v9')!;

export function managementContentTextV9(key: string, t: ManagementTranslatorV9): string {
  return Object.hasOwn(messageSpecifications, key) ? t(key as TextKey) : t('managementV9.unknownContent');
}
export function managementBlockedV9(snapshot: ManagementSnapshotV9, readOnly: boolean, allowReview = false): TextKey | null {
  if (snapshot.closed || snapshot.stopped || snapshot.runtimeFailure) return 'managementV9.stopped';
  if (readOnly || snapshot.holds.storage) return 'managementV9.readOnly';
  if (snapshot.holds.storageBusy) return 'managementV9.busy';
  if (snapshot.holds.overlay || (!allowReview && snapshot.holds.review)) return 'managementV9.reviewHeld';
  if (snapshot.holds.player || snapshot.holds.hidden || snapshot.frame.clock.pauseReasons.length) return 'managementV9.pausedHint';
  return null;
}
/** Recheck at each event boundary; a stale render/confirmation never silently becomes a new intent. */
export function managementIntentGuardV9(expected: ManagementSnapshotV9, current: ManagementSnapshotV9,
  readOnly: boolean, domain?: ManagementDomainV9, allowReview = false): TextKey | null {
  const blocked = managementBlockedV9(current, readOnly, allowReview); if (blocked) return blocked;
  if (expected.sessionEpoch !== current.sessionEpoch || expected.selection?.kind !== current.selection?.kind || expected.selection?.id !== current.selection?.id) return 'managementV9.stale';
  const previous = domain === 'cultivation' ? expected.cultivation.revision : domain ? expected.expansion.revisions[domain] : expected.worldRevision;
  const next = domain === 'cultivation' ? current.cultivation.revision : domain ? current.expansion.revisions[domain] : current.worldRevision;
  return previous === next ? null : 'managementV9.stale';
}
export function managementWorkerAvailableV9(snapshot: ManagementSnapshotV9, workerId: string): boolean {
  const actor = snapshot.frame.disciples.find(row => row.id === workerId);
  return !!actor && actor.lifeState === 'alive' && !actor.traveling
    && snapshot.cultivation.summaries.some(row => row.discipleId === workerId && row.workerAvailable);
}
export function managementHasResourcesV9(snapshot: ManagementSnapshotV9, costs: readonly SectResourceLine[]): boolean {
  return costs.every(line => ((line.ledger === 'base' ? snapshot.frame.resources.find(row => row.resourceId === line.resourceId)?.available
    : snapshot.expansion.stock.find(row => row.resourceId === line.resourceId)?.available) ?? 0) >= line.quantity);
}
export function managementResourceTextV9(lines: readonly SectResourceLine[], t: ManagementTranslatorV9): string {
  return lines.length ? lines.map(line => t('production.line', { amount: line.quantity, name: line.ledger === 'base'
    ? t(`resource.${line.resourceId}`) : managementContentTextV9(SECT_V9_CANDIDATE.resources.find(row => row.resourceId === line.resourceId)!.nameKey, t) })).join(' · ') : t('production.noInput');
}
const reasonKeys: Readonly<Record<string, TextKey>> = {
  PREVIEW_STALE: 'managementV9.stale', REPLACEMENT_STALE: 'managementV9.stale', STALE_REVISION: 'managementV9.stale', STALE_CLOCK: 'managementV9.stale',
  WORKER_UNAVAILABLE: 'managementV9.reason.worker', DISCIPLE_UNAVAILABLE: 'managementV9.reason.worker', PATIENT_UNAVAILABLE: 'managementV9.reason.worker',
  INSUFFICIENT_INVENTORY: 'managementV9.reason.resources', INSUFFICIENT_AVAILABLE: 'managementV9.reason.resources',
  RESEARCH_AUTHORITY_REQUIRED: 'managementV9.reason.research', RESEARCH_REQUIRED: 'managementV9.reason.research',
  WORKSTATION_UNAVAILABLE: 'managementV9.reason.station', STORAGE_UNAVAILABLE: 'managementV9.reason.storage',
  PATH_BLOCKED: 'managementV9.reason.path', PATH_BUDGET: 'managementV9.reason.pathBudget',
  ENTRANCE_BUSY: 'managementV9.reason.entrance', CLAIM_CONFLICT: 'managementV9.reason.entrance', WAITING_FOR_STATION: 'managementV9.reason.entrance',
  PLACEMENT_CHANGED: 'managementV9.reason.placement', OUT_OF_BOUNDS: 'managementV9.reason.bounds', INVALID_ANCHOR: 'managementV9.reason.bounds',
  ROAD_OCCUPIED: 'managementV9.reason.road', TERRAIN_BLOCKED: 'managementV9.reason.terrain', PERSON_OCCUPIED: 'managementV9.reason.person',
  FOOTPRINT_OVERLAP: 'managementV9.reason.overlap', ENTRANCE_OVERLAP: 'managementV9.reason.overlap', BLUEPRINT_OVERLAP: 'managementV9.reason.overlap', LEGACY_STATION_OCCUPIED: 'managementV9.reason.overlap',
  CONNECTIVITY_BLOCKED: 'managementV9.reason.connectivity',
  CAPACITY_EXCEEDED: 'managementV9.reason.capacity', SAVE_CAPACITY_EXCEEDED: 'managementV9.reason.capacity', HISTORY_EXHAUSTED: 'managementV9.reason.capacity',
  ID_LIMIT: 'managementV9.reason.capacity', CLOCK_LIMIT: 'managementV9.reason.capacity', VISIT_CAPACITY: 'managementV9.reason.capacity',
  UNSUPPORTED_CONTINUATION: 'managementV9.reason.unsupported', TRANSACTION_FINISHED: 'managementV9.reason.finished',
  MANAGEMENT_REQUIRED: 'managementV9.pausedHint', SESSION_HELD: 'managementV9.reviewHeld', BUSY: 'managementV9.busy', CLOSED: 'managementV9.stopped',
};
export function managementReasonV9(code: string): ManagementTextV9 {
  const key = reasonKeys[code]; return key ? { key } : { key: 'managementV9.reason.unknown', parameters: { code } };
}
export function managementResultV9(result: SessionCommandResultV9 | SessionControlResultV9): ManagementTextV9 {
  if (!result.ok) return result.kind === 'runtime-failure' ? managementReasonV9(result.error) : managementReasonV9(result.code);
  if ('result' in result && result.result.status === 'rejected') {
    const rejection = result.result.rejection;
    return managementReasonV9(rejection && 'detail' in rejection && rejection.detail ? rejection.detail : rejection?.code ?? 'INVALID_REQUEST');
  }
  return { key: 'managementV9.accepted' };
}
export function managementPhaseKeyV9(phase: string): TextKey {
  const keys: Record<string, TextKey> = { 'to-storage': 'managementV9.phase.toStorage', 'to-site': 'managementV9.phase.toSite', working: 'managementV9.phase.working',
    completed: 'managementV9.phase.completed', cancelled: 'managementV9.phase.cancelled', WaitingForStation: 'managementV9.phase.waiting',
    TravellingToWork: 'managementV9.phase.toSite', Working: 'managementV9.phase.working', TravellingToStorage: 'managementV9.phase.delivery',
    AwaitingDelivery: 'managementV9.phase.awaitingDelivery', Done: 'managementV9.phase.completed', Cancelled: 'managementV9.phase.cancelled' };
  return keys[phase] ?? 'managementV9.phase.waiting';
}

/** UI-owned holds are reference-counted per Session, so teardown from an old
 * mount cannot release a newer dialog/review. Only holds acquired here are
 * released here; storage, player, hidden and stopped state are never changed. */
type ManagementHoldPortV9 = Pick<ApplicationSessionV9, 'getSnapshot' | 'subscribe' | 'setOverlayPaused' | 'setReviewPaused'>;
type UiHoldV9 = 'overlay' | 'review';
interface UiHoldCoordinatorV9 {
  claims: Record<UiHoldV9, Set<object>>;
  owned: Record<UiHoldV9, boolean>;
  enqueue(): void;
}
const uiHoldCoordinatorsV9 = new WeakMap<ManagementHoldPortV9, UiHoldCoordinatorV9>();
const uiHoldSuccessV9 = (changed = false): SessionControlResultV9 => ({ ok: true, changed, ephemeral: true });
function uiHoldCoordinatorV9(session: ManagementHoldPortV9): UiHoldCoordinatorV9 {
  const existing = uiHoldCoordinatorsV9.get(session); if (existing) return existing;
  let queued = false; let unsubscribe: (() => void) | null = null;
  const coordinator: UiHoldCoordinatorV9 = {
    claims: { overlay: new Set(), review: new Set() }, owned: { overlay: false, review: false },
    enqueue() {
      if (queued) return; queued = true;
      // Session subscribers run inside its exclusive publication boundary. Never
      // mutate Session from that stack; release after it has exited instead.
      queueMicrotask(() => {
        queued = false;
        const snapshot = session.getSnapshot();
        if (snapshot.closed) {
          coordinator.owned.overlay = false; coordinator.owned.review = false;
          coordinator.claims.overlay.clear(); coordinator.claims.review.clear();
        } else {
          for (const kind of ['overlay', 'review'] as const) {
            if (!coordinator.owned[kind] || coordinator.claims[kind].size) continue;
            const current = session.getSnapshot();
            if (!current.holds[kind]) { coordinator.owned[kind] = false; continue; }
            if (current.holds.storageBusy) continue;
            const result = kind === 'overlay' ? session.setOverlayPaused(false) : session.setReviewPaused(false);
            if (result.ok) coordinator.owned[kind] = false;
            // Any failed guard remains authoritative. Wait for a new publication,
            // rather than spinning microtasks or bypassing a stopped/busy Session.
          }
        }
        const pending = !session.getSnapshot().closed && (['overlay', 'review'] as const).some(kind => coordinator.owned[kind] && !coordinator.claims[kind].size);
        if (pending && !unsubscribe) unsubscribe = session.subscribe(coordinator.enqueue);
        if (!pending && unsubscribe) { const dispose = unsubscribe; unsubscribe = null; dispose(); }
      });
    },
  };
  uiHoldCoordinatorsV9.set(session, coordinator); return coordinator;
}
export interface ManagementUiHoldScopeV9 {
  setOverlayPaused(paused: boolean): SessionControlResultV9;
  setReviewPaused(paused: boolean): SessionControlResultV9;
  dispose(): void;
}
export function createManagementUiHoldScopeV9(session: ManagementHoldPortV9): ManagementUiHoldScopeV9 {
  const coordinator = uiHoldCoordinatorV9(session); const token = {}; let disposed = false;
  const set = (kind: UiHoldV9, held: boolean): SessionControlResultV9 => {
    if (disposed || session.getSnapshot().closed) return { ok: false, kind: 'session-rejection', code: 'CLOSED' };
    if (!held) { const changed = coordinator.claims[kind].delete(token); coordinator.enqueue(); return uiHoldSuccessV9(changed); }
    const before = session.getSnapshot();
    const result = kind === 'overlay' ? session.setOverlayPaused(true) : session.setReviewPaused(true);
    if (result.ok) { coordinator.claims[kind].add(token); if (!before.holds[kind]) coordinator.owned[kind] = true; }
    return result;
  };
  return {
    setOverlayPaused: held => set('overlay', held), setReviewPaused: held => set('review', held),
    dispose() {
      if (disposed) return; disposed = true;
      coordinator.claims.overlay.delete(token); coordinator.claims.review.delete(token); coordinator.enqueue();
    },
  };
}

/** Reject a previous render's risk immediately, before effects can query again. */
export function managementRiskCurrentV9(proposal: RuntimeReadonlyV9<BreakthroughProposalV9> | null, snapshot: ManagementSnapshotV9): boolean {
  return !!proposal && proposal.sessionEpoch === snapshot.sessionEpoch
    && proposal.stamp.generation === snapshot.stamp.generation && proposal.stamp.publication === snapshot.stamp.publication
    && proposal.view.resourceStamp === snapshot.cultivation.resourceStamp
    && proposal.view.preview.discipleId === snapshot.cultivation.selected?.discipleId
    && proposal.view.preview.stateRevision === snapshot.cultivation.revision;
}
/** Attach to the document, not the non-focusable Canvas subtree. */
export function attachManagementReviewEscapeV9(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  blocked: () => boolean, cancel: () => void): () => void {
  const escape = (event: Event) => {
    if (event.defaultPrevented || !('key' in event) || event.key !== 'Escape' || blocked()) return;
    event.preventDefault(); cancel();
  };
  target.addEventListener('keydown', escape);
  return () => target.removeEventListener('keydown', escape);
}
