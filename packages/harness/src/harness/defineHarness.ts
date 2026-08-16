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
import type { ContextCheckpointStore } from '../ports/context-checkpoints.js'
import type { ContextCheckpoint, ContextCheckpointQuery } from '../ports/context-checkpoints.js'
import { validateContextCheckpointStore } from '../ports/context-checkpoints.js'
import { InMemoryStateStore } from '../state/in-memory.js'
import type { JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import { validateModelRetrySetting } from '../models/retry-policy.js'
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
  type HarnessInspection,
  type HarnessModuleInspection
} from '../ports/capabilities.js'
import type { DurableStepOptions } from '../runtime/steps.js'
import { type ContextProjectionPolicy, validateContextProjection } from '../context-projection.js'

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
  /**
   * Default maximum iterations for the built-in agent loop. Default: `16`.
   * Must be a positive integer; explicit values are not otherwise capped.
   */
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
  /** Optional retry-only transient context projection. */
  contextProjection?: ContextProjectionPolicy
  /** Default workflow child-agent delegation budgets. */
  delegation?: DelegationDefaults
}

/** Workflow child-agent delegation defaults. Delegation is disabled unless explicitly enabled. */
export interface DelegationDefaults {
  /**
   * Enable workflow child-agent calls for workflows that do not declare their
   * own `delegation` policy. Default: `false`.
   */
  enabled?: boolean
  /**
   * Maximum child-agent calls one workflow run may start. Default: `32`.
   * Set per workflow with `workflow.delegation.maxChildAgentCalls`.
   */
  maxChildAgentCalls?: number
  /**
   * Maximum child-agent calls active at the same time inside one workflow run.
   * Default: `8`.
   */
  maxParallelChildAgentCalls?: number
  /**
   * Maximum local delegation depth. Default: `1`.
   * Current harness workflows invoke leaf agents, so `1` allows normal
   * workflow-to-agent calls and `0` disables child-agent delegation.
   */
  maxDepth?: number
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
  /** Optional retry-only context projection override. */
  contextProjection?: ContextProjectionPolicy
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
  /** Working directory inside the current sandbox. */
  cwd?: string
  env?: Record<string, string>
  /** Prepares a sandbox-local launch before the MCP process is spawned. */
  prepareLaunch?: (context: { sandbox: import('../sandbox/index.js').SandboxSessionBase; signal?: AbortSignal }) => Promise<{
    command?: string
    args?: readonly string[]
    cwd?: string
    env?: Record<string, string>
    cleanup?: () => Promise<void>
  }>
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
export type ToolDefinition = TsToolDefinition<any, any> | McpStdioToolDefinition | McpHttpToolDefinition

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

/** Helper to infer custom TypeScript tool input from the configured Zod schema. */
export type ToolInput<S extends BuilderState, K extends keyof NonNullable<S['tools']> & string> =
  NonNullable<S['tools']>[K] extends TsToolDefinition<infer I, any> ? z.infer<I> : JsonValue

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
  checkpoints: ContextCheckpoints
  metadata: Readonly<Record<string, JsonValue>>
  metrics: Metrics
}

/** Context passed before each default agent loop model call. */
export interface AgentPrepareStepContext<S extends BuilderState, I> extends AgentContextMinimal<S, I> {
  /** Zero-based model-call step in the default loop. */
  step: number
  /** Model alias selected for this step before overrides are applied. */
  model: keyof NonNullable<S['models']> & string
  /** Messages that would be sent to the model for this step. */
  messages: readonly ModelMessage[]
  /** Model-facing tools that would be available for this step. */
  tools: readonly ModelToolSpec[]
}

/** Per-step overrides returned from `AgentDefinition.prepareStep`. */
export interface AgentPrepareStepResult<S extends BuilderState> {
  /** Optional model alias override for this model call. */
  model?: keyof NonNullable<S['models']> & string
  /** Optional instruction override for this model call only. */
  instructions?: string
  /** Optional model-facing tool names to keep active for this model call. */
  activeTools?: readonly string[]
  /** Optional message override for this model call only. */
  messages?: readonly ModelMessage[]
  /** Optional generation settings for this model call only. */
  call?: ModelCallOptions
}

/** Context passed after a default agent loop model call to decide whether to stop. */
export interface AgentStopWhenContext<S extends BuilderState, I> extends AgentPrepareStepContext<S, I> {
  /** Raw provider-normalized object response from the current model call. */
  response: ObjectResponse<JsonValue>
  /** Tool calls requested by the current model response. */
  toolCalls: readonly ToolCallSpec[]
}

/** Hook used to prepare each model call in the default agent loop. */
export type AgentPrepareStep<S extends BuilderState, I> =
  (ctx: AgentPrepareStepContext<S, I>) => AgentPrepareStepResult<S> | Promise<AgentPrepareStepResult<S> | void> | void

/** Hook used to stop the default loop after a model call. */
export type AgentStopWhen<S extends BuilderState, I> =
  (ctx: AgentStopWhenContext<S, I>) => boolean | Promise<boolean>

/** Governance mode for policy evaluation. `shadow` records decisions without enforcement. */
export type GovernanceMode = 'enforce' | 'shadow'

/** Policy effects supported by the built-in governance evaluator. */
export type GovernanceEffect = 'allow' | 'audit' | 'require_approval' | 'deny'

/** Policy decision for model-facing tool exposure before a model step. */
export type GovernanceExposureEffect = 'expose' | 'hide'

/** Optional risk severity attached to policy decisions for audit and review UX. */
export type GovernanceRiskLevel = 'critical' | 'high' | 'medium' | 'low'

/** Tool ids policy rules may target. Includes configured custom tools and built-in tools. */
export type GovernanceToolId<S extends BuilderState> = (keyof NonNullable<S['tools']> & string) | BuiltinToolName

type GovernanceToolInput<S extends BuilderState, K extends GovernanceToolId<S>> =
  K extends keyof NonNullable<S['tools']> & string ? ToolInput<S, K> : JsonValue

/** Context passed to native policy predicates and policy adapter evaluators. */
export interface GovernanceContext<S extends BuilderState = BuilderState, K extends GovernanceToolId<S> = GovernanceToolId<S>> {
  /** Canonical tool id under evaluation. */
  toolId: K
  /** Parsed tool input when a custom TypeScript tool schema is available; otherwise the raw JSON-compatible input. */
  input: GovernanceToolInput<S, K>
  /** Current agent id. */
  agentId: string
  /** Current run id. */
  runId: string
  /** Current session id. */
  sessionId: string
  /** Current workflow id when the agent is invoked from a workflow. */
  workflowId?: string
  /** Scalar invocation metadata. */
  metadata: Readonly<Record<string, JsonValue>>
}

