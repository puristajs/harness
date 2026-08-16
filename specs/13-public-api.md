# Public API

**Purpose.** Single source of truth for every symbol exported from the v1 package set. The published package set includes the core package plus independent provider addons:

- `@purista/harness` — harness, types, errors, in-memory adapters, local durable adapters, TS+MCP tools, built-in JSON logger, telemetry. Testing helpers ship under the subpath export `@purista/harness/testing`.
- `@purista/harness-openai` — OpenAI provider.
- `@purista/harness-anthropic` — Anthropic provider.
- `@purista/harness-bedrock` — Amazon Bedrock provider.
- `@purista/harness-azure-foundry` — Azure AI Foundry provider.
- `@purista/harness-memory-*` — optional external memory adapters. Core ships only `sandboxMemory()`.
- `@purista/harness-workspace-*` — optional external durable workspace stores. Core ships local durable adapters and test helpers.
- `@purista/harness-policy-*` — optional governance policy adapters. Core exports the policy port and native policy types, but OPA/AGT/Eve/Cedar engines live outside core.
- `@purista/harness-agent-plugins` — opt-in local Agent Plugins 1.0.0 client;
  it inspects reviewed portable packages and returns ordinary skill/tool
  bindings without evaluating plugin code.

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
// Static builder-transform helper — not a second construction path
export function defineHarnessModule<Required extends BuilderState = {}>(): <const Id extends string, Result extends BuilderState>(
  id: Id,
  definition: Omit<HarnessModule<Required, Result, Id>, 'id'>
) => HarnessModule<Required, Result, Id>

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

// Memory factory (default reference adapter)
export function sandboxMemory(): MemoryAdapter

// Local durable execution factories
export function localDurableExecution(options: LocalDurableExecutionOptions): LocalDurableExecution
export function sqliteStateStore(options: SqliteStateStoreOptions): StateStore & { close(): Promise<void> }
export function sqliteDurableRuntime(options: SqliteDurableRuntimeOptions): DurableRuntime & { close(): Promise<void> }
export function localDirectoryWorkspaceStore(options: LocalDirectoryWorkspaceStoreOptions): DurableWorkspaceStore
export function localDirectorySandbox(options: LocalDirectorySandboxOptions): Sandbox
export function sqliteContextCheckpointStore(options: SqliteContextCheckpointStoreOptions): ContextCheckpointStore & { close(): Promise<void> }
export class SqliteHarnessStorage    // shared SQLite backend behind the sqlite* factories

// Durable runtime (in-memory reference + durable workflow context)
export function inMemoryDurableRuntime(options?: InMemoryDurableRuntimeOptions): DurableRuntime
export function createDurableWorkflowContext(options: DurableWorkflowContextOptions): DurableWorkflowContext
export function isTerminalRunStatus(status: DurableRunStatus): boolean
export function isResumeBlockingRunStatus(status: DurableRunStatus): boolean
export class DurableStepError extends Error {}
export class DurableRunLeaseError extends Error {}
export class DurableTerminalRunError extends Error {}

// Durable workspace in-memory reference store (also re-exported from /testing)
export class InMemoryDurableWorkspaceStore implements DurableWorkspaceStore
export function inMemoryDurableWorkspaceStore(): DurableWorkspaceStore

// Shared model-adapter helpers (consumed by first-party provider packages)
export function toTokenUsage(inputTokens?: number, outputTokens?: number, totalTokens?: number, details?: TokenUsageDetails): TokenUsage
export function redactProviderContent(body: unknown): unknown
export function malformedResponseError(ctx: AdapterCallContext, message: string, body: unknown, cause: unknown): ModelError
export function parseProviderJson(content: string, ctx: AdapterCallContext, message: string): JsonValue
export function safePartialJson(content: string): JsonValue
export function withoutObjectTool(calls: ToolCallSpec[] | undefined): ToolCallSpec[] | undefined
export function createStreamToolCallState(): StreamToolCallState
export function accumulateStreamToolCallDeltas(state: StreamToolCallState, deltas: unknown[]): void
export function finalizeStreamToolCalls(state: StreamToolCallState, ctx: AdapterCallContext, malformedMessage: string): ToolCallSpec[]
export function sanitizeProviderMessage(message: string): string

