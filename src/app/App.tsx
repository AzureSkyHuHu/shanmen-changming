import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { STARTER_RECIPES, TICKS_PER_SECOND, type ResourceLine } from '../core/kernel';
import { ApplicationSession, type DeepReadonly, type SessionProjection } from '../application/session';
import { attachBrowserRuntime } from '../application/browser-runtime';
import { registerGameStatus, type GameModelContext } from '../application/webmcp';
import { SaveController } from '../application/save-controller';
import { disciplePresentation } from '../application/character-presentation';
import { commandFeedbackKey } from '../application/status-messages';
import { CultivationPanel } from './CultivationPanel';
import { InventoryPanel } from './InventoryPanel';
import { WorkPlansPanel } from './WorkPlansPanel';
import { SaveImportPanel } from './SaveImportPanel';
import { CampaignEntry } from './CampaignEntry';
import { ExpeditionPanel } from './ExpeditionPanel';
import { BuildPanel } from './BuildPanel';
import { attachInput } from '../input/actions';
import { PhaserWorld } from '../phaser/PhaserWorld';
import type { CampaignSlotId } from '../platform/persistence';
import {
  DEFAULT_LOCALE, readLocalePreference, translate, writeLocalePreference,
  type Locale, type TextKey, type TranslationParams,
} from '../i18n';

type Translator = (key: TextKey, parameters?: TranslationParams) => string;
type Projection = DeepReadonly<SessionProjection>;
export interface AppProps { initialLocale?: Locale; session?: ApplicationSession }

