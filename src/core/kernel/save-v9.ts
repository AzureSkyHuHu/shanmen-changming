import { MANAGEMENT_V9_CONTENT_VERSION } from '../../content/sect-v9/world-content';
import { canonicalUtf8ByteLength, SAVE_FILE_LIMIT_BYTES, utf8ByteLength } from '../save-budget';
import { MAX_BUILD_ID_CODE_UNITS, MAX_SAVED_AT_CODE_UNITS } from '../save-budget/envelope';
import { admitSaveWorldV9, captureSaveDataV9, saveFailureV9, type SaveErrorCodeV9, type SaveFailureV9 } from '../world/save-admission-v9';
import type { WorldStateV9 } from '../world/v9-types';
import type { SaveMetadata } from './save';
import { canonicalStringify, stableHash } from './serialization';

export const SAVE_VERSION_V9 = 9;
export const SAVE_SIMULATION_VERSION_V9 = '0.9.0';
export interface SaveEnvelopeV9 extends SaveMetadata {
  saveVersion: typeof SAVE_VERSION_V9;
  simulationVersion: typeof SAVE_SIMULATION_VERSION_V9;
  contentVersion: string;
  seed: string;
  checksum: string;
  payload: WorldStateV9;
}
export type ParseSaveResultV9 = { ok: true; envelope: SaveEnvelopeV9; world: WorldStateV9; migration: null } | SaveFailureV9;
export type { SaveErrorCodeV9 } from '../world/save-admission-v9';
/** Create/serialize use the same machine-readable failure codes as the parser. */
export class SaveCodecErrorV9 extends TypeError {
  readonly code: SaveErrorCodeV9;
  constructor(failure: SaveFailureV9) { super(failure.error.message); this.name = 'SaveCodecErrorV9'; this.code = failure.error.code; }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const metadataValid = (value: unknown): value is SaveMetadata => object(value)
  && Object.keys(value).sort().join(',') === 'buildId,savedAt'
  && typeof value.buildId === 'string' && value.buildId.length > 0 && value.buildId.length <= MAX_BUILD_ID_CODE_UNITS
  && typeof value.savedAt === 'string' && value.savedAt.length > 0 && value.savedAt.length <= MAX_SAVED_AT_CODE_UNITS;
function admittedEnvelope(input: unknown): ParseSaveResultV9 {
  const captured = captureSaveDataV9(input); if (!captured.ok) return captured;
  const value = captured.value;
  if (!object(value)) return saveFailureV9('INVALID_ENVELOPE', 'Save envelope must be an object');
  if (Object.keys(value).sort().join(',') !== 'buildId,checksum,contentVersion,payload,saveVersion,savedAt,seed,simulationVersion'
    || typeof value.saveVersion !== 'number' || !Number.isSafeInteger(value.saveVersion)
    || typeof value.simulationVersion !== 'string' || typeof value.contentVersion !== 'string'
    || typeof value.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(value.checksum) || typeof value.seed !== 'string'
    || !metadataValid({ buildId: value.buildId, savedAt: value.savedAt }) || !object(value.payload)) return saveFailureV9('INVALID_ENVELOPE', 'Invalid save envelope fields');
  if (value.saveVersion !== SAVE_VERSION_V9) return saveFailureV9('UNSUPPORTED_SAVE_VERSION', 'This headless codec accepts only version 9');
  if (value.simulationVersion !== SAVE_SIMULATION_VERSION_V9) return saveFailureV9('UNSUPPORTED_SIMULATION_VERSION', 'Only simulation 0.9.0 is supported');
  const { checksum, ...body } = value;
  if (stableHash(body) !== checksum) return saveFailureV9('CHECKSUM_MISMATCH', 'Save contents failed their checksum');
  if (value.contentVersion !== MANAGEMENT_V9_CONTENT_VERSION) return saveFailureV9('UNSUPPORTED_CONTENT_VERSION', 'Unsupported internal v9 content version');
  const admitted = admitSaveWorldV9(value.payload); if (!admitted.ok) return admitted;
  const world = admitted.world;
  if (value.seed !== world.seed || value.contentVersion !== world.contentVersion || value.simulationVersion !== world.simulationVersion) {
    return saveFailureV9('INVALID_WORLD', 'Envelope and World identity differ');
  }
  return { ok: true, envelope: { ...value, payload: world } as unknown as SaveEnvelopeV9, world, migration: null };
}

/** Internal headless prerequisite only. No registry, Session, platform storage,
 * v7/v8 migration, relabeling or browser entry point selects this codec. */
export function createSaveEnvelopeV9(input: unknown, metadata: SaveMetadata): SaveEnvelopeV9 {
  // Capture World first: metadata Proxy reflection cannot mutate an already
  // admitted caller root. The captured World will still be admitted in full.
  const captured = captureSaveDataV9(input); if (!captured.ok) throw new SaveCodecErrorV9(captured);
  const meta = captureSaveDataV9(metadata); if (!meta.ok) throw new SaveCodecErrorV9(meta);
  if (!metadataValid(meta.value)) throw new SaveCodecErrorV9(saveFailureV9('INVALID_ENVELOPE', 'Invalid save metadata'));
  const admitted = admitSaveWorldV9(captured.value); if (!admitted.ok) throw new SaveCodecErrorV9(admitted);
  const world = admitted.world;
  const body = { saveVersion: SAVE_VERSION_V9, simulationVersion: SAVE_SIMULATION_VERSION_V9, contentVersion: world.contentVersion,
    seed: world.seed, buildId: meta.value.buildId, savedAt: meta.value.savedAt, payload: world } as const;
  const envelope = { ...body, checksum: stableHash(body) };
  if (canonicalUtf8ByteLength(envelope) > SAVE_FILE_LIMIT_BYTES) throw new SaveCodecErrorV9(saveFailureV9('TOO_LARGE', 'Save exceeds the file size limit'));
  return envelope;
}
/** Even caller-built/checksummed envelopes require the complete fixed admission. */
export function serializeSaveV9(input: SaveEnvelopeV9): string {
  const admitted = admittedEnvelope(input); if (!admitted.ok) throw new SaveCodecErrorV9(admitted);
  const text = canonicalStringify(admitted.envelope);
  if (utf8ByteLength(text) > SAVE_FILE_LIMIT_BYTES) throw new SaveCodecErrorV9(saveFailureV9('TOO_LARGE', 'Save exceeds the file size limit'));
  return text;
}
export function parseSaveV9(text: string): ParseSaveResultV9 {
  if (typeof text !== 'string') return saveFailureV9('INVALID_JSON', 'Save must be JSON text');
  if (text.length > SAVE_FILE_LIMIT_BYTES || utf8ByteLength(text) > SAVE_FILE_LIMIT_BYTES) return saveFailureV9('TOO_LARGE', 'Save exceeds the file size limit');
  let value: unknown; try { value = JSON.parse(text); } catch { return saveFailureV9('INVALID_JSON', 'Save is not valid JSON'); }
  return admittedEnvelope(value);
}
