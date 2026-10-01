import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import type { SectCell } from '../../content/sect-v9/types';
import { SECT_ROTATIONS, type SectGeometryResult } from './types';

/** This is intentionally ID-only: caller-authored footprint/entrance definitions never execute. */
export function deriveSectFootprint(input: unknown): SectGeometryResult {
  if (!ownSectFields(input, ['definitionId', 'anchor', 'rotation'])) return { ok: false, code: 'INVALID_REQUEST' };
  const definition = typeof input.definitionId === 'string' ? getSectBuildingDefinition(input.definitionId) : undefined;
  if (!definition) return { ok: false, code: 'UNKNOWN_DEFINITION' };
  if (!ownSectFields(input.anchor, ['x', 'y']) || !Number.isSafeInteger(input.anchor.x) || !Number.isSafeInteger(input.anchor.y)
    || (input.anchor.x as number) < 0 || (input.anchor.y as number) < 0
    || (input.anchor.x as number) > 255 || (input.anchor.y as number) > 255) return { ok: false, code: 'INVALID_ANCHOR' };
  if (typeof input.rotation !== 'number' || !SECT_ROTATIONS.some(rotation => rotation === input.rotation)) return { ok: false, code: 'INVALID_ROTATION' };
  const anchor = input.anchor as unknown as SectCell;
  const rotate = (cell: SectCell): SectCell => {
    let { x, y } = cell;
    for (let turn = 0; turn < (input.rotation as number) / 90; turn += 1) [x, y] = [1 - y, x];
    return { x: anchor.x + x, y: anchor.y + y };
  };
  const cells = [rotate({ x: 0, y: 0 }), rotate({ x: 1, y: 0 }), rotate({ x: 0, y: 1 }), rotate({ x: 1, y: 1 })]
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return { ok: true, footprint: { cells, entrance: rotate(definition.footprint.entrance) } };
}

/** Small structural guard shared by the query layer; reads no accessors or inherited fields. */
export function ownSectFields(value: unknown, fields: readonly string[], exact = true): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (exact && Reflect.ownKeys(value).length !== fields.length) return false;
  return fields.every(field => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return !!descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  });
}
