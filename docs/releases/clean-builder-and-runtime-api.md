# Harness 4 definition and runtime API

Harness 4 replaces the fluent Harness 3 builder with immutable, independently
typed definitions and explicit runtime binding. This is a clean break; removed
methods have no aliases or compatibility layer.

## Definitions

Replace inline builder registration:

```ts
// Harness 3
defineHarness()
  .tool('lookup', toolOptions)
  .agent('support', { ...agentOptions, tools: ['lookup'] })
  .build()
```

with direct definition references:

```ts
// Harness 4
const lookup = defineTool('lookup', toolOptions)
const support = defineAgent('support', { ...agentOptions, tools: [lookup] })
const definition = defineHarness({ name: 'support' }).addAgent(support)
```

Use `defineSkill`, `defineMcpServer`, and `defineWorkflow` for the other
definition families. Use `defineCatalog` plus `.use(catalog)` to package a
reusable graph. There is no terminal `.build()` call.

## Runtime configuration

Provider clients and infrastructure no longer live in definitions:

```ts
const instance = await definition.getInstance({
  model: { provider, model: 'gpt-5-mini' },
  storage,
  memory,
  sandbox,
})
```

The definition graph projects the required bindings into the
`getInstance(...)` type and validates them before any model or tool work.

## Invocation and lifecycle

Target invocation remains address-first:

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
