import { SpanStatusCode } from '@opentelemetry/api'
import { expect, it } from 'vitest'
import { z } from 'zod'

import { RecordingLogger, RecordingTelemetry, runTelemetryFlowHarness } from './telemetryFlowHarness.js'
import { OperationTimeoutError } from '../src/errors/index.js'
import { createModelRegistry } from '../src/models/registry.js'
import { createSessionHarness } from '../src/sessions/index.js'
import { InMemoryStateStore } from '../src/state/in-memory.js'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { sandboxMemory } from '../src/memory/sandbox/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { startFakeHttpMcpServer } from '../src/testing/fixtures/mcp/fake-http-server.js'

it('emits a traceable session workflow agent model tool flow', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness()

  await expect(session.workflows.wf.prompt('find the policy')).resolves.toEqual({ answer: 'Policy says yes.' })

  const sessionSpan = telemetry.spans.find((span) => span.name === 'harness.session.prompt')
  const workflowSpan = telemetry.spans.find((span) => span.name === 'harness.workflow.run')
  const agentSpan = telemetry.spans.find((span) => span.name === 'invoke_agent responder')
  const modelSpans = telemetry.spans.filter((span) => span.name === 'chat fake')
  const toolSpan = telemetry.spans.find((span) => span.name === 'execute_tool policy_lookup')

  expect(sessionSpan).toBeDefined()
  expect(workflowSpan?.parentId).toBe(sessionSpan?.id)
  expect(agentSpan?.parentId).toBe(workflowSpan?.id)
  expect(modelSpans.at(0)?.parentId).toBe(agentSpan?.id)
  expect(toolSpan?.parentId).toBe(agentSpan?.id)
  expect(modelSpans.at(1)?.parentId).toBe(agentSpan?.id)
  expect(toolSpan?.attrs).toMatchObject({
    'harness.session.id': 'telemetry-session',
    'harness.workflow.id': 'wf',
    'harness.agent.id': 'responder',
    'gen_ai.tool.name': 'policy_lookup',
    'gen_ai.agent.name': 'responder',
    'gen_ai.tool.type': 'function'
  })
  expect(modelSpans.at(0)?.attrs).toMatchObject({
    'harness.model.alias': 'fast',
    'gen_ai.system': 'fake',
    'gen_ai.provider.name': 'fake',
    'gen_ai.request.model': 'fake',
    'gen_ai.conversation.id': 'telemetry-session',
    'gen_ai.output.type': 'json'
  })
  expect(workflowSpan?.attrs).toMatchObject({
    'gen_ai.operation.name': 'invoke_workflow',
    'gen_ai.workflow.name': 'wf',
    'gen_ai.conversation.id': 'telemetry-session'
  })
  expect(agentSpan?.attrs).toMatchObject({ 'gen_ai.conversation.id': 'telemetry-session' })
  expect(sessionSpan?.status).toBeUndefined()
  expect(workflowSpan?.status).toBeUndefined()
  expect(modelSpans.at(1)?.attrs['gen_ai.usage.total_tokens']).toBe(3)
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'histogram', name: 'gen_ai.invoke_workflow.duration' }),
    expect.objectContaining({ kind: 'histogram', name: 'gen_ai.invoke_agent.duration' }),
    expect.objectContaining({ kind: 'histogram', name: 'gen_ai.execute_tool.duration' }),
    expect.objectContaining({ kind: 'histogram', name: 'gen_ai.client.operation.duration' })
  ]))
})

it('marks failing spans with standard OTel error status and safe error attributes', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness({ failTool: true })

  await expect(session.workflows.wf.prompt('find the policy')).resolves.toEqual({ answer: 'Policy says yes.' })

  const failed = telemetry.spans.filter((span) => span.status?.code === SpanStatusCode.ERROR)
  expect(failed.map((span) => span.name)).toEqual(['execute_tool policy_lookup'])
  const toolSpan = telemetry.spans.find((span) => span.name === 'execute_tool policy_lookup')
  expect(toolSpan?.attrs).toMatchObject({
    'error.type': 'TOOL_ERROR',
    'harness.error.code': 'TOOL_ERROR',
    'harness.error.category': 'tool',
    'harness.error.retriable': false
  })
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'histogram',
      name: 'harness.tool.duration',
      attrs: expect.objectContaining({
        'harness.tool.id': 'policy_lookup',
        'harness.error.code': 'TOOL_ERROR',
        'harness.error.category': 'tool',
        'harness.error.retriable': false
      })
    }),
    expect.objectContaining({
      kind: 'histogram',
      name: 'gen_ai.execute_tool.duration',
      attrs: expect.objectContaining({
        'harness.tool.id': 'policy_lookup',
        'error.type': 'TOOL_ERROR'
      })
    })
  ]))
})

