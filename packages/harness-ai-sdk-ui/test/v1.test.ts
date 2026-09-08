import type {
  ExecutionEvent,
  HarnessInterruptKind,
  HarnessOutputUpdateKind,
  HarnessTargetContract,
  HarnessTargetStream,
  ModelSchema,
  ToolApprovalInterrupt,
} from '@purista/harness'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import {
  AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS,
  createHarnessUIMessageSseEvents,
  createHarnessUIMessageStream,
  createHarnessUIMessageStreamResponse,
  HARNESS_UI_APPROVAL_PROTOCOL,
  parseHarnessToolApprovalResume,
  parseHarnessUIMessageRequest,
  type HarnessUIApprovalDescriptor,
  type HarnessUIStatus,
} from '../src/index.js'

const failure = { code: 'MODEL_FAILED', message: 'Safe failure.', category: 'model', retriable: false } as const
const agentCaller = Object.freeze({ kind: 'agent' as const, agentId: 'support' })
const workflowCaller = Object.freeze({ kind: 'workflow' as const, workflowId: 'reviewWorkflow' })

// @ts-expect-error The v4 UI adapter accepts an exact target contract, not an output-only generic.
type StaleOutputOnlyStream = HarnessTargetStream<string>
// @ts-expect-error Caller identity is one exact discriminated union, not independent optional fields.
const staleToolStatus: HarnessUIStatus = { phase: 'tool-running', runId: 'run', toolId: 'lookup', callId: 'call', agentId: 'support' }
const exactAgentToolStatus: HarnessUIStatus = { phase: 'tool-running', runId: 'run', toolId: 'lookup', callId: 'call', caller: agentCaller }
const exactWorkflowToolStatus: HarnessUIStatus = { phase: 'tool-running', runId: 'run', toolId: 'lookup', callId: 'call', caller: workflowCaller }
void [staleToolStatus, exactAgentToolStatus, exactWorkflowToolStatus]