/** Decision returned by a policy adapter or native policy rule. */
export interface GovernanceDecision {
  decisionId?: string
  effect: GovernanceEffect
  policyId: string
  policyVersion?: string
  ruleId?: string
  message?: string
  reason?: string
  riskLevel?: GovernanceRiskLevel
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

/** External policy adapter contract for OPA, Cedar, Eve-compatible engines, or bespoke evaluators. */
export interface GovernancePolicyEvaluator<S extends BuilderState = BuilderState> {
  id: string
  version?: string
  evaluate(ctx: GovernanceContext<S>): GovernanceDecision | readonly GovernanceDecision[] | undefined | Promise<GovernanceDecision | readonly GovernanceDecision[] | undefined>
}

/** Context passed to tool-exposure policy rules before the model sees a step's tool list. */
export interface GovernanceToolExposureContext<S extends BuilderState = BuilderState, K extends GovernanceToolId<S> = GovernanceToolId<S>> {
  /** Canonical tool id whose model exposure is under evaluation. */
  toolId: K
  /** Current agent id. */
  agentId: string
  /** Current run id. */
  runId: string
  /** Current session id. */
  sessionId: string
  /** Current workflow id when the agent is invoked from a workflow. */
  workflowId?: string
  /** Zero-based default-loop model step. */
  step: number
  /** Scalar invocation metadata. */
  metadata: Readonly<Record<string, JsonValue>>
}

/** Native tool-exposure rule scoped to one or more tool ids. */
export interface GovernanceToolExposureRuleForTool<S extends BuilderState, K extends GovernanceToolId<S>> {
  id: string
  description?: string
  effect: GovernanceExposureEffect
  tools?: readonly K[]
  when?: (ctx: GovernanceToolExposureContext<S, K>) => boolean | Promise<boolean>
  message?: string
  reason?: string
  riskLevel?: GovernanceRiskLevel
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

/** Native tool-exposure rule union with context narrowed by the selected tool id. */
export type GovernanceToolExposureRule<S extends BuilderState> = {
  [K in GovernanceToolId<S>]: GovernanceToolExposureRuleForTool<S, K>
}[GovernanceToolId<S>]

/** Optional pre-model tool-exposure policy. */
export interface GovernanceToolExposurePolicy<S extends BuilderState = BuilderState> {
  id?: string
  version?: string
  defaultEffect?: GovernanceExposureEffect
  rules?: readonly GovernanceToolExposureRule<S>[]
}

/** Native TypeScript policy rule scoped to one or more tool ids. */
export interface NativePolicyRuleForTool<S extends BuilderState, K extends GovernanceToolId<S>> {
  id: string
  description?: string
  effect: GovernanceEffect
  tools?: readonly K[]
  when?: (ctx: GovernanceContext<S, K>) => boolean | Promise<boolean>
  message?: string
  reason?: string
  riskLevel?: GovernanceRiskLevel
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

/** Native policy rule union with predicate input narrowed by the selected tool id. */
export type NativePolicyRule<S extends BuilderState> = {
  [K in GovernanceToolId<S>]: NativePolicyRuleForTool<S, K>
}[GovernanceToolId<S>]

/** Native policy definition evaluated by the harness without an external policy engine. */
export interface NativePolicyDefinition<S extends BuilderState = BuilderState> {
  kind: 'native'
  id: string
  version?: string
  description?: string
  rules: readonly NativePolicyRule<S>[]
}

export type GovernancePolicyDefinition<S extends BuilderState = BuilderState> =
  | NativePolicyDefinition<S>
  | GovernancePolicyEvaluator<S>

/** Approval request emitted when the winning policy effect is `require_approval`. */
export interface GovernanceApprovalRequest {
  approvalId: string
  toolId: string
  callId: string
  agentId: string
  runId: string
  sessionId: string
  workflowId?: string
  decisions: readonly GovernanceDecision[]
  metadata: Readonly<Record<string, JsonValue>>
}

/** Approval provider result. */
export type GovernanceApprovalResult =
  | { decision: 'approved'; approverId?: string; reason?: string; metadata?: Record<string, JsonValue> }
  | { decision: 'rejected'; approverId?: string; reason?: string; metadata?: Record<string, JsonValue> }

/** Optional approval adapter used only by policies that return `require_approval`. */
export interface GovernanceApprovalProvider {
  request(request: GovernanceApprovalRequest): Promise<GovernanceApprovalResult>
}

/** Context passed to governance audit sinks for every evaluated execution policy decision. */
export interface GovernanceAuditContext {
  toolId: string
  callId: string
  agentId: string
  runId: string
  sessionId: string
  workflowId?: string
  metadata: Readonly<Record<string, JsonValue>>
  enforced: boolean
}

/** Optional audit sink for policy decisions. */
export interface GovernanceAuditSink {
  record(decision: GovernanceDecision, ctx: GovernanceAuditContext): Promise<void>
}

/** Optional policy-driven governance layer. Omitted config leaves the harness behavior unchanged. */
export interface GovernanceConfig<S extends BuilderState = BuilderState> {
  enabled?: boolean
  mode?: GovernanceMode
  defaultEffect?: 'allow' | 'deny'
  policies?: readonly GovernancePolicyDefinition<S>[]
  exposure?: GovernanceToolExposurePolicy<S>
  approval?: GovernanceApprovalProvider
  audit?: GovernanceAuditSink
}

export interface GovernanceDefinitionHelpers<S extends BuilderState> {
  rule<const K extends GovernanceToolId<S>>(definition: NativePolicyRuleForTool<S, K>): NativePolicyRuleForTool<S, K>
  exposureRule<const K extends GovernanceToolId<S>>(definition: GovernanceToolExposureRuleForTool<S, K>): GovernanceToolExposureRuleForTool<S, K>
  native<const P extends Omit<NativePolicyDefinition<S>, 'kind'>>(definition: P): P & { kind: 'native' }
  adapter<const P extends GovernancePolicyEvaluator<S>>(definition: P): P
}

/** Run-bound facade for explicit long-horizon context checkpoints. */
export interface ContextCheckpoints {
  write(input: {
    sequence: number
    kind: ContextCheckpoint['kind']
    payload: JsonValue
    metadata?: Record<string, JsonValue>
  }): Promise<void>
  list(query?: Omit<ContextCheckpointQuery, 'runId' | 'sessionId' | 'workflowId' | 'agentId' | 'signal'>): Promise<readonly ContextCheckpoint[]>
  read(ref: { sequence: number; kind: ContextCheckpoint['kind'] }): Promise<ContextCheckpoint | undefined>
  delete(ref: { sequence: number; kind: ContextCheckpoint['kind'] }): Promise<void>
}

/** Full context passed to workflow handlers. */
export interface WorkflowContext<S extends BuilderState, I, O> {
  input: I
  agents: { [K in keyof NonNullable<S['agents']>]: (input: AgentInput<S, K>, opts?: WorkflowAgentInvokeOptions<S, K>) => Promise<AgentOutput<S, K>> }
  models: ModelHandles<S>
  /** Harness logger scoped for workflow handler code (spec 10 `WorkflowContext`). */
  log: Logger
  signal: AbortSignal
  runId: string
  sessionId: string
  metadata: Readonly<Record<string, JsonValue>>
  memory: MemoryFacade
  checkpoints: ContextCheckpoints
  metrics: Metrics
  /**
   * Runs `fn` as a durable step. Under a durable invocation the output is
   * checkpointed and replayed on resume without re-running `fn`; otherwise it is
   * a transparent pass-through. See spec 10 "Durable steps".
   */
  step<T extends JsonValue>(stepId: string, fn: () => Promise<T>, options?: DurableStepOptions): Promise<T>
  /**
   * Runs independent workflow work with bounded, cancellation-aware
   * concurrency. Results retain input order. The effective concurrency never
   * exceeds this workflow's child-agent delegation budget.
   */
  fanOut<T, R>(items: readonly T[], worker: (item: T, index: number) => Promise<R>, options?: WorkflowFanOutOptions): Promise<R[]>
  /** Starts an isolated, workflow-owned child-agent task. */
  childTasks: WorkflowChildTasks<S>
  output?: O
}

/** Configuration for one typed workflow fan-out batch. */
export interface WorkflowFanOutOptions {
  /** Maximum concurrently executing workers. Defaults to the workflow child-agent budget. */
  concurrency?: number
}

/** Content policy for workflow-owned child tasks. Only isolated execution ships in core. */
export type ChildTaskContextPolicy = 'isolated'

/** Lifecycle shape for a workflow-owned child task. */
export type ChildTaskMode = 'one_shot' | 'continuable'

/** Immutable, non-content task descriptor persisted with the task run. */
export interface ChildTaskDescriptor {
  readonly id: string
  readonly parentRunId: string
  readonly sessionId: string
  readonly workflowId: string
  readonly agentId: string
  readonly modelAlias: string
  readonly contextPolicy: ChildTaskContextPolicy
  readonly mode: ChildTaskMode
  readonly createdAt: string
}

/** Snapshot available to a task handle and session owner. */
export interface ChildTaskStatus {
  readonly descriptor: ChildTaskDescriptor
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly finishedAt?: string
  readonly error?: SerializedError
}

/** Opaque workflow-owned handle for a single child-agent task. */
export interface ChildTaskHandle<O> {
  readonly id: string
  /** Resolves with the child output or rejects with its original failure. */
  result(): Promise<O>
  /** Returns a content-free lifecycle snapshot. */
  status(): Promise<ChildTaskStatus>
  /** Idempotently requests cancellation and waits for terminal settlement. */
  cancel(reason?: string): Promise<void>
}

/**
 * A task whose isolated conversation and sandbox remain live between explicit
 * turns. Continuable tasks are in-process handles: they intentionally do not
 * claim cross-process recovery until a durable task-worker adapter exists.
 */
export interface ContinuableChildTaskHandle<I, O> extends ChildTaskHandle<O> {
  /** Queues one isolated follow-up turn after any active turn settles. */
  send(input: I): Promise<O>
  /** Ends the task successfully after its final queued turn has settled. */
  close(): Promise<O | undefined>
}

/** Start options for a workflow-owned child task. */
export type ChildTaskStartOptions<S extends BuilderState, K extends keyof NonNullable<S['agents']>> = {
  /** A stable caller-chosen idempotency key for a durable workflow step. */
  idempotencyKey?: string
  /** Per-task timeout. Defaults to the workflow run timeout policy. */
  timeoutMs?: number
  /** A configured, policy-allowed model alias override. */
  model?: keyof NonNullable<S['models']> & string
  /** Only isolated history is supported; raw parent-history inheritance is intentionally absent. */
  context?: ChildTaskContextPolicy
  /** Runs exactly one agent turn and then settles the task. */
  mode?: 'one_shot'
}

/** Start options for an in-process continuable child task. */
export type ContinuableChildTaskStartOptions<S extends BuilderState, K extends keyof NonNullable<S['agents']>> =
  Omit<ChildTaskStartOptions<S, K>, 'mode'> & {
    /** Keeps an isolated task-owned conversation and sandbox open for `send(...)` turns. */
    mode: 'continuable'
  }

/** Typed child-task API available only to a running workflow handler. */
export interface WorkflowChildTasks<S extends BuilderState> {
  start<K extends keyof NonNullable<S['agents']>>(
    agentId: K,
    input: AgentInput<S, K>,
    options: ContinuableChildTaskStartOptions<S, K>
  ): Promise<ContinuableChildTaskHandle<AgentInput<S, K>, AgentOutput<S, K>>>
  start<K extends keyof NonNullable<S['agents']>>(
    agentId: K,
    input: AgentInput<S, K>,
    options?: ChildTaskStartOptions<S, K>
  ): Promise<ChildTaskHandle<AgentOutput<S, K>>>
}

/** Invoke options accepted by workflow-local child-agent calls. */
export type WorkflowAgentInvokeOptions<S extends BuilderState, K extends keyof NonNullable<S['agents']>> =
  InvokeOptions & {
    /**
     * Optional model alias override for this child-agent call.
     * The alias must exist on the harness model registry and be allowed by the
     * workflow delegation policy.
     */
    model?: keyof NonNullable<S['models']> & string
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
  /**
   * Maximum model iterations for this default-loop agent. Falls back to
   * `defaults.agentMaxIterations`. Must be a positive integer; explicit values
   * are not otherwise capped.
   */
  maxSteps?: number
  /**
   * Optional hook for per-round loop control in the default agent loop.
   *
   * @example
   * ```ts
   * prepareStep: ({ step }) => step === 0 ? { activeTools: ['lookup'] } : {}
   * ```
   */
  prepareStep?: AgentPrepareStep<S, z.infer<I>>
  /**
   * Optional hook that can stop the default loop after a model call.
   *
   * @example
   * ```ts
   * stopWhen: ({ step }) => step >= 2
   * ```
   */
  stopWhen?: AgentStopWhen<S, z.infer<I>>
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
  delegation?: WorkflowDelegationPolicy<S>
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
  prepareStep?: AgentPrepareStep<S, z.infer<I>>
  stopWhen?: AgentStopWhen<S, z.infer<I>>
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
  delegation?: WorkflowDelegationPolicy<S>
  handler: (ctx: WorkflowContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>
}

/** Policy for workflow-local child-agent delegation through `ctx.agents`. */
export interface WorkflowDelegationPolicy<S extends BuilderState = BuilderState> {
  /** Enable or disable child-agent calls for this workflow. A policy object without this field enables delegation. */
  enabled?: boolean
  /** Child agent ids this workflow may call. Omit to allow all registered agents. */
  agents?: readonly (keyof NonNullable<S['agents']> & string)[]
  /** Per-run child-agent call limit. Overrides `defaults.delegation.maxChildAgentCalls`. */
  maxChildAgentCalls?: number
  /** Per-run active child-agent call limit. Overrides `defaults.delegation.maxParallelChildAgentCalls`. */
  maxParallelChildAgentCalls?: number
  /** Maximum local delegation depth. Overrides `defaults.delegation.maxDepth`. */
  maxDepth?: number
  /** Model aliases allowed for every child-agent call in this workflow, including calls running on the agent's default `model`. */
  modelAliases?: readonly (keyof NonNullable<S['models']> & string)[]
  /** Per-child-agent model alias allowlists. These replace `modelAliases` for the named agent. */
  agentModelAliases?: Partial<Record<keyof NonNullable<S['agents']> & string, readonly (keyof NonNullable<S['models']> & string)[]>>
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
  /** Session-owner access to child tasks created by this session's workflows. */
  readonly childTasks: SessionChildTasks
  memory: SessionMemory
  history: ConversationHistory
  getRunSummary(runId: string): Promise<RunSummary | undefined>
  clearHistory(): Promise<void>
  replaceHistory(messages: ReadonlyArray<Omit<Message, 'id' | 'timestamp'>>): Promise<void>
  close(): Promise<void>
}

/** Content-safe task lookup surface owned by a session, not by a workflow. */
export interface SessionChildTasks {
  /** Retrieves a task owned by this session, including a terminal persisted task after restart. */
  get(id: string): Promise<ChildTaskHandle<JsonValue> | undefined>
  /** Lists content-free task lifecycle snapshots for this session. */
  list(opts?: { limit?: number; before?: string }): Promise<readonly ChildTaskStatus[]>
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
  | { type: 'fanout.started'; runId: string; batchId: string; at: string; count: number; concurrency: number }
  | { type: 'fanout.finished'; runId: string; batchId: string; at: string; count: number; status: 'succeeded' | 'failed' | 'cancelled' }
  | { type: 'child_task.started'; runId: string; taskId: string; at: string; parentRunId: string; workflowId: string; agentId: string; modelAlias: string; contextPolicy: ChildTaskContextPolicy; mode: ChildTaskMode }
  | { type: 'child_task.settled'; runId: string; taskId: string; at: string; parentRunId: string; workflowId: string; agentId: string; status: 'succeeded' | 'failed' | 'cancelled'; error?: SerializedError }
  | { type: 'agent.started'; runId: string; agentId: string; at: string; workflowId?: string; parentAgentId?: string; delegationCallId?: string; delegationDepth?: number; modelAlias?: string }
  | { type: 'agent.finished'; runId: string; agentId: string; at: string; workflowId?: string; parentAgentId?: string; delegationCallId?: string; delegationDepth?: number; modelAlias?: string; output?: JsonValue; error?: SerializedError }
  | { type: 'model.delta'; runId: string; streamId: string; agentId?: string; workflowId?: string; modelAlias?: string; delta: string }
  | { type: 'policy.evaluated'; runId: string; agentId: string; toolId: string; callId: string; decisionId: string; policyId: string; policyVersion?: string; ruleId?: string; effect: GovernanceEffect; enforced: boolean; message?: string; reason?: string; riskLevel?: GovernanceRiskLevel; tags?: readonly string[] }
  | { type: 'policy.exposure'; runId: string; agentId: string; toolId: string; decisionId: string; policyId: string; policyVersion?: string; ruleId?: string; effect: GovernanceExposureEffect; enforced: boolean; step: number; message?: string; reason?: string; riskLevel?: GovernanceRiskLevel; tags?: readonly string[] }
  | { type: 'approval.requested'; runId: string; agentId: string; toolId: string; callId: string; approvalId: string; decisionId: string; policyId: string; policyVersion?: string; ruleId?: string }
  | { type: 'approval.finished'; runId: string; agentId: string; toolId: string; callId: string; approvalId: string; decisionId: string; policyId: string; policyVersion?: string; ruleId?: string; decision: 'approved' | 'rejected'; approverId?: string; reason?: string }
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
  /** Applies a local, static harness module to this builder. */
  use<Required extends BuilderState, Result extends BuilderState, Id extends string>(
    module: S extends Required ? HarnessModule<Required, Result, Id> : never
  ): HarnessBuilder<Result>
  telemetry(opts: TelemetryOptions): HarnessBuilder<S>
  logger(logger: Logger): HarnessBuilder<S>
  state(store: StateStore): HarnessBuilder<S>
  sandbox(sandbox?: Sandbox<any>): HarnessBuilder<S>
  memory(adapter: MemoryAdapter): HarnessBuilder<S>
  runtime(runtime: DurableRuntimeAdapter): HarnessBuilder<S>
  workspaceStore(store: DurableWorkspaceStore): HarnessBuilder<S>
  checkpoints(store: ContextCheckpointStore): HarnessBuilder<S>
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
  governance(config: GovernanceConfig<S> | ((helpers: GovernanceDefinitionHelpers<S>) => GovernanceConfig<S>)): HarnessBuilder<S>
  build(): Harness<S>
}

/** Builder surface exposed to a static harness module. It deliberately has no build or use method. */
export interface HarnessModuleBuilder<S extends BuilderState = {}> {
  models<const M extends ModelsConfig>(models: M): HarnessModuleBuilder<S & { models: M }>
  tools<const T extends ToolsConfig>(tools: T): HarnessModuleBuilder<S & { tools: T }>
  skills<const K extends SkillsConfig>(skills: K): HarnessModuleBuilder<S & { skills: K }>
  agents<const A extends { [K in keyof A]: AgentDefinition<any, any, any> }>(
    agents: (helpers: AgentDefinitionHelpers<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }>) => A
  ): HarnessModuleBuilder<S & { agents: A }>
  agents<const A extends { [K in keyof A]: { input: z.ZodTypeAny; output: z.ZodTypeAny } }>(agents: AgentsConfigFromSchemaMaps<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A>): HarnessModuleBuilder<S & { agents: AgentsConfigFromSchemaMaps<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A> }>
  agents<const A extends { [K in keyof A]: AgentDefinitionFor<S & { models: NonNullable<S['models']>; tools: NonNullable<S['tools']>; skills: NonNullable<S['skills']> }, A[K]> }>(agents: A): HarnessModuleBuilder<S & { agents: A }>
  workflows<const W extends { [K in keyof W]: WorkflowDefinition<any, any, any> }>(
    workflows: (helpers: WorkflowDefinitionHelpers<S & { agents: NonNullable<S['agents']> }>) => W
  ): HarnessModuleBuilder<S & { workflows: W }>
  workflows<const W extends { [K in keyof W]: { input: z.ZodTypeAny; output: z.ZodTypeAny } }>(workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W>): HarnessModuleBuilder<S & { workflows: WorkflowsConfigFromSchemaMaps<S & { agents: NonNullable<S['agents']> }, W> }>
  workflows<const W extends { [K in keyof W]: WorkflowDefinitionFor<S & { agents: NonNullable<S['agents']> }, W[K]> }>(workflows: W): HarnessModuleBuilder<S & { workflows: W }>
}

/** A local static transform that contributes definitions to one harness builder. */
export interface HarnessModule<Required extends BuilderState = BuilderState, Result extends BuilderState = BuilderState, Id extends string = string> {
  readonly id: Id
  readonly version?: string
  readonly requires?: readonly AdapterCapability[]
  readonly register: (builder: HarnessModuleBuilder<Required>) => HarnessModuleBuilder<Result>
}

/** Defines a local static harness module. It does not construct or load a harness. */
export function defineHarnessModule<Required extends BuilderState = {}>(): <const Id extends string, Result extends BuilderState>(
  id: Id,
  definition: Omit<HarnessModule<Required, Result, Id>, 'id'>
) => HarnessModule<Required, Result, Id> {
  return (id, definition) => Object.freeze({ id, ...definition })
}

type BuilderStateInternal = {
  telemetry?: TelemetryOptions
  logger?: Logger
  state?: StateStore
  sandbox?: Sandbox<any>
  memory?: MemoryAdapter
  runtime?: DurableRuntimeAdapter
  workspaceStore?: DurableWorkspaceStore
  checkpoints?: ContextCheckpointStore
  requiredCapabilities?: readonly AdapterCapability[]
  defaults?: HarnessDefaults
  models?: ModelsConfig
  tools?: ToolsConfig
  skills?: SkillsConfig
  agents?: Record<string, AgentDefinition<any, any, any>>
  workflows?: Record<string, WorkflowDefinition<any, any, any>>
  governance?: GovernanceConfig<any>
  modules?: readonly HarnessModuleInspection[]
  moduleRequirements?: readonly AdapterCapability[]
}

const moduleBuilderTargets = new WeakMap<object, Builder<any>>()

class Builder<S extends BuilderState> implements HarnessBuilder<S> {
  private readonly options: HarnessOptions
  private readonly configured: BuilderStateInternal
  private readonly activeModuleId: string | undefined

