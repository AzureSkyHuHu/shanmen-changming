import {
  createSaveEnvelope, MAX_SAVE_CHARACTERS, parseSave, SAVE_VERSION, serializeSave,
  type ParseSaveResult, type SaveEnvelope, type SaveMetadata,
} from '../core/kernel/save';
import {
  createSaveEnvelopeV8, parseSaveV8, SAVE_VERSION_V8, serializeSaveV8,
  type ParseSaveResultV8, type SaveEnvelopeV8,
} from '../core/kernel/save-v8';
import { SAVE_FILE_LIMIT_BYTES, utf8ByteLength } from '../core/save-budget';
import { SIMULATION_VERSION } from '../core/world/create-world';
import { SIMULATION_VERSION_V8 } from '../core/world/create-world-v8';
import type { WorldState } from '../core/world/types';
import type { WorldStateV8 } from '../core/world/v8-types';

export const MAX_SAVE_FILE_BYTES = SAVE_FILE_LIMIT_BYTES;
export type VersionedWorldState = WorldState | WorldStateV8;
export type VersionedSaveEnvelope = SaveEnvelope | SaveEnvelopeV8;
export type VersionedParseSaveResult = ParseSaveResult | ParseSaveResultV8;
export type VersionedSaveFailure = Extract<VersionedParseSaveResult, { ok: false }>;
type SaveData<T> = T extends { ok: true } ? Omit<T, 'ok'> : never;
/** Correlated pairs: an 8 envelope always accompanies an 8 World, never a v7 cast. */
export type VersionedSaveData = SaveData<VersionedParseSaveResult>;
export type SupportedSaveVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type SaveVersionPeekResult = { ok: true; saveVersion: SupportedSaveVersion } | VersionedSaveFailure;
export type { SaveMetadata } from '../core/kernel/save';

function failure(code: VersionedSaveFailure['error']['code'], message: string): VersionedSaveFailure {
  return { ok: false, error: { code, message } };
}

type SaveSourceInspection = { ok: true; saveVersion: SupportedSaveVersion; hasV8ContentIdentity: boolean } | VersionedSaveFailure;

/** Inspect only the original bounded JSON, before any legacy migration can drop fields. */
function inspectSaveSource(text: string): SaveSourceInspection {
  if (typeof text !== 'string') return failure('INVALID_JSON', 'Save must be JSON text');
  if (text.length > MAX_SAVE_CHARACTERS || utf8ByteLength(text) > MAX_SAVE_FILE_BYTES) {
    return failure('TOO_LARGE', 'Save file exceeds the byte limit');
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return failure('INVALID_JSON', 'Save is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure('INVALID_ENVELOPE', 'Save envelope must be an object');
  }
  const candidate = value as Record<string, unknown>;
  const version = candidate.saveVersion;
  const payload = candidate.payload;
  const hasV8ContentIdentity = payload !== null && typeof payload === 'object' && Object.hasOwn(payload, 'contentIdentity');
  switch (version) {
    case 1: case 2: case 3: case 4: case 5: case 6: case SAVE_VERSION: case SAVE_VERSION_V8:
      return { ok: true, saveVersion: version, hasV8ContentIdentity };
    default:
      return failure('UNSUPPORTED_SAVE_VERSION', 'This save version is not supported');
  }
}

/** Bounded routing only. A successful peek is NOT checksum or World validation. */
export function peekSaveVersion(text: string): SaveVersionPeekResult {
  const source = inspectSaveSource(text);
  return source.ok ? { ok: true, saveVersion: source.saveVersion } : source;
}

/** Source version selects exactly one codec. Invalid v8 never retries as legacy. */
export function parseVersionedSave(text: string): VersionedParseSaveResult {
  const source = inspectSaveSource(text);
  if (!source.ok) return source;
  if (source.saveVersion === SAVE_VERSION_V8) return parseSaveV8(text);
  // Frozen legacy validators permit unknown fields. This v8 authority field is
  // reserved: accepting it would select conflicting content in runtime queries.
  // Reject the original source instead of migrating, stripping, or retrying it.
  if (source.hasV8ContentIdentity) return failure('INVALID_WORLD', 'Legacy World cannot carry a v8 content identity');
  return parseSave(text);
}

export function createVersionedSaveEnvelope(world: WorldState, metadata: SaveMetadata): SaveEnvelope;
export function createVersionedSaveEnvelope(world: WorldStateV8, metadata: SaveMetadata): SaveEnvelopeV8;
export function createVersionedSaveEnvelope(world: VersionedWorldState, metadata: SaveMetadata): VersionedSaveEnvelope;
/** The selected core creator validates the entire World, including its content identity. */
export function createVersionedSaveEnvelope(world: VersionedWorldState, metadata: SaveMetadata): VersionedSaveEnvelope {
  if (world && world.simulationVersion === SIMULATION_VERSION_V8 && 'contentIdentity' in world) {
    return createSaveEnvelopeV8(world, metadata);
  }
  if (world && world.simulationVersion === SIMULATION_VERSION && !('contentIdentity' in world)) {
    return createSaveEnvelope(world, metadata);
  }
  throw new TypeError('Cannot snapshot an unsupported World identity/version');
}

export function serializeVersionedSave(envelope: VersionedSaveEnvelope): string {
  let text: string;
  if (envelope.saveVersion === SAVE_VERSION_V8) text = serializeSaveV8(envelope);
  else if (envelope.saveVersion === SAVE_VERSION) text = serializeSave(envelope);
  else throw new TypeError('Cannot serialize an unsupported save version');
  if (text.length > MAX_SAVE_CHARACTERS || utf8ByteLength(text) > MAX_SAVE_FILE_BYTES) throw new RangeError('Save exceeds the file size limit');
  return text;
}
