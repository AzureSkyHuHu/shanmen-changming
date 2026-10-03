# v10 genuine-workload benchmark

Status: implemented, **not run or accepted by the authoring worker**. The integration owner must run type checking and the opt-in benchmark against a frozen source tree. No result below is a performance claim.

## Run explicitly

From the repository root, with the locked Node/npm dependencies already installed:

```sh
node tools/benchmark-v10-workloads.mjs --run > /tmp/v10-workloads.json
```

The default also measures actual headless `ApplicationSessionV10.frame` calls. To measure only the retained private owner:

```sh
node tools/benchmark-v10-workloads.mjs --run --without-session > /tmp/v10-workloads-owner.json
```

To focus measurement on one scenario (the same genuine setup still runs):

```sh
node tools/benchmark-v10-workloads.mjs --run --scenario=upgrade-half-checkpoint --without-session > /tmp/v10-workloads-half.json
```

Without `--run`, the launcher prints usage and does not load or prepare a World. Nothing is added to default tests, builds, content validation, public entry points, persistence or deployment. Progress is written to stderr; a completed JSON report goes to stdout. An assertion, rejected command, capacity failure or missing boundary aborts rather than substituting a synthetic fixture or success row.

### Reusing exact earned checkpoints for profiling

The original run above is unchanged. Explicit `--capture-fixtures=ABSOLUTE_NEW_DIRECTORY`
and `--fixtures=ABSOLUTE_DIRECTORY` modes now support one genuine capture and later
full readmission of the exact saved sources. Both require `--baseline-report=PATH`
to the completed 0030 report, whose file and nine canonical World hashes are pinned.
No manifest supplies admission, sampling policy or executable callbacks. Output
must remain outside the repository; capture/reuse requires a clean frozen commit.

See [the profiling procedure](v10-profiling.md) for exact commands, full save and
record checks, fixture provenance, the separate opt-in CPU profiler and the
distinction between diagnostic profiler times and unprofiled budget measurements.
The tooling author has not run these new paths; integration execution is pending.

## Provenance and setup cost

The sole origin is `createUnregisteredWorldV10('v10-workloads-earned-from-genesis-1')`. No saved fixture is imported, no v9 World is cast/lifted, and no inventory, clock, actor, level, research, cost or admission field is edited. The real four-person starter roster includes a 14-year-old and three eligible adults; this is not four adult workers or 36-person evidence.

Production commands earn wood, herbs, planks and stone. Real construction produces the library. Six real spirit-stone extractions and six insight studies fund the two research completions. Actual research earns basic medicine and herbal compatibility; actual construction and two paid upgrade checkpoints earn L2 alchemy. Actual L2 alternative production travels back to storage, settles the costs, credits a physical dose, and authenticates the subsequent care consumption/effect. Three adults perform concurrent real work in measured scenarios.

Setup executes every normal reducer tick, with complete record checks retained by that production reducer. Commands use the complete v10 capacity-gated command entry. Every final scenario additionally passes the complete record inspector, exact identity check, full capacity assessment and `admitSaveWorldV10`; save admission must preserve the whole World exactly. No reduced budget object or partial validation can admit a scenario. Setup branches are independent deterministic continuations of the same earned checkpoints.

Expect roughly 6,000–10,000 actual reducer ticks across setup/branches, plus full-history command and admission checks. Budget several minutes, potentially longer on a slow machine or a validation-heavy revision. This is a planning estimate, not a measured duration. The report records actual setup milliseconds, reducer ticks, accepted command count and milestone clock positions. Measurement/strict comparison/Session oracle work adds further runtime. Run serially, away from builds and test suites; the integration owner is the sole benchmark executor.

## Sampling contract

Each operation row has exactly 20 measured samples and 3 discarded warmups. Percentiles use nearest rank (20-sample p95 is the 19th sorted sample). All raw milliseconds are retained. Full source inventory, actual capacity costs, roster, earned research/job IDs, upgrade payment evidence, clock positions and canonical World SHA-256 identify the fixture; Node version/platform/architecture identify the process. Record the frozen source commit/tree and host CPU separately with any published measurements.

| Scenario | Sampling and observed boundary |
| --- | --- |
| `upgrade-precheckpoint` | One retained owner, 3 warmup + 20 continuous active ticks, safely below half payment; real wood/herb jobs also active |
| `upgrade-half-checkpoint` | 20 independent exact 199→200 half-payment ticks |
| `upgrade-final-checkpoint` | 20 independent exact 399→400 remainder-payment and L2 completion ticks |
| `l2-production-working` | 3 warmup + 20 continuous productive alternative-medicine ticks, plus wood/herb work |
| `l2-production-work-complete` | 20 independent exact 199→200 work completions; medicine has not yet been delivered |
| `l2-production-delivery` | 20 independent storage-arrival→committed delivery ticks, including actual stock credit |
| `l2-maintenance-renewal` | 20 independent real due-calendar L2 payments with alternative production and gather jobs active |
| `alternative-care-working` | 3 warmup + 20 continuous care ticks; real alternative production and wood gathering run concurrently |
| `alternative-care-complete` | 20 independent exact 39→40 care completions and injury effects using the authenticated alternative dose |

Each repeated-boundary trial creates a new fully admitted owner from the same earned checkpoint and advances one genuine untimed prime tick before measuring the boundary. There are 3 discarded whole-trial warmups, followed by 20 measured whole trials. Creation, prime and snapshot costs are separately reported for private-owner trials. A single one-tick boundary cannot provide 20 distinct consecutive occurrences; these are explicitly repeated independent samples, never padded with idle ticks.

The primary owner interval contains only `owner.advance(1)`. The unchanged `advanceCapacityLimitedTicksV10(source, 1)` is the strict oracle outside timing. Every measured and warmup publication must match its entire canonical World; exact one-tick progress, no stop and non-recovery status are asserted. Domain assertions verify the named work/payment/delivery/care boundary. Owner metrics are raw diagnostics, not a count of all nested validation work. Source immutability is checked.

## Session is a separate measurement

Session rows measure the actual `ApplicationSessionV10.frame` call with a deterministic 50ms timestamp increment at the genuine 1× clock. That includes owner advancement, four fresh bounded DTO queries, projection/publication and Session bookkeeping, with no subscribed UI listeners. Exported Worlds are compared to the strict oracle outside timing; all four projected DTOs are compared against an independently created strict-oracle owner outside timing.

The subsequent cached `getSnapshot()` lookup is timed separately. It is not fresh projection cost. Session creation and boundary priming are outside the primary frame interval. Do not subtract independent owner and Session percentiles to invent an isolated projection percentile. These rows have no React, DOM, Canvas, requestAnimationFrame, browser compositor or physical phone.

## Interpretation and next evidence

This benchmark can establish headless elapsed costs and exactness only for the named genuine four-person workloads. It makes no browser, phone, 36-disciple, 3× speed, long-history, long-duration, migration, public-route or full-game acceptance claim. A fast idle or leaf-only result cannot substitute for these rows, and these rows cannot substitute for end-to-end interactive performance. The script never automatically marks a latency budget passed.

The earlier `tools/benchmark-v10-runtime.*` remains unchanged and has its own narrower lifted-record/leaf scope. New results must identify this workload script, the precise operation and sampling mode. Preserve the whole JSON report, including outliers, setup/creation/export costs, metrics, provenance and any Session rows, before deciding which next optimization is justified.
