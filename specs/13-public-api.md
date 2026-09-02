# Public API

> **Approved schema update (2026-08-28):** [39-standard-schema-boundaries](./39-standard-schema-boundaries/00-vision.md) supersedes schema typing, validation, model projection, error, provider, and cleanup rules in this document. [38-guardrail-authoring](./38-guardrail-authoring/00-vision.md) remains authoritative for other authoring exports.

**Purpose.** Single source of truth for every symbol exported from the v3 package set. The published package set includes the core package plus independent provider addons:

- `@purista/harness` — harness, types, errors, in-memory adapters, local durable adapters, TS+MCP tools, built-in JSON logger, telemetry. Testing helpers ship under the subpath export `@purista/harness/testing`.
- `@purista/harness-openai` — OpenAI provider.
- `@purista/harness-google` — Google Gemini API provider.
- `@purista/harness-anthropic` — Anthropic provider.
- `@purista/harness-bedrock` — Amazon Bedrock provider.
- `@purista/harness-guardrails` — optional NeMo-shaped typed input/output/tool/retrieval rails and provider-neutral sensitive-data detector port.
- `@purista/harness-guardrails-presidio` — optional original Presidio Analyzer REST adapter.
- `@purista/harness-guardrails-native-privacy` — optional Rust/Node-API local recognizer subset for Node.js and Bun.
- `@purista/harness-azure-foundry` — Azure AI Foundry provider.
- `@purista/harness-memory-*` — optional external memory adapters. Core ships only `sandboxMemory()`.
- `@purista/harness-workspace-*` — optional external durable workspaces. Core ships local durable adapters and test helpers.
- `@purista/harness-policy-opa` — optional typed Open Policy Agent Data API governance adapter and `./testing` fake. Core exports the provider-neutral policy port; Cedar, AGT/Eve, and other engines remain application-owned.
- `@purista/harness-storage-postgres` — distributed PostgreSQL implementation of the complete HarnessStorage port.
- `@purista/harness-sandbox-kubernetes` — self-hosted Kubernetes Sandbox and optional PVC/VolumeSnapshot DurableWorkspace runtime.
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
// Opaque direct-binding key implemented by optional Guardrails packages
export const agentGuardrailsBinding: unique symbol

// Default adapters (in-memory)
export class JsonLogger implements Logger {
  constructor(opts?: {
    level?: LogLevel
    out?: NodeJS.WritableStream
    bindings?: Record<string, unknown>
  })
}
export class InMemoryHarnessStorage implements HarnessStorage { constructor() }
export function inMemoryHarnessStorage(): InMemoryHarnessStorage

// Sandbox factories (default adapters)
export function inMemorySandbox(): Sandbox<readonly ['sandbox.fs', 'sandbox.text_search']>
export interface BashSandboxOptions {
  readonly network?: { readonly allow?: readonly string[] }
  readonly executionLimits?: { readonly wallClockMs?: number; readonly maxFileSystemBytes?: number }
  readonly python?: boolean
}
export function bashSandbox(opts?: BashSandboxOptions): Sandbox<readonly ['sandbox.fs', 'sandbox.text_search', 'sandbox.exec']>
export type SandboxTelemetryOperation = 'register_owner' | 'open' | 'detach' | 'terminate' | 'list' | 'purge' | 'sweep' | 'delete_snapshot'
export function withSandboxTelemetry<T>(
  telemetry: TelemetryShim | undefined,
  adapterId: string,
  operation: SandboxTelemetryOperation,
  action: () => Promise<T>,
  successAttributes?: (result: T) => SpanAttrs
): Promise<T>

// Memory factory (default reference adapter)
export function sandboxMemory(): MemoryAdapter

// Local durable execution factories
export function localDurableExecution(options: LocalDurableExecutionOptions): LocalDurableExecution
export function sqliteHarnessStorage(options: SqliteHarnessStorageOptions): HarnessStorage & { close(): Promise<void> }
export class LocalDirectoryWorkspace implements DurableWorkspace
export function localDirectoryWorkspace(options: LocalDirectoryWorkspaceOptions): DurableWorkspace
export function localDirectorySandbox(options: LocalDirectorySandboxOptions): Sandbox
export class SqliteHarnessStorage implements HarnessStorage