// Errors (every class from 15-error-catalog)
export class HarnessError extends Error { /* see 03-foundation */ }
export class HarnessConfigError extends HarnessError {}
export class ValidationError extends HarnessError {}
export class PermissionDeniedError extends HarnessError {}
export class PolicyDeniedError extends HarnessError {}
export class PolicyEvaluationError extends HarnessError {}
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
export class DelegationPolicyError extends HarnessError {}
export class WorkflowNotFoundError extends HarnessError {}
export class SessionNotFoundError extends HarnessError {}
export class SessionBusyError extends HarnessError {}
export class StateError extends HarnessError {}
export class WorkspaceError extends HarnessError {}
export class WorkspaceQuotaExceededError extends HarnessError {}
export class WorkspaceCleanupError extends HarnessError {}
export class OperationTimeoutError extends HarnessError {}
export class OperationCancelledError extends HarnessError {}
export class McpProtocolError extends HarnessError {}
export class McpAuthError extends HarnessError {}
export class InternalError extends HarnessError {}

// Utilities
export function ulid(): string                                 // monotonic ULID
export function isHarnessError(value: unknown): value is HarnessError
export function serializeError(error: unknown): SerializedError
export const HARNESS_VERSION: string                            // semver of the package
```

`JsonLogger` defaults: `level` is read from env `PURISTA_HARNESS_LOG_LEVEL` if set (invalid values fall back to `'info'` and emit one warning), else `'info'`; `out = process.stdout`; `bindings = {}`.

**Removed in v1:** standalone `defineAgent`, `defineWorkflow`, `defineTool`, `defineSkill`, `defineModel` factories are NOT exported. Inline builder definitions and static `defineHarnessModule` transforms preserve surrounding builder constraints; a module is not an independently buildable definition catalog. See [25-static-harness-modules](./25-static-harness-modules.md).

### Exports — types (main entry)

```ts
// Builder
export interface HarnessOptions
export interface HarnessBuilder<S>
export type HarnessModuleBuilder<S>
export interface HarnessModule<Required, Result, Id>
export type BuilderState

// Harness + handle types
export interface Harness<S>
export interface Session<S>
export interface AgentInvoker<S, K>
export interface WorkflowInvoker<S, K>
export type AgentInput<S, K>
export type AgentOutput<S, K>
export type WorkflowInput<S, K>
export type WorkflowOutput<S, K>
export interface InvokeOptions
export interface DurableInvokeOptions

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
export type SkillValidationMode
export interface SkillFrontmatter
export interface SkillDiagnostic
export interface DiscoverSkillsOptions
export interface DiscoveredSkills
export function discoverSkills(options?: DiscoverSkillsOptions): Promise<DiscoveredSkills>
export type AgentsConfig<S>
export interface AgentDefinition<S, I, O>
export interface AgentDefinitionHelpers<S>
export interface AgentPrepareStepContext<S, I>
export interface AgentPrepareStepResult<S>
export interface AgentStopWhenContext<S, I>
export type AgentPrepareStep<S, I>
export type AgentStopWhen<S, I>
export type WorkflowsConfig<S>
export interface WorkflowDefinition<S, I, O>
export interface WorkflowDefinitionHelpers<S>
export interface WorkflowDelegationPolicy<S>
export type WorkflowAgentInvokeOptions<S, K>
export interface WorkflowFanOutOptions
export interface WorkflowChildTasks<S>
export type ChildTaskContextPolicy
export type ChildTaskMode
export interface ChildTaskDescriptor
export interface ChildTaskStatus
export interface ChildTaskHandle<O>
export interface ContinuableChildTaskHandle<I, O>
export type ChildTaskStartOptions<S, K>
export type ContinuableChildTaskStartOptions<S, K>

