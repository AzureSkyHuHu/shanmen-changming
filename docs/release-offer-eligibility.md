# Opt-in release offer eligibility

Status: implementation candidate, 2026-10-01. This module is **not wired into live offers, World, saves, snapshots, content composition or the random stream**. It is not a release-admission migration, a balance certificate or a replacement for the 10,000-seed offer/replay acceptance suite.

## Public contract

`src/core/expeditions/release-eligibility.ts` exports:

- `RELEASE_ELIGIBILITY_RULES_ID = release-eligibility-candidate.1`
- `releaseEligibilityInputHash(state)`
- `evaluateReleaseEligibility(state, catalog, context)`
- Closed TypeScript context, result, diagnostic and reason types

The evaluator returns immutable candidates in stable definition-ID order. Personal and selected-talisman recipient IDs are sorted. Unbound team cards retain the existing empty `holderIds` convention; their actual active source anchor is supplied separately in the authoritative context. There is no roll, grant, equip, recipient replacement, run mutation or removal of already-owned cards.

Every rejected card/recipient has explicit reasons. A short pool has `INSUFFICIENT_LEGAL_CARDS` and its actual missing choice count. The returned two-meal supply alternative is a descriptor with `grantsReward: false`; only the existing authoritative reward transaction may spend the reward opportunity and grant it. Missing context does not make a reward claim legal.

The current frozen `talent.zoumai-chengfu` is always rejected as `UNSUPPORTED_EXTRA_TARGET_STAGGER`. Its `staggerTicks` is never interpreted as delay, ordinary Stagger or an implemented extra-target protocol. Even a caller-provided proposed definition with the same ID cannot bypass this rule; a later admitted rules version must explicitly remove the gate after runtime/schema/migration verification.

## Context ownership and stale-data rejection

Only a trusted World/encounter adapter may construct `ReleaseEligibilityContext`. It must derive facts from the selected next-encounter definition, catalog, arena and authoritative locked loadouts. **Do not deserialize UI-supplied or save-supplied “capabilities” into this context.** An identity hash binds facts to inputs; it does not establish that an untrusted caller told the truth.

Required identity:

- Exact evaluator rules ID and selected combat catalog fingerprint
- Input fingerprint covering current members, loadouts, casualties, supported run sources and explicit bindings
- Selected encounter ID, encounter-rules identity and arena identity

Required encounter facts:

- A finite opportunity horizon, at most 100,000 ticks
- At most 36 hostile identities with their effective control resistance
- Explicit Guard permission, defeat rule, direct-damage enemy identities, control-causing enemy identities and normal decoy-placement possibility for each living member
- Achievable pair distances for the relevant encounter opportunities, plus legal hostile focus targets
- Exactly one live source holder per team definition in this selected pool, computed using the runtime’s actual highest-value source calculation and installed-source tie-break

The source holder and a selected talisman recipient are different identities. The evaluator must not select a more convenient source anchor, multiply one shared aura across all allies, or redirect a dead binding. Missing or duplicate source mappings fail closed. The adapter must recompute a team anchor after casualty or effective-stat changes.

Pair distances describe potential positioning during the encounter, including legal movement. They do not freeze the opening formation. An omitted pair is unreachable. Distances used in one witness must be jointly achievable in the same relevant encounter opportunity; an adapter must not combine distances from mutually exclusive/disconnected arenas. For a range-zero self action the only command target is self, but enemy/ally area effects are resolved using their own selector and radius.

Likewise, a full-health opening is not evidence that future effective healing is impossible. Downed eligibility, incoming control, allied protection and normal free placement describe achievable events. Temporary full occupancy or a wasted interrupt remains a real in-battle failure risk. This evaluator does not promise that every eligible card triggers in every battle.

After any casualty, explicit rebind, supported loadout change or context/catalog change, discard the old context and evaluate again. Dead personal sources and unavailable bound sources supply no capabilities. A dead bound team instance remains in the input and yields `INACTIVE_BOUND_RECIPIENT`; the evaluator neither deletes it nor silently rebinds it.

