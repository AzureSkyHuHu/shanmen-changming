# Advanced combat primitives

Implementation: 2026-10-01. This is a deterministic runtime extension, not content balance certification or browser acceptance. Authored catalog versions, implementation flags and blocked-reason text remain unchanged in this slice. Experimental support now includes `move`, `zone` and `summon`. Nonzero `additionalChainTargets.staggerTicks` remains explicitly unsupported: its protocol still does not define a status identity or whether the value delays damage, applies control, or schedules a link.

## Arena ownership and movement

`BattleOptions.arena` optionally supplies owned, immutable geometry. `bindBattleArena(state, catalog, arena)` binds an unbound battle once, validates every current entity and rejects later geometry changes. `createCombatController` binds its existing immutable configuration geometry; restore validates equal controller/runtime geometry. Legacy standalone, non-spatial battles may remain unbound. The old one-tick locomotion API binds the supplied arena once for compatibility. Geometry is bounded at 64 × 64 cells, with integral positions, no overlapping live entities and explicit blocked cells.

`move { mode: 'toAlly' }` moves its source holder, never its selected ally. It finds a free cardinal neighbor of the living allied target using bounded BFS with north/east/south/west ties. All traversed cells must be walkable and unoccupied; downed bodies block, permanent-dead bodies do not. Maximum distance measures total cardinal path length, including detours. An already-adjacent actor is settled without displacement. Recovery, control, unrelated windups and summon-role restrictions still apply; the committing action has already cleared its own windup lock. Range/target/resource revalidation still happens before commitment. A committed movement with no route emits `effect.rejected`; the already-paid cast is not refunded, and subsequent separately authored effects still resolve.

## Fixed spatial fields

Each zone has a unique zone instance and its own encounter-lifetime source. It saves its creation-point anchor, radius, authored effect program, action adjustments, offensive snapshot, original provenance and periodic cursor. It never follows the creation target. Nested area selectors resolve against that fixed anchor; every nested recipient is additionally clipped to the field radius. Non-area selectors keep their declared identities and are also spatially clipped. The first pulse is creation tick plus interval. Expiration is exclusive and runs before periodic effects; there is no pulse on the expiration tick.

A configured baseline pulse is not charged as a derived proc, so a legal field lasting more than 64 pulses is not silently shortened. Any trigger programs caused by those pulses retain the original root and use the existing 64-derived-effect/8-depth restrictions, once-per-root state, family allowlists and ICD ledgers. Periodic events have family `zone-periodic`. Nested fields consume depth and live-source capacity; maximum live zones is 128. Existing content limits bound each program and selector; the arena bounds traversal. Expiry/periodic ordering is stable by source/zone sequence, followed by due actions in numeric action order. New nested fields do not get an immediate same-tick pulse.

## Committed ownership and death

Installed sources now explicitly distinguish `installed` from `committed`. A committed source never becomes another copy of the origin skill's listeners or action rules. Each field or decoy owns exactly one such source; its parent is the creating source while that source remains installed. Normal explicit uninstall, finite source expiry and scope cleanup cascade to exact children and owned contributions.

Death detaches already-created committed sources before removing the dead actor's normal sources. A committed field or decoy therefore finishes its declared lifetime under `resolveCommitted`; its offensive snapshot and credit remain with the original primary actor. A source executing an atomic committed action is retained until that effect list completes, then death-cleaned, so later effects cannot acquire orphaned ownership in a synchronous pre-downed retaliation. Queued listeners from dead/removed holders still fail their usual execution revalidation. Encounter cleanup removes all fields and decoys once. After death detachment, explicit removal can target the surviving committed owner directly; the removed originating instance is no longer a live parent edge.

## Disposable, targetable decoys

The declared summon definition supplies role and health coefficient, not a display-name branch. Creation places a stationary decoy in the first free cardinal neighboring cell. If there is no free cell, the committed effect emits a placement rejection. HP is the positive integer `max(1, floor(casterMaxHealthSnapshot × healthCoefficientBps / 10000))`. The effect must declare a finite positive duration. Recasting replaces the caster's previous live decoy atomically, including simultaneous casts ordered by action sequence. Different casters have separate one-summon caps.

Summons use `summon:N` identities allocated from the same monotonic battle `nextEntity` counter. Primary units remain `entity:N`, with `kind: 'combatant'`; decoys have `kind: 'summon'` plus a summon record. Summons have no actionable skills, spirit, basic attack or controller policy/agent. Source installation on a summon is rejected. Their damage/shield/HP handling uses the normal runtime pipeline, but reaching zero retires the summon without Downed, death IDs, kill credit or `life.died`. They cannot become campaign disciples, cultivate, equip, inherit or produce campaign death rewards. Campaign participant/enemy mappings must continue to use their explicit primary maps.

Automatic offense orders explicit focus first, then a guard's current threat, then `threatDecoy`, then distance/stable ID. It does not retarget an already-committed attack. Automatic single-target healing/protection considers primary allies; area effects can include decoys. Victory/defeat ignores summons, so a surviving decoy cannot keep an eliminated primary team in combat.

Retirement removes the entity and per-decoy statistics immediately, while global damage, absorption and healing totals remain intact. It invalidates pending attacks and clears statuses, shields, modifiers, charge recipients, focus and controller desired-target references. Closed actions/logs may retain structurally validated historical `summon:N` references; missing `entity:N` primary references remain invalid. Per-target trigger activation history is folded into a bounded per-source/trigger `retired-summons` aggregate, preserving maximum-activation usage without retaining every retired decoy or resetting budgets on recast. The aggregate carries no target ICD or once-per-root list, because a new decoy has a new target identity.

## Snapshot and migration contract

