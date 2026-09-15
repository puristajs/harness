import type { ModelProvider } from './model-provider.js'
import type { HarnessExecutionCaller } from '../definitions/types.js'
import type { HarnessIdentity } from '../identity/index.js'

/** Model operation admitted before a provider call starts. */
export type ModelCallConcurrencyOperation =
  | 'text'
  | 'text_stream'
  | 'object'
  | 'object_stream'
  | 'embeddings'
  | 'rerank'
  | 'image_generation'
  | 'speech_generation'
  | 'video_generation'

/** Stable provider identity used by local or distributed concurrency adapters. */
export interface ModelCallConcurrencyKey {
  readonly providerId: string
  readonly genAiSystem: string
  readonly model: string
  readonly credentialScope: string
}

/** One cancellation-aware model-call concurrency request. */
export interface ModelCallConcurrencyRequest extends ModelCallConcurrencyKey {
  readonly operation: ModelCallConcurrencyOperation
  readonly harnessName?: string
  readonly sessionId?: string
  readonly runId?: string
  readonly caller?: HarnessExecutionCaller
  readonly identity?: HarnessIdentity
  readonly deadline?: number
  readonly signal: AbortSignal
}

/** Capacity lease held for exactly one provider call or consumed stream. */
export interface ModelCallConcurrencyLease {
  release(): void | Promise<void>
}

/**
 * Runtime port for provider concurrency and rate control.
 *
 * Implementations may coordinate locally or through distributed storage. They
 * must reject unavailable capacity with `ModelCallConcurrencyRejectedError`, including
 * a retry delay when the caller can safely defer work to a queue.
 */
export interface ModelCallConcurrency {
  acquire(request: ModelCallConcurrencyRequest): Promise<ModelCallConcurrencyLease>
}

/** Builds the stable concurrency key for one resolved model binding. */
export function modelCallConcurrencyKey(
  provider: Pick<ModelProvider, 'id' | 'genAiSystem'>,
  model: string,
  credentialScope = 'default',
): ModelCallConcurrencyKey {
  return Object.freeze({ providerId: provider.id, genAiSystem: provider.genAiSystem, model, credentialScope })
}
