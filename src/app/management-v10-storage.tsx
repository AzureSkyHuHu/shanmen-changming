import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { ManagementSaveControllerV10, ManagementSaveStatusV10, LoadReviewV10 } from '../application/management-v10-save-controller';
import type { ImportFileSource } from '../application/save-controller';
import type { RuntimeReadonlyV10 } from '../core/world/runtime-view-types-v10';
import { createTranslator, translate, type Locale, type TextKey, type TranslationParams } from '../i18n';
import type { MessageSpecifications } from '../i18n/types';
import type { SaveFile } from '../platform/files/save-files';
import { ManagementV10PersistenceError, managementV10PersistenceErrorCode, type CampaignSlotId, type ManagementV10PersistenceErrorCode } from '../platform/persistence/management-v10-types';
import { formatManagementSaveDateV9 } from './ManagementSavePanelV9';
import { focusManagementReviewV10, restoreManagementDraftFocusV10, managementBoundaryV10, type ManagementSessionV10, type ManagementSnapshotV10,
  type ManagementStorageSlotV10, type ManagementStorageStatusV10 } from './ManagementAppV10';

export type ManagementStorageControllerV10 = Pick<ManagementSaveControllerV10, 'getSnapshot' | 'subscribe' | 'canSave' | 'save' | 'reviewLoad' | 'cancelLoad' | 'load' | 'refresh'
  | 'selectImportFile' | 'selectImportTarget' | 'cancelImport' | 'commitImport' | 'exportCurrent' | 'exportRawSnapshot' | 'exportMigrationSource'>;
type Status = RuntimeReadonlyV10<ManagementSaveStatusV10>;
type Session = Pick<ManagementSessionV10, 'getSnapshot' | 'subscribe'>;
type Feedback = (key: TextKey | null, importAction?: boolean) => void;

/** Private catalog: stable keys, the same parameter validator and per-key Chinese
 * fallback as the registered UI. No persistence identities are translated. */
