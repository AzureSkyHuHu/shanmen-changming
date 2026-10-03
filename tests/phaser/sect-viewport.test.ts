import { describe, expect, it } from 'vitest';
import { clampSectViewportZoom, SECT_VIEWPORT_ZOOM, SECT_WORLD_SIZE, sectViewportContains, sectViewportFrame } from '../../src/phaser/sect-viewport';

const center = { x: SECT_WORLD_SIZE.width / 2, y: SECT_WORLD_SIZE.height / 2 };
const viewports = [[1110, 420], [1840, 600], [375, 320], [400, 340], [500, 425], [1740, 368], [320, 480], [1152, 768]] as const;

describe('presentation-only responsive sect viewport', () => {
  it.each(viewports)('fills a %s by %s viewport at normal zoom without stretching world axes', (width, height) => {
    const frame = sectViewportFrame(width, height, SECT_VIEWPORT_ZOOM.initial, center)!;
    expect(frame).not.toBeNull();
    expect(frame.width).toBe(width); expect(frame.height).toBe(height);
    expect(frame.visible.width).toBeLessThanOrEqual(SECT_WORLD_SIZE.width);
    expect(frame.visible.height).toBeLessThanOrEqual(SECT_WORLD_SIZE.height);
    expect(frame.visible.width * frame.zoom).toBeCloseTo(width);
    expect(frame.visible.height * frame.zoom).toBeCloseTo(height);
    expect(frame.bounds).toEqual({ x: 0, y: 0, ...SECT_WORLD_SIZE });
    expect(frame.center).toEqual(center);
  });

  it.each(viewports)('offers a centered complete-world overview at %s by %s even after focusing an edge', (width, height) => {
    const frame = sectViewportFrame(width, height, SECT_VIEWPORT_ZOOM.minimum, { x: 32, y: 736 })!;
    expect(frame.center).toEqual(center);
    expect(sectViewportContains(frame, { x: 0, y: 0, ...SECT_WORLD_SIZE }, 0)).toBe(true);
    expect(frame.visible.x).toBeLessThan(0); expect(frame.visible.y).toBeLessThan(0);
    expect(frame.bounds.width).toBeCloseTo(frame.visible.width);
    expect(frame.bounds.height).toBeCloseTo(frame.visible.height);
    expect(frame.bounds.x).toBeCloseTo(frame.visible.x);
    expect(frame.bounds.y).toBeCloseTo(frame.visible.y);
  });

  it.each(viewports)('keeps every logical zoom step effective and continuous at %s by %s', (width, height) => {
    let previous = 0;
    for (const zoom of [0.85, 0.95, 1.1, 1.25, 1.4, 1.55, 1.7, 1.85, 2, 2.15, 2.2]) {
      const frame = sectViewportFrame(width, height, zoom, center)!;
      expect(frame.zoom).toBeGreaterThan(previous); previous = frame.zoom;
    }
    const normal = sectViewportFrame(width, height, 1.1, center)!;
    expect(sectViewportFrame(width, height, 1.1 - 1e-9, center)!.zoom).toBeCloseTo(normal.zoom, 7);
    expect(sectViewportFrame(width, height, 1.1 + 1e-9, center)!.zoom).toBeCloseTo(normal.zoom, 7);
  });

  it('clamps the viewed center without rewriting the retained target or world coordinates', () => {
    const target = Object.freeze({ x: 950, y: 630 });
    const initial = sectViewportFrame(1110, 420, 1.1, target)!;
    const narrow = sectViewportFrame(400, 340, 1.1, target)!;
    const restored = sectViewportFrame(1110, 420, 1.1, target)!;
    expect(restored).toEqual(initial); expect(narrow.center).not.toEqual(initial.center);
    for (const frame of [initial, narrow]) {
      expect(frame.visible.x).toBeGreaterThanOrEqual(0);
      expect(frame.visible.y).toBeGreaterThanOrEqual(0);
      expect(frame.visible.x + frame.visible.width).toBeLessThanOrEqual(SECT_WORLD_SIZE.width + 1e-9);
      expect(frame.visible.y + frame.visible.height).toBeLessThanOrEqual(SECT_WORLD_SIZE.height + 1e-9);
    }
    expect(target).toEqual({ x: 950, y: 630 });
    expect(SECT_WORLD_SIZE).toEqual({ width: 1152, height: 768 });
  });

  it.each([[0, 420], [1110, 0], [-1, 400], [NaN, 400], [400, Infinity], [0.5, 300]])('ignores an unavailable host size %s by %s', (width, height) => {
    expect(sectViewportFrame(width, height, 1.1, center)).toBeNull();
  });

  it('normalizes invalid logical zoom/target values and clamps explicit bounds', () => {
    expect(clampSectViewportZoom(-10)).toBe(0.85); expect(clampSectViewportZoom(99)).toBe(2.2);
    for (const zoom of [NaN, Infinity, -Infinity]) {
      expect(clampSectViewportZoom(zoom)).toBe(1.1);
      expect(sectViewportFrame(1110, 420, zoom, { x: NaN, y: Infinity })).toEqual(sectViewportFrame(1110, 420, 1.1, center));
    }
  });

  it('checks artwork extent and a CSS-pixel inset, rather than only the feet point', () => {
    const frame = sectViewportFrame(1110, 420, 1.1, center)!;
    expect(sectViewportContains(frame, { x: center.x - 40, y: center.y - 80, width: 80, height: 120 })).toBe(true);
    expect(sectViewportContains(frame, { x: center.x - 40, y: frame.visible.y - 1, width: 80, height: 120 })).toBe(false);
    const edge = { x: frame.visible.x, y: center.y, width: 1, height: 1 };
    expect(sectViewportContains(frame, edge)).toBe(false);
    expect(sectViewportContains(frame, edge, 0)).toBe(true);
  });
});
