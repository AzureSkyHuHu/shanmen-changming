# Relocation owner integration plan

Design-only, 2026-10-03. Reviewed source baseline supplied by root: `57729ac`.
No implementation, test execution, build, Git operation, storage change or public
activation accompanies this plan. Detached relocation's 60 focused / 198 related
tests are prior domain evidence, not evidence for this proposed owner.

## Recommendation and first deliverable

Create an **internal relocation owner**, under
`src/core/world/relocation-owner/`, without selecting/registering a public v11
save, content registry, command dispatcher, Session, UI or route. It is a new
complete owner contract, not a v10 World carrying optional relocation fields.
Existing v9/v10 protocol identities, validators, saves and immutable construction
records remain frozen in meaning. Reuse their data contracts and genuine
version-neutral leaves; never disguise the new root as an old root.

The first independently reviewable implementation is only:

- `src/core/world/relocation-owner/types.ts`: explicit owner draft, persisted
  domain books, transient frame, phase and work-owner/claim contracts
- `src/core/world/relocation-owner/projection.ts`: pure explicit projection and
  recomposition, one map/clock/inventory/people authority, no mutation or admission
- `tests/world/relocation-owner-projection.test.ts`: projection round trips,
  field presence/history preservation, active-owner union and non-aliasing tests

No shared source edits are necessary for that first slice. A typed projection
is not runtime admission; do not export a constructor that takes unknown data and
claims it is a validated owner. No codec or whole-World executable command should
be added until subsequent gates pass. Root owns execution and shared edits.

## Source findings that determine the seam

1. `construction-record-validation.ts` adds every non-cancelled blueprint,
   **including completed blueprints**, to one permanent occupied-claims set.
   `validateSectRelocationRecords` invokes that validator unchanged. Therefore a
   building on a vacated original footprint currently fails before an effective
   relocation map can help. Do not mark original blueprints cancelled, rewrite
   anchors, remove historical buildings or suppress the failing issue.
2. `production-runtime-v10.ts:sectProductionSitesAtStartV10` uses historical level
   but original construction position. `research-validation.ts:sectResearchSites`,
   `research-consumer-gates-v10.ts` and `upgrade-validation.ts` also derive original
   entrances. Changing just live navigation breaks historical proofs or leaves new
   work walking to the old door. Each needs a new-owner historical-position join.
3. `tickSectRelocation` advances construction's clocks itself and treats equal
   clocks as an idempotent no-work call. `v10-sect-bridge.ts` already advances those
   clocks in construction. Appending the detached tick after construction silently
   skips relocation; advancing another tick silently doubles time.
4. Detached relocation requires its worker in current `construction.people` and
   only player-style start/cancel receipts. It cannot authenticate an archived
   worker or a death/away cancellation. A valid terminal cannot be preserved by
   manufacturing a current actor for an archived identity.
5. `v10WorkOwners`, `sectUpgradeAllLocalClaimsV10`, legacy site filtering, automatic
   starts, cultivation eligibility and compose logic know no relocation owner.
   Passing legacy-only claims to relocation, or relocation claims only one way,
   is insufficient. Production can release its seat while still delivering; v10
   deliberately proves whole-lifetime upgrade exclusion, not seat exclusion alone.
6. Detached relocation resets construction/relocation paths at completion only.
   Other navigation must observe the one new map navVersion; no other domain may
   continue a stale cached route after the atomic placement swap.

## Contract: one owner, two spatial meanings

### Immutable versus derived data

The owner retains all original construction buildings, blueprints, receipts,
source job IDs, completion ticks and first-maintenance ticks exactly. Original
level remains 1. Upgrade, research, maintenance, production and care books retain
their own history and identity. Relocation owns only ordered placement changes,
its paired reservation, work evidence, terminal and live navigation. Persist the
live relocation book once, alongside its record book; do not persist a duplicate
ConstructionFrame, effective map, current anchor cache, inventory, people or clock.

Use distinct transient results for:

- Original construction provenance (immutable geometry and source job)
- Placement at a historical `(tick, phase)` and its relocation predecessor
- Current physical spaces and navigable map
- Soft target reservations (geometry + entrance), separate from physical blockers
- Effective level at a historical phase, maintenance validity and availability

