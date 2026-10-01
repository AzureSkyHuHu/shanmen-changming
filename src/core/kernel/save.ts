import { CONTENT_VERSION, SIMULATION_VERSION } from '../world/create-world';
import type { WorldState } from '../world/types';
import { canonicalStringify, cloneJson, stableHash } from './serialization';
import { validateWorldState } from './validation';

export const SAVE_VERSION = 1;
/** Character limit is conservative for UTF-16 strings; file adapters should also cap byte count. */
export const MAX_SAVE_CHARACTERS = 4 * 1024 * 1024;
export interface SaveMetadata { buildId: string; savedAt: string }
export interface SaveEnvelope extends SaveMetadata {
  saveVersion: typeof SAVE_VERSION;
  simulationVersion: string;
  contentVersion: string;
  seed: string;
  checksum: string;
  payload: WorldState;
}
export type SaveErrorCode = 'TOO_LARGE' | 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'UNSUPPORTED_SAVE_VERSION' | 'UNSUPPORTED_SIMULATION_VERSION' | 'UNSUPPORTED_CONTENT_VERSION' | 'CHECKSUM_MISMATCH' | 'INVALID_WORLD';
export type ParseSaveResult = { ok: true; envelope: SaveEnvelope; world: WorldState } | { ok: false; error: { code: SaveErrorCode; message: string } };

function checksumEnvelope(envelope: Omit<SaveEnvelope, 'checksum'>): string { return stableHash(envelope); }

/** Caller supplies display timestamp. No runtime clock or persistence API is used here. */
export function createSaveEnvelope(world: WorldState, metadata: SaveMetadata): SaveEnvelope {
  const errors = validateWorldState(world);
  if (errors.length) throw new TypeError(`Cannot snapshot invalid world: ${errors.join('; ')}`);
  if (typeof metadata.buildId !== 'string' || metadata.buildId.length === 0 || metadata.buildId.length > 128 || typeof metadata.savedAt !== 'string' || metadata.savedAt.length === 0 || metadata.savedAt.length > 64) throw new TypeError('Invalid save metadata');
  const envelope = { saveVersion: SAVE_VERSION, simulationVersion: SIMULATION_VERSION, contentVersion: CONTENT_VERSION, seed: world.seed, buildId: metadata.buildId, savedAt: metadata.savedAt, payload: cloneJson(world) } as const;
  return { ...envelope, checksum: checksumEnvelope(envelope) };
}

export function serializeSave(envelope: SaveEnvelope): string { return canonicalStringify(envelope); }

/** v1 accepts v1 only; migrations must be explicit pure versioned functions when introduced. */
export function parseSave(text: string): ParseSaveResult {
  const fail = (code: SaveErrorCode, message: string): ParseSaveResult => ({ ok: false, error: { code, message } });
  if (typeof text !== 'string') return fail('INVALID_JSON', 'Save must be JSON text');
  if (text.length > MAX_SAVE_CHARACTERS) return fail('TOO_LARGE', 'Save exceeds the import size limit');
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('INVALID_JSON', 'Save is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_ENVELOPE', 'Save envelope must be an object');
  const candidate = value as Record<string, unknown>;
  if (candidate.saveVersion !== SAVE_VERSION) return fail('UNSUPPORTED_SAVE_VERSION', 'This save version is not supported');
  if (candidate.simulationVersion !== SIMULATION_VERSION) return fail('UNSUPPORTED_SIMULATION_VERSION', 'This simulation version is not supported');
  if (candidate.contentVersion !== CONTENT_VERSION) return fail('UNSUPPORTED_CONTENT_VERSION', 'This content version is not supported');
  if (typeof candidate.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(candidate.checksum) || typeof candidate.seed !== 'string' || typeof candidate.savedAt !== 'string' || candidate.savedAt.length === 0 || candidate.savedAt.length > 64 || typeof candidate.buildId !== 'string' || candidate.buildId.length === 0 || candidate.buildId.length > 128 || !candidate.payload || typeof candidate.payload !== 'object') return fail('INVALID_ENVELOPE', 'Save metadata is invalid');
  const { checksum, ...body } = candidate;
  try {
    if (stableHash(body) !== checksum) return fail('CHECKSUM_MISMATCH', 'Save contents failed their checksum');
    const errors = validateWorldState(candidate.payload);
    if (errors.length) return fail('INVALID_WORLD', errors.join('; '));
  } catch { return fail('INVALID_WORLD', 'Save contains unsupported or excessively nested values'); }
  const envelope = candidate as unknown as SaveEnvelope;
  if (envelope.seed !== envelope.payload.seed || envelope.simulationVersion !== envelope.payload.simulationVersion || envelope.contentVersion !== envelope.payload.contentVersion) return fail('INVALID_WORLD', 'Envelope and world identity differ');
  return { ok: true, envelope, world: envelope.payload };
}
