import { describe, expect, it } from 'vitest';
import { en } from '../../src/content/locales/en/index.ts';
import { zhCN } from '../../src/content/locales/zh-CN/index.ts';
import { requiredTextKeys } from '../../src/i18n/messages.ts';
import { validateLocales } from '../../src/i18n/validation.ts';

describe('locale content validation', () => {
  it('has complete Chinese coverage for every registered stable key', () => {
    const result = validateLocales(zhCN, en);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checkedKeys).toBe(requiredTextKeys.length);
    expect(Object.keys(zhCN).sort()).toEqual([...requiredTextKeys].sort());
  });

  it.each([undefined, '', '   '])('rejects an absent or empty Chinese base: %s', (value) => {
    const result = validateLocales({ ...zhCN, 'app.title': value }, en);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ locale: 'zh-CN', key: 'app.title', code: 'missing-base' }));
  });

  it('allows partial English and reports fallback coverage', () => {
    const result = validateLocales(zhCN, { 'app.title': '', 'app.subtitle': '   ' });
    expect(result.valid).toBe(true);
    expect(result.missingEnglishKeys).toEqual(requiredTextKeys);
  });

  it('rejects mismatched English parameter names and wrong plural parameter types', () => {
    const result = validateLocales(zhCN, {
      ...en,
      'disciple.welcome': { plural: { parameter: 'name', other: 'Welcome {name}.' } },
      'world.disciples.summary': '{amount} disciples are cultivating.',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((issue) => issue.key === 'disciple.welcome' && issue.detail.includes('numeric'))).toBe(true);
    expect(result.errors.some((issue) => issue.key === 'world.disciples.summary' && issue.detail.includes('Parameter names'))).toBe(true);
  });

  it('checks every plural branch and requires an other branch', () => {
    const result = validateLocales(zhCN, {
      ...en,
      'world.disciples.summary': { plural: { parameter: 'count', one: '{wrong} disciple.' } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((issue) => issue.detail.includes('other sentence'))).toBe(true);
    expect(result.errors.some((issue) => issue.detail.includes('Parameter names'))).toBe(true);
  });

  it.each(['Welcome {{name}}.', 'Welcome {name.toString()}.', 'Welcome {name, select, x}.'])('rejects unsupported template syntax: %s', (template) => {
    expect(validateLocales(zhCN, { ...en, 'disciple.welcome': template }).valid).toBe(false);
  });

  it('rejects unknown keys rather than masking an unregistered source string', () => {
    expect(validateLocales({ ...zhCN, 'unknown.new.key': '新内容' }, en).errors).toContainEqual(
      expect.objectContaining({ key: 'unknown.new.key', code: 'undeclared-key' }),
    );
  });
});
