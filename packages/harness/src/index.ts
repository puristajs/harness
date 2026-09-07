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
  AgentAdmissionRejectedError,
  PermissionDeniedError,
  PolicyDeniedError,
  DecisionBlockedError,
  DecisionEvaluationError,
  ApprovalResumeError,
  WorkflowCallReplayConflictError,
  WorkflowAgentCallBudgetError,
  WorkflowChildTargetError,
  HostNestedTargetError,
  HostNestedTargetReplayConflictError,
  HarnessTargetRouteReceiptMismatchError,
  ChildTaskConflictError,
  ChildTaskStateError,
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
export { normalizeHarnessTraceContext } from './telemetry/trace-context.js'
export type { HarnessTraceContext } from './telemetry/trace-context.js'
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
  ArtifactBody,
  ArtifactPublishRequest,
  ArtifactReference,
  ArtifactStore,
} from './ports/artifact-store.js'
export type {
  BaseRequest,
  ContentPart,
  ContentPartKind,
  Embedding,
  EmbeddingRequest,
  EmbeddingResponse,
  FinishReason,
  ImageProviderResponse,
  ImageRequest,
  ImageResponse,
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
  ProviderArtifact,
  SpeechProviderResponse,
  SpeechRequest,
  SpeechResponse,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  TokenUsage,
  ToolCallSpec,
  VideoProviderResponse,
  VideoProviderStreamChunk,
  VideoRequest,
  VideoResponse,
  VideoStreamChunk,
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
export { inMemoryAgentAdmission } from './ports/agent-admission.js'
export type {
  AgentAdmission,
  AgentAdmissionLease,
  AgentAdmissionRequest,
  InMemoryAgentAdmissionOptions,
} from './ports/agent-admission.js'

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
} from './ports/capabilities.js'
export type { HarnessAdapterContext, HarnessContextConfigurable } from './ports/harness-context.js'

// Harness-owned persistence + in-memory default
export type { FinishRunPatch, HarnessStorage, HarnessStorageInfo } from './storage/types.js'
export { InMemoryHarnessStorage, inMemoryHarnessStorage } from './storage/in-memory.js'
export { isJsonValue } from './models/json.js'
export type { JsonValue } from './models/json.js'
export type { Infer, InferIn, ModelSchema, Schema } from './schema/index.js'
export type { Message, PersistedRunEvent, RunRecord, RunStatus, SessionRecord } from './models/state.js'
export { harnessExecutionEventTypesV1 } from './definitions/execution-events.js'
export type {
  ExecutionEvent,
  ExecutionEventCorrelation,
  HarnessExecutionEventType,
  HarnessTargetStream,
} from './definitions/execution-events.js'
export type {
  ToolApprovalDecision,
  ToolApprovalInterrupt,
  ToolApprovalRequest,
  ToolApprovalResume,
} from './approvals/index.js'

