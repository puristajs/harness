import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import { env as processEnv } from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SandboxProcess, SpawnCapableSandboxSession } from '../../sandbox/index.js'
import { invokeMcpTool } from './runner.js'
import { createStdioMcpTransportRunner } from './stdio.js'

const fakeServerPath = fileURLToPath(new URL('../../testing/fixtures/mcp/fake-stdio-server.mjs', import.meta.url))

function baseConfig(sandbox: SpawnCapableSandboxSession, upstreamToolName: string, localToolId: string, timeoutMs = 5_000) {
  return {
    localToolId,
    kind: 'mcp_stdio' as const,
    description: 'persistent stdio',
    upstreamToolName,
    timeoutMs,
    serverKey: 'persist',
    command: '/usr/bin/env',
    args: ['node', fakeServerPath],
    sandbox: sandbox as never
  }
}

describe('persistent stdio MCP runner', () => {
  it('preserves server-side state across calls over one spawned process', async () => {
    const sandbox = hostSpawnSandbox()
    const counter = baseConfig(sandbox, 'counter', 'counterLocal')
    const runner = createStdioMcpTransportRunner(counter)
    try {
      // A one-shot transport would reset to 1 each call; persistence proves a single process.
      await expect(invokeMcpTool(counter, runner, {}, new AbortController().signal)).resolves.toEqual({ value: 1 })
      await expect(invokeMcpTool(counter, runner, {}, new AbortController().signal)).resolves.toEqual({ value: 2 })
      await expect(invokeMcpTool(counter, runner, { by: 5 }, new AbortController().signal)).resolves.toEqual({ value: 7 })
    } finally {
      await runner.close()
      await sandbox.close()
    }
  })

  it('respawns a fresh server after the process dies mid-call', async () => {
    const sandbox = hostSpawnSandbox()
    const counter = baseConfig(sandbox, 'counter', 'counterLocal')
    const echo = baseConfig(sandbox, 'echo', 'echoLocal')
    const runner = createStdioMcpTransportRunner(counter)
    try {
      await expect(invokeMcpTool(counter, runner, {}, new AbortController().signal)).resolves.toEqual({ value: 1 })
      await expect(invokeMcpTool(counter, runner, {}, new AbortController().signal)).resolves.toEqual({ value: 2 })

      await expect(invokeMcpTool(echo, runner, { message: 'boom', die: true }, new AbortController().signal)).rejects.toMatchObject({
        code: 'MCP_PROTOCOL_ERROR',
        meta: { phase: 'call', transport: 'stdio' }
      })

      // Next call re-spawns + re-initializes a fresh server; counter resets.
      await expect(invokeMcpTool(counter, runner, {}, new AbortController().signal)).resolves.toEqual({ value: 1 })
    } finally {
      await runner.close()
      await sandbox.close()
    }
  })

  it('terminates the spawned process on close', async () => {
    const sandbox = hostSpawnSandbox()
    const counter = baseConfig(sandbox, 'counter', 'counterLocal')
    const runner = createStdioMcpTransportRunner(counter)
    await invokeMcpTool(counter, runner, {}, new AbortController().signal)
    await expect(runner.close()).resolves.toBeUndefined()
    expect(sandbox.liveProcessCount()).toBe(0)
    await sandbox.close()
  })

  it('finalizes staged data before restarting a server that exited unexpectedly', async () => {
    const sandbox = hostSpawnSandbox()
    const cleanup = vi.fn(async () => undefined)
    const echo = {
      ...baseConfig(sandbox, 'echo', 'echoLocal'),
      prepareLaunch: async () => ({ cleanup })
    }
    const runner = createStdioMcpTransportRunner(echo)
    try {
      await expect(invokeMcpTool(echo, runner, { message: 'before' }, new AbortController().signal)).resolves.toEqual({ echo: 'before' })
      await expect(invokeMcpTool(echo, runner, { message: 'crash', die: true }, new AbortController().signal)).rejects.toMatchObject({
        code: 'MCP_PROTOCOL_ERROR',
        meta: { phase: 'call', transport: 'stdio' }
      })

      await expect(invokeMcpTool(echo, runner, { message: 'after' }, new AbortController().signal)).resolves.toEqual({ echo: 'after' })
      expect(cleanup).toHaveBeenCalledTimes(1)
    } finally {
      await runner.close()
      await sandbox.close()
    }
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('surfaces staged-data synchronization failures during shutdown', async () => {
    const sandbox = hostSpawnSandbox()
    const cleanup = vi.fn(async () => { throw new Error('plugin data synchronization failed') })
    const echo = {
      ...baseConfig(sandbox, 'echo', 'echoLocal'),
      prepareLaunch: async () => ({ cleanup })
    }
    const runner = createStdioMcpTransportRunner(echo)
    await expect(invokeMcpTool(echo, runner, { message: 'hello' }, new AbortController().signal)).resolves.toEqual({ echo: 'hello' })
    await expect(runner.close()).rejects.toBeInstanceOf(AggregateError)
    expect(cleanup).toHaveBeenCalledTimes(1)
    await sandbox.close()
  })
})

interface HostSpawnSandbox extends SpawnCapableSandboxSession {
  liveProcessCount(): number
}

function hostSpawnSandbox(): HostSpawnSandbox {
  const children = new Set<ChildProcessWithoutNullStreams>()
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
    liveProcessCount() {
      return [...children].filter((child) => child.exitCode === null && !child.killed).length
    },
    async spawn(command, opts): Promise<SandboxProcess> {
      const child = spawn(command, [...(opts?.args ?? [])], {
        env: { ...processEnv, ...(opts?.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      children.add(child)
      const exit = new Promise<{ exitCode: number; signal?: string }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ exitCode: code ?? 0, ...(signal ? { signal } : {}) }))
      })
      opts?.signal?.addEventListener('abort', () => child.kill(), { once: true })
      return {
        async writeStdin(chunk) { child.stdin.write(chunk) },
        stdout: decodeStream(child.stdout),
        stderr: decodeStream(child.stderr),
        exit,
        async kill(signal) { child.kill(signal ?? 'SIGTERM') }
      }
    },
    async close() {
      for (const child of children) child.kill('SIGKILL')
    }
  }
}

async function* decodeStream(stream: Readable): AsyncIterable<string> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    yield decoder.decode(chunk as Buffer, { stream: true })
  }
}
