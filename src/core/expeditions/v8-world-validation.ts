/** Current v8 relationships. Each run chooses its saved content and executable protocol. */
import { resolveContentIdentity } from '../../content/registry';
import { getWorldRunCombatCatalog, getWorldRunEncounter, getWorldBuildContentContext } from '../world/content-access';
import { restoreRegisteredExpedition } from './versioned';
import { expandDeceasedCultivator } from '../cultivation/v3';
import { validateEncounterSourceProof } from './encounter-source-proof';
import { buildCombatLoadoutV2 as buildCombatLoadout } from '../builds/v2';
import { restoreCombatController, serializeCombatController } from '../combat/ai';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { checkedAdd } from '../kernel/numeric';
import { canonicalStringify, compareStable } from '../kernel/serialization';
import type { WorldStateV8 as WorldState } from '../world/v8-types';
import { assertPlainJson, integer, resourceLines, unique, validId } from './legacy-v2/shared';
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
export function validateWorldExpeditionV8(world: WorldState): string[] {
  try {
    const state = world.expedition;
    const catalog = getWorldRunCombatCatalog(world); const context = getWorldBuildContentContext(world);
    if (!context) throw new Error('Missing v8 build rules');
    if (!state) return []; // Legacy migration has not attached the v4 bundle yet.
    assertPlainJson(state);
    if (!exact(state, ['schemaVersion', 'run', 'travel', 'battle', 'effectReceipts', 'deathMappings', 'history', 'forcedWithdrawal', 'blockedReason', 'contentIdentity', 'protocol', 'routeId']) || state.schemaVersion !== 2
      || !Array.isArray(state.effectReceipts) || state.effectReceipts.length > 2048 || !unique(state.effectReceipts.map(receipt => receipt.effectId))
      || !Array.isArray(state.deathMappings) || !unique(state.deathMappings.map(entry => entry.worldDeathId))
      || !Array.isArray(state.history) || !unique(state.history.map(history => history.runId)) || typeof state.forcedWithdrawal !== 'boolean') throw new Error('Invalid expedition bundle');
    const run = state.run;
    for (const history of state.history) {
      const selected = resolveContentIdentity(history.contentIdentity, { allowCandidate: true });
      if (!exact(history, ['runId', 'settlementId', 'reason', 'result', 'forcedWithdrawal', 'endedCalendarTick', 'loot', 'returnedSupplies', 'lostLoot', 'survivingDiscipleIds', 'deadDiscipleIds', 'deathMappings', 'routeId', 'contentIdentity', 'protocol'])
        || !selected?.routes.some(route => route.id === history.routeId)
        || (selected.id === 'content.legacy-v7' ? history.protocol !== 'legacy-v2' : history.protocol !== 'release-v3' || selected.protocols.expedition !== 'expedition-3')
        || !['legacy-v2', 'release-v3'].includes(history.protocol) || !validId(history.runId) || history.settlementId !== `${history.runId}/settlement`
        || !['victory', 'safeRetreat', 'emergencyRetreat', 'defeat'].includes(history.reason) || !['completed', 'withdrawn', 'defeated'].includes(history.result)
        || typeof history.forcedWithdrawal !== 'boolean' || !integer(history.endedCalendarTick, 0, world.clock.calendarTick)
        || !resourceLines(history.loot) || !resourceLines(history.returnedSupplies) || !resourceLines(history.lostLoot)
        || !Array.isArray(history.survivingDiscipleIds) || !Array.isArray(history.deadDiscipleIds)
        || !unique([...history.survivingDiscipleIds, ...history.deadDiscipleIds]) || !Array.isArray(history.deathMappings)) throw new Error('Invalid expedition history');
    }

    if (!run) {
      if (state.deathMappings.length || state.blockedReason !== null || state.forcedWithdrawal || state.contentIdentity !== null || state.protocol !== null || state.routeId !== null || state.travel || state.battle || state.effectReceipts.length || world.cultivation.disciples.some(profile => profile.activityOwner)
        || world.builds.disciples.some(profile => profile.lock)) throw new Error('Orphan expedition state');
      return [];
    }
    restoreRegisteredExpedition({ schemaVersion: 1, identity: state.contentIdentity, protocol: state.protocol, routeId: state.routeId, run });
    for (const member of run.members) {
      const archived = world.cultivation.archivedDisciples.find(entry => entry.discipleId === member.discipleId);
      const profile = world.cultivation.disciples.find(entry => entry.discipleId === member.discipleId) ?? (archived ? expandDeceasedCultivator(archived) : undefined);
      const build = world.builds.disciples.find(entry => entry.discipleId === member.discipleId) ?? world.builds.retiredDisciples.find(entry => entry.discipleId === member.discipleId);
      const lock = build && 'lock' in build ? build.lock : null;
      if (!profile || !build || (run.locked && (member.alive ? profile.lifeState === 'dead' : profile.lifeState !== 'dead' || profile.deathId !== member.permanentDeathId))) throw new Error('Expedition member life mismatch');
      if (run.locked ? profile.activityOwner?.runId !== run.runId || profile.activityOwner.lockId !== member.lockId || lock?.runId !== run.runId || lock.lockId !== member.lockId
        : profile.activityOwner !== null || lock !== null) throw new Error('Expedition activity/build lock mismatch');
      if (run.locked && canonicalStringify(member.loadout) !== canonicalStringify(buildCombatLoadout({ builds: world.builds, sequences: world.sequences }, member.discipleId, context))) throw new Error('Locked expedition loadout differs from owned build');
    }
    for (const profile of world.cultivation.disciples) if (profile.activityOwner && (!run.locked || !run.members.some(member => member.discipleId === profile.discipleId && member.lockId === profile.activityOwner?.lockId))) throw new Error('Orphan activity lock');
    if (!!state.travel !== !!run.admittedCheckpoint) throw new Error('Travel admission mismatch');
    if (['AtNode', 'RewardPending', 'InEncounter'].includes(run.phase) && run.calendarMonth !== Math.floor(world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH)) throw new Error('Unaccounted expedition calendar progress');
    if (state.travel) {
      const cursor = state.travel;
      if (!exact(cursor, ['checkpointId', 'startCalendarTick', 'targetCalendarTick']) || cursor.checkpointId !== run.admittedCheckpoint?.checkpointId
        || !integer(cursor.startCalendarTick) || !integer(cursor.targetCalendarTick) || cursor.targetCalendarTick !== checkedAdd(cursor.startCalendarTick, CALENDAR_TICKS_PER_MONTH)
        || world.clock.calendarTick < cursor.startCalendarTick || world.clock.calendarTick > cursor.targetCalendarTick
        || Math.floor(cursor.startCalendarTick / CALENDAR_TICKS_PER_MONTH) !== run.calendarMonth) throw new Error('Invalid travel cursor');
    }
    if ((run.phase === 'InEncounter') !== !!state.battle) throw new Error('Battle/run phase mismatch');
    if (state.battle) {
      const battle = state.battle;
      if (!run.currentEncounter || battle.encounterId !== run.currentEncounter.encounterId || battle.definitionId !== run.currentEncounter.encounterDefinitionId
        || world.clock.mode !== 'combat' || battle.lastAdvancedSimulationTick !== world.clock.simulationTick
        || battle.controller.elapsedTicks !== battle.lastAdvancedSimulationTick - battle.admittedSimulationTick
        || !unique(battle.participants.map(entry => entry.battleEntityId)) || !unique(battle.participants.map(entry => entry.discipleId))
        || canonicalStringify(battle.participants.map(entry => entry.discipleId).sort(compareStable)) !== canonicalStringify([...run.currentEncounter.memberIds].sort(compareStable))) throw new Error('Invalid battle participants/clock');
      restoreCombatController(serializeCombatController(battle.controller), catalog, battle.configHash);
      validateEncounterSourceProof(world);
      for (const participant of battle.participants) if (battle.controller.battle.entities[participant.battleEntityId]?.team !== 'sect') throw new Error('Participant is not on player team');
      if (!unique(battle.enemies.map(entry => entry.battleEntityId)) || battle.enemies.some(enemy => battle.controller.battle.entities[enemy.battleEntityId]?.team !== 'foe')
        || battle.enemies.length !== getWorldRunEncounter(world, battle.definitionId).enemies.length) throw new Error('Invalid enemy presentation mapping');
      for (const source of battle.sourceBindings) if (!run.talentInstances.some(talent => talent.instanceId === source.runTalentInstanceId)) throw new Error('Unknown run source binding');
      for (const source of battle.characterSourceBindings) {
        const original = world.builds.disciples.find(member => member.discipleId === source.discipleId)?.sources.find(entry => entry.sourceInstanceId === source.worldSourceInstanceId);
        if (!original || original.sourceDefinitionId !== source.definitionId || !battle.participants.some(entry => entry.discipleId === source.discipleId && entry.battleEntityId === source.battleEntityId)
          || (source.kind === 'bakedEquipment' ? original.kind !== 'equipment' || source.battleSourceInstanceId !== null : original.kind === 'equipment' || !source.battleSourceInstanceId)) throw new Error('Invalid permanent source mapping');
      }
      const expectedSources = battle.participants.reduce((sum, participant) => sum + world.builds.disciples.find(member => member.discipleId === participant.discipleId)!.sources.length, 0);
      if (battle.characterSourceBindings.length !== expectedSources || !unique(battle.characterSourceBindings.map(source => source.worldSourceInstanceId))) throw new Error('Incomplete permanent source map');
    }
    for (const mapping of state.deathMappings) {
      const outcome = run.encounterResults.find(entry => entry.encounterId === mapping.encounterId);
      if (!validId(mapping.battleEntityId) || !validId(mapping.battleDeathId) || !outcome?.members.some(member => member.discipleId === mapping.discipleId && member.permanentDeathId === mapping.worldDeathId)
        || !world.cultivation.deaths.some(death => death.discipleId === mapping.discipleId && death.deathId === mapping.worldDeathId)) throw new Error('Invalid combat death mapping');
    }
    for (const receipt of state.effectReceipts) if (!validId(receipt.effectId) || receipt.runId !== run.runId || !integer(receipt.simulationTick, 0, world.clock.simulationTick)
      || !run.receipts.some(entry => entry.effectIds.includes(receipt.effectId))) throw new Error('Invalid effect receipt');
    for (const receipt of run.receipts) for (const effectId of receipt.effectIds) if (!state.effectReceipts.some(entry => entry.effectId === effectId)) throw new Error('Missing applied effect receipt');
    if (run.phase === 'Ended' && !state.history.some(entry => entry.settlementId === run.settlement?.settlementId)) throw new Error('Missing terminal history');
    const hold = run.phase !== 'Ended' && (run.phase === 'AtNode' || run.phase === 'RewardPending' || run.phase === 'Preparing'
      || ((run.phase === 'Travelling' || run.phase === 'Ending') && state.travel === null) || state.blockedReason !== null);
    if (hold !== world.clock.pauseReasons.includes('expedition')) throw new Error('Expedition pause ownership mismatch');
    return [];
  } catch (error) { return [error instanceof Error ? error.message : 'Invalid expedition state']; }
}
