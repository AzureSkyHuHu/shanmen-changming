# Private strict v10 runtime owner

Status: source, targeted tests and this contract written on 2026-10-02. Execution remains with the integration owner. No test, typecheck, build, benchmark, codec registration, migration, UI, deployment or player-v10 claim is made here.

## Fixed facade and isolation

`createPrivateRuntimeV10(unknownSource)` creates a private long-lived owner exposing only `advance`, `command`, `snapshot`, `replace`, `invalidate`, `controlClock` and `close`. It is not re-exported by an engine, codec or application barrel. There are no input assessments, budgets, callback validators, trusted/frozen markers, ownership tokens, arbitrary selectors or v9 World adapters.

Creation and replacement capture the entire source with the existing bounded v10 descriptor traversal, run `assessManagementCapacityV10` (including the complete fixed v10 record root), check every actual dimension and run `inspectTeachingContinuationV10(world)`. Only the resulting private, deeply frozen data is retained. Ordinary accessors, repeated object references, cycles, hidden/symbol properties and invalid JSON are rejected without reading getters. Catch paths do not inspect a thrown object's prototype, message, stack or properties. Proxy reflection itself can still execute traps; this is not a universal Proxy detector or an atomic external snapshot against arbitrary trap side effects.

A fitting source reports `recoveryOnly: false`. A record-valid, actually within-limit source whose future obligations are deficient may be retained as `recoveryOnly: true`, provided finite teaching continuation is still supported. Every operation reports the current distinction, and every successful snapshot independently rederives it. A snapshot is an internal complete-boundary export, not save/import authorization. A future save-admission layer must reject recovery-only boundaries and independently enforce its own envelope contract.

Only the structurally generic existing `ownFrozenTree` helper is reused from the old implementation. No v9 runtime, idle proof, teaching assessment, version identity or whole-World cast is reused. All external captures and candidate/export copies use v10's stricter bounded descriptor capture. There is deliberately no archive-identity, external-freezing or cached-snapshot shortcut.

## Complete publication and strict candidate gate

Each `advance` call validates its complete starting source, including zero-step, paused and previously stopped reads. Steps must be integers in `[0, CAPACITY_LIMITED_V10_MAX_STEPS]` (currently 1200). This is a synchronous call-work bound, not a gameplay/teaching elapsed-time cap. Each unpaused tick prepares the real normal candidate, captures it and invokes the fixed complete `decisionV10` gate. The gate derives its own source/candidate capacity, finite teaching and exact real release/transition witnesses. Each accepted tick advances both actual clocks by one. There is no idle/caching fast path, caller proof or skip-month path.

If the normal candidate fails, a real no-optional-growth candidate is prepared from the same unchanged complete source and receives the same gate. Both failures retain the last complete accepted boundary and latch a typed safe-stop. No partial clock, resource, receipt, position, RNG, history, counter or domain tree is published. Accepted earlier ticks in the same batch remain committed. A stopped runtime does not retry ticking until a newly published command boundary or replacement clears its stop. Existing command preparation may legitimately persist a domain-rejection receipt; if that complete candidate passes the gate, it is a new published boundary and also clears the latch. Exact retries/conflicts and facade/no-write rejections do not clear it.

`command` descriptor-captures unknown input and uses the existing fixed v10 command preparation. Exact retries, command-ID conflicts and other no-write results preserve the old root, stop and counters; their results are separately captured/frozen. New candidate state must pass the same complete gate. A capacity refusal returns the existing command-level refusal without publishing its candidate or a diagnostic receipt. Admitted new state/result are captured and frozen before the complete publication, including an existing-domain rejected result that legitimately records a new receipt. The facade-level `ok` reports successful operation handling; a handled domain/capacity refusal can still have `ok: true` with a rejected `result` and `published: false`.

## Snapshots, replacement and lifetime counters

- `snapshot` always creates a detached copy and fully revalidates that actual copy, including finite teaching. It returns a deeply frozen World plus current `recoveryOnly`, stamp and stop. Every successful call returns a new independent snapshot. Failed export leaves the root, counters, stop and open state unchanged
- `replace` prepares its complete independent source and return envelope before assignment. Failure leaves the prior root, recovery classification, safe-stop and both counters unchanged. Success clears the stop, increments both generation and publication and adopts only the detached source
- `invalidate` increments generation only. It leaves the complete World and stop unchanged. This version has no retained capacity/idle certificates or export cache to reuse; subsequent operations still perform their strict checks
- `close` increments generation, drops the private root and stop and reports `recoveryOnly: null`. It performs no cancellation, save or other domain action. All later methods explicitly return `closed`, without reflecting over caller arguments. Prior detached snapshots remain valid independent objects

Generation starts at 1 and publication at 0. Each admitted new command boundary (including a legitimate recorded domain rejection), fixed tick or changed clock control increments publication once. Replacement increments both; invalidation/close increment generation only. No-op controls, snapshots, retries, conflicts and rejected operations do not publish. Safe-integer exhaustion is checked before changing a counter. These stamps describe this owner's lifetime only and cannot be transferred as authority.