// Optional governance
export interface GovernanceConfig<S>
export type GovernanceMode
export type GovernanceEffect
export type GovernanceExposureEffect
export type GovernanceRiskLevel
export type GovernanceToolId<S>
export interface GovernanceContext<S, K>
export interface GovernanceDecision
export interface GovernancePolicyEvaluator<S>
export interface GovernanceToolExposureContext<S, K>
export interface GovernanceToolExposurePolicy<S>
export type GovernanceToolExposureRule<S>
export interface GovernanceToolExposureRuleForTool<S, K>
export interface NativePolicyDefinition<S>
export type NativePolicyRule<S>
export interface NativePolicyRuleForTool<S, K>
export type GovernancePolicyDefinition<S>
export interface GovernanceDefinitionHelpers<S>
export interface GovernanceApprovalProvider
export interface GovernanceApprovalRequest
export type GovernanceApprovalResult
export interface GovernanceAuditContext
export interface GovernanceAuditSink
export type ToolInput<S, K>

// Defaults
export interface HarnessDefaults
export interface DelegationDefaults
export interface ContextProjectionPolicy

// Inside-handler context types
export interface AgentContext<S, I, O>
export interface AgentContextMinimal<S, I>
export interface WorkflowContext<S, I, O>
export interface ToolHandlerContext
export interface Metrics
export type SpanAttrs
export interface TelemetryShim
export interface SessionMemory
export interface MemoryFacade
export interface ContextCheckpoints
export interface ConversationHistory
export interface SessionChildTasks

// Built-in tools and permissions
export type BuiltinToolName
export type PermissionMode
export interface PermissionPolicy
export interface AgentPermissions
export interface PermissionContext
export type PermissionDecision
export type OnPermission

// Governance policy
export interface GovernanceConfig<S>
export interface GovernanceDefinitionHelpers<S>
export type GovernanceMode
export type GovernanceEffect
export interface PolicyEvaluator<S>
export interface PolicyEvaluatorInfo
export type PolicyCapability
export interface PolicyDecision
export interface PolicyEvaluationContext<S>
export type GovernanceToolId<S>
export interface NativePolicy<S>
export interface NativePolicyConfig<S>
export interface NativePolicyRule<S, T>
export interface NativeRuleContext<S, T>
export interface GovernanceApprovalAdapter
export interface GovernanceApprovalRequest
export type GovernanceApprovalDecision
export interface GovernanceAuditSink
export interface GovernanceAuditRecord

// Resolved skill (after frontmatter parse)
export interface ResolvedSkill

// Models
export interface ModelDefaults
export type ModelRetrySetting
export interface ModelRetryPolicy
export interface ModelRetryOnPolicy
export type ModelRetryKind
export interface ModelOutcome
export interface ModelRateLimitInfo
// Invalid model retry policy values throw HarnessConfigError before provider execution.
export interface ModelProvider
export abstract class BaseModelProvider
export interface BaseModelProviderOptions
export interface HarnessAdapterContext
export interface HarnessContextConfigurable
export type ModelCapability
export type ModelHandles
export type ModelHandle
export interface ModelInvokeContext
export interface AdapterCallContext
export type StreamToolCallState
export interface ModelProviderInfo
export interface ModelFeatureSet
export type ContentPartKind
export type OutputMode
export interface BaseRequest
export interface ModelCallOptions
export type ModelMessage
export type ContentPart
export interface ToolCallSpec
export interface ProviderItems
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
export interface TokenUsageDetails
export type FinishReason

