import { cloneJson } from '../kernel/serialization';
import type { CampaignError, Immutable } from './types';

export const MAX_CAMPAIGN_CLAIMS = 2048;
export class CampaignFault extends Error { constructor(readonly code: CampaignError) { super(code); } }
export function fail(code: CampaignError): never { throw new CampaignFault(code); }
export const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export const validId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z][a-zA-Z0-9._:/-]{0,119}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
export const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}$/.test(value);
export const unique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;
export const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value as Immutable<T>;
}
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export const copy = <T>(value: T): Mutable<T> => cloneJson(value) as Mutable<T>;
/** Reject accessors, cycles, sparse arrays and executable or exotic values before reading them. */
export function assertJson(value: unknown, depth = 0, ancestors = new Set<object>(), budget = { left: 200_000 }): void {
  if (--budget.left < 0 || depth > 40) fail('INVALID_INPUT');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > 100_000) fail('INVALID_INPUT'); return;
  }
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('INVALID_INPUT'); return; }
  if (typeof value !== 'object' || ancestors.has(value)) fail('INVALID_INPUT');
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 100_001 || (array && keys.length !== value.length + 1)) fail('INVALID_INPUT');
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || ['constructor', 'prototype', '__proto__'].includes(key)) fail('INVALID_INPUT');
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail('INVALID_INPUT');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('INVALID_INPUT');
    assertJson(descriptor.value, depth + 1, ancestors, budget);
  }
  ancestors.delete(value);
}
