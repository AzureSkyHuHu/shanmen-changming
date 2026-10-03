# v10 evidence snapshot staging allocations

Status: authored, awaiting the integration owner's serial validation. The author
has not executed tests, types, builds or benchmarks. There is no seventh-stage
timing or allocation measurement yet.

## Source-bound motivation

The sixth-stage profile report was produced from clean source
`5b8a396ff6d9851ead146a2395397786700e95e1`. It contains **20 owned advances in each
of three rows**, 60 advances in total. Attribution below uses samples whose exact
ancestry includes `advance` in `world/runtime-instance-v10.ts` and the owned-tick
implementation. Inspector startup/postamble and GC samples without that ancestry
are excluded.

| Scenario | Inclusive evidence-reader samples / 20 advances | Per advance | Share of owner samples |
| --- | ---: | ---: | ---: |
| upgrade-precheckpoint | 165.364 ms | 8.2682 ms | 20.73% |
| alternative-care-working | 179.245 ms | 8.9622 ms | 17.80% |
| upgrade-half-checkpoint | 164.503 ms | 8.2251 ms | 20.62% |

The combined evidence-reader subtree is 509.112 ms, 19.57% of 2601.987 ms of
owner-attributed samples. This includes useful reflection, authentication,
serialization and byte calculation; it is **not** a removable-time estimate.
The profile also contains 172.466 ms of GC across all capture windows, with no
owned-tick ancestry. It cannot establish which operation allocated that garbage
or caused an observed latency tail. Sample attribution is not unprofiled latency.

The integration owner reported sixth-stage genuine-source owner p50 values of
40.163–45.099 ms and Session p50 values of 40.748–47.049 ms, with several p95
values over 50 ms and a maximum of 114.5 ms. This patch has no measured result to
compare with those values. Full-game, browser, mobile, 36-person and sustained
20 Hz acceptance remain separate questions.

## Exact scope and representation change

Only these three files belong to this stage:

- `src/core/world/v10-evidence-snapshot.ts`
- `tests/sect-expansion/v10-evidence-snapshot-allocation.test.ts`
- `docs/v10-evidence-snapshot-allocation.md`

The reader still traverses every uncached object. The previous array path created
a `{ key, value }` object and a `{ key, text }` object for each member, then mapped
the second array into a third scratch array before joining. The new path first
captures descriptor values in an ordinary local array, then collects canonical
strings directly in a second local array. It removes two staging-record
constructions per array member and one scratch array per uncached array.

The previous object path used separate captured-child and rendered-field
records. The new path keeps `{ key, value, text }` in one private local record,
populates its text after the recursive visit, then sorts and joins in the same
place. It removes one staging-record construction per object property and one
scratch array per uncached object. These are source-level construction counts,
not heap measurements or a timing prediction; V8's actual allocation and
collection behavior must be measured separately.

The primitive branches, cache operations, cache limits, exported API and final
result construction are unchanged. No caller, domain reducer, archive function,
World capture, validator or capacity calculation is modified.

## Preserved reflection and serialization contract

Both branches retain the complete order:

1. Check the supported primitive/object category and exact ordinary prototype
2. Check this reader's private identity cache, then the active recursion set
3. Add the uncached object to the active set and increment visited-object stats
4. Observe frozen state, obtain own keys, and capture **all** own descriptors at
   the current node before descending into any child
5. Visit captured values in descriptor/index order; calculate identical byte
   totals and descendant immutability
6. Remove the current object from the active set, then check byte safe-integer
   overflow
7. Sort rendered object fields by the unchanged code-unit comparator; join text
8. Retain only a result independently proved eligible by this traversal

No input property is reread after capture. The reader never invokes an input
getter, input `map`, input `toJSON`, or caller-supplied serialization callback.
Local scratch records and arrays never escape. The caller's objects are never
frozen or changed. A child Proxy can mutate a later sibling while being
inspected, but the current node continues to use the already-captured sibling
descriptor value, exactly as before. Proxy reflection can still execute traps;
this is not an atomic snapshot or universal Proxy-detection guarantee.

Exact finite-number and negative-zero encoding, escapes, Unicode, lone
surrogates, canonical field order and UTF-8 bytes remain unchanged. Repeated
aliases still serialize repeatedly; active cycles still fail. Object symbols,
hidden object properties, accessors, exotic prototypes, sparse arrays and extra
array properties retain their existing rejections and messages. Dense
non-enumerable array indices and the ordinary keys `__proto__`, `constructor`
and `prototype` remain accepted by this serializer. Their acceptance does not
grant World admission.

## Cache authority and bounds

The private WeakMap is populated only after the reader proves that all reachable
objects are frozen and data-only. `Object.isFrozen` on a caller root alone is
insufficient. Mutable roots and shallow-frozen parents with mutable descendants
are revisited; eligible frozen children can still be reused. No flags, supplied
proofs, callbacks, stats or returned snapshots can authorize a cache hit.

Retention remains at 4096 cumulative entries and 8 MiB of accounted canonical
text, charged as `canonical.length * 2`. Entries equal to the text limit remain
eligible; entries larger than it are returned without retention. Cumulative
entry/text exhaustion rotates the entire cache before insertion. Child-before-
parent insertion, partial-traversal entries, rotation and all diagnostic counts
remain unchanged. These are retention limits, not heap/RSS promises.

The reader has no separate whole-input depth/node/byte admission limit. This
stage does not introduce one or loosen any World boundary. Full descriptor
capture's separate byte, node, depth, alias and prototype checks remain intact,
as do archive authentication, complete record/semantic validation, residual and
teaching checks, and publish-only-after-success ownership rules. Existing public
mutable-output contracts and v1–v9 paths are untouched.

