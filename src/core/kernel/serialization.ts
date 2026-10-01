export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Code-unit key order, independent of locale. Rejects non-JSON and non-finite values. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(object[key])}`).join(',')}}`;
  }
  throw new TypeError('Expected a finite JSON value');
}

/** FNV-1a over UTF-16 code units; corruption detector, never a security primitive. */
export function stableHash(value: unknown): string {
  return hashText(canonicalStringify(value)).toString(16).padStart(8, '0');
}

export function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return hash;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalStringify(value)) as T;
}

export function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