function discipleStatus(disciple: Projection['disciples'][number], summaries: Projection['cultivation']['summaries']): TextKey {
  if (disciple.lifeState === 'dead') return 'disciple.dead';
  if (disciple.lifeState === 'pendingDeath') return 'cultivation.ui.pendingDeath';
  const profile = summaries.find((entry) => entry.discipleId === disciple.id);
  if (profile?.away) return 'expedition.ui.memberAway';
  if (profile?.activeAttemptId) return 'cultivation.ui.seclusion';
  if (profile?.teaching) return 'cultivation.ui.teaching';
  if (profile?.learning) return 'cultivation.ui.learning';
  if (profile && profile.trainingMode !== 'duty') return `cultivation.mode.${profile.trainingMode}`;
  if (disciple.traveling) return 'disciple.traveling';
  if (disciple.ageMonths < 16 * 12) return 'disciple.youngShort';
  return disciple.assignmentTransactionId ? 'disciple.working' : 'disciple.idle';
}
function resourceLine(lines: readonly ResourceLine[], t: Translator): string {
  return lines.length ? lines.map((line) => t('production.line', { amount: line.quantity, name: t(`resource.${line.resourceId}`) })).join(' · ') : t('production.noInput');
}
function dateLabel(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Inspector({ session, world, t, readOnly, cultivationReview }: { session: ApplicationSession; world: Projection; t: Translator; readOnly: boolean; cultivationReview: { discipleId: string; request: number } | null }) {
  const [inspectorTab, setInspectorTab] = useState<'production' | 'cultivation' | 'workPlans'>('production');
  const [workerId, setWorkerId] = useState(world.disciples.find((entry) => entry.canWork)?.id ?? '');
  const selection = world.selection;
  const disciple = selection?.kind === 'disciple' ? world.disciples.find((entry) => entry.id === selection.id) : undefined;
  const building = selection?.kind === 'building' ? world.buildings.find((entry) => entry.id === selection.id) : undefined;
  const worker = disciple ?? world.disciples.find((entry) => entry.id === workerId) ?? world.disciples.find((entry) => entry.canWork);
  const automatic = disciple && inspectorTab === 'workPlans' ? session.getAutomaticWorkPreview() : null;
  const transaction = world.transactions.find((entry) => entry.transactionId === worker?.assignmentTransactionId);
  const needsDecision = !!disciple && world.cultivation.decisions.some((entry) => entry.discipleId === disciple.id);
  useEffect(() => { if (needsDecision || (disciple && cultivationReview?.discipleId === disciple.id)) setInspectorTab('cultivation'); }, [disciple?.id, needsDecision, cultivationReview]);
  const workerProfile = world.cultivation.summaries.find((entry) => entry.discipleId === worker?.id);
  const cultivationAllowsWork = !!workerProfile && workerProfile.trainingMode === 'duty' && !workerProfile.activeAttemptId && !workerProfile.teaching && !workerProfile.learning && !workerProfile.away;
  const recipes = Object.values(STARTER_RECIPES).filter((recipe) => !building || recipe.workstation === building.blueprintId);
  const canWork = cultivationAllowsWork && !!worker?.canWork && worker.lifeState === 'alive' && !worker.traveling && !worker.assignmentTransactionId && !readOnly && !world.clock.pauseReasons.includes('error');
  return <aside className="inspector" aria-label={t('live.inspect')}>
    <div className="inspector-heading"><span className="section-eyebrow">{t('live.inspect')}</span><span className="tiny-seal" aria-hidden="true">◇</span></div>
    {disciple ? <div className="selected-detail">
      <div className="person-title"><span className={`pixel-portrait portrait-${disciplePresentation(disciple, world.disciples.findIndex((entry) => entry.id === disciple.id)).index}`} aria-hidden="true" /><div><h2>{t(disciple.nameKey as TextKey)}</h2><p>{t(discipleStatus(disciple, world.cultivation.summaries))}</p></div></div>
      <div className="detail-facts"><span>{t('disciple.age', { years: Math.floor(disciple.ageMonths / 12), months: disciple.ageMonths % 12 })}</span><span>{t('disciple.aptitude', { value: disciple.aptitude })}</span></div>
      <p className="muted small">{t('live.position', disciple.position)}</p>
      {disciple.ageMonths < 16 * 12 && <p className="notice">{t('disciple.young')}</p>}
    </div> : building ? <div className="selected-detail"><h2>{t(building.nameKey as TextKey)}</h2><p className="muted small">{t(building.operational ? 'building.operational' : 'building.closed')}</p><p className="muted small">{t('live.position', { x: building.x, y: building.y })}</p></div> : <p className="muted">{t('live.selectHint')}</p>}
    {disciple && <div className="inspector-tabs" role="group" aria-label={t('live.inspect')}><button className="secondary" aria-pressed={inspectorTab === 'production'} onClick={() => setInspectorTab('production')}>{t('production.title')}</button><button className="secondary" aria-pressed={inspectorTab === 'cultivation'} onClick={() => setInspectorTab('cultivation')}>{t('cultivation.ui.title')}</button><button className="secondary" aria-pressed={inspectorTab === 'workPlans'} onClick={() => setInspectorTab('workPlans')}>{t('workPlans.title')}</button></div>}
    {disciple && inspectorTab === 'workPlans' && automatic ? <WorkPlansPanel key={`${world.sessionEpoch}:${disciple.id}`}
      sessionEpoch={world.sessionEpoch} state={world.sectEconomy}
      worker={{ workerId: disciple.id, nameKey: disciple.nameKey, lifeState: disciple.lifeState, ageMonths: disciple.ageMonths, away: workerProfile?.away ?? false, available: canWork }}
      resources={world.resources.map((resource) => ({ ...resource, incoming: automatic.incoming.find((line) => line.resourceId === resource.resourceId)?.quantity ?? 0 }))}
      status={automatic.status} blockers={automatic.blocked} executionReady={automatic.executionReady} activationReviewRequired={automatic.activationReviewRequired}
      readOnly={readOnly || world.clock.pauseReasons.includes('error')} t={t} onCommand={(command, guard) => session.dispatchSectEconomy(command, guard)}
    /> : disciple && inspectorTab === 'cultivation' ? <CultivationPanel key={`${world.sessionEpoch}:${disciple.id}`} session={session} world={world} readOnly={readOnly} t={t} /> : (recipes.length > 0 ? <section className="production-panel" aria-labelledby="production-heading">
      <h3 id="production-heading">{t('production.title')}</h3>
      {building && <label className="worker-choice">{t('production.worker')}<select value={worker?.id ?? ''} onChange={(event) => setWorkerId(event.target.value)}>
        {world.disciples.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.canWork || entry.lifeState !== 'alive'}>{t(entry.nameKey as TextKey)} · {t(discipleStatus(entry, world.cultivation.summaries))}</option>)}
      </select></label>}
      {transaction && <div className="current-task">
        <span className="section-eyebrow">{t('production.current')}</span>
        <h4>{t(STARTER_RECIPES[transaction.recipeId]!.nameKey as TextKey)}</h4>
        <p>{t(transaction.phase ? `production.phase.${transaction.phase}` : `production.state.${transaction.state}`)}</p>
        <progress value={transaction.activeTicks} max={transaction.requiredTicks} aria-label={t('production.workProgress', { progress: transaction.activeTicks / transaction.requiredTicks })} />
        <div className="task-footer"><span>{t('production.workRemaining', { seconds: Math.ceil((transaction.requiredTicks - transaction.activeTicks) / TICKS_PER_SECOND) })}</span><button className="text-button" disabled={readOnly} onClick={() => session.dispatch({ kind: 'production.cancel', payload: { transactionId: transaction.transactionId } })}>{t('production.cancel')}</button></div>
        {transaction.blockedReason && <p className="notice">{t(`production.blocked.${transaction.blockedReason}`)}</p>}
        <p className="footnote">{t('production.travelHint')}</p>
      </div>}
      <div className="recipe-list">{recipes.map((recipe) => {
        const sufficient = recipe.inputs.every((line) => (world.resources.find((resource) => resource.resourceId === line.resourceId)?.available ?? 0) >= line.quantity);
        return <div key={recipe.recipeId} className="recipe-row">
          <div><h4>{t(recipe.nameKey as TextKey)}</h4><p>{t('production.recipeFlow', { inputs: resourceLine(recipe.inputs, t), outputs: resourceLine(recipe.outputs, t) })}</p><span>{t('production.duration', { seconds: recipe.workTicks / TICKS_PER_SECOND })}</span></div>
          <button disabled={!canWork || !sufficient} title={t(!sufficient ? 'command.error.inventory' : 'production.startHint')} onClick={() => { if (worker) session.dispatch({ kind: 'production.start', payload: { recipeId: recipe.recipeId, workerId: worker.id } }); }}>{t('production.start')}</button>
        </div>;
      })}</div>
      <p className="footnote">{t('production.reservationHint')}</p>
    </section> : <p className="notice">{t(building?.blueprintId === 'storage' ? 'building.storageHint' : 'building.noRecipe')}</p>)}
    <div className="command-feedback" role="status" aria-live="polite">{world.lastCommand ? t(commandFeedbackKey(world.lastCommand)) : null}</div>
  </aside>;
}

