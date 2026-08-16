import { defineHarness } from '../harness/defineHarness.js'

// Fakes
export { FakeModelProvider } from './fakeModelProvider.js'
export { FakeStateStore, type FakeStateStoreOp } from './fakeStateStore.js'
export { FakeSandbox, type FakeSandboxOptions } from './fakeSandbox.js'
export { FakeLogger, type FakeLogRecord } from './fakeLogger.js'
export { FakeMemoryAdapter, memoryAdapterContract } from './fakeMemoryAdapter.js'
export { InMemoryDurableWorkspaceStore, inMemoryDurableWorkspaceStore } from '../workspace/index.js'
export { adapterCapabilitiesContract, fakeCapabilityAdapter, type FakeCapabilityAdapter } from './capabilities.js'
export { fakeSnapshotSandbox, sandboxSnapshotContract } from './sandboxSnapshot.js'

// Contract suites
export { stateStoreContract } from './stateStoreContract.js'
export { sandboxContract } from './sandboxContract.js'
export { modelProviderContract } from './modelProviderContract.js'
export { loggerContract } from './loggerContract.js'
export { durableWorkspaceStoreContract } from './durableWorkspaceStoreContract.js'

// Helpers
export { recordEvents } from './recordEvents.js'
export { createInMemoryFeedbackRecorder } from './feedback.js'
export { ReplayFixtureError, assertReplayConsumed, createReplayInteractionRecorder, replayModelProvider } from './replay.js'
export type { ReplayInteractionRecorder, ReplayModelProviderOptions, SanitizedReplayFixture, SanitizedReplayInteraction } from './replay.js'
export { DiagnosticInvariantError, assertDiagnosticInvariants } from './diagnostics.js'
export type { DiagnosticInvariantSnapshot, HarnessDiagnosticFinding, HarnessDiagnosticInvariant } from './diagnostics.js'

// AI eval test helpers (re-exported from the main entry for test ergonomics)
export { evaluateDeterministicScorer } from '../eval/index.js'
export type { DeterministicScorerDefinition, ScorerResult, ScorerTarget } from '../eval/index.js'

/** Returns a fresh harness builder for tests. */
export function makeHarness() {
  return defineHarness()
}