A spatial result does not certify research, lifecycle, ownership or whole-save
capacity. Module-private exact-source evidence may avoid repeated validation only
inside an owner that actually captures/authenticates that source; no supplied
callbacks, boolean flags, cast roots, field-stripped frames or external proof
objects establish that authority.

### Historical geometry and vacated ground

Split construction accounting/identity/history validation from its frozen
permanent-occupancy policy. Existing wrappers must still execute their original
policy in their established error order. The new fixed owner wrapper authenticates
unchanged construction records plus relocation chronology, then validates:

- Blueprint claims during their actual reserved intervals
- Construction physical occupancy during its active interval
- Each completed building at the placement effective at each relevant boundary
- Active relocation target soft claims separately; these block new placements,
  not ordinary walking
- Final current layout/connectivity using effective placement, never all origins

The historical join must reject a later blueprint that used ground before it was
vacated, even if today's layout is valid. New construction after the relocation
commit may legitimately overlap an earlier completed blueprint's original cells.
Cancelled relocations never vacate anything. Repeated moves, return-to-origin,
partial overlap with the mover's own old footprint and simultaneous other movers
need explicit cases. Base terrain is unchanged in this bounded owner; do not
claim arbitrary historical terrain/path replay from distance-only evidence.

Production/research/upgrade site proofs are checked against placement at their
actual start tick/phase, with all work/visit intervals joined to placement and
availability. Old completed work continues to prove its old entrance. Fresh work
uses the effective entrance. Research consumer gates prove original construction
and historical research/upgrade availability without equating current entrance
with construction origin. Keep building ID, sourceJobId and existing proof fields;
add new-owner-only evidence only if needed to disambiguate chronology. Never edit
old proof values to match a current location.

### Exact ordering

Proposed fixed normal tick order preserves existing relative order:

`clock -> cultivation/lifecycle release -> legacy automatic starts -> construction
-> maintenance -> upgrade -> relocation -> sect production -> research -> care
-> legacy production`

This is a design decision to freeze and test before reducers are connected.
Relocation's position query is before/after its commit phase. Maintenance remains
before upgrades and relocation; its due time and paid period are unchanged by
moving. A same-tick upgrade completion cannot retroactively change that tick's
maintenance rate. Relocation does not grant a free period or change level.
Inventory-only maintenance may renew a moving building; work availability remains
false until relocation ends, regardless of paid status.

External commands operate on a fully completed tick boundary. Same-tick command
ordering must be established by actual command/reducer evidence, never unrelated
domain revision comparisons. Construction completes before relocation; new
blueprint commands after the completed tick may reuse newly vacated ground.
Unprovable same-tick history combinations reject rather than inventing an order.
The first projection slice does not claim to solve this record proof.

Extract a fixed relocation **already-clocked work stage** from the detached clock
wrapper. The detached API keeps its present clock/idempotency behavior. The new
owner calls work once after its single clock advance; lifecycle-paused ticks run
no work. No new saved last-relocation-tick is needed. Fixed producer sequencing
and complete transition replay establish that work was not executed twice.

## Cross-domain ownership and lifecycle

Build a total owner union from real books: legacy production, construction, sect
production, research, care patient, upgrade and relocation, plus cultivation,
teaching and away/build locks as eligibility exclusions. Derive per-domain other
claims from that same union; count jobs, not number of claim tokens. Care claims
must not disappear merely because care has a patient instead of a worker.

Every command, automatic planner, site selection and tick consumes the union in
both directions. Relocation claims worker + building seat + old/new entrance;
soft target geometry additionally blocks blueprint placement and other targets.
Keep whole-lifetime productive-building exclusion through production's delivery
phase, as existing v10 upgrade validation does, unless a separately proved
relaxation is intentionally designed. Active upgrade/research/production and
relocation must not overlap on one building. Transfer worker continuity both ways
across all domains, not only construction and relocation.

Create one WorkPathBudget per tick and thread the exact same object through all
stages, including legacy production. No default/fresh domain budget at integration
call sites. Completion swaps geometry and commits the remaining wood atomically,
increments navVersion exactly once per successful move, and invalidates/replans
all affected domain navigation against it. Reserve combined construction and
relocation completion increments. Other movers in the same tick see the preceding
committed geometry in a fixed order.