function SaveDialog({ controller, session, locale, t, hasCampaign, returnToEntry, onCampaignAvailable, onClose }: { controller: SaveController; session: ApplicationSession; locale: Locale; t: Translator; hasCampaign: boolean; returnToEntry: boolean; onCampaignAvailable: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [confirmation, setConfirmation] = useState<{ slotId: CampaignSlotId; takeover: boolean } | null>(null);
  const [exportNotice, setExportNotice] = useState<TextKey | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    void controller.refresh();
    return () => { element?.close(); };
  }, [controller]);
  async function loadCampaign(slotId: CampaignSlotId, takeover: boolean): Promise<void> {
    const epoch = session.getSnapshot().sessionEpoch;
    await controller.load(slotId, takeover);
    if (session.getSnapshot().sessionEpoch !== epoch) onCampaignAvailable();
  }
  function exportSave() {
    try {
      const file = controller.exportCurrent();
      const url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType }));
      const link = document.createElement('a');
      link.href = url; link.download = file.filename;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportNotice('save.exported');
    } catch { setExportNotice('save.exportError'); }
  }
  return <dialog ref={dialog} className="save-dialog" aria-labelledby="save-title" aria-modal="true" onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); if (!status.busy) { if (confirmation) setConfirmation(null); else onClose(); } }}>
    <div className="dialog-heading"><div><span className="section-eyebrow">{t('app.title')}</span><h2 id="save-title">{t('save.title')}</h2></div><button onClick={onClose} disabled={status.busy}>{t(returnToEntry ? 'entry.back' : 'save.close')}</button></div>
    <p className={status.mode === 'memory' ? 'notice' : 'muted'}>{t(status.mode === 'opening' ? 'save.opening' : status.mode === 'browser' ? 'save.browser' : 'save.memory')}</p>
    {status.readOnly && <p className="notice">{t('save.readOnly')}</p>}
    <p className="footnote">{t('save.occupiedHint')}</p>
    <div className="save-slots">{status.slots.map(({ slotId, slot }, index) => <section className="save-slot" key={slotId}>
      <div><h3>{t('save.slot', { number: index + 1 })}{status.boundSlot === slotId && <span className="current-badge">{t('save.current')}</span>}</h3><p className="small muted">{slot ? t('save.revision', { revision: slot.revision, date: dateLabel(slot.savedAt, locale) }) : t('save.empty')}</p></div>
      <div className="slot-actions"><button disabled={!hasCampaign || !controller.canSave(slotId)} onClick={() => { setConfirmation(null); void controller.save(slotId); }}>{t('save.write')}</button><button className="secondary" disabled={!slot || status.busy} onClick={() => setConfirmation({ slotId, takeover: false })}>{t('save.load')}</button></div>
    </section>)}</div>
    {status.readOnly && status.boundSlot && status.mode === 'browser' && status.notice !== 'save.recoveredReadOnly' && <button onClick={() => setConfirmation({ slotId: status.boundSlot!, takeover: true })} disabled={status.busy}>{t('save.takeover')}</button>}
    {confirmation && <section className="load-confirmation" aria-label={t('save.load')}><p>{t(confirmation.takeover ? 'save.takeoverWarning' : 'save.loadWarning')}</p><div className="dialog-actions"><button disabled={status.busy} onClick={() => { void loadCampaign(confirmation.slotId, confirmation.takeover); setConfirmation(null); }}>{t(confirmation.takeover ? 'save.confirmTakeover' : 'save.confirmLoad')}</button><button className="secondary" disabled={status.busy} onClick={() => setConfirmation(null)}>{t('save.keepPlaying')}</button></div></section>}
    <p role="status" className="save-feedback">{status.notice ? t(status.notice) : null}</p>
    <div className="dialog-actions"><button disabled={!hasCampaign || status.busy} onClick={exportSave}>{t('save.export')}</button><button className="secondary" disabled={status.busy || status.mode !== 'browser'} onClick={() => { void controller.refresh(); }}>{t('save.refresh')}</button></div>
    {exportNotice && <p role="status" className="small">{t(exportNotice)}</p>}
    <SaveImportPanel controller={controller} locale={locale} />
    <p className="footnote">{status.lastSavedAt ? t('save.lastSuccess', { date: dateLabel(status.lastSavedAt, locale) }) : t('save.neverSaved')}</p>
  </dialog>;
}

