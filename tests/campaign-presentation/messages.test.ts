import { describe, expect, it } from 'vitest';
import { campaignMessages, campaignMessageKey } from '../../src/application/campaign-messages';
import { WORLD_CAMPAIGN_ERROR_CODES } from '../../src/core/world/campaign-queries';
import { translate, SAFE_TRANSLATION_MESSAGE } from '../../src/i18n';

describe('campaign rejection text', () => {
  it('maps every current World rejection to registered Chinese and English text', () => {
    expect(Object.keys(campaignMessages).sort()).toEqual([...WORLD_CAMPAIGN_ERROR_CODES].sort());
    for (const code of WORLD_CAMPAIGN_ERROR_CODES) for (const locale of ['zh-CN', 'en'] as const) {
      const key = campaignMessageKey(code); const text = translate(locale, key);
      expect(text).not.toBe(SAFE_TRANSLATION_MESSAGE); expect(text).not.toBe(key); expect(text).not.toBe(code);
    }
  });
  it('distinguishes physical inventory, save capacity and unproven future settlement', () => {
    expect(new Set(['INVENTORY_FULL', 'SAVE_CAPACITY_EXCEEDED', 'SAVE_OBLIGATION_UNBOUNDED'].map(campaignMessageKey)).size).toBe(3);
    expect(translate('zh-CN', campaignMessageKey('INVENTORY_FULL'))).toContain('仓储');
    expect(translate('zh-CN', campaignMessageKey('SAVE_CAPACITY_EXCEEDED'))).toContain('存档');
  });
  it('uses safe registered fallback for unknown and prototype-like codes', () => {
    for (const code of ['future-code', '__proto__', 'constructor', 'toString']) expect(campaignMessageKey(code)).toBe('campaign.growth.rejected');
  });
});
