import { z } from 'zod'
import { JsonLogger, type Logger } from '../logger/index.js'
import type {
  Embedding,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelAlias,
  ModelCapability,
  ModelDefaults,
  ModelFeatureSet,
  ModelProviderInfo,
  ModelProvider,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  OutputMode,
  ContentPartKind,
  RerankDocument,
  RerankRequest,
  RerankResponse,
  RerankResult,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  ToolCallSpec,
  ModelMessage,
  ModelToolSpec,
  TokenUsage,
  FinishReason,
  ContentPart,
  ModelCallOptions
} from '../ports/model-provider.js'
import type { StateStore } from '../ports/state.js'
import type { Metrics, TelemetryShim } from '../telemetry/index.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import { sandboxMemory } from '../memory/sandbox/index.js'
import type {
  MemoryAdapter,
  MemoryFacade,
  SessionMemory
} from '../ports/memory.js'
import { validateMemoryAdapter } from '../ports/memory.js'
import type { DurableWorkspaceStore } from '../ports/workspace.js'
import { validateDurableWorkspaceStore } from '../ports/workspace.js'
import { InMemoryStateStore } from '../state/in-memory.js'
import type { JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import type { RunStatus } from '../models/state.js'
import type { HarnessError } from '../errors/harness-error.js'
import { HarnessConfigError, SkillManifestError } from '../errors/catalog.js'
import { BUILTIN_TOOL_NAMES } from '../tools/index.js'
import { autoDetectSandbox, type Sandbox } from '../sandbox/index.js'
import { createSessionHarness } from '../sessions/index.js'
import type { ModelHandle } from '../models/registry.js'
import {
  hasAdapterCapabilities,
  missingCapabilities,
  uniqueCapabilities,
  type AdapterCapability,
  type AdapterInspection,
  type DurableRuntimeAdapter,
  type HarnessInspection
} from '../ports/capabilities.js'

/** Stable harness version string for diagnostics and generated documentation. */
export { HARNESS_VERSION } from '../version.js'

/** OpenTelemetry capture controls used by the harness. */
export type TelemetryFlavor = 'dual' | 'gen_ai_only' | 'openinference_only'
export type ContentCaptureMode = 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'

export interface TelemetryOptions {
  /** Backend emission shape. */
  flavor?: TelemetryFlavor
  /** Span/event content capture mode. */
  contentCaptureMode?: ContentCaptureMode
}

/** Default harness budgets and execution behavior. */
export interface HarnessDefaults {
  /** Default maximum iterations for the built-in agent loop. Default: `16`. */
  agentMaxIterations?: number
  /** Per-run timeout in milliseconds. `0` disables. Default: `600_000`. */
  runTimeoutMs?: number
  /** Per-tool timeout in milliseconds. Default: `120_000`. */
  toolTimeoutMs?: number
  /** Per-skill timeout in milliseconds. Default: `60_000`. */
  skillTimeoutMs?: number
  /** Per-model timeout in milliseconds. Default: `300_000`. */
  modelTimeoutMs?: number
  /** Maximum tool calls from one model response executed at the same time. Default: `8`. */
  maxParallelToolCalls?: number
  /**
   * Max non-system messages forwarded into model calls.
   * `undefined` keeps all history, `0` keeps only system messages.
   */
  historyWindow?: number
}

/** Top-level harness options passed to {@link defineHarness}. */
export interface HarnessOptions {
  /** Optional harness name for logs, telemetry, and diagnostics. Default: `agent-harness`. */
  name?: string
}

/** Durable execution opt-in for a single workflow call. */
export interface DurableInvokeOptions {
  /** Stable run id reused across resumes/retries. Matches `/^[A-Za-z0-9_.:-]{1,200}$/`. */
  runId: string
  /** Worker/process id owning the durable lease. Defaults to the harness worker id. */
  workerId?: string
  /** Initial durable step id label. Defaults to the workflow id. */
  stepId?: string
  /** Optional attempt hint; the runtime may raise it on retry. */
  attempt?: number
}

/** Shared invoke options for workflow and agent execution. */
export interface InvokeOptions {
  /** Abort signal used to cooperatively cancel the call. */
  signal?: AbortSignal
  /** Optional timeout override in milliseconds. `0` disables. */
  timeoutMs?: number
  /** Optional history-window override for this call only. */
  historyWindow?: number
  /** Optional W3C Trace Context parent. */
  traceparent?: string
  /** Optional W3C Trace Context state. */
  tracestate?: string
  /** Scalar metadata exposed to handlers and telemetry sanitizers. */
  metadata?: Record<string, JsonValue>
  /**
   * Opt a workflow run into durable execution against the configured
   * `.runtime(...)` (and optional `.workspaceStore(...)`). Workflow-only;
   * supplying it on an agent run throws `ValidationError`.
   */
  durable?: DurableInvokeOptions
}

/** Canonical built-in tool names provided by the harness. */
export type BuiltinToolName = 'bash' | 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'list'

/** Permission modes for sandbox-mutating tools. */
export type PermissionMode = 'allow' | 'ask' | 'deny'

/** Structured permission policy for a single tool family. */
export interface PermissionPolicy {
  /** Base decision mode for the tool family. */
  mode: PermissionMode
  /** Optional allowlist evaluated by harness-specific policy hooks. */
  allow?: readonly string[]
  /** Optional denylist evaluated by harness-specific policy hooks. */
  deny?: readonly string[]
}

/** Per-agent permission configuration for built-in mutating tools. */
export interface AgentPermissions {
  /** Permission mode or policy for the `bash` built-in tool. */
  bash?: PermissionMode | PermissionPolicy
  /** Permission mode or policy for the `write` built-in tool. */
  write?: PermissionMode | PermissionPolicy
  /** Permission mode or policy for the `edit` built-in tool. */
  edit?: PermissionMode | PermissionPolicy
}

/** Context passed to custom permission hooks. */
export interface PermissionContext {
  /** Tool name under evaluation. */
  toolName: string
  /** Raw input proposed for the tool call. */
  input: unknown
  /** Current agent id. */
  agentId: string
  /** Current run id. */
  runId: string
  /** Current session id. */
  sessionId: string
}

/** Final decision returned from a permission hook. */
export type PermissionDecision = 'allow' | 'deny'

/** Async permission hook used for interactive approvals or custom policy engines. */
export type OnPermission = (ctx: PermissionContext) => Promise<PermissionDecision>

/** Skill frontmatter parsed from `SKILL.md`. */
export interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  'allowed-tools'?: string
}

