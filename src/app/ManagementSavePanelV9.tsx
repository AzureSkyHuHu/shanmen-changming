import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ApplicationSessionV9 } from '../application/session-v9';
import type { ManagementSaveControllerV9, ManagementSaveStatusV9 } from '../application/management-v9-save-controller';
import type { ManagementSnapshotV9, ManagementTranslatorV9 } from '../application/management-v9-contract';
import { persistenceMessage } from '../application/status-messages';
import type { RuntimeReadonlyV9 } from '../core/world/runtime-view-types-v9';
import type { CampaignSlotId } from '../platform/persistence';
import { DEFAULT_LOCALE, translate, type Locale, type TextKey, type TranslationParams } from '../i18n';
import './management-v9-save.css';

type Controller = Pick<ManagementSaveControllerV9, 'getSnapshot' | 'subscribe' | 'canSave' | 'save' | 'load' | 'refresh' | 'selectImportFile' | 'selectImportTarget' | 'cancelImport' | 'commitImport' | 'exportCurrent'>;
type Session = Pick<ApplicationSessionV9, 'getSnapshot'>;
/** Presentation only: every save timestamp uses the same local zone and shows its offset. */
export function formatManagementSaveDateV9(savedAt: string | null, locale: Locale = DEFAULT_LOCALE): string {
  const date = savedAt ? new Date(savedAt) : null;
  if (!date || !Number.isFinite(date.getTime())) return translate(locale, 'managementV9.unknownSaveTime');
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, timeZoneName: 'shortOffset' }).format(date);
}
export function ManagementSaveSummaryV9({ status, t, locale = DEFAULT_LOCALE, announce = true }: {
  status: RuntimeReadonlyV9<ManagementSaveStatusV9>; t: ManagementTranslatorV9; locale?: Locale; announce?: boolean;
}) {
  return <div className="management-v9-save-summary" role={announce ? 'status' : undefined}>
    <span>{t(status.readOnly ? 'save.readOnly' : status.boundSlot ? 'managementV9.currentSlot' : 'managementV9.firstSave', status.boundSlot && !status.readOnly ? { number: Number(status.boundSlot.slice(-1)) } : undefined)}</span>
    <span>{t(status.busy ? 'managementV9.busy' : status.dirty ? 'managementV9.unsaved' : 'managementV9.savedBoundary')}</span>
    <span>{t('managementV9.manualOnly')}</span>
    {status.lastSavedAt && <span>{t('save.lastSuccess', { date: formatManagementSaveDateV9(status.lastSavedAt, locale) })}</span>}
    {status.mode === 'memory' && <span>{t('save.memory')}</span>}
  </div>;
}
interface LoadIntent { slotId: CampaignSlotId; slotRevision: number; takeover: boolean; basis: ManagementSnapshotV9 }
interface ImportIntent { selectionId: number; slotId: CampaignSlotId; revision: number; basis: ManagementSnapshotV9; overwrite: boolean }
function sameBoundary(previous: ManagementSnapshotV9, next: ManagementSnapshotV9): boolean {
  return previous.sessionEpoch === next.sessionEpoch && previous.worldRevision === next.worldRevision
    && previous.selection?.kind === next.selection?.kind && previous.selection?.id === next.selection?.id;
}
export function ManagementSavePanelV9({ controller, session, locale, onClose }: { controller: Controller; session: Session; locale: Locale; onClose: () => void }) {
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [intent, setIntent] = useState<LoadIntent | null>(null);
  const [importIntent, setImportIntent] = useState<ImportIntent | null>(null);
  const [notice, setNotice] = useState<TextKey | null>(null);
  const [showImportFeedback, setShowImportFeedback] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null); const confirmationButton = useRef<HTMLButtonElement>(null);
  const downloadUrl = useRef<string | null>(null); const id = useId();
  const t = (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);
  const preview = status.import; const target = preview.target;
  const displayedBoundary = session.getSnapshot();
  const importProblem = showImportFeedback && (preview.phase === 'error' || preview.phase === 'ready') ? preview.notice : null;
  const feedback: TextKey = preview.phase === 'committing' ? 'save.import.committing' : status.busy ? 'managementV9.busy'
    : preview.phase === 'reading' && showImportFeedback ? 'save.import.reading' : notice ?? importProblem ?? status.notice ?? (showImportFeedback ? preview.notice : null)
      ?? (status.dirty ? 'managementV9.unsaved' : 'managementV9.savedBoundary');
  const clearFeedback = (importAction = false) => { setNotice(null); setShowImportFeedback(importAction); };
  useEffect(() => { const opener = document.activeElement; dialog.current?.showModal(); return () => { dialog.current?.close(); if (opener instanceof HTMLElement) opener.focus(); }; }, []);
  useEffect(() => { if (intent) confirmationButton.current?.focus(); }, [intent]);
  useEffect(() => { setImportIntent(null); }, [preview.selectionId, target?.slotId, target?.revision]);
  useEffect(() => () => { controller.cancelImport(); if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); }, [controller]);
  const fresh = () => !controller.getSnapshot().busy && !session.getSnapshot().holds.storageBusy && !session.getSnapshot().closed;
  const close = () => { if (fresh()) { controller.cancelImport(); onClose(); } };
  const beginLoad = (slotId: CampaignSlotId, takeover: boolean) => {
    const latest = controller.getSnapshot(); const slot = latest.slots.find(row => row.slotId === slotId)?.slot;
    if (!fresh() || !slot) { setNotice('managementV9.stale'); return; }
    setIntent({ slotId, slotRevision: slot.revision, takeover, basis: session.getSnapshot() }); clearFeedback();
  };
  const confirmLoad = () => {
    if (!intent) return; const latest = controller.getSnapshot(); const current = session.getSnapshot();
    const slot = latest.slots.find(row => row.slotId === intent.slotId)?.slot;
    if (!fresh() || !sameBoundary(intent.basis, current) || slot?.revision !== intent.slotRevision) { setIntent(null); setNotice('managementV9.stale'); void controller.refresh(); return; }
    const chosen = intent; setIntent(null); clearFeedback(); void controller.load(chosen.slotId, chosen.takeover, chosen.slotRevision);
  };
  const acknowledgeImport = (checked: boolean) => {
    if (!checked) { setImportIntent(null); return; }
    const latest = controller.getSnapshot(); const destination = latest.import.target;
    if (!fresh() || latest.import.phase !== 'ready' || !destination) { setNotice('managementV9.stale'); return; }
    clearFeedback(true);
    setImportIntent({ selectionId: latest.import.selectionId, slotId: destination.slotId, revision: destination.revision, basis: session.getSnapshot(), overwrite: destination.occupied });
  };
  const confirmImport = () => {
    const latest = controller.getSnapshot(); const destination = latest.import.target;
    if (!importIntent || !fresh() || !sameBoundary(importIntent.basis, session.getSnapshot()) || latest.import.phase !== 'ready' || !destination
      || importIntent.selectionId !== latest.import.selectionId || importIntent.slotId !== destination.slotId || importIntent.revision !== destination.revision || importIntent.overwrite !== destination.occupied) {
      setImportIntent(null); setNotice('managementV9.stale'); void controller.refresh(); return;
    }
    const chosen = importIntent; setImportIntent(null); clearFeedback(true);
    void controller.commitImport({ selectionId: chosen.selectionId, slotId: chosen.slotId, expectedRevision: chosen.revision, overwriteConfirmed: chosen.overwrite });
  };
  return <dialog className="management-v9-save-dialog" ref={dialog} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="management-v9-save-heading management-v9-dialog-heading"><h2 id={`${id}-title`}>{t('managementV9.saveTitle')}</h2><button className="secondary" disabled={status.busy} onClick={close}>{t('save.close')}</button></header>
    <div className="management-v9-save-body">
    <p className="management-v9-help">{t('managementV9.saveIsolation')}</p>
    <ManagementSaveSummaryV9 status={status} t={t} locale={locale} announce={false} />
    <p>{t('managementV9.returnHint')}</p>
    <div className="management-v9-save-slots">{status.slots.map(({ slotId, slot }, index) => {
      const needsLoad = !!slot && slotId !== status.boundSlot && !status.busy && !status.readOnly && status.mode !== 'opening'
        && !displayedBoundary.closed && !displayedBoundary.holds.storageBusy && !controller.canSave(slotId);
      return <article className="management-v9-card" key={slotId}>
      <h3>{t('managementV9.saveSlot', { number: index + 1 })}{slotId === status.boundSlot ? ` · ${t('managementV9.currentSave')}` : ''}</h3>
      <p>{slot ? t('save.revision', { revision: slot.revision, date: formatManagementSaveDateV9(slot.savedAt, locale) }) : t('save.empty')}</p>
      <div className="management-v9-actions">
        <button disabled={status.busy || !slot} onClick={() => beginLoad(slotId, false)}>{t('save.load')}</button>
        <button className="secondary" disabled={!controller.canSave(slotId)} aria-describedby={needsLoad ? `${id}-${slotId}-load-hint` : undefined} onClick={() => { if (!fresh() || !sameBoundary(displayedBoundary, session.getSnapshot()) || !controller.canSave(slotId) || session.getSnapshot().stopped) { setNotice('managementV9.stale'); return; } clearFeedback(); void controller.save(slotId); }}>{t('save.write')}</button>
        {status.readOnly && slotId === status.boundSlot && <button className="secondary" disabled={status.busy} onClick={() => beginLoad(slotId, true)}>{t('save.takeover')}</button>}
      </div>
      {needsLoad && <p className="management-v9-help management-v9-save-load-hint" id={`${id}-${slotId}-load-hint`}>{t('managementV9.saveLoadFirst')}</p>}
    </article>; })}</div>
    {intent && <section className="management-v9-review" aria-labelledby={`${id}-confirm`}>
      <h3 id={`${id}-confirm`}>{t('managementV9.saveSlot', { number: Number(intent.slotId.slice(-1)) })}</h3>
      <p>{t(intent.takeover ? 'save.takeoverWarning' : 'save.loadWarning')}</p>
      <div className="management-v9-actions"><button ref={confirmationButton} disabled={status.busy} onClick={confirmLoad}>{t(intent.takeover ? 'save.confirmTakeover' : 'save.confirmLoad')}</button><button className="secondary" disabled={status.busy} onClick={() => setIntent(null)}>{t('save.keepPlaying')}</button></div>
    </section>}
    <div className="management-v9-actions">
      <button className="secondary" disabled={status.busy || status.mode === 'opening'} onClick={() => { if (fresh()) { clearFeedback(); void controller.refresh(); } }}>{t('save.refresh')}</button>
      <button className="secondary" disabled={status.busy || session.getSnapshot().closed} onClick={() => {
        if (!fresh() || !sameBoundary(displayedBoundary, session.getSnapshot())) { setNotice('managementV9.stale'); return; }
        clearFeedback();
        try {
          const file = controller.exportCurrent(); if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
          const url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType })); downloadUrl.current = url;
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; document.body.append(anchor); anchor.click(); anchor.remove(); setNotice('save.exported');
        } catch (error) { setNotice(persistenceMessage(error)); }
      }}>{t('save.export')}</button>
    </div>
    <section className="management-v9-import" aria-labelledby={`${id}-import`}>
      <h3 id={`${id}-import`}>{t('save.import.title')}</h3><p>{t('managementV9.importHint')}</p>
      <label className="management-v9-field">{t('save.import.choose')}<input type="file" accept=".json,application/json" disabled={status.busy || status.mode === 'opening'} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; setImportIntent(null); setIntent(null); clearFeedback(true);
        if (file && fresh()) void controller.selectImportFile(file);
      }} /></label>
      {preview.seed !== null && <p>{t('save.import.preview', { filename: preview.filename ?? '', seed: preview.seed, date: formatManagementSaveDateV9(preview.savedAt, locale) })}</p>}
      {preview.phase === 'ready' && <>
        <label className="management-v9-field">{t('save.import.target')}<select value={target?.slotId ?? ''} disabled={status.busy || status.mode !== 'browser'} onChange={event => {
          const slotId = controller.getSnapshot().slots.find(row => row.slotId === event.currentTarget.value)?.slotId;
          setImportIntent(null); clearFeedback(true); if (slotId && fresh()) controller.selectImportTarget(slotId);
        }}><option value="">{t('save.import.target')}</option>{status.slots.map(({ slotId, slot }, index) => <option key={slotId} value={slotId}>{t('managementV9.saveSlot', { number: index + 1 })} · {slot ? t('save.import.occupiedTarget', { revision: slot.revision }) : t('managementV9.emptySaveTarget')}</option>)}</select></label>
        {target?.occupied && <p className="management-v9-notice">{t('managementV9.importOverwriteWarning', { number: Number(target.slotId.slice(-1)), revision: target.revision })}</p>}
        {target && <label className="management-v9-checkbox"><input type="checkbox" disabled={status.busy} checked={!!importIntent} onChange={event => acknowledgeImport(event.currentTarget.checked)} />{t(target.occupied ? 'managementV9.importOverwriteAcknowledge' : 'managementV9.importAcknowledge')}</label>}
        <div className="management-v9-actions"><button disabled={status.busy || status.mode !== 'browser' || !importIntent} onClick={confirmImport}>{t('managementV9.importAndLoad')}</button><button className="secondary" disabled={status.busy} onClick={() => { setImportIntent(null); controller.cancelImport(); }}>{t('save.import.cancel')}</button></div>
      </>}
      {(preview.phase === 'reading' || preview.phase === 'error') && <button className="secondary" disabled={status.busy} onClick={() => controller.cancelImport()}>{t('save.import.cancel')}</button>}
      {status.mode === 'memory' && <p>{t('save.import.memoryOnly')}</p>}
    </section>
    </div>
    <footer className="management-v9-save-feedback" role="status" aria-live="polite" aria-atomic="true"><p>{t(feedback)}</p></footer>
  </dialog>;
}
