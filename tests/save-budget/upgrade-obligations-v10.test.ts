import { describe, expect, it } from 'vitest';
import { SECT_V9_CANDIDATE_IDENTITY } from '../../src/content/sect-v9/catalog';
import type { SectResourceLine } from '../../src/content/sect-v9/types';
import { emptyNavigation } from '../../src/core/agents/navigation';
import type { LedgerClaim } from '../../src/core/economy/ledger-operations';
import type { ResourceId } from '../../src/core/economy/types';
import { cloneJson } from '../../src/core/kernel/serialization';
import { navigationPathByteBudget } from '../../src/core/save-budget/bounds';
import { measureProgressionRecord as measure } from '../../src/core/save-budget/progression-bounds';
import { deriveSectUpgradeObligationsV10, type SectUpgradeBranchBoundV10, type SectUpgradeRecordSourceV10,
  type SectUpgradeOwnerBoundV10 } from '../../src/core/save-budget/upgrade-obligations-v10';
import type { SectLedgerReservation } from '../../src/core/sect-expansion/ledger';
import { SECT_UPGRADE_LIMITS_V10 as LIMITS, type SectUpgradeJobV10, type SectUpgradeReceiptV10 } from '../../src/core/sect-expansion/upgrade-types';

const MAX = Number.MAX_SAFE_INTEGER;
const METRICS = ['bytes', 'decodedCharacters', 'decodedNodes'] as const;
const PRICE: readonly SectResourceLine[] = [{ ledger: 'base', resourceId: 'stone', quantity: 6 }, { ledger: 'base', resourceId: 'plank', quantity: 6 }];
const HALF: readonly SectResourceLine[] = PRICE.map(line => ({ ...line, quantity: 3 }));

/** Synthetic record-sizing surfaces, deliberately NOT valid World/domain fixtures.
 * These omit earned research/construction, paid intervals, lifecycle and identity
 * closure. No passing budget assertion is an assertion of game-state validity. */
