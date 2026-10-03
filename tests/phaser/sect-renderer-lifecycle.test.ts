import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SectRendererSnapshot, SectRendererSource } from '../../src/phaser/sect-renderer-contract';
import { SECT_WORLD_SIZE, sectViewportFrame } from '../../src/phaser/sect-viewport';
import type { PhaserWorldProps } from '../../src/phaser/PhaserWorld';

/** Lifecycle/viewport contract only; real Phaser input transforms still need browser QA. */
const harness = vi.hoisted(() => ({ objects: [] as any[], games: [] as any[], automaticCreate: true }));
const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0, pending: [] as Array<{ index: number; callback: () => any; cleanup: (() => void) | undefined }> }));
// A small hook contract harness for pre-import commands and effect cleanup.
// This deliberately does not claim to exercise React DOM, focus or browser input.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) => a !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...actual,
    useState: (initial: any) => { const index = hooks.index++; if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.slots[index], (next: any) => { hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next; }]; },
    useRef: (initial: any) => { const index = hooks.index++; return hooks.slots[index] ??= { current: initial }; },
    useMemo: (factory: () => any, dependencies: readonly unknown[]) => { const index = hooks.index++, previous = hooks.slots[index];
      if (!previous || !same(previous.dependencies, dependencies)) hooks.slots[index] = { value: factory(), dependencies }; return hooks.slots[index].value; },
    useEffect: (callback: () => any, dependencies: readonly unknown[]) => { const index = hooks.index++, previous = hooks.slots[index];
      if (!previous || !same(previous.dependencies, dependencies)) { hooks.pending.push({ index, callback, cleanup: previous?.cleanup }); hooks.slots[index] = { dependencies }; } },
  };
});
vi.mock('phaser', () => {
  class Emitter {
    listeners = new Map<string, Array<{ callback: (...args: any[]) => void; context: any; once: boolean }>>();
    on(name: string, callback: (...args: any[]) => void, context?: any) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), { callback, context, once: false }]); return this; }
    once(name: string, callback: (...args: any[]) => void, context?: any) { this.on(name, callback, context); this.listeners.get(name)!.at(-1)!.once = true; return this; }
    off(name: string, callback: (...args: any[]) => void, context?: any) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(entry => entry.callback !== callback || entry.context !== context)); return this; }
    emit(name: string, ...args: any[]) { for (const entry of [...(this.listeners.get(name) ?? [])]) { if (entry.once) this.off(name, entry.callback, entry.context); entry.callback.apply(entry.context, args); } }
    listenerCount(name: string) { return this.listeners.get(name)?.length ?? 0; }
  }
  function display(kind: string, args: any[] = []): any {
    const emitter = new Emitter();
    const state: Record<string, any> = { kind, x: args[0] ?? 0, y: args[1] ?? 0, width: args[2] ?? 0, height: args[3] ?? 0,
      texture: { key: args[2] }, children: kind === 'container' ? args[2] ?? [] : [], destroyed: false, calls: [] as any[], emitter };
    const object = new Proxy(state, { get(target, method: string) {
      if (method in target) return target[method];
      return (...values: any[]) => {
        target.calls.push([method, ...values]);
        if (method === 'setPosition') { target.x = values[0]; target.y = values[1]; }
        else if (method === 'setSize') { target.width = values[0]; target.height = values[1]; }
        else if (method === 'setTexture') target.texture.key = values[0];
        else if (method === 'setZoom') target.zoom = values[0];
        else if (method === 'centerOn') target.center = { x: values[0], y: values[1] };
        else if (method === 'setBounds') target.bounds = { x: values[0], y: values[1], width: values[2], height: values[3] };
        else if (method === 'setDepth') target.depth = values[0];
        else if (method === 'setText') target.text = values[0];
        else if (method === 'add') target.children.push(values[0]);
        else if (method === 'removeAll') { if (values[0]) for (const child of target.children) child.destroy(); target.children = []; }
        else if (method === 'destroy') { target.destroyed = true; for (const child of target.children) child.destroy(); }
        else if (method === 'on') emitter.on(values[0], values[1]);
        return object;
      };
    } });
    harness.objects.push(object); return object;
  }
  class Scene {
    add = { graphics: () => display('graphics'), container: (...args: any[]) => display('container', args), image: (...args: any[]) => display('image', args),
      sprite: (...args: any[]) => display('sprite', args), text: (...args: any[]) => display('text', args), rectangle: (...args: any[]) => display('rectangle', args) };
    cameras = { main: display('camera') };
    load = { spritesheet: () => undefined, image: () => undefined };
    events = new Emitter(); input = new Emitter();
    scale = Object.assign(new Emitter(), { gameSize: { width: 1152, height: 768 } });
  }
  class Game {
    scene: any; config: any; canvas: { width: number; height: number }; created = false; destroyed = false;
    constructor(config: any) {
      this.config = config; this.scene = config.scene[0]; harness.games.push(this);
      this.canvas = { width: config.width, height: config.height };
      this.scene.scale.gameSize = { width: config.width, height: config.height };
      this.scene.cameras.main.setSize(config.width, config.height);
      this.scene.preload(); if (harness.automaticCreate) this.boot();
    }
    boot() { if (!this.destroyed && !this.created) { this.created = true; this.scene.create(); } }
    resize(width: number, height: number) {
      const previous = this.scene.scale.gameSize, camera = this.scene.cameras.main;
      this.canvas = { width, height }; this.scene.scale.gameSize = { width, height };
      // Phaser's ScaleManager resizes the canvas and CameraManager handles the
      // event before our scene listener, including a zero-sized hidden host.
      if (camera.x === 0 && camera.y === 0 && camera.width === previous.width && camera.height === previous.height) camera.setSize(width, height);
      this.scene.scale.emit('resize', this.scene.scale.gameSize);
    }
    destroy() { this.destroyed = true; this.scene.events.emit('shutdown'); this.scene.events.emit('destroy'); }
  }
  return { default: { Scene, Game, AUTO: 0, Math: { Vector2: class { constructor(public x: number, public y: number) {} } },
    Scenes: { Events: { SHUTDOWN: 'shutdown', DESTROY: 'destroy' } }, Scale: { FIT: 1, RESIZE: 2, CENTER_BOTH: 3, NO_CENTER: 0, Events: { RESIZE: 'resize' } } } };
});
import { mountSectWorld } from '../../src/phaser/create-sect-game';
import { PhaserWorld } from '../../src/phaser/PhaserWorld';

