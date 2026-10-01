import { cloneJson } from '../kernel/serialization';
import type { BuildError, Immutable } from './types';

export class BuildFault extends Error {
  constructor(readonly code: BuildError, readonly reasons: readonly string[] = []) { super(code); }
}
export function fail(code: BuildError, reasons: readonly string[] = []): never { throw new BuildFault(code, reasons); }
export function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value as Immutable<T>;
}
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export function copy<T>(value: T): Mutable<T> { return cloneJson(value) as Mutable<T>; }
export const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._:/-]{0,119}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const unique = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
/** Bounded JSON-only input. Inspect descriptors without invoking getters. */
export function assertJson(value: unknown, depth = 0, ancestors = new Set<object>(), budget = { remaining: 300_000 }): void {
  if (--budget.remaining < 0 || depth > 40) fail('INVALID_INPUT');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') { if (typeof value === 'string' && value.length > 100_000) fail('INVALID_INPUT'); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('INVALID_INPUT'); return; }
  if (typeof value !== 'object' || ancestors.has(value)) fail('INVALID_INPUT');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 16_385 || (array && (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1))) fail('INVALID_INPUT');
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_INPUT');
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail('INVALID_INPUT');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('INVALID_INPUT');
    assertJson(descriptor.value, depth + 1, ancestors, budget);
  }
  ancestors.delete(value);
}
