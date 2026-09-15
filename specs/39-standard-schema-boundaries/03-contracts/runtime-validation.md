# Runtime validation contracts

## CTR-SS-VALIDATION

One private async function validates all public value-schema boundaries:

1. Call `await schema['~standard'].validate(value)` exactly once.
2. If `issues` is a non-empty array, throw the boundary's existing `ValidationError` with the existing `where` value.
3. Otherwise take `result.value`; never continue with the unvalidated candidate.
4. Assert the successful value with existing `isJsonValue` before provider submission, persistence, telemetry attributes, or returning it as a Harness result.
5. A successful Standard Schema result without a JSON value is an internal contract failure, never an implicit `JSON.stringify` conversion.

Every invocation site awaits validation. Sync and async validators have identical observable behavior. Tool input is validated before authorization/handler execution; tool output after the handler and before model/persistence use. Agent/workflow input is validated before any user callback; output is validated before run completion. Guardrail-selected values are validated before the guardrail callback.

Cancellation is checked through the existing execution signal before and after an awaited validator call. The helper does not invent its own timeout; existing run deadlines remain authoritative.

## CTR-SS-ERRORS

Returned validation issues map to existing `ValidationError`. Serialized/public metadata contains only:

```ts
issues: { count: number; truncated: boolean }
```

`count` is capped at 100 and `truncated` is `true` when more than 100 issues were returned. Vendor messages, paths, offending values, schemas, and arbitrary thrown messages are not serialized, logged, persisted, or attached to telemetry.

A validator throw/rejection maps to existing `InternalError` metadata:

```ts
{ reason: 'schema_validation_execution_failed', where: ValidationWhere }
```

The original issues or thrown value may be retained only as a private `Error.cause` for in-process debugging; `serializeError` must omit it. Non-JSON successful output uses reason `schema_validation_non_json` and the same `where`. Existing error codes/categories/retry semantics remain unchanged.

Build-time model projection failures use `HarnessConfigError` with a fixed public message and metadata:

```ts
{
  reason:
    | 'schema_json_projection_missing'
    | 'schema_json_projection_failed'
    | 'schema_json_projection_invalid'
  schemaBoundary: 'agent_output' | 'tool_input'
  id: string
  schemaVendor?: string
  schemaTarget: 'draft-2020-12'
}
```

No vendor exception text or generated schema content crosses the public/logged/serialized boundary.
