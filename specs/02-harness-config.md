# Harness configuration

**Purpose.** Defines the synchronous `defineHarness()` chainable builder, every method's input shape, defaults, and validation rules. Invalid inputs throw [`HarnessConfigError`](./15-error-catalog.md) synchronously at the call site of the offending builder method. See also second-stage validators in [06-models](./06-models.md), [07-tools](./07-tools.md), [08-skills](./08-skills.md), [09-agents](./09-agents.md), and [10-workflows](./10-workflows.md).

## Signature

```ts
function defineHarness(opts?: HarnessOptions): HarnessBuilder<{}>
```

`defineHarness` is **synchronous** and returns a `HarnessBuilder`. Adapters are passed already-constructed; the harness never instantiates an adapter on the user's behalf. The full builder type surface lives in [13-public-api](./13-public-api.md).

The builder is the SOLE supported construction path. `defineHarnessModule()` is
a static transform helper for that builder, not a second construction path.
There are no standalone `defineAgent`/`defineWorkflow`/`defineTool`/`defineSkill`/`defineModel` factories — only inline-in-builder objects and static modules achieve the cross-key type constraints.

## Builder ordering and static modules (locked)

Direct builder methods MUST be called in this order, each at most once. A
`.use(module)` call may occur at any pre-build point and applies its static
transform to the accumulated builder; it cannot call `.build()` or another
`.use()`. Its contributions are additive and collision-rejecting as specified
in [25-static-harness-modules](./25-static-harness-modules.md).

```
defineHarness(opts?)
  .telemetry(...)?  .logger(...)?  .storage(...)?  .sandbox(...)?  .memory(...)?  .workspace(...)?  .requires(...)?  .defaults(...)?
  .use(module)?             // any pre-build point; static only
  .models({...})            // REQUIRED, before direct tools/skills/agents/workflows
  .tools({...})?            // before agents
  .skills({...})?           // before agents
  .agents({...})            // before workflows
  .workflows({...})?
  .governance(...)?         // optional late policy stage, after agents/workflows
  .build()
```

