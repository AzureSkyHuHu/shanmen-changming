# Opt-in actual-frame browser diagnostics

Status: authored; authoring worker has **not run** type checks, tests, builds,
browser QA, benchmarks, or Git commands. This is instrumentation, not acceptance
or authorization to enable the v10 public entry. The integration owner executes
checks serially and records actual results separately.

## Enablement and ownership

The panel exists only when both of these exact independent gates are present:

- Build environment: `VITE_ENABLE_FRAME_DIAGNOSTICS=1`
- URL: one `frameDiagnostics=local` query parameter (duplicates are rejected)

There is no hostname restriction. “Local-only” means numeric data remains in the
current tab: no telemetry, network send, browser storage, save text, names,
clipboard write, report upload, automatic export, or global Session handle.
A private/public page's access policy is unaffected. An authorized build may
include this tool without changing its hosting, CI, or permissions; those changes
are outside this implementation.

The ordinary build remains off even if its URL contains the query parameter.
An enabled build with no query also has no panel, observer, collector, frame
buffers, or capture. The collapsed panel still requires an explicit Start click;
there is no automatic capture, restart, pause, speed change, or workload setup.

`VITE_ENABLE_V10_MANAGEMENT` is independent and unchanged. This adapter imports
neither v10 Session nor a v10 factory. Its presence in the v9 app cannot activate
or import v10 through the disabled entry. Do not enable public v10 based on this
diagnostic result.

## Measurement lane

The two management components retain their single existing `requestAnimationFrame`
loop. Its existing callback either invokes `session.frame(timestamp)` directly
or passes that same real timestamp through the diagnostic adapter. The adapter
calls that existing frame method exactly once and returns its original result;
a thrown frame error is rethrown without retrying. It does not request a second
frame, introduce a synthetic timestamp sequence, call a reducer/owner directly,
or reset the Session baseline.

Start arms a 60,000 ms foreground 1× observation. The next existing frame is an
anchor. Its Session cost is reported separately; its advanced ticks and unknown
pre-start elapsed demand are excluded from sampled totals. The after-anchor
cached simulation tick and fresh pending remainder establish the accounting
baseline. Wall time begins immediately before this anchor's ordinary call.

Subsequent frames record real rAF interval, measured Session call duration,
returned advanced ticks, ending pending microseconds and conservation residual.
`performance.now()` brackets only the existing frame call. Cached `getSnapshot()`
reads and scalar getter reads occur outside that bracket. Foreground state is
cached by event handlers, so the per-frame observation does not read/write DOM,
format strings, log, serialize, or update React. A snapshot is published at most
once per second plus explicit Start and final result. Percentiles are sorted
only after the capture window closes. Browser rAF intervals and wall time still
include instrumentation, rendering, scheduling, GC and the limited report UI
updates; Session call cost must not be called total browser frame cost.

The first call whose end reaches 60 seconds of monotonic wall time finishes the
capture. It is never interrupted midway to enforce a deadline: both actual wall
time and overrun are reported. A slow terminal callback can yield a shorter rAF
span than wall span. No hidden-period catch-up or game pause is added.

No World, admission, export, full-state equality oracle, save serialization, heap
snapshot, or per-system profiler runs inside this capture. Strict replay/oracle
comparisons are a separate lane before/after a suitably identified scenario.
The existing Node genuine-source benchmarks remain their own evidence and are
not replaced by this panel.

## Bounded data and accounting

At Start the collector preallocates space for at most 32,768 measured frames and
2,048 long tasks. Frame scalar storage has six Float64 values per frame (interval,
Session duration, timestamp, ticks, pending microseconds, local residual), plus
two per long task and 15 segment counters. Scalar payload is 1,605,752 bytes.
There is no growing sample array or overwrite/wraparound. Exhaustion interrupts
capture with a specific reason, while the game's next frame still executes.
Final percentile sorting uses bounded temporary typed-array copies.

The only new Session method returns a **fresh frozen** object:

`{ pendingMicroseconds, baselineEstablished }`

It reads the private accumulator and whether a baseline exists. It does not
publish, return the actual baseline, modify timing, reveal a World or consult the
runtime owner. This is deliberately not added to the cached projection, because
zero-tick frames can change the remainder without changing that projection.

At speed 1, per-frame demand is exactly `floor(actualRafDeltaMs * 1000)`. It is
summed per interval, never obtained by flooring only the total duration. The
reported residual is:

`initialPending + demand − endingPending − advancedTicks * 50000`

Successful uninterrupted capture should conserve this accounting, and the
returned-tick count is compared with the cached clock's actual tick delta. Pending
time may exceed a tick: the Session's existing 20-tick maximum keeps backlog.
The collector never drains or discards that backlog itself. At a domain pause,
Session may discard an unused allocated batch as it already does; the final
partial sample is retained, capture is interrupted, and its residual must not be
interpreted as a successful uninterrupted conservation check.

Early/middle/late counts cover rAF ending times 0–20 s, 20–40 s and 40 s–end.
Each reports frames, advanced ticks, frames with cached active jobs, demanded
microseconds and ending pending microseconds. These reveal workload depletion
and backlog growth instead of disguising a predominantly idle run as an active
workload. Counts do not prove a specific domain scenario; record that provenance
outside capture. Starting disciple count and active job count are numbers only.

