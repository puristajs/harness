# TICKET-005 — Attach requirements and end-to-end deployment preflight

Recorded implementation: 2026-08-26. Status: **implemented; not accepted**.
Independent review controls acceptance and lifecycle promotion.

## Scope and contract trace

Implemented `CTR-GA-BINDING`, `CTR-GA-ACTIONS`, and `REQ-GA-BINDING` within
the ticket write scope. The inline-only configuration cut remains intact: this
ticket adds no file loader, YAML artifact, configuration script, or compatibility
surface.

- `Guardrails.attach()` now derives one private interceptor `requirements`
  declaration from the already compiled, active `input`, `output`,
  `tool_input`, and `tool_output` rail occurrences. It reuses opaque action-token
  metadata instead of introducing a second guardrail registry. Selected tool
  identifiers and direct model aliases are deduplicated in rail order; model
  dependencies require the existing core `object` capability. Retrieval actions
  are deliberately excluded.
- The guardrail interceptor stays private and remains appended after existing
  agent interceptors. `attach()` preserves agent schemas and callback inference
  and continues to reject custom-handler agents.
- Each prepared action callback now receives only the model handles named by
  that action token. Undeclared registered handles are not exposed through the
  guardrail callback context.
- `filterRetrievedChunks()` checks every active retrieval action's declared
  model handle before any retrieval callback runs. Missing aliases return the
  safe `model_missing` configuration reason; absent/non-callable `object`
  methods return `model_capability_missing`. Attached-phase requirements do not
  affect standalone retrieval, and retrieval requirements do not affect
  attachment.
- The inline guardrails example has a checked build-and-shutdown preflight that
  returns observable zero counts for model requests, detector inspections, tool
  invocations, and approvals. Applications may inject their detector; the
  composition wraps it with an inspection counter without changing its port.
- Review repair: attached action callbacks are now tested with a declared
  `safety` model alongside unrelated registered models. They see only `safety`;
  missing or object-capability-incompatible requirements fail during build
  before their callbacks execute.

## Acceptance mapping

| Acceptance ID | Evidence |
| --- | --- |
| `AC-GA-BINDING-SUCCESS` | Addon tests inspect exact derived requirements and attached callback model projection; the example builds, runs its two differently shaped tools, and selectively applies tool rails. |
| `AC-GA-BINDING-FAILURE` | Addon tests reject disabled selected tools, missing aliases, insufficient object capability, missing/non-callable standalone retrieval handles, and prove no protected retrieval callback ran before failure. |
| `AC-GA-BINDING-RECOVERY` | The example's preflight builds then shuts down the real inline composition with observable zero model/detector/tool/approval effects; core manual-interceptor requirement coverage remains owned by TICKET-003. |

## Verification

All commands ran from `/Users/sebastianwessel/projekte/@purista`:

1. `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/38-guardrail-authoring` — pass.
2. `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/guardrail-authoring ai-harness/specs/38-guardrail-authoring` — pass.
3. `npm --prefix ai-harness run build` — pass after an approved elevated retry.
   The restricted attempt reached the unrelated native privacy build and failed
   with sandbox `EPERM` while spawning its bundled tool; the elevated rerun made
   no network request and completed the full workspace build.
4. `npm --prefix ai-harness test --workspace @purista/harness-guardrails` —
   pass, 47 tests.
5. `npm --prefix ai-harness run test:types --workspace @purista/harness-guardrails`
   — pass.
6. `npm --prefix ai-harness test --workspace @purista/guardrails-example` —
   pass, 8 tests.

## Handoff

Ticket implementation is ready for independent review. It is not self-accepted.
