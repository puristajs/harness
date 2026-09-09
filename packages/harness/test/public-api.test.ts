import type {
  AgentResponseMode,
  AnyHarnessTargetContract,
  AgentAdmission,
  AgentAdmissionLease,
  AgentAdmissionRequest,
  InMemoryAgentAdmissionOptions,
  ExecutionEvent,
  ExecutionTerminalOutcome,
  HarnessExecutionCaller,
  HarnessExecutionEventType,
  HarnessInterruptForKinds,
  HarnessTargetExecutionEvent,
  HarnessTargetDefinitionInference,
  HarnessTargetExecutionTerminalOutcome,
  HarnessTargetInferenceFor,
  HarnessTargetInput,
  HarnessTargetOutput,
  HarnessTargetRunOutcome,
  HarnessTargetStream,
  HarnessValidatedTargetInput,
  HarnessUpdateFor,
  McpServerInference,
  McpBinding,
  McpServerOptions,
  ModelRuntimeBinding,
	NestedExecutionEvent,
	RootExecutionEventFor,
	SkillInference,
	WorkflowCallCheckpointV1,
	WorkflowCallStoredErrorV1,
	WorkflowCallStoredOutcomeV1,
	WorkflowManagedCallOperation,
	WorkflowModelCallOptions,
	WorkflowToolCallOptions,
	WorkflowToolDefinitions,
} from '../src/index.js'
import { describe, expect, expectTypeOf, it } from 'vitest'

import * as mainEntry from '../src/index.js'
import * as adapterEntry from '../src/adapter/index.js'
import * as integratorEntry from '../src/integrator/index.js'
import * as testingEntry from '../src/testing/index.js'
import type {
	HarnessTargetDefinitionInference as DefinitionsHarnessTargetDefinitionInference,
	HarnessTargetInferenceFor as DefinitionsHarnessTargetInferenceFor,
	HarnessTargetExecutionEvent as DefinitionsHarnessTargetExecutionEvent,
	McpServerInference as DefinitionsMcpServerInference,
	NestedExecutionEvent as DefinitionsNestedExecutionEvent,
	RootExecutionEventFor as DefinitionsRootExecutionEventFor,
	SkillInference as DefinitionsSkillInference,
	WorkflowModelCallOptions as DefinitionsWorkflowModelCallOptions,
	WorkflowToolCallOptions as DefinitionsWorkflowToolCallOptions,
	WorkflowToolDefinitions as DefinitionsWorkflowToolDefinitions,
} from '../src/definitions/index.js'

type PublicWorkflowTypes = readonly [
	WorkflowToolDefinitions, WorkflowToolCallOptions, WorkflowModelCallOptions,
	DefinitionsWorkflowToolDefinitions, DefinitionsWorkflowToolCallOptions, DefinitionsWorkflowModelCallOptions,
]
const publicWorkflowTypes: PublicWorkflowTypes | undefined = undefined
void publicWorkflowTypes

type PublicInferenceAndEventAliases = readonly [
	DefinitionsHarnessTargetDefinitionInference<AnyHarnessTargetContract>,
	DefinitionsHarnessTargetInferenceFor<string, string, string, 'text-delta', readonly []>,
	DefinitionsHarnessTargetExecutionEvent<AnyHarnessTargetContract>,
	DefinitionsMcpServerInference<Readonly<Record<string, import('../src/index.js').McpToolDefinition>>>,
	DefinitionsNestedExecutionEvent,
	DefinitionsRootExecutionEventFor<AnyHarnessTargetContract>,
	DefinitionsSkillInference<readonly ['node']>,
]
const publicInferenceAndEventAliases: PublicInferenceAndEventAliases | undefined = undefined
void publicInferenceAndEventAliases

/**
 * Locked value-export surface of `@purista/harness` for the v4 clean break.
 * Type-only exports are enforced by the explicit export lists in
 * `src/index.ts` / `src/testing/index.ts` (the compiler fails on drift).
 */