/** Validation mode for `SKILL.md` frontmatter. */
export type SkillValidationMode = 'strict' | 'lenient'

/** Diagnostic produced while parsing or discovering skills. */
export interface SkillDiagnostic {
  level: 'warn' | 'error'
  code:
    | 'missing_skill_md'
    | 'invalid_frontmatter'
    | 'missing_description'
    | 'invalid_name'
    | 'name_mismatch'
    | 'directory_missing'
    | 'collision_shadowed'
    | 'untrusted_project_skill'
    | 'scan_limit_reached'
  message: string
  skillName?: string
  directory?: string
  source?: string
}

/** Mounted skill metadata after frontmatter parsing. */
export interface ResolvedSkill {
  /** Public skill id. */
  name: string
  /** Short user-facing description from frontmatter. */
  description: string
  /** Absolute directory mounted into `/skills/<name>`. */
  directory: string
  /** Absolute path to the parsed `SKILL.md`. */
  skillPath: string
  /** Absolute path exposed as the skill instruction file location. */
  location: string
  /** Sandbox mount path for this skill. */
  mountPath: `/skills/${string}`
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string
  trust: 'trusted' | 'project' | 'user'
  source?: string
  diagnostics: readonly SkillDiagnostic[]
}

/** Conversation history accessor for a single session thread. */
export interface ConversationHistory {
  /** Returns persisted conversation messages for the session. */
  list(opts?: { limit?: number; before?: string }): Promise<Message[]>
}

/** Context provided to custom TypeScript tools. */
export interface ToolHandlerContext {
  signal: AbortSignal
  sandbox: import('../sandbox/index.js').SandboxSession
  logger: Logger
  telemetry: TelemetryShim
  metrics: Metrics
  memory: MemoryFacade
  runId: string
  sessionId: string
  agentId: string
  toolId: string
}

/** TypeScript-native tool definition. */
export interface TsToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Tool kind discriminator. Defaults to `ts`. */
  kind?: 'ts'
  /** Short model-facing description. */
  description: string
  /** Input schema validated before handler invocation. */
  input: I
  /** Output schema validated after handler invocation. */
  output: O
  /** Async tool implementation running inside the current session sandbox. */
  handler: (ctx: ToolHandlerContext, input: z.infer<I>) => Promise<z.infer<O>>
  /** Optional adapter hook for inheriting harness logger, telemetry, and defaults. */
  configureHarnessContext?: (context: HarnessAdapterContext) => void
}

/** MCP-over-stdio tool definition. */
export interface McpStdioToolDefinition {
  kind: 'mcp_stdio'
  description: string
  command: string
  args?: readonly string[]
  env?: Record<string, string>
  /** Optional bootstrap command executed inside the sandbox before the MCP server is called. */
  install?: {
    command: string
    cwd?: string
    env?: Record<string, string>
    timeoutMs?: number
  }
  tool: string
  inputAdapter?: (input: unknown) => unknown
  outputAdapter?: (output: unknown) => unknown
  configureHarnessContext?: (context: HarnessAdapterContext) => void
}

/** Supported MCP auth kinds. */
export type McpAuth =
  /** No authentication. */
  | { kind: 'none' }
  /** Bearer token authentication. */
  | { kind: 'bearer'; token: string }
  /** OAuth2 access token authentication. */
  | { kind: 'oauth2'; accessToken: string }
  /** API key authentication. */
  | { kind: 'api_key'; header: string; value: string }
  /** Basic authentication. */
  | { kind: 'basic'; username: string; password: string }

/** MCP-over-HTTP tool definition. */
export interface McpHttpToolDefinition {
  kind: 'mcp_http'
  description: string
  url: string
  tool: string
  auth?: McpAuth
  headers?: Record<string, string>
  inputAdapter?: (input: unknown) => unknown
  outputAdapter?: (output: unknown) => unknown
  configureHarnessContext?: (context: HarnessAdapterContext) => void
}

