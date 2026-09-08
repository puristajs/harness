# Configure a Harness

Harness configuration has two separate parts:

1. immutable definitions describe what the application can do;
2. instance bindings provide the live infrastructure that executes it.

Keeping those parts separate makes definitions reusable and keeps credentials,
connections, and deployment choices out of shared packages.

## Define the graph

```ts
import { defineAgent, defineHarness } from '@purista/harness'

const assistant = defineAgent('assistant', {
  instructions: 'Answer clearly and briefly.',
})

export const supportHarness = defineHarness({
  name: 'support',
  defaults: {
    runTimeoutMs: 30_000,
    toolTimeoutMs: 10_000,
    decisionTimeoutMs: 2_000,
  },
}).addAgent(assistant)
```

Definitions are frozen values. Add agents and workflows as executable roots;
their direct tool, Skill, MCP tool, and agent references form the dependency
closure. Use `.use(catalog)` only when executable definitions need reusable
packaging.

## Bind the runtime

```ts
const instance = await supportHarness.getInstance({
  model: {
    provider,
    model: 'gpt-5-mini',
    retry: true,
  },
  logger,
  telemetry: { contentCaptureMode: 'NO_CONTENT' },
})
```

The graph determines the required fields. A graph with only the default
`primary` model alias accepts `model`. A graph with named aliases accepts an
exact `models` record:

```ts
const answerer = defineAgent('answerer', {
  model: 'fast',
  instructions: 'Answer the user.',
})

const instance = await defineHarness({ name: 'support' })
  .addAgent(answerer)
  .getInstance({
    models: {
      fast: { provider, model: 'gpt-5-mini' },
    },
  })
```

Unknown aliases and missing required aliases fail at compile time and again
during runtime validation.

## Add memory

Declare memory on the agent that uses it:

```ts
const assistant = defineAgent('assistant', {
  instructions: 'Use relevant session memory.',
  memory: {
    capabilities: ['memory.kv', 'memory.vector_search'],
    embedding: { model: 'embeddings' },
  },
})
```

The instance now requires a compatible `memory` engine and both model aliases:

```ts
await definition.getInstance({
  models: {
    primary: { provider, model: 'gpt-5-mini' },
    embeddings: { provider, model: 'text-embedding-3-small' },
  },
  memory,
})
```

Memory is application state for agent sessions and retrieval. Business records
belong in application databases exposed through typed tools.

## Add sandbox capabilities

Tools declare the operations they need:

```ts
const inspectFile = defineTool('inspectFile', {
  description: 'Read one workspace file.',
  input,
  output,
  requires: { sandbox: ['sandbox.fs'] },
  async handler({ sandbox }, value) {
    return { content: await sandbox.readText(value.path) }
  },
})
```

The tool handler sees only the declared sandbox facade, and the Harness instance
requires a sandbox that advertises `sandbox.fs`. Skills with executable
runtimes also require a sandbox with the corresponding runtime metadata.

## Add durable execution and workspaces

```ts
const report = defineWorkflow('report', {
  input,
  output,
  durable: true,
  workspace: true,
  async handler(ctx) {
    return ctx.step('render', async () => ({ ok: true }))
  },
})

const definition = defineHarness({
  name: 'reports',
  revision: '2026-09-07',
}).addWorkflow(report)

const instance = await definition.getInstance({
  storage,
  sandbox,
  workspace,
})
```

A durable graph requires a stable deployment `revision`. Workspace workflows
also require a sandbox advertising `sandbox.workspace_binding` and a
`DurableWorkspace` adapter.

## Control concurrency

`agentAdmission` limits concurrent agent executions before a model loop
starts. `admission` limits provider operations, which is useful for
provider-specific rate limits. Both are runtime bindings and remain outside
agent definitions.

## Configure telemetry safely

Pass `logger` and `telemetry` to `getInstance`. Content capture is off by
default. Keep it off in production unless your data policy explicitly permits
prompt, model, or tool content in traces.

## Inspect requirements

```ts
console.log(definition.inspect())
console.log(definition.requirements)
```

Inspection returns sanitized definition ids, target contracts, and inferred
runtime requirements. It never returns credentials or live adapter objects.

Close the instance during application shutdown:

```ts
await instance.close()
```
