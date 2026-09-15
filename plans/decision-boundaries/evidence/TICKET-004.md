# TICKET-004 — prepared tool lifecycle

Recorded implementation and independent review: 2026-08-26.

Extracted `agents/tool-execution.ts` as sole preflight/execution/deadline owner. Implemented frozen transformed wire calls, once-parsed handler/governance input, protected transcript validation, strict interceptor outcomes, actual-step evidence, and session-wrapper-owned model.completed accounting.

Review repaired transcript failure projection, strict reason-code validation, and all recoverable post-transform validation paths. Final implementation verification: full Harness 720 tests passed with localhost permission; focused tests and type/build checks passed; guardrails 20 tests/typecheck passed. Independent final focused review: 34 tests, core typecheck and diff check passed.

A prior full rerun had one sandbox timeout test failure; the subsequent full 720-test run passed. Final verification must still rerun the current tree. Scope extensions authorized by the coordinator included session accounting and guardrails integration tests.

## Final repair acceptance — 2026-08-26

Prepared builtin/MCP input validation now happens once before approval; binding closures execute that same frozen parsed input. Orphan/duplicate older tool results reject before provider I/O. Initial parent abort is relayed before preparation, using existing withAbortSignal instead of a duplicate race. Completion accounting buffers a unique stream finish until successful exhaustion, validates reported canonical usage/finish reason, and projects safe fields. Root independently inspected all changes, extended the context-projection fixture to a complete interaction group and proved one successful retry count. Current full core suite:911/911 across58 files; core build passed; focused lifecycle65, addon30/type-tests passed. Earlier sandbox test run failed loopback EPERM; same full command with authorized loopback access passed. No broad CI claim is made.

## Final shared-schema and parser integrity review

The final reuse review replaced the handwritten interceptor allow/block shape and
validation with the canonical decision schema. Permission/governance aliases and
wait outcomes now derive from their existing owners; readonly permission lists
are preserved. The old runLimited helper and its three orphan tests were removed
because prepared batch execution owns production concurrency. See
[T010 reuse evidence](TICKET-010-reuse-review.md).

A read-only E2E probe then reproduced two interceptor-result defects: a throwing
getter/proxy exposed synthetic private text through INTERNAL_ERROR, and a changing
decision getter could validate block before a later read permitted execution.
The replacement parser returns canonical parsed data, catches envelope/parser
exceptions as invalid_result, and never consumes the raw object after validation.
Transform phase validation and own-value checks remain; the generic transform
cast was removed in favor of typed phase projections. DecisionExecutionContext
also replaces a duplicate inline context shape.

Test-first proof: getter and proxy privacy cases plus changing decision case failed
for their intended reason; inherited transform-value rejection already passed.
After repair, 155 focused core tests, core typecheck/type tests and diff check
passed. The coordinator independently inspected the actual parser and rebuilt
core successfully. Final complete-source global verification is tracked in T010.
