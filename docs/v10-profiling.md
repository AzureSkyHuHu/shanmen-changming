# Genuine v10 fixture reuse and owner CPU diagnostics

Status: tooling authored; authoring worker has **not run** tests, type checking,
fixture generation, profiling or the reused benchmark. The integration owner is
the sole executor. No production core/application algorithm changed.

## Purpose and pinned evidence

The completed genuine-workload baseline took 489.295 seconds of preparation and
847.668 seconds overall. Its owner medians were 85–92 ms for actual complex work.
Repeated genesis setup is unnecessary for each CPU investigation once the exact
earned checkpoints have been captured and completely readmitted.

The tooling pins the completed `v10-genuine-workloads-0030.json` report:

- Report file SHA-256: `c7558026ef8a08339c60659b54ac26eecd43636d7b22d509435fa53b60ff76f9`
- Source commit: `641c2b56bdf3eb5e12d48457e982f114d254a507`
- Source tree: `93957f4cddfb55c0468e0c76cf730d86c1746676`
- Genuine setup: 8,281 actual reducer ticks, 82 accepted commands
- Each of the nine canonical World SHA-256 values is pinned in
  `WORKLOAD_SOURCE_HASHES`, independently of the fixture manifest

The baseline report contains evidence and hashes, **not saved Worlds**. One new
actual genesis setup is required to write the save files. A matching manifest or
hash never substitutes for record, capacity, save or runtime admission.

## Preconditions

Run from the repository root with the locked Node 24 dependencies. Freeze a clean
Git commit first: capture, reused benchmark and profiler record HEAD/tree and
refuse tracked or untracked source changes at both beginning and end. Avoid other
repository writers as well as concurrent tests/builds while these tools run.

Output must be an explicit absolute local directory **outside the repository**.
Its parent must exist and the directory must not exist. No overwrite, deletion,
automatic cleanup, hosting, upload, network inspector port or persistent service
is performed. Interrupted outputs have no final manifest/summary and are not a
completed capture/profile; choose another new destination on retry. Never add
generated saves, manifests, CPU profiles or reports to Git.

## Capture once

```sh
node tools/benchmark-v10-workloads.mjs --run \
  --capture-fixtures=/workspace/scratch/60c35632a076/v10-earned-fixtures \
  --baseline-report=/workspace/scratch/60c35632a076/v10-genuine-workloads-0030.json \
  > /workspace/scratch/60c35632a076/v10-fixture-capture.json \
  2> /workspace/scratch/60c35632a076/v10-fixture-capture.log
```

Capture calls the original `prepareScenarios` without inventory grants, clock
edits, reduced validation or synthetic Worlds. It checks all setup counts and
all nine canonical hashes against the completed report. Each source is checked
by the full record inspector, exact v10 identity, full current/future capacity,
`admitSaveWorldV10`, `createSaveEnvelopeV10`, `serializeSaveV10` and `parseSaveV10`.
The complete World must remain exactly equal across the save round-trip.

The nine files are real canonical v10 save envelopes. The final `manifest.json`
records producing commit/tree, capture time/runtime, original baseline identity,
actual setup cost/counts, fixed filenames, byte lengths and both file and World
digests. It is written last. Capture does not run the latency benchmark.

## Profile three representative sources

```sh
node tools/profile-v10-workloads.mjs --run \
  --fixtures=/workspace/scratch/60c35632a076/v10-earned-fixtures \
  --baseline-report=/workspace/scratch/60c35632a076/v10-genuine-workloads-0030.json \
  --output=/workspace/scratch/60c35632a076/v10-owned-cpu \
  > /workspace/scratch/60c35632a076/v10-owned-cpu.json \
  2> /workspace/scratch/60c35632a076/v10-owned-cpu.log
```

Defaults are `upgrade-precheckpoint`, `alternative-care-working` and
`upgrade-half-checkpoint`: two continuous workloads and one exact payment
boundary. Use `--scenarios=NAME,NAME` for other existing named scenarios. Unknown,
duplicate, empty or more-than-nine selections fail.

Loading validates the bounded manifest and exact baseline report, file length and
digest, then runs `parseSaveV10`, complete record inspection, exact identity, full
capacity, save admission and canonical serialization/reparse. Every loaded World
must match its independently pinned original hash. Files cannot supply sampling
modes, prime counts, callbacks or verification functions; named domain assertions
are fixed TypeScript code. A corrupt, unsupported or mismatched file aborts.

