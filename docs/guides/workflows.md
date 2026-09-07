# Workflows

An agent is a configurable model loop. A workflow is application-controlled
orchestration around agents, models, durable steps, parallel work, and external
waits.

## Define callable agents

```ts
const collectFacts = defineAgent('collectFacts', {
  input: incidentInput,
  output: factsOutput,
  instructions: 'Extract verified facts only.',
  prompt: input => ({ role: 'user', content: input.report }),
})

const assessRisk = defineAgent('assessRisk', {
  input: factsOutput,
  output: riskOutput,
  instructions: 'Assess operational risk from the supplied facts.',
  prompt: input => ({ role: 'user', content: JSON.stringify(input) }),
})
```

## Define the workflow

```ts
const reviewIncident = defineWorkflow('reviewIncident', {
  input: incidentInput,
  output: reviewOutput,
  agents: { collectFacts, assessRisk },
  agentCalls: { maxCalls: 4, maxParallel: 2 },
  async handler(ctx) {
    const facts = await ctx.agents.collectFacts.run(ctx.input, {
      callId: 'collectFacts',
    })
    const risk = await ctx.agents.assessRisk.run(facts, {
      callId: 'assessRisk',
    })
    return { facts, risk }
  },
})

const definition = defineHarness({ name: 'incidentReview' })
  .addWorkflow(reviewIncident)
```

The workflow context exposes only the agents named in `agents`. Each call
needs a stable `callId`, which gives durable replay a deterministic identity.
The compiler includes referenced agents and their tools automatically.

## Run independent work in parallel

```ts
const results = await ctx.fanOut(items, async (item, index) => {
  return ctx.agents.collectFacts.run(item, { callId: `fact-${index}` })
}, { concurrency: 4 })
```

`fanOut` applies a fixed concurrency ceiling and emits lifecycle events.
`agentCalls` provides a definition-level budget for total and parallel agent
calls.

## Call models directly

Workflows can select exact model capabilities without defining an agent:

```ts
const embedDocuments = defineWorkflow('embedDocuments', {
  input: documentsInput,
  output: embeddingsOutput,
  models: {
    embeddings: { alias: 'embeddings', capabilities: ['embeddings'] },
  },
  async handler(ctx) {
    return ctx.models.embeddings.embed(
      { input: ctx.input.documents },
      ctx.signal,
    )
  },
})
```

The model alias and `embeddings` capability are projected into the runtime
configuration.

## Add durable steps

```ts
const publishReport = defineWorkflow('publishReport', {
  input,
  output,
  durable: true,
  agents: { writer },
  async handler(ctx) {
    const draft = await ctx.step('draft', () =>
      ctx.agents.writer.run(ctx.input, { callId: 'writer' }),
    )
    return ctx.step('publish', () => publishOnce(draft))
  },
})
```

Use stable step ids and JSON-compatible results. On resume, Harness reuses a
committed step result instead of repeating the side effect. A durable Harness
definition needs a deployment `revision` and a persistent `storage` binding.

## Wait for an external decision

A workflow with `durable: true` can request an external wait through
`ctx.externalWait.wait(request)`. The target returns an `interrupted`
outcome. The application records and authorizes the human decision, signals the
wait through storage, and resumes the same durable run.

Use tool approval for model-requested tool calls. Use an external wait for an
application-owned business checkpoint such as legal review or payment approval.

## Start child tasks

`ctx.childTasks.start` creates an isolated child-agent task. Use
`mode: 'one_shot'` for background work or `mode: 'continuable'` for a short
sequential conversation. The child agent must appear in the workflow's
`agents` map, and sandbox groups must be declared in
`childTaskSandboxGroups`.

## Stream a workflow

```ts
const session = await instance.getSession('incident-42')
const stream = session.workflows.reviewIncident.stream(input)

try {
  for await (const event of stream) {
    if (event.type === 'run.finished') console.log(event.outcome)
  }
} finally {
  await session.release()
}
```

Call `stream.cancel()` when a disconnected caller should cancel the actual
execution. Stopping iteration only stops local observation.
