# Tools

**Purpose.** Defines the built-in tools (which ship with the harness and operate against the Sandbox), TypeScript custom tools, and executable MCP stdio/HTTP tools. Custom tools are registered via `defineHarness().tools({...})`. There is no standalone `defineTool` factory; only inline-in-builder objects achieve cross-key type safety. Portable Agent Plugins bind selected servers through these same definitions; see [29-agent-plugins](./29-agent-plugins.md).

## Built-in tools

The harness ships seven built-in tools that operate directly against the `SandboxSession`. They are available to every agent by default — the user opts out, not in.

### Inventory

Locked canonical names (lowercase) and PascalCase aliases:

| Canonical | Aliases       | Backed by                              | Description |
|-----------|---------------|----------------------------------------|-------------|
| `bash`    | `Bash`        | `SandboxSession.exec`                  | Run a shell command in the sandbox |
| `read`    | `Read`        | `SandboxSession.readText`              | Read a file from the sandbox |
| `write`   | `Write`       | `SandboxSession.write`                 | Write a file to the sandbox |
| `edit`    | `Edit`        | `read+write`                           | String replacement edit (find old_string → new_string) |
| `glob`    | `Glob`        | `SandboxSession.list` (recursive + glob) | Pattern-match files |
| `grep`    | `Grep`        | `bash` (`grep -rn`) when executor available, else `read+match` fallback | Search file contents |
| `list`    | `LS`, `List`  | `SandboxSession.list`                  | List directory entries |

### Schemas (Zod, locked)

```ts
const builtinTools = {
  bash: {
    description: 'Run a shell command in the sandbox. Returns stdout, stderr, exitCode.',
    input: z.object({ command: z.string().min(1), cwd: z.string().optional(), timeoutMs: z.number().int().positive().optional() }),
    output: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() }),
  },
  read: {
    description: 'Read a text file from the sandbox.',
    input: z.object({ path: z.string().min(1), encoding: z.literal('utf-8').default('utf-8') }),
    output: z.object({ content: z.string() }),
  },
  write: {
    description: 'Write or overwrite a text file in the sandbox.',
    input: z.object({ path: z.string().min(1), content: z.string() }),
    output: z.object({ bytesWritten: z.number().int().nonnegative() }),
  },
  edit: {
    description: 'Replace exactly one occurrence of old_string with new_string in the given file.',
    input: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string() }),
    output: z.object({ replaced: z.literal(1) }),
  },
  glob: {
    description: 'List files matching a glob pattern under root (recursive).',
    input: z.object({ pattern: z.string().min(1), root: z.string().default('/') }),
    output: z.object({ paths: z.array(z.string()) }),
  },
  grep: {
    description: 'Search file contents for a regex pattern. Returns matching lines with paths and line numbers.',
    input: z.object({ pattern: z.string().min(1), path: z.string().default('/'), maxResults: z.number().int().positive().default(100) }),
    output: z.object({ matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })) }),
  },
  list: {
    description: 'List directory entries (non-recursive).',
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ entries: z.array(z.object({ name: z.string(), kind: z.enum(['file','directory']), size: z.number().int().optional() })) }),
  },
}
```

### Alias dispatch

Locked: when the model emits a tool call with a PascalCase alias, the harness dispatches to the canonical implementation transparently. The OTel `gen_ai.tool.name` attribute always uses the canonical lowercase name regardless of which alias the model used.

### Availability and gating

Locked rules:

- Built-in tools are available to every agent by default — the user opts out, not in.
- If `SandboxSession.executor === 'unavailable'`: `bash` and grep's exec-backed path are auto-disabled. `grep` falls back to a read+match implementation (slower; warned once per session via log).
- Per-agent `builtinTools` field controls inclusion:
  - `builtinTools: undefined` (default) — all built-ins enabled (subject to executor availability).
  - `builtinTools: false` — none.
  - `builtinTools: ['bash','read','grep']` — explicit subset (canonical names only; aliases are not allowed in config to avoid ambiguity).

### Tool definitions are model-facing

