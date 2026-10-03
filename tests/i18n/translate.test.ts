import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/content/locales/en/index.ts';
import { zhCN } from '../../src/content/locales/zh-CN/index.ts';
import {
  clearLocaleDiagnostics,
  createTranslator,
  getLocaleDiagnostics,
  SAFE_TRANSLATION_MESSAGE,
  translate,
  type TextKey,
  type TranslationParams,
} from '../../src/i18n/index.ts';

describe('Chinese-first text resolution', () => {
  it('keeps the original title and provides English per key', () => {
    expect(translate('zh-CN', 'app.title')).toBe('山门长明');
    expect(translate('en', 'app.title')).toBe('山门长明');
    expect(translate('en', 'settings.language.label')).toBe('Language');
  });

  it.each([
    ['zh-CN', '读取将以所选存档替换当前进度；如有未保存的更改，将会丢失。是否继续？', '当前未保存的进度'],
    ['en', 'Loading will replace the current session with the selected save. Any unsaved changes will be lost. Continue?', 'current unsaved progress'],
  ] as const)('warns about possible unsaved changes without asserting they exist in %s', (locale, expected, oldAssertion) => {
    const warning = translate(locale, 'save.loadWarning');
    expect(warning).toBe(expected);
    expect(warning).not.toContain(oldAssertion);
  });

  it('falls back independently for absent, empty and whitespace-only English', () => {
    const english: Record<string, unknown> = { ...en };
    delete english['app.subtitle'];
    english['app.phase'] = '';
    english['app.status'] = '   \n\t';
    const t = createTranslator({ englishCatalog: english });
    expect(t('en', 'app.subtitle')).toBe(zhCN['app.subtitle']);
    expect(t('en', 'app.phase')).toBe(zhCN['app.phase']);
    expect(t('en', 'app.status')).toBe(zhCN['app.status']);
    expect(t('en', 'settings.language.label')).toBe('Language');
  });

  it('shows a safe Chinese message for unknown keys and records a local diagnostic', () => {
    clearLocaleDiagnostics();
    expect(translate('en', 'internal.secret.key' as TextKey)).toBe(SAFE_TRANSLATION_MESSAGE);
    expect(getLocaleDiagnostics()).toEqual([{ code: 'unknown-key', locale: 'en', key: 'internal.secret.key' }]);
    clearLocaleDiagnostics();
  });

  it('does not resolve inherited object property names as text keys', () => {
    const t = createTranslator();
    expect(t('en', 'toString')).toBe(SAFE_TRANSLATION_MESSAGE);
    expect(t('en', '__proto__')).toBe(SAFE_TRANSLATION_MESSAGE);
  });

  it('handles missing Chinese content even when English has a value', () => {
    const chinese: Record<string, unknown> = { ...zhCN };
    delete chinese['app.title'];
    const diagnostics: unknown[] = [];
    const t = createTranslator({ baseCatalog: chinese, onDiagnostic: (item) => diagnostics.push(item) });
    expect(t('en', 'app.title')).toBe(SAFE_TRANSLATION_MESSAGE);
    expect(diagnostics).toEqual([{ code: 'invalid-base-message', key: 'app.title', locale: 'en' }]);
  });

  it('recovers from broken English parameters without exposing the broken template', () => {
    const t = createTranslator({ englishCatalog: { ...en, 'disciple.welcome': 'Welcome {wrongName}.' } });
    expect(t('en', 'disciple.welcome', { name: '清风' })).toBe('欢迎清风加入山门。');
  });

  it('does not allow a throwing diagnostic callback to crash the display', () => {
    const t = createTranslator({ onDiagnostic() { throw new Error('sink unavailable'); } });
    expect(t('en', 'missing')).toBe(SAFE_TRANSLATION_MESSAGE);
  });
});

describe('named parameters and localized formatting', () => {
  it.each([
    [0, '0 disciples are cultivating at the mountain gate.'],
    [1, '1 disciple is cultivating at the mountain gate.'],
    [2, '2 disciples are cultivating at the mountain gate.'],
  ])('selects the English plural for %s', (count, expected) => {
    expect(translate('en', 'world.disciples.summary', { count })).toBe(expected);
    expect(translate('zh-CN', 'world.disciples.summary', { count })).toBe(`${count}名弟子正在山门修行。`);
  });

  it('formats percentages, decimals and durations with declared units', () => {
    expect(translate('en', 'cultivation.progress', { progress: 0.125 })).toBe('Current cultivation progress is 12.5%.');
    expect(translate('zh-CN', 'cultivation.progress', { progress: 0 })).toBe('当前修炼进度为0%。');
    expect(translate('en', 'resource.amount', { name: 'spirit stones', amount: 1234.5 })).toBe('You currently have 1,234.5 of spirit stones.');
    expect(translate('en', 'production.remaining', { seconds: 1 })).toBe('Production will finish in 1 second.');
    expect(translate('zh-CN', 'production.remaining', { seconds: 2.5 })).toBe('生产还需2.5秒。');
  });

  const invalidParameterCases: TranslationParams[] = [
    {},
    { count: '1' },
    { count: 1, extra: 'unregistered' },
    { count: NaN },
    { count: Infinity },
    { count: 1.5 },
    { count: Number.MAX_SAFE_INTEGER + 1 },
  ];
  it.each(invalidParameterCases)('rejects missing, extra or invalid typed parameters: %s', (params) => {
    expect(translate('en', 'world.disciples.summary', params)).toBe(SAFE_TRANSLATION_MESSAGE);
  });

  it('never invokes toString on invalid user values', () => {
    const params = { name: { toString() { throw new Error('do not execute'); } } } as unknown as TranslationParams;
    expect(translate('en', 'disciple.welcome', params)).toBe(SAFE_TRANSLATION_MESSAGE);
  });

  it('keeps custom names intact and leaves HTML escaping to the React text node', () => {
    const name = '<img src=x onerror="alert(1)"> & 清风 {count} $&';
    const text = translate('en', 'disciple.welcome', { name });
    expect(text).toBe(`Welcome ${name} to the sect.`);
    const markup = renderToStaticMarkup(createElement('p', null, text));
    expect(markup).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; 清风 {count} $&amp;');
    expect(markup).not.toContain('<img');
    expect(translate('zh-CN', 'disciple.welcome', { name })).toBe(`欢迎${name}加入山门。`);
  });

  it('selects Chinese plural rules when an English plural message is missing', () => {
    const chinese = { ...zhCN, 'world.disciples.summary': {
      plural: { parameter: 'count', one: '单数分支{count}。', other: '中文分支{count}。' },
    } };
    const t = createTranslator({ baseCatalog: chinese, englishCatalog: {} });
    expect(t('en', 'world.disciples.summary', { count: 1 })).toBe('中文分支1。');
  });
});