describe('AI SDK UI Message Stream v1', () => {
  it('opens one step per provider turn and remains consumable by the official reader', async () => {
    const chunks = await collect(createHarnessUIMessageStream(stream([
      event({ type: 'run.started', runId: 'run-1', at: '2026-09-02T10:00:00.000Z' }),
      event({ type: 'output.text.delta', runId: 'run-1', caller: agentCaller, id: 'turn-1', delta: 'Checking' }),
      event({ type: 'model.completed', runId: 'run-1', caller: agentCaller, modelAlias: 'chat', streamId: 'turn-1', operation: 'textStream' }),
      event({ type: 'tool.input.available', runId: 'run-1', caller: agentCaller, toolId: 'lookup', callId: 'call-1', input: { id: 'tx-1' } }),
      event({ type: 'tool.started', runId: 'run-1', caller: workflowCaller, toolId: 'lookup', callId: 'call-1', input: { id: 'tx-1' } }),
      event({ type: 'tool.finished', runId: 'run-1', caller: agentCaller, toolId: 'lookup', callId: 'call-1', output: { amount: 42 } }),
      event({ type: 'output.text.delta', runId: 'run-1', caller: agentCaller, id: 'turn-2', delta: 'Done' }),
      event({ type: 'model.completed', runId: 'run-1', caller: agentCaller, modelAlias: 'chat', streamId: 'turn-2', operation: 'textStream' }),
      event({ type: 'output.text.delta', runId: 'run-1', caller: agentCaller, id: 'turn-2', delta: ' safely' }),
      event({ type: 'run.finished', runId: 'run-1', at: '2026-09-02T10:00:01.000Z', outcome: { status: 'completed', runId: 'run-1', output: 'Done safely' } }),
    ]), { sessionId: 'session-1' }))

    expect(chunks.filter(chunk => chunk.type === 'start-step')).toHaveLength(2)
    expect(chunks.filter(chunk => chunk.type === 'finish-step')).toHaveLength(2)
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'start', 'data-status', 'start-step', 'text-start', 'text-delta',
      'tool-input-available', 'data-status', 'tool-output-available',
      'text-end', 'finish-step', 'start-step', 'text-start', 'text-delta',
      'text-delta', 'text-end', 'data-status', 'finish-step', 'finish',
    ])
    let parsed: UIMessage | undefined
    for await (const message of readUIMessageStream({ stream: readable(chunks) })) parsed = message
    expect(parsed?.parts.filter(part => part.type === 'step-start')).toHaveLength(2)
    expect(parsed?.parts.filter(part => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'Checking', state: 'done' }),
      expect.objectContaining({ text: 'Done safely', state: 'done' }),
    ])
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'data-status', data: {
      phase: 'tool-running', runId: 'run-1', caller: workflowCaller, toolId: 'lookup', callId: 'call-1',
    } }))
  })

  it('maps output, tools, subagents, artifacts, ignored events, and correlation exactly', async () => {
    const ignored = vi.fn(() => { throw new Error('ignored callback failures are inert') })
    const chunks = await collect(createHarnessUIMessageStream(stream([
      event({ type: 'run.started', runId: 'run-1', at: '2026-09-02T10:00:00.000Z' }),
      event({ type: 'output.object.snapshot', runId: 'run-1', caller: agentCaller, id: 'turn-object', value: { category: 'safe' } }),
      event({ type: 'agent.started', runId: 'child-1', parentRunId: 'run-1', parentInvocationId: 'invoke-1', agentId: 'researcher', parentAgentId: 'support', delegationCallId: 'delegate-1', delegationDepth: 1, at: '2026-09-02T10:00:00.100Z' }),
      event({ type: 'agent.finished', runId: 'child-1', parentRunId: 'run-1', parentInvocationId: 'invoke-1', agentId: 'researcher', parentAgentId: 'support', delegationCallId: 'delegate-1', delegationDepth: 1, at: '2026-09-02T10:00:00.200Z', error: failure }),
      event({ type: 'tool.input.available', runId: 'run-1', caller: agentCaller, toolId: 'lookup', callId: 'call-1', input: {} }),
      event({ type: 'tool.finished', runId: 'run-1', caller: agentCaller, toolId: 'lookup', callId: 'call-1', error: failure }),
      event({ type: 'output.progress', runId: 'run-1', caller: workflowCaller, callId: 'video-call', id: 'video-1', modelAlias: 'video', operation: 'video', state: 'running', progress: 50 }),
      event({ type: 'output.file', runId: 'run-1', caller: workflowCaller, callId: 'video-call', id: 'artifact-1', modelAlias: 'video', operation: 'video', artifact: { id: 'artifact-1', url: '/artifacts/1', mediaType: 'video/mp4' } }),
      event({ type: 'stream.overflow', runId: 'run-1', at: '2026-09-02T10:00:00.300Z', dropped: 1 }),
      event({ type: 'run.finished', runId: 'run-1', at: '2026-09-02T10:00:01.000Z', outcome: { status: 'completed', runId: 'run-1', output: { category: 'safe' } } }),
    ]), { sessionId: 'session-1', onIgnoredEvent: ignored }))

    expect(chunks).toContainEqual({ type: 'data-output', id: 'harness-output:run-1:turn-object', data: { runId: 'run-1', value: { category: 'safe' } }, transient: true })
    expect(chunks).toContainEqual({ type: 'tool-output-error', toolCallId: 'call-1', errorText: 'Safe failure.', dynamic: true })
    expect(chunks).toContainEqual({ type: 'file', url: '/artifacts/1', mediaType: 'video/mp4' })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'data-status', data: expect.objectContaining({ phase: 'subagent-started', parentRunId: 'run-1', parentInvocationId: 'invoke-1' }) }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'data-status', data: expect.objectContaining({ phase: 'subagent-failed', error: failure }) }))
    expect(ignored).toHaveBeenCalledWith('stream.overflow')
  })

  it.each([['failed', 'error', 'error'], ['cancelled', 'abort', 'other']] as const)(
    'maps %s terminal outcomes using official chunks', async (status, terminalChunk, finishReason) => {
      const chunks = await collect(createHarnessUIMessageStream(stream([
        event({ type: 'run.started', runId: 'run-1', at: '2026-09-02T10:00:00.000Z' }),
        event({ type: 'model.completed', runId: 'run-1', caller: agentCaller, modelAlias: 'chat', operation: 'text', streamId: 'turn-1' }),
        event({ type: 'run.finished', runId: 'run-1', at: '2026-09-02T10:00:01.000Z', outcome: { status, runId: 'run-1', error: failure } }),
      ]), { sessionId: 'session-1' }))
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'data-status', data: { phase: status, runId: 'run-1', error: failure } }))
      expect(chunks).toContainEqual(expect.objectContaining({ type: terminalChunk }))
      expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason })
    },
  )

  it('emits approval correlation and parses approved and rejected continuations', async () => {
    const chunks = await collect(createHarnessUIMessageStream(stream(approvalEvents()), { sessionId: 'session-1', messageId: 'assistant-1' }))
    const request = chunks.find(chunk => chunk.type === 'tool-approval-request')
    expect(request).toMatchObject({ type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-refund', approvalDescriptor: approvalDescriptor() })
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'tool-calls' })
    expect(chunks.slice(-5).map(chunk => chunk.type)).toEqual(['tool-approval-request', 'tool-approval-request', 'data-status', 'finish-step', 'finish'])
    expect(chunks.filter(chunk => chunk.type === 'tool-input-available' && chunk.toolCallId === 'call-refund')).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.type === 'tool-input-available' && chunk.toolCallId === 'call-notify')).toHaveLength(1)
    let parsedApproval: UIMessage | undefined
    for await (const message of readUIMessageStream({ stream: readable(chunks) })) parsedApproval = message
    expect(parsedApproval?.parts).toContainEqual(expect.objectContaining({ type: 'dynamic-tool', state: 'approval-requested' }))

    const assistant = approvalMessage(approvalDescriptor(), [true, false])
    const parsed = parseHarnessToolApprovalResume([userMessage(), assistant])
    expect(parsed).toMatchObject({ type: 'tool-approval', runId: 'run-approval', interruptId: 'interrupt-1', revision: 'revision-1', decisions: [
      { approvalId: 'approval-1', approved: true, reason: 'Reviewed.' },
      { approvalId: 'approval-2', approved: false, reason: 'Reviewed.' },
    ] })
    expect(parsed?.eventId).toMatch(/^ui_approval_[0-9a-f]{64}$/)

    const response = createHarnessUIMessageStreamResponse(stream(approvalEvents()), { sessionId: 'session-1', messageId: 'assistant-1' })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"tool-approval-request"')
  })

  it('reconstructs tool inputs for terminal approval receipt replay for the strict official reader', async () => {
    const chunks = await collect(createHarnessUIMessageStream(stream(approvalReplayEvents()), {
      sessionId: 'session-1', messageId: 'assistant-1',
    }))
    expect(chunks.filter(chunk => chunk.type === 'tool-input-available')).toEqual([
      { type: 'tool-input-available', toolCallId: 'call-refund', toolName: 'refund', input: { id: 'tx-1' }, dynamic: true },
      { type: 'tool-input-available', toolCallId: 'call-notify', toolName: 'notify', input: { id: 'tx-1' }, dynamic: true },
    ])
    let parsed: UIMessage | undefined
    for await (const message of readUIMessageStream({
      stream: readable(chunks), terminateOnError: true, onError(error) { throw error },
    })) parsed = message
    expect(parsed?.parts.filter(part => part.type === 'dynamic-tool')).toEqual([
      expect.objectContaining({ toolName: 'refund', toolCallId: 'call-refund', state: 'approval-requested', input: { id: 'tx-1' } }),
      expect.objectContaining({ toolName: 'notify', toolCallId: 'call-notify', state: 'approval-requested', input: { id: 'tx-1' } }),
    ])
  })

  it('parses official transport bodies, approval continuations, and regeneration asynchronously', async () => {
    const assistant = approvalMessage(approvalDescriptor(), [true, false])
    const parsed = await parseHarnessUIMessageRequest({ id: 'session-1', trigger: 'submit-message', messageId: 'assistant-1', messages: [userMessage(), assistant], extra: true })
    expect(parsed).toMatchObject({ sessionId: 'session-1', lastUserMessage: userMessage(), assistantMessageId: 'assistant-1' })
    expect(parsed.resume).toEqual(parseHarnessToolApprovalResume([userMessage(), assistant]))

    const regenerated = await parseHarnessUIMessageRequest({ id: 'session-1', trigger: 'regenerate-message', messageId: 'assistant-old', messages: [userMessage()] })
    expect(regenerated.assistantMessageId).toBe('assistant-old')
    await expect(parseHarnessUIMessageRequest({ id: 'session-1', trigger: 'regenerate-message', messages: [userMessage()] })).rejects.toThrow(/messageId/i)
    await expect(parseHarnessUIMessageRequest({ id: 'session-other', trigger: 'submit-message', messageId: 'assistant-1', messages: [userMessage(), assistant] })).rejects.toThrow(/session/i)
    await expect(parseHarnessUIMessageRequest({ id: 'session-1', trigger: 'submit-message', messageId: 'wrong', messages: [userMessage(), assistant] })).rejects.toThrow(/assistant/i)
    await expect(parseHarnessUIMessageRequest({ id: 'session-1', trigger: 'submit-message', messageId: 'assistant-1', messages: [userMessage(), approvalMessage(approvalDescriptor(), [true])] })).rejects.toThrow(/incomplete/i)
  })

  it('rejects incomplete, duplicate, unknown, mixed, and replayed approvals', () => {
    const descriptor = approvalDescriptor()
    expect(parseHarnessToolApprovalResume([userMessage(), approvalMessage(descriptor, [true])])).toBeUndefined()
    const duplicate = approvalMessage(descriptor, [true, false]); duplicate.parts.push(approvalPart('approval-1', 'call-refund', descriptor, true))
    expect(() => parseHarnessToolApprovalResume([duplicate])).toThrow(/more than once/i)
    const unknown = approvalMessage(descriptor, [true, false]); unknown.parts.push(approvalPart('approval-unknown', 'call-other', descriptor, true))
    expect(() => parseHarnessToolApprovalResume([unknown])).toThrow(/not part/i)
    const mixed = approvalMessage(descriptor, [true, false])
    ;(mixed.parts[1] as { approval: { descriptor: HarnessUIApprovalDescriptor } }).approval.descriptor = { ...descriptor, revision: 'different' }
    expect(() => parseHarnessToolApprovalResume([mixed])).toThrow(/conflicting/i)
    const completed: UIMessage = { id: 'assistant-1', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'operation', toolCallId: 'call-refund', state: 'output-available', input: { id: 'tx-1' }, output: { ok: true }, approval: { id: 'approval-1', approved: true, descriptor, reason: 'Reviewed.' } }] }
    expect(parseHarnessToolApprovalResume([userMessage(), completed])).toBeUndefined()
  })

  it('replays approvals only from the final assistant message and its final step', () => {
    const descriptor = approvalDescriptor()
    const priorDescriptor = { ...descriptor, revision: 'prior-revision', eventId: 'prior-event', approvalIds: ['approval-old'] }
    const current = approvalMessage(descriptor, [true, false])
    const assistant: UIMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool', toolName: 'operation', toolCallId: 'call-old', state: 'output-available',
          input: { id: 'tx-old' }, output: { ok: true },
          approval: { id: 'approval-old', approved: true, descriptor: priorDescriptor },
        },
        { type: 'step-start' },
        ...current.parts,
      ],
    }

    expect(parseHarnessToolApprovalResume([userMessage(), assistant])).toMatchObject({
      revision: 'revision-1',
      decisions: [{ approvalId: 'approval-1' }, { approvalId: 'approval-2' }],
    })
    expect(parseHarnessToolApprovalResume([assistant, userMessage()])).toBeUndefined()
  })

  it('returns a fully framed Response and data-only records with one framing owner', async () => {
    const response = createHarnessUIMessageStreamResponse(stream(completedEvents()), {
      sessionId: 'session-1',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private',
        connection: 'close',
        'x-vercel-ai-ui-message-stream': 'v0',
        'x-accel-buffering': 'yes',
        'x-custom-header': 'preserved',
      },
    })
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('connection')).toBe('keep-alive')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(response.headers.get('x-custom-header')).toBe('preserved')
    const body = await response.text()
    expect(body).toContain('data: {"type":"text-delta"')
    expect(body).toContain('data: [DONE]')
    expect(AI_SDK_UI_MESSAGE_STREAM_V1_HEADERS).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-vercel-ai-ui-message-stream': 'v1',
      'x-accel-buffering': 'no',
    })
    const records = await collectAsync(createHarnessUIMessageSseEvents(stream(completedEvents()), { sessionId: 'session-1' }))
    expect(records.some(record => typeof record.data === 'string' && record.data.startsWith('data:'))).toBe(false)
    expect(records.at(-1)).toEqual({ event: 'data', data: '[DONE]' })
  })

  it('validates the direct root lifecycle while ignoring nested terminals', async () => {
    const ignored = vi.fn()
    const nested = event({ type: 'run.finished', runId: 'child-1', parentRunId: 'run-1', parentInvocationId: 'delegate-1', at: '2026-09-02T10:00:00.500Z', outcome: { status: 'completed', runId: 'child-1', output: 'child' } })
    const valid = [...completedEvents().slice(0, -1), nested, completedEvents().at(-1)!]
    await expect(collectAsync(createHarnessUIMessageSseEvents(stream(valid), { sessionId: 'session-1', onIgnoredEvent: ignored }))).resolves.toEqual(expect.arrayContaining([{ event: 'data', data: '[DONE]' }]))
    expect(ignored).toHaveBeenCalledWith('run.finished')
    await expect(collectAsync(createHarnessUIMessageSseEvents(stream(completedEvents().slice(0, -1)), { sessionId: 'session-1' }))).rejects.toThrow(/terminal/i)
    await expect(collectAsync(createHarnessUIMessageSseEvents(stream([...completedEvents(), completedEvents().at(-1)!]), { sessionId: 'session-1' }))).rejects.toThrow(/terminal/i)
    await expect(collectAsync(createHarnessUIMessageSseEvents(stream([...completedEvents(), event({ type: 'output.text.delta', runId: 'run-1', caller: agentCaller, id: 'turn-1', delta: 'late' })]), { sessionId: 'session-1' }))).rejects.toThrow(/after/i)
    const nestedStart = event({ type: 'run.started', runId: 'child-1', parentRunId: 'run-1', parentInvocationId: 'delegate-1', at: '2026-09-02T10:00:00.100Z' })
    await expect(collect(createHarnessUIMessageStream(stream([nestedStart]), { sessionId: 'session-1' }))).rejects.toThrow(/root/i)
    expect(() => createHarnessUIMessageStream(stream(completedEvents()), { sessionId: '' })).toThrow(/sessionId/i)
    expect(() => createHarnessUIMessageStream({ async *[Symbol.asyncIterator]() {} } as unknown as HarnessTargetStream<UITestTarget>, { sessionId: 'session-1' })).toThrow(/HarnessTargetStream/i)
  })

  it('rejects malformed terminal correlation and result mismatch before terminal chunks or DONE', async () => {
    const cases: HarnessTargetStream<UITestTarget>[] = []
    const mismatchRun = completedEvents()
    mismatchRun[mismatchRun.length - 1] = event({ type: 'run.finished', runId: 'run-1', at: '2026-09-02T10:00:01.000Z',
      outcome: { status: 'completed', runId: 'different-run', output: 'Hello' } })
    cases.push(stream(mismatchRun))
    const oneSided = completedEvents()
    oneSided[oneSided.length - 1] = event({ type: 'run.finished', runId: 'run-1', parentRunId: 'parent', at: '2026-09-02T10:00:01.000Z',
      outcome: { status: 'completed', runId: 'run-1', output: 'Hello' } })
    cases.push(stream(oneSided))
    const valid = completedEvents()
    cases.push({ ...stream(valid), result: Promise.resolve({ status: 'completed', runId: 'run-1', output: 'different' }) } as HarnessTargetStream<UITestTarget>)
    const duplicate = completedEvents()
    cases.push(stream([...duplicate, duplicate.at(-1)!]))
    cases.push(stream([...completedEvents(), event({ type: 'output.text.delta', runId: 'run-1', caller: agentCaller, id: 'late', delta: 'late' })]))

    for (const source of cases) {
      const { chunks, failure } = await readUntilFailure(createHarnessUIMessageStream(source, { sessionId: 'session-1' }))
      expect(failure).toBeInstanceOf(TypeError)
      expect(chunks).not.toContainEqual(expect.objectContaining({ type: 'finish' }))
    }
    for (const source of cases) {
      const records: unknown[] = []
      let failure: unknown
      try { for await (const record of createHarnessUIMessageSseEvents(source, { sessionId: 'session-1' })) records.push(record) }
      catch (error) { failure = error }
      expect(failure).toBeInstanceOf(TypeError)
      expect(records).not.toContainEqual({ event: 'data', data: '[DONE]' })
    }
  })

  it('compares terminal results by canonical JSON content rather than insertion order', async () => {
    const events = completedEvents()
    const equivalent = Object.freeze({ output: 'Hello', runId: 'run-1', status: 'completed' } as const)
    const source = { ...stream(events), result: Promise.resolve(equivalent) } as HarnessTargetStream<UITestTarget>

    await expect(collectAsync(createHarnessUIMessageSseEvents(source, { sessionId: 'session-1' })))
      .resolves.toContainEqual({ event: 'data', data: '[DONE]' })

    const different = Object.freeze({ output: 'Different', runId: 'run-1', status: 'completed' } as const)
    const mismatch = { ...stream(completedEvents()), result: Promise.resolve(different) } as HarnessTargetStream<UITestTarget>
    await expect(collectAsync(createHarnessUIMessageSseEvents(mismatch, { sessionId: 'session-1' })))
      .rejects.toThrow(/does not match/i)
  })

  it('cancels target execution and closes iterator observation on disconnect', async () => {
    const cancel = vi.fn(async (_reason?: string) => {})
    const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }))
    const result = new Promise<never>(() => {})
    const events = { result, cancel, [Symbol.asyncIterator]() { return { next: async () => new Promise<IteratorResult<ExecutionEvent>>(() => {}), return: iteratorReturn } } } as unknown as HarnessTargetStream<UITestTarget>
    const reader = createHarnessUIMessageStream(events, { sessionId: 'session-1' }).getReader()
    await reader.cancel('browser disconnected')
    expect(cancel).toHaveBeenCalledWith('browser disconnected')
    expect(iteratorReturn).toHaveBeenCalled()
  })

  it('surfaces producer rejection while the event iterator is still pending', async () => {
    const producerFailure = new TypeError('Harness producer rejected input.')
    const cancel = vi.fn(async () => {})
    const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }))
    const events = {
      result: Promise.reject(producerFailure),
      cancel,
      [Symbol.asyncIterator]() { return { next: async () => new Promise<IteratorResult<ExecutionEvent>>(() => {}), return: iteratorReturn } },
    } as unknown as HarnessTargetStream<UITestTarget>

    await expect(collect(createHarnessUIMessageStream(events, { sessionId: 'session-1' }))).rejects.toBe(producerFailure)
    expect(cancel).toHaveBeenCalledOnce()
    expect(iteratorReturn).toHaveBeenCalledOnce()
  })

  it('surfaces a terminal-boundary iterator rejection while the result is still pending', async () => {
    const iteratorFailure = new TypeError('Harness event iterator failed after its terminal event.')
    const cancel = vi.fn(async () => {})
    const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }))
    const values = completedEvents()
    let index = 0
    const events = {
      result: new Promise<never>(() => {}),
      cancel,
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (index < values.length) return { done: false as const, value: values[index++]! }
            throw iteratorFailure
          },
          return: iteratorReturn,
        }
      },
    } as unknown as HarnessTargetStream<UITestTarget>

    await expect(collect(createHarnessUIMessageStream(events, { sessionId: 'session-1' }))).rejects.toBe(iteratorFailure)
    expect(cancel).toHaveBeenCalledOnce()
    expect(iteratorReturn).toHaveBeenCalledOnce()
  })

  it('cleans up once after protocol errors and preserves the projection error', async () => {
    const cancel = vi.fn(async (_reason?: string) => { throw new Error('cancel cleanup failed') })
    const iteratorReturn = vi.fn(async () => { throw new Error('iterator cleanup failed') })
    const values = [
      event({ type: 'run.started', runId: 'run-1', at: '2026-09-02T10:00:00.000Z' }),
      event({ type: 'run.started', runId: 'run-2', at: '2026-09-02T10:00:00.100Z' }),
    ]
    let index = 0
    const result = new Promise<never>(() => {})
    const events = {
      result,
      cancel,
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false as const, value: values[index++]! }),
          return: iteratorReturn,
        }
      },
    } as unknown as HarnessTargetStream<UITestTarget>

    await expect(collect(createHarnessUIMessageStream(events, { sessionId: 'session-1' })))
      .rejects.toThrow('second root run.started')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('AI SDK UI stream projection failed')
    expect(iteratorReturn).toHaveBeenCalledTimes(1)
  })
})

