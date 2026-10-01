import { drawInteger } from '../../kernel/random';
import { compareStable } from '../../kernel/serialization';
import { FALLBACK_SUPPLIES, copy, freeze, instanceId } from './shared';
import { evaluateReleaseEligibility } from '../release-eligibility';
import { releaseContextForRun, releaseAnalysisView } from './context';
import type { Candidate, ExpeditionData, ExpeditionState, Immutable, OfferState, ReleaseExpeditionContext } from './types';
export function legalTalentCandidates(state: ExpeditionState, context: ReleaseExpeditionContext): Immutable<Candidate[]> {
  return evaluateReleaseEligibility(releaseAnalysisView(state), context.catalog, releaseContextForRun(state, context)).candidates;
}
function weightedPick(state: ExpeditionData, pool: readonly Immutable<Candidate>[], shown: ReadonlySet<string>): Immutable<Candidate> {
  const preference = new Set(state.origin.preferredTags ?? []);
  const weights = pool.map(card => Math.max(1, Math.min(8, 2 + card.tags.filter(tag => preference.has(tag)).length * 2 - (shown.has(card.definitionId) ? 1 : 0))));
  const draw = drawInteger(state.randomStreams, 'offers', 1, weights.reduce((sum, weight) => sum + weight, 0));
  state.randomStreams = draw.streams;
  let cursor = draw.value;
  for (let index = 0; index < pool.length; index += 1) { cursor -= weights[index]!; if (cursor <= 0) return pool[index]!; }
  return pool[pool.length - 1]!;
}
/** Internal transaction primitive. Caller owns the draft and persists it before showing the result. */
export function generateOffer(state: ExpeditionData, context: ReleaseExpeditionContext, prior: OfferState | null, requireNew: boolean): OfferState {
  const pool = legalTalentCandidates(state, context);
  const ordinal = prior?.rewardOrdinal ?? state.rewardCounters.generated + 1;
  const before = copy(state.randomStreams.offers);
  const history = new Set(state.offers.flatMap(offer => offer.shownHistory));
  const selected: Immutable<Candidate>[] = [];
  const diagnostics: OfferState['diagnostics'] = [];
  if (context.catalog.talents.length < context.catalog.targetTalentCount) diagnostics.push('INCOMPLETE_CATALOG');
  const pick = (candidates: readonly Immutable<Candidate>[]): void => {
    const available = candidates.filter(candidate => !selected.some(entry => entry.definitionId === candidate.definitionId));
    if (available.length && selected.length < 3) selected.push(weightedPick(state, available, history));
  };
  // Due guarantees precede weighting and aesthetic category distribution.
  if (!state.guarantees.coreShown && ordinal <= 2) {
    const cores = pool.filter(candidate => candidate.role === 'core');
    if (cores.length) pick(cores); else diagnostics.push('CORE_GUARANTEE_UNAVAILABLE');
  }
  for (const due of state.guarantees.supportDue.filter(entry => !entry.fulfilled && ordinal >= entry.dueOrdinal)) {
    const supports = pool.filter(candidate => candidate.role === 'support' && candidate.buildId === due.buildId);
    if (supports.length) pick(supports); else diagnostics.push('SUPPORT_GUARANTEE_UNAVAILABLE');
  }
  if (requireNew && !selected.some(candidate => !history.has(candidate.definitionId))) pick(pool.filter(candidate => !history.has(candidate.definitionId)));
  pick(pool.filter(candidate => candidate.category === 'general'));
  if (!pool.some(candidate => candidate.category === 'general')) diagnostics.push('NO_GENERAL_CARD');
  pick(pool.filter(candidate => candidate.category === 'school'));
  pick(pool.filter(candidate => candidate.role === 'bridge'));
  while (selected.length < Math.min(3, pool.length)) pick(pool);
  if (selected.length < 3) diagnostics.push('INSUFFICIENT_LEGAL_CARDS');
  const ids = selected.map(candidate => candidate.definitionId);
  if (!pool.some(candidate => !history.has(candidate.definitionId) && !ids.includes(candidate.definitionId))) diagnostics.push('REROLL_HAS_NO_NEW_CARD');
  if (selected.some(candidate => candidate.role === 'core')) state.guarantees.coreShown = true;
  for (const due of state.guarantees.supportDue) {
    if (selected.some(candidate => candidate.role === 'support' && candidate.buildId === due.buildId)) due.fulfilled = true;
  }
  return {
    offerId: prior?.offerId ?? instanceId(state, 'offer'), runId: state.runId, rewardOrdinal: ordinal,
    revision: prior ? prior.revision + 1 : 0, candidateDefinitionIds: ids,
    eligibleHolderIdsByCard: Object.fromEntries(selected.map(candidate => [candidate.definitionId, [...candidate.holderIds]])),
    shownHistory: [...new Set([...(prior?.shownHistory ?? []), ...ids])].sort(compareStable),
    remainingRerolls: state.remainingRerolls, rngBefore: before, rngAfter: copy(state.randomStreams.offers),
    guaranteeCounters: copy(state.guarantees), diagnostics, supplyFallback: copy(FALLBACK_SUPPLIES),
    chosenCard: null, chosenHolder: null, commitId: null, resolution: 'pending',
  };
}
/** No official random stream, counter, ID or save is changed by a preview. */
export function previewNextOffer(state: ExpeditionState, context: ReleaseExpeditionContext): Immutable<OfferState> {
  return freeze(generateOffer(copy(state), context, null, false));
}
