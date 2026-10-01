import { disciplePresentation } from '../application/character-presentation';
import Phaser from 'phaser';
import type { ApplicationSession, DeepReadonly, SessionProjection } from '../application/session';
import { translate, type Locale, type TextKey } from '../i18n';
import { BUILDING_ART, CHARACTER_ART, CHARACTER_FRAME, SCENERY_ART } from './art-manifest';

const TILE = 64;
const ORIGIN = { x: 128, y: 68 };
const SIZE = { width: 1152, height: 768 };
const DEFAULT_ZOOM = 1.1;
interface EntityView {
  container: Phaser.GameObjects.Container;
  art: Phaser.GameObjects.Graphics;
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  signature: string;
  hovered: boolean;
  lastX: number;
  lastY: number;
  direction: number;
}
/** Cosmetic coordinate hash. Never reads or advances the simulation's random streams. */
const grain = (x: number, y: number, salt = 0) => ((Math.imul(x + 89, 374761393) ^ Math.imul(y + salt + 17, 668265263)) >>> 0) % 997;

/** Thin disposable view: simulation positions and phases are the only movement authority. */
class SectScene extends Phaser.Scene {
  private stop: (() => void) | null = null;
  private terrain: Phaser.GameObjects.Graphics | null = null;
  private decorations: Phaser.GameObjects.Container | null = null;
  private mapSignature = '';
  private entityViews = new Map<string, EntityView>();
  private ready = false;
  private zoom = DEFAULT_ZOOM;
  private cameraTarget = { x: SIZE.width / 2, y: SIZE.height / 2 };
  private previousSelection = '';

  constructor(private readonly session: ApplicationSession, private locale: Locale, private readonly initialZoom = DEFAULT_ZOOM) { super('sect-world'); this.zoom = initialZoom; }

  preload(): void {
    for (const asset of CHARACTER_ART) this.load.spritesheet(asset.key, asset.sheet, { frameWidth: CHARACTER_FRAME.width, frameHeight: CHARACTER_FRAME.height });
    for (const asset of [...BUILDING_ART, ...SCENERY_ART]) this.load.image(asset.key, asset.url);
  }