it('adds content-free Agent Plugin provenance to the existing MCP tool span and metrics', async () => {
  const server = await startFakeHttpMcpServer()
  const telemetry = new RecordingTelemetry()
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'call-1', name: 'plugin_echo', arguments: { message: 'hello' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  model.enqueue({ object: { answer: 'done' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = createSessionHarness<any>({
    name: 'plugin-provenance-test',
    logger: new RecordingLogger(),
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
      maxParallelToolCalls: 1
    },
    models: { fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } },
    tools: {
      plugin_echo: {
        kind: 'mcp_http',
        description: 'Echo through an approved plugin MCP server.',
        url: server.url,
        tool: 'echo',
        provenance: {
          name: 'example-plugin',
          version: '1.2.3',
          digest: 'a'.repeat(64),
          component: 'mcp'
        }
      }
    },
    skills: {},
    agents: {
      responder: {
        input: z.string(),
        output: z.object({ answer: z.string() }),
        model: 'fast',
        instructions: 'Use the plugin echo tool.',
        tools: ['plugin_echo'],
        builtinTools: false
      }
    },
    workflows: {}
  })

  try {
    const session = await harness.getSession('plugin-provenance-session')
    await expect(session.agents.responder.prompt('hello')).resolves.toEqual({ answer: 'done' })
    const toolSpan = telemetry.spans.find((span) => span.name === 'execute_tool plugin_echo')
    const toolMetric = telemetry.metrics.find((metric) => metric.name === 'harness.tool.duration')
    const expected = {
      'harness.mcp.server': 'plugin_echo',
      'harness.mcp.tool': 'echo',
      'harness.mcp.transport': 'http',
      'harness.plugin.name': 'example-plugin',
      'harness.plugin.version': '1.2.3',
      'harness.plugin.digest': 'a'.repeat(64),
      'harness.plugin.component': 'mcp'
    }
    expect(toolSpan?.attrs).toMatchObject(expected)
    expect(toolMetric?.attrs).toMatchObject(expected)
    await session.close()
  } finally {
    await server.close()
  }
})

it('tracks streamed model time to first chunk without recording content', async () => {
  const telemetry = new RecordingTelemetry()
  const models = createModelRegistry({
    stream: {
      provider: {
        id: 'fake-provider',
        genAiSystem: 'fake',
        async *textStream() {
          yield { delta: 'private response content' }
        }
      },
      model: 'fake',
      capabilities: ['text_stream'] as const
    }
  }, { telemetry, harnessName: 'telemetry-test' })

  const chunks: unknown[] = []
  for await (const chunk of models.stream.textStream({ messages: [] }, new AbortController().signal, { sessionId: 'telemetry-session' })) {
    chunks.push(chunk)
  }

  expect(chunks).toEqual([{ delta: 'private response content' }])
  const span = telemetry.spans.find((candidate) => candidate.name === 'chat fake')
  expect(span?.attrs).toMatchObject({
    'gen_ai.request.stream': true,
    'gen_ai.output.type': 'text',
    'gen_ai.response.time_to_first_chunk': expect.any(Number),
    'gen_ai.conversation.id': 'telemetry-session'
  })
  expect(JSON.stringify(span?.attrs)).not.toContain('private response content')
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'histogram', name: 'gen_ai.client.operation.time_to_first_chunk' }),
    expect.objectContaining({ kind: 'histogram', name: 'gen_ai.client.operation.duration' })
  ]))
})

it('records failed model duration with the same error.type as its span', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness({ failModel: true })

  await expect(session.workflows.wf.prompt('find the policy')).rejects.toThrow('provider response included user content')

  const modelSpan = telemetry.spans.find((span) => span.name === 'chat fake')
  expect(modelSpan?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Error' })
  expect(modelSpan?.attrs['error.type']).toBe('Error')
  expect(modelSpan?.exceptions).toEqual([expect.objectContaining({ message: 'Error' })])
  expect(JSON.stringify(modelSpan?.exceptions)).not.toContain('provider response included user content')
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'histogram',
      name: 'gen_ai.client.operation.duration',
      attrs: expect.objectContaining({ 'error.type': 'Error' })
    }),
    expect.objectContaining({
      kind: 'histogram',
      name: 'gen_ai.invoke_agent.duration',
      attrs: expect.objectContaining({ 'error.type': 'Error' })
    }),
    expect.objectContaining({
      kind: 'histogram',
      name: 'gen_ai.invoke_workflow.duration',
      attrs: expect.objectContaining({ 'error.type': 'Error' })
    })
  ]))
})