When the harness translates the agent's tool set for the model API, built-in tools are listed alongside custom tools as ordinary `ModelToolSpec` entries (name + description + JSON Schema). The model treats them no differently.

## Custom tools — discriminated union

```ts
type ToolDefinition = TsToolDefinition | McpStdioToolDefinition | McpHttpToolDefinition
```

All three carry `description` (and optionally `kind`). Tool ids (the keys of `.tools({...})`) match `/^[a-z][a-z0-9_]*$/` (≤64 chars), enforced at the builder call.

## TS tool

```ts
interface TsToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  kind?: 'ts'                                // default 'ts' if omitted
  description: string
  input: I
  output: O
  handler: (ctx: ToolHandlerContext, input: z.infer<I>) => Promise<z.infer<O>>
  configureHarnessContext?: (context: HarnessAdapterContext) => void
}

interface ToolHandlerContext {
  logger: Logger
  telemetry: TelemetryShim
  metrics: Metrics
  memory: MemoryFacade
  signal: AbortSignal
  sandbox: SandboxSession                   // the open session for this run
  runId: string
  sessionId: string
  agentId: string
  toolId: string
}
```

Behavior:

- Input is validated with `input.parse` before the handler runs. Failure throws [`ValidationError`](./15-error-catalog.md) (`category: 'validation'`, `retriable: false`).
- If `.governance(...).exposure` is configured, exposure rules can hide tools before the model call. If execution `policies` are configured, policy evaluation runs after input validation and before the handler runs. Policy denial or rejected approval returns a recoverable `PolicyDeniedError` tool result to the model.
- Output is validated with `output.parse` after the handler returns. Failure throws `ValidationError`.
- The `sandbox` exposed to the handler is the same `SandboxSession` the agent loop opened. Backend-internal policy (network deny lists, etc.) applies.
- Per-call timeout: `defaults.toolTimeoutMs`. On timeout: `OperationTimeoutError`.
- On `signal.abort`: `OperationCancelledError`.

## MCP stdio tool

```ts
interface McpStdioToolDefinition {
  kind: 'mcp_stdio'
  description: string
  command: string
  args?: readonly string[]
  env?: Record<string, string>
  install?: {
    command: string
    cwd?: string
    env?: Record<string, string>
    timeoutMs?: number
  }
  tool: string                              // upstream MCP tool name
  inputAdapter?: (input: unknown) => unknown
  outputAdapter?: (output: unknown) => unknown
}
```

Behavior:

- Implementation lives inside `@purista/harness` under `src/tools/mcp/`. The runners dynamically load `@modelcontextprotocol/client` v2 so harnesses with only TS tools do not load MCP code at runtime.
- Stdio MCP runs only through a spawn-capable `SandboxSession` (see [05-sandbox](./05-sandbox.md) §"Optional long-lived process capability"). The server is spawned once via `session.spawn(...)`, owned by the SDK's modern transport lifecycle, and killed on `runner.close()` or `session.close()`. There is no exec-only/one-shot transport. A sandbox without `spawn` fails with `SandboxNoExecutorError`.
- `install.command`, when provided, runs inside the same sandbox executor before first use. Use it to install or bootstrap the MCP server inside the sandbox, for example `npm install`/`npx` setup in a sandbox workspace.
- The MCP server's `tools/list` is queried before model tool exposure; the declared input/output JSON Schemas are validated by an embedded JSON Schema validator (see "MCP JSON Schema validator" below).
- `mcp_stdio` adapter input/output flow ordering is locked: `input → inputAdapter → JSON-Schema validate → MCP call → response → JSON-Schema validate → outputAdapter → return`.
- Per-call timeout from `defaults.toolTimeoutMs`.

### Current MCP protocol support

The MCP runtime pins a current Tier-1 SDK release implementing MCP
`2026-07-28`. Streamable HTTP uses only the stateless core, method/name routing
headers, cacheable list results, and task-augmented `tools/call` after mutual
capability negotiation. This is a clean breaking major cut: no stateful
protocol, HTTP+SSE transport, compatibility shim, or transport fallback is
retained. A task remains inside one normal tool invocation: timeout/abort also
cancel it where the server supports cancellation, and only its final normalized
result reaches the model. Unsupported server-to-client requests, task
`input_required`, and task failures do not create a user prompt or credential
flow; they fail as the existing safe MCP/tool errors.

