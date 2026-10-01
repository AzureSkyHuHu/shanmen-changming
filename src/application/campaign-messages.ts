import type { WorldCampaignError } from '../core/world/campaign-types';
import type { TextKey } from '../i18n';

export const campaignMessages: Readonly<Record<WorldCampaignError, TextKey>> = Object.freeze({
  INVALID_STATE: "campaign.error.INVALID_STATE",
  INVALID_INPUT: "campaign.error.INVALID_INPUT",
  UNKNOWN_ROUTE: "campaign.error.UNKNOWN_ROUTE",
  ROUTE_LOCKED: "campaign.error.ROUTE_LOCKED",
  INVALID_VICTORY: "campaign.error.INVALID_VICTORY",
  VICTORY_CONFLICT: "campaign.error.VICTORY_CONFLICT",
  UNKNOWN_REWARD: "campaign.error.UNKNOWN_REWARD",
  ALREADY_CLAIMED: "campaign.error.ALREADY_CLAIMED",
  UNKNOWN_DISCIPLE: "campaign.error.UNKNOWN_DISCIPLE",
  DISCIPLE_UNAVAILABLE: "campaign.error.DISCIPLE_UNAVAILABLE",
  WRONG_SCHOOL: "campaign.error.WRONG_SCHOOL",
  MISSING_PREREQUISITE: "campaign.error.MISSING_PREREQUISITE",
  ALREADY_LEARNED: "campaign.error.ALREADY_LEARNED",
  INSUFFICIENT_RESOURCES: "campaign.error.INSUFFICIENT_RESOURCES",
  ROSTER_FULL: "campaign.error.ROSTER_FULL",
  IDENTITY_REUSED: "campaign.error.IDENTITY_REUSED",
  RECOVERY_UNAVAILABLE: "campaign.error.RECOVERY_UNAVAILABLE",
  LOSS_ACKNOWLEDGEMENT_REQUIRED: "campaign.error.LOSS_ACKNOWLEDGEMENT_REQUIRED",
  STALE_PLAN: "campaign.error.STALE_PLAN",
  INVALID_ACKNOWLEDGEMENT: "campaign.error.INVALID_ACKNOWLEDGEMENT",
  CLAIM_CONFLICT: "campaign.error.CLAIM_CONFLICT",
  HISTORY_LIMIT: "campaign.error.HISTORY_LIMIT",
  OVERFLOW: "campaign.error.OVERFLOW",
  RELIEF_UNAVAILABLE: "campaign.error.RELIEF_UNAVAILABLE",
  RELIEF_COOLDOWN: "campaign.error.RELIEF_COOLDOWN",
  INVALID_COMMAND: "campaign.error.INVALID_COMMAND",
  BLOCKED_BY_DECISION: "campaign.error.BLOCKED_BY_DECISION",
  ACTIVE_EXPEDITION: "campaign.error.ACTIVE_EXPEDITION",
  BUILD_REJECTED: "campaign.error.BUILD_REJECTED",
  CULTIVATION_REJECTED: "campaign.error.CULTIVATION_REJECTED",
  INVENTORY_FULL: "campaign.error.INVENTORY_FULL",
  ESTATE_UNAVAILABLE: "campaign.error.ESTATE_UNAVAILABLE",
  ITEM_UNAVAILABLE: "campaign.error.ITEM_UNAVAILABLE",
  PREVIEW_STALE: "campaign.error.PREVIEW_STALE",
  SAVE_CAPACITY_EXCEEDED: "campaign.error.SAVE_CAPACITY_EXCEEDED",
  SAVE_OBLIGATION_UNBOUNDED: "campaign.error.SAVE_OBLIGATION_UNBOUNDED",
});

/** Never display an internal code or guess a translation for an unknown rejection. */
export function campaignMessageKey(code: string): TextKey {
  return Object.hasOwn(campaignMessages, code) ? campaignMessages[code as WorldCampaignError] : 'campaign.growth.rejected';
}
