import { describe, expect, it } from 'vitest'

import { HarnessConfigError } from '../errors/index.js'
import {
  freezeAcceptedModelTurnCursor,
  freezePreparedToolCheckpointEntry,
  freezeSuspendedAgentTurnState
} from './prepared-tool-checkpoint.js'
import { ToolApprovalPendingError } from './index.js'

const call = { id: 'call', name: 'lookup', arguments: { query: 'value' } } as const

function acceptedCursor() {
  return {
    schemaVersion: 1 as const,
    kind: 'accepted_model_turn' as const,
    phase: 'after_model' as const,
    rootRunId: 'root', agentRunId: 'agent-run', sessionId: 'session', agentId: 'agent', invocationId: 'invoke', step: 1, modelAlias: 'primary', input: { question: 'hello' },
    mode: 'run' as const,
    operation: 'text' as const,
    request: {
      messages: [
        { role: 'system' as const, content: 'system' },
        { role: 'user' as const, content: [{ kind: 'text' as const, text: 'question' }] },
        { role: 'assistant' as const, content: 'answer', toolCalls: [call] },
        { role: 'tool' as const, toolCallId: 'call', content: 'result' }
      ],
      tools: [{ name: 'lookup', description: 'Find a value', parameters: { type: 'object' } }],
      call: { temperature: 0, maxTokens: 10, topP: 1, stopSequences: ['END'], parallelToolCalls: true, retry: { maxAttempts: 2, maxActiveElapsedMs: 1, maxActiveDelayMs: 1, maxDeferredDelayMs: 1, respectRetryAfter: true, minDelayMs: 1, maxDelayMs: 2, retryOn: { network: true, timeout: true, rateLimit: true, serverError: true }, longRetry: 'error' as const }, providerOptions: { region: 'test' } }
    },
    response: { content: 'answer', toolCalls: [call], usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' as const },
    agentStarted: true as const
  }
}

describe('prepared tool checkpoint persistence', () => {
  it('creates a stable approval receipt and retains only explicitly attached continuation state', () => {
    const request = { approvalId: 'approval', runId: 'run', agentRunId: 'agent-run', agentId: 'agent', invocationId: 'invoke', step: 1, toolId: 'lookup', callId: 'call', input: { query: 'value' }, demands: [{ decisionId: 'decision', source: { id: 'policy', kind: 'governance' }, phase: 'tool' }] } as never
    const first = new ToolApprovalPendingError([request], [call])
    const second = new ToolApprovalPendingError([request], [call])
    expect(first.interrupt).toEqual(second.interrupt)
    expect(Object.isFrozen(first.attachState({ input: {}, step: 1, modelAlias: 'primary', modelMessages: [], emitted: [], toolCalls: [] }).state)).toBe(true)
    expect(first.attachPreparedState({ rootRunId: 'root', agentRunId: 'agent-run', sessionId: 'session', agentId: 'agent', invocationId: 'invoke', step: 1, modelAlias: 'primary', input: {}, messages: [], entries: [], agentStarted: true }).preparedState).toMatchObject({ agentId: 'agent' })
    expect(() => new ToolApprovalPendingError([], [])).toThrow(TypeError)
  })

  it('accepts and deeply freezes valid suspended and accepted model turn state', () => {
    const entry = freezePreparedToolCheckpointEntry({ state: 'ready', call, input: { query: 'value' }, bindingId: 'binding', bindingContractDigest: 'digest', approvalId: 'approval' })
    const suspended = freezeSuspendedAgentTurnState({ rootRunId: 'root', agentRunId: 'agent-run', sessionId: 'session', agentId: 'agent', invocationId: 'invoke', step: 1, modelAlias: 'primary', input: { question: 'hello' }, messages: [{ role: 'assistant', content: 'answer', toolCalls: [call] }], entries: [entry], agentStarted: true })
    const accepted = freezeAcceptedModelTurnCursor(acceptedCursor())

    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(suspended.entries)).toBe(true)
    expect(Object.isFrozen(accepted.request.messages)).toBe(true)
    expect(accepted.response).toMatchObject({ content: 'answer', finishReason: 'stop' })
  })

  it('rejects continuation leakage and incoherent streaming state', () => {
    expect(() => freezePreparedToolCheckpointEntry({ state: 'ready', call: { ...call, providerContinuation: {} } as never, input: {}, bindingId: 'binding', bindingContractDigest: 'digest' })).toThrow(HarnessConfigError)
    expect(() => freezeSuspendedAgentTurnState({ rootRunId: 'root', agentRunId: 'agent-run', sessionId: 'session', agentId: 'agent', invocationId: 'invoke', step: 1, modelAlias: 'primary', input: {}, messages: [], entries: [], providerContinuation: { providerId: 'fake' } as never, agentStarted: true })).toThrow(HarnessConfigError)
    expect(() => freezeAcceptedModelTurnCursor({ ...acceptedCursor(), operation: 'textStream', mode: 'run' } as never)).toThrow(HarnessConfigError)
  })

  it('persists object and streaming turns with their compatible request and response shapes', () => {
    const object = acceptedCursor()
    object.operation = 'object' as never
    object.request = { ...object.request, schema: { type: 'object' } }
    object.response = {
      object: { answer: 'value' }, toolCalls: [call], usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cachedInputTokens: 1, cacheCreationInputTokens: 1, reasoningTokens: 1 }, finishReason: 'stop',
      outcome: { finishReason: 'stop', providerFinishReason: 'stop', providerStatus: '200', retryable: false, retryKind: 'none', retryAfterMs: 0, rateLimit: { scope: 'requests', limit: 10, remaining: 9, resetAt: 'later' }, details: { source: 'test' } }
    } as never
    expect(freezeAcceptedModelTurnCursor(object as never).response).toMatchObject({ object: { answer: 'value' } })

    const stream = acceptedCursor()
    stream.mode = 'stream' as never
    stream.operation = 'textStream' as never
    stream.streamId = 'stream' as never
    expect(freezeAcceptedModelTurnCursor(stream as never)).toMatchObject({ operation: 'textStream', mode: 'stream', streamId: 'stream' })
  })
})
