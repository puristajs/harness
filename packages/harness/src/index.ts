// Public surface of `@purista/harness`. The export lists below are locked by
// specs/13-public-api.md and verified by test/public-api.test.ts — keep all
// three in sync when changing any export.

// Errors (specs/15-error-catalog.md)
export {
  HarnessError,
  isHarnessError,
  HarnessConfigError,
  ValidationError,
  ModelAdmissionRejectedError,
  PermissionDeniedError,
  PolicyDeniedError,
  DecisionBlockedError,
  DecisionEvaluationError,
  SandboxError,
  SandboxNoExecutorError,
  SandboxPermissionDeniedError,
  SandboxConflictError,
  SandboxQuotaExceededError,
  SandboxStateLostError,
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
  serializeError,
} from './errors/index.js'
export type { ErrorCategory } from './errors/index.js'

// Foundation: logger, telemetry shim types, ULID, version
export { JsonLogger } from './logger/index.js'
export type { Logger, LogLevel } from './logger/index.js'
export { createTelemetryShim } from './telemetry/index.js'
export type { Metrics, SpanAttrs, TelemetryShim } from './telemetry/index.js'
export { ulid } from './ulid/index.js'
export { HARNESS_VERSION } from './version.js'
export { projectToolResults, validateContextProjection } from './context-projection.js'
export type { ContextProjectionPolicy } from './context-projection.js'
export {
  messageStorageBytes,
  retainCompleteTurns,
  validateSessionHistoryRetention,
} from './sessions/history-retention.js'
export type { SessionHistoryRetentionPolicy } from './sessions/history-retention.js'

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
  ProviderContinuation,
  ProviderContinuationItem,
  RerankDocument,
  RerankRequest,
  RerankResponse,
  RerankResult,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  TokenUsage,
  ToolCallSpec,
} from './ports/model-provider.js'
export type { ModelHandle, ModelInvokeContext } from './models/registry.js'
export { modelAdmissionKey } from './ports/model-admission.js'
export type {
  ModelAdmission,
  ModelAdmissionKey,
  ModelAdmissionLease,
  ModelAdmissionOperation,
  ModelAdmissionRequest,
} from './ports/model-admission.js'

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
  withoutObjectTool,
} from './models/adapter-utils.js'
export type { AdapterCallContext, StreamToolCallState, TokenUsageDetails } from './models/adapter-utils.js'

// Adapter capabilities and context
export type {
  AdapterCapabilities,
  AdapterCapability,
  AdapterInspection,
  HarnessInspection,
  HarnessModuleContribution,
  HarnessModuleInspection,
} from './ports/capabilities.js'
export type { HarnessAdapterContext, HarnessContextConfigurable } from './ports/harness-context.js'

// Harness-owned persistence + in-memory default
export type { FinishRunPatch, HarnessStorage, HarnessStorageInfo } from './storage/types.js'
export { InMemoryHarnessStorage, inMemoryHarnessStorage } from './storage/in-memory.js'
export { isJsonValue } from './models/json.js'
export type { JsonValue } from './models/json.js'
export type { Infer, InferIn, ModelSchema, Schema } from './schema/index.js'
export type { Message, PersistedRunEvent, RunRecord, RunStatus, SessionRecord } from './models/state.js'

// Shared decision-boundary contracts
export {
  createDecisionEvidence,
  decisionEvidenceSchema,
  decisionFailureKindSchema,
  decisionOccurrenceSchema,
  parseProviderContinuation,
  decisionResultSchema,
  decisionSourceSchema,
  governanceApprovalResultSchema,
  governanceDecisionSchema,
  providerContinuationItemSchema,
  providerContinuationSchema,
  runDecisionOperation,
} from './decisions/index.js'
export type {
  CreateDecisionEvidenceInput,
  DecisionEvidence,
  DecisionExecutionContext,
  DecisionFailureKind,
  DecisionOccurrence,
  DecisionSource,
} from './decisions/index.js'

// Memory port
export type {
  MemoryCapability,
  MemoryConfiguration,
  MemoryConfigurationFor,
  MemoryEngine,
  MemoryEngineContext,
  MemoryEngineInfo,
  MemoryEngineSearchQuery,
  MemoryEntry,
  MemoryFacade,
  MemoryIndexDescriptor,
  MemoryListOptions,
  MemoryListResult,
  MemoryOperation,
  MemoryModelReference,
  MemoryRecord,
  MemoryScope,
  MemoryScopeKind,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryWriteOptions,
  SessionMemory,
} from './ports/memory.js'
export { inMemoryMemoryEngine } from './memory/in-memory.js'
export type { HarnessIdentity } from './identity/index.js'

// Feedback port
export type { FeedbackRecord, FeedbackTarget } from './ports/feedback.js'

