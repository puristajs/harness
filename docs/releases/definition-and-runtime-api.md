# Harness 4 definition and runtime API

Harness 4 uses immutable, independently typed definitions and explicit runtime
bindings.

## Definitions

Start with direct definition references:

```ts
// Harness 4
const lookup = defineTool('lookup', toolOptions)
const support = defineAgent('support', { ...agentOptions, tools: [lookup] })
const definition = defineHarness({ name: 'support' }).addAgent(support)
```

Use `defineSkill`, `defineMcpServer`, and `defineWorkflow` for additional
capabilities. Use `defineCatalog` plus `.use(catalog)` only to package reusable
executable definitions.

## Runtime configuration

Provider clients and infrastructure belong in instance configuration:

```ts
const instance = await definition.getInstance({
  model: { provider, model: 'gpt-5-mini' },
})
```

The definition graph projects the required bindings into the
`getInstance(...)` type and validates them before any model or tool work. Add
`storage`, `memory`, or `sandbox` bindings only when a definition explicitly
requires those capabilities.

## Invocation and lifecycle

Target invocation is address-first:

- `session.agents.<id>.run(input)`
- `session.agents.<id>.stream(input)`
- `session.workflows.<id>.run(input)`
- `session.workflows.<id>.stream(input)`

Use `session.release()` to release live resources while retaining persisted
state, `session.destroy()` to delete session state, and `instance.close()` to
close instance-owned adapters.

Harness 4 exposes `ExecutionEvent` as its portable stream contract. Browser
clients should use `@purista/harness-ai-sdk-ui/v1` to receive the standard AI
SDK UI Message Stream protocol.
