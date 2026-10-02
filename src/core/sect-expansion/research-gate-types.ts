import type { SectResearchId } from '../../content/sect-v9/types';

/** Immutable reference to same-frame earned completion, never command-supplied authority. */
export interface SectResearchGateRef {
  readonly researchId: SectResearchId;
  readonly completionJobId: string;
}
