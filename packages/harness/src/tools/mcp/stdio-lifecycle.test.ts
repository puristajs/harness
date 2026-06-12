import { describe, expect, it } from 'vitest'
import { OperationTimeoutError } from '../../errors/index.js'
import type { SandboxProcess, SandboxSession, SpawnCapableSandboxSession } from '../../sandbox/index.js'
import type { McpDiscoveredTool, ResolvedMcpStdioTool } from './runner.js'
import { createMcpRunnerRegistry, invokeMcpTool } from './runner.js'
import { createStdioMcpTransportRunner } from './stdio.js'

interface ScriptedSpawnOptions {
  /** Discovered tools per spawn (index = spawn number, last entry repeats). */
  toolsPerSpawn?: McpDiscoveredTool[][]
  /** Respond to `initialize` with a JSON-RPC error. */
  initializeError?: boolean
  /** Content written to stderr right after spawn. */
  stderr?: string
  /** Ignore SIGTERM so close() must escalate to SIGKILL. */
  ignoreSigterm?: boolean
  /** Throw from writeStdin for messages after the handshake. */
  failWritesAfterHandshake?: boolean
}

function tool(name: string): McpDiscoveredTool {
  return { name, description: name, inputSchema: { type: 'object' } }
}

function baseConfig(sandbox: SpawnCapableSandboxSession, upstreamToolName: string): ResolvedMcpStdioTool {
  return {
    localToolId: 'scripted',
    kind: 'mcp_stdio',
    description: 'scripted stdio tool',
    upstreamToolName,
    timeoutMs: 2_000,
    serverKey: 'scripted:session-1',
    sandboxKey: 'session-1',
    command: 'fake-server',
    sandbox: sandbox as never
  }
}

