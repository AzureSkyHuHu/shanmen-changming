# Long-campaign save and production retention review

Status: **R1/v6 integration passed 715 tests/types/build; initial 10k save-load performance gate failed; optimization pending remeasurement**. Baseline inspected: commit
`4ca31fd7f11083e0912e803baf759b49376d247f`, save v4 / simulation 0.4.0.
Date: 2026-10-01. Only this document and `tools/bench-save-growth/**` belong to
this review. The integration owner runs validation and benchmarks serially.

## Recommendation

1. Before enabling repeat production, separate live production from terminal
   records. Keep all existing receipt results and settlement identities. Moving
   the completed records out of the per-tick map is the first performance fix.
2. Add a versioned, lossless compact archive for terminal jobs, their reservations,
   receipts and events. This buys finite storage headroom; it is not a proof of
   bounded infinite play. Preserve exact fingerprints, not just 32-bit hashes.
3. Keep the scheduler behind a World-owned integer `autoStartAllowance` until
   active/history access, migration, byte-budget reporting and regression tests
   pass. Preflight must not generate rejected commands on every idle tick.
4. For genuinely bounded continuing automatic production, introduce a **new**
   internal-job provenance/retirement contract. Do not retroactively expire v4
   command receipts or silently change what an old duplicate returns.
5. Treat build-history exhaustion, bounded future player receipts and other domain
   histories as explicit follow-on work. A production archive alone cannot make
   the whole campaign indefinitely sustainable.

The reviewer did not run installs, tests, builds, benchmarks, commits or publishing.
The integration owner ran the baseline benchmark below and then authorized a new
isolated `core/history` module with tests. Shared World/kernel edits remain owned
by the integration owner. The measured baseline predates archive implementation.
The intervening World v5 checkpoint is limited to combat compatibility and disabled
sect-economy plans. Archive integration is explicitly **v6**, not part of v5.

## Source-verified behavior and risks

### Production and command hot paths

- `src/core/economy/production.ts:45–46`: `updateOrder` spreads **all**
  `world.transactions` for each moving/working live job. With H historical jobs
  and A live jobs, map copying is O(A × (H + A)) per tick despite the existing
  bounded `activeProductionTransactionIds` index.
- `production.ts:34–41,59–82,96–99`: start and settlement also spread transaction
  and reservation maps. Terminal reservations, full navigation-shaped terminal
  records and start/settlement events are retained.
- `src/core/kernel/events.ts:9`: each append copies the full event array. A change
  of production blocked reason produces another event; merely preventing new
  starts does not bound the history of an already-live, repeatedly blocked job.
- `src/core/kernel/commands.ts:38–103`: accepted commands and most valid rejected
  commands store a full fingerprint and result in the global receipt map. Every
  new receipt spreads that map. Invalid, future-not-due and core-error-paused
  commands have earlier non-recording exits, so the contract is not “every input
  always gets a receipt.”
- `src/application/session.ts:129–134`: every submission enumerates all receipt
  IDs into a Set before choosing `app-command.N`. An archive must be consulted
  here too, or old IDs could be reused after a load.
- `src/application/session.ts:196–221` already projects only the latest five
  events and associated jobs. This avoids copying the full history into UI DTOs;
  the simulation/save problem remains below that useful optimization.
- `src/core/expeditions/world-adapter.ts:292`: player expedition dispatch clones
  the entire World, including production history. Production growth therefore
  affects expedition commands, not only working ticks.

### Validation, encoding and persistence

- `src/core/kernel/validation.ts:107–199`: reservations and transactions own each
  other bidirectionally; inventory reserved totals are recomputed from only live
  reservations, including cultivation attempts. Each production transaction also
  requires its exact accepted originating receipt.
- `validation.ts:205–250`: every settlement event and every receipt event must
  exist. Several `eventIds.includes` calls run inside history loops; the
  production-only case is quadratic in historical jobs/events. Cultivation event
  mirroring and nested domain-receipt lookup have additional `find`/`some` scans.
  Use one validated Set/Map per collection; do not reduce what is checked.
- `src/core/kernel/save.ts:12–13,37–41`: snapshot creation fully validates, makes
  a canonical JSON clone, and hashes the canonical envelope. Serialization then
  canonicalizes again. Parsing checks the checksum and full semantic schema.
  These costs and transient strings are separate from steady tick cost.
- `src/core/kernel/save.ts:49` rejects more than 4,194,304 characters;
  `src/platform/files/save-files.ts:12,23–26` also rejects more than 4,194,304 UTF-8
  bytes. This is a **4 MiB file limit**, not the design baseline's proposed 5 MB.
- `src/platform/persistence/indexeddb-save-repository.ts:250–357`: browser saves
  validate before writing, reread/validate the stored bytes, and validate retained
  generations while protecting newer formats. Generation rotation bounds the
  **number of snapshots**, not the size of each World's history. Up to three
  automatic plus manual/checkpoint snapshots per slot retain multiple full copies.
- `src/application/save-controller.ts:156–166`: memory-mode save currently skips
  the file-size validation and reports success after storing raw serialization.
  It can therefore report an oversized memory save that loading/export rejects.
  All save modes should use the same validated encoding/size boundary before
  reporting success or replacing the previous valid bytes.
- `SnapshotRecord.text` explicitly stores exact source text. Loading migration
  returns an in-memory new world; it must never rewrite those source bytes.

### Other campaign limits are real, but outside the first archive implementation

- Build `MAX_BUILD_COMMANDS` is 1,024 (`src/core/builds/rules.ts:7`). A new build
  command fails at the limit, and its current validator reconstructs semantic
  state by replaying that history (`builds.ts:251–304`). Expedition departure and
  return each consume a build authority command (`world-adapter.ts:174–175,
  211–212`), in addition to milestones and player changes. Consequently the cap
  can stop continuing expeditions after fewer than 512 complete trips. This is an
  upper bound from code, **not** an observed playthrough count.
- Cultivation has a 100,000-entry collection validation limit, retained attempts,
  receipts and mirrored events. It clones its domain frame on commands/month
  transitions. This must not be silently trimmed by a production-specific policy.
- Expedition per-run history is bounded to 512 domain commands; the active run's
  effect receipts are reset on a new departure, but World run history and player
  command receipts persist. World run history is required to validate old receipt
  run identities. Preserve settlement/death mapping facts when archiving it.

## Existing contracts that retention must preserve

| Operation | Existing v4 behavior |
|---|---|
| Repeat recorded command ID with the same kind/payload | Return a cloned **original** `CommandResult`, even when the world has changed |
| Same recorded command ID, different kind/payload | `COMMAND_CONFLICT`, no new resources, IDs, RNG or events |
| Repeat previously rejected recorded command | Return its original rejection, even if the command would now be legal |
| Repeat production start after its job commits | Original start result and **start event ID**, not a new job or settlement result |
| Complete committed transaction | Success with original settlement event ID; no resource credit |
| Cancel cancelled transaction | Success with original cancellation event ID; no second release |
| Cancel committed / complete cancelled transaction | `TRANSACTION_FINISHED` |
| Unknown transaction | `UNKNOWN_TRANSACTION` |

Changing `sequence`/`issuedTick` alone does not change the command fingerprint.
The production APIs are exported from `kernel/index.ts`, so their terminal
outcomes are a real API contract, not an implementation detail to drop casually.

The inventory ledger is the current resource authority. Do **not** rebuild current
inventory by summing old recipe outputs: resources have other debit/credit sources,
recipes may be versioned, and old accepted records are not an economic replay log.
Preserve pending commands, RNG streams, sequence high-water marks, current build
sources, open reservations, activity locks and unsettled rewards exactly.

## Proposed v6 active/history split

### Ownership and API shape

Introduce a small production-owned branch with:

- `liveById`: full `ProductionTransaction` for Running/Blocked jobs only, at most
  `MAX_DISCIPLES` (36); preserve the deterministic live ordering/index
- `liveReservationsById`: production reservations still in `reserved` state only
- `terminalArchive`: immutable terminal job + reservation records; exact known
  legacy outcomes, identities and original receipt/event references
- A bounded recent presentation view, derived from authoritative events/archive
  queries rather than used as the archive itself

Global command history remains command-owned; global event history remains
event-owned. Do not duplicate authority by copying the same receipt into a second
independently mutable store. Initially, keep full original receipt values in
archive pages with a lossless codec; specialized receipt encoding can follow.

