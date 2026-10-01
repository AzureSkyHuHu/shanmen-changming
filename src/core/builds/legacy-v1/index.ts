/** Strict historical replay. Candidate equipment/learning rules never enter this path. */
export { createBuildFrame as createLegacyBuildFrameV1, applyBuildCommand as applyLegacyBuildCommandV1,
  applyBuildAuthorityCommand as applyLegacyBuildAuthorityCommandV1, validateBuildFrame as validateLegacyBuildFrameV1,
  buildCombatLoadout as buildLegacyCombatLoadoutV1, replayLegacyBuildHistoryV1 } from './builds';
export type { BuildFrame as LegacyBuildFrameV1, BuildStateFrame as LegacyBuildStateFrameV1,
  BuildHistoryEntry as LegacyBuildHistoryEntryV1 } from './types';
