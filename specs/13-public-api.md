# Public API

**Purpose.** Single source of truth for every symbol exported from the v1 package set. The published package set includes the core package plus independent provider addons:

- `@purista/harness` — harness, types, errors, in-memory adapters, TS+MCP tools, built-in JSON logger, telemetry. Testing helpers ship under the subpath export `@purista/harness/testing`.
- `@purista/harness-openai` — OpenAI provider.
- `@purista/harness-anthropic` — Anthropic provider.
- `@purista/harness-bedrock` — Amazon Bedrock provider.
- `@purista/harness-azure-foundry` — Azure AI Foundry provider.

Non-core packages follow the convention `@purista/harness-{addon}`. The harness is published independently from the wider PuristaJS framework so it can be consumed standalone or composed inside [PuristaJS](https://purista.dev).

Other files MAY define types in detail; this file lists the export surface.

## TS version requirement

Peer dependency: `typescript@>=5.4`. The builder relies on `const` type parameters (TS 5.0+) and `satisfies` for the inference contract; ≥5.4 is locked for stable behavior.

## `@purista/harness` package

### `package.json` exports map (locked)

```json
{
  "name": "@purista/harness",
  "type": "module",
  "exports": {
    ".":         { "types": "./dist/index.d.ts",         "import": "./dist/index.js" },
    "./testing": { "types": "./dist/testing/index.d.ts", "import": "./dist/testing/index.js" }
  }
}
```

### Exports — values (main entry `@purista/harness`)

```ts
// Builder entry — the SOLE construction path
export function defineHarness(opts?: HarnessOptions): HarnessBuilder<{}>

// Default adapters (in-memory)
export class JsonLogger implements Logger {
  constructor(opts?: {
    level?: LogLevel
    out?: NodeJS.WritableStream
    bindings?: Record<string, unknown>
  })
}
export class InMemoryStateStore implements StateStore { constructor() }

// Sandbox factories (default adapters)
export function inMemorySandbox(): Sandbox<readonly ['sandbox.fs']>
export function bashSandbox(opts?: {
  network?: { allow?: string[]; deny?: string[] }
  executionLimits?: { wallClockMs?: number; memoryMb?: number }
  python?: boolean
}): Sandbox<readonly ['sandbox.fs', 'sandbox.exec']>

// Errors (every class from 15-error-catalog)
export class HarnessError extends Error { /* see 03-foundation */ }
export class HarnessConfigError extends HarnessError {}
export class ValidationError extends HarnessError {}
export class PermissionDeniedError extends HarnessError {}
export class SandboxError extends HarnessError {}
export class SandboxNoExecutorError extends HarnessError {}
export class ModelError extends HarnessError {}
export class ModelCapabilityError extends HarnessError {}
export class ToolError extends HarnessError {}
export class ToolNotFoundError extends HarnessError {}
export class SkillNotFoundError extends HarnessError {}
export class SkillManifestError extends HarnessError {}
export class AgentNotFoundError extends HarnessError {}
export class AgentLoopBudgetError extends HarnessError {}
export class WorkflowNotFoundError extends HarnessError {}
export class SessionNotFoundError extends HarnessError {}
export class SessionBusyError extends HarnessError {}
export class StateError extends HarnessError {}
export class OperationTimeoutError extends HarnessError {}
export class OperationCancelledError extends HarnessError {}
export class McpProtocolError extends HarnessError {}
export class McpAuthError extends HarnessError {}
export class InternalError extends HarnessError {}

// Utilities
export function ulid(): string                                 // monotonic ULID
export function isHarnessError(value: unknown): value is HarnessError
export const HARNESS_VERSION: string                            // semver of the package
```

`JsonLogger` defaults: `level` is read from env `PURISTA_HARNESS_LOG_LEVEL` if set (invalid values fall back to `'info'` and emit one warning), else `'info'`; `out = process.stdout`; `bindings = {}`.

**Removed in v1:** standalone `defineAgent`, `defineWorkflow`, `defineTool`, `defineSkill`, `defineModel` factories are NOT exported. Only inline-in-builder definitions achieve cross-key type constraints (the agent's `model` referencing a `.models()` key, the workflow handler's `ctx.agents` typed by the registered agent keys, etc.). Standalone definers cannot capture the surrounding builder generics, so they are removed in v1 — accept this tradeoff explicitly.

### Exports — types (main entry)

```ts
// Builder
export interface HarnessOptions
export interface HarnessBuilder<S>
export type BuilderState

// Harness + handle types
export interface Harness<S>
export interface Session<S>
export interface WorkflowInvoker<S, K>
export interface InvokeOptions

// Configuration shapes
export type ModelsConfig
export interface ModelAlias
export type ToolsConfig
export type ToolDefinition
export interface TsToolDefinition<I, O>
export interface McpStdioToolDefinition
export interface McpHttpToolDefinition
export type SkillsConfig
export interface SkillDefinition
export type AgentsConfig<S>
export interface AgentDefinition<S, I, O>
export type WorkflowsConfig<S>
export interface WorkflowDefinition<S, I, O>

// Defaults
export interface HarnessDefaults

// Inside-handler context types
export interface AgentContext<S, I, O>
export interface AgentContextMinimal<S, I>
export interface WorkflowContext<S, I, O>
export interface ToolHandlerContext
export interface SessionMemory
export interface ConversationHistory

// Built-in tools and permissions
export type BuiltinToolName
export type PermissionMode
export interface PermissionPolicy
export interface AgentPermissions
export interface PermissionContext
export type PermissionDecision
export type OnPermission

// Resolved skill (after frontmatter parse)
export interface ResolvedSkill

// Models
export interface ModelDefaults
export interface ModelProvider
export abstract class BaseModelProvider
export interface BaseModelProviderOptions
export interface HarnessAdapterContext
export interface HarnessContextConfigurable
export type ModelCapability
export type ModelHandles
export interface ModelProviderInfo
export interface ModelFeatureSet
export type ContentPartKind
export type OutputMode
export interface BaseRequest
export interface ModelCallOptions
export type ModelMessage
export type ContentPart
export interface ToolCallSpec
export interface ModelToolSpec
export interface TextRequest
export interface TextResponse
export type TextStreamChunk
export interface ObjectRequest
export interface ObjectResponse
export type ObjectStreamChunk
export interface EmbeddingRequest
export interface EmbeddingResponse
export interface Embedding
export interface RerankRequest
export interface RerankResponse
export interface RerankDocument
export interface RerankResult
export interface TokenUsage
export type FinishReason

// Foundation
export interface Logger
export type LogLevel
export type ErrorCategory
export interface TelemetryOptions
export type TelemetryFlavor
export type ContentCaptureMode

// State / Sandbox ports
export interface StateStore
export abstract class StateStoreAdapterBase
export type FinishRunPatch
export type AdapterCapability
export interface AdapterCapabilities
export interface DurableRuntimeAdapter
export interface AdapterInspection
export interface HarnessInspection
export interface Sandbox
export interface SandboxSessionBase
export interface ExecCapableSandboxSession
export interface SandboxSession
export type SandboxSessionFor
export interface SnapshotResult
export interface SandboxResumeOptions
export interface SnapshotCapableSandbox
export interface ResumeCapableSandbox
export interface HibernateCapableSandbox
export interface ExecOptions
export interface ExecResult
export interface DirEntry
export interface FileStat

// Persistence shapes
export interface SessionRecord
export interface Message
export interface RunRecord
export interface PersistedRunEvent
export type RunStatus
export type JsonValue

// Streaming
export type RunEvent
export interface SerializedError
export interface RunSummary

// MCP
export type McpAuth

// Inference helper
export type InferTypes<S>

// AI evaluation core
export interface PromptCandidate
export interface EvaluationItem
export interface CandidateScore
export interface ScorerTarget
export interface ScorerResult
export interface EvaluatePromptCandidatesInput
export function evaluatePromptCandidates<I = unknown>(
  input: EvaluatePromptCandidatesInput<I>
): Promise<CandidateScore[]>
```

### `HarnessBuilder<S>` (locked)

```ts
import type { z } from 'zod'

interface HarnessBuilder<S extends BuilderState> {
  // Foundation — optional, called at most once each
  telemetry(opts: TelemetryOptions): HarnessBuilder<S>
  logger(logger: Logger): HarnessBuilder<S>
  state(store: StateStore): HarnessBuilder<S>
  sandbox(sandbox: Sandbox): HarnessBuilder<S>
  runtime(runtime: DurableRuntimeAdapter): HarnessBuilder<S>
  requires(required: readonly AdapterCapability[]): HarnessBuilder<S>
  defaults(d: HarnessDefaults): HarnessBuilder<S>

  // Domain — each must be called exactly once before .build(), in this order:
  models<const M extends ModelsConfig>(models: M): HarnessBuilder<S & { models: M }>
  tools<const T extends ToolsConfig>(tools: T): HarnessBuilder<S & { tools: T }>
  skills<const K extends SkillsConfig>(skills: K): HarnessBuilder<S & { skills: K }>
  agents<const A extends AgentsConfig<S & { models: any; tools: any; skills: any }>>(
    agents: A
  ): HarnessBuilder<S & { agents: A }>
  workflows<const W extends WorkflowsConfig<S & { agents: any }>>(
    workflows: W
  ): HarnessBuilder<S & { workflows: W }>

  build(): Harness<S>
}
```

The builder type omits already-set or out-of-order methods so that incorrect chains fail at the type level. Behavioral ordering rules and validation are described in [02-harness-config](./02-harness-config.md).

### `Harness<S>` and `Session<S>` (locked)

```ts
interface Harness<S extends BuilderState> {
  getSession(id: string): Promise<Session<S>>
  inspect(): HarnessInspection
  shutdown(): Promise<{ errors: HarnessError[] }>
  /** Phantom value (literal `{}` at harness). Compile-time-only inference handle. */
  readonly $infer: InferTypes<S>
}

interface Session<S extends BuilderState> {
  readonly id: string
  readonly agents: { readonly [K in keyof S['agents']]: AgentInvoker<S, K> }
  readonly workflows: { readonly [K in keyof S['workflows']]: WorkflowInvoker<S, K> }
  memory: SessionMemory
  history: ConversationHistory
  getRunSummary(runId: string): Promise<RunSummary | undefined>
  clearHistory(): Promise<void>
  replaceHistory(messages: ReadonlyArray<Omit<Message,'id'|'timestamp'>>): Promise<void>
  close(): Promise<void>
}

interface AgentInvoker<S, K extends keyof S['agents']> {
  prompt(input: AgentInput<S, K>, opts?: InvokeOptions): Promise<AgentOutput<S, K>>
  stream(input: AgentInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

interface WorkflowInvoker<S, K extends keyof S['workflows']> {
  prompt(input: WorkflowInput<S, K>, opts?: InvokeOptions): Promise<WorkflowOutput<S, K>>
  stream(input: WorkflowInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

type AgentInput<S, K extends keyof S['agents']> =
  S['agents'][K] extends { input: infer I } ? (I extends z.ZodTypeAny ? z.infer<I> : string) : string
type AgentOutput<S, K extends keyof S['agents']> =
  S['agents'][K] extends { output: infer O } ? (O extends z.ZodTypeAny ? z.infer<O> : string) : string
type WorkflowInput<S, K extends keyof S['workflows']> =
  S['workflows'][K] extends { input: infer I } ? (I extends z.ZodTypeAny ? z.infer<I> : string) : string
type WorkflowOutput<S, K extends keyof S['workflows']> =
  S['workflows'][K] extends { output: infer O } ? (O extends z.ZodTypeAny ? z.infer<O> : string) : string
```

### `InferTypes<S>` namespace (locked)

```ts
type InferTypes<S extends BuilderState> = {
  models: keyof S['models']
  tools: keyof S['tools']
  skills: keyof S['skills']
  agents: { [K in keyof S['agents']]: { input: AgentInput<S, K>; output: AgentOutput<S, K> } }
  workflows: { [K in keyof S['workflows']]: { input: WorkflowInput<S, K>; output: WorkflowOutput<S, K> } }
}
```

`Harness` is not the application execution surface for model/tool/sandbox work. It exposes session creation and shutdown only. Application code opens a session and executes typed direct agents through `session.agents` or typed workflows through `session.workflows`.

`harness.$infer` is a phantom value: at harness it is the literal `{}`. Its only purpose is compile-time inference via `typeof`:

```ts
type WorkflowKeys = keyof typeof harness.$infer.workflows
type HandleInput  = typeof harness.$infer.workflows.handle_ticket.input
type HandleOutput = typeof harness.$infer.workflows.handle_ticket.output
type ToolKeys     = typeof harness.$infer.tools
type AgentKeys    = keyof typeof harness.$infer.agents
type AgentInput   = typeof harness.$infer.agents.wiki_answerer.input
```

This mirrors the Drizzle/tRPC `$inferSelect`/`AppRouter` pattern.

### Capability-projected model handles

Model capabilities are policy. `ctx.models`, direct registry handles, and any
public model-handle helper expose only methods allowed by the alias's declared
`capabilities` array. For example, an alias declared with
`capabilities: ['text']` exposes `text(...)` but not `embed(...)`, while an alias
declared with `capabilities: ['text', 'embeddings']` exposes both. Marker
capabilities also narrow request shapes: `tool_use` gates `tools` and tool-role
messages, `vision_input` gates image parts, `audio_input` gates audio parts, and
`file_input` gates file parts. Runtime `ModelCapabilityError` checks remain
required for JavaScript callers and widened configuration.

### `TelemetryOptions`

```ts
type TelemetryFlavor = 'dual' | 'gen_ai_only' | 'openinference_only'
type ContentCaptureMode = 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'

interface TelemetryOptions {
  /**
   * Backend emission shape. Default: env `PURISTA_TELEMETRY_FLAVOR`, else
   * `'dual'`.
   */
  flavor?: TelemetryFlavor
  /**
   * Content capture mode. Default: env
   * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, else `NO_CONTENT`.
   */
  contentCaptureMode?: ContentCaptureMode
  /**
   * Deprecated alias. `true` maps to `SPAN_AND_EVENT`, `false` maps to
   * `NO_CONTENT`. Ignored when `contentCaptureMode` is set.
   */
  captureContent?: boolean
}
```

Tracer + meter names are locked to `'@purista/harness'` (no `tracerName`/`meterName` knobs).

### `InvokeOptions`

```ts
interface InvokeOptions {
  signal?: AbortSignal
  timeoutMs?: number
  historyWindow?: number
  traceparent?: string
  tracestate?: string
  metadata?: Record<string, JsonValue>
}
```

`traceparent`/`tracestate` follow W3C Trace Context and are propagated into the
run span before child workflow, agent, model, tool, sandbox, and state spans are
created. `metadata` is available to handlers and emitted only as sanitized
scalar `harness.metadata.*` attributes as specified in
[19-ai-eval-core](./19-ai-eval-core.md).

### `RunSummary`

```ts
interface RunSummary {
  runId: string
  sessionId: string
  status: RunStatus
  startedAt: string
  finishedAt?: string
  tokenTotals: TokenUsage
  modelCalls: number
  toolCalls: number
  agentCalls: number
  error?: SerializedError
}
```

`Session.getRunSummary(runId)` derives this from the configured `StateStore`; it
does not inspect OTel spans.

### AI evaluation core

```ts
interface PromptCandidate<I = unknown> {
  id: string
  prompt: string
  metadata?: Record<string, JsonValue>
}

interface EvaluationItem<I = unknown> {
  id: string
  input: I
  expected?: unknown
  context?: unknown[]
}

interface CandidateScore {
  candidateId: string
  meanScore: number
  passRate: number
  itemCount: number
  scorerCount: number
}

interface EvaluatePromptCandidatesInput<I = unknown> {
  candidates: PromptCandidate<I>[]
  items: EvaluationItem<I>[]
  scorer: (target: ScorerTarget, signal: AbortSignal) => Promise<ScorerResult>
  runCandidate: (
    candidate: PromptCandidate<I>,
    item: EvaluationItem<I>,
    signal: AbortSignal
  ) => Promise<unknown>
  signal: AbortSignal
}
```

`evaluatePromptCandidates` is provider-neutral and product-neutral. It does not
generate candidates, persist datasets, call external optimizers, or know about
Cloudgrid.

## Type inference and DX

1. **`const` type parameters.** Every domain method uses TS 5.0+ `const` modifier on its type parameter. Users write `model: 'fast'` and the literal `'fast'` is preserved (not widened to `string`) without needing `as const`.
2. **Cross-key constraints.** `agents[k].model` is constrained to `keyof models & string`; `agents[k].tools[i]` to `keyof tools & string`; `agents[k].skills[i]` to `keyof skills & string`; `workflows[k]` handler's `ctx.agents` is typed with the exact agent keys. Mismatches surface as TS errors at the builder call site.
3. **`harness.$infer`** — phantom value, compile-time access to:
   - `typeof harness.$infer.models` → union of model alias keys
   - `typeof harness.$infer.tools` → union of tool keys
   - `typeof harness.$infer.skills` → union of skill keys
   - `typeof harness.$infer.agents` → union of agent keys
   - `typeof harness.$infer.workflows` → record of `{input, output}` per workflow key
4. **No `as const` required by user.** Builder type parameters carry the burden via `const` modifier.
5. **Tradeoff:** cross-file agent/workflow definition is NOT type-checked across the boundary in v1. To preserve the cross-key constraints (an agent's `model` referencing a model registered on the same builder, etc.), users keep agent and workflow definitions inline in the builder. Defining agents in a separate module and importing them loses the literal generic state, so they cannot enforce the constraints. This is the reason standalone `defineAgent`/`defineWorkflow`/`defineTool`/`defineSkill`/`defineModel` are not exported. Users who must split definitions across files can pass plain objects and accept the loss of cross-builder type safety; v1 ships no helper for this path.

### Built-in tool aliases

Locked canonical → alias map (the harness normalizes alias dispatch to canonical for OTel `gen_ai.tool.name`):

| Canonical | Aliases       |
|-----------|---------------|
| `bash`    | `Bash`        |
| `read`    | `Read`        |
| `write`   | `Write`       |
| `edit`    | `Edit`        |
| `glob`    | `Glob`        |
| `grep`    | `Grep`        |
| `list`    | `LS`, `List`  |

### Exports — `@purista/harness/testing` subpath

```ts
// Fakes
export class FakeModelProvider implements ModelProvider     // configurable scripted responses
export class FakeStateStore extends InMemoryStateStore       // exposes inspection helpers
export class FakeSandbox implements Sandbox                  // deterministic FS+exec; configurable executor flag
export class FakeLogger implements Logger                    // captures log records in memory

// Contract suites — each is a Vitest test factory
export function stateStoreContract(make: () => StateStore | Promise<StateStore>): void
export function sandboxContract(
  make: () => Sandbox | Promise<Sandbox>,
  opts: { executor: 'available' | 'unavailable' }
): void
export function modelProviderContract(
  make: () => ModelProvider,
  opts: { capabilities: ModelCapability[] }
): void
export function loggerContract(make: () => Logger): void

// Helpers
export function makeHarness(): HarnessBuilder<{}>            // alias for defineHarness() returning a fresh builder
export function recordEvents(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]>

// AI eval test helpers
export type DeterministicScorerDefinition
export interface ScorerTarget
export interface ScorerResult
export function evaluateDeterministicScorer(
  definition: DeterministicScorerDefinition,
  target: ScorerTarget
): ScorerResult
```

```ts
export type DeterministicScorerDefinition =
  | { type: 'regex'; path: string; pattern: string; flags?: 'i' | 'm' | 'im' }
  | { type: 'json-schema'; schema: JsonValue }
  | { type: 'contains'; path: string; value: string; caseInsensitive?: boolean }
  | { type: 'attribute-equality'; leftPath: string; rightPath: string }

export interface ScorerTarget {
  input: unknown
  output: unknown
  expected?: unknown
  context?: unknown[]
}

export interface ScorerResult {
  score: number
  passed: boolean
  evidence?: JsonValue
}
```

The fake adapters, contract suites, and `evaluateDeterministicScorer` helper are
**only** reachable via `@purista/harness/testing`. They MUST NOT be re-exported
from the main entry. Shared data types such as `ScorerTarget` and `ScorerResult`
may be exported by the main entry because `evaluatePromptCandidates` uses them.
Implementation agents must add a CI test that verifies the actual exports of
each entry against the lists above.

## `@purista/harness-openai` package

### `package.json` exports map (locked)

```json
{
  "name": "@purista/harness-openai",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  }
}
```

### Exports — values

```ts
import type { ModelProvider, BaseModelProviderOptions } from '@purista/harness'
import type { ClientOptions } from 'openai'

export interface OpenAiFactoryOptions extends ClientOptions {
  client?: unknown
  /** Optional adapter-level override. Defaults to the harness logger when registered. */
  harnessLogger?: BaseModelProviderOptions['logger']
  /** Optional adapter-level override. Defaults to the harness telemetry shim when registered. */
  telemetry?: BaseModelProviderOptions['telemetry']
  /** Optional adapter-level override. Defaults to `defaults.modelTimeoutMs` when registered. */
  harnessTimeoutMs?: number
}

export function openai(opts?: OpenAiFactoryOptions): ModelProvider
```

`openai(...)` returns a fully-typed `ModelProvider` implementing `text`, `textStream`, `object`, `objectStream`, and `embed` when the selected official OpenAI SDK operations support them. Reranking is implemented only if the current official OpenAI SDK exposes a suitable operation; otherwise the provider omits the `rerank` capability and fake-provider contract tests cover the core behavior. The adapter is intentionally thin over the official `openai` SDK: SDK client options are accepted directly, and per-call `providerOptions` are passed through to the matching SDK call with `providerOptions.requestOptions` forwarded as the SDK request-options object. Harness logger, telemetry, and model timeout defaults are inherited automatically when the provider is registered; adapter options only override those inherited values. The provider sets provider id `'openai'` for both `gen_ai.provider.name` and legacy `gen_ai.system` on every model-call span (see [14-otel-conventions](./14-otel-conventions.md)). Capability claims at the alias level are the user's responsibility.

### Exports — types

```ts
export type OpenAiFactoryOptions
export type OpenAiClient
```

Additional provider packages follow the `@purista/harness-{addon}` naming convention and expose one provider factory plus factory options/client types. The `ModelProvider` port remains stable for v1.x provider packages.

Current provider addons:

- `@purista/harness-anthropic`: `anthropic(options)`, `AnthropicFactoryOptions`, `AnthropicClient`
- `@purista/harness-bedrock`: `bedrock(options)`, `BedrockFactoryOptions`, `BedrockClient`
- `@purista/harness-azure-foundry`: `azureFoundry(options)`, `AzureFoundryFactoryOptions`, `AzureFoundryClient`

## Package surface summary

`session.agents[k]` and `session.workflows[k]` lookups are typed; `harness.$infer` exposes the namespaces. The public surface does NOT impose magic mapped types beyond those listed above.

Every export listed above must be re-exported from the appropriate entry point:

- `packages/harness/src/index.ts` → main entry list.
- `packages/harness/src/testing/index.ts` → testing subpath list.
- `packages/harness-openai/src/index.ts` and sibling provider addon entries → provider package lists.

## Schema conversion

The harness converts Zod schemas to JSON Schema (draft 2020-12) via an internal converter. Locked rules:

- `z.string()` → `{type:'string'}` (with `minLength`/`maxLength`/`pattern` if set).
- `z.number()` / `z.int()` → `{type:'number'|'integer'}` with bounds.
- `z.boolean()` → `{type:'boolean'}`.
- `z.literal(v)` → `{const: v}`.
- `z.enum(values)` → `{enum: values}`.
- `z.object({...})` → `{type:'object', properties, required}` with `additionalProperties: false`.
- `z.array(t)` → `{type:'array', items}`.
- `z.union([a,b])` → `{anyOf:[A,B]}`.
- `z.discriminatedUnion(k, [...])` → `{oneOf:[...]}` with the discriminator preserved on each branch.
- `z.optional(t)` makes the field optional in the parent object.
- `z.nullable(t)` → `{anyOf:[T,{type:'null'}]}`.
- `.describe(s)` populates `description`.
- Any unsupported Zod type → `SkillManifestError`/`ValidationError` at schema-translation time, with a clear `meta.unsupported` field.

The reverse conversion (JSON Schema → Zod) is not implemented; MCP tool input schemas are validated using a JSON-Schema validator embedded in the harness MCP runners, not converted to Zod.

## Cross-references

- All other spec files. This is the index of types they collectively define.
