import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { combatCatalog } from '../../src/content/definitions';
import type { CombatContentCatalog, EffectPrimitive } from '../../src/core/combat/definitions';
import { cleanupBattleScope, createBattle, issueCommand, prepareCombatCatalog, restoreBattle, serializeBattle, stepBattle } from '../../src/core/combat';
import type { BattleState } from '../../src/core/combat';
import { createCombatController } from '../../src/core/combat/ai';
import { BattlePanel, formatBattleEvent } from '../../src/app/BattlePanel';
import { battleZoneFootprint, buildBattleProjection, buildBattleZoneProjection } from '../../src/phaser/PhaserBattle';

const arena = { origin: { x: 100, y: -40 }, widthCells: 7, heightCells: 7, cellSizeUnits: 20, blockedCells: [{ x: 3, y: 2 }] };
const tune = (effect: EffectPrimitive): EffectPrimitive => effect.kind === 'zone' ? { ...effect, radiusUnits: 40, intervalTicks: 2, duration: { kind: 'ticks', ticks: 8 }, effects: effect.effects.map(nested => ({ ...nested, target: nested.target.kind === 'area' ? { ...nested.target, radiusUnits: 40 } : nested.target })) } : effect.kind === 'summon' ? { ...effect, duration: { kind: 'ticks', ticks: 10 } } : effect;
const data: CombatContentCatalog = { ...combatCatalog, skills: combatCatalog.skills.map(skill => skill.activation === 'active' && ['skill.wanjian-chaozong', 'skill.yaowang-ding', 'skill.zhikui'].includes(skill.id) ? { ...skill, action: { ...skill.action, spiritCostUnits: 0, castTicks: 0, cooldownTicks: 0, effects: skill.action.effects.map(tune) } } : skill) };
const catalog = prepareCombatCatalog(data);
const make = (enemyAttack = 10) => createBattle(catalog, { seed: 'advanced-presentation', arena, contentMode: 'experimental', entities: [
  { id: 'entity:1', team: 'party', position: { x: 100, y: -40 }, stats: { attack: 10, maxHealth: 1000 }, skills: ['skill.wanjian-chaozong', 'skill.zhikui'] },
  { id: 'entity:2', team: 'enemy', position: { x: 140, y: 0 }, stats: { attack: enemyAttack, maxHealth: 1000 }, skills: ['skill.yaowang-ding'] },
  { id: 'entity:3', team: 'party', position: { x: 100, y: 20 }, stats: { attack: 10, maxHealth: 1000 } },
] });
function effects(enemyAttack = 10): BattleState {
  let battle = issueCommand(make(enemyAttack), catalog, { kind: 'cast', actorId: 'entity:1', skillId: 'skill.zhikui', targetId: 'entity:1' });
  battle = issueCommand(battle, catalog, { kind: 'cast', actorId: 'entity:1', skillId: 'skill.wanjian-chaozong', targetId: 'entity:2' });
  return issueCommand(battle, catalog, { kind: 'cast', actorId: 'entity:2', skillId: 'skill.yaowang-ding', targetId: 'entity:2' });
}
const control = (battle: BattleState) => createCombatController(catalog, battle, { playerTeam: 'party', arena });
const noop = () => undefined;
const markup = (battle: BattleState, locale: 'zh-CN' | 'en' = 'zh-CN') => renderToStaticMarkup(<BattlePanel controller={control(battle)} catalog={catalog} locale={locale} readOnly paused speed={3} onPausedChange={noop} onSpeedChange={noop} onTacticalOrder={noop} />);
const cells = (spans: ReturnType<typeof battleZoneFootprint>) => spans.flatMap(span => Array.from({ length: span.length }, (_, index) => `${span.x + index},${span.y}`));

