# Release build catalog candidate

Status: authored candidate, 2026-10-01. **Not admitted into the live game.** This is not a balance certification, a v8 migration, or browser acceptance. Parent integration owner runs all tests/builds. Frozen definitions, World, registry, schemas and runtime remain unmodified by this slice.

## Composition and versions

`src/content/release/index.ts` is the only composition point. `releaseCombatCatalog` copies the frozen 12 talents and adds 36, producing four 12-card builds. Original skill/status/talent definitions remain byte-identical. Candidate-only starter recommendations add real supporting skills rather than inventing producers. A recommendation is a party/loadout menu, never permission to equip more than two actives and one passive on a disciple.

`releaseCatalogIdentity` fingerprints the candidate combat catalog together with existing and campaign equipment, lessons, knowledge, routes, enemies, recruit rules and recovery costs. Campaign content is imported from its one authoritative domain module; no second combat catalog or gear mechanics fork is created. This composite identity is a proposed admission identity, not a replacement for the current build-state fingerprint. Explicit build-rules/save migration must adopt it before use.

The complete schema contract is preserved: 36 personal / 12 team cards; 12 general / 24 school / 8 cross-school / 4 route cards. Functional category is independent of core/support/bridge offer role. Each build adds three of each offer role. The existing eight cross-school category entries remain unchanged. New general entries are reusable shield/heal/control/Guard/emergency tools; their bridge roles can still support a named build. The four route responses are Three-Mark Interruption (telegraphed casts), Medicine Clears the Veins (poison attrition), Ember Cup (stationary packs), and Long-Reach Inscription (separated ranged opponents). These are counterplay categories, not fabricated route-specific unlocks.

All 36 new cards are executable by the experimental runtime's existing primitives. Advanced field/decoy definitions remain explicitly uncertified in metadata. No card adds an unconditional flat-stat modifier, changes a skill's live definition, or uses callback/string execution.

## Gates before release admission

1. The live `AUTHORED_TALENT_IDS` intentionally still lists 12. New cards cannot enter ordinary offers even if someone passes the candidate catalog. Versioned admission and genuine save migration are required; this module does not evade the gate.
2. **47/48 candidate talents are currently experimentally supported**, not 48. Frozen `talent.zoumai-chengfu` still has unsupported `additionalChainTargets.staggerTicks: 16`. Its recommended override is separate proposal data, not an installed adjustment. The intended effect is finite **Stagger on extra targets**, never a projectile delay. See the next-protocol decision in `advanced-combat-implementation.md`: explicit `extraTargetStatus`, explicit link range, one captured recipient list, synchronous paired programs, original root/proc budgets, tenacity and lethal-hit skip, plus a genuine old-catalog migration fixture. The parent schedules the runtime protocol separately.
3. The current generic offer checker does not prove every cross-holder condition. Before admission, pair prerequisites and recipient suitability must be exercised against the versioned release offer rules. In particular, Ward to Edge needs a shield caster plus a mark-applying sword skill; Warded Rune needs a reachable allied shield recipient; rotation needs the indicated number of schools. Do not infer those conditions solely from a category label or generated description.
4. Ten-thousand-seed legal offers, attrition/survivor adaptation, mixed-build win rates, ordinary-loadout completion, balance, UI presentation and full campaign browser playthrough are outstanding. Authored count and runtime tests do not establish these results.

## Ownership, limits and payments