// Memory
export interface MemoryAdapter
export interface MemoryAdapterInfo
export interface MemoryOpenContext
export interface MemoryStore
export interface MemoryOperationContext
export interface MemoryScope
export type MemoryScopeKind
export type MemoryOperation
export type MemoryCapability
export interface MemoryWriteOptions
export interface MemoryListOptions
export interface MemoryEntry
export interface MemorySearchQuery
export interface MemorySearchResult

// Durable workspace replay
export interface DurableWorkspaceStore
export interface DurableWorkspaceStoreInfo
export interface DurableWorkspacePolicy
export type WorkspaceLifecycleState
export interface WorkspaceStartOptions
export interface WorkspaceHandle
export interface WorkspacePauseOptions
export interface WorkspaceCheckpoint
export interface WorkspaceResumeOptions
export interface WorkspaceAbortOptions
export interface WorkspaceAbortResult
export interface WorkspaceCleanupOptions
export interface WorkspaceCleanupResult
export interface WorkspaceInspectionOptions
export interface WorkspaceInspection
export interface WorkspaceQuotaPolicy
export interface WorkspaceRetentionPolicy
export interface WorkspaceEncryptionInfo
export interface DurableReplayCheckpoint
export interface LocalDurableExecutionOptions
export interface LocalHostExecPolicy
export interface LocalDurableExecution
export type LocalDurableSandbox
export type LocalFilesOnlySandboxCapabilities
export type LocalExecSandboxCapabilities
export interface SqliteDurableRuntimeOptions
export interface SqliteStateStoreOptions
export interface LocalDirectoryWorkspaceStoreOptions
export interface LocalDirectorySandboxOptions
export interface ContextCheckpointStore
export interface ContextCheckpointStoreInfo
export interface ContextCheckpoint
export interface ContextCheckpointQuery
export interface ContextCheckpointRef
export interface SqliteContextCheckpointStoreOptions

// Durable runtime
export interface DurableRuntime
export interface DurableRunLease
export interface DurableRunStart
export type DurableRunStatus
export type DurableActiveRunStatus
export type DurableTerminalRunStatus
export interface RunCheckpoint
export interface DurableStepCommit
export interface DurableStepOptions
export interface DurableStepRetryPolicy
export type DurableStepRetrySetting
export interface DurableWorkflowContext
export interface DurableWorkflowContextOptions
export interface InMemoryDurableRuntimeOptions

