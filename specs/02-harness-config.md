# Harness configuration

**Purpose.** Defines the synchronous `defineHarness()` chainable builder, every method's input shape, defaults, and validation rules. Invalid inputs throw [`HarnessConfigError`](./15-error-catalog.md) synchronously at the call site of the offending builder method. See also second-stage validators in [06-models](./06-models.md), [07-tools](./07-tools.md), [08-skills](./08-skills.md), [09-agents](./09-agents.md), and [10-workflows](./10-workflows.md).

## Signature

```ts
function defineHarness(opts?: HarnessOptions): HarnessBuilder<{}>
```

`defineHarness` is **synchronous** and returns a `HarnessBuilder`. Adapters are passed already-constructed; the harness never instantiates an adapter on the user's behalf. The full builder type surface lives in [13-public-api](./13-public-api.md).

The builder is the SOLE supported construction path. There are no standalone `defineAgent`/`defineWorkflow`/`defineTool`/`defineSkill`/`defineModel` factories — only inline-in-builder objects achieve the cross-key type constraints.

## Builder ordering (locked)

The methods MUST be called in this order, each at most once:

```
defineHarness(opts?)
  .telemetry(...)?  .logger(...)?  .state(...)?  .sandbox(...)?  .memory(...)?  .runtime(...)?  .requires(...)?  .defaults(...)?
  .models({...})            // REQUIRED, before tools/skills/agents/workflows
  .tools({...})?            // before agents
  .skills({...})?           // before agents
  .agents({...})            // before workflows
  .workflows({...})?
  .build()
```

