import type { GameContentIdentity } from '../registry';
import type { BuildContentContext } from '../../core/builds/v2-types';
import { stableHash } from '../../core/kernel/serialization';
import { MANAGEMENT_V9_IDENTITY, managementV9BuildContext } from '../sect-v9/world-content';
import { SECT_V9_CANDIDATE_IDENTITY } from '../sect-v9/catalog';
import { MANAGEMENT_V10_PROTOCOL, MANAGEMENT_V10_TICK_ORDER, SECT_POWDER_RECIPE_IDS_V10, SECT_UPGRADE_LIMITS_V10 } from '../../core/sect-expansion/upgrade-types';

/** Fixed protocol identity only. This does not register a runtime or admit a save. */
export const MANAGEMENT_V10_CONTENT_VERSION = MANAGEMENT_V10_PROTOCOL.contentVersion;
export const MANAGEMENT_V10_IDENTITY: Readonly<GameContentIdentity> = Object.freeze({
  registryId: MANAGEMENT_V10_PROTOCOL.registryId,
  compositeFingerprint: stableHash({
    protocol: MANAGEMENT_V10_PROTOCOL,
    base: MANAGEMENT_V9_IDENTITY,
    sect: SECT_V9_CANDIDATE_IDENTITY,
    upgradeLimits: SECT_UPGRADE_LIMITS_V10,
    powderRecipes: SECT_POWDER_RECIPE_IDS_V10,
    maintenanceIntervalTicks: 1200,
    tickOrder: MANAGEMENT_V10_TICK_ORDER,
  }),
  combatFingerprint: MANAGEMENT_V9_IDENTITY.combatFingerprint,
  buildRulesVersion: 2,
});

/** Descriptor-only comparison: never invoke identity accessors; hostile reflection fails closed. */
export function isManagementV10Identity(identity: unknown): boolean {
  try {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || Object.getPrototypeOf(identity) !== Object.prototype || Reflect.ownKeys(identity).length !== 4) return false;
    for (const [key, expected] of Object.entries(MANAGEMENT_V10_IDENTITY)) {
      const descriptor = Object.getOwnPropertyDescriptor(identity, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value !== expected) return false;
    }
    return true;
  } catch { return false; }
}

/** New World protocol, unchanged permanent-build rules/history identity. */
export function managementV10BuildContext(worldIdentity: unknown): BuildContentContext {
  if (!isManagementV10Identity(worldIdentity)) throw new TypeError('Unsupported management v10 content identity');
  return managementV9BuildContext(MANAGEMENT_V9_IDENTITY);
}
