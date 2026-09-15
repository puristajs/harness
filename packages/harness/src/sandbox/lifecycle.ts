import { HarnessConfigError, OperationCancelledError, SandboxStateLostError } from '../errors/index.js'
import type { SandboxOpenOptions, SandboxOpenResult, SandboxSessionBase, SandboxTerminateOptions } from './index.js'
import { sandboxScopeSchema, type SandboxScope } from './ownership.js'

/** Validates an adapter request without adding or normalizing identity values. */
export function validateSandboxScope(scope: unknown): asserts scope is SandboxScope {
  if (!sandboxScopeSchema.safeParse(scope).success) {
    throw new HarnessConfigError('Sandbox scope is invalid.', { reason: 'invalid_sandbox_scope', path: 'scope' })
  }
}

/** Rejects invalid lifecycle modes before an adapter reads or changes state. */
export function validateSandboxOpenOptions(options: SandboxOpenOptions): void {
  validateSandboxScope(options.scope)
  if (!['create', 'attach', 'restore'].includes(options.mode)) {
    throw new HarnessConfigError('Sandbox open mode is invalid.', { reason: 'invalid_sandbox_mode', path: 'mode' })
  }
}

/** Rejects unsupported termination reasons before an adapter invalidates attachments. */
export function validateSandboxTerminateOptions(options: SandboxTerminateOptions): void {
  validateSandboxScope(options.scope)
  if (!['session_closed', 'run_disposed', 'manual'].includes(options.reason)) {
    throw new HarnessConfigError('Sandbox termination reason is invalid.', { reason: 'invalid_sandbox_reason', path: 'reason' })
  }
}

/** Canonical private key; identity object presence and exact values are significant. */
export function sandboxScopeKey(scope: SandboxScope): string {
  validateSandboxScope(scope)
  return JSON.stringify([
    scope.owner.namespace, scope.owner.id, scope.owner.instanceId,
    scope.owner.identity !== undefined,
    scope.owner.identity?.tenantId ?? null, scope.owner.identity?.principalId ?? null,
    scope.partition.kind,
    scope.partition.kind === 'shared' ? null : scope.partition.id,
    scope.partition.kind === 'agent' || scope.partition.kind === 'workflow' ? scope.partition.harnessName : null,
    scope.lifetime, scope.lifetime === 'run' ? scope.runId : null
  ])
}

function cancelled(): OperationCancelledError {
  return new OperationCancelledError('Sandbox lifecycle operation was cancelled.', { scope: 'sandbox' })
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled()
}

async function waitForSession<S>(pending: Promise<S>, signal?: AbortSignal): Promise<S> {
  assertNotCancelled(signal)
  if (!signal) return await pending
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(cancelled())
        signal.addEventListener('abort', onAbort, { once: true })
      })
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Process-local authority shared by built-ins and their deterministic test fake. */
export class ProcessLocalSandboxLifecycle<S extends SandboxSessionBase> {
  private readonly sessions = new Map<string, Promise<S> | null>()

  public async open(options: SandboxOpenOptions, create: () => S | Promise<S>): Promise<{
    session: S
    disposition: SandboxOpenResult<[]>['disposition']
    assertActive: () => void
  }> {
    validateSandboxOpenOptions(options)
    const key = sandboxScopeKey(options.scope)
    assertNotCancelled(options.signal)
    if (options.mode === 'restore') {
      throw new SandboxStateLostError('Sandbox has no compatible durable workspace binding.', {
        reason: 'durable_workspace_recovery_unavailable', lifetime: options.scope.lifetime
      })
    }
    let pending = this.sessions.get(key)
    const created = pending === undefined && options.mode === 'create'
    const assertActive = () => {
      if (this.sessions.get(key) === null) throw this.stateLost(options.scope)
    }
    if (pending === null || (!pending && !created)) throw this.stateLost(options.scope)
    if (!pending) {
      pending = Promise.resolve().then(create)
      this.sessions.set(key, pending)
      const creating = pending
      void pending.catch(() => {
        if (this.sessions.get(key) === creating) this.sessions.delete(key)
      })
    }
    const session = await waitForSession(pending, options.signal)
    assertNotCancelled(options.signal)
    assertActive()
    return { session, disposition: created ? 'created' : 'attached', assertActive }
  }

  public async terminate(options: SandboxTerminateOptions): Promise<void> {
    validateSandboxTerminateOptions(options)
    const key = sandboxScopeKey(options.scope)
    assertNotCancelled(options.signal)
    const pending = this.sessions.get(key)
    this.sessions.set(key, null)
    if (pending) await (await pending).close()
  }

  private stateLost(scope: SandboxScope): SandboxStateLostError {
    return new SandboxStateLostError('Sandbox lifecycle state is unavailable.', { reason: 'lifecycle_state_missing', lifetime: scope.lifetime })
  }
}