const worldCenter = { x: 576, y: 384 };
const parent = (width = 1110, height = 420) => ({ clientWidth: width, clientHeight: height }) as HTMLElement;
function sourceFixture() {
  let snapshot: SectRendererSnapshot = { map: { seed: 'viewport-fixture', navVersion: 0, width: 14, height: 10, tiles: [] },
    buildings: [{ id: 'top', blueprintId: 'housing', nameKey: 'building.housing', x: 7, y: 0, operational: true },
      { id: 'bottom', blueprintId: 'storage', nameKey: 'building.storage', x: 12, y: 9, operational: true }],
    disciples: [], expansion: [], selection: null, clock: { simulationTick: 0 }, paused: true, placement: null };
  const listeners = new Set<() => void>(), stop = vi.fn(), onPlacementCell = vi.fn();
  const source: SectRendererSource = { rendererContract: 'sect-renderer.1', getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); stop(); }; },
    select: selection => { snapshot = { ...snapshot, selection }; for (const listener of listeners) listener(); }, onPlacementCell };
  return { source, stop, listeners, onPlacementCell, change: (patch: Partial<SectRendererSnapshot>) => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); } };
}
beforeEach(() => { harness.objects.length = 0; harness.games.length = 0; harness.automaticCreate = true; hooks.slots = []; hooks.index = 0; hooks.pending = []; });

