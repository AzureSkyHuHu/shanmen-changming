import { CAMPAIGN_KNOWLEDGE } from '../core/campaign/catalog';
import type { TextKey, TranslationParams } from '../i18n';

/** Presentation only: keep stable knowledge IDs in selections, commands and saves. */
export function knowledgeLabel(id: string, t: (key: TextKey, parameters?: TranslationParams) => string): string {
  const definition = CAMPAIGN_KNOWLEDGE.find(entry => entry.id === id);
  return t(definition ? definition.nameKey as TextKey : 'cultivation.ui.unknownKnowledge');
}
