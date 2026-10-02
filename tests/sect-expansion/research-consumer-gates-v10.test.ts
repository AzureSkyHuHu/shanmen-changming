import { describe, expect, it } from 'vitest';
import { getSectRecipeDefinition, SECT_V9_CANDIDATE_IDENTITY } from '../../src/content/sect-v9/catalog';
import type { SectBuildingId, SectRecipeId, SectResearchId } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { emptyNavigation } from '../../src/core/agents/navigation';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { createConstructionFrame } from '../../src/core/sect-expansion/construction';
import type { ConstructionBlueprint, ConstructionJob } from '../../src/core/sect-expansion/construction-types';
import { productionResearchGateV10, productionResearchGateMatchesV10, validateSectResearchConsumerGatesV10 } from '../../src/core/sect-expansion/research-consumer-gates-v10';
import type { SectResearchJob } from '../../src/core/sect-expansion/research-types';
import type { ConstructionOriginV10, SectProductionJobV10, SectProductionSiteProofV10, SectUpgradeFrameV10, SectUpgradeJobV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createWorld } from '../../src/core/world/create-world';

const basic = { researchId: 'basic-medicine.v9', completionJobId: 'sect-research:1' } as const;
const herbal = { researchId: 'herbal-compatibility.v9', completionJobId: 'sect-research:3' } as const;
const alchemyId = 'sect-building:7';
const libraryId = 'sect-building:3';
const alchemyPosition = { x: 4, y: 3 };
const libraryPosition = { x: 1, y: 3 };

/** Deliberately local record-stage fixtures. They supply the already-authenticated source
 * joins this leaf consumes; missing ledger/receipt histories are NOT whole-frame, World,
 * runtime, migration, save, browser or end-to-end admission evidence. */