## Capability derivation

Only two equipped same-school active skills, one equipped passive, valid effective permanent nodes and supported owned run sources contribute effects. The node dependency walk starts at actual roots, uses at most five points and does not bootstrap a cyclic prerequisite set. Wrong-slot skills and an illegal third active produce `INVALID_LOADOUT` rather than a fabricated legal configuration.

Definitions are checked through the current runtime support checker in the selected content mode. The evaluator derives events and status facts from actual typed effects, targets and conditions. Definition names, school labels, `requiredSourceTags`, descriptive text and `providesSourceTags` are not substitute producers.

The bounded least-fixed-point analysis starts from intrinsic Basic/Guard, supported paid actions, encounter damage/control opportunities and valid on-install effects. It follows existing supported trigger families only after their input event and conditions are reachable. It tracks:

- Exact status ID, hostile/allied target and applying holder
- Direct action versus indirect family, paid active versus intrinsic Basic
- Own poison versus another caster’s consumption of it
- Actual shield recipients, rather than an arbitrary ally’s self-only shield
- Owned Force storage and an actual release event
- Paid caster/school identity and the recorder’s own permitted family
- Status stack caps, refresh intervals, active cast/cooldown timing, finite uses, effective action adjustments and a bounded spirit-cost witness
- Mandatory earlier same-holder Medicine/Rune spending; a newly acquired card cannot advertise a payoff that the equipped passive always starves

Independent status outputs may add stacks, while multiple event observations of the same output are not duplicate producers. A producer conditioned on an absent status cannot stack its own opening-only output by pretending the status remains absent. A consume-only skill cannot seed a resource cycle. A graph that exceeds 64 passes or 16,384 facts fails closed with `GRAPH_LIMIT_EXCEEDED`.

This is a conservative capability analysis, not an alternate combat executor or an exact optimal scheduling search. It does not import expired encounter statuses, spent emergency charges, learned-but-unequipped skills, unowned permanent nodes or arbitrary future cards. Existing finite effects may be scheduled as opportunities, but the runtime remains authoritative for exact effect order, resource races, placement, root budgets, survival and successful payment. Spirit witnesses use the member’s available spirit and can reject an expensive multi-action setup even when each individual active fits the maximum capacity. A future extension for additional recovery/scheduling shapes must be explicit and tested, not inferred from tags.

## Additional card predicates

All rules run after supported-definition, rank, explicit prerequisite and symmetric-exclusion checks.

1. Sword starters require a real paid hostile sword action; Ward to Edge additionally requires that recipient’s action to apply Sword Mark and a real allied paid shield action. Mark payoffs require the indicated successful paid 2/3-stack spend against a reachable producer’s target. The mark-to-heal Basic requires an actual mark on a target that holder can Basic.
2. Pinned Twin Marks requires genuine hostile Stagger plus a Basic on the same target. Friendly control-resistance buffs do not qualify. Shock-Forged Edge requires actual `status.shock`, not lightning damage or a lightning label.
3. Marks Return as Runes requires a live selected recipient with an equipped payable talisman active and an allied full-mark spend. Its source anchor can be another disciple; its target must remain the explicit binding.
4. Medicine into Venom keeps its same-holder prerequisite, own poison, another live paid consumer and Basic/Medicine conditions. Medicine healing variants keep the same-holder cleanse producer and real cleanse/heal active slots. A Medicine-consuming passive does not produce Medicine.
5. Owned-poison reactions require the holder to supply poison and another actor to consume that contribution. Detonation payoffs distinguish two from three consumable stacks before expiry. Poison-for-Rune cannot invent its own initial poison.
6. Direct-heal converters exclude passive/proc/zone-only healing. Paid-heal cast listeners may accept an actual paid healing-field active, because their trigger is the paid cast; this is distinct from a direct-healing event.
7. Shield reactions require a reachable shield on the actual holder plus incoming hostile direct damage. Another actor’s self-only Mountain Embrace is insufficient. A reachable Aid or allied area shield can qualify.
8. Force payoffs require the same-holder prerequisite, storage, protection, hostile absorption and real release. The companion heal also needs another reachable living ally.
9. Control recovery requires incoming control or an independently reachable owned self-control source. Emergency survival requires no school-specific engine. Rescue uses the actual team source holder and another eligible Downed ally; immediate-death or dead recipients do not qualify.
10. Guard cards use real Guard permission. Focus mark engines require a legal focus and an actual paid Sword Mark consumer; they may create the first marks themselves. Missing preexisting marks must not wrongly exclude a genuine mark engine.
11. Rotation checks living payable equipped casters and distinct schools; Basic, proc casts and dead allies do not count. Different actors may align independently started casts in the recording window; an active that cannot commit within the encounter opportunity horizon is excluded. Rune payoffs require owned reachable Rune input, and the positioning/decoy variants additionally require an actual paid talisman active and normal placement for the decoy.

