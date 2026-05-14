import { defineHarness } from '../harness/defineHarness.js'

export { FakeModelProvider } from './fakeModelProvider.js'
export { FakeMemoryAdapter, memoryAdapterContract } from './fakeMemoryAdapter.js'
export { adapterCapabilitiesContract, fakeCapabilityAdapter, type FakeCapabilityAdapter } from './capabilities.js'
export { createInMemoryFeedbackRecorder } from './feedback.js'
export { evaluateDeterministicScorer } from '../eval/index.js'
export type { DeterministicScorerDefinition, ScorerResult, ScorerTarget } from '../eval/index.js'
export { sandboxContract } from './sandboxContract.js'
export { fakeSnapshotSandbox, sandboxSnapshotContract } from './sandboxSnapshot.js'
export { stateStoreContract } from './stateStoreContract.js'

/** Returns a fresh harness builder for tests. */
export function makeHarness() {
  return defineHarness()
}
