# v10 fixed upgrade-prefix composition

Status: authored and reviewed at source level; **the author has not executed
tests, type checks, builds or benchmarks**. The integration owner owns the
serial verification lane. Keep this change local until those checks and the
next authorized release window. No performance or public-v10 acceptance claim
is made here.

## Fresh evidence and narrow target

The preceding single-capture source was profiled at commit
`6f15b3f0cad92ce7766496414cc76e3a71eb95b9`, tree
`5ac2456d893baeb9ff3113ae2046229498f3f88a`. Attribution used raw sample
`timeDeltas` under the actual runtime owner → capacity → World-upgrade ancestry;
inspector overhead and unrelated garbage collection were excluded.

Across 20 advances in upgrade-precheckpoint / alternative-care-working /
upgrade-half-checkpoint respectively, the identifiable duplicate subtrees were:

- Construction: 28.535 / 30.446 / 27.121 sampled ms
- The second complete-frame descriptor gate: 15.591 / 10.817 / 10.878 ms
- Research prerequisites: 1.084 / 4.362 / 5.421 ms
- Repeated L1 maintenance inside upgrade: no attributed sample / 1.085 ms /
  no attributed sample; absence of a sample does not mean zero work
- Non-overlapping union: 45.210 / 46.710 / 43.420 ms, or 3.79–4.26% of owner
  samples

These are diagnostic attribution, **not expected timing gains**. The full
upgrade wrapper consumed approximately 95–101 sampled ms per scenario, most of
which remains. The final maintenance L1 recheck contributed only approximately
1.1–2.2 ms and is deliberately unchanged. Inclusive costs must not be added.

The prior all-nine-source unprofiled comparison remained exact, with owner p50
55.746–61.792 ms and Session p50 54.697–64.296 ms as reported by the integration
owner. That still exceeded 50 ms and is not a measurement of this new patch.

## Production scope and fixed composition

Only two production files change:

- `sect-expansion/upgrade-validation.ts`: add
  `inspectWorldSectUpgradePrefixV10(world, lifecycleEvidence)` and extract the
  existing upgrade-specific body into a private function
- `world/v10-sect-records.ts`: call this fixed prefix and continue the existing
  later validators and complete owner closure

The new entry derives historical identities and the genuine projected frame
itself. It accepts no frame, prerequisite result, caller death list, callback,
policy, budget or skip flag. It uses only the existing internally authenticated,
exact-World-bound lifecycle evidence, with all reauthentication points retained.
Its frame, identities and issue-array result supplies data for this synchronous
composition; no API accepts the result as admission or proof authority.

Order remains:

1. Historical identity capture and actual World projection
2. Construction records, including the complete paired ledger and its separate
   descriptor contract
3. L1 maintenance structure/payment history
4. Maintained research DAG, payment, work and receipt history
5. Existing exact lifecycle-source reauthentication
6. Complete six-domain descriptor contract and equality with a fresh genuine
   World projection
7. Existing second historical-identity/lifecycle reauthentication
8. Exact frame fields/schema and synchronized-clock/immutable-L1-origin check
9. Unchanged upgrade-specific body, including historical basic-medicine gate,
   IDs, claims, work/payment checkpoints, completions, refunds, lifetime/death
   cancellation, revision chronology and local worker limits

The private body receives the authority reference and tick already read by its
caller, preserving the standalone prelude's established reads. It is not
exported. The standalone `validateSectUpgradeRecordsV10` and
`validateWorldSectUpgradeRecordsV10` keep their full original prerequisite
sequences and error behavior, including their repeated descriptor checks.

Within the captured root, the omitted construction/research/L1 calls used the
same frame data and equivalent historical facts as the checks just completed.
No reducer, asynchronous step or supplied callback occurs between them. This
is a fixed synchronous composition, not validation-result caching.

## Distinct checks remain distinct

Whole-World descriptor capture is unchanged. It does not replace construction's
depth-16 and independent node/collection restrictions, nor upgrade's depth-28,
independent node budget, nonnegative integers, 64-field object ceiling,
128-character keys, 256-character strings and alias/descriptor checks.

The old standalone and new fixed-root paths retain actual frame-to-World
projection equality. Historical worker identities still cannot authorize death
cancellation without the exact World-bound unavailable-tick facts. The complete
reservation book remains visible throughout.

