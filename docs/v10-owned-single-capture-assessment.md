# v10 owned single-capture assessment

Status: implementation and focused tests authored; integration validation has not
been run by the implementation worker. No timing improvement is claimed.

## Scope and motivation

The fifth-stage CPU profile, producer
`c6737f79ed7deddc2213e810bed5b10cc76d9dd4`, identified the owned candidate's
capture/restore/freeze followed by another complete capture inside assessment.
Across 60 profiled advances, the assessment capture/freeze accounted for
177.458 ms; archive restoration at the owned entry, record inspection and
automatic-budget expansion accounted for 45.774, 44.480 and 52.673 ms respectively.
The non-overlapping capture/archive union was 553.096 ms, including required work.
These are sampled inclusive attributions under actual owned-advance ancestry,
excluding inspector overhead and unattributed GC. They are not expected savings,
latency measurements or proof of meeting the 50 ms budget.

Production changes are limited to:

- `src/core/kernel/validation.ts`
- `src/core/world/management-capacity-v10.ts`
- `src/core/world/runtime-owned-ticks-v10.ts`

There are no cross-tick caches, changed reducer/domain clone contracts, descriptor
budget changes, new candidate-admission routes, v1–v9 changes or player activation.

## Fixed composition

`captureRestoredV10RecordInspection(input)` is a direct-import internal factory.
It always calls the existing complete bounded `captureFrozenV10RecordData`, even
for frozen inputs or previous outputs. It then calls `restoreWorldHistory` on
that detached tree and freezes the returned root wrapper. The ordinary captured
children were already deeply frozen; the archive module owns and deeply freezes
its newly authenticated archive. No caller object or mutable content registry is
frozen. The returned frozen `{ data, inspect }` handle closes over exactly that
restored root. `inspect()` is argument-free, reruns the existing complete record
validator every time and returns fresh diagnostics.

`captureAndAssessOwnedV10(input)` creates that factory itself. It measures the
private data, runs the complete assessment through a private shared body, and
returns a frozen `{ world, assessment }` pair. It accepts only arbitrary source
data, never an inspection handle, assessment, supplied counter, callback, policy
or proof. Every call captures afresh. Nothing caches a validation result.

The complete capacity calculation, dimensions, record checks and error mapping
are shared privately with the unchanged standalone assessment contract. The owned
path still performs preliminary and captured-source envelope measurements, but
both operate on the one immutable source. The counter independently authenticates
the data before using its existing same-identity size reuse.

Computed diagnostics are recursively copied before freezing. This intentionally
does not use JSON serialization: unsupported capacity calculations may contain an
intentional `Infinity` sum. Copying also prevents a borrowed diagnostic/rule array
from being frozen in its original module. The resulting diagnostic objects remain
plain data and are not admission certificates.

The owned tick leaf obtains the pair only by calling this fixed composition. It
records those exact roots in its closure-local ownership set, avoiding a second
recursive freeze. It still checks ordinary supported/current/future fit, teaching,
both exact clock increments, and every residual cross-boundary record comparison.
Only then does it publish the new frozen boundary. A failed advance keeps its
original source and assessment; a failed capture clears the retained cursor as
before. Normal/fallback ordering and reentrancy protection are unchanged.

## Actual archive authority

The retained World's archive is the exact object returned by the archive module's
full restoration, not a raw archive that merely passed `Object.isFrozen`. The
record inspector and all capacity derivations see that same archive identity.
Their existing restoration calls remain in place and recognize the archive
through the archive module's private sealed-object/index maps. All subsequent
semantic rows, references, clocks and owner comparisons still execute.

The validator retains its existing shallow lifecycle wrapper. Lifecycle tokens
remain bound to that exact wrapper and its canonical data; the wrapper shares the
assessment's authenticated archive and captured branches. No lifecycle token is
transferred to a different root or accepted as whole-World admission.

Because initial capture creates a new ordinary alias-free tree, archive
restoration cannot introduce caller descendants or cross-branch aliases. Its
logical data remains the captured archive; the original whole-data byte/node/depth
bounds and the archive's independent codec/expanded limits all remain enforced.

## Standalone contracts and diagnostics

`captureV10RecordData`, `captureFrozenV10RecordData`,
`captureV10RecordInspection`, `inspectUnregisteredWorldV10Records` and
`assessManagementCapacityV10` retain their external behavior. General capture still
returns mutable detached data. Standalone assessment still measures its caller
before its fresh capture, then measures the captured source, checks identity,
inspects records and calculates all reserves in the original order. It returns
fresh mutable diagnostics.

In particular, an over-cap caller retains its preliminary wire measurement when
capture refuses. A malformed clock still precedes malformed-archive diagnostics
in standalone inspection. The new owned composition restores before assessment,
matching the former owned leaf's ordering; capture/archive exceptions propagate
to the leaf's unchanged refusal handler without inspecting hostile thrown values.

The kernel barrel already uses an explicit original export list; neither new
internal entry nor the result type is added. The existing standalone inspectors
remain exported exactly as before. No reverse capacity-to-validation dependency
is introduced: the existing direction remains owned leaf → capacity → validation
→ capture/history.

