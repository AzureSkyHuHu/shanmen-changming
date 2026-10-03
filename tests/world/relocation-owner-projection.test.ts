import { beforeAll, describe, expect, it } from 'vitest';
import { emptyNavigation } from '../../src/core/agents/navigation';
import type { AutomaticTransaction } from '../../src/core/economy/automatic-types';
import { cloneJson } from '../../src/core/kernel/serialization';
import type { ProductionTransaction } from '../../src/core/economy/types';
import type { ConstructionJob } from '../../src/core/sect-expansion/construction-types';
import type { SectCareJob } from '../../src/core/sect-expansion/care-types';
import type { SectRelocationJob } from '../../src/core/sect-expansion/relocation-types';
import { createSectRelocationState } from '../../src/core/sect-expansion/relocation-validation';
import type { SectResearchJob } from '../../src/core/sect-expansion/research-types';
import type { SectProductionJobV10, SectUpgradeJobV10, WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createUnregisteredWorldV10 } from '../../src/core/world/create-world-v10';
import { projectRelocationOwner, projectRelocationOwnership, recomposeRelocationOwner } from '../../src/core/world/relocation-owner/projection';
import { RELOCATION_OWNER_PHASES, type RelocationOwnerDraft } from '../../src/core/world/relocation-owner/types';

