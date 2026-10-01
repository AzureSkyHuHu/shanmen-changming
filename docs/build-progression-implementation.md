# Permanent build progression implementation

Implementation date: 2026-10-01. This document describes the standalone module under `src/core/builds`, not a claim that World, saves, UI, or live expeditions have integrated it.

## Implemented boundary

- Pure, deterministic TypeScript; no renderer, browser, persistence API, wall clock, RNG, or remote dependency
- Four existing school trees and all 36 authored nodes, with exact IDs and mechanics retained
- Every node costs one point; prerequisites include both previous branch tiers for terminals; no more than five allocated points per disciple, one native-school tree
- Separate permanent learned knowledge, equipped basic + two active + one passive, and exclusive-owned weapon/robe/artifact instances
- All four complete school starters use existing supported skills, with no run talent, reroll or random drop required to begin combat
- Stable IDs come from the existing `allocateId`/`SequenceState`; installed sources use existing `SourceOwner` fields and character/infinite lifetimes
- All mutations are revision checked, command-ID deduplicated, immutable transactions; exact command retries return no duplicate adapter operations
- Unsupported combat capabilities remain visible as unavailable choices, with runtime reason strings. The module never swaps in another skill, strips mechanics, marks a definition verified, or makes an unsupported definition playable

## API

Import from `src/core/builds`:

- `createBuildFrame({ disciples, contentMode, sequences? }, catalog)`
- `applyBuildCommand(frame, command, catalog)` for `tree.respec`, `skill.learn`, `loadout.set`
- `applyBuildAuthorityCommand(frame, command, catalog)` for `milestone.award`, `equipment.grant`, `expedition.lock`, `expedition.unlock`
- `isBuildCommand` and `isBuildAuthorityCommand` are separate closed runtime gates; authority commands never pass the player gate
- `getBuildProgress(frame, discipleId, catalog)` returns earned, spent and remaining tree points and learning credits
- `getBuildChoices(frame, discipleId, catalog)` includes authored unavailable skills and native tree nodes with reasons. Skill availability means learnable/already learned, not an implicit equip operation
- `buildCombatLoadout(frame, discipleId, catalog)` returns an owned-copy structure compatible with `ExpeditionLoadout`
- `validateBuildFrame`, `serializeBuilds(frame, catalog)`, and `restoreBuilds(text, catalog)` validate independent standalone snapshots

`BuildFrame` contains `builds` and the shared `sequences`. The World adapter should persist `builds` with the World and pass its current global sequences on every transition. The module records sequence checkpoints, allowing other domains to monotonically consume IDs between build commands. IDs must never be reset or separately allocated by an adapter.

Successful transitions return `frame`, `receipt`, `operations`, and `replayed`. Failure returns the exact unchanged prior `frame`, an error code, and any support details. Input objects and command arrays are not retained by reference. Transitions return deeply frozen state; projections return owned mutable copies.

## Atomic source handling

A respec validates the complete new allocation and equipped skill requirements before committing. It removes old tree sources in reverse prerequisite order, then installs new sources in prerequisite order. Retained nodes receive fresh source identities during a changed allocation. A semantically identical reordered allocation does nothing to sources or IDs. Equipped skill and equipment sources are separately installed; a loadout replacement removes those old sources before installing the new set. Learning permanently records knowledge and does not install an unequipped passive.

Every adapter operation carries the exact owned `BuildSource`, including source entity, definition, instance, lifetime and creation sequence. Source removal must remove only that instance's contributions. The adapter must commit the returned frame, sequences, and every operation atomically with its live source ledger; an external operation failure must discard the entire candidate World. Do not commit part of the operation list or rerun it on a duplicate command receipt. Initial sources are present in `createBuildFrame().builds.disciples[].sources`.

The current battle runtime creates encounter-local source instances. `buildCombatLoadout` therefore projects definition IDs to combat and retains authoritative permanent source identity in BuildState. An adapter must keep a permanent-to-encounter source mapping if it needs cross-domain removals; it must not pretend their instance IDs are identical. This module does not silently override the combat runtime's install API.

## Fixed provisional progression and equipment rules

Five authority-validated milestone rules exist: `realm.qi`, `realm.foundation`, `realm.golden-core`, `realm.nascent-soul`, and `expedition.first-victory`. Each grants one tree point and two learning credits. Each rule is awarded at most once per disciple. A milestone ID identifies one exact recipient/rule award: replaying the same fact is harmless; changing its recipient or rule conflicts, even under another command ID. Invented rule IDs and caller-selected grant amounts are rejected. The World must check that the referenced realm/expedition fact actually happened before calling this authority API. A string ID by itself is not proof of a milestone.