Add explicit read helpers (`lookupProduction`, `lookupCommandReceipt`,
`lookupEvent`, `recentEvents`) and transition helpers that own archive append.
All production terminal retries consult the terminal archive. Work/route updates
touch only `liveById`; inactive archive pages keep referential identity. Avoid
materializing a merged live+history map on the hot path.

Use simple immutable pages, for example 256 records per page, and a short mutable-
by-copy tail. This is an in-memory TypeScript representation, not a new database.
Copying a page directory remains O(number of pages) when appending; do not claim
constant-time archive insertion. The first acceptance target is to remove H from
ordinary work/movement ticks and materially reduce event/settlement append cost.
Derived lookup indexes may be rebuilt on load and cached outside the serialized
authority; correctness and replay must not depend on cache presence or eviction.
Do not introduce a generic storage engine, services or third-party dependencies.

Call sites requiring coordinated changes:

- World types/create-world/bootstrap/migrations; production and cultivation job
  cancellation; any expedition departure that cancels worker jobs
- Command dispatch and application command ID allocation; archive lookup before
  due/error checks must retain the existing duplicate precedence
- Session recent-event/job projection; compatibility query for terminal jobs
- Event append and cultivation bridge: replace `.slice(previous.events.length)`
  emission detection with explicit emitted-event IDs or a stable event cursor.
  A bounded recent array cannot safely stand in for an append-only count
- Validators, semantic ID registry, save encoder/decoder, file and memory save
  boundary, tests and byte/status reporting

Expedition dispatch's full-world clone is a separate adjacent hotspot. Preserve
archive references when its transactional draft is made, but only after explicitly
copying every branch the adapter can mutate (including inventory and sequences).
Deleting `cloneJson(world)` without this audit breaks rejected-command rollback
and input ownership. Add rejection/throw/input-immutability tests before that
optimization; a production-only hot-path result does not prove tactics are fast.

### Safe terminal transition

Commit resources, end reservation, emit settlement, release station/worker, remove
the live index entry and append terminal facts in **one** pure transition. A save
must see all-or-none. Keep transaction/reservation/action/event IDs allocated by
the existing monotonic sequences; never recycle them when a record moves.

Validate the union of live/archive IDs once, including other domain-owned instance
IDs. A terminal archived ID cannot alias a live transaction, reservation, source,
attempt or equipment item. Only live reservations contribute to `inventory.reserved`;
archived settlement records prove ownership/outcome but cannot reserve again.

### Lossless encoding, with deliberately narrow scope

Recommended first codec: versioned positional records plus exact string pools for
repeated keys/definition IDs/fingerprints. Numeric ID suffixes may be encoded as
safe integers with explicit namespace tags. Keep all distinct allocated IDs; do
not assume transaction/reservation/event IDs are adjacent or consecutive.

For canonical engine-produced terminal production records, `navigation` is empty,
`blockedReason` null, and phase derives from terminal state. Encode these defaults
once and reconstruct them. Preserve worksite/storage IDs, partial work at cancel,
start/completion ticks, root action, command, worker, recipe, reservation lines,
result event and start result separately. Preserve event order and parent linkage.
An event ID is not interchangeable with its transaction ID or log ordinal.

Do not rederive reservation input lines or historical `requiredTicks` from a
mutable current catalog unless the archive pins and validates the original rules
version. Do not replace an exact command fingerprint with `stableHash`/FNV-1a:
hash collisions would change conflict/deduplication behavior.

V4 validators permit extra object properties in some ledger records. An encoder
must either use a generic lossless fallback for noncanonical valid shapes or
preserve extension fields explicitly; it must not silently drop accepted input.
Require `expand(compact(record))` to be canonically equal to the original record,
including exact raw fingerprint strings and returned result fields.

This approach reduces repeated JSON overhead but still grows with distinct manual
receipts and outcomes. No compression ratio is claimed until measured. General
gzip/base64 of the entire world is not the recommended first fix: it leaves hot
path cloning intact, adds expansion-limit/security/async adapter considerations,
and cannot establish bounded logical history.

## Retention policy and the unavoidable contract choice

It is impossible to retain arbitrary command IDs, exact arbitrary original results
and exact payload-conflict checks forever in constant bounded space. Lossless
encoding improves the coefficient, not this information requirement.

### Existing records: preserve exact behavior

All v1–v4 accepted/rejected receipts, terminal settlements and events needed for
their results remain lossless. No TTL, last-N deletion, approximate Bloom filter,
receipt-hash-only tombstone or re-execution of expired old commands. The source
save text remains untouched in its stored generation.

### New automatic jobs: explicit versioned internal lifecycle

To prevent automatic work from amplifying public receipt history, new auto jobs
should originate from a persisted plan/setting and deterministic cycle identity,
not fabricated player `production.start` commands. The setting command keeps its
normal player receipt; each job keeps full live resource/worker ownership.

This needs a provenance union such as player-command vs automatic-plan, new
validator branches, and a documented retirement boundary. New internal job
completion is retryable only while its source-owned job/settlement is pending;
after atomically committing and advancing its monotonic source cursor, a retired
internal identity is never re-admitted and cannot grant resources again. Keep
bounded recent terminal detail plus authoritative cumulative statistics if useful.
No public external promise of exact perpetual results is made for these new
internal handles. Old manual and migrated terminal APIs keep their exact outcomes.

Automatic handles must not be guessable aliases in the player-command namespace.
If a player cancellation explicitly references a live automatic job, its own
accepted player receipt must retain the exact cancellation result and referenced
event for its promised receipt lifetime. That reference pins the minimum terminal
record even after normal automatic retirement. Reject future/retired identities
without admitting new work. Source cursors, pending-job identity and archive pins
must survive saves; do not infer them from the display log.

The economy planner's agreed interface is integer `autoStartAllowance >= 0`, the
maximum new starts this decision may propose, shared/decremented across all plans.
It is computed by World integration, not saved by the planner or treated as an
authoritative budget. Zero suppresses new jobs only. Existing jobs, cancellation,
manual decisions and safe export must remain available.

### Future player receipt contract: separate decision, not this phase

If a strictly bounded player history is required, introduce a new versioned
command epoch/sequence protocol with a retained result window and an acknowledged
low-water mark. Below the mark, return explicit `RECEIPT_EXPIRED` with **no effect**;
do not re-execute. This changes exact old-result/conflict behavior, so only new
protocol commands may opt into it. Legacy receipts must remain exact exceptions.
The existing arbitrary ID plus caller-chosen `sequence` is insufficient: callers
can skip/reuse numbers, and receipt lookup currently ignores sequence entirely.
Epoch ownership, restart/load behavior, pending commands and typed UI messages
need a separate schema/API design. Do not silently reinterpret existing fields.

### Safety budget while the archive is finite

Report canonical encoded UTF-8 bytes and remaining headroom using the same codec
as file/browser/memory save. Reserve room for every live settlement and important
pending decision before admitting auto work. A headroom warning or safety pause
must happen while a valid recoverable/exportable boundary still exists, not after
`exportWorldSave` begins failing. A count-only job cap is not a proven byte bound.

Since active blocked events and other domains can also grow, “stop new auto starts
at X jobs” is only an interim risk reduction. A comprehensive guard needs an
upper-bound transition budget or precommit budget check for all growing branches,
and a typed safe pause that retains the previous complete boundary. It must not
mutate gameplay silently, drop facts or claim the long-campaign requirement met.
Raising the 4 MiB cap alone only delays the failure and increases parse/heap cost.

## Migration and preservation

- Use new save/schema and simulation versions for the new serialized authority.
  Pure representation changes can have semantic equivalence; raw `domainHash`
  includes the representation and therefore need not equal across versions.
- Add frozen prior-version validators and migrations. At review baseline,
  `validateWorldSchema` treated
  version 4 as “current,” and `migrateWorldV3ToV4` imports the changing
  `SIMULATION_VERSION`. The separate v5 owner must freeze those identities; then
  archive integration adds a frozen v5→v6 boundary. Do not accidentally validate
  old data with the newest contracts.
- Verify original checksum and original version/schema first, then convert a
  cloned value. Validate every intermediate and final version. Make conversion
  deterministic, with no RNG draws, resource effects or fresh gameplay IDs.
