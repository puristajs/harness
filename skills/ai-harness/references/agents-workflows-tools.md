# Agents, Workflows, Tools, And Skills

## Contents
- Choose Agent Or Workflow
- Agent Pattern
- Workflow Pattern
- TypeScript Tools
- Built-In Tools And Permissions
- MCP Tools
- Skills Mounted Into Agents

## Choose Agent Or Workflow
Use an agent when the unit of work is one typed model loop: answer, classify, extract, summarize, or use tools until it returns one validated output.

Use a workflow when the application needs orchestration: multiple agents, fan-out, review, deterministic checks, retries, writes, or RAG steps using embeddings/rerank.

Agents do not spawn agents. Workflows orchestrate agents through `ctx.agents`
with per-run delegation budgets and optional allowlists.

## Agent Pattern
```ts
.agents(({ agent }) => ({
  answerer: agent({
    model: 'reasoning',
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string(), citations: z.array(z.string()) }),
    builtinTools: false,
    tools: ['search_docs'],
    skills: ['support-writing'],
    instructions: (ctx) => `Answer with citations for: ${ctx.input.question}`
  })
}))
```

Default agent loop requirements:
- the model alias needs `object`
- the model alias needs `tool_use` when the agent has custom tools or enabled built-in tools
- output is validated after the model returns
- multiple tool calls returned by the same model response execute concurrently up to `defaults.maxParallelToolCalls`, with results returned to the next model call in the original call order
- `maxSteps` defaults from harness defaults and must stay bounded

Use a custom `handler` only when the default loop is the wrong execution model.

Current custom agent handler context includes `input`, resolved `instructions`, `models`, `memory`, `history`, `signal`, `runId`, `sessionId`, and optional `output`. It does not expose typed `ctx.tools` or callable skill handles in the implementation; use the default loop for model-driven tool use or call application services directly from the handler.

Custom agent handlers are raced against the run signal for timeout/cancel
finalization. Still check `ctx.signal` inside long-running work so application
side effects stop promptly.

## Workflow Pattern
```ts
.workflows(({ workflow }) => ({
  answer_with_review: workflow({
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string(), approved: z.boolean() }),
    delegation: {
      agents: ['answerer', 'reviewer'],
      maxChildAgentCalls: 2,
      maxParallelChildAgentCalls: 1,
      agentModelAliases: { reviewer: ['deep_review'] }
    },
    handler: async (ctx) => {
      const draft = await ctx.agents.answerer({ question: ctx.input.question })
      const review = await ctx.agents.reviewer(draft, { model: 'deep_review' })
      return { answer: draft.answer, approved: review.approved }
    }
  })
}))
```

Workflow handlers receive typed `ctx.input`, `ctx.agents`, `ctx.models`, `ctx.memory`, `ctx.metrics`, `ctx.signal`, `ctx.runId`, `ctx.sessionId`, and `ctx.step`.

Agents must be declared before workflows. The builder uses the previously
registered agent keys to type `ctx.agents`; do not document or implement a
standalone `defineWorkflow(...)` helper.

`ctx.step(stepId, fn)` marks a durable boundary. When the workflow is invoked with `{ durable: { runId } }` and an executable `.runtime(...)` is configured, a committed step replays its stored output on resume without re-running `fn`; otherwise it is a transparent pass-through. Durable execution is workflow-only — see `durable-feedback-operations.md`.

Use `Promise.all` or `Promise.allSettled` for parallel agent calls when the calls are independent. Propagate `ctx.signal` through lower-level calls and stop starting new work once aborted.
The harness also races workflow handlers against `ctx.signal`, so a run can
finish as cancelled/timed out even when handler code hangs. This is not a
thread/process kill; cooperative cancellation is still required for cleanup.

Child-agent delegation is disabled by default. Add `workflow.delegation` next to
handlers that call `ctx.agents`; the policy object enables that workflow unless
it sets `enabled: false`. After opt-in, defaults are 32 child-agent calls per
workflow run, 8 active child-agent calls at once, and depth 1. Use
`delegation.agents` for least privilege, raise/lower budgets per workflow, and
use `agentModelAliases` or `modelAliases` before passing `{ model: 'alias' }`
to `ctx.agents.<id>`.

Runtime policy violations throw `DelegationPolicyError`. Streamed and persisted
child-agent lifecycle events include `workflowId`, `delegationCallId`,
`delegationDepth`, and `modelAlias`; persisted payloads keep lineage metadata
but redact prompts and outputs.

