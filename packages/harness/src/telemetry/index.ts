export * from './shim.js'

/** OpenTelemetry semantic convention projection emitted by the Harness. */
export type TelemetryFlavor = 'dual' | 'gen_ai_only' | 'openinference_only'
/** Controls whether model and tool content may be attached to spans or events. */
export type ContentCaptureMode = 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'
/** Harness telemetry configuration. */
export interface TelemetryOptions {
  readonly flavor?: TelemetryFlavor
  readonly contentCaptureMode?: ContentCaptureMode
}