function fixture(activeTicks = 0, width = 20, height = 20, ref = 'entity:2'): SectUpgradeRecordSourceV10 {
  const position = { x: 0, y: 0 };
  const job: SectUpgradeJobV10 = {
    jobId: 'sect-upgrade:1', reservationId: 'sect-upgrade-reservation:2', workerId: ref, buildingId: 'sect-building:4',
    fromLevel: 1, toLevel: 2, requiredTicks: 400,
    researchGate: { researchId: 'herbal-compatibility.v9', completionJobId: ref },
    site: { buildingId: 'sect-building:4', definitionId: 'alchemy.v9', sourceJobId: ref, position, level: 1, firstMaintenanceCalendarTick: 1200 },
    storageId: ref, storagePosition: position, seatToken: 'sect-building:4', entranceToken: '0,0',
    startedTick: 0, startedCalendarTick: 0, origin: position, phase: activeTicks ? 'working' : 'to-storage',
    storageVisit: activeTicks ? { tick: 1, calendarTick: 1, position } : null,
    siteVisits: activeTicks ? [{ tick: 2, calendarTick: 2, position }] : [],
    workSpans: activeTicks ? [{ firstTick: 3, lastTick: activeTicks + 2, firstCalendarTick: 3, lastCalendarTick: activeTicks + 2, visitIndex: 0 }] : [],
    checkpoints: activeTicks < 200 ? [] : [{ checkpointId: 'construction.half', activeTicks: 200, tick: 202, calendarTick: 202, position }],
    activeTicks, navigation: emptyNavigation(), blocked: null, terminal: null,
  };
  const receipt: SectUpgradeReceiptV10 = { command: { kind: 'upgrade.start', commandId: 'sizing.start', expectedRevision: 0,
    buildingId: job.buildingId, workerId: job.workerId }, revision: 1, jobId: job.jobId };
  return cloneJson({ map: { width, height }, disciples: [{ id: ref, position, traveling: true }], sectExpansion: { schemaVersion: 2,
    upgrade: { schemaVersion: 1, protocol: 'alchemy-l1-l2.1', catalogIdentity: SECT_V9_CANDIDATE_IDENTITY,
      revision: activeTicks + 1, nextId: 3, jobs: [job], receipts: [receipt] }, reservations: [claim(job, activeTicks)] } });
}
function claim(job: SectUpgradeJobV10, activeTicks: number, ended?: 'complete' | 'cancel'): SectLedgerReservation {
  const identity = { reservationId: job.reservationId, ownerTransactionId: job.jobId };
  function side<R extends string>(lines: LedgerClaim<R>['lines']): LedgerClaim<R> {
    const half = lines.map(line => ({ ...line, quantity: 3 }));
    const checkpoints = activeTicks < 200 ? [] : [{ checkpointId: 'construction.half', lines: half },
      ...(activeTicks === 400 ? [{ checkpointId: 'construction.remainder', lines: half }] : [])];
    return { ...identity, lines, consumed: activeTicks === 400 ? lines : activeTicks >= 200 ? half : [],
      remainingReservation: ended ? [] : activeTicks >= 200 ? half : lines, checkpoints,
      settlement: ended === 'complete' ? { kind: 'committed', operationId: `complete:${job.jobId}`, outputs: [] }
        : ended === 'cancel' ? { kind: 'released', operationId: `cancel:${job.jobId}` } : null };
  }
  return { ...identity, policy: 'construction-checkpoints', base: side<ResourceId>([{ resourceId: 'stone', quantity: 6 }, { resourceId: 'plank', quantity: 6 }]), sect: side([]) };
}
function proof(source: SectUpgradeRecordSourceV10): SectUpgradeOwnerBoundV10 {
  const result = deriveSectUpgradeObligationsV10(source);
  expect(result.supported, result.unknowns.join(';')).toBe(true);
  expect(result.admitted).toBe(false);
  expect(result.owners).toHaveLength(1);
  return result.owners[0]!;
}
function covers(before: SectUpgradeRecordSourceV10, after: SectUpgradeRecordSourceV10, kind: SectUpgradeBranchBoundV10['kind']): void {
  const result = deriveSectUpgradeObligationsV10(before); const owner = proof(before);
  const used = measure(before); const actual = measure(after);
  for (const metric of METRICS) {
    const branchMaximum = Math.max(...owner.branches.filter(branch => branch.kind === kind).map(branch => branch[metric]));
    expect(branchMaximum + result.shared[metric], `${kind}:${metric}`).toBeGreaterThanOrEqual(Math.max(0, actual[metric] - used[metric]));
    expect(owner[metric]).toBe(Math.max(...owner.branches.map(branch => branch[metric])));
  }
}
function terminal(source: SectUpgradeRecordSourceV10, kind: 'completed' | 'requested' | 'death', maximumEvidence = false): SectUpgradeRecordSourceV10 {
  const prior = source.sectExpansion.upgrade.jobs[0]!;
  const activeTicks = kind === 'completed' ? 400 : maximumEvidence ? 399 : prior.activeTicks;
  const position = { x: source.map.width - 1, y: source.map.height - 1 };
  const deathId = '\u0000'.repeat(128 - 'system/v10/death/'.length - '/'.length - prior.jobId.length);
  const job: SectUpgradeJobV10 = { ...prior, activeTicks, phase: kind === 'completed' ? 'completed' : 'cancelled',
    storageVisit: { tick: MAX, calendarTick: MAX, position }, navigation: emptyNavigation(), blocked: null,
    ...(maximumEvidence ? {
      siteVisits: Array.from({ length: LIMITS.siteVisits }, () => ({ tick: MAX, calendarTick: MAX, position: { ...position } })),
      workSpans: Array.from({ length: LIMITS.workSpans }, () => ({ firstTick: MAX, lastTick: MAX, firstCalendarTick: MAX, lastCalendarTick: MAX, visitIndex: 400 })),
    } : {}),
    checkpoints: activeTicks >= 200 ? [{ checkpointId: 'construction.half', activeTicks: 200, tick: MAX, calendarTick: MAX, position },
      ...(activeTicks === 400 ? [{ checkpointId: 'construction.remainder' as const, activeTicks: 400 as const, tick: MAX, calendarTick: MAX, position }] : [])] : [],
    terminal: kind === 'completed'
      ? { kind: 'completed', previousPhase: 'working', resultLevel: 2, cancellation: null, consumed: PRICE, released: [], tick: MAX, calendarTick: MAX, position, upgradeRevision: MAX }
      : { kind: 'cancelled', previousPhase: 'to-storage', resultLevel: 1,
        cancellation: kind === 'requested' ? { kind: 'requested' } : { kind: 'death', deathId },
        consumed: activeTicks < 200 ? [] : HALF, released: activeTicks < 200 ? PRICE : HALF,
        tick: MAX, calendarTick: MAX, position, upgradeRevision: MAX },
  };
  const receipt: SectUpgradeReceiptV10 = { command: { kind: 'upgrade.cancel', expectedRevision: MAX - 1, jobId: job.jobId,
    commandId: kind === 'death' ? `system/v10/death/${deathId}/${job.jobId}` : 'c'.repeat(128) }, revision: MAX, jobId: job.jobId };
  return cloneJson({ ...source, disciples: [{ ...source.disciples[0]!, position, traveling: false }],
    sectExpansion: { ...source.sectExpansion, upgrade: { ...source.sectExpansion.upgrade, revision: MAX,
      jobs: [job], receipts: [...source.sectExpansion.upgrade.receipts, ...(kind === 'completed' ? [] : [receipt])] },
    reservations: [claim(job, activeTicks, kind === 'completed' ? 'complete' : 'cancel')] } });
}