The previously documented revoked-Proxy limit also remains: a cached frozen
parent can return its prior text without revisiting a now-revoked child Proxy.
A fresh reader or a direct read of the revoked Proxy still throws. Private
World capture's detached ordinary data is unaffected by later caller revocation.
This patch neither broadens nor repairs that established internal-reader limit.

Every read still returns a fresh frozen record containing only canonical text
and byte count. Stats remain detached mutable diagnostics. Neither exposes the
private descendant-immutability proof or lets callers modify cache entries.

## Independent oracles and authored regressions

The new test embeds the complete prior reader function, changing only its
function/export name. Before production edits, the source matched the clean
sixth-stage worktree. Its source SHA-256 is
`2a3803552ea51d774c059263d0f8d9fd387a55c4c7e19308d5e1103ed6701a66`.
The retained old traversal does not delegate to the new reader. Ordinary JSON
also compares independently with `canonicalStringify` and `TextEncoder`, so
agreement between the two readers alone is not the encoding oracle. The old
reader intentionally retains the unchanged string-byte helper; the separate
TextEncoder assertion checks that helper's output independently.

Authored cases cover:

- Deterministic wide/mixed/deep ordinary JSON, every UTF-16 unit, surrogate
  pairs/lone surrogates, finite-number extremes and code-unit key order
- Repeated aliases, shared frozen children, mutable and shallow-frozen inputs,
  non-enumerable dense array indices and special object keys
- Exact Proxy reflection traces for arrays and objects, including sibling
  mutation during child descent and cache hits on later reads
- Exact rejection class/message and stats, descriptor-before-descent and
  descriptor-order-before-sort error selection, hostile getters, custom
  serialization, unsupported shapes and cycles after partial caching
- Identity-only handling of poison thrown values, direct revocation and the
  frozen-parent nested-revocation limit
- Fresh frozen outputs, detached stats and non-authoritative forged fields
- Exact entry-boundary rotation, nested child-before-parent retention, exact
  text limit and one-code-unit neighbors, and oversized Unicode parents whose
  eligible children still remain reusable

Existing tests are unchanged. The integration owner should run these checks
serially from the repository root:

```sh
npm run typecheck
npm run check:boundaries
npm test -- tests/sect-expansion/v10-evidence-snapshot-allocation.test.ts tests/sect-expansion/v10-evidence-snapshot.test.ts tests/sect-expansion/v10-cultivation-preparation.test.ts tests/sect-expansion/v10-lifecycle-records.test.ts tests/sect-expansion/v10-candidate-preparation.test.ts
```

Then use the established complete runtime/save regression lane and production
build, followed by the same nine genuine-source World/four-DTO comparisons on a
clean frozen source. Only an unprofiled before/after comparison can support a
new latency claim; a sampled subtree or fewer source constructions cannot.

## Integration validation — 2026-10-03 06:14 UTC

The frozen visitor and test diff passed five focused files/80 checks in89.00s,
including the old-reader differential oracle. Both type configurations and module
boundaries passed. Seven owned-runtime/instance/discharge/codec/Session/save
suites passed194 checks in747.68s, followed by a successful build. This ran in an
isolated worktree while presentation work proceeded elsewhere. Unrelated copy-UI
mock and lifecycle repairs are tracked separately and are not marked passed here.
No traversal, cache-retention or input-admission rule was changed. The exact nine
real-world scenario comparison and unprofiled timings remain the next gate.

## Exact earned-source comparison — 2026-10-03 06:19 UTC

Clean producer `ef74d8fdb66f6704e45914edf8c58134544c9fdd`, tree `415a7733854b9a13b37797bd75afed123b996e76`. All nine complete World/four-DTO comparisons passed; twenty samples and three warmups per row. No simultaneous local browser work or other validation lane ran during capture. Total 240537.329ms.

| Scenario | Owner p50 / p95 / max ms | Session p50 / p95 / max ms |
|---|---|---|
| upgrade-precheckpoint | 39.795 / 50.422 / 57.664 | 40.029 / 43.043 / 43.968 |
| upgrade-half-checkpoint | 41.384 / 50.241 / 51.600 | 42.957 / 48.612 / 177.937 |
| upgrade-final-checkpoint | 42.024 / 51.396 / 54.710 | 42.344 / 49.175 / 56.035 |
| l2-production-working | 41.047 / 42.860 / 45.191 | 40.995 / 46.291 / 110.011 |
| l2-production-work-complete | 40.743 / 42.245 / 155.475 | 41.483 / 44.011 / 46.965 |
| l2-production-delivery | 41.228 / 43.203 / 54.675 | 40.943 / 44.750 / 46.039 |
| l2-maintenance-renewal | 45.098 / 47.375 / 50.247 | 45.221 / 51.374 / 52.724 |
| alternative-care-working | 44.571 / 50.717 / 52.201 | 44.493 / 52.325 / 53.368 |
| alternative-care-complete | 47.038 / 49.756 / 51.578 | 45.019 / 52.032 / 57.987 |

Results are mixed against the previous run; this single sample does not establish a robust latency gain or regression. The staging-object reduction is structural, not a measured heap or GC improvement. The next useful evidence is uninterrupted actual-frame Session/Canvas throughput with a declared window, not repeated sampling until a favorable maximum. The 50ms fixed step is a capacity warning; DD-13 does not define an approved p95/every-tick threshold. Existing full-game and private functional browser gates remain unresolved.
