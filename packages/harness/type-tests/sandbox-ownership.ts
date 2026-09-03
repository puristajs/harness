import {
  SandboxConflictError,
  SandboxPermissionDeniedError,
  SandboxQuotaExceededError
} from '../src/index.js'
import type {
  SandboxBindingOptions,
  SandboxOwner,
  SandboxPolicy,
  SessionOptions
} from '../src/index.js'
import type { SandboxScope } from '../src/sandbox/ownership.js'

const owner: SandboxOwner = {
  namespace: 'acme',
  id: 'customer-42',
  instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J'
}

const sessionOptions: SessionOptions = { sandboxOwner: owner }
const policy: SandboxPolicy<'reviewers'> = { group: 'reviewers' }
const binding: SandboxBindingOptions<'reviewers'> = { groups: ['reviewers'], defaultPolicy: policy }
const runScope: SandboxScope = { owner, partition: { kind: 'group', id: 'reviewers' }, lifetime: 'run', runId: 'run-1' }
void sessionOptions
void binding
void runScope

new SandboxPermissionDeniedError('scope_mismatch')
new SandboxConflictError('checkpoint_busy')
new SandboxQuotaExceededError({ quota: 'snapshots', limit: 32 })
// @ts-expect-error sandbox permission errors do not accept caller-controlled messages.
new SandboxPermissionDeniedError('private owner value', { reason: 'scope_mismatch' })

// @ts-expect-error sandbox sharing policies do not accept a topology mode.
const invalidPolicy: SandboxPolicy = { mode: 'multi_instance' }
// @ts-expect-error group policies are constrained to the configured group vocabulary.
const invalidGroup: SandboxPolicy<'reviewers'> = { group: 'authors' }
// @ts-expect-error run scopes require a run id.
const missingRunId: SandboxScope = { owner, partition: { kind: 'shared' }, lifetime: 'run' }
// @ts-expect-error session scopes cannot retain a run id.
const sessionWithRunId: SandboxScope = { owner, partition: { kind: 'shared' }, lifetime: 'session', runId: 'run-1' }
// @ts-expect-error owner identity remains closed.
const invalidOwner: SandboxOwner = { ...owner, identity: { tenantId: 'tenant-1', extra: true } }
// @ts-expect-error session options are closed to explicit session/identity ownership fields.
const invalidSessionOptions: SessionOptions = { sandboxOwner: owner, legacySandboxId: 'sandbox-1' }
void invalidPolicy
void invalidGroup
void missingRunId
void sessionWithRunId
void invalidOwner
void invalidSessionOptions
