import type {
  AgentAdmission,
  AgentAdmissionLease,
  AgentAdmissionRequest,
  ExecutionEvent,
  HarnessExecutionEventType,
  HarnessTargetStream,
  McpBinding,
  McpServerOptions,
  ModelRuntimeBinding,
} from '../src/index.js'
import { describe, expect, expectTypeOf, it } from 'vitest'

import * as mainEntry from '../src/index.js'
import * as testingEntry from '../src/testing/index.js'

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
  'WorkflowChildTargetError',
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
  'makeHarness',
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
		expectTypeOf<HarnessTargetStream<string>>().toExtend<AsyncIterable<ExecutionEvent<string>>>()
		expectTypeOf<HarnessTargetStream<string>['cancel']>().toEqualTypeOf<(reason?: string) => Promise<void>>()
	})

  it('publishes v4 runtime binding, admission, and event inventory types', () => {
    expectTypeOf<AgentAdmission['acquire']>().toBeFunction()
    expectTypeOf<AgentAdmissionRequest['signal']>().toEqualTypeOf<AbortSignal>()
    expectTypeOf<AgentAdmissionLease['release']>().toBeFunction()
    expectTypeOf<ModelRuntimeBinding>().toHaveProperty('provider')
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
      mainEntry.WorkflowChildTargetError,
      mainEntry.HostNestedTargetError,
      mainEntry.HostNestedTargetReplayConflictError,
      mainEntry.HarnessTargetRouteReceiptMismatchError,
      mainEntry.ChildTaskConflictError,
      mainEntry.ChildTaskStateError,
    ].every(value => typeof value === 'function')).toBe(true)
  })

  it('main entry exports exactly the locked value list', () => {
    expect(Object.keys(mainEntry).sort()).toEqual([...EXPECTED_MAIN_EXPORTS].sort())
  })

  it('testing subpath exports exactly the locked value list', () => {
    expect(Object.keys(testingEntry).sort()).toEqual([...EXPECTED_TESTING_EXPORTS].sort())
  })
})
