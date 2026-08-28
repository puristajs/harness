import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperationTimeoutError, type Sandbox, type SandboxScope } from '@purista/harness'
import { sandboxContract } from '@purista/harness/testing'
import { dockerSandbox } from './index.js'

type DockerAdapter = ReturnType<typeof dockerSandbox>
const enabled = process.env['PURISTA_DOCKER_SANDBOX_TEST'] === '1'
const roots: string[] = []
const resources: Array<{ adapter: DockerAdapter; scope: SandboxScope }> = []

async function fixture(): Promise<DockerAdapter> {
  const image = process.env['PURISTA_DOCKER_SANDBOX_IMAGE']
  if (!image) throw new Error('Set PURISTA_DOCKER_SANDBOX_IMAGE to an already-present digest-pinned prepared image.')
  const root = await mkdtemp(join(tmpdir(), 'purista-docker-smoke-'))
  roots.push(root)
  const context = process.env['PURISTA_DOCKER_SANDBOX_CONTEXT']
  const adapter = dockerSandbox({ root, image, ...(context ? { context } : {}) })
  return {
    capabilities: adapter.capabilities!,
    administration: adapter.administration,
    registerOwner: async options => await adapter.registerOwner(options),
    open: async options => {
      try {
        const opened = await adapter.open(options)
        resources.push({ adapter, scope: options.scope })
        return opened
      } catch (error) {
        // Invalid runtime inputs never allocated resources; other failures may
        // have a persisted cleanup intent and must retain their exact scope.
        if (!(error instanceof Error && 'meta' in error && typeof error.meta === 'object' && error.meta !== null && 'reason' in error.meta && error.meta.reason === 'invalid_scope')) resources.push({ adapter, scope: options.scope })
        throw error
      }
    },
    terminate: async options => await adapter.terminate(options),
  } satisfies Sandbox<NonNullable<DockerAdapter['capabilities']>>
}

describe.runIf(enabled)('opt-in real Docker engine', () => {
  afterEach(async () => {
    const testRoots = roots.splice(0)
    let failure: unknown
    for (const { adapter, scope } of resources.splice(0)) {
      try { await adapter.terminate({ scope, reason: 'manual' }) } catch (error) { failure ??= error }
    }
    // Keep metadata after failed cleanup: it is required for an exact retry.
    if (failure) throw failure
    for (const root of testRoots) await rm(root, { recursive: true })
  })

  sandboxContract(fixture, { executor: 'available' })

  it('keeps binary workspace files and terminates timed-out guest work across reattachment', async () => {
    const adapter = await fixture()
    const scope: SandboxScope = { owner: { namespace: 'docker-smoke', id: randomUUID(), instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J' }, partition: { kind: 'shared' }, lifetime: 'session' }
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    const first = await adapter.open({ scope, mode: 'create' })
    await first.session.write('/workspace/binary.bin', new Uint8Array([0, 255, 1, 128]))
    await expect(first.session.exec('echo ready > /workspace/started; sleep 1; echo survived > /workspace/survived', { timeoutMs: 300 })).rejects.toBeInstanceOf(OperationTimeoutError)
    await first.session.close()
    const second = await adapter.open({ scope, mode: 'attach' })
    expect(await second.session.readText('/workspace/started')).toBe('ready\n')
    expect([...await second.session.read('/workspace/binary.bin')]).toEqual([0, 255, 1, 128])
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(await second.session.exists('/workspace/survived')).toBe(false)
    await second.session.close()
  }, 30_000)

  it('streams guest stdin/stdout/stderr and cancels live guest work before releasing ownership', async () => {
    const adapter = await fixture()
    const scope: SandboxScope = { owner: { namespace: 'docker-spawn-smoke', id: randomUUID(), instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J' }, partition: { kind: 'shared' }, lifetime: 'session' }
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    const { session } = await adapter.open({ scope, mode: 'create' })
    const controller = new AbortController()
    const process = await session.spawn('node', {
      args: ['-e', `
        const fs = require('node:fs')
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', data => {
          fs.writeFileSync('/workspace/spawn-started', 'ready')
          process.stdout.write('ack:' + data)
          process.stderr.write('guest-diagnostic\\n')
          setTimeout(() => fs.writeFileSync('/workspace/spawn-survived', 'unexpected'), 1000)
        })
      `],
      signal: controller.signal,
    })
    const stdout = process.stdout[Symbol.asyncIterator]()
    const stderr = process.stderr[Symbol.asyncIterator]()
    await process.writeStdin('request\n')
    expect(await readLine(stdout)).toBe('ack:request\n')
    expect(await readLine(stderr)).toBe('guest-diagnostic\n')
    controller.abort()
    await expect(process.exit).resolves.toMatchObject({ exitCode: expect.any(Number) })
    await process.kill('SIGKILL')
    await session.close()
    const resumed = await adapter.open({ scope, mode: 'attach' })
    expect(await resumed.session.readText('/workspace/spawn-started')).toBe('ready')
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(await resumed.session.exists('/workspace/spawn-survived')).toBe(false)
    await resumed.session.close()
  }, 30_000)
})

async function readLine(iterator: AsyncIterator<string>): Promise<string> {
  let output = ''
  while (!output.endsWith('\n')) {
    const chunk = await iterator.next()
    if (chunk.done) throw new Error('Guest stream ended before its expected line.')
    output += chunk.value
  }
  return output
}
