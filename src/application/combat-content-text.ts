import type { CombatContentCatalog } from '../core/combat/definitions';
import { combatMessageSpecifications } from '../content/definitions/messages';
import { combatZhCN } from '../content/locales/zh-CN/combat';
import { combatEn } from '../content/locales/en/combat';
import { LEGACY_V7_CONTENT } from '../content/registry';
import { releaseCombatCatalog, releaseCombatZhCN, releaseCombatEn, releaseCombatMessageSpecifications } from '../content/release';
import { createTranslator } from '../i18n';

export type CombatContentTranslator = ReturnType<typeof createTranslator>;

const legacyText = createTranslator({ baseCatalog: combatZhCN, englishCatalog: combatEn, specifications: combatMessageSpecifications });
const releaseText = createTranslator({ baseCatalog: releaseCombatZhCN, englishCatalog: releaseCombatEn, specifications: releaseCombatMessageSpecifications });

// These exact, owned, recursively frozen catalog references are also returned by the
// content registry. Do not infer a release from caller-controlled versions, IDs, or keys.
const registeredText = new WeakMap<CombatContentCatalog, CombatContentTranslator>([
  [LEGACY_V7_CONTENT.combat, legacyText],
  [releaseCombatCatalog, releaseText],
]);

/**
 * Presentation-only selection, independent of locale and simulation identity. Reuse the
 * registered catalog reference; copied/unregistered catalogs retain legacy compatibility.
 * Only trusted references are cached: no catalog hashing, mutation, or caller registration.
 * The shared translator retains parameter validation and per-key Chinese fallback.
 */
export function combatContentTranslator(catalog?: CombatContentCatalog): CombatContentTranslator {
  return catalog ? registeredText.get(catalog) ?? legacyText : legacyText;
}
