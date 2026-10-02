import Phaser from 'phaser';
import { asSectRendererSource, sectPlacementCellAt, sectRenderEntityKey, sectVisualWorkProgress, subscribeSectRenderer,
  type LegacySectRendererSession, type SectRenderExpansion, type SectRendererSnapshot, type SectRendererSource } from './sect-renderer-contract';
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
interface ExpansionView {
  container: Phaser.GameObjects.Container;
  art: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  hit: Phaser.GameObjects.Rectangle;
  signature: string;
}
/** Cosmetic coordinate hash. Never reads or advances the simulation's random streams. */
const grain = (x: number, y: number, salt = 0) => ((Math.imul(x + 89, 374761393) ^ Math.imul(y + salt + 17, 668265263)) >>> 0) % 997;

/** Thin disposable view: simulation positions and phases are the only movement authority. */
class SectScene extends Phaser.Scene {
  private stop: (() => void) | null = null;
  private terrain: Phaser.GameObjects.Graphics | null = null;
  private decorations: Phaser.GameObjects.Container | null = null;
  private placementArt: Phaser.GameObjects.Graphics | null = null;
  private placementSignature = '';
  private mapSignature = '';
  private entityViews = new Map<string, EntityView>();
  private expansionViews = new Map<string, ExpansionView>();
  private ready = false;
  private zoom = DEFAULT_ZOOM;
  private cameraTarget = { x: SIZE.width / 2, y: SIZE.height / 2 };
  private previousSelection = '';

  constructor(private readonly source: SectRendererSource, private locale: Locale, private readonly initialZoom = DEFAULT_ZOOM) { super('sect-world'); this.zoom = initialZoom; }

  preload(): void {
    for (const asset of CHARACTER_ART) this.load.spritesheet(asset.key, asset.sheet, { frameWidth: CHARACTER_FRAME.width, frameHeight: CHARACTER_FRAME.height });
    for (const asset of [...BUILDING_ART, ...SCENERY_ART]) this.load.image(asset.key, asset.url);
  }