export const managementStorageMessagesV10 = {
  'storageV10.isolation': ['独立 v10 本地存档。不会读取或改写普通入口、v8 或 v9 的存档数据库。', 'Independent v10 local saves. The normal, v8 and v9 save databases are not read or changed.'],
  'storageV10.stopped': ['存档控制器尚未启动或已停止；当前不会接受新的存档操作。', 'The save controller is not running; new save operations are not accepted.'],
  'storageV10.importHint': ['仅接受通过严格校验的 v10 JSON 文件，最大 4 MiB。导入会写入所选位置并替换当前会话；旧 v9 文件须使用另行提供的复制转换流程。', 'Only strictly validated v10 JSON files up to 4 MiB are accepted. Import writes the chosen slot and replaces this session. Old v9 files require a separate copy-conversion flow.'],
  'storageV10.loaded': ['最近一次成功读取已替换会话，并保留文件中的暂停状态。关闭窗口不会自动解除原有暂停。', 'The last successful load replaced the session with its saved pause state. Closing this window does not clear existing pauses.'],
  'storageV10.imported': ['最近一次成功导入已写入所选位置并替换会话，保留文件中的暂停状态。', 'The last successful import wrote the selected slot and replaced the session with its saved pause state.'],
  'storageV10.unboundCommit': ['已写入存档 {number} 的版本 {revision}；写入完成时尚未绑定到游戏。此记录保留当时的结果，写入并未回滚。', 'Revision {revision} was written to save {number}; it was not bound to the game when the write completed. This record preserves that historical result; the write was not rolled back.'],
  'storageV10.dirtyWarning': ['当前有尚未保存的进度。读取或导入将替换这些进度；可先导出当前会话。', 'This session has unsaved progress. Loading or importing replaces it; you can export this session first.'],
  'storageV10.replaceDirty': ['我确认替换当前尚未保存的进度', 'I confirm replacing the unsaved progress in this session'],
  'storageV10.loadReview': ['读取存档 {number} 的版本 {revision}', 'Load save {number}, revision {revision}'],
  'storageV10.loadWarning': ['确认后将用此位置的已保存进度替换当前会话；不会强行接管其他页面的写入权。', 'Confirmation replaces this session with the saved progress in this slot. It does not force takeover from another page.'],
  'storageV10.overwriteWarning': ['将覆盖存档 {number} 的版本 {revision} 及此位置的恢复快照，然后替换当前会话。已保留的 v9 来源备份仍单独保存。', 'This replaces revision {revision} and recovery snapshots in save {number}, then replaces this session. Any preserved v9 source backup remains separate.'],
  'storageV10.importConfirm': ['确认导入并读取', 'Confirm import and load'],
  'storageV10.reviewTarget': ['重新核对所选位置', 'Review selected slot again'],
  'storageV10.rawTitle': ['原始快照与来源备份', 'Raw snapshots and source backups'],
  'storageV10.rawHint': ['按原文导出，不尝试修复或降级。文件可能损坏或来自未支持的新版本；导出不等于已成功读取。', 'Export exact stored text without repair or downgrade. Files may be damaged or use an unsupported future version. Export does not mean a successful load.'],
  'storageV10.rawSnapshot': ['导出原始快照 {snapshot}', 'Export raw snapshot {snapshot}'],
  'storageV10.sourceBackup': ['导出保留的 v9 来源原文', 'Export preserved v9 source text'],
  'storageV10.sourceHint': ['只有已完成复制转换的位置才可能有来源备份；没有备份时会明确报错。此按钮不会执行迁移。', 'A source backup may exist only for a slot produced by copy conversion. A missing backup is reported as an error. This button does not perform migration.'],
  'storageV10.recovered': ['已从较早快照恢复，只读保护仍生效。当前指针和原始坏档没有被修复或覆盖。', 'An older snapshot was recovered read-only. The current pointer and damaged source were neither repaired nor overwritten.'],
  'storageV10.unreadable': ['所选位置尚未成功读取。可导出原始快照留存，不会把无法读取的文件当成已恢复进度。', 'The selected slot was not loaded successfully. Export raw snapshots for safekeeping; unreadable data is not treated as recovered progress.'],
  'storageV10.unsupported': ['版本不受支持，拒绝读取或导入并保护原始数据；不会自动转换或降级。', 'This version is unsupported. Loading or import was refused and original data is protected; no automatic conversion or downgrade occurs.'],
  'storageV10.leaseBusy': ['写入权仍由其他页面或旧会话持有。可以等待后重新读取，或导出当前进度；此界面不提供强行接管。', 'Another page or prior session still holds the writer lease. Wait and load again, or export this session. Force takeover is not available here.'],
  'storageV10.leaseLost': ['已失去写入权，当前会话受到只读保护。请重新读取或导出当前进度。', 'The writer lease was lost and this session is protected read-only. Load again or export this session.'],
} as const;
type LocalKey = keyof typeof managementStorageMessagesV10;
const string = { type: 'string', format: 'text' } as const;
const integer = { type: 'number', format: 'integer' } as const;
const parameters: MessageSpecifications = {
  'storageV10.unboundCommit': { parameters: { number: integer, revision: integer } },
  'storageV10.loadReview': { parameters: { number: integer, revision: integer } },
  'storageV10.overwriteWarning': { parameters: { number: integer, revision: integer } },
  'storageV10.rawSnapshot': { parameters: { snapshot: string } },
};
export const managementStorageMessageSpecificationsV10: MessageSpecifications = Object.fromEntries(Object.keys(managementStorageMessagesV10).map(key => [key, parameters[key] ?? { parameters: {} }]));
export function createManagementStorageTranslatorV10(locale: Locale, english: Record<string, string> = Object.fromEntries(Object.entries(managementStorageMessagesV10).map(([key, values]) => [key, values[1]]))) {
  const local = createTranslator({ specifications: managementStorageMessageSpecificationsV10,
    baseCatalog: Object.fromEntries(Object.entries(managementStorageMessagesV10).map(([key, values]) => [key, values[0]])), englishCatalog: english });
  return (key: TextKey | LocalKey, params?: TranslationParams): string => Object.hasOwn(managementStorageMessagesV10, key) ? local(locale, key, params) : translate(locale, key as TextKey, params);
}

