import type { WorkPathBudget } from '../../agents/work-navigation';
import { tickConstructionRelocationResearchDomain } from '../../sect-expansion/relocation-runtime';
import type { ConstructionRelocationResearchDomainCandidate } from './research-domain-types';

// The owning module retains every work/payment stage privately. These fixed
// unknown-input boundaries never accept an already-clocked frame or authority token.
export { prepareConstructionRelocationResearchCommandCandidate,
  validateConstructionRelocationResearchDomainRuntime } from '../../sect-expansion/relocation-runtime';
export type { ConstructionRelocationResearchDomainFrame, ConstructionRelocationResearchDomainCandidate } from './research-domain-types';
export function prepareConstructionRelocationResearchTickCandidate(input: unknown, nextContext: unknown,
  budget: WorkPathBudget): ConstructionRelocationResearchDomainCandidate {
  return tickConstructionRelocationResearchDomain(input, nextContext, budget);
}
