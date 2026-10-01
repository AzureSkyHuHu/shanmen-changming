import type { School, TreeNodeDefinition } from '../combat/definitions/types';
import { combatDefinitionSupport } from '../combat/runtime/engine';
import { allocateId, createSequences } from '../kernel/ids';
import type { SequenceState } from '../kernel/ids';
import { checkedAdd } from '../kernel/numeric';
import { canonicalStringify, compareStable, stableHash } from '../kernel/serialization';

import { assertJson, BuildFault, copy, exact, freeze, integer, unique, validId } from './shared';
import type { BuildChoice, BuildCombatLoadout, BuildCommand, BuildLoadout, BuildProgress, BuildReceipt, BuildSource, BuildSourceOperation, CreateBuildOptions, EquipmentSlot } from './types';
import type { AnyBuildCommandV2 as AnyBuildCommand, BuildAuthorityCommandV2 as BuildAuthorityCommand, BuildContentContext, BuildDiscipleV2 as BuildDisciple, BuildFrameV2 as BuildFrame, BuildStateFrameV2 as BuildStateFrame, BuildTransitionV2 as BuildTransition, EquipmentInstanceV2 as EquipmentInstance, EquipmentOwner, BuildErrorV2, KnowledgeOrigin, BuildMigrationBoundary } from './v2-types';
import { catalogFingerprint } from '../combat/runtime/catalog';
import { replayLegacyBuildHistoryV1, validateLegacyBuildFrameV1 } from './legacy-v1';
import type { LegacyBuildStateFrameV1 } from './legacy-v1';