- `models()` MUST be called before `tools()`, `skills()`, `agents()`, `workflows()`.
- `tools()` and `skills()` MUST be called before `agents()` (each may be omitted; the agent's allowed lists then come from an empty registry).
- `agents()` MUST be called before `workflows()`.
- `governance()` is optional, callable at most once, and only after
  `agents()` and after `workflows()` if workflows are configured. It is late so
  the policy callback can type-check declared tool, agent, workflow, and model
  keys.
- Direct calls of `models`/`tools`/`skills`/`agents`/`workflows`/`governance`
  are each callable at most once. Contributions from modules append to their
  registry in caller order. Duplicate ids across direct and module calls fail
  synchronously; no family replaces earlier entries.
- `.storage(...)`, `.memory(...)`, `.workspace(...)`, and `.requires(...)` are optional adapter-policy stages. They may be called before `.build()` and do not change the domain ordering.
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
   * In v3 core, prompt, model output, tool input/result, file, expected-output,
   * and context content are never emitted. Memory content follows the bounded
   * memory-facade policy in `20-memory-adapters`.
   */
  contentCaptureMode?: 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'
}
```

Default: `{ flavor: 'dual', contentCaptureMode: 'NO_CONTENT' }`. Tracer and
meter names are locked to `'@purista/harness'` (see
[14-otel-conventions](./14-otel-conventions.md)).

Core v3 never emits prompt, model output, tool input/result, file,
expected-output, or context content in telemetry or persisted run events,
regardless of `contentCaptureMode`. Memory content is governed separately by
the facade rules in [20-memory-adapters](./20-memory-adapters.md): default
`NO_CONTENT` emits no raw memory content; non-`NO_CONTENT` modes opt into the
bounded memory content fields defined there.

### `.logger(logger)`

Pass a value implementing `Logger` (see [03-foundation](./03-foundation.md)). Default: built-in `JsonLogger`.

### `.storage(store)`

Pass a `HarnessStorage`. Default: `InMemoryHarnessStorage`.

### `.sandbox(sandbox?)`

Pass a `Sandbox`. If omitted, or called with no argument, the harness auto-detects: tries `bashSandbox()` first; on import failure (the `just-bash` peer dep is not installed), falls back to `inMemorySandbox()`. See [05-sandbox](./05-sandbox.md).

### `.memory(adapter)`

Pass a `MemoryAdapter`. If omitted, the harness uses `sandboxMemory()`, the sandbox-backed reference adapter. See [20-memory-adapters](./20-memory-adapters.md).

Validation:

- `adapter.info.id` matches `/^[a-z][a-z0-9_.-]{1,63}$/`.
- `adapter.info.packageName` is non-empty.
- `adapter.info.capabilities` contains `'memory.kv'`.
- The method is callable at most once and only in the foundation stage after `.sandbox(...)` and before `.workspace(...)`, `.requires(...)`, `.defaults(...)`, or domain methods.

### `.storage(storage)`

Pass the sole `HarnessStorage` instance. If omitted, core constructs
`inMemoryHarnessStorage()`. Storage owns sessions, messages, runs, events,
durable leases/checkpoints, and external waits as one consistency boundary.
It declares exact `storage.*` capabilities; see
[32-harness-storage](./32-harness-storage.md).

The builder validates adapter metadata, the complete required method set, and
baseline checkpoint/retry/resume/workspace-reference/external-wait
capabilities synchronously. Invalid JavaScript adapters throw
`HarnessConfigError{meta.reason:'invalid_storage'}` at `.storage(...)`.

### `.workspace(adapter)`

Pass an optional `DurableWorkspace`. Core treats durable workspace
support as an opt-in adapter capability surface for production replay. The
adapter lifecycle, references, retention, encryption, cleanup, quota, fallback,
and telemetry rules are locked in [21-durable-workspaces](./21-durable-workspaces.md).

Validation:

- `adapter.info.id` matches `/^[a-z][a-z0-9_.-]{1,63}$/`.
- `adapter.info.packageName` is non-empty.
- `adapter.info.capabilities` contains `workspace.durable`.
- The method is callable at most once and only in the foundation stage after
  `.memory(...)` and before `.requires(...)`, `.defaults(...)`, or domain
  methods.

### `.requires(capabilities)`

Declares adapter capabilities required by this harness definition:

```ts
defineHarness()
  .sandbox(snapshotSandbox)
  .memory(persistentMemory)
  .storage(postgresHarnessStorage)
  .workspace(durableWorkspace)
  .requires([
    'sandbox.snapshot',
    'sandbox.resume',
    'memory.persistent',
    'storage.checkpoint',
    'storage.workspace_checkpoint',
    'storage.multi_instance',
    'workspace.durable',
    'workspace.resume',
    'workspace.cleanup',
  ])
```

`build()` aggregates capabilities from configured adapters and throws
`HarnessConfigError{meta.reason:'missing_required_capability'}` when any
required capability is unavailable. This gate is construction-time policy; a run
must not start with an unsupported adapter combination.

### `.defaults(d)`

```ts
interface HarnessDefaults {
  /** Max iterations of the default agent loop. Locked default: 16; positive integer, no hard upper cap. */
  agentMaxIterations?: number
  /** Per-run wall-clock timeout in ms. Default: 600_000 (10 min). 0 disables; negative rejected. */
  runTimeoutMs?: number
  /** Per-tool-call timeout in ms. Default: 120_000. */
  toolTimeoutMs?: number
  /** Per-skill-call timeout in ms. Default: 60_000. */
  skillTimeoutMs?: number
  /** Per-model-call timeout in ms. Default: 300_000. */
  modelTimeoutMs?: number
  /** Max tool calls from one model response executed concurrently. Default: 8. */
  maxParallelToolCalls?: number
  /**
   * Workflow child-agent delegation defaults.
   * Delegation is disabled by default.
   */
  delegation?: {
    enabled?: boolean
    maxChildAgentCalls?: number
    maxParallelChildAgentCalls?: number
    maxDepth?: number
  }
  /**
   * Maximum number of conversation messages to pass into a model call.
   * `undefined` ⇒ pass all messages. `0` ⇒ pass system messages only.
   * Negative values rejected at the builder call with `HarnessConfigError`.
   * `system`-role messages are always included; remaining slots are filled
   * with the most recent non-system messages preserving chronological order.
   * Per-call override: `InvokeOptions.historyWindow`.
   */
  historyWindow?: number
  /** Transient model-request projection. See 26-context-projection-and-compaction. */
  contextProjection?: ContextProjectionPolicy
}
```

Note that timeout fields keep `Ms` suffixes for backwards-readable API ergonomics; OTel-exposed durations use seconds (see [14-otel-conventions](./14-otel-conventions.md)).

Delegation defaults are enforced per workflow run after delegation is enabled.
`enabled` defaults to `false`. `maxChildAgentCalls` and `maxDepth` accept
integers `>= 0`; `maxParallelChildAgentCalls` accepts integers `>= 1`. A
workflow can opt in and override these values with
`WorkflowDefinition.delegation`.

### `.models(models)`

```ts
type ModelsConfig = Record<string, ModelAlias>