  create(): void {
    this.ready = true;
    this.cameras.main.setBounds(0, 0, SIZE.width, SIZE.height).setRoundPixels(true).setZoom(this.zoom).centerOn(this.cameraTarget.x, this.cameraTarget.y);
    this.terrain = this.add.graphics().setDepth(-1000);
    this.decorations = this.add.container(0, 0).setDepth(-500);
    this.placementArt = this.add.graphics().setDepth(10000);
    const placementClick = (pointer: Phaser.Input.Pointer) => {
      const cell = sectPlacementCellAt(this.source.getSnapshot(), pointer.worldX, pointer.worldY, ORIGIN, TILE);
      if (cell) this.source.onPlacementCell?.(cell);
    };
    this.input.on('pointerdown', placementClick);
    this.stop = subscribeSectRenderer(this.source, () => this.sync());
    const dispose = () => {
      this.stop?.(); this.stop = null; this.ready = false;
      this.events.off(Phaser.Scenes.Events.SHUTDOWN, dispose);
      this.events.off(Phaser.Scenes.Events.DESTROY, dispose);
      for (const view of this.entityViews.values()) view.container.destroy();
      for (const view of this.expansionViews.values()) view.container.destroy();
      this.entityViews.clear(); this.expansionViews.clear();
      this.input.off('pointerdown', placementClick);
      this.placementArt?.destroy(); this.placementArt = null;
      this.mapSignature = ''; this.previousSelection = ''; this.placementSignature = '';
    };
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

  private drawMap(projection: SectRendererSnapshot): void {
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
    hit.on('pointerdown', () => { if (!this.source.getSnapshot().placement) this.source.select({ kind, id }); });
    const container = this.add.container(0, 0, [art, sprite, label, hit]);
    const view: EntityView = { container, art, sprite, label, signature: '', hovered: false, lastX: -1, lastY: -1, direction: 0 };
    hit.on('pointerover', () => { view.hovered = true; label.setVisible(true); });
    hit.on('pointerout', () => { view.hovered = false; this.sync(); });
    this.entityViews.set(sectRenderEntityKey({ kind, id }), view);
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

  private createExpansionView(object: SectRenderExpansion): ExpansionView {
    const art = this.add.graphics();
    const label = this.add.text(0, 0, '', { fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', fontSize: '13px',
      color: '#f4edce', backgroundColor: '#304d46e8', padding: { x: 7, y: 4 } }).setOrigin(0.5, 0.5);
    const hit = this.add.rectangle(0, 0, TILE * 2, TILE * 2, 0xffffff, 0).setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => { if (!this.source.getSnapshot().placement) this.source.select({ kind: object.kind, id: object.id }); });
    const container = this.add.container(0, 0, [art, label, hit]);
    const view: ExpansionView = { container, art, label, hit, signature: '' };
    this.expansionViews.set(sectRenderEntityKey(object), view);
    return view;
  }

  private drawExpansion(view: ExpansionView, object: SectRenderExpansion, selected: boolean,
    center: { x: number; y: number }, width: number, height: number): void {
    const art = view.art; art.clear();
    const planned = object.kind === 'blueprint' && object.status === 'planned';
    const constructing = object.kind === 'blueprint' && object.status === 'started';
    const color = planned ? 0xcee9db : constructing ? 0xe1ba70 : object.definitionId === 'library.v9' ? 0x96c9b3 : 0xdcb19b;
    // Actual footprint cells are shown, never baked into or used to rewrite base-terrain walkability.
    for (const cell of object.footprint.cells) {
      const x = (cell.x - center.x) * TILE, y = (cell.y - center.y) * TILE;
      art.fillStyle(planned ? 0x86b9ad : constructing ? 0x96734b : 0x607362, planned ? 0.2 : 0.48).fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
      if (planned) {
        art.lineStyle(2, color, 0.9);
        for (let offset = 4; offset < TILE - 4; offset += 13) {
          art.lineBetween(x + offset, y + 3, x + Math.min(offset + 7, TILE - 4), y + 3);
          art.lineBetween(x + 3, y + offset, x + 3, y + Math.min(offset + 7, TILE - 4));
          art.lineBetween(x + offset, y + TILE - 3, x + Math.min(offset + 7, TILE - 4), y + TILE - 3);
          art.lineBetween(x + TILE - 3, y + offset, x + TILE - 3, y + Math.min(offset + 7, TILE - 4));
        }
      } else art.lineStyle(1, color, 0.55).strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
    }
    const left = -width / 2 + 12, right = width / 2 - 12, top = -height / 2 + 15, bottom = height / 2 - 13;
    if (constructing) {
      // An open timber scaffold, distinct from both a soft blueprint and a completed building.
      art.lineStyle(6, 0x695843, 1).strokeRect(left, top + 4, right - left, bottom - top - 4);
      art.lineStyle(3, 0xd2b486, 1).lineBetween(left, top + 6, right, bottom).lineBetween(right, top + 6, left, bottom);
      art.lineStyle(4, 0xa08358, 1).lineBetween(left - 6, top + 25, right + 6, top + 25).lineBetween(left - 6, bottom - 20, right + 6, bottom - 20);
      art.fillStyle(0xceb68c).fillRect(left + 9, bottom - 9, 31, 6).fillRect(left + 14, bottom - 17, 31, 6);
    } else if (object.kind === 'sect-building') {
      const library = object.definitionId === 'library.v9';
      const alpha = object.operational ? 1 : 0.48;
      art.fillStyle(0x2c4c43, 0.25).fillEllipse(2, bottom + 4, width - 4, 30);
      art.fillStyle(library ? 0xc2b394 : 0xbea285, alpha).fillRect(left + 5, top + 28, right - left - 10, bottom - top - 28);
      art.fillStyle(0x695643, alpha).fillRect(left + 7, top + 26, 6, bottom - top - 25).fillRect(right - 13, top + 26, 6, bottom - top - 25);
      art.fillStyle(library ? 0x47776c : 0x955e50, alpha).fillTriangle(left - 7, top + 31, 0, top - 5, right + 7, top + 31);
      art.fillStyle(library ? 0x6e9a83 : 0xb48362, alpha).fillRect(left - 7, top + 28, right - left + 14, 7);
      art.lineStyle(2, 0xd5bc87, alpha).lineBetween(left - 8, top + 28, right + 8, top + 28);
      if (library) {
        // Authored bookcase and open-book crest identify the library without an asset alias.
        art.fillStyle(0x544f40, alpha).fillRect(left + 21, top + 43, right - left - 42, bottom - top - 47);
        const bookColors = [0xb5c5a1, 0xb38e7e, 0x8ca7a6, 0xd1bc83];
        for (let row = 0; row < 2; row++) for (let book = 0; book < 5; book++) {
          art.fillStyle(bookColors[(book + row) % bookColors.length]!, alpha).fillRect(left + 25 + book * 9, top + 47 + row * 19, 6, 14);
        }
        art.lineStyle(3, 0x8b7154, alpha).lineBetween(left + 20, top + 63, right - 20, top + 63);
        art.fillStyle(0xe6d4a7, alpha).fillTriangle(-17, top + 9, 0, top + 13, -17, top + 23).fillTriangle(17, top + 9, 0, top + 13, 17, top + 23);
        art.lineStyle(2, 0xefe0ba, alpha).lineBetween(0, top + 12, 0, top + 24);
      } else {
        // Alchemy is a roofed brazier/cauldron, not a recolored legacy workshop sprite.
        art.fillStyle(0x58665e, alpha).fillEllipse(0, bottom - 22, 47, 33).fillRect(-18, bottom - 20, 36, 20);
        art.fillStyle(0x93a590, alpha).fillEllipse(0, bottom - 35, 46, 13);
        art.lineStyle(4, 0xc0b089, alpha).strokeEllipse(0, bottom - 34, 37, 7);
        art.lineStyle(5, 0x566459, alpha).lineBetween(-17, bottom - 6, -23, bottom + 2).lineBetween(17, bottom - 6, 23, bottom + 2);
        art.fillStyle(0xcfaa72, alpha).fillTriangle(-6, bottom - 12, 6, bottom - 12, 1, bottom - 24);
        art.fillStyle(0x8eaca2, alpha).fillRect(right - 22, top + 43, 10, 17).fillRect(left + 13, top + 50, 9, 12);
        if (object.level === 2) art.lineStyle(2, 0xe4d6a7, alpha).strokeCircle(-8, top + 19, 3).strokeCircle(8, top + 19, 3);
      }
      // Inoperable maintenance is a static slash as well as reduced opacity.
      if (!object.operational) art.lineStyle(3, 0xd6b090, 1).strokeCircle(right - 4, bottom - 8, 10).lineBetween(right - 11, bottom - 1, right + 3, bottom - 15);
    }
    // Mark the exact authoritative entrance cell and the direction toward its footprint.
    const entrance = object.footprint.entrance;
    const ex = (entrance.x + 0.5 - center.x) * TILE, ey = (entrance.y + 0.5 - center.y) * TILE;
    art.fillStyle(0x314f48, 0.8).fillRect(ex - 11, ey - 11, 22, 22);
    art.lineStyle(2, color, 1).strokeRect(ex - 11, ey - 11, 22, 22);
    const dx = Math.abs(ex) > Math.abs(ey) ? (ex < 0 ? 1 : -1) : 0;
    const dy = dx === 0 ? (ey < 0 ? 1 : -1) : 0;
    art.lineStyle(3, color, 1).lineBetween(ex - dx * 6, ey - dy * 6, ex + dx * 5, ey + dy * 5);
    art.fillStyle(color, 1).fillTriangle(ex + dx * 9, ey + dy * 9,
      ex - dy * 5, ey + dx * 5, ex + dy * 5, ey - dx * 5);
    if (selected) art.lineStyle(3, 0xf5dfa3, 1).strokeRect(-width / 2 - 3, -height / 2 - 3, width + 6, height + 6);
    const progress = object.kind === 'blueprint' ? sectVisualWorkProgress(object.work) : null;
    if (progress !== null) {
      art.fillStyle(0x29483e, 1).fillRect(-31, bottom + 7, 62, 7);
      art.fillStyle(object.kind === 'blueprint' && object.work?.blocked ? 0xdca87c : 0xe5d79d, 1).fillRect(-30, bottom + 8, Math.round(progress * 60), 5);
    }
    view.label.setText(translate(this.locale, object.definitionId === 'library.v9' ? 'sectV9.building.library' : 'sectV9.building.alchemy'));
    view.label.setPosition(0, height / 2 + 18);
    view.hit.setSize(width, height);
  }

  private syncExpansion(projection: SectRendererSnapshot): void {
    const present = new Set<string>();
    for (const object of projection.expansion) {
      if (object.footprint.cells.length === 0) continue;
      const key = sectRenderEntityKey(object); present.add(key);
      const view = this.expansionViews.get(key) ?? this.createExpansionView(object);
      const xs = object.footprint.cells.map(cell => cell.x), ys = object.footprint.cells.map(cell => cell.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const center = { x: (minX + maxX + 1) / 2, y: (minY + maxY + 1) / 2 };
      const width = (maxX - minX + 1) * TILE, height = (maxY - minY + 1) * TILE;
      const selected = projection.selection?.kind === object.kind && projection.selection.id === object.id;
      const signature = JSON.stringify([object, selected, this.locale]);
      if (view.signature !== signature) { this.drawExpansion(view, object, selected, center, width, height); view.signature = signature; }
      view.container.setPosition(ORIGIN.x + center.x * TILE, ORIGIN.y + center.y * TILE).setDepth((maxY + 0.5) * TILE);
    }
    for (const [key, view] of this.expansionViews) if (!present.has(key)) { view.container.destroy(); this.expansionViews.delete(key); }
  }

  private syncPlacement(projection: SectRendererSnapshot): void {
    const signature = JSON.stringify(projection.placement);
    if (signature === this.placementSignature) return;
    this.placementSignature = signature;
    const art = this.placementArt!; art.clear();
    const preview = projection.placement; if (!preview) return;
    const color = preview.allowed ? 0xc3efc4 : 0xebac8f;
    const cells = preview.footprint?.cells ?? [preview.anchor];
    for (const cell of cells) {
      const x = ORIGIN.x + cell.x * TILE, y = ORIGIN.y + cell.y * TILE;
      art.fillStyle(color, 0.16).fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
      art.lineStyle(3, color, 0.95).strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
      // Shape, not color alone, distinguishes an invalid advisory footprint.
      if (!preview.allowed) art.lineStyle(2, color, 0.9).lineBetween(x + 17, y + 17, x + 47, y + 47).lineBetween(x + 47, y + 17, x + 17, y + 47);
    }
    if (preview.footprint) {
      const entrance = preview.footprint.entrance;
      const x = ORIGIN.x + (entrance.x + 0.5) * TILE, y = ORIGIN.y + (entrance.y + 0.5) * TILE;
      art.lineStyle(3, color, 1).strokeCircle(x, y, 15);
      art.lineBetween(x - 8, y, x + 8, y).lineBetween(x, y - 8, x, y + 8);
    }
  }

  private sync(): void {
    const projection = this.source.getSnapshot();
    const signature = `${projection.map.seed}:${projection.map.navVersion}:${projection.map.width}:${projection.map.height}`;
    if (this.mapSignature !== signature) { this.drawMap(projection); this.mapSignature = signature; }
    const present = new Set<string>();
    for (const building of projection.buildings) {
      const key = sectRenderEntityKey({ kind: 'building', id: building.id });
      present.add(key);
      const view = this.entityViews.get(key) ?? this.createView(building.id, 'building', `building-${building.blueprintId}`);
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
    this.syncExpansion(projection);
    this.syncPlacement(projection);
    projection.disciples.forEach((disciple) => {
      const key = sectRenderEntityKey({ kind: 'disciple', id: disciple.id });
      present.add(key);
      const view = this.entityViews.get(key) ?? this.createView(disciple.id, 'disciple', disciple.presentationId);
      if (view.sprite.texture.key !== disciple.presentationId) view.sprite.setTexture(disciple.presentationId);
      const work = disciple.work;
      const selected = projection.selection?.kind === 'disciple' && projection.selection.id === disciple.id;
      const progress = sectVisualWorkProgress(work);
      const next = `${selected}:${progress}:${work?.blocked}:${disciple.lifeState}:${this.locale}`;
      if (view.signature !== next) {
        this.drawMarker(view, selected, progress, work?.blocked === true, false);
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
        const walking = disciple.traveling && work?.blocked !== true && disciple.lifeState === 'alive';
        const pose = walking ? Math.floor(projection.clock.simulationTick / 2) % CHARACTER_FRAME.poses : 0;
        view.sprite.setFrame(view.direction * CHARACTER_FRAME.poses + pose);
      }
      view.lastX = disciple.position.x; view.lastY = disciple.position.y;
      view.label.setVisible(selected || view.hovered || disciple.lifeState !== 'alive');
      // No position tween, predicted path, decorative wandering or synthetic progress.
      view.container.setPosition(ORIGIN.x + disciple.position.x * TILE + TILE / 2, ORIGIN.y + disciple.position.y * TILE + TILE / 2).setDepth(disciple.position.y * TILE + 1);
    });
    for (const [id, view] of this.entityViews) if (!present.has(id)) { view.container.destroy(); this.entityViews.delete(id); }
    const selection = projection.selection ? sectRenderEntityKey(projection.selection) : '';
    if (this.zoom > 1.25 && selection && selection !== this.previousSelection) {
      const view = this.entityViews.get(selection) ?? this.expansionViews.get(selection);
      if (view) { this.cameraTarget = { x: view.container.x, y: view.container.y - 45 }; this.cameras.main.centerOn(this.cameraTarget.x, this.cameraTarget.y); }
    }
    this.previousSelection = selection;
  }
}

export interface SectRenderer { setLocale(locale: Locale): void; setZoom(zoom: number): void; resetView(): void; destroy(): void }
export function mountSectWorld(parent: HTMLElement, source: SectRendererSource | LegacySectRendererSession, locale: Locale): SectRenderer {
  const scene = new SectScene(asSectRendererSource(source), locale, parent.clientWidth < 620 ? 1.8 : DEFAULT_ZOOM);
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent, width: SIZE.width, height: SIZE.height,
    scene: [scene], backgroundColor: '#91aca0', pixelArt: true, roundPixels: true,
    banner: false, autoFocus: false, audio: { noAudio: true },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  });
  let destroyed = false;
  return { setLocale: (next) => { if (!destroyed) scene.setLocale(next); }, setZoom: (zoom) => { if (!destroyed) scene.setZoom(zoom); },
    resetView: () => { if (!destroyed) scene.resetView(); }, destroy: () => { if (!destroyed) { destroyed = true; game.destroy(true); } } };
}
