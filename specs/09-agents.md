# Agents

Agents are configured high-level: declare input/output schemas, a model alias, instructions, optional custom tools, optional skills, and an optional permission policy. The harness runs the default agent loop — call model, dispatch tool calls, repeat until a final answer or `maxSteps` is exhausted. Custom loops via `handler` remain available as an escape hatch.

There is no standalone `defineAgent` factory; only inline-in-builder objects achieve the cross-key type constraints (`model` referencing a `.models()` key, `tools[]`/`skills[]` referencing `.tools()`/`.skills()` keys).

## `AgentDefinition` (inline in builder)

```ts
import type { z } from 'zod'

interface AgentDefinition<
  S,
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  input?: I                                                     // default: z.string()
  output?: O                                                    // default: z.string()
  model: keyof S['models'] & string
  instructions: string | ((ctx: AgentContextMinimal<S, z.infer<I>>) => string)

  tools?: readonly (keyof S['tools'] & string)[]                // custom tools
  builtinTools?: readonly BuiltinToolName[] | false             // default: all enabled (subject to executor availability)
  skills?: readonly (keyof S['skills'] & string)[]

  permissions?: AgentPermissions
  onPermission?: OnPermission

  maxSteps?: number                                             // default 16, max 64
  handler?: (ctx: AgentContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>   // escape hatch
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

The agent id is the key under `.agents({...})`. The builder validates each entry synchronously (see [02-harness-config](./02-harness-config.md)). Agent contexts receive the scoped `MemoryFacade` defined in [20-memory-adapters](./20-memory-adapters.md); `ctx.memory.session` is equivalent to `session.memory` for the current session, and `ctx.memory.agent` is bound to the current agent id when the configured adapter supports agent scope. Durable workspace replay is not exposed as an always-present agent context helper; custom handlers that need it receive application-owned runtime bindings or use workflow step semantics backed by [21-durable-workspaces](./21-durable-workspaces.md).

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
  log: Logger
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

## Permissions

### Per-tool permission

```ts
type PermissionMode = 'allow' | 'ask' | 'deny'

interface PermissionPolicy {
  mode: PermissionMode
  allow?: readonly string[]   // glob-like patterns matched against the input "command" (bash) or "path" (read/write/edit/list/glob/grep)
  deny?: readonly string[]
}