  public constructor(options: HarnessOptions, configured: BuilderStateInternal = {}, activeModuleId?: string) {
    this.options = options
    this.configured = configured
    this.activeModuleId = activeModuleId
  }

  public use<Required extends BuilderState, Result extends BuilderState, Id extends string>(
    module: S extends Required ? HarnessModule<Required, Result, Id> : never
  ): HarnessBuilder<Result> {
    this.validateModule(module)
    const existing = this.configured.modules ?? []
    if (existing.some((entry) => entry.id === module.id)) {
      throw new HarnessConfigError('Harness module id is already configured.', {
        reason: 'duplicate_module', path: 'modules', id: module.id, module_id: module.id
      })
    }

    const scoped = new Builder(this.options, this.configured, module.id)
    let output: HarnessModuleBuilder<Result>
    try {
      output = module.register(scoped.toModuleBuilder() as HarnessModuleBuilder<Required>)
    } catch (error) {
      throw error
    }
    const target = output && typeof output === 'object' ? moduleBuilderTargets.get(output as object) : undefined
    if (!target) {
      throw new HarnessConfigError('Harness module register must return its module builder.', {
        reason: 'invalid_module', path: `modules.${module.id}.register`, id: module.id, module_id: module.id
      })
    }
    const contributions = moduleContributions(this.configured, target.configured)
    if (contributions.length === 0) {
      throw new HarnessConfigError('Harness module must contribute at least one definition family.', {
        reason: 'invalid_module', path: `modules.${module.id}`, id: module.id, module_id: module.id
      })
    }
    const inspection: HarnessModuleInspection = Object.freeze({
      id: module.id,
      ...(module.version ? { version: module.version } : {}),
      requires: Object.freeze(uniqueCapabilities(module.requires ?? [])),
      contributions: Object.freeze(contributions.map((contribution) => Object.freeze({
        kind: contribution.kind,
        ids: Object.freeze([...contribution.ids])
      })))
    })
    return new Builder(this.options, {
      ...target.configured,
      modules: Object.freeze([...existing, inspection]),
      moduleRequirements: uniqueCapabilities([...(this.configured.moduleRequirements ?? []), ...(module.requires ?? [])])
    }) as unknown as HarnessBuilder<Result>
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

  public checkpoints(checkpoints: ContextCheckpointStore): HarnessBuilder<S> {
    if (this.configured.checkpoints) {
      throw new HarnessConfigError('Context checkpoint store is already configured.', { reason: 'duplicate_adapter', path: 'checkpoints' })
    }
    validateContextCheckpointStore(checkpoints)
    return this.clone({ checkpoints })
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
    if (defaults.agentMaxIterations !== undefined && (!Number.isInteger(defaults.agentMaxIterations) || defaults.agentMaxIterations < 1)) {
      throw new HarnessConfigError('agentMaxIterations must be a positive integer', { reason: 'invalid_defaults', path: 'defaults.agentMaxIterations' })
    }
    validateDelegationBudget(defaults.delegation?.maxChildAgentCalls, 'defaults.delegation.maxChildAgentCalls', { min: 0 })
    validateDelegationBudget(defaults.delegation?.maxParallelChildAgentCalls, 'defaults.delegation.maxParallelChildAgentCalls', { min: 1 })
    validateDelegationBudget(defaults.delegation?.maxDepth, 'defaults.delegation.maxDepth', { min: 0 })
    if (!validateContextProjection(defaults.contextProjection)) {
      throw new HarnessConfigError('contextProjection is invalid.', { reason: 'invalid_context_projection', path: 'defaults.contextProjection' })
    }
    return this.clone({ defaults })
  }

  public models<const M extends ModelsConfig>(models: M): HarnessBuilder<S & { models: M }> {
    if (Object.keys(models).length === 0) {
      throw new HarnessConfigError('At least one model alias is required.', { reason: 'missing_models', path: 'models' })
    }
    for (const [alias, config] of Object.entries(models)) {
      validateModelRetrySetting(config.retry, `models.${alias}.retry`)
      validateModelRetrySetting(config.defaults?.retry, `models.${alias}.defaults.retry`)
      if (!validateContextProjection(config.contextProjection)) {
        throw new HarnessConfigError('contextProjection is invalid.', { reason: 'invalid_context_projection', path: `models.${alias}.contextProjection`, id: alias })
      }
    }
    return this.clone({ models: this.mergeDefinitions('models', models) }) as unknown as HarnessBuilder<S & { models: M }>
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
    return this.clone({ tools: this.mergeDefinitions('tools', tools) }) as unknown as HarnessBuilder<S & { tools: T }>
  }

  public skills<const K extends SkillsConfig>(skills: K): HarnessBuilder<S & { skills: K }> {
    return this.clone({ skills: this.mergeDefinitions('skills', skills) }) as unknown as HarnessBuilder<S & { skills: K }>
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
    this.validateAgentStepBudgets(resolved)
    this.validateAgentSkillReferences(resolved)
    return this.clone({ agents: this.mergeDefinitions('agents', resolved) }) as unknown as HarnessBuilder<any>
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
    this.validateWorkflowDelegationPolicies(resolved)
    return this.clone({ workflows: this.mergeDefinitions('workflows', resolved) }) as unknown as HarnessBuilder<any>
  }

  public governance(config: GovernanceConfig<S> | ((helpers: GovernanceDefinitionHelpers<S>) => GovernanceConfig<S>)): HarnessBuilder<S> {
    if (this.configured.governance) {
      throw new HarnessConfigError('Governance is already configured.', { reason: 'duplicate_adapter', path: 'governance' })
    }
    const helpers: GovernanceDefinitionHelpers<S> = {
      rule: (definition) => definition,
      exposureRule: (definition) => definition,
      native: (definition) => ({ ...definition, kind: 'native' }),
      adapter: (definition) => definition
    }
    const resolved = typeof config === 'function' ? config(helpers) : config
    return this.clone({ governance: resolved })
  }

  public build(): Harness<S> {
    const models = this.configured.models
    if (!models || Object.keys(models).length === 0) {
      throw new HarnessConfigError('At least one model alias is required.', { reason: 'missing_models', path: 'models' })
    }
    this.validateToolSkillNamespace()
    // Validated at build time (not in `.agents(...)`) because models may be
    // declared later in the builder chain.
    this.validateAgentModelAndToolReferences(models)
    this.validateGovernancePolicies()
    const sandbox = this.configured.sandbox ?? autoDetectSandbox()
    const memory = this.configured.memory ?? sandboxMemory()
    validateMemoryAdapter(memory)
    if (this.configured.workspaceStore) validateDurableWorkspaceStore(this.configured.workspaceStore)
    if (this.configured.checkpoints) validateContextCheckpointStore(this.configured.checkpoints)
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
      ...(this.configured.checkpoints ? { checkpoints: this.configured.checkpoints } : {}),
      defaults: {
        agentMaxIterations: this.configured.defaults?.agentMaxIterations ?? 16,
        runTimeoutMs: this.configured.defaults?.runTimeoutMs ?? 600_000,
        toolTimeoutMs: this.configured.defaults?.toolTimeoutMs ?? 120_000,
        skillTimeoutMs: this.configured.defaults?.skillTimeoutMs ?? 60_000,
        modelTimeoutMs: this.configured.defaults?.modelTimeoutMs ?? 300_000,
        maxParallelToolCalls: this.configured.defaults?.maxParallelToolCalls ?? 8,
        ...(this.configured.defaults?.historyWindow !== undefined ? { historyWindow: this.configured.defaults.historyWindow } : {}),
        ...(this.configured.defaults?.contextProjection ? { contextProjection: this.configured.defaults.contextProjection } : {}),
        ...(this.configured.defaults?.delegation ? { delegation: this.configured.defaults.delegation } : {})
      },
      models,
      tools: (this.configured.tools ?? {}) as NonNullable<S['tools']>,
      skills: (this.configured.skills ?? {}) as NonNullable<S['skills']>,
      agents: (this.configured.agents ?? {}) as NonNullable<S['agents']>,
      workflows: (this.configured.workflows ?? {}) as NonNullable<S['workflows']>,
      ...(this.configured.governance ? { governance: this.configured.governance as GovernanceConfig<S> } : {}),
      inspection
    })

