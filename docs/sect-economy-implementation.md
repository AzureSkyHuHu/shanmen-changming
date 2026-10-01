# Renewable food and optional production plans

Status (2026-10-01): domain module, recipe data and tests are written. The integration owner has not yet run their checks. World schema/commands/application wiring and the production history safety gate are separate integration work. Automatic production is not enabled in the released preview by this change.

## What this slice actually models

- `gather.grain`: forage at the existing forest without spending any food or seed; 140 on-site work ticks yield one grain only after storage delivery
- `farm.grain`: reserve one grain as seed, work for 240 ticks in the existing herb garden, then deliver five grain. This is a shared mixed cultivation plot and competes with herb gathering for its one real seat
- `cook.meal`: unchanged two grain → three meals, 80 work ticks at the kitchen
- The normal production engine owns travel, station reservations, input escrow, storage arrival, atomic debits/credits, cancellation and existing capacity blocking

This is not new building construction, seasons, crop growth while absent, field expansion, hunger or general monthly household upkeep. Existing seclusion and expedition supply costs are the food sinks currently implemented. Recipe timings/yields are a bounded starter balance, not a long-campaign balance certification.

## Ownership/API

`src/core/sect-economy` has no World, application, render or persistence dependency. It never creates a job, assigns a worker, moves an actor, grants inventory, allocates an ID, emits an event or writes a public command receipt.

The serialized configuration is:

```ts
interface SectEconomyState {
  schemaVersion: 1;
  enabled: boolean;
  nextDecisionTick: number;
  plans: {
    workerId: string;
    enabled: boolean;
    priorities: { recipeId: string; targetStock: number }[];
  }[];
}
```

Up to 36 unique known workers have up to six unique registered single-output, positive-net-output recipe priorities. Targets are integer output-resource quantities from 0 to 999. Zero suppresses that priority. Priority order is intentional; worker consideration is stable ID order. Unknown keys, future schema versions, invalid deadlines, duplicate recipes/workers and unknown workers are rejected at restore/configuration boundaries.

- `createSectEconomyState(tick = 0)`: disabled and empty, including for old-save migration
- `createStarterWorkPlans(eligibleAdultDutyIds)`: optional suggestion, farmer to grain 24 and cook to meals 18. One available adult instead gets cooking then farming/foraging priorities. This does not enable the state
- `isSectEconomyCommand(value)`: validates exact `enabled.set` and `plan.set` command shapes
- `applySectEconomyCommand(state, command, knownWorkerIds)`: immutable configuration transition, returning `{ok:true,state}` or `{ok:false,code}`. Command identity/outcome retention remains World-owned
- `validateSectEconomyState(value, knownWorkerIds, simulationTick)`: strict additive save boundary
- `planAutomaticWork(state, context)`: returns `{state,intents,blocked,status}`. Intents contain only `workerId` and `recipeId`; blockers/status are ephemeral diagnostics, not historical event records

Changing priorities or disabling a plan never cancels any existing job, including an automatic job already admitted. Manual cancellation continues through normal production cancellation. A later UI must make disabling the plan available separately if the user does not want a cancelled automatic recipe to be scheduled again.

## Scheduling and stock arithmetic

The planner decides at most once per 20 simulation ticks and proposes at most two jobs. A saved `nextDecisionTick` prevents duplicate same-boundary decisions on restore. Missed decision intervals are not replayed in a burst. Pausing, combat and a disabled state leave the schedule untouched; a due decision with no legal candidate still advances the deadline using checked integer addition.

World supplies only the at-most-36 live production jobs and at-most-36 workers, with authoritative worker availability including age, duty, life state, away ownership, seclusion/teaching, travel and existing commitments. Existing active job ownership is also independently excluded by the planner. Manual jobs are never displaced.

For each resource:

`projectedStock = owned − reserved + outputs promised by all live jobs`

This includes manual and blocked jobs. It is a target comparison only: promised output cannot be spent as an input, is not a second inventory balance and is not displayed as already owned. Proposed jobs reserve inputs in local calculation and add output promises before the next candidate is evaluated. A full batch may overshoot the target by less than that batch's net yield.

Capacity admission does not assume any other job will consume inputs before this one delivers:

`owned − this proposed job's own input + all existing/proposed output promises + this proposed output <= capacity`

This is deliberately conservative. For a planting job, its own seed debit and harvest credit occur atomically, so its own seed can be subtracted. Another job's expected debit cannot be used to admit this output. Stock-comparison arithmetic saturates at the safe integer limit; actual inventory arithmetic remains the authoritative engine's responsibility.

Missing inputs, missing operational workstations/storage, occupied/unavailable workers, full capacity and met stock targets produce no start command and no repeated rejection receipt. Standard production still discovers actual paths and retains the existing path-request budget; the planner does not create fake routes or teleportation.

## Required World integration

1. Add the state in an explicit new save/simulation schema. Migrate all old saves with disabled, empty plans and preserve their original saved bytes
2. Keep `LEGACY_V4_RECIPE_IDS` as the exact frozen four old recipes when validating old transactions, accepted production origins and executable pending commands. Old rejected receipts must retain their original outcomes
3. Route plan commands through normal persisted World receipts; add exact receipt validation for their results. Do not give this pure module a second command ledger
4. Build the planner context after due manual commands and cultivation/death/away reconciliation, before production stepping. Publish the returned scheduling state at the same complete tick boundary
5. Give each admitted intent a collision-safe World-owned internal identity/provenance, then recheck ordinary authoritative admission for each start. Existing command IDs, reservations and outcomes must not be overwritten. Do not use a magic prefix as the sole collision defense
6. Keep `autoStartAllowance: 0` until the approved retention/byte-headroom contract is integrated. The allowance is a transient integer shared across all intents in the decision, not persisted authority; this module caps it by its own two-job budget
7. If admission unexpectedly fails, do not repeatedly allocate fresh rejected public commands. Diagnose the changed precondition and use the next bounded decision boundary

The current production validator requires the exact originating receipt, reservation and settlement event for every job. No record pruning is included here. See [save retention design](save-retention-design.md). A new-start allowance alone does not bound events on a live blocked job or unrelated domain histories; global transition headroom protection is still required. An unbounded manual history cannot be silently discarded merely because automatic work is added.

## Tests and outstanding acceptance

Written unit tests cover configuration bounds/strictness, disabled migration defaults, stable ordering, cadence, shared admission budgets, missing inputs and fallback foraging, real-versus-promised inventory, active manual output accounting, conservative capacity, no extra work at target, safe-integer comparisons and reloaded planner equivalence.

Written production tests use the real existing World production engine through an explicit test-only adapter: zero-seed recovery, garden seed escrow/cancellation, real storage delivery, farming → cooking, modest-stock stopping without receipt/event churn, reload equivalence and manual/training/away locks. This test adapter is not production wiring and its positive allowance does not authorize enabling the released planner.

Pending: integration-owner test/type/content/build execution; World v5 schema and idempotency integration; history-budget evidence; UI controls/projections; real browser path/work/delivery inspection; long-campaign balance and full gameplay acceptance.