// Feedback
export interface FeedbackRecord
export type FeedbackTarget

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
export interface HarnessModuleInspection
export interface HarnessModuleContribution
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
export interface SpawnOptions
export interface SandboxProcess
export interface SpawnCapableSandboxSession
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
export interface PreparedMcpStdioLaunch
export interface McpStdioLaunchPreparation

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
  /** Apply a local static transform; unavailable to module callbacks. */
  use<Required extends BuilderState, Result extends BuilderState, Id extends string>(
    this: S extends Required ? HarnessBuilder<S> : never,
    module: HarnessModule<Required, Result, Id>
  ): HarnessBuilder<Result>
  // Foundation — optional, called at most once each
  telemetry(opts: TelemetryOptions): HarnessBuilder<S>
  logger(logger: Logger): HarnessBuilder<S>
  state(store: StateStore): HarnessBuilder<S>
  sandbox(sandbox: Sandbox): HarnessBuilder<S>
  memory(adapter: MemoryAdapter): HarnessBuilder<S>
  runtime(runtime: DurableRuntimeAdapter): HarnessBuilder<S>
  workspaceStore(adapter: DurableWorkspaceStore): HarnessBuilder<S>
  checkpoints(adapter: ContextCheckpointStore): HarnessBuilder<S>
  requires(required: readonly AdapterCapability[]): HarnessBuilder<S>
  defaults(d: HarnessDefaults): HarnessBuilder<S>

  // Domain — direct calls follow staged ordering. Module contributions append
  // in caller order and reject duplicate keys; see 25-static-harness-modules.
  models<const M extends ModelsConfig>(models: M): HarnessBuilder<S & { models: M }>
  tools<const T extends ToolsConfig>(tools: T): HarnessBuilder<S & { tools: T }>
  skills<const K extends SkillsConfig>(skills: K): HarnessBuilder<S & { skills: K }>
  agents<const A extends AgentsConfig<S & { models: any; tools: any; skills: any }>>(
    agents: A
  ): HarnessBuilder<S & { agents: A }>
  workflows<const W extends WorkflowsConfig<S & { agents: any }>>(
    workflows: W
  ): HarnessBuilder<S & { workflows: W }>
  governance(
    config: GovernanceConfig<S> | ((helpers: GovernanceDefinitionHelpers<S>) => GovernanceConfig<S>)
  ): HarnessBuilder<S & { governance: GovernanceConfig<S> }>

  build(): Harness<S>
}
```

`HarnessModuleBuilder<S>` is `HarnessBuilder<S>` without `build` and `use`.
`HarnessModule<Required, Result, Id>.register` receives the declared minimum
state and returns its inferred result. `.use()` is callable only when the
accumulated state extends `Required`, and returns `HarnessBuilder<Result>`.
The shipped declaration must preserve literal model/tool/skill/agent keys
without public `any`/`unknown` escape hatches. Direct
builder types omit already-set or out-of-order methods so incorrect direct
chains fail at the type level. At runtime, `.build()` fails with
`HarnessConfigError{reason:'missing_models'}` when no accumulated module/direct
contribution supplied models. Behavioral ordering rules and validation are
described in [02-harness-config](./02-harness-config.md).

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
  readonly childTasks: SessionChildTasks
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
  governance: S extends { governance: infer G } ? G : undefined
}
```

### Skill API

```ts
type SkillValidationMode = 'strict' | 'lenient'

interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  'allowed-tools'?: string
}

interface SkillDefinition {
  directory: string
  validationMode?: SkillValidationMode
  trust?: 'trusted' | 'project' | 'user'
  source?: string
}

type SkillsConfig = Record<string, SkillDefinition>

interface SkillDiagnostic {
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

interface ResolvedSkill {
  name: string
  description: string
  directory: string
  skillPath: string
  location: string
  mountPath: `/skills/${string}`
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string
  trust: 'trusted' | 'project' | 'user'
  source?: string
  diagnostics: readonly SkillDiagnostic[]
}

interface DiscoverSkillsOptions {
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

interface DiscoveredSkills {
  skills: SkillsConfig
  diagnostics: readonly SkillDiagnostic[]
}

function discoverSkills(options?: DiscoverSkillsOptions): Promise<DiscoveredSkills>
```

### Memory API

```ts
interface SessionMemory {
  read<T = JsonValue>(key: string): Promise<T | undefined>
  write(key: string, value: JsonValue, opts?: MemoryWriteOptions): Promise<void>
  delete(key: string): Promise<void>
  list(opts?: MemoryListOptions): Promise<string[]>
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>
}

interface MemoryFacade {
  session: SessionMemory
  run: SessionMemory
  agent?: SessionMemory
  user(userId?: string): SessionMemory
  tenant(tenantId?: string): SessionMemory
  scope(scope: MemoryScope): SessionMemory
}

interface MemoryAdapter extends HarnessContextConfigurable, AdapterCapabilities {
  readonly info: MemoryAdapterInfo
  readonly capabilities: readonly MemoryCapability[]
  open(scope: MemoryScope, ctx: MemoryOpenContext): Promise<MemoryStore>
  close?(): Promise<void>
}

interface MemoryStore {
  get<T = JsonValue>(key: string, ctx: MemoryOperationContext): Promise<T | undefined>
  set(key: string, value: JsonValue, ctx: MemoryOperationContext & { opts?: MemoryWriteOptions }): Promise<void>
  delete(key: string, ctx: MemoryOperationContext): Promise<void>
  list(ctx: MemoryOperationContext & { opts?: MemoryListOptions }): Promise<MemoryEntry[]>
  search?(query: MemorySearchQuery, ctx: MemoryOperationContext): Promise<MemorySearchResult[]>
}
```

