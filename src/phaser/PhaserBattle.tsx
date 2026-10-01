import { useEffect, useMemo, useRef, useState } from 'react';
import { COMBAT_TICKS_PER_SECOND } from '../core/combat/definitions';
import type { CombatContentCatalog, EffectPrimitive } from '../core/combat/definitions';
import type { CombatControllerState } from '../core/combat/ai';
import { queryStat, shieldUnits } from '../core/combat';
import type { BattleArena, BattleEvent, LifeState } from '../core/combat';
import { combatMessageSpecifications } from '../content/definitions/messages';
import { combatZhCN } from '../content/locales/zh-CN/combat';
import { combatEn } from '../content/locales/en/combat';
import { createTranslator, translate, type Locale, type TextKey, type TranslationParams } from '../i18n';
import type { BattleRenderer } from './create-battle-game';
import { PIXEL_ART_VERSION } from './art-manifest';

export type BattleArt = 'disciple-0' | 'disciple-1' | 'disciple-2' | 'disciple-3' | 'moss-boar' | 'ruin-guardian' | 'ember-wisp' | 'ridge-raider' | 'venom-adept';
export type BattleUnitArt = BattleArt | 'paper-decoy';
/** Original code-drawn folded paper silhouette, shared by Canvas and DOM; not disciple art. */
export const PAPER_DECOY_OUTLINE: readonly (readonly [number, number])[] = [[38, 12], [58, 12], [62, 28], [56, 32], [56, 36], [76, 43], [82, 58], [70, 63], [60, 51], [59, 67], [67, 83], [53, 86], [48, 72], [43, 86], [29, 83], [37, 67], [36, 51], [26, 63], [14, 58], [20, 43], [40, 36], [40, 32], [34, 28]];
export interface BattleEntityPresentation { readonly name: string; readonly art?: BattleArt }
export type BattleEntityPresentations = Readonly<Record<string, BattleEntityPresentation>>;
export interface BattleStatusView { readonly id: string; readonly name: string; readonly stacks: number; readonly remainingTicks: number | null; readonly category: string }
export interface BattleUnitView {
  readonly id: string; readonly kind: 'combatant' | 'summon'; readonly ally: boolean; readonly name: string; readonly art: BattleUnitArt;
  readonly summon: { readonly casterId: string; readonly remainingTicks: number; readonly durationTicks: number; readonly remainingBps: number; readonly lifetimeLabel: string } | null;
  readonly x: number; readonly y: number; readonly health: number; readonly maximumHealth: number;
  readonly spirit: number; readonly maximumSpirit: number; readonly shield: number; readonly life: LifeState;
  readonly castName: string | null; readonly castProgressBps: number; readonly castRemainingTicks: number;
  readonly targetId: string | null; readonly statuses: readonly BattleStatusView[];
}
export interface BattleZoneSpan { readonly x: number; readonly y: number; readonly length: number }
export interface BattleZoneView {
  readonly id: string; readonly number: number; readonly casterId: string; readonly ally: boolean; readonly name: string;
  readonly anchor: { readonly x: number; readonly y: number }; readonly radiusUnits: number;
  readonly purpose: 'damage' | 'heal' | 'mixed' | 'support'; readonly targets: 'ally' | 'enemy' | 'mixed' | 'specific';
  readonly remainingTicks: number | null; readonly remainingBps: number; readonly lifetimeLabel: string;
  readonly spans: readonly BattleZoneSpan[]; readonly cellCount: number; readonly canvasLabel: string;
}
export interface BattleRenderSnapshot {
  readonly tick: number; readonly arena: BattleArena; readonly units: readonly BattleUnitView[];
  readonly zones: readonly BattleZoneView[]; readonly events: readonly BattleEvent[]; readonly latestEventSequence: number; readonly selectedEntityId: string | null;
  readonly paused: boolean; readonly reducedMotion: boolean;
}
const combatTranslate = createTranslator({ baseCatalog: combatZhCN, englishCatalog: combatEn, specifications: combatMessageSpecifications });
export const battleText = (locale: Locale, suffix: string, parameters: TranslationParams = {}): string => translate(locale, `battleView.${suffix}` as TextKey, parameters);
export function battleDefinitionName(locale: Locale, id: string, catalog: CombatContentCatalog): string {
  if (id === 'runtime.basic') return battleText(locale, 'basic');
  const definition = [...catalog.skills, ...catalog.statuses, ...catalog.summons, ...catalog.talents, ...catalog.treeNodes].find(item => item.id === id);
  return definition ? combatTranslate(locale, definition.nameKey) : battleText(locale, 'basic');
}
export function battleAssetUrl(art: BattleArt, sheet = false): string { const group = art.startsWith('disciple-') ? 'characters' : 'enemies'; return `${import.meta.env.BASE_URL}assets/${group}/${art}${sheet ? '-sheet' : ''}-${PIXEL_ART_VERSION}.png`; }
const ENEMY_ART: readonly BattleArt[] = ['moss-boar', 'ruin-guardian', 'ember-wisp'];
export function buildBattleProjection(controller: CombatControllerState, catalog: CombatContentCatalog, locale: Locale, presentation: BattleEntityPresentations = {}): readonly BattleUnitView[] {
  const battle = controller.battle; let allyIndex = 0; let enemyIndex = 0;
  return Object.values(battle.entities).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(entity => {
    const ally = entity.team === controller.config.playerTeam;
    // Disposable summons must not consume a disciple slot or inherit campaign presentation.
    const summon = entity.kind === 'summon' ? battle.summons.find(item => item.entityId === entity.id) : null;
    const index = entity.kind === 'summon' ? 0 : ally ? allyIndex++ : enemyIndex++;
    const art: BattleUnitArt = entity.kind === 'summon' ? 'paper-decoy' : presentation[entity.id]?.art ?? (ally ? `disciple-${index % 4}` as BattleArt : ENEMY_ART[index % ENEMY_ART.length]!);
    const summonDefinition = summon ? catalog.summons.find(item => item.id === summon.definitionId) : null;
    const name = entity.kind === 'summon' ? (summonDefinition ? combatTranslate(locale, summonDefinition.nameKey) : battleText(locale, 'summon.fallback')) : presentation[entity.id]?.name ?? (ally ? battleText(locale, 'unitFallback', { number: index + 1 }) : battleText(locale, `enemy.${art.startsWith('disciple-') ? 'moss-boar' : art}`));
    const action = entity.currentActionId ? battle.actions[entity.currentActionId] : null;
    const casting = action?.state === 'Casting';
    return { id: entity.id, kind: entity.kind, ally, name, art, summon: summon ? { casterId: summon.casterId, remainingTicks: Math.max(0, summon.expiresAtTick - battle.tick), durationTicks: summon.expiresAtTick - summon.createdTick, lifetimeLabel: battleText(locale, 'summon.remaining', { seconds: Math.max(0, summon.expiresAtTick - battle.tick) / COMBAT_TICKS_PER_SECOND }), remainingBps: Math.max(0, Math.min(10_000, Math.floor((summon.expiresAtTick - battle.tick) * 10_000 / Math.max(1, summon.expiresAtTick - summon.createdTick)))) } : null, x: entity.position.x, y: entity.position.y, health: entity.health, maximumHealth: queryStat(battle, catalog, entity.id, 'maxHealth'), spirit: entity.spirit, maximumSpirit: entity.maximumSpirit, shield: shieldUnits(battle, entity.id), life: entity.life,
      castName: casting ? battleDefinitionName(locale, action.skillId, catalog) : null, castProgressBps: casting ? Math.min(10_000, Math.max(0, Math.floor((battle.tick - action.requestTick) * 10_000 / Math.max(1, action.castEndTick - action.requestTick)))) : 0, castRemainingTicks: casting ? Math.max(0, action.castEndTick - battle.tick) : 0, targetId: casting ? action.targetId : null,
      statuses: battle.statuses.filter(status => status.holderId === entity.id).map(status => ({ id: status.statusInstanceId, name: battleDefinitionName(locale, status.definitionId, catalog), stacks: status.stacks, remainingTicks: status.expiresAtTick === null ? null : Math.max(0, status.expiresAtTick - battle.tick), category: catalog.statuses.find(definition => definition.id === status.definitionId)?.dispelCategory ?? 'buff' })),
    };
  });
}
/** Geometry only: sample the arena's legal standing cells against the real fixed radius.
 * Row spans bound draw commands without inventing line of sight or effect recipients. */