- Every card is run-only and rank 1. Shields, statuses, summons and fields remain encounter-limited; charges are finite-use, finite-duration children of the run source. Uninstall/run cleanup removes the owned effects.
- Team cards use the existing highest-value source and shared budget. Installing a second same-name source or losing its first holder does not refresh the budget.
- Every trigger is once per original root; default cap is 24 activations per encounter. Cast recording is capped at 120, distinct-school rewards at 24. Both limits are included in the bilingual descriptions. Emergency survival and team rescue each have a one-use encounter cap.
- Personal triggers listen to the owner except when explicitly watching allies. Team effects use team scope. The bound Rune bridge affects one selected talisman disciple only.
- Direct-only healing and shield reactions do not accept arbitrary proc families. The allowed families are named narrowly: force releases, the card's own cast recorder, the poison payment, and `status-expiry` for real control expiration. No family opts into itself.
- Benefits paid with Medicine/Runes recheck the resource immediately before applying the benefit; another queued card can spend it first. Consumption-scaled damage/healing use the actual consumed result. Poison-for-Rune uses a second listener on the real successful consumption event, so competing consumers cannot generate a free Rune.
- Basic attacks and Guard commands are intrinsic actor commands. They are kept as real event conditions, not fictitious skill-source tags. Specialized producers/consumers remain genuine existing skills and statuses.
- Last Stand leaves 8% health and imposes 40 ticks of self-Stagger, reduced by tenacity. Armor-Bond Rescue requires the holder above 50% health, restores another newly downed ally to 10%, gives it a 40-tick recovery lock, and imposes self-Stagger. It cannot resurrect a permanent death. Neither ability is repeatable within the encounter.

## Four build expansions

Names below match stable bilingual content keys; the source rows carry the complete numbers and descriptions.

### 回潮剑阵 / Returning Tide Sword Array

Actual core: 留痕剑 / Inscribing Sword and 归锋 / Returning Edge. Body shield and Stagger, plus a talisman with 引雷 and 符脉, are obtainable support choices. No single disciple is expected to equip all recommendations.

- Engines: 开刃留痕 / Opening Inscription adds a mark only against initially unmarked targets; 定锋双痕 / Pinned Twin Marks uses a real control window; 护剑接力 / Ward to Edge converts an allied paid shield cast into a one-use mark application charge
- Payoffs: 破阵断流 / Three-Mark Interruption requires a full three-mark spend; 折潮护身 / Returning Tide Ward creates a brief defensive window; 借痕续命 / Spend a Mark to Mend sacrifices burst stacks when the holder is hurt
- Bridges: 剑火同炉 / Edge Feeds the Furnace leaves poison after a full mark spend; 剑纹回流 / Marks Return as Runes feeds one bound talisman; 贯锋引雷 / Shock-Forged Edge consumes Shock for a piercing, noncritical basic follow-up and removes the old armor debuff

Tradeoffs: mark consumption competes with burst; applying a charge to a sword skill without a mark effect wastes the charge; missing focus or dead targets can waste bridges. Frequent cleanses or target switches break full-stack payoffs.

### 药火共炉 / Medicine and Fire Furnace

Actual starter engine: 青雾 / Verdant Mist, 焚瘴 / Miasma Ignition and 温药余性. 净心 is a learnable alternative Medicine producer. The two Medicine-spending heal variants explicitly depend on the new cleanse producer, so they are not offered as self-starting effects.

- Engines: 以药续毒 / Medicine into Venom sacrifices healing reserves; 毒后回根 / Venom Returns to the Root requires another caster to consume poison owned by the holder; 净丹生华 / Cleansing Distillate pays an active slot and spirit to make Medicine
- Payoffs: 药华净脉 / Medicine Clears the Veins spends one stack to remove poison; 聚药成泉 / Gathered-Medicine Spring spends two for a fixed three-pulse healing field; 烬火留盏 / Ember Cup rewards a full detonation with a fixed three-pulse fire field
- Bridges: 余盈护灯 / Overflow Lantern converts direct overheal into a capped same-source ward; 活脉疏剑 / Healing Guides the Edge needs actual effective direct healing and a focus target; 渡毒成纹 / Venom Becomes a Rune requires at least two consumed poison stacks

Tradeoffs: Medicine cannot be spent twice; the first queued spending source wins. Moving away leaves anchored fields behind. Proc healing cannot create another conversion chain. Low-stack detonations do not earn full-stack payoffs.

