import { exec } from 'node:child_process'
import { env as processEnv } from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OperationTimeoutError, ValidationError } from '../../errors/index.js'
import { inMemorySandbox, type SandboxSession } from '../../sandbox/index.js'
import { invokeMcpTool } from './runner.js'
import { createStdioMcpTransportRunner } from './stdio.js'

const fakeServerPath = fileURLToPath(new URL('../../testing/fixtures/mcp/fake-stdio-server.mjs', import.meta.url))

function config(sandbox: SandboxSession, timeoutMs = 5_000) {
  return {
    localToolId: 'echoLocal',
    kind: 'mcp_stdio' as const,
    description: 'Echo through stdio',
    upstreamToolName: 'echo',
    timeoutMs,
    serverKey: `echoLocal-${Math.random()}`,
    command: '/usr/bin/env',
    args: ['node', fakeServerPath],
    env: { MCP_FAKE_SECRET: 'redacted-secret' },
    sandbox
  }
}

describe('stdio MCP runner', () => {
  it('discovers tools and invokes a fake stdio MCP server', async () => {
    const sandbox = hostExecSandbox()
    const localConfig = config(sandbox as any)
    const runner = createStdioMcpTransportRunner(localConfig)
    try {
      const output = await invokeMcpTool(localConfig, runner, { message: 'hello' }, new AbortController().signal)
      expect(output).toEqual({ echo: 'hello' })
    } finally {
      await runner.close()
      await sandbox.close()
    }
  })

  it('validates input before calling the stdio server', async () => {
    const sandbox = hostExecSandbox()
    const localConfig = config(sandbox as any)
    const runner = createStdioMcpTransportRunner(localConfig)
    try {
      await expect(invokeMcpTool(localConfig, runner, { message: 123 }, new AbortController().signal)).rejects.toBeInstanceOf(ValidationError)
    } finally {
      await runner.close()
      await sandbox.close()
    }
  })

  it('maps process death during calls and respawns on the next call', async () => {
    const sandbox = hostExecSandbox()
    const localConfig = config(sandbox, 5_000)
    const runner = createStdioMcpTransportRunner(localConfig)
    try {
      await expect(invokeMcpTool(localConfig, runner, { message: 'boom', die: true }, new AbortController().signal)).rejects.toMatchObject({
        code: 'MCP_PROTOCOL_ERROR',
        meta: { phase: 'call', transport: 'stdio' }
      })

      await expect(invokeMcpTool(localConfig, runner, { message: 'after' }, new AbortController().signal)).resolves.toEqual({ echo: 'after' })
    } finally {
      await runner.close()
      await sandbox.close()
    }
  })

  it('enforces call timeouts', async () => {
    const sandbox = hostExecSandbox()
    const localConfig = config(sandbox, 20)
    const runner = createStdioMcpTransportRunner(localConfig)
    try {
      await expect(invokeMcpTool(localConfig, runner, { message: 'slow', delayMs: 250 }, new AbortController().signal)).rejects.toBeInstanceOf(OperationTimeoutError)
    } finally {
      await runner.close()
      await sandbox.close()
    }
  })

  it('does not run stdio MCP outside a sandbox executor', async () => {
    const sandbox = await inMemorySandbox().open({ sessionId: 'mcp-test', runId: 'r1' })
    const localConfig = config(sandbox as any)
    const runner = createStdioMcpTransportRunner(localConfig)
    try {
      await expect(invokeMcpTool(localConfig, runner, { message: 'hello' }, new AbortController().signal)).rejects.toMatchObject({
        code: 'SANDBOX_NO_EXECUTOR'
      })
    } finally {
      await runner.close()
      await sandbox.close()
    }
  })
})

function hostExecSandbox(): SandboxSession {
  return {
    executor: 'available',
    async read() { throw new Error('not implemented') },
    async readText() { throw new Error('not implemented') },
    async write() {},
    async remove() {},
    async list() { return [] },
    async stat() { throw new Error('not implemented') },
    async exists() { return false },
    async mount() {},
    async exec(command, opts) {
      return new Promise((resolve, reject) => {
        const started = Date.now()
        const child = exec(command, { env: { ...processEnv, ...(opts?.env ?? {}) }, timeout: opts?.timeoutMs }, (error, stdout, stderr) => {
          if (error && !('code' in error)) {
            reject(error)
            return
          }
          resolve({
            stdout,
            stderr,
            exitCode: typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : 0,
            durationSeconds: (Date.now() - started) / 1000
          })
        })
        if (opts?.stdin) child.stdin?.end(opts.stdin)
        else child.stdin?.end()
        opts?.signal?.addEventListener('abort', () => {
          child.kill()
          reject(opts.signal?.reason ?? new Error('aborted'))
        }, { once: true })
      })
    },
    async close() {}
  }
}
