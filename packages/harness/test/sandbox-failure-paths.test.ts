import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessConfigError, OperationCancelledError, SandboxError, SandboxStateLostError } from '../src/errors/index.js'
import { localDirectorySandbox } from '../src/local/index.js'
import { bashSandbox, inMemorySandbox, isExecCapableSession, isSpawnCapableSession, type Sandbox, type SandboxOpenMode, type SandboxScope, type SandboxSessionBase, type SandboxTerminateOptions } from '../src/sandbox/index.js'
import { ProcessLocalSandboxLifecycle, validateSandboxOpenOptions } from '../src/sandbox/lifecycle.js'

function scope(sessionId = 'failure-path'): SandboxScope {
  return { owner: { namespace: 'sandbox-failure-tests', id: sessionId, instanceId: '01J00000000000000000000000' }, partition: { kind: 'shared' }, lifetime: 'session' }
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe.each([
  ['memory', () => registered(inMemorySandbox())],
  ['bash', () => registered(bashSandbox())]
] as const)('%s filesystem failures and isolation', (_name, make) => {
  it('rejects malformed termination reasons without invalidating its attachments', async () => {
    const sandbox = make()
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await session.write('/workspace/retained.txt', 'retained')
    for (const reason of [undefined, '', 'expired']) {
      await expect(sandbox.terminate({ scope: scope(), reason: reason as SandboxTerminateOptions['reason'] })).rejects.toMatchObject({
        code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'invalid_sandbox_reason', path: 'reason' }
      })
      expect(await session.readText('/workspace/retained.txt')).toBe('retained')
    }
    const attached = (await sandbox.open({ scope: scope(), mode: 'attach' })).session
    expect(await attached.readText('/workspace/retained.txt')).toBe('retained')
    await sandbox.terminate({ scope: scope(), reason: 'manual' })
    await expect(attached.write('/workspace/stale', 'stale')).rejects.toBeInstanceOf(SandboxStateLostError)
  })

  it('copies binary inputs and outputs instead of exposing mutable storage', async () => {
    const sandbox = make()
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    const input = new Uint8Array([0, 127, 255])
    await session.write('/workspace/binary.dat', input)
    input[0] = 99
    const output = await session.read('/workspace/binary.dat')
    expect([...output]).toEqual([0, 127, 255])
    output[1] = 99
    expect([...(await session.read('/workspace/binary.dat'))]).toEqual([0, 127, 255])
  })

  it('lists nested files, directories, and anchored literal globs', async () => {
    const sandbox = make()
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await session.write('/workspace/top.txt', 'top')
    await session.write('/workspace/nested/a2.txt', 'two')
    await session.write('/workspace/nested/a1.txt', 'one')
    await session.write('/workspace/nested/a[1].txt', 'literal')
    await session.write('/outside/keep.txt', 'outside')
    expect((await session.list('/workspace')).map(entry => entry.path)).toEqual(['/workspace/nested', '/workspace/top.txt'])
    expect((await session.list('/workspace', { recursive: true, glob: '**/a?.txt' })).map(entry => entry.path)).toEqual([
      '/workspace/nested/a1.txt', '/workspace/nested/a2.txt'
    ])
    expect((await session.list('/workspace', { recursive: true, glob: '**/a[1].txt' })).map(entry => entry.path)).toEqual(['/workspace/nested/a[1].txt'])
    const rootEntries = await session.list('/', { recursive: true, glob: '/workspace/**' })
    expect(rootEntries.map(entry => entry.path)).toEqual([
      '/workspace/nested', '/workspace/nested/a[1].txt', '/workspace/nested/a1.txt', '/workspace/nested/a2.txt', '/workspace/top.txt'
    ])
    expect(await session.stat('/workspace/nested')).toMatchObject({ kind: 'directory', modifiedAt: expect.any(String) })
    expect(rootEntries.find(entry => entry.path === '/workspace/nested')).not.toHaveProperty('size')
  })

  it('recursively removes only the requested directory and its descendants', async () => {
    const sandbox = make()
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await session.write('/workspace/nested/deeper/remove.txt', 'remove')
    await session.write('/workspace/nested-copy/keep.txt', 'keep')
    await session.remove('/workspace/nested', { recursive: true })
    expect(await session.exists('/workspace/nested')).toBe(false)
    expect(await session.exists('/workspace/nested/deeper/remove.txt')).toBe(false)
    expect(await session.readText('/workspace/nested-copy/keep.txt')).toBe('keep')
    await session.remove('/workspace/not-created')
  })

  it('returns canonical errors for missing files, missing stat targets, and reading a directory', async () => {
    const sandbox = make()
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await session.write('/workspace/directory/file.txt', 'file')
    for (const operation of [
      () => session.read('/workspace/private-missing-file'),
      () => session.stat('/workspace/private-missing-file'),
      () => session.read('/workspace/directory')
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'SANDBOX_ERROR', meta: { reason: 'fs_failed' } })
    }
    expect(await session.readText('/workspace/directory/file.txt')).toBe('file')
  })

  it('normalizes mounted absolute-relative entries and refuses every operation after detach', async () => {
    const sandbox = make()
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await session.mount(new Map([['/SKILL.md', 'skill'], ['relative.txt', 'relative']]), '/skills/example')
    expect(await session.readText('/skills/example/SKILL.md')).toBe('skill')
    expect(await session.readText('/skills/example/relative.txt')).toBe('relative')
    await session.close()
    for (const operation of [
      () => session.read('/skills/example/SKILL.md'),
      () => session.write('/skills/example/SKILL.md', 'stale'),
      () => session.remove('/skills/example', { recursive: true }),
      () => session.list('/skills'),
      () => session.stat('/skills'),
      () => session.exists('/skills'),
      () => session.mount(new Map([['stale.txt', 'stale']]), '/skills')
    ]) await expect(operation()).rejects.toMatchObject({ meta: { reason: 'session_closed' } })
    const attached = (await sandbox.open({ scope: scope(), mode: 'attach' })).session
    expect(await attached.readText('/skills/example/SKILL.md')).toBe('skill')
  })
})

