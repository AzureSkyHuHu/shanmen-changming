import Phaser from 'phaser';
import { CHARACTER_FRAME } from './art-manifest';
import { battleAssetUrl, battlefieldLayout, battlefieldPoint, BATTLE_EFFECT_LIMIT, BATTLE_EFFECT_TICKS, collectBattleEffects, PAPER_DECOY_OUTLINE } from './PhaserBattle';
import type { BattleArt, BattleUnitArt, BattleRenderSnapshot, BattleUnitView } from './PhaserBattle';
import type { BattleEvent } from '../core/combat';
const WIDTH = 1000; const HEIGHT = 650;
const ARTS: readonly BattleArt[] = ['disciple-0', 'disciple-1', 'disciple-2', 'disciple-3', 'moss-boar', 'ruin-guardian', 'ember-wisp', 'ridge-raider', 'venom-adept'];
const palette = { jade: 0x7dc7ad, ink: 0x253f41, brass: 0xe7cd91, red: 0xd88677, mist: 0xb8d1c0 };
interface UnitDisplay { container: Phaser.GameObjects.Container; sprite: Phaser.GameObjects.Sprite | null; paper: Phaser.GameObjects.Graphics | null; expiry: Phaser.GameObjects.Text | null; bars: Phaser.GameObjects.Graphics; name: Phaser.GameObjects.Text; x: number; y: number; direction: number; art: BattleUnitArt; hovered: boolean }
interface EffectDisplay { event: BattleEvent; source: { x: number; y: number }; target: { x: number; y: number }; number: Phaser.GameObjects.Text | null }
const grain = (x: number, y: number): number => ((Math.imul(x + 31, 374761393) ^ Math.imul(y + 71, 668265263)) >>> 0) % 997;
/** Read-only presentation. There is no simulation step, timer-driven combat or hidden entity. */
class BattleScene extends Phaser.Scene {
  private snapshot: BattleRenderSnapshot;
  private ready = false;
  private mapSignature = '';
  private terrain: Phaser.GameObjects.Graphics | null = null;
  private zoneArt: Phaser.GameObjects.Graphics | null = null;
  private zoneLabels = new Map<string, Phaser.GameObjects.Text>();
  private paths: Phaser.GameObjects.Graphics | null = null;
  private effectsArt: Phaser.GameObjects.Graphics | null = null;
  private units = new Map<string, UnitDisplay>();
  private effects: EffectDisplay[] = [];
  private lastSequence: number;
  private lastTick: number;
  private zoom = 1;
  private lastSelection: string | null = null;
  constructor(snapshot: BattleRenderSnapshot, private readonly onSelect: (id: string) => void) { super('battle-presentation'); this.snapshot = snapshot; this.lastSequence = snapshot.latestEventSequence; this.lastTick = snapshot.tick; }
  preload(): void { for (const art of ARTS) this.load.spritesheet(`battle-${art}`, battleAssetUrl(art, true), { frameWidth: CHARACTER_FRAME.width, frameHeight: CHARACTER_FRAME.height }); }
  create(): void {
    this.ready = true; this.cameras.main.setBounds(0, 0, WIDTH, HEIGHT).setRoundPixels(true).centerOn(WIDTH / 2, HEIGHT / 2);
    this.terrain = this.add.graphics().setDepth(-100); this.zoneArt = this.add.graphics().setDepth(-50); this.paths = this.add.graphics().setDepth(1000); this.effectsArt = this.add.graphics().setDepth(2000);
    const cleanup = () => { this.ready = false; this.units.clear(); this.zoneLabels.clear(); for (const effect of this.effects) effect.number?.destroy(); this.effects = []; };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanup); this.events.once(Phaser.Scenes.Events.DESTROY, cleanup); this.sync();
  }
  setSnapshot(snapshot: BattleRenderSnapshot): void {
    if (snapshot.tick < this.lastTick || snapshot.latestEventSequence < this.lastSequence) { for (const effect of this.effects) effect.number?.destroy(); this.effects = []; this.lastSequence = snapshot.latestEventSequence; for (const view of this.units.values()) view.container.destroy(); this.units.clear(); for (const label of this.zoneLabels.values()) label.destroy(); this.zoneLabels.clear(); this.lastSelection = null; }
    this.snapshot = snapshot; if (this.ready) this.sync(); this.lastTick = snapshot.tick;
  }
  setZoom(zoom: number): void { this.zoom = Math.max(0.8, Math.min(2, zoom)); if (!this.ready) return; const selected = this.snapshot.units.find(unit => unit.id === this.snapshot.selectedEntityId); const point = selected ? battlefieldPoint(this.snapshot.arena, selected.x, selected.y) : { x: WIDTH / 2, y: HEIGHT / 2 }; this.cameras.main.setZoom(this.zoom).centerOn(point.x, point.y - 25); }
  resetView(): void { this.zoom = 1; if (this.ready) this.cameras.main.setZoom(1).centerOn(WIDTH / 2, HEIGHT / 2); }
  private drawTerrain(): void {
    const arena = this.snapshot.arena; const layout = battlefieldLayout(arena); const g = this.terrain!; g.clear();
    g.fillStyle(0x7f9d91).fillRect(0, 0, WIDTH, HEIGHT);
    const polygon = (color: number, points: number[][]) => g.fillStyle(color).fillPoints(points.map(([x, y]) => new Phaser.Math.Vector2(x!, y!)), true);
    polygon(0x668e87, [[0, 120], [120, 20], [205, 80], [330, 8], [410, 120], [555, 25], [660, 110], [800, 12], [930, 75], [1000, 18], [1000, 270], [0, 270]]);
    polygon(0x486c65, [[0, 215], [115, 125], [240, 180], [375, 95], [540, 205], [670, 116], [810, 177], [945, 92], [1000, 170], [1000, 430], [0, 430]]);
    g.fillStyle(0xe3dbc1, 0.16).fillRect(0, 106, WIDTH, 12).fillRect(0, 132, WIDTH, 7);
    g.fillStyle(0x2f4d48).fillRoundedRect(layout.x - 19, layout.y - 23, layout.width + 38, layout.height + 47, 8);
    g.fillStyle(0x5d7466).fillRect(layout.x - 14, layout.y - 19, layout.width + 28, layout.height + 29);
    const blocked = new Set(arena.blockedCells.map(cell => `${cell.x},${cell.y}`));
    for (let y = 0; y < arena.heightCells; y++) for (let x = 0; x < arena.widthCells; x++) {
      const px = layout.x + x * layout.cell, py = layout.y + y * layout.cell; const noise = grain(x, y);
      g.fillStyle([0x9ea484, 0xa7ab8c, 0x959f81, 0xa2aa8a][noise % 4]!).fillRect(px, py, layout.cell, layout.cell);
      g.fillStyle(0xc4c4a1, 0.62).fillRect(px + 2, py + 2, layout.cell - 4, 2); g.lineStyle(1, 0x78866e, 0.6).strokeRect(px, py, layout.cell, layout.cell);
      for (let detail = 0; detail < 4; detail++) { const n = grain(x * 11 + detail, y * 7); g.fillStyle(detail % 2 ? 0x6e8867 : 0xc3c19b, 0.65).fillRect(px + n % Math.max(1, Math.floor(layout.cell - 8)) + 3, py + Math.floor(n / 11) % Math.max(1, Math.floor(layout.cell - 8)) + 3, 4, 2); }
      if (blocked.has(`${x},${y}`)) {
        const cx = px + layout.cell / 2, cy = py + layout.cell / 2; const size = Math.max(8, layout.cell * 0.38);
        g.fillStyle(0x38544c).fillEllipse(cx, cy + 5, size * 2.3, size * 1.15);
        polygon(0x536d64, [[cx - size, cy + 2], [cx - size * 0.8, cy - size], [cx, cy - size * 1.35], [cx + size, cy - size * 0.65], [cx + size * 0.8, cy + size * 0.55], [cx - size * 0.8, cy + size * 0.55]]);
        polygon(0x8ea28b, [[cx - size * 0.8, cy - size], [cx, cy - size * 1.35], [cx + size * 0.6, cy - size * 0.65], [cx - size * 0.3, cy - size * 0.4]]);
        g.fillStyle(0x6d8c62).fillRect(cx - size * 0.8, cy - size * 0.4, size, 4);
      }
    }
    // Decorative boundary pillars sit outside cells; only arena.blockedCells implies collision.
    for (const x of [layout.x - 26, layout.x + layout.width + 26]) for (const y of [layout.y + 6, layout.y + layout.height - 4]) {
      g.fillStyle(0x304c49).fillEllipse(x + 2, y + 14, 42, 17); g.fillStyle(0x788f7e).fillRect(x - 12, y - 27, 24, 39); g.fillStyle(0xb3bea0).fillRect(x - 17, y - 32, 34, 8); g.fillStyle(0x53786b).fillRect(x - 8, y - 23, 5, 30); g.fillStyle(palette.brass).fillRect(x - 5, y - 14, 9, 3);
    }
    g.lineStyle(2, 0xc8bb88, 0.65).strokeRect(layout.x - 9, layout.y - 14, layout.width + 18, layout.height + 22);
  }
  private drawZones(): void {
    const g = this.zoneArt!; g.clear(); const layout = battlefieldLayout(this.snapshot.arena);
    const present = new Set(this.snapshot.zones.map(zone => zone.id));
    for (const [id, label] of this.zoneLabels) if (!present.has(id)) { label.destroy(); this.zoneLabels.delete(id); }
    const anchorCounts = new Map<string, number>();
    for (const zone of this.snapshot.zones) {
      const side = zone.ally ? palette.jade : palette.red;
      const purpose = zone.purpose === 'damage' ? 0xe6b176 : zone.purpose === 'heal' ? 0xa7d6a4 : zone.purpose === 'mixed' ? 0xc5b5d5 : 0xaed1dc;
      // One bounded shared Graphics object; no per-tick emitters, tweens or history allocation.
      for (const span of zone.spans) {
        const x = layout.x + span.x * layout.cell, y = layout.y + span.y * layout.cell;
        g.fillStyle(purpose, 0.16).fillRect(x + 1, y + 1, span.length * layout.cell - 2, layout.cell - 2);
        g.lineStyle(1, side, 0.78).strokeRect(x + 1, y + 1, span.length * layout.cell - 2, layout.cell - 2);
      }
      const anchor = battlefieldPoint(this.snapshot.arena, zone.anchor.x, zone.anchor.y);
      g.fillStyle(palette.ink, 0.8).fillCircle(anchor.x, anchor.y, 9); g.lineStyle(2, side, 0.95).strokeCircle(anchor.x, anchor.y, 9);
      g.lineStyle(2, purpose, 1);
      if (zone.purpose === 'heal') { g.lineBetween(anchor.x - 5, anchor.y, anchor.x + 5, anchor.y); g.lineBetween(anchor.x, anchor.y - 5, anchor.x, anchor.y + 5); }
      else if (zone.purpose === 'damage') { g.lineBetween(anchor.x - 4, anchor.y + 5, anchor.x + 4, anchor.y - 5); g.lineBetween(anchor.x - 5, anchor.y - 4, anchor.x + 5, anchor.y + 4); }
      else g.strokeRect(anchor.x - 4, anchor.y - 4, 8, 8);
      const key = `${zone.anchor.x},${zone.anchor.y}`; const offset = anchorCounts.get(key) ?? 0; anchorCounts.set(key, offset + 1);
      let label = this.zoneLabels.get(zone.id);
      if (!label) { label = this.add.text(0, 0, '', { fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', fontSize: '10px', color: '#fff2d2', backgroundColor: '#29443eec', padding: { x: 4, y: 2 } }).setOrigin(0.5).setDepth(900); this.zoneLabels.set(zone.id, label); }
      label.setText(zone.canvasLabel).setPosition(anchor.x, anchor.y + 32 + offset * 17);
      const width = Math.min(80, layout.cell); g.fillStyle(palette.ink, 0.8).fillRect(anchor.x - width / 2, anchor.y + 12, width, 3); g.fillStyle(side).fillRect(anchor.x - width / 2, anchor.y + 12, width * zone.remainingBps / 10_000, 3);
    }
  }
  private createUnit(unit: BattleUnitView): UnitDisplay {
    const bars = this.add.graphics();
    const sprite = unit.art === 'paper-decoy' ? null : this.add.sprite(0, 3, `battle-${unit.art}`, 0).setOrigin(0.5, CHARACTER_FRAME.originY).setFlipX(!unit.ally);
    const paper = unit.art === 'paper-decoy' ? this.add.graphics() : null;
    if (paper) {
      const points = PAPER_DECOY_OUTLINE.map(([x, y]) => new Phaser.Math.Vector2(x - 48, y - 88));
      paper.fillStyle(0xf3e8c4).fillPoints(points, true); paper.lineStyle(2, 0x73694e).strokePoints(points, true);
      paper.lineStyle(1, 0xb9aa7d).lineBetween(-10, -76, 0, -56).lineBetween(10, -76, 0, -56).lineBetween(0, -52, 0, -20).lineBetween(-11, -21, 0, -31).lineBetween(11, -21, 0, -31);
      paper.fillStyle(0x9e5549).fillRect(-5, -49, 10, 3).fillRect(-2, -48, 3, 17).fillRect(-6, -42, 12, 3).fillRect(-5, -34, 10, 3);
      paper.fillStyle(unit.ally ? palette.jade : palette.red).fillRect(-11, -27, 22, 4);
    }
    const expiry = unit.kind === 'summon' ? this.add.text(0, 29, unit.summon?.lifetimeLabel ?? '', { fontFamily: '"PingFang SC", sans-serif', fontSize: '10px', color: '#fff2d2', backgroundColor: '#29443eea', padding: { x: 3, y: 1 } }).setOrigin(0.5) : null;
    const name = this.add.text(0, -82, unit.name, { fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', fontSize: '13px', color: '#fff2d2', backgroundColor: '#29443eea', padding: { x: 6, y: 3 } }).setOrigin(0.5);
    const hit = this.add.rectangle(0, -30, 54, 72, 0xffffff, 0).setInteractive({ useHandCursor: true }); hit.on('pointerdown', () => this.onSelect(unit.id));
    const container = this.add.container(0, 0, [bars, ...(sprite ? [sprite] : []), ...(paper ? [paper] : []), ...(expiry ? [expiry] : []), name, hit]);
    const view: UnitDisplay = { container, bars, sprite, paper, expiry, name, x: unit.x, y: unit.y, direction: 1, art: unit.art, hovered: false };
    hit.on('pointerover', () => { view.hovered = true; name.setVisible(true); }); hit.on('pointerout', () => { view.hovered = false; name.setVisible(this.snapshot.selectedEntityId === unit.id); }); this.units.set(unit.id, view); return view;
  }
  private updateUnit(unit: BattleUnitView): void {
    let view = this.units.get(unit.id);
    if (view && view.art !== unit.art) { view.container.destroy(); this.units.delete(unit.id); view = undefined; }
    view ??= this.createUnit(unit);
    const selected = unit.id === this.snapshot.selectedEntityId; const p = battlefieldPoint(this.snapshot.arena, unit.x, unit.y); const scale = Math.min(1.2, Math.max(0.65, battlefieldLayout(this.snapshot.arena).cell / 52));
    const moved = view.x !== unit.x || view.y !== unit.y;
    if (moved) { const dx = unit.x - view.x, dy = unit.y - view.y; view.direction = dx ? 1 : dy < 0 ? 2 : 0; view.sprite?.setFlipX(dx < 0); }
    else if (view.direction === 1 && view.x === unit.x && this.snapshot.tick === 0) view.sprite?.setFlipX(!unit.ally);
    const pose = moved && this.snapshot.tick > this.lastTick && !this.snapshot.paused && !this.snapshot.reducedMotion ? Math.floor(this.snapshot.tick / 2) % CHARACTER_FRAME.poses : 0;
    if (!this.snapshot.paused || this.snapshot.reducedMotion) view.sprite?.setFrame(view.direction * CHARACTER_FRAME.poses + pose);
    const alpha = unit.life === 'Dead' ? 0.3 : unit.life === 'Downed' ? 0.55 : 1; const angle = unit.life === 'Downed' || unit.life === 'Dead' ? (unit.ally ? -65 : 65) : 0;
    view.sprite?.setScale(scale * CHARACTER_FRAME.battleScale).setAlpha(alpha).setAngle(angle); view.paper?.setScale(scale * 0.88).setAlpha(alpha).setAngle(angle);
    view.expiry?.setText(unit.summon?.lifetimeLabel ?? '');
    view.container.setPosition(p.x, p.y).setDepth(Math.floor(p.y)); view.name.setText(unit.name).setY(-76 * scale).setVisible(selected || view.hovered);
    const g = view.bars; g.clear(); g.fillStyle(palette.ink, 0.24).fillEllipse(0, 4, 34 * scale, 11 * scale);
    g.lineStyle(selected ? 2 : 1, selected ? palette.brass : unit.ally ? palette.jade : palette.red, selected ? 1 : 0.65).strokeEllipse(0, 4, 42 * scale, 15 * scale);
    const barY = 13; g.fillStyle(palette.ink, 0.95).fillRoundedRect(-25, barY, 50, 6, 2); g.fillStyle(unit.ally ? palette.jade : palette.red).fillRect(-24, barY + 1, Math.round(48 * Math.max(0, Math.min(1, unit.health / Math.max(1, unit.maximumHealth)))), 4);
    if (unit.shield > 0) { g.lineStyle(1, 0xb1e0d6, 0.75).strokeEllipse(0, -28 * scale, 50 * scale, 64 * scale); g.fillStyle(0xb1e0d6).fillRect(-24, barY - 3, Math.max(2, Math.round(48 * Math.min(1, unit.shield / unit.maximumHealth))), 2); }
    if (unit.castName) { g.fillStyle(0x534d3d).fillRect(-24, barY + 8, 48, 3); g.fillStyle(palette.brass).fillRect(-24, barY + 8, Math.round(48 * unit.castProgressBps / 10_000), 3); }
    if (unit.summon) { g.fillStyle(0x534d3d).fillRect(-24, barY + 8, 48, 3); g.fillStyle(palette.brass).fillRect(-24, barY + 8, 48 * unit.summon.remainingBps / 10_000, 3); }
    unit.statuses.slice(0, 5).forEach((status, index) => { const color = status.category === 'poison' ? 0x92af65 : status.category === 'control' ? 0xd1b4d6 : status.category === 'debuff' ? palette.red : 0x9ed6c1; g.fillStyle(color).fillRect(-19 + index * 9, barY + (unit.summon ? 29 : 15), 6, 5); });
    view.x = unit.x; view.y = unit.y;
  }
  private receiveEffects(): void {
    for (const event of collectBattleEffects(this.snapshot.events, this.lastSequence, this.snapshot.tick)) {
      const source = this.snapshot.units.find(unit => unit.id === event.actorId); const target = this.snapshot.units.find(unit => unit.id === event.targetId); if (!target) continue;
      const destination = battlefieldPoint(this.snapshot.arena, target.x, target.y); const origin = source ? battlefieldPoint(this.snapshot.arena, source.x, source.y) : destination;
      const amount = event.kind === 'damage.healthLost' ? event.values.actualHealthLoss : event.kind === 'healing.resolved' ? event.values.effectiveHealing : event.kind === 'shield.absorbed' ? event.values.actualShieldAbsorbed : undefined;
      const color = event.kind === 'healing.resolved' ? '#c2efbb' : event.kind === 'shield.absorbed' ? '#c8e8df' : event.flags.isCritical ? '#ffe7a7' : '#fff0d1';
      const text = amount !== undefined && amount > 0 ? this.add.text(destination.x, destination.y - 53, `${event.kind === 'healing.resolved' ? '+' : ''}${amount}`, { fontFamily: 'Georgia, "Songti SC", serif', fontSize: event.flags.isCritical ? '24px' : '19px', fontStyle: 'bold', color, stroke: '#293f40', strokeThickness: 3 }).setOrigin(0.5).setDepth(2100) : null;
      this.effects.push({ event, source: origin, target: destination, number: text });
    }
    this.lastSequence = this.snapshot.latestEventSequence;
    while (this.effects.length > BATTLE_EFFECT_LIMIT) this.effects.shift()!.number?.destroy();
  }
  private drawEffects(): void {
    const g = this.effectsArt!; g.clear();
    this.effects = this.effects.filter(effect => { if (effect.event.tick + BATTLE_EFFECT_TICKS <= this.snapshot.tick) { effect.number?.destroy(); return false; } return true; });
    for (const effect of this.effects) {
      const age = Math.max(0, this.snapshot.tick - effect.event.tick); const alpha = 1 - age / BATTLE_EFFECT_TICKS; const y = effect.target.y - 30;
      effect.number?.setPosition(effect.target.x, effect.target.y - 55 - (this.snapshot.reducedMotion ? 0 : age * 1.6)).setAlpha(alpha);
      if (this.snapshot.reducedMotion) continue;
      const kind = effect.event.kind; const tags = effect.event.originalTags; const color = kind === 'healing.resolved' ? 0xb4e7af : kind.startsWith('shield') ? 0xb9e5db : tags.includes('lightning') ? 0xd4e7ed : tags.includes('fire') ? 0xf0b082 : tags.includes('poison') ? 0xb5cc7d : palette.brass;
      g.lineStyle(kind === 'action.committed' ? 2 : 3, color, alpha * 0.85);
      if (kind === 'action.committed' && effect.source !== effect.target) { g.lineBetween(effect.source.x, effect.source.y - 29, effect.target.x, y); }
      else if (kind === 'damage.healthLost') { const spread = 9 + age * 1.6; g.lineBetween(effect.target.x - spread, y + 8, effect.target.x + spread, y - 10); g.lineBetween(effect.target.x - spread * 0.6, y - 7, effect.target.x + spread * 0.6, y + 9); }
      else if (kind === 'healing.resolved') { g.lineBetween(effect.target.x - 7, y, effect.target.x + 7, y); g.lineBetween(effect.target.x, y - 7, effect.target.x, y + 7); }
      else g.strokeCircle(effect.target.x, y, 14 + age * 1.5);
    }
  }
  private sync(): void {
    const signature = JSON.stringify(this.snapshot.arena); if (signature !== this.mapSignature) { this.mapSignature = signature; this.drawTerrain(); }
    this.drawZones();
    const present = new Set(this.snapshot.units.map(unit => unit.id)); for (const [id, view] of this.units) if (!present.has(id)) { view.container.destroy(); this.units.delete(id); }
    for (const unit of this.snapshot.units) this.updateUnit(unit);
    this.paths!.clear(); const selected = this.snapshot.units.find(unit => unit.id === this.snapshot.selectedEntityId); const target = selected?.targetId ? this.snapshot.units.find(unit => unit.id === selected.targetId) : null;
    if (selected && target) { const a = battlefieldPoint(this.snapshot.arena, selected.x, selected.y), b = battlefieldPoint(this.snapshot.arena, target.x, target.y); this.paths!.lineStyle(1, palette.brass, 0.7).lineBetween(a.x, a.y + 3, b.x, b.y + 3); }
    if (this.zoom > 1 && selected && selected.id !== this.lastSelection) { const point = battlefieldPoint(this.snapshot.arena, selected.x, selected.y); this.cameras.main.centerOn(point.x, point.y - 25); }
    this.lastSelection = this.snapshot.selectedEntityId;
    this.receiveEffects(); this.drawEffects();
  }
}
export interface BattleRenderer { update(snapshot: BattleRenderSnapshot): void; setZoom(zoom: number): void; resetView(): void; destroy(): void }
export function mountBattleGame(parent: HTMLElement, snapshot: BattleRenderSnapshot, onSelect: (id: string) => void): BattleRenderer {
  const scene = new BattleScene(snapshot, onSelect); const game = new Phaser.Game({ type: Phaser.AUTO, parent, width: WIDTH, height: HEIGHT, scene: [scene], backgroundColor: '#739588', pixelArt: true, roundPixels: true, banner: false, autoFocus: false, audio: { noAudio: true }, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH } });
  return { update: next => scene.setSnapshot(next), setZoom: zoom => scene.setZoom(zoom), resetView: () => scene.resetView(), destroy: () => game.destroy(true) };
}
