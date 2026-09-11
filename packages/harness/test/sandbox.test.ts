import { describe, expect, it } from 'vitest'
import { bashSandbox, inMemorySandbox, type BashSandboxOptions } from '../src/sandbox/index.js'
import { HarnessConfigError, OperationTimeoutError } from '../src/errors/index.js'
import { sandboxContract } from '../src/testing/sandboxContract.js'

function scope(id: string, runId?: string) {
  return { owner: { namespace: 'sandbox-test', id, instanceId: '01J00000000000000000000000' }, partition: { kind: 'shared' as const }, ...(runId ? { lifetime: 'run' as const, runId } : { lifetime: 'session' as const }) }
}

async function open(sandbox: ReturnType<typeof inMemorySandbox> | ReturnType<typeof bashSandbox>, target: ReturnType<typeof scope>, mode: 'create' | 'attach' = 'create') {
  await sandbox.registerOwner({ owner: target.owner, mode: mode === 'create' ? 'create' : 'attach' })
  return await sandbox.open({ scope: target, mode })
}

describe('inMemorySandbox', () => {
  sandboxContract(() => inMemorySandbox(), { executor: 'unavailable' })
})

describe('bashSandbox', () => {
  sandboxContract(() => bashSandbox(), { executor: 'available' })

  it('shares mounted files and command output through every attachment', async () => {
    const sandbox = bashSandbox()
    const target = scope('s')
    const first = (await open(sandbox, target)).session
    await first.write('/workspace/input.txt', 'hello')
    await first.mount(new Map([['SKILL.md', 'skill instructions']]), '/skills/example')
    const second = (await open(sandbox, target, 'attach')).session
    const result = await second.exec('cat /workspace/input.txt /skills/example/SKILL.md > /workspace/output.txt')
    expect(result.exitCode).toBe(0)
    await expect(first.readText('/workspace/output.txt')).resolves.toBe('helloskill instructions')
    await first.remove('/workspace/input.txt')
    expect((await second.exec('test -f /workspace/input.txt')).exitCode).not.toBe(0)
  })

  it('rejects unsupported or invalid configuration instead of ignoring limits', () => {
    for (const options of [
      { network: { deny: ['https://example.com'] } },
      { executionLimits: { memoryMb: 128 } },
      { executionLimits: { wallClockMs: -1 } },
      { executionLimits: { maxFileSystemBytes: Number.POSITIVE_INFINITY } },
      { network: { allow: ['not-a-url'] } },
      { unknown: true }
    ]) {
      expect(() => bashSandbox(options as BashSandboxOptions)).toThrow(HarnessConfigError)
    }
  })

  it('enforces the configured filesystem byte budget', async () => {
    const sandbox = bashSandbox({ executionLimits: { maxFileSystemBytes: 64 * 1024 } })
    const { session } = await open(sandbox, scope('limited'))
    await expect(session.write('/workspace/too-large.txt', 'a'.repeat(128 * 1024))).rejects.toMatchObject({ code: 'SANDBOX_ERROR' })
    await session.write('/workspace/small.txt', 'small')
    await expect(session.readText('/workspace/small.txt')).resolves.toBe('small')
  })

  it('applies the configured wall-clock limit when exec does not provide a timeout', async () => {
    const sandbox = bashSandbox({ executionLimits: { wallClockMs: 100 } })
    const { session } = await open(sandbox, scope('wall-clock'))
    await expect(session.exec('sleep 1')).rejects.toBeInstanceOf(OperationTimeoutError)
    expect((await session.exec('echo recovered')).stdout).toBe('recovered\n')
  })
})

it('glob list is anchored and does not throw on regex metacharacters', async () => {
  const sandbox = inMemorySandbox()
  const session = (await open(sandbox, scope('s', 'r'))).session
  await session.write('/a.ts', 'x')
  await session.write('/a.tsx', 'x')
  await session.write('/b.json', 'x')

  const ts = await session.list('/', { recursive: true, glob: '*.ts' })
  // Anchored: *.ts must NOT match a.tsx
  expect(ts.map((e) => e.path).sort()).toEqual(['/a.ts'])

  // A pattern with a regex metacharacter must not throw a SyntaxError.
  await expect(session.list('/', { recursive: true, glob: 'a[.ts' })).resolves.toBeDefined()
  await session.close?.()
})