## One bounded future Rune payoff

Warded Rune, Runes After Release and A Rune at Venom’s Cost must have a meaningful Rune direction. Either:

- An already-owned reachable Rune consumer exists for the recipient, including one made reachable by this proposed producer’s Rune output, or
- A supported **unowned run-talent consumer in this selected pool** is otherwise currently eligible after adding only the proposed producer’s Rune output

The second case reports both `FOLLOWUP_REQUIRED` and the explicit consumer definition IDs. It does not grant the consumer or claim immediate payoff. The followup must independently satisfy recipient, rank, prerequisites, exclusions, skill slots, Basic/talisman access and placement rules. Unowned permanent nodes are excluded because the run loadout is locked. There is no recursive future-card search, two-card future chain or mutual prerequisite justification.

## Medicine acquisition gap and candidate.2 repair

`juyao-chengquan` needs two Medicine while the holder actually equips cleanse plus heal. The previous candidate.1 `jingdan-shenghua` granted Medicine for 200 ticks. Qingxin’s base cooldown is 280 ticks plus its cast, so repeating that cleanse could not retain the first stack long enough to form two. The other ordinary Medicine engine requires the holder’s own poison and an allied consumer; Qingwu would occupy a third active slot in the cleanse/heal setup.

Consequently, the retained previous-catalog cleanse+heal witness is rejected with `MISSING_MEDICINE`. In addition, starter passive Medicinal Lore (`yaoli`) spends up to both Medicine stacks in its earlier paid-heal listener. Both new Medicine payoffs recheck payment after that spend. Merely lengthening Medicine does not make either payoff usable under that passive: `RESOURCE_PREEMPTED` reports the conflict.

### Approved new-catalog-only repair

The integration owner approved this narrowly scoped candidate-only change:

1. The new `jingdan-shenghua` effect duration changes from 200 to **400 ticks** (20 seconds). Its one-stack amount, 100-tick trigger cooldown and all frozen skills/statuses remain unchanged
2. That card’s Chinese `10秒药华` becomes `20秒药华`; English `1 Medicine for 10s` becomes `1 Medicine for 20s`
3. The opt-in combat content version becomes `0.2.0-release-candidate.2`, and candidate identity becomes `shanmen-release-v8-candidate.2`; fingerprints therefore change explicitly

No other talent definition or central locale was edited in this repair. A later player-facing integration should also surface the passive-slot tradeoff, for example: “药理会先耗药，需换用余息等不耗药被动” / “Medicinal Lore spends Medicine first; equip a non-spending passive such as Lingering Breath”. This is documented here rather than silently adding another content change outside the approved repair.