// Durable external wait errors; persistence is part of HarnessStorage
export class ExternalWaitPendingError extends HarnessError {}
export class ExternalWaitError extends HarnessError {}

// Storage-owned recoverable execution primitives
export function isTerminalRunStatus(status: DurableRunStatus): boolean
export function isResumeBlockingRunStatus(status: DurableRunStatus): boolean
export class DurableStepError extends Error {}
export class DurableRunLeaseError extends Error {}
export class DurableTerminalRunError extends Error {}

// Durable workspace in-memory reference (also re-exported from /testing)
export class InMemoryDurableWorkspace implements DurableWorkspace
export function inMemoryDurableWorkspace(): DurableWorkspace

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

// Provider concurrency and rate admission
export function modelAdmissionKey(provider: Pick<ModelProvider, 'id' | 'genAiSystem'>, model: string, credentialScope?: string): ModelAdmissionKey
export interface ModelAdmission { acquire(request: ModelAdmissionRequest): Promise<ModelAdmissionLease> }

// Errors (every class from 15-error-catalog)
export class HarnessError extends Error { /* see 03-foundation */ }
export class HarnessConfigError extends HarnessError {}
export class ValidationError extends HarnessError {}
export class ModelAdmissionRejectedError extends HarnessError {}
export class PermissionDeniedError extends HarnessError {}
export class PolicyDeniedError extends HarnessError {}
export class DecisionEvaluationError extends HarnessError {}
export class DecisionBlockedError extends HarnessError {}
export class SandboxError extends HarnessError {}
export class SandboxNoExecutorError extends HarnessError {}
export class SandboxStateLostError extends HarnessError {}
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

**Removed in v3:** standalone `defineAgent`, `defineWorkflow`, `defineTool`, `defineSkill`, `defineModel` factories are NOT exported. Inline builder definitions and static `defineHarnessModule` transforms preserve surrounding builder constraints; a module is not an independently buildable definition catalog. See [25-static-harness-modules](./25-static-harness-modules.md).

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
export interface TsToolDefinition<I, O, Context = ToolHandlerContext>
export interface McpStdioToolDefinition
export interface McpHttpToolDefinition
export interface McpPluginProvenance
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
export interface AgentModelRequest
export interface AgentExecutionInterceptorContext<S, I>
export interface AgentBeforeInputInterceptorContext<S, I>
export interface AgentBeforeModelInterceptorContext<S, I>
export interface AgentAfterModelInterceptorContext<S, I>
export interface AgentBeforeToolInterceptorContext<S, I>
export interface AgentAfterToolInterceptorContext<S, I>
export interface AgentExecutionInterceptor<S, I>
export type AgentExecutionInterception<T>
export interface AgentGuardrailsBinding
export interface AgentPrepareStepContext<S, I>
export interface AgentPrepareStepResult<S>
export interface AgentStopWhenContext<S, I>
export type AgentPrepareStep<S, I>
export type AgentStopWhen<S, I>
export type WorkflowsConfig<S>
export interface WorkflowDefinition<S, I, O>
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
export interface GovernanceApprovalProvider<S>
export type GovernanceApprovalRequest<S>
export type GovernanceApprovalResult
export type GovernanceAuditRecord
export interface GovernanceAuditSink
export type ToolInput<S, K>

// Defaults
export interface HarnessDefaults
export interface DelegationDefaults
export interface ContextProjectionPolicy
export interface SessionHistoryRetentionPolicy

// Inside-handler context types
export interface AgentContext<S, I, O>
export interface AgentContextMinimal<S, I>
export interface WorkflowContext<S, I, O>
export type ToolHandlerContext<C extends readonly AdapterCapability[] = readonly AdapterCapability[]>
export interface Metrics
export type SpanAttrs
export interface TelemetryShim
export function createTelemetryShim(): TelemetryShim
export interface SessionMemory
export interface MemoryFacade
export interface ConversationHistory
export interface SessionChildTasks

// Built-in tools and permissions
export type BuiltinToolName
export type PermissionMode
export interface PermissionPolicy
export interface AgentPermissions

