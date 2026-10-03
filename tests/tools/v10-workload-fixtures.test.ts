import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Profiler } from 'node:inspector';
import { describe, expect, it } from 'vitest';
import { SCENARIO_NAMES } from '../../tools/benchmark-v10-workloads.ts';
import { DEFAULT_PROFILE_SCENARIOS, readWorkloadBaseline, summarizeCpuProfiles, validateFixtureManifest,
  WORKLOAD_BASELINE, WORKLOAD_SOURCE_HASHES, type FixtureManifest } from '../../tools/profile-v10-workloads.ts';

/** Metadata-only seam input. These placeholders are NOT save files, captured
 * Worlds, earned gameplay fixtures or evidence that a scenario was admitted. */
function metadata(): FixtureManifest {
  return { schemaVersion: 1, scope: 'genuine-v10-workload-fixtures', baselineReportSha256: WORKLOAD_BASELINE.reportSha256,
    baselineSource: { commit: WORKLOAD_BASELINE.commit, tree: WORKLOAD_BASELINE.tree },
    producer: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, createdAt: 'metadata parser test only', node: 'test', platform: 'test', arch: 'test',
    setup: { milliseconds: 1, reducerTicks: WORKLOAD_BASELINE.reducerTicks, acceptedCommands: WORKLOAD_BASELINE.acceptedCommands,
      finalEarnedCareWorldSha256: WORKLOAD_BASELINE.finalEarnedCareWorldSha256 },
    scenarios: SCENARIO_NAMES.map(name => ({ name, file: `${name}.save-v10.json`, fileSha256: 'c'.repeat(64),
      canonicalWorldSha256: WORKLOAD_SOURCE_HASHES[name], bytes: 100 })) };
}

describe('v10 workload metadata boundaries, without gameplay setup', () => {
  it('pins all nine hashes and includes both continuous and boundary profile defaults', () => {
    expect(Object.keys(WORKLOAD_SOURCE_HASHES).sort()).toEqual([...SCENARIO_NAMES].sort());
    expect(WORKLOAD_BASELINE.reportSha256).toBe('c7558026ef8a08339c60659b54ac26eecd43636d7b22d509435fa53b60ff76f9');
    expect(DEFAULT_PROFILE_SCENARIOS).toEqual(['upgrade-precheckpoint', 'alternative-care-working', 'upgrade-half-checkpoint']);
  });
  it('accepts only the metadata shape, without returning admission fields or a World', () => {
    const result = validateFixtureManifest(metadata());
    expect(result).not.toHaveProperty('world'); expect(result).not.toHaveProperty('admitted');
    expect(result.scenarios).toHaveLength(9);
  });
  it('rejects missing and duplicate scenario rows', () => {
    const missing = metadata(); missing.scenarios.pop(); expect(() => validateFixtureManifest(missing)).toThrow('all nine');
    const duplicate = metadata(); duplicate.scenarios[1] = { ...duplicate.scenarios[0]! };
    expect(() => validateFixtureManifest(duplicate)).toThrow('Duplicate');
  });
  it('rejects unknown scenarios, extra executable metadata and alternate baselines', () => {
    const unknown = metadata(); (unknown.scenarios[0] as unknown as Record<string, unknown>).name = 'idle';
    expect(() => validateFixtureManifest(unknown)).toThrow('Unknown');
    expect(() => validateFixtureManifest({ ...metadata(), verify: 'return true' })).toThrow('fields');
    const baseline = metadata(); baseline.baselineReportSha256 = '0'.repeat(64);
    expect(() => validateFixtureManifest(baseline)).toThrow('baseline');
  });
  it('rejects directory traversal and imported sampling or prime policies', () => {
    const traversal = metadata(); traversal.scenarios[0]!.file = '../source.json';
    expect(() => validateFixtureManifest(traversal)).toThrow('basenames');
    const policy = metadata(); Object.assign(policy.scenarios[0]!, { primeTicks: 0, mode: 'idle' });
    expect(() => validateFixtureManifest(policy)).toThrow('scenario');
  });
  it('rejects a changed canonical source hash even with a plausible file digest', () => {
    const value = metadata(); value.scenarios[0]!.canonicalWorldSha256 = '0'.repeat(64);
    expect(() => validateFixtureManifest(value)).toThrow('recorded baseline');
  });
  it.each([0, -1, 4 * 1024 * 1024 + 1, 1.5, Number.POSITIVE_INFINITY])('rejects invalid file size %s before loading', bytes => {
    const value = metadata(); value.scenarios[0]!.bytes = bytes;
    expect(() => validateFixtureManifest(value)).toThrow('bound');
  });
  it('rejects a fabricated genuine setup count and producer revision', () => {
    const count = metadata(); count.setup.reducerTicks--;
    expect(() => validateFixtureManifest(count)).toThrow('setup provenance');
    const revision = metadata(); revision.producer.tree = 'dirty';
    expect(() => validateFixtureManifest(revision)).toThrow('revision');
  });
  it('does not accept a replacement report that merely claims the right source hashes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'v10-baseline-parser-'));
    try {
      const path = join(directory, 'report.json');
      writeFileSync(path, JSON.stringify({ rows: SCENARIO_NAMES.map(scenario => ({ scenario,
        source: { canonicalWorldSha256: WORKLOAD_SOURCE_HASHES[scenario] } })) }));
      expect(() => readWorkloadBaseline(path)).toThrow('SHA-256 differs');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('CPU profile attribution seam, synthetic profiler records only', () => {
  const frame = (functionName: string) => ({ functionName, scriptId: '1', url: 'profile-seam.ts', lineNumber: 0, columnNumber: 0 });
  const profile = (): Profiler.Profile => ({ startTime: 0, endTime: 30,
    nodes: [{ id: 1, callFrame: frame('root'), children: [2] }, { id: 2, callFrame: frame('work') }],
    samples: [2, 2, 1], timeDeltas: [10, 15, 5] });
  it('accounts self and overlapping inclusive samples without double-counting time', () => {
    const result = summarizeCpuProfiles([profile()]);
    expect(result.attributedMicroseconds).toBe(30); expect(result.sampleCount).toBe(3);
    expect(result.topSelf[0]).toMatchObject({ functionName: 'work', selfMicroseconds: 25, inclusiveMicroseconds: 25, samples: 2 });
    expect(result.topInclusive[0]).toMatchObject({ functionName: 'root', selfMicroseconds: 5, inclusiveMicroseconds: 30 });
  });
  it('aggregates matching call sites across independent boundary profiles', () => {
    const result = summarizeCpuProfiles([profile(), profile()]);
    expect(result.attributedMicroseconds).toBe(60); expect(result.topSelf[0]!.selfMicroseconds).toBe(50);
  });
  it('rejects inconsistent samples and malformed call trees', () => {
    const missing = profile(); missing.timeDeltas = [];
    expect(() => summarizeCpuProfiles([missing])).toThrow('lengths differ');
    const unknown = profile(); unknown.samples = [99, 2, 1];
    expect(() => summarizeCpuProfiles([unknown])).toThrow('unknown node');
    const cyclic = profile(); cyclic.nodes[1]!.children = [1];
    expect(() => summarizeCpuProfiles([cyclic])).toThrow('Cyclic');
  });
});