// Durable external wait port
export { ExternalWaitError } from './storage/external-wait.js'
export type {
  ExternalWaitOutcome,
  ExternalWaitRequest,
  ExternalWaitSnapshot,
  ExternalWaitSignal,
  ExternalWaitSignalResult,
  ExternalWaitStatus,
  ExternalWaitRegistration,
  ExternalWaitResolved,
} from './storage/external-wait.js'

// Durable workspace port
export type {
  DurableReplayCheckpoint,
  DurableWorkspacePolicy,
  DurableWorkspace,
  DurableWorkspaceInfo,
  WorkspaceAbortOptions,
  WorkspaceAbortResult,
  WorkspaceCheckpoint,
  WorkspaceCleanupOptions,
  WorkspaceCleanupResult,
  WorkspaceEncryptionInfo,
  WorkspaceFinishOptions,
  WorkspaceHandle,
  WorkspaceInspection,
  WorkspaceInspectionOptions,
  WorkspaceLifecycleState,
  WorkspacePauseOptions,
  WorkspacePinOptions,
  WorkspaceQuotaPolicy,
  WorkspaceResumeOptions,
  WorkspaceReleasePinOptions,
  WorkspaceRetentionPolicy,
  WorkspaceStartOptions,
} from './ports/workspace.js'
export { InMemoryDurableWorkspace, inMemoryDurableWorkspace } from './workspace/index.js'

// Storage-owned durable execution types
export {
  DurableStepError,
  DurableRunLeaseError,
  DurableTerminalRunError,
  isResumeBlockingRunStatus,
  isTerminalRunStatus,
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
  DurableTerminalRunStatus,
  RunCheckpoint,
} from './runtime/index.js'

// Sandbox port + default factories
export {
  SANDBOX_TEXT_SEARCH_LIMITS,
  bashSandbox,
  compileSafeRegex,
  inMemorySandbox,
  isExecCapableSession,
  isReadOnlyMountCapableSession,
  isSpawnCapableSession,
  isTextSearchCapableSession,
  validateSandboxTextSearchRequest,
} from './sandbox/index.js'
export type {
  BashSandboxOptions,
  ExecCapableSandboxSession,
  HibernateCapableSandbox,
  ResumeCapableSandbox,
  ReadOnlyMountCapableSandboxSession,
  ReadOnlyMountOptions,
  Sandbox,
  SandboxOpenMode,
  SandboxOpenOptions,
  SandboxOpenResult,
  SandboxProcess,
  SandboxResumeOptions,
  SandboxScope,
  SandboxSession,
  SandboxSessionBase,
  SandboxSessionFor,
  SnapshotCapableSandbox,
  SnapshotResult,
  SpawnCapableSandboxSession,
  SpawnOptions,
  SandboxTerminateOptions,
  SandboxTextSearchLimitReason,
  SandboxTextSearchMatch,
  SandboxTextSearchRequest,
  SandboxTextSearchResult,
  SandboxTextSearchSyntax,
  TextSearchCapableSandboxSession,
} from './sandbox/index.js'
export type {
  SandboxBindingOptions,
  SandboxOwner,
  SandboxOwnerAuthorizationContext,
  SandboxOwnerRegistrationOptions,
  SandboxPartition,
  SandboxPolicy,
  SessionOptions,
  SessionSandboxBinding,
} from './sandbox/ownership.js'
export {
  sandboxOwnerRegistrationOptionsSchema,
  sandboxScopeSchema,
} from './sandbox/ownership.js'
export type {
  SandboxAdministration,
  SandboxAdministrationOptions,
  SandboxListOptions,
  SandboxPurgeOptions,
  SandboxPurgeResult,
  SandboxResourcePage,
  SandboxResourceSummary,
  SandboxSelector,
  SandboxSnapshotDeleteOptions,
  SandboxSnapshotPolicy,
  SandboxSweepOptions,
  SandboxSweepResult,
  WorkspaceAdministrationOptions,
} from './sandbox/administration.js'
export {
  sandboxListOptionsSchema,
  sandboxPurgeOptionsSchema,
  sandboxSnapshotDeleteOptionsSchema,
  sandboxSweepOptionsSchema,
} from './sandbox/administration.js'
export { withSandboxTelemetry } from './sandbox/telemetry.js'
export type { SandboxTelemetryOperation } from './sandbox/telemetry.js'
export type { DirEntry, ExecOptions, ExecResult, FileStat } from './harness/types.js'

// Local durable execution
export {
  localDirectorySandbox,
  LocalDirectoryWorkspace,
  localDirectoryWorkspace,
  localDurableExecution,
  SqliteHarnessStorage,
  sqliteHarnessStorage,
} from './local/index.js'
export type {
  LocalDirectorySandboxOptions,
  LocalDirectoryWorkspaceOptions,
  LocalDurableExecution,
  LocalDurableExecutionOptions,
  LocalDurableSandbox,
  LocalExecSandboxCapabilities,
  LocalFilesOnlySandboxCapabilities,
  LocalHostExecPolicy,
  SqliteHarnessStorageOptions,
} from './local/index.js'