describe('persistent stdio runner lifecycle', () => {
  it('fails the handshake with a connect protocol error and kills the server when initialize reports an error', async () => {
    const sandbox = scriptedSandbox({ initializeError: true })
    const config = baseConfig(sandbox, 'alpha')
    const runner = createStdioMcpTransportRunner(config, { closeGraceMs: 50 })

    await expect(invokeMcpTool(config, runner, {}, new AbortController().signal)).rejects.toMatchObject({
      code: 'MCP_PROTOCOL_ERROR',
      meta: { transport: 'stdio', phase: 'connect' }
    })
    expect(sandbox.processes[0]?.killSignals).toContain('SIGTERM')
    expect(sandbox.processes[0]?.exited).toBe(true)
    await runner.close()
  })

  it('enriches process-exit failures with the recent stderr tail', async () => {
    const sandbox = scriptedSandbox({ toolsPerSpawn: [[tool('die')]], stderr: 'boom from server stderr' })
    const config = baseConfig(sandbox, 'die')
    const runner = createStdioMcpTransportRunner(config, { closeGraceMs: 50 })

    let caught: unknown
    try {
      await invokeMcpTool(config, runner, {}, new AbortController().signal)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'MCP_PROTOCOL_ERROR' })
    expect(String((caught as { cause?: { message?: string } }).cause?.message)).toContain('boom from server stderr')
    await runner.close()
  })

  it('escalates to SIGKILL when the server ignores SIGTERM on close', async () => {
    const sandbox = scriptedSandbox({ toolsPerSpawn: [[tool('alpha')]], ignoreSigterm: true })
    const config = baseConfig(sandbox, 'alpha')
    const runner = createStdioMcpTransportRunner(config, { closeGraceMs: 50 })

    await expect(invokeMcpTool(config, runner, {}, new AbortController().signal)).resolves.toEqual({ ok: 'alpha' })
    await expect(runner.close()).resolves.toBeUndefined()
    expect(sandbox.processes[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(sandbox.processes[0]?.exited).toBe(true)
  })

  it('cleans up the pending request when writing to the server fails', async () => {
    const sandbox = scriptedSandbox({ toolsPerSpawn: [[tool('alpha')]], failWritesAfterHandshake: true })
    const config = baseConfig(sandbox, 'alpha')
    const runner = createStdioMcpTransportRunner(config, { closeGraceMs: 50 })

    await expect(invokeMcpTool(config, runner, {}, new AbortController().signal)).rejects.toMatchObject({
      code: 'MCP_PROTOCOL_ERROR'
    })
    // Closing rejects all pending entries; a leaked entry for the failed write
    // would surface as an unhandled rejection and fail the test run.
    await runner.close()
  })

  it('re-discovers the tool list after the persistent server respawns', async () => {
    const sandbox = scriptedSandbox({ toolsPerSpawn: [[tool('alpha'), tool('die')], [tool('beta')]] })
    const registry = createMcpRunnerRegistry()
    const alpha = baseConfig(sandbox, 'alpha')
    const die = baseConfig(sandbox, 'die')
    const beta = baseConfig(sandbox, 'beta')

    try {
      await expect(invokeMcpTool(alpha, registry.getRunner(alpha), {}, new AbortController().signal)).resolves.toEqual({ ok: 'alpha' })
      await expect(invokeMcpTool(die, registry.getRunner(die), {}, new AbortController().signal)).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' })
      // The respawned server only exposes `beta`; without cache invalidation
      // the stale discovery would raise TOOL_NOT_FOUND here.
      await expect(invokeMcpTool(beta, registry.getRunner(beta), {}, new AbortController().signal)).resolves.toEqual({ ok: 'beta' })
      expect(sandbox.processes).toHaveLength(2)
    } finally {
      await registry.close()
    }
  })
})

describe('one-shot stdio runner', () => {
  it('retries a failed install instead of caching the rejection', async () => {
    let installAttempts = 0
    const session = oneShotSandbox({
      onInstall: () => {
        installAttempts += 1
        return installAttempts === 1 ? { exitCode: 1, stderr: 'install failed' } : { exitCode: 0 }
      },
      tools: [tool('alpha')]
    })
    const config: ResolvedMcpStdioTool = {
      ...baseConfig(session as never, 'alpha'),
      install: { command: 'install-server' },
      sandbox: session
    }
    const runner = createStdioMcpTransportRunner(config)

    await expect(invokeMcpTool(config, runner, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR' })
    await expect(invokeMcpTool(config, runner, {}, new AbortController().signal)).resolves.toEqual({ ok: 'alpha' })
    expect(installAttempts).toBe(2)
    await runner.close()
  })

  it('propagates exec timeouts unwrapped, consistent with the persistent runner', async () => {
    const session = oneShotSandbox({
      onExchange: () => {
        throw new OperationTimeoutError('Sandbox exec timed out.', { scope: 'tool', timeout_ms: 5 })
      }
    })
    const config: ResolvedMcpStdioTool = { ...baseConfig(session as never, 'alpha'), sandbox: session }
    const runner = createStdioMcpTransportRunner(config)

    await expect(runner.listTools()).rejects.toBeInstanceOf(OperationTimeoutError)
    await runner.close()
  })
})

interface ScriptedProcess extends SandboxProcess {
  killSignals: string[]
  exited: boolean
}

interface ScriptedSandbox extends SpawnCapableSandboxSession {
  processes: ScriptedProcess[]
}

function createAsyncQueue<T>() {
  const values: T[] = []
  const resolvers: Array<(result: IteratorResult<T>) => void> = []
  let done = false
  return {
    push(value: T) {
      const resolve = resolvers.shift()
      if (resolve) resolve({ value, done: false })
      else values.push(value)
    },
    end() {
      done = true
      for (const resolve of resolvers.splice(0)) resolve({ value: undefined as never, done: true })
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift()
            if (value !== undefined) return Promise.resolve({ value, done: false })
            if (done) return Promise.resolve({ value: undefined as never, done: true })
            return new Promise((resolve) => resolvers.push(resolve))
          }
        }
      }
    } as AsyncIterable<T>
  }
}

