# Workflow Guide

Use a workflow when application code must coordinate more than one step. A
workflow is not another model loop: it is typed orchestration code that can call
registered agents, direct model handles, memory, metrics, durable steps, and
application-owned adapters.

## When To Use A Workflow

Choose a workflow for:

- fan-out/fan-in across several agents;
- review, judging, or approval gates;
- retrieval orchestration with embeddings and rerank;
- deterministic checks before a final model call;
- durable checkpoints around long-running work;
- state or artifact writes that should stay outside the agent loop.

Keep a direct agent when one model loop can answer, classify, extract, or use
tools until it returns one validated result.

## Define Agents Before Workflows

Workflows are declared after agents so `ctx.agents` can be typed from the
registered agent keys. There is no standalone `defineWorkflow(...)` helper.

```ts
const harness = defineHarness({ name: 'incident-review' })
  .models({
    reasoning: {
      provider,
      model: 'gpt-5-mini',
      capabilities: ['object']
    }
  })
  .agents(({ agent }) => ({
    facts: agent({
      model: 'reasoning',
      input: z.object({ report: z.string() }),
      output: z.object({ facts: z.array(z.string()) }),
      builtinTools: false,
      instructions: 'Extract only concrete facts from the report.'
    }),
    risk: agent({
      model: 'reasoning',
      input: z.object({ facts: z.array(z.string()) }),
      output: z.object({ level: z.enum(['low', 'medium', 'high']), reasons: z.array(z.string()) }),
      builtinTools: false,
      instructions: 'Assess operational risk from the supplied facts.'
    })
  }))
  .workflows(({ workflow }) => ({
    review_incident: workflow({
      input: z.object({ report: z.string() }),
      output: z.object({
        facts: z.array(z.string()),
        level: z.enum(['low', 'medium', 'high']),
        reasons: z.array(z.string())
      }),
      delegation: { agents: ['facts', 'risk'] },
      handler: async (ctx) => {
        const facts = await ctx.agents.facts({ report: ctx.input.report })
        const risk = await ctx.agents.risk({ facts: facts.facts })
        return { facts: facts.facts, level: risk.level, reasons: risk.reasons }
      }
    })
  }))
  .build()
```

## Fan-Out And Fan-In

Use `Promise.all` when child agent calls are independent. Every call shares the
workflow run id and signal; message history is appended as branches finish.

```ts
delegation: { agents: ['security_review', 'docs_review', 'test_review'] },
handler: async (ctx) => {
  const [security, docs, tests] = await Promise.all([
    ctx.agents.security_review(ctx.input),
    ctx.agents.docs_review(ctx.input),
    ctx.agents.test_review(ctx.input)
  ])

  return synthesize({ security, docs, tests })
}
```

Use `Promise.allSettled` when a workflow can return partial results. Convert
failures into your output schema instead of leaking raw provider or tool
payloads.

## Delegation Policy

Workflow child-agent calls are disabled by default. A workflow must declare
`delegation` or the harness must opt in with `defaults.delegation.enabled: true`
before `ctx.agents.<id>(...)` can start a child agent.

Prefer workflow-local opt-in because it documents the orchestration contract
next to the handler:

```ts
.workflows(({ workflow }) => ({
  answer_with_review: workflow({
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string(), approved: z.boolean() }),
    delegation: {
      agents: ['answerer', 'reviewer'],
      maxChildAgentCalls: 4,
      maxParallelChildAgentCalls: 2,
      agentModelAliases: {
        reviewer: ['deep_review']
      }
    },
    handler: async (ctx) => {
      const draft = await ctx.agents.answerer({ question: ctx.input.question })
      const review = await ctx.agents.reviewer(draft, { model: 'deep_review' })
      return { answer: draft.answer, approved: review.approved }
    }
  })
}))
```

Policy reference mistakes fail during builder setup. Runtime budget violations
fail with `DelegationPolicyError` and preserve `workflow_id`, `agent_id`,
`reason`, and the relevant limit or model alias.

Settings:

- `enabled`: optional workflow switch. A `delegation` object enables delegation
  unless it sets `enabled: false`.
- `agents`: child-agent allowlist. Omit only when the workflow may call any
  registered agent.
- `maxChildAgentCalls`: total child-agent calls for one workflow run. Default
  after opt-in: `32`.
- `maxParallelChildAgentCalls`: maximum active child-agent calls. Default after
  opt-in: `8`.
- `maxDepth`: local delegation depth. Default after opt-in: `1`; `0` disables
  child-agent calls.
- `modelAliases`: model aliases allowed for all child-agent calls in this
  workflow.
- `agentModelAliases`: per-agent model alias allowlists. These override
  `modelAliases` for the named agent.

## Direct Model Work Inside Workflows

Workflow handlers can call `ctx.models.<alias>` directly for deterministic
orchestration steps that should not become reusable agents.

```ts
const embedding = await ctx.models.retrieval.embed(
  { input: ctx.input.question },
  ctx.signal
)
```

Storage, retrieval policy, authorization, and writes remain application code.
The harness owns provider calls, cancellation, validation, and telemetry.

## Durable Steps

`ctx.step(stepId, fn)` marks a JSON-serializable checkpoint boundary. It is a
transparent pass-through unless the workflow call opts into durable execution
and a durable runtime adapter is configured.

```ts
delegation: { agents: ['outline', 'writer'] },
const outline = await ctx.step('outline', () => ctx.agents.outline(ctx.input))
const report = await ctx.step('report', () => ctx.agents.writer(outline))
return report
```

Invoke durably with a stable run id:

```ts
await session.workflows.research_report.prompt(input, {
  durable: { runId: 'report-2026-06-12' }
})
```

Durable execution is workflow-only. Direct agent calls reject durable invoke
options.

## Streaming Workflow Runs

`session.workflows.<id>.stream(input)` emits typed `RunEvent` values for the
workflow run, child agent lifecycle events, tool calls, and final output. Direct
model stream chunks inside workflow code stay private unless that model stream
call opts in with `emitRunEvents: true`.

```ts
for await (const event of session.workflows.review_incident.stream(input)) {
  if (event.type === 'agent.started') console.log('agent', event.agentId)
  if (event.type === 'model.delta') process.stdout.write(event.delta)
  if (event.type === 'run.finished') console.log(event.output)
}
```

Map `RunEvent` to SSE, WebSocket, or UI events in your application. The harness
does not emit the Vercel stream protocol.

## Cancellation And Failure

Pass `signal` or `timeoutMs` on the workflow call. The harness races the handler
against the run signal and propagates cancellation into child agents, model
calls, tools, memory, and sandbox operations.

Handlers should still check `ctx.signal` before starting long-running side
effects and should stop starting new child work after cancellation.

Errors from child agents bubble unchanged unless the workflow catches them.
Workflow input and output are validated with the workflow Zod schemas.

## Testing

Test workflows with fake providers and deterministic adapters first:

- assert `session.workflows.<id>.prompt(...)` returns the validated output;
- assert `.stream(...)` emits lifecycle and final events you map in the UI;
- test child-agent failures and partial-result paths;
- test durable resume by repeating the same durable `runId`;
- assert prompts, tool inputs, raw documents, and secrets are absent from logs,
  traces, metrics, and persisted run events.
