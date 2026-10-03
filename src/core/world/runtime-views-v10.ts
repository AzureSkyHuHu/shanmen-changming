/** Internal fixed projections over the runtime's already owned root. No function
 * here grants source authority or escapes a World/frame/proof to the caller. */
import { getSectBuildingDefinition, getSectRecipeDefinition } from '../../content/sect-v9/catalog';
import { SECT_RECIPE_IDS, SECT_RESOURCE_IDS, type SectResourceLine } from '../../content/sect-v9/types';
import { managementV10BuildContext } from '../../content/sect-v10/world-content';
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
import { SECT_MAINTENANCE_LIMITS } from '../sect-expansion/maintenance-types';
import { sectProductionSitesV10 } from '../sect-expansion/production-runtime-v10';
import { productionResearchGateV10 } from '../sect-expansion/research-consumer-gates-v10';
import { previewSectUpgradeV10, sectBuildingStatusV10 } from '../sect-expansion/upgrade-queries';
import { sectUpgradeAllLocalClaimsV10 } from '../sect-expansion/upgrade-validation';
import type { SectProductionSiteProofV10, SectUpgradeFrameV10, SectUpgradeJobV10, WorldStateV10 } from '../sect-expansion/upgrade-types';
import type { SectPlacementRequest } from '../sect-expansion/types';
import { cultivationFrameOf } from './cultivation-preparation';
import { lookupCommandReceipt, lookupProduction, recentWorldEvents } from './history-access';
import { projectV10SectFrame, v10SectContext, v10WorkerAvailable, v10WorkOwners } from './v10-sect-frame';
import { RUNTIME_VIEW_LIMITS_V10 as LIMITS } from './runtime-view-types-v10';
import type { RuntimeApplicationCommandV10, RuntimeBreakthroughPreviewV10, RuntimeBreakthroughRequestV10, RuntimeBuildViewV10,
  RuntimeCultivationViewV10, RuntimeExpansionJobV10, RuntimeExpansionTerminalV10, RuntimeExpansionViewV10,
  RuntimeFrameViewV10, RuntimePlacementPreviewV10, RuntimeSelectedCultivationV10, RuntimeUpgradeRequestV10, RuntimeUpgradePreviewV10,
  RuntimeDoseSourceV10, RuntimeProductionSiteV10, RuntimeMaintenanceViewV10, RuntimeRecipeViewV10, RuntimeUpgradeCheckpointV10 } from './runtime-view-types-v10';

function bounded(length: number, maximum: number): void {
  if (length > maximum) throw new RangeError('Private v10 view exceeds its fixed presentation bound');
}
export const validRuntimeDiscipleQueryV10 = (value: unknown): value is string | null => value === null
  || typeof value === 'string' && value.length <= 128 && /^entity:[1-9][0-9]*$/.test(value);