// Governance public types are inventoried above; no alternate policy/approval aliases.

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
export type ProviderContinuation
export type ProviderContinuationItem
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
export interface DurableWorkspace
export interface DurableWorkspaceInfo
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
export interface WorkspacePinOptions
export interface WorkspaceReleasePinOptions
export interface WorkspaceFinishOptions
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
export interface SqliteHarnessStorageOptions
export interface LocalDirectoryWorkspaceOptions
export interface LocalDirectorySandboxOptions

// Adapter-author subpath: @purista/harness/adapter
export function sameHarnessIdentity
export function assertSessionSandboxBindingTransition
export function sandboxScopeKey
export function validateSandboxOpenOptions
export function validateSandboxScope
export function validateSandboxTerminateOptions
export function asExternalWaitResolved
export function createExternalWaitCancellation
export function projectExternalWaitRequest
export function validateBoundExternalWaitRequest
export function validateExternalWaitId
export function validateExternalWaitRegistration
export function validateExternalWaitSignal
export function validateExternalWaitSignalResult
export function validateExternalWaitSnapshot

// Storage-owned durable execution
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

// Harness storage / Sandbox ports
export interface HarnessStorage
export interface HarnessStorageInfo
export type FinishRunPatch
export type AdapterCapability
export interface AdapterCapabilities
export interface AdapterInspection
export interface HarnessInspection
export interface HarnessModuleInspection
export interface HarnessModuleContribution
export type Sandbox
export interface SandboxSessionBase
export interface ReadOnlyMountOptions
export interface ReadOnlyMountCapableSandboxSession
export function isReadOnlyMountCapableSession
export interface ExecCapableSandboxSession
export function isExecCapableSession
export interface TextSearchCapableSandboxSession
export function isTextSearchCapableSession
export type SandboxSession
export type SandboxSessionFor
export interface SnapshotResult
export interface SandboxResumeOptions
export interface SnapshotCapableSandbox
export interface ResumeCapableSandbox
export interface HibernateCapableSandbox
export type SandboxScope
export type SandboxOpenMode
export interface SandboxOpenOptions
export type SandboxOpenResult
export interface SandboxTerminateOptions
export interface SpawnOptions
export interface SandboxProcess
export interface SpawnCapableSandboxSession
export function isSpawnCapableSession
export interface ExecOptions
export interface ExecResult
export interface DirEntry
export interface FileStat
export type SandboxTextSearchSyntax
export type SandboxTextSearchLimitReason
export interface SandboxTextSearchRequest
export interface SandboxTextSearchMatch
export interface SandboxTextSearchResult
export const SANDBOX_TEXT_SEARCH_LIMITS
export function validateSandboxTextSearchRequest
export function compileSafeRegex

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

// Generic evaluations
export interface EvaluationCase
export interface EvaluationDataset
export interface EvaluationCandidate
export interface EvaluationTrial
export type EvaluationDimensionDefinition
export interface EvaluationCorrelation
export interface EvaluationCost
export interface EvaluationModelIdentity
export interface EvaluationModelCall
export interface EvaluationAccounting
export interface EvaluationExecutionProvenance
export interface EvaluationObservation
export interface EvaluationTaskTarget
export interface EvaluationTaskOutput
export interface EvaluationTask
export type EvaluationEvidence
export type EvaluationDimensionResult
export interface EvaluationScorerOutput
export interface EvaluationScorerTarget
export interface EvaluationScorer
export interface DeterministicEvaluationScorerDefinition
export type EvaluationFailurePolicy
export interface EvaluationRetryPolicy
export interface EvaluationTimeouts
export interface EvaluationRunInput
export interface EvaluationScoreInput
export type EvaluationRunMode
export type EvaluationRunStatus
export type EvaluationCaseStatus
export type EvaluationScorerStatus
export interface EvaluationErrorRecord
export interface EvaluationScorerResultRecord
export interface EvaluationTaskResultRecord
export interface EvaluationCaseResult
export type EvaluationAggregateScope
export interface EvaluationDistribution
export interface EvaluationCoverage
export interface EvaluationAccountingSummary
export interface EvaluationCandidateAggregate
export interface EvaluationDimensionAggregate
export interface EvaluationRunResult
export interface EvaluationFeedbackProjectionOptions
export function runEvaluation<I, Assessment, Candidate, O, ScorerContext = unknown>(
  input: EvaluationRunInput<I, Assessment, Candidate, O, ScorerContext>
): Promise<EvaluationRunResult>
export function scoreEvaluation<Assessment, O, ScorerContext = unknown>(
  input: EvaluationScoreInput<Assessment, O, ScorerContext>
): Promise<EvaluationRunResult>
export function createDeterministicEvaluationScorer<Assessment = unknown, O = unknown, ScorerContext = unknown>(
  definition: DeterministicEvaluationScorerDefinition<Assessment, O, ScorerContext>
): EvaluationScorer<Assessment, O, ScorerContext>
export function evaluationResultToFeedbackRecords(
  result: EvaluationRunResult,
  options: EvaluationFeedbackProjectionOptions
): readonly FeedbackRecord[]
```

### `HarnessBuilder<S>` (locked)

```ts
export type Schema<Input extends JsonValue = JsonValue, Output extends JsonValue = Input> = StandardSchemaV1<Input, Output>
export type ModelSchema<Input extends JsonValue = JsonValue, Output extends JsonValue = Input> =
  StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>
