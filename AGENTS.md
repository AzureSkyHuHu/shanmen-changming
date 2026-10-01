# Project engineering instructions

Read README.md, docs/development-status.md, and the relevant documents under docs/engineering-plan before editing. The design is a baseline, not proof of implemented features.

## Boundaries
- Keep authoritative simulation pure TypeScript, separate from Phaser, React, DOM, wall clock and persistence APIs.
- Simulation uses deterministic IDs, serialized independent random streams, fixed ticks and explicit command/event order.
- Skills, talents, statuses and item effects use typed validated data plus registered effect primitives. No eval or arbitrary code in content/save files.
- Every modifier has source ownership. Lifecycle scope and timed duration are separate. Death and reward settlement happen once.
- Default locale zh-CN, optional en, per-key Chinese fallback. All player-facing strings use stable keys and parameterized templates; language never changes simulation or save identity.
- Core entities max 36 full disciples; decorative crowds do not silently add full simulations.
- Do not add network services, telemetry, paid dependencies, public hosting or account permissions without applicable authorization.
- Never commit credentials, node_modules, generated test output, or personal information unrelated to this project.

## Team ownership and validation
- Each worker must stay inside explicitly assigned files; report needed changes outside scope.
- One integration owner runs repository-wide dependency installation, builds and test suites serially. Other workers write test cases and request runs rather than racing installs/builds.
- Read relevant official game skills at .local-tools/game-studio/skills/<skill>/SKILL.md. Preserve their complete references/scripts layout. Tool availability is not proof that its code is safe or required.
- Before completion, review full diff, run type checking, relevant tests, build and content validation. Record actual results and limitations.
- Browser/Canvas changes require screenshot review and real interaction; a passing DOM test alone is insufficient.
- Keep milestones, known risks and task evidence updated; do not label a task complete solely because files exist.

