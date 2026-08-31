# Agents

> **Approved schema update (2026-08-28):** [39-standard-schema-boundaries](./39-standard-schema-boundaries/00-vision.md) supersedes schema typing, validation, model projection, error, and cleanup rules in this document. [38-guardrail-authoring](./38-guardrail-authoring/00-vision.md) remains authoritative for other callback rules.
>
> **Approved registration update (2026-08-30):** [40-declarative-registration-and-guardrails-binding](./40-declarative-registration-and-guardrails-binding.md) supersedes agent callback-helper registration and Guardrails attachment in this document and spec 38.

Agents are configured high-level: declare input/output schemas, a model alias, instructions, optional custom tools, optional skills, and an optional permission policy. The harness runs the default agent loop — call model, dispatch tool calls, repeat until a final answer or `maxSteps` is exhausted. Custom loops via `handler` remain available as an escape hatch.

There is no standalone `defineAgent` factory; only inline-in-builder objects achieve the cross-key type constraints (`model` referencing a `.model()`/`.models()` key, `tools[]` referencing `.tool()`/`.tools()` keys, and `skills[]` referencing `.skill()`/`.skills()` keys).

## `AgentDefinition` (inline in builder)

```ts
interface AgentDefinition<
  S,
  I extends Schema = Schema,
  O extends Schema = Schema,
> {
  input?: I                                                     // default: z.string()
  output?: O                                                    // default: z.string()
  model: keyof S['models'] & string
  instructions: string | ((ctx: AgentContextMinimal<S, Infer<I>>) => string)

  tools?: readonly (keyof S['tools'] & string)[]                // custom tools
  builtinTools?: readonly BuiltinToolName[] | false             // default: none; explicit canonical-name allowlist
  skills?: readonly (keyof S['skills'] & string)[]

  permissions?: AgentPermissions

  maxSteps?: number                                             // default 16; positive integer, no hard upper cap
  prepareStep?: (ctx: AgentPrepareStepContext<S, Infer<I>>) => AgentPrepareStepResult<S> | Promise<AgentPrepareStepResult<S> | void> | void
  stopWhen?: (ctx: AgentStopWhenContext<S, Infer<I>>) => boolean | Promise<boolean>
  interceptors?: readonly AgentExecutionInterceptor<S, Infer<I>>[]
  handler?: (ctx: AgentContext<S, Infer<I>, InferIn<O>>) => Promise<InferIn<O>>   // escape hatch
}

type BuiltinToolName = 'bash' | 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'list'

interface AgentContextMinimal<S, I> {
  input: I
  sessionId: string
  runId: string
  history: ConversationHistory
  memory: MemoryFacade
  metadata: Readonly<Record<string, JsonValue>>
  metrics: Metrics
}
```

This compact shape shows shared fields. The public declaration is a correlated union: a default-loop entry without `handler` requires `O extends ModelSchema`; a custom-handler entry permits `O extends Schema`. Caller input is `InferIn<I>`, while callbacks receive validated `Infer<I>`.

The agent id is the first argument to `.agent(id, definition)` or a key under
`.agents({...})`. Both methods are repeatable and contribute to the same typed
registry. The builder validates each entry synchronously (see
[02-harness-config](./02-harness-config.md)). Agent contexts receive the scoped
`MemoryFacade` defined in [20-memory-adapters](./20-memory-adapters.md);
`ctx.memory.session` is equivalent to `session.memory` for the current session,
and `ctx.memory.agent` is bound to the current agent id when the configured
adapter supports agent scope. Durable workspace replay is not exposed as an
always-present agent context helper; custom handlers that need it receive
application-owned runtime bindings or use workflow step semantics backed by
[21-durable-workspaces](./21-durable-workspaces.md).

## `AgentContext`

```ts
interface AgentContext<S, I, O> {
  input: I
  instructions: string                  // resolved at run start (with skill index appended)
  models: { [K in keyof S['models']]: ModelHandle<S['models'][K]> }
  tools:  { [K in NonNullable<S['agents'][string]['tools']>[number]]: ToolInvoke<S['tools'][K]> }
  skills: { [K in NonNullable<S['agents'][string]['skills']>[number]]: SkillHandle }
  memory: MemoryFacade
  history: ConversationHistory          // read-only
  logger: Logger
  telemetry: TelemetryShim
  signal: AbortSignal
  runId: string
  sessionId: string
  metadata: Readonly<Record<string, JsonValue>>
  metrics: Metrics
}

interface ConversationHistory {
  list(opts?: { limit?: number; before?: string }): Promise<Message[]>
}
```

