# v10 immutable private validation copies

Status: narrow first optimization authored, **not executed or accepted by the
authoring worker**. Root owns tests, type checking, benchmarks and Git.

## Measured reason for this change

The genuine three-scenario CPU profiles were taken from saved sources whose
canonical hashes match the completed 0030 baseline. Restricting attribution to
the actual `runtime-instance-v10.advance` ancestry gives these sampled totals
over 20 operations, in upgrade-working / care-working / half-payment order:

- Complete capacity assessment: 925 / 1,064 / 954 ms
- Actual preparation: 407 / 449 / 429 ms
- Residual cross-boundary record checks: 251 / 342 / 271 ms
- Canonical byte walking inside assessment: 354 / 400 / 356 ms

The unrelated inspector-post samples (3,010 / 3,128 / 3,683 ms) are excluded;
unattributed GC is separate. These are sampled diagnostic costs, not latency
budget results. The subsequent unprofiled reused upgrade-working baseline at
clean `57df2f9` was p50 81.641 ms, p95 87.846 ms, max 94.969 ms, with all 20
complete Worlds exact. This patch has no measured improvement claim yet.

## Smallest selected change

`captureFrozenV10RecordData` first calls the existing bounded descriptor capture,
then recursively freezes only the fresh ordinary-data copy. It is used only by:

- `assessManagementCapacityV10`
- `inspectUnregisteredWorldV10Records`

The existing byte and record counters already inspect all descriptors and
descendants before reusing exact immutable sizes. Their algorithms and authority
remain unchanged. Freezing the two private scratch copies lets those existing
caches reuse unchanged data during repeated nested checks. First traversals and
fresh counters remain real work; the change cannot eliminate the whole profiled
cost pool, and may add freeze cost. Unprofiled measurement decides its value.

## Preserved safety and behavior

- Every call still makes a fresh full bounded descriptor copy, even for an
  externally frozen input. No caller object or child is frozen
- General `captureV10RecordData` retains its unchanged mutable-copy contract
- Full record validation, exact identities, lifecycle checks, all dimensions and
  reservations, residual checks and public candidate replay are retained
- Preliminary over-cap measurement and all first-issue checks retain their order
- Archive restoration remains at the original call sites. Freezing an ordinary
  archive does not mark it as sealed or provide the archive module's private index
- No caller boolean, assessment, budget, callback, trust token or supplied cache
  authorizes reuse. The helper itself provides no World or capacity admission
- v1–v9 branches, general canonical serialization, save schema, RNG, event order,
  domain reducers and measurement boundaries are unchanged

Read-only inspection of the affected validator composition found writes to local
sets/maps/arrays, freshly projected data, copied progression assessments and build
replay outputs; no required mutation of the captured World was identified. This
inspection is not a substitute for the existing mutation/negative tests.

## Regression and evidence handoff

The focused suite covers detached full-data equality, deep freeze, unchanged
mutable capture, fresh repeated snapshots, shallow-frozen caller mutation,
independent existing-counter authentication/reuse, descriptor rejections, complete
valid/invalid records, exact full assessment equality, first-error order, actual
production cancellation archives, corrupted packed history, real birthday-expiry
and death-finalization reducers, and exact-object lifecycle evidence. The lifespan
case explicitly uses a legal near-expiry initial birthday, not a lifetime claim.

Run the new suite together with existing record/capacity/lifecycle negatives and
unchanged counter suites; then compare the same genuine saved sources using the
unprofiled reuse command in [v10-profiling.md](v10-profiling.md). Keep the whole
report, actual frozen commit/tree, raw samples and complete-World/DTO equality.
Do not claim 20 Hz, browser, phone, 36-person, 3× or full-game acceptance from this
patch or a headless result alone.

## 2026-10-03 local verification

The integration owner passed strict types, core boundaries, and seven focused
capture/counter/record/lifecycle/capacity suites: 178 tests in 180.54 seconds.
Two new-test fixture mistakes were corrected without changing production checks:
a changed seed correctly invalidates its authenticated map, and readonly typed
stock entries are replaced via fresh spread-created mutable fixture entries.
Performance comparison and broader runtime/save regressions remain separate gates.
