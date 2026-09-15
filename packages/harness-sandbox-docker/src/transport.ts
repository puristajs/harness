import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { HarnessError, OperationCancelledError, OperationTimeoutError } from '@purista/harness'
import { failure } from './options.js'

export const OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 120_000

export interface DockerResult { stdout: string; stderr: string; exitCode: number }
export interface DockerChild {
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  readonly exit: Promise<{ exitCode: number; signal?: string }>
  write(chunk: string): Promise<void>
  end(chunk?: string): void
  kill(): void
}
export interface DockerTransport { start(args: readonly string[]): Promise<DockerChild> }

/** The only host command this package executes. Arguments never pass through a host shell. */
export const dockerTransport: DockerTransport = {
  async start(args) {
    return await new Promise<DockerChild>((resolve, reject) => {
      const environment = { ...process.env }
      for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete environment[key]
      const child = spawn('docker', [...args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: environment })
      let started = false
      child.once('error', () => {
        if (!started) reject(failure('provider_unavailable', 'The Docker CLI could not be started.'))
      })
      const exit = new Promise<{ exitCode: number; signal?: string }>(resolveExit => {
        child.once('close', (exitCode, signal) => resolveExit({ exitCode: exitCode ?? 1, ...(signal ? { signal } : {}) }))
      })
      child.stdin.on('error', () => undefined)
      child.once('spawn', () => {
        started = true
        resolve({
          stdout: child.stdout,
          stderr: child.stderr,
          exit,
          write: async chunk => await new Promise<void>((resolveWrite, rejectWrite) => {
            child.stdin.write(chunk, error => error ? rejectWrite(failure('process_stdin_closed')) : resolveWrite())
          }),
          end: chunk => child.stdin.end(chunk),
          kill: () => { child.kill('SIGKILL') },
        })
      })
    })
  },
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError('Docker sandbox operation was cancelled.', { scope: 'sandbox' })
}

export async function collect(child: DockerChild, options: {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  stdin?: string | undefined
  cleanup?: (() => Promise<void>) | undefined
} = {}): Promise<DockerResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw failure('invalid_timeout')
  let rejectInterrupted: ((error: Error) => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject })
  const abort = () => rejectInterrupted?.(new OperationCancelledError('Docker sandbox operation was cancelled.', { scope: 'sandbox' }))
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => rejectInterrupted?.(new OperationTimeoutError('Docker sandbox operation timed out.', { scope: 'sandbox_run', timeout_ms: timeoutMs })), timeoutMs)
  const read = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
    const decoder = new StringDecoder('utf8')
    let output = ''
    let bytes = 0
    for await (const chunk of stream) {
      bytes += chunk.byteLength
      if (bytes > OUTPUT_LIMIT_BYTES) throw failure('output_limit_exceeded', 'Docker sandbox output exceeded the 10 MiB per-stream limit.')
      output += decoder.write(Buffer.from(chunk))
    }
    return output + decoder.end()
  }
  try {
    checkCancelled(options.signal)
    child.end(options.stdin)
    const [stdout, stderr, exited] = await Promise.race([
      Promise.all([read(child.stdout), read(child.stderr), child.exit]),
      interrupted,
    ])
    return { stdout, stderr, exitCode: exited.exitCode }
  } catch (error) {
    // Stopping a host CLI cannot prove that its guest command stopped.
    try { await options.cleanup?.() } finally { child.kill() }
    throw error instanceof HarnessError ? error : failure('provider_transport_failed')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