After the prefix, the root still invokes final maintenance, production records,
production receipts, research consumer gates, care records, historical pause
checks, care ownership, legacy economy closure, base/sect balance provenance,
global IDs, workers and command ownership. Final maintenance still rechecks L1
before checking L2 historical rates and exact settlement amounts. Runtime
pre/post-candidate checks inspect different states and are unchanged.

No v1–v9 implementation, schema, identity, RNG/reducer order, capacity equation,
save admission or public export is changed. The new composition is a direct
module export, with no new barrel export or unchecked-core export.

## Isolation and diagnostic compatibility

The complete World record root still supplies freshly captured immutable
ordinary data and an authenticated restored archive. The source World wrapper
and projected containers belong to this invocation. The new prefix neither
freezes callers nor retains a mutable-input validation cache. As before, direct
low-level calls involving hostile Proxies are not an atomic-snapshot or
universal Proxy-detection guarantee; they do not become whole-World admission.

Early identity/projection/construction/L1/research exceptions remain outside the
upgrade wrapper's catch boundary. Construction issues retain the root's original
unprefixed paths. Standalone upgrade construction issues retain their
`construction.` path prefix. The complete-frame/projection failure still reports
`INVALID_UPGRADE_WORLD_PROJECTION`; late lifecycle exceptions report
`UPGRADE_DEATH_AUTHORITY_REQUIRED`; upgrade-body exceptions report
`INVALID_UPGRADE_RECORDS`. The new function does not move the upgrade descriptor
gate ahead of the root's original prerequisite diagnostics.

## Test intent and verification handoff

`v10-upgrade-prefix-composition.test.ts` retains a test-only implementation of
the former outer prefix, calling every real old standalone validator. It
compares exact issue arrays and projected data, and can substitute only that
complete former composition into the full root for exact root-error comparisons.
No successful validation result is fabricated.

Focused cases cover:

- Multiply-invalid construction/L1/research/upgrade inputs and exact first-error
  order; standalone versus root construction paths
- Forwarding construction/L1/research/lifecycle/projection spies, plus real
  descriptor-read counts distinguishing the removed second tree walk from the
  retained exact-field guard
- Foreign/forged evidence, changed World identity/data and mismatched projections
- Narrow construction depth versus whole-upgrade shape/depth/string/field/alias
  restrictions; original fixed node budgets remain unchanged
- Late lifecycle and upgrade-body exception classifications
- Unchanged final L1/L2 maintenance and full stock/legacy reservation closure
- Real paid prior construction/research and real upgrade start, half payment,
  completion, requested cancellation/refund, L2 maintenance and exact death
  cancellation; corrupted checkpoints and prerequisite precedence

The paid-work fixture uses the existing explicitly base-funded v9 test helper.
Its sect materials, buildings, research, work and payments are earned by actual
reducers. It is a component/record fixture, not migration, unrestricted save or
performance evidence. The death case preserves the established explicitly
near-expiry within-month component setup and does not claim a simulated lifetime.

Run strict types and boundaries, this suite, then existing upgrade-runtime,
upgrade-death-v10, upgrade-retired-history, maintenance-v10-leaves,
production-v10, care-v10 and full v10 record/capacity suites. Preserve the
frozen-capture/single-capture, owned runtime, discharge, codec, Session and
save-controller regressions and full release checks. The integration owner
must report actual outcomes separately from this authored test plan.

After freezing a clean source, use the same fully re-admitted earned fixtures
and [unprofiled comparison procedure](v10-profiling.md), retaining producer
commit/tree, source hashes, raw samples and complete World/DTO equality. Browser,
phone, 36-person, 3×, long-history and complete-game acceptance remain separate.

## Integration checkpoint — 2026-10-03 03:53 UTC

Strict types and module boundaries passed. Six focused prefix/upgrade/runtime/
death/retired-history/maintenance/World-record suites passed 150 tests in
80.13 seconds. Independent source review found no equivalence blocker and
confirmed unchanged standalone preludes, private upgrade body, and owner-closure
suffix against the preceding source. Genuine workload timing and broader
runtime/save regressions remain pending.

04:15 UTC: the seven broader runtime/instance/reserved-discharge/codec/Session/
save-controller suites passed194 tests in745.39 seconds; production build passed.
The clean nine-fixture unprofiled run from c6737f79ed7deddc2213e810bed5b10cc76d9dd4
kept all complete Worlds and four Session DTOs exact. Owner p50 spans51.944–58.953ms,
Session p50 spans51.095–61.004ms. The 50ms budget remains unmet; one delivery p95
sample reached252.134ms and is not assigned a code-only cause from this run.