- Keep exact `SnapshotRecord.text` bytes and source checksum. Reading a migration
  must not update the slot pointer or prune its source; an explicit successful
  save creates the new generation. Current unsupported-newer-save protection and
  lease/revision fencing must remain.
- Keep checked-in legacy fixture files byte-identical. New migration fixtures are
  additional files, with old/new semantic projections and provenance documented.
- Validate input bytes **and** decoded record count/depth/size. Compact data cannot
  be permitted to expand without a bounded allocation budget. Reject malformed
  tags, duplicate pooled keys, namespace mismatches, overflow and dangling refs.

## Reproducible measurements

Harness and exact command: `tools/bench-save-growth/README.md`.
The integration owner records commit, node/host and raw `SAVE_GROWTH_*` rows.

- Actual simulation: 0/1/10/100 completed gather-wood jobs; real command, movement,
  work, delivery, inventory and calendar. No increased capacity or skipped time.
- Synthetic stress: 0/100/1,000/2,500/5,000/10,000 copied terminal records with fresh
  IDs and matching receipts/events, validated by the current validator. The fixed
  inventory/calendar is deliberately **not** a replay of those jobs.
- Measure UTF-8 file and branch bytes, validation, envelope generation, final
  encoding, import, original duplicate result, isolated production tick and full
  tick. Over-cap parse rejection is reported separately from successful restores.
- The harness does not measure IndexedDB latency/quota, browser UI/heap/long tasks,
  battle costs or 36 workers. Actual browser profiling remains a release gate.

Source-only rate estimate (not measured performance): at 20 Hz, 120 wood-work ticks
cost at least six simulated seconds before walking/delivery. An always-supplied
single station could therefore complete at most 600 such jobs/hour at 1×, or 1,800
per real hour at 3×; walking, stock targets, capacity and other activity reduce it.
Convert measured bytes/job to an approximate cap horizon only with those
assumptions visible. The starter 999-unit capacity normally stops gathering much
earlier; recurring consumption is why auto production makes the history issue
relevant again. Do not call a synthetic byte threshold a played campaign duration.

### Measured v4 baseline, integration-owner run

The parent ran the exact command on HEAD `3c4cdee` with concurrent advanced-combat
work present; the production path and World save remained v4. This is **not** a
clean checkout performance claim for `4ca31fd`. Host: Node v24.19.0, Linux x64,
Intel Xeon Platinum 8573C. Seed `save-growth-review-v4`; 3 samples per measurement,
64 isolated working ticks and 40 full ticks per sample. One benchmark test passed,
21.11 seconds total (test body 20,159 ms). Parent reported completion 2026-10-01
09:41 UTC; raw runner Start label is `02:40:20` and is not interpreted as UTC.
Raw stdout is retained outside the repository at
`/workspace/scratch/60c35632a076/save-growth-benchmark.log`.

All timings below are milliseconds, medians. “Rejected” means the byte cap stopped
parsing; it does not mean the larger file restored quickly. UTF-8 bytes equaled
character counts in this ASCII fixture.

| Data | Jobs | Save bytes | Validate | Envelope | Encode | Parse | Working tick | Full tick | Duplicate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Actual | 0 | 22,426 | 9.584 | 13.223 | 0.566 | 9.523 | 0.00397 | 0.00851 | — |
| Actual | 1 | 23,702 | 10.071 | 7.364 | 0.414 | 7.095 | 0.00320 | 0.00419 | 0.01871 |
| Actual | 10 | 35,272 | 8.802 | 8.504 | 0.697 | 8.629 | 0.00172 | 0.00297 | 0.01127 |
| Actual | 100 | 152,837 | 10.708 | 17.272 | 2.900 | 12.200 | 0.00653 | 0.00593 | 0.00945 |
| Synthetic | 0 | 22,430 | 6.462 | 8.309 | 0.464 | 6.700 | 0.00376 | 0.00737 | — |
| Synthetic | 100 | 152,289 | 9.771 | 16.125 | 3.141 | 13.631 | 0.00695 | 0.00998 | 0.00833 |
| Synthetic | 1,000 | 1,338,878 | 30.082 | 108.252 | 24.913 | 64.947 | 0.42595 | 0.41844 | 0.00835 |
| Synthetic | 2,500 | 3,335,378 | 87.602 | 262.908 | 64.786 | 202.715 | 0.87200 | 0.97036 | 0.00793 |
| Synthetic | 5,000 | 6,663,060 | 271.328 | 587.132 | 124.959 | Rejected | 2.18606 | 2.29162 | 0.00892 |
| Synthetic | 10,000 | 13,383,067 | 739.925 | 1,635.528 | 419.134 | Rejected | 5.66986 | 5.10694 | 0.00973 |

| Data/jobs | Transaction bytes | Reservation bytes | Receipt bytes | Event bytes | Build bytes | Cultivation bytes |
|---|---:|---:|---:|---:|---:|---:|
| Actual 0 | 2 | 2 | 2 | 2 | 10,257 | 1,609 |
| Actual 1 | 476 | 113 | 296 | 395 | 10,257 | 1,609 |
| Actual 10 | 4,785 | 1,121 | 2,959 | 3,981 | 10,257 | 1,609 |
| Actual 100 | 48,509 | 11,407 | 29,990 | 40,497 | 10,257 | 1,611 |
| Synthetic 0 | 2 | 2 | 2 | 2 | 10,257 | 1,609 |
| Synthetic 100 | 48,142 | 11,410 | 30,287 | 40,023 | 10,257 | 1,609 |
| Synthetic 1,000 | 486,704 | 116,469 | 307,607 | 405,668 | 10,257 | 1,609 |
| Synthetic 2,500 | 1,223,204 | 293,469 | 775,607 | 1,020,668 | 10,257 | 1,609 |
| Synthetic 5,000 | 2,450,764 | 588,528 | 1,555,627 | 2,045,709 | 10,257 | 1,609 |
| Synthetic 10,000 | 4,925,766 | 1,193,528 | 3,125,627 | 4,115,713 | 10,257 | 1,609 |

Actual 1/10/100 jobs reached 157/1,606/16,096 ticks and 28/64/424 owned wood;
initial owned wood was 24. Generating all 100 jobs plus the intermediate
measurements took 629.305 ms. Synthetic cases kept tick 157 and owned wood 28.
The synthetic 2.5k→5k segment grew by about 1,331 bytes/job. Linear interpolation
puts this fixture's 4 MiB crossing near 3,145 historical jobs. This is an estimate
between measured points, not a validated exact boundary or a real played horizon.

The actual repeated wood job settled in 161 ticks after the first 157-tick job;
at that observed path length it is about 447 deliveries/hour at 1×. If resources
were continually consumed and one station ran without interruptions, 3,145 jobs
would therefore be roughly 7.0 hours at 1× or 2.3 hours at 3×. This projection
explicitly ignores capacity pauses, targets, lifespan, other domains and player
activity; the benchmark did **not** simulate those hours. It shows why an automatic
economy cannot ship against the existing unbounded archive as a long-game solution.

## Acceptance and proposed bounded implementation phase

### Phase R1: approve one coordinated production/archive change

Scope: World production live/terminal split, immutable terminal/event archive,
lossless codec, exact receipt lookups, linear cross-reference validation, v5→v6
migration, session lookups/ID allocation and uniform save-size errors. Keep the
scheduler gated. Do not change other domains' replay semantics or broadly rewrite
the economy. Parent assigns one integration owner for shared core/schema changes.

Required regressions:

1. Same seed/commands/steps and split-vs-contiguous advances yield identical v6
   hashes; save/load at every production phase preserves progression/resources.
2. Old accepted **and rejected** commands return byte-equivalent canonical results
   after archival, migration and restore; same-ID changed payload still conflicts.
   Changing sequence/tick alone retains current duplicate behavior.
3. Start receipt retains start event; committed/cancelled terminal APIs keep the
   table above. Repeated completion/cancel never changes inventory, IDs or RNG.
4. Cancellation during travel, capacity block, worker death, cultivation role
   change and departure releases ownership once and preserves position. Archive
   move plus resource/station/worker updates is atomic under fault injection.
5. Corrupt live/archive/pending references, cross-domain ID collisions, duplicate
   event IDs, archive order issues and parent links are rejected as before. Source
   archive cannot supply a live reservation or enable a repeated reward.