export type Infer<S extends Schema> = StandardSchemaV1.InferOutput<S>
export type InferIn<S extends Schema> = StandardSchemaV1.InferInput<S>

interface HarnessBuilder<S extends BuilderState> {
  /** Apply a local static transform; unavailable to module callbacks. */
  use<Required extends BuilderState, Result extends BuilderState, Id extends string>(
    this: S extends Required ? HarnessBuilder<S> : never,
    module: HarnessModule<Required, Result, Id>
  ): HarnessBuilder<S & Result>
  // Foundation — optional, called at most once each
  telemetry(opts: TelemetryOptions): HarnessBuilder<S>
  logger(logger: Logger): HarnessBuilder<S>
  storage(storage: HarnessStorage): HarnessBuilder<S>
  sandbox(): HarnessBuilder<S & { sandboxCapabilities: readonly AdapterCapability[] }>
  sandbox<const A extends Sandbox>(sandbox: A): HarnessBuilder<S & { sandboxCapabilities: NonNullable<A['capabilities']> }>
  memory(adapter: MemoryAdapter): HarnessBuilder<S>
  workspace(workspace: DurableWorkspace): HarnessBuilder<S>
  requires(required: readonly AdapterCapability[]): HarnessBuilder<S>
  defaults(d: HarnessDefaults): HarnessBuilder<S>

  // Registries are repeatable, append-only, and collision-rejecting.
  model<const Id extends string, const D extends ModelAlias>(
    id: Id,
    definition: D
  ): HarnessBuilder<S & { models: Record<Id, D> }>
  models<const M extends ModelsConfig>(models: M): HarnessBuilder<S & { models: M }>
  tool<const Id extends string, const I extends ModelSchema, const O extends Schema>(
    id: Id,
    definition: TsToolDefinition<I, O, ToolHandlerContext<SandboxCapabilitiesFor<S>>>
  ): HarnessBuilder<S & { tools: Record<Id, TsToolDefinition<I, O, ToolHandlerContext<SandboxCapabilitiesFor<S>>>> }>
  tool<const Id extends string, const D extends McpStdioToolDefinition | McpHttpToolDefinition>(
    id: Id,
    definition: D
  ): HarnessBuilder<S & { tools: Record<Id, D> }>
  tools<const T extends Record<string, ToolDefinition<ToolHandlerContext<SandboxCapabilitiesFor<S>>>>>(
    tools: T & ToolsConfigFromSchemaMaps<T, ToolHandlerContext<SandboxCapabilitiesFor<S>>>
  ): HarnessBuilder<S & { tools: T }>
  skill<const Id extends string, const D extends SkillDefinition>(
    id: Id,
    definition: D
  ): HarnessBuilder<S & { skills: Record<Id, D> }>
  skills<const K extends SkillsConfig>(skills: K): HarnessBuilder<S & { skills: K }>
  agent<const Id extends string, const D extends AgentDefinition<S>>(
    id: Id,
    definition: D
  ): HarnessBuilder<S & { agents: Record<Id, D> }>
  agents<const A extends AgentsConfig<S>>(
    agents: A
  ): HarnessBuilder<S & { agents: A }>
  workflow<const Id extends string, const D extends WorkflowDefinition<S>>(
    id: Id,
    definition: D
  ): HarnessBuilder<S & { workflows: Record<Id, D> }>
  workflows<const W extends WorkflowsConfig<S>>(
    workflows: W
  ): HarnessBuilder<S & { workflows: W }>
  governance(
    config: GovernanceConfig<S> | ((helpers: GovernanceDefinitionHelpers<S>) => GovernanceConfig<S>)
  ): HarnessBuilder<S & { governance: GovernanceConfig<S> }>

