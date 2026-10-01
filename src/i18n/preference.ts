import { DEFAULT_LOCALE, type Locale } from './types.ts';

/** Separate from all world, save and simulation namespaces. Never exported with a world. */
export const LOCALE_PREFERENCE_KEY = 'shanmen-changming:settings:locale:v1';

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): LocaleStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

/** No browser-language detection: a new or damaged preference always starts Chinese. */
export function readLocalePreference(storage?: LocaleStorage | null): Locale {
  try {
    const selectedStorage = storage === undefined ? browserStorage() : storage;
    const stored = selectedStorage?.getItem(LOCALE_PREFERENCE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Failure is harmless: the caller can still keep the selected locale in UI state. */
export function writeLocalePreference(locale: Locale, storage?: LocaleStorage | null): boolean {
  if (!isLocale(locale)) return false;
  try {
    const selectedStorage = storage === undefined ? browserStorage() : storage;
    if (selectedStorage === null) return false;
    selectedStorage.setItem(LOCALE_PREFERENCE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}