export function battleZoneFootprint(arena: BattleArena, anchor: { readonly x: number; readonly y: number }, radiusUnits: number): readonly BattleZoneSpan[] {
  const blocked = new Set(arena.blockedCells.map(cell => `${cell.x},${cell.y}`)); const spans: BattleZoneSpan[] = [];
  for (let y = 0; y < arena.heightCells; y++) {
    let start = -1;
    for (let x = 0; x <= arena.widthCells; x++) {
      const dx = arena.origin.x + x * arena.cellSizeUnits - anchor.x, dy = arena.origin.y + y * arena.cellSizeUnits - anchor.y;
      const covered = x < arena.widthCells && !blocked.has(`${x},${y}`) && dx * dx + dy * dy <= radiusUnits * radiusUnits;
      if (covered && start < 0) start = x;
      if (!covered && start >= 0) { spans.push({ x: start, y, length: x - start }); start = -1; }
    }
  }
  return spans;
}
function zonePurposes(effects: readonly EffectPrimitive[]): Set<'damage' | 'heal' | 'support'> {
  return new Set(effects.flatMap(effect => effect.kind === 'zone' ? [...zonePurposes(effect.effects)] : effect.kind === 'damage' || effect.kind === 'releaseForce' ? ['damage' as const] : effect.kind === 'heal' ? ['heal' as const] : ['support' as const]));
}
export function buildBattleZoneProjection(controller: CombatControllerState, catalog: CombatContentCatalog, locale: Locale): readonly BattleZoneView[] {
  const battle = controller.battle; const arena = battle.arena ?? controller.config.arena;
  return battle.zones.map((zone, index) => {
    const purposes = zonePurposes(zone.effect.effects); const purpose = purposes.size === 1 ? [...purposes][0]! : 'mixed';
    const targetTeams = new Set(zone.effect.effects.map(effect => 'team' in effect.target ? effect.target.team : 'specific'));
    const targets = targetTeams.size === 1 ? [...targetTeams][0]! : targetTeams.has('specific') ? 'specific' : 'mixed';
    const remainingTicks = zone.expiresAtTick === null ? null : Math.max(0, zone.expiresAtTick - battle.tick);
    const lifetimeLabel = remainingTicks === null ? battleText(locale, 'statusInfinite') : battleText(locale, 'statusDuration', { seconds: remainingTicks / COMBAT_TICKS_PER_SECOND });
    const spans = battleZoneFootprint(arena, zone.anchor, zone.radiusUnits);
    return { id: zone.zoneInstanceId, number: index + 1, casterId: zone.casterId, ally: battle.entities[zone.casterId]?.team === controller.config.playerTeam,
      name: battleDefinitionName(locale, battle.sources[zone.sourceInstanceId]?.sourceDefinitionId ?? '', catalog), anchor: { ...zone.anchor }, radiusUnits: zone.radiusUnits,
      purpose, targets, remainingTicks, remainingBps: remainingTicks === null ? 10_000 : Math.min(10_000, Math.floor(remainingTicks * 10_000 / Math.max(1, zone.expiresAtTick! - zone.createdTick))),
      lifetimeLabel, spans, cellCount: spans.reduce((count, span) => count + span.length, 0), canvasLabel: `${battleText(locale, 'zone.badge', { number: index + 1 })} · ${lifetimeLabel}`,
    };
  });
}
export const BATTLE_EFFECT_LIMIT = 32;
export const BATTLE_EFFECT_TICKS = 10;
const VISUAL_EVENT_KINDS = new Set(['action.committed', 'damage.healthLost', 'shield.absorbed', 'shield.broken', 'healing.resolved', 'life.downed', 'life.died']);
/** Only new actual events are visualized; lost/truncated history is never synthesized. */
export function collectBattleEffects(events: readonly BattleEvent[], afterSequence: number, tick: number): readonly BattleEvent[] { return events.filter(event => event.sequence > afterSequence && event.tick <= tick && event.tick + BATTLE_EFFECT_TICKS > tick && VISUAL_EVENT_KINDS.has(event.kind)).slice(-BATTLE_EFFECT_LIMIT); }
export function battlefieldLayout(arena: BattleArena): { readonly cell: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number } { const cell = Math.min(76, 840 / arena.widthCells, 438 / arena.heightCells); const width = cell * arena.widthCells; const height = cell * arena.heightCells; return { cell, x: (1000 - width) / 2, y: 128 + (438 - height) / 2, width, height }; }
export function battlefieldPoint(arena: BattleArena, x: number, y: number): { x: number; y: number } { const layout = battlefieldLayout(arena); return { x: layout.x + ((x - arena.origin.x) / arena.cellSizeUnits + 0.5) * layout.cell, y: layout.y + ((y - arena.origin.y) / arena.cellSizeUnits + 0.5) * layout.cell }; }
export interface PhaserBattleProps {
  readonly controller: CombatControllerState; readonly catalog: CombatContentCatalog; readonly locale: Locale;
  readonly entityPresentation?: BattleEntityPresentations; readonly selectedEntityId: string | null;
  readonly onSelect: (entityId: string) => void; readonly paused: boolean; readonly reducedMotion?: boolean;
}
export function PhaserBattle({ controller, catalog, locale, entityPresentation, selectedEntityId, onSelect, paused, reducedMotion = false }: PhaserBattleProps) {
  const element = useRef<HTMLDivElement>(null); const renderer = useRef<BattleRenderer | null>(null); const select = useRef(onSelect); select.current = onSelect;
  const [failed, setFailed] = useState(false); const [zoom, setZoom] = useState(1);
  const units = useMemo(() => buildBattleProjection(controller, catalog, locale, entityPresentation), [controller, catalog, locale, entityPresentation]);
  const zones = useMemo(() => buildBattleZoneProjection(controller, catalog, locale), [controller, catalog, locale]);
  const snapshot: BattleRenderSnapshot = useMemo(() => ({ tick: controller.battle.tick, arena: controller.battle.arena ?? controller.config.arena, units, zones, events: controller.battle.log, latestEventSequence: controller.battle.sequences.nextEvent - 1, selectedEntityId, paused, reducedMotion }), [controller, units, zones, selectedEntityId, paused, reducedMotion]);
  const current = useRef(snapshot); current.current = snapshot;
  useEffect(() => { let disposed = false; void import('./create-battle-game').then(({ mountBattleGame }) => { if (!disposed && element.current) renderer.current = mountBattleGame(element.current, current.current, id => select.current(id)); }).catch(() => { if (!disposed) setFailed(true); }); return () => { disposed = true; renderer.current?.destroy(); renderer.current = null; }; }, []);
  useEffect(() => { renderer.current?.update(snapshot); }, [snapshot]);
  const changeZoom = (value: number) => { const next = Math.max(0.8, Math.min(2, value)); setZoom(next); renderer.current?.setZoom(next); };
  return <div className="battle-stage">
    <div ref={element} className="battle-canvas" role="img" aria-label={battleText(locale, 'canvasLabel')}>{failed && <p className="battle-render-error" role="alert">{battleText(locale, 'renderError')}</p>}</div>
    <div className="battle-camera-controls">
      <button type="button" aria-label={battleText(locale, 'zoomOut')} disabled={zoom <= 0.8} onClick={() => changeZoom(zoom - 0.2)}>−</button>
      <button type="button" aria-label={battleText(locale, 'resetView')} onClick={() => { setZoom(1); renderer.current?.resetView(); }}>⌂</button>
      <button type="button" aria-label={battleText(locale, 'zoomIn')} disabled={zoom >= 2} onClick={() => changeZoom(zoom + 0.2)}>+</button>
    </div>
  </div>;
}
