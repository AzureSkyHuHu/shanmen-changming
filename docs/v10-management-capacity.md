# Fixed whole-v10 management capacity query

Status: implementation and targeted tests written on 2026-10-02. The integration owner must run type checking, targeted tests and the full release checks. This document does not claim those checks passed, a v10 save was admitted, or a player-facing feature was published.

## Internal APIs and authority boundary

- `assessManagementCapacityV10(actualWorld)` returns a fresh `ManagementCapacityV10` diagnostic. It accepts only the actual complete v10 World. There are no caller-supplied byte counts, budgets, policies, content contexts, validator callbacks or reusable admission certificates.
- `deriveV10RecordReservations(actualWorld)` derives pinned build facts, build obligations, phase-aware progression, RNG headroom, combined sect obligations and clock rows. It is an internal structural leaf shared with the narrow check, not a root validator.
- `inspectV10KnownRecordHeadroom(actualWorld)` checks known finite archive, cultivation, clock, ID and cancellation obligations. It deliberately does not import the full record root, avoiding validation recursion. An empty result is not whole-envelope/reader fit or a continuation certificate.

The whole query checks exact v10 identity, isolates ordinary data descriptors into an owned source, and invokes `inspectUnregisteredWorldV10Records` on the complete source. It never disguises the World as v9, strips the sixth domain, filters the paired ledger, trusts the caller's frozen flag, mutates/freezes caller data, or examines a caught caller-thrown error object. Proxy reflection can execute traps; capture is not a universal hostile-Proxy detector or an atomic snapshot across arbitrary traps.

The initial safe descriptor measurement preserves a useful over-wire-cap diagnosis if the bounded capture refuses the source. After capture, all sizing and validation reads use the owned copy. Shape-correct but invalid synthetic pressure sources can retain dimensions for diagnosis; source-record issues always prevent `supported` and `fits`.

`actualFits` means only that the current complete envelope fits 4,194,304 bytes. `supported` means the records are valid and the enumerated finite structural bounds were derived. `fits` additionally checks every enumerated current-plus-reserved limit. None proves a reachable recovery or teaching route. `admitted`, `importAuthorized`, `eventualCompletionSupported`, `fullyFundedContinuation` and `terminalDischargeProved` remain false. Missing runtime/discharge/continuation proofs are explicit exclusions, never converted into a supported-continuation flag.

## Whole-envelope equation

The current cost is the canonical UTF-8 size of the actual eight-field envelope, with saveVersion 10, simulationVersion 0.10.0, the exact new content identity, schema-2 sect records, and all upgrade/L2 histories. Metadata is the existing worst legal escaped buildId/savedAt and an eight-character checksum.

The single wire equation is:

```
whole actual v10 envelope
+ automatic/manual/pending production, bounded journal and general reserve
+ phase-aware progression structural totals
+ combined existing-five-owner plus upgrade sect totals
+ finite phase-aware clock row totals
```

Each line is charged once. Build rows/bytes are progression subtotals. Each sect leaf's shared-width subtotal is already included in its totals and is never added to wire bytes again. Current completed/cancelled records, L2 proof/rate fields, claims, receipts and clock rows remain in the current envelope. They are not reclaimable credit.

Live upgrade branches retain the underlying upgrade leaf's independently derived maxima for live work, completion and cancellation, including paired ledger and actual worker fields. Whole mutually exclusive branch maxima are used; completion and cancellation are not added together. A live upgrade reserves one cancellation receipt and revision, zero new job/claim/building/ID/navigation allocation, and the finite 401-visit/400-span/two-checkpoint representation. These record counts do not create a 400-tick waiting horizon.

Maintenance renewals are optional growth. The new rate fields and paid claims enter the real normal candidate and its fresh current measurement. No perpetual renewal reserve or unlimited maintenance promise is invented.

## Independent dimensions

The query reports current, reserved, costs, limits and deficits for:

- Archive production/receipt/event rows and decoded characters/nodes, combining legacy production terminal requirements with progression without adding sect-local receipts to the World archive
- Pinned build command limit; every existing build array's real 16,384-member descriptor limit, including origin/history children; future history, receipt, retirement and award insertions; the actual build snapshot's 4,000,000 UTF-16 characters and 300,000 value-node reader limits
- Cultivation's existing 100,000-row collections, 36 active profiles and the actual cultivation snapshot's 4,000,000-character reader limit; unique future sect relic destinations are charged once per actual relic
- Legacy archived-identity and estate destinations coupled to the real active-plus-archived identity set, with separate build-retirement/cultivation archive limits. There is no fabricated independent legacy 100,000-row allowance
- All existing local construction, production, research, care, maintenance and paired-ledger row limits; upgrade's 128 jobs, 256 receipts, live cancellation revision reserve, current nextId and the shared 36-worker ceiling
- Existing finite work-span/visit limits and navigation cells, plus upgrade's 401 visits, 400 spans and two checkpoints
- Cultivation clock's 8,192 rows and its schema-implied structural node envelope
- Shared action/entity/event/instance allocations; build/cultivation/sect revisions, next IDs, navigation version, calendar/simulation ticks, months, each current RNG draw/state and the proved breakthrough rejection-draw reserve
- Safe birthday-duration subtraction itself, including negative birth ticks, rather than assuming two safe operands have a safe difference

Counter fit uses `current <= limit - reserved`. If a diagnostic cost exceeds the safe range its `cost` is Infinity, never a rounded supposedly funded integer; the deficit is computed by subtraction, preserving an exact one-short counter diagnosis. Such a boundary cannot pass `fits`.

## Only readers actually invoked by v10

Construction's real descriptor reader sees the projected construction frame, including its complete shared paired book and projected people. Its future node delta is the per-owner branch maximum of construction records, paired-ledger records and worker projection growth. Upgrade job/receipt arrays are not charged to this subset reader simply because they exist elsewhere in the World.

The fixed six-domain reader sees the entire actual `SectUpgradeFrameV10`, containing construction, production, research, maintenance, care and upgrade. Its current nodes and combined finite sect node growth are checked against the acyclic `descriptor-bounds-v10` constant. The old schema-1 production/research/maintenance aggregate readers are not invoked by the new root and are not synthesized as fake v10 gates.

The build and cultivation readers receive conservative progression-domain unions; these are independent reader checks, not second charges to wire bytes. Shared sect scalar growth already includes inventory width, so inventory is not charged a second time to the cultivation reader.

## Finite time and remaining proofs

The existing phase-aware progression derivation sums already-funded remaining months and subtracts the current month phase once. Clock arithmetic counts the actual future month and off-month birthday groups within that finite horizon. Progression already owns month actions; only additional birthday groups add actions/cultivation revisions. The same finite horizon remains reserved in the old construction/production/research revision counters.

Natural death trigger records are separately reserved without pretending that every arbitrary month leading to death is funded. Upgrade work ticks are evidence bounds, not a wall-time guarantee. Path blocking, maintenance blocking, arbitrary waiting, optional starts and perpetual growth remain outside this query's proof.

The next runtime layer still needs authenticated exact terminal/paired-ledger/receipt discharge, executable cancellation/recovery routes including upgrade workers, finite teaching eligibility/continuation, atomic complete-candidate publication, stopped-state behavior and codec/migration admission. Deleting an owner, rewriting its phase or fabricating a cancel log cannot be treated as discharge by this API.

## Test intent and execution

`tests/sect-expansion/v10-management-capacity.test.ts` covers exact worst-metadata envelope accounting, reserve equation, fresh diagnostics/nonmutation/frozen input, identity/getter/alias/thrown-object rejection, wire equality/one-over, build array/node and ID pressure, phase-aware teaching arithmetic, and genuine research/start/work/complete/cancel upgrade histories. The L2 case advances actual candidates to the next real rate-2 maintenance payment and checks immutable L1 construction provenance.

Synthetic malformed sizing-pressure cases are labelled as such; passing a diagnostic assertion does not make them root-valid saves. Genuine fixtures use strict fresh/earned old history as explicit record-test input and the new complete-record candidate APIs for new research/upgrades/maintenance. They are not a migration, codec, runtime admission or public gameplay claim.

No tests, builds, Git operations, browser actions or other workers were run by the file owner. Actual integration results should be appended by the integration owner after execution.

## Integration evidence — 2026-10-02 20:30 UTC

The isolated final structural capacity and shared-leaf snapshot passed both TypeScript configurations and 3 files / 27 tests in 107.40s. Independent read-only review found no material defect. The genuine start/completion/cancel/L2 checkpoints were then strengthened to require fits=true, and the synthetic one-short counter asserts excess exactly 1; all 12 final capacity tests passed in 102.60s. Boundaries and default production build passed with the subsequently added, not-yet-tested continuation/discharge sources present. This is targeted evidence, not full regression, save admission, browser v10 or complete game acceptance.
