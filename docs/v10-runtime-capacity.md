# Fixed internal v10 complete-candidate capacity gate

Status: implementation and test cases written on 2026-10-02. Execution belongs to the integration owner; this document does not claim a passing test run, public v10 runtime, codec, migration, Session, UI, deployment or performance acceptance.

## Fixed boundaries

- `verifyCapacityLimitedCandidateV10(before, after)` checks actual complete v10 Worlds. Both are descriptor-captured into detached owned data before semantic reads. It internally derives both fixed `assessManagementCapacityV10` queries; callers cannot supply an assessment, byte count, budget, validator, policy, release flag or teaching exemption
- `dispatchCapacityLimitedCommandV10(world, unknownCommand)` captures the World and command, invokes the existing fixed v10 command preparation, and publishes a new result only after complete candidate admission
- `advanceCapacityLimitedTicksV10(world, steps, immediateCommands)` captures the entire source and command list before any command execution, sorts commands by issued tick, sequence, command ID and canonical tie-breaker, and advances actual single-tick candidates. It returns the last complete published boundary plus ephemeral command results, stop details and two candidate-attempt counters
- `CAPACITY_LIMITED_V10_MAX_STEPS` is 1200. An invalid, fractional, negative, nonfinite or larger count returns the original boundary with `invalid-records`, before processing commands. This is a synchronous per-call work bound, not a gameplay elapsed-time cap; callers may continue in bounded segments

The new modules are internal imports only. They do not enter a public barrel, create a retained runtime instance, replace any old v9 API, change simulation content or authorize an import/save. In particular, a successful candidate check does not turn the structural assessment's `admitted`, `importAuthorized`, `eventualCompletionSupported`, `fullyFundedContinuation` or `terminalDischargeProved` fields into true.

## Admission sequence

1. Capture each complete actual World using the fixed v10 descriptor traversal and derive fresh structural assessments. Reject either unsupported source
2. Check every current dimension on both boundaries, including actual full-envelope bytes and the independent reader/record/numeric ceilings. A recovery cannot start from or create an actually over-limit boundary
3. When either World contains teaching, independently inspect its fixed finite continuation route. Verify the complete actual teaching-bearing transition, including stable lesson ownership, knowledge/provenance and real reducer cleanup
4. Require the fixed `inspectReservedDischargesV10(before, after)` proof for every candidate, including otherwise fitting ordinary candidates. Its exact complete command/single-tick replay must match all domains, resources, paths, RNG, clocks and history. Two separately fitting Worlds do not by themselves establish a transition
5. If the complete candidate fits every enumerated current-plus-reserved dimension, accept it as `ordinary`
6. Otherwise compare all prior/candidate deficits using exact integer operands. No deficient dimension may grow. Require at least one real existing owner discharge, with complete retained terminal, paired-ledger, receipt/history and lifecycle evidence, before accepting `reserved-recovery`

The result's assessment and string lists are fresh diagnostics, never reusable authority. Mutating one cannot affect later checks. An unchanged fully fitting World can satisfy the identity boundary; an unchanged deficient World has no discharge and cannot obtain recovery admission. Real cancelled/completed rows remain measured; their disappearance is not a byte credit.

An ordinary candidate with an invalid complete transition receives `unsupported-transition` / `SAVE_OBLIGATION_UNBOUNDED`. Unsupported teaching receives `unsupported-continuation` / `UNSUPPORTED_CONTINUATION`. A genuine candidate that lacks future capacity receives `future-capacity` / `SAVE_CAPACITY_EXCEEDED`. Malformed capture or a failed fixed proof is caught without reading a caught object's prototype, message, stack or other properties.

## Retry and atomicity behavior

Command preparation preserves the original record-boundary retry/conflict behavior. An exact receipt retry or a command-ID conflict returns the original supplied World identity before new capacity admission; reduced future headroom does not manufacture a second receipt or reject an already committed command. This requires the existing supported complete records and bounded capture. It does not admit a malformed source or an unregistered command family.