export function managementStorageErrorV10(error: unknown): TextKey {
  const code = managementV10PersistenceErrorCode(error);
  if (code && error instanceof ManagementV10PersistenceError) {
    if (error.saveErrorCode === 'TOO_LARGE') return 'save.error.tooLarge';
    if (error.saveErrorCode?.startsWith('UNSUPPORTED_')) return 'save.error.version';
  }
  const keys: Partial<Record<ManagementV10PersistenceErrorCode, TextKey>> = {
    STORAGE_UNAVAILABLE: 'save.error.unavailable', STORAGE_BLOCKED: 'save.error.blocked', DATABASE_VERSION_UNSUPPORTED: 'save.error.version',
    STORAGE_SCHEMA_INVALID: 'save.error.invalid', INVALID_ARGUMENT: 'save.error.invalid', INVALID_SAVE: 'save.error.invalid',
    QUOTA_EXCEEDED: 'save.error.quota', SLOT_EMPTY: 'save.error.empty', SLOT_OCCUPIED: 'save.error.slotOccupied', NO_EMPTY_SLOT: 'save.error.full',
    REVISION_CONFLICT: 'save.error.conflict', LEASE_BUSY: 'save.error.leaseBusy', LEASE_LOST: 'save.error.leaseLost', SNAPSHOT_MISSING: 'save.error.missing',
    NO_VALID_SNAPSHOT: 'save.error.invalid', CURRENT_SNAPSHOT_INVALID: 'save.error.protected', NEWER_SAVE_PROTECTED: 'save.error.version',
    MIGRATION_SOURCE_INVALID: 'save.error.invalid', MIGRATION_NOT_READY: 'save.error.invalid', MIGRATION_TARGET_MISMATCH: 'save.error.conflict', SOURCE_BACKUP_CONFLICT: 'save.error.conflict',
  };
  return code ? keys[code] ?? 'save.error.transaction' : 'save.error.transaction';
}
/** The parent translator accepts registered keys only. Do not forward the old
 * import-success sentence (which falsely says the current session is unchanged)
 * or legacy lease sentences which advertise a force-takeover button. */
function footerKey(key: TextKey | null): TextKey | null {
  if (key === 'save.import.success') return 'managementV9.savedBoundary';
  if (key === 'save.error.leaseBusy' || key === 'save.error.leaseLost') return 'save.readOnly';
  return key;
}
export function managementStorageStatusV10(status: Status, feedback: TextKey | null = null, showImportFeedback = true): ManagementStorageStatusV10 {
  const importProblem = status.import.phase === 'error' || status.import.phase === 'ready' ? status.import.notice : null;
  const key = status.import.phase === 'committing' ? 'save.import.committing' : status.busy ? 'managementV9.busy'
    : status.import.phase === 'reading' ? 'save.import.reading' : feedback ?? (showImportFeedback ? importProblem : null) ?? status.notice ?? (showImportFeedback ? status.import.notice : null);
  const notice = key === 'save.import.success' && status.dirty ? 'managementV9.unsaved' : footerKey(key);
  return Object.freeze({ busy: status.busy, readOnly: status.readOnly,
    summary: Object.freeze({ key: status.mode === 'opening' ? 'save.opening' : status.mode === 'unavailable' ? 'save.error.unavailable'
      : status.mode === 'stopped' ? 'managementV10.unsavedSession' : status.dirty ? 'managementV9.unsaved' : 'managementV9.savedBoundary' }),
    notice: notice ? Object.freeze({ key: notice }) : null });
}

/** Reuses the existing SaveFile download descriptor and the established Blob /
 * anchor flow. URL ownership is local to this mounted body, not the Session. */
export function createManagementSaveDownloadV10() {
  let previous: string | null = null;
  const dispose = () => { if (previous !== null) { URL.revokeObjectURL(previous); previous = null; } };
  return {
    download(file: SaveFile) {
      dispose();
      const url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType })); previous = url;
      let anchor: HTMLAnchorElement | null = null;
      try {
        anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename;
        document.body.append(anchor); anchor.click();
      } catch (error) { dispose(); throw error; } finally { anchor?.remove(); }
    }, dispose,
  };
}
export interface StorageLoadIntentV10 { readonly review: LoadReviewV10; readonly basis: ManagementSnapshotV10 }
export interface StorageImportIntentV10 {
  readonly selectionId: number; readonly slotId: CampaignSlotId; readonly revision: number; readonly occupied: boolean;
  readonly dirty: boolean; readonly basis: ManagementSnapshotV10;
}

/** Overlay belongs to the outer storage dialog and must remain held. A newer
 * Session, selection, active transaction or closed body never inherits focus. */
