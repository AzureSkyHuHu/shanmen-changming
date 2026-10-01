import Phaser from 'phaser';
import type { ApplicationSession, DeepReadonly, SessionProjection } from '../application/session';
import { translate, type Locale, type TextKey } from '../i18n';

const TILE = 48;
const ORIGIN = { x: 88, y: 92 };
const SIZE = { width: 848, height: 640 };
const terrainColors = { grass: 0x456248, path: 0x9b9970, forest: 0x3d5942, stone: 0x526758, water: 0x4f8891 };
const robes = [0xb99964, 0x709d9e, 0xbd7960, 0x9b95b5];
interface EntityView { container: Phaser.GameObjects.Container; art: Phaser.GameObjects.Graphics; label: Phaser.GameObjects.Text; signature: string; hovered: boolean }

/** Disposable view only. Positions, assignments and progress always come from the session. */
class SectScene extends Phaser.Scene {
  private stop: (() => void) | null = null;
  private terrain: Phaser.GameObjects.Graphics | null = null;
  private mapSignature = '';
  private entityViews = new Map<string, EntityView>();
  private ready = false;

  constructor(private readonly session: ApplicationSession, private locale: Locale) { super('sect-world'); }

  create(): void {
    this.ready = true;
    this.cameras.main.setRoundPixels(true);
    this.terrain = this.add.graphics();
    this.stop = this.session.subscribe(() => this.sync());
    const dispose = () => {
      this.stop?.(); this.stop = null; this.ready = false; this.entityViews.clear();
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, dispose);
    this.events.once(Phaser.Scenes.Events.DESTROY, dispose);
    this.sync();
  }

  setLocale(locale: Locale): void { this.locale = locale; if (this.ready) this.sync(); }

  private drawMap(projection: DeepReadonly<SessionProjection>): void {
    const graphics = this.terrain!;
    graphics.clear();
    graphics.fillStyle(0x193837).fillRect(0, 0, SIZE.width, SIZE.height);
    // Original geometric foothills, outside the authoritative tile map.
    graphics.fillStyle(0x284942).fillTriangle(0, 90, 165, 5, 340, 90).fillTriangle(402, 90, 608, 9, 848, 90);
    graphics.fillStyle(0x355448).fillTriangle(80, 92, 256, 43, 447, 92).fillTriangle(555, 92, 761, 33, 848, 92);
    graphics.fillStyle(0x233e33).fillRect(ORIGIN.x - 12, ORIGIN.y - 8, projection.map.width * TILE + 24, projection.map.height * TILE + 24);
    graphics.fillStyle(0x253c2f).fillRect(ORIGIN.x - 5, ORIGIN.y + projection.map.height * TILE, projection.map.width * TILE + 10, 14);
    for (const tile of projection.map.tiles) {
      const x = ORIGIN.x + tile.x * TILE;
      const y = ORIGIN.y + tile.y * TILE;
      graphics.fillStyle(terrainColors[tile.terrain]).fillRect(x, y, TILE, TILE);
      if (tile.terrain === 'path') {
        graphics.fillStyle(0xb4b08a, 0.5).fillRect(x + 4, y + 10, 22, 3).fillRect(x + 27, y + 33, 14, 3);
        graphics.fillStyle(0x838867, 0.6).fillRect(x + 17, y + 23, 13, 2);
      } else {
        const shade = (tile.x + tile.y) % 2 ? 0x6c8050 : 0x769260;
        graphics.fillStyle(shade, 0.45).fillRect(x + 6, y + 28, 4, 8).fillRect(x + 9, y + 25, 3, 7).fillRect(x + 34, y + 13, 3, 5);
        if (tile.terrain === 'forest') {
          graphics.fillStyle(0x304630).fillRect(x + 22, y + 17, 16, 8);
          graphics.fillStyle(0x745d43).fillRect(x + 28, y + 8, 4, 12);
          graphics.fillStyle(0x294d3b).fillRect(x + 18, y + 2, 23, 12);
          graphics.fillStyle(0x3b694b).fillRect(x + 23, y - 3, 14, 12);
          graphics.fillStyle(0x6b8652).fillRect(x + 25, y - 3, 8, 3);
        }
        if (tile.terrain === 'stone') {
          graphics.fillStyle(0x809082).fillRect(x + 24, y + 24, 14, 9).fillRect(x + 28, y + 20, 9, 5);
          graphics.fillStyle(0xb1b69a).fillRect(x + 28, y + 20, 8, 3);
        }
      }
    }
  }