### 玄甲回响 / Dark Armor Echo

Actual starter engine: 抱岳 / Mountain Embrace, 蓄劲 / Stored Force and 返震. No damage is banked from empty shields, shield expiry or self-harm.

- Engines: 碎甲回息 / Breath from Broken Armor restores spirit only on real enemy shield break; 定步凝石 / Stone After the Stumble grants a short ward when control ends; 守御留阵 / Guarding Footing needs a timed Guard command
- Payoffs: 藏劲断喝 / Stored-Force Shout adds tenacity-resisted control after a real release; 藏劲养脉 / Force Mends a Companion cannot self-heal; 破釜守元 / Last Stand, Heavy Breath is a once-per-encounter emergency with self-control cost
- Bridges: 同甲救援 / Armor-Bond Rescue is a single shared team intervention; 盾甲润生 / Absorption Nourishes Life uses actual absorbed units with a health-based cap; 护阵点锋 / Guard Marks the Opening feeds a short-lived focused burst window

Tradeoffs: protection is temporary; spending the emergency budget early leaves later lethal hits dangerous. The rescue holder must be healthy and alive. Reactive cards do not increase unopposed damage and cannot create Force without exposure.

### 三曜流转 / Three Lights Rotation

Actual starter engine: 符脉 with 引雷/焚瘴 plus sword and healing allies. Learnable 援护 can shield the talisman disciple. All recording uses paid committed actives, not basic attacks, chain jumps, canceled windups or free derived programs.

- Engines: 护符养纹 / Warded Rune needs a shield still present at commitment; 解封清纹 / Runes After Release trades enduring control for a short reserve; 两仪结纹 / Two Schools Weave Runes checks two distinct schools in the last three casts of a five-second window
- Payoffs: 断纹截咒 / Rune-Breaking Interruption can waste its payment against idle enemies; 展纹远书 / Long-Reach Inscription spends two Runes for a single later positioning advantage; 三转纸身 / Three-Rune Paper Body spends three for a four-second decoy and shares the caster's one-decoy cap
- Bridges: 异法护灯 / Rotating Healer Ward protects the new healer only when caster identity changes; 三曜净阵 / Three-School Cleansing Array needs three distinct schools in six seconds and nearby allies; 蚀毒起纹 / A Rune at Venom's Cost consumes poison that could otherwise fuel a detonation

Tradeoffs: Rune spenders compete, movement can outrun short charges, and a decoy can fail in an occupied arena. Same-school spam cannot complete the cleanse. Losing a required ally reduces the available rotation rather than creating phantom casts.

## Test evidence and remaining work

`tests/release-content/catalog.test.ts` checks exact distribution, strict schema/capability/localization, real lesson references, ownership limits, unchanged original definitions and the still-frozen admission gate.

`tests/release-content/execution.test.ts` contains an observable runtime scenario for every new card, serialized restore plus run cleanup, irrelevant-action negatives, real starter-skill Medicine/Force/rotation chains, competing Medicine payments, shared-team failover budgets, one-use survival/rescue, invalid rotations and a direct-healing loop negative. Primitive-focused scenarios seed statuses through executable fixture spells; they do not forge combat events. The independent starter chains use actual game skills without seeded marks/Medicine/Force/Runes.

First parent-run snapshot: 101/104 focused tests passed; validation exposed full-catalog distribution/starter obligations, two omitted `status-expiry` family allowlists, and narrow TypeScript helper types. Those failures prompted corrections rather than validator weakening. Second parent-run snapshot: both strict TypeScript projects and all **112 focused tests passed** (46 release execution, 6 release catalog, plus baseline content/offers) in the isolated verified-v5 + campaign/history validation tree. This is the validated release slice, not an aggregate pass for concurrently changing World/save integration. After that pass, the parent approved proposal-only identity labels moving from v7 to v8 and this documentation expanded the future admission contract. That final metadata/documentation delta has **not** been rerun under the earlier 112-test evidence; combat definitions and their catalog/composite hashes are unchanged. No release, balance or browser pass is claimed here.


