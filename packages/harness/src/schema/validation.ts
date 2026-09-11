import { InternalError, ValidationError, type ValidationWhere } from '../errors/index.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type { Schema } from './index.js'

/** Options supplied by each runtime boundary to the shared schema validator. */
export interface ValidateSchemaOptions {
  /** Stable public validation boundary. */
  readonly where: ValidationWhere
  /** Existing boundary-specific public error message. */
  readonly message: string
  /** Runs before and after awaiting a validator so the owning lifecycle retains cancellation semantics. */
  readonly assertNotAborted?: () => void
}

/**
 * Validates one public Harness value boundary through Standard Schema V1.
 *
 * The result is always strict JSON because validated values can reach model
 * ports, persistence, telemetry envelopes, and session results. Validator
 * exceptions intentionally become closed internal errors: schema vendors must
 * not leak candidate data, issue text, or implementation details.
 */
export async function validateSchema<S extends Schema<any, any>>(schema: S, candidate: unknown, options: ValidateSchemaOptions): Promise<JsonValue> {
  options.assertNotAborted?.()

  let result: Awaited<ReturnType<Schema['~standard']['validate']>>
  try {
    result = await schema['~standard'].validate(candidate)
  } catch (error) {
    options.assertNotAborted?.()
    throw new InternalError('Schema validation execution failed.', {
      reason: 'schema_validation_execution_failed',
      where: options.where
    }, error)
  }

  options.assertNotAborted?.()
  if (!isValidationResult(result)) {
    throw new InternalError('Schema validation returned a non-JSON value.', {
      reason: 'schema_validation_non_json',
      where: options.where
    })
  }
  if ('issues' in result && Array.isArray(result.issues) && result.issues.length > 0) {
    throw new ValidationError(options.message, {
      where: options.where,
      issues: {
        count: Math.min(result.issues.length, 100),
        truncated: result.issues.length > 100
      }
    }, result.issues)
  }

  const value = 'value' in result ? result.value : undefined
  if (!isJsonValue(value)) {
    throw new InternalError('Schema validation returned a non-JSON value.', {
      reason: 'schema_validation_non_json',
      where: options.where
    })
  }
  return value
}

function isValidationResult(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
