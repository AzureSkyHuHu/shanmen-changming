import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BattleEvent } from '../../src/core/combat';
import type { BattleRenderSnapshot, BattleUnitView, BattleZoneView } from '../../src/phaser/PhaserBattle';

/** A lifecycle contract harness, not a browser/Canvas visual-acceptance substitute. */
const harness = vi.hoisted(() => ({ objects: [] as Array<Record<string, any>>, scenes: [] as Array<any>, loaded: [] as string[] }));
vi.mock('phaser', () => {
  function display(kind: string, args: any[] = []): any {
    const state: Record<string, any> = { kind, args, destroyed: false, drawOps: 0, x: args[0] ?? 0, y: args[1] ?? 0, frame: 0, text: kind === 'text' ? args[2] : '', children: kind === 'container' ? args[2] : [], listeners: {} };
    const view = new Proxy(state, { get(target, method: string) {
      if (method in target) return target[method];
      return (...values: any[]) => {
        if (method === 'destroy') { target.destroyed = true; for (const child of target.children) child.destroy(); }
        else if (method === 'clear') target.drawOps = 0;
        else if (method === 'setText') target.text = values[0];
        else if (method === 'setFrame') target.frame = values[0];
        else if (method === 'setPosition') { target.x = values[0]; target.y = values[1]; }
        else if (method === 'setY') target.y = values[0];
        else if (method === 'setDepth') target.depth = values[0];
        else if (method === 'on') target.listeners[values[0]] = values[1];
        else if (/^(?:fill|stroke|line)/.test(method)) target.drawOps++;
        return view;
      };
    } });
    harness.objects.push(view); return view;
  }
  class Scene {
    add = { graphics: () => display('graphics'), sprite: (...args: any[]) => display('sprite', args), text: (...args: any[]) => display('text', args), rectangle: (...args: any[]) => display('rectangle', args), container: (...args: any[]) => display('container', args) };
    cameras = { main: display('camera') };
    load = { spritesheet: (key: string) => harness.loaded.push(key) };
    listeners = new Map<string, (() => void)[]>();
    events = { once: (name: string, callback: () => void) => this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]) };
  }
  class Game {
    scene: any;
    constructor(config: any) { this.scene = config.scene[0]; harness.scenes.push(this.scene); this.scene.preload(); this.scene.create(); }
    destroy() { for (const callback of this.scene.listeners.get('shutdown') ?? []) callback(); for (const object of harness.objects) if (!object.destroyed) object.destroy(); }
  }
  return { default: { Scene, Game, Math: { Vector2: class { constructor(public x: number, public y: number) {} } }, Scenes: { Events: { SHUTDOWN: 'shutdown', DESTROY: 'destroy' } }, Scale: { FIT: 1, CENTER_BOTH: 2 }, AUTO: 0 } };
});
import { mountBattleGame } from '../../src/phaser/create-battle-game';
const arena = { origin: { x: 0, y: 0 }, widthCells: 5, heightCells: 5, cellSizeUnits: 20, blockedCells: [] };
const unit = (summon = false): BattleUnitView => ({ id: summon ? 'summon:1' : 'entity:1', kind: summon ? 'summon' : 'combatant', ally: true, name: summon ? 'Paper Substitute' : 'Disciple', art: summon ? 'paper-decoy' : 'disciple-0', summon: summon ? { casterId: 'entity:1', remainingTicks: 20, durationTicks: 40, remainingBps: 5000, lifetimeLabel: '1s remaining' } : null, x: summon ? 20 : 0, y: 0, health: summon ? 25 : 100, maximumHealth: 100, spirit: 0, maximumSpirit: 100, shield: 0, life: 'Alive', castName: null, castRemainingTicks: 0, castProgressBps: 0, targetId: null, statuses: [] });
const zone = (): BattleZoneView => ({ id: 'instance:10', number: 1, casterId: 'entity:1', ally: true, name: 'Field', anchor: { x: 40, y: 40 }, radiusUnits: 20, purpose: 'damage', targets: 'enemy', remainingTicks: 20, remainingBps: 5000, lifetimeLabel: '1s remaining', spans: [{ x: 2, y: 1, length: 1 }, { x: 1, y: 2, length: 3 }, { x: 2, y: 3, length: 1 }], cellCount: 5, canvasLabel: 'Field 1 · 1s remaining' });
const snapshot = (): BattleRenderSnapshot => ({ tick: 20, arena, units: [unit(), unit(true)], zones: [zone()], events: [], latestEventSequence: 0, selectedEntityId: null, paused: false, reducedMotion: false });
const event = (sequence: number, tick: number): BattleEvent => ({ eventId: `event:${sequence}`, sequence, tick, kind: 'damage.healthLost', actorId: 'entity:1', targetId: 'summon:1', sourceInstanceId: null, sourceDefinitionId: null, values: { actualHealthLoss: 10 }, flags: {}, statusId: null, consumedApplierIds: [], shieldInstanceId: null, reason: null, rootActionId: 'action:1', parentId: null, depth: 0, family: null, direct: true, originalTags: [], originalActorId: 'entity:1', school: null });

