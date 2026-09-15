# TICKET-001 — Schema-directed native tools and callback inference

Recorded implementation: 2026-08-26. Status: **implemented; not accepted**. Independent review controls acceptance and plan/index lifecycle updates.

## Scope and contract trace

Implemented `CTR-GA-CALLBACKS` / `REQ-GA-CALLBACKS` in the ticket write scope.

- Added the builder-local `ToolDefinitionHelpers.tool` helper and its private enumerable symbol brand. The helper shallow-copies a native definition, while JSON serialization omits the brand.
- Added callback and captured-map registration overloads to harness and static-module builders. Raw native objects fail during registration with `HarnessConfigError` metadata `{ reason: 'invalid_tool', path: 'tools.<id>', id }`; native storage remains the approved localized heterogeneous boundary.
- Both callback overloads return and validate `T & CheckedTools<T, C>`, so a spread registered definition cannot replace its input schema or handler output. `ToolDefinition` remains the canonical unbranded runtime union, while `ToolsConfig` is the branded accepted-registration boundary.
- Preserved native tool input/output schema directions: handlers receive `z.output<I>`, return `Promise<z.input<O>>`, and model-facing native-tool and agent-output schemas use `z.toJSONSchema(..., { io: 'input' })`.
- Retained exact builder state, tool keys, schema inference, and sandbox context through callback registration, including static modules. Exported public helper/registered-definition types without introducing a standalone `defineTool` API.
- Converted scoped native tool examples and tests to the builder-local callback pattern. The living-wiki factory receives its helper before its optional store and no longer repeats per-handler input parsing or uses a `ToolsConfig` annotation.

The pre-existing worktree was broadly dirty before this ticket. No reset, cleanup, migration, compatibility layer, dependency change, or Voyage change was made.

## Acceptance mapping

| Acceptance ID | Evidence |
| --- | --- |
| `AC-GA-CALLBACKS-SUCCESS` | `harness-typing.ts` checks contextual native input, exact schemas, sandbox capabilities, callback registration/static modules, and transformed raw invocation/$infer/child-task types. `build-validation.test.ts` proves the shallow enumerable readonly brand, spread retention, JSON omission, and same-instance captured-map reuse. `agent-interceptors.test.ts` asserts actual native-tool and model output-candidate input JSON Schemas plus direct custom-agent default/transform parser counts. `workflow-delegation.test.ts` asserts transformed workflow-to-agent delegation values and one-pass parser counts. |
| `AC-GA-CALLBACKS-FAILURE` | `build-validation.test.ts` proves direct and callback raw `{ kind: undefined }` maps fail with the required metadata; `static-modules.test.ts` proves the same static-module path. Type tests reject raw native maps, unregistered `TsToolDefinition` values, and callback-spread schema/handler mismatches for harness and static modules. |
| `AC-GA-CALLBACKS-RECOVERY` | Existing type coverage for default string agent/workflow schemas remains green; callback-based maps preserve registered keys and subsequent builder inference. |

## Verification

Preflight, using the ticket-pinned manifests, passed:

- `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/38-guardrail-authoring`
- `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/guardrail-authoring ai-harness/specs/38-guardrail-authoring`

Implementation verification passed:

- `npm --prefix ai-harness run build` — passed. The known Vite chunk-size warning was emitted; no build failure.
- `npm --prefix ai-harness test --workspace @purista/harness` — passed: 57 files, 926 tests. It required unrestricted local loopback access for the integration fixture; expected-error logs were emitted by negative-path tests.
- `npx vitest run test/build-validation.test.ts test/static-modules.test.ts test/agent-interceptors.test.ts` from `packages/harness` — passed: 72 tests.
- `npm --prefix ai-harness run test:types --workspace @purista/harness` — passed.
- `npm --prefix ai-harness test --workspace @purista/harness-guardrails` — passed: 38 tests. It required the same local-loopback fixture access.
- `npm --prefix ai-harness run lint` — passed across all workspaces.
- `git -C ai-harness diff --check` — passed.
- Post-review fixture cleanup: custom-agent transform fixtures now declare `instructions: ''` and invoke defaulted inputs as `undefined` without casts; focused runtime and package type checks passed.

## Residual review focus

Review the intentional `as never` runtime raw-native fixtures, which cross the compile-time boundary solely to assert the required `invalid_tool` failure. Also inspect the localized `any` in the unbranded runtime union: it is the contract-approved storage erasure behind the branded `ToolsConfig` boundary, not a public typing escape hatch.

No blockers remain for independent review.
