# Agents, Workflows, Tools, And Skills

## Contents
- Choose Agent Or Workflow
- Agent Pattern
- Workflow Pattern
- TypeScript Tools
- Built-In Tools And Permissions
- Optional Governance Policies
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
- `maxSteps` defaults from harness defaults; both are positive integer budgets with no hidden upper cap
- `prepareStep` can adjust one model call by switching to another configured model alias, narrowing `activeTools`, overriding instructions/messages, or passing model call options
- `stopWhen` runs after a model response and before tool execution; when it returns `true`, the response object must satisfy the output schema and becomes the final answer
- `interceptors` are ordered, fail-closed default-loop hooks. `beforeInput` runs before dynamic instructions/transcript work; `afterModel` runs before events, output validation, persistence, and tool dispatch; tool hooks wrap the actual side effect. Use them through `@purista/harness-guardrails` unless an application owns a different generic boundary concern.
- Guardrails produce content-free `evaluate_guardrail {rail.id}` OpenInference `GUARDRAIL` spans plus `harness.guardrail.evaluations` and `harness.guardrail.duration`. Treat `outcome='block'` as an expected enforced policy decision and reserve span errors for action failures/timeouts. Retrieval remains caller-owned; pass its run-scoped models, abort signal, and logger to `filterRetrievedChunks`.

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

Workflow handlers receive typed `ctx.input`, `ctx.agents`, `ctx.models`, `ctx.log`, `ctx.memory`, `ctx.metrics`, `ctx.signal`, `ctx.runId`, `ctx.sessionId`, `ctx.step`, `ctx.fanOut`, and `ctx.childTasks`. `ctx.log` is the harness logger; never log prompts, outputs, or other content payloads.

Agents must be declared before workflows. The builder uses the previously
registered agent keys to type `ctx.agents`; do not document or implement a
standalone `defineWorkflow(...)` helper.

`ctx.step(stepId, fn, options?)` marks a durable boundary. When the workflow is invoked with `{ durable: { runId } }` and an executable `.runtime(...)` is configured, a committed step replays its stored output on resume without re-running `fn`; otherwise it is a transparent pass-through. Use `options.retry` for short active retries before checkpoint commit. Durable execution is workflow-only — see `durable-feedback-operations.md`.

Use `ctx.fanOut(items, worker, { concurrency })` for ordered, bounded parallel work. `Promise.all` or `Promise.allSettled` remain appropriate when application-defined behavior is needed; propagate `ctx.signal` through lower-level calls and stop starting new work once aborted.

Use `ctx.childTasks.start('reviewer', input)` when a workflow should return a task id before isolated work completes; application code can later retrieve the task only through `session.childTasks.get(id)`. A child task uses the chosen agent's established tool, skill, model, and delegation boundaries, owns a separate sandbox/run, and never appends its private messages to the parent session history. For a short task-owned conversation, pass `{ mode: 'continuable' }`, call `send(input)` sequentially, and finish with `close()`. This mode is in-process only and is rejected for durable workflow invocation; use an application queue/worker adapter for restart-safe work.
The harness also races workflow handlers against `ctx.signal`, so a run can
finish as cancelled/timed out even when handler code hangs. This is not a
thread/process kill; cooperative cancellation is still required for cleanup.

Child-agent delegation is disabled by default. Add `workflow.delegation` next to
handlers that call `ctx.agents`; the policy object enables that workflow unless
it sets `enabled: false`. After opt-in, defaults are 32 child-agent calls per
workflow run, 8 active child-agent calls at once, and depth 1. Use
`delegation.agents` for least privilege and raise/lower budgets per workflow.
`modelAliases` restricts every child-agent call in the workflow — including
calls that run on the agent's default `model` — and `agentModelAliases`
replaces that set for the named agent; configure one of them before passing
`{ model: 'alias' }` to `ctx.agents.<id>`.

Runtime policy violations throw `DelegationPolicyError`. Streamed and persisted
child-agent lifecycle events include `workflowId`, `delegationCallId`,
`delegationDepth`, and `modelAlias`; persisted payloads keep lineage metadata
but redact prompts and outputs.

Direct model streams inside workflow handlers are private to the handler unless
the model call opts in with `{ emitRunEvents: true }`. Workflow stream APIs emit
typed `RunEvent` values, not provider chunks or the Vercel stream protocol.