Introduce a new owner-bound lifecycle preparation and cancellation record path.
Death cancellation must consume actual source/candidate cultivation evidence
before work and before actor retirement; a player cancellation cannot claim death
provenance. Historical terminal records resolve archived identities through this
owner's lifecycle factory only. Preserve a real terminal position; never teleport
or refund the spent half payment. Pending lifespan death, breakthrough death,
settlement and archive all need tests at 99/100/199/200 effective ticks and blocked
completion. An actor becoming away/unavailable must have an authenticated cause;
a generic supplied away boolean does not authorize cancellation.

Keep departures/active away protocols closed in this bounded management owner,
as v10 already does. Do not invent expedition support. If an away transition is
later admitted, it needs explicit same-source cancellation preparation and future
budget before the transition; worker eligibility alone is not that proof.

## Minimum shared extraction, in dependency order

Only root changes these existing files after independent review:

1. `sect-expansion/construction-record-validation.ts`: extract common structural,
   provenance, ledger and work checks from geometry-claim policy. Prefer fixed
   named version wrappers calling a shared internal implementation, not a public
   caller-selected relaxed mode. Preserve all old validation outcomes/order.
2. `sect-expansion/relocation-validation.ts` and `relocation-runtime.ts`: share
   accounting/work mechanics with a new fixed owner validator/work stage; local
   wrapper remains strict and standalone. New owner lifecycle/archived identity
   and temporal occupancy are not injected as unauthenticated exemption inputs.
3. `sect-expansion/production-runtime-v10.ts`, `research-validation.ts`,
   `research-consumer-gates-v10.ts`, `upgrade-validation.ts`: isolate position-
   independent proof/ledger mechanics where worthwhile; keep frozen v10 entrance
   policy wrappers. New owner supplies fixed historical-placement implementations
   in its own files. Do not broaden the old root's accepted record shapes.
4. `sect-expansion/history-identity.ts`: add an owner-specific factory only after
   its lifecycle inspector exists, following exact-source-bound evidence and
   archived-terminal-only resolution. Existing factories keep their behavior.

Reuse ledger, footprint, navigation and version-neutral production phase engines
without modifications unless a concrete test demonstrates necessity. Do not
parameterize every old World validator or clone all v10 files speculatively.
Version-specific capacity, transition, lifecycle and codec roots require new fixed
composition; calling the v10 whole-root proof on a projected/stripped new root is
never an extraction.

## Staged implementation gates and files

All paths below are proposed, not implemented. Prefix `O` means
`src/core/world/relocation-owner/`; prefix `T` means
`tests/world/relocation-owner-`.

1. **Projection contract**, first slice above: `O/types.ts`, `O/projection.ts`,
   `T/projection.test.ts`. Inverse composition preserves all unrelated fields,
   original geometry, optional field presence, order, clocks, IDs and RNG;
   original caller remains unchanged. Distinguish claim/job counts and actor
   travel projection. No admission token, codec, runtime start or public exports.
2. **Record/space owner**: `O/capture.ts`, `O/spatial-records.ts`,
   `O/records.ts`, `O/history-sites.ts`, `T/records.test.ts`, `T/spatial.test.ts`,
   `T/history-sites.test.ts`, plus extraction 1. Descriptor capture first; exact
   complete new-root schema/content binding; old histories accepted unchanged;
   forged relocation chains and temporally impossible overlaps reject. Freeze
   internal identity only here, still unregistered publicly.
3. **Cross-domain/lifecycle candidates**: `O/claims.ts`, `O/stages.ts`,
   `O/commands.ts`, `O/lifecycle.ts`, `T/claims.test.ts`, `T/stages.test.ts`,
   `T/lifecycle.test.ts`, extractions 2–4. Full source and candidate inspection;
   exact normal/no-optional-growth order; shared budget; cancellation before
   retirement; no public publication API. Block admission of unsupported active
   boundaries rather than advertise a partial owner as full-game ready.
4. **Capacity and executable transitions**: `O/obligations.ts`, `O/capacity.ts`,
   `O/discharges.ts`, `O/runtime.ts`, `T/capacity.test.ts`,
   `T/discharges.test.ts`, `T/runtime.test.ts`. Recompute source/candidate bounds
   from actual full roots; verify same-source command/tick replay, not just valid
   before/after records. Recovery requires real terminal discharge and no increase
   in any deficient dimension. Runtime owns capture/freeze, stop, replacement,
   invalidation and close; defer fast paths until strict baseline is proven.
