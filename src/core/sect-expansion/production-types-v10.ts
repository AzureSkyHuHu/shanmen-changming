import type { SectProductionRejection } from './production-types';
import type { SectUpgradeFrameV10 } from './upgrade-types';

/** Fixed internal v10 production candidate. Complete source/candidate admission belongs
 * to the v10 root, including descriptor capture, lifecycle/history, owners and capacity. */
export type SectProductionResultV10 =
  | { readonly ok: true; readonly frame: SectUpgradeFrameV10; readonly repeated: boolean; readonly jobId: string | null }
  | { readonly ok: false; readonly frame: SectUpgradeFrameV10; readonly code: SectProductionRejection };
