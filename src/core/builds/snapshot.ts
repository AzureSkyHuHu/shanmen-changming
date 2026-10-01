import { canonicalStringify, stableHash } from '../kernel/serialization';
import { validateBuildFrame } from './builds';
import { assertJson, copy, exact, freeze } from './shared';
import type { BuildCatalog, BuildStateFrame } from './types';

export const MAX_BUILD_SNAPSHOT_CHARS = 4_000_000;
/** The outer World save must commit this frame with inventory, lock, and source-adapter state. */
export function serializeBuilds(frame: BuildStateFrame, catalog: BuildCatalog): string {
  validateBuildFrame(frame, catalog);
  const text = canonicalStringify({ format: 'shanmen-builds', version: 1, frame, checksum: stableHash(frame) });
  if (text.length > MAX_BUILD_SNAPSHOT_CHARS) throw new RangeError('Build snapshot exceeds limit');
  return text;
}
/** Checksums detect corruption; deterministic history, rather than a checksum, validates semantic state. */
export function restoreBuilds(text: string, catalog: BuildCatalog): BuildStateFrame {
  if (typeof text !== 'string' || text.length > MAX_BUILD_SNAPSHOT_CHARS) throw new TypeError('Invalid build snapshot size');
  const parsed: unknown = JSON.parse(text);
  assertJson(parsed);
  if (!exact(parsed, ['format', 'version', 'frame', 'checksum']) || parsed.format !== 'shanmen-builds' || parsed.version !== 1 || parsed.checksum !== stableHash(parsed.frame)) throw new TypeError('Invalid build snapshot envelope');
  validateBuildFrame(parsed.frame, catalog);
  return freeze(copy(parsed.frame));
}
