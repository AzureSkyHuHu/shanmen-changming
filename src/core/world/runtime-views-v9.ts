/** Internal fixed projections over the runtime's already owned root. No function
 * here grants source authority or escapes a World/frame/proof to the caller. */
import { getSectBuildingDefinition } from '../../content/sect-v9/catalog';
import { SECT_RESOURCE_IDS } from '../../content/sect-v9/types';
import { managementV9BuildContext } from '../../content/sect-v9/world-content';
import { REALM_RULES } from '../cultivation/rules';
import { previewBreakthroughV3 } from '../cultivation/v3';
import type { BreakthroughPreview } from '../cultivation/types';
import { lookupLiveProduction } from '../economy/automatic-production';
import { RESOURCE_IDS } from '../economy/types';
import { restoreHistoryArchive } from '../history';
import { CALENDAR_TICKS_PER_MONTH } from '../kernel/clock';
import { compareStable, stableHash } from '../kernel/serialization';
import { previewValidatedConstructionPlacement } from '../sect-expansion/construction-runtime';
import { deriveSectFootprint, ownSectFields } from '../sect-expansion/layout';
import { sectMaintenanceStatusFromRecords } from '../sect-expansion/maintenance-periods';
import type { SectPlacementRequest } from '../sect-expansion/types';
import { cultivationFrameOf } from './cultivation-preparation';
import { lookupCommandReceipt, lookupProduction, recentWorldEvents } from './history-access';
import { projectV9SectFrame, v9SectContext, v9WorkerAvailable, v9WorkOwners } from './v9-sect-bridge';
import type { WorldStateV9 } from './v9-types';
import { RUNTIME_VIEW_LIMITS_V9 as LIMITS } from './runtime-view-types-v9';
import type { RuntimeApplicationCommandV9, RuntimeBreakthroughPreviewV9, RuntimeBreakthroughRequestV9, RuntimeBuildViewV9,
  RuntimeClockControlV9, RuntimeCultivationViewV9, RuntimeExpansionJobV9, RuntimeExpansionTerminalV9, RuntimeExpansionViewV9,
  RuntimeFrameViewV9, RuntimePlacementPreviewV9, RuntimeSelectedCultivationV9 } from './runtime-view-types-v9';

function bounded(length: number, maximum: number): void {
  if (length > maximum) throw new RangeError('Private v9 view exceeds its fixed presentation bound');
}
export const validRuntimeDiscipleQueryV9 = (value: unknown): value is string | null => value === null
  || typeof value === 'string' && value.length <= 128 && /^entity:[1-9][0-9]*$/.test(value);
export function validRuntimeBreakthroughQueryV9(value: unknown): value is RuntimeBreakthroughRequestV9 {
  return ownSectFields(value, ['discipleId', 'preparation']) && value.discipleId !== null && validRuntimeDiscipleQueryV9(value.discipleId)
    && ownSectFields(value.preparation, ['method', 'arraySupport'])
    && (value.preparation.method === 'standard' || value.preparation.method === 'forced')
    && (value.preparation.arraySupport === 0 || value.preparation.arraySupport === 1 || value.preparation.arraySupport === 2);
}
export function validRuntimePlacementQueryV9(value: unknown): value is SectPlacementRequest {
  return deriveSectFootprint(value).ok;
}
export function validRuntimeClockControlV9(value: unknown): value is RuntimeClockControlV9 {
  return ownSectFields(value, ['kind', 'speed']) && value.kind === 'speed' && (value.speed === 1 || value.speed === 3)
    || ownSectFields(value, ['kind', 'reason', 'paused']) && value.kind === 'pause'
      && (value.reason === 'player' || value.reason === 'hidden') && typeof value.paused === 'boolean';
}

/** Fixed fields, including nested records: valid retained extension data does not
 * silently turn a tiny inspector into a history export. */
