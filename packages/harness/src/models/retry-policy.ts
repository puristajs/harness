import { HarnessConfigError } from '../errors/index.js'
import type { ModelRetrySetting } from '../ports/model-provider.js'

/**
 * Runtime guard for retry policies supplied from JavaScript, JSON config, or
 * generated application code. TypeScript catches shape mistakes for TS users;
 * this keeps invalid retry budgets from silently degrading into odd behavior.
 */
export function validateModelRetrySetting(setting: ModelRetrySetting | undefined, path = 'model.retry'): void {
  if (setting === undefined || typeof setting === 'boolean') return
  if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
    throw invalidRetryPolicy(path, 'retry must be true, false, or a policy object.')
  }

  validateInteger(setting.maxAttempts, `${path}.maxAttempts`, { min: 1 })
  validateInteger(setting.maxActiveElapsedMs, `${path}.maxActiveElapsedMs`, { min: 0 })
  validateInteger(setting.maxActiveDelayMs, `${path}.maxActiveDelayMs`, { min: 0 })
  validateInteger(setting.maxDeferredDelayMs, `${path}.maxDeferredDelayMs`, { min: 0 })
  validateInteger(setting.minDelayMs, `${path}.minDelayMs`, { min: 0 })
  validateInteger(setting.maxDelayMs, `${path}.maxDelayMs`, { min: 0 })

  if (setting.longRetry !== undefined && setting.longRetry !== 'error' && setting.longRetry !== 'defer') {
    throw invalidRetryPolicy(`${path}.longRetry`, 'longRetry must be "error" or "defer".')
  }

  if (setting.retryOn !== undefined) {
    if (setting.retryOn === null || typeof setting.retryOn !== 'object' || Array.isArray(setting.retryOn)) {
      throw invalidRetryPolicy(`${path}.retryOn`, 'retryOn must be an object when supplied.')
    }
    validateBoolean(setting.retryOn.network, `${path}.retryOn.network`)
    validateBoolean(setting.retryOn.timeout, `${path}.retryOn.timeout`)
    validateBoolean(setting.retryOn.rateLimit, `${path}.retryOn.rateLimit`)
    validateBoolean(setting.retryOn.serverError, `${path}.retryOn.serverError`)
  }
}

function validateInteger(value: number | undefined, path: string, opts: { min: number }): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < opts.min) {
    throw invalidRetryPolicy(path, `${path} must be an integer >= ${opts.min}.`)
  }
}

function validateBoolean(value: boolean | undefined, path: string): void {
  if (value === undefined) return
  if (typeof value !== 'boolean') {
    throw invalidRetryPolicy(path, `${path} must be a boolean.`)
  }
}

function invalidRetryPolicy(path: string, message: string): HarnessConfigError {
  return new HarnessConfigError(`Invalid model retry policy: ${message}`, {
    reason: 'invalid_model_retry_policy',
    path
  })
}