5. **Codec and explicit quiet copy**, separately scoped only after gates 1–4:
   `O/save-admission.ts`, `O/codec.ts`, `O/quiet-copy.ts`,
   `T/codec.test.ts`, `T/quiet-copy.test.ts`. These remain internal. Storage,
   Session, UI, registration and public activation are a later separate gate.

## Capacity/restore acceptance contract

Measure the complete actual envelope in UTF-8, including all current books, once.
Bound archive rows/decoded characters/nodes, every descriptor/array reader limit,
paired ledgers/reservations, receipts/events, live paths, clocks, sequence and
revision widths, visits/spans/checkpoints, navVersion and identity counters.
Relocation adds maximum remaining evidence for its real phase: 201 visits,
200 spans, two checkpoints, terminal and cancellation/system receipt where
applicable. Derive actual branch maxima; do not sum mutually exclusive completion
and cancellation branches or double-charge already measured records/shared widths.
Death/estate/archive obligations coexist and must be covered too.

An admitted start reserves finite completion/cancellation record peaks and an
immediate cancellation route. Waiting may be indefinite; it does not prove
natural eventual completion or permit unbounded clock growth. Each next tick
must remain admissible or safe-stop without losing its funded cancellation.
At terminal, the exact candidate proves consumed/released lines, unchanged source
history, owner disappearance, retained terminal evidence and map increment.
Rejection/retry/conflict consume no ID, RNG, stock, publication or history; failed
candidate discards all stage effects. Fresh budgets for re-preparation come from
the unchanged source, never a partly spent failed candidate.

Restore tests cover each travel/work/payment/wait/cancel/death boundary, fragmented
work spans, archived workers, multibyte names, near-limit widths, archive blocks,
malformed descriptors/aliases/getters, future versions and legal unknown-field
policy. Exact round trips plus continuation/replay equality are required; isolated
record validation cannot substitute.

## Quiet-boundary copy and old-save protection

Initial source should be one explicitly supported v10 protocol, parsed first by
its unchanged complete codec. Retain the exact input text (whitespace/key order
included) separately from the candidate. Require quiet management: no live domain
job including upgrade, no planned blueprint, pending command, automatic work,
active cultivation/teaching/death/estate, travel, away/build locks or live station
claims. Preserve terminal/archive histories, pauses, speed, training/rest settings,
expired maintenance and every ID/RNG value. No tick, payment, cancellation or
history repair is performed to make the source quiet.

The new root receives only its explicitly new identity/schema and empty relocation
records/live book; all inherited historical identities remain their genuine
original identities. Target record/capacity/codec admission is independent. Reject
unsupported journals/history; never erase them. v9 users retain their existing
explicit v9-to-v10 copy path; no silent chain or widening of either old parser.
A later controller must separately own read-only/source-session fencing, backup
and readback, empty target/lease, durable pointer commit and unknown-version
protection. A checksum alone is not a backup, and pure preparation is not storage
write authorization.

## Highest-risk acceptance matrix

- Move -> retain old production/research proofs -> start new work at new door ->
  construct on vacated footprint -> move again; all original records unchanged
- Forged earlier blueprint on not-yet-vacated ground rejects; cancelled move leaves
  old footprint occupied; occupied target waits at 200 without extra work/payment
- Construction/upgrade/relocation completion and maintenance due in one tick:
  fixed order, old maintenance rate, correct post-phase position/level and summed
  nav increments; a paused lifecycle tick does none of that work
- Cross-domain worker/seat/entrance conflicts in both command orders; released-seat
  production delivery still blocks relocation of its productive building
- Last path-budget unit shared across domains; stale route after move replans;
  no duplicate work from equal-clock detached API or repeated stage invocation
- Death before/after checkpoint, cancellation during wait, real archive then load:
  exactly one release, retained spent wood, no actor resurrection or fake authority
- UTF-8/reader/archive/receipt/nav/counter pressure: start rejection is unchanged,
  funded cancellation still succeeds, unrelated edits cannot claim release credit
- Frozen v9/v10 fixtures and command rejection/error ordering remain unchanged;
  no public route, accepted command union, storage namespace or identity activation

Environment note: the AGENTS-mentioned `.local-tools/game-studio/skills` directory
was absent in this checkout. Source and design documents were inspected read-only;
no tests/builds were run by this worker.

## First projection slice executed — 2026-10-03 10:27 UTC

