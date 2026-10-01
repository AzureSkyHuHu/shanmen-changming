import type { BuildContentContext } from '../../core/builds/v2-types';
import { contentIdentity, LEGACY_V7_CONTENT, resolveContentIdentity } from './index';

/** Trusted adapter: resolve every identity before handing concrete definitions to pure build rules. */
export function resolveBuildContentContext(identity: unknown, options: { allowCandidate?: boolean } = {}): BuildContentContext | null {
  const selected = resolveContentIdentity(identity, options);
  if (!selected) return null;
  return Object.freeze({ identity: contentIdentity(selected), catalog: selected.combat, rules: selected.buildRules,
    legacy: Object.freeze({ identity: contentIdentity(LEGACY_V7_CONTENT), catalog: LEGACY_V7_CONTENT.combat }) });
}
