import { beforeAll, describe, expect, it } from 'vitest';
import { SECT_V9_CANDIDATE_IDENTITY } from '../../src/content/sect-v9/catalog';
import type { SectResearchId } from '../../src/content/sect-v9/types';
import { createEmptySectStock } from '../../src/content/sect-v9/validation';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { createConstructionFrame } from '../../src/core/sect-expansion/construction';
import { applySectMaintenanceConstructionCommand, applySectMaintenanceResearchCommand, createSectMaintenanceFrame,
  tickSectMaintenance } from '../../src/core/sect-expansion/maintenance';
import { sectBuildingPaidRange } from '../../src/core/sect-expansion/maintenance-periods';
import type { SectMaintenanceContext, SectMaintenanceFrame, SectMaintenanceResult } from '../../src/core/sect-expansion/maintenance-types';
import { validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';
import { sectBuildingL1PaidRangeV10, validateSectMaintenanceL1RecordsV10,
  validateSectMaintenanceRecordsV10, validateSectUpgradeResearchPrerequisitesV10 } from '../../src/core/sect-expansion/maintenance-v10';
import { createSectProductionFrame } from '../../src/core/sect-expansion/production';
import { createSectResearchFrame } from '../../src/core/sect-expansion/research';
import { validateMaintainedSectResearchRecords, validateMaintainedSectResearchSourceRecords } from '../../src/core/sect-expansion/research-validation';
import type { SectUpgradeFrameV10 } from '../../src/core/sect-expansion/upgrade-types';
import { createWorld } from '../../src/core/world/create-world';

const context = (frame: SectMaintenanceFrame): SectMaintenanceContext => ({
  simulationTick: frame.construction.lastSimulationTick, calendarTick: frame.construction.lastCalendarTick,
  mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [],
});
function accept(result: SectMaintenanceResult): SectMaintenanceFrame {
  if (!result.ok) throw new Error(`${result.code}: ${JSON.stringify(validateSectMaintenanceFrame(result.frame))}`);
  return result.frame;
}
function step(frame: SectMaintenanceFrame): SectMaintenanceFrame {
  const ctx = { ...context(frame), simulationTick: frame.construction.lastSimulationTick + 1, calendarTick: frame.construction.lastCalendarTick + 1 };
  return accept(tickSectMaintenance(frame, ctx, createWorkPathBudget(ctx.simulationTick)));
}
function until(frame: SectMaintenanceFrame, done: (value: SectMaintenanceFrame) => boolean): SectMaintenanceFrame {
  for (let n = 0; n < 900 && !done(frame); n++) frame = step(frame);
  if (!done(frame)) throw new Error('Leaf fixture work did not finish'); return frame;
}
function atBoundary(frame: SectMaintenanceFrame, tick: number): SectMaintenanceFrame {
  return { ...frame, construction: { ...frame.construction, lastSimulationTick: tick, lastCalendarTick: tick } };
}
function build(frame: SectMaintenanceFrame, definitionId: 'library.v9' | 'alchemy.v9', x: number): SectMaintenanceFrame {
  frame = accept(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'blueprint.place',
    commandId: `leaf.place.${frame.construction.revision}`, expectedRevision: frame.construction.revision,
    placement: { definitionId, anchor: { x, y: 1 }, rotation: 0 } }));
  frame = accept(applySectMaintenanceConstructionCommand(frame, context(frame), { kind: 'construction.start',
    commandId: `leaf.build.${frame.construction.revision}`, expectedRevision: frame.construction.revision,
    blueprintId: frame.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' }));
  return until(frame, value => value.construction.jobs.at(-1)!.terminal?.kind === 'completed');
}
function research(frame: SectMaintenanceFrame, researchId: SectResearchId): SectMaintenanceFrame {
  frame = accept(applySectMaintenanceResearchCommand(frame, context(frame), { kind: 'research.start',
    commandId: `leaf.research.${frame.research.revision}`, expectedRevision: frame.research.revision,
    researchId, workerId: 'entity:2' }));
  return until(frame, value => value.research.jobs.at(-1)!.terminal?.kind === 'completed');
}
function promoteRecords(frame: SectMaintenanceFrame): SectUpgradeFrameV10 {
  if (frame.production.jobs.length) throw new Error('This leaf fixture has no production records');
  return { ...frame, schemaVersion: 2, construction: { ...frame.construction,
    buildings: frame.construction.buildings.map(building => ({ ...building, level: 1 as const })) },
  production: { ...frame.production, jobs: [] },
  care: { revision: 0, nextId: 1, jobs: [], receipts: [] },
  upgrade: { schemaVersion: 1, protocol: 'alchemy-l1-l2.1', catalogIdentity: cloneJson(SECT_V9_CANDIDATE_IDENTITY),
    revision: 0, nextId: 1, jobs: [], receipts: [] } };
}
/** Explicit local record-stage fixture: starting balances and clock gaps are boundary inputs,
 * not claimed as resource provenance or a v10 migration. Construction, research, visits,
 * work spans, maintenance payments and paired debits below all use actual v9 reducers. */
function seed(): SectMaintenanceFrame {
  const world = createWorld('maintenance-v10-record-leaves');
  for (const entry of Object.values(world.inventory)) entry.owned = Math.min(80, entry.capacity);
  const empty = createEmptySectStock();
  const stock = { ...empty, 'spirit-stone': { ...empty['spirit-stone'], owned: 6 }, 'basic-insight': { ...empty['basic-insight'], owned: 6 } };
  return createSectMaintenanceFrame(createSectResearchFrame(createSectProductionFrame(createConstructionFrame({
    map: world.map, simulationTick: 0, calendarTick: 0,
    legacyStations: world.buildings.map(site => ({ id: site.id, blueprintId: site.blueprintId, x: site.x, y: site.y, operational: site.operational })),
    people: world.disciples.map(person => ({ id: person.id, position: person.position, lifeState: person.lifeState,
      canWork: person.canWork, away: false, productionTransactionId: null, cultivationOwnerId: null, otherOwnerId: null })),
    ledger: { inventory: world.inventory, stock, reservations: [] },
  }))));
}

let library: SectMaintenanceFrame; let researched: SectMaintenanceFrame; let paid: SectMaintenanceFrame; let frame: SectUpgradeFrameV10;
beforeAll(() => { library = build(seed(), 'library.v9', 1); });
beforeAll(() => {
  const due = library.construction.buildings[0]!.firstMaintenanceCalendarTick;
  // Basic medicine's real work spans cross the first expiry, requiring real renewal proof.
  researched = research(atBoundary(library, due - 2), 'basic-medicine.v9');
});
beforeAll(() => { researched = research(researched, 'herbal-compatibility.v9'); });
beforeAll(() => {
  const alchemy = build(researched, 'alchemy.v9', 10);
  const due = alchemy.construction.buildings.at(-1)!.firstMaintenanceCalendarTick;
  paid = step(atBoundary(alchemy, due - 1)); frame = promoteRecords(paid);
});

describe('v10 early maintenance accounting stage', () => {
  it('preserves every old payment and authenticates all untagged payments without changing the source', () => {
    const before = canonicalStringify(frame);
    expect(validateSectMaintenanceFrame(paid)).toEqual([]);
    expect(validateSectMaintenanceL1RecordsV10(frame)).toEqual([]);
    expect(validateSectUpgradeResearchPrerequisitesV10(frame)).toEqual([]);
    expect(frame.maintenance).toEqual(paid.maintenance);
    expect(frame.maintenance.payments.every(payment => Object.keys(payment).length === 9)).toBe(true);
    expect(canonicalStringify(frame)).toBe(before);
  });
  it('admits only the exact alchemy L2 rate shape at this early, deliberately incomplete stage', () => {
    const tagged = cloneJson(frame) as any;
    tagged.maintenance.payments.at(-1).rate = { level: 2, upgradeJobId: 'sect-upgrade:1' };
    // No completed upgrade and only the old L1 debit: final v10 authentication remains required.
    expect(validateSectMaintenanceL1RecordsV10(tagged)).toEqual([]);
    expect(validateSectUpgradeResearchPrerequisitesV10(tagged)).toEqual([]);
    for (const rate of [undefined, null, {}, { level: 1, upgradeJobId: 'sect-upgrade:1' },
      { level: 2, upgradeJobId: 'sect-upgrade:01' }, { level: 2, upgradeJobId: 'sect-upgrade:9007199254740992' },
      { level: 2, upgradeJobId: 'sect-upgrade:1', trusted: true }]) {
      tagged.maintenance.payments.at(-1).rate = rate;
      expect(validateSectMaintenanceL1RecordsV10(tagged).length).toBeGreaterThan(0);
    }
  });
  it('never permits library rates, even before the final upgrade/rate stage', () => {
    const tagged = cloneJson(frame) as any;
    tagged.maintenance.payments[0].rate = { level: 2, upgradeJobId: 'sect-upgrade:1' };
    expect(validateSectMaintenanceL1RecordsV10(tagged)).toEqual([{ code: 'INVALID_MAINTENANCE_RATE', path: tagged.maintenance.payments[0].paymentId }]);
  });
  it.each(['library.v9', 'alchemy.v9'] as const)('requires a complete immutable L1 debit for %s', definitionId => {
    const broken = cloneJson(frame) as any;
    const building = broken.construction.buildings.find((value: any) => value.definitionId === definitionId);
    const payment = broken.maintenance.payments.find((value: any) => value.buildingId === building.buildingId);
    const claim = broken.construction.ledger.reservations.find((value: any) => value.reservationId === payment.reservationId);
    claim.base.consumed = [];
    expect(validateSectMaintenanceL1RecordsV10(broken)).toEqual([{ code: 'INVALID_MAINTENANCE_PAYMENT', path: payment.paymentId }]);
  });
  it.each(['source', 'predecessor', 'due', 'future', 'id', 'order'] as const)('checks %s even on deferred L2 records', field => {
    const broken = cloneJson(frame) as any;
    const payment = broken.maintenance.payments.at(-1);
    payment.rate = { level: 2, upgradeJobId: 'sect-upgrade:1' };
    if (field === 'source') payment.sourceJobId = broken.construction.buildings[0].sourceJobId;
    if (field === 'predecessor') payment.predecessorPaymentId = broken.maintenance.payments[0].paymentId;
    if (field === 'due') payment.dueCalendarTick++;
    if (field === 'future') { payment.paidTick++; payment.paidCalendarTick++; payment.dueCalendarTick++; }
    if (field === 'id') payment.reservationId = 'sect-maintenance-reservation:2';
    if (field === 'order') broken.maintenance.payments.reverse();
    expect(validateSectMaintenanceL1RecordsV10(broken).length).toBeGreaterThan(0);
  });
  it('checks L1 settlement IDs, outputs, policy and checkpoints', () => {
    for (const mutate of [
      (claim: any) => { claim.sect.settlement.operationId = 'maintain:another'; },
      (claim: any) => { claim.base.settlement.outputs = [{ resourceId: 'wood', quantity: 1 }]; },
      (claim: any) => { claim.policy = 'construction-checkpoints'; },
      (claim: any) => { claim.sect.checkpoints = [{ checkpointId: 'construction.half', lines: [] }]; },
      (claim: any) => { claim.base.remainingReservation = [{ resourceId: 'wood', quantity: 1 }]; },
    ]) {
      const broken = cloneJson(frame) as any; const payment = broken.maintenance.payments[0];
      mutate(broken.construction.ledger.reservations.find((claim: any) => claim.reservationId === payment.reservationId));
      expect(validateSectMaintenanceL1RecordsV10(broken)).toEqual([{ code: 'INVALID_MAINTENANCE_PAYMENT', path: payment.paymentId }]);
    }
  });
  it('rejects sparse/null/accessor/extra-field payment records without evaluating getters', () => {
    let reads = 0;
    const accessor = cloneJson(frame.maintenance.payments[0]!);
    Object.defineProperty(accessor, 'paidTick', { enumerable: true, get: () => { reads++; return 0; } });
    for (const payments of [[null], [,], [accessor], [{ ...frame.maintenance.payments[0]!, trusted: true }]]) {
      expect(validateSectMaintenanceL1RecordsV10({ ...frame, maintenance: { ...frame.maintenance, payments } } as any).length).toBeGreaterThan(0);
    }
    expect(reads).toBe(0);
  });
  it('keeps old root rejection and its exact nine-field payment contract', () => {
    expect(validateSectMaintenanceFrame(frame)).toEqual([{ code: 'INVALID_SHAPE', path: 'frame' }]);
    const tagged = cloneJson(paid) as any;
    tagged.maintenance.payments.at(-1).rate = { level: 2, upgradeJobId: 'sect-upgrade:1' };
    expect(validateSectMaintenanceFrame(tagged)).toEqual([{ code: 'INVALID_PAYMENT', path: 'maintenance.payments' }]);
  });
});

describe('fixed one-source research and historical L1 paid leaves', () => {
  it('keeps v9 maintained wrapper outcomes and accepts the narrow structural source', () => {
    const source = { construction: frame.construction, research: frame.research, maintenance: frame.maintenance };
    expect(validateMaintainedSectResearchRecords(paid)).toEqual([]);
    expect(validateMaintainedSectResearchSourceRecords(source)).toEqual(validateMaintainedSectResearchRecords(paid));
  });
  it.each(['prerequisite', 'work', 'receipt', 'site', 'cost'] as const)('retains research %s evidence checks', field => {
    const broken = cloneJson(frame) as any; const job = broken.research.jobs.at(-1);
    if (field === 'prerequisite') job.prerequisites[0].completionJobId = job.jobId;
    if (field === 'work') job.activeTicks--;
    if (field === 'receipt') broken.research.receipts.pop();
    if (field === 'site') job.site.sourceJobId = broken.construction.buildings.at(-1).sourceJobId;
    if (field === 'cost') broken.construction.ledger.reservations.find((claim: any) => claim.reservationId === job.reservationId).sect.lines[0].quantity++;
    const old = { ...paid, construction: broken.construction, research: broken.research };
    const issues = validateSectUpgradeResearchPrerequisitesV10(broken);
    expect(issues.length).toBeGreaterThan(0); expect(issues).toEqual(validateMaintainedSectResearchRecords(old));
  });
  it('retains required library renewal evidence across real research work', () => {
    const job = frame.research.jobs[0]!; const building = frame.construction.buildings[0]!;
    expect(job.workSpans.at(-1)!.lastCalendarTick).toBeGreaterThan(building.firstMaintenanceCalendarTick);
    const missing = { ...frame, maintenance: { ...frame.maintenance, payments: frame.maintenance.payments.slice(1) } };
    expect(validateSectUpgradeResearchPrerequisitesV10(missing).length).toBeGreaterThan(0);
  });
  it('covers contiguous L1 ranges, but never treats tagged L2 periods as upgrade funding', () => {
    const payment = frame.maintenance.payments.at(-1)!; const building = frame.construction.buildings.at(-1)!;
    const start = building.firstMaintenanceCalendarTick - 1; const end = payment.paidTick;
    expect(sectBuildingL1PaidRangeV10(frame, building.buildingId, start, end, start, end)).toBe(true);
    expect(sectBuildingPaidRange(frame, building.buildingId, start, end, start, end)).toBe(true);
    const tagged = cloneJson(frame) as any; tagged.maintenance.payments.at(-1).rate = { level: 2, upgradeJobId: 'sect-upgrade:1' };
    expect(sectBuildingL1PaidRangeV10(tagged, building.buildingId, start, start, start, start)).toBe(true);
    expect(sectBuildingL1PaidRangeV10(tagged, building.buildingId, start, end, start, end)).toBe(false);
    expect(sectBuildingL1PaidRangeV10(tagged, building.buildingId, end, end, end, end)).toBe(false);
  });
  it('retains tagged-payment clock anchors when answering L1 range queries', () => {
    const broken = cloneJson(frame) as any; const building = broken.construction.buildings.at(-1);
    const tick = building.completedTick;
    // Deliberately invalid deferred-rate anchor. Removing it would hide the backdating.
    broken.maintenance.payments.at(-1).rate = { level: 2, upgradeJobId: 'sect-upgrade:1' };
    broken.maintenance.payments.at(-1).paidTick = tick - 1;
    expect(sectBuildingL1PaidRangeV10(broken, building.buildingId, tick, tick, tick, tick)).toBe(false);
  });
  it('rejects reversed, future, unequal-clock and invalid numeric L1 queries', () => {
    const building = frame.construction.buildings.at(-1)!; const tick = building.completedTick;
    for (const range of [[tick + 1, tick, tick + 1, tick], [tick, tick, tick - 1, tick - 1],
      [NaN, tick, tick, tick], [-1, tick, -1, tick], [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1]]) {
      expect(sectBuildingL1PaidRangeV10(frame, building.buildingId, range[0]!, range[1]!, range[2]!, range[3]!)).toBe(false);
    }
    expect(sectBuildingL1PaidRangeV10(frame, 'missing', tick, tick, tick, tick)).toBe(false);
  });
});

/** Deliberately narrow rate-stage anchor fixture, not a valid upgrade job or admitted frame.
 * Genuine upgrade work/settlement authentication is the preceding stage's independent duty.
 * This isolates phase ordering and the rate validator's own exact settlement checks. */
function rateStageFixture(completedOffset: number, l2: boolean): SectUpgradeFrameV10 {
  const source = cloneJson(frame) as any; const payment = source.maintenance.payments.at(-1);
  const tick = payment.paidTick + completedOffset;
  source.construction.lastSimulationTick = Math.max(source.construction.lastSimulationTick, tick);
  source.construction.lastCalendarTick = Math.max(source.construction.lastCalendarTick, tick);
  source.upgrade.jobs = [{ jobId: 'sect-upgrade:1', buildingId: payment.buildingId,
    terminal: { kind: 'completed', tick, calendarTick: tick } }];
  if (l2) {
    payment.rate = { level: 2, upgradeJobId: 'sect-upgrade:1' };
    const claim = source.construction.ledger.reservations.find((value: any) => value.reservationId === payment.reservationId);
    const lines = [{ resourceId: 'wood', quantity: 2 }, { resourceId: 'herbs', quantity: 1 }];
    claim.base.lines = cloneJson(lines); claim.base.consumed = cloneJson(lines);
    source.construction.ledger.inventory.wood.owned--; source.construction.ledger.inventory.herbs.owned--;
  }
  return source;
}

describe('final v10 historical-rate record leaf after upgrade authentication', () => {
  it('keeps every historical L1 payment unchanged when no completed upgrade exists', () => {
    expect(validateSectMaintenanceRecordsV10(frame)).toEqual([]);
    const tagged = cloneJson(frame) as any;
    tagged.maintenance.payments.at(-1).rate = { level: 2, upgradeJobId: 'sect-upgrade:1' };
    expect(validateSectMaintenanceRecordsV10(tagged)).toEqual([{ code: 'INVALID_MAINTENANCE_RATE', path: tagged.maintenance.payments.at(-1).paymentId }]);
  });
  it.each([-1, 0, 1])('uses the maintenance-before-upgrade boundary when completion offset is %s', offset => {
    const correct = rateStageFixture(offset, offset < 0);
    const originalDue = frame.maintenance.payments.at(-1)!.dueCalendarTick;
    expect(validateSectMaintenanceRecordsV10(correct)).toEqual([]);
    expect(correct.maintenance.payments.at(-1)!.dueCalendarTick).toBe(originalDue);
    expect(correct.construction.buildings).toEqual(frame.construction.buildings);
    const wrong = rateStageFixture(offset, offset >= 0);
    expect(validateSectMaintenanceRecordsV10(wrong)).toEqual([{ code: 'INVALID_MAINTENANCE_RATE', path: wrong.maintenance.payments.at(-1)!.paymentId }]);
  });
  it('requires the matching unique completion reference and rejects a double completion', () => {
    const mismatch = rateStageFixture(-1, true) as any;
    mismatch.maintenance.payments.at(-1).rate.upgradeJobId = 'sect-upgrade:3';
    expect(validateSectMaintenanceRecordsV10(mismatch)[0]?.code).toBe('INVALID_MAINTENANCE_RATE');
    const duplicate = rateStageFixture(-1, true) as any;
    duplicate.upgrade.jobs.push({ ...cloneJson(duplicate.upgrade.jobs[0]), jobId: 'sect-upgrade:3' });
    expect(validateSectMaintenanceRecordsV10(duplicate)[0]?.code).toBe('INVALID_MAINTENANCE_RATE');
  });
  it.each(['wood', 'herbs', 'settlement', 'outputs', 'remaining', 'checkpoint'] as const)('authenticates L2 %s accounting exactly', field => {
    const broken = rateStageFixture(-1, true) as any; const payment = broken.maintenance.payments.at(-1);
    const claim = broken.construction.ledger.reservations.find((value: any) => value.reservationId === payment.reservationId);
    if (field === 'wood') claim.base.consumed[0].quantity--;
    if (field === 'herbs') { claim.base.lines.pop(); claim.base.consumed.pop(); }
    if (field === 'settlement') claim.sect.settlement.operationId = 'maintain:other';
    if (field === 'outputs') claim.sect.settlement.outputs = [{ resourceId: 'wound-powder', quantity: 1 }];
    if (field === 'remaining') claim.base.remainingReservation = [{ resourceId: 'herbs', quantity: 1 }];
    if (field === 'checkpoint') claim.base.checkpoints = [{ checkpointId: 'construction.half', lines: [] }];
    expect(validateSectMaintenanceL1RecordsV10(broken)).toEqual([]);
    expect(validateSectMaintenanceRecordsV10(broken)).toEqual([{ code: 'INVALID_MAINTENANCE_PAYMENT', path: payment.paymentId }]);
  });
  it('rechecks the early stage instead of ignoring an invalid old L1 debit beside L2 history', () => {
    const broken = rateStageFixture(-1, true) as any; const payment = broken.maintenance.payments[0];
    const claim = broken.construction.ledger.reservations.find((value: any) => value.reservationId === payment.reservationId);
    claim.base.consumed = [];
    expect(validateSectMaintenanceRecordsV10(broken)).toEqual([{ code: 'INVALID_MAINTENANCE_PAYMENT', path: payment.paymentId }]);
  });
});