6. Codec roundtrip is lossless for canonical and fallback valid v4 records; exact
   source file bytes, all existing fixtures and unsupported-newer generations
   remain unchanged after load, migration failure and write failure.
7. File, browser and memory save reject the same oversize encoded output without
   claiming success or replacing a prior valid save. Boundary tests include UTF-8
   multibyte strings, exactly-at-limit and one-byte-over data.
8. Application command allocation consults archived receipts, survives reload and
   does not scan the full historical archive on every UI submission.

Performance acceptance is measured on the same host/build, not a flaky CI timer:

- At 10,000 terminal jobs with one live Working job, archive object identity is
  unchanged across ordinary ticks; no enumeration/serialization of H historical
  records occurs in that tick path. Test this structurally as well as timing it.
- Target one-live-job median tick cost at 10k history within 2× the 100-history
  measurement, with a documented noise floor. Add 36-live-job fixtures and browser
  p50/p95/p99 measurements before declaring the 20 Hz/60 fps budget met.
- Validation uses indexed linear reference checks; 10k/1k cost should scale near
  input growth rather than 100× quadratic growth after fixed startup cost. Measure
  build/cultivation replay separately so this target is not falsely generalized.
- Suggested minimum capacity target: compact production-only 10k-history save
  stays below 3 MiB, leaving at least 1 MiB of the existing file limit for other
  content. This is a proposed gate, **not** an established compression result or a
  proof a full battle/campaign fits. Adjust only from recorded measurements.
- The design budget of <1 second save/load and normal 60 fps still needs a stated
  reference browser/device and peak heap/long-task evidence. Node timing alone
  cannot pass it.

### Phase R2: bound new auto lifecycle, then enable sustainable production

Integrate new automatic provenance/retirement, resource target preflight and
source cursors, retain exact pinned player receipts, and run genuinely simulated
production/consumption/save/reload cycles over the intended campaign horizon.
Assert bounded automatic-only terminal/event history, no rejected-command churn,
no duplicate outputs, stable ID ownership and a working export at every checkpoint.
Neither R1's lossless compression nor a safe-stop allowance substitutes for R2.

### Tracked follow-on: other permanent histories

The 1,024 build-history limit needs a versioned checkpoint plus validated suffix
design or a different bounded authority ledger. Preserve acquired equipment,
awards, removed source ownership and exact public receipts; a checksum-only
checkpoint cannot replace the current semantic replay validator. Cultivation,
expedition history and future bounded player receipts need equally explicit
contracts. These are remaining complete-game requirements, not solved by R1.

## Isolated module handoff (26 focused tests passed)

Files: `src/core/history/{types,archive,index}.ts` and
`tests/history/archive.test.ts`. No shared World/kernel/application file was edited
by this worker. The parent independently fixed memory-mode byte validation and
added memory/browser cap regressions; do not duplicate that application change.

Public exports:

- `createHistoryArchive()` and idempotent `restoreHistoryArchive(value)`
- `validateHistoryArchive(value): string[]`, structural/codec checks only
- `appendHistoryBatch(archive, { production?, commandReceipts?, events? })`
- `appendArchivedProduction(archive, transaction, reservation)`
- `appendArchivedCommandReceipt(archive, receipt)` / `appendArchivedEvent(archive, event)`
- `lookupArchivedProduction(archive, id): ArchivedProduction | null`
- `lookupArchivedCommandReceipt(archive, id): CommandReceipt | null`
- `lookupArchivedEvent(archive, id): DomainEvent | null`
- `readArchivedEvents(archive, offset, limit)` using original append ordinal
- `iterateArchivedProduction`, `iterateArchivedCommandReceipts`, and
  `iterateArchivedEvents` return detached streaming records in append order
- `visitArchivedRecords(archive, { production?, commandReceipt?, event? })`

`HistoryArchive` has independent schema/codec versions 1, a maximum 256-entry
exact-string pool, and production/receipt/event tables of at most 256 rows per
immutable page. Production tuples reconstruct all terminal fields and reservation
lines. Production events and plain receipts have specialized tuples; noncanonical
legacy extension-bearing records and other-domain results use lossless raw rows.
The string pool has a bounded dictionary; later unique strings stay inline.

Every returned archive is owned/frozen. Import restore validates and clones input,
does not freeze the caller's object, and constructs lookup indexes once. Repeated
restore of an already-owned archive returns it unchanged. Unsealed query inputs
are accepted safely, but integration should replace them with the restored branch
once so it does not redo import work for every query. Every query/visitor returns
detached decoded values, including raw fallbacks.

WeakMap indexes are reconstructible and not serialized. Each index uses 256
immutable hash buckets; an append copies only the affected bucket and page tail,
so forked archives do not see each other's future entries. No cache is required
for correctness. History pages retain identity across unrelated transitions.
Batch append is atomic: a later conflict/invalid row throws without changing the
prior archive or input records. Identical reappend of an owned record is a no-op.

Defensive limits include 100,000 rows per table, 64 MiB expanded canonical text,
bounded JSON depth/nodes, safe numeric ID suffixes, exact tuple arity, pool bounds,
duplicate identities and transaction/reservation collision checks. These are
codec allocation bounds, not a claim that a whole World fits its 4 MiB file limit.
World integration still checks live/archive union ownership, clock bounds, recipes,
event parents/results, originating receipts and all cross-domain relationships.

Parent ran `npm exec -- vitest run tests/history/archive.test.ts`: **26 tests
passed**, reported 2026-10-01 09:59 UTC. An earlier nullable fixture TypeScript
error was fixed; full-tree typecheck/build status remains integration-owner
evidence, not implied by this focused test result.

Observed `HISTORY_CODEC_SIZE` for 10,000 **synthetic** terminal bundles:

- Compact archive: **1,815,095 UTF-8 bytes** (about 1.73 MiB)
- Equivalent expanded legacy collections: **13,460,129 bytes**
- Encoded fraction: **13.4849748%**, about **86.52% fewer bytes**
- Exact string pool: 3 entries
- Pages: 40 production, 40 command-receipt, 79 event pages

The ratio compares the same crafted plank-job records, reservations, receipts and
events. It is separate from the earlier v4 gather-wood World benchmark, whose
fixture/content differs. The archive bytes exclude the rest of World and envelope,
and do not prove full-World restore, old-command replay, long simulation, per-tick
speed, IndexedDB behavior or browser performance. Raw parent log is outside the
repository at `/workspace/scratch/60c35632a076/history-size-observed.log`.

The source-level API handoff was subsequently integrated into v6. Scheduler
allowance stays zero until the distinct new-auto-job lifecycle is integrated and
verified. Three streaming iterator wrappers and two tests were added for v6 early-
return validators; the initial integrated tree passed 715 total tests/types/build.

## Integrated R1 benchmark: frozen v5 versus frozen v6

Parent-run result reported 2026-10-01 10:33 UTC: one comparison test passed in
49.55 seconds (test body 47,580 ms). Raw log:
`/workspace/scratch/60c35632a076/v6-comparison.log`. The runner's `03:29:13` start
label is retained as-is rather than interpreted as UTC. Exact command and export
preparation are documented in `tools/bench-save-growth/README.md`.

Both source trees were frozen, so subsequent shared-workspace edits cannot be
mistaken for these measurements:

- v5: commit `4bb8ba1`, export `validation-combat-v5`, 120 source files;
  source SHA-256 `181a169380ca16f386562d60e94c720aea74e03ff6bfec5842b6fa0ce9d3c034`
- v6: tree `635fd3d5c550605f200d68ebd4d6e1bf7330dc34`, commit `5601c67`, export
  `validation-history-v6`, 133 source files;
  source SHA-256 `bf318f83f5113966cc920ef2d9465690456bf9423c8caa3f82e615fcbbd459ea`
- Hash algorithm: sorted `src`-relative path + NUL + file bytes + NUL, SHA-256
- Node v24.19.0, Linux x64, Intel Xeon Platinum 8573C; seed
  `save-growth-review-v4`; three timing samples, 64 isolated Working ticks per
  sample, 40 full ticks per sample

All times below are median milliseconds. These include whole-World files, not
just codec rows. The 100-job actual scenarios ran independently through both
engines to tick 16,096 and 424 owned wood. Synthetic scenarios stayed at tick 157
and 28 owned wood; their histories are validator-approved shape stress data,
not a causally played economy.

