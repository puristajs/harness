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
  model: 'chat',
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
  models: { chat: {
    provider,
    model: 'gpt-5-mini',
    retry: true,
  } },
  logger,
  telemetry: { contentCaptureMode: 'NO_CONTENT' },
})
```

The graph determines the required fields. Every model alias is
application-defined and every graph uses one exact `models` record. Harness
does not reserve an alias or expose a singular shortcut:

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

Put provider generation defaults, including `providerOptions`, under
`defaults`. Retry policy belongs once at the model binding level and may still
be overridden by an individual model call:

```ts
models: {
  chat: {
    provider,
    model: 'gpt-5-mini',
    retry: { maxAttempts: 3 },
    defaults: { temperature: 0.2, providerOptions: { serviceTier: 'auto' } },
  },
}
```

## Add memory

Declare memory on the agent that uses it:

```ts
const assistant = defineAgent('assistant', {
  model: 'chat',
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
    chat: { provider, model: 'gpt-5-mini' },
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

Bind the adapter beneath `sandbox.adapter`. The optional `sandbox.policy`
controls partition selection for this deployment; it does not configure the
adapter itself. Without a policy, unconfigured top-level targets use private
partitions. Named groups are declared by agents and workflows, then enabled
once by the deployment:

```ts
const instance = await definition.getInstance({
  models: { chat: { provider, model: 'gpt-5-mini' } },
  sandbox: {
    adapter: sandbox,
    policy: {
      sharing: 'declared',
      default: { group: 'support-review' },
      authorizeBorrowedOwner: async ({ owner, identity }) =>
        owner.identity?.tenantId === identity?.tenantId,
    },
  },
})
```

Do not configure group names again at runtime. Graphs without declared groups
cannot enable sharing; graphs with groups require `sharing: 'declared'`.

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
  sandbox: { adapter: sandbox },
  workspace,
})
```

A durable graph requires a stable deployment `revision`. Workspace workflows
also require a sandbox advertising `sandbox.workspace_binding` and a
`DurableWorkspace` adapter.

## Control concurrency

`concurrency.runs` limits concurrent root agent or workflow executions.
`concurrency.modelCalls` limits provider operations, which is useful for
provider-specific rate limits. Both are runtime bindings and remain outside
portable definitions.

```ts
const instance = await definition.getInstance({
  models,
  concurrency: {
    runs: runConcurrency,
    modelCalls: modelCallConcurrency,
  },
})
```

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
