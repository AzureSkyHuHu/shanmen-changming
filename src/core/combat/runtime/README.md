# Deterministic battle runtime v2

Pure TypeScript, fixed integral 20 Hz ticks. No UI, automatic AI, wall clock, storage API, or dependency on world simulation. The catalog remains a definition-only authoring foundation; these runtime tests do not certify every authored entry or its balance.

## Public boundary

- `prepareCombatCatalog(catalog)` returns an owned, deeply frozen copy with a safely memoized fingerprint/definition index. Prepare once and pass this same copy to battle functions. Mutable caller catalogs remain supported but are rehashed at each entry to detect mutation; this has a measurable cost. Caller-owned input is never frozen.
- `createBattle(catalog, options)` creates a deeply frozen snapshot. Seeded kernel streams and sequence IDs are owned by this battle. Supply namespaced `entity:N` IDs to preserve world entity identity; omitted IDs allocate deterministically.
- `issueCommand(state, catalog, command)` returns a new state. Cast/basic commands reserve resources, then commit at windup end. Zero windup commits immediately. Cooldowns start at commitment. Invalid/blocked commands append a diagnostic and leave simulation resources unchanged.
- `stepBattle(state, catalog, ticks = 1)` advances explicit ticks, never proposes actions. Maximum single call: 100,000 ticks. Expiry precedes periodic work, which precedes due casts. Equal-time casts use numeric action sequence.
- `installCombatSource`, `removeCombatSource`, `cleanupBattleScope`, `advanceBattleNode`, and `endBattle` expose source/lifecycle operations. Installation returns a state; new source identities are in `state.sources`. Scope cleanup removes narrower scopes too. Encounter cleanup resets encounter trigger activations while retaining run activation budgets; run cleanup resets those budgets.
- `queryStat`, `selectTargets`, `statusStacks`, and `shieldUnits` are read-only queries.
- `serializeBattle` and `restoreBattle` use an explicit versioned, checksum-bearing canonical JSON envelope. Version/catalog fingerprint mismatch rejects rather than migrating implicitly; explicit frozen-v1 upgrade helpers are provided for the World migration owner. RNG, IDs, pending windups/reservations, per-source activation/ICD/once-per-root state, shared team budgets, charges, histories, live root budgets, statuses, statistics, and logs survive restoration.

`contentMode` defaults to `verified`: all reachable definitions must explicitly be verified. The opt-in `experimental` mode permits supported definition-only data for conformance tests and development previews. It does not alter the catalog or confer certification. Catalogs supplied by application code must first pass the separate protocol/content validation boundary. Runtime capability checks reject unsupported actual operations even if a capability manifest is inaccurate.

Commands `interrupt` and `finishDowned` are explicit simulation-authority operations for scenario orchestration. A player-facing controller must restrict their availability to authorized game rules; they are not free tactical buttons. `guard` emits a command event, and `focus` sets a team target. Focus has no automatic expiry in this slice and is revalidated whenever selected. The independent controller proposes locomotion/AI; content movement executes through the bound arena.

## Implemented operations

`damage`, `heal`, `shield`, `applyStatus`, `consumeStatus`, `restoreResource`, `installModifier`, `dispel`, `interrupt`, `preventDowned`, `rescue`, `storeForce`, `releaseForce`, `recordCast`, `augmentNextAction`, `actionRules`, and `control`.

Advanced operations `move`, `zone`, and `summon` are implemented; see [the lifecycle and migration contract](../../../../docs/advanced-combat-implementation.md). Nonzero `additionalChainTargets.staggerTicks` also throws: the protocol has no unambiguous status identity or delay semantics. This currently excludes `talent.zoumai-chengfu`. Zero-stagger chain extension works for hostile intent-targeted damage/status effects, with distinct stable-ID-tied targets and a 600-unit chain link range. The protocol does not carry a separate chain link range for an adjustment. Finite node durations are supported for installed sources via `advanceBattleNode`; node-duration effect contributions are explicitly rejected. No unsupported behavior silently becomes a no-op.

## Calculation and ordering policy