export function managementStorageFocusOwnerV10(owner: Session, latestOwner: Session, basis: ManagementSnapshotV10): boolean {
  if (owner !== latestOwner) return false;
  const current = owner.getSnapshot();
  return !current.closed && !current.holds.storageBusy && current.sessionEpoch === basis.sessionEpoch
    && current.selection?.kind === basis.selection?.kind && current.selection?.id === basis.selection?.id;
}
export function focusManagementStorageReviewV10(options: Parameters<typeof focusManagementReviewV10>[0]): () => void {
  // Native select arrows may publish each intermediate choice. Keep that focus
  // until the user tabs onward; an explicit re-review button may enter the form.
  if (options.focus.opener.matches('select')) return () => restoreManagementDraftFocusV10({
    opener: options.focus.restoreTo ?? options.focus.opener, region: options.region, document: options.document, canRestore: options.canRestore,
  });
  return focusManagementReviewV10(options);
}
function useStorageReviewFocusV10(intent: StorageLoadIntentV10 | StorageImportIntentV10 | null, region: RefObject<HTMLElement | null>,
  opener: RefObject<HTMLElement | null>, session: Session, restoreTo?: RefObject<HTMLElement | null>) {
  const latest = useRef({ intent, session }); latest.current = { intent, session };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const node = region.current; const origin = opener.current;
    if (!intent || !node || !origin) return;
    const owns = () => mounted.current && managementStorageFocusOwnerV10(session, latest.current.session, intent.basis);
    const restore = focusManagementStorageReviewV10({ region: node, focus: { opener: origin, restoreTo: restoreTo?.current ?? origin }, document,
      canEnter: () => latest.current.intent === intent && owns(),
      canRestore: () => latest.current.intent === null && owns() });
    return () => { queueMicrotask(restore); };
  }, [intent, region, opener, restoreTo, session]);
}

/** UI one-shot acknowledgements. The real controller retains storage authority.
 * Full Session revision/selection and exact controller tokens are retained, and
 * every boolean/null result is checked before publishing any success feedback. */