/** Any tool definition accepted by `.tools(...)`. */
export type ToolDefinition = TsToolDefinition | McpStdioToolDefinition | McpHttpToolDefinition

/** Full tool registry shape. */
export type ToolsConfig = Record<string, ToolDefinition>

/** Skill definition registered on the harness builder. */
export interface SkillDefinition {
  /** Absolute path to the directory containing `SKILL.md`. */
  directory: string
  validationMode?: SkillValidationMode
  trust?: 'trusted' | 'project' | 'user'
  source?: string
}

/** Full skill registry shape. */
export type SkillsConfig = Record<string, SkillDefinition>

/** Options for local Agent Skills discovery. */
export interface DiscoverSkillsOptions {
  projectRoot?: string
  clientName?: string
  includeProjectAgentsDir?: boolean
  includeProjectClientDir?: boolean
  includeUserAgentsDir?: boolean
  includeUserClientDir?: boolean
  includeClaudeCompatDir?: boolean
  includeAncestorProjectDirs?: boolean
  trustedProjectRoots?: readonly string[]
  validationMode?: SkillValidationMode
  maxDepth?: number
  maxDirectories?: number
}

/** Result of local Agent Skills discovery. */
export interface DiscoveredSkills {
  skills: SkillsConfig
  diagnostics: readonly SkillDiagnostic[]
}

/** Alias map passed to `.models(...)`. */
export type ModelsConfig = Record<string, ModelAlias>

/** Builder-state accumulator used for type propagation across the fluent harness builder. */
export interface BuilderState {
  models?: ModelsConfig
  tools?: ToolsConfig
  skills?: SkillsConfig
  agents?: Record<string, AgentDefinition<any, any, any>>
  workflows?: Record<string, WorkflowDefinition<any, any, any>>
}

type InferSchemaOrString<T> = T extends z.ZodTypeAny ? z.infer<T> : string

type DefinitionInput<D> = D extends { input: infer I } ? InferSchemaOrString<I> : D extends { input?: infer I } ? InferSchemaOrString<I> : string

type DefinitionOutput<D> = D extends { output: infer O } ? InferSchemaOrString<O> : D extends { output?: infer O } ? InferSchemaOrString<O> : string

/** Helper to infer workflow input type from a workflow definition. */
export type WorkflowInput<S extends BuilderState, K extends keyof NonNullable<S['workflows']>> =
  DefinitionInput<NonNullable<S['workflows']>[K]>

/** Helper to infer workflow output type from a workflow definition. */
export type WorkflowOutput<S extends BuilderState, K extends keyof NonNullable<S['workflows']>> =
  DefinitionOutput<NonNullable<S['workflows']>[K]>

/** Helper to infer agent input type from an agent definition. */
export type AgentInput<S extends BuilderState, K extends keyof NonNullable<S['agents']>> =
  DefinitionInput<NonNullable<S['agents']>[K]>

/** Helper to infer agent output type from an agent definition. */
export type AgentOutput<S extends BuilderState, K extends keyof NonNullable<S['agents']>> =
  DefinitionOutput<NonNullable<S['agents']>[K]>

/** Capability-filtered model handles keyed by configured model alias. */
export type ModelHandles<S extends BuilderState> = {
  readonly [K in keyof NonNullable<S['models']>]: NonNullable<S['models']>[K] extends { capabilities: readonly ModelCapability[] }
    ? ModelHandle<NonNullable<S['models']>[K]>
    : never
}

/** Minimal context available when deriving dynamic agent instructions. */
export interface AgentContextMinimal<S extends BuilderState, I> {
  input: I
  sessionId: string
  runId: string
  history: ConversationHistory
  memory: MemoryFacade
  metadata: Readonly<Record<string, JsonValue>>
  metrics: Metrics
}

/** Full context passed to workflow handlers. */
export interface WorkflowContext<S extends BuilderState, I, O> {
  input: I
  agents: { [K in keyof NonNullable<S['agents']>]: (input: AgentInput<S, K>, opts?: InvokeOptions) => Promise<AgentOutput<S, K>> }
  models: ModelHandles<S>
  signal: AbortSignal
  runId: string
  sessionId: string
  metadata: Readonly<Record<string, JsonValue>>
  memory: MemoryFacade
  metrics: Metrics
  /**
   * Runs `fn` as a durable step. Under a durable invocation the output is
   * checkpointed and replayed on resume without re-running `fn`; otherwise it is
   * a transparent pass-through. See spec 10 "Durable steps".
   */
  step<T extends JsonValue>(stepId: string, fn: () => Promise<T>): Promise<T>
  output?: O
}

/** Full context passed to custom agent handlers. */
export interface AgentContext<S extends BuilderState, I, O> extends AgentContextMinimal<S, I> {
  models: ModelHandles<S>
  signal: AbortSignal
  output?: O
}