interface ModelAlias {
  provider: ModelProvider
  model: string
  capabilities: readonly ModelCapability[]
  defaults?: ModelDefaults
  /** Provider-neutral retry behavior. Default: true. */
  retry?: ModelRetrySetting
  /** Transient retry-only context projection for this alias. */
  contextProjection?: ContextProjectionPolicy
  /** Free-form provider-specific options, passed to the provider unchanged. */
  providerOptions?: Record<string, unknown>
}
```

Use `defaults.parallelToolCalls` on a model alias to request whether the provider
may emit multiple tool calls in one model turn. This is the ergonomic path for
agent loops because agents reference model aliases and do not need to know
provider-specific payload names.

Use alias `retry`, `defaults.retry`, or per-call `call.retry` to control
provider-neutral model retry. Defaults are safe for short transient outages and
rate limits; long provider retry instructions are surfaced as typed deferred
retry errors. See [23-provider-outcomes-and-retry](./23-provider-outcomes-and-retry.md).

Each key is the alias id referenced by agents. Validation:

- ≥1 alias required (otherwise the resulting builder type lacks `.agents()`/`.workflows()`/`.build()`).
- Each `model` must claim ≥1 capability.

Zod parser invoked synchronously inside the method; failure throws `HarnessConfigError`.

### `.governance(config)`

Optional policy-as-code governance for tool decisions. If omitted, the harness
does not load or evaluate any policy engine and emits no policy events.

```ts
.governance(({ native }) => ({
  mode: 'enforce',
  defaultEffect: 'deny',
  policies: [
    native({
      name: 'financial-controls',
      version: '1.0.0',
      rules: [
        {
          id: 'large-transfer',
          effect: 'require_approval',
          tools: ['transfer_funds'],
          when: (ctx) => ctx.input.amount > 10_000
        }
      ]
    })
  ]
}))
```

Governance configuration is locked in [24-governance-policy](./24-governance-policy.md).
Builder validation rejects missing/empty policy arrays, duplicate policy names,
duplicate native rule ids within one policy, unknown referenced tool ids, and
invalid effect/default values. Native single-tool rules over TypeScript tools
infer `ctx.input` and `ctx.output` from the registered tool schemas.

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
  provenance?: McpPluginProvenance
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
  provenance?: McpPluginProvenance
}

interface McpPluginProvenance {
  name: string
  version?: string
  digest: string
  component: 'mcp'
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
  validationMode?: 'strict' | 'lenient'
  trust?: 'trusted' | 'project' | 'user'
  source?: string
}
```