let origin: WorldStateV10;
beforeAll(() => { origin = createUnregisteredWorldV10('owner-projection'); });
/** Explicit test assembly, NOT an import/migration API or evidence of valid new-owner history. */
function fixture(): RelocationOwnerDraft {
  const w = cloneJson(origin); const b = w.sectExpansion;
  return {
    kind: 'internal-relocation-owner-draft', seed: w.seed, contentIdentity: w.contentIdentity,
    clock: w.clock, randomStreams: w.randomStreams, sequences: w.sequences, map: w.map, disciples: w.disciples,
    buildings: w.buildings, sectEconomy: w.sectEconomy, history: w.history, automaticProduction: w.automaticProduction,
    inventory: w.inventory, reservations: w.reservations, transactions: w.transactions,
    activeProductionTransactionIds: w.activeProductionTransactionIds, commandReceipts: w.commandReceipts,
    pendingCommands: w.pendingCommands, events: w.events, unlocks: w.unlocks, diagnostics: w.diagnostics,
    cultivation: w.cultivation, cultivationClock: w.cultivationClock, builds: w.builds,
    expedition: w.expedition, campaign: w.campaign, legacy: w.legacy,
    domains: { construction: b.construction, stock: b.stock, reservations: b.reservations, production: b.production,
      research: b.research, maintenance: b.maintenance, care: b.care, upgrade: b.upgrade,
      relocation: createSectRelocationState(), relocationLive: [] },
  };
}
const p = { x: 1, y: 3 };
const site = { buildingId: 'building', sourceJobId: 'original-build', position: p, level: 1 as const, firstMaintenanceCalendarTick: 1200 };
function jobs(workerId: string, storageId: string) {
  const construction: ConstructionJob = { jobId: 'construction', blueprintId: 'blueprint', reservationId: 'construction-res',
    resultBuildingId: 'future-building', workerId, storageId, seatToken: 'blueprint', entranceToken: '10,3', phase: 'working',
    startedTick: 1, startedCalendarTick: 1, origin: p, storageVisit: { tick: 1, position: p }, siteVisit: { tick: 2, position: p },
    workSpans: [{ firstTick: 3, lastTick: 4 }], activeTicks: 2, navigation: emptyNavigation(), blocked: null, terminal: null };
  const production: SectProductionJobV10 = { transactionId: 'production', recipeId: 'craft.wound-powder.v9', workerId,
    state: 'Running', activeTicks: 40, requiredTicks: 40, startedTick: 1, blockedReason: null, phase: 'TravellingToStorage',
    worksiteId: null, storageId, navigation: { ...emptyNavigation(), path: [{ x: 2, y: 3 }] }, reservationId: 'production-res',
    startedCalendarTick: 1, origin: p, productiveSite: { kind: 'placed', siteId: 'building', position: p, sourceJobId: 'original-build', level: 1, firstMaintenanceCalendarTick: 1200 },
    seatSiteId: null, workVisit: { tick: 2, calendarTick: 2, position: p }, deliveryVisit: null,
    workSpans: [{ firstTick: 3, lastTick: 42, firstCalendarTick: 3, lastCalendarTick: 42 }], terminal: null,
    researchGate: { researchId: 'basic-medicine.v9', completionJobId: 'old-research' } };
  const research: SectResearchJob = { jobId: 'research', reservationId: 'research-res', researchId: 'basic-medicine.v9', workerId,
    startedTick: 2, startedCalendarTick: 2, origin: p, site, prerequisites: [], phase: 'working', activeTicks: 0, requiredTicks: 200,
    visits: [], workSpans: [], navigation: emptyNavigation(), blocked: null, terminal: null };
  const care: SectCareJob = { jobId: 'care', reservationId: 'care-res', patientId: workerId, doseProductionJobId: 'old-production',
    previousCancelledCareId: null, startedTick: 1, startedCalendarTick: 1, origin: p, storageId, storagePosition: p,
    phase: 'to-storage', activeTicks: 0, visits: [], workSpans: [], navigation: { ...emptyNavigation(), path: [{ x: 3, y: 3 }] }, blocked: null, terminal: null };
  const upgrade: SectUpgradeJobV10 = { jobId: 'upgrade', reservationId: 'upgrade-res', workerId, buildingId: 'building',
    fromLevel: 1, toLevel: 2, requiredTicks: 400, researchGate: { researchId: 'herbal-compatibility.v9', completionJobId: 'old-research-2' },
    site: { ...site, definitionId: 'alchemy.v9' }, storageId, storagePosition: p, seatToken: 'building', entranceToken: '1,3',
    startedTick: 2, startedCalendarTick: 2, origin: p, phase: 'working', storageVisit: null, siteVisits: [], workSpans: [], checkpoints: [],
    activeTicks: 0, navigation: emptyNavigation(), blocked: null, terminal: null };
  const relocation: SectRelocationJob = { jobId: 'relocation', reservationId: 'relocation-res', buildingId: 'building',
    sourceJobId: 'original-build', workerId, previousRelocationJobId: null,
    from: { definitionId: 'alchemy.v9', anchor: { x: 1, y: 1 }, rotation: 0 },
    to: { definitionId: 'alchemy.v9', anchor: { x: 4, y: 1 }, rotation: 0 },
    startedTick: 3, startedCalendarTick: 3, origin: p, requiredTicks: 200, phase: 'to-old-entrance', oldEntranceVisit: null,
    newEntranceVisits: [], workSpans: [], checkpoints: [], activeTicks: 0, terminal: null };
  const legacy: ProductionTransaction = { transactionId: 'legacy', rootActionId: 'action', commandId: 'command', recipeId: 'gather.wood',
    workerId, reservationId: 'legacy-res', state: 'Running', activeTicks: 0, requiredTicks: 10, startedTick: 1, completedTick: null,
    resultEventId: null, blockedReason: null, phase: 'TravellingToStorage', worksiteId: null, storageId, navigation: emptyNavigation() };
  return { construction, production, research, care, upgrade, relocation, legacy };
}
/** Deliberately overlapping typed job books exercise projection, not simulation validity. */
function populated(): RelocationOwnerDraft {
  const source = fixture(); const j = jobs(source.disciples[0]!.id, source.buildings.find(s => s.blueprintId === 'storage')!.id);
  return { ...source, transactions: { legacy: j.legacy }, activeProductionTransactionIds: ['legacy'],
    domains: { ...source.domains,
      construction: { ...source.domains.construction, jobs: [j.construction], buildings: [{ kind: 'placed', buildingId: 'building', definitionId: 'alchemy.v9',
        anchor: { x: 1, y: 1 }, rotation: 0, level: 1, sourceJobId: 'original-build', completedTick: 1, completedCalendarTick: 1, firstMaintenanceCalendarTick: 1200 }] },
      production: { ...source.domains.production, jobs: [j.production] }, research: { ...source.domains.research, jobs: [j.research] },
      care: { ...source.domains.care, jobs: [j.care] }, upgrade: { ...source.domains.upgrade, jobs: [j.upgrade] },
      relocation: { ...source.domains.relocation, jobs: [j.relocation], receipts: [{ revision: 1, jobId: j.relocation.jobId,
        command: { kind: 'relocation.start', commandId: 'move', expectedRevision: 0, buildingId: j.relocation.buildingId, workerId: j.relocation.workerId, target: j.relocation.to } }] },
      relocationLive: [{ jobId: j.relocation.jobId, navigation: { ...emptyNavigation(), path: [{ x: 4, y: 3 }] }, blocked: null }],
      maintenance: { nextId: 3, payments: [
        { paymentId: 'pay1', reservationId: 'pay-res1', buildingId: 'building', sourceJobId: 'original-build', predecessorPaymentId: null,
          previousDueCalendarTick: 1200, paidTick: 1100, paidCalendarTick: 1100, dueCalendarTick: 2400 },
        { paymentId: 'pay2', reservationId: 'pay-res2', buildingId: 'building', sourceJobId: 'original-build', predecessorPaymentId: 'pay1',
          previousDueCalendarTick: 2400, paidTick: 2300, paidCalendarTick: 2300, dueCalendarTick: 3600, rate: { level: 2, upgradeJobId: 'completed-upgrade' } },
      ] },
    } };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

describe('internal relocation owner typed projection only', () => {
  it('round trips every explicit root field, immutable construction origin and domain history', () => {
    const source = populated(); const before = cloneJson(source); const frame = projectRelocationOwner(freeze(source));
    const result = recomposeRelocationOwner(frame);
    expect(result).toStrictEqual(before); expect(source).toStrictEqual(before);
    expect(Object.keys(result).sort()).toEqual(Object.keys(before).sort());
    expect(result).not.toHaveProperty('saveVersion'); expect(result).not.toHaveProperty('simulationVersion');
    expect(frame.domains).not.toHaveProperty('map'); expect(frame.domains.construction).not.toHaveProperty('people');
    expect(frame.domains.construction).not.toHaveProperty('lastSimulationTick');
    expect(result.domains.maintenance.payments[0]).not.toHaveProperty('rate');
    expect(result.domains.maintenance.payments[1]).toHaveProperty('rate.level', 2);
    expect(result.domains.production.jobs[0]).toHaveProperty('researchGate.completionJobId', 'old-research');
    expect(result.domains.construction.buildings[0]!.level).toBe(1);
  });
  it('detaches both directions deeply and preserves explicit actor travel without choosing a job', () => {
    const source = populated(); const before = cloneJson(source); const frame = projectRelocationOwner(source);
    frame.authority.disciples[0]!.position.x = 99; frame.authority.disciples[0]!.traveling = true;
    frame.authority.inventory.wood.owned++; frame.authority.map.tiles[0]!.walkable = false;
    frame.domains.relocationLive[0]!.navigation.path[0]!.x = 77;
    frame.continuity.cultivation.legacyStateExtras.marker = { nested: ['preserved'] };
    const result = recomposeRelocationOwner(frame); const expected = cloneJson(result);
    frame.authority.disciples[0]!.position.x = 100;
    frame.domains.relocationLive[0]!.navigation.path[0]!.x = 88;
    expect(result).toStrictEqual(expected); expect(source).toStrictEqual(before);
    result.map.tiles[0]!.terrain = 'water';
    expect(frame.authority.map.tiles[0]!.terrain).not.toBe('water');
    expect(result.disciples[0]!.traveling).toBe(true);
    expect(result.domains.construction.buildings).toStrictEqual(before.domains.construction.buildings);
  });
  it('counts seven domain jobs including care patient and delivery with no production seat', () => {
    const source = populated(); const view = projectRelocationOwnership(source);
    expect(view.activeJobCount).toBe(7);
    expect(view.owners.map(o => o.domain)).toEqual(['legacy-production', 'construction', 'sect-production', 'research', 'care', 'upgrade', 'relocation']);
    expect(view.owners.find(o => o.domain === 'care')).toMatchObject({ actorRole: 'patient', traveling: true });
    expect(view.owners.find(o => o.domain === 'relocation')!.traveling).toBe(true);
    expect(view.claims.some(c => c.kind === 'building-lifetime' && c.owner.domain === 'sect-production')).toBe(true);
    expect(view.claims.some(c => c.kind === 'seat' && c.owner.domain === 'sect-production')).toBe(false);
    expect(view.claims.filter(c => c.kind === 'soft-target').length).toBeGreaterThan(0);
    expect(view.issues.some(i => i.code === 'CLAIM_CONFLICT' && i.key === 'building-lifetime:building')).toBe(true);
    expect(view.issues.some(i => i.code === 'CLAIM_CONFLICT' && i.key.startsWith('actor:'))).toBe(true);
    expect(view.claims.length).toBeGreaterThan(view.activeJobCount);
    view.owners.find(o => o.domain === 'relocation')!.navigation!.path[0]!.x = 200;
    expect(source.domains.relocationLive[0]!.navigation.path[0]!.x).toBe(4);
  });
  it('keeps every legacy delivery owner while sharing storage occupancy only with legacy deliveries', () => {
    const source = fixture(); const storage = source.buildings.find(s => s.blueprintId === 'storage')!;
    const first = jobs(source.disciples[0]!.id, storage.id).legacy;
    source.disciples[0]!.assignmentTransactionId = first.transactionId;
    source.disciples[1]!.assignmentTransactionId = 'legacy-two';
    const second = { ...first, transactionId: 'legacy-two', workerId: source.disciples[1]!.id };
    const next = { ...source, transactions: { legacy: first, 'legacy-two': second }, activeProductionTransactionIds: ['legacy', 'legacy-two'] };
    const view = projectRelocationOwnership(next);
    expect(view.activeJobCount).toBe(2);
    expect(view.claims.filter(c => c.access === 'shared-legacy-storage')).toHaveLength(2);
    expect(view.issues.filter(i => i.code === 'CLAIM_CONFLICT' || i.code === 'LEGACY_ASSIGNMENT_MISMATCH' || i.code === 'LEGACY_STATION_MISMATCH')).toEqual([]);
    const reused = { ...next, transactions: { legacy: first, 'legacy-two': { ...second, workerId: first.workerId } } };
    expect(projectRelocationOwnership(reused).issues.some(i => i.code === 'CLAIM_CONFLICT' && i.key.startsWith('actor:'))).toBe(true);
    const care = { ...jobs(source.disciples[2]!.id, storage.id).care, storagePosition: { x: storage.x, y: storage.y } };
    const exclusive = { ...next, domains: { ...next.domains, care: { ...next.domains.care, jobs: [care] } } };
    expect(projectRelocationOwnership(exclusive).issues.some(i => i.code === 'CLAIM_CONFLICT' && i.key === `entrance:${storage.x},${storage.y}`)).toBe(true);
  });
  it('surfaces orphan indexes and missing/duplicate relocation live entries, never chooses one', () => {
    const source = populated(); const duplicate = { ...source, activeProductionTransactionIds: ['missing'],
      domains: { ...source.domains, relocationLive: [...source.domains.relocationLive, ...source.domains.relocationLive] } };
    const view = projectRelocationOwnership(duplicate);
    expect(view.issues.filter(i => i.code === 'LEGACY_INDEX_MISMATCH').map(i => i.key)).toEqual(['missing', 'legacy']);
    expect(view.issues.some(i => i.code === 'RELOCATION_LIVE_MISMATCH')).toBe(true);
    expect(view.owners.find(o => o.domain === 'relocation')!.navigation).toBeNull();
    expect(projectRelocationOwnership({ ...source, domains: { ...source.domains, relocationLive: [] } }).issues.some(i => i.code === 'RELOCATION_LIVE_MISMATCH')).toBe(true);
  });
  it('reports orphan actor and station references even without a legacy index and retains their claims', () => {
    const source = fixture(); const actor = source.disciples[0]!; const building = source.buildings[0]!;
    actor.assignmentTransactionId = 'missing-job'; building.stationTransactionId = 'missing-job';
    const before = cloneJson(source); const frame = projectRelocationOwner(source);
    expect(frame.ownership.activeJobCount).toBe(0);
    expect(frame.ownership.issues).toEqual(expect.arrayContaining([
      { code: 'LEGACY_ASSIGNMENT_MISMATCH', key: actor.id, owners: [{ domain: 'legacy-production', id: 'missing-job' }] },
      { code: 'LEGACY_STATION_MISMATCH', key: building.id, owners: [{ domain: 'legacy-production', id: 'missing-job' }] },
    ]));
    expect(frame.ownership.claims).toEqual(expect.arrayContaining([
      { kind: 'actor', key: actor.id, access: 'exclusive', owner: { domain: 'legacy-production', id: 'missing-job' } },
      { kind: 'seat', key: building.id, access: 'exclusive', owner: { domain: 'legacy-production', id: 'missing-job' } },
    ]));
    expect(recomposeRelocationOwner(frame)).toStrictEqual(before); expect(source).toStrictEqual(before);
  });
  it('checks live legacy assignments and station references in both directions', () => {
    const source = fixture(); const actor = source.disciples[0]!; const wrongActor = source.disciples[1]!;
    const building = source.buildings[0]!;
    const legacy = { ...jobs(actor.id, source.buildings.find(s => s.blueprintId === 'storage')!.id).legacy,
      phase: 'Working' as const, worksiteId: building.id };
    const next = { ...source, transactions: { legacy }, activeProductionTransactionIds: ['legacy'] };
    const missing = projectRelocationOwnership(next);
    expect(missing.issues.some(i => i.code === 'LEGACY_ASSIGNMENT_MISMATCH')).toBe(true);
    expect(missing.issues.some(i => i.code === 'LEGACY_STATION_MISMATCH')).toBe(true);
    actor.assignmentTransactionId = legacy.transactionId; building.stationTransactionId = legacy.transactionId;
    expect(projectRelocationOwnership(next).issues.filter(i => i.code === 'LEGACY_ASSIGNMENT_MISMATCH' || i.code === 'LEGACY_STATION_MISMATCH')).toEqual([]);
    wrongActor.assignmentTransactionId = legacy.transactionId;
    source.buildings[1]!.stationTransactionId = legacy.transactionId;
    const mismatched = projectRelocationOwnership(next);
    expect(mismatched.issues.some(i => i.code === 'LEGACY_ASSIGNMENT_MISMATCH' && i.key === wrongActor.id)).toBe(true);
    expect(mismatched.issues.some(i => i.code === 'LEGACY_STATION_MISMATCH' && i.key === source.buildings[1]!.id)).toBe(true);
    expect(recomposeRelocationOwner(projectRelocationOwner(next))).toStrictEqual(next);
  });
  it('retains terminal history while removing its owner and preserves optional field absence', () => {
    const source = populated(); const job = source.domains.relocation.jobs[0]!;
    const terminal: SectRelocationJob = { ...job, phase: 'cancelled', terminal: { kind: 'cancelled', previousPhase: 'to-old-entrance',
      tick: 4, calendarTick: 4, position: p, revision: 2, consumed: [], released: [{ ledger: 'base', resourceId: 'wood', quantity: 2 }] } };
    const next = { ...source, domains: { ...source.domains, relocation: { ...source.domains.relocation, jobs: [terminal] }, relocationLive: [] } };
    const frame = projectRelocationOwner(next);
    expect(frame.ownership.activeJobCount).toBe(6); expect(frame.ownership.owners.some(o => o.domain === 'relocation')).toBe(false);
    expect(recomposeRelocationOwner(frame)).toStrictEqual(next);
    expect(frame.domains.construction.jobs[0]).not.toHaveProperty('researchGate');
  });
  it('projects cultivation, teaching, away and build locks as exclusions without erasing work', () => {
    const source = populated(); const actor = source.disciples[0]!; const profile = source.cultivation.disciples.find(p => p.discipleId === actor.id)!;
    profile.activeAttemptId = 'attempt'; profile.trainingMode = 'rest';
    profile.activityOwner = { kind: 'expedition', runId: 'run', lockId: 'away-lock' };
    source.cultivation.disciples[1]!.teaching = { teachingId: 'teaching', studentId: actor.id, knowledgeId: 'knowledge', completedMonths: 0, requiredMonths: 1 };
    source.builds.disciples.find(p => p.discipleId === actor.id)!.lock = { lockId: 'lock', runId: 'run', loadoutHash: 'hash' };
    const view = projectRelocationOwnership(source);
    expect(view.activeJobCount).toBe(7);
    expect(view.exclusions).toEqual(expect.arrayContaining([
      { actorId: actor.id, kind: 'cultivation', sourceId: 'attempt' }, { actorId: actor.id, kind: 'training', sourceId: null },
      { actorId: actor.id, kind: 'build-lock', sourceId: 'lock' },
      { actorId: actor.id, kind: 'away', sourceId: 'away-lock' }, { actorId: actor.id, kind: 'teaching', sourceId: 'teaching' },
    ]));
    expect(view.issues.some(i => i.code === 'OWNER_EXCLUDED')).toBe(true);
    expect(recomposeRelocationOwner(projectRelocationOwner(source))).toStrictEqual(source);
  });
  it('includes automatic live jobs and detects duplicate domain IDs without overwriting either owner', () => {
    const source = fixture(); const legacy = jobs(source.disciples[0]!.id, source.buildings.find(s => s.blueprintId === 'storage')!.id).legacy;
    const automatic: AutomaticTransaction = {
      transactionId: 'auto-job/1', origin: { kind: 'sect-plan', cycle: 1 }, rootActionId: legacy.rootActionId,
      recipeId: legacy.recipeId, workerId: legacy.workerId, reservationId: legacy.reservationId, state: legacy.state,
      activeTicks: legacy.activeTicks, requiredTicks: legacy.requiredTicks, startedTick: legacy.startedTick,
      completedTick: legacy.completedTick, resultEventId: legacy.resultEventId, blockedReason: legacy.blockedReason,
      phase: legacy.phase, worksiteId: legacy.worksiteId, storageId: legacy.storageId, navigation: legacy.navigation,
    };
    source.automaticProduction.live['auto-job/1'] = { transaction: automatic,
      reservation: { reservationId: legacy.reservationId, ownerTransactionId: automatic.transactionId, state: 'reserved', lines: [] } };
    source.activeProductionTransactionIds.push(automatic.transactionId);
    expect(projectRelocationOwnership(source).owners).toHaveLength(1);
    expect(recomposeRelocationOwner(projectRelocationOwner(source))).toStrictEqual(source);
    source.transactions[automatic.transactionId] = { ...legacy, transactionId: automatic.transactionId };
    const duplicate = projectRelocationOwnership(source);
    expect(duplicate.activeJobCount).toBe(2);
    expect(duplicate.issues.some(i => i.code === 'DUPLICATE_OWNER')).toBe(true);
  });
  it('keeps opaque archive rows, lifecycle extras, pauses, settings and optional field presence', () => {
    const base = populated(); base.clock.pauseReasons = ['player', 'save-capacity']; base.clock.speed = 3;
    base.cultivation.legacyStateExtras.kept = { nullable: null, list: ['历史', 0] };
    base.cultivationClock.transitions.push({ kind: 'month', tick: 20, beforeRevision: 2, rootActionId: 'month' });
    const source = { ...base, history: { ...base.history, strings: ['archived'],
      events: { count: 1, pages: [[['opaque', null, 2]]] } },
      legacy: { ...base.legacy, estates: [{ estateId: 'estate', deathId: 'death', discipleId: 'archived-person', beneficiaryId: null,
        itemInstanceIds: ['item'], pendingRunId: null, transferCommandIds: ['transfer'], recordedMonth: 1, settledMonth: 2, settledOwner: { kind: 'sect-estate' as const } }] },
    };
    const result = recomposeRelocationOwner(projectRelocationOwner(source));
    expect(result).toStrictEqual(source);
    expect(result.history.events.pages).not.toBe(source.history.events.pages);
    expect(result.legacy.estates[0]!.itemInstanceIds).not.toBe(source.legacy.estates[0]!.itemInstanceIds);
  });
  it('freezes the proposed phase seam without claiming an executable clock stage', () => {
    expect(RELOCATION_OWNER_PHASES.slice(3)).toEqual(['construction', 'maintenance', 'upgrade', 'relocation', 'sect-production', 'research', 'care', 'legacy-production']);
  });
});