it('records run timeout cancellation in logs and trace error attributes', async () => {
  const { session, telemetry, logger } = await runTelemetryFlowHarness({ hangWorkflow: true })

  await expect(session.workflows.wf.prompt('find the policy', { timeoutMs: 5 })).rejects.toBeInstanceOf(OperationTimeoutError)

  expect(logger.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      level: 'error',
      msg: 'Harness workflow run failed.',
      fields: expect.objectContaining({
        error: expect.objectContaining({
          code: 'OPERATION_TIMEOUT',
          meta: expect.objectContaining({ scope: 'run', timeout_ms: 5 })
        })
      })
    })
  ]))

  const sessionSpan = telemetry.spans.find((span) => span.name === 'harness.session.prompt')
  const workflowSpan = telemetry.spans.find((span) => span.name === 'harness.workflow.run')
  for (const span of [sessionSpan, workflowSpan]) {
    expect(span?.status?.code).toBe(SpanStatusCode.ERROR)
    expect(span?.attrs).toMatchObject({
      'harness.error.code': 'OPERATION_TIMEOUT',
      'harness.error.category': 'timeout',
      'harness.error.scope': 'run',
      'harness.error.timeout_ms': 5
    })
  }
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'histogram',
      name: 'gen_ai.invoke_workflow.duration',
      attrs: expect.objectContaining({ 'error.type': 'OPERATION_TIMEOUT' })
    })
  ]))
})

it('emits OpenInference attributes alongside GenAI attributes by default', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness()

  await session.workflows.wf.prompt('find the policy')

  const agentSpan = telemetry.spans.find((span) => span.name === 'invoke_agent responder')
  const modelSpan = telemetry.spans.find((span) => span.name === 'chat fake')
  const toolSpan = telemetry.spans.find((span) => span.name === 'execute_tool policy_lookup')

  expect(agentSpan?.attrs).toMatchObject({
    'gen_ai.operation.name': 'invoke_agent',
    'openinference.span.kind': 'AGENT',
    'gen_ai.agent.id': 'responder',
    'metadata.agent_id': 'responder',
    'harness.agent.id': 'responder'
  })
  expect(modelSpan?.attrs).toMatchObject({
    'gen_ai.request.model': 'fake',
    'openinference.span.kind': 'LLM',
    'llm.provider': 'fake'
  })
  expect(toolSpan?.attrs).toMatchObject({
    'gen_ai.tool.name': 'policy_lookup',
    'openinference.span.kind': 'TOOL',
    'tool.name': 'policy_lookup'
  })
})

it('filters telemetry namespaces by configured flavor', async () => {
  const genAi = await runTelemetryFlowHarness({ telemetry: { flavor: 'gen_ai_only' } })
  await genAi.session.workflows.wf.prompt('find the policy')
  const genAiModelSpan = genAi.telemetry.spans.find((span) => span.name === 'chat fake')
  expect(genAiModelSpan?.attrs['gen_ai.request.model']).toBe('fake')
  expect(genAiModelSpan?.attrs['openinference.span.kind']).toBeUndefined()
  expect(genAiModelSpan?.attrs['llm.token_count.total']).toBeUndefined()

  const openInference = await runTelemetryFlowHarness({ telemetry: { flavor: 'openinference_only' } })
  await openInference.session.workflows.wf.prompt('find the policy')
  const openInferenceModelSpan = openInference.telemetry.spans.find((span) => span.name === 'chat fake')
  expect(openInferenceModelSpan?.attrs['gen_ai.request.model']).toBeUndefined()
  expect(openInferenceModelSpan?.attrs['gen_ai.usage.total_tokens']).toBeUndefined()
  expect(openInferenceModelSpan?.attrs['openinference.span.kind']).toBe('LLM')
})

it('extracts valid incoming Trace Context before root spans', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness()

  await session.workflows.wf.prompt('find the policy', {
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    tracestate: 'vendor=value'
  })

  expect(telemetry.traceContexts).toEqual([
    {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=value'
    }
  ])
})

