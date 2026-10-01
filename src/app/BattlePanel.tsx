import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CombatContentCatalog } from '../core/combat/definitions';
import { COMBAT_TICKS_PER_SECOND } from '../core/combat/definitions';
import type { CombatControllerState, TacticalCommand } from '../core/combat/ai';
import { queryCastReadiness, type BattleEvent, type CastReadiness } from '../core/combat';
import { translate, type Locale } from '../i18n';
import { PhaserBattle, battleAssetUrl, battleDefinitionName, battleText, buildBattleProjection, buildBattleZoneProjection, PAPER_DECOY_OUTLINE } from '../phaser/PhaserBattle';
import type { BattleEntityPresentations, BattleUnitView } from '../phaser/PhaserBattle';
import './battle.css';

export interface BattlePanelProps {
  readonly controller: CombatControllerState; readonly catalog: CombatContentCatalog; readonly locale: Locale;
  readonly entityPresentation?: BattleEntityPresentations; readonly paused: boolean; readonly speed: 1 | 3;
  readonly onPausedChange: (paused: boolean) => void; readonly onSpeedChange: (speed: 1 | 3) => void;
  readonly onTacticalOrder: (command: TacticalCommand) => void; readonly readOnly?: boolean;
  readonly retreatStatus?: 'available' | 'pending' | 'unavailable'; readonly retreatRemainingTicks?: number;
  readonly onRetreat?: () => void; readonly onContinue?: () => void;
}
export function battlePauseKeyAction(code: string, tagName: string, repeat: boolean, enabled: boolean): 'ignore' | 'consume' | 'toggle' { if (code !== 'Space' || ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'A'].includes(tagName.toUpperCase())) return 'ignore'; return enabled && !repeat ? 'toggle' : 'consume'; }
export const battleSeconds = (ticks: number): number => Math.max(0, ticks) / COMBAT_TICKS_PER_SECOND;
function useReducedMotion(): boolean { const [reduced, setReduced] = useState(false); useEffect(() => { const media = window.matchMedia('(prefers-reduced-motion: reduce)'); setReduced(media.matches); const change = () => setReduced(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []); return reduced; }
export function formatBattleEvent(event: BattleEvent, units: readonly BattleUnitView[], catalog: CombatContentCatalog, locale: Locale): string | null {
  const eventName = (id: string | null) => units.find(unit => unit.id === id)?.name ?? (id?.startsWith('summon:') ? battleText(locale, 'summon.fallback') : undefined);
  const actor = eventName(event.actorId) ?? battleText(locale, 'unitFallback', { number: 0 }); const target = eventName(event.targetId) ?? actor;
  switch (event.kind) {
    case 'damage.healthLost': return battleText(locale, 'event.damage', { actor, target, amount: event.values.actualHealthLoss ?? 0 });
    case 'healing.resolved': return battleText(locale, 'event.heal', { actor, target, amount: event.values.effectiveHealing ?? 0 });
    case 'shield.absorbed': return battleText(locale, 'event.shield', { target, amount: event.values.actualShieldAbsorbed ?? 0 });
    case 'life.downed': return battleText(locale, 'event.downed', { target });
    case 'life.died': return battleText(locale, 'event.dead', { target });
    case 'action.committed': return battleText(locale, 'event.cast', { actor, skill: battleDefinitionName(locale, event.sourceDefinitionId ?? 'runtime.basic', catalog) });
    default: return null;
  }
}
export interface BattleSkillCommandContext {
  readonly controller: CombatControllerState; readonly catalog: CombatContentCatalog;
  readonly commanderId: string | null; readonly selectedTargetId: string | null;
  readonly readOnly: boolean; readonly onTacticalOrder: (command: TacticalCommand) => void;
}
/** Recheck live props at dispatch, including the commander rather than the inspected
 * unit. Player pause allows tactical input; the world command port owns overlay/error locks. */
export function dispatchBattleSkill(context: BattleSkillCommandContext, skillId: string): boolean {
  const { controller, catalog, commanderId, selectedTargetId, readOnly, onTacticalOrder } = context;
  const actor = commanderId === null ? undefined : controller.battle.entities[commanderId];
  if (readOnly || controller.outcome.status !== 'running' || !actor || actor.kind !== 'combatant' || actor.team !== controller.config.playerTeam) return false;
  const skill = catalog.skills.find(item => item.id === skillId); if (!skill || skill.activation !== 'active') return false;
  const targetId = skill.action.targetTeam === 'self' ? actor.id : selectedTargetId;
  const readiness = queryCastReadiness(controller.battle, catalog, actor.id, skillId, targetId);
  if (!readiness.ready || targetId === null) return false;
  onTacticalOrder({ kind: 'cast', actorId: actor.id, skillId, targetId }); return true;
}
function skillReadinessText(readiness: CastReadiness, locale: Locale): string {
  switch (readiness.reason) {
    case null: return battleText(locale, 'skill.ready');
    case 'battle-ended': return battleText(locale, 'skill.ended');
    case 'actor-downed': return battleText(locale, 'skill.actorDowned');
    case 'actor-dead': return battleText(locale, 'skill.actorDead');
    case 'recovery-lock': return battleText(locale, 'skill.recovery', { seconds: battleSeconds(readiness.recoveryRemainingTicks) });
    case 'action-lock': return battleText(locale, 'skill.actionLock');
    case 'actor-casting': return battleText(locale, 'skill.casting');
    case 'cooldown': return battleText(locale, 'skill.cooldown', { seconds: battleSeconds(readiness.cooldownRemainingTicks) });
    case 'missing-target': return battleText(locale, 'skill.noTarget');
    case 'target-team': return battleText(locale, 'skill.wrongTeam');
    case 'target-downed': return battleText(locale, 'skill.targetDowned');
    case 'target-dead': return battleText(locale, 'skill.targetDead');
    case 'out-of-range': return battleText(locale, 'skill.range');
    case 'insufficient-spirit': return battleText(locale, 'skill.resource', { cost: readiness.spiritCostUnits, available: readiness.availableSpiritUnits });
    case 'condition': return battleText(locale, 'skill.condition');
    default: return battleText(locale, 'skill.unavailable');
  }
}
function UnitPortrait({ unit, large = false }: { unit: BattleUnitView; large?: boolean }) {
  return <span className={`battle-portrait${large ? ' battle-portrait-large' : ''}`} data-life={unit.life} data-kind={unit.kind}>{unit.art === 'paper-decoy' ? <svg className="battle-paper-decoy" viewBox="0 0 96 96" aria-hidden="true" focusable="false" data-art="paper-decoy">
    <polygon points={PAPER_DECOY_OUTLINE.map(point => point.join(',')).join(' ')} fill="#f3e8c4" stroke="#73694e" strokeWidth="2" />
    <path d="M38 12 48 32 58 12 M48 36V68 M37 67 48 57 59 67" fill="none" stroke="#b9aa7d" />
    <path d="M43 40H53 M47 40V57 M42 47H54 M43 55H53" fill="none" stroke="#9e5549" strokeWidth="3" />
    <path d="M37 63H59" stroke={unit.ally ? '#7dc7ad' : '#d88677'} strokeWidth="4" />
  </svg> : <img src={battleAssetUrl(unit.art)} alt="" width={96} height={96} draggable={false} />}</span>;
}
function Roster({ title, units, selected, onSelect, locale }: { title: string; units: readonly BattleUnitView[]; selected: string | null; onSelect: (id: string) => void; locale: Locale }) {
  return <section className="battle-roster" aria-label={title}><h3>{title}</h3><div className="battle-roster-units">{units.map(unit => <button type="button" key={unit.id} className="battle-unit-button" data-side={unit.ally ? 'ally' : 'enemy'} data-kind={unit.kind} data-life={unit.life} aria-pressed={unit.id === selected} onClick={() => onSelect(unit.id)}>
    <UnitPortrait unit={unit} /><span className="battle-roster-detail"><strong>{unit.name}</strong><span className="battle-roster-health"><span style={{ width: `${Math.max(0, Math.min(100, unit.health * 100 / unit.maximumHealth))}%` }} /></span><span className="battle-roster-numbers">{unit.health} / {unit.maximumHealth}{unit.shield > 0 && <span className="battle-shield-small"> ◇ {unit.shield}</span>}</span><span className="battle-roster-life">{unit.kind === 'summon' ? `${battleText(locale, unit.ally ? 'side.ally' : 'side.enemy')} · ${battleText(locale, 'summon.kind')}` : battleText(locale, `life.${unit.life}`)}</span>{unit.summon && <span className="battle-summon-expiry">{unit.summon.lifetimeLabel}</span>}</span>
  </button>)}</div></section>;
}
export function BattlePanel({ controller, catalog, locale, entityPresentation, paused, speed, onPausedChange, onSpeedChange, onTacticalOrder, readOnly = false, retreatStatus = 'unavailable', retreatRemainingTicks = 0, onRetreat, onContinue }: BattlePanelProps) {
  const titleId = useId(); const commandId = useId(); const reducedMotion = useReducedMotion();
  const units = useMemo(() => buildBattleProjection(controller, catalog, locale, entityPresentation), [controller, catalog, locale, entityPresentation]);
  const zones = useMemo(() => buildBattleZoneProjection(controller, catalog, locale), [controller, catalog, locale]);
  const allies = units.filter(unit => unit.ally && unit.kind === 'combatant'); const enemies = units.filter(unit => !unit.ally && unit.kind === 'combatant'); const summons = units.filter(unit => unit.kind === 'summon'); const availableAllies = allies.filter(unit => unit.kind === 'combatant' && (unit.life === 'Alive' || unit.life === 'Recovered'));
  const [selectedId, setSelectedId] = useState<string | null>(() => allies[0]?.id ?? units[0]?.id ?? null); const [commanderId, setCommanderId] = useState<string>(() => availableAllies[0]?.id ?? '');
  const selected = units.find(unit => unit.id === selectedId) ?? units[0] ?? null; const commander = allies.find(unit => unit.id === commanderId) ?? availableAllies[0] ?? allies[0] ?? null;
  const ongoing = controller.outcome.status === 'running'; const controlsEnabled = ongoing && !readOnly;
  const skillContext = useRef<BattleSkillCommandContext>({ controller, catalog, commanderId: commander?.id ?? null, selectedTargetId: selected?.id ?? null, readOnly, onTacticalOrder });
  skillContext.current = { controller, catalog, commanderId: commander?.id ?? null, selectedTargetId: selected?.id ?? null, readOnly, onTacticalOrder };
  const submittedController = useRef<CombatControllerState | null>(null);
  const castSkill = (skillId: string) => { const current = skillContext.current; if (submittedController.current !== current.controller && dispatchBattleSkill(current, skillId)) submittedController.current = current.controller; };
  const equippedSkills = commander ? controller.battle.entities[commander.id]!.skills.flatMap(id => { const skill = catalog.skills.find(item => item.id === id); return skill?.activation === 'active' ? [skill] : []; }) : [];
  const commanderActive = commander !== null && (commander.life === 'Alive' || commander.life === 'Recovered');
  const issuerUnlocked = commanderActive && commander !== null && controller.battle.entities[commander.id]!.recoveryUntilTick <= controller.battle.tick && !controller.battle.statuses.some(status => status.holderId === commander.id && catalog.statuses.some(definition => definition.id === status.definitionId && definition.actionLock === 'untilRemoved')); const guardReady = (controller.guardReadyAt[controller.config.playerTeam] ?? 0) <= controller.battle.tick;
  const actionableTarget = selected !== null && (selected.life === 'Alive' || selected.life === 'Recovered');
  const records = controller.battle.log.flatMap(event => { const text = formatBattleEvent(event, units, catalog, locale); return text === null ? [] : [{ id: event.eventId, text, seconds: battleSeconds(event.tick - controller.startTick) }]; }).slice(-12).reverse();
  const issue = (kind: 'focus' | 'guard' | 'hold') => { if (!commander || !commanderActive || !controlsEnabled || ((kind === 'focus' || kind === 'guard') && !issuerUnlocked)) return; if (kind === 'hold') onTacticalOrder({ kind, actorId: commander.id }); else if (selected) onTacticalOrder({ kind, actorId: commander.id, targetId: selected.id }); };
  return <section className="battle-panel" aria-labelledby={titleId} tabIndex={0} onKeyDown={event => { const action = battlePauseKeyAction(event.code, (event.target as HTMLElement).tagName, event.repeat, controlsEnabled); if (action !== 'ignore') { event.preventDefault(); event.stopPropagation(); if (action === 'toggle') onPausedChange(!paused); } }}>
    <header className="battle-header"><div><span className="battle-eyebrow">{battleText(locale, paused ? 'paused' : 'auto')}</span><h2 id={titleId}>{battleText(locale, 'title')}</h2><p>{battleText(locale, 'subtitle')}</p></div><div className="battle-time-controls"><span className="battle-elapsed">{battleText(locale, 'elapsed', { seconds: battleSeconds(controller.elapsedTicks) })}</span><button type="button" className="battle-pause" disabled={!controlsEnabled} aria-pressed={paused} onClick={() => onPausedChange(!paused)}>{translate(locale, paused ? 'time.resume' : 'time.pause')}</button><div className="battle-speed" role="group" aria-label={battleText(locale, 'auto')}><button type="button" aria-pressed={speed === 1} disabled={!controlsEnabled} onClick={() => onSpeedChange(1)}>{translate(locale, 'time.normal')}</button><button type="button" aria-pressed={speed === 3} disabled={!controlsEnabled} onClick={() => onSpeedChange(3)}>{translate(locale, 'time.fast')}</button></div></div></header>
    {!ongoing && <div className="battle-outcome" data-outcome={controller.outcome.status} role="status"><strong>{battleText(locale, `outcome.${controller.outcome.status}`)}</strong><span>{battleText(locale, 'totals', { damage: controller.battle.statistics.healthLost, healing: controller.battle.statistics.effectiveHealing })}</span>{onContinue && <button type="button" disabled={readOnly} onClick={onContinue}>{battleText(locale, 'continue')}</button>}</div>}
    <div className="battle-main"><div className="battle-playfield"><PhaserBattle controller={controller} catalog={catalog} locale={locale} {...(entityPresentation ? { entityPresentation } : {})} selectedEntityId={selected?.id ?? null} onSelect={setSelectedId} paused={paused} reducedMotion={reducedMotion} /><p className="battle-keyboard-help">{battleText(locale, 'keyboardHelp')}</p></div>
      <aside className="battle-inspector" aria-label={battleText(locale, 'inspect')}>{selected ? <>
        <div className="battle-inspector-heading" data-kind={selected.kind}><UnitPortrait unit={selected} large /><div><span className="battle-eyebrow">{battleText(locale, selected.ally ? 'side.ally' : 'side.enemy')}</span><h3>{selected.name}</h3><span className="battle-life-badge" data-life={selected.life}>{battleText(locale, `life.${selected.life}`)}</span>{selected.kind === 'summon' && <span className="battle-summon-kind">{battleText(locale, 'summon.kind')}</span>}</div></div>
        <dl className="battle-vitals"><div><dt>{battleText(locale, 'health')}</dt><dd>{selected.health} / {selected.maximumHealth}</dd><progress aria-label={battleText(locale, 'health')} value={selected.health} max={selected.maximumHealth} /></div>{selected.kind !== 'summon' && <div><dt>{battleText(locale, 'spirit')}</dt><dd>{selected.spirit} / {selected.maximumSpirit}</dd><progress aria-label={battleText(locale, 'spirit')} value={selected.spirit} max={Math.max(1, selected.maximumSpirit)} /></div>}<div className="battle-shield-total"><dt>{battleText(locale, 'shield')}</dt><dd>{selected.shield}</dd></div></dl>
        {selected.kind === 'summon' ? <div className="battle-summon-details">
          {selected.summon && <><strong>{selected.summon.lifetimeLabel}</strong><progress aria-label={selected.summon.lifetimeLabel} max={10_000} value={selected.summon.remainingBps} /><span>{battleText(locale, 'summon.owner', { name: units.find(unit => unit.id === selected.summon!.casterId)?.name ?? battleText(locale, 'unitFallback', { number: 0 }) })}</span></>}
          <small>{battleText(locale, 'summon.rules')}</small>
        </div> : <div className="battle-casting">{selected.castName ? <><strong>{battleText(locale, 'casting', { skill: selected.castName })}</strong><progress max={10_000} value={selected.castProgressBps} aria-label={battleText(locale, 'casting', { skill: selected.castName })} /><span>{battleText(locale, 'castRemaining', { seconds: battleSeconds(selected.castRemainingTicks) })}</span></> : <strong>{battleText(locale, 'idle')}</strong>}<small>{selected.targetId ? battleText(locale, 'target', { name: units.find(unit => unit.id === selected.targetId)?.name ?? '' }) : battleText(locale, 'untargeted')}</small></div>}
        <div className="battle-status-list"><h4>{battleText(locale, 'statuses')}</h4>{selected.statuses.length === 0 ? <p>{battleText(locale, 'noStatuses')}</p> : <ul>{selected.statuses.map(status => <li key={status.id} data-category={status.category}><strong>{battleText(locale, 'statusStack', { name: status.name, count: status.stacks })}</strong><small>{status.remainingTicks === null ? battleText(locale, 'statusInfinite') : battleText(locale, 'statusDuration', { seconds: battleSeconds(status.remainingTicks) })}</small></li>)}</ul>}</div>
      </> : <p>{battleText(locale, 'selectHint')}</p>}</aside></div>
    {zones.length > 0 && <section className="battle-fields" aria-label={battleText(locale, 'zone.title')}>
      <h3>{battleText(locale, 'zone.title')}</h3><p>{battleText(locale, 'zone.hint')}</p>
      <ol>{zones.map(zone => <li key={zone.id} data-zone-id={zone.id} data-side={zone.ally ? 'ally' : 'enemy'} data-purpose={zone.purpose}>
        <div><strong>{battleText(locale, 'zone.badge', { number: zone.number })} · {zone.name}</strong><span>{battleText(locale, zone.ally ? 'side.ally' : 'side.enemy')} · {battleText(locale, `zone.purpose.${zone.purpose}`)}</span></div>
        <span>{battleText(locale, `zone.targets.${zone.targets}`)} · {zone.lifetimeLabel}</span>
        <small>{battleText(locale, 'zone.owner', { name: units.find(unit => unit.id === zone.casterId)?.name ?? battleText(locale, 'unitFallback', { number: 0 }) })}</small>
        <small>{battleText(locale, 'zone.fixed', { x: zone.anchor.x, y: zone.anchor.y, radius: zone.radiusUnits, cells: zone.cellCount })}</small>
      </li>)}</ol>
    </section>}
    <div className="battle-rosters"><Roster title={battleText(locale, 'allies')} units={allies} selected={selected?.id ?? null} onSelect={setSelectedId} locale={locale} /><Roster title={battleText(locale, 'enemies')} units={enemies} selected={selected?.id ?? null} onSelect={setSelectedId} locale={locale} /></div>
    {summons.length > 0 && <div className="battle-summons"><Roster title={battleText(locale, 'summon.title')} units={summons} selected={selected?.id ?? null} onSelect={setSelectedId} locale={locale} /></div>}
    <div className="battle-command-strip"><div className="battle-commander"><label htmlFor={commandId}>{battleText(locale, 'commander')}</label><select id={commandId} value={commander?.id ?? ''} onChange={event => setCommanderId(event.target.value)} disabled={!controlsEnabled || !commander}>{allies.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></div><div className="battle-tactics"><button type="button" disabled={!controlsEnabled || !commander || !issuerUnlocked || !actionableTarget || selected!.ally} onClick={() => issue('focus')}>{battleText(locale, 'focus')}</button><button type="button" disabled={!controlsEnabled || !commander || !issuerUnlocked || !actionableTarget || !selected!.ally || selected!.id === commander.id || !guardReady} onClick={() => issue('guard')}>{battleText(locale, 'guard')}</button><button type="button" disabled={!controlsEnabled || !commanderActive} onClick={() => issue('hold')}>{battleText(locale, 'hold')}</button><button type="button" className="battle-secondary" disabled={!controlsEnabled || !commanderActive || !controller.battle.focusByTeam[controller.config.playerTeam]} onClick={() => commander && commanderActive && controlsEnabled && onTacticalOrder({ kind: 'clearFocus', actorId: commander.id })}>{battleText(locale, 'clearFocus')}</button></div>
      <div className="battle-retreat">{retreatStatus === 'pending' ? <span role="status">{battleText(locale, 'retreatPending', { seconds: battleSeconds(retreatRemainingTicks) })}</span> : <button type="button" className="battle-retreat-button" disabled={!controlsEnabled || retreatStatus !== 'available' || !onRetreat} title={retreatStatus === 'unavailable' ? battleText(locale, 'retreatUnavailable') : undefined} onClick={onRetreat}>{battleText(locale, 'retreat')}</button>}</div>
    </div><p className="battle-command-hint">{battleText(locale, 'commandHint')}</p>
    <section className="battle-skills" aria-label={battleText(locale, 'skill.title')}>
      <div className="battle-skills-heading"><h3>{battleText(locale, 'skill.title')}</h3><p>{battleText(locale, paused ? 'skill.paused' : 'skill.hint')}</p></div>
      {!commander ? <p>{battleText(locale, 'skill.noCommander')}</p> : equippedSkills.length === 0 ? <p>{battleText(locale, 'skill.empty')}</p> : <div className="battle-skill-list">{equippedSkills.map(skill => {
        const targetId = skill.action.targetTeam === 'self' ? commander.id : selected?.id ?? null;
        const readiness = queryCastReadiness(controller.battle, catalog, commander.id, skill.id, targetId);
        const reason = readOnly ? battleText(locale, 'skill.readOnly') : !ongoing ? battleText(locale, 'skill.ended') : skillReadinessText(readiness, locale);
        const target = units.find(unit => unit.id === targetId); const ready = controlsEnabled && readiness.ready;
        return <div className="battle-skill" data-ready={ready} data-ultimate={skill.ultimate} key={skill.id}>
          <button type="button" className="battle-skill-button" data-skill-id={skill.id} disabled={!ready} onClick={() => castSkill(skill.id)} title={reason}>
            <span>{battleDefinitionName(locale, skill.id, catalog)}</span>{skill.ultimate && <small>{battleText(locale, 'skill.ultimate')}</small>}<span className="battle-skill-verb">{battleText(locale, 'skill.cast')}</span>
          </button>
          <small>{battleText(locale, 'skill.summary', { cost: readiness.spiritCostUnits, range: readiness.rangeUnits / controller.config.arena.cellSizeUnits, seconds: battleSeconds(readiness.castTicks) })}</small>
          <span>{battleText(locale, skill.action.targetTeam === 'self' ? 'skill.targetSelf' : skill.action.targetTeam === 'ally' ? 'skill.targetAlly' : 'skill.targetEnemy')}{target && <> · {battleText(locale, 'skill.target', { name: target.name })}</>}</span>
          <span className="battle-skill-readiness">{reason}</span>
        </div>;
      })}</div>}
    </section>
    <details className="battle-log"><summary>{battleText(locale, 'log')}</summary>{records.length ? <ol>{records.map(record => <li key={record.id}><time>{record.seconds.toFixed(2)}s</time><span>{record.text}</span></li>)}</ol> : <p>{battleText(locale, 'logEmpty')}</p>}</details>
  </section>;
}
