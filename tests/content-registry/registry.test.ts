import { describe, expect, it } from 'vitest';
import { cloneJson, stableHash } from '../../src/core/kernel/serialization';
import { combatCatalog } from '../../src/content/definitions';
import { EXPEDITION_ENCOUNTERS, STARTER_ROUTE } from '../../src/core/expeditions/encounter-catalog';
import { EQUIPMENT_DEFINITIONS, SKILL_LEARNING_RULES } from '../../src/core/builds/rules';
import { LEGACY_V7_CONTENT, LEGACY_V7_PROVENANCE, RELEASE_V8_CANDIDATE, contentFingerprint, contentIdentity, resolveContentIdentity,
  type GameContentBundle } from '../../src/content/registry';
import { combatZhCN } from '../../src/content/locales/zh-CN/combat';
import { combatEn } from '../../src/content/locales/en/combat';

describe('versioned, opt-in gameplay content identities', () => {
  it('preserves the proven v7 catalog, encounter, route and build-rule data exactly', () => {
    expect(LEGACY_V7_PROVENANCE.sourceCommit).toBe('98e7026c9dfef68754a3ad9369d70aa3c2475195');
    expect(LEGACY_V7_CONTENT.combat).toEqual(combatCatalog);
    expect(contentIdentity(LEGACY_V7_CONTENT).combatFingerprint).toBe(stableHash(combatCatalog));
    expect(LEGACY_V7_CONTENT.encounters).toEqual(EXPEDITION_ENCOUNTERS);
    expect(LEGACY_V7_CONTENT.routes[0]!.specification).toEqual(STARTER_ROUTE);
    expect(LEGACY_V7_CONTENT.buildRules.equipment).toEqual(EQUIPMENT_DEFINITIONS);
    expect(LEGACY_V7_CONTENT.buildRules.lessons).toEqual(SKILL_LEARNING_RULES);
    expect(LEGACY_V7_CONTENT.offerRules.authoredTalentIds).toHaveLength(12);
    expect(LEGACY_V7_PROVENANCE.sourceHashes).not.toHaveProperty('src/core/expeditions/release-eligibility.ts');
    expect(Object.keys(LEGACY_V7_PROVENANCE.sourceHashes).length).toBeGreaterThan(20);
  });
  it('contains all starter and later encounters and all obtainable growth categories in the candidate', () => {
    const release = RELEASE_V8_CANDIDATE;
    expect(release.encounters).toHaveLength(11); expect(release.routes).toHaveLength(5);
    expect(release.buildRules.equipment).toHaveLength(10); expect(release.buildRules.lessons).toHaveLength(24);
    expect(release.campaign?.knowledge).toHaveLength(3); expect(release.campaign?.recruits).toHaveLength(4);
    expect(release.combat.talents).toHaveLength(48);
    const ids = new Set(release.encounters.map(encounter => encounter.id));
    expect(ids.size).toBe(11);
    for (const route of release.routes) for (const id of [...route.specification.regularEncounterIds, route.specification.bossEncounterId]) expect(ids.has(id)).toBe(true);
    expect(release.blockers).toContain('extra-target-stagger');
    expect(release.blockers).not.toContain('juyao-chengquan-legal-acquisition-witness');
    const producer = release.combat.talents.find(talent => talent.id === 'talent.jingdan-shenghua')!;
    expect(producer.mechanics.triggers.flatMap(trigger => trigger.effects).find(effect => effect.kind === 'applyStatus' && effect.statusId === 'status.medicine')).toMatchObject({ duration: { kind: 'ticks', ticks: 400 } });
  });
  it('fails closed for unknown, mismatched and not-yet-live candidate identities', () => {
    for (const malformed of [null, [], 'content.legacy-v7', {}, Object.create(null)]) expect(resolveContentIdentity(malformed)).toBeNull();
    let invoked = false; const accessor = { get registryId() { invoked = true; return 'content.legacy-v7'; }, compositeFingerprint: 'x', combatFingerprint: 'x', buildRulesVersion: 1 };
    expect(resolveContentIdentity(accessor)).toBeNull(); expect(invoked).toBe(false);
    const legacy = contentIdentity(LEGACY_V7_CONTENT); const candidate = contentIdentity(RELEASE_V8_CANDIDATE);
    expect(resolveContentIdentity(legacy)).toBe(LEGACY_V7_CONTENT);
    expect(resolveContentIdentity(candidate)).toBeNull();
    expect(resolveContentIdentity(candidate, { allowCandidate: true })).toBe(RELEASE_V8_CANDIDATE);
    for (const wrong of [{ ...legacy, registryId: 'content.future' }, { ...legacy, compositeFingerprint: '00000000' },
      { ...legacy, combatFingerprint: '00000000' }, { ...legacy, buildRulesVersion: 99 }]) expect(resolveContentIdentity(wrong, { allowCandidate: true })).toBeNull();
  });
  it('makes every gameplay category and explicit protocol part of the composite fingerprint', () => {
    const original = contentFingerprint(RELEASE_V8_CANDIDATE);
    const mutate = (change: (copy: GameContentBundle) => void) => {
      const copy = cloneJson(RELEASE_V8_CANDIDATE) as GameContentBundle; change(copy);
      expect(contentFingerprint(copy)).not.toBe(original);
    };
    mutate(copy => { copy.worldContentVersion += '.changed'; });
    mutate(copy => { copy.combat = { ...copy.combat, contentVersion: 'changed' }; });
    mutate(copy => { copy.encounters = copy.encounters.map((entry, index) => index ? entry : { ...entry, maximumTicks: entry.maximumTicks + 1 }); });
    mutate(copy => { copy.routes = copy.routes.map((entry, index) => index ? entry : { ...entry, specification: { ...entry.specification, returnMonths: 2 } }); });
    mutate(copy => { copy.buildRules = { ...copy.buildRules, equipment: copy.buildRules.equipment.map((entry, index) => index ? entry : { ...entry, maximumSpiritBonus: 999 }) }; });
    mutate(copy => { copy.buildRules = { ...copy.buildRules, lessons: copy.buildRules.lessons.map((entry, index) => index ? entry : { ...entry, creditCost: 99 }) }; });
    mutate(copy => { copy.offerRules = { ...copy.offerRules, protocol: 'different-offer' }; });
    mutate(copy => { copy.campaign = { ...copy.campaign!, knowledge: copy.campaign!.knowledge.map((entry, index) => index ? entry : { ...entry, skillId: 'different-skill' }) }; });
    mutate(copy => { copy.campaign = { ...copy.campaign!, recruits: copy.campaign!.recruits.map((entry, index) => index ? entry : { ...entry, aptitude: 1 }) }; });
    mutate(copy => { copy.campaign = { ...copy.campaign!, recruitCosts: [{ resourceId: 'meal', quantity: 99 }] }; });
    mutate(copy => { copy.campaign = { ...copy.campaign!, recoveryResources: [{ resourceId: 'meal', quantity: 99 }] }; });
    mutate(copy => { copy.campaign = { ...copy.campaign!, maximumClaims: 17 }; });
    mutate(copy => { copy.campaign = { ...copy.campaign!, reliefPolicy: { ...copy.campaign!.reliefPolicy, cooldownMonths: 24 } }; });
    mutate(copy => { copy.campaign = { ...copy.campaign!, reliefPolicy: { ...copy.campaign!.reliefPolicy, costs: [{ resourceId: 'meal', quantity: 9 }] } }; });
    for (const protocol of Object.keys(RELEASE_V8_CANDIDATE.protocols) as (keyof GameContentBundle['protocols'])[]) mutate(copy => { copy.protocols = { ...copy.protocols, [protocol]: 'changed-protocol' }; });
  });
  it('deeply freezes shared data and keeps translations outside simulation identity', () => {
    const before = contentIdentity(LEGACY_V7_CONTENT);
    expect(Object.isFrozen(LEGACY_V7_CONTENT.buildRules.equipment[0])).toBe(true);
    const detached = cloneJson(LEGACY_V7_CONTENT) as GameContentBundle;
    detached.buildRules.maximumCommands = 3;
    expect(contentIdentity(LEGACY_V7_CONTENT)).toEqual(before);
    const key = LEGACY_V7_CONTENT.combat.skills[0]!.nameKey;
    expect(Object.hasOwn(combatZhCN, key)).toBe(true);
    expect(combatZhCN[key as keyof typeof combatZhCN]).not.toBe(combatEn[key as keyof typeof combatEn]);
    expect(contentIdentity(LEGACY_V7_CONTENT)).toEqual(before);
  });
});