interface AgentPermissions {
  bash?:  PermissionMode | PermissionPolicy   // default 'allow'
  write?: PermissionMode | PermissionPolicy   // default 'allow'
  edit?:  PermissionMode | PermissionPolicy   // default 'allow'
  // read/list/glob/grep default to 'allow' and cannot be set to 'ask' or 'deny' (read-only operations always allowed within the sandbox)
}
```

Locked semantics:

- `'allow'` — call proceeds unconditionally.
- `'deny'` — throws `PermissionDeniedError` before invocation.
- `'ask'` — invokes `onPermission` if defined; if undefined, treated as `'deny'`.
- Pattern matching: glob-style (`*` matches any chars except `/`, `**` matches any including `/`). For `bash`, matched against the literal command string; for file tools, against the path. `deny` patterns evaluated first; then `allow` (if non-empty, must match); then `mode`.
- Read-only built-ins (`read`, `list`, `glob`, `grep`) cannot be denied in v1 — the model needs to navigate the sandbox FS for skill discovery to work. Locked rule.

### `onPermission` hook

```ts
interface PermissionContext {
  toolName: string         // canonical name
  input: unknown           // tool input
  agentId: string
  runId: string
  sessionId: string
}
type PermissionDecision = 'allow' | 'deny'
type OnPermission = (ctx: PermissionContext) => Promise<PermissionDecision>
```

`onPermission` is the ONLY async branch in the loop apart from tool execution itself. Timeouts: bounded by `defaults.toolTimeoutMs`. Hook errors → `PermissionDeniedError{reason:'hook_failed'}` and the tool call is denied.

Permission denials inside the loop are *recoverable* — the model is informed via a tool result message (`{error:'PERMISSION_DENIED'}`) and can adapt. Throwing a harness error would defeat the point. The agent run does NOT terminate on a permission denial.

## Default loop

The default loop requires the agent's model alias to claim `'object'` (and `'tool_use'` if the agent declares any `tools` or has any built-in tools enabled). Enforced at `defineHarness` time.

When `handler` is undefined, the harness executes this algorithm:

1. **Validate input** against the `input` schema → `ValidationError{where:'agent_input'}` on failure.
2. **Open sandbox session** (if not already open for this session). Mount declared skills.
3. **Build system message**:
   - Resolve `instructions` (string or function call).
   - Append the skill catalog format defined in [08-skills](./08-skills.md), including `Location: /skills/<name>/SKILL.md` and optional compatibility.
4. **Resolve tool set**:
   - Custom tools from `tools[]` (typed against harness config).
   - Built-in tools per `builtinTools` rule, filtered by sandbox executor availability.
5. **Build initial messages**: prior conversation history (capped by effective `historyWindow`) + the current user input as `Message{role:'user', content: stringify(input)}`. `stringify` is `String(input)` if a string, else `JSON.stringify(input)`.
6. **Loop** up to `maxSteps`:
   - a. Call `models[model].object(messages, tools, schema=outputSchema)`.
   - b. If response has no tool calls and includes structured `object` matching the output schema: validate; return.
   - c. If response has no tool calls and no valid `object`: throw `ModelError{reason:'unstructured_response'}`.
   - d. Execute the tool calls returned by that model response as one parallel batch, capped by `defaults.maxParallelToolCalls`:
     - Resolve canonical tool name (alias → canonical).
     - Check permissions. On `'deny'`, append a tool result message `{role:'tool', content: JSON.stringify({error:'PERMISSION_DENIED'})}` and continue (does NOT throw — the model can adapt).
     - Validate tool input against the tool schema. On failure, append a tool result with `error: ValidationError`.
     - Execute the tool (with timeout). On error, append the tool result with the serialized error.
     - Emit `tool.started` and `tool.finished` for each call as it starts/finishes; events from different calls in the same batch may interleave.
     - Append the assistant message + tool result messages to local history after the batch finishes, preserving the original model-returned tool-call order.
   - e. Increment the step counter; if it exceeds `maxSteps`, throw `AgentLoopBudgetError{reason:'iterations_exceeded'}`.
7. **Persist**: append every assistant + tool message produced in the loop to session history via `StateStore.appendMessages`.

### Output schema conversion

`ModelDefaults.parallelToolCalls` controls whether the provider may emit multiple
tool calls in one model response. `HarnessDefaults.maxParallelToolCalls` controls
how many of those returned calls the harness executes concurrently. Keep these
separate: one is provider generation behavior; the other is local runtime
backpressure.

`agent.output` (Zod) is converted to JSON Schema for the model call. See [13-public-api](./13-public-api.md) §"Schema conversion".

### Tool spec construction

For each enabled tool (custom or built-in):

- `name`: tool id (custom) or canonical name (built-in).
- `description`: from config / built-in registry.
- `parameters`: JSON Schema derived from the tool's input Zod schema (custom TS) or built-in registry; cached from upstream `tools/list` for MCP tools.

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

When `handler` is provided, the harness skips the default loop and invokes `handler(ctx)`. The handler is responsible for using `models`, `tools`, `skills`, etc. Output is still validated against `output.parse` after the handler returns.
The harness passes the run signal into `ctx.signal` and races the handler
against cancellation/timeout so a hung custom handler does not block the run
record from reaching a terminal state.

## Telemetry

- Span `invoke_agent {agent.name}` per invocation (GenAI conv); attributes `gen_ai.agent.name`, `gen_ai.agent.id`, `gen_ai.agent.description`, plus `harness.agent.id`, `harness.agent.model`, `harness.agent.has_handler`.
- Span `harness.agent.iteration` per default-loop iteration; attribute `harness.iteration.index`.
- Span `chat {request.model}` or equivalent provider operation per model call. Attributes follow the active telemetry flavor in [14-otel-conventions](./14-otel-conventions.md).
- Span `execute_tool {tool.name}` per tool call. Attributes follow the active telemetry flavor; for permission-gated calls, attributes `harness.permission.mode` and `harness.permission.decision` are always present.
- Error spans include safe `harness.error.*` attributes, including
  `harness.error.scope` and `harness.error.timeout_ms` when present.
- Histogram `harness.agent.iterations` (sample of total iterations).
- Counter `harness.permission.denials` per denied tool call.
- RunEvents: `agent.started`, `agent.finished`, `model.delta`/`model.message`, `model.object.partial`/`model.object` where structured output streaming is used, `tool.started`/`tool.finished`.

## Errors

| Class                  | When                                                       |
|------------------------|------------------------------------------------------------|
| `AgentNotFoundError`   | session/workflow references unknown agent id               |
| `AgentLoopBudgetError` | `maxSteps` exceeded                                        |
| `ValidationError`      | input/output schema mismatch                               |
| `ToolNotFoundError`    | model returned tool call for unknown name                  |
| `PermissionDeniedError`| `'deny'` mode or hook failure (per call; recoverable)      |
| `ModelError`           | provider failure                                           |
| `OperationTimeoutError`| per-call or run timeout                                    |
| `OperationCancelledError` | aborted                                                 |

## Cross-references

- [05-sandbox](./05-sandbox.md), [06-models](./06-models.md), [07-tools](./07-tools.md), [08-skills](./08-skills.md)
- [10-workflows](./10-workflows.md), [11-sessions](./11-sessions.md), [12-streaming](./12-streaming.md)
- [13-public-api](./13-public-api.md), [15-error-catalog](./15-error-catalog.md)
- [21-durable-workspaces](./21-durable-workspaces.md)
