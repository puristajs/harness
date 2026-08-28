import { z } from 'zod'
import { isJsonValue } from '../models/json.js'

const configurationIdentifier = z.string().refine(
  (value) => Array.from(value).length >= 1 && Array.from(value).length <= 128 && !/\p{Cc}/u.test(value),
  'Expected a non-empty configuration identifier without control characters.'
)

const occurrenceIdentifier = z.string().regex(/^[A-Za-z0-9_.:@/-]{1,200}$/)

/** Stable, content-free code accepted in decision callback outcomes and evidence. */
export const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)

/** Strict source identity for a content-free decision boundary. */
export const decisionSourceSchema = z.strictObject({
  kind: z.enum(['permission', 'policy', 'exposure', 'interceptor', 'guardrail']),
  id: configurationIdentifier,
  version: configurationIdentifier.optional(),
  ruleId: configurationIdentifier.optional()
}).readonly()

/** Strict invocation correlation used when deriving decision identity. */
export const decisionOccurrenceSchema = z.strictObject({
  invocationId: occurrenceIdentifier,
  step: z.number().int().nonnegative().safe(),
  runId: occurrenceIdentifier.optional(),
  agentId: occurrenceIdentifier.optional(),
  sessionId: occurrenceIdentifier.optional(),
  workflowId: occurrenceIdentifier.optional(),
  toolId: occurrenceIdentifier.optional(),
  callId: occurrenceIdentifier.optional()
}).readonly()

export const decisionPhaseSchema = z.enum([
  'input',
  'before_model',
  'after_model',
  'output',
  'tool_input',
  'permission',
  'policy',
  'approval',
  'tool_output',
  'exposure',
  'retrieval'
])

/** Strict, content-free evidence emitted by decision boundaries. */
export const decisionEvidenceSchema = z.strictObject({
  decisionId: z.string().regex(/^decision_[0-9a-f]{64}$/),
  source: decisionSourceSchema,
  phase: decisionPhaseSchema,
  reasonCode: reasonCodeSchema.optional()
}).readonly()

/** Terminal failure classifications for fail-closed decision evaluation. */
export const decisionFailureKindSchema = z.enum([
  'invalid_result',
  'callback_failed',
  'callback_timeout',
  'invalid_transform',
  'invalid_continuation',
  'audit_failed',
  'sensitive_data_detector_failed',
  'sensitive_data_invalid_result',
  'sensitive_data_codec_failed'
])

/** Internal strict envelope parser for the public evidence factory. */
export const createDecisionEvidenceInputSchema = z.strictObject({
  occurrence: decisionOccurrenceSchema,
  source: decisionSourceSchema,
  phase: decisionPhaseSchema,
  ordinal: z.number().int().nonnegative().safe(),
  reasonCode: reasonCodeSchema.optional()
})

/** The base allow/block callback outcome. Phase transforms stay private to their owners. */
export const decisionResultSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('allow'), reasonCode: reasonCodeSchema.optional() }),
  z.strictObject({ decision: z.literal('block'), reasonCode: reasonCodeSchema.optional() })
])

/** Strict result returned by a governance policy. */
const governanceRuleIdentifier = configurationIdentifier.refine((value) => value !== 'default', 'Reserved governance rule identifier.')

export const governanceDecisionSchema = z.strictObject({
  effect: z.enum(['allow', 'deny', 'require_approval', 'audit']),
  reasonCode: reasonCodeSchema.optional(),
  ruleId: governanceRuleIdentifier.optional()
})

export const governancePolicyResultSchema = z.union([governanceDecisionSchema, z.array(governanceDecisionSchema), z.undefined()])

const callbackSchema = z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function')
const governanceSelectorSchema = z.array(z.string()).optional()
const governanceRuleFields = {
  id: governanceRuleIdentifier,
  description: z.string().optional(),
  tools: governanceSelectorSchema,
  when: callbackSchema.optional()
}
const nativeGovernanceRuleSchema = z.strictObject({
  ...governanceRuleFields,
  effect: governanceDecisionSchema.shape.effect,
  reasonCode: reasonCodeSchema.optional()
})
const governancePolicyFields = {
  id: configurationIdentifier.refine((value) => value !== 'governance.default' && value !== 'governance.exposure', 'Reserved governance policy identifier.'),
  version: configurationIdentifier.optional()
}
const governanceExposureEffectSchema = z.enum(['expose', 'hide'])