beforeEach(() => { harness.objects.length = 0; harness.scenes.length = 0; harness.loaded.length = 0; });
describe('readonly renderer lifecycle contract', () => {
  it('reuses bounded graphics/labels, loads no borrowed paper asset, and destroys removed zones and summons', () => {
    const renderer = mountBattleGame({} as HTMLElement, snapshot(), () => undefined);
    expect(harness.loaded).toHaveLength(9); expect(harness.loaded.some(key => key.includes('paper'))).toBe(false);
    expect(harness.objects.filter(object => object.kind === 'sprite')).toHaveLength(1);
    const count = harness.objects.length; const field = harness.objects.find(object => object.kind === 'text' && object.text.startsWith('Field 1'))!;
    const summon = harness.objects.filter(object => object.kind === 'container')[1]!; const graphics = harness.objects.find(object => object.kind === 'graphics' && object.depth === -50)!;
    const commands = graphics.drawOps;
    for (let index = 0; index < 100; index++) renderer.update(snapshot());
    expect(harness.objects).toHaveLength(count); expect(graphics.drawOps).toBe(commands);
    renderer.update({ ...snapshot(), tick: 21, units: [unit()], zones: [] });
    expect(field.destroyed).toBe(true); expect(summon.destroyed).toBe(true); expect(summon.children.every((child: any) => child.destroyed)).toBe(true); expect(graphics.drawOps).toBe(0);
    renderer.destroy(); expect(harness.objects.every(object => object.destroyed)).toBe(true);
  });
  it('freezes authoritative expiry and animation when snapshots pause or repeat, and respects reduced motion', () => {
    const initial = snapshot(); const renderer = mountBattleGame({} as HTMLElement, initial, () => undefined);
    const sprite = harness.objects.find(object => object.kind === 'sprite')!;
    const expiry = harness.objects.find(object => object.kind === 'text' && object.text === '1s remaining')!;
    const moved = { ...initial, tick: 23, units: [{ ...unit(), x: 20 }, unit(true)] };
    renderer.update(moved); const walkingFrame = sprite.frame; expect(walkingFrame % 6).not.toBe(0);
    for (let index = 0; index < 25; index++) renderer.update({ ...moved, paused: true });
    expect(sprite.frame).toBe(walkingFrame); expect(expiry.text).toBe('1s remaining');
    renderer.update({ ...moved, paused: true, reducedMotion: true }); expect(sprite.frame % 6).toBe(0);
    renderer.destroy();
  });
  it('clears retained effects, labels and old identities on rewind without replaying historical effects', () => {
    const initial = snapshot(); const renderer = mountBattleGame({} as HTMLElement, initial, () => undefined);
    renderer.update({ ...initial, tick: 21, latestEventSequence: 1, events: [event(1, 21)] });
    const number = harness.objects.find(object => object.kind === 'text' && object.text === '10')!; expect(number).toBeDefined();
    const oldContainers = harness.objects.filter(object => object.kind === 'container');
    renderer.update({ ...initial, tick: 2, latestEventSequence: 0, events: [event(0, 2)] });
    expect(number.destroyed).toBe(true); expect(oldContainers.every(object => object.destroyed)).toBe(true);
    expect(harness.objects.filter(object => object.kind === 'text' && object.text === '10' && !object.destroyed)).toHaveLength(0);
    expect(harness.objects.filter(object => object.kind === 'container' && !object.destroyed)).toHaveLength(2);
    renderer.destroy();
  });
});