    return harness
  }

  private toModuleBuilder<T extends BuilderState = S>(target: Builder<T> = this as unknown as Builder<T>): HarnessModuleBuilder<T> {
    const builder = target
    const facade = {
      models: (models: ModelsConfig) => builder.toModuleBuilder(builder.models(models) as unknown as Builder<T & { models: ModelsConfig }>),
      tools: (tools: ToolsConfig) => builder.toModuleBuilder(builder.tools(tools) as unknown as Builder<T & { tools: ToolsConfig }>),
      skills: (skills: SkillsConfig) => builder.toModuleBuilder(builder.skills(skills) as unknown as Builder<T & { skills: SkillsConfig }>),
      agents: (agents: unknown) => builder.toModuleBuilder(builder.agents(agents as never) as unknown as Builder<T & { agents: Record<string, AgentDefinition<any, any, any>> }>),
      workflows: (workflows: unknown) => builder.toModuleBuilder(builder.workflows(workflows as never) as unknown as Builder<T & { workflows: Record<string, WorkflowDefinition<any, any, any>> }>)
    }
    moduleBuilderTargets.set(facade, builder)
    return facade as unknown as HarnessModuleBuilder<T>
  }

  private mergeDefinitions<K extends 'models' | 'tools' | 'skills' | 'agents' | 'workflows', V extends Record<string, unknown>>(
    family: K,
    incoming: V
  ): V {
    const current = (this.configured[family] ?? {}) as Record<string, unknown>
    for (const id of Object.keys(incoming)) {
      if (id in current) {
        throw new HarnessConfigError(`Definition id "${id}" is already configured in ${family}.`, {
          reason: 'duplicate_definition',
          path: `${family}.${id}`,
          id,
          ...(this.activeModuleId ? { module_id: this.activeModuleId } : {})
        })
      }
    }
    return { ...current, ...incoming } as V
  }

