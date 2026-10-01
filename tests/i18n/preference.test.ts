import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALE_PREFERENCE_KEY,
  readLocalePreference,
  translate,
  writeLocalePreference,
  type LocaleStorage,
} from '../../src/i18n/index.ts';

function memoryStorage(initial?: string): { storage: LocaleStorage; values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(LOCALE_PREFERENCE_KEY, initial);
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    },
  };
}

describe('independent local language preference', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('defaults to Chinese without a stored explicit selection', () => {
    expect(DEFAULT_LOCALE).toBe('zh-CN');
    expect(readLocalePreference(null)).toBe('zh-CN');
    expect(readLocalePreference(memoryStorage().storage)).toBe('zh-CN');
  });

  it.each(['de', 'EN', 'en-US', '{}', 'null', ''])('ignores damaged or unsupported preferences: %s', (initial) => {
    expect(readLocalePreference(memoryStorage(initial).storage)).toBe('zh-CN');
  });

  it('persists the explicit locale using only the independent setting key', () => {
    const { storage, values } = memoryStorage();
    expect(writeLocalePreference('en', storage)).toBe(true);
    expect(readLocalePreference(storage)).toBe('en');
    expect([...values.entries()]).toEqual([[LOCALE_PREFERENCE_KEY, 'en']]);
    expect(writeLocalePreference('zh-CN', storage)).toBe(true);
    expect(readLocalePreference(storage)).toBe('zh-CN');
  });

  it('handles blocked reads and quota/permission failures without throwing', () => {
    const storage = {
      getItem() { throw new Error('Storage access denied'); },
      setItem() { throw new Error('Quota exceeded'); },
    };
    expect(readLocalePreference(storage)).toBe('zh-CN');
    expect(writeLocalePreference('en', storage)).toBe(false);
    expect(writeLocalePreference('en', null)).toBe(false);
    expect(translate('en', 'settings.language.label')).toBe('Language');
  });

  it('handles a denied browser localStorage property getter', () => {
    vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', {
      get() { throw new Error('SecurityError'); },
    }));
    expect(readLocalePreference()).toBe('zh-CN');
    expect(writeLocalePreference('en')).toBe(false);
  });

  it('does not let an English browser language override a new Chinese preference', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage().storage });
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] });
    expect(readLocalePreference()).toBe('zh-CN');
  });

  it('switches twice over identical input without changing domain, RNG, commands or offer', () => {
    const domain = Object.freeze({
      tick: 40,
      worldId: 'world-fixed-id',
      rng: Object.freeze({ world: 12345, combat: 67890, offers: 24680 }),
      pendingCommand: Object.freeze({ commandId: 'command-4', targetId: 'disciple-1' }),
      pendingOffer: Object.freeze(['skill-1', 'skill-2', 'skill-3']),
      name: '青松 & 长明',
      count: 1,
    });
    const before = JSON.stringify(domain);
    const { storage, values } = memoryStorage();
    const parameters = Object.freeze({ name: domain.name });
    const initial = translate(readLocalePreference(storage), 'disciple.welcome', parameters);
    writeLocalePreference('en', storage);
    const english = translate(readLocalePreference(storage), 'disciple.welcome', parameters);
    writeLocalePreference('zh-CN', storage);
    expect(translate(readLocalePreference(storage), 'disciple.welcome', parameters)).toBe(initial);
    expect(english).not.toBe(initial);
    expect(JSON.stringify(domain)).toBe(before);
    expect(parameters).toEqual({ name: '青松 & 长明' });
    expect([...values.keys()]).toEqual([LOCALE_PREFERENCE_KEY]);
  });
});