function breakthroughView(value: BreakthroughPreview): BreakthroughPreview {
  bounded(value.costs.length, 6); bounded(value.factors.length, 8); bounded(value.blockers.length, 6); bounded(value.warnings.length, 5);
  return { phase: value.phase, rulesVersion: value.rulesVersion, stateRevision: value.stateRevision, basisHash: value.basisHash,
    discipleId: value.discipleId, targetRealm: value.targetRealm,
    preparation: { method: value.preparation.method, arraySupport: value.preparation.arraySupport },
    costs: value.costs.map(row => ({ resourceId: row.resourceId, quantity: row.quantity })), seclusionMonths: value.seclusionMonths,
    monthlyMealCost: value.monthlyMealCost, remainingLifespanMonths: value.remainingLifespanMonths, successBps: value.successBps,
    failureDeathBps: value.failureDeathBps, overallDeathBps: value.overallDeathBps,
    factors: value.factors.map(row => ({ key: row.key, contributionBps: row.contributionBps })),
    blockers: [...value.blockers], warnings: [...value.warnings] };
}
export function projectRuntimeFrameV9(world: WorldStateV9): RuntimeFrameViewV9 {
  bounded(world.disciples.length, LIMITS.livePeople); bounded(world.buildings.length, LIMITS.objects); bounded(world.map.tiles.length, LIMITS.mapTiles);
  bounded(world.sectEconomy.plans.length, LIMITS.workPlans);
  for (const plan of world.sectEconomy.plans) bounded(plan.priorities.length, LIMITS.workPriorities);
  const events = recentWorldEvents(world, LIMITS.recentEvents).reverse();
  const ids = new Set(world.activeProductionTransactionIds);
  for (const event of events) if (typeof event.payload.transactionId === 'string') ids.add(event.payload.transactionId);
  bounded(ids.size, LIMITS.activeJobs + LIMITS.recentEvents);
  const elapsed = Math.floor(world.clock.calendarTick / CALENDAR_TICKS_PER_MONTH);
  return {
    seed: world.seed, simulationVersion: world.simulationVersion, contentVersion: world.contentVersion,
    contentIdentity: { registryId: world.contentIdentity.registryId, compositeFingerprint: world.contentIdentity.compositeFingerprint,
      combatFingerprint: world.contentIdentity.combatFingerprint, buildRulesVersion: world.contentIdentity.buildRulesVersion },
    clock: { simulationTick: world.clock.simulationTick, calendarTick: world.clock.calendarTick, encounterTick: world.clock.encounterTick,
      mode: world.clock.mode, speed: world.clock.speed, pauseReasons: [...world.clock.pauseReasons] },
    calendar: { year: Math.floor(elapsed / 12) + 1, month: elapsed % 12 + 1, progress: world.clock.calendarTick % CALENDAR_TICKS_PER_MONTH / CALENDAR_TICKS_PER_MONTH },
    map: { width: world.map.width, height: world.map.height, seed: world.map.seed, generationVersion: world.map.generationVersion,
      navVersion: world.map.navVersion, tiles: world.map.tiles.map(tile => ({ x: tile.x, y: tile.y, terrain: tile.terrain, walkable: tile.walkable })) },
    disciples: world.disciples.map(actor => ({ id: actor.id, nameKey: actor.nameKey, ageMonths: actor.ageMonths, birthCalendarTick: actor.birthCalendarTick,
      position: { x: actor.position.x, y: actor.position.y }, lifeState: actor.lifeState, canWork: actor.canWork, traveling: actor.traveling,
      assignmentTransactionId: actor.assignmentTransactionId, aptitude: actor.aptitude, presentationId: actor.presentationId })),
    buildings: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, nameKey: site.nameKey, x: site.x, y: site.y,
      operational: site.operational, stationTransactionId: site.stationTransactionId })),
    resources: RESOURCE_IDS.map(resourceId => { const row = world.inventory[resourceId]; return { resourceId, owned: row.owned, reserved: row.reserved, capacity: row.capacity, available: row.owned - row.reserved }; }),
    transactions: [...ids].flatMap(id => { const job = lookupLiveProduction(world, id)?.transaction ?? lookupProduction(world, id);
      return job ? [{ transactionId: job.transactionId, recipeId: job.recipeId, workerId: job.workerId, state: job.state,
        activeTicks: job.activeTicks, requiredTicks: job.requiredTicks, phase: job.phase, blockedReason: job.blockedReason }] : []; }),
    recentEvents: events.map(event => ({ eventId: event.eventId, kind: event.kind, tick: event.tick,
      transactionId: typeof event.payload.transactionId === 'string' ? event.payload.transactionId : null,
      workerId: typeof event.payload.workerId === 'string' ? event.payload.workerId : null,
      recipeId: typeof event.payload.recipeId === 'string' ? event.payload.recipeId : null,
      reason: typeof event.payload.reason === 'string' ? event.payload.reason : null,
      discipleId: typeof event.payload.discipleId === 'string' ? event.payload.discipleId : null,
      resourceId: RESOURCE_IDS.find(id => id === event.payload.resourceId) ?? null,
      quantity: typeof event.payload.quantity === 'number' ? event.payload.quantity : null })),
    sectEconomy: { schemaVersion: world.sectEconomy.schemaVersion, enabled: world.sectEconomy.enabled, nextDecisionTick: world.sectEconomy.nextDecisionTick,
      plans: world.sectEconomy.plans.map(plan => ({ workerId: plan.workerId, enabled: plan.enabled,
        priorities: plan.priorities.map(priority => ({ recipeId: priority.recipeId, targetStock: priority.targetStock })) })) },
  };
}
export function projectRuntimeCultivationV9(world: WorldStateV9, discipleId: string | null): RuntimeCultivationViewV9 {
  const state = world.cultivation; const owners = v9WorkOwners(world);
  bounded(state.disciples.length, LIMITS.livePeople); bounded(owners.length, LIMITS.activeJobs);
  bounded(state.pendingDeaths.length, LIMITS.livePeople);
  const receiving = new Map(state.disciples.filter(profile => profile.teaching).map(profile => [profile.teaching!.studentId, profile]));
  const profile = state.disciples.find(profile => profile.discipleId === discipleId);
  const ownerFor = (id: string) => owners.find(owner => owner.workerId === id) ?? null;
  let selected: RuntimeSelectedCultivationV9 | null = null;
  if (profile) {
    const attempt = state.attempts.find(row => row.attemptId === profile.activeAttemptId);
    const pending = state.pendingDeaths.find(row => row.deathId === profile.pendingDeathId);
    const death = state.deaths.find(row => row.deathId === profile.deathId);
    const latest = state.attempts.findLast(row => row.discipleId === profile.discipleId && row.outcome !== null);
    const teacher = receiving.get(profile.discipleId); const workOwner = ownerFor(profile.discipleId);
    const free = (id: string) => !ownerFor(id) && !world.disciples.find(actor => actor.id === id)?.traveling
      && !world.builds.disciples.find(row => row.discipleId === id)?.lock;
    const canTeach = profile.lifeState === 'alive' && !profile.activityOwner && !profile.activeAttemptId && !profile.teaching && !teacher && free(profile.discipleId);
    const students = canTeach ? state.disciples.filter(row => row.discipleId !== profile.discipleId && row.lifeState === 'alive'
      && !row.activityOwner && !row.activeAttemptId && !row.teaching && !receiving.has(row.discipleId) && free(row.discipleId)) : [];
    const choices: RuntimeSelectedCultivationV9['teachingChoices'] = []; let totalTeachableKnowledge = 0;
    if (canTeach) for (const knowledge of profile.knowledge) {
      const studentIds = students.filter(row => !row.knowledge.some(known => known.knowledgeId === knowledge.knowledgeId)).map(row => row.discipleId);
      if (studentIds.length) { totalTeachableKnowledge++; if (choices.length < LIMITS.teachingChoices) choices.push({ knowledgeId: knowledge.knowledgeId, studentIds }); }
    }
    selected = { discipleId: profile.discipleId, realm: profile.realm, cultivation: profile.cultivation, understanding: profile.understanding,
      foundation: profile.foundation, mindset: profile.mindset, injury: profile.injury, lifeState: profile.lifeState, trainingMode: profile.trainingMode,
      heirId: profile.heirId, requiredCultivation: REALM_RULES[profile.realm].cultivationRequired,
      remainingLifespanMonths: Math.max(0, profile.lifespanMonths - profile.ageMonths), relicCount: profile.relicIds.length,
      activityLocked: profile.activityOwner !== null || workOwner !== null, workOwner, workerAvailable: v9WorkerAvailable(world, profile.discipleId),
      activeAttempt: attempt ? { attemptId: attempt.attemptId, phase: attempt.phase, preview: breakthroughView(attempt.preview), completedMonths: attempt.completedMonths,
        blockedMonths: attempt.blockedMonths, blockedReason: attempt.blockedReason, outcome: attempt.outcome } : null,
      pendingDeath: pending ? { deathId: pending.deathId, cause: pending.cause, month: pending.month } : null,
      deathRecord: death ? { cause: death.cause, month: death.month, beneficiaryId: death.beneficiaryId, transferredRelicCount: death.transferredRelicIds.length } : null,
      lastOutcome: latest?.outcome ?? null, heirChoices: state.disciples.filter(row => row.discipleId !== profile.discipleId && row.lifeState === 'alive').map(row => row.discipleId),
      teaching: profile.teaching ? { teachingId: profile.teaching.teachingId, studentId: profile.teaching.studentId, knowledgeId: profile.teaching.knowledgeId,
        completedMonths: profile.teaching.completedMonths, requiredMonths: profile.teaching.requiredMonths } : null,
      learning: teacher?.teaching ? { teacherId: teacher.discipleId, knowledgeId: teacher.teaching.knowledgeId,
        completedMonths: teacher.teaching.completedMonths, requiredMonths: teacher.teaching.requiredMonths } : null,
      teachingChoices: choices, totalTeachableKnowledge };
  }
  return { revision: state.revision, resourceStamp: stableHash(world.inventory), selected,
    summaries: state.disciples.map(row => ({ discipleId: row.discipleId, realm: row.realm, lifeState: row.lifeState, trainingMode: row.trainingMode,
      activeAttemptId: row.activeAttemptId, teaching: row.teaching !== null, learning: receiving.has(row.discipleId), away: row.activityOwner !== null,
      workOwner: ownerFor(row.discipleId), workerAvailable: v9WorkerAvailable(world, row.discipleId) })),
    decisions: [...state.pendingDeaths.map(row => ({ discipleId: row.discipleId, kind: 'death' as const })),
      ...state.disciples.filter(row => row.activeAttemptId && state.attempts.some(attempt => attempt.attemptId === row.activeAttemptId && attempt.phase === 'DecisionReady'))
        .map(row => ({ discipleId: row.discipleId, kind: 'breakthrough' as const }))] };
}
export function projectRuntimeBuildV9(world: WorldStateV9, discipleId: string | null): RuntimeBuildViewV9 {
  const content = managementV9BuildContext(world.contentIdentity); const build = world.builds.disciples.find(row => row.discipleId === discipleId);
  const profile = world.cultivation.disciples.find(row => row.discipleId === discipleId);
  const identity = content.identity;
  const result: RuntimeBuildViewV9 = { revision: world.builds.revision, contentIdentity: { registryId: identity.registryId,
    compositeFingerprint: identity.compositeFingerprint, combatFingerprint: identity.combatFingerprint, buildRulesVersion: identity.buildRulesVersion }, selected: null };
  if (!build || !profile) return result;
  bounded(build.allocatedNodeIds.length, content.rules.maximumAllocatedPoints); bounded(build.learnedSkills.length, content.catalog.skills.length);
  const awards = world.builds.awards.filter(row => row.discipleId === discipleId);
  const earnedPoints = awards.reduce((sum, row) => sum + row.treePoints, 0);
  const earnedLearningCredits = awards.reduce((sum, row) => sum + row.learningCredits, 0);
  const spentLearningCredits = build.learnedSkills.reduce((sum, row) => sum + row.creditCost, 0);
  const equipment = world.builds.equipment.filter(row => row.owner.kind === 'disciple' && row.owner.discipleId === discipleId)
    .map(row => ({ instanceId: row.instanceId, definitionId: row.definitionId })); bounded(equipment.length, LIMITS.equipmentChoices);
  result.selected = { discipleId: build.discipleId, school: build.school, treeId: build.treeId, lifeState: profile.lifeState,
    locked: build.lock !== null || world.sectExpansion.care.jobs.some(job => job.patientId === discipleId && !job.terminal),
    allocatedNodeIds: [...build.allocatedNodeIds], learnedSkillIds: build.learnedSkills.map(row => row.skillId),
    loadout: { basicId: build.loadout.basicId, activeSkillIds: [build.loadout.activeSkillIds[0], build.loadout.activeSkillIds[1]],
      passiveSkillId: build.loadout.passiveSkillId, equipment: { weaponId: build.loadout.equipment.weaponId,
        robeId: build.loadout.equipment.robeId, artifactId: build.loadout.equipment.artifactId } },
    progress: { earnedPoints, allocatedPoints: build.allocatedNodeIds.length, availablePoints: earnedPoints - build.allocatedNodeIds.length,
      earnedLearningCredits, spentLearningCredits, availableLearningCredits: earnedLearningCredits - spentLearningCredits }, equipment };
  return result;
}
function footprint(request: SectPlacementRequest) {
  const geometry = deriveSectFootprint({ definitionId: request.definitionId, anchor: { x: request.anchor.x, y: request.anchor.y }, rotation: request.rotation });
  if (!geometry.ok) throw new TypeError('Owned placement lost its geometry'); return geometry.footprint;
}
export function projectRuntimeExpansionV9(world: WorldStateV9): RuntimeExpansionViewV9 {
  const records = world.sectExpansion; const frame = projectV9SectFrame(world); const owners = v9WorkOwners(world);
  bounded(owners.length, LIMITS.activeJobs); bounded(records.construction.buildings.length + world.buildings.length, LIMITS.objects);
  bounded(records.construction.blueprints.filter(row => row.status === 'planned').length, LIMITS.plannedBlueprints);
  const completedResearch = records.research.jobs.filter(job => job.terminal?.kind === 'completed').map(job => ({ researchId: job.researchId, completionJobId: job.jobId }));
  bounded(completedResearch.length, LIMITS.completedResearch);
  const blueprints = records.construction.blueprints.filter(row => row.status === 'planned' || row.status === 'started').map(row => ({
    blueprintId: row.blueprintId, definitionId: row.definitionId, anchor: { x: row.anchor.x, y: row.anchor.y }, rotation: row.rotation,
    status: row.status as 'planned' | 'started', jobId: row.jobId, footprint: footprint(row) })); bounded(blueprints.length, LIMITS.visibleBlueprints);
  const jobs: RuntimeExpansionJobV9[] = [
    ...records.construction.jobs.filter(job => !job.terminal).map(job => { const bp = records.construction.blueprints.find(row => row.blueprintId === job.blueprintId)!;
      return { domain: 'construction' as const, jobId: job.jobId, blueprintId: job.blueprintId, workerId: job.workerId, phase: job.phase,
        activeTicks: job.activeTicks, requiredTicks: getSectBuildingDefinition(bp.definitionId)!.levels[0]!.workTicks, blocked: job.blocked }; }),
    ...records.production.jobs.filter(job => !job.terminal).map(job => ({ domain: 'production' as const, jobId: job.transactionId,
      recipeId: job.recipeId, workerId: job.workerId, phase: job.phase, activeTicks: job.activeTicks, requiredTicks: job.requiredTicks, blocked: job.blockedReason })),
    ...records.research.jobs.filter(job => !job.terminal).map(job => ({ domain: 'research' as const, jobId: job.jobId, researchId: job.researchId,
      workerId: job.workerId, phase: job.phase, activeTicks: job.activeTicks, requiredTicks: job.requiredTicks, blocked: job.blocked })),
    ...records.care.jobs.filter(job => !job.terminal).map(job => ({ domain: 'care' as const, jobId: job.jobId, patientId: job.patientId,
      phase: job.phase, activeTicks: job.activeTicks, requiredTicks: 40 as const, blocked: job.blocked })),
  ]; bounded(jobs.length, LIMITS.activeJobs);
  const terminals: RuntimeExpansionTerminalV9[] = [
    ...records.construction.jobs.flatMap(job => job.terminal ? [{ domain: 'construction' as const, jobId: job.jobId, actorId: job.workerId,
      kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: null, afterInjury: null }] : []),
    ...records.production.jobs.flatMap(job => job.terminal ? [{ domain: 'production' as const, jobId: job.transactionId, actorId: job.workerId,
      kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: null, afterInjury: null }] : []),
    ...records.research.jobs.flatMap(job => job.terminal ? [{ domain: 'research' as const, jobId: job.jobId, actorId: job.workerId,
      kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: null, afterInjury: null }] : []),
    ...records.care.jobs.flatMap(job => job.terminal ? [{ domain: 'care' as const, jobId: job.jobId, actorId: job.patientId,
      kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: job.terminal.effect?.beforeInjury ?? null, afterInjury: job.terminal.effect?.afterInjury ?? null }] : []),
  ];
  terminals.sort((a, b) => b.tick - a.tick || compareStable(a.domain, b.domain) || compareStable(a.jobId, b.jobId));
  return { revisions: { construction: records.construction.revision, production: records.production.revision, research: records.research.revision, care: records.care.revision },
    stock: SECT_RESOURCE_IDS.map(resourceId => { const row = records.stock[resourceId]; return { resourceId, owned: row.owned, reserved: row.reserved,
      capacity: row.capacity, available: row.owned - row.reserved }; }), blueprints,
    buildings: records.construction.buildings.map(row => ({ buildingId: row.buildingId, definitionId: row.definitionId, anchor: { x: row.anchor.x, y: row.anchor.y },
      rotation: row.rotation, level: row.level, footprint: footprint(row), maintenance: sectMaintenanceStatusFromRecords(frame, row) })),
    jobs, workOwners: owners,
    completedResearch,
    recentTerminals: terminals.slice(0, LIMITS.recentTerminals), totalTerminals: terminals.length };
}
export function projectRuntimeBreakthroughV9(world: WorldStateV9, request: RuntimeBreakthroughRequestV9): RuntimeBreakthroughPreviewV9 {
  return { preview: breakthroughView(previewBreakthroughV3(cultivationFrameOf(world), request.discipleId, request.preparation)),
    resourceStamp: stableHash(world.inventory), workOwner: v9WorkOwners(world).find(owner => owner.workerId === request.discipleId) ?? null };
}
export function projectRuntimePlacementV9(world: WorldStateV9, request: SectPlacementRequest): RuntimePlacementPreviewV9 {
  const frame = projectV9SectFrame(world); const geometry = deriveSectFootprint(request);
  const definition = getSectBuildingDefinition(request.definitionId)!;
  const preview = previewValidatedConstructionPlacement(frame.construction, v9SectContext(world), request, frame);
  return { request, expectedRevision: frame.construction.revision, navVersion: world.map.navVersion,
    allowed: preview.ok, code: preview.ok ? null : preview.code, footprint: geometry.ok ? geometry.footprint : null,
    costs: definition.levels[0]!.costs.map(row => ({ ...row })), requiredTicks: definition.levels[0]!.workTicks, scope: 'placement-and-research' };
}
/** Fixed application namespace. No suffix parsing, receipt export, or ID allocation.
 * Restore the archive once for this lookup, never repeatedly from raw JSON. */
export function nextRuntimeApplicationCommandV9(world: WorldStateV9, start: number): RuntimeApplicationCommandV9 | null {
  const local = new Set(world.pendingCommands.map(command => command.commandId));
  for (const domain of ['construction', 'production', 'research', 'care'] as const) {
    for (const receipt of world.sectExpansion[domain].receipts) local.add(receipt.command.commandId);
  }
  const source = { ...world, history: restoreHistoryArchive(world.history) };
  let sequence = start;
  for (;;) {
    // Reserve space for the Session's next cursor; never hand it an unsafe +1.
    if (sequence >= Number.MAX_SAFE_INTEGER) return null;
    const commandId = `app-command.${sequence}`;
    if (!local.has(commandId) && !lookupCommandReceipt(source, commandId)) return { commandId, sequence, issuedTick: world.clock.simulationTick };
    sequence++;
  }
}
