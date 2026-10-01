import { describe, expect, it } from 'vitest';
import { combatCatalog } from '../../src/content/definitions';
import { releaseCatalogIdentity, releaseCombatCatalog, releaseCombatEn, releaseCombatZhCN, releaseCombatMessageSpecifications, releaseTalentRows, proposedExtraTargetStaggerOverride } from '../../src/content/release';
import { validateCombatCatalog } from '../../src/content/schemas';
import { combatDefinitionSupport } from '../../src/core/combat';
import { stableHash } from '../../src/core/kernel/serialization';
import { validateLocales } from '../../src/i18n/validation';
import { SKILL_LEARNING_RULES, STARTER_SKILLS } from '../../src/core/builds/rules';
import { createExpedition, legalTalentCandidates } from '../../src/core/expeditions';
import { options } from '../expeditions/fixtures';

const next = releaseCombatCatalog;
describe('opt-in release catalog', () => {
  it('composes exactly 48 meaningful cards with 12 per build and 3 added roles of each kind', () => {
    expect(releaseTalentRows).toHaveLength(36); expect(next.talents).toHaveLength(48);
    for (const build of next.builds) {
      expect(build.talentIds).toHaveLength(12);
      for (const role of ['core', 'support', 'bridge']) expect(releaseTalentRows.filter(row => row.definition.buildId === build.id && row.definition.offerRole === role)).toHaveLength(3);
    }
    expect(new Set(next.talents.map(card => card.id)).size).toBe(48);
    expect(next.talents.filter(card => card.holderScope === 'personal')).toHaveLength(36);
    expect(next.talents.filter(card => card.holderScope === 'team')).toHaveLength(12);
    for (const [category, total] of [['general', 12], ['school', 24], ['crossSchool', 8], ['route', 4]] as const) expect(next.talents.filter(card => card.category === category)).toHaveLength(total);
    expect(releaseTalentRows.every(row => row.definition.mechanics.triggers.length > 0 && row.definition.mechanics.onInstall.length === 0 && row.definition.mechanics.actionRules.length === 0)).toBe(true);
    // Counts cannot stand in for unique behavior: no program is just a copied numeric modifier.
    const signatures = releaseTalentRows.map(row => JSON.stringify(row.definition.mechanics));
    expect(new Set(signatures).size).toBe(36);
  });
  it('passes strict structure/reference/capability and both-language parameter validation', () => {
    const result = validateCombatCatalog(next, { locales: { 'zh-CN': releaseCombatZhCN, en: releaseCombatEn } });
    expect(result.errors).toEqual([]); expect(result.warnings.some(issue => issue.code === 'incomplete-talent-catalog')).toBe(false);
    const locale = validateLocales(releaseCombatZhCN, releaseCombatEn, releaseCombatMessageSpecifications);
    expect(locale.errors).toEqual([]); expect(locale.missingEnglishKeys).toEqual([]);
    for (const row of releaseTalentRows) {
      expect(combatDefinitionSupport(next, row.definition.id)).toEqual({ supported: true, reasons: [] });
      expect(row.zhDescription).toMatch(/个人|全队/); expect(row.enDescription).toMatch(/Personal:|Team:/);
      expect(row.zhDescription.length).toBeGreaterThan(40); expect(row.enDescription.length).toBeGreaterThan(90);
    }
  });
  it('keeps all original definitions byte-identical, including the honest Stagger blocker', () => {
    expect(combatCatalog.talents).toHaveLength(12);
    for (const original of combatCatalog.talents) expect(next.talents.find(card => card.id === original.id)).toEqual(original);
    expect(next.skills).toEqual(combatCatalog.skills); expect(next.statuses).toEqual(combatCatalog.statuses);
    expect(releaseCatalogIdentity.currentCombatFingerprint).toBe(stableHash(combatCatalog));
    expect(releaseCatalogIdentity.combatFingerprint).not.toBe(stableHash(combatCatalog));
    expect(combatDefinitionSupport(next, 'talent.zoumai-chengfu').supported).toBe(false);
    expect(proposedExtraTargetStaggerOverride).toMatchObject({ extraTargetStatus: { statusId: 'status.stagger', durationTicks: 16, stacks: 1 }, oldCatalogMutationAllowed: false, migrationRequired: true });
  });
  it('does not silently bypass live expedition admission or its old fingerprint', () => {
    const run = createExpedition(options(), next);
    const ids = legalTalentCandidates(run, next).map(card => card.definitionId);
    expect(ids.every(id => combatCatalog.talents.some(card => card.id === id))).toBe(true);
    expect(releaseCatalogIdentity.admission).toBe('not-live-until-explicit-migration');
    expect(releaseCatalogIdentity.blockers).toHaveLength(2);
  });
  it('ties every new engine to genuinely learnable skills and valid earlier talent prerequisites', () => {
    const obtainable = new Set([...Object.values(STARTER_SKILLS).flat(), ...SKILL_LEARNING_RULES.map(rule => rule.skillId)]);
    for (const row of releaseTalentRows) {
      expect(row.evidenceSkillIds.length).toBeGreaterThan(0);
      for (const id of row.evidenceSkillIds) {
        expect(obtainable.has(id), `${row.definition.id}: ${id}`).toBe(true);
        expect(next.skills.some(skill => skill.id === id)).toBe(true);
      }
      for (const id of row.definition.prerequisites) expect(row.evidenceTalentIds).toContain(id);
      for (const id of row.evidenceTalentIds) expect(next.talents.some(card => card.id === id)).toBe(true);
    }
  });
  it('bounds source ownership, shared counters, and emergency effects without permitting self-proc loops', () => {
    for (const row of releaseTalentRows) {
      expect(row.definition.lifecycleScope).toBe('run');
      expect(row.definition.teamStackPolicy).toBe(row.definition.holderScope === 'team' ? 'highestValueSharedBudget' : 'notApplicable');
      for (const trigger of row.definition.mechanics.triggers) {
        expect(trigger.proc.oncePerRoot).toBe(true);
        expect(trigger.proc.allowIndirectFamilies).not.toContain(trigger.proc.family);
        expect(trigger.proc.maximumActivations).toBeLessThanOrEqual(120);
        if (trigger.effects.some(effect => ['rescue', 'preventDowned'].includes(effect.kind))) {
          expect(trigger.proc.maximumActivations).toBe(1); expect(trigger.proc.activationScope).toBe('encounter');
        }
      }
    }
  });
});
