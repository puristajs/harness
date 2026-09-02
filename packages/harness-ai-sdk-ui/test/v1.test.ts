import type { ExecutionEvent, JsonValue, ToolApprovalInterrupt } from '@purista/harness'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import {
  createHarnessUIMessageStream,
  createHarnessUIMessageStreamResponse,
  createHarnessUIMessageSseEvents,
  AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS,
  HARNESS_UI_APPROVAL_PROTOCOL,
  parseHarnessToolApprovalResume,
  type HarnessUIApprovalDescriptor,
} from '../src/index.js'

describe('AI SDK UI Message Stream v1', () => {
  it('maps text, structured output, tools, status, and the standard SSE response', async () => {
    const events: ExecutionEvent[] = [
      { type: 'run.started', runId: 'run-1', at: '2026-09-02T10:00:00.000Z' },
      { type: 'output.text.delta', runId: 'run-1', id: 'answer', delta: 'Hello' },
      { type: 'output.object.snapshot', runId: 'run-1', id: 'result', value: { category: 'safe' } },
      {
        type: 'output.progress',
        runId: 'run-1',
        id: 'video:video',
        operation: 'video',
        state: 'running',
        progress: 50,
      },
      {
        type: 'output.file',
        runId: 'run-1',
        id: 'artifact-1',
        artifact: { id: 'artifact-1', url: '/artifacts/artifact-1', mediaType: 'video/mp4' },
      },
      {
        type: 'tool.input.available',
        runId: 'run-1',
        agentId: 'support',
        toolId: 'lookupTransaction',
        callId: 'call-1',
        input: { transactionId: 'tx-1' },
      },
      {
        type: 'tool.started',
        runId: 'run-1',
        agentId: 'support',
        toolId: 'lookupTransaction',
        callId: 'call-1',
        input: { transactionId: 'tx-1' },
      },
      {
        type: 'tool.finished',
        runId: 'run-1',
        agentId: 'support',
        toolId: 'lookupTransaction',
        callId: 'call-1',
        output: { amount: 42 },
      },
      {
        type: 'run.finished',
        runId: 'run-1',
        at: '2026-09-02T10:00:01.000Z',
        outcome: { status: 'completed', runId: 'run-1', output: 'Hello' },
      },
    ]

    const chunks = await collect(createHarnessUIMessageStream(iterate(events)))
    expect(chunks).toContainEqual({ type: 'start', messageId: 'run-1' })
    expect(chunks).toContainEqual({ type: 'text-start', id: 'answer' })
    expect(chunks).toContainEqual({ type: 'text-delta', id: 'answer', delta: 'Hello' })
    expect(chunks).toContainEqual({ type: 'text-end', id: 'answer' })
    expect(chunks).toContainEqual({ type: 'file', url: '/artifacts/artifact-1', mediaType: 'video/mp4' })
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'data-status',
      data: expect.objectContaining({ phase: 'media-progress', operation: 'video', progress: 50 }),
    }))
    expect(chunks).toContainEqual({
      type: 'tool-input-available',
      toolCallId: 'call-1',
      toolName: 'lookupTransaction',
      input: { transactionId: 'tx-1' },
      dynamic: true,
    })
    expect(chunks).toContainEqual({
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: { amount: 42 },
      dynamic: true,
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' })

    const response = createHarnessUIMessageStreamResponse(iterate(events))
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('"type":"text-delta"')
    expect(body).toContain('data: [DONE]')
    expect(AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS).toEqual({ 'x-vercel-ai-ui-message-stream': 'v1' })
  })

  it('projects data-only SSE events for framework-owned HTTP streams', async () => {
    const events: ExecutionEvent[] = [
      { type: 'run.started', runId: 'run-1', at: '2026-09-02T10:00:00.000Z' },
      { type: 'output.text.delta', runId: 'run-1', id: 'answer', delta: 'Hello' },
      {
        type: 'run.finished',
        runId: 'run-1',
        at: '2026-09-02T10:00:01.000Z',
        outcome: { status: 'completed', runId: 'run-1', output: 'Hello' },
      },
    ]
    const sseEvents = []
    for await (const event of createHarnessUIMessageSseEvents(iterate(events))) sseEvents.push(event)

    expect(sseEvents.every(event => event.event === 'data')).toBe(true)
    expect(sseEvents).toContainEqual({ event: 'data', data: { type: 'text-delta', id: 'answer', delta: 'Hello' } })
    expect(sseEvents.at(-1)).toEqual({ event: 'data', data: '[DONE]' })
  })

  it('emits a standard approval request and reconstructs a deterministic resume', async () => {
    const interrupt = approvalInterrupt()
    const events: ExecutionEvent[] = [
      { type: 'run.started', runId: 'run-approval', at: '2026-09-02T10:00:00.000Z' },
      {
        type: 'tool.input.available',
        runId: 'run-approval',
        agentId: 'support',
        toolId: 'refundTransaction',
        callId: 'call-refund',
        input: { transactionId: 'tx-1' },
      },
      {
        type: 'approval.requested',
        runId: 'run-approval',
        agentId: 'support',
        toolId: 'refundTransaction',
        callId: 'call-refund',
        approvalId: 'approval-1',
      },
      {
        type: 'run.finished',
        runId: 'run-approval',
        at: '2026-09-02T10:00:01.000Z',
        outcome: { status: 'interrupted', runId: 'run-approval', interrupt },
      },
    ]

    const chunks = await collect(createHarnessUIMessageStream(iterate(events), { messageId: 'assistant-1' }))
    expect(chunks[0]).toEqual({ type: 'start', messageId: 'assistant-1' })
    const request = chunks.find(chunk => chunk.type === 'tool-approval-request')
    expect(request).toMatchObject({
      type: 'tool-approval-request',
      approvalId: 'approval-1',
      toolCallId: 'call-refund',
      approvalDescriptor: {
        protocol: HARNESS_UI_APPROVAL_PROTOCOL,
        version: 1,
        runId: 'run-approval',
        interruptId: 'interrupt-1',
        revision: 'revision-1',
        approvalIds: ['approval-1'],
      },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'tool-calls' })

    const descriptor = (request as Extract<UIMessageChunk, { type: 'tool-approval-request' }>).approvalDescriptor
    const messages = [approvedMessage(descriptor as HarnessUIApprovalDescriptor)]
    const first = parseHarnessToolApprovalResume(messages)
    const retry = parseHarnessToolApprovalResume(messages)
    expect(first).toEqual(retry)
    expect(first).toMatchObject({
      type: 'tool-approval',
      runId: 'run-approval',
      interruptId: 'interrupt-1',
      revision: 'revision-1',
      decisions: [{ approvalId: 'approval-1', approved: true, reason: 'Reviewed by an operator.' }],
    })
    expect(first?.eventId).toMatch(/^ui_approval_[0-9a-f]{64}$/)
  })

  it('waits for the complete approval batch and rejects conflicting descriptors', () => {
    const descriptor: HarnessUIApprovalDescriptor = {
      protocol: HARNESS_UI_APPROVAL_PROTOCOL,
      version: 1,
      runId: 'run-approval',
      interruptId: 'interrupt-1',
      revision: 'revision-1',
      approvalIds: ['approval-1', 'approval-2'],
    }
    expect(parseHarnessToolApprovalResume([approvedMessage(descriptor)])).toBeUndefined()

    const conflicting = { ...descriptor, revision: 'revision-2' }
    const message = approvedMessage(descriptor)
    message.parts.push(approvalPart('approval-2', 'call-2', conflicting))
    expect(() => parseHarnessToolApprovalResume([message])).toThrow(/conflicting Harness approval descriptors/)

    const completed: UIMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'refundTransaction',
          toolCallId: 'call-refund',
          state: 'output-available',
          input: { transactionId: 'tx-1' },
          output: { refunded: true },
          preliminary: false,
          approval: {
            id: 'approval-1',
            approved: true,
            descriptor: { ...descriptor, approvalIds: ['approval-1'] },
          },
        },
      ],
    }
    expect(parseHarnessToolApprovalResume([completed])).toBeUndefined()
  })

  it('cancels the underlying Harness iterator when the browser disconnects', async () => {
    const cancel = vi.fn(async () => ({ done: true as const, value: undefined }))
    const events: AsyncIterable<ExecutionEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => new Promise<IteratorResult<ExecutionEvent>>(() => {}),
          return: cancel,
        }
      },
    }
    const reader = createHarnessUIMessageStream(events).getReader()
    await reader.cancel('browser disconnected')
    expect(cancel).toHaveBeenCalledWith('browser disconnected')
  })

  it('produces UI messages consumable by the AI SDK parser', async () => {
    const events: ExecutionEvent[] = [
      { type: 'run.started', runId: 'run-1', at: '2026-09-02T10:00:00.000Z' },
      { type: 'output.text.delta', runId: 'run-1', id: 'answer', delta: 'Hello' },
      {
        type: 'run.finished',
        runId: 'run-1',
        at: '2026-09-02T10:00:01.000Z',
        outcome: { status: 'completed', runId: 'run-1', output: 'Hello' },
      },
    ]
    const messages = readUIMessageStream({ stream: createHarnessUIMessageStream(iterate(events)) })
    let last: UIMessage | undefined
    for await (const message of messages) last = message
    expect(last?.id).toBe('run-1')
    expect(last?.role).toBe('assistant')
    const text = last?.parts.find(part => part.type === 'text')
    expect(text).toMatchObject({ type: 'text', text: 'Hello', state: 'done' })
  })
})

