import { describe, expect, it } from 'vitest';
import { combatContentTranslator } from '../../src/application/combat-content-text';
import { allCombatDefinitions, combatCatalog } from '../../src/content/definitions';
import { combatMessageSpecifications } from '../../src/content/definitions/messages';
import { combatEn } from '../../src/content/locales/en/combat';
import { combatZhCN } from '../../src/content/locales/zh-CN/combat';
import { LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE } from '../../src/content/registry';
import { releaseCombatCatalog, releaseCombatEn, releaseCombatZhCN, releaseTalentRows } from '../../src/content/release';
import { prepareCombatCatalog } from '../../src/core/combat/runtime/catalog';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { createTranslator, SAFE_TRANSLATION_MESSAGE } from '../../src/i18n';

const locales = ['zh-CN', 'en'] as const;
const legacyText = createTranslator({ baseCatalog: combatZhCN, englishCatalog: combatEn, specifications: combatMessageSpecifications });

describe('catalog-selected combat text', () => {
  it.each(locales)('renders every release talent name and description in %s without missing text', locale => {
    const catalog = RELEASE_V8_CANDIDATE.combat;
    const text = combatContentTranslator(catalog);
    const localeCatalog: Readonly<Record<string, string>> = locale === 'en' ? releaseCombatEn : releaseCombatZhCN;
    expect(catalog.talents).toHaveLength(48);
    for (const talent of catalog.talents) {
      const name = text(locale, talent.nameKey);
      const description = text(locale, talent.descriptionKey, talent.descriptionParameters);
      expect(name, talent.id).not.toBe(SAFE_TRANSLATION_MESSAGE);
      expect(description, talent.id).not.toBe(SAFE_TRANSLATION_MESSAGE);
      expect(name).toBe(localeCatalog[talent.nameKey]);
      expect(description).not.toMatch(/\{[A-Za-z][A-Za-z0-9_]*\}/);
    }
    for (const row of releaseTalentRows) {
      expect(text(locale, row.definition.nameKey)).toBe(locale === 'en' ? row.enName : row.zhName);
      expect(text(locale, row.definition.descriptionKey, row.definition.descriptionParameters)).toBe(locale === 'en' ? row.enDescription : row.zhDescription);
    }
  });

  it.each(locales)('preserves all frozen legacy text and its parameter formatting in %s', locale => {
    const before = canonicalStringify(LEGACY_V7_CONTENT);
    const text = combatContentTranslator(LEGACY_V7_CONTENT.combat);
    for (const definition of allCombatDefinitions(LEGACY_V7_CONTENT.combat)) {
      expect(text(locale, definition.nameKey)).toBe(legacyText(locale, definition.nameKey));
      expect(text(locale, definition.descriptionKey, definition.descriptionParameters)).toBe(legacyText(locale, definition.descriptionKey, definition.descriptionParameters));
    }
    expect(canonicalStringify(LEGACY_V7_CONTENT)).toBe(before);
  });

  it('keeps authored parameters intact and retains strict parameter validation for each catalog', () => {
    for (const catalog of [LEGACY_V7_CONTENT.combat, RELEASE_V8_CANDIDATE.combat]) {
      const definition = catalog.skills.find(skill => skill.id === 'skill.liuhen-jian')!;
      const text = combatContentTranslator(catalog);
      const before = canonicalStringify(definition);
      const params = { cost: 1234, cooldownTicks: 5678, castTicks: 90 };
      expect(text('en', definition.descriptionKey, params)).toBe('Strike and apply Sword Mark. Spirit 1,234; cooldown 5,678 ticks; wind-up 90 ticks.');
      expect(text('zh-CN', definition.descriptionKey, params)).toBe(legacyText('zh-CN', definition.descriptionKey, params));
      expect(text('en', definition.descriptionKey, {})).toBe(SAFE_TRANSLATION_MESSAGE);
      expect(text('en', definition.descriptionKey, { ...params, cost: '1234' })).toBe(SAFE_TRANSLATION_MESSAGE);
      expect(text('en', definition.descriptionKey, { ...params, extra: 1 })).toBe(SAFE_TRANSLATION_MESSAGE);
      expect(canonicalStringify(definition)).toBe(before);
    }
  });

  it('reuses only the exact trusted catalog selections without inspecting or hashing caller data', () => {
    const release = combatContentTranslator(releaseCombatCatalog);
    const legacy = combatContentTranslator(LEGACY_V7_CONTENT.combat);
    expect(releaseCombatCatalog).toBe(RELEASE_V8_CANDIDATE.combat);
    expect(release).toBe(combatContentTranslator(RELEASE_V8_CANDIDATE.combat));
    expect(legacy).toBe(combatContentTranslator());
    expect(legacy).toBe(combatContentTranslator(combatCatalog));
    expect(release).not.toBe(legacy);
    const copy = cloneJson(releaseCombatCatalog);
    const inputs = [copy, Object.freeze(cloneJson(releaseCombatCatalog)), prepareCombatCatalog(cloneJson(releaseCombatCatalog)),
      new Proxy(copy, { get() { throw new Error('Catalog selection must not read or hash caller properties'); } })];
    for (const input of inputs) {
      expect(combatContentTranslator(input)).toBe(legacy);
      expect(combatContentTranslator(input)('en', releaseTalentRows[0]!.definition.nameKey)).toBe(SAFE_TRANSLATION_MESSAGE);
    }
    expect(Object.isFrozen(copy)).toBe(false);
  });

  it('does not mutate catalog data, locale data, or identities when the displayed locale changes', () => {
    const before = canonicalStringify({ legacy: LEGACY_V7_CONTENT, release: RELEASE_V8_CANDIDATE, combatZhCN, combatEn, releaseCombatZhCN, releaseCombatEn });
    for (const catalog of [LEGACY_V7_CONTENT.combat, RELEASE_V8_CANDIDATE.combat]) {
      const text = combatContentTranslator(catalog);
      for (const locale of ['zh-CN', 'en', 'zh-CN'] as const) {
        for (const definition of allCombatDefinitions(catalog)) {
          text(locale, definition.nameKey);
          text(locale, definition.descriptionKey, definition.descriptionParameters);
        }
      }
    }
    expect(canonicalStringify({ legacy: LEGACY_V7_CONTENT, release: RELEASE_V8_CANDIDATE, combatZhCN, combatEn, releaseCombatZhCN, releaseCombatEn })).toBe(before);
  });
});
