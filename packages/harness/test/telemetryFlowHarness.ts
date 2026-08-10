import { z } from 'zod'
import { SpanStatusCode, type Span } from '@opentelemetry/api'

import type { Logger } from '../src/logger/index.js'
import type { ObjectResponse, ModelProvider } from '../src/ports/model-provider.js'
import { InMemoryStateStore } from '../src/state/in-memory.js'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { sandboxMemory } from '../src/memory/sandbox/index.js'
import { createSessionHarness } from '../src/sessions/index.js'
import type { TelemetryShim } from '../src/telemetry/index.js'
import { telemetryErrorType } from '../src/telemetry/index.js'
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
  public readonly metrics: Array<{ kind: 'counter' | 'histogram'; name: string; value: number; attrs: Record<string, unknown> }> = []

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
      return await fn(span)
    } catch (error) {
      record.exceptions.push(new Error(telemetryErrorType(error)))
      record.attrs['error.type'] = telemetryErrorType(error)
      if (error && typeof error === 'object' && 'code' in error) {
        const harnessError = error as { code?: string; category?: string; retriable?: boolean; meta?: Record<string, unknown> }
        record.attrs['error.type'] = harnessError.code
        record.attrs['harness.error.code'] = harnessError.code
        record.attrs['harness.error.category'] = harnessError.category
        record.attrs['harness.error.retriable'] = harnessError.retriable
        if (typeof harnessError.meta?.scope === 'string') record.attrs['harness.error.scope'] = harnessError.meta.scope
        if (typeof harnessError.meta?.timeout_ms === 'number') record.attrs['harness.error.timeout_ms'] = harnessError.meta.timeout_ms
      }
      record.status = { code: SpanStatusCode.ERROR, message: telemetryErrorType(error) }
      throw error
    } finally {
      this.stack.pop()
    }
  }

  public recordHistogram(name: string, value: number, attrs: Record<string, unknown>): void {
    this.metrics.push({ kind: 'histogram', name, value, attrs: { ...attrs } })
  }

  public recordCounter(name: string, value: number, attrs: Record<string, unknown>): void {
    this.metrics.push({ kind: 'counter', name, value, attrs: { ...attrs } })
  }

  public currentTraceparent(): string | undefined {
    return this.stack.length > 0 ? '00-00000000000000000000000000000001-0000000000000001-01' : undefined
  }

  public async withTraceContext<T>(carrier: { traceparent: string; tracestate?: string }, fn: () => Promise<T>): Promise<T> {
    this.traceContexts.push(carrier)
    return fn()
  }
}

export class RecordingLogger implements Logger {
  public readonly entries: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []

  public trace(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'trace', msg, fields }) }
  public debug(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'debug', msg, fields }) }
  public info(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'info', msg, fields }) }
  public warn(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'warn', msg, fields }) }
  public error(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'error', msg, fields }) }
  public fatal(msg: string, fields?: Record<string, unknown>): void { this.entries.push({ level: 'fatal', msg, fields }) }
  public child(): Logger { return this }
}

class FlowModelProvider implements ModelProvider {
  public readonly id = 'fake-provider'
  public readonly genAiSystem = 'fake'
  private calls = 0

  public constructor(private readonly failModel = false) {}

  public async object(): Promise<ObjectResponse> {
    if (this.failModel) throw new Error('provider response included user content')
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
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cachedInputTokens: 1, reasoningTokens: 1 },
      finishReason: 'stop'
    }
  }
}

export async function runTelemetryFlowHarness(opts: { failTool?: boolean; failModel?: boolean; hangWorkflow?: boolean; telemetry?: TelemetryOptions } = {}) {
  const telemetry = new RecordingTelemetry()
  const logger = new RecordingLogger()
  const harness = createSessionHarness<any>({
    name: 'telemetry-test',
    logger,
    telemetry: opts.telemetry,
    telemetryShim: telemetry,
    state: new InMemoryStateStore(),
    sandbox: inMemorySandbox(),
    memory: sandboxMemory(),
    defaults: {
      agentMaxIterations: 4,
      runTimeoutMs: 60_000,
      toolTimeoutMs: 10_000,
      skillTimeoutMs: 10_000,
      modelTimeoutMs: 60_000,
      maxParallelToolCalls: 8
    },
    models: {
      fast: { provider: new FlowModelProvider(opts.failModel), model: 'fake', capabilities: ['object', 'tool_use'] }
    },
    tools: {
      policy_lookup: {
        kind: 'ts',
        description: 'Looks up a policy.',
        input: z.object({ query: z.string() }),
        output: z.object({ policy: z.string() }),
        handler: async (ctx) => {
          ctx.metrics.counter('app.policy_lookup.calls')
          await ctx.memory.session.write('tool_seen', { query: ctx.sessionId })
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
        delegation: {},
        handler: async (ctx: any) => {
          if (opts.hangWorkflow) return new Promise<never>(() => undefined)
          await ctx.memory.session.write('workflow_topic', { value: ctx.input })
          await ctx.memory.run.write('workflow_step', { value: 'started' })
          return ctx.metrics.duration('app.workflow.duration', { 'app.workflow.name': 'wf' }, () => ctx.agents.responder(ctx.input))
        }
      }
    }
  })
  const session = await harness.getSession('telemetry-session')
  return { session, telemetry, logger }
}
