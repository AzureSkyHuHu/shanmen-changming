// Frozen v7 build-v1 protocol from commit 98e7026. Change only with an explicit legacy compatibility fix.
import type { School, TreeNodeDefinition } from '../../combat/definitions/types';
import { combatDefinitionSupport } from '../../combat/runtime/engine';
import { allocateId, createSequences } from '../../kernel/ids';
import type { SequenceState } from '../../kernel/ids';
import { checkedAdd } from '../../kernel/numeric';
import { canonicalStringify, compareStable, stableHash } from '../../kernel/serialization';
import { basicDefinition, basicId, BUILD_SCHOOLS, EQUIPMENT_SLOTS, equipmentDefinition, MAX_ALLOCATED_POINTS, MAX_BUILD_COMMANDS, MAX_BUILD_DISCIPLES, MAX_BUILD_EQUIPMENT, MILESTONE_RULE_IDS, skillLearningRule, STARTER_SKILLS } from './rules';
import { assertJson, BuildFault, copy, exact, fail, freeze, integer, unique, validId } from './shared';
import type { AnyBuildCommand, BuildAuthorityCommand, BuildCatalog, BuildChoice, BuildCombatLoadout, BuildCommand, BuildDisciple, BuildFrame, BuildLoadout, BuildProgress, BuildReceipt, BuildSource, BuildSourceOperation, BuildStateFrame, BuildTransition, CreateBuildOptions, EquipmentInstance } from './types';

