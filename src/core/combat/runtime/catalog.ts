import type { CombatContentCatalog, CombatDefinition } from '../definitions/types';
import type { Mutable } from './types';
import { stableHash } from '../../kernel/serialization';

/** Copy only trusted JSON-shaped runtime data, preserving canonical object-key order. */
export function copyCombatData<T>(value: T): Mutable<T> {
  if (value === null || typeof value !== 'object') return value as Mutable<T>;
  if (Array.isArray(value)) return value.map(item => copyCombatData(item)) as Mutable<T>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = copyCombatData((value as Record<string, unknown>)[key]);
  return result as Mutable<T>;
}
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
const prepared = new WeakMap<CombatContentCatalog, { fingerprint: string; definitions: ReadonlyMap<string, CombatDefinition> }>();
export function catalogDefinitions(catalog: CombatContentCatalog): readonly CombatDefinition[] { return [...catalog.skills, ...catalog.talents, ...catalog.treeNodes, ...catalog.statuses, ...catalog.trees, ...catalog.summons, ...catalog.builds]; }
/**
 * Return an owned frozen catalog for repeated stepping. Never freezes or trusts a mutable
 * caller-owned object. Memoized fingerprints/indexes are safe because this copy cannot change.
 */
export function prepareCombatCatalog(catalog: CombatContentCatalog): CombatContentCatalog {
  if (prepared.has(catalog)) return catalog;
  const copy = deepFreeze(copyCombatData(catalog));
  const definitions = new Map<string, CombatDefinition>();
  for (const item of catalogDefinitions(copy)) { if (definitions.has(item.id)) throw new Error(`Duplicate combat definition: ${item.id}`); definitions.set(item.id, item); }
  prepared.set(copy, { fingerprint: stableHash(copy), definitions }); return copy;
}
export function catalogFingerprint(catalog: CombatContentCatalog): string { return prepared.get(catalog)?.fingerprint ?? stableHash(catalog); }
export function findCombatDefinition(catalog: CombatContentCatalog, definitionId: string): CombatDefinition | undefined { const indexed = prepared.get(catalog); return indexed ? indexed.definitions.get(definitionId) : catalogDefinitions(catalog).find(item => item.id === definitionId); }