Optional Long Tasks support is connected only on Start. Unsupported or failed
registration is explicitly “unavailable,” never evidence of zero long tasks.
Only numeric start/duration fields are kept; attribution is not collected.
Entries must start within the observed window. Reported counts include callbacks
already delivered and the final `takeRecords()` drain. The terminal browser task
may not yet have generated its entry, so this is explicitly incomplete coverage,
not a promise of a complete Long Tasks trace.

## Interruption and cleanup

Capture ends on hide, blur, pause/hold, Session epoch replacement, runtime closure
or failure, non-management mode, non-1× speed, unexpected baseline loss,
out-of-band tick/remainder changes, rejected frame, thrown frame error,
non-monotonic/invalid time, probe failure, reentrant frame, manual Stop, buffer
exhaustion or effect cleanup. Immediate Session subscriptions catch short-lived
pause/hold changes even between frames. Events only stop diagnostics; existing
application focus/visibility handlers remain the sole game-control owners.

An interruption during a synchronous frame publication is deferred until that
call's outcome is recorded. Disposal clears listeners before completing any
pending capture and prevents later observer callbacks from publishing. Every
React effect mount receives a fresh controller, so a StrictMode cleanup cannot
revive or dispose the next mount's collector. No auto-restart occurs after an
interruption.

## Reading the result and acceptance limits

There is no green pass badge or invented p95 threshold. “Reached 60-second
window” describes duration, not performance or correctness acceptance. The count
of Session calls over 50 ms is a 20 Hz capacity warning; it is not a 60 fps target,
and a multi-tick call is not equivalent to a one-tick cost measurement. Do not
subtract independent percentiles to claim renderer/projection time.

[DD-13](engineering-plan/02-detailed-design/13-assets-performance.md) still calls
for a fixed middle-range laptop, pinned browser, 1080p, 128×128 map, 36 disciples,
roughly 200 objects and 6v20 combat, with 60 fps normal / 30 fps low quality,
frame distributions, long tasks, heap memory and per-system tick measurements.
This bounded management adapter does not supply all those metrics/scenes, real
mobile-device coverage, long-save acceptance, worker-migration justification,
public activation approval or full-game acceptance.

## Integration-owner verification

Run serially from the frozen source; do not run authoring workers in parallel:

```sh
npx vitest run tests/application/browser-frame-diagnostics.test.ts tests/application/browser-frame-diagnostics-session.test.ts tests/application/frame-diagnostics-panel.test.tsx
npx vitest run tests/application/session-v9.test.ts tests/application/session-v10.test.ts tests/application/management-v10.test.tsx tests/application/management-workspace.test.tsx
npm run typecheck
npm run check:boundaries
npm run check-content
npm run build
VITE_ENABLE_FRAME_DIAGNOSTICS=1 npm run build
```

Preserve the ordinary v10-disabled build policy. If an already authorized private
v10 build is separately tested, record both flags and do not infer public
activation from those results. Run the repository aggregate check before any
release claim, as usual.

Real browser QA in an authorized diagnostics-enabled build remains required:

1. With no flag/query, verify no panel or capture; test exact gates and duplicates
2. At 1× foreground, Start once and double-click; verify a single capture with the
   same existing gameplay progress and no new controls/holds
3. Observe a full 60-second actual workload and retain numeric results, actual
   duration, starting/ending state, workload provenance, commit/build, browser,
   hardware, quality, viewport and limitations outside the timed window
4. Repeat hide/blur, pause, review/save overlay, speed, Session replacement and
   unmount cases; verify one interrupted result and no auto-resume or restart
5. Check narrow viewport and Chinese/English expanded details and focus controls;
   default UI remains uncluttered, without truncating diagnostic labels
6. Repeat the same scenario without capture to characterize observer overhead;
   retain the separate strict-oracle lane. Do not equate fake-clock tests or a
   static DOM render with actual Canvas or full-game acceptance

## Integration validation — 2026-10-03 07:06 UTC

Both strict type configurations passed. The first focused run found one local
message-parameter specification mismatch: its extraction pattern excluded digits
in `p50` and `p95`. The pattern was aligned with the shared i18n identifier rule,
without weakening the assertion. The final three focused files passed all 34
tests in 2.47 seconds. Four existing Session/management regression files passed
190 tests in 88.47 seconds. Boundaries and content/1205 shared locale keys passed;
default and independently diagnostics-enabled builds passed (v10 not enabled).
Independent source review also checked interruption before the first frame and
rejected-restart reset behavior; both reporting defects were repaired.

These results do not supply real browser capture, enabled/disabled full-state
comparison, actual hardware performance acceptance, or public deployment. The
existing compact-layout main CI remains a separate in-progress release.

### State-equivalence follow-up — 2026-10-03 08:10 UTC

