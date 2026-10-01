import { disciplePresentation } from '../application/character-presentation';
import { useId, useMemo, useState } from 'react';
import type { CombatControllerState } from '../core/combat/ai';
import { canonicalStringify } from '../core/kernel/serialization';
import type { ResourceLine } from '../core/economy/types';
import { EXPEDITION_COMBAT_CATALOG, EXPEDITION_ENCOUNTERS, STARTER_ROUTE_ID } from '../core/expeditions/encounter-catalog';
import type { ExpeditionDepartureRequest } from '../core/expeditions/world-types';
import { combatMessageSpecifications } from '../content/definitions/messages';
import { combatZhCN } from '../content/locales/zh-CN/combat';
import { combatEn } from '../content/locales/en/combat';
import { ApplicationSession, type DeepReadonly, type DepartureProposal, type OfferProjection, type SessionProjection } from '../application/session';
import { commandFeedbackKey, expeditionMessages } from '../application/status-messages';
import { createTranslator, translate, type Locale, type TextKey, type TranslationParams } from '../i18n';
import { BattlePanel } from './BattlePanel';
import type { BattleEntityPresentations } from '../phaser/PhaserBattle';
import './expedition.css';

type Projection = DeepReadonly<SessionProjection>;
type Translator = (key: TextKey, parameters?: TranslationParams) => string;
const contentText = createTranslator({ baseCatalog: combatZhCN, englishCatalog: combatEn, specifications: combatMessageSpecifications });
export interface ExpeditionPanelProps { session: ApplicationSession; world: Projection; controller: CombatControllerState | null; locale: Locale; readOnly: boolean; onReturnSect: () => void }
const resources = (lines: readonly ResourceLine[], t: Translator) => lines.length ? lines.map((line) => t('production.line', { amount: line.quantity, name: t(`resource.${line.resourceId}`) })).join(' · ') : t('expedition.ui.none');
const discipleName = (world: Projection, id: string, t: Translator) => { const nameKey = world.disciples.find((disciple) => disciple.id === id)?.nameKey; return nameKey ? t(nameKey as TextKey) : t('expedition.ui.none'); };

/** The live form and the confirmation guard share one canonical request builder. */
export function expeditionDepartureRequest(squadIds: readonly string[], mealInput: string): ExpeditionDepartureRequest | null {
  const mealCount = mealInput.trim() === '' ? null : Number(mealInput);
  if (squadIds.length < 1 || squadIds.length > 6 || new Set(squadIds).size !== squadIds.length || (mealCount !== null && (!Number.isSafeInteger(mealCount) || mealCount < 0))) return null;
  return { squadIds: [...squadIds], routeId: STARTER_ROUTE_ID, ...(mealCount === null ? {} : { supplies: mealCount === 0 ? [] : [{ resourceId: 'meal' as const, quantity: mealCount }] }) };
}
export function departureFormMatches(proposal: DeepReadonly<DepartureProposal>, squadIds: readonly string[], mealInput: string): boolean {
  const request = expeditionDepartureRequest(squadIds, mealInput);
  return request !== null && canonicalStringify(request) === canonicalStringify(proposal.request);
}

/** Prefer two available adults; age itself is not a fabricated expedition restriction. */
export function defaultExpeditionSquad(world: Projection): string[] {
  return [...world.expedition.preparationCandidates].filter((entry) => entry.available).sort((left, right) => {
    const leftAdult = (world.disciples.find((entry) => entry.id === left.discipleId)?.ageMonths ?? 0) >= 192;
    const rightAdult = (world.disciples.find((entry) => entry.id === right.discipleId)?.ageMonths ?? 0) >= 192;
    return Number(rightAdult) - Number(leftAdult);
  }).slice(0, 2).map((entry) => entry.discipleId);
}

export function expeditionBattlePresentations(world: Projection, locale: Locale): BattleEntityPresentations {
  const t: Translator = (key, parameters) => translate(locale, key, parameters);
  const entries: Record<string, { name: string; art: 'disciple-0' | 'disciple-1' | 'disciple-2' | 'disciple-3' | 'ridge-raider' | 'venom-adept' | 'ruin-guardian' }> = {};
  for (const participant of world.expedition.participants) {
    const index = world.disciples.findIndex((entry) => entry.id === participant.discipleId);
    if (index >= 0) entries[participant.battleEntityId] = { name: discipleName(world, participant.discipleId, t), art: disciplePresentation(world.disciples[index]!, index).id };
  }
  for (const enemy of world.expedition.enemies) entries[enemy.battleEntityId] = { name: t(enemy.nameKey as TextKey), art: enemy.archetypeId };
  return entries;
}

