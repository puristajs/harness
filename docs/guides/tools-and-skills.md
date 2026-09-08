# Tools and Agent Skills

Tools let a model request an action. Agent Skills provide reusable instructions
and optional scripts. Define both beside the agent that selects them.

## Define a native tool

```ts
import { defineTool } from '@purista/harness'
import { z } from 'zod'

export const findOrder = defineTool('findOrder', {
  description: 'Find one order visible to the current customer.',
  input: z.object({ orderId: z.string() }),
  output: z.object({ status: z.string() }),
  async handler(context, input) {
    context.logger.debug('Finding an order', { order_id: input.orderId })
    return { status: 'processing' }
  },
})
```

The input schema validates model-generated arguments before the handler runs.
The output schema validates the handler result before it returns to the model.
Keep the description specific because the model uses it to choose tools.

## Declare resources

A portable tool receives common run metadata by default. Memory and sandbox
facades appear only when the definition declares them:

```ts
export const searchNotes = defineTool('searchNotes', {
  description: 'Search notes from this session.',
  input: z.object({ query: z.string() }),
  output: z.object({ matches: z.array(z.string()) }),
  requires: {
    memory: ['memory.text_search'],
    sandbox: ['sandbox.fs'],
  },
  async handler({ memory, sandbox }, input) {
    const notes = await memory.session.search({ text: input.query, limit: 5 })
    await sandbox.write('/workspace/last-query.txt', input.query)
    return { matches: notes.items.map(item => item.content) }
  },
})
```

These requirements are projected into `getInstance`, so an incompatible
runtime fails before execution.

In a PURISTA service, use the PURISTA host-tool helper when a tool must invoke a
command, enqueue work, or emit an event. The helper adds the service context and
preserves the trusted principal and tenant. The portable Harness definition
still contains no EventBridge or service instance.

## Attach tools to an agent

```ts
const support = defineAgent('support', {
  instructions: 'Help the customer using verified order data.',
  tools: [findOrder, searchNotes],
})

const definition = defineHarness({ name: 'support' }).addAgent(support)
```

Use direct definition references. String tool ids are not accepted, which
prevents missing definitions and runtime name lookup.

## Use built-in tools

`builtInTools` provides sandbox-backed file and command operations. Each tool
declares its exact sandbox capability. Selecting `builtInTools.read`, for
example, makes a compatible sandbox binding required.

## Define an Agent Skill

```ts
import { defineSkill } from '@purista/harness'

export const supportMethod = defineSkill('support-method', {
  directory: new URL('../skills/support-method/', import.meta.url),
})
```

The directory contains `SKILL.md` and any supporting files. Harness exposes
reviewed text through the scoped `read_skill` tool. Add `runtimes: ['node']`,
`['python']`, or `['shell']` only when the Skill includes scripts that need that
runtime. Runtime-bearing Skills additionally require a sandbox with filesystem
and read-only-mount capabilities. Runtime availability never grants tool
authority; the agent still needs a selected tool to execute anything.

```ts
const support = defineAgent('support', {
  instructions: 'Follow the support method.',
  tools: [findOrder],
  skills: [supportMethod],
})
```

Skills may be shared through a catalog:

```ts
const supportCatalog = defineCatalog('supportCatalog', {
  tools: [findOrder],
  skills: [supportMethod],
  agents: [support],
})

const definition = defineHarness({ name: 'app' }).use(supportCatalog)
```

`defineCatalog` is an immutable package of definitions. It is useful for reuse
and distribution. Inside one application, add the agent directly; its tool and
Skill references bring those leaf definitions into the compiled dependency
closure.

## Test tools

Call the tool handler with a typed fake context for unit tests, or compose it
into a Harness with `FakeModelProvider` to test validation and model-driven
selection. Include invalid input, denied access, cancellation, and adapter
failure cases when they affect the tool.