// Shared decision-boundary contracts
export {
  createDecisionEvidence,
  decisionEvidenceSchema,
  decisionFailureKindSchema,
  decisionOccurrenceSchema,
  parseProviderContinuation,
  decisionResultSchema,
  decisionSourceSchema,
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

// Composable v4 definitions and runtime
export { defineAgent, defineMcpServer, defineSkill, defineTool, defineWorkflow } from './definitions/index.js'
export { defineCatalog } from './definitions/catalog.js'
export { defineHarness } from './definitions/harness.js'
export { agentGuardrailsBinding } from './agents/guardrails.js'
export { builtInTools } from './tools/index.js'
export { agentExecutionRequirementsSchema } from './harness/agent-requirements.js'
export type { AgentExecutionRequirements } from './harness/agent-requirements.js'
export type {
  AgentGuardrailsBinding,
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
  AgentModelResponse,
  AgentPermissions,
  PermissionMode,
  PermissionPolicy,
} from './agents/guardrails.js'
export type {
  AgentDefinition,
  AgentInputCapability,
  AgentLoopOptions,
  AgentMemoryPolicy,
  AgentOptions,
  AgentPrompt,
  AgentSubagentMap,
  AgentSubagentReference,
  AnyAgentDefinition,
  AnyNonMcpToolDefinition,
  AnyToolDefinition,
  BuiltInToolDefinition,
  ChildTaskContextPolicy,
  ChildTaskDescriptor,
  ChildTaskHandle,
  ChildTaskMode,
  ChildTaskStartOptions,
  ChildTaskStatus,
  ContinuableChildTaskHandle,
  ContinuableChildTaskStartOptions,
  DefinitionInference,
  HarnessExecutionMode,
  HarnessInterruptKind,
  HarnessOutputUpdateKind,
  HarnessTargetContract,
  HarnessTargetKind,
  HostToolDefinition,
  McpServerDefinition,
  McpServerOptions,
  McpToolDefinition,
  McpToolOptions,
  ModelAliasId,
  SandboxCapabilityId,
  SkillDefinition,
  SkillOptions,
  SkillRuntimeId,
  ToolDefinition,
  ToolHandlerContext,
  ToolHandlerContextBase,
  ToolMemoryFacade,
  ToolOptions,
  ToolRequirements,
  ToolSandboxFacade,
  UserModelMessage,
  WorkflowAgentMap,
  WorkflowAgentCallLimits,
  WorkflowChildTasks,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowModelMap,
  WorkflowModelRequirement,
  WorkflowOptions,
} from './definitions/index.js'
export type { DefinitionReference } from './definitions/identity.js'
export type {
  CatalogOptions,
  HarnessCatalogDefinition,
  HarnessCatalogView,
  HarnessContracts,
  HarnessInfer,
  HarnessTargetInferMap,
} from './definitions/catalog.js'
export type { HarnessDefinition, HarnessInspection, HarnessOptions, HarnessTargetInspection } from './definitions/harness.js'
export type {
  AgentGovernanceAuthoringConfig,
  AgentGovernanceInput,
  AgentModelToolMap,
  GovernanceAuditRecord,
  GovernanceAuditSink,
  GovernanceConfig,
  GovernanceContext,
  GovernanceDecision,
  GovernanceDefinitionHelpers,
  GovernanceEffect,
  GovernanceExposureEffect,
  GovernanceMode,
  GovernancePolicyEvaluator,
  GovernanceToolDefinition,
  GovernanceToolExposureContext,
  GovernanceToolExposurePolicy,
  GovernanceToolExposureRule,
  GovernanceToolMap,
  NativePolicyDefinition,
  NativePolicyAuthoringDefinition,
  NativePolicyRule,
  NativePolicyRuleForTool,
  ResolvedAgentGovernance,
} from './governance/types.js'
export type { BuiltinToolName } from './tools/index.js'
export type { ContentCaptureMode, TelemetryFlavor, TelemetryOptions } from './telemetry/index.js'
export type { HarnessInterrupt, RunOutcome } from './runtime/outcomes.js'
export type { ConversationHistory, RunSummary, SessionChildTasks } from './runtime/session-contracts.js'
export type {
  DurableInvokeOptions,
  HarnessInstance,
  HarnessSession,
  HarnessSessionOptions,
  HarnessTargetInvoker,
  InvokeOptions,
} from './runtime/standalone-instance.js'
export type { HarnessInstanceConfig, McpBinding, ModelRuntimeBinding } from './runtime/instance-config.js'
export type { HarnessExecutionDefaults, ResolvedHarnessExecutionDefaults } from './runtime/execution-defaults.js'
export type { RuntimeRequirements, RuntimeRequirementsFor } from './runtime/runtime-requirements.js'
export type {
  DiscoveredSkills,
  DiscoveredSkillSource,
  DiscoverSkillsOptions,
  ResolvedSkill,
  SkillDiagnostic,
  SkillFrontmatter,
  SkillValidationMode,
} from './skills/index.js'
