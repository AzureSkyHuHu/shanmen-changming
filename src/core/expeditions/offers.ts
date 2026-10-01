import type { CombatDefinition, CombatTag, Condition, EffectPrimitive, TalentDefinition } from '../combat/definitions/types';
import { combatDefinitionSupport } from '../combat/runtime/engine';
import { drawInteger } from '../kernel/random';
import { compareStable } from '../kernel/serialization';
import { AUTHORED_TALENT_IDS, FALLBACK_SUPPLIES, copy, freeze, instanceId } from './shared';
import type { Candidate, ExpeditionCatalog, ExpeditionData, ExpeditionState, Immutable, OfferState, RunTalent } from './types';

const producerTags: readonly CombatTag[] = ['swordMark', 'storedForce', 'medicine', 'rune', 'poison', 'shield', 'heal', 'fire', 'lightning'];
const statusTags: Readonly<Record<string, CombatTag>> = {
  'status.sword-mark': 'swordMark', 'status.poison': 'poison', 'status.medicine': 'medicine', 'status.rune': 'rune',
};
function definition(catalog: ExpeditionCatalog, id: string): CombatDefinition | undefined {
  return [...catalog.skills, ...catalog.treeNodes, ...catalog.talents].find(entry => entry.id === id);
}
/** A consume-only poison/sword-mark label does not create a usable trigger source. */
function sourceTags(entry: CombatDefinition): CombatTag[] {
  const tags = new Set(entry.tags.filter(tag => !producerTags.includes(tag)));
  const inspect = (effects: readonly EffectPrimitive[]): void => {
    for (const effect of effects) {
      if (effect.kind === 'applyStatus') { const tag = statusTags[effect.statusId]; if (tag) tags.add(tag); }
      if (effect.kind === 'shield') tags.add('shield');
      if (effect.kind === 'heal') tags.add('heal');
      if (effect.kind === 'storeForce') tags.add('storedForce');
      if (effect.kind === 'damage' && ['fire', 'poison', 'lightning'].includes(effect.damageType)) tags.add(effect.damageType);
      if (effect.kind === 'zone') inspect(effect.effects);
    }
  };
  if ('mechanics' in entry) {
    inspect(entry.mechanics.onInstall);
    for (const trigger of entry.mechanics.triggers) inspect(trigger.effects);
  }
  if (entry.kind === 'skill' && entry.activation === 'active') inspect(entry.action.effects);
  if (entry.kind === 'talent') for (const tag of entry.providesSourceTags) tags.add(tag);
  return [...tags];
}
function starterTags(entry: TalentDefinition): CombatTag[] {
  const dependsOn = (condition: Condition, tag: CombatTag): boolean => {
    if (condition.kind === 'all' || condition.kind === 'any') return condition.conditions.some(child => dependsOn(child, tag));
    if (condition.kind === 'not') return dependsOn(condition.condition, tag);
    return (condition.kind === 'consumedStatus' || condition.kind === 'hasStatus') && statusTags[condition.statusId] === tag;
  };
  // A card that merely reapplies the poison it just consumed is not a poison starter.
  return sourceTags(entry).filter(tag => entry.providesSourceTags.includes(tag)
    || !producerTags.includes(tag) || sourceTags({ ...entry, mechanics: { ...entry.mechanics, triggers: [] } }).includes(tag)
    || entry.mechanics.triggers.some(trigger => !dependsOn(trigger.condition, tag)
      && sourceTags({ ...entry, mechanics: { onInstall: [], actionRules: [], triggers: [trigger] } }).includes(tag)));
}
const relevantTalents = (state: ExpeditionState, holderId: string): readonly Immutable<RunTalent>[] =>
  state.talentInstances.filter(talent => talent.holderScope === 'team' || talent.holderId === holderId);