function OfferChoice({ session, offer, world, locale, locked }: { session: ApplicationSession; offer: DeepReadonly<OfferProjection>; world: Projection; locale: Locale; locked: boolean }) {
  const prefix = useId();
  const t: Translator = (key, parameters) => translate(locale, key, parameters);
  const [cardId, setCardId] = useState<string | null>(null);
  const [holderId, setHolderId] = useState('');
  const [confirmSupplies, setConfirmSupplies] = useState(false);
  const selected = EXPEDITION_COMBAT_CATALOG.talents.find((entry) => entry.id === cardId && offer.candidateDefinitionIds.includes(entry.id));
  const holders = selected ? offer.eligibleHolderIdsByCard[selected.id] ?? [] : [];
  const requiresHolder = !!selected && (selected.holderScope === 'personal' || selected.recipientBinding === 'selectedTalisman');
  const legalSelection = !!selected && (!requiresHolder || holders.includes(holderId));
  const canReroll = offer.remainingRerolls > 0 && !offer.diagnostics.includes('REROLL_HAS_NO_NEW_CARD');
  return <section className="expedition-offer" aria-labelledby={`${prefix}-title`}>
    <h3 id={`${prefix}-title`}>{t('expedition.ui.offer')}</h3><p className="footnote">{t('expedition.ui.offerHint')}</p>
    <div className="expedition-cards">{offer.candidateDefinitionIds.map((id) => {
      const talent = EXPEDITION_COMBAT_CATALOG.talents.find((entry) => entry.id === id);
      if (!talent) return null;
      return <article className="expedition-card" key={id} data-selected={cardId === id}>
        <span className="section-eyebrow">{t(talent.holderScope === 'team' ? 'expedition.ui.teamHolder' : 'expedition.ui.personalHolder')}</span>
        <h4>{contentText(locale, talent.nameKey)}</h4><p>{contentText(locale, talent.descriptionKey, talent.descriptionParameters)}</p>
        <button className="secondary" aria-pressed={cardId === id} disabled={locked} onClick={() => { setCardId(id); setHolderId(''); setConfirmSupplies(false); }}>{t('expedition.ui.chooseCard')}</button>
      </article>;
    })}</div>
    {offer.candidateDefinitionIds.length === 0 && <p className="notice">{t('expedition.ui.noCards')}</p>}
    {selected && <div className="expedition-choice-confirmation"><h4>{contentText(locale, selected.nameKey)}</h4>{requiresHolder ? <label htmlFor={`${prefix}-holder`}>{t('expedition.ui.holder')}<select id={`${prefix}-holder`} value={holderId} disabled={locked} onChange={(event) => setHolderId(event.target.value)}><option value="">{t('expedition.ui.chooseHolder')}</option>{holders.map((id) => <option key={id} value={id}>{discipleName(world, id, t)}</option>)}</select></label> : <p>{t('expedition.ui.teamHolder')}</p>}<button disabled={locked || !legalSelection} onClick={() => { if (selected && legalSelection) session.dispatchExpedition({ kind: 'expedition.choose', offerId: offer.offerId, offerRevision: offer.revision, definitionId: selected.id, holderId: requiresHolder ? holderId : null }); }}>{t('expedition.ui.confirmChoice')}</button></div>}
    <div className="expedition-offer-actions"><div><p>{t('expedition.ui.rerolls', { count: offer.remainingRerolls })}</p><button className="secondary" disabled={locked || !canReroll} onClick={() => session.dispatchExpedition({ kind: 'expedition.reroll', offerId: offer.offerId, offerRevision: offer.revision })}>{t('expedition.ui.reroll')}</button>{!canReroll && offer.remainingRerolls > 0 && <p className="footnote">{t('expedition.ui.noNewCard')}</p>}</div><button className="secondary" disabled={locked} onClick={() => setConfirmSupplies(true)}>{t('expedition.ui.supplyAlternative', { supplies: resources(offer.supplyFallback, t) })}</button></div>
    {confirmSupplies && <div className="expedition-choice-confirmation"><p>{t('expedition.ui.supplyWarning')}</p><div className="expedition-actions"><button disabled={locked} onClick={() => session.dispatchExpedition({ kind: 'expedition.supplies', offerId: offer.offerId, offerRevision: offer.revision })}>{t('expedition.ui.confirmSupplies')}</button><button className="secondary" onClick={() => setConfirmSupplies(false)}>{t('expedition.ui.keepOffer')}</button></div></div>}
  </section>;
}

