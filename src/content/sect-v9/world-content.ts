import { contentIdentity, LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE, type GameContentIdentity } from '../registry';
import type { BuildContentContext } from '../../core/builds/v2-types';
import { canonicalStringify, stableHash } from '../../core/kernel/serialization';
import { SECT_V9_CANDIDATE_IDENTITY } from './catalog';

/** Internal management identity. Deliberately absent from the public content registry,
 * expedition protocols, application engine and save codec. Old identities are unchanged. */
export const MANAGEMENT_V9_CONTENT_VERSION = 'shanmen-management-0.9.0-unregistered.1';
export const MANAGEMENT_V9_IDENTITY: Readonly<GameContentIdentity> = Object.freeze({
  registryId: 'content.management-v9.unregistered-1',
  compositeFingerprint: stableHash({ protocol: MANAGEMENT_V9_CONTENT_VERSION,
    base: contentIdentity(RELEASE_V8_CANDIDATE), sect: SECT_V9_CANDIDATE_IDENTITY, departures: 'closed', care: 'unimplemented' }),
  combatFingerprint: contentIdentity(RELEASE_V8_CANDIDATE).combatFingerprint, buildRulesVersion: 2,
});
export function isManagementV9Identity(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || Object.getPrototypeOf(identity) !== Object.prototype
    || Reflect.ownKeys(identity).length !== 4) return false;
  for (const [key, expected] of Object.entries(MANAGEMENT_V9_IDENTITY)) {
    const descriptor = Object.getOwnPropertyDescriptor(identity, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value !== expected) return false;
  }
  return true;
}
const context: BuildContentContext = Object.freeze({ identity: MANAGEMENT_V9_IDENTITY, catalog: RELEASE_V8_CANDIDATE.combat,
  rules: RELEASE_V8_CANDIDATE.buildRules,
  legacy: Object.freeze({ identity: contentIdentity(LEGACY_V7_CONTENT), catalog: LEGACY_V7_CONTENT.combat }) });
export function managementV9BuildContext(identity: unknown): BuildContentContext {
  if (!isManagementV9Identity(identity)) throw new TypeError('Unsupported internal v9 content identity');
  return context;
}
export const sameManagementV9Data = (a: unknown, b: unknown): boolean => canonicalStringify(a) === canonicalStringify(b);
