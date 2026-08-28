import { defineHarness } from '../harness/defineHarness.js'

// Fakes
export { FakeModelProvider } from './fakeModelProvider.js'
export { FakeHarnessStorage, type FakeHarnessStorageOp } from './fakeHarnessStorage.js'
export { FakeSandbox, type FakeSandboxOptions } from './fakeSandbox.js'
export { FakeLogger, type FakeLogRecord } from './fakeLogger.js'
export { RecordingTelemetry, type RecordedTelemetryMetric, type RecordedTelemetrySpan } from './recordingTelemetry.js'
export { FakeMemoryEngine, memoryEngineContract } from './fakeMemoryEngine.js'
export { InMemoryDurableWorkspace, inMemoryDurableWorkspace } from '../workspace/index.js'
export { adapterCapabilitiesContract, fakeCapabilityAdapter, type FakeCapabilityAdapter } from './capabilities.js'
export { fakeSnapshotSandbox, sandboxSnapshotContract } from './sandboxSnapshot.js'

// Contract suites
export { harnessStorageContract } from './harnessStorageContract.js'
export { sandboxContract, sandboxMultiClientContract } from './sandboxContract.js'
export { modelProviderContract } from './modelProviderContract.js'
export { loggerContract } from './loggerContract.js'
export { durableWorkspaceContract } from './durableWorkspaceContract.js'

// Helpers
export { recordEvents } from './recordEvents.js'
export { createInMemoryFeedbackRecorder } from './feedback.js'
export { ReplayFixtureError, assertReplayConsumed, createReplayInteractionRecorder, replayModelProvider } from './replay.js'
export type { ReplayInteractionRecorder, ReplayModelProviderOptions, SanitizedReplayFixture, SanitizedReplayInteraction } from './replay.js'
export { DiagnosticInvariantError, assertDiagnosticInvariants } from './diagnostics.js'
export type { DiagnosticInvariantSnapshot, HarnessDiagnosticFinding, HarnessDiagnosticInvariant } from './diagnostics.js'

// AI eval test helpers (re-exported from the main entry for test ergonomics)
export { createDeterministicEvaluationScorer } from '../eval/index.js'
export type { DeterministicEvaluationScorerDefinition } from '../eval/index.js'

/** Returns a fresh harness builder for tests. */
export function makeHarness() {
  return defineHarness()
}
