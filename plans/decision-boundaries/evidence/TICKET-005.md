# TICKET-005 — phase-specific rails

Recorded implementation and independent review: 2026-08-26.

Removed legacy guardrail errors and the private callback race. Rails use public decision evidence/execution, strict phase outcomes, schema-preserving JSON transforms, and beforeOutput for final content. Review repaired inherited child signal/deadline propagation, mutation-resistant snapshots, and primitive equality where 0 equals -0.

Verification recorded: guardrails 26 tests/typecheck/type tests/build; core build/type tests and focused interception tests; example and detector suites passed. Direct add-on tests cover blocked final delivery/history, tool intermediate output, stopWhen finalization, ordered transforms, malformed outcomes, schema mutation and enclosing tool cancellation. Independent re-review passed.

Final whole-tree verification remains TICKET-010's responsibility.

## Final repair acceptance — 2026-08-26

Attached blocks now preserve the exact rail source/reason/phase/ordinal evidence; direct and delegated input/tool-input cases prove distinct invocation identities and no protected side effect. Root independently reviewed rails.ts/context plumbing and reran addon30 tests and addon type tests. Current core911 suite also passes. Prior final-audit gaps are closed; T005 accepted.

## Final documentation-driven repair and independent recheck

A full coverage run exposed an intermittent nested action timeout winning over its parent tool timeout. A deterministic fake-clock regression reproduced the wrong callback_timeout identity. Attached actions now time only their own budget and inherit parent timeout identity through the signal; their reported deadline remains the effective minimum. Standalone retrieval explicitly enforces a supplied deadline and gives each action a fresh own budget otherwise. The shared core executor remains the sole decision timer. The docs also exposed rails.attach(agent(...)) generic contravariance: canonical state/input/output inference now preserves exact D without attachment casts. Root inspected both changes and regressions, rebuilt core/addon, reran both type-test suites and addon32 tests (all exit0). Focused addon coverage32 passed with rails.ts100% lines/functions before the final type-only attach signature change. Acceptance restored.

### Composed example follow-up

Fresh addon declaration check of examples/guardrails exposed TS7031 on the raw literal instructions callback. TICKET-005 reopened: the helper-agent fix must also preserve literal contextual typing. Existing type-test/runtime proof is retained but does not establish example compatibility. No docs-side cast/annotation workaround is accepted.

## Final schema ownership and public-only addon review

Both attachment call forms now pass against fresh declarations: raw literal
callback inference and helper-created agent inference. The unchanged composed
example passes seven runtime tests and its typecheck.

GuardrailDecision and private phase transforms derive from public
decisionResultSchema. Manual reason-code/key validation and private any context
parameters were removed. Four extra classification/privacy assertions passed.
The model-check request schema and result parser share one local strict schema.
Sensitive-data failure codes use the same public reason-code validator, with
valid/unsafe/overlength tests. The telemetry test now runs a real public Harness
workflow and configured model, observing its public adapter telemetry context;
the private model-registry import is gone. Existing parent-span/token assertions
remain, with an actual provider invocation assertion.

The addon suite passed 38 tests; typecheck/type tests and diff check passed. The
coordinator inspected these changes and rebuilt the addon. The real static
cleanup scanner now passes, including public-only imports and schema reuse.
Final complete-source global verification is tracked in T010.