The actual build route uses ordinary training gear, no allocated tree points, and four earned study credits: two to learn Clear Mind (`qingxin`), two to learn Lingering Breath (`yuxi`). Both require knowledge of the already-known Verdant Mist (`qingwu`), which remains learned but **unequipped**. The final loadout is exactly Clear Mind + Spring Renewal + Lingering Breath. The permanent-build fixture supplies two legitimate milestone-rule facts through the existing authority API; it does not claim to complete those milestones in a World playthrough. Likewise, the ally’s initial 20 HP is an explicit injured-ally domain fixture, not a claimed prior campaign battle.

`medicine-repair-witness.test.ts` exercises real build learning/equip commands and two opt-in eligibility decisions. Its runtime then begins with no statuses and only those three equipped skills, installing the admitted run sources explicitly because the live dispatcher intentionally remains frozen. With 120 spirit and 15 attack from ordinary training gear:

- First paid Clear Mind commits at tick 12, giving one Medicine
- Second commits at tick 304 after its real cooldown/cast, retaining two Medicine only in the repaired catalog
- Paid Spring Renewal commits at tick 320; total spirit spent is 58, leaving 62
- The real field consumes both stacks and heals the wounded ally at ticks 340, 360 and 380; the ally moves from 20 HP to 51 HP through the direct heal plus three actual pulses
- The two-stack boundary survives serialize/restore; source cleanup is checked after the field expires

Negative runtime sequences use an explicitly retained previous-candidate.1 200-tick fixture, or use candidate.2 with the starter Medicinal Lore passive. Neither creates a field. The latter demonstrates the earlier passive payment instead of hiding the conflict with seeded stacks or extra active slots.

The old 200-tick definition exists only in the regression fixture. The 400-tick repair is now in the opt-in new catalog under candidate.2; it does not alter any frozen starter definition or activate live offers. Experimental executability and pure eligibility witnesses still do not establish full player-facing acquisition, so this module does not claim “47 playable cards.”

## Validation and next integration gates

`tests/release-eligibility/` contains an explicit matrix for all 36 additions, with ordinary equipped-skill capability fixtures under candidate.2 and a retained candidate.1 acquisition-gap negative. Additional cases exercise wrong holders, self/ally shields, distinct hostile targets, control immunity, direct/proc healing, missing spirit, source families, resource cycles, temporal stacks, one-followup limits, deaths/rebinds, rank/exclusion checks, context identity, short pools and frozen legacy RNG behavior.

The initial parent-run checkpoint passed both TypeScript projects and **68 combined eligibility/registry tests**. The second checkpoint passed both TypeScript projects and **67 eligibility/runtime-witness tests**, including the real learned-loadout Medicine sequence against a test-only 400-tick proposal. The candidate.2 checkpoint then passed both TypeScript projects and **159 eligibility/release/expedition/registry tests**. Boundary validation identified the pure local predicate helper’s name `require` as a prohibited CommonJS global; the helper and all its calls were renamed to `requireCapability`, without changing the checker or behavior.

**Final parent-run evidence, 2026-10-01 12:15 UTC:** the post-rename rerun passed core boundaries, the **908-key locale/content checks**, and **all 159 eligibility/release/expedition/registry tests**. The two TypeScript projects passed on the candidate.2 code immediately before the behavior-preserving helper rename. No additional typecheck or production-build result is claimed for this final documentation-only recording. Candidate.2 remains opt-in, with no World admission active. No independent dependency install, test execution, build or Git operation was performed by this worker.

Still required before player admission:

- Adapter construction and validation of the authoritative opportunity context and exact team anchors
- Versioned selected-catalog routing, frozen old offer algorithm and genuine save migration
- Separately versioned extra-target Stagger protocol; candidate.2’s Medicine repair has the focused validation recorded above
- Legal acquisition witnesses through actual build/run transactions, beyond these pure capability fixtures
- 10,000-seed generation, reroll/pity, casualty, restore and old-replay tests under the admitted new identity
- Normal-loadout campaign balance and actual UI/browser acceptance