function event<T extends Omit<ExecutionEvent, 'eventId' | 'sequence'>>(value: T): ExecutionEvent {
  event.sequence += 1
  return { ...value, eventId: `event-${event.sequence}`, sequence: event.sequence } as unknown as ExecutionEvent
}
event.sequence = 0

type UITestTarget = HarnessTargetContract<
  'agent' | 'workflow',
  string,
  ModelSchema,
  ModelSchema,
  HarnessOutputUpdateKind,
  readonly HarnessInterruptKind[]
>

function stream(events: readonly ExecutionEvent[], cancel = vi.fn(async (_reason?: string) => {})): HarnessTargetStream<UITestTarget> {
  const terminal = events.find((current): current is Extract<ExecutionEvent, { type: 'run.finished' }> =>
    current.type === 'run.finished' && current.parentRunId === undefined && current.parentInvocationId === undefined)
  const result = terminal === undefined ? new Promise<never>(() => {}) : Promise.resolve(terminal.outcome)
  return { result, cancel, async *[Symbol.asyncIterator]() { yield* events } } as unknown as HarnessTargetStream<UITestTarget>
}
function readable(chunks: readonly UIMessageChunk[]): ReadableStream<UIMessageChunk> { return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } }) }
async function collect(value: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> { const reader = value.getReader(); const result: UIMessageChunk[] = []; while (true) { const next = await reader.read(); if (next.done) return result; result.push(next.value) } }
async function collectAsync<T>(values: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const value of values) result.push(value); return result }
async function readUntilFailure(stream: ReadableStream<UIMessageChunk>): Promise<{ chunks: UIMessageChunk[]; failure: unknown }> {
  const reader = stream.getReader()
  const chunks: UIMessageChunk[] = []
  try {
    while (true) { const next = await reader.read(); if (next.done) return { chunks, failure: undefined }; chunks.push(next.value) }
  } catch (failure) { return { chunks, failure } }
}

