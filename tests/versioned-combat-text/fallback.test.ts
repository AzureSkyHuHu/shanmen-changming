import { describe, expect, it, vi } from 'vitest';
import { combatContentTranslator } from '../../src/application/combat-content-text';
import { RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import { releaseCombatCatalog, releaseCombatEn, releaseTalentRows } from '../../src/content/release';
import { battleDefinitionName } from '../../src/phaser/PhaserBattle';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { SAFE_TRANSLATION_MESSAGE } from '../../src/i18n';

// Simulate an incomplete English release at the module boundary. The actual registered
// catalog and Chinese text are untouched, and other test files see the original module.
vi.mock('../../src/content/release', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/content/release')>();
  const english: Record<string, string> = { ...actual.releaseCombatEn };
  const first = actual.releaseTalentRows[0]!.definition;
  delete english[first.nameKey]; delete english[first.descriptionKey];
  english[actual.releaseTalentRows[1]!.definition.descriptionKey] = '';
  delete english['combat.skill.liuhen-jian.description'];
  return { ...actual, releaseCombatEn: Object.freeze(english) };
});

describe('selected release per-key Chinese fallback', () => {
  it('falls back only for missing/empty English keys while the next key remains English', () => {
    const text = combatContentTranslator(RELEASE_V8_CANDIDATE.combat);
    const first = releaseTalentRows[0]!; const second = releaseTalentRows[1]!;
    const before = canonicalStringify({ catalog: releaseCombatCatalog, english: releaseCombatEn });
    expect(text('en', first.definition.nameKey)).toBe(first.zhName);
    expect(text('en', first.definition.descriptionKey, first.definition.descriptionParameters)).toBe(first.zhDescription);
    expect(text('en', second.definition.nameKey)).toBe(second.enName);
    expect(text('en', second.definition.descriptionKey, second.definition.descriptionParameters)).toBe(second.zhDescription);
    expect(battleDefinitionName('en', first.definition.id, RELEASE_V8_CANDIDATE.combat)).toBe(first.zhName);
    expect(text('zh-CN', first.definition.nameKey)).toBe(first.zhName);
    expect(text('en', second.definition.nameKey)).toBe(second.enName);
    expect(canonicalStringify({ catalog: releaseCombatCatalog, english: releaseCombatEn })).toBe(before);
  });

  it('keeps parameters and English numeric formatting when a parameterized key falls back', () => {
    const text = combatContentTranslator(releaseCombatCatalog);
    const key = 'combat.skill.liuhen-jian.description';
    const parameters = { cost: 1234, cooldownTicks: 5678, castTicks: 90 };
    const result = text('en', key, parameters);
    expect(result).toBe(text('zh-CN', key, parameters));
    expect(result).not.toBe(SAFE_TRANSLATION_MESSAGE);
    expect(result).toContain('1,234'); expect(result).toContain('5,678'); expect(result).toContain('90');
    expect(result).not.toMatch(/\{[A-Za-z][A-Za-z0-9_]*\}/);
    expect(parameters).toEqual({ cost: 1234, cooldownTicks: 5678, castTicks: 90 });
  });
});