- All quantities are safe integers. Checked products and additions reject overflow. Percentages/probability are basis points. Critical probability uses kernel `drawInteger(..., 0, 9999)`; 0% never hits and 100% always hits.
- Stat queries calculate base plus flat, shared additive percentage, independent factors, lower/upper bounds, final floor, and engine safety caps. Tagged modifiers require all their tags. There is no stale stat cache. Health-fraction conditions use resolved maximum health, except a maximum-health modifier testing its own health fraction uses base maximum health to avoid a circular equation.
- Damage: resolved amount plus common additive damage bonuses, critical multiplier, physical armor after penetration, general reduction, shield absorption, actual health loss, pre-downed prevention, downed/death settlement. Armor policy is `floor(requested × 100 / (100 + effectiveArmor))`; elemental damage bypasses armor. General reduction floors the next stage. This is an explicit unbalanced engine policy, not a universal design formula.
- Direct attack uses the reservation snapshot; defense is queried at hit time. DOT stores the original applier's application snapshot and multiplies periodic contributions by accepted stacks. Periodic self selectors denote the bearer while credit remains with the applier.
- Expiration is exclusive. Status instances expiring on tick T are removed before a possible periodic tick T. Refresh, extend with ceiling, independent bounded stacks and strongest retained-source arbitration are implemented. Merged status identities retain per-applier/source stack ownership. Removing one source removes only its owned stacks. Control locks interrupt reserved actions and end on removal; tenacity reduces finite control duration.
- Shield break emits once per shield identity. Broken shields are retired after their frozen events are published. Strongest shield/status contenders remain recorded, permitting losing contributions to become active after the winner is removed.
- `Alive → Downed` never grants a kill. `Recovered` has an explicit action lock then returns to `Alive`. Only `finishDowned` or an entity's explicit immediate-death rule creates a unique permanent death ID. Prevention runs only inside the fixed pre-downed window; healing cannot rescue or revive.

## Trigger and ownership safety

Event payloads are frozen snapshots. Eligible triggers are collected before execution and sorted by priority, holder ID, source creation sequence, then definition index; event publication order supplies the event-sequence ordering. Ordinary derived programs drain after the complete originating effect list. Pre-downed prevention is the explicit synchronous exception. New sources cannot hear the event that created them. Recipients are revalidated at execution, preventing poison renewal from reapplying to a target killed by its detonation.

Indirect events require an exact family allowlist; self-family recursion remains blocked even if listed. Global root depth ≤8 and derived-effect count ≤64 are hard limits independent of listener count. Overflow emits a diagnostic once per exhausted root. Per-source maximum activations, once-per-root checks, and target-keyed ICDs are separate restrictions. Team talents arbitrate one active source and retain a shared run budget through replacement or removal. Charged party augments have one shared use count; they are spent only at commitment and recomputed before paying, so simultaneous reservations cannot duplicate the discount.

Source-owned force records only actual hostile shield absorption, shares one holder cap, and drains accepted units once. History records only genuine paid direct committed actions, then emits a separate frozen history event including that cast. Neither a proc nor a chain hit emits a second committed cast.

## Snapshot and retention limits

State updates share already-frozen closed-action and event subtrees while copying mutable transactional data; caller inputs and previous states remain unchanged.

Snapshots reject wrong versions/catalogs, checksum mismatch, unknown/malformed nested structures, unsafe JSON keys, source cycles, duplicate contribution identities, invalid resource reservations, unrecognized action programs, forged basic programs, source-inconsistent modifiers/augments, invalid provenance and out-of-bound proc budgets. The checksum detects accidental corruption; it is not cryptographic authentication or anti-cheat.

Display logs cap independently at 0–10,000 events, default256. Cumulative statistics are never derived from that log. Closed action detail retains the newest256 actions. Roots remain while referenced by pending/recent actions, status provenance, bounded histories or display events; inactive roots and their once-per-root references are retired. Activation counts and ICDs remain even after root detail is retired. Live sources/statuses/shields/modifiers/charges each cap at4096; a capacity/overflow failure throws before any new immutable boundary is returned, so the caller retains its previous complete state. Snapshot text caps at8,000,000 characters. These are defensive bounds, not performance certification for maximum load.

There is no projectile travel or content certification here. Bounded spatial movement, fixed zones and battle-only summons are supported; controller/outcome and campaign/reward integration remain separate modules. World integration should consume the returned immutable state and unique death IDs, rather than inferring settlement from display logs.

## Optional controller locomotion extension

`stepBattle` accepts a fourth `BattleStepOptions` argument with a fixed arena and movement intents, only when `ticks === 1`. It applies bounded adjacent cardinal movement after expiry and before periodic effects/commits, without RNG or content-move execution. Casting, recovery/control locks, blocked/out-of-bounds cells, occupied start cells and duplicate claims are rejected. Dead entities are nonblocking; Downed entities block. Stable entity IDs resolve free-cell conflicts. `clearFocus` explicitly removes an actor team's focus and is also available for cleanup when that actor is downed/dead. The automatic controller owns fixed arena serialization, path planning and paced tactical commands; details are in `../ai/README.md`.
