import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ApplicationSession } from '../application/session';
import type { SaveController, SaveStatus } from '../application/save-controller';
import type { CampaignSlotId } from '../platform/persistence';
import { translate, type Locale, type TextKey, type TranslationParams } from '../i18n';
import './campaign-entry.css';

/** A player-editable default, never derived from a wall clock or ambient randomness. */
export const DEFAULT_CAMPAIGN_SEED = 'shanmen-001';
export function campaignSeed(value: string): string | null {
  const seed = value.trim();
  return seed.length >= 1 && seed.length <= 256 ? seed : null;
}
export type EntryLoadOutcome = 'unchanged' | 'review' | 'ready';
/** A resolved load Promise is not proof that a world was loaded successfully. */
export function entryLoadOutcome(beforeEpoch: number, afterEpoch: number, status: Pick<SaveStatus, 'busy' | 'readOnly' | 'notice' | 'mode'>): EntryLoadOutcome {
  if (beforeEpoch === afterEpoch) return 'unchanged';
  if (!status.busy && status.mode !== 'opening' && !status.readOnly && (status.notice === 'save.loadedPaused' || status.notice === 'save.migratedPaused')) return 'ready';
  return 'review';
}
export type CampaignIntent = { kind: 'new'; seed: string; epoch: number } | { kind: 'load'; slotId: CampaignSlotId; epoch: number };
export function entryIntentCurrent(intent: CampaignIntent, epoch: number, status: Pick<SaveStatus, 'busy' | 'mode'>): boolean {
  return intent.epoch === epoch && !status.busy && status.mode !== 'opening' && (intent.kind !== 'new' || campaignSeed(intent.seed) === intent.seed);
}
export function entryCancelAction(busy: boolean, confirming: boolean, hasCampaign: boolean): 'blocked' | 'confirmation' | 'campaign' | 'stay' {
  return busy ? 'blocked' : confirming ? 'confirmation' : hasCampaign ? 'campaign' : 'stay';
}

export interface CampaignEntryProps {
  controller: SaveController;
  session: ApplicationSession;
  locale: Locale;
  hasCampaign: boolean;
  previewNotice?: ReactNode;
  onEnter: () => void;
  onCampaignAvailable: () => void;
  onManageSaves: () => void;
  onLocaleChange: (locale: string) => void;
}
const dateLabel = (value: string, locale: Locale): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const helpKeys: readonly TextKey[] = ['entry.help.production', 'entry.help.cultivation', 'entry.help.expedition', 'entry.help.builds'];