describe('opt-in sect renderer viewport lifecycle', () => {
  it('preserves fixed FIT dimensions, mobile default, reset and no resize subscription for legacy callers', () => {
    const fixture = sourceFixture(); const renderer = mountSectWorld(parent(400, 340), fixture.source, 'zh-CN');
    const game = harness.games[0], camera = game.scene.cameras.main;
    expect(game.config.scale).toEqual({ mode: 1, autoCenter: 3 });
    expect(game.config.width).toBe(1152); expect(game.config.height).toBe(768);
    expect(camera.zoom).toBe(1.8); expect(camera.center).toEqual(worldCenter);
    expect(game.scene.scale.listenerCount('resize')).toBe(0);
    renderer.setZoom(1.1); fixture.source.select({ kind: 'building', id: 'bottom' });
    expect(camera.center).toEqual(worldCenter);
    renderer.resetView(); expect(camera.zoom).toBe(1.8); renderer.destroy();
  });

  it('fills the actual host, resizes its camera and retains logical zoom without changing world objects', () => {
    const fixture = sourceFixture(); const before = fixture.source.getSnapshot();
    const renderer = mountSectWorld(parent(), fixture.source, 'zh-CN', { responsiveViewport: true });
    const game = harness.games[0], camera = game.scene.cameras.main;
    expect(game.config.scale).toEqual({ mode: 2, autoCenter: 0 });
    expect(game.config.width).toBe(1110); expect(game.config.height).toBe(420);
    expect(camera.zoom).toBeCloseTo(sectViewportFrame(1110, 420, 1.1, worldCenter)!.zoom);
    const objects = harness.objects.filter(object => object.kind === 'container').map(object => [object, object.x, object.y]);
    renderer.setZoom(1.55); game.resize(400, 340);
    expect(camera.width).toBe(400); expect(camera.height).toBe(340);
    expect(camera.zoom).toBeCloseTo(sectViewportFrame(400, 340, 1.55, worldCenter)!.zoom);
    expect(objects.every(([object, x, y]) => object.x === x && object.y === y)).toBe(true);
    expect(fixture.source.getSnapshot()).toBe(before);
    renderer.resetView(); expect(camera.zoom).toBeCloseTo(sectViewportFrame(400, 340, 1.1, worldCenter)!.zoom);
    renderer.destroy();
  });

  it('replays pre-create zoom intent and reset, then reaches a centered overview in a short wide viewport', () => {
    harness.automaticCreate = false;
    const fixture = sourceFixture(); const renderer = mountSectWorld(parent(1740, 368), fixture.source, 'zh-CN', { responsiveViewport: true, zoom: 1.4 });
    const game = harness.games[0], camera = game.scene.cameras.main;
    renderer.setZoom(2); renderer.resetView(); renderer.setZoom(0.85); game.boot();
    const frame = sectViewportFrame(1740, 368, 0.85, worldCenter)!;
    expect(camera.zoom).toBeCloseTo(frame.zoom); expect(camera.center).toEqual(worldCenter);
    expect(camera.bounds).toEqual(frame.bounds);
    expect(frame.visible.width).toBeGreaterThan(SECT_WORLD_SIZE.width);
    expect(frame.visible.height).toBeGreaterThan(SECT_WORLD_SIZE.height);
    renderer.destroy();
  });

  it('centers newly off-screen selections at default zoom and keeps the target through resize and overview', () => {
    const fixture = sourceFixture(); const renderer = mountSectWorld(parent(), fixture.source, 'zh-CN', { responsiveViewport: true });
    const game = harness.games[0], camera = game.scene.cameras.main;
    fixture.source.select({ kind: 'building', id: 'bottom' });
    const target = { x: 128 + 12 * 64 + 32, y: 68 + 9 * 64 + 32 - 45 };
    expect(camera.center).toEqual(sectViewportFrame(1110, 420, 1.1, target)!.center);
    game.resize(400, 340);
    expect(camera.center).toEqual(sectViewportFrame(400, 340, 1.1, target)!.center);
    renderer.setZoom(0.85); expect(camera.center).toEqual(worldCenter);
    renderer.setZoom(1.1); expect(camera.center).toEqual(sectViewportFrame(400, 340, 1.1, target)!.center);
    renderer.resetView(); expect(camera.center).toEqual(worldCenter);
    fixture.change({ paused: false }); expect(camera.center).toEqual(worldCenter);
    renderer.destroy();
  });

  it('keeps world-coordinate placement unchanged and does not turn sprite selection into a placement command', () => {
    const fixture = sourceFixture(); fixture.change({ placement: { anchor: { x: 2, y: 3 }, footprint: null, allowed: true } });
    const renderer = mountSectWorld(parent(), fixture.source, 'zh-CN', { responsiveViewport: true });
    const game = harness.games[0];
    game.resize(400, 340); renderer.setZoom(0.85);
    game.scene.input.emit('pointerdown', { worldX: 128 + 13 * 64 + 32, worldY: 68 + 9 * 64 + 32 });
    expect(fixture.onPlacementCell).toHaveBeenCalledExactlyOnceWith({ x: 13, y: 9 });
    const hit = harness.objects.find(object => object.kind === 'rectangle');
    hit.emitter.emit('pointerdown'); expect(fixture.source.getSnapshot().selection).toBeNull();
    game.scene.input.emit('pointerdown', { worldX: 0, worldY: 0 });
    expect(fixture.onPlacementCell).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it('recovers logical zoom and target after Phaser collapses a hidden viewport, and disposes listeners once', () => {
    const fixture = sourceFixture(); const renderer = mountSectWorld(parent(), fixture.source, 'zh-CN', { responsiveViewport: true });
    const game = harness.games[0], camera = game.scene.cameras.main;
    const queuedResize = game.scene.scale.listeners.get('resize')[0];
    renderer.setZoom(1.55); fixture.source.select({ kind: 'building', id: 'bottom' });
    const target = { x: 128 + 12 * 64 + 32, y: 68 + 9 * 64 + 32 - 45 };
    const originalZoom = camera.zoom;
    game.resize(0, 0);
    expect(game.canvas).toEqual({ width: 0, height: 0 });
    expect(camera.width).toBe(0); expect(camera.height).toBe(0); expect(camera.zoom).toBe(originalZoom);
    game.resize(500, 425);
    const recovered = sectViewportFrame(500, 425, 1.55, target)!;
    expect(camera.width).toBe(500); expect(camera.height).toBe(425);
    expect(camera.zoom).toBeCloseTo(recovered.zoom); expect(camera.center).toEqual(recovered.center);
    expect(camera.bounds).toEqual(recovered.bounds);
    expect(fixture.source.getSnapshot().selection).toEqual({ kind: 'building', id: 'bottom' });
    expect(game.scene.scale.listenerCount('resize')).toBe(1);
    renderer.destroy(); renderer.destroy();
    expect(fixture.stop).toHaveBeenCalledTimes(1); expect(fixture.listeners.size).toBe(0);
    expect(game.scene.scale.listenerCount('resize')).toBe(0); expect(game.scene.input.listenerCount('pointerdown')).toBe(0);
    const calls = camera.calls.length;
    queuedResize.callback.call(queuedResize.context, { width: 900, height: 500 });
    renderer.setZoom(2); renderer.resetView(); renderer.setLocale('en');
    game.scene.scale.emit('resize', { width: 900, height: 500 });
    expect(camera.calls).toHaveLength(calls);
  });

  it('disposes safely during preload without subscribing or creating another world', () => {
    harness.automaticCreate = false;
    const fixture = sourceFixture(); const renderer = mountSectWorld(parent(), fixture.source, 'zh-CN', { responsiveViewport: true, zoom: 1.4 });
    const game = harness.games[0]; renderer.destroy(); game.boot();
    expect(game.created).toBe(false); expect(fixture.listeners.size).toBe(0); expect(fixture.stop).not.toHaveBeenCalled();
  });
});

function componentNodes(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return [];
  const children = tree.props?.children;
  return [tree, ...(Array.isArray(children) ? children : [children]).flatMap(componentNodes)];
}
function renderWorld(props: PhaserWorldProps, host = parent(400, 340)) {
  hooks.index = 0;
  const tree = PhaserWorld(props), nodes = componentNodes(tree);
  nodes.find(node => node.props?.className === 'world-canvas').props.ref.current = host;
  const pending = hooks.pending.splice(0);
  for (const effect of pending) { effect.cleanup?.(); hooks.slots[effect.index].cleanup = effect.callback(); }
  const buttons = nodes.filter(node => node.type === 'button');
  return { minus: buttons[0], reset: buttons[1], plus: buttons[2], tree };
}
function unmountWorld() { for (const slot of hooks.slots) if (typeof slot?.cleanup === 'function') { slot.cleanup(); slot.cleanup = undefined; } }

describe('responsive React camera-control intent', () => {
  it('keeps rapid pre-import clicks coherent with the first narrow-host camera and button limits', async () => {
    const fixture = sourceFixture(), props: PhaserWorldProps = { source: fixture.source, locale: 'zh-CN', responsiveViewport: true };
    let controls = renderWorld(props);
    controls.plus.props.onClick(); controls.plus.props.onClick();
    await vi.dynamicImportSettled();
    const game = harness.games[0], camera = game.scene.cameras.main;
    expect(camera.zoom).toBeCloseTo(sectViewportFrame(400, 340, 1.4, worldCenter)!.zoom);
    controls = renderWorld(props);
    for (let index = 0; index < 10; index++) controls.minus.props.onClick();
    controls = renderWorld(props); expect(controls.minus.props.disabled).toBe(true);
    expect(camera.zoom).toBeCloseTo(sectViewportFrame(400, 340, 0.85, worldCenter)!.zoom);
    controls.reset.props.onClick(); controls = renderWorld(props);
    expect(controls.minus.props.disabled).toBe(false);
    expect(camera.zoom).toBeCloseTo(sectViewportFrame(400, 340, 1.1, worldCenter)!.zoom);
    expect(harness.games).toHaveLength(1); unmountWorld();
  });

  it('applies a reset before async mount and retains later user zoom across a source replacement', async () => {
    const first = sourceFixture(), props: PhaserWorldProps = { source: first.source, locale: 'zh-CN', responsiveViewport: true };
    let controls = renderWorld(props);
    controls.plus.props.onClick(); controls.reset.props.onClick();
    await vi.dynamicImportSettled();
    const firstGame = harness.games[0];
    expect(firstGame.scene.cameras.main.zoom).toBeCloseTo(sectViewportFrame(400, 340, 1.1, worldCenter)!.zoom);
    controls = renderWorld(props);
    controls.plus.props.onClick(); controls.plus.props.onClick(); controls.plus.props.onClick();
    const next = sourceFixture(); renderWorld({ ...props, source: next.source, locale: 'en' });
    expect(firstGame.destroyed).toBe(true); expect(first.stop).toHaveBeenCalledTimes(1);
    await vi.dynamicImportSettled();
    expect(harness.games).toHaveLength(2);
    expect(harness.games[1].scene.cameras.main.zoom).toBeCloseTo(sectViewportFrame(400, 340, 1.55, worldCenter)!.zoom);
    unmountWorld(); expect(next.stop).toHaveBeenCalledTimes(1);
  });

  it('does not mount an abandoned import after React cleanup', async () => {
    const fixture = sourceFixture(); renderWorld({ source: fixture.source, locale: 'zh-CN', responsiveViewport: true });
    unmountWorld(); await vi.dynamicImportSettled();
    expect(harness.games).toHaveLength(0); expect(fixture.listeners.size).toBe(0);
  });
});