const trusted = new WeakMap<object, string>();
const preparedContexts = new WeakSet<object>();
const same = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const sequenceKeys = ['nextEntity', 'nextEvent', 'nextAction', 'nextInstance'] as const;
class BuildV2Fault extends Error {
  constructor(readonly code: BuildErrorV2, readonly reasons: readonly string[] = []) { super(code); }
}
function fail(code: BuildErrorV2, reasons: readonly string[] = []): never { throw new BuildV2Fault(code, reasons); }
function contextKey(context: BuildContentContext): string {
  return canonicalStringify({ identity: context.identity, rulesHash: stableHash(context.rules), legacy: context.legacy.identity });
}
function equipmentDefinition(context: BuildContentContext, id: string) { return context.rules.equipment.find(item => item.id === id); }
function skillLearningRule(context: BuildContentContext, id: string) { return context.rules.lessons.find(item => item.skillId === id); }
function basicId(school: School): string { return `basic.${school}`; }
function basicDefinition(context: BuildContentContext, school: School): BuildCombatLoadout['basic'] {
  const definition = context.rules.basics.find(item => item.id === basicId(school));
  if (!definition) fail('UNKNOWN_DEFINITION'); return copy(definition.definition);
}
function slots(context: BuildContentContext): readonly EquipmentSlot[] { return context.rules.equipmentSlots as readonly EquipmentSlot[]; }
function ownerValid(owner: unknown): owner is EquipmentOwner {
  return exact(owner, ['kind']) && owner.kind === 'sect-estate'
    || exact(owner, ['kind', 'discipleId']) && owner.kind === 'disciple' && validId(owner.discipleId);
}
function provenanceValid(value: unknown): value is KnowledgeOrigin {
  return exact(value, ['kind', 'knowledgeId']) && value.kind === 'archive' && validId(value.knowledgeId)
    || exact(value, ['kind', 'knowledgeId', 'teacherId', 'teachingId']) && value.kind === 'teaching'
      && validId(value.knowledgeId) && validId(value.teacherId) && validId(value.teachingId);
}
function sequencesValid(value: unknown): value is SequenceState { return exact(value, sequenceKeys) && sequenceKeys.every(key => integer(value[key], 1)); }
function follows(next: SequenceState, prior: SequenceState): boolean { return sequenceKeys.every(key => next[key] >= prior[key]); }
function sealed(frame: BuildFrame, context: BuildContentContext): BuildStateFrame { const result = freeze(frame); trusted.set(result, contextKey(context)); return result; }
function contextCheck(context: BuildContentContext): void {
  if (preparedContexts.has(context)) return;
  assertJson(context);
  if (!exact(context, ['identity', 'catalog', 'rules', 'legacy']) || !exact(context.legacy, ['identity', 'catalog'])) fail('INVALID_INPUT');
  for (const identity of [context.identity, context.legacy.identity]) {
    if (!exact(identity, ['registryId', 'compositeFingerprint', 'combatFingerprint', 'buildRulesVersion'])
      || !validId(identity.registryId) || !/^[0-9a-f]{8}$/.test(identity.compositeFingerprint)
      || !/^[0-9a-f]{8}$/.test(identity.combatFingerprint)) fail('INVALID_INPUT');
  }
  const rules = context.rules;
  if (context.identity.buildRulesVersion !== 2 || context.legacy.identity.buildRulesVersion !== 1
    || context.identity.combatFingerprint !== catalogFingerprint(context.catalog)
    || context.legacy.identity.combatFingerprint !== catalogFingerprint(context.legacy.catalog)
    || rules.version !== 2 || !same(rules.schools, ['sword', 'body', 'alchemy', 'talisman'])
    || !same(rules.equipmentSlots, ['weapon', 'robe', 'artifact']) || rules.maximumAllocatedPoints !== 5
    || !integer(rules.maximumCommands, 1, 1024) || !integer(rules.maximumDisciples, 1, 36)
    || !integer(rules.maximumEquipment, 3, 512) || !unique(rules.equipment.map(item => item.id))
    || !unique(rules.lessons.map(item => item.skillId)) || !unique(rules.basics.map(item => item.id))) fail('INVALID_INPUT');
  for (const school of rules.schools) {
    if (!Array.isArray(rules.starterSkills[school]) || rules.starterSkills[school].length !== 3
      || !unique(rules.starterSkills[school]) || !rules.basics.some(item => item.id === basicId(school) && item.definition.school === school)) fail('INVALID_INPUT');
  }
  if (!context.catalog || context.catalog.schemaVersion !== 1 || !Array.isArray(context.catalog.trees) || context.catalog.trees.length !== 4 || !Array.isArray(context.catalog.treeNodes) || context.catalog.treeNodes.length !== 36 || !Array.isArray(context.catalog.skills)) fail('INVALID_INPUT');
  const all = [...context.catalog.skills, ...context.catalog.trees, ...context.catalog.treeNodes, ...context.catalog.talents, ...context.catalog.statuses, ...context.catalog.summons, ...context.catalog.builds];
  if (!unique(all.map(item => item.id)) || all.some(item => !validId(item.id))) fail('INVALID_INPUT');
  for (const school of context.rules.schools) {
    const tree = context.catalog.trees.find(item => item.id === `tree.${school}`);
    if (!tree || tree.kind !== 'tree' || tree.school !== school || tree.maximumPoints !== 5 || tree.nodeIds.length !== 9 || !unique(tree.nodeIds)) fail('INVALID_INPUT');
    const nodes = context.catalog.treeNodes.filter(node => node.treeId === tree.id);
    if (nodes.length !== 9 || nodes.some(node => !tree.nodeIds.includes(node.id) || node.pointCost !== 1 || node.kind !== 'treeNode' || node.school !== school)) fail('INVALID_INPUT');
    for (const branch of ['a', 'b', 'c']) for (const tier of [1, 2, 3]) {
      const matches = nodes.filter(node => node.branch === branch && node.tier === tier);
      if (matches.length !== 1) fail('INVALID_INPUT');
      const node = matches[0]!;
      const expected = nodes.filter(other => other.branch === branch && other.tier < tier).map(other => other.id).sort(compareStable);
      if (!same([...node.prerequisites].sort(compareStable), expected) || !unique(node.excludes) || node.excludes.some((id: string) => !tree.nodeIds.includes(id))) fail('INVALID_INPUT');
    }
    for (const id of context.rules.starterSkills[school]) {
      const skill = context.catalog.skills.find(item => item.id === id);
      if (!skill || skill.school !== school || !skillLearningRule(context, id)) fail('INVALID_INPUT');
    }
  }
  // Cache only deeply frozen caller catalogs; mutable input must be checked on every call.
  const frozen = (value: unknown): boolean => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(frozen));
  if (frozen(context)) preparedContexts.add(context);
}
function supported(context: BuildContentContext, definitionId: string, mode: 'verified' | 'experimental'): void {
  const support = combatDefinitionSupport(context.catalog, definitionId, mode);
  if (!support.supported) fail('UNSUPPORTED_CONTENT', support.reasons);
}
function nextId(frame: BuildFrame): string { const next = allocateId(frame.sequences, 'instance'); frame.sequences = next.sequences; return next.id; }
function source(frame: BuildFrame, discipleId: string, definitionId: string, kind: BuildSource['kind'], itemInstanceId: string | null = null): BuildSource {
  const createdSequence = frame.sequences.nextInstance;
  return { sourceEntityId: discipleId, sourceDefinitionId: definitionId, sourceInstanceId: nextId(frame), createdSequence, lifecycleScope: 'character', duration: { kind: 'infinite' }, kind, itemInstanceId };
}
function getDisciple(frame: BuildStateFrame, discipleId: string): BuildStateFrame['builds']['disciples'][number] {
  const disciple = frame.builds.disciples.find(item => item.discipleId === discipleId);
  if (!disciple) fail('UNKNOWN_DISCIPLE'); return disciple;
}
function mutableDisciple(frame: BuildFrame, discipleId: string): BuildDisciple { return getDisciple(frame, discipleId) as BuildDisciple; }
function progress(frame: BuildStateFrame, discipleId: string): BuildProgress {
  const disciple = getDisciple(frame, discipleId);
  const awards = frame.builds.awards.filter(award => award.discipleId === discipleId);
  const earnedPoints = awards.reduce((sum, award) => sum + award.treePoints, 0);
  const earnedLearningCredits = awards.reduce((sum, award) => sum + award.learningCredits, 0);
  const spentLearningCredits = disciple.learnedSkills.reduce((sum, skill) => sum + skill.creditCost, 0);
  return { earnedPoints, allocatedPoints: disciple.allocatedNodeIds.length, availablePoints: earnedPoints - disciple.allocatedNodeIds.length, earnedLearningCredits, spentLearningCredits, availableLearningCredits: earnedLearningCredits - spentLearningCredits };
}
function orderedNodes(ids: readonly string[], context: BuildContentContext): TreeNodeDefinition[] {
  return ids.map(id => { const node = context.catalog.treeNodes.find(item => item.id === id); if (!node) fail('UNKNOWN_DEFINITION'); return node; })
    .sort((left, right) => left.tier - right.tier || compareStable(left.id, right.id));
}
function allocationValid(frame: BuildStateFrame, discipleId: string, ids: readonly string[], context: BuildContentContext): void {
  const disciple = getDisciple(frame, discipleId);
  if (!Array.isArray(ids) || ids.some(id => !validId(id)) || !unique(ids)) fail('INVALID_ALLOCATION');
  if (ids.length > context.rules.maximumAllocatedPoints) fail('POINT_LIMIT');
  const nodes = orderedNodes(ids, context);
  if (nodes.some(node => node.treeId !== disciple.treeId || node.school !== disciple.school || node.pointCost !== 1 || node.excludes.some(id => ids.includes(id)))) fail('INVALID_ALLOCATION');
  if (nodes.some(node => node.prerequisites.some(id => !ids.includes(id)))) fail('MISSING_PREREQUISITE');
  if (ids.length > progress(frame, discipleId).earnedPoints) fail('INSUFFICIENT_POINTS');
  for (const node of nodes) supported(context, node.id, frame.builds.contentMode);
}
function skillRequirements(context: BuildContentContext, disciple: BuildStateFrame['builds']['disciples'][number], skillId: string, nodeIds: readonly string[] = disciple.allocatedNodeIds): void {
  const rule = skillLearningRule(context, skillId);
  if (!rule) fail('UNKNOWN_DEFINITION');
  if (rule.requiredSkillIds.some(id => !disciple.learnedSkills.some(skill => skill.skillId === id)) || rule.requiredNodeIds.some(id => !nodeIds.includes(id))) fail('MISSING_PREREQUISITE');
}
function loadoutShape(loadout: unknown): loadout is BuildLoadout {
  if (!exact(loadout, ['basicId', 'activeSkillIds', 'passiveSkillId', 'equipment']) || !validId(loadout.basicId) || !validId(loadout.passiveSkillId)
    || !Array.isArray(loadout.activeSkillIds) || loadout.activeSkillIds.length !== 2 || !loadout.activeSkillIds.every(validId) || !unique(loadout.activeSkillIds)
    || !exact(loadout.equipment, ['weaponId', 'robeId', 'artifactId']) || !Object.values(loadout.equipment).every(validId)) return false;
  return unique(Object.values(loadout.equipment));
}
function loadoutValid(frame: BuildStateFrame, discipleId: string, loadout: BuildStateFrame['builds']['disciples'][number]['loadout'], context: BuildContentContext, nodeIds?: readonly string[]): void {
  const disciple = getDisciple(frame, discipleId);
  if (!loadoutShape(loadout) || loadout.basicId !== basicId(disciple.school)) fail('INVALID_LOADOUT');
  for (const id of [...loadout.activeSkillIds, loadout.passiveSkillId]) {
    const skill = context.catalog.skills.find(item => item.id === id);
    if (!skill) fail('UNKNOWN_DEFINITION');
    if (skill.school !== disciple.school || skill.activation !== (id === loadout.passiveSkillId ? 'passive' : 'active') || !disciple.learnedSkills.some(item => item.skillId === id)) fail('INVALID_LOADOUT');
    skillRequirements(context, disciple, id, nodeIds);
    supported(context, id, frame.builds.contentMode);
  }
  for (const slot of slots(context)) {
    const instanceId = loadout.equipment[`${slot}Id`];
    const item = frame.builds.equipment.find(entry => entry.instanceId === instanceId);
    if (!item || item.owner.kind !== 'disciple' || item.owner.discipleId !== discipleId) fail('ITEM_NOT_OWNED');
    const definition = equipmentDefinition(context, item.definitionId);
    if (!definition || definition.slot !== slot || (definition.school !== null && definition.school !== disciple.school)) fail('INVALID_LOADOUT');
    if (frame.builds.disciples.some(other => other.discipleId !== discipleId && Object.values(other.loadout.equipment).includes(instanceId))) fail('ITEM_ALREADY_EQUIPPED');
  }
}
function addLoadoutSources(context: BuildContentContext, frame: BuildFrame, disciple: BuildDisciple): BuildSource[] {
  const result = [...disciple.loadout.activeSkillIds, disciple.loadout.passiveSkillId].map(id => source(frame, disciple.discipleId, id, 'skill'));
  for (const slot of slots(context)) {
    const itemId = disciple.loadout.equipment[`${slot}Id`];
    const item = frame.builds.equipment.find(entry => entry.instanceId === itemId)!;
    result.push(source(frame, disciple.discipleId, item.definitionId, 'equipment', itemId));
  }
  disciple.sources.push(...result); return result;
}
function lockHash(disciple: BuildStateFrame['builds']['disciples'][number]): string { return stableHash({ allocatedNodeIds: disciple.allocatedNodeIds, loadout: disciple.loadout, sources: disciple.sources }); }
function enroll(frame: BuildFrame, input: { discipleId: string; school: School }, acquisitionId: string, context: BuildContentContext): BuildDisciple {
  const starter = context.rules.starterSkills[input.school];
  const equipment = {} as BuildLoadout['equipment'];
  if (frame.builds.equipment.length + 3 > context.rules.maximumEquipment) fail('COMMAND_LIMIT');
  for (const slot of slots(context)) {
    const instanceId = nextId(frame);
    const definitionId = slot === 'weapon' ? `equipment.training-${input.school}` : `equipment.training-${slot}`;
    frame.builds.equipment.push({ instanceId, definitionId, owner: { kind: 'disciple', discipleId: input.discipleId }, acquisitionId: `${acquisitionId}/${slot}` });
    equipment[`${slot}Id`] = instanceId;
  }
  const disciple: BuildDisciple = { discipleId: input.discipleId, school: input.school, treeId: `tree.${input.school}`, allocatedNodeIds: [],
    learnedSkills: starter.map(skillId => ({ skillId, origin: 'starter', creditCost: 0, acquisitionId })),
    loadout: { basicId: basicId(input.school), activeSkillIds: [starter[0]!, starter[1]!], passiveSkillId: starter[2]!, equipment }, sources: [], lock: null };
  frame.builds.disciples.push(disciple);
  loadoutValid(frame, disciple.discipleId, disciple.loadout, context);
  addLoadoutSources(context, frame, disciple);
  return disciple;
}
function createUnchecked(options: CreateBuildOptions, context: BuildContentContext): BuildStateFrame {
  const origin = copy(options);
  origin.disciples.sort((a, b) => compareStable(a.discipleId, b.discipleId));
  origin.sequences = copy(origin.sequences ?? createSequences());
  const frame: BuildFrame = { builds: { schemaVersion: 2, simulationVersion: 'permanent-builds-2', rulesVersion: 2,
    contentIdentity: copy(context.identity), rulesHash: stableHash(context.rules), origin,
    contentMode: origin.contentMode, revision: 0, migration: null, disciples: [], retiredDisciples: [], equipment: [], awards: [], receipts: [], history: [] }, sequences: copy(origin.sequences) };
  for (const input of origin.disciples) {
    enroll(frame, input, `starter/${input.discipleId}`, context);
  }
  return sealed(frame, context);
}
export function createBuildFrameV2(options: CreateBuildOptions, context: BuildContentContext): BuildStateFrame {
  assertJson(options); contextCheck(context);
  const keys = options && Object.keys(options).sort().join(',');
  if (keys !== 'contentMode,disciples' && keys !== 'contentMode,disciples,sequences') fail('INVALID_INPUT');
  if (!Array.isArray(options.disciples) || options.disciples.length > context.rules.maximumDisciples || !unique(options.disciples.map(item => item.discipleId))
    || options.disciples.some(item => !exact(item, ['discipleId', 'school']) || !validId(item.discipleId) || !context.rules.schools.includes(item.school))
    || !['verified', 'experimental'].includes(options.contentMode) || (options.sequences !== undefined && !sequencesValid(options.sequences))) fail('INVALID_INPUT');
  return createUnchecked(options, context);
}
function isCommand(value: unknown, authority: boolean, context: BuildContentContext): value is AnyBuildCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as AnyBuildCommand;
  if (!validId(command.commandId) || !integer(command.expectedRevision)) return false;
  const common = ['kind', 'commandId', 'expectedRevision'];
  if (!authority) {
    if (command.kind === 'tree.respec') return exact(command, [...common, 'discipleId', 'nodeIds']) && validId(command.discipleId) && Array.isArray(command.nodeIds) && command.nodeIds.length <= 36 && command.nodeIds.every(validId);
    if (command.kind === 'skill.learn') return exact(command, [...common, 'discipleId', 'skillId']) && validId(command.discipleId) && validId(command.skillId);
    if (command.kind === 'loadout.set') return exact(command, [...common, 'discipleId', 'loadout']) && validId(command.discipleId) && loadoutShape(command.loadout);
    return false;
  }
  if (command.kind === 'milestone.award') return exact(command, [...common, 'discipleId', 'milestoneId', 'ruleId']) && validId(command.discipleId) && validId(command.milestoneId) && context.rules.milestones.includes(command.ruleId);
  if (command.kind === 'equipment.grant') return exact(command, [...common, 'discipleId', 'acquisitionId', 'definitionId']) && validId(command.discipleId) && validId(command.acquisitionId) && validId(command.definitionId);
  if (command.kind === 'disciple.enroll') return exact(command, [...common, 'discipleId', 'acquisitionId', 'school'])
    && validId(command.discipleId) && validId(command.acquisitionId) && context.rules.schools.includes(command.school);
  if (command.kind === 'skill.grantKnowledge') return exact(command, [...common, 'discipleId', 'acquisitionId', 'skillId', 'provenance'])
    && validId(command.discipleId) && validId(command.acquisitionId) && validId(command.skillId) && provenanceValid(command.provenance);
  if (command.kind === 'disciple.retire') return exact(command, [...common, 'discipleId', 'deathId']) && validId(command.discipleId) && validId(command.deathId);
  if (command.kind === 'equipment.transfer') return exact(command, [...common, 'transferId', 'itemInstanceId', 'fromOwner', 'toOwner', 'reason'])
    && validId(command.transferId) && validId(command.itemInstanceId) && ownerValid(command.fromOwner) && ownerValid(command.toOwner)
    && ((exact(command.reason, ['kind', 'deathId']) && command.reason.kind === 'death' && validId(command.reason.deathId))
      || (exact(command.reason, ['kind', 'assignmentId']) && command.reason.kind === 'estate-assignment' && validId(command.reason.assignmentId)));
  if (command.kind === 'expedition.lock' || command.kind === 'expedition.unlock') return exact(command, [...common, 'runId', 'locks']) && validId(command.runId)
    && Array.isArray(command.locks) && command.locks.length > 0 && command.locks.length <= context.rules.maximumDisciples && unique(command.locks.map(item => item?.discipleId)) && unique(command.locks.map(item => item?.lockId))
    && command.locks.every(item => exact(item, ['discipleId', 'lockId']) && validId(item.discipleId) && validId(item.lockId));
  return false;
}


