# Workflows

**Status:** active v4 topic contract.

A workflow is the Harness application-orchestration primitive. It owns a
custom typed handler and can coordinate explicitly declared agents, native or
host-aware tools, and model capabilities. An agent owns a standard model loop;
a workflow owns branching, iteration, fan-out, deterministic data processing,
ingestion, and long-running application flow.

[Spec 42 §7](./42-composable-definitions-and-catalogs.md) owns the exact types,
managed-call protocol, replay behavior, and execution context.

## Minimal definition

```ts
const normalizeInput = defineWorkflow('normalizeInput', {
  async handler({ input }) {
    return input.trim()
  },
})
```

Input and output default to the Harness string schema. The handler receives
validated input and must return the output schema's input type. The final value
is validated once before it becomes the workflow outcome.

## Declare capabilities

```ts
const ingestKnowledge = defineWorkflow('ingestKnowledge', {
  input: ingestInputSchema,
  output: ingestOutputSchema,
  agents: [extractKnowledge],
  tools: [saveKnowledgeChunks],
  models: {
    embeddings: {
      capabilities: ['embeddings'],
    },
  },
  async handler(ctx) {
    const extracted = await ctx.agents.extractKnowledge.run(
      { content: ctx.input.content },
      { callId: 'extractKnowledge' },
    )

    const vectors = await ctx.models.embeddings.embed(
      { input: extracted.chunks.map(chunk => chunk.text) },
      { callId: 'embedChunks' },
    )

    await ctx.tools.saveKnowledgeChunks.run(
      {
        chunks: extracted.chunks,
        vectors,
      },
      { callId: 'saveChunks' },
    )

    return {
      stored: extracted.chunks.length,
    }
  },
})
```

The context exposes exact maps derived from these declarations. An undeclared
agent, tool, or model alias does not exist on the type and cannot be resolved
through a string lookup.

Workflow model entries state required capabilities. Their object key is the
runtime model alias unless an explicit `alias` remaps it. The context exposes
capability-scoped invokers for text, structured output, embeddings, reranking,
image, speech, and video operations. It never exposes a raw provider or general
model index.

Workflow memory access is not implicit. A workflow that needs application or
vector data uses an explicitly declared tool so identity, authorization,
resource ownership, validation, events, and replay stay visible.

## Managed calls and stable ids

Every managed agent, tool, or model operation requires a stable `callId`.
The id identifies one logical effect for durability, retry, and replay. It is
not generated from array position, source line, or mutable control flow.

Managed invokers automatically propagate:

- cancellation and the nearest deadline;
- tenant/principal identity and trace context;
- workflow/run/session correlation;
- idempotency and deterministic checkpoint data;
- content-safe lifecycle events and telemetry.

A direct workflow tool call uses the same authentic binding, input/output
validation, host overlay, timeout, cancellation, event, telemetry, and managed
checkpoint machinery as an agent-selected call. It does not borrow an agent's
exposure, permission, governance, approval, or Guardrail policy. Business
authorization for a PURISTA host tool belongs in that tool's service guard.
Its caller is `{ kind: 'workflow', workflowId }`. It does not use a synthetic
agent id.
An agent call made inside a workflow keeps
`{ kind: 'agent', agentId, workflowId }`.

Repeating a committed call with an equal operation, target, input, options, and
idempotency identity returns the checkpointed result without another effect.
Reusing a `callId` for a changed logical operation fails with
`WorkflowCallReplayConflictError`.

## Agent calls

```ts
const answer = await ctx.agents.answerQuestion.run(
  { question: ctx.input.question },
  { callId: 'answerQuestion' },
)
```

The workflow receives the validated completed output. A failed child maps to
`WorkflowManagedCallError`; cancellation maps to
`OperationCancelledError`; approval interruption suspends the root
invocation tree through the package-private interruption control path. The
workflow handler does not accidentally treat an interruption as output.

Agent calls use the target dispatcher. In a hosted PURISTA runtime, every call
uses EventBridge and can reach another service instance. There is no direct
in-process fallback.

## Parallel work and fan-out

Independent managed calls may run through `Promise.all` within the declared
parallel limits. For data-driven fan-out, the workflow context exposes the
bounded fan-out and child-task facilities specified by
[spec 28](./28-workflow-child-tasks.md). Bounds cover total calls, parallel
calls, depth, and child-task admission.

Output order follows input order where the fan-out API promises an ordered
result, regardless of completion order. A failure cancels unfinished siblings
according to the child-task contract and preserves every cleanup failure.

## Durability

`durable: true` contributes durable Harness storage. `workspace: true`
also requires a durable workspace binding. External waits and durable child
tasks likewise make storage requirements explicit.

At each managed call boundary Harness records the stable call identity and
validated wire data needed for replay. Model calls use the same checkpoint
discipline as agents and tools and include model alias plus `callId` in
embedding, rerank, and media events. Workflow code never calls a provider
directly or reconstructs checkpoint logic.

Long-running deployment changes use the Harness application `revision`. A
durable graph requires it. A changed handler, schema, policy, prompt, or
orchestration contract must use a new revision so suspended work cannot resume
against different behavior.

## Streaming

A workflow may emit progress through managed agent, tool, model, artifact,
fan-out, child-task, and wait events. The public target stream contains exact
root events plus explicitly correlated nested events. Only the direct
workflow's root `run.finished` settles its public stream result.

Workflow outputs do not pretend to be token streams. Their contract update kind
is `none`; model/agent child output remains correlated nested activity. A
transport adapter may project progress and status without treating a nested
terminal event as the root answer.

## Cancellation and cleanup

Cancellation propagates to active child targets, model calls, tools, storage,
sandbox, waits, and live event delivery. Workflow code should pass no separate
AbortSignal because the managed invokers already carry the current signal.

Cleanup runs under the lifecycle contracts even if the handler fails. A
cleanup failure is aggregated and observed but does not repeat a committed
business effect.

## Required verification

- omitted and explicit schemas retain exact inference;
- undeclared agents, tools, models, and memory access fail statically and at
  erased runtime boundaries;
- stable call-id equality, replay, conflicts, cancellation, and deadlines;
- workflow and nested-agent caller correlation without synthetic identities;
- every direct tool call uses the common pipeline;
- model capability projection and embedding/rerank/media correlation;
- dispatcher-only agent execution in standalone and hosted runtimes;
- bounded sequential, parallel, fan-out, child-task, durable, and external-wait
  paths;
- nested events cannot settle the root stream.

## References

- [06 — models](./06-models.md)
- [07 — tools](./07-tools.md)
- [12 — streaming](./12-streaming.md)
- [21 — durable workspaces](./21-durable-workspaces.md)
- [28 — workflow child tasks](./28-workflow-child-tasks.md)
- [32 — Harness storage](./32-harness-storage.md)
- [42 — exact workflow contract](./42-composable-definitions-and-catalogs.md)