- `models()` MUST be called before `tools()`, `skills()`, `agents()`, `workflows()`.
- `tools()` and `skills()` MUST be called before `agents()` (each may be omitted; the agent's allowed lists then come from an empty registry).
- `agents()` MUST be called before `workflows()`.
- Each of `models`/`tools`/`skills`/`agents`/`workflows` is callable AT MOST ONCE.
- `.memory(...)`, `.runtime(...)`, and `.requires(...)` are optional adapter-policy stages. They may be called before `.build()` and do not change the domain ordering.
- Calling out of order or twice is a TYPE error: each builder method returns a sub-builder type that omits methods which are no longer valid (already-set or out-of-order).
- `build()` is only present on builder types that have at least `models` set AND at least one of `agents`/`workflows` set.

The ordering also makes validation deterministic: each builder method runs its Zod parser synchronously and throws `HarnessConfigError` if the inputs fail.

## `HarnessOptions` (entry point)

```ts
interface HarnessOptions {
  /** Optional human-readable name; surfaced as `harness` in logs. Default: 'agent-harness'. */
  name?: string
}
```

## Builder methods

### `.telemetry(opts)`

```ts
interface TelemetryOptions {
  /**
   * Backend emission shape. Defaults to env `PURISTA_TELEMETRY_FLAVOR`, else
   * `'dual'`.
   */
  flavor?: 'dual' | 'gen_ai_only' | 'openinference_only'
  /**
   * Content telemetry policy. Defaults to env
   * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, else `'NO_CONTENT'`.
   * In v1 core, prompt, model output, tool input/result, file, expected-output,
   * and context content are never emitted. Memory content follows the bounded
   * memory-facade policy in `20-memory-adapters`.
   */
  contentCaptureMode?: 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'
}
```

Default: `{ flavor: 'dual', contentCaptureMode: 'NO_CONTENT' }`. Tracer and
meter names are locked to `'@purista/harness'` (see
[14-otel-conventions](./14-otel-conventions.md)).

Core v1 never emits prompt, model output, tool input/result, file,
expected-output, or context content in telemetry or persisted run events,
regardless of `contentCaptureMode`. Memory content is governed separately by
the facade rules in [20-memory-adapters](./20-memory-adapters.md): default
`NO_CONTENT` emits no raw memory content; non-`NO_CONTENT` modes opt into the
bounded memory content fields defined there.

### `.logger(logger)`

Pass a value implementing `Logger` (see [03-foundation](./03-foundation.md)). Default: built-in `JsonLogger`.

### `.state(store)`

Pass a `StateStore`. Default: `InMemoryStateStore`.

### `.sandbox(sandbox?)`

Pass a `Sandbox`. If omitted, or called with no argument, the harness auto-detects: tries `bashSandbox()` first; on import failure (the `just-bash` peer dep is not installed), falls back to `inMemorySandbox()`. See [05-sandbox](./05-sandbox.md).

### `.memory(adapter)`

Pass a `MemoryAdapter`. If omitted, the harness uses `sandboxMemory()`, the sandbox-backed reference adapter. See [20-memory-adapters](./20-memory-adapters.md).

Validation:

- `adapter.info.id` matches `/^[a-z][a-z0-9_.-]{1,63}$/`.
- `adapter.info.packageName` is non-empty.
- `adapter.info.capabilities` contains `'memory.kv'`.
- The method is callable at most once and only in the foundation stage after `.sandbox(...)` and before `.runtime(...)`, `.requires(...)`, `.defaults(...)`, or domain methods.

### `.runtime(runtime)`

Pass an optional durable runtime adapter descriptor. Core treats durable runtime
support as an opt-in adapter capability surface, not a mandatory worker or
queue. Runtime adapters declare `capabilities`; checkpoint, retry, lock, and
resume semantics stay owned by the runtime adapter.

### `.requires(capabilities)`

Declares adapter capabilities required by this harness definition:

```ts
defineHarness()
  .sandbox(snapshotSandbox)
  .memory(persistentMemory)
  .runtime(durableRuntime)
  .requires(['sandbox.snapshot', 'sandbox.resume', 'memory.persistent', 'runtime.checkpoint'])
```

`build()` aggregates capabilities from configured adapters and throws
`HarnessConfigError{meta.reason:'missing_required_capability'}` when any
required capability is unavailable. This gate is construction-time policy; a run
must not start with an unsupported adapter combination.

### `.defaults(d)`

```ts
interface HarnessDefaults {
  /** Max iterations of the default agent loop. Locked default: 16. */
  agentMaxIterations?: number
  /** Per-run wall-clock timeout in ms. Default: 600_000 (10 min). 0 disables; negative rejected. */
  runTimeoutMs?: number
  /** Per-tool-call timeout in ms. Default: 120_000. */
  toolTimeoutMs?: number
  /** Per-skill-call timeout in ms. Default: 60_000. */
  skillTimeoutMs?: number
  /** Per-model-call timeout in ms. Default: 300_000. */
  modelTimeoutMs?: number
  /**
   * Maximum number of conversation messages to pass into a model call.
   * `undefined` ⇒ pass all messages. `0` ⇒ pass system messages only.
   * Negative values rejected at the builder call with `HarnessConfigError`.
   * `system`-role messages are always included; remaining slots are filled
   * with the most recent non-system messages preserving chronological order.
   * Per-call override: `InvokeOptions.historyWindow`.
   */
  historyWindow?: number
}
```

Note that timeout fields keep `Ms` suffixes for backwards-readable API ergonomics; OTel-exposed durations use seconds (see [14-otel-conventions](./14-otel-conventions.md)).

### `.models(models)`

```ts
type ModelsConfig = Record<string, ModelAlias>

interface ModelAlias {
  provider: ModelProvider
  model: string
  capabilities: readonly ModelCapability[]
  defaults?: ModelDefaults
  /** Free-form provider-specific options, passed to the provider unchanged. */
  providerOptions?: Record<string, unknown>
}
```

Each key is the alias id referenced by agents. Validation:

- ≥1 alias required (otherwise the resulting builder type lacks `.agents()`/`.workflows()`/`.build()`).
- Each `model` must claim ≥1 capability.

Zod parser invoked synchronously inside the method; failure throws `HarnessConfigError`.

### `.tools(tools)`

```ts
type ToolsConfig = Record<string, ToolDefinition>

type ToolDefinition =
  | TsToolDefinition
  | McpStdioToolDefinition
  | McpHttpToolDefinition

interface TsToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  kind?: 'ts'                                // default 'ts' if omitted
  description: string
  input: I
  output: O
  handler: (ctx: ToolHandlerContext, input: z.infer<I>) => Promise<z.infer<O>>
  configureHarnessContext?: (context: HarnessAdapterContext) => void
}

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
  tool: string
  inputAdapter?: (i: unknown) => unknown
  outputAdapter?: (o: unknown) => unknown
}

interface McpHttpToolDefinition {
  kind: 'mcp_http'
  description: string
  url: string
  tool: string
  auth?: McpAuth
  headers?: Record<string, string>
}
```

See [07-tools](./07-tools.md) for full semantics. Validation rules (synchronous):

- Tool ids match `/^[a-z][a-z0-9_]*$/`, ≤64 chars.
- Tool ids may not collide with skill ids (cross-namespace).
- Tool ids may not collide with built-in tool canonical names (`bash`, `read`, `write`, `edit`, `glob`, `grep`, `list`).
- Reserved id prefixes (throw): `harness_`, `system_`.

### `.skills(skills)`

```ts
type SkillsConfig = Record<string, SkillDefinition>

interface SkillDefinition {
  /** Absolute path to the directory containing SKILL.md. */
  directory: string
}
```

The harness resolves `directory` and parses `SKILL.md` (YAML frontmatter) synchronously inside `.skills()`. See [08-skills](./08-skills.md) for the frontmatter schema and validation. The harness config key MUST equal the frontmatter `name`; mismatch throws `SkillManifestError{reason:'name_mismatch'}`.

### `.agents(agents)`

```ts
type AgentsConfig<S> = Record<string, AgentDefinition<S>>

interface AgentDefinition<
  S,
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  input?: I                                   // default: z.string()
  output?: O                                  // default: z.string()
  model: keyof S['models'] & string           // constrained to a registered alias
  instructions: string | ((ctx: AgentContextMinimal<S, z.infer<I>>) => string)
  tools?: readonly (keyof S['tools'] & string)[]
  builtinTools?: readonly BuiltinToolName[] | false   // default: all enabled
  skills?: readonly (keyof S['skills'] & string)[]
  permissions?: AgentPermissions
  onPermission?: OnPermission
  maxSteps?: number                           // default 16, max 64
  handler?: (ctx: AgentContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>
}
```

Cross-key constraints are enforced by the type system; harness additionally re-checks at the builder call. Validation (synchronous):

- Agent ids match `/^[a-z][a-z0-9_]*$/`, ≤64 chars; reserved prefixes `harness_`, `system_` rejected.
- `model` MUST reference a key from `.models(...)`.
- Every entry of `tools` MUST reference a key from `.tools(...)`.
- Every entry of `skills` MUST reference a key from `.skills(...)`.
- If `builtinTools` is an array, every entry MUST be one of `'bash'|'read'|'write'|'edit'|'glob'|'grep'|'list'`; unknown name → `HarnessConfigError`.
- If `permissions.bash` is set but the configured sandbox's executor will be unavailable at harness, the bash policy is still parsed but warning-logged (permissions for an unavailable tool are no-ops).
- `maxSteps`: positive integer, ≤64; otherwise `HarnessConfigError`.
- For agents WITHOUT a custom handler: the referenced model alias's `capabilities` MUST include `'object'`. If the agent declares any `tools` OR has any built-in tools enabled, the alias MUST additionally include `'tool_use'`. Violation → `HarnessConfigError{meta.reason:'agent_model_capability_mismatch'}`.

### `.workflows(workflows)`

```ts
type WorkflowsConfig<S> = Record<string, WorkflowDefinition<S>>

interface WorkflowDefinition<
  S,
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  input?: I                                   // default: z.string()
  output?: O                                  // default: z.string()
  handler: (ctx: WorkflowContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>
}
```

Validation:

- Workflow ids match `/^[a-z][a-z0-9_]*$/`, ≤64 chars; reserved prefixes rejected.
- Workflow ids may not collide with reserved Session member names: `'memory' | 'history' | 'close' | 'id' | 'workflows' | 'clearHistory' | 'replaceHistory'`. Violation → `HarnessConfigError`.
- `ctx.agents[k]` is typed by the registered agent keys.

### `.build()`

Returns the immutable `Harness<S>` (see [13-public-api](./13-public-api.md)). Available only when `models` and at least one of `agents`/`workflows` are set, enforced by the builder type.

## Defaults

| Key                                  | Default                              |
|--------------------------------------|--------------------------------------|
| `name`                               | `'agent-harness'`                    |
| `state`                              | `InMemoryStateStore`                 |
| `sandbox`                            | auto-detect: `bashSandbox()` if `just-bash` is installed, else `inMemorySandbox()` |
| `memory`                             | `sandboxMemory()`                    |
| `logger`                             | built-in `JsonLogger`                |
| `telemetry.flavor`                   | env `PURISTA_TELEMETRY_FLAVOR`, else `'dual'` |
| `telemetry.contentCaptureMode`       | env `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, else `'NO_CONTENT'` |
| `defaults.agentMaxIterations`        | `16`                                 |
| `defaults.runTimeoutMs`              | `600_000`                            |
| `defaults.toolTimeoutMs`             | `120_000`                            |
| `defaults.skillTimeoutMs`            | `60_000`                             |
| `defaults.modelTimeoutMs`            | `300_000`                            |
| `defaults.historyWindow`             | `undefined` (pass all messages)      |

## Validation rules summary (each thrown synchronously by the originating builder method)

1. `models` ≥1 entry, each with ≥1 capability — checked in `.models()`.
2. Every `agent.model` matches a `.models()` key — checked in `.agents()`.
3. Every `agent.tools[]` entry matches a `.tools()` key — checked in `.agents()`.
4. Every `agent.skills[]` entry matches a `.skills()` key — checked in `.agents()`.
5. For every skill: `SKILL.md` parsed, frontmatter validated, config key equals frontmatter `name` — checked in `.skills()`.
6. Tool/skill/agent/workflow/model-alias keys MUST match `/^[a-z][a-z0-9_]*$/`, ≤64 chars; reserved prefixes `harness_`/`system_` rejected; cross-namespace collisions (tool vs skill, tool vs built-in name) and reserved Session member collisions (workflows) rejected.
7. `defaults.runTimeoutMs === 0` disables the run timeout. Per-call timeouts must be > 0; negative values rejected. `InvokeOptions.timeoutMs` follows the same `>0/0/<0` rules: negative throws `ValidationError`.
8. Default-loop agents need `'object'` capability on their alias; `'tool_use'` if any custom tools or any built-in tools enabled — checked in `.agents()`.
9. `defaults.historyWindow`: `undefined`/`0`/positive int OK; negative → `HarnessConfigError`. Same rules apply to `InvokeOptions.historyWindow` (negative throws `ValidationError{where:'invoke_options'}`).
10. `agent.builtinTools` if an array MUST contain only valid built-in names; `agent.maxSteps` if set MUST be in `[1, 64]`.
11. `.requires(...)` entries MUST be stable `AdapterCapability` values and MUST be provided by configured adapters by `.build()`.
12. `telemetry.flavor` MUST be one of `'dual'`, `'gen_ai_only'`, or `'openinference_only'`.
13. `telemetry.contentCaptureMode` MUST be one of `'NO_CONTENT'`, `'SPAN_ONLY'`, `'EVENT_ONLY'`, or `'SPAN_AND_EVENT'`.
14. `memory.info` and memory adapter capabilities MUST pass the validation rules in [20-memory-adapters](./20-memory-adapters.md).

## `Harness<S>` returned object

The builder's `.build()` returns the typed `Harness<S>`. The full type surface (including `$infer`, `getSession`, and `inspect`) is locked in [13-public-api](./13-public-api.md).

`getSession` is `async` because the StateStore may be remote.

`shutdown()` calls `.close()` on every adapter that has the method (state, sandbox, memory, logger, every model provider). Every adapter's `close()` runs regardless of individual failures. Errors are aggregated and returned in `errors`. Errors are also logged at `error` level. Resolves when all attempts finish.

`inspect()` returns a synchronous, data-only snapshot of the resolved harness
setup: harness name, effective adapter capabilities, required capabilities, and
adapter descriptors. It must not make network calls or mutate runtime state.

## Cross-references

- [03-foundation](./03-foundation.md), [04-state-queue-stream](./04-state-queue-stream.md), [05-sandbox](./05-sandbox.md), [20-memory-adapters](./20-memory-adapters.md)
- [06-models](./06-models.md), [07-tools](./07-tools.md), [08-skills](./08-skills.md)
- [09-agents](./09-agents.md), [10-workflows](./10-workflows.md), [11-sessions](./11-sessions.md)
- [13-public-api](./13-public-api.md), [15-error-catalog](./15-error-catalog.md)