describe('Bash execution failure boundaries', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid timeout %s before executing', async timeoutMs => {
    const sandbox = registered(bashSandbox())
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await expect(session.exec('touch /workspace/should-not-exist', { timeoutMs })).rejects.toMatchObject({ meta: { reason: 'invalid_exec_options' } })
    expect(await session.exists('/workspace/should-not-exist')).toBe(false)
  })

  it('cancels an in-flight execution without poisoning another attachment', async () => {
    const sandbox = registered(bashSandbox())
    const first = (await sandbox.open({ scope: scope(), mode: 'create' })).session
    const second = (await sandbox.open({ scope: scope(), mode: 'attach' })).session
    const controller = new AbortController()
    const execution = first.exec('sleep 0.05; touch /workspace/late', { signal: controller.signal })
    const rejected = expect(execution).rejects.toBeInstanceOf(OperationCancelledError)
    controller.abort('private caller reason')
    await rejected
    await second.exec('sleep 0.1')
    expect(await second.exists('/workspace/late')).toBe(false)
    expect((await second.exec('echo recovered')).stdout).toBe('recovered\n')
  })

  it('detach cancels its execution but leaves logical files attachable', async () => {
    const sandbox = registered(bashSandbox())
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await session.write('/workspace/retained.txt', 'retained')
    const rejected = expect(session.exec('sleep 0.05; touch /workspace/late')).rejects.toBeInstanceOf(OperationCancelledError)
    await session.close()
    await rejected
    await expect(session.exec('echo stale')).rejects.toMatchObject({ meta: { reason: 'session_closed' } })
    const attached = (await sandbox.open({ scope: scope(), mode: 'attach' })).session
    await attached.exec('sleep 0.1')
    expect(await attached.readText('/workspace/retained.txt')).toBe('retained')
    expect(await attached.exists('/workspace/late')).toBe(false)
  })

  it('termination cancels in-flight execution and rejects future attachment mutations', async () => {
    const sandbox = registered(bashSandbox())
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    const rejected = expect(session.exec('sleep 5; touch /workspace/late')).rejects.toBeInstanceOf(OperationCancelledError)
    await sandbox.terminate({ scope: scope(), reason: 'manual' })
    await rejected
    await expect(session.exec('echo stale')).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(session.write('/workspace/stale', 'stale')).rejects.toBeInstanceOf(SandboxStateLostError)
  })

  it('caps caller timeouts with configured limits and remains usable afterward', async () => {
    const sandbox = registered(bashSandbox({ executionLimits: { wallClockMs: 100 } }))
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await expect(session.exec('sleep 1', { timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', meta: { timeout_ms: 100 } })
    expect((await session.exec('echo recovered')).stdout).toBe('recovered\n')
  })

  it('rejects a relative cwd and reports ordinary command failure without throwing', async () => {
    const sandbox = registered(bashSandbox())
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await expect(session.exec('echo invalid', { cwd: 'relative' })).rejects.toBeInstanceOf(SandboxError)
    expect(await session.exec('false')).toMatchObject({ stdout: '', stderr: '', exitCode: 1 })
    expect((await session.exec('echo recovered')).stdout).toBe('recovered\n')
  })

  it('rejects unapproved URLs before calling fetch when an allowlist is configured', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'))
    try {
      const sandbox = registered(bashSandbox({ network: { allow: ['https://approved.invalid/'] }, python: false }))
      const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
      expect((await session.exec('curl https://blocked.invalid/private')).exitCode).not.toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })
})

describe('process-local allocation failure and cancellation', () => {
  it.each([null, undefined, [], 42, 'scope'])('rejects malformed runtime scope %j', async invalidScope => {
    const sandbox = registered(inMemorySandbox())
    await expect(sandbox.open({ scope: invalidScope as unknown as SandboxScope, mode: 'create' })).rejects.toBeInstanceOf(HarnessConfigError)
    await expect(sandbox.terminate({ scope: invalidScope as unknown as SandboxScope, reason: 'manual' })).rejects.toBeInstanceOf(HarnessConfigError)
  })

  it('rejects an unknown open mode before allocating any state', async () => {
    const sandbox = registered(inMemorySandbox())
    await expect(sandbox.open({ scope: scope(), mode: 'unexpected' as SandboxOpenMode })).rejects.toMatchObject({ meta: { reason: 'invalid_sandbox_mode' } })
    await expect(sandbox.open({ scope: scope(), mode: 'create' })).resolves.toMatchObject({ disposition: 'created' })
  })

  it('allows a fresh allocation retry after initialization fails', async () => {
    const lifecycle = new ProcessLocalSandboxLifecycle<SandboxSessionBase>()
    const failure = new Error('provider initialization failed')
    await expect(lifecycle.open({ scope: scope(), mode: 'create' }, () => { throw failure })).rejects.toBe(failure)
    const backing = (await registered(inMemorySandbox()).open({ scope: scope(), mode: 'create' })).session
    const retry = await lifecycle.open({ scope: scope(), mode: 'create' }, () => backing)
    expect(retry.disposition).toBe('created')
    await retry.session.write('/workspace/retried', 'ok')
    expect(await retry.session.readText('/workspace/retried')).toBe('ok')
  })

  it('retains termination when the overlapping allocation rejects', async () => {
    const lifecycle = new ProcessLocalSandboxLifecycle<SandboxSessionBase>()
    const allocation = deferred<SandboxSessionBase>()
    const failure = new Error('provider initialization failed')
    const results = Promise.allSettled([
      lifecycle.open({ scope: scope(), mode: 'create' }, () => allocation.promise),
      lifecycle.terminate({ scope: scope(), reason: 'manual' })
    ])
    allocation.reject(failure)
    expect(await results).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }])
    await expect(lifecycle.open({ scope: scope(), mode: 'create' }, () => { throw new Error('Must not allocate') })).rejects.toBeInstanceOf(SandboxStateLostError)
  })

  it('cancels one waiter without cancelling the shared allocation or another attachment', async () => {
    const lifecycle = new ProcessLocalSandboxLifecycle<SandboxSessionBase>()
    const allocation = deferred<SandboxSessionBase>()
    const controller = new AbortController()
    const creator = lifecycle.open({ scope: scope(), mode: 'create', signal: controller.signal }, () => allocation.promise)
    const rejected = expect(creator).rejects.toBeInstanceOf(OperationCancelledError)
    const attaching = lifecycle.open({ scope: scope(), mode: 'attach' }, () => { throw new Error('Attach must not allocate') })
    controller.abort('private cancellation')
    await rejected
    const backing = (await registered(inMemorySandbox()).open({ scope: scope(), mode: 'create' })).session
    allocation.resolve(backing)
    const attached = await attaching
    expect(attached.disposition).toBe('attached')
    await attached.session.write('/workspace/retained', 'retained')
    expect(await attached.session.readText('/workspace/retained')).toBe('retained')
  })
})

