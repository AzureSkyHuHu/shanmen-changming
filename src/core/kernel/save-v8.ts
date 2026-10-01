import { resolveContentIdentity } from '../../content/registry';
import { cloneWorldWithSharedHistory, restoreWorldHistory } from '../world/history-access';
import type { WorldStateV8 } from '../world/v8-types';
import { SIMULATION_VERSION_V8 } from '../world/create-world-v8';
import { canonicalUtf8ByteLength, utf8ByteLength, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { canonicalStringify, stableHash } from './serialization';
import { validateWorldStateV8 } from './validation';
import type { SaveMetadata, SaveErrorCode } from './save';
export const SAVE_VERSION_V8 = 8;
export interface SaveEnvelopeV8 extends SaveMetadata {
  saveVersion: typeof SAVE_VERSION_V8; simulationVersion: string; contentVersion: string; seed: string; checksum: string; payload: WorldStateV8;
}
export type ParseSaveResultV8 = { ok: true; envelope: SaveEnvelopeV8; world: WorldStateV8; migration: null }
  | { ok: false; error: { code: SaveErrorCode; message: string } };
export function createSaveEnvelopeV8(world: WorldStateV8, metadata: SaveMetadata): SaveEnvelopeV8 {
  canonicalUtf8ByteLength(world);
  const errors = validateWorldStateV8(world); if (errors.length) throw new TypeError(`Cannot snapshot invalid v8 World: ${errors.join('; ')}`);
  if (!metadata || typeof metadata.buildId !== 'string' || metadata.buildId.length < 1 || metadata.buildId.length > 128
    || typeof metadata.savedAt !== 'string' || metadata.savedAt.length < 1 || metadata.savedAt.length > 64) throw new TypeError('Invalid save metadata');
  const body = { saveVersion: SAVE_VERSION_V8, simulationVersion: SIMULATION_VERSION_V8, contentVersion: world.contentVersion, seed: world.seed,
    buildId: metadata.buildId, savedAt: metadata.savedAt, payload: cloneWorldWithSharedHistory(world) } as const;
  const envelope = { ...body, checksum: stableHash(body) };
  if (canonicalUtf8ByteLength(envelope) > SAVE_FILE_LIMIT_BYTES) throw new RangeError('Save exceeds the file size limit');
  return envelope;
}
export function serializeSaveV8(envelope: SaveEnvelopeV8): string {
  const text = canonicalStringify(envelope); if (utf8ByteLength(text) > SAVE_FILE_LIMIT_BYTES) throw new RangeError('Save exceeds the file size limit'); return text;
}
/** Strict v8 codec. A legacy file stays on the legacy codec until an explicit,
 * fully budgeted migration is chosen; this function never silently upgrades it. */
export function parseSaveV8(text: string): ParseSaveResultV8 {
  const fail = (code: SaveErrorCode, message: string): ParseSaveResultV8 => ({ ok: false, error: { code, message } });
  if (typeof text !== 'string') return fail('INVALID_JSON', 'Save must be JSON text');
  if (text.length > SAVE_FILE_LIMIT_BYTES || utf8ByteLength(text) > SAVE_FILE_LIMIT_BYTES) return fail('TOO_LARGE', 'Save exceeds the file size limit');
  let value: unknown; try { value = JSON.parse(text); } catch { return fail('INVALID_JSON', 'Save is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_ENVELOPE', 'Save envelope must be an object');
  const candidate = value as Record<string, unknown>;
  if (candidate.saveVersion !== SAVE_VERSION_V8) return fail('UNSUPPORTED_SAVE_VERSION', 'This codec accepts only version 8');
  if (candidate.simulationVersion !== SIMULATION_VERSION_V8) return fail('UNSUPPORTED_SIMULATION_VERSION', 'Unsupported simulation version');
  if (Object.keys(candidate).sort().join(',') !== 'buildId,checksum,contentVersion,payload,saveVersion,savedAt,seed,simulationVersion'
    || typeof candidate.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(candidate.checksum) || typeof candidate.seed !== 'string'
    || typeof candidate.buildId !== 'string' || candidate.buildId.length < 1 || candidate.buildId.length > 128
    || typeof candidate.savedAt !== 'string' || candidate.savedAt.length < 1 || candidate.savedAt.length > 64
    || !candidate.payload || typeof candidate.payload !== 'object') return fail('INVALID_ENVELOPE', 'Invalid save metadata');
  try {
    const { checksum, ...body } = candidate; if (stableHash(body) !== checksum) return fail('CHECKSUM_MISMATCH', 'Save contents failed their checksum');
    const payload = candidate.payload as Record<string, unknown>;
    const content = resolveContentIdentity(payload.contentIdentity, { allowCandidate: true });
    if (!content || content.worldContentVersion !== candidate.contentVersion || payload.contentVersion !== content.worldContentVersion) return fail('UNSUPPORTED_CONTENT_VERSION', 'Unsupported registered content identity');
    const world = restoreWorldHistory(candidate.payload as WorldStateV8);
    const errors = validateWorldStateV8(world); if (errors.length) return fail('INVALID_WORLD', errors.join('; '));
    if (candidate.seed !== world.seed || candidate.contentVersion !== world.contentVersion || candidate.simulationVersion !== world.simulationVersion) return fail('INVALID_WORLD', 'Envelope and World identity differ');
    return { ok: true, world, envelope: { ...candidate, payload: world } as unknown as SaveEnvelopeV8, migration: null };
  } catch { return fail('INVALID_WORLD', 'Save contains unsupported values'); }
}