## Non-authoritative results

The returned data and diagnostics are deeply frozen. Their JSON-like fields can
still be copied or imitated; that grants no authority. No owner method accepts a
supplied result pair or candidate. External capture always detaches and completely
checks even this factory's previous output. The owner establishes provenance from
its own direct call, then retains all its existing checks before publication.
Borrowed methods and extra arguments cannot replace a closed-over source or a
fixed validator.

## Focused regression plan

`tests/sect-expansion/v10-owned-single-capture-assessment.test.ts` covers:

- Exact World and complete assessment differentials against the former owned
  capture/restore/freeze/standalone-assessment composition
- One complete descriptor capture, same measured World and same archive identity
  across record and capacity consumers, and real private archive authentication
- Fresh captures of prior/frozen outputs, caller mutation isolation, repeated
  complete inspection, fresh issue arrays and absent public/internal helper APIs
- Mutable rule-registry preservation and copied borrowed diagnostics; intentional
  nonfinite diagnostic sums remain unchanged
- Standalone mutable results, multiply-invalid issue order, over-cap diagnostics,
  exact byte/depth boundaries, excessive declared nodes, alias/cycle/prototype/
  descriptor rejection, hostile exceptions and revoked caller Proxies
- Actual production work and cancellation archives, subsequent owned boundaries,
  birthday expiry/pause records, candidate-validator and residual failures before
  publication, and an independent fallback from the original source

The capture node guard remains unchanged; an isolated exact node-limit fixture is
not claimed. Finite ordinary JSON reaches its byte bound before that many value
nodes. Existing node/array/descriptor-pressure suites remain required.

The two existing test updates only track the new complete-query seam and preserve
the validation module/barrel export contract. Existing owned-tick/integration
tests retain genuine research, upgrade checkpoints/completion, L2 maintenance,
care, archive append, death, teaching and fallback coverage.

The integration owner should run both type configurations, boundaries, this new
suite, single/frozen capture, preflight-cache, owned ticks/integration, world
records/capacity, reserved discharges and the broad runtime/save regressions.
Only after a frozen clean source passes should the same nine earned scenarios be
compared for exact Worlds/DTOs and unprofiled owner/Session latency. Profile pools
do not replace that comparison or establish browser/mobile/36-person performance.

## Integration validation — 2026-10-03 05:12 UTC

Both strict type configurations and module boundaries passed. The five-suite
focused lane passed 114 tests in 9.19 seconds after correcting a test fixture
that overflowed a reserved operand instead of the intended current-plus-reserved
cost; no production change was required. Five owned-runtime/capacity/discharge/
candidate suites passed 120 tests in 642.05 seconds. The established seven-suite
runtime/instance/discharge/codec/Session/save lane passed 194 tests in 746.39
seconds. All 1205 locale keys, content validation and production build passed.
Independent read-only source review found no production blocker and verified the
shared calculation against the previous implementation. The existing incomplete
12/48 talent catalog and large bundle warnings remain; this does not constitute
full-game acceptance. Exact nine-scenario timing/equivalence is the next gate.

## Exact earned-source benchmark — 2026-10-03 05:17 UTC

Clean producer `5b8a396ff6d9851ead146a2395397786700e95e1`, tree `c26d4ee45e59fbb133e506e86848e447116b17c2`. Fully readmitted the same nine real sources; twenty samples and three warmups per row. All complete Worlds and four Session DTOs matched the exact oracle after every measured operation. No live browser interaction or separate local test/build ran during this benchmark. Total 240970.478 ms.

| Scenario | Owner p50 / p95 / max ms | Session p50 / p95 / max ms |
|---|---|---|
| upgrade-precheckpoint | 40.583 / 46.200 / 114.521 | 41.176 / 54.182 / 108.745 |
| upgrade-half-checkpoint | 41.387 / 44.373 / 44.425 | 43.205 / 48.692 / 53.986 |
| upgrade-final-checkpoint | 42.404 / 55.659 / 59.282 | 42.991 / 45.992 / 46.052 |
| l2-production-working | 40.163 / 47.474 / 105.123 | 42.187 / 49.277 / 51.188 |
| l2-production-work-complete | 41.255 / 47.006 / 49.191 | 40.748 / 42.114 / 42.334 |
| l2-production-delivery | 41.448 / 44.485 / 44.711 | 42.085 / 44.613 / 45.117 |
| l2-maintenance-renewal | 45.099 / 47.548 / 55.954 | 45.750 / 52.943 / 56.944 |
| alternative-care-working | 43.630 / 50.841 / 55.519 | 44.188 / 49.370 / 71.121 |
| alternative-care-complete | 44.705 / 45.913 / 47.318 | 47.049 / 73.934 / 76.074 |

All medians are now below 50 ms, but several p95 values and maxima still exceed the single-tick budget. This is a meaningful reduction, not a complete performance pass. Public v10 activation, browser/36-person/3× performance, full-game acceptance and long-run memory remain unverified.