it('does not narrow a files-only local adapter to spawn merely because the method exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-files-only-guard-'))
  const sandbox = registered(localDirectorySandbox({ root }))
  try {
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    expect(session.executor).toBe('unavailable')
    expect(isExecCapableSession(session)).toBe(false)
    expect(isSpawnCapableSession(session)).toBe(false)
  } finally {
    await sandbox.terminate({ scope: scope(), reason: 'manual' })
    await rm(root, { recursive: true, force: true })
  }
})

describe('optional Bash dependency detection', () => {
  afterEach(() => {
    vi.doUnmock('node:module')
    vi.resetModules()
  })

  it('falls back to files-only only when the optional peer cannot be resolved', async () => {
    vi.resetModules()
    vi.doMock('node:module', () => ({ createRequire: () => Object.assign(() => undefined, { resolve: () => { throw new Error('peer missing') } }) }))
    const { autoDetectSandbox } = await import('../src/sandbox/index.js')
    const sandbox = registered(autoDetectSandbox())
    expect(sandbox.capabilities).toEqual(['sandbox.fs'])
    const { session } = await sandbox.open({ scope: scope(), mode: 'create' })
    await session.write('/workspace/fallback', 'files')
    expect(await session.readText('/workspace/fallback')).toBe('files')
  })

  it('does not hide an installed peer loading failure behind files-only fallback', async () => {
    const failure = new Error('installed peer initialization failed')
    vi.resetModules()
    vi.doMock('node:module', () => ({ createRequire: () => Object.assign(() => { throw failure }, { resolve: () => 'installed-peer' }) }))
    const { autoDetectSandbox } = await import('../src/sandbox/index.js')
    expect(() => autoDetectSandbox()).toThrow(failure)
  })
})