  private validateModule(module: unknown): void {
    const candidate = module as Partial<HarnessModule<any, any, string>> | undefined
    if (!candidate || typeof candidate !== 'object' || typeof candidate.id !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(candidate.id)) {
      throw new HarnessConfigError('Harness module id is invalid.', {
        reason: 'invalid_module', path: 'modules', ...(typeof candidate?.id === 'string' ? { id: candidate.id } : {})
      })
    }
    if (candidate.version !== undefined && (typeof candidate.version !== 'string' || candidate.version.length === 0 || candidate.version.length > 128 || /[^\x20-\x7E]/.test(candidate.version))) {
      throw new HarnessConfigError('Harness module version is invalid.', { reason: 'invalid_module', path: `modules.${candidate.id}.version`, id: candidate.id, module_id: candidate.id })
    }
    if (typeof candidate.register !== 'function') {
      throw new HarnessConfigError('Harness module register must be a function.', { reason: 'invalid_module', path: `modules.${candidate.id}.register`, id: candidate.id, module_id: candidate.id })
    }
    if (candidate.requires && !Array.isArray(candidate.requires)) {
      throw new HarnessConfigError('Harness module requires must be an array.', { reason: 'invalid_module', path: `modules.${candidate.id}.requires`, id: candidate.id, module_id: candidate.id })
    }
  }

