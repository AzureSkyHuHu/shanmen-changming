import { describe, expect, it } from 'vitest';
import { MANAGEMENT_V9_IDENTITY, isManagementV9Identity, managementV9BuildContext } from '../../src/content/sect-v9/world-content';
import { MANAGEMENT_V10_IDENTITY, isManagementV10Identity, managementV10BuildContext } from '../../src/content/sect-v10/world-content';
import { MANAGEMENT_V10_PROTOCOL, MANAGEMENT_V10_TICK_ORDER, SECT_POWDER_RECIPE_IDS_V10, SECT_UPGRADE_LIMITS_V10 } from '../../src/core/sect-expansion/upgrade-types';
import { SECT_V9_CANDIDATE_IDENTITY } from '../../src/content/sect-v9/catalog';
import { stableHash } from '../../src/core/kernel/serialization';
import { createUnregisteredWorldV9 } from '../../src/core/world/create-world-v9';
import { applyBuildCommandV2, restoreBuildsV2, serializeBuildsV2, validateBuildFrameV2 } from '../../src/core/builds/v2';

describe('fixed v10 World identity and unchanged permanent-build authority', () => {
  it('hashes the exact frozen contract and keeps combat rules unchanged', () => {
    expect(MANAGEMENT_V10_IDENTITY.compositeFingerprint).toBe(stableHash({ protocol: MANAGEMENT_V10_PROTOCOL,
      base: MANAGEMENT_V9_IDENTITY, sect: SECT_V9_CANDIDATE_IDENTITY, upgradeLimits: SECT_UPGRADE_LIMITS_V10,
      powderRecipes: SECT_POWDER_RECIPE_IDS_V10, maintenanceIntervalTicks: 1200, tickOrder: MANAGEMENT_V10_TICK_ORDER }));
    expect(MANAGEMENT_V10_IDENTITY.compositeFingerprint).not.toBe(MANAGEMENT_V9_IDENTITY.compositeFingerprint);
    expect(MANAGEMENT_V10_IDENTITY.combatFingerprint).toBe(MANAGEMENT_V9_IDENTITY.combatFingerprint);
    expect(Object.isFrozen(MANAGEMENT_V10_IDENTITY)).toBe(true);
  });
  it('returns the existing exact build context without relabeling it', () => {
    const context = managementV10BuildContext({ ...MANAGEMENT_V10_IDENTITY });
    expect(context).toBe(managementV9BuildContext(MANAGEMENT_V9_IDENTITY));
    expect(context.identity).toBe(MANAGEMENT_V9_IDENTITY);
    expect(isManagementV9Identity(MANAGEMENT_V10_IDENTITY)).toBe(false);
    expect(isManagementV10Identity(MANAGEMENT_V9_IDENTITY)).toBe(false);
    expect(() => managementV10BuildContext(MANAGEMENT_V9_IDENTITY)).toThrow(TypeError);
  });
  it('rejects missing, changed, extra and inherited identity fields', () => {
    for (const key of Object.keys(MANAGEMENT_V10_IDENTITY)) {
      const missing: Record<string, unknown> = { ...MANAGEMENT_V10_IDENTITY }; delete missing[key];
      expect(isManagementV10Identity(missing)).toBe(false);
      expect(isManagementV10Identity({ ...MANAGEMENT_V10_IDENTITY, [key]: 'forged' })).toBe(false);
    }
    for (const value of [null, [], Object.create(MANAGEMENT_V10_IDENTITY),
      { ...MANAGEMENT_V10_IDENTITY, extra: true }, { ...MANAGEMENT_V10_IDENTITY, [Symbol('extra')]: true }]) {
      expect(isManagementV10Identity(value)).toBe(false);
      expect(() => managementV10BuildContext(value)).toThrow(TypeError);
    }
  });
  it('does not invoke getters and safely rejects hostile reflection', () => {
    let reads = 0;
    const accessor = { ...MANAGEMENT_V10_IDENTITY };
    Object.defineProperty(accessor, 'registryId', { enumerable: true, get() { reads++; throw new Error('getter'); } });
    expect(isManagementV10Identity(accessor)).toBe(false); expect(reads).toBe(0);
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('reflection'); } });
    expect(isManagementV10Identity(hostile)).toBe(false);
    expect(() => managementV10BuildContext(hostile)).toThrow(TypeError);
    const hidden = { ...MANAGEMENT_V10_IDENTITY };
    Object.defineProperty(hidden, 'registryId', { enumerable: false });
    expect(isManagementV10Identity(hidden)).toBe(false);
  });
  it('reads genuine old build history and appends under the unchanged context', () => {
    const world = createUnregisteredWorldV9('v10-identity-build-continuation');
    const oldContext = managementV9BuildContext(MANAGEMENT_V9_IDENTITY);
    const newContext = managementV10BuildContext(MANAGEMENT_V10_IDENTITY);
    const before = serializeBuildsV2({ builds: world.builds, sequences: world.sequences }, oldContext);
    const frame = restoreBuildsV2(before, newContext);
    expect(serializeBuildsV2(frame, newContext)).toBe(before);
    const disciple = frame.builds.disciples[0]!;
    const result = applyBuildCommandV2(frame, { kind: 'loadout.set', commandId: 'test/v10-context/swap',
      expectedRevision: frame.builds.revision, discipleId: disciple.discipleId,
      loadout: { ...disciple.loadout, activeSkillIds: [disciple.loadout.activeSkillIds[1], disciple.loadout.activeSkillIds[0]] } }, newContext);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    validateBuildFrameV2(result.frame, oldContext);
    expect(result.frame.builds.contentIdentity).toEqual(MANAGEMENT_V9_IDENTITY);
    expect(result.frame.builds.history.slice(0, frame.builds.history.length)).toEqual(frame.builds.history);
    expect(result.frame.builds.origin).toEqual(frame.builds.origin);
    expect(result.frame.builds.migration).toEqual(frame.builds.migration);
    expect(restoreBuildsV2(serializeBuildsV2(result.frame, newContext), oldContext)).toEqual(result.frame);
  });
});
