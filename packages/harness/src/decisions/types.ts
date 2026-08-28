import type { z } from 'zod'
import type {
  createDecisionEvidenceInputSchema,
  decisionEvidenceSchema,
  decisionFailureKindSchema,
  decisionOccurrenceSchema,
  providerContinuationItemSchema,
  providerContinuationSchema,
  decisionSourceSchema
} from './schemas.js'

/** Content-free configuration identity for a decision boundary. */
export type DecisionSource = z.output<typeof decisionSourceSchema>

/** Invocation correlation used exclusively to create deterministic decision IDs. */
export type DecisionOccurrence = z.output<typeof decisionOccurrenceSchema>

/** Content-free evidence suitable for logs, metrics, and safe errors. */
export type DecisionEvidence = z.output<typeof decisionEvidenceSchema>

/** Fail-closed classification for a decision callback failure. */
export type DecisionFailureKind = z.output<typeof decisionFailureKindSchema>

/** Provider-neutral continuation template for one transient assistant turn. */
export type ProviderContinuation = z.output<typeof providerContinuationSchema>

/** A provider-owned opaque item, canonical tool-call slot, or assistant-content slot. */
export type ProviderContinuationItem = z.output<typeof providerContinuationItemSchema>

/** Strict input accepted by {@link createDecisionEvidence}. */
export type CreateDecisionEvidenceInput = z.input<typeof createDecisionEvidenceInputSchema>

/** Cancellation and deadline supplied to one bounded decision callback. */
export interface DecisionExecutionContext {
  readonly signal: AbortSignal
  readonly deadline: number
}
