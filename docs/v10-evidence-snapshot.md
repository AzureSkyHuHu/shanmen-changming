# v10 bounded immutable evidence snapshots

Status: authored and reviewed at source level; this patch has **not been run by
the author**. The integration owner runs types, tests and genuine workload
comparisons. No new performance result is claimed here.

## Why this narrow second patch

The real three-scenario CPU profiles attributed approximately 273–302 ms per 20
owned advances to pre-work snapshots, and 163–190 ms to historical lifecycle
evidence reads. These inclusive sampled figures overlap; inspector startup/post
samples are excluded. They are diagnostic attribution, not budget measurements.

The earlier private-frozen-capture patch was retained after paired unprofiled
upgrade-precheckpoint runs with identical real earned fixture evidence and exact
complete Worlds. The integration owner reported:

| Source | Run 1 p50 / p95 | Run 2 p50 / p95 |
| --- | --- | --- |
| Before, `57df2f9` | 81.337 / 92.487 ms | 81.782 / 105.858 ms |
| Frozen captures, `4aef3f4` | 76.675 / 85.907 ms | 76.292 / 79.011 ms |

This is a modest improvement and remains far above 50 ms per tick. It does not
establish browser, phone, 36-person, 3× speed or full-game acceptance.

## Exact production scope

- `v10-evidence-snapshot.ts`: one internally authenticated canonical snapshot
  reader, shared only by the v10 evidence modules
- `v10-cultivation-preparation.ts`: its existing local `snapshot` function uses
  that reader; all call sites, identity checks and string comparisons remain
- `v10-lifecycle-records.ts`: token-mint canonical text and historical-evidence
  comparisons use that reader. The initial `canonicalUtf8ByteLength` preflight,
  validators, check order, exact World binding and actual death derivation remain

The validation root creates a mutable World wrapper over private frozen fields
and restored archive data. Therefore the reader may reuse frozen **subtrees**;
it cannot treat the mutable wrapper as immutable or cache a validation result.

## Serialization and cache authentication

The reader checks ordinary prototypes and captures own data descriptors, without
calling getters, input array methods or `toJSON`. It then produces canonical text
and exact UTF-8 bytes in the same recursive traversal. Object field output uses
code-unit key ordering, matching `canonicalStringify`; primitive encoding uses
`JSON.stringify` and the unchanged JSON-string byte helper. Repeated references
serialize repeatedly, as the previous evidence reader did. An active recursion
set rejects cycles. Dense non-enumerable array indices retain the existing byte
counter/canonical serializer behavior; hidden object fields and custom array
properties remain rejected.

A WeakMap entry is created only after this reader itself has checked every
reachable descriptor and established that every object is frozen. A merely
shallow-frozen parent with a mutable child is not cached. Mutable wrappers are
always re-read, including their identity and descriptor values. Cache entries
are private; results are fresh frozen records containing only text and bytes, so
mutating a returned value cannot poison later reads. Stats are detached and have
no authority. There are no supplied trust markers, limits or callbacks.

Descriptor reflection can execute Proxy traps, as with existing capture and
counter helpers. This is not a promise of atomic inspection or universal hostile
Proxy detection. Caller objects are never frozen or mutated.

There is a specific exception-behavior difference outside ordinary-data parity:
if a nested Proxy is revoked after its fully frozen parent has been inspected,
a cache hit on that parent returns the previously authenticated text and bytes
without revisiting the child. The former live `canonicalStringify` traversal and
a fresh snapshot reader throw on that revoked child. The existing byte-counter
cache already skips such nested reflection, but caching canonical text extends
that behavior to evidence comparisons. Directly reading the revoked Proxy still
throws. This optimization does not preserve arbitrary Proxy trap/exception effects
for callers of internal evidence ports and does not claim to detect revocation.

The production owned-tick path and complete v10 inspection roots first perform
fresh descriptor capture into private ordinary objects; they do not retain caller
Proxies in their copied data. Revoking an external Proxy after that capture cannot
revoke the private copy. The focused characterization test contrasts cached,
fresh-reader and live-serializer behavior and verifies that a detached captured
copy remains readable after revocation. Public admission and capture checks are
not replaced by this cache.

## Fixed retention limits and recovery

