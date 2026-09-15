import { mkdtemp, readdir, rm } from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localDirectorySandbox, localDirectoryWorkspace, SandboxStateLostError, type SandboxScope } from '../src/index.js'
import { createLocalWorkspaceCoordinator } from '../src/local/local-workspace.js'
import { sandboxActorBarrierContract, sandboxContract } from '../src/testing/sandboxContract.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'purista-local-sandbox-contract-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const scope: SandboxScope = {
  owner: { namespace: 'local-contract', id: 'session', instanceId: '01J00000000000000000000000' },
  partition: { kind: 'shared' }, lifetime: 'run', runId: 'run'
}

async function open(adapter: ReturnType<typeof localDirectorySandbox>, target: SandboxScope, mode: 'create' | 'attach' | 'restore' = 'create') {
  await adapter.registerOwner({ owner: target.owner, mode: mode === 'create' ? 'create' : 'attach' })
  return await adapter.open({ scope: target, mode, ...(target.owner.identity ? { identity: target.owner.identity } : {}) })
}

sandboxContract(async () => localDirectorySandbox({ root: await root() }), { executor: 'unavailable' })
sandboxActorBarrierContract(async () => localDirectorySandbox({ root: await root() }))

describe('local sandbox authority', () => {
  it.each(['exec', 'spawn'] as const)('does not admit %s after close during async path resolution', async operation => {
    const adapter = localDirectorySandbox({ root: await root(), exec: {} })
    const { session } = await open(adapter, scope)
    let admitted!: () => void
    let proceed!: () => void
    const pathStarted = new Promise<void>(resolve => { admitted = resolve })
    const pathAllowed = new Promise<void>(resolve => { proceed = resolve })
    const realpath = filesystem.realpath
    const spy = vi.spyOn(filesystem, 'realpath').mockImplementationOnce(async path => {
      admitted()
      await pathAllowed
      return realpath(path)
    })
    const pending = operation === 'exec' ? session.exec('node -e "process.exit(0)"') : session.spawn('node', { args: ['-e', 'process.exit(0)'] })
    const rejected = expect(pending).rejects.toMatchObject({ meta: { reason: 'session_closed' } })
    try {
      await pathStarted
      await session.close()
      proceed()
      await rejected
    } finally {
      proceed()
      spy.mockRestore()
      await session.close()
      await adapter.terminate({ scope, reason: 'run_disposed' })
    }
  })

  it('terminates active exec without waiting for the command timeout', async () => {
    const adapter = localDirectorySandbox({ root: await root(), exec: { timeoutMs: 30_000 } })
    const { session } = await open(adapter, scope)
    const running = session.exec('node -e "require(\'fs\').writeFileSync(\'started\',\'ready\'); setInterval(()=>{},1000)"')
    // Termination can surface either an exit result or a normalized execution error.
    const settled = running.then(() => true, () => true)
    try {
      await expect.poll(() => session.exists('/workspace/started')).toBe(true)
      await adapter.terminate({ scope, reason: 'run_disposed' })
      expect(await settled).toBe(true)
      await expect(session.write('/workspace/stale', 'denied')).rejects.toBeInstanceOf(SandboxStateLostError)
    } finally {
      await session.close()
    }
  }, 3_000)

  it.each(['namespace', 'tenant', 'principal', 'instance', 'partition'] as const)('separates the %s scope dimension', async dimension => {
    const adapter = localDirectorySandbox({ root: await root() })
    const different: SandboxScope = {
      ...scope, owner: {
        ...scope.owner,
        ...(dimension === 'namespace' ? { namespace: 'other' } : {}),
        ...(dimension === 'tenant' ? { identity: { tenantId: 'tenant' } } : {}),
        ...(dimension === 'principal' ? { identity: { principalId: 'principal' } } : {}),
        ...(dimension === 'instance' ? { instanceId: '01J00000000000000000000001' } : {})
      }, ...(dimension === 'partition' ? { partition: { kind: 'agent' as const, harnessName: 'local-contract', id: 'child' } } : {})
    }
    const first = await open(adapter, scope)
    await first.session.write('/workspace/private.txt', 'private')
    const second = await open(adapter, different)
    expect(await second.session.exists('/workspace/private.txt')).toBe(false)
    await first.session.close()
    await second.session.close()
  })

  it.each(['files', 'lifecycle.json'])('does not replace missing %s on create or attach', async target => {
    const path = await root()
    const first = localDirectorySandbox({ root: path })
    const opened = await open(first, scope)
    await opened.session.close()
    const [directory] = await readdir(join(path, 'sandboxes'))
    await rm(join(path, 'sandboxes', directory!, target), { recursive: true, force: true })
    const second = localDirectorySandbox({ root: path })
    for (const mode of ['attach', 'create'] as const) {
      await second.registerOwner({ owner: scope.owner, mode: 'attach' })
      await expect(second.open({ scope, mode })).rejects.toBeInstanceOf(SandboxStateLostError)
    }
  })

  it('rejects cancellation before allocating metadata', async () => {
    const path = await root()
    const adapter = localDirectorySandbox({ root: path })
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    await expect(adapter.open({ scope, mode: 'create', signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await expect(readdir(join(path, 'sandboxes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores one generation per committed workspace resume and rejects old handles', async () => {
    const path = await root()
    const coordinator = createLocalWorkspaceCoordinator()
    const adapter = localDirectorySandbox({ root: path, coordinator })
    const workspace = localDirectoryWorkspace({ root: path, coordinator })
    const handle = await workspace.startWorkspace({ runId: 'run', sessionId: 'session', sandboxOwner: scope.owner, sandboxPolicyDigest: 'a'.repeat(64), attempt: 1, idempotencyKey: 'start' })
    const first = await open(adapter, scope)
    await first.session.write('/workspace/file', 'committed')
    const checkpoint = await workspace.pauseWorkspace({ handle, sandboxPartitions: [scope.partition], stepId: 'write', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'checkpoint' })
    await first.session.write('/workspace/file', 'uncommitted')
    await workspace.resumeWorkspace({ workspaceRef: handle.workspaceRef, checkpointRef: checkpoint.checkpointRef, runId: 'run', sessionId: 'session', attempt: 2, idempotencyKey: 'restore' })
    // Resume fences old attachments before a replacement session can be opened.
    await expect(first.session.write('/workspace/file', 'stale')).rejects.toBeInstanceOf(SandboxStateLostError)
    const restored = await open(adapter, scope, 'restore')
    await expect(restored.session.readText('/workspace/file')).resolves.toBe('committed')
    const retry = await open(adapter, scope, 'restore')
    await restored.session.write('/workspace/after-restore', 'new')
    await expect(retry.session.readText('/workspace/after-restore')).resolves.toBe('new')
    await adapter.terminate({ scope, reason: 'run_disposed' })
  })

  it('rejects checkpointing while a spawned sandbox process owns a writer admission', async () => {
    const path = await root()
    const coordinator = createLocalWorkspaceCoordinator()
    const adapter = localDirectorySandbox({ root: path, coordinator, exec: { allowCommands: ['node'] } })
    const workspace = localDirectoryWorkspace({ root: path, coordinator })
    const handle = await workspace.startWorkspace({ runId: 'run', sessionId: 'session', sandboxOwner: scope.owner, sandboxPolicyDigest: 'a'.repeat(64), attempt: 1, idempotencyKey: 'start' })
    const opened = await open(adapter, scope)
    const child = await opened.session.spawn('node', { args: ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"] })
    for await (const chunk of child.stdout) { if (chunk.includes('ready')) break }

    await expect(workspace.pauseWorkspace({
      handle,
      sandboxPartitions: [scope.partition],
      stepId: 'checkpoint',
      sequence: 1,
      attempt: 1,
      reason: 'step_completed',
      idempotencyKey: 'checkpoint-while-spawned'
    })).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'checkpoint_conflict' }
    })
    await child.kill()
    await expect(child.exit).resolves.toBeDefined()
    await expect(workspace.pauseWorkspace({
      handle,
      sandboxPartitions: [scope.partition],
      stepId: 'checkpoint',
      sequence: 1,
      attempt: 1,
      reason: 'step_completed',
      idempotencyKey: 'checkpoint-after-spawn'
    })).resolves.toMatchObject({ workspaceRef: handle.workspaceRef })
    await opened.session.close()
  })

  it('reports failed spawn and closes a process that ignores SIGTERM', async () => {
    const adapter = localDirectorySandbox({ root: await root(), exec: {} })
    const { session } = await open(adapter, scope)
    await expect(session.spawn('purista-no-such-executable')).rejects.toMatchObject({ code: 'SANDBOX_ERROR' })
    const child = await session.spawn('node', { args: ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"] })
    for await (const chunk of child.stdout) { if (chunk.includes('ready')) break }
    await session.close()
    await expect(child.exit).resolves.toMatchObject({ signal: 'SIGKILL' })
    await expect(session.close()).resolves.toBeUndefined()
    await adapter.terminate({ scope, reason: 'run_disposed' })
  })
})
