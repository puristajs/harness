import type { Logger } from '../logger/index.js'
import type { Metrics, TelemetryShim } from '../telemetry/index.js'
import type { ContentCaptureMode } from '../harness/defineHarness.js'

/** Harness-level context inherited by adapters registered with the harness. */
export interface HarnessAdapterContext {
  harnessName: string
  logger: Logger
  telemetry: TelemetryShim
  metrics: Metrics
  contentCaptureMode: ContentCaptureMode
  defaults: {
    agentMaxIterations: number
    runTimeoutMs: number
    toolTimeoutMs: number
    decisionTimeoutMs: number
    skillTimeoutMs: number
    modelTimeoutMs: number
    maxParallelToolCalls: number
    historyWindow?: number
  }
}

/** Optional structural hook implemented by adapter base classes. */
export interface HarnessContextConfigurable {
  configureHarnessContext(context: HarnessAdapterContext): void
}