## Proposed versioned offer-admission contract

This is a handoff specification, not a new live admission implementation. The integration target is the parent's future v8 release slice. The proposal-only identity labels now name v8; final runtime protocol numbering is chosen during integration. Admission must read the selected versioned catalog rather than a hardcoded frozen-ID list, while old snapshots continue to validate against their original identity.

### Derive truthful capability facts

For each living disciple, inspect only equipped active/passive skills, effective permanent nodes and already owned supported run talents. Resolve exact status IDs, target teams/selectors and effect families, not just display tags. Basic and Guard are intrinsic commands. A consumed-only poison tag is not a poison producer; a generic lightning damage tag is not proof of Shock; a conditional output is not an unconditional starter. Build a bounded dependency graph and require an externally reachable producer before following a same-resource cycle. Dead sources and inactive bound holders do not supply facts.

Run admission again after casualties, explicit rebinds and any supported loadout change. Preserve already granted cards but suppress newly useless offers. Do not replace an unavailable prerequisite with fabricated tags or secretly change the selected recipient.

### Exact additional predicates for the 36 additions

Apply ordinary rank, symmetric exclusion, supported-definition and explicit prerequisite checks first. Then:

1. **Sword production/spending:** `kairen-liuhen` requires a paid sword active targeting enemies; `pochen-duanliu`, `zhechao-hushen` and `jianhuo-tonglu` require an owned paid active consuming the indicated 2/3 Sword Marks plus a living reachable mark producer. `jiehen-xuming` requires a hostile mark producer reachable by this holder's Basic. The low-health condition is a combat-state opportunity, not a permanent offer exclusion.
2. **Control and allied shield windows:** `dingfeng-shuanghen` requires a living allied Stagger producer and an ally able to Basic the same hostile target. `hujian-jieli` requires the recipient to own a paid sword active that actually applies Sword Mark (currently `liuhen-jian`) and a living ally with a paid shield active. `hufu-yangwen` requires a paid talisman active, a Rune route, and an ally-targeted shield that can reach the holder (`yuanhu`/`budong-shan`, a compatible team shield, or a genuine self-shield source); another disciple's self-only `baoyue` is insufficient.
3. **Bound/full-mark Rune bridge:** `jianwen-huiliu` requires a living selected talisman recipient, an allied paid three-mark consumer and a reachable mark producer. Its source remains one shared team instance with explicit binding.
4. **Shock payment:** `guanfeng-yinlei` requires a real reachable `status.shock` producer and a basic attacker who can reach that target. Lightning-only damage does not prove this input. Mark generation or rune generation alone does not prove it either.
5. **Medicine:** `yiyao-xudu` requires its same-holder `wenyao-yuxing`, own poison application, another living paid poison consumer, and Basic access. `jingdan-shenghua` requires an owned paid `cleanse` active. `yaohua-jingmai` and `juyao-chengquan` require their same-holder `jingdan-shenghua`, a paid cleanse active and a paid heal active within the real two-active-slot limit. A passive `yaoli` label by itself is not a Medicine producer. Competing Medicine spends remain legitimate choices, with the documented opportunity cost.
6. **Owned poison and detonations:** `duhou-huigen` requires the holder's real poison application and another living paid poison consumer. `jinhuo-liuzhan` and `dudu-chengwen` require the holder's own paid poison consumer plus a reachable living producer capable of reaching the required stack count before expiry. `shidu-qiwen` requires a reachable poison producer, Basic access and a Rune-spending direction; its own consume-and-convert program is not evidence of an independent poison starter.
7. **Healing inputs:** `yuying-hudeng` requires an owned direct heal; `huomai-shujian` requires an allied direct heal plus a reachable Sword Mark consumer/focus target. `yifa-hudeng` requires a paid healing active and at least one other living paid caster. A proc-only healing source cannot qualify any of these direct/paid predicates.
8. **Shield inputs:** `suijia-huixi` and `dunjia-runsheng` require a shield that can actually be applied to their holder. An ally's self-only shield is insufficient. Incoming hostile direct damage is a route encounter fact. Shield expiry is never a qualifying source. `shouyu-liuzhen` requires a legal Guard recipient; `huzhen-dianfeng` additionally needs a reachable mark consumer and legal focus. `tongjia-jiuyuan` requires another living disciple whose defeat rule permits Downed; immediate permanent-death units are not rescue recipients.
9. **Stored Force:** `cangjin-duanhe` and `cangjin-yangmai` require same-holder `fanzhen`, a real owned Force producer (such as `xujin`), a shield that can reach the holder, and hostile direct damage. The healing variant also requires another living ally. A label or an empty release action is insufficient.
10. **Control recovery and emergency:** `dingbu-ningshi` and `jiefeng-qingwen` are useful when the upcoming encounter contains control, or a deliberate owned self-control source exists; Rune recovery additionally needs a Rune payoff. `pofu-shouyuan` needs no school-specific capability. Neither a previous encounter's spent emergency charge nor an expired temporary status can be counted as a current producer.
11. **Rotation/payoffs:** `liangyi-jiewen` needs living paid casters spanning at least two schools, and `sanyao-jingzhen` at least three, with cast times/cooldowns making the 5s/6s window feasible. `duanwen-jiezhou`, `zhanwen-yuanshu` and `sanzhuan-zhishen` need an owned reachable Rune producer; the latter two also require an owned paid talisman active. The decoy payment needs a route/arena that can normally offer a free placement, while temporary full occupancy remains a valid in-battle failure risk.

