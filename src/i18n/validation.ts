import { messageSpecifications } from './messages.ts';
import type { Locale, MessageSpecifications, MessageSpec, MessageTemplate } from './types.ts';

export type CatalogInput = Readonly<Record<string, unknown>>;

export interface LocaleValidationIssue {
  readonly locale: Locale;
  readonly key: string;
  readonly code: 'missing-base' | 'undeclared-key' | 'invalid-template';
  readonly detail: string;
}

export interface LocaleValidationResult {
  readonly valid: boolean;
  readonly errors: readonly LocaleValidationIssue[];
  readonly missingEnglishKeys: readonly string[];
  readonly checkedKeys: number;
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isEmptyTranslation(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Only {namedParameter} is supported. Interpolated values are never parsed again. */
export function extractParameterNames(template: string): readonly string[] {
  return [...new Set(Array.from(template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (match) => match[1]!))].sort();
}

function inspectSentence(template: unknown, spec: MessageSpec): string[] {
  if (typeof template !== 'string' || template.trim() === '') {
    return ['Every sentence must be a nonempty string.'];
  }
  if (/[{}]/.test(template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, ''))) {
    return ['Only named {parameter} tokens are supported; braces cannot be nested.'];
  }
  const expected = Object.keys(spec.parameters).sort();
  const actual = extractParameterNames(template);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    return [`Parameter names must match the shared schema (${expected.join(', ') || 'none'}).`];
  }
  return [];
}

/** Validates every branch against one shared parameter/type schema for both locales. */
export function inspectMessage(value: unknown, spec: MessageSpec): readonly string[] {
  if (typeof value === 'string') return inspectSentence(value, spec);
  if (value === null || typeof value !== 'object' || !hasOwn(value, 'plural')) {
    return ['A message must be a string or an explicit plural message.'];
  }
  const plural = (value as { plural: unknown }).plural;
  if (plural === null || typeof plural !== 'object') return ['Invalid plural message.'];
  const branch = plural as Record<string, unknown>;
  const issues: string[] = [];
  if (Object.keys(value).some((key) => key !== 'plural') || Object.keys(branch).some((key) => !['parameter', 'one', 'other'].includes(key))) {
    issues.push('Only the explicit plural parameter, one and other fields are supported.');
  }
  if (
    !hasOwn(branch, 'parameter') ||
    typeof branch.parameter !== 'string' ||
    !hasOwn(spec.parameters, branch.parameter) ||
    spec.parameters[branch.parameter]?.type !== 'number'
  ) {
    issues.push('The plural parameter must be a declared numeric parameter.');
  }
  if (!hasOwn(branch, 'other')) issues.push('Plural messages require an other sentence.');
  else issues.push(...inspectSentence(branch.other, spec));
  if (hasOwn(branch, 'one')) issues.push(...inspectSentence(branch.one, spec));
  return issues;
}

export function isMessageTemplate(value: unknown, spec: MessageSpec): value is MessageTemplate {
  return inspectMessage(value, spec).length === 0;
}

export function validateLocales(
  baseCatalog: CatalogInput,
  englishCatalog: CatalogInput,
  specifications: MessageSpecifications = messageSpecifications,
): LocaleValidationResult {
  const errors: LocaleValidationIssue[] = [];
  const missingEnglishKeys: string[] = [];
  const keys = Object.keys(specifications);

  for (const key of keys) {
    const spec = specifications[key]!;
    const base = hasOwn(baseCatalog, key) ? baseCatalog[key] : undefined;
    if (isEmptyTranslation(base)) {
      errors.push({ locale: 'zh-CN', key, code: 'missing-base', detail: 'A nonempty Chinese base message is required.' });
    } else {
      for (const detail of inspectMessage(base, spec)) {
        errors.push({ locale: 'zh-CN', key, code: 'invalid-template', detail });
      }
    }
    const english = hasOwn(englishCatalog, key) ? englishCatalog[key] : undefined;
    if (isEmptyTranslation(english)) missingEnglishKeys.push(key);
    else {
      for (const detail of inspectMessage(english, spec)) {
        errors.push({ locale: 'en', key, code: 'invalid-template', detail });
      }
    }
  }

  for (const [locale, catalog] of [['zh-CN', baseCatalog], ['en', englishCatalog]] as const) {
    for (const key of Object.keys(catalog)) {
      if (!hasOwn(specifications, key)) {
        errors.push({ locale, key, code: 'undeclared-key', detail: 'Declare the stable key and parameter schema first.' });
      }
    }
  }

  return { valid: errors.length === 0, errors, missingEnglishKeys, checkedKeys: keys.length };
}