const EXPECTED_MAIN_EXPORTS = [
  'AgentLoopBudgetError',
  'AgentAdmissionRejectedError',
  'AgentNotFoundError',
  'BaseModelProvider',
  'DecisionBlockedError',
  'DecisionEvaluationError',
  'ApprovalResumeError',
  'ChildTaskConflictError',
  'ChildTaskStateError',
  'DelegationPolicyError',
  'DurableRunLeaseError',
  'DurableStepError',
  'DurableTerminalRunError',
  'ExternalWaitError',
  'HARNESS_VERSION',
  'HarnessConfigError',
  'HarnessTargetRouteReceiptMismatchError',
  'HostNestedTargetError',
  'HostNestedTargetReplayConflictError',
  'HarnessError',
  'InMemoryHarnessStorage',
  'InMemoryDurableWorkspace',
  'InternalError',
  'JsonLogger',
  'LocalDirectoryWorkspace',
  'McpAuthError',
  'McpProtocolError',
  'ModelAdmissionRejectedError',
  'ModelCapabilityError',
  'ModelError',
  'OperationCancelledError',
  'OperationTimeoutError',
  'PermissionDeniedError',
  'PolicyDeniedError',
  'SANDBOX_TEXT_SEARCH_LIMITS',
  'SandboxError',
  'SandboxConflictError',
  'SandboxNoExecutorError',
  'SandboxPermissionDeniedError',
  'SandboxQuotaExceededError',
  'SandboxStateLostError',
  'SessionBusyError',
  'SessionNotFoundError',
  'SkillManifestError',
  'SkillNotFoundError',
  'SqliteHarnessStorage',
  'StateError',
  'ToolError',
  'ToolNotFoundError',
  'ValidationError',
  'WorkflowNotFoundError',
  'WorkflowAgentCallBudgetError',
  'WorkflowCallReplayConflictError',
  'WorkflowManagedCallError',
  'WorkspaceCleanupError',
  'WorkspaceError',
  'WorkspaceQuotaExceededError',
  'accumulateStreamToolCallDeltas',
  'agentExecutionRequirementsSchema',
  'agentGuardrailsBinding',
  'bashSandbox',
  'builtInTools',
  'compileSafeRegex',
  'createTelemetryShim',
  'createDecisionEvidence',
  'createStreamToolCallState',
  'decisionEvidenceSchema',
  'decisionFailureKindSchema',
  'decisionOccurrenceSchema',
  'decisionResultSchema',
  'decisionSourceSchema',
  'defineHarness',
  'defineAgent',
  'defineCatalog',
  'defineMcpServer',
  'defineSkill',
  'defineTool',
  'defineWorkflow',
  'discoverSkills',
  'createDeterministicEvaluationScorer',
  'finalizeStreamToolCalls',
  'governanceDecisionSchema',
  'harnessExecutionEventTypesV1',
  'providerContinuationItemSchema',
  'providerContinuationSchema',
  'inMemoryHarnessStorage',
  'inMemoryAgentAdmission',
  'inMemoryDurableWorkspace',
  'inMemorySandbox',
  'isJsonValue',
  'isHarnessError',
  'isReadOnlyMountCapableSession',
  'isExecCapableSession',
  'isSpawnCapableSession',
  'isResumeBlockingRunStatus',
  'isTerminalRunStatus',
  'isTextSearchCapableSession',
  'localDirectorySandbox',
  'localDirectoryWorkspace',
  'localDurableExecution',
  'malformedResponseError',
  'parseProviderJson',
  'parseProviderContinuation',
  'projectToolResults',
  'redactProviderContent',
  'retainCompleteTurns',
  'runEvaluation',
  'runDecisionOperation',
  'safePartialJson',
  'scoreEvaluation',
  'sandboxListOptionsSchema',
  'sandboxOwnerRegistrationOptionsSchema',
  'sandboxPurgeOptionsSchema',
  'sandboxScopeSchema',
  'sandboxSnapshotDeleteOptionsSchema',
  'sandboxSweepOptionsSchema',
  'inMemoryMemoryEngine',
  'sanitizeProviderMessage',
  'serializeError',
  'sqliteHarnessStorage',
  'toTokenUsage',
  'ulid',
  'validateContextProjection',
  'validateSessionHistoryRetention',
  'validateSandboxTextSearchRequest',
  'messageStorageBytes',
  'modelAdmissionKey',
  'normalizeHarnessTraceContext',
  'withoutObjectTool',
  'evaluationResultToFeedbackRecords',
  'withSandboxTelemetry',
]

/** Locked v4 value-export surface of `@purista/harness/testing`. */
const EXPECTED_TESTING_EXPORTS = [
  'FakeLogger',
  'FakeMemoryEngine',
  'FakeModelProvider',
  'FakeSandbox',
  'FakeHarnessStorage',
  'InMemoryDurableWorkspace',
  'adapterCapabilitiesContract',
  'assertDiagnosticInvariants',
  'assertReplayConsumed',
  'createInMemoryFeedbackRecorder',
  'createReplayInteractionRecorder',
  'DiagnosticInvariantError',
  'durableWorkspaceContract',
  'createDeterministicEvaluationScorer',
  'fakeCapabilityAdapter',
  'fakeSnapshotSandbox',
  'inMemoryDurableWorkspace',
  'loggerContract',
  'memoryEngineContract',
  'modelProviderContract',
  'recordEvents',
  'ReplayFixtureError',
  'RecordingTelemetry',
  'replayModelProvider',
  'sandboxContract',
  'sandboxMultiClientContract',
  'sandboxSnapshotContract',
  'sandboxTextSearchContract',
  'harnessStorageContract',
]

