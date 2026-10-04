import { beforeAll, describe, expect, it } from 'vitest';
import { emptyNavigation, findCardinalPath, MOVEMENT_TICKS_PER_CELL } from '../../src/core/agents/navigation';
import { advanceWorkNavigationWithBudget, createWorkPathBudget } from '../../src/core/agents/work-navigation';
import { prepareUnregisteredCommandCandidateV10 } from '../../src/core/kernel/commands-v10';
import { createSaveEnvelopeV9, serializeSaveV9 } from '../../src/core/kernel/save-v9';
import { canonicalStringify, cloneJson } from '../../src/core/kernel/serialization';
import { prepareNormalTickCandidateV10 } from '../../src/core/kernel/simulation-v10';
import type { ConstructionContext } from '../../src/core/sect-expansion/construction-types';
import { applySectMaintenanceConstructionCommand, applySectMaintenanceResearchCommand, tickSectMaintenance } from '../../src/core/sect-expansion/maintenance';
import type { SectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-types';
import { validateSectMaintenanceFrame } from '../../src/core/sect-expansion/maintenance-validation';
import { tickConstructionRelocationResearchDomain } from '../../src/core/sect-expansion/relocation-runtime';
import type { SectResearchCommand } from '../../src/core/sect-expansion/research-types';
import type { WorldStateV10 } from '../../src/core/sect-expansion/upgrade-types';
import { prepareV9ToV10Migration } from '../../src/core/world/migrate-v9-to-v10';
import { prepareConstructionRelocationResearchCommandCandidate as commandCandidate, prepareConstructionRelocationResearchTickCandidate as tickCandidate,
  validateConstructionRelocationResearchDomainRuntime as validate, type ConstructionRelocationResearchDomainCandidate as Result } from '../../src/core/world/relocation-owner/research-domain-composition';
import { relocationOwnerEffectiveMap } from '../../src/core/world/relocation-owner/spatial-records';
import { projectV10SectFrame } from '../../src/core/world/v10-sect-frame';
import { actualOldResearchFixture, apply, build, cancelResearch, context, fromMaintained, move, moveCommand,
  nextContext, researchCommand, start, step, until, unwrap, type Frame } from './fixtures/relocation-research-runtime';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
function changed<T>(source: T, change: (value: Mutable<T>) => void): Mutable<T> { const next = cloneJson(source) as Mutable<T>; change(next); return next; }
function frozen<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
function rejected(input: unknown, result: Result, code?: string): void {
  expect(result.ok).toBe(false); expect(result.frame).toBe(input); if (!result.ok && code) expect(result.code).toBe(code);
}
function allReject(input: unknown): void {
  expect(validate(input).length).toBeGreaterThan(0);
  rejected(input, commandCandidate(input, context(seed), researchCommand(seed)), 'INVALID_FRAME');
  for (const tick of [tickCandidate, tickConstructionRelocationResearchDomain]) {
    const ctx = nextContext(seed); const budget = createWorkPathBudget(ctx.simulationTick); const remaining = budget.remaining;
    rejected(input, tick(input, ctx, budget), 'INVALID_FRAME'); expect(budget.remaining).toBe(remaining);
  }
}
function due(frame: Frame): number {
  const building = frame.records.construction.buildings[0]!;
  return frame.records.maintenance.payments.filter(payment => payment.buildingId === building.buildingId).at(-1)?.dueCalendarTick ?? building.firstMaintenanceCalendarTick;
}
function withoutAvailableWood(frame: Frame): Frame {
  // Explicit external inventory snapshot only; no record, clock, reservation or
  // maintenance history is rewritten to manufacture an expired interval.
  return changed(frame, f => { f.records.construction.ledger.inventory.wood.owned = f.records.construction.ledger.inventory.wood.reserved; });
}
function consumeUntilOne(frame: Frame, simulationTick: number) {
  const budget = createWorkPathBudget(simulationTick); const map = relocationOwnerEffectiveMap({ construction: frame.records.construction, relocation: frame.records.relocation });
  if (!map.ok) throw new Error('Fixture map unavailable');
  while (budget.remaining > 1) advanceWorkNavigationWithBudget({ map: map.map, position: { x: 0, y: 5 }, target: { x: 0, y: 6 },
    navigation: emptyNavigation(), simulationTick }, budget);
  return budget;
}
let old: SectMaintenanceFrame; let beforeBasic: SectMaintenanceFrame; let oldV10: WorldStateV10;
let seed: Frame; let moving: Frame; let moved: Frame; let traveling: Frame; let working: Frame; let work399: Frame; let completed: Frame;
let due399: Frame; let dueMove199: Frame; let aligned: Frame;
beforeAll(() => {
  const actual = actualOldResearchFixture(); old = actual.old; beforeBasic = actual.beforeBasic;
  const metadata = { buildId: 'relocation-research-execution', savedAt: '2026-10-03T00:00:00Z' };
  const migrated = prepareV9ToV10Migration(serializeSaveV9(createSaveEnvelopeV9(actual.world, metadata)), metadata);
  if (!migrated.ok) throw new Error(JSON.stringify(migrated.issues)); oldV10 = migrated.world;
  seed = fromMaintained(old); moving = move(seed); moved = until(moving, f => !!f.records.relocation.jobs[0]!.terminal);
  traveling = step(start(moved, 'entity:4'));
  working = until(traveling, f => f.records.research.jobs.at(-1)!.phase === 'working');
  work399 = until(working, f => f.records.research.jobs.at(-1)!.activeTicks === 399); completed = step(work399);
  let deadline = due(moved); if (context(moved).calendarTick > deadline - 401) deadline += 1200;
  aligned = until(moved, f => context(f).calendarTick === deadline - 401);
  due399 = until(start(aligned), f => f.records.research.jobs.at(-1)!.activeTicks === 399);
  expect(context(due399).calendarTick).toBe(deadline - 1);
  const map = relocationOwnerEffectiveMap({ construction: aligned.records.construction, relocation: aligned.records.relocation });
  if (!map.ok) throw new Error('No real map');
  const path = findCardinalPath(map.map, { x: 4, y: 3 }, { x: 10, y: 3 }); if (!path) throw new Error('No real move route');
  const duration = 1 + path.length * MOVEMENT_TICKS_PER_CELL + 200;
  const ready = until(aligned, f => context(f).calendarTick === deadline - duration);
  dueMove199 = until(move(ready, 'entity:2', 10), f => f.records.relocation.jobs.at(-1)!.activeTicks === 199);
  expect(context(dueMove199).calendarTick).toBe(deadline - 1);
  [old, beforeBasic, oldV10, seed, moving, moved, traveling, working, work399, completed, due399, dueMove199, aligned].forEach(frozen);
}, 600_000);

describe('complete relocated library-L1 research execution', () => {
  it('uses twelve genuine old production completions and genuine old basic/maintenance history', () => {
    expect(beforeBasic.production.jobs).toHaveLength(12);
    expect(beforeBasic.production.jobs.every(job => job.terminal?.kind === 'completed')).toBe(true);
    expect(beforeBasic.construction.ledger.stock['spirit-stone'].owned).toBe(6);
    expect(beforeBasic.construction.ledger.stock['basic-insight'].owned).toBe(6);
    expect(seed.records.research.jobs[0]!.terminal?.kind).toBe('completed'); expect(seed.records.maintenance.payments.length).toBeGreaterThan(0);
    expect(validate(seed)).toEqual([]); expect(validate(completed)).toEqual([]);
  });
  it('actually moves the library, walks to its new doorway, then completes exactly 400 herbal work ticks', () => {
    expect(moved.records.relocation.jobs[0]!.terminal?.kind).toBe('completed');
    expect(traveling.records.research.jobs.at(-1)!.navigation.path.length).toBeGreaterThan(0);
    expect(traveling.records.research.jobs.at(-1)!.activeTicks).toBe(0);
    expect(working.records.research.jobs.at(-1)!.visits.at(-1)!.position).toEqual({ x: 4, y: 3 });
    expect(working.records.research.jobs.at(-1)!.activeTicks).toBe(0);
    const job = completed.records.research.jobs.at(-1)!;
    expect(job.activeTicks).toBe(400); expect(job.terminal).toMatchObject({ kind: 'completed', position: { x: 4, y: 3 } });
    expect(job.site.position).toEqual({ x: 4, y: 3 }); expect(job.prerequisites[0]!.completionJobId).toBe(seed.records.research.jobs[0]!.jobId);
    expect(completed.records.construction.ledger.stock['spirit-stone']).toMatchObject({ owned: 0, reserved: 0 });
    expect(completed.records.construction.ledger.stock['basic-insight']).toMatchObject({ owned: 0, reserved: 0 });
  });
  it('retains original construction, old-door research, maintenance and every original ledger entry exactly', () => {
    const original = seed.records; const final = completed.records;
    expect(final.construction.blueprints).toEqual(original.construction.blueprints); expect(final.construction.buildings).toEqual(original.construction.buildings);
    expect(final.construction.jobs).toEqual(original.construction.jobs); expect(final.construction.receipts).toEqual(original.construction.receipts);
    expect(final.research.jobs[0]).toEqual(original.research.jobs[0]); expect(final.research.jobs[0]!.site.position).toEqual({ x: 1, y: 3 });
    expect(final.research.receipts.slice(0, original.research.receipts.length)).toEqual(original.research.receipts);
    expect(final.maintenance.payments.slice(0, original.maintenance.payments.length)).toEqual(original.maintenance.payments);
    expect(final.construction.ledger.reservations.slice(0, original.construction.ledger.reservations.length)).toEqual(original.construction.ledger.reservations);
  });
  it.each([tickCandidate, tickConstructionRelocationResearchDomain])('equal-clock full entry %s cannot move/work/pay/revise or touch budget', tick => {
    for (const frame of [traveling, working, due399, completed]) {
      const budget = createWorkPathBudget(context(frame).simulationTick); const before = canonicalStringify(frame); const remaining = budget.remaining;
      const result = tick(frame, context(frame), budget);
      expect(result.ok && result.repeated).toBe(true); expect(result.frame).toEqual(frame); expect(result.frame).not.toBe(frame);
      expect(canonicalStringify(frame)).toBe(before); expect(budget.remaining).toBe(remaining);
    }
  });
  it.each([{ paused: true }, { mode: 'combat' as const }, { expeditionActive: true }])('nonproductive %j increments only simulation and leaves research/payment/work untouched', patch => {
    const next = step(traveling, patch);
    expect(context(next).simulationTick).toBe(context(traveling).simulationTick + 1); expect(context(next).calendarTick).toBe(context(traveling).calendarTick);
    expect(next.records.research).toEqual(traveling.records.research); expect(next.records.maintenance).toEqual(traveling.records.maintenance);
    expect(next.records.relocation).toEqual(traveling.records.relocation); expect(next.records.construction.people).toEqual(traveling.records.construction.people);
    expect(next.records.construction.ledger).toEqual(traveling.records.construction.ledger);
  });
  it('returns detached deterministic commands and settles cancellation only once', () => {
    const command = researchCommand(moved, 'entity:4'); const started = unwrap(commandCandidate(moved, context(moved), command));
    const again = commandCandidate(started, context(started), command);
    expect(again.ok && again.repeated).toBe(true); expect(again.frame).toEqual(started); expect(again.frame).not.toBe(started);
    const cancelled = cancelResearch(traveling); const cancel = cancelled.records.research.receipts.at(-1)!.command;
    expect(cancelled.records.research.jobs.at(-1)!.terminal).toMatchObject({ kind: 'cancelled', consumed: [] });
    expect(cancelled.records.construction.ledger.stock['spirit-stone'].reserved).toBe(0);
    const retry = commandCandidate(cancelled, context(cancelled), cancel); expect(retry.ok && retry.repeated).toBe(true); expect(retry.frame).toEqual(cancelled);
    const after = step(completed); const job = completed.records.research.jobs.at(-1)!;
    expect(after.records.construction.ledger.reservations.find(claim => claim.ownerTransactionId === job.jobId))
      .toEqual(completed.records.construction.ledger.reservations.find(claim => claim.ownerTransactionId === job.jobId));
    expect(after.records.construction.ledger.stock).toEqual(completed.records.construction.ledger.stock);
  });
  it('allows real cancellation despite newly external worker ownership, with full terminal evidence', () => {
    const job = traveling.records.research.jobs.at(-1)!;
    const command: SectResearchCommand = { kind: 'research.cancel', commandId: 'external.cancel', expectedRevision: traveling.records.research.revision, jobId: job.jobId };
    const ctx = context(traveling, { externalActiveJobs: 36, externalClaims: [{ kind: 'worker', key: job.workerId, ownerId: 'external:1' }] });
    const cancelled = unwrap(commandCandidate(traveling, ctx, command)); expect(validate(cancelled)).toEqual([]);
    expect(cancelled.records.research.jobs.at(-1)!.terminal?.kind).toBe('cancelled');
    const retry = commandCandidate(cancelled, context(cancelled, { externalActiveJobs: 36, externalClaims: ctx.externalClaims }), command);
    expect(retry.ok && retry.repeated).toBe(true); expect(retry.frame).toEqual(cancelled);
  });
});

describe('actual due-boundary payment order', () => {
  it('pays before the final herbal work boundary and records actual paid+1200', () => {
    const next = step(due399); const payment = next.records.maintenance.payments.at(-1)!;
    expect(next.records.research.jobs.at(-1)!.terminal?.kind).toBe('completed'); expect(payment.paidCalendarTick).toBe(context(next).calendarTick);
    expect(payment.dueCalendarTick).toBe(payment.paidCalendarTick + 1200); expect(next.records.maintenance.nextId).toBe(due399.records.maintenance.nextId + 2);
    expect(next.records.construction.ledger.inventory.wood.owned).toBe(due399.records.construction.ledger.inventory.wood.owned - 1);
  });
  it('cannot finish the last work tick for free when maintenance cannot be paid; no failed ID/reservation', () => {
    const poor = withoutAvailableWood(due399); expect(validate(poor)).toEqual([]);
    const blocked = step(poor); const again = step(blocked);
    expect(again.records.research.jobs.at(-1)!).toMatchObject({ activeTicks: 399, terminal: null, blocked: 'WORKSTATION_UNAVAILABLE' });
    expect(again.records.research.jobs.at(-1)!.visits).toEqual(poor.records.research.jobs.at(-1)!.visits);
    expect(again.records.research.jobs.at(-1)!.workSpans).toEqual(poor.records.research.jobs.at(-1)!.workSpans);
    expect(again.records.maintenance).toEqual(poor.records.maintenance); expect(again.records.construction.ledger).toEqual(poor.records.construction.ledger);
    expect(cancelResearch(again).records.research.jobs.at(-1)!.terminal?.kind).toBe('cancelled');
  });
  it('stops both distant movement and same-door arrival at the unpaid due boundary', () => {
    const cancelled = cancelResearch(due399);
    for (const worker of ['entity:2', 'entity:4']) {
      const started = withoutAvailableWood(start(cancelled, worker)); const next = step(started);
      expect(next.records.construction.people).toEqual(started.records.construction.people);
      expect(next.records.research.jobs.at(-1)!).toMatchObject({ phase: 'to-site', activeTicks: 0, visits: [], workSpans: [], blocked: 'WORKSTATION_UNAVAILABLE' });
      expect(next.records.research.jobs.at(-1)!.navigation).toEqual(emptyNavigation()); expect(next.records.maintenance).toEqual(started.records.maintenance);
    }
  });
  it('starts a late paid period at actual payment, with no catch-up debt or free extension', () => {
    let expired = step(withoutAvailableWood(due399)); expired = step(expired); expired = step(expired);
    const funded = changed(expired, f => { f.records.construction.ledger.inventory.wood.owned = 1; });
    const next = step(funded); const payment = next.records.maintenance.payments.at(-1)!;
    expect(payment.paidCalendarTick).toBe(context(next).calendarTick); expect(payment.paidCalendarTick).toBeGreaterThan(payment.previousDueCalendarTick);
    expect(payment.dueCalendarTick).toBe(payment.paidCalendarTick + 1200); expect(next.records.construction.ledger.inventory.wood.owned).toBe(0);
    expect(next.records.maintenance.payments.length).toBe(due399.records.maintenance.payments.length + 1);
    expect(next.records.research.jobs.at(-1)!.terminal?.kind).toBe('completed');
  });
  it('renews during relocation before its same-tick completion, with no move-based free period', () => {
    const next = step(dueMove199); const payment = next.records.maintenance.payments.at(-1)!;
    expect(next.records.relocation.jobs.at(-1)!.terminal?.kind).toBe('completed');
    expect(payment.paidTick).toBe(next.records.relocation.jobs.at(-1)!.terminal!.tick); expect(payment.dueCalendarTick).toBe(context(next).calendarTick + 1200);
    expect(next.records.construction.ledger.inventory.wood.owned).toBe(dueMove199.records.construction.ledger.inventory.wood.owned - 2);
  });
  it('does not invent an unpaid-relocation prohibition', () => {
    const poor = withoutAvailableWood(dueMove199); const next = step(poor);
    expect(next.records.maintenance).toEqual(poor.records.maintenance); expect(next.records.relocation.jobs.at(-1)!.terminal?.kind).toBe('completed');
    expect(next.records.construction.ledger.inventory.wood.owned).toBe(0);
  });
});

describe('fixed three-domain claims, IDs and ambiguity', () => {
  it('blocks research and relocation building ownership in both command orders', () => {
    const research = start(seed);
    rejected(research, commandCandidate(research, context(research), moveCommand(research, 'entity:3')), 'CLAIM_CONFLICT');
    rejected(moving, commandCandidate(moving, context(moving), researchCommand(moving, 'entity:3')), 'CLAIM_CONFLICT');
  });
  it('blocks worker ownership between research and construction in both directions', () => {
    const research = start(seed, 'entity:3');
    const placed = apply(research, { kind: 'blueprint.place', commandId: 'conflict.place', expectedRevision: research.records.construction.revision,
      placement: { definitionId: 'library.v9', anchor: { x: 10, y: 1 }, rotation: 0 } });
    rejected(placed, commandCandidate(placed, context(placed), { kind: 'construction.start', commandId: 'conflict.build', expectedRevision: placed.records.construction.revision,
      blueprintId: placed.records.construction.blueprints.at(-1)!.blueprintId, workerId: 'entity:3' }));
    const constructed = build(seed, 'entity:3');
    rejected(constructed, commandCandidate(constructed, context(constructed), researchCommand(constructed, 'entity:3')), 'CLAIM_CONFLICT');
  });
  it('retains the single-active-research limit', () => {
    const active = start(seed); rejected(active, commandCandidate(active, context(active), { ...researchCommand(active, 'entity:3'), commandId: 'second.active.research' }), 'RESEARCH_ACTIVE');
  });
  it('counts jobs once instead of counting worker/seat/entrance claim tokens', () => {
    const result = commandCandidate(seed, context(seed, { externalActiveJobs: 35 }), researchCommand(seed));
    expect(result.ok).toBe(true);
    rejected(seed, commandCandidate(seed, context(seed, { externalActiveJobs: 36 }), researchCommand(seed)), 'CAPACITY_EXCEEDED');
  });
  it('rejects research-to-construction/relocation and reverse command-ID reuse without effects', () => {
    const researchId = old.research.receipts[0]!.command.commandId;
    rejected(seed, commandCandidate(seed, context(seed), { ...moveCommand(seed), commandId: researchId }), 'IDENTITY_CONFLICT');
    rejected(seed, commandCandidate(seed, context(seed), { kind: 'blueprint.place', commandId: researchId, expectedRevision: seed.records.construction.revision,
      placement: { definitionId: 'library.v9', anchor: { x: 10, y: 1 }, rotation: 0 } }), 'IDENTITY_CONFLICT');
    for (const commandId of [seed.records.construction.receipts[0]!.command.commandId, moved.records.relocation.receipts[0]!.command.commandId])
      rejected(moved, commandCandidate(moved, context(moved), { ...researchCommand(moved), commandId }), 'IDENTITY_CONFLICT');
    const altered = { ...researchCommand(moved), commandId: old.research.receipts[0]!.command.commandId };
    rejected(moved, commandCandidate(moved, context(moved), altered), 'IDENTITY_CONFLICT');
  });
  it('rejects research-cancel/move and move-cancel/research same-tick ambiguity, then allows next-tick retry', () => {
    const cancelledResearch = cancelResearch(start(seed));
    rejected(cancelledResearch, commandCandidate(cancelledResearch, context(cancelledResearch), moveCommand(cancelledResearch)), 'INVALID_FRAME');
    expect(move(step(cancelledResearch)).records.relocation.jobs.at(-1)!.terminal).toBeNull();
    const cancelledMove = apply(moving, { kind: 'relocation.cancel', commandId: 'cancel-for-research', expectedRevision: moving.records.relocation.revision,
      jobId: moving.records.relocation.jobs[0]!.jobId });
    rejected(cancelledMove, commandCandidate(cancelledMove, context(cancelledMove), researchCommand(cancelledMove)), 'INVALID_FRAME');
    expect(start(step(cancelledMove)).records.research.jobs.at(-1)!.terminal).toBeNull();
  });
  it('keeps alchemy, upgrades and recipe consumers closed after real herbal completion', () => {
    rejected(completed, commandCandidate(completed, context(completed), { kind: 'blueprint.place', commandId: 'alchemy.closed', expectedRevision: completed.records.construction.revision,
      placement: { definitionId: 'alchemy.v9', anchor: { x: 10, y: 1 }, rotation: 0 } }), 'RESEARCH_AUTHORITY_REQUIRED');
    for (const kind of ['upgrade.start', 'production.start', 'care.start']) rejected(completed, commandCandidate(completed, context(completed), { kind, commandId: kind, expectedRevision: 0 }), 'INVALID_COMMAND');
  });
  it('cancels relocation with another active research and maximum or overlapping external ownership', () => {
    const built = until(build(moved, 'entity:3'), f => !!f.records.construction.jobs.at(-1)!.terminal);
    const research = start(built, 'entity:3'); expect(research.records.research.jobs.at(-1)!.site.position).toEqual({ x: 10, y: 3 });
    const both = move(research, 'entity:2', 1);
    for (const extra of [{ externalActiveJobs: 36 }, { externalActiveJobs: 36,
      externalClaims: [{ kind: 'worker' as const, key: 'entity:3', ownerId: 'external:other-research' }] }]) {
      const command = { kind: 'relocation.cancel' as const, commandId: 'cancel.with-other-research', expectedRevision: both.records.relocation.revision,
        jobId: both.records.relocation.jobs.at(-1)!.jobId };
      const result = commandCandidate(both, context(both, extra), command); const next = unwrap(result);
      expect(validate(next)).toEqual([]); expect(next.records.research).toEqual(both.records.research);
      expect(next.records.relocation.jobs.at(-1)!.terminal?.kind).toBe('cancelled');
    }
  }, 120_000);
});

describe('one shared real budget and navigation invalidation', () => {
  it('shares the final path request between actual construction and research', () => {
    // entity:3 begins at storage; entity:4 must actually path to storage first.
    const both = build(start(seed, 'entity:3'), 'entity:4'); const ctx = nextContext(both); const budget = consumeUntilOne(both, ctx.simulationTick);
    const next = unwrap(tickCandidate(both, ctx, budget));
    expect(budget.remaining).toBe(0); expect(next.records.construction.jobs.at(-1)!.navigation.path.length).toBeGreaterThan(0);
    expect(next.records.research.jobs.at(-1)!.blocked).toBe('PATH_BUDGET'); expect(next.records.research.jobs.at(-1)!.activeTicks).toBe(0);
    expect(next.records.research.jobs.at(-1)!.navigation.movementTicks).toBe(0);
  });
  it('clears an actual nonempty research cache on a construction nav change and really replans', () => {
    const withPath = step(start(seed, 'entity:3')); expect(withPath.records.research.jobs.at(-1)!.navigation.path.length).toBeGreaterThan(0);
    const built = build(withPath, 'entity:4'); expect(built.records.construction.map.navVersion).toBeGreaterThan(withPath.records.construction.map.navVersion);
    expect(built.records.research.jobs.at(-1)!.navigation).toEqual(emptyNavigation());
    const ctx = nextContext(built); const budget = createWorkPathBudget(ctx.simulationTick); const next = unwrap(tickCandidate(built, ctx, budget));
    expect(next.records.research.jobs.at(-1)!.navigation.routeVersion).toBe(next.records.construction.map.navVersion);
    expect(budget.remaining).toBeLessThan(3); expect(next.records.research.jobs[0]).toEqual(seed.records.research.jobs[0]);
  });
  it('clears a cached route on actual relocation completion before research replans against the new navVersion', () => {
    const built = until(build(moved, 'entity:3'), f => !!f.records.construction.jobs.at(-1)!.terminal);
    const almost = until(move(built, 'entity:2', 1), f => f.records.relocation.jobs.at(-1)!.activeTicks === 198);
    const path = step(start(almost, 'entity:4')); expect(path.records.relocation.jobs.at(-1)!.activeTicks).toBe(199);
    expect(path.records.research.jobs.at(-1)!.navigation.path.length).toBeGreaterThan(0);
    const ctx = nextContext(path); const budget = createWorkPathBudget(ctx.simulationTick); const remaining = budget.remaining;
    const next = unwrap(tickCandidate(path, ctx, budget)); expect(next.records.relocation.jobs.at(-1)!.terminal?.kind).toBe('completed');
    expect(next.records.construction.map.navVersion).toBe(path.records.construction.map.navVersion + 1);
    expect(next.records.research.jobs.at(-1)!.navigation.routeVersion).toBe(next.records.construction.map.navVersion);
    expect(budget.remaining).toBe(remaining - 1); expect(next.records.research.jobs[0]).toEqual(seed.records.research.jobs[0]);
  }, 120_000);
  it('never restores caller-spent budget on early rejection; this does not claim a later-stage failure', () => {
    const ctx = nextContext(seed); const budget = consumeUntilOne(seed, ctx.simulationTick); const before = canonicalStringify(seed);
    const badContext = { ...ctx, simulationTick: ctx.simulationTick + 1 };
    rejected(seed, tickCandidate(seed, badContext, budget), 'CLOCK_GAP'); expect(budget.remaining).toBe(1); expect(canonicalStringify(seed)).toBe(before);
    // No fixture here dynamically spends budget in stage one and fails in stage
    // two. That distinct case is explicitly unverified, never inferred above.
  });
});

describe('no-relocation selected-domain differential', () => {
  it('executes basic under both maintained-v9 and new full wrappers, preserving every selected field at every tick', () => {
    let candidate = fromMaintained(beforeBasic); let legacy = cloneJson(beforeBasic);
    const command = researchCommand(candidate, 'entity:2', 'basic-medicine.v9'); candidate = apply(candidate, command);
    const started = applySectMaintenanceResearchCommand(legacy, context(fromMaintained(legacy)), command); if (!started.ok) throw new Error(started.code); legacy = started.frame;
    for (let i = 0; i < 600 && !candidate.records.research.jobs[0]!.terminal; i++) {
      const ctx = nextContext(candidate); const result = tickSectMaintenance(legacy, ctx, createWorkPathBudget(ctx.simulationTick)); if (!result.ok) throw new Error(result.code);
      legacy = result.frame; candidate = step(candidate);
      expect(candidate.records.construction).toEqual(legacy.construction); expect(candidate.records.research).toEqual(legacy.research); expect(candidate.records.maintenance).toEqual(legacy.maintenance);
    }
    expect(candidate.records.research.jobs[0]!.terminal?.kind).toBe('completed'); expect(validateSectMaintenanceFrame(legacy)).toEqual([]);
  }, 120_000);
  it('executes herbal against a genuine migrated v10 World and maintained-v9, comparing selected domains step by step', () => {
    let candidate = seed; let legacy = cloneJson(old); let world = cloneJson(oldV10);
    const command = researchCommand(candidate); candidate = apply(candidate, command);
    const started = applySectMaintenanceResearchCommand(legacy, context(seed), command); if (!started.ok) throw new Error(started.code); legacy = started.frame;
    const admitted = prepareUnregisteredCommandCandidateV10(world, { kind: 'sect.command', commandId: command.commandId,
      issuedTick: world.clock.simulationTick, sequence: 0, payload: { domain: 'research', command } });
    if (admitted.result.status !== 'accepted') throw new Error(JSON.stringify(admitted.result)); world = admitted.world;
    for (let i = 0; i < 600 && !candidate.records.research.jobs.at(-1)!.terminal; i++) {
      const ctx = nextContext(candidate); const result = tickSectMaintenance(legacy, ctx, createWorkPathBudget(ctx.simulationTick)); if (!result.ok) throw new Error(result.code);
      legacy = result.frame; candidate = step(candidate); world = prepareNormalTickCandidateV10(world); const v10 = projectV10SectFrame(world);
      for (const original of [legacy, v10]) { expect(candidate.records.construction).toEqual(original.construction); expect(candidate.records.research).toEqual(original.research); expect(candidate.records.maintenance).toEqual(original.maintenance); }
    }
    expect(candidate.records.research.jobs.at(-1)!.terminal?.kind).toBe('completed');
  }, 180_000);
});

describe('complete unknown-source and local capacity guards', () => {
  it.each([
    ['route-version', (f: Mutable<Frame>) => { f.records.research.jobs.at(-1)!.navigation.routeVersion = 0; }],
    ['first-step', (f: Mutable<Frame>) => { f.records.research.jobs.at(-1)!.navigation.path[0] = { x: 0, y: 0 }; }],
    ['last-step', (f: Mutable<Frame>) => { f.records.research.jobs.at(-1)!.navigation.path.pop(); }],
    ['target', (f: Mutable<Frame>) => { f.records.research.jobs.at(-1)!.navigation.target = { x: 1, y: 3 }; }],
    ['empty-fractional', (f: Mutable<Frame>) => { const nav = f.records.research.jobs.at(-1)!.navigation; nav.path = []; nav.movementTicks = 1; }],
    ['future-retry', (f: Mutable<Frame>) => { f.records.research.jobs.at(-1)!.navigation.retryAtTick = f.records.construction.lastSimulationTick + 21; }],
    ['teleported-worker', (f: Mutable<Frame>) => { f.records.construction.people.find(p => p.id === 'entity:4')!.position = { x: 0, y: 10 }; }],
    ['unpaid-fractional-travel', (f: Mutable<Frame>) => { f.records.research.jobs.at(-1)!.navigation.movementTicks = 3; }],
    ['blocked-route', (f: Mutable<Frame>) => { const cell = f.records.research.jobs.at(-1)!.navigation.path[0]!; f.records.construction.map.tiles.find(t => t.x === cell.x && t.y === cell.y)!.walkable = false; }],
    ['deleted-old-research', (f: Mutable<Frame>) => { f.records.research.jobs.shift(); }],
    ['missing-maintenance', (f: Mutable<Frame>) => { f.records.maintenance.payments.shift(); }],
    ['maintenance-rate', (f: Mutable<Frame>) => { f.records.maintenance.payments[0]!.rate = { level: 2, upgradeJobId: 'sect-upgrade:1' }; }],
    ['128-record-limit', (f: Mutable<Frame>) => { while (f.records.research.jobs.length < 129) f.records.research.jobs.push(cloneJson(f.records.research.jobs[0]!)); }],
    ['256-receipt-limit', (f: Mutable<Frame>) => { while (f.records.research.receipts.length < 257) f.records.research.receipts.push(cloneJson(f.records.research.receipts[0]!)); }],
    ['401-visit-limit', (f: Mutable<Frame>) => { f.records.research.jobs.at(-1)!.visits = Array.from({ length: 402 }, () => ({ tick: 1, calendarTick: 1, position: { x: 4, y: 3 } })); }],
    ['400-span-limit', (f: Mutable<Frame>) => { f.records.research.jobs.at(-1)!.workSpans = Array.from({ length: 401 }, () => ({ firstTick: 1, lastTick: 1, firstCalendarTick: 1, lastCalendarTick: 1, visitIndex: 0 })); }],
    ['384-paired-ledger-limit', (f: Mutable<Frame>) => { while (f.records.construction.ledger.reservations.length < 385) f.records.construction.ledger.reservations.push(cloneJson(f.records.construction.ledger.reservations[0]!)); }],
    ['orphan-relocation-live', (f: Mutable<Frame>) => { f.live.push({ jobId: 'sect-relocation:999', navigation: { path: [], target: null, routeVersion: null, movementTicks: 0, retryAtTick: 0 }, blocked: null }); }],
    ['shared-blueprint-clock', (f: Mutable<Frame>) => { f.records.construction.blueprints[0]!.placedCalendarTick = 1; }],
  ] as const)('rejects %s at validator, command and both complete tick entrances without touching source/budget', (_name, mutation) => {
    const invalid = changed(traveling, mutation); const before = canonicalStringify(invalid); allReject(invalid); expect(canonicalStringify(invalid)).toBe(before);
  });
  it('rejects a genuine old gated alchemy blueprint across all retained construction history', () => {
    const result = applySectMaintenanceConstructionCommand(old, context(seed), { kind: 'blueprint.place', commandId: 'old.alchemy.history',
      expectedRevision: old.construction.revision, placement: { definitionId: 'alchemy.v9', anchor: { x: 10, y: 1 }, rotation: 0 } });
    if (!result.ok) throw new Error(result.code);
    expect(validateSectMaintenanceFrame(result.frame)).toEqual([]);
    const invalid = fromMaintained(result.frame); expect(invalid.records.construction.blueprints.at(-1)!.researchGate).toBeDefined();
    expect(validate(invalid)).toEqual(['UNSUPPORTED_RESEARCH_DOMAIN_HISTORY']); allReject(invalid);
  });
  it('rejects working-away and cached-working navigation', () => {
    allReject(changed(working, f => { f.records.construction.people.find(p => p.id === 'entity:4')!.position.x++; }));
    allReject(changed(working, f => { f.records.research.jobs.at(-1)!.navigation.target = { x: 4, y: 3 }; }));
  });
  it('pause-only simulation time cannot fund fractional research movement or positional drift', () => {
    const source = start(moved, 'entity:4'); let paused = source;
    for (let i = 0; i < 8; i++) paused = step(paused, { paused: true });
    allReject(changed(paused, f => { const nav = f.records.research.jobs.at(-1)!.navigation;
      nav.path = traveling.records.research.jobs.at(-1)!.navigation.path.map(cell => ({ ...cell })); nav.target = { x: 4, y: 3 };
      nav.routeVersion = f.records.construction.map.navVersion; nav.movementTicks = 1; }));
    allReject(changed(paused, f => { f.records.construction.people.find(p => p.id === 'entity:4')!.position.y++; }));
  });
  it('rejects accessors and aliases without invoking a getter', () => {
    let reads = 0; const getter = cloneJson(seed);
    Object.defineProperty(getter, 'records', { enumerable: true, get() { reads++; return seed.records; } }); allReject(getter); expect(reads).toBe(0);
    const aliased = changed(traveling, f => { f.records.research.jobs.at(-1)!.navigation.target = f.records.research.jobs.at(-1)!.site.position; }); allReject(aliased);
    const sharedBook = { records: seed.records, live: seed.live, copied: seed.records }; allReject(sharedBook);
  });
  it('captures command and context descriptors before reading their accessors', () => {
    let reads = 0; const command = { ...researchCommand(seed) }; Object.defineProperty(command, 'kind', { enumerable: true, get() { reads++; return 'research.start'; } });
    rejected(seed, commandCandidate(seed, context(seed), command), 'INVALID_COMMAND');
    const ctx = { ...context(seed) }; Object.defineProperty(ctx, 'paused', { enumerable: true, get() { reads++; return false; } });
    rejected(seed, commandCandidate(seed, ctx, researchCommand(seed)), 'INVALID_CONTEXT'); expect(reads).toBe(0);
  });
  it('reserves start+cancel revision and ID headroom on an otherwise valid source', () => {
    for (const field of ['revision', 'nextId'] as const) {
      const tight = changed(seed, f => { f.records.research[field] = Number.MAX_SAFE_INTEGER - 1; }); expect(validate(tight)).toEqual([]);
      rejected(tight, commandCandidate(tight, context(tight), researchCommand(tight)), 'CAPACITY_EXCEEDED');
    }
  });
  it('preserves the active cancellation headroom at the final revision and refuses productive ticking', () => {
    const tight = changed(traveling, f => { f.records.research.revision = Number.MAX_SAFE_INTEGER - 1; }); expect(validate(tight)).toEqual([]);
    const ctx = nextContext(tight); rejected(tight, tickCandidate(tight, ctx, createWorkPathBudget(ctx.simulationTick)), 'CAPACITY_EXCEEDED');
    expect(cancelResearch(tight).records.research.revision).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('rejects stale/gapped clocks and wrong-tick actual budgets without changing any book', () => {
    const bytes = canonicalStringify(traveling); const ctx = nextContext(traveling);
    rejected(traveling, tickCandidate(traveling, { ...ctx, calendarTick: ctx.calendarTick + 1 }, createWorkPathBudget(ctx.simulationTick)), 'CLOCK_GAP');
    rejected(traveling, tickCandidate(traveling, ctx, createWorkPathBudget(ctx.simulationTick + 1)), 'INVALID_CONTEXT');
    rejected(traveling, commandCandidate(traveling, ctx, researchCommand(traveling)), 'STALE_CLOCK'); expect(canonicalStringify(traveling)).toBe(bytes);
  });
});
