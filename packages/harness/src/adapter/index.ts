/**
 * Narrow implementation surface for Harness adapter authors.
 *
 * Application code should normally import ports and errors from
 * `@purista/harness`; this subpath exposes the canonical boundary validators
 * needed to implement storage and infrastructure adapters without importing
 * private source files.
 */
export { sameHarnessIdentity } from '../identity/index.js'
export { assertSessionSandboxBindingTransition } from '../storage/session-binding.js'
export {
  sandboxScopeKey,
  validateSandboxOpenOptions,
  validateSandboxScope,
  validateSandboxTerminateOptions,
} from '../sandbox/lifecycle.js'
export {
  asExternalWaitResolved,
  createExternalWaitCancellation,
  projectExternalWaitRequest,
  validateBoundExternalWaitRequest,
  validateExternalWaitId,
  validateExternalWaitRegistration,
  validateExternalWaitSignal,
  validateExternalWaitSignalResult,
  validateExternalWaitSnapshot,
} from '../storage/external-wait.js'