function run(frame: BuildFrame, command: AnyBuildCommand, context: BuildContentContext, operations: BuildSourceOperation[]): string | null {
  if (command.kind === 'disciple.enroll') {
    if (frame.builds.disciples.some(item => item.discipleId === command.discipleId)
      || frame.builds.retiredDisciples.some(item => item.discipleId === command.discipleId)) fail('IDENTITY_REUSED');
    if (frame.builds.disciples.length >= context.rules.maximumDisciples) fail('COMMAND_LIMIT');
    if (frame.builds.history.some(entry => entry.command.kind === 'disciple.enroll' && entry.command.acquisitionId === command.acquisitionId)
      || frame.builds.equipment.some(item => item.acquisitionId === command.acquisitionId)
      || frame.builds.disciples.some(item => item.learnedSkills.some(skill => skill.acquisitionId === command.acquisitionId))) fail('ACQUISITION_CONFLICT');
    const added = enroll(frame, command, command.acquisitionId, context);
    operations.push(...added.sources.map(source => ({ kind: 'source.install' as const, source: copy(source) })));
    return command.discipleId;
  }
  if (command.kind === 'equipment.transfer') {
    const previous = frame.builds.history.map(entry => entry.command).find(entry => entry.kind === 'equipment.transfer' && entry.transferId === command.transferId);
    if (previous?.kind === 'equipment.transfer') {
      const { commandId: _oldId, expectedRevision: _oldRevision, ...oldEffect } = previous;
      const { commandId: _id, expectedRevision: _revision, ...effect } = command;
      if (!same(oldEffect, effect)) fail('TRANSFER_CONFLICT'); return command.itemInstanceId;
    }
    const item = frame.builds.equipment.find(entry => entry.instanceId === command.itemInstanceId);
    if (!item || !same(item.owner, command.fromOwner) || same(command.fromOwner, command.toOwner)) fail('ITEM_NOT_OWNED');
    if (frame.builds.disciples.some(member => Object.values(member.loadout.equipment).includes(item.instanceId))) fail('ITEM_ALREADY_EQUIPPED');
    if (item.owner.kind === 'disciple' && frame.builds.disciples.some(member => member.discipleId === (item.owner as { discipleId: string }).discipleId && member.lock)) fail('EXPEDITION_LOCKED');
    if (command.toOwner.kind === 'disciple') getDisciple(frame, command.toOwner.discipleId);
    if (command.reason.kind === 'death') {
      if (command.fromOwner.kind !== 'disciple' || !frame.builds.retiredDisciples.some(member => member.discipleId === (command.fromOwner as { discipleId: string }).discipleId
        && member.deathId === (command.reason as { deathId: string }).deathId)) fail('INVALID_PROVENANCE');
      if (frame.builds.history.some(entry => entry.command.kind === 'equipment.transfer' && entry.command.itemInstanceId === item.instanceId
        && entry.command.reason.kind === 'death' && entry.command.reason.deathId === (command.reason as { deathId: string }).deathId)) fail('TRANSFER_CONFLICT');
    } else if (command.fromOwner.kind !== 'sect-estate') fail('INVALID_PROVENANCE');
    item.owner = copy(command.toOwner); return item.instanceId;
  }
  if (command.kind === 'disciple.retire') {
    const prior = frame.builds.retiredDisciples.find(member => member.discipleId === command.discipleId);
    if (prior) { if (prior.deathId !== command.deathId) fail('ALREADY_RETIRED'); return prior.discipleId; }
    const member = mutableDisciple(frame, command.discipleId);
    if (member.lock) fail('EXPEDITION_LOCKED');
    if (frame.builds.retiredDisciples.some(entry => entry.deathId === command.deathId)) fail('INVALID_PROVENANCE');
    operations.push(...[...member.sources].sort((a, b) => b.createdSequence - a.createdSequence).map(source => ({ kind: 'source.remove' as const, source: copy(source) })));
    frame.builds.retiredDisciples.push({ discipleId: member.discipleId, school: member.school, treeId: member.treeId,
      deathId: command.deathId, learnedSkills: copy(member.learnedSkills), retiredRevision: checkedAdd(frame.builds.revision, 1) });
    frame.builds.disciples = frame.builds.disciples.filter(entry => entry.discipleId !== member.discipleId);
    return member.discipleId;
  }
  if (command.kind === 'expedition.lock' || command.kind === 'expedition.unlock') {
    for (const entry of [...command.locks].sort((a, b) => compareStable(a.discipleId, b.discipleId))) {
      const disciple = mutableDisciple(frame, entry.discipleId);
      if (command.kind === 'expedition.lock') {
        if (disciple.lock) fail('EXPEDITION_LOCKED');
        if (frame.builds.disciples.some(other => other.lock?.lockId === entry.lockId)) fail('LOCK_MISMATCH');
        loadoutValid(frame, disciple.discipleId, disciple.loadout, context);
        disciple.lock = { runId: command.runId, lockId: entry.lockId, loadoutHash: lockHash(disciple) };
      } else {
        if (!disciple.lock || disciple.lock.runId !== command.runId || disciple.lock.lockId !== entry.lockId || disciple.lock.loadoutHash !== lockHash(disciple)) fail('LOCK_MISMATCH');
        disciple.lock = null;
      }
    }
    return command.runId;
  }
  const disciple = mutableDisciple(frame, command.discipleId);
  if (command.kind === 'milestone.award') {
    const award = { milestoneId: command.milestoneId, discipleId: command.discipleId, ruleId: command.ruleId, treePoints: 1 as const, learningCredits: 2 as const };
    const previous = frame.builds.awards.find(item => item.milestoneId === command.milestoneId);
    if (previous) { if (!same(previous, award)) fail('MILESTONE_CONFLICT'); return previous.milestoneId; }
    if (frame.builds.awards.some(item => item.discipleId === command.discipleId && item.ruleId === command.ruleId)) fail('MILESTONE_ALREADY_AWARDED');
    if (progress(frame, command.discipleId).earnedPoints >= context.rules.maximumAllocatedPoints) fail('POINT_LIMIT');
    frame.builds.awards.push(award); return command.milestoneId;
  }
  if (command.kind === 'equipment.grant') {
    const definition = equipmentDefinition(context, command.definitionId);
    if (!definition) fail('UNKNOWN_DEFINITION');
    const previous = frame.builds.equipment.find(item => item.acquisitionId === command.acquisitionId);
    if (previous) {
      if (previous.definitionId !== command.definitionId || previous.owner.kind !== 'disciple' || previous.owner.discipleId !== command.discipleId) fail('ACQUISITION_CONFLICT');
      return previous.instanceId;
    }
    if (frame.builds.equipment.length >= context.rules.maximumEquipment) fail('COMMAND_LIMIT');
    const item: EquipmentInstance = { instanceId: nextId(frame), definitionId: command.definitionId, owner: { kind: 'disciple', discipleId: command.discipleId }, acquisitionId: command.acquisitionId };
    frame.builds.equipment.push(item); return item.instanceId;
  }
  if (disciple.lock) fail('EXPEDITION_LOCKED');
  if (command.kind === 'skill.grantKnowledge') {
    const previous = [...frame.builds.disciples, ...frame.builds.retiredDisciples].flatMap(member => member.learnedSkills.map(skill => ({ member, skill })))
      .find(entry => entry.skill.acquisitionId === command.acquisitionId);
    if (previous) {
      if (previous.member.discipleId !== command.discipleId || previous.skill.skillId !== command.skillId
        || !('provenance' in previous.skill) || !same(previous.skill.provenance, command.provenance)) fail('ACQUISITION_CONFLICT');
      return command.skillId;
    }
    const definition = context.catalog.skills.find(skill => skill.id === command.skillId);
    if (!definition || definition.school !== disciple.school) fail('UNKNOWN_DEFINITION');
    if (disciple.learnedSkills.some(skill => skill.skillId === command.skillId)) fail('ALREADY_LEARNED');
    if (command.provenance.kind === 'teaching') {
      const provenance = command.provenance;
      const teacher = [...frame.builds.disciples, ...frame.builds.retiredDisciples].find(member => member.discipleId === provenance.teacherId);
      if (!teacher || teacher.discipleId === disciple.discipleId || !teacher.learnedSkills.some(skill => skill.skillId === command.skillId
        && 'provenance' in skill && skill.provenance.knowledgeId === command.provenance.knowledgeId)) fail('INVALID_PROVENANCE');
    }
    skillRequirements(context, disciple, command.skillId); supported(context, command.skillId, frame.builds.contentMode);
    disciple.learnedSkills.push({ skillId: command.skillId, origin: command.provenance.kind, creditCost: 0,
      acquisitionId: command.acquisitionId, provenance: copy(command.provenance) });
    return command.skillId;
  }
  if (command.kind === 'skill.learn') {
    const skill = context.catalog.skills.find(item => item.id === command.skillId);
    const rule = skillLearningRule(context, command.skillId);
    if (!skill || !rule) fail('UNKNOWN_DEFINITION');
    if (disciple.learnedSkills.some(item => item.skillId === command.skillId)) fail('ALREADY_LEARNED');
    skillRequirements(context, disciple, command.skillId);
    supported(context, command.skillId, frame.builds.contentMode);
    if (progress(frame, command.discipleId).availableLearningCredits < rule.creditCost) fail('INSUFFICIENT_LEARNING_CREDITS');
    disciple.learnedSkills.push({ skillId: command.skillId, origin: 'study', creditCost: rule.creditCost, acquisitionId: command.commandId });
    return command.skillId;
  }
  if (command.kind === 'tree.respec') {
    allocationValid(frame, command.discipleId, command.nodeIds, context);
    loadoutValid(frame, command.discipleId, disciple.loadout, context, command.nodeIds);
    const nodes = orderedNodes(command.nodeIds, context);
    if (same(disciple.allocatedNodeIds, nodes.map(node => node.id))) return null;
    const oldNodes = orderedNodes(disciple.allocatedNodeIds, context).reverse();
    for (const node of oldNodes) {
      const oldSource = disciple.sources.find(item => item.kind === 'treeNode' && item.sourceDefinitionId === node.id)!;
      operations.push({ kind: 'source.remove', source: copy(oldSource) });
    }
    disciple.sources = disciple.sources.filter(item => item.kind !== 'treeNode');
    disciple.allocatedNodeIds = nodes.map(node => node.id);
    for (const node of nodes) {
      const installed = source(frame, disciple.discipleId, node.id, 'treeNode');
      disciple.sources.push(installed); operations.push({ kind: 'source.install', source: copy(installed) });
    }
    return null;
  }
  loadoutValid(frame, command.discipleId, command.loadout, context);
  if (same(disciple.loadout, command.loadout)) return null;
  const previous = disciple.sources.filter(item => item.kind !== 'treeNode').sort((a, b) => b.createdSequence - a.createdSequence);
  operations.push(...previous.map(item => ({ kind: 'source.remove' as const, source: copy(item) })));
  disciple.sources = disciple.sources.filter(item => item.kind === 'treeNode');
  disciple.loadout = copy(command.loadout);
  operations.push(...addLoadoutSources(context, frame, disciple).map(item => ({ kind: 'source.install' as const, source: copy(item) })));
  return null;
}