### Required admission regression matrix

- All four real two-active/one-passive starter squads; the learnable cleanse+heal variant; legitimate unlock/point budgets
- Single survivor, missing healer/body/talisman, dead selected recipient, duplicate-school squads, missing poison applier vs missing consumer, ally-self-shield vs ally-targeted shield
- Trait combinations that consume the same resource, conditional-producer cycles, consumed-only fake source tags, direct-only listeners with proc-only producers
- All 47 supported candidates should have at least one executable legal witness; the legacy Stagger card must remain excluded until the explicit protocol migration passes
- At least 10,000 offer seeds using the migrated identity: unique legal options, pity/bridge guarantees only when possible, transparent short pools, stable replays and casualty re-evaluation

### Separate extra-target Stagger protocol gate

The proposal preserves the frozen card and localizes the next protocol change: replace only its ambiguous additional-chain adjustment with `additionalTargets: 1`, `linkRangeUnits: 600`, and `extraTargetStatus: { statusId: 'status.stagger', durationTicks: 16, stacks: 1 }`. Compile neither proposal data nor old `staggerTicks` into a delay. Admission remains blocked until the runtime owns the explicit structure, strict schema validation and genuine previous-catalog migration.

Runtime acceptance must prove: one captured deterministic extra-recipient list, paired effect order, no duplicate recipient, bonus Stagger only on extra targets and only once, tenacity including full resistance, lethal-hit status skip, correct applier/source identity, one paid-cast/root event, shared root/ICD bounds, consumed augment count, nested retaliation/caster death, and unchanged old-save bytes until explicit save. No delayed-hit queue or presentation timing is part of this mechanic.

集成者最终整树验证（2026-10-01 10:27 UTC）：v6基线与本候选目录共45文件767测试通过，两个TypeScript项目、模块边界、现行内容校验与生产构建通过，包含最终v8提案标签。候选目录仍未接入玩家机缘池；当前线上目录仍12项，额外目标失衡与跨成员可用性仍为发布门槛。测试数量不等于48项已开放。
