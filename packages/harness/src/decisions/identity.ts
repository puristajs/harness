import { createHash } from 'node:crypto'
import type { DecisionEvidence, DecisionOccurrence, DecisionSource } from './types.js'

export function createDecisionId(
  occurrence: DecisionOccurrence,
  source: DecisionSource,
  phase: DecisionEvidence['phase'],
  ordinal: number
): string {
  const tuple = [
    occurrence.runId ?? null,
    occurrence.invocationId,
    phase,
    occurrence.step,
    occurrence.toolId ?? null,
    occurrence.callId ?? null,
    source.kind,
    source.id,
    source.version ?? null,
    source.ruleId ?? null,
    ordinal
  ]
  return `decision_${createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')}`
}
