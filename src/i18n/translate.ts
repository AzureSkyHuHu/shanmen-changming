import { en } from '../content/locales/en/index.ts';
import { zhCN } from '../content/locales/zh-CN/index.ts';
import { messageSpecifications, type TextKey } from './messages.ts';
import type {
  DiagnosticReporter,
  Locale,
  LocaleDiagnostic,
  MessageSpecifications,
  MessageSpec,
  MessageTemplate,
  ParameterSpec,
  TranslationParams,
} from './types.ts';
import { hasOwn, isEmptyTranslation, isMessageTemplate, type CatalogInput } from './validation.ts';

/** Deliberately Chinese even when corrupted content asks for an unknown English key. */
export const SAFE_TRANSLATION_MESSAGE = '文本暂不可用';

export interface TranslatorOptions {
  readonly baseCatalog?: CatalogInput;
  readonly englishCatalog?: CatalogInput;
  readonly specifications?: MessageSpecifications;
  readonly onDiagnostic?: DiagnosticReporter;
}

function validParameters(params: TranslationParams, spec: MessageSpec): boolean {
  const expected = Object.keys(spec.parameters);
  if (Object.keys(params).length !== expected.length) return false;
  return expected.every((name) => {
    if (!hasOwn(params, name)) return false;
    const value = params[name];
    const parameter = spec.parameters[name]!;
    if (parameter.type === 'string') return typeof value === 'string';
    return typeof value === 'number' && Number.isFinite(value) && (parameter.format !== 'integer' || Number.isSafeInteger(value));
  });
}

function formatParameter(locale: Locale, value: string | number, spec: ParameterSpec): string {
  if (spec.type === 'string') return value as string;
  const options: Intl.NumberFormatOptions = spec.format === 'percent'
    ? { style: 'percent', maximumFractionDigits: 2 }
    : { maximumFractionDigits: spec.format === 'integer' ? 0 : 3 };
  return new Intl.NumberFormat(locale, options).format(value as number);
}

function selectSentence(locale: Locale, template: MessageTemplate, params: TranslationParams): string {
  if (typeof template === 'string') return template;
  const { parameter, one, other } = template.plural;
  const category = new Intl.PluralRules(locale).select(params[parameter] as number);
  return category === 'one' && one !== undefined ? one : other;
}

/**
 * A minimal, local-only plain-text adapter, not a full ICU/i18next implementation.
 * The caller must render the result as a text node, never innerHTML.
 */
export function createTranslator(options: TranslatorOptions = {}) {
  const baseCatalog: CatalogInput = options.baseCatalog ?? zhCN;
  const englishCatalog: CatalogInput = options.englishCatalog ?? en;
  const specifications: MessageSpecifications = options.specifications ?? messageSpecifications;

  function report(code: LocaleDiagnostic['code'], locale: Locale, key: string): void {
    // A diagnostic sink cannot break an otherwise usable display. Never log parameter values.
    try { options.onDiagnostic?.({ code, locale, key }); } catch { /* Diagnostics are best-effort. */ }
  }

  return function translate(locale: Locale, key: string, params: TranslationParams = {}): string {
    const displayLocale = locale === 'en' ? 'en' : 'zh-CN';
    if (!hasOwn(specifications, key)) {
      report('unknown-key', displayLocale, key);
      return SAFE_TRANSLATION_MESSAGE;
    }
    const spec = specifications[key]!;
    const base = hasOwn(baseCatalog, key) ? baseCatalog[key] : undefined;
    if (!isMessageTemplate(base, spec)) {
      report('invalid-base-message', displayLocale, key);
      return SAFE_TRANSLATION_MESSAGE;
    }
    if (params === null || typeof params !== 'object' || !validParameters(params, spec)) {
      report('invalid-parameters', displayLocale, key);
      return SAFE_TRANSLATION_MESSAGE;
    }

    let template: MessageTemplate = base;
    let templateLocale: Locale = 'zh-CN';
    if (displayLocale === 'en') {
      const english = hasOwn(englishCatalog, key) ? englishCatalog[key] : undefined;
      if (!isEmptyTranslation(english)) {
        if (isMessageTemplate(english, spec)) {
          template = english;
          templateLocale = 'en';
        } else report('invalid-translation', displayLocale, key);
      }
    }

    // Plural rules follow the selected sentence's language. Numbers follow the UI locale.
    const sentence = selectSentence(templateLocale, template, params);
    return sentence.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_token, name: string) =>
      formatParameter(displayLocale, params[name]!, spec.parameters[name]!),
    );
  };
}

const localDiagnostics: LocaleDiagnostic[] = [];
const MAX_DIAGNOSTICS = 100;

export function getLocaleDiagnostics(): readonly LocaleDiagnostic[] {
  return localDiagnostics.map((diagnostic) => ({ ...diagnostic }));
}

export function clearLocaleDiagnostics(): void {
  localDiagnostics.length = 0;
}

export const translate: (locale: Locale, key: TextKey, params?: TranslationParams) => string = createTranslator({
  onDiagnostic(diagnostic) {
    if (localDiagnostics.length === MAX_DIAGNOSTICS) localDiagnostics.shift();
    localDiagnostics.push(diagnostic);
  },
});
