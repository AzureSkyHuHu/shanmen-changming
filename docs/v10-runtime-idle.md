# Private v10 retained idle integration

Status: implementation and differential cases written on 2026-10-02. This document describes the integration contract, not a test or performance pass. Test, typecheck, benchmark, build and publication execution belongs to the integration owner. The strict owner baseline was reported passing 27 tests before this change; those results do not verify this change.

This extends the private owner described in `v10-runtime-instance.md`. Its earlier statements that every advance rereads the source and that there is no retained idle proof describe the strict baseline, and are superseded here only for the privately proven idle slice. The fixed strict candidate gate and public application path are unchanged.

## Two private proofs with different meanings

The retained runtime has two separate closure-local bindings:

- An exact anchor binds one privately owned frozen World identity and generation to its actual `ManagementCapacityV10` assessment. Creation, complete strict source checks and accepted strict candidates may establish this anchor. It is exact only for that World
- An idle cursor binds one privately owned frozen World identity and generation to a distinct `CarriedIdleCapacityV10`. Its current dimensions are updated by the fixed scalar leaf; reserved amounts remain conservative. It is not an exact assessment, recovery allowance, candidate admission or terminal-discharge proof

The leaf itself has its own private root and carried capacity. Only its descriptor-based complete capture or fixed producer can install either. When the runtime enters the leaf, `capture` returns a new detached, fully assessed frozen World. The owner adopts that exact root identity in its World, exact-anchor and leaf-cursor bindings together. This internal identity replacement does not change logical World data, generation or publication. It prevents accidentally keeping a certificate for one clone while advancing a different root.

External freezing, a root from another runtime, a structurally equal snapshot, a caller-controlled `this`, diagnostic objects and extra arguments confer no authority. There is no source-borrow flag, policy callback, arbitrary producer, public assessment input, owner token, cross-runtime registry or generally trusted frozen-object path.

## Fixed scalar publication

After normal step validation, a privately matching exact anchor or carried cursor can avoid a repeated outer source check. A stop is still checked before leaf entry, and a paused root does not advance. Every tick checks publication headroom before preparing a candidate.

Entry has a rejecting hint based on the exact assessment and known live work. This avoids trying to clone clearly active or recovery-only sources into the leaf. It never admits a root: the existing owned leaf still descriptor-captures and fully assesses every actual entry. That extra entry query is intentional and must be counted in real profiling.

The leaf changes exactly five stored integers: simulation tick, calendar tick, construction revision, production revision and research revision. It shares only its already-owned immutable subtrees. Care and upgrade revisions remain unchanged. Its arithmetic separately advances every live and archived birthday elapsed dimension, including dimensions not serialized in the World, and checks their individual safe-integer/capacity limits. Only the five stored integer decimal-width changes are charged to serialized wire growth; derived elapsed dimensions are not charged twice.

A successful leaf tick replaces the private complete World, invalidates the previous exact anchor, replaces the cursor with the returned carried boundary, increments publication and `advancedTicks` once, and reports `recoveryOnly: false`. Carry eligibility requires full fit, so no recovery-only World enters this branch.

## Every boundary returns to exact strict work

The leaf reevaluates its fixed shape on every tick. Month rollover, individual birthdays, pending death, active/blocked upgrade or other work, teaching, automatic decision times, maintenance expiry, numeric edges, unknown clock shape and conservative capacity refusal are all outside this proof. Maintenance uses the latest actual payment expiry, including its L2 rate, rather than the historical L1 building origin.

A failed capture or failed carry clears both private proofs and performs a fresh complete source assessment/teaching check. It then reaches the existing normal candidate followed, if needed, by the existing no-optional-growth candidate, both from the same unchanged complete boundary. The existing `decisionV10` still independently derives its exact source/candidate assessments and actual teaching/release witnesses. No carried number is cast to or passed as `ManagementCapacityV10`, compared for recovery deficits, or spent as a discharged obligation.

A leaf refusal by itself does not create a stop. In particular, a conservative carried wire reserve can refuse a decimal crossing even when a fresh exact query finds a smaller required reserve and the real strict tick succeeds. Conversely, a genuine strict failure preserves the complete last accepted World and latches the existing typed stop. Earlier accepted ticks in a batch remain published. The existing facade's invalid-records diagnostic wording differs from the owner-free strict oracle for thrown preparations; test comparisons preserve that pre-existing distinction while requiring the same stop kind and complete World.

After a strict accepted boundary, the owner may establish a new exact anchor and later capture a newly idle source. Active work continues through the strict path. There is no active-work, checkpoint, terminal-discharge, lesson, death-settlement or maintenance fast path.

## Operations and lifetime isolation