/** Internal validation of closed configuration; generic callback typing stays in the builder. */
export const governanceConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  mode: z.enum(['enforce', 'shadow']).optional(),
  defaultEffect: z.enum(['allow', 'deny']).optional(),
  policies: z.array(z.union([
    z.strictObject({ ...governancePolicyFields, kind: z.literal('native'), description: z.string().optional(), rules: z.array(nativeGovernanceRuleSchema).min(1) }),
    z.strictObject({ ...governancePolicyFields, evaluate: callbackSchema })
  ])).optional(),
  exposure: z.strictObject({
    id: configurationIdentifier.optional(),
    version: configurationIdentifier.optional(),
    defaultEffect: governanceExposureEffectSchema.optional(),
    rules: z.array(z.strictObject({ ...governanceRuleFields, effect: governanceExposureEffectSchema })).optional()
  }).optional(),
  approval: z.strictObject({ request: callbackSchema }).optional(),
  audit: z.strictObject({ record: callbackSchema }).optional()
})

const permissionModeSchema = z.enum(['allow', 'require_approval', 'deny'])

/** Internal shared parser for coarse permission configuration. */
export const permissionPolicySchema = z.union([
  permissionModeSchema,
  z.strictObject({
    mode: permissionModeSchema.describe('Base decision mode for the tool family.'),
    allow: z.array(z.string()).readonly().optional().describe('Optional allowlist of command or path patterns.'),
    deny: z.array(z.string()).readonly().optional().describe('Optional denylist of command or path patterns.')
  })
])

export const agentPermissionsSchema = z.strictObject({
  bash: permissionPolicySchema.optional().describe('Permission mode or policy for the bash builtin.'),
  write: permissionPolicySchema.optional().describe('Permission mode or policy for the write builtin.'),
  edit: permissionPolicySchema.optional().describe('Permission mode or policy for the edit builtin.')
})

/** Strict result returned by the immediate governance approval provider. */
export const governanceApprovalResultSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
  reasonCode: reasonCodeSchema.optional()
})

export const policyDenialReasonSchema = z.enum(['policy_deny', 'approval_rejected', 'approval_unavailable'])

const jsonValueSchema = z.custom<import('../models/json.js').JsonValue>(isJsonValue, 'Expected a strict JSON value.')

/** Canonical provider-owned continuation slot retained only for the next model request. */
export const providerContinuationItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('opaque'), data: jsonValueSchema }),
  z.strictObject({ kind: z.literal('tool_call'), callId: configurationIdentifier, data: jsonValueSchema.optional() }),
  z.strictObject({ kind: z.literal('assistant_content') })
]).readonly()

/**
 * Provider-neutral template for reconstructing one assistant turn.
 *
 * Adapters retain opaque provider state only in `opaque` entries and replace
 * `tool_call` slots from the current canonical tool calls before provider I/O.
 */
export const providerContinuationSchema = z.strictObject({
  providerId: configurationIdentifier,
  items: z.array(providerContinuationItemSchema)
}).readonly()

/**
 * Validates the provider-neutral continuation envelope and its canonical tool
 * references. Adapters add only their provider-specific data validation.
 */
export function parseProviderContinuation(
  value: unknown,
  toolCallIds: readonly string[]
): z.output<typeof providerContinuationSchema> | undefined {
  const parsed = providerContinuationSchema.safeParse(value)
  if (!parsed.success) return undefined
  if (parsed.data.items.length === 0) return parsed.data

  const canonicalIds = new Set<string>()
  for (const callId of toolCallIds) {
    if (canonicalIds.has(callId)) return undefined
    canonicalIds.add(callId)
  }

  const continuationIds = new Set<string>()
  let assistantContentSlots = 0
  for (const item of parsed.data.items) {
    if (item.kind === 'assistant_content') {
      assistantContentSlots += 1
      if (assistantContentSlots > 1) return undefined
      continue
    }
    if (item.kind === 'tool_call') {
      if (!canonicalIds.has(item.callId) || continuationIds.has(item.callId)) return undefined
      continuationIds.add(item.callId)
    }
  }
  return continuationIds.size === canonicalIds.size ? parsed.data : undefined
}