`MemoryFacade` and `SessionMemory` are defined in [20-memory-adapters](./20-memory-adapters.md) and [11-sessions](./11-sessions.md). `SkillHandle` exposes resolved skill metadata (`name`, `description`, `location`, `mountPath`, optional compatibility, trust, and diagnostics); skills are not "called" — the model accesses them via the sandbox `/skills/<name>/` mount.

Agents do not spawn other agents. Multi-agent orchestration is performed only inside workflow handlers via `WorkflowContext.agents`.

Governance policy is optional and configured at the harness builder level after
agents/workflows are declared. Agents do not wrap tools individually. When
configured, governance sees typed agent/tool/run context and evaluates tool
decisions through the lifecycle in [24-governance-policy](./24-governance-policy.md).

## Permissions

AgentPermissions retains bash/write/edit modes and allow/deny glob patterns. Modes are allow, require_approval and deny. Read/list/glob/grep remain outside this coarse denial configuration. One governance approval provider resolves permission and policy demands together. Exact validation, precedence, pattern behavior and failure outcomes: [decision contracts](./37-decision-boundaries/03-contracts/decisions.md).

## Default loop

The agent requires object capability and tool_use when tools are enabled. Parse input; apply ordered beforeInput with per-transform reparse; create sandbox and instructions; prepare model step; filter exposure; apply message-only beforeModel; call model; account completed response; apply observation-only afterModel. A final candidate passes beforeOutput then output schema, content event and persistence. Tool batches preflight every call before execution, preserve canonical effective wire arguments and once-parsed inputs, then apply permission/governance/approval/handler/output processing. Exact deadline, replay and cancellation rules are [CTR-DB-TOOLS and CTR-DB-RAILS](./37-decision-boundaries/03-contracts/decisions.md). No original uninspected tool arguments or intermediate assistant content are persisted.

### Loop controls

`maxSteps` overrides `defaults.agentMaxIterations` for one default-loop agent.
Both values must be positive integers. The harness does not silently clamp an
explicit budget: callers choose the finite iteration limit, while the existing
run and model timeouts remain independent safety bounds.

`prepareStep` and `stopWhen` customize the built-in loop without requiring a full
custom handler. Use them for bounded routing decisions: switch to a cheaper
model after the first call, temporarily disable tools, pass per-call model
options, or stop after a known tool-call marker. They must not hide business
orchestration that belongs in a workflow handler.

`prepareStep.activeTools` is a list of model-facing tool names from the already
resolved tool set. Unknown names throw `ValidationError{where:'agent_input'}`.
`prepareStep.model` must reference a configured model alias. `stopWhen` runs
after a model response and before tool execution; when it returns `true`, the
response object must satisfy the agent output schema.

### Output schema conversion

`ModelDefaults.parallelToolCalls` controls whether the provider may emit multiple
tool calls in one model response. `HarnessDefaults.maxParallelToolCalls` controls
how many of those returned calls the harness executes concurrently. Keep these
separate: one is provider generation behavior; the other is local runtime
backpressure.

For default-loop agents, `agent.output` is a `ModelSchema`. Its Standard JSON Schema input projection is compiled once during `build()` and reused for model calls. Custom-handler output needs only `Schema`. See [39-standard-schema-boundaries](./39-standard-schema-boundaries/03-contracts/model-projection.md).

### Tool spec construction

For each enabled tool (custom or built-in):

- `name`: tool id (custom) or canonical name (built-in).
- `description`: from config / built-in registry.
- `parameters`: cached JSON Schema from the tool input's Standard JSON Schema projection (custom TS) or built-in registry; cached from upstream `tools/list` for MCP tools.

## History conversion

Persisted `Message` records are converted to `ModelMessage[]` deterministically:

- `Message{role:'system'|'user', content}` → `{role, content}`.
- `Message{role:'assistant', content}` with no `toolCalls` → `{role:'assistant', content}`.
- `Message{role:'assistant', content, toolCalls}` → `{role:'assistant', content, toolCalls}`.
- `Message{role:'tool', toolResults}` → one `{role:'tool', toolCallId, content: JSON.stringify(result)}` per `toolResults` entry.
- Order is preserved by `Message.timestamp` ascending; ties are broken by `Message.id` ascending.

The effective `historyWindow` cap (`InvokeOptions.historyWindow ?? harness.defaults.historyWindow`) is applied before conversion: every `role:'system'` message is always included; remaining slots are filled with the most recent non-system messages preserving chronological order.

