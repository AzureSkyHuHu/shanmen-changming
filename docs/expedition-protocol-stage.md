# Per-run content and expedition protocol stage

2026-10-01. This stage is additive: the running World remains v7. The registered run wrapper is not yet selected by its live dispatcher, and campaign claims are not yet activated.

## API and compatibility boundary

`core/expeditions/versioned.ts` exposes `RegisteredExpedition`, `pinLegacyExpedition`, `createRegisteredExpedition`, `restoreRegisteredExpedition`, `applyRegisteredExpeditionCommand`, `registeredTimeCheckpoint` and `registeredEligibility`.

Every wrapper retains a registry identity, route ID and explicit protocol. `legacy-v2` preserves the original inner schema2/expedition-2 state. `release-v3` uses a new inner schema3/expedition-3 state that also binds the selected identity. Registry identity includes the composite fingerprint and actual combat fingerprint; arbitrary caller catalogs and unknown identities are rejected.

`core/expeditions/legacy-v2` freezes the published v7 executable reducer, offer selection and replay path. Pinning an existing run validates that path and preserves its origin, offers, bindings, locks, RNG, receipts and counters. No inner content hash or version is relabeled. Existing run continuation selects this old protocol through Ended; new runs select the explicitly registered new protocol.

The independent v3 engine derives candidates through `release-eligibility-candidate.1`; weighted selection and guarantees remain deterministic and bounded. Unsupported `talent.zoumai-chengfu` extra-target Stagger is explicitly excluded and reported. No alternate damage effect substitutes for the missing control primitive.

## Derived encounter opportunities

The v3 context builder reads the registered upcoming encounter and actual locked living loadouts. It creates a detached runtime projection to obtain enemy control resistance and exact highest-value/shared-budget team-source anchors. It uses registered terrain, occupied cells, bounded cardinal reachability, actual equipped enemy control skills and real nearby summon placement. A cast interruption alone does not prove a timed `control.ended` opportunity.

These are conservative potential opportunities, not a second combat executor or a promised successful tactical sequence. Preview projection uses separate temporary runtime IDs/RNG and never advances the authoritative run, World IDs, supplies or controller. True battle results and death mappings remain World-owned.

## Captured failure and regression

The first focused run found a real error: a sword/body squad without any equipped talisman skill still attempted to install a `selectedTalisman` team card into the temporary runtime. The runtime correctly rejected that binding, which incorrectly failed the whole reward transaction.

The fix follows the actual executor contract:

- Search equipped active/passive skills for a live talisman recipient, rather than trusting `basic.school`
- Omit that card's source anchor if no legal recipient exists
- Treat that card alone as `NO_LIVING_RECIPIENT`; ordinary candidates remain available
- Continue requiring every other installable team-source anchor; malformed/ambiguous contexts still fail closed

Regressions cover an ordinary no-talisman three-choice offer, a forged talisman basic label with no talisman skill, preservation of normal candidates at the admission layer, and continued rejection when a required ordinary or legally bindable talisman anchor is missing.

## Validation evidence and remaining gates

The parent-run second focused check passed both TypeScript projects, core boundaries and **117 tests in the selected six files**. Existing genuine v7 active-battle, pending-offer and Ended fixtures retained their exact run values/source bytes; legacy reroll output matches the original executable behavior. New-protocol tests cover selected identity, deterministic restore, casualty re-evaluation, caller immutability, forged offers and unsupported cards. The separate UI suite passed31 tests. The parent has started the full tree check; its result is not preclaimed here.

Some new-protocol tests use explicit domain-adapter outcome fixtures to isolate offer/replay semantics. They do not claim a real controller-to-World campaign clear. Still required: v8 World/save migration, real battle and campaign settlement binding, atomic rewards/teaching/estate provenance, capacity obligations, player-facing Session activation, 10,000-seed offer acceptance and browser playthroughs. The original v7 automatic-work/save constraints remain in force.

父任务验证补充（14:56 UTC）：全量71文件1108项测试、970文案键及边界/内容校验通过。网络策略中止npm后续build时，使用现有依赖的离线模式单独通过类型检查和生产构建。未做浏览器验收。
