import type { SectRelocationLiveRuntime, SectRelocationRejection } from '../../sect-expansion/relocation-runtime-types';
import type { SectResearchRejection } from '../../sect-expansion/research-types';
import type { RelocationOwnerResearchSource } from './research-records';

/** Bounded, ungated library-L1 executable candidate. Four real books, one shared
 * authority, and only relocation's separately stored live navigation. This is
 * not a World, lifecycle/archive, save/restore or public consumer admission. */
export interface ConstructionRelocationResearchDomainFrame {
  readonly records: RelocationOwnerResearchSource;
  readonly live: readonly SectRelocationLiveRuntime[];
}
export type ConstructionRelocationResearchDomainCandidate =
  | { readonly ok: true; readonly scope: 'construction-relocation-research-domain-candidate';
      readonly frame: ConstructionRelocationResearchDomainFrame; readonly relatedId: string | null; readonly repeated: boolean }
  | { readonly ok: false; readonly scope: 'construction-relocation-research-domain-candidate';
      readonly frame: unknown; readonly code: SectRelocationRejection | SectResearchRejection; readonly issues: readonly string[] };
