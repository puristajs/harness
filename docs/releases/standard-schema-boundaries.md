# Standard Schema boundaries

`@purista/harness` now accepts any [Standard Schema](https://standardschema.dev/)
validator at its public validation boundaries. This is a clean breaking change:
the public schema contract no longer exposes Zod types, parsing APIs, or
provider-specific conversion paths.

Zod remains the default documentation choice. Existing Zod definitions work
without wrapping. ArkType works directly. Valibot works directly for
validation-only boundaries; add `@valibot/to-json-schema` and wrap the schema
with `toStandardJsonSchema(...)` only for a model-facing boundary.

## Model-facing boundaries

`ModelSchema` is required only where a model creates the value that a validator
will consume:

- TypeScript tool `input`;
- default-loop agent `output`.

Those schemas must implement Standard JSON Schema. During `.build()`, Harness
calls the schema's input projection once with `{ target: 'draft-2020-12' }`,
validates it as JSON, clones and freezes it, then gives every provider that
same JSON value. Providers do not receive a Zod, ArkType, or Valibot object and
do not rewrite the projection.

Agent input, custom-handler agent output, tool output, workflow input/output,
and guardrail values need only `Schema`. The validator's raw accepted input is
preserved for defaults, coercions, and transforms; the validated result must be
JSON before it crosses a Harness handler, provider, persistence, telemetry, or
session-result boundary.

See [Create typed tools](../guides/tools-and-skills.md#choose-the-schema-boundary-deliberately)
for verified Zod, ArkType, and Valibot patterns, and [Public API](../reference/public-api.md)
for `Schema`, `ModelSchema`, `Infer`, and `InferIn`.
