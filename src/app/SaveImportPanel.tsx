import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { SaveController } from '../application/save-controller';
import type { CampaignSlotId } from '../platform/persistence';
import { translate, type Locale, type TextKey, type TranslationParams } from '../i18n';
import './save-import.css';

/** File access begins only after the player explicitly chooses a local file. */
export function SaveImportPanel({ controller, locale }: { controller: SaveController; locale: Locale }) {
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const preview = status.import;
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const inputId = useId();
  const t = (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);
  useEffect(() => { setOverwriteConfirmed(false); }, [preview.selectionId, preview.target?.slotId, preview.target?.revision]);
  useEffect(() => () => { controller.cancelImport(); }, [controller]);
  const date = preview.savedAt ? new Date(preview.savedAt) : null;
  const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : preview.savedAt ?? '';
  const ready = preview.phase === 'ready';
  const target = preview.target;
  const commitDisabled = status.busy || status.mode !== 'browser' || !ready || !target || (target.occupied && !overwriteConfirmed);

  return <section className="save-import-panel" aria-labelledby={`${inputId}-title`}>
    <h3 id={`${inputId}-title`}>{t('save.import.title')}</h3>
    <p className="footnote" id={`${inputId}-hint`}>{t('save.import.hint')}</p>
    <label className="save-import-file" htmlFor={inputId}>
      <span>{t('save.import.choose')}</span>
      <input id={inputId} type="file" accept=".json,application/json" aria-describedby={`${inputId}-hint`} disabled={status.busy || status.mode === 'opening'} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        // Reset even a repeated selection of the same filename; the controller uses a fresh token.
        event.currentTarget.value = '';
        setOverwriteConfirmed(false);
        if (file) void controller.selectImportFile(file);
      }} />
    </label>
    {preview.phase === 'reading' && <p className="save-import-notice" role="status">{t('save.import.reading')}</p>}
    {preview.phase === 'committing' && <p className="save-import-notice" role="status">{t('save.import.committing')}</p>}
    {preview.seed !== null && <div className="save-import-preview">
      <p>{t('save.import.preview', { filename: preview.filename ?? '', seed: preview.seed, date: dateText })}</p>
      {preview.migrated && <p className="footnote">{t('save.import.migrated')}</p>}
      {target && <p className="footnote">{t('save.import.selectedTarget', { number: Number(target.slotId.slice(-1)) })}</p>}
    </div>}
    {ready && <>
      <label className="save-import-target">{t('save.import.target')}
        <select value={target?.slotId ?? ''} disabled={status.busy || status.mode !== 'browser'} onChange={(event) => { setOverwriteConfirmed(false); controller.selectImportTarget(event.target.value as CampaignSlotId); }}>
          <option value="" disabled>{t('save.import.target')}</option>
          {status.slots.map(({ slotId, slot }, index) => <option key={slotId} value={slotId}>
            {t('save.slot', { number: index + 1 })} · {slot ? t('save.import.occupiedTarget', { revision: slot.revision }) : t('save.import.emptyTarget')}
          </option>)}
        </select>
      </label>
      {target?.occupied && <div className="save-import-overwrite">
        <p>{t('save.import.overwriteWarning', { number: Number(target.slotId.slice(-1)), revision: target.revision })}</p>
        <label><input type="checkbox" checked={overwriteConfirmed} disabled={status.busy} onChange={(event) => setOverwriteConfirmed(event.target.checked)} />{t('save.import.confirmOverwrite')}</label>
      </div>}
      <div className="dialog-actions">
        <button type="button" disabled={commitDisabled} onClick={() => {
          if (target) void controller.commitImport({ selectionId: preview.selectionId, slotId: target.slotId, expectedRevision: target.revision, overwriteConfirmed });
        }}>{t('save.import.commit')}</button>
        <button type="button" className="secondary" disabled={status.busy} onClick={() => { setOverwriteConfirmed(false); controller.cancelImport(); }}>{t('save.import.cancel')}</button>
      </div>
    </>}
    {(preview.phase === 'reading' || preview.phase === 'error') && <button type="button" className="secondary" disabled={status.busy} onClick={() => controller.cancelImport()}>{t('save.import.cancel')}</button>}
    {status.mode === 'memory' && <p className="save-import-notice">{t('save.import.memoryOnly')}</p>}
    {preview.notice && !(status.mode === 'memory' && preview.notice === 'save.import.memoryOnly') && <p className="save-import-notice" role="status">{t(preview.notice)}</p>}
  </section>;
}
