# Serial regression job headroom

2026-10-02: validated run 37052582069 at commit
3296235769b92b57db66748c38eff27e0eb542cc completed successfully.
Its validation job ran from 19:13:05 to 19:32:26 UTC (19 minutes 21 seconds);
158 test files took 1128.72 seconds before both successful builds and artifact upload.

The next internal v10 consumer/evidence stage adds four focused suites (72 tests).
The previous 20-minute job ceiling leaves insufficient runner-variance margin as
the full serial suite grows. The validation job ceiling is therefore 30 minutes.

No tests, assertions, individual test timeouts, validation steps, serial execution,
deployment gates, workflow permissions, pinned dependencies or artifact checks are
removed or relaxed. The deployment job remains unchanged. Long silent work still
requires diagnosis; this is not permission to ignore stalled execution.