Every method rejects reentrant calls before input reflection or coercion. Busy state is restored in `finally`; methods use closures and do not trust `this`. Even a hostile Proxy trap cannot call `close`, `replace`, `invalidate`, `snapshot`, `command`, `advance` or `controlClock` while an operation is preparing its input.

## Narrow clock control

`controlClock` accepts only exact `{kind: 'speed', speed: 1|3}` or `{kind: 'pause', reason: 'player'|'hidden', paused: boolean}` data. It preserves actual ticks, mode, domain-owned pauses and their existing order, RNG, IDs, receipts and every non-clock field. A no-op does not publish. Domain pause removal, extra fields and arbitrary clock edits are rejected.

Clock-only controls use fresh complete source/candidate checks and finite teaching inspection. They are a separately fixed control construction, not a domain command/tick witness and not an arbitrary candidate bypass. They discharge no owner. Recovery-only controls may preserve or reduce every deficient dimension; adding a pause cannot increase an already deficient wire dimension. Clock controls preserve an existing safe-stop even when a changed clock is accepted, so adjusting speed or removing player pause cannot bypass a capacity stop.

## Metrics and test scope

`sourceChecks`, `candidateChecks`, `normalCandidates`, `noOptionalCandidates` and `exports` count only outer owner operations. Nested record validators, capacity queries, teaching recovery trials and reducer witness replays are excluded. No `fullQueries`, fast-path count, total-cost claim, 20 Hz/3× claim, 36-person claim, mobile claim or general performance acceptance follows from these counters. Profiling must occur separately before player integration.

`tests/sect-expansion/v10-runtime-instance.test.ts` covers strict-gate differential calls; publication/generation; source/result/snapshot mutation isolation; failed replacement; recovery-only safe-stop and genuine cancellation; repeat/conflict priority; narrow clock controls; closed/reentrant and hostile/reflection/error cases; actual oversize rejection; and snapshot export failure.

Real earned alchemy/herbal fixtures exercise half-consumed upgrade cancellation after snapshot reconstruction and the actual 399→400 upgrade completion, retaining immutable L1 construction history and idempotent receipts. Old earned history is an explicitly labelled record-test lift with base-stock fixture funding, not a migration or acquisition claim.

Teaching tests start from an explicitly lawful within-month initial condition, execute real first-month crossing ticks through the owner, export/reconstruct, and compare short continuations with the fixed strict gate. The intervening ticks to the final-month checkpoint are executed by actual v10 candidate preparations as fixture setup, then the owner performs genuine final-month settlement, export/reconstruction and a no-double-award continuation. This deliberately targets owner boundary/continuation behavior; it does not duplicate the separate teaching module's full 2400-tick owner-free proof or claim a complete two-month run through this retained owner.

The file owner did not run tests, type checking, builds, Git commands, browsers, deployments or other workers. The integration owner must append actual execution results and remaining limitations.

## First integration feedback and fixture corrections

The integration owner reported 20/24 tests passing in 109.84s on the first isolated run, including genuine upgrade and teaching crossings. Two readonly fixture assignments were changed to immutable record replacement after the separate typecheck. The two numeric-pressure cases actually throw from real candidate record preparation: construction revision MAX−1 increments to MAX, then the pending blueprint still requires one cancellation revision. Tests now prove both preparation throws and the fixed gate's invalid-records classification; production catches remain unchanged. Separate real wire-deficit cases cover a produced-but-capacity-refused candidate, safe-stop, rejected deficit-growing pause and genuine cancellation.

The other two failures came from Vitest's spy wrapper inspecting the thrown Proxy with instanceof before the owner received it. The tests now inject through plain module-factory forwarding functions instead of spy-wrapped throws, so the exact hostile object reaches the owner and every prototype/property read must remain zero. Same-source successful fallback and preservation of an earlier accepted tick were also added. These corrections and additions await the integration owner's rerun; the first run is not described as fully passing.

Second integration feedback: the corrected combined run passed all 23 headless-codec and 25 quiet-migration tests, plus 26/27 owner tests (owner file 131.441s; combined 309.25s). The remaining owner fixture assumed that a decimal tick boundary grows total wire cost, but the actual complete query reported decreasing future reserve. It now uses a root-valid empty-construction counter boundary: the first genuine tick reaches MAX with no outstanding cancellation owner, remains fully assessed/fitting, and the next real normal/fallback preparations exhaust the counter. The assertion still requires retaining exactly the previously accepted full boundary; no capacity formula, gate or runtime behavior was changed. This final fixture change awaits the integration owner's rerun.

## 集成证据：2026-10-02 21:22 UTC

最终27/27运行实例测试通过127.95秒。修正测试中Vitest包装器的instanceof干扰后，真实敌意异常属性/原型读取仍为0；数值溢出边界按真实固定预备失败分类。 双类型、边界、1205中文键、内容及默认构建通过。上述定向证据不代表全仓CI、公开v10、真机或完整游戏验收；性能仍待实际运行实例优化后重测。
