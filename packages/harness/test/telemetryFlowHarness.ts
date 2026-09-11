import type { Logger } from '../src/logger/index.js'

export { RecordingTelemetry } from '../src/testing/recordingTelemetry.js'

/** Content-capturing logger used only by hermetic telemetry tests. */
export class RecordingLogger implements Logger {
  public readonly entries: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
  public trace(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'trace', msg, fields }) }
  public debug(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'debug', msg, fields }) }
  public info(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'info', msg, fields }) }
  public warn(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'warn', msg, fields }) }
  public error(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'error', msg, fields }) }
  public fatal(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'fatal', msg, fields }) }
  public child(): Logger { return this }
}
