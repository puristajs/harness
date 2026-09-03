# Nonfunctional requirements

Build/compile validation is deterministic and linear in configured
phases/actions/declarations and registry references. It performs no callback,
network, session, model/detector, MCP or sandbox execution. No new hot-path
registry traversal: precompute selector sets and compiled model requirements
once. Selected action ordering, evidence ordinals and the existing decision
timeout/cancellation budget remain unchanged. External dependency availability
is checked through existing runtime ports, not startup probing.

Policy data and protected content must not enter metrics/logs/errors. Fixed
errors and declared IDs/field paths are sufficient; no raw parse cause or input
value crosses serialized diagnostics. Configuration is an in-memory,
application-authored object and is never interpreted as executable code.

No persistent data model, retention, session storage, queue, concurrency,
retry, approval or durable-wait semantics change. Reuse spec37 tests as
regressions; no schema/typing fix may alter its effect ordering or cancellation
fences. Rebuilding after a failed preflight is the recovery path; there is no
partial build result or runtime fallback policy.

Keep existing repository coverage thresholds unchanged. Type-test negative
cases must prove errors occur, including IsAny checks, literals,
helper/default-generic paths and mixed registries. E2E tests use existing fake
providers/detectors and assert zero protected side effects on failures. No live
provider credentials, installs or downloads in default verification. Package
contents/exports and declarations are part of release verification.
