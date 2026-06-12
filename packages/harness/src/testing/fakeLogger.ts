import type { Logger, LogLevel } from '../logger/index.js'

/** Single log record captured by {@link FakeLogger}. */
export interface FakeLogRecord {
  level: LogLevel
  msg: string
  /** RFC3339 timestamp of the record. */
  time: string
  /** Effective bindings (parent bindings merged with child bindings). */
  bindings: Record<string, unknown>
  fields?: Record<string, unknown>
}

/** Logger that captures records in memory for assertions. Child loggers share the parent's record list. */
export class FakeLogger implements Logger {
  public readonly records: FakeLogRecord[]

  public constructor(
    private readonly bindings: Record<string, unknown> = {},
    records?: FakeLogRecord[]
  ) {
    this.records = records ?? []
  }

  public trace(msg: string, fields?: Record<string, unknown>): void {
    this.capture('trace', msg, fields)
  }

  public debug(msg: string, fields?: Record<string, unknown>): void {
    this.capture('debug', msg, fields)
  }

  public info(msg: string, fields?: Record<string, unknown>): void {
    this.capture('info', msg, fields)
  }

  public warn(msg: string, fields?: Record<string, unknown>): void {
    this.capture('warn', msg, fields)
  }

  public error(msg: string, fields?: Record<string, unknown>): void {
    this.capture('error', msg, fields)
  }

  public fatal(msg: string, fields?: Record<string, unknown>): void {
    this.capture('fatal', msg, fields)
  }

  public child(bindings: Record<string, unknown>): Logger {
    return new FakeLogger({ ...this.bindings, ...bindings }, this.records)
  }

  /** Returns captured records filtered by level. */
  public recordsAt(level: LogLevel): FakeLogRecord[] {
    return this.records.filter((record) => record.level === level)
  }

  /** Clears all captured records. */
  public clear(): void {
    this.records.length = 0
  }

  private capture(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    this.records.push({
      level,
      msg,
      time: new Date().toISOString(),
      bindings: { ...this.bindings },
      ...(fields ? { fields } : {})
    })
  }
}