function completedEvents(): ExecutionEvent[] { return [
  event({ type: 'run.started', runId: 'run-1', at: '2026-09-02T10:00:00.000Z' }),
  event({ type: 'output.text.delta', runId: 'run-1', caller: agentCaller, id: 'turn-1', delta: 'Hello' }),
  event({ type: 'model.completed', runId: 'run-1', caller: agentCaller, modelAlias: 'chat', streamId: 'turn-1', operation: 'textStream' }),
  event({ type: 'run.finished', runId: 'run-1', at: '2026-09-02T10:00:01.000Z', outcome: { status: 'completed', runId: 'run-1', output: 'Hello' } }),
] }

function approvalEvents(): ExecutionEvent[] { return [
  event({ type: 'run.started', runId: 'run-approval', at: '2026-09-02T10:00:00.000Z' }),
  event({ type: 'model.completed', runId: 'agent-run-1', parentRunId: 'run-approval', parentInvocationId: 'parent-1', caller: agentCaller, modelAlias: 'chat', streamId: 'approval-turn', operation: 'textStream' }),
  event({ type: 'tool.input.available', runId: 'agent-run-1', parentRunId: 'run-approval', parentInvocationId: 'parent-1', caller: agentCaller, toolId: 'refund', callId: 'call-refund', input: { id: 'tx-1' } }),
  event({ type: 'tool.input.available', runId: 'agent-run-1', parentRunId: 'run-approval', parentInvocationId: 'parent-1', caller: agentCaller, toolId: 'notify', callId: 'call-notify', input: { id: 'tx-1' } }),
  { ...event({ type: 'run.finished', runId: 'run-approval', at: '2026-09-02T10:00:01.000Z', outcome: { status: 'interrupted', runId: 'run-approval', interrupt: approvalInterrupt() } }), eventId: 'event-4' },
] }
function approvalReplayEvents(): ExecutionEvent[] { return [
  event({ type: 'run.started', runId: 'run-approval', at: '2026-09-02T10:00:00.000Z' }),
  { ...event({ type: 'run.finished', runId: 'run-approval', at: '2026-09-02T10:00:01.000Z', outcome: { status: 'interrupted', runId: 'run-approval', interrupt: approvalInterrupt() } }), eventId: 'event-4' },
] }