The explicit internal draft, domain books and detached projection/recomposition
are now implemented in the three first-slice files listed above. The derived
work-owner union covers seven domains, including care patients and production's
whole delivery-lifetime exclusion. It is diagnostic data, never a replacement
for saved actor assignment/travel flags or a complete owner admission result.

Source review found and repaired two defects before execution: legitimate legacy
storage deliveries now retain separate shared claims without false conflicts;
orphan actor assignment and building station references are independently
reported even when no live job/index row exists. Shared/exclusive and genuine
same-actor conflicts still report issues; unexplained references do not invent
live owners or inflate active job counts. Original authority fields round-trip.

Root serial validation: both TypeScript configurations passed; 12 focused tests
passed in 2.01 s; four projection/relocation files passed 91 tests in 26.20 s;
boundaries, 1206 Chinese locale keys, content checks and default build (871 ms)
passed. The author's earlier count of 13 was corrected to the actual 12 tests.
No World codec, save identity, command dispatcher, lifecycle cancellation,
relocation UI or public v10 activation is supplied by this slice.

Next is the narrowly split construction/relocation record-validation boundary:
retain old wrappers and their exact first-error order, then distinguish original
provenance from historical/current placement. Cross-domain cancellation/reuse in
the same tick cannot be ordered using unrelated domain revisions. True vacated-
ground construction still requires the later new-owner command integration.

## Fixed provenance boundary extracted — 2026-10-03 10:43 UTC

Two internal partial inspection entry points now share existing record mechanics:
`inspectConstructionProvenanceForRelocationOwner` and
`inspectRelocationProvenanceForOwner`. Only the original-position permanent
occupancy policy is omitted in these named leaves. Shape, descriptor budgets,
geometry, accounting, source chains, work, receipts and current-worker checks
remain. They do not authenticate vacated-ground reuse or any World; empty issues
must not be treated as complete spatial admission.

All old construction wrappers keep their permanent-origin policy at exactly the
same point within each blueprint's validation. The old relocation entry still
calls the old construction validator. No public identity, runtime command,
archived-worker exception or caller-supplied validation callback was introduced.

Root checks: both type configurations; final 45 policy tests in 3.12 s. Earlier
nine-file related run passed 307 tests in 68.59 s before test-only coverage
additions, plus boundaries/content/1206 locale keys and default build in 793 ms.
The final test additions directly cover the World wrapper using factory-captured
identity evidence, relocation's own missing-worker guard using a distinct real
worker, and cancellation terminal position. Independent source review found no
new production defect. Tests explicitly demonstrate that a spatially invalid
origin overlap can pass a partial leaf and still be rejected by the old complete
runtime, preventing that narrow result from being mistaken for admission.

## Historical/current spatial slice — 2026-10-03 11:00 UTC

The internal spatial module now builds bounded occupancy intervals from the
original construction and relocation records. All queries re-run fixed record
inspection and return detached discriminated results. It checks ended and live
soft targets, immutable origin-to-building handoff, cancellation/wait retention,
static terrain/road/legacy geometry, current physical layout and connectivity.
Only the same authenticated source may overlap itself during a move. Soft target
reservations do not become hard navigation blockers or consume blueprint slots.

Tick completions precede external commands; unrelated domain command revisions
are never compared. A geometrically relevant cross-domain same-tick cancellation
and reuse without ordering evidence is rejected as AMBIGUOUS_SPATIAL_BOUNDARY.
Review found a real omission: relocation's own revision order could contradict
that fixed phase order and falsely allow early reuse. A dedicated consistency
check now rejects that contradiction; its regression begins with a real successful
handoff and changes only the two same-tick revisions, retaining provenance validity.

The declared proof scope remains bounded spatial records, not complete World
admission. Historical per-command intermediate navigation connectivity, people,
terrain changes, other domain owners and lifecycle/archives need later owner
integration. The manually assembled new-building-on-vacated-ground fixture is
explicitly marked as record evidence; the old construction runtime still cannot
perform that complete gameplay loop.

Root final checks: both type configurations; 31 focused tests in 10.97 s; six
related files with 167 tests in 37.04 s; boundaries, 1206 locale keys, content and
default build (803 ms). Initial execution stopped at a test receipt literal's
TypeScript inference error; explicit ConstructionReceipt context fixed it without
casting away the frame type. Independent review closed the phase/revision defect.
No runtime/UI/public-identity activation is included.