Each reader retains at most 4,096 entries and 8 MiB of accounted canonical text
payload, charging two bytes per UTF-16 code unit. This bounds helper retention,
not VM object overhead, ropes, GC scheduling, total process heap, evidence strings
already retained by live tokens, or input/output size.

On entry or text-budget exhaustion the private WeakMap is replaced and accounting
restarts before admitting the new entry. Thus accumulated dead keys cannot
permanently turn caching off. An individual string larger than the cache budget
is simply not retained. These limits never truncate data or alter acceptance,
canonical text, UTF-8 size, evidence checks or admission. General serialization,
full capture contracts, archive restoration, validators, death-fact derivation,
RNG/reducer order and v1–v9 remain unchanged.

## Regression handoff

New unit cases cover exact text/bytes, all UTF-16 units, numerical extremes,
aliases, descriptor shapes, frozen first-read proof, shallow-freeze mutation,
frozen subtree reuse under mutable wrappers, getter introduction, result/cache
poisoning attempts, cycles, and continued cache usefulness after repeated entry
and text exhaustion. An oversized serialization is a cache-only unit fixture,
not gameplay evidence or save admission.

The existing lifecycle and cultivation-evidence suites add shallow-frozen nested
mutation and post-read getter cases. Their real expiry/death and archive-boundary
tests, all forged/foreign-token tests, and source/candidate/frame/context/actual
transition mutation comparisons remain in place.

The integration owner should run the focused snapshot/evidence suites, strict
types and boundaries, then record/capture/capacity/runtime/save regressions.
After freezing a clean source, compare the same earned fixtures with the
unprofiled command in [v10-profiling.md](v10-profiling.md), keeping raw samples,
commit/tree, exact source hashes and full World/DTO equality. Profiled elapsed
time must not be presented as a latency budget result.

## Integration checkpoint — 2026-10-03 02:08 UTC

The integration owner ran strict type checking and module boundaries, then four
focused snapshot/cultivation/lifecycle/canonical-byte suites: 70 tests passed in
5.95 seconds. After adding the explicit revoked-Proxy characterization, the final
snapshot suite passed all 24 cases in 1.88 seconds. Independent source review
found no ordinary-data mutation or identity blocker. Genuine workload timing and
broader integration regression remain pending for this patch.

The preceding frozen-capture patch additionally passed seven runtime, instance,
reserved-discharge, codec, Session and save-controller suites: 194 tests in
794.43 seconds, followed by the production build. These results are not complete
game acceptance and do not establish the 50 ms tick budget.

## Genuine reused-source measurement — 2026-10-03 02:14 UTC

Clean producer `669f4c430ad2d8c283a607938d649952ade86711`, tree `dc0e7f8262c6626c516d6eb242885692a6b0b106`. All nine earned source saves were fully re-admitted; original fixture hashes were retained. Setup was not repeated. Each lane used three warmups and twenty samples without a CPU profiler.

| Scenario | Owner p50 / p95 ms | Session p50 / p95 ms |
| --- | --- | --- |
| upgrade-precheckpoint | 68.159 / 81.212 | 69.002 / 92.647 |
| upgrade-half-checkpoint | 69.379 / 97.954 | 67.823 / 89.332 |
| upgrade-final-checkpoint | 68.697 / 98.709 | 72.515 / 145.334 |
| l2-production-working | 67.464 / 81.756 | 68.180 / 72.086 |
| l2-production-work-complete | 69.844 / 86.742 | 73.039 / 84.945 |
| l2-production-delivery | 72.549 / 90.420 | 70.046 / 78.697 |
| l2-maintenance-renewal | 75.181 / 93.273 | 73.475 / 113.747 |
| alternative-care-working | 71.168 / 78.665 | 70.342 / 77.692 |
| alternative-care-complete | 74.614 / 84.557 | 78.295 / 85.574 |

Every owner result matched the complete oracle World; every Session result matched the World and four fresh DTOs. All measured owner paths remained owned one-tick advancement, with no strict fallback. This still fails the 50 ms tick budget; tail spikes remain. It does not authorize public v10 activation. Broader runtime/save regression is running separately.

02:28 UTC: The frozen second-patch source also passed eight runtime, instance,
reserved-discharge, codec, Session, save-controller and frozen-capture suites:
212 tests in 831.03 seconds, followed by a successful production build.