| Data/jobs | Version | Save bytes | Validate | Envelope | Encode | Parse file | Working tick | Full tick |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Actual 100 | v5 | 152,926 | 10.975 | 17.142 | 3.281 | 13.290 | 0.00526 | 0.00504 |
| Actual 100 | v6 | 67,401 | 18.023 | 13.188 | 1.168 | 26.643 | 0.00097 | 0.00168 |
| Synthetic 100 | v5 | 152,378 | 8.890 | 22.330 | 4.262 | 12.076 | 0.01387 | 0.01214 |
| Synthetic 100 | v6 | 66,781 | 12.421 | 17.284 | 1.361 | 30.286 | 0.00328 | 0.00836 |
| Synthetic 1,000 | v5 | 1,338,967 | 24.191 | 87.893 | 42.946 | 99.392 | 0.50808 | 0.37734 |
| Synthetic 1,000 | v6 | 225,449 | 33.958 | 51.733 | 6.818 | 280.163 | 0.00422 | 0.00658 |
| Synthetic 2,500 | v5 | 3,335,467 | 86.098 | 256.258 | 81.064 | 407.786 | 0.86892 | 0.93724 |
| Synthetic 2,500 | v6 | 502,998 | 76.625 | 116.893 | 14.845 | 674.794 | 0.00410 | 0.00557 |
| Synthetic 10,000 | v5 | 13,383,156 | 642.232 | 1,393.175 | 349.192 | TOO_LARGE | 5.00800 | 4.26340 |
| Synthetic 10,000 | v6 | 1,935,973 | 336.897 | 493.758 | 68.072 | **2,832.490** | 0.00240 | 0.00923 |

For every terminal N-job v6 scenario, the live transaction/reservation maps were
empty, recent receipts/events were each 64, and archive counts were N production,
N−64 receipts and 2N−64 events. The v5 “live” map count in raw output means its
unsplit map, not N active workers. V6 archive bytes alone were 12,553 for actual
100 jobs, and 11,957 / 170,102 / 447,591 / 1,880,111 for synthetic 100 / 1k / 2.5k /
10k respectively. UTF-8 bytes equaled character counts in these ASCII fixtures.

| Source | Source bytes | Migration route | Median ms | Maximum ms |
|---|---:|---|---:|---:|
| Actual 100 | 152,926 | Public v5 file import | 75.300 | 96.266 |
| Synthetic 100 | 152,378 | Public v5 file import | 59.696 | 60.943 |
| Synthetic 1,000 | 1,338,967 | Public v5 file import | 431.978 | 440.378 |
| Synthetic 2,500 | 3,335,467 | Public v5 file import | 1,590.795 | 2,546.374 |
| Synthetic 10,000 | 13,383,156 | Validated in-memory stress conversion only | 1,642.632 | 1,726.359 |

At 10k, public import of the old oversized file was explicitly tested and rejected
as `TOO_LARGE`; the direct internal representation conversion is **not** supported
oversized file import. The compact v6 file then passed ordinary public file restore.
Every migration preserved the full normalized semantic projection and original
source. Sampled old receipts, changed-payload conflicts and terminal retries stayed
exact. The 100 actual v5/v6 runs also had exactly equal semantic projections.

The 10k whole-file encoded fraction was 14.4657% (about 85.53% fewer bytes).
Ordinary v6 ticks retained the exact archive object identity. Its 100→10k Working
tick ratio was 0.732 and full-tick ratio 1.104 on this host; no wall-clock threshold
was asserted. These support the intended removal of historical-map copying from
ordinary work ticks, not a browser performance certification.

**Load-performance acceptance is not met:** 10k v6 `parseSaveFile` median was
2.832 seconds, above the proposed one-second target. Under-cap 2.5k v5→v6 public
migration also exceeded a second. Parent authorized a separate performance-only
follow-up: one bounded plain-data archive clone + one structural/decode/index
validation, checksum verification before once-owned World semantic validation,
and sharing authenticated immutable archives in session snapshots. All schema,
cross-reference and byte-limit checks remain required. Two new archive regressions
reject getters without invoking them and cover safe escaped/prototype-named data;
that optimization requires fresh tests and a separately pinned benchmark.

### R1 first load optimization rerun: improved, still over target

Parent reported the next comparison passing in 41.75 seconds on 2026-10-01
10:42 UTC. Raw log: `/workspace/scratch/60c35632a076/v6-optimized-comparison.log`.
The v5 export/hash, host, fixtures and sample settings were unchanged. Current
source was the separate frozen `validation-history-v6-opt` export, 139 source
files, SHA-256
`040f1eb59c6cb79ba2845e757dc82c660c0c1ac3e85e681c88313625237eaba7`.
It includes the bounded getter-safe plain-data archive clone and one owned decode/
index validation, checksum-before-once-owned save parsing, and session sharing of
authenticated immutable archive pages.

All file bytes, decoded semantics, original-source preservation, sampled duplicate/
terminal outcomes and structural archive-identity checks stayed unchanged.

| v6 data/jobs | Save bytes | Validate ms | Envelope ms | Encode ms | Parse median ms | Parse max ms | Working tick ms | Full tick ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Actual 100 | 67,401 | 9.865 | 14.513 | 1.568 | 20.290 | 30.060 | 0.00103 | 0.00212 |
| Synthetic 100 | 66,781 | 9.520 | 11.415 | 1.144 | 14.143 | 15.995 | 0.00465 | 0.00943 |
| Synthetic 1,000 | 225,449 | 30.952 | 39.449 | 8.463 | 133.989 | 176.399 | 0.00344 | 0.01029 |
| Synthetic 2,500 | 502,998 | 79.181 | 99.900 | 17.384 | 274.380 | 317.318 | 0.00471 | 0.00786 |
| Synthetic 10,000 | 1,935,973 | 339.462 | 420.079 | 66.149 | **1,117.345** | **1,126.064** | 0.00185 | 0.01263 |

The 10k parse samples were 1,126.064 / 1,083.393 / 1,117.345 ms. The median fell
from 2,832.490 to 1,117.345 ms, but **every sample still missed the <1,000 ms
target**. R1 load-performance acceptance therefore remains failed; do not label
the optimization complete or relax the threshold to turn this into a pass.

Public migration medians for actual100/synthetic100/1k/2.5k were
60.836 / 50.175 / 288.488 / 764.632 ms (maxima 85.370 / 55.502 / 293.001 /
819.760 ms). The oversized10k direct in-memory conversion measured 2,565.796 ms
median, 2,800.530 ms maximum, slower than the initial run's 1,642.632 ms median.
This is a distinct stress-conversion operation and must not be hidden by the
improved normal-parse figure. Its public old-file import remained correctly refused.
Run-to-run timing variation and differing work in the migration path remain
visible in the retained raw logs.

The 100→10k Working tick ratio was 0.398; full-tick ratio was 1.340. Historical
growth still did not cause ordinary archive copies. Parent assigned the next
semantic-validation single-pass reduction to the World owner; no further archive
codec change is part of that follow-up unless a correctness defect is found.

## R2 decision proposal: bounded internal work, World v7

Status: **design only, 2026-10-01 10:12 UTC**. R1/World v6 integration is in
progress with a different owner. This proposal does not expand v6. Campaign/new
content integration follows as v8. The source inspection below observed the
current planner, command queue, cultivation/expedition cancellation bridges and
the in-progress v6 history queries; it is not a claim that R2 is implemented.

### Decision summary

Use one global automatic-cycle counter, a separate bounded live-job branch, a
64-entry recent automatic journal, and a manual-reference pin branch. Do not put
ordinary automatic terminal jobs, notices or fabricated start receipts in the
lossless manual archive. The automatic state has bounded cardinality in the
absence of new external player commands. Numeric counters use checked safe
integers; exhaustion causes a safe stop, never wraparound or ID reuse.

The current `HistoryArchive` codec remains version 1. Its manual production rows
require `commandId` and `instance:N` identities and must not be reinterpreted.
Existing live/manual and archived/manual record shapes and old duplicate behavior
remain unchanged. Automatic live records and pins have their own explicitly
versioned schema, validated alongside the existing manual authority.

### A. Smallest authority/provenance schema

Persist an additional World-owned `automaticProduction` branch:

```ts
type ProductionOrigin =
  | { kind: 'command'; commandId: string }
  | { kind: 'sect-plan'; cycle: number };

// Canonical decimal, positive safe integer, no leading zeroes.
type AutomaticJobId = `auto-job/${number}`;

interface AutomaticLiveJob {
  // All ordinary navigation/work/timing/site fields, but no commandId.
  transaction: Omit<ProductionTransaction, 'commandId'> & {
    transactionId: AutomaticJobId;
    origin: { kind: 'sect-plan'; cycle: number };
  };
  reservation: Reservation; // reserved, ownerTransactionId = transactionId
}

interface AutomaticTerminalPin {
  cycle: number;
  state: 'Committed' | 'Cancelled';
  workerId: string;
  recipeId: string;
  rootActionId: string;
  completedTick: number;
  // Null only for a temporary, pending-command-owned fact.
  resultEventId: string | null;
  retention: 'pending-command' | 'exact-receipt';
}

interface AutomaticProductionNotice {
  eventId: string;       // ordinary allocated event:N, used for display ordering
  tick: number;
  cycle: number;
  workerId: string;
  recipeId: string;
  kind: 'started' | 'blocked' | 'committed' | 'cancelled';
  reason: ProductionBlockedReason | null;
}

interface AutomaticProductionState {
  schemaVersion: 1;
  nextCycle: number;     // starts at 1; advances only on successful admission
  live: Record<AutomaticJobId, AutomaticLiveJob>; // at most 36, shared worker cap
  journal: AutomaticProductionNotice[];         // at most 64, append order
  pins: Record<AutomaticJobId, AutomaticTerminalPin>;
}
```

The union is exposed by the production-owner query/transition API. A manual
record's `{kind:'command',commandId}` is derived from its existing `commandId`;
there is no need to rewrite v6 manual archive tuples or add a redundant origin
field to old manual records. Only the new automatic live record persists the
`sect-plan` origin. Job `workerId` identifies the source plan and `recipeId` is the
admitted recipe snapshot. Do not store an unbounded plan-generation history or a
pretend originating `production.start` receipt.

Changing/disabling a plan does not cancel its already-admitted job. Consequently
validation must not require a live job to match the *current* edited priorities.
Admission checks the current plan; a saved live job proves ownership through its
source cycle, reservation, worker/seat and recipe invariants. The existing game
does not reconstruct the whole inventory from historical receipts, so an automatic
plan does not need a synthetic historic start command to validate resources.

Keep automatic reservations nested in the live record. This leaves the v6 manual
`World.reservations`/terminal archive contract intact. The inventory reserved-total
validator sums manual live reservations + automatic live reservations + cultivation
reservations. The shared at-most-36 `activeProductionTransactionIds` and
worker/station assignment strings may contain either canonical namespace; queries
resolve their owning branch without building a merged historical map.

`pins` is **not** counted as automatic-only history: entries are justified by an
actual external pending command or exact public receipt. Permanent pins may grow
with explicit player cancellations, just like manual command receipts. That growth
is disclosed and budgeted; it is never disguised as bounded infinite manual play.
Do not add counters, input lines, paths or full terminal snapshots to a pin unless
a public result actually requires them. The fields above validate identity and
the promised terminal result; resources are never settled from a pin.

### B. Private admission and public API boundaries

Add these World/economy-owner operations, with names finalized by the implementer:

- `lookupLiveProduction(world,id)` returns the live manual/automatic pair and
  normalized `ProductionOrigin`; only this may supply a commit-capable job
- `startAutomaticProduction(world,intent)` is an internal capability imported by
  the scheduler bridge, not by `kernel/index.ts`, the player dispatcher, WebMCP or
  application request types. It accepts only `{workerId,recipeId}`, never a cycle,
  ID, arbitrary origin, resource delta or caller-created receipt
- `finishAutomaticProduction(world,id,cause,receiptContext)` settles a verified
  live record only; `cause` is commit or cancel. It cannot resurrect a pin or
  retired handle. Production walking/work/delivery still uses the same rules
- `classifyAutomaticHandle(world,id)` returns live, pinned terminal, retired or
  unknown, without executing any work
- `recordAutomaticNotice` appends/truncates only the new 64-entry journal;
  `pinAutomaticTerminalForReceipt` promotes exactly the facts/events referenced by
  a new public receipt

Handle classification order:

1. Strictly parse `auto-job/N`; look in live and pins
2. If absent and `1 <= N < nextCycle`, it is retired
3. Otherwise it is unknown; malformed/unsafe/zero/leading-zero forms are unknown

The slash namespace is deliberately disjoint from all frozen v6 command targets:
v6's `validId` grammar excludes `/`. Extend only v7 `production.cancel` target
validation to accept canonical `auto-job/N`; public **command IDs** keep their
existing slash-free grammar. Do not use `auto-job:N`: a valid old queued cancel
could already contain that formerly unknown string and accidentally cancel a new
job after migration. Old pending commands remain byte-for-byte unchanged and can
never acquire authority over the new slash namespace. This is a compatibility
rule in addition to the ownership checks, not merely a naming convention.

The namespace alone grants no authority. A live automatic record must be stored
in the automatic branch, match its cycle and worker assignment, own its reserved
inputs, and have a cycle below `nextCycle`. The dispatcher never accepts a source
cycle from a player, so even a guessed old/future string cannot create work.
Every successful admission consumes exactly the next cycle, making all lower
absent cycles conclusively retired without storing a tombstone per job. Out-of-
order completion is safe: all still-unsettled exceptions remain in `live`.

Add `AUTO_JOB_RETIRED` as the public rejection for a *new* cancellation command
whose automatic target is retired. It is an explicit v7 handle-retention rule,
not `UNKNOWN_TRANSACTION` or re-execution. An internal duplicate finish returns a
no-effect retired outcome with no resource, sequence, receipt or event changes.
Unknown future handles remain `UNKNOWN_TRANSACTION`. A public duplicate command
ID is always looked up in the exact receipt ledger **before** classification,
due checks, budget checks or error pauses, preserving its original result.

### C. Exact per-tick transition ordering

Keep the current due-command order (`issuedTick`, `sequence`, stable command ID,
then fingerprint tie-break). For each management tick:

1. Apply expedition boundary checks and pause ownership
2. Remove/sort due external pending commands and dispatch them normally
3. Advance the clock; settle cultivation age/month/death and away ownership
4. Cancel jobs made unavailable by those authoritative transitions
5. Build the at-most-36 live-job planner context, including both manual and auto
   output promises; compute conservative automatic byte allowance
6. Call the existing `planAutomaticWork` once when due. Commit its
   `nextDecisionTick`; iterate its at-most-two intents in returned stable order
7. For each intent, recheck current plan/role/material/stock/capacity/seat/storage
   admission against the result of earlier starts. On success, allocate the next
   automatic cycle, one ordinary root-action ID and one reservation instance ID,
   reserve real inputs, claim the worker, and add the source-owned live pair
8. Tick ordinary production navigation/work/delivery; settle results atomically
9. Apply expedition post-tick behavior, then publish the complete boundary

Version the system order because scheduler insertion is new simulation behavior.
An automatic job may make its first movement step in its admission tick, just as
an accepted due manual start currently can; pin that exact choice in tests.
No extra work tick is awarded on station arrival or same-tick teleportation.

The planner already advances by 20 ticks and caps decisions to two intents. It
does not issue commands or receipts. Rechecking a rejected intent consumes no
cycle/IDs/RNG/resources and emits no permanent event. Return a current ephemeral
blocker for its worker and wait for the next saved decision boundary. Do not
dispatch `production.start`, enqueue automatic commands, generate new command IDs,
or retry per idle tick. If the second intent becomes unavailable, the first may
remain successfully admitted; the complete tick still rolls back as a whole on
an invariant exception under the existing kernel boundary.

### D. Settlement and retirement table

Before touching inventory, require a live pair, correct worker/seat/reservation,
and the same delivery/cancel conditions as manual production. A commit debits
inputs and credits outputs once; a cancel releases reserved inputs once. Resource
delta, station release, worker release, live-index removal and retirement/pinning
form one immutable transition. Never mark a source retired before the resource
and ownership transition is complete.