// Skills discovery
export { discoverSkills } from './skills/index.js'

// AI evaluation core
export {
  createDeterministicEvaluationScorer,
  evaluationResultToFeedbackRecords,
  runEvaluation,
  scoreEvaluation,
} from './eval/index.js'
export type {
  DeterministicEvaluationScorerDefinition,
  EvaluationAccounting,
  EvaluationAccountingSummary,
  EvaluationAggregateScope,
  EvaluationCandidate,
  EvaluationCandidateAggregate,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationCaseStatus,
  EvaluationCorrelation,
  EvaluationCost,
  EvaluationCoverage,
  EvaluationDataset,
  EvaluationDimensionAggregate,
  EvaluationDimensionDefinition,
  EvaluationDimensionResult,
  EvaluationDistribution,
  EvaluationErrorRecord,
  EvaluationEvidence,
  EvaluationExecutionProvenance,
  EvaluationFailurePolicy,
  EvaluationFeedbackProjectionOptions,
  EvaluationModelCall,
  EvaluationModelIdentity,
  EvaluationObservation,
  EvaluationRetryPolicy,
  EvaluationRunInput,
  EvaluationRunMode,
  EvaluationRunResult,
  EvaluationRunStatus,
  EvaluationScoreInput,
  EvaluationScorer,
  EvaluationScorerOutput,
  EvaluationScorerResultRecord,
  EvaluationScorerStatus,
  EvaluationScorerTarget,
  EvaluationTask,
  EvaluationTaskOutput,
  EvaluationTaskResultRecord,
  EvaluationTaskTarget,
  EvaluationTimeouts,
  EvaluationTrial,
} from './eval/index.js'

// Builder, harness, session, and handler context types
export { agentGuardrailsBinding, defineHarness, defineHarnessModule } from './harness/defineHarness.js'
export { agentExecutionRequirementsSchema } from './harness/agent-requirements.js'
export type { AgentExecutionRequirements } from './harness/agent-requirements.js'
export type {
  AgentContext,
  AgentContextMinimal,
  AgentGuardrailsBinding,
  AgentDefinition,
  AgentDefinitionCommon,
  AgentAfterModelInterceptorContext,
  AgentAfterToolInterceptorContext,
  AgentBeforeInputInterceptorContext,
  AgentBeforeModelInterceptorContext,
  AgentBeforeOutputInterceptorContext,
  AgentBeforeToolInterceptorContext,
  AgentInterceptorDecision,
  AgentInterceptorTransform,
  AgentExecutionInterception,
  AgentExecutionInterceptor,
  AgentExecutionInterceptorContext,
  AgentModelRequest,
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
  ConversationHistory,
  DelegationDefaults,
  DiscoveredSkills,
  DiscoverSkillsOptions,
  DurableInvokeOptions,
  ExecutionEvent,
  GovernanceApprovalProvider,
  GovernanceApprovalRequest,
  GovernanceApprovalResult,
  GovernanceApprovalSubject,
  GovernanceAuditRecord,
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
  GovernanceToolExposureContext,
  GovernanceToolExposurePolicy,
  GovernanceToolExposureRule,
  GovernanceToolExposureRuleForTool,
  GovernanceToolId,
  Harness,
  HarnessBuilder,
  HarnessContributionCatalog,
  HarnessDefinition,
  HarnessDefaults,
  HarnessEntryContract,
  HarnessTargetContract,
  HarnessTargetContracts,
  HarnessInstanceConfig,
  HarnessHostToolBindings,
  HarnessInterrupt,
  HarnessModule,
  HarnessModuleBuilder,
  HarnessOptions,
  InferTypes,
  InvokeOptions,
  McpAuth,
  McpHttpToolDefinition,
  McpPluginProvenance,
  McpStdioToolDefinition,
  ModelHandles,
  ModelRequirement,
  ModelRuntimeBinding,
  ModelTypesConfig,
  ModelsConfig,
  NativePolicyDefinition,
  NativePolicyRule,
  NativePolicyRuleForTool,
  PermissionMode,
  PermissionPolicy,
  OutputUpdateMode,
  ResolvedSkill,
  RunEvent,
  RunOutcome,
  RunSummary,
  HarnessRuntimeModels,
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
  AuthoredToolDefinition,
  AuthoredToolsConfig,
  HostToolBinding,
  HostToolDefinition,
  HostToolHandlerContext,
  ToolHandlerContext,
  ToolInput,
  ToolsConfig,
  TsToolDefinition,
  WorkflowAgentInvokeOptions,
  WorkflowChildTasks,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowDelegationPolicy,
  WorkflowFanOutOptions,
  WorkflowInput,
  WorkflowInvoker,
  WorkflowOutput,
  WorkflowsConfig,
} from './harness/defineHarness.js'