  private clone(patch: Partial<BuilderStateInternal>): Builder<S> {
    return new Builder(this.options, { ...this.configured, ...patch }, this.activeModuleId)
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

  private validateAgentModelAndToolReferences(models: ModelsConfig): void {
    const configuredTools = new Set(Object.keys(this.configured.tools ?? {}))
    for (const [agentId, agent] of Object.entries(this.configured.agents ?? {})) {
      if (!(agent.model in models)) {
        throw new HarnessConfigError('Agent references an unknown model alias.', {
          reason: 'invalid_agent',
          path: `agents.${agentId}.model`,
          id: agent.model
        })
      }
      for (const toolId of agent.tools ?? []) {
        if (!configuredTools.has(toolId)) {
          throw new HarnessConfigError('Agent references an unknown tool.', {
            reason: 'invalid_agent',
            path: `agents.${agentId}.tools`,
            id: toolId
          })
        }
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

  private validateAgentStepBudgets(agents: Record<string, AgentDefinition<any, any, any>>): void {
    for (const [agentId, agent] of Object.entries(agents)) {
      if (agent.maxSteps !== undefined && (!Number.isInteger(agent.maxSteps) || agent.maxSteps < 1)) {
        throw new HarnessConfigError('agent.maxSteps must be a positive integer', {
          reason: 'invalid_agent',
          path: `agents.${agentId}.maxSteps`,
          id: agentId
        })
      }
    }
  }

  private validateWorkflowDelegationPolicies(workflows: Record<string, WorkflowDefinition<any, any, any>>): void {
    const configuredAgents = new Set(Object.keys(this.configured.agents ?? {}))
    const configuredModels = new Set(Object.keys(this.configured.models ?? {}))

    for (const [workflowId, workflow] of Object.entries(workflows)) {
      const policy = workflow.delegation
      if (!policy) continue

      validateDelegationBudget(policy.maxChildAgentCalls, `workflows.${workflowId}.delegation.maxChildAgentCalls`, { min: 0 })
      validateDelegationBudget(policy.maxParallelChildAgentCalls, `workflows.${workflowId}.delegation.maxParallelChildAgentCalls`, { min: 1 })
      validateDelegationBudget(policy.maxDepth, `workflows.${workflowId}.delegation.maxDepth`, { min: 0 })

      for (const agentId of policy.agents ?? []) {
        if (!configuredAgents.has(agentId)) {
          throw new HarnessConfigError('Workflow delegation policy references an unknown agent.', {
            reason: 'invalid_workflow',
            path: `workflows.${workflowId}.delegation.agents`,
            id: agentId
          })
        }
      }

      for (const alias of policy.modelAliases ?? []) {
        if (!configuredModels.has(alias)) {
          throw new HarnessConfigError('Workflow delegation policy references an unknown model alias.', {
            reason: 'invalid_workflow',
            path: `workflows.${workflowId}.delegation.modelAliases`,
            id: alias
          })
        }
      }

      for (const [agentId, aliases] of Object.entries(policy.agentModelAliases ?? {})) {
        if (!configuredAgents.has(agentId)) {
          throw new HarnessConfigError('Workflow delegation policy references an unknown agent.', {
            reason: 'invalid_workflow',
            path: `workflows.${workflowId}.delegation.agentModelAliases.${agentId}`,
            id: agentId
          })
        }
        for (const alias of aliases ?? []) {
          if (!configuredModels.has(alias)) {
            throw new HarnessConfigError('Workflow delegation policy references an unknown model alias.', {
              reason: 'invalid_workflow',
              path: `workflows.${workflowId}.delegation.agentModelAliases.${agentId}`,
              id: alias
            })
          }
        }
      }
    }
  }

  private validateGovernancePolicies(): void {
    const governance = this.configured.governance
    if (!governance || governance.enabled === false) return
    const policies = governance.policies ?? []
    const exposureRules = governance.exposure?.rules ?? []
    if (policies.length === 0 && exposureRules.length === 0) {
      throw new HarnessConfigError('Governance requires at least one execution policy or exposure rule.', { reason: 'invalid_governance', path: 'governance' })
    }

    const configuredTools = new Set<string>([...BUILTIN_TOOL_NAMES, ...Object.keys(this.configured.tools ?? {})])
    const policyIds = new Set<string>()
    for (const [policyIndex, policy] of policies.entries()) {
      if (!policy.id || typeof policy.id !== 'string') {
        throw new HarnessConfigError('Governance policy id is required.', { reason: 'invalid_governance', path: `governance.policies.${policyIndex}.id` })
      }
      if (policyIds.has(policy.id)) {
        throw new HarnessConfigError('Governance policy ids must be unique.', { reason: 'invalid_governance', path: `governance.policies.${policyIndex}.id`, id: policy.id })
      }
      policyIds.add(policy.id)

      if ('kind' in policy && policy.kind === 'native') {
        if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
          throw new HarnessConfigError('Native governance policies require at least one rule.', { reason: 'invalid_governance', path: `governance.policies.${policyIndex}.rules` })
        }
        const ruleIds = new Set<string>()
        for (const [ruleIndex, rule] of policy.rules.entries()) {
          if (!rule.id || typeof rule.id !== 'string') {
            throw new HarnessConfigError('Governance rule id is required.', { reason: 'invalid_governance', path: `governance.policies.${policyIndex}.rules.${ruleIndex}.id` })
          }
          if (ruleIds.has(rule.id)) {
            throw new HarnessConfigError('Governance rule ids must be unique within a policy.', { reason: 'invalid_governance', path: `governance.policies.${policyIndex}.rules.${ruleIndex}.id`, id: rule.id })
          }
          ruleIds.add(rule.id)
          for (const toolId of rule.tools ?? []) {
            if (!configuredTools.has(toolId)) {
              throw new HarnessConfigError('Governance policy references an unknown tool.', {
                reason: 'invalid_governance',
                path: `governance.policies.${policyIndex}.rules.${ruleIndex}.tools`,
                id: toolId
              })
            }
          }
        }
      } else if (typeof (policy as GovernancePolicyEvaluator<any>).evaluate !== 'function') {
        throw new HarnessConfigError('Governance adapter policies require an evaluate function.', { reason: 'invalid_governance', path: `governance.policies.${policyIndex}.evaluate`, id: policy.id })
      }
    }

    if (governance.exposure) {
      const exposure = governance.exposure
      if (exposure.defaultEffect !== undefined && exposure.defaultEffect !== 'expose' && exposure.defaultEffect !== 'hide') {
        throw new HarnessConfigError('Governance exposure defaultEffect must be "expose" or "hide".', { reason: 'invalid_governance', path: 'governance.exposure.defaultEffect' })
      }
      const exposureRuleIds = new Set<string>()
      for (const [ruleIndex, rule] of exposureRules.entries()) {
        if (!rule.id || typeof rule.id !== 'string') {
          throw new HarnessConfigError('Governance exposure rule id is required.', { reason: 'invalid_governance', path: `governance.exposure.rules.${ruleIndex}.id` })
        }
        if (exposureRuleIds.has(rule.id)) {
          throw new HarnessConfigError('Governance exposure rule ids must be unique.', { reason: 'invalid_governance', path: `governance.exposure.rules.${ruleIndex}.id`, id: rule.id })
        }
        exposureRuleIds.add(rule.id)
        for (const toolId of rule.tools ?? []) {
          if (!configuredTools.has(toolId)) {
            throw new HarnessConfigError('Governance exposure rule references an unknown tool.', {
              reason: 'invalid_governance',
              path: `governance.exposure.rules.${ruleIndex}.tools`,
              id: toolId
            })
          }
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

    if (this.configured.checkpoints) {
      adapters.push({
        kind: 'context_checkpoint',
        id: this.configured.checkpoints.info.id,
        capabilities: uniqueCapabilities(this.configured.checkpoints.info.capabilities),
        metadata: {
          packageName: this.configured.checkpoints.info.packageName
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
      requiredCapabilities: uniqueCapabilities([
        ...(this.configured.requiredCapabilities ?? []),
        ...(this.configured.moduleRequirements ?? [])
      ]),
      adapters: Object.freeze(adapters.map((adapter) => Object.freeze({
        ...adapter,
        capabilities: Object.freeze([...adapter.capabilities]),
        ...(adapter.metadata ? { metadata: Object.freeze({ ...adapter.metadata }) } : {})
      }))),
      modules: Object.freeze([...(this.configured.modules ?? [])])
    }
  }
}

function moduleContributions(before: BuilderStateInternal, after: BuilderStateInternal): Array<{ kind: 'model' | 'tool' | 'skill' | 'agent' | 'workflow'; ids: string[] }> {
  const families: ReadonlyArray<readonly ['models' | 'tools' | 'skills' | 'agents' | 'workflows', 'model' | 'tool' | 'skill' | 'agent' | 'workflow']> = [
    ['models', 'model'], ['tools', 'tool'], ['skills', 'skill'], ['agents', 'agent'], ['workflows', 'workflow']
  ]
  return families.flatMap(([family, kind]) => {
    const previous = new Set(Object.keys((before[family] ?? {}) as Record<string, unknown>))
    const ids = Object.keys((after[family] ?? {}) as Record<string, unknown>).filter((id) => !previous.has(id))
    return ids.length > 0 ? [{ kind, ids }] : []
  })
}

function getAdapterId(adapter: unknown, fallback: string): string {
  if (adapter && typeof adapter === 'object' && typeof (adapter as { id?: unknown }).id === 'string') {
    return (adapter as { id: string }).id
  }
  return fallback
}

function validateDelegationBudget(value: number | undefined, path: string, opts: { min: number }): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < opts.min) {
    throw new HarnessConfigError(`${path} must be an integer >= ${opts.min}`, {
      reason: 'invalid_defaults',
      path
    })
  }
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
 *       delegation: { agents: ['summarize'] },
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
