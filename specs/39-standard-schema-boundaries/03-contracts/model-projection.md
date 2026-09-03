# Model projection and provider contracts

## CTR-SS-PROJECTION

During `build()`, and once per registered model-facing boundary, core:

1. Reads `schema['~standard'].jsonSchema.input`.
2. Calls it exactly once with `{ target: 'draft-2020-12' }`.
3. Rejects missing conversion, thrown conversion, or a non-`JsonValue` result with `CTR-SS-ERRORS` metadata.
4. Deep-clones to a null/prototype-safe JSON value if required by the existing JSON utilities, then recursively freezes the owned copy.
5. Stores the result in a private compiled tool/agent definition.

The input projection is mandatory for both tool arguments and default-loop structured output because the model produces a value that the validation schema consumes. Output projection is not used. No projection occurs in session creation, replay, retries, agent steps, or tool loops. Build-cache tests instrument the converter and assert one call per registered boundary across multiple runs and retries.

The memory summarization request in `sessions/index.ts` must pass an actual `JsonValue` JSON Schema to `ModelHandle.object`; passing a Zod schema through a cast is forbidden and covered by regression test.

## CTR-SS-PROVIDERS

`ModelToolSpec.parameters` and `ObjectRequest.schema` remain `JsonValue`. First-party OpenAI, Anthropic, Bedrock, and Azure adapters receive an opaque JSON Schema and pass it to their provider request without validator imports or schema conversion. Existing provider SDK helpers for Zod are not used.

Core does not promise that every legal Draft 2020-12 keyword is accepted by every provider. Adapters may reject provider-unsupported schemas using existing provider error mapping, but must not silently delete, rename, widen, close, or rewrite keywords. Contract tests use distinctive nested schemas and assert deep equality at the SDK request seam. Live provider calls and credentials are unnecessary.

Local validation always uses the original Standard Schema object and is authoritative even when a provider claims structured-output conformance.