The harness resolves `directory` and parses `SKILL.md` (YAML frontmatter) synchronously inside `.skills()` for explicit local definitions. See [08-skills](./08-skills.md) for the frontmatter schema, strict/lenient validation, diagnostics, discovery helpers, trust rules, and collision behavior. In strict mode the harness config key MUST equal the frontmatter `name`; mismatch throws `SkillManifestError{reason:'name_mismatch'}`. In lenient mode, mismatch may load the frontmatter name and record a diagnostic when no collision occurs.

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
  maxSteps?: number                           // default 16; positive integer, no hard upper cap
  prepareStep?: AgentPrepareStep<S, z.infer<I>>
  stopWhen?: AgentStopWhen<S, z.infer<I>>
  interceptors?: readonly AgentExecutionInterceptor<S, z.infer<I>>[]
  handler?: (ctx: AgentContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>
}
```

`interceptors` are ordered, default-loop-only hooks. `beforeInput` executes
after input-schema validation and before instructions, transcript, or a model
call. `afterModel` executes after content-free model.completed accounting and before final content processing or tool dispatch. `beforeOutput` gates final content before schema validation, content events and persistence; tool hooks wrap the prepared execution boundary. A block
or hook exception is terminal and throws non-retriable `DecisionBlockedError` or `DecisionEvaluationError`.
Custom handlers deliberately do not receive interceptors because they own their
own provider and tool lifecycle. The optional NeMo-shaped addon is specified in
[30-guardrails](./30-guardrails.md).

Cross-key constraints are enforced by the type system; harness additionally re-checks at the builder call. Validation (synchronous):

- Agent ids match `/^[a-z][a-z0-9_]*$/`, ≤64 chars; reserved prefixes `harness_`, `system_` rejected.
- `model` MUST reference a key from `.models(...)`.
- Every entry of `tools` MUST reference a key from `.tools(...)`.
- Every entry of `skills` MUST reference a key from `.skills(...)`.
- If `builtinTools` is an array, every entry MUST be one of `'bash'|'read'|'write'|'edit'|'glob'|'grep'|'list'`; unknown name → `HarnessConfigError`.
- If `permissions.bash` is set but the configured sandbox's executor will be unavailable at harness, the bash policy is still parsed but warning-logged (permissions for an unavailable tool are no-ops).
- `maxSteps`: positive integer with no hard upper cap; otherwise `HarnessConfigError`.
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
- Workflow ids may not collide with reserved Session member names: `'memory' | 'history' | 'release' | 'close' | 'id' | 'workflows' | 'clearHistory' | 'replaceHistory'`. Violation → `HarnessConfigError`.
- `ctx.agents[k]` is typed by the registered agent keys.
- A wrapper package that accepts a workflow definition and local agent
  definitions must apply the same order as the builder: register agents first,
  then workflows, so handler `ctx.agents` matches runtime availability.

### `.build()`

Returns the immutable `Harness<S>` (see [13-public-api](./13-public-api.md)). Available only when `models` and at least one of `agents`/`workflows` are set, enforced by the builder type.

## Defaults

| Key                                  | Default                              |
|--------------------------------------|--------------------------------------|
| `name`                               | `'agent-harness'`                    |
| `state`                              | `InMemoryHarnessStorage`                 |
| `sandbox`                            | auto-detect: `bashSandbox()` if `just-bash` is installed, else `inMemorySandbox()` |
| `memory`                             | `sandboxMemory()`                    |
| `checkpoints`                        | none                                 |
| `logger`                             | built-in `JsonLogger`                |
| `telemetry.flavor`                   | env `PURISTA_TELEMETRY_FLAVOR`, else `'dual'` |
| `telemetry.contentCaptureMode`       | env `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, else `'NO_CONTENT'` |
| `defaults.agentMaxIterations`        | `16`                                 |
| `defaults.runTimeoutMs`              | `600_000`                            |
| `defaults.toolTimeoutMs`             | `120_000`                            |
| `defaults.skillTimeoutMs`            | `60_000`                             |
| `defaults.modelTimeoutMs`            | `300_000`                            |
| `defaults.maxParallelToolCalls`      | `8`                                  |
| `defaults.historyWindow`             | `undefined` (pass all messages)      |

## Validation rules summary (each thrown synchronously by the originating builder method)

