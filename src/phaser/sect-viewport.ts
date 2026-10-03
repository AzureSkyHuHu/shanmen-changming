/** Presentation-only geometry. These dimensions never become simulation/map authority. */
export const SECT_WORLD_SIZE = { width: 1152, height: 768 } as const;
export const SECT_VIEWPORT_ZOOM = { minimum: 0.85, initial: 1.1, maximum: 2.2, step: 0.15 } as const;

export interface SectViewportPoint { readonly x: number; readonly y: number }
export interface SectViewportRect extends SectViewportPoint { readonly width: number; readonly height: number }
export interface SectViewportFrame {
  readonly width: number; readonly height: number; readonly zoom: number;
  readonly center: SectViewportPoint;
  readonly bounds: SectViewportRect;
  readonly visible: SectViewportRect;
}

export function clampSectViewportZoom(value: number): number {
  return Number.isFinite(value) ? Math.max(SECT_VIEWPORT_ZOOM.minimum, Math.min(SECT_VIEWPORT_ZOOM.maximum, value)) : SECT_VIEWPORT_ZOOM.initial;
}

/**
 * Fill at the normal zoom, while the low end deliberately fits the whole world.
 * The short overview-to-fill interval is continuous and every zoom step changes
 * the picture, even for a very wide viewport. Above normal, zoom is proportional.
 */
export function sectViewportFrame(width: number, height: number, logicalZoom: number, target: SectViewportPoint): SectViewportFrame | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const zoom = clampSectViewportZoom(logicalZoom);
  const fit = Math.min(width / SECT_WORLD_SIZE.width, height / SECT_WORLD_SIZE.height);
  const fill = Math.max(width / SECT_WORLD_SIZE.width, height / SECT_WORLD_SIZE.height);
  const progress = (zoom - SECT_VIEWPORT_ZOOM.minimum) / (SECT_VIEWPORT_ZOOM.initial - SECT_VIEWPORT_ZOOM.minimum);
  const effectiveZoom = zoom < SECT_VIEWPORT_ZOOM.initial
    ? fit * SECT_VIEWPORT_ZOOM.minimum + (fill * SECT_VIEWPORT_ZOOM.initial - fit * SECT_VIEWPORT_ZOOM.minimum) * progress
    : fill * zoom;
  const visibleWidth = width / effectiveZoom, visibleHeight = height / effectiveZoom;
  const centerAxis = (value: number, world: number, visible: number) => visible >= world ? world / 2
    : Math.max(visible / 2, Math.min(world - visible / 2, Number.isFinite(value) ? value : world / 2));
  const center = { x: centerAxis(target.x, SECT_WORLD_SIZE.width, visibleWidth), y: centerAxis(target.y, SECT_WORLD_SIZE.height, visibleHeight) };
  // Phaser pins undersized camera bounds to their top/left edges. Symmetric
  // presentation-only padding keeps overview centered without moving the world.
  const bounds = { x: Math.min(0, (SECT_WORLD_SIZE.width - visibleWidth) / 2), y: Math.min(0, (SECT_WORLD_SIZE.height - visibleHeight) / 2),
    width: Math.max(SECT_WORLD_SIZE.width, visibleWidth), height: Math.max(SECT_WORLD_SIZE.height, visibleHeight) };
  return { width, height, zoom: effectiveZoom, center, bounds,
    visible: { x: center.x - visibleWidth / 2, y: center.y - visibleHeight / 2, width: visibleWidth, height: visibleHeight } };
}

/** Check the selected artwork, not only its ground/feet point. Padding is CSS pixels. */
export function sectViewportContains(frame: SectViewportFrame, object: SectViewportRect, padding = 12): boolean {
  const inset = Math.max(0, Number.isFinite(padding) ? padding : 0) / frame.zoom;
  const xInset = Math.min(inset, frame.visible.width / 4), yInset = Math.min(inset, frame.visible.height / 4);
  return object.x >= frame.visible.x + xInset && object.y >= frame.visible.y + yInset
    && object.x + object.width <= frame.visible.x + frame.visible.width - xInset
    && object.y + object.height <= frame.visible.y + frame.visible.height - yInset;
}