function constructionSource(definitionId: SectBuildingId, n: number, startedTick: number, completedTick: number) {
  const alchemy = definitionId === 'alchemy.v9';
  const anchor = { x: alchemy ? 4 : 1, y: 1 };
  const position = alchemy ? alchemyPosition : libraryPosition;
  const building: ConstructionOriginV10 = { kind: 'placed', buildingId: `sect-building:${n + 2}`, definitionId,
    anchor, rotation: 0, level: 1, sourceJobId: `sect-construction:${n}`, completedTick, completedCalendarTick: completedTick,
    firstMaintenanceCalendarTick: completedTick + 1200 };
  const bp: ConstructionBlueprint = { blueprintId: `sect-blueprint:${n}`, definitionId, anchor, rotation: 0,
    placedTick: startedTick, placedCalendarTick: startedTick, status: 'completed', jobId: building.sourceJobId, endedTick: completedTick,
    ...(alchemy ? { researchGate: basic } : {}) };
  const job: ConstructionJob = { jobId: building.sourceJobId, blueprintId: bp.blueprintId, reservationId: `sect-construction-reservation:${n + 1}`,
    resultBuildingId: building.buildingId, workerId: 'entity:2', storageId: 'local-storage', seatToken: bp.blueprintId,
    entranceToken: `${position.x},${position.y}`, phase: 'completed', startedTick, startedCalendarTick: startedTick, origin: position,
    storageVisit: { tick: startedTick + 1, position }, siteVisit: { tick: completedTick - 320, position },
    workSpans: [{ firstTick: completedTick - 319, lastTick: completedTick }], activeTicks: 320,
    navigation: emptyNavigation(), blocked: null, terminal: { kind: 'completed', tick: completedTick, calendarTick: completedTick,
      position, previousPhase: 'working', consumed: [], released: [], buildingId: building.buildingId } };
  return { building, bp, job };
}
function researchSource(researchId: SectResearchId, n: number, startedTick: number, completedTick: number): SectResearchJob {
  const requiredTicks = researchId === 'basic-medicine.v9' ? 240 : 400;
  const visitTick = completedTick - requiredTicks;
  return { jobId: `sect-research:${n}`, reservationId: `sect-research-reservation:${n + 1}`, researchId, workerId: 'entity:4',
    startedTick, startedCalendarTick: startedTick, origin: libraryPosition,
    site: { buildingId: libraryId, sourceJobId: 'sect-construction:1', position: libraryPosition, level: 1, firstMaintenanceCalendarTick: 1540 },
    prerequisites: researchId === 'basic-medicine.v9' ? [] : [basic], phase: 'completed', activeTicks: requiredTicks, requiredTicks,
    visits: [{ tick: visitTick, calendarTick: visitTick, position: libraryPosition }],
    workSpans: [{ firstTick: visitTick + 1, lastTick: completedTick, firstCalendarTick: visitTick + 1, lastCalendarTick: completedTick, visitIndex: 0 }],
    navigation: emptyNavigation(), blocked: null, terminal: { kind: 'completed', tick: completedTick, calendarTick: completedTick,
      position: libraryPosition, previousPhase: 'working', consumed: [], released: [] } };
}
function upgradeSource(): SectUpgradeJobV10 {
  return { jobId: 'sect-upgrade:1', reservationId: 'sect-upgrade-reservation:2', workerId: 'entity:4', buildingId: alchemyId,
    fromLevel: 1, toLevel: 2, requiredTicks: 400, researchGate: herbal,
    site: { buildingId: alchemyId, definitionId: 'alchemy.v9', sourceJobId: 'sect-construction:5', position: alchemyPosition,
      level: 1, firstMaintenanceCalendarTick: 2150 }, storageId: 'local-storage', storagePosition: alchemyPosition,
    seatToken: alchemyId, entranceToken: '4,3', startedTick: 1200, startedCalendarTick: 1200, origin: alchemyPosition,
    phase: 'completed', storageVisit: { tick: 1201, calendarTick: 1201, position: alchemyPosition },
    siteVisits: [{ tick: 1210, calendarTick: 1210, position: alchemyPosition }],
    workSpans: [{ firstTick: 1211, lastTick: 1610, firstCalendarTick: 1211, lastCalendarTick: 1610, visitIndex: 0 }],
    checkpoints: [
      { checkpointId: 'construction.half', activeTicks: 200, tick: 1410, calendarTick: 1410, position: alchemyPosition },
      { checkpointId: 'construction.remainder', activeTicks: 400, tick: 1610, calendarTick: 1610, position: alchemyPosition },
    ], activeTicks: 400, navigation: emptyNavigation(), blocked: null,
    terminal: { kind: 'completed', tick: 1610, calendarTick: 1610, position: alchemyPosition, previousPhase: 'working',
      resultLevel: 2, cancellation: null, consumed: [], released: [], upgradeRevision: 401 } };
}
function powder(recipeId: 'craft.wound-powder.v9' | 'craft.wound-powder-alt.v9' = 'craft.wound-powder-alt.v9', level: 1 | 2 = 2,
  startedTick = 1620): SectProductionJobV10 {
  const productiveSite = { kind: 'placed' as const, siteId: alchemyId, position: alchemyPosition, sourceJobId: 'sect-construction:5',
    level, firstMaintenanceCalendarTick: 2150, ...(level === 2 ? { upgradeJobId: 'sect-upgrade:1' } : {}) };
  // Intentional fixture union: callers can construct forbidden recipe/level combinations for rejection tests.
  return { transactionId: 'sect-production:1', reservationId: 'sect-production-reservation:2', recipeId, workerId: 'entity:2',
    researchGate: recipeId === 'craft.wound-powder.v9' ? basic : herbal, state: 'Running', activeTicks: 0,
    requiredTicks: recipeId === 'craft.wound-powder.v9' ? 160 : 200, startedTick, startedCalendarTick: startedTick,
    origin: alchemyPosition, productiveSite, blockedReason: null, phase: 'TravellingToWork', worksiteId: alchemyId,
    storageId: null, navigation: emptyNavigation(), seatSiteId: alchemyId, workVisit: null, deliveryVisit: null, workSpans: [], terminal: null } as SectProductionJobV10;
}
function historicalPowder(): SectProductionJobV10 {
  return { ...powder('craft.wound-powder.v9', 1, 970), phase: 'Done', state: 'Committed', activeTicks: 160,
    worksiteId: null, seatSiteId: null, workVisit: { tick: 974, calendarTick: 974, position: alchemyPosition },
    workSpans: [{ firstTick: 975, lastTick: 1134, firstCalendarTick: 975, lastCalendarTick: 1134 }],
    deliveryVisit: { tick: 1138, calendarTick: 1138, position: alchemyPosition },
    terminal: { kind: 'completed', tick: 1139, calendarTick: 1139, position: alchemyPosition,
      previousPhase: 'AwaitingDelivery', consumed: [], released: [], outputs: [{ ledger: 'sect', resourceId: 'wound-powder', quantity: 1 }] } };
}
function localRecordStageFixture(job: SectProductionJobV10 = powder()): SectUpgradeFrameV10 {
  const world = createWorld('v10-consumer-gate-local-record-stage');
  const library = constructionSource('library.v9', 1, 0, 340);
  const alchemy = constructionSource('alchemy.v9', 5, 620, 950);
  const construction = createConstructionFrame({ map: world.map,
    legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    people: [], ledger: { inventory: world.inventory, stock: createEmptySectStock(), reservations: [] }, simulationTick: 2000, calendarTick: 2000 });
  return { schemaVersion: 2,
    construction: { ...construction, buildings: [library.building, alchemy.building], blueprints: [library.bp, alchemy.bp], jobs: [library.job, alchemy.job] },
    production: { revision: 1, nextId: 3, jobs: [job], receipts: [] },
    research: { revision: 402, nextId: 5, jobs: [researchSource('basic-medicine.v9', 1, 350, 600), researchSource('herbal-compatibility.v9', 3, 620, 1030)], receipts: [] },
    maintenance: { nextId: 1, payments: [] }, care: { revision: 0, nextId: 1, jobs: [], receipts: [] },
    upgrade: { schemaVersion: 1, protocol: 'alchemy-l1-l2.1', catalogIdentity: SECT_V9_CANDIDATE_IDENTITY,
      revision: 401, nextId: 3, jobs: [upgradeSource()], receipts: [] } };
}
/** Explicit test corruption; never an admission adapter. */
const corrupt = <T>(value: T, patch: Record<string, unknown>): T => ({ ...value, ...patch });
const withJob = (frame: SectUpgradeFrameV10, job: SectProductionJobV10): SectUpgradeFrameV10 => ({ ...frame, production: { ...frame.production, jobs: [job] } });
const withUpgrade = (frame: SectUpgradeFrameV10, job: SectUpgradeJobV10): SectUpgradeFrameV10 => ({ ...frame, upgrade: { ...frame.upgrade, jobs: [job] } });