/** One modal surface: confirmations replace its body rather than stacking dialogs. */
export function CampaignEntry({ controller, session, locale, hasCampaign, previewNotice, onEnter, onCampaignAvailable, onManageSaves, onLocaleChange }: CampaignEntryProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmationCancel = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const running = useRef(false);
  const [seed, setSeed] = useState(DEFAULT_CAMPAIGN_SEED);
  const [confirmation, setConfirmation] = useState<CampaignIntent | null>(null);
  const [pending, setPending] = useState(false);
  const [localNotice, setLocalNotice] = useState<TextKey | null>(null);
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const world = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const busy = status.busy || pending;
  const blocked = busy || status.mode === 'opening';
  const validSeed = campaignSeed(seed);
  const occupiedSlots = status.slots.filter((entry) => entry.slot !== null);
  const t = (key: TextKey, parameters?: TranslationParams) => translate(locale, key, parameters);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    heading.current?.focus();
    void controller.refresh();
    return () => { element?.close(); };
  }, [controller]);
  useLayoutEffect(() => {
    if (confirmation) confirmationCancel.current?.focus();
    else if (returnFocus.current?.isConnected) { returnFocus.current.focus(); returnFocus.current = null; }
  }, [confirmation]);
  useLayoutEffect(() => {
    if (confirmation && confirmation.epoch !== world.sessionEpoch && !running.current) {
      setConfirmation(null);
      setLocalNotice('entry.failed');
    }
  }, [world.sessionEpoch, confirmation]);

  async function execute(intent: CampaignIntent): Promise<void> {
    if (running.current || !entryIntentCurrent(intent, session.getSnapshot().sessionEpoch, controller.getSnapshot())) return;
    running.current = true;
    setPending(true);
    setLocalNotice(null);
    let enter = false;
    try {
      if (intent.kind === 'new') {
        const success = await controller.beginNewCampaign(intent.seed);
        enter = success && session.getSnapshot().sessionEpoch !== intent.epoch && !controller.getSnapshot().busy;
        if (!enter) setLocalNotice('entry.failed');
      } else {
        await controller.load(intent.slotId);
        const outcome = entryLoadOutcome(intent.epoch, session.getSnapshot().sessionEpoch, controller.getSnapshot());
        enter = outcome === 'ready';
        if (outcome === 'unchanged') setLocalNotice('entry.failed');
      }
    } catch {
      // Controller errors are normally status values; an unexpected rejection must still leave this menu usable.
      setLocalNotice('entry.failed');
    } finally {
      if (session.getSnapshot().sessionEpoch !== intent.epoch) onCampaignAvailable();
      running.current = false;
      setPending(false);
      setConfirmation(null);
    }
    if (enter) onEnter();
  }
  function request(intent: CampaignIntent, trigger: HTMLElement): void {
    if (running.current || !entryIntentCurrent(intent, session.getSnapshot().sessionEpoch, controller.getSnapshot())) return;
    setLocalNotice(null);
    if (hasCampaign) { returnFocus.current = trigger; setConfirmation(intent); }
    else void execute(intent);
  }
  function cancel(): void {
    switch (entryCancelAction(busy || running.current, confirmation !== null, hasCampaign)) {
      case 'confirmation': setConfirmation(null); break;
      case 'campaign': onEnter(); break;
    }
  }

  return <dialog ref={dialog} className="campaign-entry" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} aria-modal="true" onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); cancel(); }}>
    {previewNotice}
    <div className="entry-heading"><div><span className="section-eyebrow">{t('app.title')}</span><h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{t('entry.title')}</h2></div><label className="language-control"><span className="sr-only">{t('settings.language.label')}</span><select value={locale} disabled={busy || confirmation !== null} onChange={(event) => onLocaleChange(event.target.value)} aria-label={t('settings.language.switch')}><option value="zh-CN">{t('settings.language.zh-CN')}</option><option value="en">{t('settings.language.en')}</option></select></label></div>
    <p id={`${id}-intro`} className="entry-intro">{t('entry.subtitle')}</p>
    <p className={status.mode === 'memory' ? 'entry-storage notice' : 'entry-storage muted'}>{t(status.mode === 'opening' ? 'save.opening' : status.mode === 'browser' ? 'save.browser' : 'save.memory')}</p>
    {status.readOnly && <p className="entry-readonly notice">{t('entry.readOnlyHint')}</p>}
    <div hidden={confirmation !== null} className="entry-choices">
      {hasCampaign && <button className="entry-resume" disabled={blocked} onClick={() => { if (!running.current && !controller.getSnapshot().busy) onEnter(); }}>{t(status.readOnly ? 'entry.viewReadOnly' : 'entry.resume')}</button>}
      <div className="entry-campaigns">
        <section className="entry-continue" aria-labelledby={`${id}-continue`}><h3 id={`${id}-continue`}>{t('entry.continue.title')}</h3>
          {occupiedSlots.length === 0 ? <p className="entry-empty muted">{t('entry.continue.empty')}</p> : <ul className="entry-slot-list">{status.slots.map(({ slotId, slot }, index) => slot ? <li key={slotId}><div><h4>{t('save.slot', { number: index + 1 })}{status.boundSlot === slotId && <span className="current-badge">{t('save.current')}</span>}</h4><p>{t('save.revision', { revision: slot.revision, date: dateLabel(slot.savedAt, locale) })}</p></div><button className="secondary" disabled={blocked} onClick={(event) => request({ kind: 'load', slotId, epoch: world.sessionEpoch }, event.currentTarget)} aria-label={`${t('entry.continue.action')} · ${t('save.slot', { number: index + 1 })}`}>{t('entry.continue.action')}</button></li> : null)}</ul>}
        </section>
        <section className="entry-new" aria-labelledby={`${id}-new`}><h3 id={`${id}-new`}>{t('entry.new.title')}</h3><label htmlFor={`${id}-seed`}>{t('entry.seed.label')}</label><input id={`${id}-seed`} className="entry-seed" type="text" value={seed} maxLength={256} autoComplete="off" spellCheck={false} disabled={blocked} aria-describedby={`${id}-seed-hint${validSeed === null ? ` ${id}-seed-error` : ''}`} aria-invalid={validSeed === null} onChange={(event) => setSeed(event.target.value)} /><p id={`${id}-seed-hint`} className="footnote">{t('entry.seed.hint')}</p>{validSeed === null && <p id={`${id}-seed-error`} className="notice">{t('save.error.seed')}</p>}<button disabled={blocked || validSeed === null} onClick={(event) => { if (validSeed !== null) request({ kind: 'new', seed: validSeed, epoch: world.sessionEpoch }, event.currentTarget); }}>{t('entry.new.action')}</button><p className="footnote">{t('entry.new.unsaved')}</p></section>
      </div>
      <details className="entry-help"><summary>{t('entry.help.title')}</summary><ol>{helpKeys.map((key) => <li key={key}>{t(key)}</li>)}</ol><p className="notice">{t('entry.help.risk')}</p><p>{t('entry.help.saving')}</p><p className="footnote">{t('entry.help.scope')}</p></details>
      <div className="entry-footer"><button className="secondary" disabled={blocked} onClick={() => { if (!running.current && !controller.getSnapshot().busy) onManageSaves(); }}>{t('entry.manageSaves')}</button><button className="text-button" disabled={blocked || status.mode !== 'browser'} onClick={() => { setLocalNotice(null); void controller.refresh(); }}>{t('save.refresh')}</button></div>
    </div>
    {confirmation && <section className="entry-confirmation" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-confirm-title`} aria-describedby={`${id}-confirm-warning`}><h3 id={`${id}-confirm-title`}>{t('entry.replace.title')}</h3><p id={`${id}-confirm-warning`}>{t('entry.replace.warning')}</p><p className="entry-intent">{confirmation.kind === 'new' ? `${t('entry.new.title')} · ${confirmation.seed}` : `${t('entry.continue.action')} · ${t('save.slot', { number: Number(confirmation.slotId.slice(-1)) })}`}</p><div className="dialog-actions"><button className="secondary" ref={confirmationCancel} disabled={busy} onClick={() => setConfirmation(null)}>{t('entry.replace.cancel')}</button><button disabled={blocked || !entryIntentCurrent(confirmation, world.sessionEpoch, status)} onClick={() => { void execute(confirmation); }}>{t('entry.replace.confirm')}</button></div></section>}
    <div className="entry-feedback" role="status" aria-live="polite">{busy ? <p>{t('entry.working')}</p> : <>{localNotice && <p>{t(localNotice)}</p>}{status.notice && <p>{t(status.notice)}</p>}</>}</div>
  </dialog>;
}
