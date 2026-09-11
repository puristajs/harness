import { HarnessConfigError } from '../errors/index.js'
import { createDecisionId } from './identity.js'
import { createDecisionEvidenceInputSchema } from './schemas.js'
import type { CreateDecisionEvidenceInput, DecisionEvidence } from './types.js'

/**
 * Validates configuration-owned identity fields and returns recursively frozen,
 * content-free evidence with its deterministic runtime-owned decision ID.
 */
export function createDecisionEvidence(input: CreateDecisionEvidenceInput): DecisionEvidence {
  try {
    const parsed = createDecisionEvidenceInputSchema.parse(input)
    return Object.freeze({
      decisionId: createDecisionId(parsed.occurrence, parsed.source, parsed.phase, parsed.ordinal),
      source: Object.freeze({ ...parsed.source }),
      phase: parsed.phase,
      ...(parsed.reasonCode === undefined ? {} : { reasonCode: parsed.reasonCode })
    })
  } catch {
    throw new HarnessConfigError('Decision evidence configuration is invalid.', { reason: 'invalid_decision_evidence' })
  }
}