For each selected scenario:

1. Create a genuine private runtime. Continuous scenarios discard three ordinary
   warmup ticks; boundary scenarios discard three whole independent trials and
   prime each retained owner with its real one-tick predecessor
2. Execute 20 `owner.advance(1)` operations with V8 CPU sampling at 1,000 µs
3. Start/stop the in-process inspector around each advance. Full strict-oracle
   computation, creation, priming, snapshot export, canonical equality, named
   domain assertions and disk writes remain outside these profiles
4. Require exact complete Worlds, the intended domain boundary, unchanged input,
   no stop/recovery, and one retained owned tick without strict fallback
5. Save every raw `.cpuprofile` and `summary.json`, including self/inclusive hot
   call sites, actual result ticks, metrics, raw diagnostic elapsed times, source
   hashes, load/admission cost and source/runtime provenance

These profiles identify where to optimize. They do **not** establish a 50 ms
latency budget. Inspector start/stop protocol, timing and sampling overhead can
appear; GC/scheduler effects remain visible. Inclusive call-site totals overlap,
must not be added as independent costs, and may group recursive calls. V8 source
coordinates are zero-based and Vite SSR URLs may need matching to the raw profile.
The summary is a sampled approximation, not exact per-stage stopwatch accounting.

## Run an unprofiled comparison without earning the sources again

```sh
node tools/benchmark-v10-workloads.mjs --run \
  --fixtures=/workspace/scratch/60c35632a076/v10-earned-fixtures \
  --baseline-report=/workspace/scratch/60c35632a076/v10-genuine-workloads-0030.json \
  --scenario=upgrade-precheckpoint --without-session \
  > /workspace/scratch/60c35632a076/v10-reused-owner.json
```

This calls the original benchmark measurement functions with full reloaded
sources. Omitting `--without-session` retains actual Session timing and the four
strict DTO comparisons. Omitting `--scenario` measures all nine. The report labels
fixture reuse, producer revision and loading cost; capture setup metadata is
provenance, not work executed during reuse. CPU profiling is never started here.

The original `--run` without capture/reuse flags still performs its unchanged
genuine setup and measurement path. Reuse remains four-person, headless evidence;
it proves nothing about renderer, browser, physical phone, 36 disciples, 3× speed,
long history, migration, public activation or complete-game acceptance.

## Initial targets and validation handoff

Inspect inclusive stacks under `prepareValidatedV10CultivationClock`,
`readV10PreWorkDeaths`, `captureV10RecordData`, `assessManagementCapacityV10`,
`inspectUnregisteredWorldV10Records`, `inspectReservedDischargeRecordsV10`, and
`restoreHistoryArchive`, plus self time in canonical serialization, descriptor
walking and GC. Choose the largest measured source before implementing an
optimization. Preserve complete validation and public safety.

The focused `tests/tools/v10-workload-fixtures.test.ts` suite checks only bounded
metadata parsing, immutable baseline pins, rejection of imported policy/path
fields, report mismatch and CPU attribution arithmetic. Its metadata placeholders
and synthetic profiler records are explicitly **not gameplay fixtures**. Importing
the tooling does not prepare a World or connect an inspector. The genuine capture
and profile runs remain separate opt-in integration evidence.

Tooling/test imports use explicit `.ts` extensions, supported by the repository's
`allowImportingTsExtensions` setting. This prevents Vite/Vitest from resolving the
same-basename `.mjs` command-line launchers instead of the implementation modules.

Integration owner commands:

```sh
npx vitest run tests/tools/v10-workload-fixtures.test.ts
npm run typecheck
npm run check:boundaries
node tools/benchmark-v10-workloads.mjs
node tools/profile-v10-workloads.mjs
```

Freeze the verified tooling before the single capture run. No tests, capture or
performance outcome is claimed by this document until the integration owner records
actual execution results.

## 2026-10-03 integration preparation

The 16 metadata/profile-arithmetic seam tests passed (1.78 seconds); strict type
checking, core boundaries, and both no-run launcher paths passed. The first test
attempt exposed extensionless imports selecting same-named `.mjs` launchers;
explicit `.ts` implementation imports fixed that. The profiler metrics array now
uses the actual exported runtime metrics type. Genuine capture and CPU profiling
remain separate, not yet completed by these checks.