Workflow docs and examples should cover:
- choosing workflow vs direct agent;
- sequence, routing, fan-out/fan-in, and evaluator-optimizer patterns;
- durable `ctx.step(...)` boundaries;
- long-running workflow version boundaries for runs that may outlive one deploy;
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

## Optional Governance Policies
Governance is an opt-in business policy layer. Do not add `.governance(...)`
to examples or apps unless they need policy-driven model-facing tool exposure,
tool-call execution decisions, approvals, audit evidence, or an external policy
adapter.

Keep the layers distinct:
- agent `tools` and `builtinTools` define the maximum tool set an agent may use
- built-in `permissions` gate risky built-ins such as `bash`, `write`, and `edit`
- governance `exposure` can hide configured tools before a model step
- governance `policies` evaluate a specific tool call after permissions,
  allowlists, and TypeScript input validation but before handler execution

Use exposure rules when the model should not even see a capability for a
tenant, plan, workflow, rollout, or step:

```ts
.governance(({ exposureRule }) => ({
  exposure: {
    id: 'tenant-tool-exposure',
    version: '2026-06-30',
    rules: [
      exposureRule({
        id: 'hide-transfers-for-readonly-tenants',
        effect: 'hide',
        tools: ['transfer_funds'],
        when: ({ metadata }) => metadata.plan === 'readonly',
        reason: 'Readonly tenants cannot use transfer tools.',
        riskLevel: 'high',
        tags: ['tenant-policy']
      })
    ]
  }
}))
```

Exposure runs after `prepareStep.activeTools` and before the model call. Hidden
tools are removed from the provider `tools` array. In `mode: 'shadow'`, the
harness emits `policy.exposure` decisions but does not hide tools. The runtime
also rejects provider tool calls whose tool name was not exposed for that step.

Use execution policies when a concrete tool call needs typed business rules:

```ts
.governance(({ native, rule, adapter }) => ({
  mode: 'enforce',
  defaultEffect: 'allow',
  approval: {
    request: async (request) => ({
      decision: request.input.amount <= 5_000 ? 'approved' : 'rejected',
      approverId: 'ops-console'
    })
  },
  policies: [
    native({
      id: 'bank-transfer-policy',
      version: '2026-06-30',
      rules: [
        rule({
          id: 'large-transfer-approval',
          effect: 'require_approval',
          tools: ['transfer_funds'],
          when: ({ input }) => input.amount > 1_000,
          reason: 'Large transfers need human review.',
          riskLevel: 'medium'
        }),
        rule({
          id: 'insufficient-funds',
          effect: 'deny',
          tools: ['transfer_funds'],
          when: ({ input }) => input.amount > input.balance,
          reason: 'Transfer amount exceeds available balance.',
          riskLevel: 'high'
        })
      ]
    }),
    adapter({
      id: 'external-policy-engine',
      version: 'bundle-42',
      evaluate: async (ctx) => undefined
    })
  ]
}))
```

`rule(...)` narrows `ctx.input` to the parsed Zod input for the selected
TypeScript tool. MCP and built-in tool policy input is JSON-compatible raw
input. `exposureRule(...)` narrows `ctx.toolId`; exposure rules do not receive
tool input because no call exists yet.

Execution effects resolve by precedence:
`deny > require_approval > audit > allow`.

`policies` are optional when only exposure rules are needed. When execution
policies are configured and no decision matches, `defaultEffect` defaults to
`deny`. A governance config with only exposure rules does not apply execution
default-deny later.

Use `mode: 'shadow'` to compare native, OPA, Cedar, Eve-style, or bespoke
policy engines before enforcing. External adapters translate harness context
into the engine input document and return `GovernanceDecision` values; the
harness does not own policy language syntax, bundle distribution, or rule-store
deployment.

Governance stream/audit evidence includes stable `decisionId`, optional
`policyVersion`, `approvalId` for approvals, `reason`, `riskLevel`, and `tags`.
Do not include raw tool input or output in policy events, logs, or telemetry.

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

MCP stdio requires a spawn-capable sandbox. Add `@modelcontextprotocol/client` only when MCP is needed.

For an Agent Plugins stdio binding, require more than `spawn`: the sandbox must
also implement `mountReadOnly(...)` so the digest-reviewed package root cannot
be changed by the plugin process. Supply an existing application-owned data
directory outside the plugin root for `PLUGIN_DATA`; the addon stages and
synchronizes only that directory. The local host-directory sandbox is not an
isolating Agent Plugins stdio backend.

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
