import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { CultivationPanel } from '../../src/app/CultivationPanel';
import { knowledgeLabel } from '../../src/app/knowledge-label';
import { CAMPAIGN_KNOWLEDGE } from '../../src/core/campaign/catalog';
import { createTranslator, translate, type Locale, type TextKey, type TranslationParams } from '../../src/i18n';
import { en } from '../../src/content/locales/en';

const labels = [
  ['knowledge.clear-heart', '清心抄本', 'Clear Heart Manual'],
  ['knowledge.sun-piercing', '贯日剑谱', 'Sun-Piercing Manual'],
  ['knowledge.guard-step', '援护身法', 'Guardian Step Manual'],
] as const;
const translator = (locale: Locale) => (key: TextKey, params?: TranslationParams) => translate(locale, key, params);

describe('inheritance knowledge presentation', () => {
  it.each(['zh-CN', 'en'] as const)('labels every supported manual in %s without changing option identities', locale => {
    const session = new ApplicationSession();
    {
      const before = session.exportWorld();
      const snapshot = session.getSnapshot();
      const selected = snapshot.cultivation.selected!;
      const studentId = snapshot.disciples.find(row => row.id !== selected.discipleId)!.id;
      const world = { ...snapshot, cultivation: { ...snapshot.cultivation, selected: { ...selected,
        teachingChoices: CAMPAIGN_KNOWLEDGE.map(row => ({ knowledgeId: row.id, studentIds: [studentId] })),
        totalTeachableKnowledge: CAMPAIGN_KNOWLEDGE.length,
      } } };
      const markup = renderToStaticMarkup(createElement(CultivationPanel, { session, world, readOnly: false, t: translator(locale) }));
      expect(CAMPAIGN_KNOWLEDGE.map(row => row.id)).toEqual(labels.map(row => row[0]));
      for (const [id, zh, english] of labels) {
        const label = locale === 'en' ? english : zh;
        expect(knowledgeLabel(id, translator(locale))).toBe(label);
        expect(markup).toMatch(new RegExp(`<option value="${id}"[^>]*>${label}</option>`));
      }
      expect(markup.replace(/<[^>]*>/g, '')).not.toContain('knowledge.');
      expect(session.exportWorld()).toEqual(before);
    }
  });

  it.each(['zh-CN', 'en'] as const)('localizes teaching and learning progress in %s', locale => {
    const session = new ApplicationSession();
    {
      const snapshot = session.getSnapshot();
      const selected = snapshot.cultivation.selected!;
      const otherId = snapshot.disciples.find(row => row.id !== selected.discipleId)!.id;
      for (const [id, zh, english] of labels) {
        for (const activity of ['teaching', 'learning'] as const) {
          const world = { ...snapshot, cultivation: { ...snapshot.cultivation, selected: { ...selected,
            teaching: activity === 'teaching' ? { teachingId: 'test.lesson', studentId: otherId, knowledgeId: id, completedMonths: 1, requiredMonths: 2 } : null,
            learning: activity === 'learning' ? { teacherId: otherId, knowledgeId: id, completedMonths: 1, requiredMonths: 2 } : null,
          } } };
          const markup = renderToStaticMarkup(createElement(CultivationPanel, { session, world, readOnly: false, t: translator(locale) }));
          expect(markup).toContain(locale === 'en' ? english : zh);
          expect(markup.replace(/<[^>]*>/g, '')).not.toContain(id);
        }
      }
    }
  });

  it.each(['zh-CN', 'en'] as const)('uses a safe localized fallback for unknown IDs in %s', locale => {
    for (const id of ['knowledge.future', '', '<script>alert(1)</script>', 'constructor', '__proto__']) {
      expect(knowledgeLabel(id, translator(locale))).toBe(locale === 'en' ? 'Unrecognized manual' : '未识别的典籍');
    }
  });

  it('retains per-key Chinese fallback for an untranslated English manual', () => {
    const t = createTranslator({ englishCatalog: { ...en, 'campaign.knowledge.sunPiercing.name': '' } });
    expect(knowledgeLabel('knowledge.sun-piercing', (key, params) => t('en', key, params))).toBe('贯日剑谱');
  });
});
