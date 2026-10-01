import { checkedAdd } from '../../kernel/numeric';
import type { ExpeditionData } from './types';
export { ExpeditionFault, MAX_COMMANDS, MAX_ENCOUNTERS, MAX_MONTHS_PER_NODE, MAX_SQUAD, FALLBACK_SUPPLIES,
  addLines, assertPlainJson, copy, fail, freeze, integer, resourceLines, sortedLines, subtractLines, unique, validId } from '../shared';
export function instanceId(state: ExpeditionData, prefix: string): string {
  const next = state.nextInstance; state.nextInstance = checkedAdd(next, 1); return `${state.runId}/${prefix}/${next}`;
}