1. `models` ≥1 entry, each with ≥1 capability — checked in `.models()`.
2. Every `agent.model` matches a `.models()` key — checked in `.agents()`.
3. Every `agent.tools[]` entry matches a `.tools()` key — checked in `.agents()`.
4. Every `agent.skills[]` entry matches a `.skills()` key — checked in `.agents()`.
5. For every skill: `SKILL.md` parsed with YAML semantics, frontmatter validated, optional fields preserved, diagnostics recorded, and strict key/name rules enforced — checked in `.skills()`.
6. Tool/skill/agent/workflow/model-alias keys MUST match `/^[a-z][a-z0-9_]*$/`, ≤64 chars; reserved prefixes `harness_`/`system_` rejected; cross-namespace collisions (tool vs skill, tool vs built-in name) and reserved Session member collisions (workflows) rejected.
7. `defaults.runTimeoutMs === 0` disables the run timeout. Per-call timeouts must be > 0; negative values rejected. `InvokeOptions.timeoutMs` follows the same `>0/0/<0` rules: negative throws `ValidationError`.
8. Default-loop agents need `'object'` capability on their alias; `'tool_use'` if any custom tools or any built-in tools enabled — checked in `.agents()`.
9. `defaults.historyWindow`: `undefined`/`0`/positive int OK; negative → `HarnessConfigError`. Same rules apply to `InvokeOptions.historyWindow` (negative throws `ValidationError{where:'invoke_options'}`).
10. `defaults.maxParallelToolCalls` must be a positive integer. `1` forces sequential local execution of a model-returned tool batch.
11. `agent.builtinTools` if an array MUST contain only valid built-in names; `agent.maxSteps` if set and `defaults.agentMaxIterations` if set MUST be positive integers. Explicit loop budgets have no hard upper cap.
12. `.requires(...)` entries MUST be stable `AdapterCapability` values and MUST be provided by configured adapters by `.build()`.
13. `telemetry.flavor` MUST be one of `'dual'`, `'gen_ai_only'`, or `'openinference_only'`.
14. `telemetry.contentCaptureMode` MUST be one of `'NO_CONTENT'`, `'SPAN_ONLY'`, `'EVENT_ONLY'`, or `'SPAN_AND_EVENT'`.
14. `memory.info` and memory adapter capabilities MUST pass the validation rules in [20-memory-adapters](./20-memory-adapters.md).
15. `workspace.info` and durable workspace capabilities MUST pass the validation rules in [21-durable-workspaces](./21-durable-workspaces.md).
16. `storage.info` and `storage.capabilities` MUST satisfy [32-harness-storage](./32-harness-storage.md).
17. `contextProjection.toolResultPruner`, when supplied through defaults or a model alias, requires finite non-negative integer byte values and an ASCII-only marker. Validation reserves the marker's actual byte length and the complete rendered omission annotation in addition to `headBytes + tailBytes`, so every valid projected result is at most `maxBytes`; invalid configuration throws `HarnessConfigError{reason:'invalid_context_projection'}`. The corresponding invocation validation throws `ValidationError{where:'invoke_options'}`.

## `Harness<S>` returned object

The builder's `.build()` returns the typed `Harness<S>`. The full type surface (including `$infer`, `getSession`, and `inspect`) is locked in [13-public-api](./13-public-api.md).

`getSession` is `async` because the HarnessStorage may be remote.

Concurrent `shutdown()` calls share one operation. It sequentially closes the MCP
runner registry, opened session sandbox handles, unique model providers in
reverse alias order, governance adapter, workspace, memory, configured sandbox,
storage, then logger. Each object is de-duplicated by
identity and every `close()` runs at most once. Every failure is normalized,
aggregated and returned; failures before logger closure are error-logged using
only resource kind/id, while logger-close failure is only aggregated. A later
completed `shutdown()` returns the stored aggregate without new close calls.

`inspect()` returns a synchronous, data-only snapshot of the resolved harness
setup: harness name, effective adapter capabilities, required capabilities,
adapter descriptors, and ordered content-free static-module provenance. It must
not make network calls or mutate runtime state.

## Cross-references

- [03-foundation](./03-foundation.md), [04-state-queue-stream](./04-state-queue-stream.md), [05-sandbox](./05-sandbox.md), [20-memory-adapters](./20-memory-adapters.md), [21-durable-workspaces](./21-durable-workspaces.md)
- [06-models](./06-models.md), [07-tools](./07-tools.md), [08-skills](./08-skills.md)
- [09-agents](./09-agents.md), [10-workflows](./10-workflows.md), [11-sessions](./11-sessions.md)
- [13-public-api](./13-public-api.md), [15-error-catalog](./15-error-catalog.md)

## Approved decision defaults

`defaults.decisionTimeoutMs` is a positive safe integer, default 10_000. The [decision contract](./37-decision-boundaries/03-contracts/decisions.md) owns its relation to run/tool deadlines and the new final-output hook.
