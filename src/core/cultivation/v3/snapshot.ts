import { canonicalStringify, cloneJson, stableHash } from '../../kernel/serialization';
import type { CultivationFrame } from './types';
import { validateCultivationFrameV3 } from './validation';
export function serializeCultivationV3(frame: CultivationFrame): string {
  if (validateCultivationFrameV3(frame).length) throw new TypeError('Invalid cultivation v3 state');
  const text = canonicalStringify({ format: 'shanmen-cultivation', version: 3, frame, checksum: stableHash(frame) });
  if (text.length > 4_000_000) throw new RangeError('Cultivation snapshot exceeds limit'); return text;
}
export function restoreCultivationV3(text: string): CultivationFrame {
  if (typeof text !== 'string' || text.length > 4_000_000) throw new TypeError('Invalid cultivation snapshot size');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'checksum,format,frame,version') throw new TypeError('Invalid cultivation snapshot');
  const envelope = value as { format: string; version: number; checksum: string; frame: CultivationFrame };
  if (envelope.format !== 'shanmen-cultivation' || envelope.version !== 3 || envelope.checksum !== stableHash(envelope.frame)
    || validateCultivationFrameV3(envelope.frame).length) throw new TypeError('Invalid cultivation snapshot');
  return cloneJson(envelope.frame);
}