| Terminal case | Persistent result |
|---|---|
| Automatic commit, no external pending/public reference | Remove live pair, append bounded notice; no terminal archive, no public receipt |
| Automatic cancellation from simulation/role/death, no external reference | Same retirement, cancelled notice; no permanent event |
| Live automatic cancellation by public `production.cancel` | Exact cancelled terminal pin + ordinary permanent cancellation event + normal public command receipt |
| Automatic cancellation inside accepted training/death/expedition command, and cancellation facts appear in its result event IDs | Pin exactly those terminal facts and events under that command's receipt context |
| Automatic terminal with future queued external cancellation still referring to it | Temporary pending-command pin sufficient to answer that pending command; no fabricated start receipt |
| Later new cancellation of a cancelled temporary pin | Allocate its first durable cancellation-acknowledgment event, promote pin to exact-receipt, then return/store that accepted result |
| Later new cancellation of a committed temporary pin | Return/store `TRANSACTION_FINISHED`; no result event is required; drop temporary pin once no pending target remains |
| Repeat command ID after any of the above | Return the exact original stored result; do not touch live state, pins, scheduling or resources |

For a cancelled temporary pin, the new durable `production.cancelled` event records
the acknowledgment at the current tick and includes `settledTick` for the original
cancellation tick. Its root is the original allocated root-action ID and
`parentEventId` is null. The auto journal did not expose an API-returned domain
event, so this does not replace any promised event ID. After the first public
result, every exact retry uses that same durable event ID. Manual v1–v6 terminal
events retain their original behavior and identity without this new rule.

An exact-receipt pin is never removed while its receipt contract is perpetual.
Repeated fresh cancellation commands against a cancelled exact pin return its
same cancellation event; they do not add another pin or cancellation event.
Completing a cancelled pin is finished; a stale internal completion never credits
resources. A committed temporary pin is only a pending observation fact and has
no durable completion receipt. Once the queue no longer needs it, it may become
retired; the already-stored rejected command result remains exact forever.

Pass an explicit optional internal
`receiptContext: {commandId, exposeCancellationEvent:boolean}` through cancellation
paths; the existence of an outer public command alone is not a reason to pin.
Direct public `production.cancel` sets exposure true. Cultivation operations that
include their cancellation events in the returned event slice set it true.
Simulation ticks set it false. **Current expedition dispatch returns
`eventIds: []` (`world-adapter.ts:318–319`), so departure cancellation sets exposure
false and retires an unreferenced automatic job**, unless a pending cancellation
still needs a temporary pin. Do not invent a permanent cancellation receipt for
departure merely because departure itself is a player command. If an outer API
later returns an auto cancellation fact, it must explicitly opt into promotion.
Promotion plus command receipt insertion is atomic;
rejecting/throwing in the enclosing command discards all proposed promotions.
Do not pin unrelated auto notices merely because they occurred in the same tick.

A public cancellation of a **live** automatic job also moves the scheduler's
`nextDecisionTick` to at least `simulationTick + 20`, preventing immediate same-
boundary replacement. Do not repeat this delay for a duplicate command or a
terminal-pin query. The plan stays enabled: the UI explains that “cancel this job”
and “disable this work plan” are separate controls. Disabling/editing a plan leaves
its current job alone, as the existing planner contract specifies.

### E. Pending external commands are a reference boundary

Automatic intents are never placed in `pendingCommands`. The saved source cursor,
saved live pair and existing `nextDecisionTick` cover restore/retry without an
internal command queue. There is no invisible backlog of automatic jobs.

External future commands keep current ordering and due-time dispatch semantics;
being queued is not the same as an accepted command receipt. Before retiring an
auto job, check whether any still-pending `production.cancel` targets its canonical
ID. If so, retain the temporary terminal pin. A derived target Set can be cached
against the immutable pending-command array; do not scan the entire queue for
every moving worker tick. At terminal boundaries or queue changes a scan is safe
to arrange; performance measurement decides whether the cache is needed.

Do not change a queued command's ID, target, issued tick, sequence, or payload.
Do not prematurely create a success/rejection receipt. A queued target that is
unknown when actually dispatched is rejected normally. A new public command that
already has an exact receipt does not keep an unrelated pending pin alive: its
duplicate result is independent of future target state.

When a due cancellation is removed from the queue, keep its reference context
through that dispatch before cleaning temporary pins. This avoids dropping the
fact between “remove due commands” and “dispatch due cancellation.” After the due
batch, discard only temporary pins with no remaining pending or in-flight command
reference. Accepted cancellation promotion is permanent; rejected results need
only their ordinary exact receipt. Never garbage-collect a genuine manual record.

Due manual starts are still dispatched before new auto proposals. Existing busy-
worker semantics stay explicit: an already-running auto job is not silently
cancelled just because a future manual start becomes due. The player may cancel
the job/change the role first. Adding automatic preemption would be a separate
gameplay decision and is not hidden in this retention change.

### F. Bounded journal and blocked jobs

The automatic journal is a new v7 presentation record with at most 64 entries.
Its `event:N` display IDs are allocated from the normal sequence for stable
cross-channel ordering, but the journal records are **not** public `DomainEvent`
receipts. They are never valid receipt `eventIds` or event parents. Gaps below
`nextEvent` are already valid; dropping a v7 presentation notice does not permit
ID reuse. The journal is not copied into R1 history when it rolls over.

At most one notice is appended for a blocked-reason change, as current production
already does. Unchanged blocking produces no notice and no receipt. Even deliberate
alternation of blocked reasons is bounded by the 64-entry ring. Current live
`blockedReason` remains authoritative whether its notice has rolled out or not.
No full movement route or full transaction snapshot belongs in a notice.

When a cancellation is public/pinned, write its durable DomainEvent and use the
normal recent-event query instead of duplicating the same record in the auto
journal. Merge the last manual-domain events and automatic notices for display by
tick and allocated event sequence; the journal itself is append-ordered. A recent
notice carries enough recipe/worker/outcome information to render after the full
job retires. UI history lookup must not fabricate a terminal transaction to do so.
The UI must identify this as recent activity, not a complete historical ledger.

### G. Validation branches and migration

New automatic branch checks, in addition to all unchanged v6 manual checks:

1. Exact schema/field set; positive safe `nextCycle`; live union <=36; journal <=64
2. Each live key is exactly `auto-job/<origin.cycle>`; cycle unique and below the
   source cursor; no live/pin overlap. No external/public command field is present
3. Every live pair owns a `reserved` reservation with an ordinary unique
   `instance:N` ID; the reservation owner is its auto handle. Validate normalized
   recipe inputs, all navigation/work/phase bounds and bidirectional worker/seat
   assignment identically to manual production
4. Worker, recipe, root-action and reservation sequence ownership remain valid;
   live automatic reservation instance IDs join the existing cross-domain ID Set
5. A temporary pin has a real pending or currently-dispatching target owner,
   terminal state, completed tick <= world tick and no settlement resource path
6. An exact-receipt pin is Cancelled, has its matching durable event, and is demanded
   by an accepted public cancellation receipt or an accepted outer receipt's
   cancellation event reference. The event has the same auto handle, recipe,
   worker, root and `settledTick`; its parent is null
7. Rejected public receipts keep exact values without needing a permanent auto pin;
   accepted auto-cancel receipts require the pin/event. Fingerprint conflict checks
   remain exact and precede current-state lookup
8. Journal IDs are unique within the journal and do not collide with durable live/
   archived event IDs; kinds/payloads are bounded and refer to a cycle below the
   source cursor. A notice may legitimately refer to an already-retired job
9. No old manual origin is relabeled automatic. The manual ledger may never claim
   an `auto-job/N` as an `instance:N`, and the archive codec is not loosened

V6→v7 creates `{schemaVersion:1,nextCycle:1,live:{},journal:[],pins:{}}` without
changing manual live jobs, archives, resources, pending commands or sequences.
Preserve work-plan settings, but migrate the global work-plan `enabled` flag to
false with a visible “review and enable automatic work after upgrade” notice:
v5/v6 settings existed behind a hard-zero allowance and did not execute. Do not
silently begin producing during load. A fresh user `enabled.set(true)` can then
activate the feature; replaying an old recorded settings command only returns its
old result, as before. Existing future settings commands remain queued and keep
their explicit due-time behavior. Original v6 source bytes remain untouched.

### H. Saved-byte headroom, including unfinished work

R2 must not exchange unbounded history for a route/pin growth failure. Use the
actual compact World encoding's UTF-8 byte counter. Cache immutable archive/page
sizes, so a due 20-tick decision does not canonicalize the whole historical world.
Do not trust a saved byte-count field; recompute/cache it from validated content
on load. Nonfrozen mutable caller objects must not enter identity-based caches.