  build(): Harness<S>
}
```

All five singular/plural registry families are repeatable and accumulate exact
registry keys. Singular and plural calls share one validation/merge path;
duplicate IDs fail rather than replace. Identity callbacks, native-tool helper
callbacks, registration brands, and their public helper types do not exist.
`HarnessModuleBuilder<S>` exposes the same ten registration methods and is
otherwise `HarnessBuilder<S>` without `build` and `use`.
`HarnessModule<Required, Result, Id>.register` receives the declared minimum
state and returns its inferred result. `.use()` is callable only when the
accumulated state extends `Required`, and returns `HarnessBuilder<S & Result>`
so existing definitions and sandbox capability inference are retained.
The shipped declaration must preserve literal model/tool/skill/agent keys,
schema directions, and sandbox capabilities without public `any`/`unknown`
escape hatches. A consumer definition can reference only registry keys already
accumulated in its builder state. At runtime, `.build()` fails with
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
  /** Frees live sandbox/MCP resources but preserves persisted session state. */
  release(): Promise<void>
  /** Destructively removes persisted session state after releasing resources. */
  destroy(): Promise<void>
}

interface AgentInvoker<S, K extends keyof S['agents']> {
  run(input: AgentInput<S, K>, opts?: InvokeOptions): Promise<AgentOutput<S, K>>
  stream(input: AgentInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

interface WorkflowInvoker<S, K extends keyof S['workflows']> {
  run(input: WorkflowInput<S, K>, opts?: InvokeOptions): Promise<WorkflowOutput<S, K>>
  stream(input: WorkflowInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

type AgentInput<S, K extends keyof S['agents']> =
  S['agents'][K] extends { input: infer I extends Schema } ? InferIn<I> : string
type AgentOutput<S, K extends keyof S['agents']> =
  S['agents'][K] extends { output: infer O extends Schema } ? Infer<O> : string
type WorkflowInput<S, K extends keyof S['workflows']> =
  S['workflows'][K] extends { input: infer I extends Schema } ? InferIn<I> : string
type WorkflowOutput<S, K extends keyof S['workflows']> =
  S['workflows'][K] extends { output: infer O extends Schema } ? Infer<O> : string
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
  | 'sandbox.text_search'
  | 'sandbox.exec'
  | 'sandbox.persistent_fs'
  | 'sandbox.workspace_binding'
  | 'sandbox.snapshot'
  | 'sandbox.resume'
  | 'sandbox.hibernate'
  | 'sandbox.live_process_preservation'
  | 'storage.checkpoint'
  | 'storage.retry'
  | 'storage.multi_instance'
  | 'storage.resume'
  | 'storage.workspace_checkpoint'
  | 'storage.checkpoint_retention'
  | 'storage.persistent'
  | 'storage.external_wait'
  | 'workspace.durable'
  | 'workspace.persistent'
  | 'workspace.checkpoint'
  | 'workspace.resume'
  | 'workspace.abort'
  | 'workspace.cleanup'
  | 'workspace.inspect'
  | 'workspace.retention'
  | 'workspace.quota'
  | 'workspace.encrypted_storage'
  | 'feedback.record'
  | MemoryCapability

interface AdapterInspection {
  kind: 'storage' | 'sandbox' | 'workspace' | 'feedback' | 'model' | 'memory'
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
  idempotencyKey?: string
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
  /** Per-run workspace constraints; the workspace adapter validates and enforces them. */
  workspacePolicy?: Partial<DurableWorkspacePolicy>
}
```

