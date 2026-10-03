# v10 structural byte-preflight cache reuse

Status: narrowly authored; tests, type checking and genuine comparison have
**not been run by the author**. The integration owner is the sole executor.

## Fresh profile evidence

The post-snapshot profiles came from clean commit
`0e0920a0c127ea02f5ff49ada3c472e2e95c4e9b`, tree
`cda84f92b0303467723b38a3571c53b20ccbc7b8`. All three scenario sources matched the
original earned-fixture hashes and all complete Worlds remained exact.

Filtering raw CPU stacks to `runtime-instance-v10.advance` ancestry, the exact
fresh-counter preflights in `deriveV10RecordReservations` and
`deriveSectReservationsV10` retained these sampled costs:

| Scenario, 20 advances each | Preflight samples | Share of owner samples |
| --- | --- | --- |
| upgrade-precheckpoint | 143.055 ms | 10.4% |
| alternative-care-working | 161.111 ms | 10.5% |
| upgrade-half-checkpoint | 136.659 ms | 8.4% |

This is approximately 6.83–8.06 ms per sampled advance, **not a predicted latency
saving**. First measurement still costs work, and sharing can move where that
work is attributed. Inspector-post samples of 3.28–3.68 seconds per scenario and
unattributed GC are excluded. Profiled elapsed time is not a 50 ms budget result.
Full capacity assessment remains roughly 59–61% of these owner samples.

## Exact production scope

Only two imports and two existing preflight calls change:

- `world/v10-record-headroom.ts`: `deriveV10RecordReservations`
- `save-budget/sect-obligations-v10.ts`: `deriveSectReservationsV10`

Each existing `createCanonicalByteCounter().measure(world)` becomes
`canonicalUtf8ByteLength(world)`, which uses the same counter implementation's
private shared instance. Every preflight remains in its original position.
Protocol/identity checks, every structural derivation and validator, error order,
full assessment, archive restoration, fresh descriptor capture and strict
admission remain in place. No v1–v9 wrapper or counter algorithm is changed.
No result, death fact, sizing assessment, supplied budget or admission is cached.

## Authentication and ordinary-data equivalence

The existing counter first inspects the data descriptors and descendants itself.
It caches only recursively frozen, ordinary finite data. A mutable root or a
shallow-frozen parent with a mutable child is rechecked on every measurement.
Frozen-subtree reuse can therefore share work with progression's existing global
preflight without trusting a caller marker or changing the complete checks.

All ordinary-object rejection behavior remains: getters, non-finite data, cycles,
sparse arrays, symbols and unsupported shapes cannot acquire a valid cached root.
Frozen but structurally invalid gameplay data still undergoes the identity and
record checks after byte measurement. The numeric result alone grants nothing.

## Retention and Proxy limitations

The shared counter owns a `WeakMap<object, number>`. Weak keys and scalar values
do not keep input Worlds alive. It has no insertion budget or disabled state, so
there is no permanent saturation to rotate out of. Its cumulative diagnostic
statistics never affect measurement. There is no hard bound on live cache entry
count: callers retaining many frozen input objects also retain their associated
small numeric entries. This is distinct from the new evidence reader's bounded
retained strings. Collection timing and process heap are not promised or tested.

Proxy exception behavior is explicitly outside ordinary-data equivalence. If a
nested Proxy is revoked after a frozen parent was authenticated, a shared-cache
hit can return its previous byte count without revisiting that child; a fresh
counter would throw. These internal structural queries can then produce the same
sizing diagnostics if their later typed reads do not touch the revoked child.
They remain no source, import or runtime admission authority.

Production owned execution and complete inspection roots still capture fresh
ordinary private data instead of retaining external Proxies. A revoked caller
still fails fresh capture and complete assessment/record inspection. A copy
captured before revocation remains independent. The focused test explicitly
characterizes both behaviors rather than claiming Proxy traps are preserved.

## Regression handoff

The new focused suite uses a real v10 genesis and clearly labeled negative input
mutations. It checks complete mutable/shallow/deep-frozen derivation equality,
fresh outputs, getter/non-finite rejection after warm reads, descriptor-before-
identity ordering, frozen wrong identities, detached capture isolation, explicit
nested Proxy behavior, and continued byte-counter reuse after 9,000 new frozen
unit inputs. None is fabricated earned gameplay or a benchmark fixture.

The integration owner should run this suite with the existing canonical byte,
v10 sect-obligation, complete record/capacity and runtime/save regressions, plus
strict types and boundaries. Freeze a clean source before the same genuine-fixture
unprofiled comparison in [v10-profiling.md](v10-profiling.md). Require exact source
hashes, complete Worlds and DTOs, and retain actual samples and source provenance.
No speedup, 20 Hz, browser, mobile, 36-person or full-game acceptance is claimed
until the corresponding measured gate succeeds.

Integration checkpoint, 2026-10-03 02:40 UTC: strict types and module boundaries
passed. The new preflight suite plus canonical-byte suite passed 35 tests in
2.33 seconds. Genuine reused-workload timing and broader regression remain
pending for this exact patch.
