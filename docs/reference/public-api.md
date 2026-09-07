# Public API

`@purista/harness` separates portable, immutable definitions from runtime
bindings. TypeScript derives the callable targets and required adapters from the
definition graph.

## Definition helpers

| Helper | Purpose |
| --- | --- |
| `defineTool(id, options)` | Native TypeScript tool with typed input, output, handler, and declared resources. |
| `defineSkill(id, options)` | Agent Skill directory and its required runtimes. |
| `defineMcpServer(id, options)` | Transport-free MCP server and selected typed tools. |
| `defineAgent(id, options)` | Standard bounded agent loop with tools, skills, subagents, policy, and guardrails. |
| `defineWorkflow(id, options)` | Typed application orchestration over exact agent and model references. |
| `defineCatalog(id, options)` | Reusable package of definitions and their transitive dependencies. |
| `defineHarness(options)` | Root definition with composition, inspection, and runtime creation. |

Definitions are frozen identity-bearing values. Use direct references throughout
the graph:

```ts
import { defineAgent, defineHarness, defineTool } from '@purista/harness'
import { z } from 'zod'

const search = defineTool('search', {
  description: 'Search approved documents.',
  input: z.object({ query: z.string() }),
  output: z.object({ passages: z.array(z.string()) }),
  handler: async (_ctx, input) => ({ passages: await index.search(input.query) }),
})

const answer = defineAgent('answer', {
  model: 'primary',
  instructions: 'Answer from approved documents and use search when needed.',
  tools: [search],
})

const definition = defineHarness({ name: 'knowledge' }).addAgent(answer)
```

`defineAgent` defaults to string input, string output, model alias `primary`, and
text-delta streaming. Supplying an input schema also requires a pure `prompt`
mapper. Supplying an output schema selects structured generation and
`output.object.snapshot` updates.

## Harness definition

`HarnessDefinition` exposes:

- `.addTool`, `.addSkill`, `.addMcpServer`, `.addAgent`, and `.addWorkflow`;
- `.use(catalog)` for reusable definition packages;
- `.inspect()` for a sanitized definition and requirement projection;
- `.catalog`, `.contracts`, `.requirements`, and type-only `.$infer`;
- `.getInstance(config)` to validate runtime bindings and create an executable instance.

Composition is additive and immutable. Duplicate IDs and conflicting foreign
definitions fail immediately.

## Runtime bindings

Bind provider clients, model names, admission controls, storage, memory,
sandbox, workspace, MCP transports, telemetry, and logging only when creating
an instance:

```ts
const instance = await definition.getInstance({
  models: {
    primary: { provider, model: 'gpt-5-mini', retry: true },
  },
  storage,
  memory,
  sandbox,
  telemetry: { contentCaptureMode: 'NO_CONTENT' },
})
```

For a graph that only uses `primary`, the singular `model` binding is the
short form:

```ts
const instance = await definition.getInstance({
  model: { provider, model: 'gpt-5-mini' },
})
```

The exact `HarnessInstanceConfig<typeof definition.requirements>` type requires
only resources projected by the graph and rejects unknown bindings.

## Sessions and invocation

```ts
const session = await instance.getSession('conversation-42')
try {
  const outcome = await session.agents.answer.run('How do refunds work?')

  const stream = session.agents.answer.stream('Explain the policy.')
  for await (const event of stream) {
    if (event.type === 'output.text.delta') process.stdout.write(event.delta)
  }
} finally {
  await session.release()
  await instance.close()
}
```

Every target has the same address-first surface:

- `session.agents.<id>.run(input, options?)`
- `session.agents.<id>.stream(input, options?)`
- `session.workflows.<id>.run(input, options?)`
- `session.workflows.<id>.stream(input, options?)`

`run` resolves to `RunOutcome<Output>` with status `completed` or
`interrupted`. Failures and cancellation throw normalized Harness errors.
`stream` returns a cancellable `HarnessTargetStream`; call `stream.cancel()`
when a client disconnects. The terminal `run.finished` event carries the same
aggregate outcome, plus terminal failed and cancelled variants.

Invocation options include cancellation, timeout, history window,
idempotency key, metadata, tracing, context projection, approval resume, and
durable invocation identity.

## Execution events

`ExecutionEvent` is the provider-neutral runtime stream. Its v1 discriminators
are exported as `harnessExecutionEventTypesV1` and include:

- run, agent, and model lifecycle;
- `output.text.delta`, `output.object.snapshot`, files, and progress;
- tool input, start, and finish;
- governance and approval;
- durable waits, fan-out, and child tasks;
- `stream.overflow` for bounded observer buffers.

Use `@purista/harness-ai-sdk-ui/v1` to project this contract to the standard AI
SDK UI Message Stream v1 SSE protocol. Do not expose provider-specific streams
or raw internal events to a browser.

## Approval interruption and resume

Approval is a typed interruption, not a server error. Persist and display the
requests from `outcome.interrupt`, collect one decision for every request, then
resume the same logical run:

```ts
if (outcome.status === 'interrupted' && outcome.interrupt.type === 'tool-approval') {
  const resumed = await session.agents.answer.run(input, {
    resume: {
      type: 'tool-approval',
      runId: outcome.runId,
      decisions,
    },
  })
}
```

The AI SDK UI adapter maps these requests to standard tool approval parts so
`useChat` clients can call `addToolApprovalResponse` and reconnect to the
resumed stream.

## Tools, skills, and subagents

`defineTool` handlers receive a content-free context with cancellation,
logging, telemetry, identity, run correlation, metadata, and only the memory or
sandbox operations declared in `requires`.

`defineSkill` declares a directory and optional `node`, `python`, or `shell`
runtime requirements. Skills are mounted read-only and loaded on demand through
the built-in skill reader.

Subagents are direct references on their parent:

```ts
const coordinator = defineAgent('coordinator', {
  instructions: 'Delegate specialist work when useful.',
  subagents: {
    researcher,
    writer: { agent: writer, description: 'Draft the final answer.' },
  },
  loop: { maxSubagentCalls: 4, maxParallelSubagents: 2, maxDepth: 2 },
})
```

The compiled graph collects these dependencies recursively and detects cycles.

## Workflows

A workflow declares exact local names for the agents and direct model handles
its handler may call:

```ts
const investigate = defineWorkflow('investigate', {
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  agents: { researcher },
  agentCalls: { maxCalls: 4, maxParallel: 2 },
  handler: async (ctx) => {
    const answer = await ctx.agents.researcher.run(ctx.input.question, {
      callId: 'research',
      signal: ctx.signal,
    })
    return { answer }
  },
})
```

Handlers also receive `step`, `fanOut`, child tasks, logging, telemetry,
metrics, correlation metadata, and, for durable workflows, external waits.

## Schemas

`Schema`, `ModelSchema`, `Infer`, and `InferIn` use Standard Schema. A schema
whose value is produced by a model must also expose Standard JSON Schema. This
includes native tool input and standard-agent output. Zod and ArkType satisfy
both contracts directly; Valibot can use its official JSON Schema wrapper at
model-facing boundaries.

All values are validated before crossing handler, provider, persistence,
telemetry, or result boundaries.

## Lifecycle and persisted state

`session.release()` releases a borrowed live session and retains persisted
state. `session.destroy()` deletes the session and its persisted state.
`instance.close()` closes instance-owned resources once. Session history,
memory, child tasks, and content-free run summaries remain session-scoped.

Package-specific provider, storage, memory, sandbox, governance, Guardrail, and
UI adapter APIs are documented in their package READMEs and the corresponding
guides.