describe('advanced battle read-only projection', () => {
  it('projects authoritative zone allegiance, purpose, source, lifetime and fixed anchor', () => {
    const battle = effects(); const before = serializeBattle(battle); const controller = control(battle);
    const zones = buildBattleZoneProjection(controller, catalog, 'zh-CN');
    expect(zones).toHaveLength(2);
    expect(zones[0]).toMatchObject({ ally: true, name: '万剑朝宗', purpose: 'damage', targets: 'enemy', anchor: { x: 140, y: 0 }, radiusUnits: 40, remainingTicks: 8, remainingBps: 10_000, cellCount: 12 });
    expect(zones[1]).toMatchObject({ ally: false, name: '药王鼎', purpose: 'heal', targets: 'ally', anchor: { x: 140, y: 0 } });
    expect(zones[0]!.lifetimeLabel).toContain('0.4');
    expect(serializeBattle(battle)).toBe(before);
  });
  it('shows Euclidean cell-center coverage, clips edges and excludes blockers without fake occlusion', () => {
    const footprint = cells(battleZoneFootprint(arena, { x: 140, y: 0 }, 40));
    expect(footprint).toHaveLength(12); expect(footprint).toContain('4,2'); expect(footprint).not.toContain('3,2'); expect(footprint).not.toContain('4,4');
    expect(footprint).toContain('3,3'); // sqrt(20² + 20²) is inside radius 40, although Manhattan layouts differ.
    expect(cells(battleZoneFootprint(arena, arena.origin, 0))).toEqual(['0,0']);
    expect(cells(battleZoneFootprint(arena, arena.origin, 20))).toEqual(['0,0', '1,0', '0,1']);
    const huge = battleZoneFootprint(arena, arena.origin, 1_000_000);
    expect(huge.length).toBeLessThanOrEqual(arena.heightCells + arena.blockedCells.length);
    expect(cells(huge)).toHaveLength(arena.widthCells * arena.heightCells - arena.blockedCells.length);
  });
  it('does not move fields with their old intent, and reload reproduces the exact read-only projection', () => {
    const battle = effects();
    const moved = stepBattle(battle, catalog, 1, { movement: { arena, intents: [{ actorId: 'entity:2', to: { x: 140, y: 20 } }] } });
    expect(moved.entities['entity:2']!.position).toEqual({ x: 140, y: 20 });
    const projected = buildBattleZoneProjection(control(moved), catalog, 'en');
    expect(projected[0]!.anchor).toEqual({ x: 140, y: 0 }); expect(projected[0]!.remainingTicks).toBe(7);
    const restored = restoreBattle(serializeBattle(moved), catalog);
    expect(buildBattleZoneProjection(control(restored), catalog, 'en')).toEqual(projected);
    expect(buildBattleProjection(control(restored), catalog, 'en')).toEqual(buildBattleProjection(control(moved), catalog, 'en'));
  });
  it('uses disposable paper identity and real HP even when campaign presentation wrongly supplies disciple art', () => {
    const battle = effects(); const summon = battle.summons[0]!;
    const units = buildBattleProjection(control(battle), catalog, 'zh-CN', { [summon.entityId]: { name: '不得借用的弟子', art: 'disciple-3' } });
    const paper = units.find(unit => unit.id === summon.entityId)!;
    expect(paper).toMatchObject({ kind: 'summon', art: 'paper-decoy', name: '纸傀替身', health: 250, maximumHealth: 250, summon: { casterId: 'entity:1', remainingTicks: 10, durationTicks: 10, remainingBps: 10_000 } });
    expect(units.find(unit => unit.id === 'entity:3')!.art).toBe('disciple-1');
    expect(units.find(unit => unit.id === 'entity:3')!.name).toContain('2');
    expect(buildBattleProjection(control(stepBattle(battle, catalog, 2)), catalog, 'en').find(unit => unit.kind === 'summon')!.summon).toMatchObject({ remainingTicks: 8, remainingBps: 8000 });
  });
  it('drops expired, replaced, destroyed and cleaned entities/fields only when authoritative state removes them', () => {
    const initial = effects(); const originalId = initial.summons[0]!.entityId;
    const replaced = issueCommand(initial, catalog, { kind: 'cast', actorId: 'entity:1', skillId: 'skill.zhikui', targetId: 'entity:1' });
    expect(buildBattleProjection(control(replaced), catalog, 'en').some(unit => unit.id === originalId)).toBe(false);
    expect(buildBattleProjection(control(replaced), catalog, 'en').filter(unit => unit.kind === 'summon')).toHaveLength(1);
    const vulnerable = effects(1000); const destroyed = issueCommand(vulnerable, catalog, { kind: 'basic', actorId: 'entity:2', targetId: vulnerable.summons[0]!.entityId });
    expect(buildBattleProjection(control(destroyed), catalog, 'en').some(unit => unit.kind === 'summon')).toBe(false);
    expect(destroyed.log.some(event => event.kind === 'life.died' && event.targetId === vulnerable.summons[0]!.entityId)).toBe(false);
    const hit = destroyed.log.find(event => event.kind === 'damage.healthLost' && event.targetId === vulnerable.summons[0]!.entityId)!;
    expect(formatBattleEvent(hit, buildBattleProjection(control(destroyed), catalog, 'en'), catalog, 'en')).toContain('Temporary summon');
    const expiredZones = stepBattle(initial, catalog, 8);
    expect(buildBattleZoneProjection(control(expiredZones), catalog, 'en')).toEqual([]);
    expect(buildBattleProjection(control(expiredZones), catalog, 'en').find(unit => unit.kind === 'summon')!.summon!.remainingTicks).toBe(2);
    const expiredSummon = stepBattle(expiredZones, catalog, 2);
    expect(buildBattleProjection(control(expiredSummon), catalog, 'en').some(unit => unit.kind === 'summon')).toBe(false);
    const cleaned = cleanupBattleScope(initial, catalog, 'encounter');
    expect(buildBattleZoneProjection(control(cleaned), catalog, 'en')).toEqual([]);
    expect(buildBattleProjection(control(cleaned), catalog, 'en').some(unit => unit.kind === 'summon')).toBe(false);
  });
});

