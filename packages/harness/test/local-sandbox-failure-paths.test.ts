import * as filesystem from 'node:fs/promises'
import * as processes from 'node:child_process'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localDirectorySandbox, localDirectoryWorkspace, SandboxStateLostError, serializeError, type Sandbox, type SandboxOpenOptions, type SandboxSessionBase, type SandboxScope, type SandboxTerminateOptions } from '../src/index.js'
import { createLocalWorkspaceCoordinator } from '../src/local/local-workspace.js'
import { sha256Hex } from '../src/local/ref-hash.js'
import { validateSandboxOpenOptions } from '../src/sandbox/lifecycle.js'
import { sandboxScopeKey } from '../src/sandbox/lifecycle.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }))

const roots: string[] = []
const sessions: SandboxSessionBase[] = []
const privateDiagnostic = '/private/customer-path-sentinel provider-reference-sentinel credential-sentinel'
const scope: SandboxScope = {
  owner: { namespace: 'local-failure-paths', id: 'session', instanceId: '01J00000000000000000000000' },
  partition: { kind: 'shared' }, lifetime: 'run', runId: 'run'
}

function registered<T extends Sandbox>(sandbox: T): T {
  return new Proxy(sandbox, {
    get(target, key) {
      if (key === 'open') return async (options: Parameters<T['open']>[0]) => {
        validateSandboxOpenOptions(options)
        await target.registerOwner({ owner: options.scope.owner, mode: options.mode === 'create' ? 'create' : 'attach' })
        return await target.open(options)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(sessions.splice(0).map(session => session.close()))
  await Promise.all(roots.splice(0).map(root => filesystem.rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await filesystem.mkdtemp(join(tmpdir(), 'purista-sandbox-failures-'))
  roots.push(value)
  return value
}

async function fixture() {
  const path = await root()
  const adapter = registered(localDirectorySandbox({ root: path, exec: { allowCommands: ['node'] } }))
  const { session } = await adapter.open({ scope, mode: 'create' })
  sessions.push(session)
  await session.write('/workspace/private', 'retained')
  const [key] = await filesystem.readdir(join(path, 'sandboxes'))
  const directory = join(path, 'sandboxes', key!)
  return { path, adapter, session, directory, metadata: join(directory, 'lifecycle.json'), files: join(directory, 'files') }
}

async function boundFixture(open = true) {
  const path = await root()
  const coordinator = createLocalWorkspaceCoordinator()
  const workspace = localDirectoryWorkspace({ root: path, coordinator })
  await workspace.startWorkspace({ runId: 'run', sessionId: 'session', sandboxOwner: scope.owner, sandboxPolicyDigest: 'a'.repeat(64), attempt: 1, idempotencyKey: 'start' })
  const binding = coordinator.get(scope)!
  const adapter = registered(localDirectorySandbox({ root: path, coordinator, exec: {} }))
  if (open) {
    const { session } = await adapter.open({ scope, mode: 'create' })
    sessions.push(session)
    await session.write('/workspace/private', 'retained')
  }
  return { path, coordinator, adapter, binding, owner: join(dirname(binding.activePath), 'sandbox-owner') }
}

function partitionWorkspacePath(activePath: string): string {
  return join(activePath, 'partitions', sha256Hex(sandboxScopeKey(scope)), 'workspace')
}

function filesystemFailure(code = 'EACCES'): NodeJS.ErrnoException {
  return Object.assign(new Error(privateDiagnostic), { code, path: privateDiagnostic })
}

async function expectSafeFailure(operation: Promise<unknown>, reason: string): Promise<void> {
  const error = await operation.then(() => undefined, failure => failure)
  expect(error).toMatchObject({ code: 'SANDBOX_ERROR', meta: { reason } })
  expect(JSON.stringify(serializeError(error))).not.toContain(privateDiagnostic)
}

describe('local sandbox failed lifecycle persistence', () => {
  it.each(['open-mode', 'terminate-reason'] as const)('rejects an invalid %s before touching active state', async request => {
    const value = await fixture()
    const operation = request === 'open-mode'
      ? value.adapter.open({ scope, mode: 'unsupported' } as unknown as SandboxOpenOptions)
      : value.adapter.terminate({ scope, reason: 'unsupported' } as unknown as SandboxTerminateOptions)
    await expect(operation).rejects.toThrow()
    await expect(value.session.readText('/workspace/private')).resolves.toBe('retained')
  })

  it.each([
    'not-json',
    JSON.stringify({ version: 2, state: 'active', generation: 1 }),
    JSON.stringify({ version: 1, state: 'active', generation: 0 }),
    JSON.stringify({ version: 1, state: 'active', generation: 1, providerBody: privateDiagnostic })
  ])('rejects invalid lifecycle metadata without touching retained files: %s', async metadata => {
    const value = await fixture()
    await value.session.close()
    await filesystem.writeFile(value.metadata, metadata)
    for (const mode of ['create', 'attach', 'restore'] as const) {
      await expectSafeFailure(value.adapter.open({ scope, mode }), 'lifecycle_metadata_invalid')
    }
    await expectSafeFailure(value.adapter.terminate({ scope, reason: 'manual' }), 'lifecycle_metadata_invalid')
    await expect(filesystem.readFile(join(value.files, 'workspace/private'), 'utf8')).resolves.toBe('retained')
  })

  it.each(['metadata-symlink', 'directory-symlink', 'directory-file'] as const)('rejects a replaced %s instead of adopting it', async replacement => {
    const value = await fixture()
    await value.session.close()
    const original = join(value.path, 'preserved-original')
    if (replacement === 'metadata-symlink') {
      await filesystem.rename(value.metadata, original)
      await filesystem.symlink(original, value.metadata)
    } else {
      await filesystem.rename(value.directory, original)
      if (replacement === 'directory-symlink') await filesystem.symlink(original, value.directory)
      else await filesystem.writeFile(value.directory, privateDiagnostic)
    }
    await expectSafeFailure(value.adapter.open({ scope, mode: 'attach' }), 'lifecycle_metadata_invalid')
    await expectSafeFailure(value.adapter.terminate({ scope, reason: 'manual' }), 'lifecycle_metadata_invalid')
    const preservedFile = replacement === 'metadata-symlink'
      ? join(value.files, 'workspace/private') : join(original, 'files/workspace/private')
    await expect(filesystem.readFile(preservedFile, 'utf8')).resolves.toBe('retained')
  })

  it('never deletes unmanaged retained files when termination finds missing metadata', async () => {
    const value = await fixture()
    await value.session.close()
    await filesystem.rm(value.metadata)
    await expect(value.adapter.terminate({ scope, reason: 'manual' })).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(filesystem.readFile(join(value.files, 'workspace/private'), 'utf8')).resolves.toBe('retained')
  })

  it('reports filesystem unavailability rather than state loss and permits a later attach', async () => {
    const value = await fixture()
    const unavailable = vi.spyOn(filesystem, 'stat').mockRejectedValueOnce(filesystemFailure('EIO'))
    await expectSafeFailure(value.adapter.open({ scope, mode: 'attach' }), 'fs_failed')
    unavailable.mockRestore()
    const attached = await value.adapter.open({ scope, mode: 'attach' })
    sessions.push(attached.session)
    await expect(attached.session.readText('/workspace/private')).resolves.toBe('retained')
  })

  it('invalidates an existing handle when its backing files disappear', async () => {
    const value = await fixture()
    await filesystem.rm(value.files, { recursive: true })
    await expect(value.session.write('/workspace/replacement', 'forbidden')).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(filesystem.stat(value.files)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps interrupted first creation terminal rather than replacing unknown state', async () => {
    const path = await root()
    const adapter = localDirectorySandbox({ root: path })
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    const controller = new AbortController()
    const rename = filesystem.rename
    const commit = vi.spyOn(filesystem, 'rename').mockImplementationOnce(async (from, to) => {
      await rename(from, to)
      controller.abort(privateDiagnostic)
    })
    await expect(adapter.open({ scope, mode: 'create', signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    commit.mockRestore()
    await expect(adapter.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(adapter.open({ scope, mode: 'create' })).rejects.toBeInstanceOf(SandboxStateLostError)
  })

  it.each(['open', 'terminate'] as const)('honors cancellation while %s waits for an admitted filesystem write', async operation => {
    const value = await fixture()
    let started!: () => void
    let proceed!: () => void
    const writing = new Promise<void>(resolve => { started = resolve })
    const allowed = new Promise<void>(resolve => { proceed = resolve })
    const write = filesystem.writeFile
    const blocker = vi.spyOn(filesystem, 'writeFile').mockImplementationOnce(async (path, data, options) => {
      started()
      await allowed
      await write(path, data, options)
    })
    const pendingWrite = value.session.write('/workspace/private', 'updated')
    try {
      await writing
      const controller = new AbortController()
      const pending = operation === 'open'
        ? value.adapter.open({ scope, mode: 'attach', signal: controller.signal })
        : value.adapter.terminate({ scope, reason: 'manual', signal: controller.signal })
      const rejected = expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
      controller.abort(privateDiagnostic)
      proceed()
      await pendingWrite
      await rejected
      await expect(value.session.readText('/workspace/private')).resolves.toBe('updated')
    } finally {
      proceed()
      blocker.mockRestore()
      await pendingWrite
    }
  })

  it('preserves creating metadata and removes temporary files when activation cannot commit', async () => {
    const path = await root()
    const adapter = localDirectorySandbox({ root: path })
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    const rename = filesystem.rename
    let commits = 0
    const commit = vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
      commits += 1
      if (commits === 2) throw filesystemFailure('EIO')
      await rename(from, to)
    })
    await expectSafeFailure(adapter.open({ scope, mode: 'create' }), 'fs_failed')
    commit.mockRestore()
    await expect(filesystem.readdir(join(path, 'sandboxes'))).rejects.toMatchObject({ code: 'ENOENT' })
    const retry = await adapter.open({ scope, mode: 'create' })
    sessions.push(retry.session)
    expect(retry.disposition).toBe('created')
  })

  it('sanitizes directory creation failures without allocating usable state', async () => {
    const path = await root()
    const adapter = localDirectorySandbox({ root: path })
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    const mkdir = vi.spyOn(filesystem, 'mkdir').mockRejectedValueOnce(filesystemFailure())
    await expectSafeFailure(adapter.open({ scope, mode: 'create' }), 'fs_failed')
    mkdir.mockRestore()
    expect(await filesystem.readdir(path)).toEqual(['sandbox-catalog'])
    const retry = await adapter.open({ scope, mode: 'create' })
    sessions.push(retry.session)
    expect(retry.disposition).toBe('created')
  })

  it('keeps failed deletion terminal and retries cleanup without recreating files', async () => {
    const value = await fixture()
    const remove = filesystem.rm
    const failCleanup = vi.spyOn(filesystem, 'rm').mockImplementation(async (path, options) => {
      if (String(path) === value.files) throw filesystemFailure()
      await remove(path, options)
    })
    await expectSafeFailure(value.adapter.terminate({ scope, reason: 'manual' }), 'fs_failed')
    failCleanup.mockRestore()
    expect(JSON.parse(await filesystem.readFile(value.metadata, 'utf8')).state).toBe('terminating')
    await expect(value.adapter.open({ scope, mode: 'create' })).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(value.session.readText('/workspace/private')).rejects.toBeInstanceOf(SandboxStateLostError)
    await value.adapter.terminate({ scope, reason: 'manual' })
    await expect(filesystem.stat(value.files)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await filesystem.readFile(value.metadata, 'utf8')).state).toBe('terminated')
  })
})

describe('local sandbox binding failures', () => {
  it('rejects a missing active workspace before creating a scope', async () => {
    const value = await boundFixture(false)
    await value.adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    await filesystem.rm(value.binding.activePath, { recursive: true })
    await expect(value.adapter.open({ scope, mode: 'create' })).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(filesystem.stat(join(value.path, 'sandboxes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects lost or mismatched workspace bindings without changing existing files', async () => {
    const value = await boundFixture()
    value.coordinator.unbind('run', scope.owner)
    await expect(value.adapter.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
    value.coordinator.bind('run', scope.owner, 'different-private-reference', value.binding.activePath, 'resume')
    await expect(value.adapter.open({ scope, mode: 'restore' })).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(filesystem.readFile(join(partitionWorkspacePath(value.binding.activePath), 'private'), 'utf8')).resolves.toBe('retained')
  })

  it('rejects malformed ownership metadata instead of replacing the claim', async () => {
    const value = await boundFixture()
    await filesystem.writeFile(value.owner, privateDiagnostic)
    await expectSafeFailure(value.adapter.open({ scope, mode: 'attach' }), 'lifecycle_metadata_invalid')
    await expect(filesystem.readFile(value.owner, 'utf8')).resolves.toBe(privateDiagnostic)
    await expect(filesystem.readFile(join(partitionWorkspacePath(value.binding.activePath), 'private'), 'utf8')).resolves.toBe('retained')
  })

  it('does not adopt a symlinked workspace metadata directory', async () => {
    const value = await boundFixture(false)
    const original = dirname(value.binding.activePath)
    const moved = join(value.path, 'preserved-workspace')
    await filesystem.rename(original, moved)
    await filesystem.symlink(moved, original)
    await expectSafeFailure(value.adapter.open({ scope, mode: 'create' }), 'lifecycle_metadata_invalid')
    await expect(filesystem.stat(join(moved, 'sandbox-owner'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(filesystem.stat(join(moved, 'active', 'partitions'))).resolves.toBeDefined()
  })

  it('sanitizes an ownership write failure and allows a later first claim', async () => {
    const value = await boundFixture(false)
    await value.adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    const write = vi.spyOn(filesystem, 'writeFile').mockRejectedValueOnce(filesystemFailure())
    await expectSafeFailure(value.adapter.open({ scope, mode: 'create' }), 'fs_failed')
    write.mockRestore()
    const retry = await value.adapter.open({ scope, mode: 'create' })
    sessions.push(retry.session)
    expect(retry.disposition).toBe('created')
  })
})

describe('local sandbox operation and process failures', () => {
  it('does not turn permission errors into a negative exists result', async () => {
    const value = await fixture()
    const stat = filesystem.stat
    const target = join(value.files, 'workspace/private')
    const denied = vi.spyOn(filesystem, 'stat').mockImplementation(async path => {
      if (String(path) === target) throw filesystemFailure()
      return stat(path)
    })
    await expectSafeFailure(value.session.exists('/workspace/private'), 'fs_failed')
    denied.mockRestore()
    await expect(value.session.readText('/workspace/private')).resolves.toBe('retained')
  })

  it.each(['', '  \t  ', 'node "unterminated', 'sh', 'node;touch forbidden'])('rejects malformed or forbidden exec without side effects: %s', async command => {
    const value = await fixture()
    await expectSafeFailure(value.session.exec(command), 'exec_failed')
    await expect(value.session.list('/workspace')).resolves.toHaveLength(1)
  })

  it('rejects disallowed spawn and pre-aborted process requests before starting work', async () => {
    const value = await fixture()
    await expectSafeFailure(value.session.spawn('sh'), 'exec_failed')
    const signal = AbortSignal.abort(privateDiagnostic)
    await expect(value.session.spawn('node', { signal })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await expect(value.session.exec('node', { signal })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })

  it('does not allocate a child when cancellation arrives during asynchronous spawn preparation', async () => {
    const value = await fixture()
    const controller = new AbortController()
    let started!: () => void
    let proceed!: () => void
    const resolving = new Promise<void>(resolve => { started = resolve })
    const allowed = new Promise<void>(resolve => { proceed = resolve })
    const realpath = filesystem.realpath
    const blocker = vi.spyOn(filesystem, 'realpath').mockImplementationOnce(async path => {
      started()
      await allowed
      return realpath(path)
    })
    const spawn = vi.spyOn(processes, 'spawn')
    const pending = value.session.spawn('node', { args: ['-e', 'process.exit(0)'], signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    try {
      await resolving
      controller.abort(privateDiagnostic)
      proceed()
      await rejected
      expect(spawn).not.toHaveBeenCalled()
      await expect(value.session.readText('/workspace/private')).resolves.toBe('retained')
    } finally {
      proceed()
      blocker.mockRestore()
      spawn.mockRestore()
      await pending.catch(() => undefined)
    }
  })

  it.each(['close', 'terminate'] as const)('retains failed process cleanup for a safe %s retry', async operation => {
    const value = await fixture()
    const child = await value.session.spawn('node', { args: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"] })
    for await (const chunk of child.stdout) { if (chunk.includes('ready')) break }
    const denied = vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw filesystemFailure() })
    try {
      await expectSafeFailure(operation === 'close'
        ? value.session.close()
        : value.adapter.terminate({ scope, reason: 'manual' }), 'cleanup_failed')
      denied.mockRestore()
      await expect(value.session.write('/workspace/forbidden', 'x')).rejects.toThrow()
      if (operation === 'close') {
        await value.session.close()
        const attached = await value.adapter.open({ scope, mode: 'attach' })
        sessions.push(attached.session)
        await expect(attached.session.readText('/workspace/private')).resolves.toBe('retained')
      } else {
        await expect(value.adapter.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
        await value.adapter.terminate({ scope, reason: 'manual' })
      }
      await expect(child.exit).resolves.toMatchObject({ signal: 'SIGTERM' })
    } finally {
      denied.mockRestore()
      await child.kill('SIGKILL')
    }
  })

  it('reports stdin failure after process exit without copying native diagnostics', async () => {
    const value = await fixture()
    const child = await value.session.spawn('node', { args: ['-e', 'process.exit(0)'] })
    await expect(child.exit).resolves.toMatchObject({ exitCode: 0 })
    await expectSafeFailure(child.writeStdin(privateDiagnostic), 'exec_failed')
    await expect(child.kill()).resolves.toBeUndefined()
  })
})
