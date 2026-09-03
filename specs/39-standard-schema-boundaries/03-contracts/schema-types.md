# Schema and inference contracts

## CTR-SS-SCHEMA

The public declarations are semantically exact:

```ts
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

export type Schema<Input = unknown, Output = unknown> = StandardSchemaV1<Input, Output>

export type ModelSchema<Input = unknown, Output = unknown> =
  StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>

export type Infer<S extends Schema<any, any>> = StandardSchemaV1.InferOutput<S>
export type InferIn<S extends Schema<any, any>> = StandardSchemaV1.InferInput<S>
```

`Schema` and `ModelSchema` are structural contracts; users never wrap or register a vendor. Their unconstrained associated types deliberately preserve a validator's raw input semantics: Zod defaults/optionals and coercing/transforming validators can accept values that are not representable as strict JSON before validation. `ModelSchema` is intentionally narrower. Zod 4.4 satisfies it directly. ArkType 2.1.28+ satisfies both standards directly. A Valibot validation schema becomes model-facing only through the official `@valibot/to-json-schema` Standard JSON Schema wrapper; ordinary Valibot schemas remain valid `Schema` values.

At every public Harness boundary, the builder accepts a schema only when its **validated output** (`Infer<S>`) extends `JsonValue`. Raw `InferIn<S>` remains exact and is never persisted, supplied to a provider, or emitted as a Harness result before validation. This is the only JSON constraint: it preserves validator semantics while ensuring every value that crosses into handlers, model ports, persistence, telemetry envelopes, or session results is JSON.

The package exports these four types from its root with IDE-ready TSDoc. It does not export Standard Schema runtime values or create `HarnessSchema` aliases.

## CTR-SS-BUILDERS

Definitions are parameterized by schema objects, not pre-inferred values. Exact required relationships:

| Boundary | Declared schema | Caller/producer type | Validated consumer/result type |
| --- | --- | --- | --- |
| agent input | `I extends Schema` | `InferIn<I>` | `Infer<I>` in instructions, hooks, interceptors, handler context |
| default-loop agent output | `O extends ModelSchema` | model JSON candidate | `Infer<O>` session result |
| custom-handler agent output | `O extends Schema` | handler returns `InferIn<O>` | `Infer<O>` session result |
| tool input | `I extends ModelSchema` | model JSON candidate | `Infer<I>` handler input |
| tool output | `O extends Schema` | handler returns `InferIn<O>` | `Infer<O>` tool result/model payload |
| workflow input | `I extends Schema` | `InferIn<I>` invocation | `Infer<I>` handler context |
| workflow output | `O extends Schema` | handler returns `InferIn<O>` | `Infer<O>` invocation result |
| guardrail value | `S extends Schema` | selected unknown value | `Infer<S>` callback value |

The agent definition is a correlated union: absence of `handler` selects the default loop and requires `ModelSchema` output; presence of `handler` permits `Schema` output. The default omitted input/output schemas remain internal Zod strings and satisfy `ModelSchema`.

`defineHarness()` preserves literal aliases through every chained registration. `$infer.agents.<alias>.input` equals the invocation type and `.output` equals validated output; `$infer.workflows` follows the same shape. `ctx.agents`, `ctx.workflows`, `ctx.tools`, `session.agents`, and `session.workflows` preserve alias-specific arguments/results recursively. A bare `Schema` annotation may intentionally be unknown; no known schema flowing through a builder or public result may be erased to `any`, `unknown`, or broad `JsonValue`.

Type tests must use equality assertions and negative `@ts-expect-error` cases for nested objects, arrays, optionals/defaults, transforms with distinct JSON input/output, and two registered aliases with incompatible types. Runtime casts may exist only behind tested private helpers and may not appear in exported declarations.