export function App({ initialLocale, session: suppliedSession }: AppProps) {
  const [session] = useState(() => suppliedSession ?? new ApplicationSession());
  const [saves] = useState(() => new SaveController(session));
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? readLocalePreference() ?? DEFAULT_LOCALE);
  // A single surface owns the transient overlay pause; swapping menus never releases it.
  const [overlay, setOverlay] = useState<'entry' | 'saves' | null>('entry');
  const [hasCampaign, setHasCampaign] = useState(false);
  const [saveReturnToEntry, setSaveReturnToEntry] = useState(false);
  const overlayFocus = useRef<HTMLElement | null>(null);
  const entryButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<'sect' | 'expedition' | 'builds'>('sect');
  const [cultivationReview, setCultivationReview] = useState<{ discipleId: string; request: number } | null>(null);
  const modalOpen = useRef(false);
  modalOpen.current = overlay !== null;
  const world = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const battleController = useSyncExternalStore(session.subscribe, session.getBattleController, session.getBattleController);
  const buildFrame = useSyncExternalStore(session.subscribe, session.getBuildFrame, session.getBuildFrame);
  const saveStatus = useSyncExternalStore(saves.subscribe, saves.getSnapshot, saves.getSnapshot);
  const t: Translator = (key, parameters) => translate(locale, key, parameters);
  const buildDiscipleId = world.selection?.kind === 'disciple' ? world.selection.id : world.disciples[1]?.id ?? world.disciples[0]?.id ?? '';
  const buildDisciple = world.disciples.find((entry) => entry.id === buildDiscipleId);
  useLayoutEffect(() => {
    // Layout effects run before the browser runtime is attached and its first frame can execute.
    session.setOverlayPaused(overlay !== null);
    if (overlay === null) {
      const target = overlayFocus.current?.isConnected ? overlayFocus.current : entryButton.current;
      target?.focus();
      overlayFocus.current = null;
    }
  }, [session, overlay]);
  useLayoutEffect(() => () => session.setOverlayPaused(false), [session]);
  useEffect(() => { if (world.expedition.encounterId) setView('expedition'); }, [world.sessionEpoch, world.expedition.encounterId]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, 'app.title');
  }, [locale]);
  useEffect(() => registerGameStatus((document as Document & { modelContext?: GameModelContext }).modelContext, session, translate(locale, 'tools.sectStatus')), [session, locale]);
  useEffect(() => {
    const stopRuntime = attachBrowserRuntime(session);
    const stopInput = attachInput(session, () => modalOpen.current);
    void saves.start();
    return () => { stopRuntime(); stopInput(); saves.stop(); };
  }, [session, saves]);
  function selectLocale(next: string) { if (next === 'zh-CN' || next === 'en') { setLocale(next); writeLocalePreference(next); } }
  const pauseReason = world.clock.pauseReasons.map((reason) => t(`pause.${reason}`)).join(' · ');
  return <main className="game-shell" lang={locale} style={{ '--disciple-atlas': `url("${import.meta.env.BASE_URL}assets/portraits/disciples-atlas-v1.png")`, ...Object.fromEntries([0, 1, 2, 3].map(index => [`--disciple-fallback-${index}`, `url("${import.meta.env.BASE_URL}assets/characters/disciple-${index}-96-v2.png")`])) } as CSSProperties}>
    <div className="campaign-world" inert={overlay !== null}>
    <header className="shell-header">
      <div className="brand"><svg className="brand-seal" viewBox="0 0 40 48" aria-hidden="true"><rect x="1" y="1" width="38" height="46" rx="3" /><path d="M9 32V20M20 32V13M31 32V20M9 32H31M10 38H30" /></svg><div><h1>{t('app.title')}</h1><p>{t('live.phase')}</p></div></div>
      <div className="clock-cluster"><p className="calendar">{t('live.calendar', { year: world.calendar.year, month: world.calendar.month })}</p><div className="time-controls" role="group" aria-label={t('live.monthProgress')}><button className="pause-button" aria-pressed={world.clock.pauseReasons.includes('player')} onClick={() => session.togglePlayerPause()} disabled={saveStatus.readOnly}>{t(world.clock.pauseReasons.includes('player') ? 'time.resume' : 'time.pause')}</button><button aria-pressed={world.clock.speed === 1} onClick={() => session.setSpeed(1)} disabled={saveStatus.readOnly}>{t('time.normal')}</button><button aria-pressed={world.clock.speed === 3} onClick={() => session.setSpeed(3)} disabled={saveStatus.readOnly}>{t('time.fast')}</button></div></div>
      <div className="header-actions"><button ref={entryButton} className="secondary" onClick={(event) => { overlayFocus.current = event.currentTarget; setOverlay('entry'); }}>{t('entry.open')}</button><button className="secondary" onClick={(event) => { overlayFocus.current = event.currentTarget; setSaveReturnToEntry(false); setOverlay('saves'); }}>{t('save.open')}</button><label className="language-control"><span className="sr-only">{t('settings.language.label')}</span><select value={locale} onChange={(event) => selectLocale(event.target.value)} aria-label={t('settings.language.switch')}><option value="zh-CN">{t('settings.language.zh-CN')}</option><option value="en">{t('settings.language.en')}</option></select></label></div>
    </header>
    <nav className="game-view-tabs" aria-label={t('expedition.ui.navigation')}><button className="secondary" aria-pressed={view === 'sect'} onClick={() => setView('sect')}>{t('expedition.ui.sect')}</button><button className="secondary" aria-pressed={view === 'expedition'} onClick={() => setView('expedition')}>{t('expedition.ui.title')}</button><button className="secondary" aria-pressed={view === 'builds'} onClick={() => setView('builds')}>{t('expedition.ui.builds')}</button>{world.expedition.phase !== 'none' && world.expedition.phase !== 'Ended' && <span className="active-run-label">{t(`expedition.phase.${world.expedition.phase}`)}</span>}</nav>
    <section className="resource-strip" aria-label={t('live.resources')}>{world.resources.map((resource) => <div className={`resource resource-${resource.resourceId}`} key={resource.resourceId} title={t('live.capacity', { capacity: resource.capacity })}><span className="resource-glyph" aria-hidden="true" /><div><div className="resource-topline"><span>{t(`resource.${resource.resourceId}`)}</span><strong>{resource.owned}</strong></div><span className="resource-detail">{t('live.available', { available: resource.available, reserved: resource.reserved })}</span></div></div>)}</section>
    {world.clock.pauseReasons.includes('save-capacity') && <p className="notice warning-text" role="status">{t(world.capacityStop === 'SAVE_OBLIGATION_UNBOUNDED' ? 'command.error.saveObligation' : 'command.error.saveCapacity')}</p>}
    <InventoryPanel resources={world.resources} sessionEpoch={world.sessionEpoch} readOnly={saveStatus.readOnly || world.clock.pauseReasons.includes('error')} t={t}
      suggestedDiscard={world.expedition.phase === 'Ending' && world.expedition.settlement && !world.expedition.settlement.committed
        ? world.resources.map((resource) => ({ resourceId: resource.resourceId, quantity: Math.max(0, resource.owned + [...world.expedition.settlement!.loot, ...world.expedition.settlement!.unusedSupplies].filter((line) => line.resourceId === resource.resourceId).reduce((sum, line) => sum + line.quantity, 0) - resource.capacity) })).filter((line) => line.quantity > 0) : []}
      onDiscard={(request, guard) => session.dispatchInventoryDiscard(request, guard)} />
    {world.cultivation.decisions.length > 0 && <section className="cultivation-alerts" aria-live="polite"><p>{t('cultivation.ui.pending', { count: world.cultivation.decisions.length })}</p>{world.cultivation.decisions.map((decision) => { const disciple = world.disciples.find((entry) => entry.id === decision.discipleId); return disciple ? <button className="secondary" key={`${decision.kind}:${decision.discipleId}`} onClick={() => { setView('sect'); session.select({ kind: 'disciple', id: decision.discipleId }); setCultivationReview((prior) => ({ discipleId: decision.discipleId, request: (prior?.request ?? 0) + 1 })); }}>{t('cultivation.ui.review', { name: t(disciple.nameKey as TextKey) })}</button> : null; })}</section>}
    {view === 'sect' ? <>
    <div className="play-layout">
      <section className="world-panel" aria-labelledby="world-title"><div className="map-heading"><div><p className="section-eyebrow">{t('live.mapSubtitle')}</p><h2 id="world-title">{t('live.mapTitle')}</h2></div><p className={`time-status ${world.paused ? 'is-paused' : ''}`}>{t(world.paused ? 'time.paused' : 'time.running', world.paused ? { reason: pauseReason } : undefined)}</p></div><PhaserWorld session={session} locale={locale} /><div className="map-footer"><span>{t('live.provisional')}</span><span>{t('live.tick', { tick: world.clock.simulationTick })}</span></div></section>
      <Inspector session={session} world={world} t={t} readOnly={saveStatus.readOnly} cultivationReview={cultivationReview} />
    </div>
    <section className="sect-roster" aria-labelledby="roster-title"><h2 id="roster-title">{t('live.disciples')}</h2><div className="disciple-list">{world.disciples.map((disciple, index) => <button className="disciple-chip" key={disciple.id} aria-pressed={world.selection?.kind === 'disciple' && world.selection.id === disciple.id} onClick={() => session.select({ kind: 'disciple', id: disciple.id })}><span className={`disciple-dot disciple-dot-${disciplePresentation(disciple, index).index}`} aria-hidden="true" /><span>{t(disciple.nameKey as TextKey)}</span><small>{t(discipleStatus(disciple, world.cultivation.summaries))}</small></button>)}</div></section>
    <div className="lower-details"><details><summary>{t('live.buildings')}</summary><div className="building-list">{world.buildings.map((building) => <button className="secondary" key={building.id} aria-pressed={world.selection?.kind === 'building' && world.selection.id === building.id} onClick={() => session.select({ kind: 'building', id: building.id })}>{t(building.nameKey as TextKey)}</button>)}</div></details><details><summary>{t('live.events')}</summary>{world.recentEvents.length ? <ol className="event-list">{world.recentEvents.map((event) => {
      const eventTransaction = world.transactions.find((entry) => entry.transactionId === event.transactionId);
      const name = world.disciples.find((entry) => entry.id === (event.discipleId ?? event.workerId ?? eventTransaction?.workerId))?.nameKey;
      if (event.kind === 'inventory.discarded') return <li key={event.eventId}>{t('event.inventory.discarded', { resource: event.resourceId ? t(`resource.${event.resourceId}`) : '', quantity: event.quantity ?? 0 })}</li>;
      if (event.kind.startsWith('cultivation.')) return <li key={event.eventId}>{t(`event.${event.kind}` as TextKey, { name: name ? t(name as TextKey) : '' })}</li>;
      const recipeId = typeof event.recipeId === 'string' ? event.recipeId : '';
      const recipe = STARTER_RECIPES[recipeId];
      if (event.kind === 'production.blocked') return <li key={event.eventId}>{t('event.production.paused', { name: name ? t(name as TextKey) : '', reason: typeof event.reason === 'string' ? t(`production.blocked.${event.reason}` as TextKey) : t('command.error.unavailable') })}</li>;
      return <li key={event.eventId}>{t(`event.${event.kind}`, { name: name ? t(name as TextKey) : '', recipe: recipe ? t(recipe.nameKey as TextKey) : '' })}</li>;
    })}</ol> : <p className="muted small">{t('live.noEvents')}</p>}</details></div>
    </> : view === 'expedition' ? <ExpeditionPanel key={world.sessionEpoch} session={session} world={world} controller={battleController} locale={locale} readOnly={saveStatus.readOnly} onReturnSect={() => setView('sect')} /> : <section className="build-view-shell">
      <label className="build-view-selector">{t('live.disciples')}<select value={buildDiscipleId} onChange={(event) => session.select({ kind: 'disciple', id: event.target.value })}>{world.disciples.map((disciple) => <option value={disciple.id} key={disciple.id}>{t(disciple.nameKey as TextKey)}</option>)}</select></label>
      <BuildPanel key={`${world.sessionEpoch}:${buildDiscipleId}`} frame={buildFrame} catalog={session.getCombatCatalog()} context={session.getBuildContentContext()} lifeState={buildDisciple?.lifeState} discipleId={buildDiscipleId} locale={locale} discipleName={buildDisciple ? t(buildDisciple.nameKey as TextKey) : t('expedition.ui.none')} readOnly={saveStatus.readOnly || world.clock.pauseReasons.includes('error') || buildDisciple?.lifeState !== 'alive' || world.clock.mode !== 'management'} locked={!!buildFrame.builds.disciples.find((entry) => entry.discipleId === buildDiscipleId)?.lock} onCommand={(request) => { const result = session.dispatchBuild(request); return result.status === 'accepted' ? { ok: true } : result.rejection?.buildCode ? { ok: false, code: result.rejection.buildCode } : { ok: false }; }} />
      <button className="secondary" onClick={() => setView('sect')}>{t('expedition.ui.returnSect')}</button>
    </section>}
    <footer className="shell-footer"><p>{t('live.help')}</p><p className={saveStatus.mode === 'memory' || saveStatus.readOnly ? 'warning-text' : ''}>{saveStatus.mode === 'memory' ? t('save.memory') : saveStatus.readOnly ? t('save.readOnly') : saveStatus.lastSavedAt ? t('save.lastSuccess', { date: dateLabel(saveStatus.lastSavedAt, locale) }) : t('save.neverSaved')}</p></footer>
    </div>
    {overlay === 'entry' && <CampaignEntry controller={saves} session={session} locale={locale} hasCampaign={hasCampaign} onEnter={() => { setHasCampaign(true); setOverlay(null); }} onCampaignAvailable={() => setHasCampaign(true)} onManageSaves={() => { setSaveReturnToEntry(true); setOverlay('saves'); }} onLocaleChange={selectLocale} />}
    {overlay === 'saves' && <SaveDialog controller={saves} session={session} locale={locale} t={t} hasCampaign={hasCampaign} returnToEntry={saveReturnToEntry || !hasCampaign} onCampaignAvailable={() => setHasCampaign(true)} onClose={() => setOverlay(saveReturnToEntry || !hasCampaign ? 'entry' : null)} />}
  </main>;
}
