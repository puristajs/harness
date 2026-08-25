import { describe, expect, it } from 'vitest'

import * as mainEntry from '../src/index.js'
import * as testingEntry from '../src/testing/index.js'

/**
 * Locked value-export surface of `@purista/harness` per specs/13-public-api.md.
 * Type-only exports are enforced by the explicit export lists in
 * `src/index.ts` / `src/testing/index.ts` (the compiler fails on drift).
 */
const EXPECTED_MAIN_EXPORTS = [
  'AgentInterceptorError',
  'AgentLoopBudgetError',
  'AgentNotFoundError',
  'BaseModelProvider',
  'DelegationPolicyError',
  'DurableRunLeaseError',
  'DurableStepError',
  'DurableTerminalRunError',
  'ExternalWaitError',
  'ExternalWaitPendingError',
  'HARNESS_VERSION',
  'HarnessConfigError',
  'HarnessError',
  'InMemoryHarnessStorage',
  'InMemoryDurableWorkspace',
  'InternalError',
  'JsonLogger',
  'LocalDirectoryWorkspace',
  'McpAuthError',
  'McpProtocolError',
  'ModelCapabilityError',
  'ModelError',
  'OperationCancelledError',
  'OperationTimeoutError',
  'PermissionDeniedError',
  'PolicyDeniedError',
  'PolicyEvaluationError',
  'SandboxError',
  'SandboxNoExecutorError',
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
  'WorkspaceCleanupError',
  'WorkspaceError',
  'WorkspaceQuotaExceededError',
  'accumulateStreamToolCallDeltas',
  'bashSandbox',
  'createTelemetryShim',
  'createStreamToolCallState',
  'defineHarness',
  'defineHarnessModule',
  'discoverSkills',
  'evaluateDeterministicScorer',
  'evaluatePromptCandidates',
  'finalizeStreamToolCalls',
  'inMemoryHarnessStorage',
  'inMemoryDurableWorkspace',
  'inMemorySandbox',
  'isHarnessError',
  'isReadOnlyMountCapableSession',
  'isResumeBlockingRunStatus',
  'isTerminalRunStatus',
  'localDirectorySandbox',
  'localDirectoryWorkspace',
  'localDurableExecution',
  'malformedResponseError',
  'parseProviderJson',
  'projectToolResults',
  'redactProviderContent',
  'retainCompleteTurns',
  'safePartialJson',
  'inMemoryMemoryEngine',
  'sanitizeProviderMessage',
  'serializeError',
  'sqliteHarnessStorage',
  'toTokenUsage',
  'ulid',
  'validateContextProjection',
  'validateSessionHistoryRetention',
  'messageStorageBytes',
  'withoutObjectTool'
]

/** Locked value-export surface of `@purista/harness/testing` per specs/13-public-api.md. */
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
  'evaluateDeterministicScorer',
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
  'sandboxSnapshotContract',
  'harnessStorageContract'
]

describe('public API export surface (specs/13-public-api.md)', () => {
  it('main entry exports exactly the locked value list', () => {
    expect(Object.keys(mainEntry).sort()).toEqual([...EXPECTED_MAIN_EXPORTS].sort())
  })

  it('testing subpath exports exactly the locked value list', () => {
    expect(Object.keys(testingEntry).sort()).toEqual([...EXPECTED_TESTING_EXPORTS].sort())
  })
})
