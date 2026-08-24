import { z } from 'zod'

import type { Logger } from '../src/logger/index.js'
import type { ObjectResponse, ModelProvider } from '../src/ports/model-provider.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { sandboxMemory } from '../src/memory/sandbox/index.js'
import { createSessionHarness } from '../src/sessions/index.js'
import type { TelemetryOptions } from '../src/index.js'
import type { AgentExecutionInterceptor } from '../src/harness/defineHarness.js'
import { RecordingTelemetry } from '../src/testing/recordingTelemetry.js'

export { RecordingTelemetry } from '../src/testing/recordingTelemetry.js'

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

export async function runTelemetryFlowHarness(opts: { failTool?: boolean; failModel?: boolean; hangWorkflow?: boolean; telemetry?: TelemetryOptions; interceptors?: readonly AgentExecutionInterceptor[] } = {}) {
  const telemetry = new RecordingTelemetry()
  const logger = new RecordingLogger()
  const harness = createSessionHarness<any>({
    name: 'telemetry-test',
    logger,
    telemetry: opts.telemetry,
    telemetryShim: telemetry,
    storage: new InMemoryHarnessStorage(),
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
        builtinTools: false,
        ...(opts.interceptors ? { interceptors: opts.interceptors } : {})
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