`durable` opts a workflow run into recoverable execution against the configured
`.storage(...)` and optional `.workspace(...)`; see
[21-durable-workspaces](./21-durable-workspaces.md) §16.1 and
[11-sessions](./11-sessions.md).

`traceparent`/`tracestate` follow W3C Trace Context and are propagated into the
run span before child workflow, agent, model, tool, sandbox, and storage spans are
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

`Session.getRunSummary(runId)` derives this from the configured `HarnessStorage`; it
does not inspect OTel spans.

### Generic evaluation runs

The complete closed type unions, field optionality, validation, failure,
ordering, aggregation, privacy, feedback-projection, and telemetry semantics for
the exports above are authoritative in
[35-generic-evaluation-runs](./35-generic-evaluation-runs.md). That approved
specification replaces the previous aggregate prompt evaluator and standalone
scorer types as one breaking cleanup. No dataset persistence, reporter/sink
port, vendor SDK, UI, annotation, dashboard, or hosted judge export is added by
this API.

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
export interface FakeModelProviderOptions { strict?: boolean }
export class FakeModelProvider implements ModelProvider     // configurable scripted responses; strict mode rejects unscripted calls and assertExhausted() detects unused fixtures
export class FakeHarnessStorage extends InMemoryHarnessStorage       // records invoked operations (`ops`, `opCount`, `resetOps`)
export class FakeSandbox implements Sandbox                  // deterministic FS+exec; configurable executor flag
export class FakeLogger implements Logger                    // captures log records in memory (`records`)
export class RecordingTelemetry implements TelemetryShim     // captures deterministic spans, metrics, and parent links
export class FakeMemoryAdapter implements MemoryAdapter      // deterministic KV/search fake
export class InMemoryDurableWorkspace implements DurableWorkspace   // also a main-entry export
export function inMemoryDurableWorkspace(): DurableWorkspace        // also a main-entry export
export function fakeCapabilityAdapter(
  capabilities: readonly AdapterCapability[],
  opts?: { id?: string }
): FakeCapabilityAdapter
export function fakeSnapshotSandbox(): Sandbox               // snapshot/resume/hibernate-capable in-memory sandbox
export type FakeHarnessStorageOp
export interface FakeSandboxOptions
export interface FakeLogRecord
export interface RecordedTelemetrySpan
export interface RecordedTelemetryMetric
export interface FakeCapabilityAdapter

// Contract suites — each is a Vitest test factory
export function harnessStorageContract(make: () => HarnessStorage | Promise<HarnessStorage>): void
export function sandboxContract(
  make: () => Sandbox | Promise<Sandbox>,
  opts: { executor: 'available' | 'unavailable' }
): void
export function sandboxTextSearchContract(make: () => Sandbox | Promise<Sandbox>): void
export function modelProviderContract(
  make: () => ModelProvider,
  opts: { capabilities: ModelCapability[] }
): void
export function loggerContract(make: () => Logger): void
export function memoryAdapterContract(
  make: () => MemoryAdapter | Promise<MemoryAdapter>,
  opts?: { search?: 'available' | 'unavailable'; persistence?: 'ephemeral' | 'persistent' }
): void
export function durableWorkspaceContract(
  make: () => DurableWorkspace | Promise<DurableWorkspace>,
): void
export function adapterCapabilitiesContract(make: () => AdapterCapabilities | Promise<AdapterCapabilities>): void
export function sandboxSnapshotContract(make: () => Sandbox | Promise<Sandbox>): void
export function sandboxMultiClientContract(
  makePair: () => readonly [Sandbox, Sandbox] | Promise<readonly [Sandbox, Sandbox]>
): void

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

// Generic evaluation test ergonomics; exact re-exports from the main package
export interface DeterministicEvaluationScorerDefinition
export function createDeterministicEvaluationScorer<Assessment = unknown, O = unknown, ScorerContext = unknown>(
  definition: DeterministicEvaluationScorerDefinition<Assessment, O, ScorerContext>
): EvaluationScorer<Assessment, O, ScorerContext>
```

```ts
export interface DeterministicEvaluationScorerDefinition<Assessment = unknown, O = unknown, ScorerContext = unknown> {
  id: string
  version: string
  dimension: EvaluationDimensionDefinition
  evaluate(observation: EvaluationObservation<Assessment, O, ScorerContext>): EvaluationDimensionResult
}
```

The factory returns a normal `EvaluationScorer`, has exactly the one declared
dimension, and does not define a second callback, target, or result
representation. Its callback is synchronous by design; asynchronous and
model-backed judgments implement `EvaluationScorer.score` directly.

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
`createDeterministicEvaluationScorer` (plus its definition types) and
`InMemoryDurableWorkspace`/`inMemoryDurableWorkspace` are main-entry
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

### `@purista/harness-google` package

```ts
import type { ModelProvider, BaseModelProviderOptions } from '@purista/harness'
import type { GoogleGenAIOptions } from '@google/genai'