function upgradeUnchecked(legacy: LegacyBuildStateFrameV1, context: BuildContentContext): BuildStateFrame {
  const source = legacy.builds;
  const migration: BuildMigrationBoundary = { kind: 'legacy-v1', identity: copy(context.legacy.identity),
    prefixLength: source.history.length, sourceStateHash: stableHash(legacy), sequencesAtMigration: copy(legacy.sequences) };
  return sealed({ builds: { schemaVersion: 2, simulationVersion: 'permanent-builds-2', rulesVersion: 2,
    contentIdentity: copy(context.identity), rulesHash: stableHash(context.rules), origin: copy(source.origin),
    contentMode: source.contentMode, revision: source.revision, migration,
    disciples: copy(source.disciples), retiredDisciples: [],
    equipment: source.equipment.map(item => ({ instanceId: item.instanceId, definitionId: item.definitionId,
      acquisitionId: item.acquisitionId, owner: { kind: 'disciple', discipleId: item.ownerDiscipleId } })),
    awards: copy(source.awards), receipts: copy(source.receipts), history: copy(source.history),
  }, sequences: copy(legacy.sequences) }, context);
}
/** Strict old replay precedes the structural boundary. No ID, source, RNG or receipt is regenerated. */
export function upgradeLegacyBuildFrameV1(value: unknown, context: BuildContentContext): BuildStateFrame {
  contextCheck(context); validateLegacyBuildFrameV1(value, context.legacy.catalog);
  return upgradeUnchecked(value, context);
}
function apply(previous: BuildStateFrame, command: unknown, context: BuildContentContext, authority: boolean, skipValidation = false): BuildTransition {
  let stage: 'state' | 'command' | 'run' = 'state';
  try {
    contextCheck(context);
    if (!skipValidation) validateBuildFrameV2(previous, context);
    stage = 'command'; assertJson(command);
    if (!isCommand(command, authority, context)) fail('INVALID_COMMAND');
    const fingerprint = canonicalStringify({ command, authority });
    const receipt = previous.builds.receipts.find(item => item.commandId === command.commandId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail('COMMAND_CONFLICT');
      return { ok: true, frame: previous, receipt, operations: [], replayed: true };
    }
    if (command.expectedRevision !== previous.builds.revision) fail('REVISION_CONFLICT');
    if (previous.builds.history.length >= context.rules.maximumCommands) fail('COMMAND_LIMIT');
    stage = 'run';
    const frame = copy(previous); const operations: BuildSourceOperation[] = [];
    const resultId = run(frame, command, context, operations);
    frame.builds.revision = checkedAdd(frame.builds.revision, 1);
    const result: BuildReceipt = { commandId: command.commandId, fingerprint, authority, revision: frame.builds.revision,
      operations: copy(operations), resultId };
    frame.builds.receipts.push(result);
    frame.builds.history.push({ authority, command: copy(command), sequencesBefore: copy(previous.sequences) });
    const finished = sealed(frame, context);
    return { ok: true, frame: finished, receipt: finished.builds.receipts[finished.builds.receipts.length - 1]!,
      operations: freeze(copy(operations)), replayed: false };
  } catch (error) {
    const code = error instanceof BuildV2Fault || error instanceof BuildFault ? error.code
      : error instanceof RangeError && stage === 'run' ? 'OVERFLOW' : stage === 'command' ? 'INVALID_COMMAND' : 'INVALID_STATE';
    return { ok: false, frame: previous, code, reasons: error instanceof BuildV2Fault || error instanceof BuildFault ? error.reasons : [] };
  }
}
export function applyBuildCommandV2(frame: BuildStateFrame, command: BuildCommand, context: BuildContentContext): BuildTransition {
  return apply(frame, command, context, false);
}
export function applyBuildAuthorityCommandV2(frame: BuildStateFrame, command: BuildAuthorityCommand, context: BuildContentContext): BuildTransition {
  return apply(frame, command, context, true);
}
export function isBuildAuthorityCommandV2(value: unknown, context: BuildContentContext): value is BuildAuthorityCommand {
  try { contextCheck(context); assertJson(value); return isCommand(value, true, context); } catch { return false; }
}
/** Replay an authenticated legacy prefix, upgrade once, then replay the current-rule suffix. */
export function validateBuildFrameV2(value: unknown, context: BuildContentContext): asserts value is BuildStateFrame {
  contextCheck(context);
  if (value && typeof value === 'object' && trusted.get(value) === contextKey(context)) return;
  assertJson(value);
  if (!exact(value, ['builds', 'sequences']) || !sequencesValid(value.sequences)
    || !exact(value.builds, ['schemaVersion', 'simulationVersion', 'rulesVersion', 'contentIdentity', 'rulesHash', 'origin',
      'contentMode', 'revision', 'migration', 'disciples', 'retiredDisciples', 'equipment', 'awards', 'receipts', 'history'])) fail('INVALID_STATE');
  const frame = value as unknown as BuildStateFrame; const state = frame.builds;
  if (state.schemaVersion !== 2 || state.simulationVersion !== 'permanent-builds-2' || state.rulesVersion !== 2
    || !same(state.contentIdentity, context.identity) || state.rulesHash !== stableHash(context.rules)
    || !Array.isArray(state.history) || state.history.length > context.rules.maximumCommands || state.revision !== state.history.length) fail('INVALID_STATE');
  let replay: BuildStateFrame;
  let prefixLength = 0;
  if (state.migration === null) replay = createBuildFrameV2(copy(state.origin), context);
  else {
    const boundary = state.migration;
    if (!exact(boundary, ['kind', 'identity', 'prefixLength', 'sourceStateHash', 'sequencesAtMigration']) || boundary.kind !== 'legacy-v1'
      || !same(boundary.identity, context.legacy.identity) || !integer(boundary.prefixLength, 0, state.history.length)
      || !sequencesValid(boundary.sequencesAtMigration) || !/^[0-9a-f]{8}$/.test(boundary.sourceStateHash)) fail('INVALID_STATE');
    prefixLength = boundary.prefixLength;
    const legacy = replayLegacyBuildHistoryV1(copy(state.origin), state.history.slice(0, prefixLength), copy(boundary.sequencesAtMigration), context.legacy.catalog);
    if (stableHash(legacy) !== boundary.sourceStateHash) fail('INVALID_STATE');
    replay = upgradeUnchecked(legacy, context);
  }
  for (const entry of state.history.slice(prefixLength)) {
    if (!exact(entry, ['authority', 'command', 'sequencesBefore']) || typeof entry.authority !== 'boolean'
      || !sequencesValid(entry.sequencesBefore) || !follows(entry.sequencesBefore, replay.sequences)) fail('INVALID_STATE');
    const before = { builds: replay.builds, sequences: copy(entry.sequencesBefore) };
    const result = apply(before, entry.command, context, entry.authority, true);
    if (!result.ok || result.replayed) fail('INVALID_STATE'); replay = result.frame;
  }
  if (!follows(frame.sequences, replay.sequences) || !same(state, replay.builds)) fail('INVALID_STATE');
}
export function getBuildProgressV2(frame: BuildStateFrame, discipleId: string, context: BuildContentContext): BuildProgress {
  validateBuildFrameV2(frame, context); return progress(frame, discipleId);
}
export function getBuildChoicesV2(frame: BuildStateFrame, discipleId: string, context: BuildContentContext): { skills: BuildChoice[]; treeNodes: BuildChoice[] } {
  validateBuildFrameV2(frame, context); const disciple = getDisciple(frame, discipleId);
  const choice = (definitionId: string, check: () => void): BuildChoice => {
    try { check(); return { definitionId, available: true, reasons: [] }; }
    catch (error) { return { definitionId, available: false, reasons: error instanceof BuildV2Fault ? [error.code, ...error.reasons] : ['INVALID_STATE'] }; }
  };
  return {
    skills: context.catalog.skills.filter(skill => skill.school === disciple.school).map(skill => choice(skill.id, () => {
      if (disciple.lock) fail('EXPEDITION_LOCKED'); supported(context, skill.id, frame.builds.contentMode);
      skillRequirements(context, disciple, skill.id);
      if (!disciple.learnedSkills.some(learned => learned.skillId === skill.id)
        && progress(frame, discipleId).availableLearningCredits < (skillLearningRule(context, skill.id)?.creditCost ?? Number.MAX_SAFE_INTEGER)) fail('INSUFFICIENT_LEARNING_CREDITS');
    })),
    treeNodes: context.catalog.treeNodes.filter(node => node.school === disciple.school).map(node => choice(node.id, () => {
      if (disciple.lock) fail('EXPEDITION_LOCKED'); allocationValid(frame, discipleId, [...new Set([...disciple.allocatedNodeIds, node.id])], context);
    })),
  };
}
export function buildCombatLoadoutV2(frame: BuildStateFrame, discipleId: string, context: BuildContentContext): BuildCombatLoadout {
  validateBuildFrameV2(frame, context); const disciple = getDisciple(frame, discipleId);
  allocationValid(frame, discipleId, disciple.allocatedNodeIds, context); loadoutValid(frame, discipleId, disciple.loadout, context);
  const stats: BuildCombatLoadout['stats'] = { attack: 12, maxHealth: 100, armor: 0 };
  let maximumSpirit = 100;
  for (const instanceId of Object.values(disciple.loadout.equipment)) {
    const item = frame.builds.equipment.find(entry => entry.instanceId === instanceId)!;
    const definition = equipmentDefinition(context, item.definitionId)!;
    for (const [stat, amount] of Object.entries(definition.flatStats)) {
      const key = stat as keyof typeof stats;
      (stats as Record<string, number>)[key] = checkedAdd(stats[key] ?? 0, amount);
    }
    maximumSpirit = checkedAdd(maximumSpirit, definition.maximumSpiritBonus);
  }
  return { basic: basicDefinition(context, disciple.school), activeSkillIds: [...disciple.loadout.activeSkillIds], passiveSkillId: disciple.loadout.passiveSkillId,
    characterSourceIds: [...disciple.allocatedNodeIds], equipment: copy(disciple.loadout.equipment), stats, maximumSpirit };
}
export function serializeBuildsV2(frame: BuildStateFrame, context: BuildContentContext): string {
  validateBuildFrameV2(frame, context);
  const text = canonicalStringify({ format: 'shanmen-builds', version: 2, frame, checksum: stableHash(frame) });
  if (text.length > 4_000_000) throw new RangeError('Build snapshot exceeds limit'); return text;
}
export function restoreBuildsV2(text: string, context: BuildContentContext): BuildStateFrame {
  if (typeof text !== 'string' || text.length > 4_000_000) throw new TypeError('Invalid build snapshot size');
  const parsed: unknown = JSON.parse(text); assertJson(parsed);
  if (!exact(parsed, ['format', 'version', 'frame', 'checksum']) || parsed.format !== 'shanmen-builds' || parsed.version !== 2
    || parsed.checksum !== stableHash(parsed.frame)) throw new TypeError('Invalid build snapshot envelope');
  validateBuildFrameV2(parsed.frame, context); return sealed(copy(parsed.frame), context);
}