export function ExpeditionPanel({ session, world, controller, locale, readOnly, onReturnSect }: ExpeditionPanelProps) {
  const prefix = useId(); const expedition = world.expedition;
  const t: Translator = (key, parameters) => translate(locale, key, parameters);
  const locked = readOnly || world.clock.pauseReasons.includes('error');
  const [squadIds, setSquadIds] = useState(() => defaultExpeditionSquad(world));
  const [mealInput, setMealInput] = useState('');
  const [proposal, setProposal] = useState<DeepReadonly<DepartureProposal> | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [retreatConfirmation, setRetreatConfirmation] = useState(false);
  const [newPreparation, setNewPreparation] = useState(false);
  const preparation = expedition.phase === 'none' || (expedition.phase === 'Ended' && newPreparation);
  const fresh = !!proposal && session.isDepartureProposalCurrent(proposal) && departureFormMatches(proposal, squadIds, mealInput);
  const mealCount = mealInput.trim() === '' ? null : Number(mealInput);
  const validMealCount = mealCount === null || (Number.isSafeInteger(mealCount) && mealCount >= 0);
  const presentations = useMemo(() => expeditionBattlePresentations(world, locale), [world, locale]);
  const encounter = EXPEDITION_ENCOUNTERS.find((entry) => entry.id === expedition.nextEncounterDefinitionId);
  const nameOf = (id: string) => discipleName(world, id, t);
  function invalidate() { setProposal(null); setAcknowledged(false); setPreviewError(false); }
  function prepare() {
    if (!validMealCount || squadIds.length < 1 || squadIds.length > 6) return;
    const request = expeditionDepartureRequest(squadIds, mealInput);
    if (!request) return;
    try { setProposal(session.prepareExpedition(request)); setAcknowledged(false); setPreviewError(false); }
    catch { setPreviewError(true); setProposal(null); }
  }
  const continueAllowed = expedition.phase === 'AtNode' || ((expedition.phase === 'Travelling' || expedition.phase === 'Ending') && expedition.travelTotalTicks === 0);
  const canRetreat = expedition.phase === 'AtNode' || expedition.phase === 'RewardPending';
  const settlement = expedition.settlement;
  const history = expedition.phase === 'Ended' && expedition.latestHistory?.runId === expedition.runId ? expedition.latestHistory : null;
  return <section className="expedition-panel" aria-labelledby={`${prefix}-title`}>
    <header className="expedition-header"><div><p className="section-eyebrow">{t('expedition.ui.title')}</p><h2 id={`${prefix}-title`}>{t('expedition.ui.routeName')}</h2><p>{t('expedition.ui.routeDescription')}</p></div><span className="expedition-phase">{t(`expedition.phase.${expedition.phase}`)}</span></header>
    {preparation ? <div className="expedition-preparation">
      <section className="expedition-squad-picker"><h3>{t('expedition.ui.chooseSquad')}</h3><p className="footnote">{t('expedition.ui.squadCount', { count: squadIds.length })}</p><div className="expedition-squad-options">{expedition.preparationCandidates.map((candidate) => {
        const checked = squadIds.includes(candidate.discipleId);
        return <label key={candidate.discipleId} className="expedition-member-choice"><input type="checkbox" checked={checked} disabled={locked || (!checked && (!candidate.available || squadIds.length >= 6))} onChange={(event) => { setSquadIds((current) => event.target.checked ? [...current, candidate.discipleId] : current.filter((id) => id !== candidate.discipleId)); invalidate(); }} /><span><strong>{nameOf(candidate.discipleId)}</strong><small>{candidate.available ? t('cultivation.ui.lifespan', { months: candidate.remainingLifespanMonths }) : t('expedition.ui.memberUnavailable')}</small></span></label>;
      })}</div></section>
      <section className="expedition-preflight"><h3>{t('expedition.ui.supplies')}</h3><label htmlFor={`${prefix}-meals`}>{t('expedition.ui.meals')}<input id={`${prefix}-meals`} type="number" min={0} step={1} inputMode="numeric" value={mealInput} onChange={(event) => { setMealInput(event.target.value); invalidate(); }} /></label><p className="footnote">{t('expedition.ui.automaticSupplies')}</p><p>{t('expedition.ui.availableMeals', { count: world.resources.find((entry) => entry.resourceId === 'meal')?.available ?? 0 })}</p>{!validMealCount && <p className="notice">{t('expedition.ui.supplyInvalid')}</p>}<button className="secondary" disabled={!validMealCount || squadIds.length < 1 || squadIds.length > 6} onClick={prepare}>{t(proposal ? 'expedition.ui.refreshPreview' : 'expedition.ui.preview')}</button><p className="footnote">{t('expedition.ui.previewReadonly')}</p></section>
      {proposal && <section className="expedition-departure-preview"><h3>{t('expedition.ui.preparation')}</h3><p>{proposal.preview.squadIds.map(nameOf).join(' · ')}</p><p>{t('expedition.ui.expectedMonths', { months: proposal.preview.expectedMonths })}</p><p>{t('expedition.ui.minimumSupplies', { supplies: resources(proposal.preview.minimumSupplies, t) })}</p><p>{t('expedition.ui.requestedSupplies', { supplies: resources(proposal.preview.requestedSupplies, t) })}</p><p className="notice">{t('expedition.ui.departureWarning')}</p>
        {proposal.preview.warnings.map((warning) => <p className="notice" key={`${warning.code}:${warning.discipleId}`}>{warning.code === 'LIFESPAN_BEFORE_RETURN' ? t('expedition.ui.lifespanRisk', { name: nameOf(warning.discipleId), months: expedition.preparationCandidates.find((entry) => entry.discipleId === warning.discipleId)?.remainingLifespanMonths ?? 0 }) : t('expedition.ui.injuryRisk', { name: nameOf(warning.discipleId) })}</p>)}
        {proposal.preview.blockers.length > 0 && <ul className="expedition-blockers">{proposal.preview.blockers.map((code) => <li key={code}>{t(expeditionMessages[code])}</li>)}</ul>}{!fresh && <p className="notice" role="status">{t('expedition.ui.previewStale')}</p>}
        <label className="expedition-ack"><input type="checkbox" checked={acknowledged} disabled={locked || !fresh || proposal.preview.blockers.length > 0} onChange={(event) => setAcknowledged(event.target.checked)} /><span>{t('expedition.ui.acknowledgeDeparture')}</span></label><button disabled={locked || !fresh || !acknowledged || proposal.preview.blockers.length > 0} onClick={() => { if (fresh && acknowledged) { const result = session.confirmDeparture(proposal); if (result.status === 'accepted') { invalidate(); setNewPreparation(false); } } }}>{t('expedition.ui.depart')}</button>
      </section>}{previewError && <p className="notice" role="status">{t('expedition.ui.previewFailed')}</p>}
    </div> : <>
      <section className="expedition-route" aria-label={t('expedition.ui.route')}><p>{t('expedition.ui.nodeProgress', { current: Math.min(expedition.nodeIndex + 1, expedition.nodeCount), total: expedition.nodeCount })}</p><ol>{expedition.route.map((node, index) => { const definition = EXPEDITION_ENCOUNTERS.find((entry) => entry.id === node.encounterDefinitionId); return <li key={node.nodeId} data-current={index === expedition.nodeIndex} data-visited={index < expedition.nodeIndex}><span>{index + 1}</span><strong>{definition ? t(definition.nameKey as TextKey) : t('expedition.phase.AtNode')}</strong><small>{t('expedition.ui.nodeTravel', { months: node.travelMonths })}</small></li>; })}</ol></section>
      <section className="expedition-current"><h3>{t('expedition.ui.squad')}</h3><p>{expedition.members.map((member) => nameOf(member.discipleId)).join(' · ')}</p><p>{t('expedition.ui.availableSupplies', { supplies: resources(expedition.availableSupplies, t) })}</p>{expedition.blockedReason && <p className="notice" role="status">{t(expeditionMessages[expedition.blockedReason])}</p>}{expedition.forcedWithdrawal && <p className="notice">{t('expedition.ui.forcedWithdrawal')}</p>}{expedition.lastEncounterOutcome && <p className="expedition-outcome">{t('expedition.ui.lastEncounter', { outcome: t(`expedition.ui.${expedition.lastEncounterOutcome}`) })}</p>}</section>
      {controller && expedition.phase === 'InEncounter' ? <><p className="footnote">{t('expedition.ui.battleActive')}</p><BattlePanel controller={controller} catalog={EXPEDITION_COMBAT_CATALOG} locale={locale} entityPresentation={presentations} paused={world.paused} speed={world.clock.speed} readOnly={locked} onPausedChange={(paused) => session.setPaused('player', paused)} onSpeedChange={(speed) => session.setSpeed(speed)} onTacticalOrder={(order) => { session.dispatchExpedition({ kind: 'expedition.tactic', order }); }} retreatStatus="unavailable" /><p className="footnote">{t('expedition.ui.emergencyUnavailable')}</p></> : <>
        {(expedition.phase === 'Travelling' || expedition.phase === 'Ending') && <section className="expedition-checkpoint"><h3>{t(`expedition.phase.${expedition.phase}`)}</h3>{expedition.travelTotalTicks > 0 ? <><p>{t('expedition.ui.travelProgress', { progress: expedition.travelProgressTicks / expedition.travelTotalTicks })}</p><progress max={expedition.travelTotalTicks} value={expedition.travelProgressTicks} aria-label={t('expedition.ui.travelProgress', { progress: expedition.travelProgressTicks / expedition.travelTotalTicks })} /></> : <p>{t('expedition.ui.awaitTravel')}</p>}<p className="footnote">{t('expedition.ui.checkpointHint')}</p></section>}
        {expedition.phase === 'AtNode' && encounter && <section className="expedition-node"><h3>{t(encounter.nameKey as TextKey)}</h3><p>{t(encounter.descriptionKey as TextKey)}</p></section>}
        {continueAllowed && <button disabled={locked || world.cultivation.decisions.length > 0} onClick={() => session.dispatchExpedition({ kind: 'expedition.continue' })}>{t(expedition.phase === 'AtNode' ? 'expedition.ui.enterEncounter' : expedition.phase === 'Ending' ? 'expedition.ui.continueReturn' : 'expedition.ui.continueTravel')}</button>}
        {expedition.phase === 'RewardPending' && expedition.currentOffer && <OfferChoice key={`${expedition.currentOffer.offerId}:${expedition.currentOffer.revision}`} session={session} world={world} offer={expedition.currentOffer} locale={locale} locked={locked || world.cultivation.decisions.length > 0} />}
        {canRetreat && <section className="expedition-retreat"><button className="secondary" disabled={locked} onClick={() => setRetreatConfirmation(true)}>{t('expedition.ui.retreat')}</button>{retreatConfirmation && <div className="expedition-choice-confirmation"><p>{t('expedition.ui.retreatWarning')}</p><div className="expedition-actions"><button disabled={locked} onClick={() => { const result = session.dispatchExpedition({ kind: 'expedition.retreat' }); if (result.status === 'accepted') setRetreatConfirmation(false); }}>{t('expedition.ui.confirmRetreat')}</button><button className="secondary" onClick={() => setRetreatConfirmation(false)}>{t('expedition.ui.keepRun')}</button></div></div>}</section>}
      </>}
      {expedition.talentInstances.length > 0 && <details className="expedition-talents"><summary>{t('expedition.ui.runTalents')}</summary><ul>{expedition.talentInstances.map((instance) => { const definition = EXPEDITION_COMBAT_CATALOG.talents.find((entry) => entry.id === instance.definitionId); return definition ? <li key={instance.instanceId}><strong>{contentText(locale, definition.nameKey)}</strong><span>{instance.holderId || instance.boundHolderId ? nameOf((instance.holderId ?? instance.boundHolderId)!) : t('expedition.ui.teamHolder')}</span></li> : null; })}</ul></details>}
      {(settlement || history) && <section className="expedition-results"><h3>{t('expedition.ui.results')}</h3><p>{t('expedition.ui.endReason', { reason: t(`expedition.reason.${(history ?? settlement)!.reason}`) })}</p><p>{t('expedition.ui.loot', { supplies: resources((history ?? settlement)!.loot, t) })}</p><p>{t('expedition.ui.lostLoot', { supplies: resources((history ?? settlement)!.lostLoot, t) })}</p><p>{t('expedition.ui.returnedSupplies', { supplies: resources(history?.returnedSupplies ?? settlement?.unusedSupplies ?? [], t) })}</p>{history ? <><p>{t('expedition.ui.survivors', { names: history.survivingDiscipleIds.map(nameOf).join(' · ') || t('expedition.ui.none') })}</p><p>{t('expedition.ui.deadMembers', { names: history.deadDiscipleIds.map(nameOf).join(' · ') || t('expedition.ui.none') })}</p><p className="notice">{t('expedition.ui.settlementCommitted')}</p><button onClick={() => { setSquadIds(defaultExpeditionSquad(world)); setMealInput(''); invalidate(); setNewPreparation(true); }}>{t('expedition.ui.prepareAgain')}</button></> : <p className="notice">{t('expedition.ui.pendingSettlement')}</p>}</section>}
    </>}
    <div className="expedition-feedback" role="status">{world.lastCommand ? t(commandFeedbackKey(world.lastCommand)) : null}</div><button className="secondary" onClick={onReturnSect}>{t('expedition.ui.returnSect')}</button>
  </section>;
}
