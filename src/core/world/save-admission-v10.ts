import { isManagementV10Identity, MANAGEMENT_V10_CONTENT_VERSION } from '../../content/sect-v10/world-content';
import type { SaveErrorCode } from '../kernel/save';
import { inspectUnregisteredWorldV10Records } from '../kernel/validation';
import { jsonStringByteLength, SAVE_FILE_LIMIT_BYTES } from '../save-budget';
import { MANAGEMENT_V10_PROTOCOL, type WorldStateV10 } from '../sect-expansion/upgrade-types';
import { createPrivateRuntimeV10 } from './runtime-instance-v10';

/** Internal headless codec only. No application/import route is registered. */
export type SaveErrorCodeV10 = SaveErrorCode | 'UNSUPPORTED_SCOPE';
export interface SaveFailureV10 { ok: false; error: { code: SaveErrorCodeV10; message: string } }
export type SaveAdmissionV10 = { ok: true; world: WorldStateV10 } | SaveFailureV10;
export const V10_SAVE_JSON_MAX_DEPTH = 128;
// Every JSON value costs at least one byte. Independent domain reader ceilings
// remain enforced by the fixed complete runtime gate below.
export const V10_SAVE_JSON_MAX_NODES = SAVE_FILE_LIMIT_BYTES;
export function saveFailureV10(code: SaveErrorCodeV10, message: string): SaveFailureV10 { return { ok: false, error: { code, message } }; }

/** Data-only capture before any World/metadata/property reads. The fixed v10
 * contract rejects shared references as well as cycles; v9 behavior is unchanged.
 * Capture every node's descriptors before recursing so sibling traps cannot swap
 * already-captured data for accessors. No getter/toJSON/custom iteration is used.
 * Proxy reflection itself can allocate, throw, or cause caller-side effects and
 * is not atomic. This bounds our traversal, not execution inside caller traps. */
export function captureSaveDataV10(input: unknown): { ok: true; value: unknown } | SaveFailureV10 {
  let bytes = 0; let nodes = 0;
  let failure = saveFailureV10('INVALID_WORLD', 'Save requires bounded finite data-only JSON');
  const seen = new WeakSet<object>();
  function reject(code: SaveErrorCodeV10, message: string): never { failure = saveFailureV10(code, message); throw null; }
  const add = (count: number): void => { bytes += count; if (bytes > SAVE_FILE_LIMIT_BYTES) reject('TOO_LARGE', 'Save exceeds the file size limit'); };
  const stringBytes = (value: string): number => {
    if (value.length > SAVE_FILE_LIMIT_BYTES) reject('TOO_LARGE', 'Save exceeds the file size limit');
    return jsonStringByteLength(value);
  };
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > V10_SAVE_JSON_MAX_NODES || depth > V10_SAVE_JSON_MAX_DEPTH) reject('INVALID_WORLD', 'Save exceeds bounded JSON structure limits');
    if (value === null) { add(4); return null; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return value; }
    if (typeof value === 'string') { add(stringBytes(value)); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value).length); return value === 0 ? 0 : value; }
    if (value === null || typeof value !== 'object') reject('INVALID_WORLD', 'Save requires finite JSON values');
    if (seen.has(value)) reject('INVALID_WORLD', 'Save contains aliases or cyclic JSON');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) reject('INVALID_WORLD', 'Save requires plain JSON objects and arrays');
    seen.add(value); add(2);
    const keys = Reflect.ownKeys(value);
    const count = array ? Math.max(0, keys.length - 1) : keys.length;
    if (keys.length > SAVE_FILE_LIMIT_BYTES || bytes + count * (array ? 1 : 4) + Math.max(0, count - 1) > SAVE_FILE_LIMIT_BYTES) {
      reject('TOO_LARGE', 'Save exceeds the file size limit');
    }
    if (count > V10_SAVE_JSON_MAX_NODES - nodes) reject('INVALID_WORLD', 'Save exceeds bounded JSON structure limits');
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = descriptor?.value;
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1
        || keys.some(key => typeof key !== 'string' || key !== 'length' && (key.length > 10 || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
        reject('INVALID_WORLD', 'Save requires dense JSON arrays');
      }
      add(Math.max(0, length - 1)); const children: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const child = Object.getOwnPropertyDescriptor(value, String(index));
        if (!child?.enumerable || !Object.hasOwn(child, 'value')) reject('INVALID_WORLD', 'Save arrays must contain enumerable data');
        children.push(child.value);
      }
      return children.map(child => copy(child, depth + 1));
    }
    add(Math.max(0, keys.length - 1)); const children: [string, unknown][] = [];
    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') reject('INVALID_WORLD', 'Save requires safe JSON string keys');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject('INVALID_WORLD', 'Save properties must be enumerable data');
      add(stringBytes(key) + 1); children.push([key, descriptor.value]);
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of children) result[key] = copy(child, depth + 1);
    return result;
  }
  try { return { ok: true, value: copy(input, 0) }; }
  // Never inspect a caller-thrown value, including instanceof or .message.
  catch { return failure; }
}

/** Fixed complete admission: no callback, trusted flag, caller assessment, or
 * recovery-only opt-in. Temporary ownership ends on every successful creation. */
export function admitSaveWorldV10(input: unknown): SaveAdmissionV10 {
  const captured = captureSaveDataV10(input); if (!captured.ok) return captured;
  const value = captured.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return saveFailureV10('INVALID_WORLD', 'World must be a JSON object');
  const world = value as WorldStateV10;
  if (world.simulationVersion !== MANAGEMENT_V10_PROTOCOL.simulationVersion) return saveFailureV10('UNSUPPORTED_SIMULATION_VERSION', 'Only simulation 0.10.0 is supported');
  if (world.contentVersion !== MANAGEMENT_V10_CONTENT_VERSION || !isManagementV10Identity(world.contentIdentity)) {
    return saveFailureV10('UNSUPPORTED_CONTENT_VERSION', 'Only the exact internal management-v10 upgrade identity is supported');
  }
  if (world.runtimeProtocol !== MANAGEMENT_V10_PROTOCOL.runtimeProtocol) return saveFailureV10('UNSUPPORTED_SCOPE', 'Only management-v10-alchemy-upgrade.1 is supported');
  const created = createPrivateRuntimeV10(world);
  if (!created.ok) {
    if (created.error === 'unsupported-continuation') return saveFailureV10('UNSUPPORTED_SCOPE', 'World has no supported finite teaching continuation');
    // Distinguish a valid but unsupported boundary only AFTER the private owner
    // attempted complete admission. This fallback never grants save authority.
    if (inspectUnregisteredWorldV10Records(world).length === 0) return saveFailureV10('UNSUPPORTED_SCOPE', 'World is outside the fully funded actual-fitting save subset');
    return saveFailureV10('INVALID_WORLD', 'World failed complete v10 record validation');
  }
  try {
    if (created.recoveryOnly) return saveFailureV10('UNSUPPORTED_SCOPE', 'Recovery-only World has an unfunded reserve; saving this scope is not supported');
    const snapshot = created.instance.snapshot();
    if (!snapshot.ok || snapshot.world === null) return saveFailureV10('INVALID_WORLD', 'Unable to export a validated v10 World');
    if (snapshot.recoveryOnly) return saveFailureV10('UNSUPPORTED_SCOPE', 'World snapshot has an unfunded future reserve');
    return { ok: true, world: snapshot.world };
  } finally { created.instance.close(); }
}