Full memory scope, capability, validation, telemetry, metrics, and reference adapter semantics are locked in [20-memory-adapters](./20-memory-adapters.md).

### Adapter capabilities

```ts
type AdapterCapability =
  | 'sandbox.fs'
  | 'sandbox.exec'
  | 'sandbox.persistent_fs'
  | 'sandbox.snapshot'
  | 'sandbox.resume'
  | 'sandbox.hibernate'
  | 'runtime.checkpoint'
  | 'runtime.retry'
  | 'runtime.distributed_lock'
  | 'runtime.resume_from_checkpoint'
  | 'runtime.workspace_checkpoint'
  | 'runtime.checkpoint_retention'
  | 'runtime.persistent'
  | 'workspace_store.durable'
  | 'workspace_store.persistent'
  | 'workspace_store.checkpoint'
  | 'workspace_store.resume'
  | 'workspace_store.abort'
  | 'workspace_store.cleanup'
  | 'workspace_store.inspect'
  | 'workspace_store.retention'
  | 'workspace_store.quota'
  | 'workspace_store.encrypted_storage'
  | 'context_checkpoint.write'
  | 'context_checkpoint.read'
  | 'context_checkpoint.list'
  | 'context_checkpoint.delete'
  | 'context_checkpoint.persistent'
  | 'feedback.record'
  | MemoryCapability

interface AdapterInspection {
  kind: 'state' | 'sandbox' | 'runtime' | 'workspace_store' | 'context_checkpoint' | 'feedback' | 'model' | 'memory'
  id: string
  capabilities: readonly AdapterCapability[]
}

interface HarnessModuleContribution {
  kind: 'model' | 'tool' | 'skill' | 'agent' | 'workflow' | 'foundation'
  ids: readonly string[]
}

interface HarnessModuleInspection {
  id: string
  version?: string
  requires: readonly AdapterCapability[]
  contributions: readonly HarnessModuleContribution[]
}

interface HarnessInspection {
  name: string
  capabilities: readonly AdapterCapability[]
  requiredCapabilities: readonly AdapterCapability[]
  adapters: readonly AdapterInspection[]
  modules: readonly HarnessModuleInspection[]
}
```

### Adapter context

```ts
interface HarnessAdapterContext {
  harnessName: string
  logger: Logger
  telemetry: TelemetryShim
  metrics: Metrics
  contentCaptureMode: ContentCaptureMode
  defaults: {
    agentMaxIterations: number
    runTimeoutMs: number
    toolTimeoutMs: number
    skillTimeoutMs: number
    modelTimeoutMs: number
    maxParallelToolCalls: number
    historyWindow?: number
  }
}

interface HarnessContextConfigurable {
  configureHarnessContext(context: HarnessAdapterContext): void
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
}
```

Tracer + meter names are locked to `'@purista/harness'` (no `tracerName`/`meterName` knobs).

### `InvokeOptions`

```ts
interface InvokeOptions {
  signal?: AbortSignal
  timeoutMs?: number
  historyWindow?: number
  contextProjection?: ContextProjectionPolicy
  traceparent?: string
  tracestate?: string
  metadata?: Record<string, JsonValue>
  durable?: DurableInvokeOptions
}

interface DurableInvokeOptions {
  runId: string
  workerId?: string
  stepId?: string
  attempt?: number
}
```

`durable` opts a workflow run into durable execution against the configured
`.runtime(...)` / `.workspaceStore(...)`; see
[21-durable-workspaces](./21-durable-workspaces.md) §16.1 and
[11-sessions](./11-sessions.md).

