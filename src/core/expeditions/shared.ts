import { RESOURCE_IDS, type ResourceLine } from '../economy/types';
import { checkedAdd } from '../kernel/numeric';
import { cloneJson, compareStable } from '../kernel/serialization';
import type { ExpeditionData, ExpeditionError, Immutable } from './types';

export const MAX_COMMANDS = 512;
export const MAX_ENCOUNTERS = 9;
export const MAX_SQUAD = 36;
export const MAX_MONTHS_PER_NODE = 12;
export const FALLBACK_SUPPLIES: readonly ResourceLine[] = Object.freeze([{ resourceId: 'meal', quantity: 2 }]);
export const AUTHORED_TALENT_IDS = Object.freeze([
  'talent.xigui-jianmai', 'talent.shouzhong-shengfeng', 'talent.cuofeng',
  'talent.wenyao-yuxing', 'talent.yaoyan-yanmian', 'talent.yuhuo-zhaolu',
  'talent.fanzhen', 'talent.humai', 'talent.bingjian-shouyu',
  'talent.yifa-tongming', 'talent.zoumai-chengfu', 'talent.sanyao-hepai',
]);
export class ExpeditionFault extends Error {
  constructor(readonly code: ExpeditionError) { super(code); }
}
export function fail(code: ExpeditionError): never { throw new ExpeditionFault(code); }
export function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value as Immutable<T>;
}
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export const copy = <T>(value: T): Mutable<T> => cloneJson(value) as Mutable<T>;
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._:/-]{0,119}$/.test(value);
export const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export const unique = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;
export function instanceId(state: ExpeditionData, prefix: string): string {
  const next = state.nextInstance;
  state.nextInstance = checkedAdd(next, 1);
  return `${state.runId}/${prefix}/${next}`;
}
export function resourceLines(value: unknown): value is ResourceLine[] {
  return Array.isArray(value) && value.length <= RESOURCE_IDS.length && unique(value.map((line: ResourceLine) => line?.resourceId))
    && value.every((line: ResourceLine) => !!line && typeof line === 'object' && RESOURCE_IDS.includes(line.resourceId)
      && integer(line.quantity, 1, 1_000_000_000) && Object.keys(line).every(key => ['resourceId', 'quantity'].includes(key)));
}
export function sortedLines(lines: readonly ResourceLine[]): ResourceLine[] {
  return lines.map(line => ({ ...line })).sort((a, b) => compareStable(a.resourceId, b.resourceId));
}
export function addLines(left: readonly ResourceLine[], right: readonly ResourceLine[]): ResourceLine[] {
  const result = sortedLines(left);
  for (const line of right) {
    const existing = result.find(item => item.resourceId === line.resourceId);
    if (existing) existing.quantity = checkedAdd(existing.quantity, line.quantity);
    else result.push({ ...line });
  }
  if (result.some(line => line.quantity > 1_000_000_000)) fail('OVERFLOW');
  return sortedLines(result);
}
export function subtractLines(left: readonly ResourceLine[], right: readonly ResourceLine[]): ResourceLine[] {
  const result = sortedLines(left);
  for (const line of right) {
    const existing = result.find(item => item.resourceId === line.resourceId);
    if (!existing || existing.quantity < line.quantity) fail('INSUFFICIENT_SUPPLIES');
    existing.quantity -= line.quantity;
  }
  return result.filter(line => line.quantity > 0);
}
/** Reject accessors, exotic prototypes, cycles, sparse arrays, and large untrusted input before cloning. */
export function assertPlainJson(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 40) fail('INVALID_INPUT');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('INVALID_INPUT'); return; }
  if (typeof value !== 'object' || ancestors.has(value)) fail('INVALID_INPUT');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_INPUT');
  if (array && value.length > 8192) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 8193) fail('INVALID_INPUT');
  if (array && keys.length !== value.length + 1) fail('INVALID_INPUT');
  ancestors.add(value);
  for (const key of keys) {
    if (key === 'length' && array) continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_INPUT');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('INVALID_INPUT');
    assertPlainJson(descriptor.value, depth + 1, ancestors);
  }
  ancestors.delete(value);
}
