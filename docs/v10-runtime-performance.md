# v10 strict runtime performance baseline

2026-10-02 20:53 UTC. Root serial local Node24/Vite SSR measurement, no browser or parallel local tests/builds. Reproduce with `node tools/benchmark-v10-runtime.mjs`.

- Fresh four-disciple record-only lifted fixture; source validated by actual v10 full record root. This is not migration or imported-save authorization
- Three warmup steps, then20 measured strict single ticks; each result compared against the complete normal raw candidate outside the timed section
- p50 110.343ms, p95 147.349ms, maximum148.026ms; all results exactly equal
- This strict cold-boundary path exceeds a50ms 20Hz frame budget before rendering. It is a baseline blocker for activating player-facing v10, not a browser/phone/large-population performance verdict
- Correctness gate remains unchanged. Next optimize only private-owned redundant work or proved scalar idle transitions, retaining the strict path as differential oracle and untrusted-source admission
- Existing v9 public gameplay remains in place. No v10 performance or full-game acceptance claim

Private-owner baseline (same isolated source,21:24UTC):20 separate single-tick advances after3warmups, each checked against the full raw candidate with snapshot/oracle outside timing. Creation71.950ms; advance p50 128.578ms,p95 135.581ms,max152.443ms; all exact. Reproduce with `node tools/benchmark-v10-runtime.mjs --private`. This is the pre-idle-integration baseline, not optimized runtime performance.

Idle-integrated owner measurement21:40UTC: fresh20samples p50 .207ms,p95 .360ms,max.407ms,creation68.68ms,all exact. New `--active` scenario uses actual gather command and40 real setup ticks before sampling20 single ticks: p5099.577ms,p95123.274ms,max126.721ms,creation62.10ms,all exact. Neither fixture injects active work or resources. Active-work cost remains a blocker; browser and larger worlds are unmeasured.

Owned actual-tick leaf (not yet private-owner integration),22:17UTC:20 samples, real active gather, p5046.995ms,p9556.203ms,max56.336ms,capture32.381ms. Every result matches full raw candidates; retained cross-endpoint discharge comparisons are included. Reproduce `node tools/benchmark-v10-runtime.mjs --owned`. This still leaves insufficient 20Hz/rendering margin and does not resolve activation.

## 2026-10-02 22:47 UTC fixed-stage owned leaf

After sharing fixed stages inside the private factory while retaining full candidate capacity and all residual cross-boundary checks, 78 owned-tick/discharge/gate tests passed in 409.66s. A 20-sample real active-gather leaf benchmark measured p50 24.393ms, p95 26.163ms, max 26.791ms, initial capture 37.873ms; all candidate Worlds exactly matched the strict reducer. This is a private leaf measurement only. Actual runtime integration, UI frame cost, mixed L2 workloads, 36-person scale and phone/browser measurements remain outstanding. Public v10 activation is still blocked on integration and acceptance.

## 2026-10-02 23:16 UTC actual private owner integration

The actual owner now uses the checked ordinary active pipeline while preserving idle carry and strict normal-before-fallback recovery. Three integration/baseline suites passed 70 tests in508.77s. The same real active-gather 20-sample owner benchmark measured p50 25.652ms, p95 27.552ms, max 28.400ms; all complete Worlds equaled the strict oracle (exports and oracle outside timing). Warm final operation reports one owned tick and no repeated source/candidate replay counters. Initial creation remains62.510ms. This improves the measured single-gather owner budget; UI/projections, mixed upgraded-building workloads, 36-person and real browser/mobile acceptance remain separate and unverified.
