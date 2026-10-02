# v10 strict runtime performance baseline

2026-10-02 20:53 UTC. Root serial local Node24/Vite SSR measurement, no browser or parallel local tests/builds. Reproduce with `node tools/benchmark-v10-runtime.mjs`.

- Fresh four-disciple record-only lifted fixture; source validated by actual v10 full record root. This is not migration or imported-save authorization
- Three warmup steps, then20 measured strict single ticks; each result compared against the complete normal raw candidate outside the timed section
- p50 110.343ms, p95 147.349ms, maximum148.026ms; all results exactly equal
- This strict cold-boundary path exceeds a50ms 20Hz frame budget before rendering. It is a baseline blocker for activating player-facing v10, not a browser/phone/large-population performance verdict
- Correctness gate remains unchanged. Next optimize only private-owned redundant work or proved scalar idle transitions, retaining the strict path as differential oracle and untrusted-source admission
- Existing v9 public gameplay remains in place. No v10 performance or full-game acceptance claim