Every capacity/capture-refused dispatch returns the exact supplied boundary. A legitimate domain rejection can retain its existing recorded receipt behavior, but that complete candidate must itself pass capacity admission before publication. Accepted new candidates own their data and do not alias the external World or command. No input is frozen, persisted or cached across calls. An advance call owns its own snapshot; a stopped tick returns the last fully admitted command/tick boundary, which may be later than the original source if earlier commands were published. Capacity failure never publishes a diagnostic row or a partial rejection receipt.

Each unpaused tick first prepares the normal funded order. Only if that complete candidate fails preparation or admission does the gate prepare a no-optional-growth candidate from the same unchanged complete source. It never continues from a partial normal result. The latter skips only the existing optional automatic starts and maintenance renewals; it preserves settings, already-paid work, lifecycle handling and the real clock order. Both paths receive the same complete fixed candidate checks.

The `metrics.normalCandidates` and `metrics.noOptionalCandidates` values count only these outer preparation attempts. Exact witness replays, teaching route trials, capacity queries and source captures are excluded. There is deliberately no `fullQueries` count that could be mistaken for total execution cost, and no idle fast path or 20 Hz claim.

Existing pause reasons are preserved. `stopped` is an ephemeral result, not a new stored World flag or a retained stop latch. A future private runtime/Session must define its own stop ownership and save/export rules; this pure baseline does not claim to implement them. Arbitrary blocked work, unlimited waiting, optional future commands and maintenance renewal forever remain outside the finite proof.

Descriptor capture rejects ordinary getters, non-JSON data, repeated references and cycles before semantic reads. It preserves the established limitation: hostile Proxy reflection itself can execute traps, so this is not a universal Proxy detector or an atomic snapshot against arbitrary trap side effects. Returned original World references on refusal remain caller-owned.

## Test intent

`tests/sect-expansion/v10-runtime-capacity.test.ts` covers:

- Whole-envelope exact candidate equality and one additional byte, with no receipt/ID/resource/RNG leakage on refusal
- Separately fitting unrelated Worlds and a genuine candidate spliced with a valid-shaped RNG change
- Fresh, nontransferable diagnostics and genuine sequential cancellations while future headroom remains deficient
- Planned-owner transfer and ordinary receipt creation failing to masquerade as discharge
- Last-event manual cancellation, original-boundary exact retries and conflicting command IDs under reduced headroom
- Genuine production completion refused when the unrelated planned-construction future revision deficit would grow, despite an authentic owner discharge
- True same-source normal/no-optional automatic-work fallback, both-path failure, and preservation of a previously accepted command boundary
- Deterministic immediate-command sorting, bounded segmented advancement, frozen inputs, output isolation and mutation of the caller after return
- Pause preservation and invalid/excessive step rejection before any command
- Ordinary getters, repeated references, hostile thrown objects, wrong identities and forbidden persisted queues
- Supported teaching advancement, rejection of forged teaching-bearing transitions and one-short finite revision funding
- Actual herbal research, a genuine L1→L2 upgrade start, 200-work-tick half-consumption cancellation, 399→400 completion and forged cancellation splices

Old v9 history used in the last group is explicitly an earned-record test lift with existing base-stock fixture funding. New herbal research and upgrade work use actual v10 preparations; no migrated save or public route is implied. Fixture setup does not count as runtime capacity/performance acceptance.

No tests, builds, Git operations, deployments, browsers or child agents were run by this file owner. The integration owner must append the exact checks and limitations after executing them.

## 集成复验：2026-10-02 20:51 UTC

最终20/20定向检查通过110.78秒，双类型、模块边界和默认构建通过；独立只读审阅未发现实质问题。首轮4项大封包正确性检查超过新测试默认5秒，改为本文件固定30秒预算；另1项把完成工时误作实际送仓，修正为真实AwaitingDelivery边界后再施加计数压力。没有修改准入算法或削弱断言。教学57项及解除义务14项已在此前合跑中通过。以上不代表全仓CI、运行时性能、新v10浏览器或完整游戏验收。
