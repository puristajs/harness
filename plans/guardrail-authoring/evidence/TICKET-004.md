# TICKET-004 evidence

## Implemented scope

- Added `packages/harness-guardrails/src/action.ts` with opaque immutable action
  tokens, private callback/schema metadata, strict action-definition overloads,
  and schema-preserving prepared callback thunks.
- Refactored rail compilation and evaluation to require authentic tokens, keep
  outcome/evidence/deadline ownership in the existing coordinator, and skip
  nonselected tool rails before schema parsing or callbacks.
- Replaced dynamic sensitive tool-flow options with `sensitiveDataToolRail`, a
  schema-bound, explicit-tool-selector constructor. The fixed six-action
  sensitive factory retains the shared detector algorithms.
- Updated exports, focused type assertions, and the guardrails example to use
  inline token constructors. The example asserts selected tool rails do not
  preflight unrelated tools.
- Runtime tests retain their historical behavior fixtures through a test-local
  adapter that calls the public token constructor. Direct public raw and forged
  action objects are separately asserted to fail configuration validation.
- Review repair: schema-bound action thunks now close over a frozen snapshot of
  the schema parser output while retaining the raw snapshot for structural
  equality. Both input preparation and transform validation use `Object.is`
  for scalar equality, so `-0` and `0` cannot pass as equivalent values.
- Review repair: type tests cover an unsafe narrowed extracted evaluator as a
  compile failure and demonstrate indexed `GuardrailActionDefinition['evaluate']`
  typing for an extracted schema-bound callback.
- Review repair: `tool_input` and `tool_output` action definitions now require
  a nonempty exact `tools` selector in both overloads and JavaScript runtime
  validation. Focused type and runtime negative cases cover omission.

## Acceptance mapping

- `AC-GA-ACTIONS-SUCCESS`: literal token phase/schema inference, fixed
  sensitive actions, schema-bound sensitive tool action, and example flow pass.
- `AC-GA-ACTIONS-FAILURE`: type tests reject wrong target, false transforms,
  dynamic boolean permission, illegal non-tool selector, missing codec schema;
  runtime tests reject raw/forged tokens.
- `AC-GA-ACTIONS-RECOVERY`: ordered transforms/evidence/deadlines remain under
  the coordinator; example verifies selectors skip unrelated tool preflight.

## Verification

All commands ran from `/Users/sebastianwessel/projekte/@purista`:

1. `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/38-guardrail-authoring` — pass.
2. `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/guardrail-authoring ai-harness/specs/38-guardrail-authoring` — pass.
3. `npm --prefix ai-harness run build` — pass. Initial sandbox run hit local
   native-process `EPERM`; the approved elevated rerun passed without network.
4. `npm --prefix ai-harness test --workspace @purista/harness-guardrails` —
   pass, 47 tests (including `-0`/`0` structural-preservation rejection and
   missing tool-selector rejection).
5. `npm --prefix ai-harness run test:types --workspace @purista/harness-guardrails` — pass.
6. `npm --prefix ai-harness test --workspace @purista/guardrails-example` —
   pass, 7 tests.

## Handoff

Ticket implementation is ready for independent review. It is not self-accepted.
