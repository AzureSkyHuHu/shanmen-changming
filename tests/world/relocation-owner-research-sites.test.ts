import { beforeAll, describe, expect, it } from 'vitest';
import { getSectResearchDefinition } from '../../src/content/sect-v9/catalog';
import { createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { createSaveEnvelopeV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import type { ConstructionCommand, ConstructionContext } from '../../src/core/sect-expansion/construction-types';
import { validateSectMaintenanceL1RecordsV10, validateSectMaintenanceL1SourceRecords, validateSectUpgradeResearchPrerequisitesV10 } from '../../src/core/sect-expansion/maintenance-v10';
import type { SectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-types';
import { validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';
import { createSectRelocationRuntime } from '../../src/core/sect-expansion/relocation-runtime';
import type { SectRelocationRuntimeFrame } from '../../src/core/sect-expansion/relocation-runtime-types';
import type { SectRelocationCommand } from '../../src/core/sect-expansion/relocation-types';
import { createSectRelocationState } from '../../src/core/sect-expansion/relocation-validation';
import { validateMaintainedSectResearchRecords, validateMaintainedSectResearchSourceRecords,
  validateRelocationOwnerResearchSourceRecords } from '../../src/core/sect-expansion/research-validation';
import type { SectUpgradeFrameV10 } from '../../src/core/sect-expansion/upgrade-types';
import { prepareV9ToV10Migration } from '../../src/core/world/migrate-v9-to-v10';
import { prepareConstructionRelocationCommandCandidate as commandCandidate, prepareConstructionRelocationTickCandidate as tickCandidate } from '../../src/core/world/relocation-owner/domain-composition';
import { compareRelocationHistoryEdges, relocationHistoryCommandEdge, relocationHistoryCompletionEdge,
  relocationHistoryIntersection } from '../../src/core/world/relocation-owner/history-order';
import { relocationResearchSitesFromRecordsAt } from '../../src/core/world/relocation-owner/history-sites';
import { inspectRelocationOwnerResearchRecords as inspect, relocationOwnerResearchSiteAtStart as atStart,
  relocationOwnerResearchSitesNow as sitesNow, type RelocationOwnerResearchSource as Source } from '../../src/core/world/relocation-owner/research-records';
import { inspectRelocationOwnerSpatialRecords } from '../../src/core/world/relocation-owner/spatial-records';
import { projectV9SectFrame } from '../../src/core/world/v9-sect-bridge';
import { projectV10SectFrame } from '../../src/core/world/v10-sect-frame';
import { fixtureApply, fixturePlace, fixtureProduce, fixtureResearchStart, fixtureSectCommand,
  fixtureStartConstruction, fixtureUntil, fundedRuntimeFixture } from '../sect-expansion/fixtures/v9-runtime';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
function changed<T>(source: T, change: (value: Mutable<T>) => void): Mutable<T> { const next = cloneJson(source) as Mutable<T>; change(next); return next; }
const scope = 'partial-relocation-owner-library-l1-research-records';
function frozen<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
function context(frame: SectRelocationRuntimeFrame): ConstructionContext {
  return { simulationTick: frame.records.construction.lastSimulationTick, calendarTick: frame.records.construction.lastCalendarTick,
    mode: 'management', paused: false, expeditionActive: false, externalActiveJobs: 0, externalClaims: [] };
}
function apply(frame: SectRelocationRuntimeFrame, command: ConstructionCommand | SectRelocationCommand): SectRelocationRuntimeFrame {
  const result = commandCandidate(frame, context(frame), command);
  if (!result.ok) throw new Error(`${result.code}:${result.issues.join(';')}`); return result.frame;
}
function step(frame: SectRelocationRuntimeFrame): SectRelocationRuntimeFrame {
  const ctx = { ...context(frame), simulationTick: context(frame).simulationTick + 1, calendarTick: context(frame).calendarTick + 1 };
  const result = tickCandidate(frame, ctx, createWorkPathBudget(ctx.simulationTick));
  if (!result.ok) throw new Error(`${result.code}:${result.issues.join(';')}`); return result.frame;
}
function until(frame: SectRelocationRuntimeFrame, done: (f: SectRelocationRuntimeFrame) => boolean): SectRelocationRuntimeFrame {
  for (let i = 0; i < 1600 && !done(frame); i++) frame = step(frame);
  if (!done(frame)) throw new Error('Real relocation composition did not finish'); return frame;
}
function move(frame: SectRelocationRuntimeFrame, x: number): SectRelocationRuntimeFrame {
  return apply(frame, { kind: 'relocation.start', commandId: `research-sites.move.${frame.records.relocation.nextId}`,
    expectedRevision: frame.records.relocation.revision, buildingId: frame.records.construction.buildings[0]!.buildingId,
    workerId: 'entity:2', target: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } });
}
function cancelMove(frame: SectRelocationRuntimeFrame): SectRelocationRuntimeFrame {
  return apply(frame, { kind: 'relocation.cancel', commandId: `research-sites.cancel.${frame.records.relocation.nextId}`,
    expectedRevision: frame.records.relocation.revision, jobId: frame.records.relocation.jobs.at(-1)!.jobId });
}
function build(frame: SectRelocationRuntimeFrame, x: number): SectRelocationRuntimeFrame {
  frame = apply(frame, { kind: 'blueprint.place', commandId: `research-sites.place.${frame.records.construction.nextId}`,
    expectedRevision: frame.records.construction.revision, placement: { definitionId: 'library.v9', anchor: { x, y: 1 }, rotation: 0 } });
  return apply(frame, { kind: 'construction.start', commandId: `research-sites.build.${frame.records.construction.nextId}`,
    expectedRevision: frame.records.construction.revision, blueprintId: frame.records.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:2' });
}
function source(frame: SectRelocationRuntimeFrame, old: SectMaintenanceFrame): Source {
  // Exact real records and ALL shared ledger claims are retained. No relocated
  // construction is composed into a v9/v10 World or passed to an old whole root.
  return cloneJson({ construction: frame.records.construction, relocation: frame.records.relocation, research: old.research, maintenance: old.maintenance });
}
function seed(old: SectMaintenanceFrame): SectRelocationRuntimeFrame {
  return createSectRelocationRuntime(cloneJson({ construction: old.construction, relocation: createSectRelocationState() }));
}
function code(input: unknown): string | null { const result = inspect(input); return result.ok ? null : result.issues[0]!.code; }
function allReject(input: unknown): void { expect(inspect(input).ok).toBe(false); expect(atStart(input, 'sect-research:1').ok).toBe(false); expect(sitesNow(input, 'herbal-compatibility.v9').ok).toBe(false); }
let old: SectMaintenanceFrame; let oldV10: SectUpgradeFrameV10; let cancelledOld: SectMaintenanceFrame;
let original: Source; let active: Source; let cancelledMove: Source; let moved: Source; let final: Source;
let cancelThenStart: Source; let outAndBack: Source; let laterBuild: Source;
beforeAll(() => {
  let world = fixtureStartConstruction(fixturePlace(fundedRuntimeFixture(), 'library.v9', 1));
  world = fixtureUntil(world, w => !!w.sectExpansion.construction.jobs[0]!.terminal);
  for (const recipe of ['extract.spirit-stone.v9', 'extract.spirit-stone.v9', 'study.basic-insight.v9', 'study.basic-insight.v9'] as const) world = fixtureProduce(world, recipe);
  const due = world.sectExpansion.maintenance.payments.at(-1)?.dueCalendarTick ?? world.sectExpansion.construction.buildings[0]!.firstMaintenanceCalendarTick;
  const startTick = world.clock.calendarTick < due - 100 ? due - 100 : due + 1100;
  world = fixtureUntil(world, w => w.clock.calendarTick >= startTick);
  const started = fixtureResearchStart(world);
  const cancelled = fixtureApply(started, fixtureSectCommand(started, { domain: 'research', command: {
    kind: 'research.cancel', commandId: 'research-sites.cancel-research', expectedRevision: started.sectExpansion.research.revision,
    jobId: started.sectExpansion.research.jobs[0]!.jobId } }));
  const cancelProjection = projectV9SectFrame(cancelled);
  cancelledOld = cloneJson({ schemaVersion: 1, construction: cancelProjection.construction, production: cancelProjection.production,
    research: cancelProjection.research, maintenance: cancelProjection.maintenance });
  world = fixtureUntil(started, w => !!w.sectExpansion.research.jobs[0]!.terminal);
  const projection = projectV9SectFrame(world);
  old = cloneJson({ schemaVersion: 1, construction: projection.construction, production: projection.production,
    research: projection.research, maintenance: projection.maintenance });
  const metadata = { buildId: 'research-sites-regression', savedAt: '2026-10-03T00:00:00Z' };
  const migrated = prepareV9ToV10Migration(serializeSaveV9(createSaveEnvelopeV9(world, metadata)), metadata);
  if (!migrated.ok) throw new Error(JSON.stringify(migrated.issues)); oldV10 = cloneJson(projectV10SectFrame(migrated.world));
  const initial = seed(old); original = source(initial, old);
  const moving = move(initial, 4); active = source(moving, old); cancelledMove = source(cancelMove(moving), old);
  const movedFrame = until(moving, f => !!f.records.relocation.jobs[0]!.terminal); moved = source(movedFrame, old);
  const built = until(build(movedFrame, 1), f => !!f.records.construction.jobs[1]!.terminal);
  const again = until(move(built, 10), f => !!f.records.relocation.jobs[1]!.terminal); final = source(again, old);
  const cancelledSeed = seed(cancelledOld);
  cancelThenStart = source(move(cancelledSeed, 4), cancelledOld);
  const first = until(move(step(cancelledSeed), 4), f => !!f.records.relocation.jobs[0]!.terminal);
  outAndBack = source(until(move(first, 1), f => !!f.records.relocation.jobs[1]!.terminal), cancelledOld);
  laterBuild = source(until(build(step(cancelledSeed), 10), f => !!f.records.construction.jobs[1]!.terminal), cancelledOld);
  [old, oldV10, cancelledOld, original, active, cancelledMove, moved, final, cancelThenStart, outAndBack, laterBuild].forEach(frozen);
}, 360_000);

describe('partial relocated research history and current L1 sites', () => {
  it('retains actual research, maintenance, construction and every original ledger record through move/build/move', () => {
    expect(inspect(final)).toEqual({ ok: true, scope });
    expect(final.research).toEqual(old.research); expect(final.maintenance).toEqual(old.maintenance);
    expect(final.construction.jobs[0]).toEqual(old.construction.jobs[0]);
    expect(final.construction.buildings[0]).toEqual(old.construction.buildings[0]);
    expect(final.construction.blueprints[0]).toEqual(old.construction.blueprints[0]);
    expect(final.construction.receipts.slice(0, old.construction.receipts.length)).toEqual(old.construction.receipts);
    expect(final.construction.ledger.reservations.slice(0, old.construction.ledger.reservations.length)).toEqual(old.construction.ledger.reservations);
    expect(final.construction.blueprints[1]!.placedTick).toBe(final.relocation.jobs[0]!.terminal!.tick);
    expect(final.relocation.jobs[1]!.previousRelocationJobId).toBe(final.relocation.jobs[0]!.jobId);
  });
  it('returns the original start doorway and the same building identity at its new current doorway', () => {
    const start = atStart(final, old.research.jobs[0]!.jobId); const now = sitesNow(final, 'herbal-compatibility.v9');
    expect(start).toEqual({ ok: true, scope, site: old.research.jobs[0]!.site });
    expect(now.ok).toBe(true); if (!now.ok || !start.ok) return;
    const a = now.sites.find(s => s.buildingId === start.site.buildingId)!;
    expect(a.position).toEqual({ x: 10, y: 3 }); expect(start.site.position).toEqual({ x: 1, y: 3 });
    expect(a.sourceJobId).toBe(start.site.sourceJobId); expect(a.firstMaintenanceCalendarTick).toBe(start.site.firstMaintenanceCalendarTick);
    expect(now.sites).toHaveLength(2); expect(final.research.jobs).toHaveLength(1);
    // This is a site query, not execution/navigation of herbal compatibility.
    expect(final.research.jobs.some(j => j.researchId === 'herbal-compatibility.v9')).toBe(false);
  });
  it('uses construction/relocation before-and-after phases and external starts after the whole tick', () => {
    const def = getSectResearchDefinition('basic-medicine.v9')!; const tick = moved.relocation.jobs[0]!.terminal!.tick;
    const query = (phase: 'construction' | 'relocation' | 'research' | 'legacy-production', side: 'before' | 'after') =>
      relocationResearchSitesFromRecordsAt(moved, def, { tick, phase, side })[0]!.position;
    expect(query('relocation', 'before')).toEqual({ x: 1, y: 3 });
    expect(query('relocation', 'after')).toEqual({ x: 4, y: 3 });
    expect(query('research', 'before')).toEqual({ x: 4, y: 3 });
    expect(query('legacy-production', 'after')).toEqual({ x: 4, y: 3 });
    const born = original.construction.buildings[0]!.completedTick;
    expect(relocationResearchSitesFromRecordsAt(original, def, { tick: born, phase: 'construction', side: 'before' })).toEqual([]);
    expect(relocationResearchSitesFromRecordsAt(original, def, { tick: born, phase: 'construction', side: 'after' })).toHaveLength(1);
  });
  it('excludes an actively moving building and retains the original door after cancellation', () => {
    expect(sitesNow(active, 'herbal-compatibility.v9')).toEqual({ ok: true, scope, sites: [] });
    const result = sitesNow(cancelledMove, 'herbal-compatibility.v9');
    expect(result.ok && result.sites[0]!.position).toEqual({ x: 1, y: 3 });
    expect(atStart(cancelledMove, old.research.jobs[0]!.jobId).ok).toBe(true);
  });
  it('authenticates a genuine maintenance renewal inside the original research work span', () => {
    const job = old.research.jobs[0]!;
    const renewal = old.maintenance.payments.find(p => p.paidTick > job.startedTick && p.paidTick <= job.terminal!.tick)!;
    expect(renewal).toBeDefined(); expect(job.workSpans.some(s => s.firstTick <= renewal.paidTick && s.lastTick >= renewal.paidTick)).toBe(true);
    expect(validateSectMaintenanceL1SourceRecords(final)).toEqual([]); expect(inspect(original).ok).toBe(true);
  });
  it('keeps returned sites detached and each entry reauthenticates changed source data', () => {
    const bytes = canonicalStringify(final); const first = atStart(final, old.research.jobs[0]!.jobId); const now = sitesNow(final, 'herbal-compatibility.v9');
    if (!first.ok || !now.ok) throw new Error('Expected sites');
    Object.assign(first.site.position, { x: 90 }); Object.assign(now.sites[0]!.position, { y: 90 });
    expect(canonicalStringify(final)).toBe(bytes); expect(atStart(final, old.research.jobs[0]!.jobId)).not.toEqual(first);
    allReject(changed(final, f => { f.research.jobs[0]!.site.position.x++; }));
  });
  it.each(['job', 'research'] as const)('rejects unknown %s query keys after authenticating the source', kind => {
    expect((kind === 'job' ? atStart(final, 'missing') : sitesNow(final, 'missing')).ok).toBe(false);
  });
});

describe('record tampering and original wrapper compatibility', () => {
  it.each([
    ['site', (f: Mutable<Source>) => { f.research.jobs[0]!.site.position.x++; }],
    ['origin', (f: Mutable<Source>) => { f.research.jobs[0]!.origin.x = 255; }],
    ['visit', (f: Mutable<Source>) => { f.research.jobs[0]!.visits[0]!.position.x++; }],
    ['span', (f: Mutable<Source>) => { f.research.jobs[0]!.workSpans[0]!.lastTick--; }],
    ['DAG', (f: Mutable<Source>) => { f.research.jobs[0]!.prerequisites.push({ researchId: 'basic-medicine.v9', completionJobId: 'sect-research:1' }); }],
    ['receipt', (f: Mutable<Source>) => { f.research.receipts.pop(); }],
    ['cost', (f: Mutable<Source>) => { f.construction.ledger.reservations.find(c => c.ownerTransactionId === f.research.jobs[0]!.jobId)!.sect.lines[0]!.quantity++; }],
    ['terminal', (f: Mutable<Source>) => { f.research.jobs[0]!.terminal!.position.x++; }],
    ['navigation', (f: Mutable<Source>) => { f.research.jobs[0]!.navigation.target = { x: 1, y: 3 }; }],
    ['first-maintenance', (f: Mutable<Source>) => { f.construction.buildings[0]!.firstMaintenanceCalendarTick++; }],
    ['payment-deleted', (f: Mutable<Source>) => { f.maintenance.payments.splice(0, 1); }],
    ['payment-forged', (f: Mutable<Source>) => { f.maintenance.payments[0]!.reservationId = 'sect-maintenance-reservation:999'; }],
    ['payment-debit', (f: Mutable<Source>) => { f.construction.ledger.reservations.find(c => c.ownerTransactionId === f.maintenance.payments[0]!.paymentId)!.base.settlement!.operationId = 'forged'; }],
    ['library-L2-tag', (f: Mutable<Source>) => { f.maintenance.payments[0]!.rate = { level: 2, upgradeJobId: 'sect-upgrade:1' }; }],
    ['research-orphan', (f: Mutable<Source>) => { f.research.jobs = []; f.research.receipts = []; }],
  ] as const)('rejects %s tampering at all three entry points', (_name, change) => { allReject(changed(final, change)); });
  it('rejects a deleted payment even when no research work depends on its period', () => {
    const seedSource = source(seed(cancelledOld), cancelledOld);
    expect(seedSource.maintenance.payments.length).toBeGreaterThan(0);
    const f = changed(seedSource, value => { value.maintenance.payments = []; });
    // The cancelled start is after the first original expiry, so shared research
    // proof can reject unpaid use before namespace closure; deletion is never ignored.
    expect(code(f)).not.toBeNull(); allReject(f);
  });
  it('preserves authentic v9 and migrated-v10 acceptance without relocated old-World reconstruction', () => {
    expect(validateSectMaintenanceFrame(old)).toEqual([]); expect(validateMaintainedSectResearchRecords(old)).toEqual([]);
    expect(validateMaintainedSectResearchSourceRecords(old)).toEqual([]); expect(validateSectMaintenanceL1RecordsV10(oldV10)).toEqual([]);
    expect(validateSectUpgradeResearchPrerequisitesV10(oldV10)).toEqual([]);
    expect(oldV10.research).toEqual(old.research); expect(oldV10.maintenance).toEqual(old.maintenance);
  });
  it('preserves the old research first error for two corruptions', () => {
    const invalid = changed(old, f => { f.research.jobs[0]!.site.position.x++; f.research.receipts = []; });
    const expected = [{ code: 'INVALID_SITE_SOURCE', path: old.research.jobs[0]!.jobId }];
    expect(validateMaintainedSectResearchRecords(invalid)).toEqual(expected);
    expect(validateMaintainedSectResearchSourceRecords(invalid)).toEqual(expected);
    const invalidV10 = changed(oldV10, f => { f.research.jobs[0]!.site.position.x++; f.research.receipts = []; });
    expect(validateSectUpgradeResearchPrerequisitesV10(invalidV10)).toEqual(expected);
  });
  it('preserves the old maintenance first error ahead of later research damage', () => {
    const invalid = changed(oldV10, f => { f.maintenance.payments[0]!.previousDueCalendarTick++; f.research.receipts = []; });
    expect(validateSectMaintenanceL1RecordsV10(invalid)).toEqual([{ code: 'INVALID_MAINTENANCE_PERIOD', path: invalid.maintenance.payments[0]!.paymentId }]);
    expect(validateSectMaintenanceL1SourceRecords(invalid)).toEqual(validateSectMaintenanceL1RecordsV10(invalid));
  });
});

describe('whole-lifetime joins and unordered cancellation boundaries', () => {
  it('rejects backdated blueprint placement calendar in all three independently authenticated entries', () => {
    const f = changed(final, value => { value.construction.blueprints[1]!.placedCalendarTick = 0; });
    expect(inspectRelocationOwnerSpatialRecords({ construction: f.construction, relocation: f.relocation }).ok).toBe(true);
    expect(code(f)).toBe('INVALID_RESEARCH_SHARED_CLOCK'); allReject(f);
  });
  it('rejects research cancellation and relocation start at the same tick independently of cross-domain revision magnitude', () => {
    expect(code(cancelThenStart)).toBe('AMBIGUOUS_RESEARCH_HISTORY_BOUNDARY');
    const lower = changed(cancelThenStart, f => {
      f.research.revision = 2;
      f.research.receipts.forEach((r, i) => { r.revision = i + 1; r.command.expectedRevision = i; });
    });
    const higher = changed(lower, f => {
      f.research.revision = 9002;
      f.research.receipts.forEach(r => { r.revision += 9000; r.command.expectedRevision += 9000; });
    });
    expect(code(lower)).toBe('AMBIGUOUS_RESEARCH_HISTORY_BOUNDARY'); expect(code(higher)).toBe('AMBIGUOUS_RESEARCH_HISTORY_BOUNDARY');
  });
  it('rejects the opposite relocation-cancel/research-start boundary without ordering unrelated revisions', () => {
    const runtime = cancelMove(move(step(seed(cancelledOld)), 4));
    const f = changed(source(runtime, cancelledOld), value => {
      const job = value.research.jobs[0]!; const tick = value.construction.lastSimulationTick;
      job.startedTick = tick; job.startedCalendarTick = tick; job.terminal!.tick = tick; job.terminal!.calendarTick = tick;
    });
    expect(validateRelocationOwnerResearchSourceRecords(f)).toEqual([]);
    expect(code(f)).toBe('AMBIGUOUS_RESEARCH_HISTORY_BOUNDARY');
  });
  it('does not let an out-and-back relocation hide inside a cancelled research lifetime', () => {
    expect(inspect(outAndBack).ok).toBe(true);
    const f = changed(outAndBack, value => {
      const terminal = value.research.jobs[0]!.terminal!;
      terminal.tick = value.construction.lastSimulationTick; terminal.calendarTick = value.construction.lastCalendarTick;
    });
    expect(f.relocation.jobs[1]!.to).toEqual(f.relocation.jobs[0]!.from);
    expect(validateRelocationOwnerResearchSourceRecords(f)).toEqual([]);
    expect(code(f)).toBe('RESEARCH_RELOCATION_BUILDING_OVERLAP');
  });
  it('rejects the same-building lifetime overlap even when research and relocation use different workers', () => {
    const f = changed(outAndBack, value => {
      const job = value.research.jobs[0]!; job.workerId = 'entity:3';
      job.terminal!.tick = value.construction.lastSimulationTick; job.terminal!.calendarTick = value.construction.lastCalendarTick;
      for (const receipt of value.research.receipts) if (receipt.command.kind === 'research.start') receipt.command.workerId = 'entity:3';
    });
    expect(validateRelocationOwnerResearchSourceRecords(f)).toEqual([]);
    expect(code(f)).toBe('RESEARCH_RELOCATION_BUILDING_OVERLAP');
  });
  it('joins the complete research/construction worker interval even without a relocation', () => {
    expect(inspect(laterBuild).ok).toBe(true);
    const f = changed(laterBuild, value => {
      value.research.jobs[0]!.terminal!.tick = value.construction.lastSimulationTick;
      value.research.jobs[0]!.terminal!.calendarTick = value.construction.lastCalendarTick;
    });
    expect(validateRelocationOwnerResearchSourceRecords(f)).toEqual([]); expect(code(f)).toBe('RESEARCH_HISTORY_WORKER_OVERLAP');
  });
  it('requires calendar travel distance from research cancellation into relocation', () => {
    const f = changed(outAndBack, value => { value.research.jobs[0]!.terminal!.position.x++; });
    expect(inspectRelocationOwnerSpatialRecords({ construction: f.construction, relocation: f.relocation }).ok).toBe(true);
    expect(validateRelocationOwnerResearchSourceRecords(f)).toEqual([]);
    expect(code(f)).toBe('INVALID_RESEARCH_WORKER_CONTINUITY');
  });
  it('requires calendar travel distance from research cancellation into construction', () => {
    const f = changed(laterBuild, value => { value.research.jobs[0]!.terminal!.position.x++; });
    expect(inspectRelocationOwnerSpatialRecords({ construction: f.construction, relocation: f.relocation }).ok).toBe(true);
    expect(validateRelocationOwnerResearchSourceRecords(f)).toEqual([]);
    expect(code(f)).toBe('INVALID_RESEARCH_WORKER_CONTINUITY');
  });
  it('fixed phase order permits research completion before an external relocation start', () => {
    expect(active.research.jobs[0]!.terminal!.tick).toBe(active.relocation.jobs[0]!.startedTick);
    expect(inspect(active)).toEqual({ ok: true, scope });
    const completion = relocationHistoryCompletionEdge(10, 'research');
    expect(compareRelocationHistoryEdges(completion, relocationHistoryCommandEdge(10, 'relocation', 1))).toBe(-1);
    expect(compareRelocationHistoryEdges(relocationHistoryCompletionEdge(10, 'relocation'), completion)).toBe(-1);
  });
  it('same-domain receipts remain ordered while cross-domain commands are incomparable', () => {
    const research = relocationHistoryCommandEdge(10, 'research', 9000); const relocation = relocationHistoryCommandEdge(10, 'relocation', 1);
    expect(compareRelocationHistoryEdges(research, relocation)).toBeNull();
    expect(compareRelocationHistoryEdges(relocationHistoryCommandEdge(10, 'research', 8999), research)).toBe(-1);
    expect(relocationHistoryIntersection({ start: relocationHistoryCommandEdge(9, 'research', 8999), end: research }, { start: relocation, end: null })).toBe('ambiguous');
  });
});

describe('hostile descriptor and alias isolation', () => {
  it.each(['root', 'site', 'maintenance', 'array'] as const)('rejects the %s getter without invoking it', location => {
    const f = cloneJson(final); let reads = 0;
    const target = location === 'root' ? f : location === 'site' ? f.research.jobs[0]!.site : location === 'maintenance' ? f.maintenance : f.research.jobs;
    const key = location === 'root' ? 'construction' : location === 'site' ? 'position' : location === 'maintenance' ? 'payments' : '0';
    Object.defineProperty(target, key, { enumerable: true, get: () => { reads++; throw new Error('must not execute'); } });
    allReject(f); expect(reads).toBe(0);
  });
  it.each(['extra-root', 'extra-job', 'symbol', 'nonenumerable', 'alias', 'cycle', 'sparse', 'prototype'] as const)('rejects %s data', kind => {
    const f = cloneJson(final);
    if (kind === 'extra-root') Object.assign(f, { validated: true });
    if (kind === 'extra-job') Object.assign(f.research.jobs[0]!, { validated: true });
    if (kind === 'symbol') Object.defineProperty(f, Symbol('fake'), { value: true, enumerable: true });
    if (kind === 'nonenumerable') Object.defineProperty(f, 'fake', { value: true });
    if (kind === 'alias') Object.assign(f.research.jobs[0]!.visits[0]!, { position: f.research.jobs[0]!.site.position });
    if (kind === 'cycle') Object.assign(f, { cycle: f });
    if (kind === 'sparse') Reflect.deleteProperty(f.research.jobs, '0');
    if (kind === 'prototype') Object.setPrototypeOf(f.maintenance, null);
    allReject(f);
  });
});
