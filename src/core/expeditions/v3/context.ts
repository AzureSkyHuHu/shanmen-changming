import { resolveContentIdentity } from '../../../content/registry';
import { createBattle, installCombatSource, queryStat } from '../../combat/runtime';
import { catalogFingerprint } from '../../combat/runtime/catalog';
import { sourceActive } from '../../combat/runtime/queries';
import { arenaWalkable, occupiedBattleCells, summonPlacement } from '../../combat/runtime/movement';
import type { BattleEntityInput, BattleState } from '../../combat/runtime';
import type { EffectPrimitive } from '../../combat/definitions/types';
import { canonicalStringify, compareStable, stableHash } from '../../kernel/serialization';
import { RELEASE_ELIGIBILITY_RULES_ID, releaseEligibilityInputHash } from '../release-eligibility';
import type { ReleaseEligibilityContext } from '../release-eligibility';
import type { ExpeditionState as LegacyExpeditionState } from '../types';
import { assertPlainJson, copy, freeze } from './shared';
import type { ExpeditionState, ReleaseExpeditionContext } from './types';

const acceptedContexts = new WeakSet<object>();
/** Registered data only; accepting a caller-computed matching combat hash is insufficient. */
export function validateReleaseExpeditionContext(context: ReleaseExpeditionContext): void {
  if (acceptedContexts.has(context)) return;
  assertPlainJson(context);
  const selected = resolveContentIdentity(context.identity, { allowCandidate: true });
  if (!selected || selected.id === 'content.legacy-v7' || context.expeditionProtocol !== 'expedition-3'
    || context.admissionProtocol !== RELEASE_ELIGIBILITY_RULES_ID
    || selected.protocols.expedition !== context.expeditionProtocol || selected.protocols.admission !== context.admissionProtocol
    || canonicalStringify(selected.combat) !== canonicalStringify(context.catalog)
    || canonicalStringify(selected.encounters) !== canonicalStringify(context.encounters)) throw new TypeError('Unregistered expedition protocol context');
  const frozen = (value: unknown): boolean => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(frozen));
  if (frozen(context)) acceptedContexts.add(context);
}
/** Read-only compatibility projection for the existing evaluator, never a saved/replayed legacy run. */
export function releaseAnalysisView(state: ExpeditionState): LegacyExpeditionState {
  return { ...state, schemaVersion: 2, simulationVersion: 'expedition-2' };
}
function reachable(battle: BattleState, actorId: string, horizonTicks: number): readonly { x: number; y: number }[] {
  const arena = battle.arena!; const actor = battle.entities[actorId]!;
  const occupied = occupiedBattleCells(battle, actorId); const result = [{ ...actor.position }];
  const seen = new Set([`${actor.position.x},${actor.position.y}`]); const depths = [0];
  // At most one cardinal move per 20 ticks is a conservative movement opportunity.
  const maximumSteps = Math.floor(horizonTicks / 20);
  for (let head = 0; head < result.length && head < arena.widthCells * arena.heightCells; head++) {
    if (depths[head]! >= maximumSteps) continue;
    const from = result[head]!;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const to = { x: from.x + dx * arena.cellSizeUnits, y: from.y + dy * arena.cellSizeUnits }; const key = `${to.x},${to.y}`;
      if (seen.has(key) || occupied.has(key) || !arenaWalkable(arena, to)) continue;
      seen.add(key); result.push(to); depths.push(depths[head]! + 1);
    }
  }
  return result;
}
function distance(left: { readonly x: number; readonly y: number }, right: { readonly x: number; readonly y: number }): number {
  return Math.ceil(Math.sqrt((left.x - right.x) ** 2 + (left.y - right.y) ** 2));
}
function targetMayBeHostile(effect: EffectPrimitive): boolean {
  if (!('target' in effect)) return false;
  const target = effect.target;
  return target.kind === 'intent' || target.kind === 'focus' || ('team' in target && target.team === 'enemy');
}
/** Upcoming encounter facts are derived from fixed catalog data and the current locked survivors.
 * No live World resource, RNG stream, ID or battle controller is consumed by this analysis. */
