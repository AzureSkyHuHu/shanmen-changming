import { isManagementV9Identity, MANAGEMENT_V9_CONTENT_VERSION } from '../../content/sect-v9/world-content';
import type { SaveErrorCode } from '../kernel/save';
import { inspectUnregisteredWorldV9Records } from '../kernel/validation';
import { jsonStringByteLength, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { createPrivateRuntimeV9 } from './runtime-instance-v9';
import type { WorldStateV9 } from './v9-types';

/** Internal codec scope only. This does not add an application/import route. */
export type SaveErrorCodeV9 = SaveErrorCode | 'UNSUPPORTED_SCOPE';
export interface SaveFailureV9 { ok: false; error: { code: SaveErrorCodeV9; message: string } }
export type SaveAdmissionV9 = { ok: true; world: WorldStateV9 } | SaveFailureV9;
export const V9_SAVE_JSON_MAX_DEPTH = 128;
// Every JSON value requires at least one wire byte. Independent of domain reader
// bounds, this ceiling cannot exclude a tree whose complete wire image fits.
export const V9_SAVE_JSON_MAX_NODES = SAVE_FILE_LIMIT_BYTES;
export function saveFailureV9(code: SaveErrorCodeV9, message: string): SaveFailureV9 { return { ok: false, error: { code, message } }; }

/** Bounded descriptor capture before any supplied-property read or recursion in
 * domain readers. No getters/toJSON/custom array iteration are ever invoked.
 * Repeated references are copied separately; cycles and exotic data reject.
 * Proxy reflection is not atomic and may have caller-side effects. Every captured
 * result nevertheless gets complete validation; no supplied freezing is trust. */
export function captureSaveDataV9(input: unknown): { ok: true; value: unknown } | SaveFailureV9 {
  let bytes = 0; let nodes = 0; let failure = saveFailureV9('INVALID_WORLD', 'Save requires bounded finite data-only JSON');
  const active = new WeakSet<object>();
  function reject(code: SaveErrorCodeV9, message: string): never { failure = saveFailureV9(code, message); throw null; }
  const add = (count: number): void => { bytes += count; if (bytes > SAVE_FILE_LIMIT_BYTES) reject('TOO_LARGE', 'Save exceeds the file size limit'); };
  const stringBytes = (value: string): number => {
    if (value.length > SAVE_FILE_LIMIT_BYTES) reject('TOO_LARGE', 'Save exceeds the file size limit');
    return jsonStringByteLength(value);
  };
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > V9_SAVE_JSON_MAX_NODES || depth > V9_SAVE_JSON_MAX_DEPTH) reject('INVALID_WORLD', 'Save exceeds bounded JSON structure limits');
    if (value === null) { add(4); return null; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return value; }
    if (typeof value === 'string') { add(stringBytes(value)); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value).length); return value === 0 ? 0 : value; }
    if (value === null || typeof value !== 'object') reject('INVALID_WORLD', 'Save requires finite JSON values');
    if (active.has(value)) reject('INVALID_WORLD', 'Save contains cyclic JSON');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) reject('INVALID_WORLD', 'Save requires plain JSON objects and arrays');
    active.add(value); add(2);
    // ownKeys itself can allocate/run a Proxy trap; only traversal/copy after
    // that unavoidable reflection step is budgeted, not caller trap execution.
    const keys = Reflect.ownKeys(value);
    if (keys.length > SAVE_FILE_LIMIT_BYTES) reject('TOO_LARGE', 'Save exceeds the file size limit');
    const minimumValues = array ? Math.max(0, keys.length - 1) : keys.length;
    // Before descriptor reads: each object entry needs at least "":0 plus
    // separators; each array value needs at least one byte plus separators.
    if (bytes + minimumValues * (array ? 1 : 4) + Math.max(0, minimumValues - 1) > SAVE_FILE_LIMIT_BYTES) {
      reject('TOO_LARGE', 'Save exceeds the file size limit');
    }
    let result: unknown;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1
        || keys.some(key => typeof key !== 'string' || key !== 'length' && (key.length > 10 || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
        reject('INVALID_WORLD', 'Save requires dense JSON arrays');
      }
      add(Math.max(0, length - 1)); const output: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('INVALID_WORLD', 'Save arrays must contain enumerable data');
        output.push(copy(descriptor.value, depth + 1));
      }
      result = output;
    } else {
      add(Math.max(0, keys.length - 1)); const output: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== 'string') reject('INVALID_WORLD', 'Save keys must be JSON strings');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('INVALID_WORLD', 'Save properties must be enumerable data');
        add(stringBytes(key) + 1);
        Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      result = output;
    }
    active.delete(value); return result;
  }
  try { return { ok: true, value: copy(input, 0) }; }
  // Do not inspect a caller-thrown error, even with instanceof or .message.
  catch { return failure; }
}

/** The single fixed complete save admission. No trust flags, validators,
 * callbacks, externally supplied assessments or recovery-only opt-ins exist.
 * Temporary ownership always ends, including failed export and scope refusal. */
export function admitSaveWorldV9(input: unknown): SaveAdmissionV9 {
  const captured = captureSaveDataV9(input); if (!captured.ok) return captured;
  const value = captured.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return saveFailureV9('INVALID_WORLD', 'World must be a JSON object');
  const world = value as WorldStateV9;
  if (world.simulationVersion !== '0.9.0') return saveFailureV9('UNSUPPORTED_SIMULATION_VERSION', 'Only simulation 0.9.0 is supported');
  if (world.contentVersion !== MANAGEMENT_V9_CONTENT_VERSION || !isManagementV9Identity(world.contentIdentity)) {
    return saveFailureV9('UNSUPPORTED_CONTENT_VERSION', 'Only the exact internal management-v9 .3 identity is supported');
  }
  if (world.runtimeProtocol !== 'fresh-management-v9-unregistered.3') return saveFailureV9('UNSUPPORTED_SCOPE', 'Only the unchanged fresh-management-v9-unregistered.3 protocol is supported');
  const created = createPrivateRuntimeV9(world);
  if (!created.ok) {
    if (created.error === 'unsupported-continuation') return saveFailureV9('UNSUPPORTED_SCOPE', 'World has no supported finite teaching continuation');
    // Full source validation still runs in the private owner. Only distinguish a
    // valid but unsupported root after its failed construction, never bypass it.
    if (inspectUnregisteredWorldV9Records(world).length === 0) return saveFailureV9('UNSUPPORTED_SCOPE', 'World is outside the fully funded actual-fitting save subset');
    return saveFailureV9('INVALID_WORLD', 'World failed complete v9 record validation');
  }
  try {
    if (created.recoveryOnly) return saveFailureV9('UNSUPPORTED_SCOPE', 'Recovery-only World has an unfunded reserve; saving this scope is not supported');
    const snapshot = created.instance.snapshot();
    if (!snapshot.ok || snapshot.world === null) return saveFailureV9('INVALID_WORLD', 'Unable to export a validated v9 World');
    return { ok: true, world: snapshot.world };
  } finally { created.instance.close(); }
}
