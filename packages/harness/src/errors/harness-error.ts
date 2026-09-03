import { sanitizeMeta } from './redaction.js'

/**
 * Canonical harness error categories.
 *
 * Use these values for machine-readable error routing and operational dashboards.
 */
export type ErrorCategory =
  /** Invalid or inconsistent harness configuration. */
  | 'config'
  /** Input/output validation failures. */
  | 'validation'
  /** Permission and approval denials. */
  | 'permission'
  /** A provider-neutral agent interception denied or failed closed. */
  | 'interceptor'
  /** Sandbox filesystem or execution failures. */
  | 'sandbox'
  /** Model/provider invocation failures. */
  | 'model'
  /** Tool execution failures. */
  | 'tool'
  /** Skill discovery, loading, or manifest failures. */
  | 'skill'
  /** Session lifecycle failures. */
  | 'session'
  /** State-store persistence failures. */
  | 'state'
  /** Durable workspace lifecycle or backend failures. */
  | 'workspace'
  /** Timeout budget failures. */
  | 'timeout'
  /** Cooperative cancellation events. */
  | 'cancelled'
  /** Unclassified internal harness bugs. */
  | 'internal'

/** Construction options for {@link HarnessError}. */
export interface HarnessErrorOptions {
  code: string
  category: ErrorCategory
  message: string
  retriable: boolean
  meta?: Record<string, unknown>
  cause?: unknown
}

/**
 * Base class for all exported harness errors.
 *
 * Carries stable machine-readable fields (`code`, `category`, `retriable`, `meta`) for
 * API mapping, log processing, and operator automation.
 */
export class HarnessError extends Error {
  public readonly code: string
  public readonly category: ErrorCategory
  public readonly retriable: boolean
  public readonly meta: Record<string, unknown> | undefined
  public override readonly cause: unknown

  public constructor(opts: HarnessErrorOptions) {
    super(opts.message, { cause: opts.cause })
    this.name = new.target.name
    this.code = opts.code
    this.category = opts.category
    this.retriable = opts.retriable
    this.meta = opts.meta
    this.cause = opts.cause
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      retriable: this.retriable,
      message: this.message,
      ...(this.meta ? { meta: sanitizeMeta(this.meta) } : {}),
    }
  }
}

/** Harness type guard for {@link HarnessError}. */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError
}

/**
 * Converts an unknown thrown value into a stable envelope for trusted
 * persistence, run events, logging, and telemetry.
 *
 * This is not a public HTTP/queue error formatter. Unknown `Error` instances
 * retain their original message, and Harness error metadata can contain
 * operational identifiers. Map the envelope through an application-owned
 * allowlist before returning any part of it across an untrusted boundary.
 */
export function serializeError(error: unknown): {
  code: string
  category: string
  retriable: boolean
  message: string
  meta?: Record<string, unknown>
} {
  if (error instanceof HarnessError) {
    const serialized: {
      code: string
      category: string
      retriable: boolean
      message: string
      meta?: Record<string, unknown>
    } = {
      code: error.code,
      category: error.category,
      retriable: error.retriable,
      message: error.message,
    }
    const meta = sanitizeMeta(error.meta)
    if (meta) serialized.meta = meta
    return serialized
  }

  return {
    code: 'INTERNAL_ERROR',
    category: 'internal',
    retriable: false,
    message: error instanceof Error ? error.message : String(error),
  }
}
