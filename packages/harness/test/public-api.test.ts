import { describe, expect, it } from 'vitest'

import * as mainEntry from '../src/index.js'
import * as testingEntry from '../src/testing/index.js'

/**
 * Locked value-export surface of `@purista/harness` per specs/13-public-api.md.
 * Type-only exports are enforced by the explicit export lists in
 * `src/index.ts` / `src/testing/index.ts` (the compiler fails on drift).
 */
const EXPECTED_MAIN_EXPORTS = [
  'AgentLoopBudgetError',
  'AgentNotFoundError',
  'BaseModelProvider',
  'DelegationPolicyError',
  'DurableRunLeaseError',
  'DurableStepError',
  'DurableTerminalRunError',
  'HARNESS_VERSION',
  'HarnessConfigError',
  'HarnessError',
  'InMemoryDurableWorkspaceStore',
  'InMemoryStateStore',
  'InternalError',
  'JsonLogger',
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
  'StateStoreAdapterBase',
  'ToolError',
  'ToolNotFoundError',
  'ValidationError',
  'WorkflowNotFoundError',
  'WorkspaceCleanupError',
  'WorkspaceError',
  'WorkspaceQuotaExceededError',
  'accumulateStreamToolCallDeltas',
  'bashSandbox',
  'createDurableWorkflowContext',
  'createStreamToolCallState',
  'defineHarness',
  'defineHarnessModule',
  'discoverSkills',
  'evaluateDeterministicScorer',
  'evaluatePromptCandidates',
  'finalizeStreamToolCalls',
  'inMemoryDurableRuntime',
  'inMemoryDurableWorkspaceStore',
  'inMemorySandbox',
  'isHarnessError',
  'isReadOnlyMountCapableSession',
  'isResumeBlockingRunStatus',
  'isTerminalRunStatus',
  'localDirectorySandbox',
  'localDirectoryWorkspaceStore',
  'localDurableExecution',
  'malformedResponseError',
  'parseProviderJson',
  'projectToolResults',
  'redactProviderContent',
  'retainCompleteTurns',
  'safePartialJson',
  'sandboxMemory',
  'sanitizeProviderMessage',
  'serializeError',
  'sqliteContextCheckpointStore',
  'sqliteDurableRuntime',
  'sqliteStateStore',
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
  'FakeMemoryAdapter',
  'FakeModelProvider',
  'FakeSandbox',
  'FakeStateStore',
  'InMemoryDurableWorkspaceStore',
  'adapterCapabilitiesContract',
  'assertDiagnosticInvariants',
  'assertReplayConsumed',
  'createInMemoryFeedbackRecorder',
  'createReplayInteractionRecorder',
  'DiagnosticInvariantError',
  'durableWorkspaceStoreContract',
  'evaluateDeterministicScorer',
  'fakeCapabilityAdapter',
  'fakeSnapshotSandbox',
  'inMemoryDurableWorkspaceStore',
  'loggerContract',
  'makeHarness',
  'memoryAdapterContract',
  'modelProviderContract',
  'recordEvents',
  'ReplayFixtureError',
  'replayModelProvider',
  'sandboxContract',
  'sandboxSnapshotContract',
  'stateStoreContract'
]

describe('public API export surface (specs/13-public-api.md)', () => {
  it('main entry exports exactly the locked value list', () => {
    expect(Object.keys(mainEntry).sort()).toEqual([...EXPECTED_MAIN_EXPORTS].sort())
  })

  it('testing subpath exports exactly the locked value list', () => {
    expect(Object.keys(testingEntry).sort()).toEqual([...EXPECTED_TESTING_EXPORTS].sort())
  })
})
