import { canonicalStringify, stableHash } from '../kernel/serialization';
import { validateCampaignState } from './campaign';
import { assertJson, copy, exact, freeze } from './shared';
import type { CampaignState } from './types';

export const MAX_CAMPAIGN_SNAPSHOT_CHARS = 2_000_000;
export function serializeCampaign(state: CampaignState): string {
  if (validateCampaignState(state).length) throw new TypeError('Invalid campaign state');
  const text = canonicalStringify({ format: 'shanmen-campaign', version: 1, state, checksum: stableHash(state) });
  if (text.length > MAX_CAMPAIGN_SNAPSHOT_CHARS) throw new RangeError('Campaign snapshot exceeds limit');
  return text;
}
export function restoreCampaign(text: string): CampaignState {
  if (typeof text !== 'string' || text.length > MAX_CAMPAIGN_SNAPSHOT_CHARS) throw new TypeError('Invalid campaign snapshot size');
  const value: unknown = JSON.parse(text); assertJson(value);
  if (!exact(value, ['format', 'version', 'state', 'checksum']) || value.format !== 'shanmen-campaign' || value.version !== 1
    || value.checksum !== stableHash(value.state) || validateCampaignState(value.state).length) throw new TypeError('Invalid campaign snapshot');
  return freeze(copy(value.state as CampaignState));
}
