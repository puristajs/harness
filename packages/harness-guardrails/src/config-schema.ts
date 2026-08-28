import { z } from 'zod'

/** The guardrail boundaries that may carry an ordered action flow. */
export const guardrailPhases = ['input', 'output', 'tool_input', 'tool_output', 'retrieval'] as const

/** One of the supported guardrail boundaries. */
export type GuardrailPhase = typeof guardrailPhases[number]

const actionIdSchema = z.string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'Action IDs must not be whitespace only.')
  .describe('A nonempty, non-whitespace-only action identifier. IDs are preserved exactly.')

const flowSchema = z.strictObject({
  flows: z.array(actionIdSchema)
    .refine((flows) => new Set(flows).size === flows.length, 'Action flow IDs must be distinct.')
    .describe('Ordered action IDs for this phase. An empty array disables the phase.')
}).describe('One phase-specific ordered guardrail flow.')

const sensitiveDataPolicySchema = z.strictObject({
  entities: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
    .min(1)
    .refine((entities) => new Set(entities).size === entities.length, 'Sensitive-data entities must be distinct.')
    .describe('Distinct detector entity identifiers.'),
  maskToken: z.string().max(128).describe('Replacement text for detected values. An empty string is allowed.'),
  scoreThreshold: z.number().finite().min(0).max(1).describe('Detector score threshold from zero through one.')
}).describe('Explicit sensitive-data policy for one supported phase.')

/** The single runtime source of truth for guardrail configuration. */
export const guardrailsConfigSchema = z.strictObject({
  rails: z.strictObject({
    input: flowSchema.optional().describe('Flows before the user message reaches the model.'),
    output: flowSchema.optional().describe('Flows before the final model response is returned.'),
    tool_input: flowSchema.optional().describe('Flows before an enabled tool runs.'),
    tool_output: flowSchema.optional().describe('Flows after an enabled tool returns.'),
    retrieval: flowSchema.optional().describe('Flows over caller-owned retrieval chunks.')
  }).default({}).describe('Phase-specific action flow bindings.'),
  sensitiveData: z.strictObject({
    input: sensitiveDataPolicySchema.optional().describe('Policy used by input-sensitive actions.'),
    output: sensitiveDataPolicySchema.optional().describe('Policy used by output-sensitive actions.'),
    retrieval: sensitiveDataPolicySchema.optional().describe('Policy used by retrieval-sensitive actions.')
  }).optional().describe('Optional explicit sensitive-data policies.')
}).describe('Guardrail action bindings and sensitive-data policies.')

/** Accepted inline guardrail configuration before defaults. */
export type GuardrailsConfigInput = z.input<typeof guardrailsConfigSchema>

/** Normalized guardrail configuration after the rails default is applied. */
export type GuardrailsConfig = z.output<typeof guardrailsConfigSchema>

/** One normalized sensitive-data policy. */
export type SensitiveDataPolicy = NonNullable<NonNullable<GuardrailsConfig['sensitiveData']>[keyof NonNullable<GuardrailsConfig['sensitiveData']>]>