  private createView(id: string, kind: 'disciple' | 'building'): EntityView {
    const art = this.add.graphics();
    const label = this.add.text(0, kind === 'disciple' ? 26 : -48, '', { fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', fontSize: '12px', color: '#f1e8cb', backgroundColor: '#203b32', padding: { x: 4, y: 3 } }).setOrigin(0.5, 0.5);
    const hit = this.add.rectangle(0, -8, kind === 'disciple' ? 32 : 44, 48, 0xffffff, 0).setInteractive({ useHandCursor: true });
    hit.on('pointerdown', () => this.session.select({ kind, id }));
    const container = this.add.container(0, 0, [art, label, hit]);
    const view = { container, art, label, signature: '', hovered: false };
    if (kind === 'disciple') {
      hit.on('pointerover', () => { view.hovered = true; label.setVisible(true); });
      hit.on('pointerout', () => { view.hovered = false; const selected = this.session.getSnapshot().selection; label.setVisible(selected?.kind === 'disciple' && selected.id === id); });
    }
    this.entityViews.set(id, view);
    return view;
  }

  private drawDisciple(view: EntityView, index: number, selected: boolean, progress: number | null, blocked: boolean): void {
    const art = view.art;
    art.clear();
    if (selected) art.lineStyle(2, 0xf1d692).strokeRect(-18, -29, 36, 48);
    art.fillStyle(0x1e332c, 0.55).fillRect(-11, 12, 23, 5);
    art.fillStyle(0x233334).fillRect(-7, 10, 5, 6).fillRect(3, 10, 5, 6);
    art.fillStyle(robes[index % robes.length]!).fillRect(-10, -9, 20, 21).fillRect(-13, -5, 5, 12).fillRect(9, -5, 5, 12);
    art.fillStyle(0xede0b8).fillRect(-2, -8, 4, 19).fillRect(-10, 4, 20, 3);
    art.fillStyle(0xd8b08a).fillRect(-7, -22, 15, 14);
    art.fillStyle(index === 3 ? 0xc9c9b2 : 0x293a36).fillRect(-8, -26, 17, 7).fillRect(-9, -20, 4, 10).fillRect(6, -20, 4, 10).fillRect(-3, -31, 7, 6);
    art.fillStyle(0x26352c).fillRect(-4, -16, 2, 2).fillRect(4, -16, 2, 2);
    if (progress !== null) {
      art.fillStyle(0x17322d).fillRect(-16, 18, 32, 4);
      art.fillStyle(blocked ? 0xddab66 : 0xe5dba2).fillRect(-16, 18, Math.max(1, Math.round(progress * 32)), 4);
    }
  }

  private drawBuilding(view: EntityView, blueprint: string, selected: boolean): void {
    const art = view.art;
    art.clear();
    if (selected) art.lineStyle(2, 0xf1d692).strokeRect(-25, -37, 50, 59);
    art.fillStyle(0x233d32, 0.75).fillRect(-22, 14, 48, 8);
    if (blueprint === 'forest') {
      art.fillStyle(0x735c3c).fillRect(-10, -19, 8, 34).fillRect(7, -6, 6, 22);
      art.fillStyle(0x284f38).fillRect(-24, -30, 35, 22).fillRect(0, -18, 25, 17);
      art.fillStyle(0x72915a).fillRect(-18, -33, 24, 7).fillRect(4, -22, 18, 7);
      art.fillStyle(0xab8757).fillRect(-20, 8, 11, 8).fillRect(-22, 4, 15, 5);
    } else if (blueprint === 'herb-garden') {
      art.fillStyle(0x8c7750).fillRect(-22, -8, 45, 27);
      art.fillStyle(0x48573a).fillRect(-19, -6, 39, 7).fillRect(-19, 4, 39, 7).fillRect(-19, 14, 39, 3);
      for (let x = -16; x < 19; x += 10) {
        art.fillStyle(0xa6b571).fillRect(x, -13, 4, 10).fillRect(x, 0, 4, 9);
        art.fillStyle(0xd3b49d).fillRect(x - 1, -14, 6, 3);
      }
    } else if (blueprint === 'storage') {
      art.fillStyle(0xb19a67).fillRect(-23, -12, 46, 30);
      art.fillStyle(0x756947).fillRect(-26, -20, 52, 10).fillRect(-18, -26, 36, 7);
      art.fillStyle(0x6c5941).fillRect(-16, -3, 13, 20).fillRect(2, -3, 16, 20);
      art.fillStyle(0xc2a46b).fillRect(-18, 3, 17, 3).fillRect(0, 3, 20, 3).fillRect(-12, -3, 3, 20).fillRect(8, -3, 3, 20);
    } else if (blueprint === 'mine') {
      art.fillStyle(0x84907c).fillRect(-23, -12, 47, 31).fillRect(-16, -23, 30, 17);
      art.fillStyle(0xb4b99a).fillRect(-14, -23, 22, 6);
      art.fillStyle(0x294139).fillRect(-9, -4, 20, 23);
      art.fillStyle(0x806c4d).fillRect(-11, -7, 24, 4).fillRect(-11, -3, 4, 22).fillRect(9, -3, 4, 22);
    } else if (blueprint === 'spirit-vein') {
      art.fillStyle(0x879b88).fillRect(-23, 7, 46, 9).fillRect(-16, 0, 32, 7);
      art.fillStyle(0x9dc9bb).fillRect(-7, -27, 14, 26).fillRect(-11, -17, 22, 13);
      art.fillStyle(0xd7e0bb).fillRect(-4, -23, 5, 20);
    } else {
      art.fillStyle(0xbca77c).fillRect(-20, -17, 40, 34);
      art.fillStyle(0x6f765a).fillRect(-25, -24, 50, 9).fillRect(-20, -30, 40, 7).fillRect(-11, -35, 23, 6);
      art.fillStyle(0xc3b987).fillRect(-20, -28, 40, 3);
      art.fillStyle(0x3e5044).fillRect(-7, -5, 14, 23).fillRect(-17, -8, 7, 8).fillRect(11, -8, 7, 8);
      art.fillStyle(0xe7c780).fillRect(12, -7, 5, 5);
      art.fillStyle(0x806846).fillRect(-21, -16, 4, 35).fillRect(17, -16, 4, 35);
      if (blueprint === 'kitchen') art.fillStyle(0x80765e).fillRect(12, -38, 7, 12);
      if (blueprint === 'workshop') art.fillStyle(0x796247).fillRect(-17, 12, 14, 8).fillRect(-20, 7, 20, 5);
    }
  }

  private sync(): void {
    const projection = this.session.getSnapshot();
    const signature = JSON.stringify(projection.map);
    if (this.mapSignature !== signature) { this.drawMap(projection); this.mapSignature = signature; }
    const present = new Set<string>();
    for (const building of projection.buildings) {
      present.add(building.id);
      const view = this.entityViews.get(building.id) ?? this.createView(building.id, 'building');
      const selected = projection.selection?.kind === 'building' && projection.selection.id === building.id;
      const next = `${building.blueprintId}:${selected}:${this.locale}`;
      if (view.signature !== next) {
        this.drawBuilding(view, building.blueprintId, selected);
        view.label.setText(translate(this.locale, building.nameKey as TextKey));
        view.signature = next;
      }
      view.container.setPosition(ORIGIN.x + building.x * TILE + TILE / 2, ORIGIN.y + building.y * TILE + TILE / 2).setDepth(building.y * TILE);
    }
    projection.disciples.forEach((disciple, index) => {
      present.add(disciple.id);
      const view = this.entityViews.get(disciple.id) ?? this.createView(disciple.id, 'disciple');
      const transaction = projection.transactions.find((entry) => entry.transactionId === disciple.assignmentTransactionId);
      const selected = projection.selection?.kind === 'disciple' && projection.selection.id === disciple.id;
      const progress = transaction ? transaction.activeTicks / transaction.requiredTicks : null;
      const next = `${selected}:${progress}:${transaction?.phase}:${transaction?.state}:${this.locale}`;
      if (view.signature !== next) {
        this.drawDisciple(view, index, selected, progress, transaction?.state === 'Blocked');
        view.label.setText(translate(this.locale, disciple.nameKey as TextKey));
        view.signature = next;
      }
      view.label.setVisible(selected || view.hovered);
      // Deliberately no decorative walking: movement must come from simulation positions.
      view.container.setPosition(ORIGIN.x + disciple.position.x * TILE + TILE / 2, ORIGIN.y + disciple.position.y * TILE + TILE / 2).setDepth(disciple.position.y * TILE + 1);
    });
    for (const [id, view] of this.entityViews) if (!present.has(id)) { view.container.destroy(); this.entityViews.delete(id); }
  }
}

export interface SectRenderer { setLocale(locale: Locale): void; destroy(): void }
export function mountSectWorld(parent: HTMLElement, session: ApplicationSession, locale: Locale): SectRenderer {
  const scene = new SectScene(session, locale);
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent, width: SIZE.width, height: SIZE.height,
    scene: [scene], backgroundColor: '#193837', pixelArt: true, roundPixels: true,
    banner: false, autoFocus: false, audio: { noAudio: true },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  });
  return { setLocale: (next) => scene.setLocale(next), destroy: () => game.destroy(true) };
}