Direct model streams inside workflow handlers are private to the handler unless
the model call opts in with `{ emitRunEvents: true }`. Workflow stream APIs emit
typed `RunEvent` values, not provider chunks or the Vercel stream protocol.

Workflow docs and examples should cover:
- choosing workflow vs direct agent;
- sequence and fan-out/fan-in patterns;
- durable `ctx.step(...)` boundaries;
- cancellation and timeout behavior;
- streaming through `session.workflows.<id>.stream(...)`;
- tests with fake providers, child-agent failure paths, and durable replay.

## TypeScript Tools
Use TypeScript tools for application APIs and deterministic logic:

```ts
.tools({
  search_docs: {
    description: 'Search internal docs for relevant passages.',
    input: z.object({ query: z.string() }),
    output: z.object({ hits: z.array(z.object({ id: z.string(), text: z.string() })) }),
    handler: async (ctx, input) => {
      ctx.logger.info('Searching docs.', { toolId: ctx.toolId })
      ctx.signal.throwIfAborted()
      return { hits: [] }
    }
  }
})
```

Rules:
- validate input and output with Zod schemas
- return JSON-compatible data
- respect `ctx.signal`
- use `ctx.sandbox` for sandboxed filesystem/exec behavior
- never log secrets or large raw document content

Exact `TsToolDefinition` fields:

```ts
{
  kind?: 'ts',
  description: string,
  input: z.ZodTypeAny,
  output: z.ZodTypeAny,
  handler: (ctx, input) => Promise<output>,
  configureHarnessContext?: (context) => void
}
```

`ToolHandlerContext` includes `signal`, `sandbox`, `logger`, `telemetry`, `runId`, `sessionId`, `agentId`, and `toolId`.

Tool ids are model-facing and should be stable lowercase identifiers. The implementation validates tool ids against the harness builder rules, so use names such as `search_docs`, `read_ticket`, or `render_panel_spec`.

## Built-In Tools And Permissions
Built-in tools are enabled by default unless `builtinTools: false` or a subset is configured.

Canonical built-ins:
- `bash`
- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `list`

Use permissions for mutating or risky built-ins:

```ts
permissions: {
  bash: { mode: 'ask', allow: ['npm test', 'npm run *'], deny: ['rm *'] },
  write: 'deny',
  edit: 'allow'
},
onPermission: async (ctx) => ctx.toolName === 'bash' ? 'allow' : 'deny'
```

Read-only built-ins are intentionally available so agents can navigate mounted skills and sandbox files.

## MCP Tools
Use `mcp_stdio` when the MCP server should run inside the sandbox executor:

```ts
docs_search: {
  kind: 'mcp_stdio',
  description: 'Search docs through a local MCP server.',
  install: {
    command: 'npm install @example/docs-mcp',
    cwd: '/workspace',
    timeoutMs: 120_000
  },
  command: 'npx',
  args: ['-y', '@example/docs-mcp'],
  env: { DOCS_ROOT: '/workspace/docs' },
  tool: 'search',
  inputAdapter: (input) => input,
  outputAdapter: (output) => output
}
```

Use `mcp_http` when calling a remote MCP endpoint:

```ts
remote_search: {
  kind: 'mcp_http',
  description: 'Search remote docs.',
  url: process.env.DOCS_MCP_URL!,
  tool: 'search',
  auth: { kind: 'bearer', token: process.env.DOCS_MCP_TOKEN! }
}
```

MCP stdio requires an executor-capable sandbox. Add `@modelcontextprotocol/sdk` only when MCP is needed.

MCP validation/order:
1. optional `inputAdapter`
2. validate against upstream MCP input JSON Schema
3. MCP call
4. validate upstream output JSON Schema
5. optional `outputAdapter`
6. return normalized JSON output

HTTP auth forms are `none`, `bearer`, `oauth2`, `api_key`, and `basic`.

## Skills Mounted Into Agents
A harness skill directory contains a `SKILL.md` file. Register the directory and allowlist it on agents:

```ts
.skills({
  'incident-responder': { directory: join(import.meta.dirname, 'skills/incident-responder') }
})
.agents(({ agent }) => ({
  writer: agent({
    model: 'reasoning',
    output: z.object({ summary: z.string() }),
    skills: ['incident-responder'],
    instructions: 'Use the mounted incident-responder guidance.'
  })
}))
```

The harness injects only the skill index into instructions. The model reads `/skills/<name>/SKILL.md` and supporting files through built-in filesystem tools when needed.

If a skill is attached and you disable all built-ins, the model cannot inspect the mounted files. Prefer `builtinTools: ['read', 'list', 'grep']` for skill-driven agents that do not need mutation or shell execution.