## Run timeout cancellation

```
runTimeoutMs (HarnessDefaults or InvokeOptions.timeoutMs)
        │
        ▼
AbortController (run-scoped)
        │
        ▼
workflow.signal
        │
        ├──▶ agent.signal ──┬──▶ tool.signal
        │                   ├──▶ model.signal
        │                   └──▶ sandbox.signal
        ▼
external InvokeOptions.signal (linked into the same controller)
```

When the run timeout fires, the controller aborts; every layer translates the abort into `OperationCancelledError` (per scope) or `OperationTimeoutError{scope:'run'}` when the harness detects the timeout source.
Workflow handlers, custom agent handlers, and tool handlers are raced against
the active signal, so the harness can finish the run even if application code
does not cooperatively poll `signal.aborted`. In-process JavaScript work cannot
be force-killed; non-cooperative promises may continue in the background, so
handlers should still stop work promptly when `signal` aborts.

## Custom handler agents

When `handler` is provided, the harness skips the default loop and invokes `handler(ctx)`. The handler is responsible for using `models`, `tools`, `skills`, etc. Its return is still awaited through the shared Standard Schema validator before completion.
The harness passes the run signal into `ctx.signal` and races the handler
against cancellation/timeout so a hung custom handler does not block the run
record from reaching a terminal state.

`ctx.models` remains the harness-scoped model registry: calls retain the active
trace, session, run, and agent attribution. A handler may opt a model call into
the native run-event pipeline with `{ emitRunEvents: true }` as the model
invocation context. The harness—not handler code—owns event ids, event ordering,
and persisted-event redaction. There is no arbitrary custom-event emitter on
`AgentContext`.

## Telemetry

- Span `invoke_agent {agent.name}` per invocation (GenAI conv); attributes `gen_ai.agent.name`, `gen_ai.agent.id`, `gen_ai.agent.description`, plus `harness.agent.id`, `harness.agent.model`, `harness.agent.has_handler`.
- Span `harness.agent.iteration` per default-loop iteration; attribute `harness.iteration.index`.
- Span `chat {request.model}` or equivalent provider operation per model call. Attributes follow the active telemetry flavor in [14-otel-conventions](./14-otel-conventions.md).
- Span `execute_tool {tool.name}` per tool call. Attributes follow the active telemetry flavor; for permission-gated calls, attributes `harness.permission.mode` and `harness.permission.decision` are always present.
- When governance is configured, policy evaluation spans/attributes and
  `policy.evaluated` events follow [14-otel-conventions](./14-otel-conventions.md)
  and [24-governance-policy](./24-governance-policy.md). Tool input/output
  content remains redacted by default.
- Error spans include safe `harness.error.*` attributes, including
  `harness.error.scope` and `harness.error.timeout_ms` when present.
- Histogram `harness.agent.iterations` (sample of total iterations).
- Counter `harness.permission.denials` per denied tool call.
- RunEvents: `agent.started`, `agent.finished`, `model.completed`, `model.object`, opt-in stream events (`model.delta`, `model.object.partial`, streamed final `model.object`) where model stream calls publish chunks, `tool.started`/`tool.finished`.

## Errors

| Class                  | When                                                       |
|------------------------|------------------------------------------------------------|
| `AgentNotFoundError`   | session/workflow references unknown agent id               |
| `AgentLoopBudgetError` | `maxSteps` exceeded                                        |
| `ValidationError`      | input/output schema mismatch                               |
| `ToolNotFoundError`    | model returned tool call for unknown name                  |
| `PermissionDeniedError`| `'deny'` mode or hook failure (per call; recoverable)      |
| `PolicyDeniedError`    | optional governance denied a tool call or approval failed (recoverable in default loop) |
| `DecisionEvaluationError`| optional governance evaluator failed or returned an invalid decision |
| `ModelError`           | provider failure                                           |
| `OperationTimeoutError`| per-call or run timeout                                    |
| `OperationCancelledError` | aborted                                                 |

## Cross-references

- [05-sandbox](./05-sandbox.md), [06-models](./06-models.md), [07-tools](./07-tools.md), [08-skills](./08-skills.md)
- [10-workflows](./10-workflows.md), [11-sessions](./11-sessions.md), [12-streaming](./12-streaming.md)
- [13-public-api](./13-public-api.md), [15-error-catalog](./15-error-catalog.md)
- [21-durable-workspaces](./21-durable-workspaces.md)