`traceparent`/`tracestate` follow W3C Trace Context and are propagated into the
run span before child workflow, agent, model, tool, sandbox, and state spans are
created. `metadata` is available to handlers and emitted only as sanitized
scalar string, number, and boolean `harness.metadata.*` attributes as specified in
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

`RunSummary.tokenTotals` includes the optional `TokenUsage` detail fields when
one or more completed model events reported them.

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
5. **Static cross-file composition:** `defineHarnessModule` receives the actual accumulated builder state through its generic `register` callback. A later module can therefore retain cross-key checks for earlier module contributions. Imported plain objects without a static module transform still lose that guarantee. Standalone definers remain intentionally absent.

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
export class FakeStateStore extends InMemoryStateStore       // records invoked operations (`ops`, `opCount`, `resetOps`)
export class FakeSandbox implements Sandbox                  // deterministic FS+exec; configurable executor flag
export class FakeLogger implements Logger                    // captures log records in memory (`records`)
export class FakeMemoryAdapter implements MemoryAdapter      // deterministic KV/search fake
export class InMemoryDurableWorkspaceStore implements DurableWorkspaceStore   // also a main-entry export
export function inMemoryDurableWorkspaceStore(): DurableWorkspaceStore        // also a main-entry export
export function fakeCapabilityAdapter(
  capabilities: readonly AdapterCapability[],
  opts?: { id?: string }
): FakeCapabilityAdapter
export function fakeSnapshotSandbox(): Sandbox               // snapshot/resume/hibernate-capable in-memory sandbox
export type FakeStateStoreOp
export interface FakeSandboxOptions
export interface FakeLogRecord
export interface FakeCapabilityAdapter

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
export function memoryAdapterContract(
  make: () => MemoryAdapter | Promise<MemoryAdapter>,
  opts?: { search?: 'available' | 'unavailable'; persistence?: 'ephemeral' | 'persistent' }
): void
export function durableWorkspaceStoreContract(
  make: () => DurableWorkspaceStore | Promise<DurableWorkspaceStore>,
): void
export function adapterCapabilitiesContract(make: () => AdapterCapabilities | Promise<AdapterCapabilities>): void
export function sandboxSnapshotContract(make: () => Sandbox | Promise<Sandbox>): void

// Helpers
export function makeHarness(): HarnessBuilder<{}>            // alias for defineHarness() returning a fresh builder
export function recordEvents(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]>
export function createInMemoryFeedbackRecorder(): { record(...): FeedbackRecord; list(target?: FeedbackTarget): readonly FeedbackRecord[]; clear(): void }

// Sanitized model interaction fixtures
export interface SanitizedReplayFixture
export interface ReplayInteractionRecorder
export interface ReplayModelProviderOptions
export class ReplayFixtureError extends Error {}
export function createReplayInteractionRecorder(options: { sanitize: (value: unknown) => unknown }): ReplayInteractionRecorder
export function replayModelProvider(fixture: SanitizedReplayFixture, options?: ReplayModelProviderOptions): ModelProvider
export function assertReplayConsumed(provider: ModelProvider): void

// Development-only diagnostics
export interface HarnessDiagnosticInvariant
export interface HarnessDiagnosticFinding
export interface DiagnosticInvariantSnapshot
export class DiagnosticInvariantError extends Error {}
export function assertDiagnosticInvariants(
  snapshot: DiagnosticInvariantSnapshot,
  invariants: readonly HarnessDiagnosticInvariant[]
): void

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

### Testing replay and diagnostic contracts

