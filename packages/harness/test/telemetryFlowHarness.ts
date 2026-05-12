import { z } from 'zod'
import { SpanStatusCode, type Span } from '@opentelemetry/api'

import { JsonLogger } from '../src/logger/index.js'
import type { ObjectResponse, ModelProvider } from '../src/ports/model-provider.js'
import { InMemoryStateStore } from '../src/state/in-memory.js'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { createSessionHarness } from '../src/sessions/index.js'
import type { TelemetryShim } from '../src/telemetry/index.js'
import type { TelemetryOptions } from '../src/index.js'

export class RecordingTelemetry implements TelemetryShim {
  public readonly spans: Array<{
    id: string
    parentId?: string
    name: string
    attrs: Record<string, unknown>
    status?: { code: SpanStatusCode; message?: string }
    exceptions: unknown[]
  }> = []
  public readonly traceContexts: Array<{ traceparent: string; tracestate?: string }> = []

  private readonly stack: string[] = []

  public async span<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>): Promise<T> {
    const id = `span-${this.spans.length + 1}`
    const record = { id, parentId: this.stack.at(-1), name, attrs: { ...attrs }, exceptions: [] as unknown[] }
    this.spans.push(record)
    const span = {
      setAttribute: (key: string, value: unknown) => { record.attrs[key] = value; return span },
      setAttributes: (next: Record<string, unknown>) => { Object.assign(record.attrs, next); return span },
      recordException: (error: unknown) => { record.exceptions.push(error) },
      setStatus: (status: { code: SpanStatusCode; message?: string }) => { record.status = status },
      end: () => undefined
    } as unknown as Span

    this.stack.push(id)
    try {
      const result = await fn(span)
      record.status ??= { code: SpanStatusCode.OK }
      return result
    } catch (error) {
      record.exceptions.push(error)
      if (error && typeof error === 'object' && 'code' in error) {
        const harnessError = error as { code?: string; category?: string; retriable?: boolean }
        record.attrs['error.type'] = harnessError.code
        record.attrs['harness.error.code'] = harnessError.code
        record.attrs['harness.error.category'] = harnessError.category
        record.attrs['harness.error.retriable'] = harnessError.retriable
      }
      record.status = { code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) }
      throw error
    } finally {
      this.stack.pop()
    }
  }

  public recordHistogram(): void {}

  public recordCounter(): void {}

  public currentTraceparent(): string | undefined {
    return this.stack.length > 0 ? '00-00000000000000000000000000000001-0000000000000001-01' : undefined
  }

  public async withTraceContext<T>(carrier: { traceparent: string; tracestate?: string }, fn: () => Promise<T>): Promise<T> {
    this.traceContexts.push(carrier)
    return fn()
  }
}

class FlowModelProvider implements ModelProvider {
  public readonly id = 'fake-provider'
  public readonly genAiSystem = 'fake'
  private calls = 0

  public async object(): Promise<ObjectResponse> {
    this.calls += 1
    if (this.calls === 1) {
      return {
        object: {},
        toolCalls: [{ id: 'call-1', name: 'policy_lookup', arguments: { query: 'policy' } }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'tool_calls'
      }
    }
    return {
      object: { answer: 'Policy says yes.' },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: 'stop'
    }
  }
}

export async function runTelemetryFlowHarness(opts: { failTool?: boolean; telemetry?: TelemetryOptions } = {}) {
  const telemetry = new RecordingTelemetry()
  const harness = createSessionHarness<any>({
    name: 'telemetry-test',
    logger: new JsonLogger({ level: 'fatal' }),
    telemetry: opts.telemetry,
    telemetryShim: telemetry,
    state: new InMemoryStateStore(),
    sandbox: inMemorySandbox(),
    defaults: {
      agentMaxIterations: 4,
      runTimeoutMs: 60_000,
      toolTimeoutMs: 10_000,
      skillTimeoutMs: 10_000,
      modelTimeoutMs: 60_000
    },
    models: {
      fast: { provider: new FlowModelProvider(), model: 'fake', capabilities: ['object', 'tool_use'] }
    },
    tools: {
      policy_lookup: {
        kind: 'ts',
        description: 'Looks up a policy.',
        input: z.object({ query: z.string() }),
        output: z.object({ policy: z.string() }),
        handler: async () => {
          if (opts.failTool) throw new Error('policy backend unavailable')
          return { policy: 'yes' }
        }
      }
    },
    skills: {},
    agents: {
      responder: {
        input: z.string(),
        output: z.object({ answer: z.string() }),
        model: 'fast',
        instructions: 'Answer with policy context.',
        tools: ['policy_lookup'],
        builtinTools: false
      }
    },
    workflows: {
      wf: {
        input: z.string(),
        output: z.object({ answer: z.string() }),
        handler: async (ctx: any) => ctx.agents.responder(ctx.input)
      }
    }
  })
  const session = await harness.getSession('telemetry-session')
  return { session, telemetry }
}