  create(): void {
    this.ready = true;
    this.cameras.main.setBounds(0, 0, SIZE.width, SIZE.height).setRoundPixels(true).setZoom(this.zoom).centerOn(this.cameraTarget.x, this.cameraTarget.y);
    this.terrain = this.add.graphics().setDepth(-1000);
    this.decorations = this.add.container(0, 0).setDepth(-500);
    this.stop = this.session.subscribe(() => this.sync());
    const dispose = () => { this.stop?.(); this.stop = null; this.ready = false; this.entityViews.clear(); };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, dispose);
    this.events.once(Phaser.Scenes.Events.DESTROY, dispose);
    this.sync();
  }
  setLocale(locale: Locale): void { this.locale = locale; if (this.ready) this.sync(); }
  setZoom(zoom: number): void {
    this.zoom = Math.max(0.85, Math.min(2.2, zoom));
    if (this.ready) this.cameras.main.setZoom(this.zoom).centerOn(this.cameraTarget.x, this.cameraTarget.y);
  }
  resetView(): void {
    this.cameraTarget = { x: SIZE.width / 2, y: SIZE.height / 2 };
    this.setZoom(this.initialZoom);
  }

  private drawMap(projection: DeepReadonly<SessionProjection>): void {
    const g = this.terrain!;
    g.clear();
    this.decorations!.removeAll(true);
    const rect = (color: number, x: number, y: number, w: number, h: number, alpha = 1) => g.fillStyle(color, alpha).fillRect(x, y, w, h);
    // Desaturated layered peaks frame a bright, quiet courtyard rather than a boxed grid.
    rect(0x99b4ab, 0, 0, SIZE.width, SIZE.height);
    g.fillStyle(0x6f9996).fillPoints([{ x: 0, y: 180 }, { x: 115, y: 39 }, { x: 218, y: 89 }, { x: 341, y: 5 }, { x: 445, y: 126 }, { x: 557, y: 42 }, { x: 716, y: 111 }, { x: 887, y: 11 }, { x: 1034, y: 115 }, { x: 1152, y: 51 }, { x: 1152, y: 285 }, { x: 0, y: 285 }].map((point) => new Phaser.Math.Vector2(point.x, point.y)), true);
    g.fillStyle(0x517e79).fillPoints([{ x: 0, y: 255 }, { x: 88, y: 124 }, { x: 151, y: 147 }, { x: 218, y: 72 }, { x: 339, y: 221 }, { x: 454, y: 138 }, { x: 575, y: 202 }, { x: 686, y: 82 }, { x: 810, y: 216 }, { x: 925, y: 112 }, { x: 1054, y: 153 }, { x: 1152, y: 92 }, { x: 1152, y: 400 }, { x: 0, y: 400 }].map((point) => new Phaser.Math.Vector2(point.x, point.y)), true);
    rect(0xd7ddc0, 0, 91, SIZE.width, 11, 0.25); rect(0xc4d5bf, 0, 128, SIZE.width, 17, 0.2);
    // Stone terrace retaining walls, moss, creek and an unambiguous map edge.
    rect(0x3f635c, ORIGIN.x - 24, ORIGIN.y + 20, projection.map.width * TILE + 48, projection.map.height * TILE + 12);
    rect(0x567564, ORIGIN.x - 18, ORIGIN.y - 4, projection.map.width * TILE + 36, projection.map.height * TILE + 20);
    for (let x = ORIGIN.x - 24; x < ORIGIN.x + projection.map.width * TILE + 24; x += 24) {
      rect(0x82947b, x, ORIGIN.y + projection.map.height * TILE + 13, 21, 8);
      rect(0x596e5e, x + 4, ORIGIN.y + projection.map.height * TILE + 22, 18, 7);
    }
    for (const tile of projection.map.tiles) {
      const x = ORIGIN.x + tile.x * TILE, y = ORIGIN.y + tile.y * TILE;
      const sample = grain(tile.x, tile.y);
      const green = [0x7d9970, 0x829d73, 0x819b70, 0x7b966c][sample % 4]!;
      rect(tile.terrain === 'water' ? 0x6baba4 : tile.walkable ? green : 0x536f5f, x, y, TILE, TILE);
      // Small, grouped clusters instead of one repeated checkerboard glyph.
      for (let detail = 0; detail < 12; detail += 1) {
        const n = grain(tile.x * 13 + detail, tile.y, detail);
        const dx = 3 + n % 57, dy = 3 + Math.floor(n / 17) % 56;
        rect(detail % 3 ? 0xa6b783 : 0x567b58, x + dx, y + dy, 2 + n % 4, 2, 0.6);
        if (detail % 4 === 0) rect(0x557b51, x + dx + 2, y + dy - 3, 2, 4, 0.55);
      }
      if (tile.terrain === 'path') {
        rect(0x9b9c79, x, y, TILE, TILE);
        rect(0xb7b693, x + 2, y + 1, TILE - 4, TILE - 2);
        for (let row = 0; row < 4; row += 1) for (let col = 0; col < 3; col += 1) {
          const dx = (col * 23 + (row % 2) * 10) % 61;
          rect((row + col + sample) % 3 ? 0xc6c6a4 : 0xadaf91, x + dx + 1, y + row * 16 + 2, Math.min(20, 63 - dx), 13);
          rect(0xd7d5b4, x + dx + 2, y + row * 16 + 2, Math.min(15, 61 - dx), 1);
        }
        rect(0x698659, x + sample % 45, y + 60, 8, 3);
      } else if (tile.terrain === 'forest') {
        // Groundcover is traversable; these low shrubs never pretend to be collision trees.
        const dx = x + 15 + sample % 22, dy = y + 24 + sample % 16;
        rect(0x527853, dx - 7, dy, 22, 8); rect(0x638e5e, dx - 9, dy - 4, 17, 7); rect(0x92ad72, dx - 5, dy - 6, 11, 4); rect(0xb0bf81, dx - 3, dy - 7, 4, 2);
        if (sample % 3 === 0) { rect(0xdac5ae, dx + 7, dy - 2, 3, 3); rect(0xc59da2, dx + 10, dy + 2, 3, 3); }
      } else if (tile.terrain === 'stone') {
        const dx = x + 15 + sample % 18, dy = y + 26;
        rect(0x607c6a, dx - 2, dy + 10, 26, 6); rect(0x94a58e, dx, dy, 23, 12); rect(0xc1c4a5, dx + 3, dy - 3, 16, 6); rect(0x7f9580, dx + 16, dy + 3, 7, 9); rect(0xd2cfac, dx + 4, dy - 3, 10, 2);
      }
      if (!tile.walkable) { rect(0x37584f, x + 5, y + 8, 54, 46, 0.25); }
    }
    // Borders are scenery only and do not alter any authoritative tile or passability.
    const addTree = (x: number, y: number, blossom: boolean, scale = 1.6) => {
      const image = this.add.image(x, y, blossom ? 'scenery-blossom' : 'scenery-pine').setOrigin(0.5, 0.85).setScale(scale);
      this.decorations!.add(image);
    };
    for (let i = 0; i < 7; i += 1) { addTree(63 + (i % 2) * 19, 165 + i * 88, i === 2 || i === 6); addTree(1082 - (i % 2) * 17, 152 + i * 90, i === 1 || i === 5); }
    for (const building of projection.buildings) {
      const x = ORIGIN.x + building.x * TILE + TILE / 2, y = ORIGIN.y + building.y * TILE + TILE / 2;
      // Worn soil around each real worksite helps explain the scene's spatial rhythm.
      g.fillStyle(0xafa681, 0.75).fillEllipse(x, y + 3, building.blueprintId === 'herb-garden' ? 108 : 94, 43);
      for (let i = 0; i < 4; i += 1) rect(0xd0c4a0, x - 31 + i * 18, y + 8 + (i % 2) * 3, 13, 3);
    }
    // Fence follows only the outer terrace, with an opening on the real central path.
    const bottom = ORIGIN.y + projection.map.height * TILE + 4;
    for (let x = ORIGIN.x + 6; x < ORIGIN.x + projection.map.width * TILE; x += 28) {
      if (Math.abs(x - (ORIGIN.x + 7.5 * TILE)) < 45) continue;
      rect(0x6b6450, x, bottom - 16, 4, 23); rect(0xb7a279, x, bottom - 18, 4, 3); rect(0xa18f6b, x, bottom - 11, 26, 3); rect(0x7b7358, x, bottom - 4, 26, 3);
    }
  }

  private createView(id: string, kind: 'disciple' | 'building', texture: string): EntityView {
    const art = this.add.graphics();
    const sprite = this.add.sprite(0, kind === 'disciple' ? 3 : 9, texture, 0).setOrigin(0.5, kind === 'disciple' ? CHARACTER_FRAME.originY : 0.83).setScale(kind === 'disciple' ? CHARACTER_FRAME.worldScale : 0.86);
    const label = this.add.text(0, kind === 'disciple' ? 20 : 30, '', { fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', fontSize: '13px', color: '#f4edce', backgroundColor: '#304d46e8', padding: { x: 7, y: 4 } }).setOrigin(0.5, 0.5);
    const hit = this.add.rectangle(0, kind === 'disciple' ? -34 : -43, kind === 'disciple' ? 51 : 106, kind === 'disciple' ? 79 : 111, 0xffffff, 0).setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => this.session.select({ kind, id }));
    const container = this.add.container(0, 0, [art, sprite, label, hit]);
    const view: EntityView = { container, art, sprite, label, signature: '', hovered: false, lastX: -1, lastY: -1, direction: 0 };
    hit.on('pointerover', () => { view.hovered = true; label.setVisible(true); });
    hit.on('pointerout', () => { view.hovered = false; this.sync(); });
    this.entityViews.set(id, view);
    return view;
  }

  private drawMarker(view: EntityView, selected: boolean, progress: number | null, blocked: boolean, building: boolean): void {
    const art = view.art;
    art.clear();
    art.fillStyle(0x2c4c43, 0.24).fillEllipse(1, 4, building ? 88 : 34, building ? 25 : 10);
    if (selected) {
      art.lineStyle(2, 0xf5dfa3, 0.9).strokeEllipse(0, 4, building ? 106 : 47, building ? 36 : 17);
      art.fillStyle(0xf5dfa3).fillTriangle(-4, building ? -117 : -83, 4, building ? -117 : -83, 0, building ? -111 : -77);
    }
    if (progress !== null) {
      art.fillStyle(0x29483e, 0.9).fillRect(-21, 12, 42, 5);
      if (progress > 0) art.fillStyle(blocked ? 0xdca87c : 0xe5d79d).fillRect(-20, 13, Math.round(progress * 40), 3);
    }
  }

  private sync(): void {
    const projection = this.session.getSnapshot();
    const signature = `${projection.map.seed}:${projection.map.navVersion}:${projection.map.width}:${projection.map.height}`;
    if (this.mapSignature !== signature) { this.drawMap(projection); this.mapSignature = signature; }
    const present = new Set<string>();
    for (const building of projection.buildings) {
      present.add(building.id);
      const view = this.entityViews.get(building.id) ?? this.createView(building.id, 'building', `building-${building.blueprintId}`);
      const selected = projection.selection?.kind === 'building' && projection.selection.id === building.id;
      const next = `${selected}:${building.operational}:${this.locale}`;
      if (view.signature !== next) {
        this.drawMarker(view, selected, null, false, true);
        view.label.setText(translate(this.locale, building.nameKey as TextKey));
        view.sprite.setAlpha(building.operational ? 1 : 0.55);
        view.signature = next;
      }
      view.label.setVisible(true);
      view.container.setPosition(ORIGIN.x + building.x * TILE + TILE / 2, ORIGIN.y + building.y * TILE + TILE / 2).setDepth(building.y * TILE);
    }
    projection.disciples.forEach((disciple, index) => {
      present.add(disciple.id);
      const presentation = disciplePresentation(disciple, index);
      const view = this.entityViews.get(disciple.id) ?? this.createView(disciple.id, 'disciple', presentation.id);
      if (view.sprite.texture.key !== presentation.id) view.sprite.setTexture(presentation.id);
      const transaction = projection.transactions.find((entry) => entry.transactionId === disciple.assignmentTransactionId);
      const selected = projection.selection?.kind === 'disciple' && projection.selection.id === disciple.id;
      const progress = transaction ? transaction.activeTicks / transaction.requiredTicks : null;
      const next = `${selected}:${progress}:${transaction?.state}:${disciple.lifeState}:${this.locale}`;
      if (view.signature !== next) {
        this.drawMarker(view, selected, progress, transaction?.state === 'Blocked', false);
        const name = translate(this.locale, disciple.nameKey as TextKey);
        const lifecycleLabel = disciple.lifeState === 'dead' ? translate(this.locale, 'disciple.dead')
          : disciple.lifeState === 'pendingDeath' ? translate(this.locale, 'cultivation.ui.pendingDeath') : null;
        view.label.setText(lifecycleLabel ? `${name} · ${lifecycleLabel}` : name);
        view.sprite.setAlpha(disciple.lifeState === 'dead' ? 0.4 : disciple.lifeState === 'pendingDeath' ? 0.7 : 1);
        if (disciple.lifeState === 'alive') view.sprite.clearTint();
        else view.sprite.setTint(disciple.lifeState === 'dead' ? 0x70877f : 0xd2b88b).setFrame(0).setFlipX(false);
        view.signature = next;
      }
      if (view.lastX >= 0 && (view.lastX !== disciple.position.x || view.lastY !== disciple.position.y)) {
        const dx = disciple.position.x - view.lastX, dy = disciple.position.y - view.lastY;
        view.direction = dx !== 0 ? 1 : dy < 0 ? 2 : 0;
        view.sprite.setFlipX(dx < 0);
        if (dx === 0) view.sprite.setFlipX(false);
      }
      // Pose advances only with simulation ticks, never from Phaser wall-clock callbacks.
      if (disciple.lifeState !== 'alive') {
        view.sprite.setFrame(0).setFlipX(false);
      } else if (!projection.paused) {
        const walking = disciple.traveling && transaction?.state !== 'Blocked' && disciple.lifeState === 'alive';
        const pose = walking ? Math.floor(projection.clock.simulationTick / 2) % CHARACTER_FRAME.poses : 0;
        view.sprite.setFrame(view.direction * CHARACTER_FRAME.poses + pose);
      }
      view.lastX = disciple.position.x; view.lastY = disciple.position.y;
      view.label.setVisible(selected || view.hovered || disciple.lifeState !== 'alive');
      // No position tween, predicted path, decorative wandering or synthetic progress.
      view.container.setPosition(ORIGIN.x + disciple.position.x * TILE + TILE / 2, ORIGIN.y + disciple.position.y * TILE + TILE / 2).setDepth(disciple.position.y * TILE + 1);
    });
    for (const [id, view] of this.entityViews) if (!present.has(id)) { view.container.destroy(); this.entityViews.delete(id); }
    const selection = projection.selection ? `${projection.selection.kind}:${projection.selection.id}` : '';
    if (this.zoom > 1.25 && selection && selection !== this.previousSelection) {
      const view = projection.selection ? this.entityViews.get(projection.selection.id) : undefined;
      if (view) { this.cameraTarget = { x: view.container.x, y: view.container.y - 45 }; this.cameras.main.centerOn(this.cameraTarget.x, this.cameraTarget.y); }
    }
    this.previousSelection = selection;
  }
}

export interface SectRenderer { setLocale(locale: Locale): void; setZoom(zoom: number): void; resetView(): void; destroy(): void }
export function mountSectWorld(parent: HTMLElement, session: ApplicationSession, locale: Locale): SectRenderer {
  const scene = new SectScene(session, locale, parent.clientWidth < 620 ? 1.8 : DEFAULT_ZOOM);
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent, width: SIZE.width, height: SIZE.height,
    scene: [scene], backgroundColor: '#91aca0', pixelArt: true, roundPixels: true,
    banner: false, autoFocus: false, audio: { noAudio: true },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  });
  return { setLocale: (next) => scene.setLocale(next), setZoom: (zoom) => scene.setZoom(zoom), resetView: () => scene.resetView(), destroy: () => game.destroy(true) };
}
