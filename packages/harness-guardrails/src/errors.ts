import { HarnessError } from '@purista/harness'

/** NeMo-compatible configuration could not be loaded or compiled safely. */
export class GuardrailsConfigError extends HarnessError {
  public constructor(message: string, meta: { reason: string; path?: string | undefined; field?: string | undefined; flow_id?: string | undefined }, cause?: unknown) {
    super({ code: 'GUARDRAILS_CONFIG_ERROR', category: 'config', retriable: false, message, meta, cause })
  }
}

/** A rail action failed outside a Harness default-loop interception hook. */
export class GuardrailEvaluationError extends HarnessError {
  public constructor(message: string, meta: { rail_id: string; phase: GuardrailPhase; reason: 'action_failed' | 'action_timeout' | 'invalid_outcome' | 'unsupported_transform' }, cause?: unknown) {
    super({ code: 'GUARDRAIL_EVALUATION_ERROR', category: 'interceptor', retriable: false, message, meta, cause })
  }
}

/** A configured rail intentionally denied caller-owned data before it could be used. */
export class GuardrailBlockedError extends HarnessError {
  public constructor(meta: { rail_id: string; phase: GuardrailPhase; reason_code?: string | undefined }) {
    super({ code: 'GUARDRAIL_BLOCKED', category: 'interceptor', retriable: false, message: 'Guardrail blocked execution.', meta })
  }
}

/** The stable phases understood by the first `@purista/harness-guardrails` release. */
export type GuardrailPhase = 'input' | 'output' | 'tool_input' | 'tool_output' | 'retrieval'
