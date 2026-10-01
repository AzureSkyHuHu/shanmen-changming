import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { combatCatalog } from '../../src/content/definitions';
import { createBattle, issueCommand, prepareCombatCatalog, serializeBattle, stepBattle } from '../../src/core/combat';
import type { BattleEvent } from '../../src/core/combat';
import { createCombatController } from '../../src/core/combat/ai';
import { BattlePanel, battlePauseKeyAction, battleSeconds } from '../../src/app/BattlePanel';
import { battleAssetUrl, battleDefinitionName, battlefieldLayout, battlefieldPoint, BATTLE_EFFECT_LIMIT, buildBattleProjection, collectBattleEffects } from '../../src/phaser/PhaserBattle';
import { CHARACTER_ART, CHARACTER_FRAME, PIXEL_ART_VERSION } from '../../src/phaser/art-manifest';
const catalog = prepareCombatCatalog(combatCatalog);
const arena = { origin: { x: 0, y: 0 }, widthCells: 12, heightCells: 5, cellSizeUnits: 20, blockedCells: [] };
const make = () => createBattle(catalog, { seed: 'battle-presentation', contentMode: 'experimental', entities: [
  { id: 'entity:1', team: 'party', position: { x: 0, y: 0 }, stats: { attack: 100, maxHealth: 1000 }, skills: ['skill.baoyue', 'skill.liuhen-jian'] },
  { id: 'entity:2', team: 'enemy', position: { x: 80, y: 0 }, stats: { attack: 100, maxHealth: 1000 } },
] });
const control = (battle = make()) => createCombatController(catalog, battle, { playerTeam: 'party', arena });
const noop = () => undefined;

describe('readonly battle presentation projection', () => {
  it('projects real health, spirit and pending windup without mutating or advancing the controller', () => {
    const reserved = issueCommand(make(), catalog, { kind: 'cast', actorId: 'entity:1', skillId: 'skill.baoyue', targetId: 'entity:1' });
    const midCast = stepBattle(reserved, catalog, 4); const controller = control(midCast); const before = serializeBattle(controller.battle);
    const units = buildBattleProjection(controller, catalog, 'zh-CN', { 'entity:1': { name: '林清', art: 'disciple-1' } });
    expect(units[0]).toMatchObject({ name: '林清', health: 1000, spirit: 100, shield: 0, castName: '抱岳', castProgressBps: 4000, castRemainingTicks: 6 });
    expect(serializeBattle(controller.battle)).toBe(before); expect(controller.battle.tick).toBe(4);
  });
  it('shows real shield amounts only after commitment and uses authored names in both locales', () => {
    const done = stepBattle(issueCommand(make(), catalog, { kind: 'cast', actorId: 'entity:1', skillId: 'skill.baoyue', targetId: 'entity:1' }), catalog, 10);
    const units = buildBattleProjection(control(done), catalog, 'zh-CN');
    expect(units[0]).toMatchObject({ shield: 220, spirit: 86, castName: null });
    expect(battleDefinitionName('zh-CN', 'skill.liuhen-jian', catalog)).toBe('留痕剑');
    expect(battleDefinitionName('en', 'skill.liuhen-jian', catalog)).toBe('Traceblade');
  });
  it('converts authoritative ticks to seconds without a wall clock', () => { expect(battleSeconds(20)).toBe(1); expect(battleSeconds(24)).toBe(1.2); expect(battleSeconds(-2)).toBe(0); });
  it('maps only authoritative positions to stable battlefield points', () => {
    const layout = battlefieldLayout(arena); const first = battlefieldPoint(arena, 0, 0); const second = battlefieldPoint(arena, 20, 0);
    expect(second.x - first.x).toBe(layout.cell); expect(second.y).toBe(first.y); expect(first.x).toBe(layout.x + layout.cell / 2);
  });
  it('bounds effects, ignores historical replay and expires them strictly on simulation ticks', () => {
    const hit = issueCommand(make(), catalog, { kind: 'basic', actorId: 'entity:1', targetId: 'entity:2' }); const event = hit.log.find(event => event.kind === 'damage.healthLost')!;
    const events: BattleEvent[] = Array.from({ length: 100 }, (_, index) => ({ ...event, eventId: `event:${index + 1}`, sequence: index + 1 }));
    expect(collectBattleEffects(events, 0, hit.tick)).toHaveLength(BATTLE_EFFECT_LIMIT);
    expect(collectBattleEffects(events, 100, hit.tick)).toEqual([]);
    expect(collectBattleEffects(events, 0, event.tick + 10)).toEqual([]);
    expect(collectBattleEffects(events, 0, event.tick + 9)).toHaveLength(BATTLE_EFFECT_LIMIT);
  });
});

