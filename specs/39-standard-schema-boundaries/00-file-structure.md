# File structure

## Required ownership

| Path | Required responsibility |
| --- | --- |
| `packages/harness/src/schema/index.ts` | Public `Schema`, `ModelSchema`, `Infer`, `InferIn`; internal async validation and model projection helpers may be re-exported from private sibling files only. |
| `packages/harness/src/schema/validation.ts` | Single Standard Schema invocation, JSON assertion, privacy-safe issue/error mapping. |
| `packages/harness/src/schema/json-schema.ts` | Standard JSON Schema input projection, Draft 2020-12 selection, JSON validation, deep freeze. |
| `packages/harness/src/harness/defineHarness.ts` | Schema-first definitions/builders, private compiled runtime definitions, exact nested inference. |
| `packages/harness/src/agents/index.ts` | Agent validation and consumption of cached model schemas; no vendor conversion. |
| `packages/harness/src/agents/tool-execution.ts` | Tool input/output validation using shared helper. |
| `packages/harness/src/workflows/index.ts` | Workflow input/output validation using shared helper. |
| `packages/harness/src/sessions/index.ts` | Typed invocation/result persistence, replay and memory-summary object request using JSON Schema. |
| `packages/harness-guardrails/src/**` | `Schema`-based value schemas and awaited validation; internal config Zod is unchanged. |
| `packages/harness-*/src/**` | Adapter pass-through only; no schema-library dependency. |
| `packages/harness/test/**`, `packages/harness/src/**/*.test.ts`, `packages/harness/type-tests/**` | Runtime, adapter-contract, build-cache and compile-time inference coverage. |
| `docs/**`, `examples/**`, `skills/ai-harness/**` | Zod-default, Standard-Schema-compatible public guidance. |
| `../purista/web/**`, `../purista/skills/**`, `../purista/packages/core/**` | Website/handbook/skill alignment and reuse of established PURISTA terminology; core behavior changes only if a shared defect is proven by tests. |

Do not create validator-specific adapter modules, compatibility folders, duplicate JSON types, committed generated JSON schemas, or a second validation error hierarchy.