export function createManagementStorageActionsV10(controller: ManagementStorageControllerV10, session: Session, feedback: Feedback,
  download: (file: SaveFile) => void) {
  let active = false; let generation = 0; let inFlight = false;
  let load: StorageLoadIntentV10 | null = null; let imported: StorageImportIntentV10 | null = null;
  const current = (basis?: ManagementSnapshotV10, browser = true) => active && !inFlight && !controller.getSnapshot().busy
    && (!browser || controller.getSnapshot().mode === 'browser') && !session.getSnapshot().closed && !session.getSnapshot().holds.storageBusy
    && (!basis || managementBoundaryV10(basis, session.getSnapshot()));
  const failure = (importAction = false) => {
    const state = controller.getSnapshot();
    const problem = (importAction ? [state.import.notice, state.notice] : [state.notice]).find(key => key?.startsWith('save.error.')
      || key === 'save.import.readError' || key === 'save.import.tooLarge' || key === 'save.import.conflict' || key === 'save.import.leaseBusy' || key === 'save.import.leaseLost');
    feedback(problem ?? 'managementV9.stale'); return false;
  };
  const run = async (basis: ManagementSnapshotV10, work: () => boolean | SaveFile | null | Promise<boolean | SaveFile | null>, success: TextKey | null = null, importAction = false) => {
    const version = generation; inFlight = true; feedback(null, importAction);
    try {
      // Feedback publication may synchronously unmount this body or change the
      // Session. Recheck before handing an action to the authoritative controller.
      if (!active || version !== generation) return false;
      if (!managementBoundaryV10(basis, session.getSnapshot()) || controller.getSnapshot().busy || session.getSnapshot().closed || session.getSnapshot().holds.storageBusy) return failure(importAction);
      const result = await work();
      if (!active || version !== generation) return false;
      if (result === false || result === null) return failure(importAction);
      if (typeof result === 'object') download(result);
      if (success) feedback(success); return true;
    } catch (error) { if (active && version === generation) feedback(managementStorageErrorV10(error)); return false; }
    finally { if (version === generation) inFlight = false; }
  };
  const isLoadCurrent = (intent: StorageLoadIntentV10) => intent === load && current(intent.basis)
    && controller.getSnapshot().load === intent.review && controller.getSnapshot().slots.find(row => row.slotId === intent.review.slotId)?.slot?.revision === intent.review.expectedRevision;
  const isImportCurrent = (intent: StorageImportIntentV10) => {
    const status = controller.getSnapshot(); const target = status.import.target;
    return intent === imported && current(intent.basis) && status.import.phase === 'ready' && status.import.selectionId === intent.selectionId
      && target?.slotId === intent.slotId && target.revision === intent.revision && target.occupied === intent.occupied && status.dirty === intent.dirty;
  };
  return {
    activate() { active = true; generation++; inFlight = false; },
    deactivate() { active = false; generation++; inFlight = false; load = null; imported = null; controller.cancelLoad(); controller.cancelImport(); },
    isLoadCurrent, isImportCurrent,
    beginLoad(basis: ManagementSnapshotV10, slotId: CampaignSlotId): StorageLoadIntentV10 | null {
      if (!current(basis)) { failure(); return null; }
      imported = null; controller.cancelImport(); const review = controller.reviewLoad(slotId);
      if (!review) { failure(); return null; }
      load = Object.freeze({ review, basis: session.getSnapshot() }); feedback(null); return load;
    },
    cancelLoad() { load = null; controller.cancelLoad(); feedback(null); },
    async confirmLoad(intent: StorageLoadIntentV10, replaceDirtyConfirmed: boolean) {
      if (!isLoadCurrent(intent) || intent.review.dirty && !replaceDirtyConfirmed) return failure();
      load = null; return run(intent.basis, () => controller.load(intent.review, replaceDirtyConfirmed));
    },
    async save(basis: ManagementSnapshotV10, slotId: CampaignSlotId) {
      if (!current(basis) || !controller.canSave(slotId)) return failure();
      return run(basis, () => controller.save(slotId));
    },
    async refresh(basis: ManagementSnapshotV10) {
      if (!current(basis)) return failure(); load = null; imported = null; controller.cancelLoad(); controller.cancelImport();
      return run(basis, () => controller.refresh());
    },
    async selectFile(basis: ManagementSnapshotV10, file: ImportFileSource) {
      if (!current(basis)) return failure(true); load = null; imported = null; controller.cancelLoad();
      return run(basis, () => controller.selectImportFile(file), null, true);
    },
    selectTarget(basis: ManagementSnapshotV10, slotId: CampaignSlotId): StorageImportIntentV10 | null {
      if (!current(basis)) { failure(true); return null; }
      imported = null;
      if (!controller.selectImportTarget(slotId)) { failure(true); return null; }
      const state = controller.getSnapshot(); const target = state.import.target;
      if (!target || target.slotId !== slotId || state.import.phase !== 'ready') { failure(true); return null; }
      imported = Object.freeze({ selectionId: state.import.selectionId, slotId, revision: target.revision, occupied: target.occupied,
        dirty: state.dirty, basis: session.getSnapshot() }); feedback(null, true); return imported;
    },
    cancelImport() { imported = null; if (!controller.cancelImport()) return false; generation++; inFlight = false; feedback(null); return true; },
    async confirmImport(intent: StorageImportIntentV10, overwriteConfirmed: boolean, replaceDirtyConfirmed: boolean) {
      if (!isImportCurrent(intent) || intent.occupied && !overwriteConfirmed || intent.dirty && !replaceDirtyConfirmed) return failure(true);
      imported = null;
      return run(intent.basis, () => controller.commitImport({ selectionId: intent.selectionId, slotId: intent.slotId, expectedRevision: intent.revision, overwriteConfirmed, replaceDirtyConfirmed }), null, true);
    },
    async exportCurrent(basis: ManagementSnapshotV10) {
      if (!current(basis, false)) return failure(); return run(basis, () => controller.exportCurrent(), 'save.exported');
    },
    async exportRaw(basis: ManagementSnapshotV10, slotId: CampaignSlotId, snapshotId: string) {
      if (!current(basis)) return failure(); return run(basis, () => controller.exportRawSnapshot(slotId, snapshotId), 'save.exported');
    },
    async exportSource(basis: ManagementSnapshotV10, slotId: CampaignSlotId) {
      if (!current(basis)) return failure(); return run(basis, () => controller.exportMigrationSource(slotId), 'save.exported');
    },
  };
}

