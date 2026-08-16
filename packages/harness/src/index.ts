// Public surface of `@purista/harness`. The export lists below are locked by
// specs/13-public-api.md and verified by test/public-api.test.ts — keep all
// three in sync when changing any export.

// Errors (specs/15-error-catalog.md)
export {
  HarnessError,
  isHarnessError,
  HarnessConfigError,
  ValidationError,
  PermissionDeniedError,
  PolicyDeniedError,
  PolicyEvaluationError,
  SandboxError,
  SandboxNoExecutorError,
  ModelError,
  ModelCapabilityError,
  ToolError,
  ToolNotFoundError,
  SkillNotFoundError,
  SkillManifestError,
  AgentNotFoundError,
  AgentLoopBudgetError,
  DelegationPolicyError,
  WorkflowNotFoundError,
  SessionNotFoundError,
  SessionBusyError,
  StateError,
  WorkspaceError,
  WorkspaceQuotaExceededError,
  WorkspaceCleanupError,
  OperationTimeoutError,
  OperationCancelledError,
  McpProtocolError,
  McpAuthError,
  InternalError,
  sanitizeProviderMessage,
  serializeError
} from './errors/index.js'
export type { ErrorCategory } from './errors/index.js'

// Foundation: logger, telemetry shim types, ULID, version
export { JsonLogger } from './logger/index.js'
export type { Logger, LogLevel } from './logger/index.js'
export type { Metrics, SpanAttrs, TelemetryShim } from './telemetry/index.js'
export { ulid } from './ulid/index.js'
export { HARNESS_VERSION } from './version.js'
export { projectToolResults, validateContextProjection } from './context-projection.js'
export type { ContextProjectionPolicy } from './context-projection.js'

// Model provider port
export { BaseModelProvider } from './ports/base-model-provider.js'
export type { BaseModelProviderOptions } from './ports/base-model-provider.js'
export type {
  BaseRequest,
  ContentPart,
  ContentPartKind,
  Embedding,
  EmbeddingRequest,
  EmbeddingResponse,
  FinishReason,
  ModelAlias,
  ModelCallOptions,
  ModelCapability,
  ModelDefaults,
  ModelFeatureSet,
  ModelMessage,
  ModelOutcome,
  ModelProvider,
  ModelProviderInfo,
  ModelRateLimitInfo,
  ModelRetryKind,
  ModelRetryOnPolicy,
  ModelRetryPolicy,
  ModelRetrySetting,
  ModelToolSpec,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  OutputMode,
  ProviderItems,
  RerankDocument,
  RerankRequest,
  RerankResponse,
  RerankResult,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  TokenUsage,
  ToolCallSpec
} from './ports/model-provider.js'
export type { ModelHandle, ModelInvokeContext } from './models/registry.js'

// Shared model adapter helpers (consumed by first-party provider packages)
export {
  accumulateStreamToolCallDeltas,
  createStreamToolCallState,
  finalizeStreamToolCalls,
  malformedResponseError,
  parseProviderJson,
  redactProviderContent,
  safePartialJson,
  toTokenUsage,
  withoutObjectTool
} from './models/adapter-utils.js'
export type { AdapterCallContext, StreamToolCallState, TokenUsageDetails } from './models/adapter-utils.js'

// Adapter capabilities and context
export type {
  AdapterCapabilities,
  AdapterCapability,
  AdapterInspection,
  DurableRuntimeAdapter,
  HarnessInspection,
  HarnessModuleContribution,
  HarnessModuleInspection
} from './ports/capabilities.js'
export type { HarnessAdapterContext, HarnessContextConfigurable } from './ports/harness-context.js'

// State port + in-memory default
export { StateStoreAdapterBase } from './ports/state.js'
export type { StateStore } from './ports/state.js'
export { InMemoryStateStore } from './state/in-memory.js'
export type { JsonValue } from './models/json.js'
export type { Message, PersistedRunEvent, RunRecord, RunStatus, SessionRecord } from './models/state.js'

// Memory port
export type {
  MemoryAdapter,
  MemoryAdapterInfo,
  MemoryCapability,
  MemoryEntry,
  MemoryFacade,
  MemoryListOptions,
  MemoryOpenContext,
  MemoryOperation,
  MemoryOperationContext,
  MemoryScope,
  MemoryScopeKind,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryStore,
  MemoryWriteOptions,
  SessionMemory
} from './ports/memory.js'
export { sandboxMemory } from './memory/sandbox/index.js'

// Feedback port
export type { FeedbackRecord, FeedbackTarget } from './ports/feedback.js'

// Durable workspace port
export type {
  DurableReplayCheckpoint,
  DurableWorkspacePolicy,
  DurableWorkspaceStore,
  DurableWorkspaceStoreInfo,
  WorkspaceAbortOptions,
  WorkspaceAbortResult,
  WorkspaceCheckpoint,
  WorkspaceCleanupOptions,
  WorkspaceCleanupResult,
  WorkspaceEncryptionInfo,
  WorkspaceHandle,
  WorkspaceInspection,
  WorkspaceInspectionOptions,
  WorkspaceLifecycleState,
  WorkspacePauseOptions,
  WorkspaceQuotaPolicy,
  WorkspaceResumeOptions,
  WorkspaceRetentionPolicy,
  WorkspaceStartOptions
} from './ports/workspace.js'
export { InMemoryDurableWorkspaceStore, inMemoryDurableWorkspaceStore } from './workspace/index.js'

// Context checkpoint port
export type {
  ContextCheckpoint,
  ContextCheckpointQuery,
  ContextCheckpointRef,
  ContextCheckpointStore,
  ContextCheckpointStoreInfo
} from './ports/context-checkpoints.js'

