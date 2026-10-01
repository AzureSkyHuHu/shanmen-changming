import type { Reservation, ResourceLine } from '../economy/types';
import type { WorldCampaignError, WorldCampaignResult } from './campaign-types';
import type { WorldStateV8 } from './v8-types';

/** Persisted as the payload of exactly one campaign.committed World event.
 * The normal outer command receipt must reference that event. A domain-only
 * acknowledgement or this payload without its receipt is never sufficient. */
export interface WorldCampaignTransactionProof {
  commandId: string;
  /** Real management calendar at commit; simulation event tick also includes combat. */
  calendarTick: number;
  claimId: string | null;
  /** Actual shared-ledger reserve+commit, including a committed empty reservation
   * for a free claim/assignment. ownerTransactionId equals the event rootActionId. */
  payment: Reservation;
  creditedResources: ResourceLine[];
  acquisitionIds: string[];
  /** Exact ordered authority commands committed with this transaction. */
  buildCommandIds: string[];
  cultivationCommandIds: string[];
}
/** Internal preparation only. The owner must append one event and normal receipt,
 * validate their two-way evidence and fund all obligations before publication. */
export type WorldCampaignCommitCandidate =
  | { ok: true; candidate: WorldStateV8; rootActionId: string; proof: WorldCampaignTransactionProof; result: WorldCampaignResult }
  | { ok: false; code: WorldCampaignError };
