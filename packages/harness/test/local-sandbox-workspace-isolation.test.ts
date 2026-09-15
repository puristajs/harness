import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localDirectorySandbox, localDirectoryWorkspace, SandboxStateLostError, type Sandbox, type SandboxScope } from '../src/index.js'
import { createLocalWorkspaceCoordinator } from '../src/local/local-workspace.js'
import { sha256Hex } from '../src/local/ref-hash.js'
import { sandboxScopeKey } from '../src/sandbox/lifecycle.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const scope: SandboxScope = {
  owner: { namespace: 'bound-isolation', id: 'session', instanceId: '01J00000000000000000000000', identity: { tenantId: 'tenant', principalId: 'principal' } },
  partition: { kind: 'shared' }, lifetime: 'run', runId: 'run'
}

async function open(adapter: Sandbox, target: SandboxScope, mode: 'create' | 'attach' | 'restore' = 'create') {
  await adapter.registerOwner({ owner: target.owner, mode: mode === 'create' ? 'create' : 'attach' })
  return await adapter.open({ scope: target, mode, ...(target.owner.identity ? { identity: target.owner.identity } : {}) })
}

function partitionWorkspacePath(activePath: string, target: SandboxScope): string {
  return join(activePath, 'partitions', sha256Hex(sandboxScopeKey(target)), 'workspace')
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'purista-bound-sandbox-'))
  roots.push(root)
  const coordinator = createLocalWorkspaceCoordinator()
  const workspace = localDirectoryWorkspace({ root, coordinator })
  const handle = await workspace.startWorkspace({ runId: 'run', sessionId: 'session', sandboxOwner: scope.owner, sandboxPolicyDigest: 'a'.repeat(64), attempt: 1, idempotencyKey: 'start' })
  const adapter = localDirectorySandbox({ root, coordinator })
  const opened = await open(adapter, scope)
  await opened.session.write('/workspace/private', 'retained private data')
  const binding = coordinator.get(scope)!
  return { root, coordinator, workspace, handle, adapter, opened, binding, ownerPath: join(dirname(binding.activePath), 'sandbox-owner') }
}

describe('local workspace sandbox ownership', () => {
  it.each(['namespace', 'tenant', 'principal', 'identity-presence', 'instance'] as const)('rejects a different %s owner on the same workspace', async dimension => {
    const { adapter, opened } = await fixture()
    const baseScope = { ...scope, owner: { ...scope.owner } }
    if (dimension === 'identity-presence') delete baseScope.owner.identity
    const different: SandboxScope = {
      ...baseScope, owner: {
        ...baseScope.owner,
        ...(dimension === 'namespace' ? { namespace: 'other' } : {}),
        ...(dimension === 'tenant' ? { identity: { tenantId: 'other', principalId: 'principal' } } : {}),
        ...(dimension === 'principal' ? { identity: { tenantId: 'tenant', principalId: 'other' } } : {}),
        ...(dimension === 'instance' ? { instanceId: '01J00000000000000000000001' } : {})
      }
    }
    await expect(open(adapter, different)).rejects.toMatchObject({
      code: 'SANDBOX_ERROR', meta: { reason: 'invalid_scope' }
    })
    await expect(opened.session.readText('/workspace/private')).resolves.toBe('retained private data')
    await opened.session.close()
  })

  it('creates a separate partition under the same owner/run aggregate', async () => {
    const { adapter, opened, binding, workspace, handle } = await fixture()
    const childScope: SandboxScope = { ...scope, partition: { kind: 'agent', harnessName: 'bound-isolation', id: 'child' } }
    const child = await open(adapter, childScope)
    await child.session.write('/workspace/private', 'child data')
    await expect(opened.session.readText('/workspace/private')).resolves.toBe('retained private data')
    await expect(child.session.readText('/workspace/private')).resolves.toBe('child data')
    await expect(readFile(join(partitionWorkspacePath(binding.activePath, childScope), 'private'), 'utf8')).resolves.toBe('child data')
    const checkpoint = await workspace.pauseWorkspace({
      handle,
      sandboxPartitions: [scope.partition],
      stepId: 'checkpoint',
      sequence: 1,
      attempt: 1,
      reason: 'step_completed',
      idempotencyKey: 'checkpoint'
    })
    expect(checkpoint.sandboxPartitions).toEqual([childScope.partition, scope.partition])
    await child.session.close()
    await opened.session.close()
  })

  it('persists ownership outside the active directory across independent clients and sandbox roots', async () => {
    const { root, adapter, opened, binding, ownerPath } = await fixture()
    const owner = await readFile(ownerPath, 'utf8')
    expect(owner).toMatch(/^[a-f0-9]{64}$/)
    expect(owner).not.toContain('tenant')
    await opened.session.close()
    const reopenedCoordinator = createLocalWorkspaceCoordinator()
    reopenedCoordinator.bind('run', scope.owner, binding.workspaceRef, binding.activePath)
    const reopened = localDirectorySandbox({ root, coordinator: reopenedCoordinator })
    const attached = await open(reopened, scope, 'attach')
    await expect(attached.session.readText('/workspace/private')).resolves.toBe('retained private data')
    const alternate = localDirectorySandbox({ root: join(root, 'another-sandbox-root'), coordinator: reopenedCoordinator })
    await expect(open(alternate, { ...scope, owner: { ...scope.owner, instanceId: '01J00000000000000000000001' } })).rejects.toMatchObject({
      code: 'SANDBOX_ERROR', meta: { reason: 'invalid_scope' }
    })
    await attached.session.close()
    await adapter.terminate({ scope, reason: 'run_disposed' })
    await expect(readFile(join(partitionWorkspacePath(binding.activePath, scope), 'private'), 'utf8')).resolves.toBe('retained private data')
    await expect(readFile(ownerPath, 'utf8')).resolves.toBe(owner)
  })

  it.each(['create', 'attach', 'restore'] as const)('never recreates missing ownership for existing lifecycle state on %s', async mode => {
    const { adapter, opened, coordinator, binding, ownerPath } = await fixture()
    await opened.session.close()
    coordinator.bind('run', scope.owner, binding.workspaceRef, binding.activePath, 'committed-resume')
    await rm(ownerPath)
    await expect(open(adapter, scope, mode)).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(readFile(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(partitionWorkspacePath(binding.activePath, scope), 'private'), 'utf8')).resolves.toBe('retained private data')
  })

  it('rejects an owner symlink without following or overwriting it', async () => {
    const { adapter, opened, binding, ownerPath } = await fixture()
    await opened.session.close()
    await rm(ownerPath)
    const privateFile = join(partitionWorkspacePath(binding.activePath, scope), 'private')
    await symlink(privateFile, ownerPath)
    await expect(open(adapter, scope, 'attach')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR', meta: { reason: 'lifecycle_metadata_invalid' }
    })
    await expect(readFile(privateFile, 'utf8')).resolves.toBe('retained private data')
  })
})