describe('v10 fixed research consumer gates: local record stage, not whole-world admission', () => {
  it('joins the alternative herbal gate independently of the original basic-medicine blueprint', () => {
    const frame = localRecordStageFixture();
    expect(productionResearchGateV10(frame, 'craft.wound-powder-alt.v9', 1620, 1620)).toEqual(herbal);
    expect(frame.construction.blueprints[1]!.researchGate).toEqual(basic);
    expect(productionResearchGateMatchesV10(frame, frame.production.jobs[0]!)).toBe(true);
    expect(validateSectResearchConsumerGatesV10(frame)).toEqual([]);
  });
  it('keeps basic medicine for base powder produced at L2', () => {
    const job = powder('craft.wound-powder.v9'); const frame = localRecordStageFixture(job);
    expect(productionResearchGateV10(frame, job.recipeId, 1620, 1620)).toEqual(basic);
    expect(validateSectResearchConsumerGatesV10(frame)).toEqual([]);
    expect(productionResearchGateMatchesV10(frame, corrupt(job, { researchGate: herbal }))).toBe(false);
  });
  it('retains the original six-field historical L1 proof after later completion of an upgrade', () => {
    const job = historicalPowder(); const frame = localRecordStageFixture(job);
    expect(Object.keys(job.productiveSite)).toHaveLength(6);
    expect(Object.hasOwn(job.productiveSite, 'upgradeJobId')).toBe(false);
    expect(productionResearchGateMatchesV10(frame, job)).toBe(true);
    expect(validateSectResearchConsumerGatesV10(frame)).toEqual([]);
  });
  it('accepts an L2 production start at the exact completed-upgrade boundary', () => {
    const job = powder('craft.wound-powder-alt.v9', 2, 1610); const frame = localRecordStageFixture(job);
    expect(productionResearchGateMatchesV10(frame, job)).toBe(true);
    expect(productionResearchGateMatchesV10(frame, powder('craft.wound-powder-alt.v9', 2, 1609))).toBe(false);
    expect(productionResearchGateMatchesV10(frame, powder('craft.wound-powder.v9', 1, 1610))).toBe(false);
  });
  it('does not unlock the alternative on L1 or let current L2 rewrite a historical L1 proof', () => {
    const frame = localRecordStageFixture();
    expect(productionResearchGateMatchesV10(frame, powder('craft.wound-powder-alt.v9', 1, 1100))).toBe(false);
    expect(productionResearchGateMatchesV10(frame, powder('craft.wound-powder.v9', 2, 970))).toBe(false);
  });
  it('resolves exact completed research at equality, never from a later completion', () => {
    const frame = localRecordStageFixture();
    expect(productionResearchGateV10(frame, 'craft.wound-powder-alt.v9', 1029, 1029)).toBeNull();
    expect(productionResearchGateV10(frame, 'craft.wound-powder-alt.v9', 1030, 1030)).toEqual(herbal);
    expect(productionResearchGateV10(frame, 'craft.wound-powder.v9', 599, 599)).toBeNull();
    expect(productionResearchGateV10(frame, 'craft.wound-powder.v9', 600, 600)).toEqual(basic);
  });
  it.each(['absent', 'cancelled', 'duplicate'] as const)('rejects %s completed herbal authority', mode => {
    const frame = localRecordStageFixture(); const job = frame.research.jobs[1]!;
    const jobs = mode === 'absent' ? [frame.research.jobs[0]!] : mode === 'cancelled'
      ? [frame.research.jobs[0]!, corrupt(job, { terminal: { ...job.terminal!, kind: 'cancelled' } })]
      : [...frame.research.jobs, { ...job, jobId: 'sect-research:5' }];
    const changed = { ...frame, research: { ...frame.research, jobs } };
    expect(productionResearchGateV10(changed, 'craft.wound-powder-alt.v9', 1620, 1620)).toBeNull();
    expect(validateSectResearchConsumerGatesV10(changed)[0]?.code).toBe('INVALID_RESEARCH_GATE');
  });
  it.each([
    {}, { researchId: 'basic-medicine.v9', completionJobId: herbal.completionJobId },
    { researchId: herbal.researchId, completionJobId: basic.completionJobId },
    { ...herbal, completionJobId: 'sect-research:999' }, { ...herbal, extra: true }, null, undefined,
  ])('rejects an inexact alternative completion reference %#', researchGate => {
    const frame = localRecordStageFixture(); const job = corrupt(frame.production.jobs[0]!, { researchGate });
    expect(productionResearchGateMatchesV10(frame, job)).toBe(false);
  });
  it('does not replace the original blueprint gate with the later herbal gate', () => {
    const frame = localRecordStageFixture();
    const changed = { ...frame, construction: { ...frame.construction, blueprints: frame.construction.blueprints.map(bp =>
      bp.definitionId === 'alchemy.v9' ? { ...bp, researchGate: herbal } : bp) } };
    expect(productionResearchGateMatchesV10(changed, changed.production.jobs[0]!)).toBe(false);
    expect(validateSectResearchConsumerGatesV10(changed)).toEqual([{ code: 'INVALID_RESEARCH_GATE', path: 'sect-blueprint:5' }]);
  });
  it('checks basic-medicine completion at blueprint placement as well as construction start', () => {
    const frame = localRecordStageFixture();
    const changed = { ...frame, construction: { ...frame.construction, blueprints: frame.construction.blueprints.map(bp =>
      bp.definitionId === 'alchemy.v9' ? { ...bp, placedTick: 599, placedCalendarTick: 599 } : bp) } };
    expect(validateSectResearchConsumerGatesV10(changed)).toEqual([{ code: 'INVALID_RESEARCH_GATE', path: 'sect-blueprint:5' }]);
  });
  it.each([
    { upgradeJobId: undefined }, { upgradeJobId: null }, { upgradeJobId: 'sect-upgrade:3' }, { extra: true },
    { kind: 'legacy-point' }, { level: 1 }, { sourceJobId: 'sect-construction:1' }, { siteId: libraryId },
    { position: { x: 4, y: 1 } }, { firstMaintenanceCalendarTick: 2200 },
  ])('rejects an inexact L2 proof/source join %#', patch => {
    const frame = localRecordStageFixture(); const original = frame.production.jobs[0]!;
    const job = corrupt(original, { productiveSite: corrupt(original.productiveSite, patch) });
    expect(productionResearchGateMatchesV10(frame, job)).toBe(false);
  });
  it('rejects a missing L2 upgrade field and explicit undefined on historical L1', () => {
    const frame = localRecordStageFixture(); const original = frame.production.jobs[0]!;
    const { upgradeJobId: _ignored, ...inexact } = original.productiveSite;
    expect(productionResearchGateMatchesV10(frame, corrupt(original, { productiveSite: inexact }))).toBe(false);
    const old = powder('craft.wound-powder.v9', 1, 970);
    expect(productionResearchGateMatchesV10(frame, corrupt(old, { productiveSite: { ...old.productiveSite, upgradeJobId: undefined } }))).toBe(false);
  });
  it.each(['missing', 'active', 'cancelled', 'other-building', 'other-source', 'duplicate'] as const)('rejects %s upgrade evidence', mode => {
    const frame = localRecordStageFixture(); const upgrade = frame.upgrade.jobs[0]!;
    let changed = frame;
    if (mode === 'missing') changed = { ...frame, upgrade: { ...frame.upgrade, jobs: [] } };
    if (mode === 'active') changed = withUpgrade(frame, corrupt(upgrade, { terminal: null, phase: 'working' }));
    if (mode === 'cancelled') changed = withUpgrade(frame, corrupt(upgrade, { terminal: { ...upgrade.terminal!, kind: 'cancelled', resultLevel: 1 } }));
    if (mode === 'other-building') changed = withUpgrade(frame, { ...upgrade, buildingId: libraryId });
    if (mode === 'other-source') changed = withUpgrade(frame, { ...upgrade, site: { ...upgrade.site, sourceJobId: 'sect-construction:1' } });
    if (mode === 'duplicate') changed = { ...frame, upgrade: { ...frame.upgrade, jobs: [upgrade, { ...upgrade, jobId: 'sect-upgrade:3' }] } };
    expect(productionResearchGateMatchesV10(changed, changed.production.jobs[0]!)).toBe(false);
  });
  it.each(['future-construction', 'wrong-building-result', 'mismatched-origin-clock'] as const)('rejects %s construction provenance', mode => {
    const frame = localRecordStageFixture(); const source = frame.construction.jobs[1]!;
    const broken = mode === 'future-construction' ? corrupt(source, { terminal: { ...source.terminal!, tick: 1621, calendarTick: 1621 } })
      : mode === 'wrong-building-result' ? { ...source, resultBuildingId: libraryId }
      : corrupt(source, { terminal: { ...source.terminal!, calendarTick: 949 } });
    const changed = { ...frame, construction: { ...frame.construction, jobs: [frame.construction.jobs[0]!, broken] } };
    expect(productionResearchGateMatchesV10(changed, changed.production.jobs[0]!)).toBe(false);
  });
  it.each([[1620, 1619], [2001, 2001], [-1, -1], [1.5, 1.5], [NaN, NaN], [Infinity, Infinity]])('rejects invalid query clocks %s/%s', (tick, calendarTick) => {
    const frame = localRecordStageFixture();
    expect(productionResearchGateV10(frame, 'craft.wound-powder-alt.v9', tick!, calendarTick!)).toBeNull();
  });
  it.each([[2000, 1999], [Infinity, Infinity]])('rejects inexact authoritative clocks %s/%s', (tick, calendarTick) => {
    const frame = localRecordStageFixture();
    const changed = { ...frame, construction: { ...frame.construction, lastSimulationTick: tick!, lastCalendarTick: calendarTick! } };
    expect(productionResearchGateV10(changed, 'craft.wound-powder-alt.v9', 1620, 1620)).toBeNull();
  });
  it('rejects mismatched or future research and upgrade completion clocks', () => {
    const frame = localRecordStageFixture(); const research = frame.research.jobs[1]!; const upgrade = frame.upgrade.jobs[0]!;
    const changedResearch = { ...frame, research: { ...frame.research, jobs: [frame.research.jobs[0]!,
      corrupt(research, { terminal: { ...research.terminal!, calendarTick: 1031 } })] } };
    expect(productionResearchGateMatchesV10(changedResearch, frame.production.jobs[0]!)).toBe(false);
    for (const calendarTick of [1609, 1621]) {
      const changed = withUpgrade(frame, corrupt(upgrade, { terminal: { ...upgrade.terminal!, calendarTick } }));
      expect(productionResearchGateMatchesV10(changed, frame.production.jobs[0]!)).toBe(false);
    }
  });
  it.each(['gather.stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9'] as const)('keeps the exact old ungated %s record', recipeId => {
    let frame = localRecordStageFixture(); const original = frame.production.jobs[0]!;
    const recipe = getSectRecipeDefinition(recipeId)!;
    let productiveSite: SectProductionSiteProofV10;
    if (recipe.workstation.kind === 'legacy-point') {
      const blueprintId = recipe.workstation.blueprintId;
      const station = frame.construction.legacyStations.find(value => value.blueprintId === blueprintId)!;
      productiveSite = { kind: 'legacy-point', siteId: station.id, position: { x: station.x, y: station.y }, level: 0,
        sourceJobId: null, firstMaintenanceCalendarTick: null };
    } else productiveSite = { kind: 'placed', siteId: libraryId, position: libraryPosition, level: 1,
      sourceJobId: 'sect-construction:1', firstMaintenanceCalendarTick: 1540 };
    const { researchGate: _ignored, ...ungated } = original;
    const job = corrupt(ungated, { recipeId, productiveSite, requiredTicks: recipe.workTicks }) as SectProductionJobV10;
    frame = withJob(frame, job);
    expect(productionResearchGateV10(frame, recipeId, 1620, 1620)).toBeNull();
    expect(validateSectResearchConsumerGatesV10(frame)).toEqual([]);
    expect(validateSectResearchConsumerGatesV10(withJob(frame, corrupt(job, { researchGate: undefined })))[0]?.code).toBe('INVALID_RESEARCH_GATE');
    expect(validateSectResearchConsumerGatesV10(withJob(frame, corrupt(job, { productiveSite: { ...productiveSite, upgradeJobId: undefined } })))[0]?.code).toBe('INVALID_RESEARCH_GATE');
    expect(validateSectResearchConsumerGatesV10(withJob(frame, corrupt(job, { productiveSite: original.productiveSite })))[0]?.code).toBe('INVALID_RESEARCH_GATE');
  });
  it('does not infer a recipe unlock from matching wound-powder output', () => {
    const frame = localRecordStageFixture();
    const job = corrupt(frame.production.jobs[0]!, { recipeId: 'craft.fake-powder.v9', outputs: getSectRecipeDefinition('craft.wound-powder-alt.v9')!.outputs });
    expect(productionResearchGateV10(frame, job.recipeId as SectRecipeId, 1620, 1620)).toBeNull();
    expect(validateSectResearchConsumerGatesV10(withJob(frame, job))).toEqual([{ code: 'INVALID_RESEARCH_GATE', path: job.transactionId }]);
  });
  it('returns isolated references and never rewrites immutable L1 origin or shared histories', () => {
    const frame = localRecordStageFixture(); const before = canonicalStringify(frame);
    const first = productionResearchGateV10(frame, 'craft.wound-powder-alt.v9', 1620, 1620)!;
    const second = productionResearchGateV10(frame, 'craft.wound-powder-alt.v9', 1620, 1620)!;
    expect(first).not.toBe(second);
    expect(first).not.toBe(frame.upgrade.jobs[0]!.researchGate);
    expect(validateSectResearchConsumerGatesV10(frame)).toEqual([]);
    expect(canonicalStringify(frame)).toBe(before);
    expect(frame.construction.buildings[1]!.level).toBe(1);
  });
});
