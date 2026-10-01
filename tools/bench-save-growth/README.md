# Save-growth review benchmark

Integration-owner-only run, from the repository root:

```sh
git rev-parse HEAD
npm exec -- vitest run --config tools/bench-save-growth/vitest.config.ts --reporter=verbose
```

No dependencies, application changes, disk saves or archived fixture edits. This
separate config does not add a benchmark to the ordinary test suite. It is bounded
to 100 real jobs, six synthetic history sizes (up to 10,000), three measurement
samples, 64 isolated tick calls per sample and 40 full ticks per sample. The test
has a 180-second timeout; if an external timeout interrupts it, keep partial rows
and report the last completed size rather than calling the absent rows passed.

Output contains machine-readable `SAVE_GROWTH_ENV`, `SAVE_GROWTH_ROW` and
`SAVE_GROWTH_ACTUAL` lines. Capture stdout outside the repository, if desired.
No measured numbers were available when this harness was authored.

## What the two data sets mean

- **Actual simulation:** 0, 1, 10 and 100 genuine gather-wood deliveries from the
  starter world, normal command dispatch, walking, work, delivery, resources and
  calendar progression. No capacity boost, time skipping or world edits. This
  small run does not establish a full long-campaign balance or lifespan result.
- **Synthetic history:** copy a genuinely settled transaction with fresh IDs and
  matching receipts/events/reservations, validated by the real world validator.
  Elapsed time and inventory are deliberately fixed. This is a shape/performance
  stress fixture, not evidence that 10,000 jobs were played or economically fit.

The one-live-job microbenchmark repeatedly calls `tickProduction` from the same
Working boundary to isolate the per-tick historical-map copy. The full-tick
benchmark advances 40 ticks from that boundary without settlement. These do not
measure 36 workers, renderer cost, IndexedDB quota/latency, browser long tasks,
mobile performance, huge breakthrough/build histories, or battle serialization.

`createEnvelope` includes world validation, canonical clone and checksum;
`serialize` is additional canonical encoding. `parseFile` includes byte-limit,
checksum and validation when the file is below the limit. Above-limit parsing is
an expected fast `TOO_LARGE` rejection, **not** a faster successful restore.
Branch byte counts are canonical UTF-8 JSON of each branch (not additive object
envelope overhead). No wall-clock pass threshold is asserted on an unknown host.

## Integrated v5 → v6 comparison

The original harness and raw baseline are preserved. New `.mjs` files keep the
ordinary TypeScript build independent of sibling frozen exports absent on clean
checkouts. The integration owner prepares exports; the harness never creates them.

```sh
SAVE_GROWTH_V5_ROOT=/workspace/scratch/60c35632a076/validation-combat-v5 \
SAVE_GROWTH_CURRENT_ROOT=/workspace/scratch/60c35632a076/validation-history-v6 \
npm exec -- vitest run --config tools/bench-save-growth/v6-comparison.config.mjs --reporter=verbose
```

Provided source identities: v5 commit `4bb8ba1`; v6 tree
`635fd3d5c550605f200d68ebd4d6e1bf7330dc34` (subsequently committed as `5601c67`).
The harness records a SHA-256 over every `src` file in each export and enforces
save/simulation 5/0.5.0 versus 6/0.6.0. Source roots are configurable; defaults are
`../validation-combat-v5` and `../validation-history-v6`, both frozen exports.
For reproduction, export the corresponding commit/tree into separate directories
using the integration owner's usual `git archive` workflow, then supply both root
paths. Never point the comparison at a shared working tree under active edits.

Coverage:

- 100 genuine gather deliveries independently in both engines, exact semantic
  equality after normalizing only representation and simulation-version label
- Identical validator-checked synthetic histories of 100/1k/2.5k/10k jobs
- Real public v5-file migration below the unchanged 4 MiB cap
- At 10k, asserted public `TOO_LARGE` rejection, then explicitly labeled validated
  **in-memory stress migration**, using the real representation migration function
- Normal v6 file roundtrip at 10k; full decoded semantic equality, unchanged source,
  sampled exact receipts, command conflicts and terminal retries
- Validate/envelope/encode/parse timings, one-working-job/full ticks, sealed history
  before timing, archive-identity assertions and reported 100-to-10k timing ratios

No timing thresholds are asserted. This is Node/core evidence, not browser,
IndexedDB, ordinary 10k-job play or unlimited automatic-work acceptance. Timeout is
240 seconds; timings have three samples. No save fixture/export/output is written.
Output prefixes: `SAVE_GROWTH_V6_ENV`, `_ROW`, `_MIGRATION`, `_COMPARISON`.