The budget must also reserve **archive expansion and row ceilings**, which can
bind before the compact file reaches 4 MiB. Read the authenticated archive's
existing index counters through the parent-coordinated `getHistoryArchiveUsage`
seam, without re-decoding every row. `expandedCharacters` is canonical decoded-
record UTF-16 JSON characters, capped at 64 MiB; `expandedNodes` is charged traversal
nodes **plus 32 safety units per record**, capped at 4,000,000. Each table also has
a 100,000-row cap. These are separate from UTF-8 file bytes. Reserve pending
manual terminal/event/receipt additions in all relevant units; never alter those
limits merely to make an admission appear to fit.

Conservative initial budget terms:

- `F = 4,194,304` bytes, the existing file limit
- `B = current encoded World/envelope byte count`, with worst legal save metadata
- `S = 1,048,576` bytes reserved for nonautomatic decisions/settlement/diagnostics;
  this is safety headroom, not proof of all other domain growth
- `J = max(0, full 64-notice budget − current journal bytes)`
- For every currently live auto job, reserve its maximum remaining route/state
  expansion **and** one minimal public-cancellation pin/event budget
- Reserve the bounded effects of already-pending external commands separately;
  if a command kind has no justified upper bound, automatic allowance is zero

The admission calculation may deliberately double-count a live job's current
bytes for simplicity: `free = F − B − S − J − sum(liveFutureBudgets) − pendingBudget`.
Each proposed start consumes its full future job/pin budget in that calculation;
shared allowance is `min(2, available worker slots, starts whose full budgets fit)`.
Do not give the second intent the first intent's headroom again.

A safe route upper bound depends on the validated map. For N = width×height,
maximum coordinate digit widths dx/dy, an N-cell canonical JSON path is bounded by
`1 + N × (12 + dx + dy)` ASCII bytes, plus the bounded navigation wrapper. On the
starter 14×10 map this is about 2,101 path bytes; on a 256×256 import it is about
1,179,649 bytes **per path**. Therefore a universal “4 KiB per live job” assumption
is unsafe. Use a conservative fixed-field budget plus this map-derived bound, or
a separately versioned bounded-route representation. Large imported maps may
legitimately receive allowance zero; never truncate their live paths silently.

Implementation targets to verify with maximum-length typed fixtures before use:
4 KiB fixed auto-live metadata/reservation allowance, plus the path bound; 2 KiB
minimal terminal pin + one durable production-cancel event; 2 KiB for one direct
production-cancel receipt; 1 KiB per recent notice. These are deliberately loose
candidate bounds for the finite ASCII-ID/current-recipe schema, **not measured
proofs**. Compute their actual maxima from validators (including JSON escaping,
safe-integer digit length and resource lines) and assert them. Outer cultivation/
expedition command receipts are covered by their own command-kind budget, not the
small direct-cancel receipt allowance.

For the starter map, a candidate job reserve is roughly 4,096 + 2,101 + 2,048 +
2,048 = 10,293 bytes before small wrapper overhead; 36 such reserves are about
370,548 bytes (about 362 KiB). A full conservative 64 KiB journal plus the 1 MiB general margin makes
the order of headroom required explicit. This is an estimate for implementation
planning, not an acceptance measurement, and does not assume 36 jobs actually fit
available seats/materials. The exact formula, not this rounded estimate, controls
admission.

Re-evaluate before accepting any new external operation that can consume reserved
headroom. An over-budget new command gets a typed transient **pre-admission**
capacity rejection without allocating a receipt/ID or adding a diagnostic each
retry, analogous to the existing error-paused nonrecording exit. Existing receipts
are still returned first. Already-live cancellations and safe terminal release
have their reserved budget and must remain possible; do not lock the player into
a job because storage is nearly full. New pending-command batches need an atomic
budget check before enqueue; a preexisting imported queue that cannot be bounded
disables new automatic starts and reports the limitation instead of rewriting it.

After every accepted growing transition, verify that the complete candidate and
remaining reserved obligations fit before publishing. Failure rolls back to the
previous exportable boundary with one bounded visible storage-capacity pause.
Keep pause/rejection text out of an unbounded error-history loop. This is the
necessary guard against unrelated manual growth; a zero new-start allowance by
itself does not guarantee whole-World saveability.

### I. R2 implementation slices and acceptance

1. Add v7 auto authority/handle queries and frozen v6 migration, keeping default
   disabled. Extract common live production mechanics with owner-specific writes;
   do not route cycles through public start or relabel manual archive records
2. Add atomic automatic settlement/retirement, bounded journal, pending-reference
   pins and public cancellation propagation. Keep allowance zero until this passes
3. Add verified headroom accounting/admission and then hook the existing planner;
   expose current blockers, plan enable/disable and cancellation behavior in UI

Regression requirements, run by the integration owner:

- At least 10,000 real start→walk→work→deliver reducer cycles in a declared test
  scenario; compare continuous execution with many save/reload boundaries. Use
  actual implemented resource sinks where possible. A deterministic test-only
  sink or lifespan-adjusted fixture must be labeled a controlled stress scenario,
  not an ordinary played campaign. No new hunger/consumption mechanic is silently
  added just to sustain the benchmark
- With no new player commands, permanent manual receipt/event/production archive
  counts stay constant, live counts <=36, journal <=64, pins zero, and save bytes
  stabilize except bounded numeric digit growth/current path state
- Internal duplicate commit/cancel for live, pinned and retired handles never
  grants/releases twice; forged future/unsafe/namespace-conflicting handles do not
  advance cursor, consume IDs or create work
- Out-of-order job completion, capacity/path blocks, indefinitely alternating
  blocked reasons, missing materials and absent stations cause no receipt churn
- Due manual commands before planner; first/second intent resource contention;
  restored decision deadline; pause/combat/hidden behavior and no offline catch-up
- Role, teaching, seclusion, death and expedition cancellations release once;
  external command contexts pin only returned auto-cancellation facts/events
- Queued cancel settles after the job commits, after simulation cancels it, after
  the journal wraps and after reload. Its exact eventual receipt survives later
  cleanup; due-batch reference removal cannot race pin cleanup
- Manual cancel during live auto work produces one durable pin/event and exact
  retries; no same-boundary replacement, plan-disable remains a separate action
- Max-length IDs/recipes/resource lines, route bounds, metadata escaping, large
  maps, full journal, 36 pending settlements, many queued commands and near-cap
  pinned cancellations preserve an exportable prior boundary and saved source bytes
- Integrated whole-World bytes, tick p50/p95/p99, save/restore time and browser
  responsiveness pass the declared reference-device budget. Codec-only R1 size
  results are insufficient

### Separate finite follow-on: 1,024 build-history entries

R2 does not fix the build history's 1,024-command ceiling. Expedition lock/unlock
uses the same ledger, so repeated travel eventually exhausts it even if automatic
history is bounded. Keep this as a separate versioned checkpoint/semantic-replay
design preserving awards, equipment, removed source IDs, lock ownership and exact
public receipts. Do not raise/delete the limit or switch to checksum-only trust
inside the automatic-work change. Cultivation and player-issued perpetual receipt
growth remain separately disclosed finite-history work too.

### 2026-10-01 11:13 UTC validation checkpoint

Frozen v6 candidate (source SHA-256 186e3fb277f76809edc138ce2efe02103d88858f273a67b66a06b8a5e1cfe8ab) passed 801 tests; after replacing two readonly negative-test mutations with equivalent immutable replacements, both TypeScript targets and production build passed. Vitest concurrency is bounded to two workers; assertions and timeout values unchanged.

The latest serial v5/v6 comparison preserved exact semantic projection, original source bytes, original receipt results and terminal retries. At 10,000 synthetic historical jobs v6 measured 1,935,973 bytes versus v5 13,383,156 bytes. The oversized v5 example was rejected by the public file parser and migrated only in-memory for stress comparison, never silently admitted as a file. V6 ordinary ticks preserve immutable archive identity. Median full tick was 0.00584ms; median file parse was 1,058ms, with 785–3,286ms samples. Therefore the proposed sub-second load target is still NOT accepted. The comparison intentionally reports timing rather than asserting noisy wall-clock thresholds. This does not establish browser performance or unlimited campaign retention.