Generic prepared stdio launch support lets an addon stage validated immutable
assets and a per-plugin writable data directory into the current sandbox. It is
not a second MCP runner and cannot bypass command/args separation, sandbox
execution, permissions, governance, validation, telemetry, or shutdown.

### Reconnect / process death

- If the stdio server exits during a call, the harness surfaces the failure as `McpProtocolError{meta.phase:'call'}`. In persistent mode the dead process is discarded and the next call re-spawns and re-initializes a fresh server (server-side state from before the crash is lost); in one-shot mode the next call simply starts a fresh exchange.
- `mcp_http` is a per-call HTTP request and has no persistent connection; reconnect semantics do not apply.

## MCP HTTP tool

```ts
interface McpHttpToolDefinition {
  kind: 'mcp_http'
  description: string
  url: string
  tool: string
  auth?: McpAuth
  headers?: Record<string, string>
  inputAdapter?: (input: unknown) => unknown
  outputAdapter?: (output: unknown) => unknown
}

type McpAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'oauth2'; accessToken: string }
  | { kind: 'api_key'; header: string; value: string }
  | { kind: 'basic'; username: string; password: string }
```

Behavior:

- Same validation/adapter flow as `mcp_stdio`.
- Auth failures throw [`McpAuthError`](./15-error-catalog.md) (`category: 'tool'`, `retriable: false` for 401, `true` for 5xx).
- Protocol-level failures (connection failure, list failure, malformed response) throw `McpProtocolError`.

## MCP JSON Schema validator

The harness ships an embedded JSON Schema validator (used by the MCP tool runners). Locked behavior:

- Draft: 2020-12.
- Supported keywords: `type`, `properties`, `required`, `items`, `enum`, `const`, `oneOf`, `anyOf`, `allOf`, `not`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `format` (only `'uri'`, `'email'`, `'date-time'`, `'uuid'`).
- Any unsupported keyword: log `warn` once per `(toolId, keyword)` pair, then accept the value as-is (no validation against the unsupported keyword).
- Validation failure throws `ValidationError{where:'mcp_input'|'mcp_output'}`.

## Tool lookup inside agents

The agent context exposes `tools` typed by the agent's declared tool ids (only the entries listed in the agent's `tools` array). Calling a tool id not in the agent's allowlist is a static type error and throws [`ToolNotFoundError`](./15-error-catalog.md) at harness.

## Errors

| Class                  | Thrown when                                              | Retriable |
|------------------------|----------------------------------------------------------|-----------|
| `ToolNotFoundError`    | tool id not in registry / not allowed for the agent      | no        |
| `ValidationError`      | input or output schema mismatch                          | no        |
| `PermissionDeniedError`| permission policy denied the call (per-call; recoverable)| no        |
| `PolicyDeniedError`    | governance policy or approval denied the call (recoverable)| no      |
| `PolicyEvaluationError`| governance adapter or predicate failed                   | no        |
| `ToolError`            | handler threw a non-harness error                        | as cause  |
| `SandboxNoExecutorError`| `bash` invoked when sandbox executor is unavailable     | no        |
| `McpProtocolError`     | MCP connection/list/call protocol failure                | yes       |
| `McpAuthError`         | MCP auth failure                                         | yes for 5xx |
| `OperationTimeoutError`| tool call exceeded `toolTimeoutMs`                       | yes       |
| `OperationCancelledError` | agent run aborted                                     | no        |

## Cross-references

- [24-governance-policy](./24-governance-policy.md) — optional policy, approval, shadow mode, and external adapter governance for tool calls.

- [05-sandbox](./05-sandbox.md) — sandbox port and the FS+exec surface that built-in tools layer on.
- [09-agents](./09-agents.md) — agent context `tools`, default loop, permissions.
- [15-error-catalog](./15-error-catalog.md).
- [14-otel-conventions](./14-otel-conventions.md) — `execute_tool {tool.name}` span (GenAI conv).