const trusted = new WeakSet<object>();
const preparedCatalogs = new WeakSet<object>();
const same = (left: unknown, right: unknown): boolean => canonicalStringify(left) === canonicalStringify(right);
const sequenceKeys = ['nextEntity', 'nextEvent', 'nextAction', 'nextInstance'] as const;
function sequencesValid(value: unknown): value is SequenceState { return exact(value, sequenceKeys) && sequenceKeys.every(key => integer(value[key], 1)); }
function follows(next: SequenceState, prior: SequenceState): boolean { return sequenceKeys.every(key => next[key] >= prior[key]); }
function sealed(frame: BuildFrame): BuildStateFrame { const result = freeze(frame); trusted.add(result); return result; }
function catalogCheck(catalog: BuildCatalog): void {
  if (preparedCatalogs.has(catalog)) return;
  assertJson(catalog);
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.trees) || catalog.trees.length !== 4 || !Array.isArray(catalog.treeNodes) || catalog.treeNodes.length !== 36 || !Array.isArray(catalog.skills)) fail('INVALID_INPUT');
  const all = [...catalog.skills, ...catalog.trees, ...catalog.treeNodes, ...catalog.talents, ...catalog.statuses, ...catalog.summons, ...catalog.builds];
  if (!unique(all.map(item => item.id)) || all.some(item => !validId(item.id))) fail('INVALID_INPUT');
  for (const school of BUILD_SCHOOLS) {
    const tree = catalog.trees.find(item => item.id === `tree.${school}`);
    if (!tree || tree.kind !== 'tree' || tree.school !== school || tree.maximumPoints !== 5 || tree.nodeIds.length !== 9 || !unique(tree.nodeIds)) fail('INVALID_INPUT');
    const nodes = catalog.treeNodes.filter(node => node.treeId === tree.id);
    if (nodes.length !== 9 || nodes.some(node => !tree.nodeIds.includes(node.id) || node.pointCost !== 1 || node.kind !== 'treeNode' || node.school !== school)) fail('INVALID_INPUT');
    for (const branch of ['a', 'b', 'c']) for (const tier of [1, 2, 3]) {
      const matches = nodes.filter(node => node.branch === branch && node.tier === tier);
      if (matches.length !== 1) fail('INVALID_INPUT');
      const node = matches[0]!;
      const expected = nodes.filter(other => other.branch === branch && other.tier < tier).map(other => other.id).sort(compareStable);
      if (!same([...node.prerequisites].sort(compareStable), expected) || !unique(node.excludes) || node.excludes.some((id: string) => !tree.nodeIds.includes(id))) fail('INVALID_INPUT');
    }
    for (const id of STARTER_SKILLS[school]) {
      const skill = catalog.skills.find(item => item.id === id);
      if (!skill || skill.school !== school || !skillLearningRule(id)) fail('INVALID_INPUT');
    }
  }
  // Cache only deeply frozen caller catalogs; mutable input must be checked on every call.
  const frozen = (value: unknown): boolean => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(frozen));
  if (frozen(catalog)) preparedCatalogs.add(catalog);
}
function supported(catalog: BuildCatalog, definitionId: string, mode: 'verified' | 'experimental'): void {
  const support = combatDefinitionSupport(catalog, definitionId, mode);
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
function orderedNodes(ids: readonly string[], catalog: BuildCatalog): TreeNodeDefinition[] {
  return ids.map(id => { const node = catalog.treeNodes.find(item => item.id === id); if (!node) fail('UNKNOWN_DEFINITION'); return node; })
    .sort((left, right) => left.tier - right.tier || compareStable(left.id, right.id));
}
function allocationValid(frame: BuildStateFrame, discipleId: string, ids: readonly string[], catalog: BuildCatalog): void {
  const disciple = getDisciple(frame, discipleId);
  if (!Array.isArray(ids) || ids.some(id => !validId(id)) || !unique(ids)) fail('INVALID_ALLOCATION');
  if (ids.length > MAX_ALLOCATED_POINTS) fail('POINT_LIMIT');
  const nodes = orderedNodes(ids, catalog);
  if (nodes.some(node => node.treeId !== disciple.treeId || node.school !== disciple.school || node.pointCost !== 1 || node.excludes.some(id => ids.includes(id)))) fail('INVALID_ALLOCATION');
  if (nodes.some(node => node.prerequisites.some(id => !ids.includes(id)))) fail('MISSING_PREREQUISITE');
  if (ids.length > progress(frame, discipleId).earnedPoints) fail('INSUFFICIENT_POINTS');
  for (const node of nodes) supported(catalog, node.id, frame.builds.contentMode);
}
function skillRequirements(disciple: BuildStateFrame['builds']['disciples'][number], skillId: string, nodeIds: readonly string[] = disciple.allocatedNodeIds): void {
  const rule = skillLearningRule(skillId);
  if (!rule) fail('UNKNOWN_DEFINITION');
  if (rule.requiredSkillIds.some(id => !disciple.learnedSkills.some(skill => skill.skillId === id)) || rule.requiredNodeIds.some(id => !nodeIds.includes(id))) fail('MISSING_PREREQUISITE');
}
function loadoutShape(loadout: unknown): loadout is BuildLoadout {
  if (!exact(loadout, ['basicId', 'activeSkillIds', 'passiveSkillId', 'equipment']) || !validId(loadout.basicId) || !validId(loadout.passiveSkillId)
    || !Array.isArray(loadout.activeSkillIds) || loadout.activeSkillIds.length !== 2 || !loadout.activeSkillIds.every(validId) || !unique(loadout.activeSkillIds)
    || !exact(loadout.equipment, ['weaponId', 'robeId', 'artifactId']) || !Object.values(loadout.equipment).every(validId)) return false;
  return unique(Object.values(loadout.equipment));
}
function loadoutValid(frame: BuildStateFrame, discipleId: string, loadout: BuildStateFrame['builds']['disciples'][number]['loadout'], catalog: BuildCatalog, nodeIds?: readonly string[]): void {
  const disciple = getDisciple(frame, discipleId);
  if (!loadoutShape(loadout) || loadout.basicId !== basicId(disciple.school)) fail('INVALID_LOADOUT');
  for (const id of [...loadout.activeSkillIds, loadout.passiveSkillId]) {
    const skill = catalog.skills.find(item => item.id === id);
    if (!skill) fail('UNKNOWN_DEFINITION');
    if (skill.school !== disciple.school || skill.activation !== (id === loadout.passiveSkillId ? 'passive' : 'active') || !disciple.learnedSkills.some(item => item.skillId === id)) fail('INVALID_LOADOUT');
    skillRequirements(disciple, id, nodeIds);
    supported(catalog, id, frame.builds.contentMode);
  }
  for (const slot of EQUIPMENT_SLOTS) {
    const instanceId = loadout.equipment[`${slot}Id`];
    const item = frame.builds.equipment.find(entry => entry.instanceId === instanceId);
    if (!item || item.ownerDiscipleId !== discipleId) fail('ITEM_NOT_OWNED');
    const definition = equipmentDefinition(item.definitionId);
    if (!definition || definition.slot !== slot || (definition.school !== null && definition.school !== disciple.school)) fail('INVALID_LOADOUT');
    if (frame.builds.disciples.some(other => other.discipleId !== discipleId && Object.values(other.loadout.equipment).includes(instanceId))) fail('ITEM_ALREADY_EQUIPPED');
  }
}
function addLoadoutSources(frame: BuildFrame, disciple: BuildDisciple): BuildSource[] {
  const result = [...disciple.loadout.activeSkillIds, disciple.loadout.passiveSkillId].map(id => source(frame, disciple.discipleId, id, 'skill'));
  for (const slot of EQUIPMENT_SLOTS) {
    const itemId = disciple.loadout.equipment[`${slot}Id`];
    const item = frame.builds.equipment.find(entry => entry.instanceId === itemId)!;
    result.push(source(frame, disciple.discipleId, item.definitionId, 'equipment', itemId));
  }
  disciple.sources.push(...result); return result;
}
function lockHash(disciple: BuildStateFrame['builds']['disciples'][number]): string { return stableHash({ allocatedNodeIds: disciple.allocatedNodeIds, loadout: disciple.loadout, sources: disciple.sources }); }
function createUnchecked(options: CreateBuildOptions, catalog: BuildCatalog): BuildStateFrame {
  const origin = copy(options);
  origin.disciples.sort((a, b) => compareStable(a.discipleId, b.discipleId));
  origin.sequences = copy(origin.sequences ?? createSequences());
  const frame: BuildFrame = { builds: { schemaVersion: 1, simulationVersion: 'permanent-builds-1', rulesVersion: 1, contentHash: stableHash(catalog), origin,
    contentMode: origin.contentMode, revision: 0, disciples: [], equipment: [], awards: [], receipts: [], history: [] }, sequences: copy(origin.sequences) };
  for (const input of origin.disciples) {
    const starter = STARTER_SKILLS[input.school];
    const equipment = {} as BuildLoadout['equipment'];
    for (const slot of EQUIPMENT_SLOTS) {
      const instanceId = nextId(frame);
      const definitionId = slot === 'weapon' ? `equipment.training-${input.school}` : `equipment.training-${slot}`;
      frame.builds.equipment.push({ instanceId, definitionId, ownerDiscipleId: input.discipleId, acquisitionId: `starter/${input.discipleId}/${slot}` });
      equipment[`${slot}Id`] = instanceId;
    }
    const disciple: BuildDisciple = { discipleId: input.discipleId, school: input.school, treeId: `tree.${input.school}`, allocatedNodeIds: [],
      learnedSkills: starter.map(skillId => ({ skillId, origin: 'starter', creditCost: 0, acquisitionId: `starter/${input.discipleId}` })),
      loadout: { basicId: basicId(input.school), activeSkillIds: [starter[0], starter[1]], passiveSkillId: starter[2], equipment }, sources: [], lock: null };
    frame.builds.disciples.push(disciple);
    loadoutValid(frame, disciple.discipleId, disciple.loadout, catalog);
    addLoadoutSources(frame, disciple);
  }
  return sealed(frame);
}
export function createBuildFrame(options: CreateBuildOptions, catalog: BuildCatalog): BuildStateFrame {
  assertJson(options); catalogCheck(catalog);
  const keys = options && Object.keys(options).sort().join(',');
  if (keys !== 'contentMode,disciples' && keys !== 'contentMode,disciples,sequences') fail('INVALID_INPUT');
  if (!Array.isArray(options.disciples) || options.disciples.length > MAX_BUILD_DISCIPLES || !unique(options.disciples.map(item => item.discipleId))
    || options.disciples.some(item => !exact(item, ['discipleId', 'school']) || !validId(item.discipleId) || !BUILD_SCHOOLS.includes(item.school))
    || !['verified', 'experimental'].includes(options.contentMode) || (options.sequences !== undefined && !sequencesValid(options.sequences))) fail('INVALID_INPUT');
  return createUnchecked(options, catalog);
}
function isCommand(value: unknown, authority: boolean): value is AnyBuildCommand {
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
  if (command.kind === 'milestone.award') return exact(command, [...common, 'discipleId', 'milestoneId', 'ruleId']) && validId(command.discipleId) && validId(command.milestoneId) && MILESTONE_RULE_IDS.includes(command.ruleId);
  if (command.kind === 'equipment.grant') return exact(command, [...common, 'discipleId', 'acquisitionId', 'definitionId']) && validId(command.discipleId) && validId(command.acquisitionId) && validId(command.definitionId);
  if (command.kind === 'expedition.lock' || command.kind === 'expedition.unlock') return exact(command, [...common, 'runId', 'locks']) && validId(command.runId)
    && Array.isArray(command.locks) && command.locks.length > 0 && command.locks.length <= MAX_BUILD_DISCIPLES && unique(command.locks.map(item => item?.discipleId)) && unique(command.locks.map(item => item?.lockId))
    && command.locks.every(item => exact(item, ['discipleId', 'lockId']) && validId(item.discipleId) && validId(item.lockId));
  return false;
}
export function isBuildCommand(value: unknown): value is BuildCommand { try { assertJson(value); return isCommand(value, false); } catch { return false; } }
export function isBuildAuthorityCommand(value: unknown): value is BuildAuthorityCommand { try { assertJson(value); return isCommand(value, true); } catch { return false; } }
function run(frame: BuildFrame, command: AnyBuildCommand, catalog: BuildCatalog, operations: BuildSourceOperation[]): string | null {
  if (command.kind === 'expedition.lock' || command.kind === 'expedition.unlock') {
    for (const entry of [...command.locks].sort((a, b) => compareStable(a.discipleId, b.discipleId))) {
      const disciple = mutableDisciple(frame, entry.discipleId);
      if (command.kind === 'expedition.lock') {
        if (disciple.lock) fail('EXPEDITION_LOCKED');
        if (frame.builds.disciples.some(other => other.lock?.lockId === entry.lockId)) fail('LOCK_MISMATCH');
        loadoutValid(frame, disciple.discipleId, disciple.loadout, catalog);
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
    if (progress(frame, command.discipleId).earnedPoints >= MAX_ALLOCATED_POINTS) fail('POINT_LIMIT');
    frame.builds.awards.push(award); return command.milestoneId;
  }
  if (command.kind === 'equipment.grant') {
    const definition = equipmentDefinition(command.definitionId);
    if (!definition) fail('UNKNOWN_DEFINITION');
    const previous = frame.builds.equipment.find(item => item.acquisitionId === command.acquisitionId);
    if (previous) {
      if (previous.definitionId !== command.definitionId || previous.ownerDiscipleId !== command.discipleId) fail('ACQUISITION_CONFLICT');
      return previous.instanceId;
    }
    if (frame.builds.equipment.length >= MAX_BUILD_EQUIPMENT) fail('COMMAND_LIMIT');
    const item: EquipmentInstance = { instanceId: nextId(frame), definitionId: command.definitionId, ownerDiscipleId: command.discipleId, acquisitionId: command.acquisitionId };
    frame.builds.equipment.push(item); return item.instanceId;
  }
  if (disciple.lock) fail('EXPEDITION_LOCKED');
  if (command.kind === 'skill.learn') {
    const skill = catalog.skills.find(item => item.id === command.skillId);
    const rule = skillLearningRule(command.skillId);
    if (!skill || !rule) fail('UNKNOWN_DEFINITION');
    if (disciple.learnedSkills.some(item => item.skillId === command.skillId)) fail('ALREADY_LEARNED');
    skillRequirements(disciple, command.skillId);
    supported(catalog, command.skillId, frame.builds.contentMode);
    if (progress(frame, command.discipleId).availableLearningCredits < rule.creditCost) fail('INSUFFICIENT_LEARNING_CREDITS');
    disciple.learnedSkills.push({ skillId: command.skillId, origin: 'study', creditCost: rule.creditCost, acquisitionId: command.commandId });
    return command.skillId;
  }
  if (command.kind === 'tree.respec') {
    allocationValid(frame, command.discipleId, command.nodeIds, catalog);
    loadoutValid(frame, command.discipleId, disciple.loadout, catalog, command.nodeIds);
    const nodes = orderedNodes(command.nodeIds, catalog);
    if (same(disciple.allocatedNodeIds, nodes.map(node => node.id))) return null;
    const oldNodes = orderedNodes(disciple.allocatedNodeIds, catalog).reverse();
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
  loadoutValid(frame, command.discipleId, command.loadout, catalog);
  if (same(disciple.loadout, command.loadout)) return null;
  const previous = disciple.sources.filter(item => item.kind !== 'treeNode').sort((a, b) => b.createdSequence - a.createdSequence);
  operations.push(...previous.map(item => ({ kind: 'source.remove' as const, source: copy(item) })));
  disciple.sources = disciple.sources.filter(item => item.kind === 'treeNode');
  disciple.loadout = copy(command.loadout);
  operations.push(...addLoadoutSources(frame, disciple).map(item => ({ kind: 'source.install' as const, source: copy(item) })));
  return null;
}
function apply(previous: BuildStateFrame, command: unknown, catalog: BuildCatalog, authority: boolean, skipValidation = false): BuildTransition {
  let stage: 'state' | 'command' | 'run' = 'state';
  try {
    catalogCheck(catalog);
    if (!skipValidation) validateBuildFrame(previous, catalog);
    if (previous.builds.contentHash !== stableHash(catalog)) fail('CONTENT_MISMATCH');
    stage = 'command'; assertJson(command);
    if (!isCommand(command, authority)) fail('INVALID_COMMAND');
    const fingerprint = canonicalStringify({ command, authority });
    const receipt = previous.builds.receipts.find(item => item.commandId === command.commandId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail('COMMAND_CONFLICT');
      return { ok: true, frame: previous, receipt, operations: [], replayed: true };
    }
    if (command.expectedRevision !== previous.builds.revision) fail('REVISION_CONFLICT');
    if (previous.builds.history.length >= MAX_BUILD_COMMANDS) fail('COMMAND_LIMIT');
    stage = 'run';
    const frame = copy(previous); const operations: BuildSourceOperation[] = [];
    const resultId = run(frame, command, catalog, operations);
    frame.builds.revision = checkedAdd(frame.builds.revision, 1);
    const result: BuildReceipt = { commandId: command.commandId, fingerprint, authority, revision: frame.builds.revision, operations: copy(operations), resultId };
    frame.builds.receipts.push(result);
    frame.builds.history.push({ authority, command: copy(command), sequencesBefore: copy(previous.sequences) });
    const finished = sealed(frame);
    return { ok: true, frame: finished, receipt: finished.builds.receipts[finished.builds.receipts.length - 1]!, operations: freeze(copy(operations)), replayed: false };
  } catch (error) {
    const code = error instanceof BuildFault ? error.code : error instanceof RangeError && stage === 'run' ? 'OVERFLOW' : stage === 'command' ? 'INVALID_COMMAND' : 'INVALID_STATE';
    return { ok: false, frame: previous, code, reasons: error instanceof BuildFault ? error.reasons : [] };
  }
}
export function applyBuildCommand(frame: BuildStateFrame, command: BuildCommand, catalog: BuildCatalog): BuildTransition { return apply(frame, command, catalog, false); }
export function applyBuildAuthorityCommand(frame: BuildStateFrame, command: BuildAuthorityCommand, catalog: BuildCatalog): BuildTransition { return apply(frame, command, catalog, true); }
/** V2 boundary helper: the unchanged v1 reducer replays each prefix entry once. */
export function replayLegacyBuildHistoryV1(options: CreateBuildOptions, history: unknown, sequences: SequenceState, catalog: BuildCatalog): BuildStateFrame {
  assertJson(history);
  if (!Array.isArray(history) || history.length > MAX_BUILD_COMMANDS || !sequencesValid(sequences)) fail('INVALID_STATE');
  let replay = createBuildFrame(copy(options), catalog);
  for (const entry of history) {
    if (!exact(entry, ['authority', 'command', 'sequencesBefore']) || typeof entry.authority !== 'boolean'
      || !sequencesValid(entry.sequencesBefore) || !follows(entry.sequencesBefore, replay.sequences)) fail('INVALID_STATE');
    const result = apply({ builds: replay.builds, sequences: copy(entry.sequencesBefore) }, entry.command, catalog, entry.authority, true);
    if (!result.ok || result.replayed) fail('INVALID_STATE'); replay = result.frame;
  }
  if (!follows(sequences, replay.sequences)) fail('INVALID_STATE');
  return sealed({ builds: copy(replay.builds), sequences: copy(sequences) });
}
/** Validate semantic history, ownership, dependencies, receipts, sources and every exact saved field. */
export function validateBuildFrame(value: unknown, catalog: BuildCatalog): asserts value is BuildStateFrame {
  catalogCheck(catalog);
  if (value && typeof value === 'object' && trusted.has(value)) {
    if ((value as BuildStateFrame).builds.contentHash !== stableHash(catalog)) fail('CONTENT_MISMATCH'); return;
  }
  assertJson(value);
  if (!exact(value, ['builds', 'sequences']) || !sequencesValid(value.sequences) || !exact(value.builds, ['schemaVersion', 'simulationVersion', 'rulesVersion', 'contentHash', 'origin', 'contentMode', 'revision', 'disciples', 'equipment', 'awards', 'receipts', 'history'])) fail('INVALID_STATE');
  const frame = value as unknown as BuildStateFrame;
  const state = frame.builds;
  if (state.schemaVersion !== 1 || state.simulationVersion !== 'permanent-builds-1' || state.rulesVersion !== 1 || !Array.isArray(state.history) || state.history.length > MAX_BUILD_COMMANDS || state.revision !== state.history.length) fail('INVALID_STATE');
  if (state.contentHash !== stableHash(catalog)) fail('CONTENT_MISMATCH');
  let replay = createBuildFrame(copy(state.origin), catalog);
  for (const entry of state.history) {
    if (!exact(entry, ['authority', 'command', 'sequencesBefore']) || typeof entry.authority !== 'boolean' || !sequencesValid(entry.sequencesBefore) || !follows(entry.sequencesBefore, replay.sequences)) fail('INVALID_STATE');
    const before = { builds: replay.builds, sequences: copy(entry.sequencesBefore) };
    const result = apply(before, entry.command, catalog, entry.authority, true);
    if (!result.ok || result.replayed) fail('INVALID_STATE');
    replay = result.frame;
  }
  if (!follows(frame.sequences, replay.sequences) || !same(state, replay.builds)) fail('INVALID_STATE');
  // Never cache or freeze caller-owned mutable input. All transitions clone it before changes.
}
export function getBuildProgress(frame: BuildStateFrame, discipleId: string, catalog: BuildCatalog): BuildProgress { validateBuildFrame(frame, catalog); return progress(frame, discipleId); }
export function getBuildChoices(frame: BuildStateFrame, discipleId: string, catalog: BuildCatalog): { skills: BuildChoice[]; treeNodes: BuildChoice[] } {
  validateBuildFrame(frame, catalog); const disciple = getDisciple(frame, discipleId);
  const choice = (definitionId: string, check: () => void): BuildChoice => {
    try { check(); return { definitionId, available: true, reasons: [] }; }
    catch (error) { return { definitionId, available: false, reasons: error instanceof BuildFault ? [error.code, ...error.reasons] : ['INVALID_STATE'] }; }
  };
  return {
    skills: catalog.skills.map(skill => choice(skill.id, () => {
      if (disciple.lock) fail('EXPEDITION_LOCKED'); supported(catalog, skill.id, frame.builds.contentMode);
      skillRequirements(disciple, skill.id);
      if (!disciple.learnedSkills.some(learned => learned.skillId === skill.id) && progress(frame, discipleId).availableLearningCredits < (skillLearningRule(skill.id)?.creditCost ?? Number.MAX_SAFE_INTEGER)) fail('INSUFFICIENT_LEARNING_CREDITS');
    })),
    treeNodes: catalog.treeNodes.filter(node => node.school === disciple.school).map(node => choice(node.id, () => {
      if (disciple.lock) fail('EXPEDITION_LOCKED');
      allocationValid(frame, discipleId, [...new Set([...disciple.allocatedNodeIds, node.id])], catalog);
    })),
  };
}
/** Returned values are owned copies. Equipment bonuses are applied once; tree/passive mechanics stay runtime-owned. */
export function buildCombatLoadout(frame: BuildStateFrame, discipleId: string, catalog: BuildCatalog): BuildCombatLoadout {
  validateBuildFrame(frame, catalog); const disciple = getDisciple(frame, discipleId);
  allocationValid(frame, discipleId, disciple.allocatedNodeIds, catalog); loadoutValid(frame, discipleId, disciple.loadout, catalog);
  const stats: BuildCombatLoadout['stats'] = { attack: 12, maxHealth: 100, armor: 0 };
  let maximumSpirit = 100;
  for (const instanceId of Object.values(disciple.loadout.equipment)) {
    const item = frame.builds.equipment.find(entry => entry.instanceId === instanceId)!;
    const definition = equipmentDefinition(item.definitionId)!;
    for (const [stat, amount] of Object.entries(definition.flatStats)) {
      const key = stat as keyof typeof stats;
      (stats as Record<string, number>)[key] = checkedAdd(stats[key] ?? 0, amount);
    }
    maximumSpirit = checkedAdd(maximumSpirit, definition.maximumSpiritBonus);
  }
  return { basic: basicDefinition(disciple.school), activeSkillIds: [...disciple.loadout.activeSkillIds], passiveSkillId: disciple.loadout.passiveSkillId,
    characterSourceIds: [...disciple.allocatedNodeIds], equipment: copy(disciple.loadout.equipment), stats, maximumSpirit };
}
