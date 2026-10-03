# v10 single captured-record inspection

Status: authored and source-reviewed, **not executed by the author**. The
integration owner runs types, tests, builds and genuine workload comparisons.
There is no performance acceptance or public-v10 activation claim for this patch.

## Measured reason and limited scope

The preceding owned-advance CPU profile identified two consecutive complete
immutable captures inside each capacity assessment: its own captured World and
the record inspector's second capture of that already detached, deeply frozen
tree. Restricting attribution to the real runtime owner ancestry, including
inlined copy/freeze frames, the second capture accounted for approximately
53.7 / 56.5 / 57.2 ms across 20 advances in upgrade-precheckpoint,
alternative-care-working and upgrade-half-checkpoint respectively. This is
roughly 3–4% of sampled owner time, not predicted latency savings.

The larger assessment pool also includes full lifecycle/sect validation,
evidence serialization, descriptor gates, reservation derivation and exact
envelope measurement. Inclusive profile groups overlap. This change does not
remove those checks or claim their cost disappears. Sharing the same frozen
identity between measurement and inspection may affect existing authenticated
counters, but any effect must be measured rather than assumed.

After the separate counter-reuse patch, the integration owner reported genuine
all-nine-scenario exact comparisons with owner p50 values of 57.780–66.348 ms.
Those are preceding-patch results, not measurements of this implementation; the
50 ms tick budget still failed. Broader regression and these new measurements
remain separate gates.

Production edits are limited to `kernel/validation.ts`, `kernel/index.ts` and
`world/management-capacity-v10.ts`. The owned runtime candidate's independent
capture, general mutable capture, frozen-capture implementation, every domain
validator, archive module, capacity equations and v1–v9 branches are unchanged.

## Fixed factory and ownership

The new factory and `V10RecordInspection` type are exported only from their
implementation module for direct internal composition imports. The kernel
barrel now explicitly re-exports all twelve preexisting validation functions,
including both existing v9/v10 record inspectors, and excludes only the new
factory and handle type. There were no preexisting validation type exports to
remove. This preserves the old barrel surface; it does not claim that the old
inspectors were previously private. Here, internal means the new composition
API is absent from the aggregate barrel, not that direct module imports form a
security boundary or that the handle grants admission authority.

`captureV10RecordInspection(input)` always calls the existing complete bounded
`captureFrozenV10RecordData`, including for externally frozen inputs. It returns
a frozen object with exactly two fields:

- `data`: the complete detached tree, recursively frozen at runtime; its public
  type is `unknown`, not a claim that the data is a valid World
- `inspect()`: an argument-free lexical closure over precisely that tree

The descriptor capture retains its original byte/node/depth bounds, alias and
cycle rejection, ordinary-prototype checks, complete property descriptors,
dense enumerable array requirements and finite-JSON restrictions. It does not
freeze the caller or keep caller-owned child objects. Proxy reflection can still
execute traps during capture, and no universal hostile-Proxy/atomic-snapshot
guarantee is introduced. Revoking a caller Proxy after successful capture cannot
revoke the detached data tree.

Readonly declarations are not the isolation mechanism: deep runtime freezing is.
Neither a mutable original, a shallow-frozen parent with mutable children, nor a
new getter on the original can change the captured source. Each new factory or
standalone-root call captures again and observes the then-current input.

`inspect()` takes no source, callback, policy, limits or trust marker. Its source
comes from a lexical constant, never `this` or supplied arguments. No admission
or validation API accepts a caller-supplied handle; forging a similar object
grants nothing. The private captured-record function is not exported.

Every `inspect()` invokes the complete existing root-field and literal-version-10
validation path. There is no cached validation result. Returned string arrays
are copied afresh, so mutating diagnostics cannot poison later calls. Existing
internally authenticated immutable measurement/evidence caches retain their
own unchanged behavior and do not become admission authority.

## Preserved order and failure behavior

Capacity still performs, in order:

1. Safe preliminary caller measurement, including the complete envelope, to
   preserve over-cap diagnostics even when bounded capture rejects the source
2. Complete bounded capture and recursive freeze
3. Exact envelope measurement of the detached data
4. Exact management-v10 identity checks
5. Complete record inspection of that same immutable data
6. Existing dimensions, reservations, deficits and final classification

The factory does not inspect during step 2. An incorrect identity still fails
before record diagnostics are populated. Shape-correct but invalid synthetic
pressure sources may retain sizing diagnostics, but source issues continue to
exclude supported/fits. Record-root field failures retain
`Invalid internal v10 root fields`; capture/inspection exceptions retain
`Invalid internal v10 records` through the standalone wrapper. No arbitrary
caller-thrown error object is inspected.

