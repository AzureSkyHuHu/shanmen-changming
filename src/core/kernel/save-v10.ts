import { MANAGEMENT_V10_CONTENT_VERSION } from '../../content/sect-v10/world-content';
import { canonicalUtf8ByteLength, SAVE_FILE_LIMIT_BYTES, utf8ByteLength } from '../save-budget';
import { MAX_BUILD_ID_CODE_UNITS, MAX_SAVED_AT_CODE_UNITS } from '../save-budget/envelope';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../sect-expansion/upgrade-types';
import { admitSaveWorldV10, captureSaveDataV10, saveFailureV10, type SaveErrorCodeV10, type SaveFailureV10 } from '../world/save-admission-v10';
import type { SaveMetadata } from './save';
import { canonicalStringify, stableHash } from './serialization';

export const SAVE_VERSION_V10 = MANAGEMENT_V10_PROTOCOL.saveVersion;
export const SAVE_SIMULATION_VERSION_V10 = MANAGEMENT_V10_PROTOCOL.simulationVersion;
export interface SaveEnvelopeV10 extends SaveMetadata {
  saveVersion: typeof SAVE_VERSION_V10;
  simulationVersion: typeof SAVE_SIMULATION_VERSION_V10;
  contentVersion: typeof MANAGEMENT_V10_CONTENT_VERSION;
  seed: string;
  checksum: string;
  payload: WorldStateV10;
}
export type ParseSaveResultV10 = { ok: true; envelope: SaveEnvelopeV10; world: WorldStateV10; migration: null } | SaveFailureV10;
export type { SaveErrorCodeV10 } from '../world/save-admission-v10';
/** Create/serialize expose the same machine-readable codes as parse. */
export class SaveCodecErrorV10 extends TypeError {
  readonly code: SaveErrorCodeV10;
  constructor(failure: SaveFailureV10) { super(failure.error.message); this.name = 'SaveCodecErrorV10'; this.code = failure.error.code; }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const metadataValid = (value: unknown): value is SaveMetadata => object(value)
  && Object.keys(value).sort().join(',') === 'buildId,savedAt'
  && typeof value.buildId === 'string' && value.buildId.length > 0 && value.buildId.length <= MAX_BUILD_ID_CODE_UNITS
  && typeof value.savedAt === 'string' && value.savedAt.length > 0 && value.savedAt.length <= MAX_SAVED_AT_CODE_UNITS;

function admittedEnvelope(input: unknown): ParseSaveResultV10 {
  const captured = captureSaveDataV10(input); if (!captured.ok) return captured;
  const value = captured.value;
  if (!object(value)) return saveFailureV10('INVALID_ENVELOPE', 'Save envelope must be an object');
  if (Object.keys(value).sort().join(',') !== 'buildId,checksum,contentVersion,payload,saveVersion,savedAt,seed,simulationVersion'
    || typeof value.saveVersion !== 'number' || !Number.isSafeInteger(value.saveVersion)
    || typeof value.simulationVersion !== 'string' || typeof value.contentVersion !== 'string'
    || typeof value.checksum !== 'string' || !/^[0-9a-f]{8}$/.test(value.checksum) || typeof value.seed !== 'string'
    || !metadataValid({ buildId: value.buildId, savedAt: value.savedAt }) || !object(value.payload)) return saveFailureV10('INVALID_ENVELOPE', 'Invalid save envelope fields');
  if (value.saveVersion !== SAVE_VERSION_V10) return saveFailureV10('UNSUPPORTED_SAVE_VERSION', 'This headless codec accepts only version 10');
  if (value.simulationVersion !== SAVE_SIMULATION_VERSION_V10) return saveFailureV10('UNSUPPORTED_SIMULATION_VERSION', 'Only simulation 0.10.0 is supported');
  const { checksum, ...body } = value;
  if (stableHash(body) !== checksum) return saveFailureV10('CHECKSUM_MISMATCH', 'Save contents failed their checksum');
  if (value.contentVersion !== MANAGEMENT_V10_CONTENT_VERSION) return saveFailureV10('UNSUPPORTED_CONTENT_VERSION', 'Unsupported internal v10 content version');
  const admitted = admitSaveWorldV10(value.payload); if (!admitted.ok) return admitted;
  const world = admitted.world;
  if (value.seed !== world.seed || value.contentVersion !== world.contentVersion || value.simulationVersion !== world.simulationVersion) {
    return saveFailureV10('INVALID_WORLD', 'Envelope and World identity differ');
  }
  return { ok: true, envelope: { ...value, payload: world } as unknown as SaveEnvelopeV10, world, migration: null };
}

/** Internal headless entry only. No registry, Session, browser storage, UI,
 * migration, or old-version relabeling is added by this codec. */
export function createSaveEnvelopeV10(input: unknown, metadata: SaveMetadata): SaveEnvelopeV10 {
  // Isolate World before metadata reflection can mutate the caller's source.
  const captured = captureSaveDataV10(input); if (!captured.ok) throw new SaveCodecErrorV10(captured);
  const meta = captureSaveDataV10(metadata); if (!meta.ok) throw new SaveCodecErrorV10(meta);
  if (!metadataValid(meta.value)) throw new SaveCodecErrorV10(saveFailureV10('INVALID_ENVELOPE', 'Invalid save metadata'));
  const admitted = admitSaveWorldV10(captured.value); if (!admitted.ok) throw new SaveCodecErrorV10(admitted);
  const world = admitted.world;
  const body = { saveVersion: SAVE_VERSION_V10, simulationVersion: SAVE_SIMULATION_VERSION_V10, contentVersion: MANAGEMENT_V10_CONTENT_VERSION,
    seed: world.seed, buildId: meta.value.buildId, savedAt: meta.value.savedAt, payload: world } as const;
  const envelope = { ...body, checksum: stableHash(body) };
  if (canonicalUtf8ByteLength(envelope) > SAVE_FILE_LIMIT_BYTES) throw new SaveCodecErrorV10(saveFailureV10('TOO_LARGE', 'Save exceeds the file size limit'));
  return envelope;
}
/** Caller-built and correctly checksummed envelopes still pass full admission. */
export function serializeSaveV10(input: SaveEnvelopeV10): string {
  const admitted = admittedEnvelope(input); if (!admitted.ok) throw new SaveCodecErrorV10(admitted);
  const text = canonicalStringify(admitted.envelope);
  if (utf8ByteLength(text) > SAVE_FILE_LIMIT_BYTES) throw new SaveCodecErrorV10(saveFailureV10('TOO_LARGE', 'Save exceeds the file size limit'));
  return text;
}
export function parseSaveV10(text: string): ParseSaveResultV10 {
  if (typeof text !== 'string') return saveFailureV10('INVALID_JSON', 'Save must be JSON text');
  if (text.length > SAVE_FILE_LIMIT_BYTES || utf8ByteLength(text) > SAVE_FILE_LIMIT_BYTES) return saveFailureV10('TOO_LARGE', 'Save exceeds the file size limit');
  let value: unknown; try { value = JSON.parse(text); } catch { return saveFailureV10('INVALID_JSON', 'Save is not valid JSON'); }
  return admittedEnvelope(value);
}
