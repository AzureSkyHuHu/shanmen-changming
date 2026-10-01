import { createBattle } from '../combat/runtime';
import type { BattleEntityInput } from '../combat/runtime';
import { getWorldRunCombatCatalog, getWorldRunEncounter } from '../world/content-access';
import type { WorldStateV8 } from '../world/v8-types';
import type { CharacterSourceBinding, EncounterSourceBinding } from './world-types';
import { canonicalStringify } from '../kernel/serialization';
import { copy } from './shared';

/** Reconstruct admission IDs under the saved catalog, so legitimate later source
 * cleanup does not erase proof and a truthy/foreign source ID cannot pass validation. */
export function validateEncounterSourceProof(world: WorldStateV8): void {
  const encounter = world.expedition.battle; const boundary = world.expedition.run?.currentEncounter;
  if (!encounter || !boundary) throw new TypeError('Missing encounter admission proof');
  const catalog = getWorldRunCombatCatalog(world); const definition = getWorldRunEncounter(world, encounter.definitionId);
  const participants = boundary.squad.map((member, index) => ({ discipleId: member.discipleId, battleEntityId: `entity:${index + 1}` }));
  if (canonicalStringify(participants) !== canonicalStringify(encounter.participants)) throw new TypeError('Battle participants differ from admission identity order');
  const entities: BattleEntityInput[] = boundary.squad.map((member, index) => ({ id: participants[index]!.battleEntityId, team: 'sect', position: { x: 80, y: 80 * (index + 1) },
    stats: copy(member.loadout.stats), healthRatioBps: Math.max(1, Math.min(10_000, Math.floor(member.health * 10_000 / member.loadout.stats.maxHealth))),
    spirit: member.spirit, maximumSpirit: member.loadout.maximumSpirit, skills: [...member.loadout.activeSkillIds, member.loadout.passiveSkillId],
    sources: [...member.loadout.characterSourceIds], basic: copy(member.loadout.basic), deathRule: 'downed' }));
  for (const [index, enemy] of definition.enemies.entries()) {
    const { nameKey: _label, ...data } = enemy;
    const id = `entity:${participants.length + index + 1}`;
    if (!encounter.enemies.some(entry => entry.battleEntityId === id && entry.nameKey === enemy.nameKey)) throw new TypeError('Enemy identity differs from registered admission');
    entities.push({ ...copy(data), id, team: 'foe' });
  }
  const anchors: { instanceId: string; definitionId: string; actorId: string }[] = [];
  for (const talent of boundary.talentSources) {
    const bound = talent.boundHolderId ? participants.find(entry => entry.discipleId === talent.boundHolderId)?.battleEntityId : undefined;
    if (talent.boundHolderId && !bound) throw new TypeError('Invalid admitted talent recipient');
    for (const member of participants.filter(entry => talent.holderScope === 'team' || entry.discipleId === talent.holderId)) {
      const index = entities.findIndex(entry => entry.id === member.battleEntityId); const input = entities[index]!;
      entities[index] = { ...input, sources: [...(input.sources ?? []), { definitionId: talent.definitionId, ...(bound ? { options: { boundHolderId: bound } } : {}) }] };
      anchors.push({ instanceId: talent.instanceId, definitionId: talent.definitionId, actorId: member.battleEntityId });
    }
  }
  const admitted = createBattle(catalog, { seed: boundary.seed, entities, contentMode: 'experimental', logCapacity: 160,
    ...(world.expedition.protocol === 'release-v3' ? { arena: copy(definition.arena) } : {}) });
  const characters: CharacterSourceBinding[] = participants.flatMap(participant => {
    const build = world.builds.disciples.find(entry => entry.discipleId === participant.discipleId);
    if (!build) throw new TypeError('Battle source owner has no locked build');
    return build.sources.map(source => {
      const actual = Object.values(admitted.sources).find(entry => entry.holderId === participant.battleEntityId && entry.sourceDefinitionId === source.sourceDefinitionId);
      if (source.kind !== 'equipment' && !actual) throw new TypeError('Permanent source was not admitted');
      return { worldSourceInstanceId: source.sourceInstanceId, discipleId: participant.discipleId, battleEntityId: participant.battleEntityId,
        definitionId: source.sourceDefinitionId, kind: source.kind === 'equipment' ? 'bakedEquipment' as const : 'installed' as const,
        battleSourceInstanceId: source.kind === 'equipment' ? null : actual!.sourceInstanceId };
    });
  });
  const talents: EncounterSourceBinding[] = anchors.map(anchor => {
    const source = Object.values(admitted.sources).find(entry => entry.holderId === anchor.actorId && entry.sourceDefinitionId === anchor.definitionId);
    if (!source) throw new TypeError('Run source was not admitted');
    return { runTalentInstanceId: anchor.instanceId, battleSourceInstanceId: source.sourceInstanceId };
  });
  if (characters.length !== encounter.characterSourceBindings.length || new Set(encounter.characterSourceBindings.map(entry => entry.worldSourceInstanceId)).size !== characters.length
    || characters.some(expected => !encounter.characterSourceBindings.some(actual => canonicalStringify(actual) === canonicalStringify(expected)))) throw new TypeError('Permanent source binding differs from admission proof');
  if (talents.length !== encounter.sourceBindings.length || new Set(encounter.sourceBindings.map(entry => entry.battleSourceInstanceId)).size !== talents.length
    || talents.some(expected => !encounter.sourceBindings.some(actual => canonicalStringify(actual) === canonicalStringify(expected)))) throw new TypeError('Run source binding differs from admission proof');
  for (const id of [...characters.flatMap(entry => entry.battleSourceInstanceId ? [entry.battleSourceInstanceId] : []), ...talents.map(entry => entry.battleSourceInstanceId)]) {
    const original = admitted.sources[id]!; const current = encounter.controller.battle.sources[id];
    if (current ? current.holderId !== original.holderId || current.sourceEntityId !== original.sourceEntityId
      || current.sourceDefinitionId !== original.sourceDefinitionId || current.boundHolderId !== original.boundHolderId
      : encounter.controller.battle.entities[original.holderId]?.life !== 'Dead' && encounter.controller.battle.entities[original.boundHolderId]?.life !== 'Dead') throw new TypeError('Bound runtime source is missing or owned by another actor');
  }
}
