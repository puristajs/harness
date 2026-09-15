# File and folder structure

Add core `packages/harness/src/decisions/` with schemas.ts, types.ts, identity.ts, evidence.ts, execution.ts, index.ts and decisions.test.ts. Add `agents/tool-execution.ts` for private prepared invocation and batch lifecycle. Extract governance evaluation from agents into `governance/` beside its existing API; keep reducer, approval and audit helpers private to that module. Existing owners stay in models/json.ts, ports/model-provider.ts, sessions/index.ts, storage/external-wait.ts, errors/catalog.ts and harness/defineHarness.ts.

Addon implementation remains under `packages/harness-guardrails/src/`; errors.ts keeps configuration errors only after imports move. Provider mapping stays inside each adapter package. Review action/claim schemas and methods remain in `examples/durable-human-review/src/review-task-store.ts`; workflow orchestration stays in payment-review.ts. No application-specific source enters Harness.

Add two scoped maintenance scripts under `ai-harness/scripts/`: check-decision-boundaries.mjs and verify-decision-consumers.mjs, with node:test tests. They are verification tools, not runtime generators. Existing package-boundaries, catalog and skill sync scripts remain authoritative. Plan ticket write_scope bounds exact directories; this general layout does not authorize unrelated edits.