describe('accessible HUD and original sprite assets', () => {
  it('renders a real readonly controller as keyboard-accessible rosters and legitimate tactics', () => {
    const controller = control(); const before = serializeBattle(controller.battle);
    const markup = renderToStaticMarkup(<BattlePanel controller={controller} catalog={catalog} locale="zh-CN" paused={false} speed={1} onPausedChange={noop} onSpeedChange={noop} onTacticalOrder={noop} retreatStatus="pending" retreatRemainingTicks={30} />);
    expect(markup).toContain('秘境交锋'); expect(markup).toContain('护卫所选同伴'); expect(markup).toContain('撤离准备中'); expect(markup).toContain('1.5'); expect(markup).not.toContain('剩余 30 步'); expect(markup).toContain('aria-pressed'); expect(markup).toContain('<select'); expect(markup).toContain('<progress'); expect(markup).not.toContain('finishDowned'); expect(serializeBattle(controller.battle)).toBe(before);
  });
  it('consumes handled Space repeats/read-only input without toggling or leaking to global input', () => {
    expect(battlePauseKeyAction('Space', 'DIV', false, true)).toBe('toggle');
    expect(battlePauseKeyAction('Space', 'CANVAS', true, true)).toBe('consume');
    expect(battlePauseKeyAction('Space', 'DIV', false, false)).toBe('consume');
    for (const tag of ['BUTTON', 'SELECT', 'INPUT', 'SUMMARY']) expect(battlePauseKeyAction('Space', tag, false, true)).toBe('ignore');
    expect(battlePauseKeyAction('Enter', 'DIV', false, true)).toBe('ignore');
  });
  it('disables clock/tactical/retreat mutations under a storage/error read-only lock', () => {
    const markup = renderToStaticMarkup(<BattlePanel controller={control()} catalog={catalog} locale="zh-CN" readOnly paused speed={1} onPausedChange={noop} onSpeedChange={noop} onTacticalOrder={noop} retreatStatus="available" onRetreat={noop} />);
    expect(markup).toMatch(/class="battle-pause"[^>]*disabled/);
    expect(markup).toMatch(/class="battle-retreat-button"[^>]*disabled/);
    expect(markup).toMatch(/<select[^>]*disabled/);
    expect(markup).toContain('battle-unit-button');
  });
  it('distinguishes downed survivors from death in the HUD', () => {
    let state = createBattle(catalog, { seed: 'downed-display', contentMode: 'experimental', entities: [
      { id: 'entity:1', team: 'party', position: { x: 0, y: 0 }, stats: { attack: 10, maxHealth: 100 }, health: 10 },
      { id: 'entity:2', team: 'enemy', position: { x: 20, y: 0 }, stats: { attack: 100, maxHealth: 100 } },
    ] });
    state = issueCommand(state, catalog, { kind: 'basic', actorId: 'entity:2', targetId: 'entity:1' });
    const controller = control(state); const markup = renderToStaticMarkup(<BattlePanel controller={controller} catalog={catalog} locale="zh-CN" paused speed={1} onPausedChange={noop} onSpeedChange={noop} onTacticalOrder={noop} />);
    expect(markup).toContain('倒地 · 尚未死亡'); expect(controller.battle.entities['entity:1']!.deathId).toBeNull();
  });
  it('uses host-base-aware asset URLs and exact original transparent sprite dimensions', () => {
    expect(battleAssetUrl('moss-boar', true)).toBe(`${import.meta.env.BASE_URL}assets/enemies/moss-boar-sheet-${PIXEL_ART_VERSION}.png`);
    expect(CHARACTER_FRAME).toMatchObject({ width: 96, height: 96, poses: 6, directions: 3 });
    expect(CHARACTER_ART[0]!.sheet).toBe(`${import.meta.env.BASE_URL}assets/characters/disciple-0-sheet-${PIXEL_ART_VERSION}.png`);
    for (const art of ['disciple-0', 'disciple-1', 'disciple-2', 'disciple-3', 'moss-boar', 'ruin-guardian', 'ember-wisp', 'ridge-raider', 'venom-adept']) for (const sheet of [false, true]) {
      const group = art.startsWith('disciple-') ? 'characters' : 'enemies';
      const filename = resolve(`public/assets/${group}/${art}${sheet ? '-sheet' : ''}-${PIXEL_ART_VERSION}.png`); const bytes = readFileSync(filename);
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); expect(bytes.readUInt32BE(16)).toBe(sheet ? 576 : 96); expect(bytes.readUInt32BE(20)).toBe(sheet ? 288 : 96); expect(bytes[25]).toBe(6);
    }
  });
  it('keeps authoritative advancement and random generation out of the Phaser renderer', () => {
    const source = readFileSync(resolve('src/phaser/create-battle-game.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:stepBattle|stepCombatController|issueCommand|drawInteger)\s*\(/);
    expect(source).not.toMatch(/Math\.random\s*\(/); expect(source).toContain('BATTLE_EFFECT_LIMIT'); expect(source).toContain('snapshot.tick');
  });
});