// Durable runtime
export {
  createDurableWorkflowContext,
  DurableStepError,
  DurableRunLeaseError,
  DurableTerminalRunError,
  inMemoryDurableRuntime,
  isResumeBlockingRunStatus,
  isTerminalRunStatus
} from './runtime/index.js'
export type {
  DurableActiveRunStatus,
  DurableWorkflowContext,
  DurableWorkflowContextOptions,
  DurableStepCommit,
  DurableStepOptions,
  DurableStepRetryPolicy,
  DurableStepRetrySetting,
  DurableRunLease,
  DurableRunStart,
  DurableRunStatus,
  DurableRuntime,
  DurableTerminalRunStatus,
  FinishRunPatch,
  InMemoryDurableRuntimeOptions,
  RunCheckpoint
} from './runtime/index.js'

// Sandbox port + default factories
export { bashSandbox, inMemorySandbox } from './sandbox/index.js'
export type {
  ExecCapableSandboxSession,
  HibernateCapableSandbox,
  ResumeCapableSandbox,
  Sandbox,
  SandboxProcess,
  SandboxResumeOptions,
  SandboxSession,
  SandboxSessionBase,
  SandboxSessionFor,
  SnapshotCapableSandbox,
  SnapshotResult,
  SpawnCapableSandboxSession,
  SpawnOptions
} from './sandbox/index.js'
export type { DirEntry, ExecOptions, ExecResult, FileStat } from './harness/types.js'

// Local durable execution
export {
  localDirectorySandbox,
  localDirectoryWorkspaceStore,
  localDurableExecution,
  SqliteHarnessStorage,
  sqliteContextCheckpointStore,
  sqliteDurableRuntime,
  sqliteStateStore
} from './local/index.js'
export type {
  LocalDirectorySandboxOptions,
  LocalDirectoryWorkspaceStoreOptions,
  LocalDurableExecution,
  LocalDurableExecutionOptions,
  LocalDurableSandbox,
  LocalExecSandboxCapabilities,
  LocalFilesOnlySandboxCapabilities,
  LocalHostExecPolicy,
  SqliteContextCheckpointStoreOptions,
  SqliteDurableRuntimeOptions,
  SqliteStateStoreOptions
} from './local/index.js'

// Skills discovery
export { discoverSkills } from './skills/index.js'

// AI evaluation core
export { evaluateDeterministicScorer, evaluatePromptCandidates } from './eval/index.js'
export type {
  CandidateScore,
  DeterministicScorerDefinition,
  EvaluatePromptCandidatesInput,
  EvaluationItem,
  PromptCandidate,
  ScorerResult,
  ScorerTarget
} from './eval/index.js'

// Builder, harness, session, and handler context types
export { defineHarness, defineHarnessModule } from './harness/defineHarness.js'
export type {
  AgentContext,
  AgentContextMinimal,
  AgentDefinition,
  AgentDefinitionHelpers,
  AgentInput,
  AgentInvoker,
  AgentOutput,
  AgentPermissions,
  AgentPrepareStep,
  AgentPrepareStepContext,
  AgentPrepareStepResult,
  AgentStopWhen,
  AgentStopWhenContext,
  AgentsConfig,
  BuilderState,
  BuiltinToolName,
  ChildTaskContextPolicy,
  ChildTaskDescriptor,
  ChildTaskHandle,
  ChildTaskMode,
  ChildTaskStartOptions,
  ChildTaskStatus,
  ContinuableChildTaskHandle,
  ContinuableChildTaskStartOptions,
  ContentCaptureMode,
  ContextCheckpoints,
  ConversationHistory,
  DelegationDefaults,
  DiscoveredSkills,
  DiscoverSkillsOptions,
  DurableInvokeOptions,
  GovernanceApprovalProvider,
  GovernanceApprovalRequest,
  GovernanceApprovalResult,
  GovernanceAuditContext,
  GovernanceAuditSink,
  GovernanceConfig,
  GovernanceContext,
  GovernanceDecision,
  GovernanceDefinitionHelpers,
  GovernanceEffect,
  GovernanceExposureEffect,
  GovernanceMode,
  GovernancePolicyDefinition,
  GovernancePolicyEvaluator,
  GovernanceRiskLevel,
  GovernanceToolExposureContext,
  GovernanceToolExposurePolicy,
  GovernanceToolExposureRule,
  GovernanceToolExposureRuleForTool,
  GovernanceToolId,
  Harness,
  HarnessBuilder,
  HarnessDefaults,
  HarnessModule,
  HarnessModuleBuilder,
  HarnessOptions,
  InferTypes,
  InvokeOptions,
  McpAuth,
  McpHttpToolDefinition,
  McpStdioToolDefinition,
  ModelHandles,
  ModelsConfig,
  NativePolicyDefinition,
  NativePolicyRule,
  NativePolicyRuleForTool,
  OnPermission,
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionPolicy,
  ResolvedSkill,
  RunEvent,
  RunSummary,
  SerializedError,
  Session,
  SessionChildTasks,
  SkillDefinition,
  SkillDiagnostic,
  SkillFrontmatter,
  SkillsConfig,
  SkillValidationMode,
  TelemetryFlavor,
  TelemetryOptions,
  ToolDefinition,
  ToolHandlerContext,
  ToolInput,
  ToolsConfig,
  TsToolDefinition,
  WorkflowAgentInvokeOptions,
  WorkflowChildTasks,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowDefinitionHelpers,
  WorkflowDelegationPolicy,
  WorkflowFanOutOptions,
  WorkflowInput,
  WorkflowInvoker,
  WorkflowOutput,
  WorkflowsConfig
} from './harness/defineHarness.js'