export interface GoogleFactoryOptions extends GoogleGenAIOptions {
  client?: GoogleClient
  /** Optional adapter-level override. Defaults to the harness logger when registered. */
  harnessLogger?: BaseModelProviderOptions['logger']
  /** Optional adapter-level override. Defaults to the harness telemetry shim when registered. */
  telemetry?: BaseModelProviderOptions['telemetry']
  /** Optional adapter-level override. Defaults to `defaults.modelTimeoutMs` when registered. */
  harnessTimeoutMs?: number
}

export interface GoogleClient {
  models: {
    generateContent(params: unknown): Promise<unknown>
    generateContentStream(params: unknown): Promise<AsyncIterable<unknown>>
    embedContent(params: unknown): Promise<unknown>
  }
}

export function google(opts?: GoogleFactoryOptions): ModelProvider
```

`google(...)` is a thin official `@google/genai` SDK adapter. It implements
text, text streaming, JSON-schema object output, object streaming, application
function tools/results, and embeddings. It maps inline image/audio/file parts
to the SDK, does not upload sandbox files, and does not implement reranking.
Factory options accept Gemini API and Vertex/enterprise SDK settings. Harness
owns retry, timeout, telemetry and client-side conversation history; the
adapter applies `httpOptions.retryOptions.attempts: 1` unless the caller
provides explicit SDK retry options. The provider id is `'google'` and the
OpenTelemetry system identifier is `'google.gemini'`.

Additional provider packages follow the `@purista/harness-{addon}` naming convention and expose one provider factory plus factory options/client types. The `ModelProvider` port remains stable for v3.x provider packages.

Current provider addons:

- `@purista/harness-google`: `google(options)`, `GoogleFactoryOptions`, `GoogleClient`
- `@purista/harness-anthropic`: `anthropic(options)`, `AnthropicFactoryOptions`, `AnthropicClient`
- `@purista/harness-bedrock`: `bedrock(options)`, `BedrockFactoryOptions`, `BedrockClient`
- `@purista/harness-azure-foundry`: `azureFoundry(options)`, `AzureFoundryFactoryOptions`, `AzureFoundryClient`

## `@purista/harness-storage-postgres` package

The package exports exactly:

```ts
export interface PostgresHarnessStorageOptions {
  readonly connectionString?: string
  readonly pool?: import('pg').Pool
  readonly leaseTtlMs?: number
  readonly now?: () => number
}

export function postgresHarnessStorage(
  options: PostgresHarnessStorageOptions,
): HarnessStorage & { close(): Promise<void> }
```

Exactly one connection string or pool is required. A created pool is owned and
closed idempotently; an injected pool is never closed. Package migrations,
capabilities, transaction/fencing behavior, and telemetry are locked by spec
43.

## `@purista/harness-sandbox-kubernetes` package

The primary application surface is:

```ts
export interface KubernetesWorkspaceRuntimeOptions {
  readonly snapshotClassName?: string
  readonly snapshotReadyTimeoutMs?: number
}

export interface KubernetesSandboxRuntimeOptions {
  readonly namespace: string
  readonly image: string
  readonly runtimeId?: string
  readonly containerName?: string
  readonly serviceAccountName?: string
  readonly runtimeClassName?: string
  readonly imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never'
  readonly volumeSize?: string
  readonly storageClassName?: string
  readonly podReadyTimeoutMs?: number
  readonly defaultCommandTimeoutMs?: number
  readonly cpuLimit?: string
  readonly memoryLimit?: string
  readonly ephemeralStorageLimit?: string
  readonly maxFileBytes?: number
  readonly maxOutputBytes?: number
  readonly workspace?: false | true | KubernetesWorkspaceRuntimeOptions
  readonly kubeConfig?: import('@kubernetes/client-node').KubeConfig
  readonly driver?: KubernetesSandboxDriver
}