export function validRuntimeBreakthroughQueryV10(value: unknown): value is RuntimeBreakthroughRequestV10 {
  return ownSectFields(value, ['discipleId', 'preparation']) && value.discipleId !== null && validRuntimeDiscipleQueryV10(value.discipleId)
    && ownSectFields(value.preparation, ['method', 'arraySupport'])
    && (value.preparation.method === 'standard' || value.preparation.method === 'forced')
    && (value.preparation.arraySupport === 0 || value.preparation.arraySupport === 1 || value.preparation.arraySupport === 2);
}
export function validRuntimePlacementQueryV10(value: unknown): value is SectPlacementRequest {
  return deriveSectFootprint(value).ok;
}
export function validRuntimeUpgradeQueryV10(value: unknown): value is RuntimeUpgradeRequestV10 {
  return ownSectFields(value, ['buildingId', 'workerId']) && typeof value.buildingId === 'string'
    && value.buildingId.length <= 128 && /^sect-building:[1-9][0-9]*$/.test(value.buildingId)
    && value.workerId !== null && validRuntimeDiscipleQueryV10(value.workerId);
}
export const validRuntimeApplicationCursorV10 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

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
export function projectRuntimeFrameV10(world: WorldStateV10): RuntimeFrameViewV10 {
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
export function projectRuntimeCultivationV10(world: WorldStateV10, discipleId: string | null): RuntimeCultivationViewV10 {
  const state = world.cultivation; const owners = v10WorkOwners(world);
  bounded(state.disciples.length, LIMITS.livePeople); bounded(owners.length, LIMITS.activeJobs);
  bounded(state.pendingDeaths.length, LIMITS.livePeople);
  const receiving = new Map(state.disciples.filter(profile => profile.teaching).map(profile => [profile.teaching!.studentId, profile]));
  const profile = state.disciples.find(profile => profile.discipleId === discipleId);
  const ownerFor = (id: string) => owners.find(owner => owner.workerId === id) ?? null;
  let selected: RuntimeSelectedCultivationV10 | null = null;
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
    const choices: RuntimeSelectedCultivationV10['teachingChoices'] = []; let totalTeachableKnowledge = 0;
    if (canTeach) for (const knowledge of profile.knowledge) {
      const studentIds = students.filter(row => !row.knowledge.some(known => known.knowledgeId === knowledge.knowledgeId)).map(row => row.discipleId);
      if (studentIds.length) { totalTeachableKnowledge++; if (choices.length < LIMITS.teachingChoices) choices.push({ knowledgeId: knowledge.knowledgeId, studentIds }); }
    }
    selected = { discipleId: profile.discipleId, realm: profile.realm, cultivation: profile.cultivation, understanding: profile.understanding,
      foundation: profile.foundation, mindset: profile.mindset, injury: profile.injury, lifeState: profile.lifeState, trainingMode: profile.trainingMode,
      heirId: profile.heirId, requiredCultivation: REALM_RULES[profile.realm].cultivationRequired,
      remainingLifespanMonths: Math.max(0, profile.lifespanMonths - profile.ageMonths), relicCount: profile.relicIds.length,
      activityLocked: profile.activityOwner !== null || workOwner !== null, workOwner, workerAvailable: v10WorkerAvailable(world, profile.discipleId),
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
      workOwner: ownerFor(row.discipleId), workerAvailable: v10WorkerAvailable(world, row.discipleId) })),
    decisions: [...state.pendingDeaths.map(row => ({ discipleId: row.discipleId, kind: 'death' as const })),
      ...state.disciples.filter(row => row.activeAttemptId && state.attempts.some(attempt => attempt.attemptId === row.activeAttemptId && attempt.phase === 'DecisionReady'))
        .map(row => ({ discipleId: row.discipleId, kind: 'breakthrough' as const }))] };
}
export function projectRuntimeBuildV10(world: WorldStateV10, discipleId: string | null): RuntimeBuildViewV10 {
  const content = managementV10BuildContext(world.contentIdentity); const build = world.builds.disciples.find(row => row.discipleId === discipleId);
  const profile = world.cultivation.disciples.find(row => row.discipleId === discipleId);
  const identity = content.identity;
  const result: RuntimeBuildViewV10 = { revision: world.builds.revision, contentIdentity: { registryId: identity.registryId,
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
function siteView(site: SectProductionSiteProofV10): RuntimeProductionSiteV10 {
  return { kind: site.kind, siteId: site.siteId, sourceJobId: site.sourceJobId, level: site.level,
    upgradeJobId: site.level === 2 ? site.upgradeJobId : null };
}
function doseView(frame: SectUpgradeFrameV10, jobId: string): RuntimeDoseSourceV10 {
  const producer = frame.production.jobs.find(job => job.transactionId === jobId);
  if (!producer || producer.terminal?.kind !== 'completed'
    || producer.recipeId !== 'craft.wound-powder.v9' && producer.recipeId !== 'craft.wound-powder-alt.v9')
    throw new TypeError('Owned care dose lost its exact production source');
  return { productionJobId: producer.transactionId, recipeId: producer.recipeId, site: siteView(producer.productiveSite) };
}
function upgradeCheckpointViews(frame: SectUpgradeFrameV10, job: SectUpgradeJobV10): RuntimeUpgradeCheckpointV10[] {
  bounded(job.checkpoints.length, LIMITS.upgradeCheckpoints);
  const claim = frame.construction.ledger.reservations.find(row => row.reservationId === job.reservationId && row.ownerTransactionId === job.jobId);
  if (!claim) throw new TypeError('Owned upgrade lost its paired resource claim');
  return job.checkpoints.map(checkpoint => {
    const base = claim.base.checkpoints.find(row => row.checkpointId === checkpoint.checkpointId);
    const sect = claim.sect.checkpoints.find(row => row.checkpointId === checkpoint.checkpointId);
    if (!base || !sect) throw new TypeError('Owned upgrade checkpoint lost its recorded consumption');
    bounded(base.lines.length + sect.lines.length, LIMITS.resourceLines);
    return { checkpointId: checkpoint.checkpointId, activeTicks: checkpoint.activeTicks, tick: checkpoint.tick,
      consumed: [...base.lines.map(line => ({ ledger: 'base' as const, resourceId: line.resourceId, quantity: line.quantity })),
        ...sect.lines.map(line => ({ ledger: 'sect' as const, resourceId: line.resourceId, quantity: line.quantity }))] };
  });
}
function recordedResourceLines(lines: readonly SectResourceLine[]): SectResourceLine[] {
  bounded(lines.length, LIMITS.resourceLines);
  return lines.map(line => line.ledger === 'base'
    ? { ledger: 'base' as const, resourceId: line.resourceId, quantity: line.quantity }
    : { ledger: 'sect' as const, resourceId: line.resourceId, quantity: line.quantity });
}
function maintenanceView(frame: SectUpgradeFrameV10, buildingId: string): RuntimeMaintenanceViewV10 {
  const status = sectBuildingStatusV10(frame, buildingId);
  const building = frame.construction.buildings.find(row => row.buildingId === buildingId);
  if (!status || !building) throw new TypeError('Owned building lost its level source');
  bounded(status.nextMaintenanceCosts.length, LIMITS.resourceLines); bounded(status.deficits.length, LIMITS.resourceLines);
  const latest = frame.maintenance.payments.findLast(payment => payment.buildingId === buildingId);
  const renewalBlock = frame.maintenance.payments.length >= SECT_MAINTENANCE_LIMITS.payments
    || frame.construction.ledger.reservations.length >= SECT_MAINTENANCE_LIMITS.pairedClaims ? 'HISTORY_EXHAUSTED'
    : frame.maintenance.nextId > Number.MAX_SAFE_INTEGER - 2 ? 'ID_LIMIT'
    : frame.construction.lastCalendarTick > Number.MAX_SAFE_INTEGER - 1200 ? 'CLOCK_LIMIT'
    : status.deficits.length ? 'INSUFFICIENT_INVENTORY' : null;
  return { buildingId, paid: status.paid, operational: status.operational, dueCalendarTick: status.dueCalendarTick,
    deficits: status.deficits, nextMaintenanceCosts: status.nextMaintenanceCosts, renewalBlock,
    currentPeriod: status.paid ? { paymentId: latest?.paymentId ?? null, level: latest?.rate?.level ?? 1,
      upgradeJobId: latest?.rate?.upgradeJobId ?? null, paidTick: latest?.paidTick ?? building.completedTick,
      paidCalendarTick: latest?.paidCalendarTick ?? building.completedCalendarTick, dueCalendarTick: status.dueCalendarTick } : null };
}
function recipeViews(world: WorldStateV10, frame: SectUpgradeFrameV10): RuntimeRecipeViewV10[] {
  bounded(SECT_RECIPE_IDS.length, LIMITS.recipes);
  const claims = [...sectUpgradeAllLocalClaimsV10(frame), ...v10SectContext(world).externalClaims];
  return SECT_RECIPE_IDS.map(recipeId => {
    const recipe = getSectRecipeDefinition(recipeId)!;
    bounded(recipe.inputs.length, LIMITS.resourceLines); bounded(recipe.outputs.length, LIMITS.resourceLines);
    const gate = productionResearchGateV10(frame, recipeId, world.clock.simulationTick, world.clock.calendarTick);
    const sites = sectProductionSitesV10(frame, recipe); bounded(sites.length, LIMITS.objects);
    return { recipeId, inputs: recipe.inputs.map(line => ({ ...line })), outputs: recipe.outputs.map(line => ({ ...line })),
      requiredTicks: recipe.workTicks, researchGate: gate ? { researchId: gate.researchId, completionJobId: gate.completionJobId } : null,
      researchSatisfied: recipe.requiredResearch.length === 0 || gate !== null,
      deficits: recipe.inputs.flatMap(line => {
        const row = line.ledger === 'base' ? world.inventory[line.resourceId] : world.sectExpansion.stock[line.resourceId];
        const quantity = Math.max(0, line.quantity - (row.owned - row.reserved)); return quantity ? [{ ...line, quantity }] : [];
      }),
      sites: sites.map(site => {
        const status = site.kind === 'placed' ? sectBuildingStatusV10(frame, site.siteId) : null;
        const paid = site.kind === 'legacy-point' || status?.paid === true;
        const operational = site.kind === 'legacy-point'
          ? frame.construction.legacyStations.find(value => value.id === site.siteId)?.operational === true : status?.operational === true;
        return { ...siteView(site), paid, operational,
          busy: claims.some(claim => claim.kind === 'seat' && claim.key === site.siteId
            || claim.kind === 'entrance' && claim.key === `${site.position.x},${site.position.y}`) };
      }), scope: 'catalog-and-authenticated-sites' };
  });
}
export function projectRuntimeExpansionV10(world: WorldStateV10): RuntimeExpansionViewV10 {
  const records = world.sectExpansion; const frame = projectV10SectFrame(world); const owners = v10WorkOwners(world);
  bounded(owners.length, LIMITS.activeJobs); bounded(records.construction.buildings.length + world.buildings.length, LIMITS.objects);
  bounded(records.construction.blueprints.filter(row => row.status === 'planned').length, LIMITS.plannedBlueprints);
  const completedResearch = records.research.jobs.filter(job => job.terminal?.kind === 'completed')
    .map(job => ({ researchId: job.researchId, completionJobId: job.jobId }));
  bounded(completedResearch.length, LIMITS.completedResearch);
  const blueprints = records.construction.blueprints.filter(row => row.status === 'planned' || row.status === 'started').map(row => ({
    blueprintId: row.blueprintId, definitionId: row.definitionId, anchor: { x: row.anchor.x, y: row.anchor.y }, rotation: row.rotation,
    status: row.status as 'planned' | 'started', jobId: row.jobId, footprint: footprint(row) })); bounded(blueprints.length, LIMITS.visibleBlueprints);
  const jobs: RuntimeExpansionJobV10[] = [
    ...records.construction.jobs.filter(job => !job.terminal).map(job => {
      const bp = records.construction.blueprints.find(row => row.blueprintId === job.blueprintId)!;
      return { domain: 'construction' as const, jobId: job.jobId, blueprintId: job.blueprintId, workerId: job.workerId, phase: job.phase,
        activeTicks: job.activeTicks, requiredTicks: getSectBuildingDefinition(bp.definitionId)!.levels[0]!.workTicks, blocked: job.blocked };
    }),
    ...records.production.jobs.filter(job => !job.terminal).map(job => ({ domain: 'production' as const, jobId: job.transactionId,
      recipeId: job.recipeId, workerId: job.workerId, phase: job.phase, activeTicks: job.activeTicks, requiredTicks: job.requiredTicks,
      blocked: job.blockedReason, site: siteView(job.productiveSite) })),
    ...records.research.jobs.filter(job => !job.terminal).map(job => ({ domain: 'research' as const, jobId: job.jobId, researchId: job.researchId,
      workerId: job.workerId, phase: job.phase, activeTicks: job.activeTicks, requiredTicks: job.requiredTicks, blocked: job.blocked })),
    ...records.care.jobs.filter(job => !job.terminal).map(job => ({ domain: 'care' as const, jobId: job.jobId, patientId: job.patientId,
      phase: job.phase, activeTicks: job.activeTicks, requiredTicks: 40 as const, blocked: job.blocked, doseSource: doseView(frame, job.doseProductionJobId) })),
    ...records.upgrade.jobs.filter(job => !job.terminal).map(job => ({ domain: 'upgrade' as const, jobId: job.jobId, buildingId: job.buildingId,
      workerId: job.workerId, fromLevel: job.fromLevel, toLevel: job.toLevel, phase: job.phase, activeTicks: job.activeTicks,
      requiredTicks: job.requiredTicks, blocked: job.blocked, checkpoints: upgradeCheckpointViews(frame, job) })),
  ]; bounded(jobs.length, LIMITS.activeJobs);
  // Keep at most eight terminal summaries while traversing retained records.
  // History length never becomes DTO length, even as old identities retire.
  const terminals: RuntimeExpansionTerminalV10[] = []; let totalTerminals = 0;
  const remember = (terminal: RuntimeExpansionTerminalV10): void => {
    totalTerminals++; terminals.push(terminal);
    terminals.sort((a, b) => b.tick - a.tick || compareStable(a.domain, b.domain) || compareStable(a.jobId, b.jobId));
    if (terminals.length > LIMITS.recentTerminals) terminals.pop();
  };
  for (const job of records.construction.jobs) if (job.terminal) remember({ domain: 'construction', jobId: job.jobId, actorId: job.workerId,
    kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: null, afterInjury: null, resultLevel: null, doseSource: null });
  for (const job of records.production.jobs) if (job.terminal) remember({ domain: 'production', jobId: job.transactionId, actorId: job.workerId,
    kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: null, afterInjury: null, resultLevel: null, doseSource: null });
  for (const job of records.research.jobs) if (job.terminal) remember({ domain: 'research', jobId: job.jobId, actorId: job.workerId,
    kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: null, afterInjury: null, resultLevel: null, doseSource: null });
  for (const job of records.care.jobs) if (job.terminal) remember({ domain: 'care', jobId: job.jobId, actorId: job.patientId,
    kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: job.terminal.effect?.beforeInjury ?? null,
    afterInjury: job.terminal.effect?.afterInjury ?? null, resultLevel: null, doseSource: doseView(frame, job.doseProductionJobId) });
  for (const job of records.upgrade.jobs) if (job.terminal) remember({ domain: 'upgrade', jobId: job.jobId, actorId: job.workerId,
    kind: job.terminal.kind, tick: job.terminal.tick, beforeInjury: null, afterInjury: null, resultLevel: job.terminal.resultLevel, doseSource: null,
    consumed: recordedResourceLines(job.terminal.consumed), released: recordedResourceLines(job.terminal.released) });
  return { revisions: { construction: records.construction.revision, production: records.production.revision,
    research: records.research.revision, care: records.care.revision, upgrade: records.upgrade.revision },
    stock: SECT_RESOURCE_IDS.map(resourceId => { const row = records.stock[resourceId]; return { resourceId, owned: row.owned, reserved: row.reserved,
      capacity: row.capacity, available: row.owned - row.reserved }; }), blueprints,
    buildings: records.construction.buildings.map(row => {
      const status = sectBuildingStatusV10(frame, row.buildingId);
      if (!status) throw new TypeError('Owned building lost its effective level');
      return { buildingId: row.buildingId, definitionId: row.definitionId, anchor: { x: row.anchor.x, y: row.anchor.y }, rotation: row.rotation,
        level: status.level.level, levelEvidence: status.level, activeUpgradeJobId: status.activeUpgradeJobId,
        footprint: footprint(row), maintenance: maintenanceView(frame, row.buildingId) };
    }), jobs, workOwners: owners, completedResearch, recentTerminals: terminals, totalTerminals,
    recipes: recipeViews(world, frame) };
}
export function projectRuntimeBreakthroughV10(world: WorldStateV10, request: RuntimeBreakthroughRequestV10): RuntimeBreakthroughPreviewV10 {
  return { preview: breakthroughView(previewBreakthroughV3(cultivationFrameOf(world), request.discipleId, request.preparation)),
    resourceStamp: stableHash(world.inventory), workOwner: v10WorkOwners(world).find(owner => owner.workerId === request.discipleId) ?? null };
}
export function projectRuntimePlacementV10(world: WorldStateV10, request: SectPlacementRequest): RuntimePlacementPreviewV10 {
  const frame = projectV10SectFrame(world); const geometry = deriveSectFootprint(request);
  const definition = getSectBuildingDefinition(request.definitionId)!;
  const preview = previewValidatedConstructionPlacement(frame.construction, v10SectContext(world), request, frame);
  return { request: { definitionId: request.definitionId, anchor: { x: request.anchor.x, y: request.anchor.y }, rotation: request.rotation }, expectedRevision: frame.construction.revision, navVersion: world.map.navVersion,
    allowed: preview.ok, code: preview.ok ? null : preview.code, footprint: geometry.ok ? geometry.footprint : null,
    costs: definition.levels[0]!.costs.map(row => ({ ...row })), requiredTicks: definition.levels[0]!.workTicks, scope: 'placement-and-research' };
}
/** Pure fixed upgrade leaf. Prices/gates come only from the owned v10 source
 * and frozen catalog. Neither this preview nor its scope grants capacity admission. */
export function projectRuntimeUpgradeV10(world: WorldStateV10, request: RuntimeUpgradeRequestV10): RuntimeUpgradePreviewV10 {
  const preview = previewSectUpgradeV10(projectV10SectFrame(world), v10SectContext(world), request.buildingId, request.workerId);
  return { ...preview, scope: 'upgrade-start-conditions' };
}
/** Exact bounded application namespace search, including all five sect receipt
 * owners and live/archived World receipts. Pigeonhole bound: N occupied IDs can
 * obstruct at most N consecutive candidates. Never parse a receipt's suffix. */
export function nextRuntimeApplicationCommandV10(world: WorldStateV10, start: number): RuntimeApplicationCommandV10 | null {
  if (!validRuntimeApplicationCursorV10(start)) return null;
  const local = new Set(world.pendingCommands.map(command => command.commandId));
  for (const domain of ['construction', 'production', 'research', 'care', 'upgrade'] as const) {
    for (const receipt of world.sectExpansion[domain].receipts) local.add(receipt.command.commandId);
  }
  const source = { ...world, history: restoreHistoryArchive(world.history) };
  const maximumChecks = local.size + Object.keys(world.commandReceipts).length + source.history.commandReceipts.count + 1;
  let sequence = start;
  for (let checked = 0; checked < maximumChecks; checked++, sequence++) {
    // Reserve the Session's next cursor; never return an unsafe +1.
    if (sequence >= Number.MAX_SAFE_INTEGER) return null;
    const commandId = `app-command.${sequence}`;
    if (!local.has(commandId) && !lookupCommandReceipt(source, commandId)) return { commandId, sequence, issuedTick: world.clock.simulationTick };
  }
  throw new TypeError('Owned receipt counts lost their exact search bound');
}
