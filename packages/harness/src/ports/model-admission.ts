import type { ModelProvider } from './model-provider.js'

/** Model operation admitted before a provider call starts. */
export type ModelAdmissionOperation =
  | 'text'
  | 'text_stream'
  | 'object'
  | 'object_stream'
  | 'embeddings'
  | 'rerank'

/** Stable provider identity used by local or distributed admission adapters. */
export interface ModelAdmissionKey {
  readonly providerId: string
  readonly genAiSystem: string
  readonly model: string
  readonly credentialScope: string
}

/** One cancellation-aware admission request. */
export interface ModelAdmissionRequest extends ModelAdmissionKey {
  readonly operation: ModelAdmissionOperation
  readonly signal: AbortSignal
}

/** Capacity lease held for exactly one provider call or consumed stream. */
export interface ModelAdmissionLease {
  release(): void | Promise<void>
}

/**
 * Runtime port for provider concurrency and rate admission.
 *
 * Implementations may coordinate locally or through distributed storage. They
 * must reject unavailable capacity with `ModelAdmissionRejectedError`, including
 * a retry delay when the caller can safely defer work to a queue.
 */
export interface ModelAdmission {
  acquire(request: ModelAdmissionRequest): Promise<ModelAdmissionLease>
}

/** Builds the stable admission key for one resolved model binding. */
export function modelAdmissionKey(
  provider: Pick<ModelProvider, 'id' | 'genAiSystem'>,
  model: string,
  credentialScope = 'default',
): ModelAdmissionKey {
  return Object.freeze({ providerId: provider.id, genAiSystem: provider.genAiSystem, model, credentialScope })
}