describe('advanced battle DOM and rendering contract', () => {
  it('shows localized fields and paper summon HP/expiry with no summon command option or portrait', () => {
    const battle = effects(); const before = serializeBattle(battle); const html = markup(battle);
    expect(html).toContain('场上区域'); expect(html).toContain('万剑朝宗'); expect(html).toContain('药王鼎'); expect(html).toContain('持续伤害'); expect(html).toContain('持续治疗');
    expect(html).toContain('data-purpose="damage"'); expect(html).toContain('data-purpose="heal"'); expect(html).toContain('半径 40'); expect(html).toContain('12');
    const roster = html.match(/<button[^>]*data-kind="summon"[^>]*>[\s\S]*?<\/button>/)![0];
    expect(roster).toContain('纸傀替身'); expect(roster).toContain('250 / 250'); expect(roster).toContain('0.5'); expect(roster).toContain('data-art="paper-decoy"'); expect(roster).not.toContain('<img'); expect(roster).toContain('我方');
    expect(html).toContain('class="battle-summons"'); const primaryRosters = html.match(/<div class="battle-rosters">[\s\S]*?(?=<div class="battle-summons">)/)![0]; expect(primaryRosters).not.toContain('data-kind="summon"');
    const commander = html.match(/<select[\s\S]*?<\/select>/)![0];
    expect(commander).toContain('disabled'); expect(commander).not.toContain('summon:'); expect(commander).not.toContain('纸傀替身');
    expect(html).toMatch(/class="battle-pause"[^>]*disabled/); expect(serializeBattle(battle)).toBe(before);
    const english = markup(battle, 'en'); expect(english).toContain('Active fields'); expect(english).toContain('Paper Substitute'); expect(english).toContain('Periodic healing');
  });
  it('removes stale DOM field and summon entries on expiry without replaying them from logs', () => {
    const battle = stepBattle(effects(), catalog, 10); const html = markup(battle);
    expect(battle.log.some(event => event.kind === 'summon.created')).toBe(true);
    expect(html).not.toContain('data-zone-id='); expect(html).not.toContain('data-kind="summon"');
  });
  it('keeps code-drawn summons off asset loads and never advances battle state or wall-clock lifetimes', () => {
    const renderer = readFileSync('src/phaser/create-battle-game.ts', 'utf8');
    expect(renderer).not.toMatch(/\b(?:stepBattle|stepCombatController|issueCommand|drawInteger|setTimeout|setInterval|Date\.now)\s*\(/);
    expect(renderer).toContain('PAPER_DECOY_OUTLINE'); expect(renderer).toContain("unit.art === 'paper-decoy' ? null");
    expect(renderer).toContain('this.zoneLabels.delete(id)'); expect(renderer).toContain('this.units.delete(id)');
    expect(renderer).toContain('this.snapshot.tick > this.lastTick'); expect(renderer).toContain('this.snapshot.reducedMotion');
  });
});
