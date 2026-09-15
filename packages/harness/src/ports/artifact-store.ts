import type { JsonValue } from '../models/json.js'

/** JSON-safe reference to an artifact published by the application. */
export interface ArtifactReference {
  /** Opaque application-owned identifier. */
  readonly id: string
  /** URL consumable by the intended client. It may be signed or authenticated. */
  readonly url: string
  /** IANA media type of the published content. */
  readonly mediaType: string
  readonly filename?: string
  readonly size?: number
  /** ISO-8601 expiry of a temporary URL, when applicable. */
  readonly expiresAt?: string
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

/** Non-serializable content supplied only to an {@link ArtifactStore}. */
export type ArtifactBody = Uint8Array | AsyncIterable<Uint8Array>

/** Content and trusted run scope supplied when publishing an artifact. */
export interface ArtifactPublishRequest {
  readonly body: ArtifactBody
  readonly mediaType: string
  readonly filename?: string
  readonly size?: number
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly scope: {
    readonly harnessName?: string
    readonly sessionId?: string
    readonly runId?: string
    readonly workflowId?: string
    readonly agentId?: string
  }
  /** Stable application key for retry-safe publication when available. */
  readonly idempotencyKey?: string
  readonly signal: AbortSignal
}

/**
 * Application-owned storage boundary for model-generated files.
 *
 * Implementations persist the supplied bytes and return a client-safe URL.
 * Provider URLs, credentials, and raw bytes must not be copied into the
 * returned reference.
 */
export interface ArtifactStore {
  publish(request: ArtifactPublishRequest): Promise<ArtifactReference>
  close?(): Promise<void>
}