Initial disciples have zero earned tree points and zero elective learning credits. Each knows its three fixed starter skills. Elective study costs one to three credits. Explicit rules cover all 24 existing skill IDs: first-school skills have no skill prerequisite, later skills require that school's first skill, and ultimates require the first two. Learning prerequisites are checked against permanent knowledge. Ultimates still occupy an ordinary active slot. Unsupported third skills are not an artificial prerequisite for independently supported ultimates. Required-node lists are part of the rule contract but currently empty; no invented tree-to-skill unlocks are attributed to the frozen design.

Permanent knowledge never holds a foreign teacher source or depends on teacher life state. Reallocating a teacher's or learner's nodes cannot revoke learned knowledge. Actual teacher death, teaching eligibility, and inheritance remain World/cultivation responsibilities and need integration tests there; the standalone module does not claim to execute deaths or teaching.

Equipment prototypes are declared in `EQUIPMENT_DEFINITIONS`: four native-school training weapons each grant flat attack +3; the training robe grants maxHealth +20 and armor +1; the training artifact grants maximumSpirit +20. Tags, slots, school compatibility, and bonuses are explicit. These are provisional equipment rules, not newly fabricated combat skill definitions. Each item has an allocated stable instance ID, one owner, and a deduplicated acquisition ID. Only an exact owned item of the right slot/school can be equipped; references shared by multiple disciples are invalid. Unequipped equipment grants never install a combat source.

The projection starts at provisional attack 12/maxHealth 100/armor 0/maximumSpirit 100, then adds equipment bonuses once. Tree and passive effects are not pre-applied to those stats: combat installs them from characterSourceIds and skill IDs. All four initial equipped sets are:

- sword: liuhen-jian / guifeng / jianxin
- body: baoyue / zhenbu / xujin
- alchemy: qingwu / huichun / yaoli
- talisman: yinlei / fenzhang / fumai

These are playable starting loadouts, not a claim that every mature named build synergy is complete. Current content still requires explicit experimental mode; verified mode rejects uncertified content. Move, zone, summon, and other runtime-rejected capability variants remain blocked. Native-school equip restrictions mirror the existing expedition validator; off-school permanent study does not allow an illegal expedition loadout.

## Expedition lock and validation

Authority lock commands can lock a whole party atomically with exact run and lock IDs. All player build mutations are rejected while locked, including same-value edits and elective study. Milestone awards and inventory-only gear acquisition may proceed because they do not change installed sources. Unlock requires exact matching run/lock identities and the unchanged locked source/loadout digest. Failure for any party member rolls back earlier members in the same command.

Snapshots contain an origin, accepted command history, sequence checkpoints, exact receipts, and the full state. Restore reconstructs the origin and deterministically replays history before comparing the complete result. It does not trust a recomputed checksum to establish valid knowledge, points, item ownership, sources or locks. Mutable imported frames receive the same semantic check before mutation. Content hashes and simulation/rules versions must match. Unknown fields, ID conflicts, non-JSON objects, accessors, sparse arrays, cycles, non-finite values, invalid references, backwards sequences, and forged state are rejected. Bounds include 36 disciples, 512 equipment instances, 1,024 accepted commands, a bounded JSON traversal, and four million snapshot characters. This is a local corruption/invariant boundary, not an anti-cheat signature; a wholly rewritten valid authority history still requires trustworthy outer World provenance.

## Validation evidence and remaining work

Tests under `tests/builds` cover allocation gates, source ordering/ownership, overflow rollback, shared item references, milestone/command deduplication, supported complete starters, bounded prerequisite learning, permanent knowledge retention, slot validation, lock atomicity, hostile saves, semantic replay, and global sequence advances. The integration owner runs all tests, type checks and builds; this worker did not run repository-wide commands. Parent validation at 08:41 UTC: all 27 build tests passed in 1.89 seconds. Parent type checking identified three test-only assignments to readonly SourceOwner fields; fixtures were corrected by replacing the deliberately forged source records. Final repository-wide validation remains with the integration owner.

Not implemented here: World/schema/UI wiring, actual realm/expedition milestone authority, equipment drops, balance certification, live teacher-death integration, or browser verification. No unrelated files are owned or changed by this module.
