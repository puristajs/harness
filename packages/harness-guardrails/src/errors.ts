import { HarnessError } from '@purista/harness'
import { z } from 'zod'

/** Stable safe reason codes emitted by configuration and compilation boundaries. */
export const guardrailsConfigErrorReasonSchema = z.enum([
  'invalid_shape', 'action_missing', 'invalid_action', 'missing_policy', 'unsupported_entity', 'model_missing', 'model_capability_missing'
])

/** A stable safe reason code emitted by configuration and compilation boundaries. */
export type GuardrailsConfigErrorReason = z.output<typeof guardrailsConfigErrorReasonSchema>

/** Redacted structured metadata for a guardrails configuration failure. */
export const guardrailsConfigErrorMetaSchema = z.strictObject({
  reason: guardrailsConfigErrorReasonSchema,
  field: z.string().optional(),
  flowId: z.string().optional(),
  modelAlias: z.string().optional()
})

/** Redacted structured metadata for a guardrails configuration failure. */
export type GuardrailsConfigErrorMeta = z.output<typeof guardrailsConfigErrorMetaSchema>

/** Fixed safe configuration error with no caller-controlled message or cause. */
export class GuardrailsConfigError extends HarnessError {
  public constructor(meta: GuardrailsConfigErrorMeta) {
    super({ code: 'GUARDRAILS_CONFIG_ERROR', category: 'config', retriable: false, message: 'Guardrails configuration is invalid.', meta: normalizeMeta(meta) })
  }
}

function normalizeMeta(meta: unknown): GuardrailsConfigErrorMeta {
  try {
    const parsed = guardrailsConfigErrorMetaSchema.safeParse(meta)
    return parsed.success ? parsed.data : { reason: 'invalid_shape' }
  } catch {
    return { reason: 'invalid_shape' }
  }
}