function holderSources(state: ExpeditionState, catalog: ExpeditionCatalog, holderId: string): { ids: Set<string>; tags: Set<CombatTag> } {
  const member = state.members.find(entry => entry.discipleId === holderId)!;
  const ids = new Set([...member.loadout.activeSkillIds, member.loadout.passiveSkillId, ...member.loadout.characterSourceIds]);
  for (const talent of relevantTalents(state, holderId)) {
    if (talent.boundHolderId && !state.members.some(entry => entry.discipleId === talent.boundHolderId && entry.alive)) continue;
    if (talent.boundHolderId && talent.boundHolderId !== holderId) continue;
    ids.add(talent.definitionId);
  }
  const tags = new Set<CombatTag>(['basic', member.loadout.basic.school]);
  for (const id of ids) { const entry = definition(catalog, id); if (entry) for (const tag of sourceTags(entry)) tags.add(tag); }
  return { ids, tags };
}
function exclusionsPass(entry: TalentDefinition, ids: ReadonlySet<string>, catalog: ExpeditionCatalog): boolean {
  return !entry.excludes.some(id => ids.has(id)) && !catalog.talents.some(other => ids.has(other.id) && other.excludes.includes(entry.id));
}
function conditions(condition: Condition): Condition[] {
  if (condition.kind === 'all' || condition.kind === 'any') return condition.conditions.flatMap(conditions);
  if (condition.kind === 'not') return conditions(condition.condition);
  return [condition];
}
function effectsOf(entry: CombatDefinition): EffectPrimitive[] {
  const effects: EffectPrimitive[] = [];
  if ('mechanics' in entry) effects.push(...entry.mechanics.onInstall, ...entry.mechanics.triggers.flatMap(trigger => trigger.effects));
  if (entry.kind === 'skill' && entry.activation === 'active') effects.push(...entry.action.effects);
  return effects;
}
/** Check actual authored proc inputs, including ally poison consumers and minimum distinct casters. */
function activationCompatible(entry: TalentDefinition, holderId: string | null,
  sources: ReadonlyMap<string, { ids: Set<string>; tags: Set<CombatTag> }>, catalog: ExpeditionCatalog): boolean {
  const effectsFor = (id: string): EffectPrimitive[] => [...sources.get(id)!.ids].flatMap(sourceId => {
    const source = definition(catalog, sourceId); return source ? effectsOf(source) : [];
  });
  for (const trigger of entry.mechanics.triggers) {
    const predicates = conditions(trigger.condition);
    if (predicates.some(condition => condition.kind === 'flag' && condition.field === 'event.differentCaster' && condition.value) && sources.size < 2) return false;
    if (predicates.some(condition => condition.kind === 'compare' && condition.field === 'event.distinctCasterCount'
      && (condition.operator === 'gte' ? sources.size < condition.value : condition.operator === 'gt' && sources.size <= condition.value))) return false;
    if (trigger.event === 'status.consumed' || trigger.event === 'force.released') {
      const differentCaster = predicates.some(condition => condition.kind === 'flag' && condition.field === 'event.differentCaster' && condition.value);
      const actorIds = [...sources.keys()].filter(id => (trigger.eventScope !== 'owner' || holderId === null || holderId === id)
        && !(differentCaster && holderId === id));
      const availableEffects = actorIds.flatMap(effectsFor);
      if (trigger.event === 'force.released' && !availableEffects.some(effect => effect.kind === 'releaseForce')) return false;
      if (trigger.event === 'status.consumed') {
        const consumed = predicates.filter(condition => condition.kind === 'consumedStatus').map(condition => condition.statusId);
        if (!availableEffects.some(effect => effect.kind === 'consumeStatus' && (!consumed.length || consumed.includes(effect.statusId)))) return false;
        if (holderId && predicates.some(condition => condition.kind === 'flag' && condition.field === 'event.ownedStatus' && condition.value)
          && !effectsFor(holderId).some(effect => effect.kind === 'applyStatus' && (!consumed.length || consumed.includes(effect.statusId)))) return false;
      }
    }
  }
  return true;
}
/** All candidates are actual authored definitions supported by the currently selected combat mode. */
export function legalTalentCandidates(state: ExpeditionState, catalog: ExpeditionCatalog): Immutable<Candidate[]> {
  const living = state.members.filter(member => member.alive).sort((a, b) => compareStable(a.discipleId, b.discipleId));
  const sources = new Map(living.map(member => [member.discipleId, holderSources(state, catalog, member.discipleId)]));
  const teamIds = new Set([...sources.values()].flatMap(source => [...source.ids]));
  const teamTags = new Set([...sources.values()].flatMap(source => [...source.tags]));
  const result: Candidate[] = [];
  if (!living.length) return freeze(result);
  for (const entry of [...catalog.talents].sort((a, b) => compareStable(a.id, b.id))) {
    if (!AUTHORED_TALENT_IDS.includes(entry.id) || !combatDefinitionSupport(catalog, entry.id, state.origin.contentMode).supported) continue;
    const ownTags = starterTags(entry);
    const eligible = (ids: ReadonlySet<string>, tags: ReadonlySet<CombatTag>): boolean => entry.prerequisites.every(id => ids.has(id))
      && exclusionsPass(entry, ids, catalog) && entry.requiredSourceTags.every(tag => tags.has(tag) || ownTags.includes(tag)
        || (['poison', 'swordMark'].includes(tag) && teamTags.has(tag)));
    let holderIds: string[];
    if (entry.holderScope === 'personal') {
      holderIds = living.filter(member => {
        const source = sources.get(member.discipleId)!;
        const rank = state.talentInstances.find(talent => talent.definitionId === entry.id && talent.holderId === member.discipleId)?.rank ?? 0;
        return rank < entry.maximumRank && eligible(source.ids, source.tags) && activationCompatible(entry, member.discipleId, sources, catalog);
      }).map(member => member.discipleId);
      if (!holderIds.length) continue;
    } else {
      const rank = state.talentInstances.find(talent => talent.definitionId === entry.id && talent.holderScope === 'team')?.rank ?? 0;
      if (rank >= entry.maximumRank || !eligible(teamIds, teamTags) || !activationCompatible(entry, null, sources, catalog)) continue;
      holderIds = entry.recipientBinding === 'selectedTalisman'
        ? living.filter(member => member.loadout.basic.school === 'talisman').map(member => member.discipleId) : [];
      if (entry.recipientBinding === 'selectedTalisman' && !holderIds.length) continue;
    }
    result.push({ definitionId: entry.id, holderIds, tags: [...entry.tags], category: entry.category, role: entry.offerRole, buildId: entry.buildId });
  }
  return freeze(result);
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
export function generateOffer(state: ExpeditionData, catalog: ExpeditionCatalog, prior: OfferState | null, requireNew: boolean): OfferState {
  const pool = legalTalentCandidates(state, catalog);
  const ordinal = prior?.rewardOrdinal ?? state.rewardCounters.generated + 1;
  const before = copy(state.randomStreams.offers);
  const history = new Set(state.offers.flatMap(offer => offer.shownHistory));
  const selected: Immutable<Candidate>[] = [];
  const diagnostics: OfferState['diagnostics'] = [];
  if (catalog.talents.length < catalog.targetTalentCount) diagnostics.push('INCOMPLETE_CATALOG');
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
export function previewNextOffer(state: ExpeditionState, catalog: ExpeditionCatalog): Immutable<OfferState> {
  return freeze(generateOffer(copy(state), catalog, null, false));
}