`inspectUnregisteredWorldV10Records(input)` remains an always-fresh external
capture boundary. It constructs its own factory and inspects it; passing a
previous captured/frozen tree still creates a fresh detached copy. The capacity
path alone avoids asking this wrapper to copy the already captured tree again.

Archive restoration still occurs at the original full-validator location.
Freezing ordinary archive data does not seal/authenticate it. Each inspection
restores the archive, constructs its own single archive-restored World wrapper,
and passes the exact same wrapper to lifecycle inspection and six-owner
closure. Exact-object lifecycle evidence, all domain validation, full shared
ledger closure and residual cross-boundary checks remain intact.

## Regression coverage and integration handoff

The focused `v10-single-capture-inspection.test.ts` covers:

- Deep immutable isolation, fresh standalone captures, mutable general capture,
  shallow-frozen originals, post-capture mutation/getters and revoked Proxies
- Foreign `this`/arguments, forged handles, handle/data mutation and diagnostic
  mutation without source replacement or validation authority
- Runtime identity of all twelve preexisting validation barrel exports, absence
  of the new factory, and a negative type assertion excluding the new handle
- Forwarding spies proving repeated real archive/lifecycle/closure calls and
  exact same-source evidence, plus one frozen capture per capacity assessment
- Full assessment parity against a test-only reconstruction of the former
  double-capture composition, without replacing any validation result
- Root/identity/first-domain diagnostics, synthetic array-reader pressure,
  current wire equality/one-over and preliminary over-cap failure diagnostics
- Descriptor negatives, actual production start/cancellation archive history,
  corrupted archive counts, real near-expiry tick/finalized death and foreign
  lifecycle-source rejection
- Existing v9 validity and legacy wrappers' rejection of reserved v10 fields

The node ceiling remains the unchanged fixed complete-capture guard; the focused
test does not fabricate a node-only admitted World or relax the earlier byte
bound. Existing reader-node pressure and full descriptor suites remain required.

The integration owner should first run strict types and boundaries, the new
suite and existing frozen-capture, world-record, lifecycle and capacity suites.
Then run owned ticks/instance, reserved-discharge, codec, Session and
save-controller regressions together with legacy compatibility and the full
release checks. Existing genuine upgrade/L2/care fixtures cover the domain work
that this focused suite deliberately does not re-earn independently.

For performance, freeze a clean source and compare the same fully re-admitted
earned fixture files using the unprofiled reuse procedure in
[v10-profiling.md](v10-profiling.md). Preserve source hashes, producer commit/tree,
raw samples and complete World/DTO equality. Do not interpret profiled elapsed
time as budget evidence or infer browser, phone, 36-person, 3×, long-history or
full-game acceptance from this change.

## Integration checkpoint — 2026-10-03 03:03 UTC

Strict type checking and module boundaries passed. Four focused capture,
lifecycle and cultivation suites passed 74 tests in 7.85 seconds. Independent
source review found no authority or ordering blocker; its barrel-surface finding
was corrected by explicitly preserving the twelve prior validation exports while
excluding the new factory and handle type. Genuine workload comparison and
broader regressions remain pending for this stage.

## Genuine comparison and broader regression — 2026-10-03 03:27 UTC

Producer `6f15b3f0cad92ce7766496414cc76e3a71eb95b9`, tree `5ac2456d893baeb9ff3113ae2046229498f3f88a`. Reused all nine fully re-admitted earned fixtures; setup was not rerun. Twenty unprofiled measured samples after three warmups per lane.

| Scenario | Owner p50 / p95 ms | Session p50 / p95 ms |
| --- | --- | --- |
| upgrade-precheckpoint | 55.908 / 64.394 | 54.697 / 58.453 |
| upgrade-half-checkpoint | 56.349 / 60.954 | 57.406 / 74.526 |
| upgrade-final-checkpoint | 57.653 / 61.528 | 58.528 / 84.370 |
| l2-production-working | 55.746 / 61.894 | 56.283 / 63.985 |
| l2-production-work-complete | 57.928 / 65.895 | 58.393 / 62.804 |
| l2-production-delivery | 56.561 / 62.953 | 57.772 / 61.104 |
| l2-maintenance-renewal | 61.453 / 68.279 | 63.609 / 76.768 |
| alternative-care-working | 60.179 / 73.501 | 60.598 / 83.546 |
| alternative-care-complete | 61.792 / 68.500 | 64.296 / 67.800 |

All complete Worlds and four Session DTOs matched their oracles. Seven broader runtime/instance/reserved-discharge/codec/Session/save-controller suites passed 194 tests in 789.07 seconds, followed by a successful production build. The 50 ms tick budget remains unmet; no public v10 activation, phone/36-person/3× or full-game acceptance claim.