function approvalInterrupt(): ToolApprovalInterrupt {
  const request = (approvalId: string, toolId: string, callId: string) => ({ approvalId, runId: 'run-approval', agentRunId: 'agent-run-1', parentRunId: 'run-approval', parentInvocationId: 'parent-1', agentId: 'support', invocationId: 'agent-invocation-1', step: 1, toolId, callId, input: { id: 'tx-1' }, demands: [{ decisionId: `decision_${'a'.repeat(64)}`, source: { kind: 'policy' as const, id: 'approval-policy' }, phase: 'approval' as const, reasonCode: 'human_review_required' }] })
  return { type: 'tool-approval', id: 'interrupt-1', revision: 'revision-1', requests: [request('approval-1', 'refund', 'call-refund'), request('approval-2', 'notify', 'call-notify')] }
}
function approvalDescriptor(): HarnessUIApprovalDescriptor { return { protocol: HARNESS_UI_APPROVAL_PROTOCOL, version: 1, rootRunId: 'run-approval', agentRunId: 'agent-run-1', sessionId: 'session-1', interruptId: 'interrupt-1', revision: 'revision-1', eventId: 'event-4', approvalIds: ['approval-1', 'approval-2'] } }
function userMessage(): UIMessage { return { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Please continue.' }] } }
function approvalMessage(descriptor: HarnessUIApprovalDescriptor, decisions: readonly boolean[]): UIMessage { return { id: 'assistant-1', role: 'assistant', parts: decisions.map((approved, index) => approvalPart(`approval-${index + 1}`, index === 0 ? 'call-refund' : 'call-notify', descriptor, approved)) } }
function approvalPart(approvalId: string, toolCallId: string, descriptor: HarnessUIApprovalDescriptor, approved: boolean) { return { type: 'dynamic-tool' as const, toolName: 'operation', toolCallId, state: 'approval-responded' as const, input: { id: 'tx-1' }, approval: { id: approvalId, approved, descriptor, reason: 'Reviewed.' } } }