- Every non-reentrant command, clock control, replacement attempt, invalidation and close clears the previous idle cursor and exact anchor before processing. Invalid requests can therefore cost a new source check later; they cannot preserve an obsolete proof
- Commands then use a fresh exact source check and the unchanged fixed candidate gate. Exact retries, command-ID conflicts, malformed commands, capacity refusals and other no-write outcomes preserve the logical World, stop and stamps. A new accepted complete candidate establishes a new exact anchor
- Clock controls check the source and fixed clock-only candidate exactly. Their deficit comparison accepts only actual `ManagementCapacityV10` values. No-op controls do not publish. Changed controls increment publication but never clear a latched stop or domain-owned pause
- Failed replacement can discard private proofs but preserves the old World, recovery status, stop and generation/publication. Successful replacement fully captures/validates the external input, increments generation and publication, and establishes a new exact anchor
- Invalidation clears proofs and increments generation only. The next operation cannot reuse a prior-generation assessment or leaf cursor
- Close clears proofs, drops the root and increments generation. All later operations reject before caller-input reflection
- Snapshots do not consume or export either proof. Every snapshot descriptor-captures a separate World, fully validates that actual detached export including teaching, and returns a deeply frozen independent tree. Export failure does not mutate the retained World, proof, stop or stamps
- Reentrancy guards still run before argument reflection, coercion, proof clearing or root access. Methods are closure-owned and ignore `this`

Generation and publication remain safe integers with pre-publication headroom checks. This integration does not change the 1200-step synchronous call bound, wire/record limits, content identity, canonical codec, save admission, migration or UI registration.

## Metrics and performance limits

`fastTicks` counts only successfully published fixed scalar leaf ticks. `sourceChecks` counts calls of this runtime's outer `checkSource` helper. It excludes leaf-entry capacity queries, query-internal complete record checks, strict decision source/candidate assessments, teaching route trials and exact reducer witness replay. `candidateChecks`, `normalCandidates`, `noOptionalCandidates` and `exports` retain their existing outer-operation meanings.

These counters are branch diagnostics, not total CPU cost, total validation count, saved work or performance acceptance. Creation, first leaf entry, boundary reentry, controls, commands, replacement and snapshot export still have complete validation costs. The active path remains strict. Any benchmark must separate creation/entry, warm advances, boundary fallbacks and export and compare complete outputs to the strict oracle outside the measured interval.

No 20 Hz, 3×, 36-disciple, long-history, 150-year, rendering, mobile-device, public-v10 or complete-game performance claim follows from this implementation. The integration owner must record actual measured results and remaining limitations separately.

## Written differential coverage

`tests/sect-expansion/v10-runtime-idle.test.ts` compares complete Worlds, stop outputs, recovery classifications and publication counts against the unchanged owner-free strict oracle across repeated calls and mixed batches. It covers month, birthday, planner and decimal boundaries; a real conservative-wire refusal followed by strict success; numeric safe-stop retention through retries/conflicts/failed replacement/invalidation/clock changes; proof invalidation; isolated snapshots; foreign frozen roots; accessors, thrown Proxies, borrowed methods and all-method reentry.

Genuine natural death and finalization exercise pending-death pause and later archived elapsed dimensions. Earned alchemy/herbal fixtures exercise upgrade phases, the real 199→200 paid checkpoint, 399→400 completion, death-before-completion ordering, idle reentry after completion, and a latest actual L2 maintenance expiry after snapshot reconstruction. Old earned records are explicitly lifted as record fixtures; base-stock funding and selected phase/age initial conditions are labelled test setup rather than new gameplay or migration claims. Existing standalone leaf and strict owner tests remain independent regression targets.

Execution results are pending the integration owner's run. This file's author ran no tests, typecheck, build, benchmarks, Git operations, browser or deployment.

## Root integration evidence,2026-10-02 21:43UTC

All15 new idle integration cases passed;26/27 previous owner cases passed in308.70s combined. The sole failure was the old exact metrics expectation (strict queries) after introducing counted fastTicks. Its corrected retained-idle expectation separately passed (1passed/26skipped,3.10s), with unchanged World/oracle assertions. Types,boundaries and default build passed; read-only review found no blocking issue.

Twenty separate fresh four-disciple owner ticks after3warmups exactly matched raw candidates: p50 .207ms,p95 .360ms,max.407ms; creation68.68ms. Snapshots/oracle excluded from timing. Pre-integration same owner benchmark was p50128.578ms. A genuine active gather still costs p5099.577ms,p95123.274ms,max126.721ms (creation62.10ms), all exact. Idle optimization therefore does not clear the active-work activation blocker or prove rendering/phone/36-person/L2 performance.