Two bounded tests now compare independent same-seed real v9 and v10 Sessions:
full detached exports (including RNG/receipts), all four cached DTOs, publication
counts and exact timing remainder. Real gathering, an advancing anchor, zero/
multi-tick calls, manual stop, overlay/foreground holds, resume and repeated
cleanup match the direct Session path. Seven logical ticks per Session are
covered. Both passed in the combined six-file/55-test run (6.87 seconds); this
is deterministic regression evidence, not real browser throughput measurement.

### Existing public-v9 observation lane — 2026-10-03 09:26 UTC

Pages builds now include only the independent diagnostics flag, as an ordinary
update to the already-public v9 game. Default/index and v8 behavior are unchanged;
the v10 entry remains compile-time disabled. The exact query plus explicit Start
are still required; ordinary visitors see no panel or automatic observation.
There is no upload, telemetry, save export or private-Site data in this change.
The existing full-check/exact-main-SHA deployment workflow is unchanged.

Purpose: obtain actual browser instrumentation, interruption and observer-overhead
evidence on the currently accessible v9 page, without changing the owner-only
Site or bypassing its pending login. This is not v10 performance evidence or
permission to enable v10. Record actual build/scenario/browser/viewport and
small-scene limitations, and keep strict-oracle comparisons outside capture.

Integration checks for that Pages-only flag passed: both strict type
configurations, six diagnostic/preview/copy-preview files with 73 tests in 15.90
seconds, and enabled-v8/v9/diagnostics Pages build (847 ms). The first combined
run exposed a pre-existing preview-test mock graph retained by a static entry
import across module resets. Per-test fresh imports and complete dynamic-import
settlement fixed the test isolation; all 34 preview assertions/gate traps remain.
No production gate or storage behavior was relaxed. Real published observation
has not been run at this point.

### Published idle-scene capture — 2026-10-03 10:26 UTC

The exact main `ba02264550971e73e867cafed28301b8f68ddef2` passed
Actions 37113675942 (216 files / 4372 tests, 1985.86 s) and Pages deployment
111181572139, with terminal success at 10:11:16 UTC. Actual cloud Chrome loaded
`management.html?frameDiagnostics=local`; explicit Start was used after the
local heavy validation lane finished. The fresh unbound v9 scene had four
disciples, zero active jobs and speed 1x. No save was loaded or overwritten.

The capture finished naturally at its 60-second window:

- 3599 measured frames; 1200 actual simulation ticks, from 610 to 1810
- 2399 zero-tick frames and zero multi-tick frames
- rAF span 60003.50 ms; wall duration 60000.40 ms
- rAF interval p50 / p95 / max: 16.70 / 16.70 / 33.30 ms
- Session call p50 / p95 / max: 0 / 1 / 27.60 ms; total 1097.10 ms
- Pending time 25773 -> 26871 microseconds; maximum 49976
- Demand 60001098 microseconds; exact conservation residual 0 and tick mismatch 0
- Zero delivered long-task entries; each of three segments advanced 400 ticks

The panel remained readable and the final report survived an ordinary game pause.
This is an idle four-person instrumentation check, not an active-workload,
36-person, v10, mobile-device or full-game performance acceptance. The viewport
was the existing narrow desktop Chrome window; no hardware-target claim is made.
Strict full-state equivalence remains the separate deterministic test evidence.

The matching frozen local snapshot passed all 216 files / 4372 tests in
2861.50 s. Its npm aggregate then hit a blocked registry network request
before completing the build chain. Existing local compiler and Vite binaries
completed both type configurations and the default build (864 ms) without a
network request. This records separately completed stages, not an uninterrupted
successful npm aggregate exit.

### Real work-to-idle and interruption follow-up — 2026-10-03 10:35 UTC

On the same published build, ordinary UI commands started planting grain,
processing planks and gathering wood with three distinct available workers.
The first selector attempt used a label locator that did not match; the visible
combobox was then used. No game state or resources were injected. The second
capture began with three real active jobs and four disciples at speed 1x:

- 3591 frames / 1200 ticks, simulation 3244 -> 4444, zero multi-tick frames
- Wall duration 60004.20 ms; rAF span 60003.50 ms
- rAF interval p50 / p95 / maximum 16.70 / 16.70 / 50 ms
- Session call p50 / p95 / maximum 0 / 9.70 / 21.40 ms, total 3496.20 ms
- Pending 8313 -> 9547 microseconds, maximum 49985; exact residual and tick mismatch both 0
- 694 active-work frames in the first 20 seconds; no active work in later segments
- One delivered long task of 57 ms, not hidden or described as zero

All three jobs completed and delivered their ordinary yields. Stock changed from
wood24/grain24/planks0 to wood25/grain28/planks2. This is explicitly a short
three-job work-to-idle sample, not sustained load or large-scale acceptance.

Starting while the game was paused ended immediately with the paused reason and
zero samples, without advancing tick5765 or resuming play. A subsequent running
capture was interrupted by opening the save dialog: 17 frames / 5 ticks ended
with the Session-hold reason. Closing the dialog resumed ordinary play without
restarting diagnostics; the final report remained unchanged. No save/import/load
was performed; existing slot revisions were still 4/1/4. Foreground loss,
long-duration heaps, real mobile hardware and v10 remain separate outstanding
checks. Root performed no concurrent test/build workload during either capture.