it('ignores invalid incoming Trace Context', async () => {
  const { session, telemetry, logger } = await runTelemetryFlowHarness()

  await session.workflows.wf.prompt('find the policy', {
    traceparent: 'invalid'
  })

  expect(telemetry.traceContexts).toEqual([])
  expect(logger.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      level: 'warn',
      fields: expect.objectContaining({ 'harness.warning.code': 'INVALID_TRACE_CONTEXT' })
    })
  ]))
})

it('emits sanitized scalar invoke metadata as harness metadata attributes', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness()

  await session.workflows.wf.prompt('find the policy', {
    metadata: {
      tenant: 'acme',
      runNumber: 7,
      approved: true,
      nested: { ignored: true },
      longValue: 'x'.repeat(257),
      'invalid key': 'ignored'
    }
  })

  const sessionSpan = telemetry.spans.find((span) => span.name === 'harness.session.prompt')
  const workflowSpan = telemetry.spans.find((span) => span.name === 'harness.workflow.run')
  const agentSpan = telemetry.spans.find((span) => span.name === 'invoke_agent responder')

  for (const span of [sessionSpan, workflowSpan, agentSpan]) {
    expect(span?.attrs).toMatchObject({
      'harness.metadata.tenant': 'acme',
      'harness.metadata.runNumber': 7,
      'harness.metadata.approved': true
    })
    expect(span?.attrs['harness.metadata.nested']).toBeUndefined()
    expect(span?.attrs['harness.metadata.longValue']).toBeUndefined()
    expect(span?.attrs['harness.metadata.invalid key']).toBeUndefined()
  }
})

it('exposes scoped metrics helpers to workflow and tool handlers', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness()

  await session.workflows.wf.prompt('find the policy')

  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'histogram',
      name: 'app.workflow.duration',
      attrs: expect.objectContaining({
        'harness.workflow.id': 'wf',
        'harness.session.id': 'telemetry-session',
        'app.workflow.name': 'wf'
      })
    }),
    expect.objectContaining({
      kind: 'counter',
      name: 'app.policy_lookup.calls',
      value: 1,
      attrs: expect.objectContaining({
        'harness.tool.id': 'policy_lookup',
        'harness.agent.id': 'responder',
        'harness.session.id': 'telemetry-session'
      })
    })
  ]))
})

it('records GenAI token usage as histogram samples while keeping token counts on spans', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness()

  await session.workflows.wf.prompt('find the policy')

  const tokenMetrics = telemetry.metrics.filter((metric) => metric.name === 'gen_ai.client.token.usage')
  expect(tokenMetrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'histogram', value: 1, attrs: expect.objectContaining({ 'gen_ai.token.type': 'input' }) }),
    expect.objectContaining({ kind: 'histogram', value: 2, attrs: expect.objectContaining({ 'gen_ai.token.type': 'output' }) })
  ]))

  const finalModelSpan = telemetry.spans.filter((span) => span.name === 'chat fake').at(-1)
  expect(finalModelSpan?.attrs).toMatchObject({
    'gen_ai.usage.input_tokens': 1,
    'gen_ai.usage.output_tokens': 2,
    'gen_ai.usage.total_tokens': 3,
    'gen_ai.usage.cache_read.input_tokens': 1,
    'gen_ai.usage.reasoning.output_tokens': 1,
    'llm.token_count.prompt': 1,
    'llm.token_count.completion': 2,
    'llm.token_count.total': 3,
    'llm.token_count.prompt_details.cache_read': 1,
    'llm.token_count.completion_details.reasoning': 1
  })
})

it('emits privacy-safe memory spans and metrics from the core wrapper', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness()

  await session.workflows.wf.prompt('find the policy')

  const memorySpans = telemetry.spans.filter((span) => span.name.startsWith('harness.memory.'))
  expect(memorySpans.map((span) => span.name)).toEqual(expect.arrayContaining([
    'harness.memory.set',
    'harness.memory.set',
    'harness.memory.set'
  ]))
  for (const span of memorySpans) {
    expect(span.attrs).toMatchObject({
      'harness.memory.provider': 'sandbox_memory',
      'harness.memory.content_captured': false,
      'harness.session.id': 'telemetry-session'
    })
    expect(span.attrs['harness.memory.key']).toBeUndefined()
    expect(span.attrs['harness.memory.value']).toBeUndefined()
  }

  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'counter',
      name: 'harness.memory.operations',
      attrs: expect.objectContaining({ 'harness.memory.operation': 'set' })
    }),
    expect.objectContaining({
      kind: 'histogram',
      name: 'harness.memory.operation.duration',
      attrs: expect.objectContaining({ 'harness.memory.provider': 'sandbox_memory' })
    })
  ]))
})
