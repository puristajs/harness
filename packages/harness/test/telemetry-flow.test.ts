import { SpanStatusCode } from '@opentelemetry/api'
import { expect, it } from 'vitest'

import { runTelemetryFlowHarness } from './telemetryFlowHarness.js'

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
    'gen_ai.tool.name': 'policy_lookup'
  })
  expect(modelSpans.at(0)?.attrs).toMatchObject({
    'harness.model.alias': 'fast',
    'gen_ai.system': 'fake',
    'gen_ai.request.model': 'fake'
  })
  expect(modelSpans.at(1)?.attrs['gen_ai.usage.total_tokens']).toBe(3)
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
    'llm.token_count.prompt': 1,
    'llm.token_count.completion': 2,
    'llm.token_count.total': 3
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
