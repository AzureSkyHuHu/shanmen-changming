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

## 2026-10-02 21:07 UTC follow-on headroom

Run37059900215 at73ee8dfb578edd822934f7b21f32f2fa32d47816 passed167 files/3348 tests in1299.18s, then both builds and deployment. Subsequent serial capacity fixtures measured102.60s; new teaching/discharge/gate combined fixtures393.56s (later gate corrections separately20/20 pass110.78s). Those measured additions bring the expected serial duration close to or beyond30 minutes before runner variance and subsequent owner/codec fixtures.

The validation job ceiling is40 minutes for these added real-reducer/save-continuation regressions. No test removal, assertion change, parallel execution, workflow permission change or deployment gate relaxation is part of this job-level change; deploy remains15 minutes. Some newly introduced long full-envelope correctness cases have their own explicit30s limits, documented in their stage reports; existing test limits are unchanged. Performance remains separately measured and is an activation blocker, not excused by this CI ceiling. More than20 minutes without verifiable progress still requires inspection; live job logs may not exist until GitHub finalizes a job.

## 2026-10-02 21:46 UTC measured next-batch estimate

Run37065423449 passed171 files/3451 tests in1893.94s and deployed successfully at21:44:44UTC. The next ready batch adds owner/codec/pure-migration fixtures (309.25s combined locally), idle-leaf coverage (169.70s), and new integrated-idle cases (approximately187s excluding the separately counted owner suite). Their observed serial sum is about42.7minutes before runner variance/builds. The validation-only job ceiling is50minutes for that batch; assertions, old individual test limits, serial one-worker execution, deployment15minute limit and permissions are unchanged. This preserves the full suite rather than dropping coverage; active-runtime performance remains a separate unresolved activation requirement.