export interface KubernetesSandboxRuntime {
  readonly sandbox: Sandbox
  readonly workspace?: DurableWorkspace
  close(): Promise<void>
}

export interface KubernetesSandboxRuntimeWithWorkspace extends KubernetesSandboxRuntime {
  readonly workspace: DurableWorkspace
}

export function kubernetesSandboxRuntime(
  options: KubernetesSandboxRuntimeOptions & { readonly workspace: true | KubernetesWorkspaceRuntimeOptions },
): KubernetesSandboxRuntimeWithWorkspace
export function kubernetesSandboxRuntime(options: KubernetesSandboxRuntimeOptions): KubernetesSandboxRuntime
```

The package also exports the focused `KubernetesSandboxAdapter`,
`KubernetesDurableWorkspace`, capability constants, public option/record types,
`KubernetesSandboxDriver`, official driver factory, and resource-name helper so
platform wrappers can inject a tested infrastructure boundary without deep
imports. Application code normally uses only `kubernetesSandboxRuntime(...)`.
Provider resources and control metadata remain adapter-private.

## `@purista/harness-policy-opa` package

### `package.json` exports map (locked)

```json
{
  "name": "@purista/harness-policy-opa",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./testing": { "types": "./dist/testing/index.d.ts", "import": "./dist/testing/index.js" }
  }
}
```

### Main exports — values

```ts
export const OPA_DATA_API_PREFIX: 'v1/data'
export const OPA_DEFAULT_MAX_RESPONSE_BYTES: 262_144
export const OPA_DEFAULT_TIMEOUT_MS: 10_000
export class OpaClientError extends Error {}
export class OpaPolicyError extends Error {}
export function createOpaClient(options: OpaClientOptions): OpaClient
export function opaPolicy<
  S extends BuilderState,
  const ResultSchema extends Schema<any, any>,
>(
  registrar: OpaPolicyRegistrar<S>,
  options: OpaPolicyOptions<S, ResultSchema>,
): GovernancePolicyEvaluator<S>
```

### Main exports — types

```ts
export type OpaDecisionPath
export type OpaClientErrorKind
export type OpaPolicyErrorKind
export type OpaQueryResult
export type OpaJsonCompatible<T>
export type OpaJsonResultSchema<ResultSchema extends Schema<any, any>>
export interface OpaDecisionExecution
export interface OpaClientOptions
export interface OpaClient
export interface OpaPolicyRegistrar<S extends BuilderState>
export interface OpaPolicyOptions<S extends BuilderState, ResultSchema extends Schema<any, any>>
```

### Testing exports

```ts
export interface FakeOpaDataApiRequest
export interface FakeOpaDataApiResponseOptions
export interface FakeOpaDataApiDecisionOptions
export class FakeOpaDataApi
```

The exact generic callbacks, transport behavior, validation, errors, and fake
methods are locked in [41-opa-policy-adapter](./41-opa-policy-adapter.md).

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

The harness does not own a vendor-specific conversion matrix. Tool input and default-loop agent output implement `ModelSchema`; during `build()`, Harness calls the Standard JSON Schema input converter exactly once with target `draft-2020-12`, validates/freezes the returned `JsonValue`, and caches it. All other public value-schema boundaries require only `Schema`. Provider ports receive plain JSON Schema and adapters pass it through unchanged. Exact failure metadata, type directions, and cache rules are locked in [39-standard-schema-boundaries](./39-standard-schema-boundaries/03-contracts/model-projection.md).

MCP tools retain their existing embedded JSON Schema validation path; JSON Schema is not converted into a user validator.

## Cross-references

- All other spec files. This is the index of types they collectively define.

## Decision boundary public inventory

The [shared ABI, phase, governance, wait and continuation inventory](./37-decision-boundaries/03-contracts/decisions.md) adds the core decisions exports, beforeOutput hook/types, ProviderContinuation and ExternalWaitResolved. Its clean removals are mandatory; this index does not authorize old aliases.