describe('added upgrade-owner typed record sizing, never v10 admission', () => {
  it.each([0, 199, 200, 399])('bounds retained evidence, completion and both cancellations from %i work ticks', activeTicks => {
    const source = fixture(activeTicks); const owner = proof(source);
    covers(source, terminal(source, 'completed'), 'completion');
    for (const kind of ['requested', 'death'] as const) {
      covers(source, terminal(source, kind), 'cancellation');
      covers(source, terminal(source, kind, true), 'cancellation');
    }
    covers(source, terminal(source, 'completed', true), 'completion');
    expect(owner.rows).toEqual({ upgradeReceipts: 1, upgradeJobs: 0, pairedClaims: 0, buildings: 0 });
    expect(owner.counters).toEqual({ upgradeRevisions: 1, upgradeNextId: 0, navVersion: 0 });
    expect(owner.remaining).toMatchObject({ workTicks: 400 - activeTicks, siteVisits: activeTicks ? 400 : 401,
      workSpanSlots: activeTicks ? 399 : 400, appendableWorkSpans: 400 - activeTicks, checkpoints: activeTicks >= 200 ? 1 : 2 });
  });
  it('chooses whole mutually exclusive branches independently for each metric', () => {
    const owner = proof(fixture(199));
    for (const metric of METRICS) {
      expect(owner[metric]).toBe(Math.max(...owner.branches.map(branch => branch[metric])));
      for (const branch of owner.branches) expect(branch[metric]).toBe(branch.records.reduce((sum, record) => sum + record[metric], 0));
      expect(owner[metric]).toBeLessThan(owner.branches.reduce((sum, branch) => sum + branch[metric], 0));
    }
    expect(owner.branches.filter(branch => branch.kind === 'completion').every(branch => branch.records.every(record => record.label !== 'upgrade.cancel-receipt'))).toBe(true);
  });
  it('bounds each live paired-payment alternative together with actual worker fields', () => {
    const source = fixture(199, 9, 10); const owner = proof(source);
    for (const bound of owner.branches.filter(branch => branch.kind === 'live-peak')) {
      const jobRecord = bound.records.find(record => record.label === 'upgrade.job')!;
      const skeleton = cloneJson(jobRecord.witness as SectUpgradeJobV10);
      // Independent expansion of an explicitly synthetic maximum-width witness.
      // Do not submit this deliberately unreachable collection to a game reducer.
      const expanded = { ...skeleton, navigation: { ...skeleton.navigation } };
      for (const row of jobRecord.repeated) {
        const values = Array.from({ length: row.count }, () => cloneJson(row.sample));
        if (row.field === 'navigation.path') Object.assign(expanded.navigation, { path: values });
        else Object.assign(expanded, { [row.field]: values });
      }
      expect(measure(expanded)).toEqual(jobRecord.maximum);
      const paired = bound.records.find(record => record.label === 'paired-ledger')!.witness as SectLedgerReservation;
      const worker = bound.records.find(record => record.label === 'World.worker.position+traveling')!.witness;
      const next: SectUpgradeRecordSourceV10 = { ...source,
        disciples: [{ ...source.disciples[0]!, ...worker }], sectExpansion: { ...source.sectExpansion,
          upgrade: { ...source.sectExpansion.upgrade, revision: MAX, jobs: [expanded] }, reservations: [paired] } };
      covers(source, next, 'live-peak');
    }
  });
  it('subtracts retained 399-span evidence only from the full future record envelope', () => {
    const initial = fixture(399, 256, 256); const maximum = terminal(initial, 'completed', true);
    const completed = maximum.sectExpansion.upgrade.jobs[0]!;
    const job: SectUpgradeJobV10 = { ...initial.sectExpansion.upgrade.jobs[0]!,
      siteVisits: completed.siteVisits.slice(0, 400), workSpans: completed.workSpans.slice(0, 399) };
    const source: SectUpgradeRecordSourceV10 = { ...initial, sectExpansion: { ...initial.sectExpansion,
      upgrade: { ...initial.sectExpansion.upgrade, jobs: [job] } } };
    const owner = proof(source);
    expect(owner.remaining).toMatchObject({ siteVisits: 1, workSpanSlots: 1, appendableWorkSpans: 1, checkpoints: 1 });
    covers(source, terminal(source, 'completed', true), 'completion');
    covers(source, terminal(source, 'death', true), 'cancellation');
    expect(owner.bytes).toBeLessThan(proof(initial).bytes);
  });
  it.each([[1, 1], [9, 10], [99, 100], [256, 256]])('derives %i × %i paths without allocating a full map witness', (width, height) => {
    const source = fixture(199, width, height); const owner = proof(source);
    const live = owner.branches.find(branch => branch.kind === 'live-peak')!;
    const job = live.records.find(record => record.label === 'upgrade.job')!;
    const path = job.repeated.find(row => row.field === 'navigation.path')!;
    expect(path.count).toBe(width * height);
    expect(path.count * measure(path.sample).bytes + Math.max(0, path.count - 1)).toBe(navigationPathByteBudget(source.map) - 2);
    expect(path.count * measure(path.sample).decodedNodes).toBe(width * height * 3);
    expect((job.witness as SectUpgradeJobV10).navigation.path).toEqual([]);
    for (const metric of METRICS) {
      const skeleton = measure(job.witness)[metric];
      const expanded = job.repeated.reduce((sum, row) => sum + row.count * measure(row.sample)[metric]
        + (metric === 'decodedNodes' ? 0 : Math.max(0, row.count - 1)), skeleton);
      expect(job.maximum[metric]).toBe(expanded);
      expect(job[metric]).toBe(Math.max(0, expanded - measure(source.sectExpansion.upgrade.jobs[0])[metric]));
    }
  });
  it.each(['x', '\u0000', '\ud800', '界', '😀'])('keeps actual maximum legal reference strings: %s', unit => {
    const reference = unit.repeat(128 / unit.length);
    const source = fixture(200, 256, 256, reference);
    covers(source, terminal(source, 'completed', true), 'completion');
    covers(source, terminal(source, 'death', true), 'cancellation');
    const owner = proof(source); const death = owner.branches.find(branch => branch.variant === 'death-after-half')!;
    const receipt = death.records.find(record => record.label === 'upgrade.cancel-receipt')!.witness as SectUpgradeReceiptV10;
    expect(receipt.command.commandId.length).toBe(128);
    expect(receipt.command.commandId.startsWith('system/v10/death/')).toBe(true);
    expect(receipt.command.expectedRevision).toBe(MAX - 1); expect(receipt.revision).toBe(MAX);
    const job = death.records.find(record => record.label === 'upgrade.job')!.witness as SectUpgradeJobV10;
    expect(job.workerId).toBe(reference); expect(job.site.sourceJobId).toBe(reference);
    const paired = death.records.find(record => record.label === 'paired-ledger')!.witness as SectLedgerReservation;
    expect(paired.base.settlement?.operationId).toBe(`cancel:${job.jobId}`);
    expect(paired.sect.checkpoints).toEqual([{ checkpointId: 'construction.half', lines: [] }]);
  });
  it('funds the last cancel receipt and revision, refusing the next boundary independently of sizing support', () => {
    const initial = fixture();
    const at = (count: number, revision: number): SectUpgradeRecordSourceV10 => ({ ...initial, sectExpansion: { ...initial.sectExpansion,
      upgrade: { ...initial.sectExpansion.upgrade, revision, receipts: Array.from({ length: count }, () => cloneJson(initial.sectExpansion.upgrade.receipts[0]!)) } } });
    // Duplicate receipts here are intentionally synthetic row-pressure fixtures.
    expect(deriveSectUpgradeObligationsV10(at(255, MAX - 1)).headroom.fits).toBe(true);
    for (const source of [at(256, MAX - 1), at(255, MAX)]) {
      const result = deriveSectUpgradeObligationsV10(source);
      expect(result.supported).toBe(true); expect(result.headroom.fits).toBe(false); expect(result.admitted).toBe(false);
    }
    const done = terminal(initial, 'completed');
    expect(deriveSectUpgradeObligationsV10(done)).toMatchObject({ supported: true, owners: [], shared: { bytes: 0, decodedCharacters: 0, decodedNodes: 0 },
      totals: { bytes: 0, decodedCharacters: 0, decodedNodes: 0 }, headroom: { fits: true } });
    expect(done.sectExpansion.upgrade.jobs).toHaveLength(1); expect(done.sectExpansion.reservations).toHaveLength(1);
  });
  it('charges no second start/claim/building and preserves already terminal history at maximum local ID', () => {
    const initial = fixture(200, 256, 256); const completed = terminal(initial, 'completed', true);
    const jobs: SectUpgradeJobV10[] = [];
    for (let i = 0; i < 128; i++) jobs.push({ ...(i === 127 ? initial : completed).sectExpansion.upgrade.jobs[0]!,
      jobId: `sect-upgrade:${i * 2 + 1}`, reservationId: `sect-upgrade-reservation:${i * 2 + 2}` });
    const source: SectUpgradeRecordSourceV10 = { ...initial, sectExpansion: { ...initial.sectExpansion,
      upgrade: { ...initial.sectExpansion.upgrade, jobs, nextId: 257 },
      reservations: jobs.map((job, index) => claim(job, index === 127 ? 200 : 400, index === 127 ? undefined : 'complete')) } };
    const before = measure(source); const result = deriveSectUpgradeObligationsV10(source);
    expect(result.supported).toBe(true); expect(result.owners).toHaveLength(1);
    expect(result.owners[0]!.jobId).toBe('sect-upgrade:255');
    expect(result.totals.rows).toEqual({ upgradeReceipts: 1, upgradeJobs: 0, pairedClaims: 0, buildings: 0 });
    expect(measure(source)).toEqual(before);
    expect(result.owners[0]!.branches.some(branch => branch.records.some(record => record.current.bytes >= before.bytes))).toBe(false);
  });
  it('reserves every simultaneous owner cancellation and retains the existing paired-book ceiling', () => {
    const initial = fixture();
    const jobs = Array.from({ length: LIMITS.activeJobs }, (_, index): SectUpgradeJobV10 => ({ ...initial.sectExpansion.upgrade.jobs[0]!,
      jobId: `sect-upgrade:${index * 2 + 1}`, reservationId: `sect-upgrade-reservation:${index * 2 + 2}`, workerId: `worker:${index}` }));
    const source: SectUpgradeRecordSourceV10 = { ...initial,
      disciples: jobs.map(job => ({ id: job.workerId, position: { x: 0, y: 0 }, traveling: true })),
      sectExpansion: { ...initial.sectExpansion, upgrade: { ...initial.sectExpansion.upgrade,
        revision: MAX - LIMITS.activeJobs, nextId: jobs.length * 2 + 1, jobs,
        receipts: Array.from({ length: LIMITS.receipts - LIMITS.activeJobs }, () => cloneJson(initial.sectExpansion.upgrade.receipts[0]!)) },
      reservations: jobs.map(job => claim(job, 0)) } };
    const result = deriveSectUpgradeObligationsV10(source);
    expect(result.headroom.fits).toBe(true); expect(result.owners).toHaveLength(36);
    expect(result.totals.rows.upgradeReceipts).toBe(36); expect(result.totals.counters.upgradeRevisions).toBe(36);
    for (const metric of METRICS) expect(result.totals[metric]).toBe(result.shared[metric] + result.owners.reduce((total, owner) => total + owner[metric], 0));
    const noRevision: SectUpgradeRecordSourceV10 = { ...source, sectExpansion: { ...source.sectExpansion,
      upgrade: { ...source.sectExpansion.upgrade, revision: source.sectExpansion.upgrade.revision + 1 } } };
    expect(deriveSectUpgradeObligationsV10(noRevision).headroom.fits).toBe(false);
    // Inert extra claims are row-pressure data only, never valid owner closure.
    const paired = (count: number): SectUpgradeRecordSourceV10 => ({ ...source, sectExpansion: { ...source.sectExpansion,
      reservations: [...source.sectExpansion.reservations, ...Array.from({ length: count - jobs.length }, (_, index) => {
        const other = { ...jobs[0]!, jobId: `other:${index}`, reservationId: `other-reservation:${index}` };
        return claim(other, 400, 'complete');
      })] } });
    expect(deriveSectUpgradeObligationsV10(paired(384)).headroom.fits).toBe(true);
    expect(deriveSectUpgradeObligationsV10(paired(385)).headroom.fits).toBe(false);
  });
  it('returns isolated witness diagnostics and does not retain a caller-reusable authority', () => {
    const source = fixture(200); const before = cloneJson(source); const result = deriveSectUpgradeObligationsV10(source);
    const witness = result.owners[0]!.branches[0]!.records[0]!.witness as SectUpgradeJobV10;
    Object.assign(witness.researchGate, { completionJobId: 'changed diagnostic' });
    expect(source).toEqual(before);
    const next = deriveSectUpgradeObligationsV10(source);
    expect(next.admitted).toBe(false); expect(next.owners[0]!.bytes).toBe(result.owners[0]!.bytes);
  });
  it('does not derive a claim for missing owners, unsafe maps, non-JSON or a terminal owner rewritten active400', () => {
    const source = fixture();
    const bad: SectUpgradeRecordSourceV10[] = [
      { ...source, map: { width: 257, height: 1 } }, { ...source, map: { width: 0, height: 1 } },
      { ...source, disciples: [] }, { ...source, sectExpansion: { ...source.sectExpansion, reservations: [] } },
      { ...source, sectExpansion: { ...source.sectExpansion, upgrade: { ...source.sectExpansion.upgrade,
        jobs: [{ ...source.sectExpansion.upgrade.jobs[0]!, activeTicks: 400 }] } } },
    ];
    let getterCalled = false;
    const accessor = cloneJson(source);
    Object.defineProperty(accessor.sectExpansion.upgrade, 'revision', { enumerable: true, get: () => { getterCalled = true; return 1; } });
    bad.push(accessor);
    for (const candidate of bad) expect(deriveSectUpgradeObligationsV10(candidate)).toMatchObject({ supported: false, admitted: false, owners: [], headroom: { fits: false } });
    expect(getterCalled).toBe(false);
  });
});