Current versions are battle snapshot **2**, simulation **combat-runtime-2**, controller **2**. Current readers remain strict; no implicit reinterpretation of active v1 combat happens.

- `upgradeLegacyBattleState(value, catalog, arena?)` / `upgradeLegacyBattleSnapshot(text, catalog, arena?)`
- `upgradeLegacyCombatControllerState(value, catalog, expectedConfigHash?)` / `upgradeLegacyCombatControllerSnapshot(text, catalog, expectedConfigHash?)`

These pure helpers require the frozen v1 shape and versions, validate original text checksums where applicable, original catalog fingerprint, IDs, RNG, reservations, effects, statuses, ownership, roots and ICDs, and reject old installed content that the v1 executor could not support. They add empty `zones`/`summons`, default primary entity/source kinds and the controller's unchanged arena. Controller configHash, RNG/ID sequences and all existing action/proc data are preserved. World/kernel migration is owned separately and must call the raw helper only in its explicit old-World migration.

The accepted active v4 fixture at `tests/integration/fixtures/save-v4-active-battle.json` was captured using the frozen accepted v4 implementation before the new schema was wired in. It contains genuine controller1/battle1 state with active actions, statuses, a shield and consumed combat RNG. Tests use this real fixture rather than deleting v2 fields to invent a legacy input. The released v3 preview has no active battle; that does not justify relabeling the accepted v4 fixture.

## Renderer/UI adapter needs

- Read `entity.kind` and the `summons` record to render a decoy using its summon definition's stable presentation identity; never look it up as a campaign disciple or normal enemy mapping
- Draw zone fixed `anchor`/`radiusUnits` and lifetime from `zones`; effects follow simulation state rather than sprite movement
- Use `entity.moved`, `zone.created`/`zone.removed`, `summon.created`/`summon.removed` and `effect.rejected` for optional presentation/log feedback; they are runtime diagnostics, not new gameplay proc triggers
- Hide decoys from roster/loadout, tactical-issuer and automatic-healing controls, but allow hostile target selection and display their real current HP
- No sprite size/frame/scale metadata is specified here; the 96px asset owner controls that contract

## Verification and remaining limits

New tests are isolated in `tests/combat-advanced`, including movement blockers/occupancy/detours, arena equality, source death/expiry, fixed spatial anchors, periodic boundary, >64 baseline pulses with bounded derived procs, nested deterministic replay, decoy health/cap/replacement/targeting/retirement, controller outcomes, malformed snapshots and strict genuine-v4 migration. Four obsolete negative-test fixtures were replaced with genuinely unsupported/invalid parameters while preserving negative coverage. Existing supported-skill behavior remains under the original combat/controller suites.

Parent-run checks: both TypeScript projects passed after the first runtime/API pass. The subsequent advanced/runtime/AI/builds/expeditions suites passed, including 24 primitive and 3 genuine-v4 migration cases after obsolete negative fixtures were corrected. Final review then added immediate tactical-order cleanup after summon retirement and three regressions (unrelated-windup movement, guard-threat priority and focused-summon manual destruction); those changes are frozen for the integration owner's final run. No worker-run tests/builds, browser acceptance, certification, balance or renderer completion is claimed here.

## Next protocol decision: additional chain Stagger (design only)

The frozen design source (`docs/engineering-plan/source/game-design.md`, §15, line440) says the extra target receives finite imbalance and bosses reduce it by tenacity. Both authored locales agree; English explicitly says “brief Stagger.” Therefore the existing `staggerTicks: 16` should **not** silently become a 16-tick projectile delay. The current catalog must remain unsupported until the following semantics are approved and encoded unambiguously.

Recommended minimal contract:

1. Replace the ambiguous numeric field with explicit `extraTargetStatus: { statusId: 'status.stagger', durationTicks: 16, stacks: 1 } | null`, plus explicit `linkRangeUnits` rather than relying on runtime's current 600-unit fallback. Keep `additionalTargets` separate. This requires a catalog/protocol version change and migration plan; do not mutate content under its existing fingerprint.
2. At commitment, compute one deterministic hostile-recipient chain from the action intent using live positions, nearest distance and stable-ID ties. The original intent is not an extra target. Every extra target is unique and must be within the link range of its predecessor. Capture this one list for all eligible paired damage/status primitives, preventing each primitive from choosing a different victim after damage downs someone.
3. Execute each extra recipient's authored damage/status pair in definition order as one atomic committed program, with ordinary queued triggers drained after that pair. Recipients are revalidated before each effect: if lethal damage downed the recipient, later status application skips it. Apply the explicit bonus Stagger once per extra recipient, not once per damage/status primitive; it uses the status definition's tenacity, exclusive duration and source ownership. No new paid cast, action.committed event or random targeting draw is generated.
4. These baseline extra hits remain part of the original action; resulting trigger programs use the original root, depth/64-derived budget, source activation counters and target-keyed ICD. Critical RNG is drawn only for an actually resolving damage effect, in recipient/effect order. Caster death during the atomic committed chain follows the same transient-origin cleanup policy proven by the v2 death tests. An uncommitted windup still cancels on death/source uninstall. Since every extra hit resolves synchronously at commitment, there is no new pending-hit snapshot state and no queued-hit cleanup problem.
5. Verification: paired damage/status recipient identity, extra-only Stagger, no double Stagger, tenacity to zero, lethal-first-effect skip, stable distance ties, per-target source attribution, consumed augment count, nested retaliation, one root/ICD budget, and genuine old-catalog migration rather than a manufactured fixture.

No delayed-hit queue is needed for the authored brief-Stagger mechanic. Visual travel, if desired, remains presentation-only unless a future explicit gameplay requirement defines a separate delay field. No chain-control implementation or catalog revision is included in v2.