export function releaseContextForRun(state: ExpeditionState, context: ReleaseExpeditionContext): ReleaseEligibilityContext {
  validateReleaseExpeditionContext(context);
  // Offers are constructed just after an encounter result, before phase is changed.
  const completedCurrent = state.encounterResults.some(result => result.encounterId === `${state.route[state.nodeIndex]?.nodeVisitId}/encounter`);
  const node = state.route[Math.min(state.route.length - 1, state.nodeIndex + (completedCurrent ? 1 : 0))];
  const definition = context.encounters.find(entry => entry.id === node?.encounterDefinitionId);
  if (!definition) throw new TypeError('Run has no registered upcoming encounter');
  const living = state.members.filter(member => member.alive && member.permanentDeathId === null);
  const participants = living.map((member, index) => ({ discipleId: member.discipleId, battleId: `entity:${index + 1}` }));
  const enemies = definition.enemies.map((enemy, index) => ({ input: enemy, id: `${state.runId}/foe/${index + 1}`, battleId: `entity:${living.length + index + 1}` }));
  const entities: BattleEntityInput[] = living.map((member, index) => ({ id: participants[index]!.battleId, team: 'sect',
    position: { x: 80, y: 80 * (index + 1) }, stats: copy(member.loadout.stats),
    healthRatioBps: Math.max(1, Math.min(10_000, Math.floor(member.health * 10_000 / member.loadout.stats.maxHealth))),
    spirit: member.spirit, maximumSpirit: member.loadout.maximumSpirit, skills: [...member.loadout.activeSkillIds, member.loadout.passiveSkillId],
    sources: [...member.loadout.characterSourceIds], basic: copy(member.loadout.basic), deathRule: 'downed' }));
  for (const enemy of enemies) { const { nameKey: _name, ...input } = enemy.input; entities.push({ ...copy(input), id: enemy.battleId, team: 'foe' }); }
  for (const talent of state.talentInstances) {
    if (talent.boundHolderId && !participants.some(member => member.discipleId === talent.boundHolderId)) continue;
    const bound = talent.boundHolderId ? participants.find(member => member.discipleId === talent.boundHolderId)!.battleId : undefined;
    for (const member of participants.filter(member => talent.holderScope === 'team' || member.discipleId === talent.holderId)) {
      const index = entities.findIndex(entry => entry.id === member.battleId); const input = entities[index]!;
      entities[index] = { ...input, sources: [...(input.sources ?? []), { definitionId: talent.definitionId, ...(bound ? { options: { boundHolderId: bound } } : {}) }] };
    }
  }
  const battle = createBattle(context.catalog, { seed: `${state.runId}/admission/${node!.nodeVisitId}`, entities,
    arena: copy(definition.arena), contentMode: state.origin.contentMode, logCapacity: 0 });
  const ids = [...participants.map(member => ({ id: member.discipleId, battleId: member.battleId })), ...enemies];
  const reach = new Map(ids.map(entry => [entry.battleId, reachable(battle, entry.battleId, definition.maximumTicks)]));
  const reachablePairs: { firstId: string; secondId: string; distanceUnits: number }[] = [];
  for (let left = 0; left < ids.length; left++) for (let right = left + 1; right < ids.length; right++) {
    const a = ids[left]!; const b = ids[right]!;
    // One actor approaches the other's actual stationary cell. Never fabricate zero-distance or traversal through bodies.
    const minimum = Math.min(...reach.get(a.battleId)!.map(position => distance(position, battle.entities[b.battleId]!.position)),
      ...reach.get(b.battleId)!.map(position => distance(position, battle.entities[a.battleId]!.position)));
    reachablePairs.push({ firstId: a.id, secondId: b.id, distanceUnits: minimum });
  }
  const near = (first: string, second: string, range: number): boolean => reachablePairs.some(pair =>
    ((pair.firstId === first && pair.secondId === second) || (pair.firstId === second && pair.secondId === first)) && pair.distanceUnits <= range);
  const teamSourceHolders: { definitionId: string; discipleId: string }[] = [];
  if (participants.length) for (const talent of context.catalog.talents.filter(entry => entry.holderScope === 'team')) {
    let projection = battle;
    // Match the executor's binding contract: an actually equipped talisman skill,
    // not the school's display/basic label, establishes a legal recipient.
    const bound = participants.find(member => battle.entities[member.battleId]!.skills.some(id =>
      context.catalog.skills.some(skill => skill.id === id && skill.school === 'talisman')));
    if (talent.recipientBinding === 'selectedTalisman' && !bound) continue;
    for (const member of participants) if (!Object.values(projection.sources).some(source => source.holderId === member.battleId && source.sourceDefinitionId === talent.id)) {
      projection = installCombatSource(projection, context.catalog, member.battleId, talent.id,
        talent.recipientBinding === 'selectedTalisman' ? { boundHolderId: bound!.battleId } : {});
    }
    const active = Object.values(projection.sources).find(source => source.sourceDefinitionId === talent.id && sourceActive(projection, context.catalog, source.sourceInstanceId));
    const owner = participants.find(member => member.battleId === active?.holderId);
    if (!owner) throw new TypeError('Team source has no runtime-owned anchor');
    teamSourceHolders.push({ definitionId: talent.id, discipleId: owner.discipleId });
  }
  const enemyControls = (enemy: typeof enemies[number], discipleId: string): boolean => (enemy.input.skills ?? []).some(skillId => {
    const skill = context.catalog.skills.find(entry => entry.id === skillId);
    return skill?.activation === 'active' && skill.action.targetTeam === 'enemy' && near(enemy.id, discipleId, skill.action.rangeUnits)
      // Interrupting a cast is not a timed control state and cannot prove control.ended.
      && skill.action.effects.some(effect => targetMayBeHostile(effect) && effect.kind === 'applyStatus'
        && context.catalog.statuses.some(status => status.id === effect.statusId && status.dispelCategory === 'control'));
  });
  return freeze({ identity: { rulesId: RELEASE_ELIGIBILITY_RULES_ID, catalogHash: catalogFingerprint(context.catalog),
    inputHash: releaseEligibilityInputHash(releaseAnalysisView(state)), encounterId: `${node!.nodeVisitId}/encounter`,
    encounterRulesId: context.identity.compositeFingerprint, arenaId: stableHash(definition.arena) },
    horizonTicks: definition.maximumTicks, enemies: enemies.map(enemy => ({ id: enemy.id, controlResistanceBps: queryStat(battle, context.catalog, enemy.battleId, 'controlResistanceBps') })),
    members: participants.map(member => ({ discipleId: member.discipleId, guardAllowed: true, defeatRule: 'downed' as const,
      directDamageEnemyIds: enemies.filter(enemy => !!enemy.input.basic && near(member.discipleId, enemy.id, enemy.input.basic.rangeUnits)).map(enemy => enemy.id),
      controlEnemyIds: enemies.filter(enemy => enemyControls(enemy, member.discipleId)).map(enemy => enemy.id),
      decoyPlacementPossible: summonPlacement(battle, member.battleId, null) !== null })),
    reachablePairs, focusEnemyIds: enemies.map(enemy => enemy.id), teamSourceHolders: teamSourceHolders.sort((a, b) => compareStable(a.definitionId, b.definitionId)) });
}