/** Pure adapter construction: no DB, subscriptions, controller start/stop, Session
 * holds, default-route registration or migration are performed here. */
export function createManagementStorageSlotV10(controller: ManagementStorageControllerV10): ManagementStorageSlotV10 {
  let previous: Status | null = null; let cached: ManagementStorageStatusV10 | null = null; let feedback: TextKey | null = null;
  let feedbackSource: Status | null = null;
  let showImportFeedback = true;
  const listeners = new Set<() => void>();
  const getSnapshot = () => {
    const status = controller.getSnapshot();
    if (!cached || previous !== status) { previous = status; cached = managementStorageStatusV10(status, feedbackSource === status ? feedback : null, showImportFeedback); }
    return cached;
  };
  const setFeedback: Feedback = (key, importAction) => { feedback = key; if (importAction !== undefined) showImportFeedback = importAction;
    feedbackSource = controller.getSnapshot(); cached = null; for (const listener of [...listeners]) listener(); };
  return {
    getSnapshot,
    subscribe(listener) { listeners.add(listener); const stop = controller.subscribe(listener); return () => { listeners.delete(listener); stop(); }; },
    renderBody({ session, locale }) { return <ManagementStorageBodyV10 controller={controller} session={session} locale={locale} feedback={setFeedback} />; },
  };
}

