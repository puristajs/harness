# Conventions

## CONV-SS-PURISTA

- Match PURISTA schema vocabulary: `Schema`, `Infer`, `InferIn`; add only `ModelSchema` for the narrower model-facing capability.
- Prefer schema-first generics. Infer callback/context/session types from the registered definition object; do not mirror user-authored shapes in interfaces.
- Caller inputs use `InferIn<S>`; validated handler/context values and returned session results use `Infer<S>`.
- Handler returns use `InferIn<OutputSchema>` and are validated into `Infer<OutputSchema>`.
- Preserve literal registry keys and recursively mapped `$infer.agents`/`$infer.workflows` members. Do not widen to `string`, `unknown`, `any`, `Record<string, ...>`, or `JsonValue` when an exact inferred type exists.
- Runtime code calls only shared schema helpers. Vendor detection and direct `.parse`, `.safeParse`, or `z.toJSONSchema` calls are forbidden at public value-schema boundaries.
- TSDoc is required for exported schema types/helpers, including one Zod example and one non-Zod example.
- Use existing errors, telemetry, logger, and provider port structures; introduce no parallel abstraction.

## Clean-code rule

Delete replaced branches and types in the same ticket that installs the new path. A temporary private helper is allowed only inside an implementation ticket and must be absent at ticket acceptance.