/** Locked v4 value-export surface of `@purista/harness/adapter`. */
const EXPECTED_ADAPTER_EXPORTS = [
  'asExternalWaitResolved',
  'assertSessionSandboxBindingTransition',
  'createExternalWaitCancellation',
  'normalizeSkillRuntimes',
  'projectExternalWaitRequest',
  'sameHarnessIdentity',
  'sandboxScopeKey',
  'validateBoundExternalWaitRequest',
  'validateExternalWaitId',
  'validateExternalWaitRegistration',
  'validateExternalWaitSignal',
  'validateExternalWaitSignalResult',
  'validateExternalWaitSnapshot',
  'validateSandboxOpenOptions',
  'validateSandboxScope',
  'validateSandboxTerminateOptions',
]

/** Locked v4 value-export surface of `@purista/harness/integrator`. */
const EXPECTED_INTEGRATOR_EXPORTS = [
  'assertHarnessHostToolOwner',
  'createHostOwnerToken',
  'defineHostTool',
  'instantiateHostedHarness',
  'isHarnessTargetContract',
  'visitHostedHarnessTargets',
]

describe('v4 public API export surface', () => {
	it('publishes the canonical frozen trace-context normalizer', () => {
		const carrier = mainEntry.normalizeHarnessTraceContext({
			traceparent: '00-00000000000000000000000000000001-0000000000000001-03',
			tracestate: 'vendor=value',
		})
		expect(carrier).toEqual({
			traceparent: '00-00000000000000000000000000000001-0000000000000001-03',
			tracestate: 'vendor=value',
		})
		expect(Object.isFrozen(carrier)).toBe(true)
		expect(() => mainEntry.normalizeHarnessTraceContext({ traceparent: 'invalid' })).toThrow(mainEntry.HarnessConfigError)
	})

	it('publishes the canonical cancellable target event stream from the root', () => {
		const definition = mainEntry.defineAgent('publicApiTarget', { instructions: 'Answer.' })
		const target = definition.contract
		const mcp = mainEntry.defineMcpServer('publicApiMcp', {
			tools: { lookup: { remoteName: 'lookup', description: 'Look up.', input: target.input, output: target.output } },
		})
		const skill = mainEntry.defineSkill('public-api-skill', {
			directory: new URL('./public-api-skill/', import.meta.url), runtimes: ['node', 'shell'],
		})
		expectTypeOf<typeof target>().toExtend<AnyHarnessTargetContract>()
		expectTypeOf<HarnessTargetDefinitionInference<typeof target>>().toEqualTypeOf<typeof definition.$infer>()
		expectTypeOf<HarnessTargetInput<typeof target>>().toEqualTypeOf<string>()
		expectTypeOf<HarnessValidatedTargetInput<typeof target>>().toEqualTypeOf<string>()
		expectTypeOf<HarnessTargetOutput<typeof target>>().toEqualTypeOf<string>()
		expectTypeOf<HarnessTargetExecutionEvent<typeof target>>().toExtend<ExecutionEvent<string>>()
		expectTypeOf<HarnessTargetExecutionEvent<typeof target>>()
			.toEqualTypeOf<RootExecutionEventFor<typeof target> | NestedExecutionEvent>()
		expectTypeOf<McpServerInference<typeof mcp.tools>>().toEqualTypeOf<typeof mcp.$infer>()
		expectTypeOf<SkillInference<readonly ['node', 'shell']>>().toEqualTypeOf<typeof skill.$infer>()
		expectTypeOf<HarnessTargetStream<typeof target>>().toExtend<AsyncIterable<ExecutionEvent<string>>>()
		expectTypeOf<HarnessTargetStream<typeof target>['cancel']>().toEqualTypeOf<(reason?: string) => Promise<void>>()
		expectTypeOf<HarnessTargetStream<typeof target>['result']>().toEqualTypeOf<Promise<HarnessTargetExecutionTerminalOutcome<typeof target>>>()
		expectTypeOf<HarnessTargetRunOutcome<typeof target>>().toMatchTypeOf<
			| { readonly status: 'completed'; readonly runId: string; readonly output: string }
			| { readonly status: 'interrupted'; readonly runId: string; readonly interrupt: never }
		>()
		expectTypeOf<ExecutionTerminalOutcome<string, never>>().toMatchTypeOf<
			HarnessTargetExecutionTerminalOutcome<typeof target>>()
		expectTypeOf<HarnessTargetInferenceFor<string, string, string, 'text-delta', readonly []>['update']>()
			.toEqualTypeOf<string>()
		expectTypeOf<HarnessUpdateFor<typeof target.output, 'none'>>().toEqualTypeOf<never>()
		expectTypeOf<HarnessInterruptForKinds<readonly []>>().toEqualTypeOf<never>()
		expectTypeOf<AgentResponseMode>().toEqualTypeOf<'text' | 'structured'>()
		expectTypeOf<HarnessExecutionCaller>().toMatchTypeOf<
			| Readonly<{ kind: 'agent'; agentId: string; workflowId?: string }>
			| Readonly<{ kind: 'workflow'; workflowId: string; agentId?: never }>
		>()
	})

  it('publishes v4 runtime binding, admission, and event inventory types', () => {
    expectTypeOf<AgentAdmission['acquire']>().toBeFunction()
    expectTypeOf<AgentAdmissionRequest['signal']>().toEqualTypeOf<AbortSignal>()
    expectTypeOf<AgentAdmissionLease['release']>().toBeFunction()
    expectTypeOf<InMemoryAgentAdmissionOptions>().toEqualTypeOf<{
      readonly maxConcurrent: number
      readonly maxQueued?: number
      readonly retryAfterMs?: number
    }>()
    expectTypeOf<ModelRuntimeBinding>().toHaveProperty('provider')
		expectTypeOf<WorkflowManagedCallOperation>().toEqualTypeOf<
			'agent_run' | 'tool_run' | 'model_text' | 'model_text_stream' | 'model_object' | 'model_object_stream'
			| 'model_embed' | 'model_rerank' | 'model_image' | 'model_speech' | 'model_video' | 'model_video_stream'
		>()
		expectTypeOf<WorkflowCallCheckpointV1['outcome']>().toEqualTypeOf<WorkflowCallStoredOutcomeV1>()
		expectTypeOf<Extract<WorkflowCallStoredErrorV1, { code: 'WORKFLOW_MANAGED_CALL_FAILED' }>['meta']>().toEqualTypeOf<Readonly<{
			reason: 'operation_failed'; workflow_id: string; call_id: string; operation: WorkflowManagedCallOperation
			target_kind: 'agent' | 'tool' | 'model'; target_id: string
		}>>()
    expectTypeOf<McpBinding['transport']>().toEqualTypeOf<'http' | 'stdio'>()
    expectTypeOf<McpServerOptions<{ lookup: {
      remoteName: string
      description: string
      input: import('../src/index.js').ModelSchema
      output: import('../src/index.js').Schema
    } }>>().toHaveProperty('tools')
    expectTypeOf<HarnessExecutionEventType>().toEqualTypeOf<(typeof mainEntry.harnessExecutionEventTypesV1)[number]>()
  })

  it('publishes the v4 runtime error constructors from the package root', () => {
    expect([
      mainEntry.ApprovalResumeError,
      mainEntry.WorkflowCallReplayConflictError,
      mainEntry.WorkflowAgentCallBudgetError,
      mainEntry.WorkflowManagedCallError,
      mainEntry.HostNestedTargetError,
      mainEntry.HostNestedTargetReplayConflictError,
      mainEntry.HarnessTargetRouteReceiptMismatchError,
      mainEntry.ChildTaskConflictError,
      mainEntry.ChildTaskStateError,
    ].every(value => typeof value === 'function')).toBe(true)
		const managed = new mainEntry.WorkflowManagedCallError({ reason: 'operation_failed', workflow_id: 'flow', call_id: 'call',
			operation: 'tool_run', target_kind: 'tool', target_id: 'lookup' }, new Error('private'))
		expect(managed).toMatchObject({ code: 'WORKFLOW_MANAGED_CALL_FAILED', message: 'Workflow managed call failed.', category: 'internal', retriable: false,
			meta: { reason: 'operation_failed', workflow_id: 'flow', call_id: 'call', operation: 'tool_run', target_kind: 'tool', target_id: 'lookup' } })
		expect(Object.keys(managed.meta)).toEqual(['reason', 'workflow_id', 'call_id', 'operation', 'target_kind', 'target_id'])
  })

  it('main entry exports exactly the locked value list', () => {
    expect('normalizeSkillRuntimes' in mainEntry).toBe(false)
    expect(Object.keys(mainEntry).sort()).toEqual([...EXPECTED_MAIN_EXPORTS].sort())
  })

  it('testing subpath exports exactly the locked value list', () => {
    expect(Object.keys(testingEntry).sort()).toEqual([...EXPECTED_TESTING_EXPORTS].sort())
  })

  it('adapter subpath exports exactly the locked value list', () => {
    expect(Object.keys(adapterEntry).sort()).toEqual([...EXPECTED_ADAPTER_EXPORTS].sort())
  })

  it('integrator subpath exports exactly the locked value list', () => {
    expect(Object.keys(integratorEntry).sort()).toEqual([...EXPECTED_INTEGRATOR_EXPORTS].sort())
  })
})