/** Agent definition registered inline within `.agents(...)`. */
export interface AgentDefinition<
  S extends BuilderState,
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny
> {
  input?: I
  output?: O
  model: keyof NonNullable<S['models']> & string
  instructions: string | ((ctx: AgentContextMinimal<S, z.infer<I>>) => string)
  tools?: readonly (keyof NonNullable<S['tools']> & string)[]
  builtinTools?: readonly BuiltinToolName[] | false
  skills?: readonly (keyof NonNullable<S['skills']> & string)[]
  permissions?: AgentPermissions
  onPermission?: OnPermission
  maxSteps?: number
  handler?: (ctx: AgentContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>
}

/** Workflow definition registered inline within `.workflows(...)`. */
export interface WorkflowDefinition<
  S extends BuilderState,
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny
> {
  input?: I
  output?: O
  handler: (ctx: WorkflowContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>
}

type AgentSchemaFields = {
  input?: z.ZodTypeAny
  output?: z.ZodTypeAny
}

type AgentDefinitionResolved<S extends BuilderState, I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  input?: I
  output?: O
  model: keyof NonNullable<S['models']> & string
  instructions: string | ((ctx: AgentContextMinimal<S, z.infer<I>>) => string)
  tools?: readonly (keyof NonNullable<S['tools']> & string)[]
  builtinTools?: readonly BuiltinToolName[] | false
  skills?: readonly (keyof NonNullable<S['skills']> & string)[]
  permissions?: AgentPermissions
  onPermission?: OnPermission
  maxSteps?: number
  handler?: (ctx: AgentContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>
}

type AgentDefinitionFor<S extends BuilderState, D> =
  D extends { input: infer I extends z.ZodTypeAny; output: infer O extends z.ZodTypeAny }
    ? AgentDefinitionResolved<S, I, O>
    : D extends { input: infer I extends z.ZodTypeAny }
      ? AgentDefinitionResolved<S, I, z.ZodString>
      : D extends { output: infer O extends z.ZodTypeAny }
        ? AgentDefinitionResolved<S, z.ZodString, O>
        : AgentDefinitionResolved<S, z.ZodString, z.ZodString>

type AgentsConfigFromSchemaMaps<
  S extends BuilderState,
  A extends { [K in keyof A]: { input: z.ZodTypeAny; output: z.ZodTypeAny } }
> = {
  [K in keyof A]: A[K] & AgentDefinitionResolved<S, A[K]['input'], A[K]['output']>
}

type WorkflowSchemaFields = {
  input?: z.ZodTypeAny
  output?: z.ZodTypeAny
}

type WorkflowDefinitionResolved<S extends BuilderState, I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  input?: I
  output?: O
  handler: (ctx: WorkflowContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>
}

type WorkflowDefinitionFor<S extends BuilderState, D> =
  D extends { input: infer I extends z.ZodTypeAny; output: infer O extends z.ZodTypeAny }
    ? WorkflowDefinitionResolved<S, I, O>
    : D extends { input: infer I extends z.ZodTypeAny }
      ? WorkflowDefinitionResolved<S, I, z.ZodString>
      : D extends { output: infer O extends z.ZodTypeAny }
        ? WorkflowDefinitionResolved<S, z.ZodString, O>
        : WorkflowDefinitionResolved<S, z.ZodString, z.ZodString>

type WorkflowsConfigFromSchemaMaps<
  S extends BuilderState,
  W extends { [K in keyof W]: { input: z.ZodTypeAny; output: z.ZodTypeAny } }
> = {
  [K in keyof W]: W[K] & WorkflowDefinitionResolved<S, W[K]['input'], W[K]['output']>
}

export interface AgentDefinitionHelpers<S extends BuilderState> {
  agent<const I extends z.ZodTypeAny, const O extends z.ZodTypeAny>(
    definition: AgentDefinitionResolved<S, I, O> & { input: I; output: O }
  ): AgentDefinitionResolved<S, I, O> & { input: I; output: O }
}

export interface WorkflowDefinitionHelpers<S extends BuilderState> {
  workflow<const I extends z.ZodTypeAny, const O extends z.ZodTypeAny>(
    definition: WorkflowDefinitionResolved<S, I, O> & { input: I; output: O }
  ): WorkflowDefinitionResolved<S, I, O> & { input: I; output: O }
}

/** Agent registry shape constrained by the previously declared models/tools/skills. */
export type AgentsConfig<S extends BuilderState, A extends { [K in keyof A]: AgentSchemaFields } = Record<string, AgentSchemaFields>> = {
  [K in keyof A]: A[K] & AgentDefinitionFor<S, A[K]>
}

/** Workflow registry shape constrained by the previously declared agents. */
export type WorkflowsConfig<S extends BuilderState, W extends { [K in keyof W]: WorkflowSchemaFields } = Record<string, WorkflowSchemaFields>> = {
  [K in keyof W]: W[K] & WorkflowDefinitionFor<S, W[K]>
}

/** Typed workflow invoker available under `session.workflows.<id>`. */
export interface WorkflowInvoker<S extends BuilderState, K extends keyof NonNullable<S['workflows']>> {
  /** Runs the workflow to completion and resolves its validated output. */
  prompt(input: WorkflowInput<S, K>, opts?: InvokeOptions): Promise<WorkflowOutput<S, K>>
  /** Streams run events while the workflow executes. */
  stream(input: WorkflowInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

/** Typed agent invoker available under `session.agents.<id>`. */
export interface AgentInvoker<S extends BuilderState, K extends keyof NonNullable<S['agents']>> {
  /** Runs the agent to completion and resolves its validated output. */
  prompt(input: AgentInput<S, K>, opts?: InvokeOptions): Promise<AgentOutput<S, K>>
  /** Streams run events while the agent executes. */
  stream(input: AgentInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

/** Compile-time-only namespace exposed as `harness.$infer`. */
export type InferTypes<S extends BuilderState> = {
  models: keyof NonNullable<S['models']>
  tools: keyof NonNullable<S['tools']>
  skills: keyof NonNullable<S['skills']>
  agents: { [K in keyof NonNullable<S['agents']>]: { input: AgentInput<S, K>; output: AgentOutput<S, K> } }
  workflows: { [K in keyof NonNullable<S['workflows']>]: { input: WorkflowInput<S, K>; output: WorkflowOutput<S, K> } }
}

/** Harness handle returned from `build()`. */
export interface Harness<S extends BuilderState> {
  /** Opens or creates a fresh session facade bound to `id`. */
  getSession(id: string): Promise<Session<S>>
  /** Returns a synchronous, data-only snapshot of resolved adapter setup. */
  inspect(): HarnessInspection
  /** Closes harness-owned adapters and returns any shutdown errors. */
  shutdown(): Promise<{ errors: HarnessError[] }>
  /** Phantom inference handle. Harness value is always the literal `{}`. */
  readonly $infer: InferTypes<S>
}

/** Session-scoped operational API. */
export interface Session<S extends BuilderState> {
  readonly id: string
  readonly agents: { readonly [K in keyof NonNullable<S['agents']>]: AgentInvoker<S, K> }
  readonly workflows: { readonly [K in keyof NonNullable<S['workflows']>]: WorkflowInvoker<S, K> }
  memory: SessionMemory
  history: ConversationHistory
  getRunSummary(runId: string): Promise<RunSummary | undefined>
  clearHistory(): Promise<void>
  replaceHistory(messages: ReadonlyArray<Omit<Message, 'id' | 'timestamp'>>): Promise<void>
  close(): Promise<void>
}

/** Structured run-event error payload. */
export interface SerializedError {
  code: string
  category: string
  retriable: boolean
  message: string
  meta?: Record<string, unknown>
}

export interface RunSummary {
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

/**
 * Harness streaming events emitted from `session.workflows.<id>.stream(...)`.
 *
 * `text(...)` and `object(...)` model calls return final results and do not
 * expose partial output. Consumed model streams are private by default.
 * `model.delta`, `model.object.partial`, and streamed `model.object` are
 * emitted only when that `textStream(...)` or `objectStream(...)` call passes
 * `{ emitRunEvents: true }`.
 */
export type RunEvent =
  | { type: 'run.started'; runId: string; at: string }
  | { type: 'run.finished'; runId: string; at: string; output?: JsonValue; error?: SerializedError }
  | { type: 'agent.started'; runId: string; agentId: string; at: string }
  | { type: 'agent.finished'; runId: string; agentId: string; at: string; output?: JsonValue; error?: SerializedError }
  | { type: 'model.delta'; runId: string; streamId: string; agentId?: string; workflowId?: string; modelAlias?: string; delta: string }
  | { type: 'tool.started'; runId: string; agentId: string; toolId: string; callId: string; input: JsonValue }
  | { type: 'tool.finished'; runId: string; agentId: string; toolId: string; callId: string; output?: JsonValue; error?: SerializedError }
  | { type: 'model.message'; runId: string; agentId: string; message: Message }
  | { type: 'model.object.partial'; runId: string; streamId: string; agentId?: string; workflowId?: string; modelAlias?: string; partial: JsonValue }
  | { type: 'model.object'; runId: string; agentId?: string; workflowId?: string; modelAlias?: string; streamId?: string; object: JsonValue; usage?: TokenUsage }
  | { type: 'model.embedding.completed'; runId: string; agentId?: string; count: number; dimensions?: number; usage?: TokenUsage }
  | { type: 'model.rerank.completed'; runId: string; agentId?: string; count: number; topN?: number; usage?: TokenUsage }
  | { type: 'stream.overflow'; runId: string; at: string; dropped: number }

/** Fluent builder contract for composing a harness. */
export interface HarnessBuilder<S extends BuilderState = {}> {
  telemetry(opts: TelemetryOptions): HarnessBuilder<S>
  logger(logger: Logger): HarnessBuilder<S>
  state(store: StateStore): HarnessBuilder<S>
  sandbox(sandbox?: Sandbox<any>): HarnessBuilder<S>
  memory(adapter: MemoryAdapter): HarnessBuilder<S>
  runtime(runtime: DurableRuntimeAdapter): HarnessBuilder<S>
  workspaceStore(store: DurableWorkspaceStore): HarnessBuilder<S>
  requires(capabilities: readonly AdapterCapability[]): HarnessBuilder<S>
  defaults(defaults: HarnessDefaults): HarnessBuilder<S>
  models<const M extends ModelsConfig>(models: M): HarnessBuilder<S & { models: M }>
  tools<const T extends ToolsConfig>(tools: T): HarnessBuilder<S & { tools: T }>
  skills<const K extends SkillsConfig>(skills: K): HarnessBuilder<S & { skills: K }>
  agents<const A extends { [K in keyof A]: AgentDefinition<any, any, any> }>(
    agents: (helpers: AgentDefinitionHelpers<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }>) => A
  ): HarnessBuilder<S & { agents: A }>
  agents<const A extends { [K in keyof A]: { input: z.ZodTypeAny; output: z.ZodTypeAny } }>(agents: AgentsConfigFromSchemaMaps<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A>): HarnessBuilder<S & { agents: AgentsConfigFromSchemaMaps<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A> }>
  agents<const A extends { [K in keyof A]: AgentDefinitionFor<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A[K]> }>(agents: A): HarnessBuilder<S & { agents: A }>
  workflows<const W extends { [K in keyof W]: WorkflowDefinition<any, any, any> }>(
    workflows: (helpers: WorkflowDefinitionHelpers<S & { agents: NonNullable<S['agents']> }>) => W
  ): HarnessBuilder<S & { workflows: W }>
  workflows<const W extends { [K in keyof W]: { input: z.ZodTypeAny; output: z.ZodTypeAny } }>(workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W>): HarnessBuilder<S & { workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W> }>
  workflows<const W extends { [K in keyof W]: WorkflowDefinitionFor<S & { agents: NonNullable<S['agents']> }, W[K]> }>(workflows: W): HarnessBuilder<S & { workflows: W }>
  build(): Harness<S>
}

type BuilderStateInternal = {
  telemetry?: TelemetryOptions
  logger?: Logger
  state?: StateStore
  sandbox?: Sandbox<any>
  memory?: MemoryAdapter
  runtime?: DurableRuntimeAdapter
  workspaceStore?: DurableWorkspaceStore
  requiredCapabilities?: readonly AdapterCapability[]
  defaults?: HarnessDefaults
  models?: ModelsConfig
  tools?: ToolsConfig
  skills?: SkillsConfig
  agents?: Record<string, AgentDefinition<any, any, any>>
  workflows?: Record<string, WorkflowDefinition<any, any, any>>
}

class Builder<S extends BuilderState> implements HarnessBuilder<S> {
  private readonly options: HarnessOptions
  private readonly configured: BuilderStateInternal

  public constructor(options: HarnessOptions, configured: BuilderStateInternal = {}) {
    this.options = options
    this.configured = configured
  }

  public telemetry(opts: TelemetryOptions): HarnessBuilder<S> {
    return this.clone({ telemetry: opts })
  }

  public logger(logger: Logger): HarnessBuilder<S> {
    return this.clone({ logger })
  }

  public state(store: StateStore): HarnessBuilder<S> {
    return this.clone({ state: store })
  }

  public sandbox(sandbox: Sandbox<any> = autoDetectSandbox()): HarnessBuilder<S> {
    return this.clone({ sandbox })
  }

  public memory(memory: MemoryAdapter): HarnessBuilder<S> {
    if (this.configured.memory) {
      throw new HarnessConfigError('Memory adapter is already configured.', { reason: 'duplicate_adapter', path: 'memory' })
    }
    validateMemoryAdapter(memory)
    return this.clone({ memory })
  }

  public runtime(runtime: DurableRuntimeAdapter): HarnessBuilder<S> {
    return this.clone({ runtime })
  }

  public workspaceStore(workspaceStore: DurableWorkspaceStore): HarnessBuilder<S> {
    if (this.configured.workspaceStore) {
      throw new HarnessConfigError('Workspace store is already configured.', { reason: 'duplicate_adapter', path: 'workspaceStore' })
    }
    validateDurableWorkspaceStore(workspaceStore)
    return this.clone({ workspaceStore })
  }

  public requires(capabilities: readonly AdapterCapability[]): HarnessBuilder<S> {
    return this.clone({ requiredCapabilities: uniqueCapabilities(capabilities) })
  }

  public defaults(defaults: HarnessDefaults): HarnessBuilder<S> {
    if (defaults.historyWindow !== undefined && defaults.historyWindow < 0) {
      throw new HarnessConfigError('historyWindow must be >= 0', { reason: 'invalid_defaults', path: 'defaults.historyWindow' })
    }
    if (defaults.maxParallelToolCalls !== undefined && (!Number.isInteger(defaults.maxParallelToolCalls) || defaults.maxParallelToolCalls < 1)) {
      throw new HarnessConfigError('maxParallelToolCalls must be a positive integer', { reason: 'invalid_defaults', path: 'defaults.maxParallelToolCalls' })
    }
    return this.clone({ defaults })
  }

  public models<const M extends ModelsConfig>(models: M): HarnessBuilder<S & { models: M }> {
    if (Object.keys(models).length === 0) {
      throw new HarnessConfigError('At least one model alias is required.', { reason: 'missing_models', path: 'models' })
    }
    return this.clone({ models }) as unknown as HarnessBuilder<S & { models: M }>
  }

  public tools<const T extends ToolsConfig>(tools: T): HarnessBuilder<S & { tools: T }> {
    for (const id of Object.keys(tools)) {
      if (!/^[a-z][a-z0-9_]*$/.test(id) || id.length > 64) {
        throw new HarnessConfigError(
          'Invalid tool id. Tool ids must match /^[a-z][a-z0-9_]*$/ and be at most 64 characters.',
          { reason: 'invalid_tool_id', path: `tools.${id}`, id }
        )
      }
    }
    return this.clone({ tools }) as unknown as HarnessBuilder<S & { tools: T }>
  }

  public skills<const K extends SkillsConfig>(skills: K): HarnessBuilder<S & { skills: K }> {
    return this.clone({ skills }) as unknown as HarnessBuilder<S & { skills: K }>
  }

  public agents<const A extends { [K in keyof A]: AgentDefinition<any, any, any> }>(
    agents: (helpers: AgentDefinitionHelpers<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }>) => A
  ): HarnessBuilder<S & { agents: A }>
  public agents<const A extends { [K in keyof A]: { input: z.ZodTypeAny; output: z.ZodTypeAny } }>(agents: AgentsConfigFromSchemaMaps<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A>): HarnessBuilder<S & { agents: AgentsConfigFromSchemaMaps<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A> }>
  public agents<const A extends { [K in keyof A]: AgentDefinitionFor<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A[K]> }>(agents: A): HarnessBuilder<S & { agents: A }>
  public agents(agents: Record<string, AgentDefinition<any, any, any>> | ((helpers: AgentDefinitionHelpers<any>) => Record<string, AgentDefinition<any, any, any>>)): HarnessBuilder<any> {
    const resolved = typeof agents === 'function'
      ? agents({ agent: (definition) => definition })
      : agents
    this.validateAgentSkillReferences(resolved)
    return this.clone({ agents: resolved }) as unknown as HarnessBuilder<any>
  }

  public workflows<const W extends { [K in keyof W]: WorkflowDefinition<any, any, any> }>(
    workflows: (helpers: WorkflowDefinitionHelpers<S & { agents: NonNullable<S['agents']> }>) => W
  ): HarnessBuilder<S & { workflows: W }>
  public workflows<const W extends { [K in keyof W]: { input: z.ZodTypeAny; output: z.ZodTypeAny } }>(workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W>): HarnessBuilder<S & { workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W> }>
  public workflows<const W extends { [K in keyof W]: WorkflowDefinitionFor<S & { agents: NonNullable<S['agents']> }, W[K]> }>(workflows: W): HarnessBuilder<S & { workflows: W }>
  public workflows(workflows: Record<string, WorkflowDefinition<any, any, any>> | ((helpers: WorkflowDefinitionHelpers<any>) => Record<string, WorkflowDefinition<any, any, any>>)): HarnessBuilder<any> {
    const resolved = typeof workflows === 'function'
      ? workflows({ workflow: (definition) => definition })
      : workflows
    return this.clone({ workflows: resolved }) as unknown as HarnessBuilder<any>
  }

  public build(): Harness<S> {
    const models = this.configured.models
    if (!models || Object.keys(models).length === 0) {
      throw new HarnessConfigError('At least one model alias is required.', { reason: 'missing_models', path: 'models' })
    }
    this.validateToolSkillNamespace()
    const sandbox = this.configured.sandbox ?? autoDetectSandbox()
    const memory = this.configured.memory ?? sandboxMemory()
    validateMemoryAdapter(memory)
    if (this.configured.workspaceStore) validateDurableWorkspaceStore(this.configured.workspaceStore)
    const inspection = this.resolveInspection(this.options.name ?? 'agent-harness', sandbox, memory, models)
    const missing = missingCapabilities(inspection.requiredCapabilities, inspection.capabilities)
    if (missing.length > 0) {
      throw new HarnessConfigError('Required adapter capabilities are not available.', {
        reason: 'missing_required_capability',
        path: 'requires',
        id: missing.join(',')
      })
    }

    const harness = createSessionHarness<S>({
      name: this.options.name ?? 'agent-harness',
      logger: this.configured.logger ?? new JsonLogger(),
      ...(this.configured.telemetry ? { telemetry: this.configured.telemetry } : {}),
      state: this.configured.state ?? new InMemoryStateStore(),
      sandbox,
      memory,
      ...(this.configured.runtime ? { runtime: this.configured.runtime } : {}),
      ...(this.configured.workspaceStore ? { workspaceStore: this.configured.workspaceStore } : {}),
      defaults: {
        agentMaxIterations: this.configured.defaults?.agentMaxIterations ?? 16,
        runTimeoutMs: this.configured.defaults?.runTimeoutMs ?? 600_000,
        toolTimeoutMs: this.configured.defaults?.toolTimeoutMs ?? 120_000,
        skillTimeoutMs: this.configured.defaults?.skillTimeoutMs ?? 60_000,
        modelTimeoutMs: this.configured.defaults?.modelTimeoutMs ?? 300_000,
        maxParallelToolCalls: this.configured.defaults?.maxParallelToolCalls ?? 8,
        ...(this.configured.defaults?.historyWindow !== undefined ? { historyWindow: this.configured.defaults.historyWindow } : {})
      },
      models,
      tools: (this.configured.tools ?? {}) as NonNullable<S['tools']>,
      skills: (this.configured.skills ?? {}) as NonNullable<S['skills']>,
      agents: (this.configured.agents ?? {}) as NonNullable<S['agents']>,
      workflows: (this.configured.workflows ?? {}) as NonNullable<S['workflows']>,
      inspection
    })

    return harness
  }

  private clone(patch: Partial<BuilderStateInternal>): Builder<S> {
    return new Builder(this.options, { ...this.configured, ...patch })
  }

  /**
   * Tool ids, skill ids, and built-in tool names share one model-facing
   * namespace (spec 08 §6). A custom tool id must not collide with a built-in
   * tool name or a skill id, and a skill id must not collide with a built-in
   * tool name.
   */
  private validateToolSkillNamespace(): void {
    const toolIds = Object.keys(this.configured.tools ?? {})
    const skillIds = new Set(Object.keys(this.configured.skills ?? {}))
    const builtinNames = new Set<string>(BUILTIN_TOOL_NAMES)

    for (const id of toolIds) {
      if (builtinNames.has(id)) {
        throw new SkillManifestError(`Custom tool id "${id}" collides with a built-in tool name.`, {
          reason: 'reserved_name',
          skill_id: id,
          source: 'tool'
        })
      }
      if (skillIds.has(id)) {
        throw new SkillManifestError(`Custom tool id "${id}" collides with a skill id.`, {
          reason: 'reserved_name',
          skill_id: id,
          source: 'tool'
        })
      }
    }

    for (const id of skillIds) {
      if (builtinNames.has(id)) {
        throw new SkillManifestError(`Skill id "${id}" collides with a built-in tool name.`, {
          reason: 'reserved_name',
          skill_id: id,
          source: 'skill'
        })
      }
    }
  }

  private validateAgentSkillReferences(agents: Record<string, AgentDefinition<any, any, any>>): void {
    const configuredSkills = new Set(Object.keys(this.configured.skills ?? {}))
    for (const [agentId, agent] of Object.entries(agents)) {
      for (const skillId of agent.skills ?? []) {
        if (!configuredSkills.has(skillId)) {
          throw new HarnessConfigError('Agent references an unknown skill.', {
            reason: 'invalid_agent',
            path: `agents.${agentId}.skills`,
            id: skillId
          })
        }
      }
    }
  }

  private resolveInspection(name: string, sandbox: Sandbox, memory: MemoryAdapter, models: ModelsConfig): HarnessInspection {
    const adapters: AdapterInspection[] = []
    const sandboxCapabilities = hasAdapterCapabilities(sandbox) ? uniqueCapabilities(sandbox.capabilities) : []
    adapters.push({
      kind: 'sandbox',
      id: getAdapterId(sandbox, 'sandbox'),
      capabilities: sandboxCapabilities
    })
    adapters.push({
      kind: 'memory',
      id: memory.info.id,
      capabilities: uniqueCapabilities(memory.info.capabilities),
      metadata: {
        packageName: memory.info.packageName,
        ...(memory.info.version ? { version: memory.info.version } : {})
      }
    })

    if (this.configured.runtime) {
      adapters.push({
        kind: 'runtime',
        id: this.configured.runtime.id ?? 'runtime',
        capabilities: uniqueCapabilities(this.configured.runtime.capabilities)
      })
    }

    if (this.configured.workspaceStore) {
      adapters.push({
        kind: 'workspace_store',
        id: this.configured.workspaceStore.info.id,
        capabilities: uniqueCapabilities(this.configured.workspaceStore.info.capabilities),
        metadata: {
          packageName: this.configured.workspaceStore.info.packageName,
          policy: this.configured.workspaceStore.info.policy
        }
      })
    }

    for (const [alias, model] of Object.entries(models)) {
      adapters.push({
        kind: 'model',
        id: alias,
        capabilities: [],
        metadata: {
          providerId: model.provider.id,
          genAiSystem: model.provider.genAiSystem,
          model: model.model,
          modelCapabilities: model.capabilities,
          ...(model.provider.info ? { providerInfo: model.provider.info } : {})
        }
      })
    }

    const capabilities = uniqueCapabilities(adapters.flatMap((adapter) => adapter.capabilities))
    return {
      name,
      capabilities,
      requiredCapabilities: uniqueCapabilities(this.configured.requiredCapabilities ?? []),
      adapters
    }
  }
}

function getAdapterId(adapter: unknown, fallback: string): string {
  if (adapter && typeof adapter === 'object' && typeof (adapter as { id?: unknown }).id === 'string') {
    return (adapter as { id: string }).id
  }
  return fallback
}

/**
 * Creates the chainable harness builder used to define a harness system.
 *
 * Application code should compose models, tools, skills, agents, and workflows here,
 * build the harness, and then execute work exclusively through `harness.getSession(...)`.
 *
 * @example
 * ```ts
 * const harness = defineHarness()
 *   .models({ fast: { provider, model: 'gpt-4.1-mini', capabilities: ['object'] } })
 *   .agents({ summarize: { model: 'fast', instructions: 'Summarize the input.' } })
 *   .workflows({
 *     summarize_ticket: {
 *       input: z.object({ ticket: z.string() }),
 *       output: z.string(),
 *       handler: (ctx) => ctx.agents.summarize(ctx.input.ticket)
 *     }
 *   })
 *   .build()
 *
 * const session = await harness.getSession('ticket-123')
 * const summary = await session.workflows.summarize_ticket.prompt({ ticket: 'Cannot log in' })
 * ```
 */
export function defineHarness(opts: HarnessOptions = {}): HarnessBuilder<{}> {
  return new Builder(opts)
}
