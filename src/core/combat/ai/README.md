# Default automatic battle controller

Pure deterministic expedition-facing orchestration over the real battle runtime. Prepare a catalog once, create a battle from the party and enemies, and pass it to `createCombatController(catalog, battle, options)`. `stepCombatController(state, catalog, ticks)` advances both teams, returning immutable state and a terminal `victory`, `defeat`, or timeout/mutual-elimination `draw`. There is no separate demonstration simulation or wall clock. The application owns pause, speed, expedition transitions and reward settlement.

## Public interface

- `createCombatController(catalog, battle, options)` takes a player team, fixed arena and optional per-unit policy, decision/movement cadence, guard command pacing, order duration and maximum battle ticks
- `issueTacticalOrder(state, catalog, command)` exposes only focus, guard, hold, clear-focus and ordinary skill casting, restricted to the player team. It never forwards raw authority interrupt or finish-downed commands
- `stepCombatController(state, catalog, ticks = 1)` runs the deterministic loop. Terminal states are stable and stop advancing
- `serializeCombatController` / `restoreCombatController(text, catalog, expectedConfigHash?)` preserve arena, policy, timers, path fairness cursor, pacing, orders, outcome and the full validated runtime snapshot. An expedition adapter should pass its expected configuration hash when restoring. The checksum is corruption detection, not cryptographic anti-cheat

The controller does not create, persist or distribute world rewards. A terminal battle retains Downed/Dead distinctions and authoritative death IDs. It ends the encounter through runtime cleanup and releases unfinished reservations. UI should consume `outcome` and the battle's cumulative statistics, not infer results from the capped event log.

## Selection policy

Sources and skills are identified by their typed data, never by authored names. Alive/recovered-and-unlocked actors decide on a fixed cadence. Rescue, threshold healing, timely authored interruption, cleanse, useful shield, ordinary active skills and basics form the default order. Explicit skill priorities resolve alternatives within each class. Targets use focus, guard-threat preference, distance and stable entity-ID ties. Healers compare integer health basis points. Basic attacks provide a no-spirit fallback. Ultimate auto-use is off by default and can be enabled per unit or requested through the ordinary manual cast tactic.

The default consume-status heuristic waits for the skill's maximum consumable stack count to favor build payoffs. Auto selection conservatively checks authored cost/range/cast duration; authoritative runtime action rules revalidate and adjust the real transaction. This first heuristic does not exploit every temporary discount/range bonus in its planning, and it may therefore defer a discounted spell or approach farther than strictly necessary. It never bypasses the authoritative resource, target or interruption checks.

Focus is team-wide, expires explicitly, and clears the underlying runtime focus map, including when its issuer/target becomes unavailable. Guard affects threat preference and emits one paced guard command, with a team-shared command cooldown in addition to content proc ICDs. Hold suppresses new automatic decisions and locomotion until expiry; an already committed/reserved cast is not implicitly cancelled. A hold can be accepted during control/recovery, but its duration starts immediately and does not wait for the lock to end. Focus/guard admission is confirmed by the authoritative runtime before any order, guard pacing or order sequence is recorded; a rejected locked/recovering issuer only produces diagnostics.

## Locomotion rules

Arena positions are integral grid points: `origin + cell × cellSizeUnits`. Arena dimensions are bounded to64×64 cells and must contain all initial entities on distinct walkable cells. Planning is bounded BFS with north/east/south/west tie order, at most four path requests per tick and a serialized round-robin cursor. It seeks a reachable cell within the desired attack/heal range, not the occupied target cell. Unreachable goals remain bounded and eventually draw at the configured timeout.

Runtime `stepBattle(state, catalog, 1, {movement:{arena,intents}})` accepts at most one cardinal-cell move per actor per tick. Supplying a movement batch with zero or multiple ticks is rejected rather than replayed silently. Movement takes place after status/source expiry and before periodic effects/due cast commitment. No movement while casting, recovering or action-locked by control. No simulation random stream is consumed.

Alive, Recovered and Downed entities occupy their start-of-movement cells; permanent Dead bodies do not. Occupied destinations are blocked even when their occupants intend to leave, so swaps and same-batch following into vacated cells are disallowed. Competing intents for an initially free cell resolve by stable entity ID; subsequent claims fail diagnostically. This is ordinary arena locomotion, not an implementation of the content `move` effect, which remains explicitly unsupported. Dynamic arena edits, knockback, kiting/retreat rules, collision sizes larger than one cell and formations are outside this slice.