async function* iterate<T extends JsonValue>(events: readonly ExecutionEvent<T>[]): AsyncIterable<ExecutionEvent<T>> {
  yield* events
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader()
  const chunks: UIMessageChunk[] = []
  while (true) {
    const next = await reader.read()
    if (next.done) return chunks
    chunks.push(next.value)
  }
}

function approvalInterrupt(): ToolApprovalInterrupt {
  return {
    type: 'tool-approval',
    id: 'interrupt-1',
    revision: 'revision-1',
    requests: [
      {
        approvalId: 'approval-1',
        runId: 'run-approval',
        agentId: 'support',
        invocationId: 'invocation-1',
        step: 1,
        toolId: 'refundTransaction',
        callId: 'call-refund',
        input: { transactionId: 'tx-1' },
        demands: [
          {
            decisionId: `decision_${'a'.repeat(64)}`,
            source: { kind: 'policy', id: 'refund-approval' },
            phase: 'approval',
            reasonCode: 'human_review_required',
          },
        ],
      },
    ],
  }
}

function approvedMessage(descriptor: HarnessUIApprovalDescriptor): UIMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    parts: [approvalPart('approval-1', 'call-refund', descriptor)],
  }
}

function approvalPart(approvalId: string, toolCallId: string, descriptor: HarnessUIApprovalDescriptor) {
  return {
    type: 'dynamic-tool' as const,
    toolName: 'refundTransaction',
    toolCallId,
    state: 'approval-responded' as const,
    input: { transactionId: 'tx-1' },
    approval: {
      id: approvalId,
      approved: true,
      descriptor,
      reason: 'Reviewed by an operator.',
    },
  }
}