export function ManagementStorageBodyV10({ controller, session, locale, feedback }: {
  controller: ManagementStorageControllerV10; session: Session; locale: Locale; feedback: Feedback;
}) {
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const basis = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const t = useMemo(() => createManagementStorageTranslatorV10(locale), [locale]); const id = useId();
  const downloads = useMemo(() => createManagementSaveDownloadV10(), []);
  const actions = useMemo(() => createManagementStorageActionsV10(controller, session, feedback, downloads.download), [controller, session, feedback, downloads]);
  const [load, setLoad] = useState<StorageLoadIntentV10 | null>(null);
  const [imported, setImported] = useState<StorageImportIntentV10 | null>(null);
  const [replaceLoad, setReplaceLoad] = useState(false); const [replaceImport, setReplaceImport] = useState(false); const [overwrite, setOverwrite] = useState(false);
  const loadRegion = useRef<HTMLElement>(null); const loadOpener = useRef<HTMLElement>(null);
  const importRegion = useRef<HTMLDivElement>(null); const importOpener = useRef<HTMLElement>(null); const importFile = useRef<HTMLInputElement>(null);
  useStorageReviewFocusV10(load, loadRegion, loadOpener, session);
  useStorageReviewFocusV10(imported, importRegion, importOpener, session, importFile);
  useEffect(() => { actions.activate(); return () => { actions.deactivate(); downloads.dispose(); }; }, [actions, downloads]);
  const busy = status.busy || basis.holds.storageBusy || basis.closed;
  const browser = status.mode === 'browser'; const reading = status.import.phase === 'reading';
  const blocked = busy || reading; const preview = status.import; const target = preview.target;
  const chooseTarget = (slotId: CampaignSlotId, opener: HTMLElement) => { importOpener.current = opener; setOverwrite(false); setReplaceImport(false); setImported(actions.selectTarget(basis, slotId)); };
  const cancelLoad = () => { actions.cancelLoad(); setLoad(null); };
  const cancelImport = () => { if (actions.cancelImport()) setImported(null); };
  const knownNotice = (preview.phase === 'ready' || preview.phase === 'error' ? preview.notice : null) ?? status.notice ?? preview.notice;
  return <>
    <p className="management-v9-help">{t('storageV10.isolation')}</p>
    <div className="management-v9-save-summary">
      <span>{t(status.boundSlot ? 'managementV9.currentSlot' : 'managementV9.firstSave', status.boundSlot ? { number: Number(status.boundSlot.slice(-1)) } : undefined)}</span>
      <span>{t(status.dirty ? 'managementV9.unsaved' : 'managementV9.savedBoundary')}</span><span>{t('managementV9.manualOnly')}</span>
      {status.readOnly && <span>{t('save.readOnly')}</span>}
      {status.lastSavedAt && <span>{t('save.lastSuccess', { date: formatManagementSaveDateV9(status.lastSavedAt, locale) })}</span>}
    </div>
    {status.mode === 'stopped' && <p>{t('storageV10.stopped')}</p>}{status.mode === 'opening' && <p>{t('save.opening')}</p>}
    {status.mode === 'unavailable' && <p>{t('save.error.unavailable')}</p>}
    {status.lastAction === 'loaded' && <p>{t('storageV10.loaded')}</p>}{status.lastAction === 'imported' && <p>{t('storageV10.imported')}</p>}
    {status.committed && !status.committed.bound && <p className="management-v9-help">{t('storageV10.unboundCommit', { number: Number(status.committed.slotId.slice(-1)), revision: status.committed.revision })}</p>}
    {status.rescue && <p className="management-v9-notice">{t(status.rescue.reason === 'recovered' ? 'storageV10.recovered' : 'storageV10.unreadable')}</p>}
    {knownNotice === 'save.error.version' && <p className="management-v9-notice">{t('storageV10.unsupported')}</p>}
    {(knownNotice === 'save.error.leaseBusy' || knownNotice === 'save.error.leaseLost') && <p className="management-v9-notice">{t(knownNotice === 'save.error.leaseBusy' ? 'storageV10.leaseBusy' : 'storageV10.leaseLost')}</p>}
    <div className="management-v9-save-slots">{status.slots.map(({ slotId, slot }) => {
      const needsLoad = browser && !blocked && !status.readOnly && !!slot && slotId !== status.boundSlot && !controller.canSave(slotId);
      const snapshots = slot ? [...new Set([slot.currentSnapshotId, ...slot.autoSnapshotIds, slot.manualSnapshotId, slot.checkpointSnapshotId].filter((value): value is string => value !== null))] : [];
      return <article className="management-v9-card" key={slotId}>
        <h3>{t('managementV9.saveSlot', { number: Number(slotId.slice(-1)) })}{status.boundSlot === slotId ? ` · ${t('managementV9.currentSave')}` : ''}</h3>
        <p>{slot ? t('save.revision', { revision: slot.revision, date: formatManagementSaveDateV9(slot.savedAt, locale) }) : t('save.empty')}</p>
        <div className="management-v9-actions">
          <button type="button" disabled={!browser || blocked || !slot} onClick={event => { loadOpener.current = event.currentTarget; setReplaceLoad(false); setImported(null); setLoad(actions.beginLoad(basis, slotId)); }}>{t('save.load')}</button>
          <button type="button" className="secondary" disabled={blocked || !controller.canSave(slotId)} aria-describedby={needsLoad ? `${id}-${slotId}-load` : undefined} onClick={() => { void actions.save(basis, slotId); }}>{t('save.write')}</button>
        </div>
        {needsLoad && <p id={`${id}-${slotId}-load`} className="management-v9-help">{t('managementV9.saveLoadFirst')}</p>}
        {slot && <details><summary>{t('storageV10.rawTitle')}</summary><p>{t('storageV10.rawHint')}</p>
          <div className="management-v9-actions">{snapshots.map(snapshot => <button type="button" className="secondary" key={snapshot} disabled={!browser || blocked} onClick={() => { void actions.exportRaw(basis, slotId, snapshot); }}>{t('storageV10.rawSnapshot', { snapshot })}</button>)}</div>
          <p>{t('storageV10.sourceHint')}</p><button type="button" className="secondary" disabled={!browser || blocked} onClick={() => { void actions.exportSource(basis, slotId); }}>{t('storageV10.sourceBackup')}</button>
        </details>}
      </article>;
    })}</div>
    {load && <section ref={loadRegion} className="management-v9-review" aria-labelledby={`${id}-load-review`} onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || busy) return;
      event.preventDefault(); event.stopPropagation(); cancelLoad();
    }}>
      <h3 id={`${id}-load-review`}>{t('storageV10.loadReview', { number: Number(load.review.slotId.slice(-1)), revision: load.review.expectedRevision })}</h3>
      <p>{t('storageV10.loadWarning')}</p>
      {load.review.dirty && <><p>{t('storageV10.dirtyWarning')}</p><label className="management-v9-checkbox"><input type="checkbox" disabled={blocked || !actions.isLoadCurrent(load)} checked={replaceLoad} onChange={event => setReplaceLoad(event.currentTarget.checked)} />{t('storageV10.replaceDirty')}</label></>}
      {!actions.isLoadCurrent(load) && <p>{t('managementV9.stale')}</p>}
      <div className="management-v9-actions"><button type="button" disabled={blocked || !actions.isLoadCurrent(load) || load.review.dirty && !replaceLoad} onClick={() => { const chosen = load; setLoad(null); void actions.confirmLoad(chosen, replaceLoad); }}>{t('save.confirmLoad')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={cancelLoad}>{t('save.keepPlaying')}</button></div>
    </section>}
    <div className="management-v9-actions"><button type="button" className="secondary" disabled={!browser || blocked} onClick={() => { setLoad(null); setImported(null); void actions.refresh(basis); }}>{t('save.refresh')}</button>
      <button type="button" className="secondary" disabled={blocked} onClick={() => { void actions.exportCurrent(basis); }}>{t('save.export')}</button></div>
    <section className="management-v9-import" aria-labelledby={`${id}-import`}>
      <h3 id={`${id}-import`}>{t('save.import.title')}</h3><p>{t('storageV10.importHint')}</p>
      <label className="management-v9-field">{t('save.import.choose')}<input ref={importFile} type="file" accept=".json,application/json" disabled={!browser || blocked} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; setLoad(null); setImported(null); setOverwrite(false); setReplaceImport(false);
        if (file) void actions.selectFile(basis, file);
      }} /></label>
      {preview.seed !== null && <p>{t('save.import.preview', { filename: preview.filename ?? '', seed: preview.seed, date: formatManagementSaveDateV9(preview.savedAt, locale) })}</p>}
      {preview.phase === 'ready' && <>
        <label className="management-v9-field">{t('save.import.target')}<select value={target?.slotId ?? ''} disabled={!browser || blocked} onChange={event => {
          const slotId = controller.getSnapshot().slots.find(row => row.slotId === event.currentTarget.value)?.slotId;
          if (slotId) chooseTarget(slotId, event.currentTarget); else { setImported(null); setOverwrite(false); setReplaceImport(false); }
        }}><option value="">{t('save.import.target')}</option>{status.slots.map(({ slotId, slot }) => <option value={slotId} key={slotId}>{t('managementV9.saveSlot', { number: Number(slotId.slice(-1)) })} · {slot ? t('save.import.occupiedTarget', { revision: slot.revision }) : t('managementV9.emptySaveTarget')}</option>)}</select></label>
        <div ref={importRegion} onKeyDown={event => {
          if (event.key !== 'Escape' || event.defaultPrevented || busy) return;
          event.preventDefault(); event.stopPropagation(); cancelImport();
        }}>
        {target?.occupied && <p className="management-v9-notice">{t('storageV10.overwriteWarning', { number: Number(target.slotId.slice(-1)), revision: target.revision })}</p>}
        {status.dirty && target && <p>{t('storageV10.dirtyWarning')}</p>}
        {imported?.occupied && <label className="management-v9-checkbox"><input type="checkbox" checked={overwrite} disabled={blocked || !actions.isImportCurrent(imported)} onChange={event => setOverwrite(event.currentTarget.checked)} />{t('save.import.confirmOverwrite')}</label>}
        {imported?.dirty && <label className="management-v9-checkbox"><input type="checkbox" checked={replaceImport} disabled={blocked || !actions.isImportCurrent(imported)} onChange={event => setReplaceImport(event.currentTarget.checked)} />{t('storageV10.replaceDirty')}</label>}
        {target && (!imported || !actions.isImportCurrent(imported)) && <><p>{t('managementV9.stale')}</p><button type="button" className="secondary" disabled={blocked} onClick={event => chooseTarget(target.slotId, event.currentTarget)}>{t('storageV10.reviewTarget')}</button></>}
        <div className="management-v9-actions"><button type="button" disabled={blocked || !imported || !actions.isImportCurrent(imported) || imported.occupied && !overwrite || imported.dirty && !replaceImport} onClick={() => {
          if (!imported) return; const chosen = imported; setImported(null); void actions.confirmImport(chosen, overwrite, replaceImport);
        }}>{t('storageV10.importConfirm')}</button><button type="button" className="secondary" disabled={busy} onClick={cancelImport}>{t('save.import.cancel')}</button></div>
        </div>
      </>}
      {(reading || preview.phase === 'error') && <button type="button" className="secondary" disabled={busy} onClick={cancelImport}>{t('save.import.cancel')}</button>}
    </section>
  </>;
}