```ts
interface SanitizedReplayRequest {
  fingerprint: string
  providerId: string
  model: string
  value: JsonValue
}

interface SanitizedReplayInteraction {
  method: 'text' | 'object' | 'textStream' | 'objectStream'
  request: SanitizedReplayRequest
  chunks?: readonly JsonValue[]
  outcome: JsonValue
}

interface SanitizedReplayFixture {
  version: 1
  id: string
  interactions: readonly SanitizedReplayInteraction[]
}

interface ReplayInteractionRecorder {
  wrap(provider: ModelProvider): ModelProvider
  fixture(id: string): SanitizedReplayFixture
}

interface ReplayModelProviderOptions {
  id?: string
  genAiSystem?: string
  capabilities?: readonly ModelCapability[]
}

interface HarnessDiagnosticFinding {
  path: string
  message: string
}

interface DiagnosticInvariantSnapshot {
  inspection: HarnessInspection
  events?: readonly {
    ordinal: number
    type: string
    runId?: string
    agentId?: string
    toolId?: string
    callId?: string
    attempt?: number
  }[]
}

interface HarnessDiagnosticInvariant {
  id: string
  check(snapshot: DiagnosticInvariantSnapshot): HarnessDiagnosticFinding | undefined
}
```

`ReplayFixtureError` has `code: 'REPLAY_FIXTURE_ERROR'` and metadata limited to
fixture id, ordinal, sanitized method/provider/model labels, and reason
`'invalid_fixture'|'mismatch'|'exhausted'|'unused'|'unsupported_method'`.
`DiagnosticInvariantError` has `code: 'DIAGNOSTIC_INVARIANT_ERROR'` and metadata
limited to invariant id and finding path. Both are testing-subpath errors and
never appear in a production harness run unless a caller explicitly invokes the
testing helper.

The fake adapters and contract suites are only reachable via
`@purista/harness/testing`, with two deliberate overlaps:
`evaluateDeterministicScorer` (plus its deterministic scorer types) and
`InMemoryDurableWorkspaceStore`/`inMemoryDurableWorkspaceStore` are main-entry
exports re-exported by the testing subpath for ergonomics.
Implementation agents must add a CI test that verifies the actual exports of
each entry against the lists above
(`packages/harness/test/public-api.test.ts`).

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

## `@purista/harness-agent-plugins` package

### `package.json` exports map (locked)

```json
{
  "name": "@purista/harness-agent-plugins",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  }
}
```

### Exports — values

```ts
export function inspectAgentPlugin(source: AgentPluginSource): Promise<AgentPluginInspection>
export function loadAgentPlugins(options: AgentPluginLoadOptions): Promise<readonly LoadedAgentPlugin[]>
export class AgentPluginError extends Error {}
export class AgentPluginManifestError extends AgentPluginError {}
export class AgentPluginTrustError extends AgentPluginError {}
export class AgentPluginLoadError extends AgentPluginError {}
```

### Exports — types

```ts
export type AgentPluginTrust
export type AgentPluginTransport
export interface AgentPluginSource
export interface AgentPluginLoadOptions
export interface AgentPluginToolBinding
export interface AgentPluginDiagnostic
export interface AgentPluginProvenance
export interface AgentPluginInspection
export interface AgentPluginBindings
export interface LoadedAgentPlugin
```

`loadAgentPlugins()` loads application-approved local roots only. The returned
`LoadedAgentPlugin.bindings()` factory creates ordinary `SkillsConfig` and
`ToolsConfig` entries, so applications retain literal alias inference and agent
allowlists. The package supports `stdio` and current Streamable HTTP; legacy
HTTP+SSE and legacy MCP protocol behavior are intentionally unsupported in this
breaking major release. See [29-agent-plugins](./29-agent-plugins.md).

## Package surface summary

`session.agents[k]` and `session.workflows[k]` lookups are typed; `harness.$infer` exposes the namespaces. The public surface does NOT impose magic mapped types beyond those listed above.

Every export listed above must be re-exported from the appropriate entry point:

- `packages/harness/src/index.ts` → main entry list.
- `packages/harness/src/testing/index.ts` → testing subpath list.
- `packages/harness-openai/src/index.ts` and sibling provider addon entries → provider package lists.
- `packages/harness-agent-plugins/src/index.ts` → Agent Plugins addon list.

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