/** In-process scripted MCP stdio server behind the SpawnCapableSandboxSession contract. */
function scriptedSandbox(options: ScriptedSpawnOptions): ScriptedSandbox {
  const processes: ScriptedProcess[] = []

  function createProcess(spawnIndex: number): ScriptedProcess {
    const stdout = createAsyncQueue<string>()
    const stderr = createAsyncQueue<string>()
    let resolveExit: (result: { exitCode: number; signal?: string }) => void
    const exit = new Promise<{ exitCode: number; signal?: string }>((resolve) => { resolveExit = resolve })
    const toolsPerSpawn = options.toolsPerSpawn ?? [[]]
    const tools = toolsPerSpawn[Math.min(spawnIndex, toolsPerSpawn.length - 1)] ?? []
    let handshakeDone = false

    const proc: ScriptedProcess = {
      killSignals: [],
      exited: false,
      stdout: stdout.iterable,
      stderr: stderr.iterable,
      exit,
      async kill(signal) {
        proc.killSignals.push(signal ?? 'SIGTERM')
        if (signal === 'SIGTERM' && options.ignoreSigterm) return
        terminate(143, signal ?? 'SIGTERM')
      },
      async writeStdin(chunk) {
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const message = JSON.parse(trimmed) as { id?: number; method?: string; params?: { name?: string } }
          if (message.method === 'initialize') {
            stdout.push(options.initializeError
              ? `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'initialize rejected' } })}\n`
              : `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } })}\n`)
            continue
          }
          if (message.method === 'notifications/initialized') {
            handshakeDone = true
            continue
          }
          if (options.failWritesAfterHandshake && handshakeDone) {
            throw new Error('broken pipe')
          }
          if (message.method === 'tools/list') {
            stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools } })}\n`)
            continue
          }
          if (message.method === 'tools/call') {
            if (message.params?.name === 'die') {
              terminate(9)
              continue
            }
            const result = { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: message.params?.name ?? 'unknown' } }
            stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
          }
        }
      }
    }

    function terminate(exitCode: number, signal?: string): void {
      if (proc.exited) return
      proc.exited = true
      stdout.end()
      stderr.end()
      resolveExit({ exitCode, ...(signal ? { signal } : {}) })
    }

    if (options.stderr) stderr.push(options.stderr)
    return proc
  }

  return {
    processes,
    executor: 'available',
    async read() { throw new Error('not implemented') },
    async readText() { throw new Error('not implemented') },
    async write() {},
    async remove() {},
    async list() { return [] },
    async stat() { throw new Error('not implemented') },
    async exists() { return false },
    async mount() {},
    async spawn() {
      const proc = createProcess(processes.length)
      processes.push(proc)
      return proc
    },
    async close() {
      for (const proc of processes) await proc.kill('SIGKILL')
    }
  }
}

interface OneShotSandboxOptions {
  onInstall?: () => { exitCode: number; stdout?: string; stderr?: string }
  onExchange?: () => never
  tools?: McpDiscoveredTool[]
}

/** Exec-only sandbox that answers one-shot JSON-RPC exchanges from a script. */
function oneShotSandbox(options: OneShotSandboxOptions): SandboxSession {
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
      if (command === 'install-server') {
        const result = options.onInstall?.() ?? { exitCode: 0 }
        return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode, durationSeconds: 0 }
      }
      options.onExchange?.()
      const lines: string[] = []
      for (const line of (opts?.stdin ?? '').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const message = JSON.parse(trimmed) as { id?: number; method?: string; params?: { name?: string } }
        if (message.method === 'initialize') {
          lines.push(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }))
        } else if (message.method === 'tools/list') {
          lines.push(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: options.tools ?? [] } }))
        } else if (message.method === 'tools/call') {
          const result = { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: message.params?.name ?? 'unknown' } }
          lines.push(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
        }
      }
      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0, durationSeconds: 0 }
    },
    async close() {}
  }
}
