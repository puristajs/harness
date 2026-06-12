import { describe, expect, it } from 'vitest'

import { OperationCancelledError } from '../errors/index.js'
import type {
  FinishReason,
  ModelCapability,
  ModelOutcome,
  ModelProvider,
  ObjectStreamChunk,
  TextStreamChunk,
  TokenUsage
} from '../ports/model-provider.js'

const FINISH_REASONS: readonly FinishReason[] = [
  'stop',
  'length',
  'context_limit',
  'tool_calls',
  'content_filter',
  'refusal',
  'pause',
  'malformed',
  'cancelled',
  'error'
]

const METHOD_BY_CAPABILITY = {
  text: 'text',
  text_stream: 'textStream',
  object: 'object',
  object_stream: 'objectStream',
  embeddings: 'embed',
  rerank: 'rerank'
} as const

type OperationCapability = keyof typeof METHOD_BY_CAPABILITY

const CONTRACT_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean' } }
} as const

function signal(): AbortSignal {
  return new AbortController().signal
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

/**
 * Pre-aborted signals must reject. `BaseModelProvider` currently rethrows the
 * raw abort reason at the entry point (before error normalization), so both
 * the normalized `OperationCancelledError` and a raw `AbortError` satisfy the
 * contract; mid-flight aborts always normalize to `OperationCancelledError`.
 */
function expectAbortRejection(error: unknown): boolean {
  return error instanceof OperationCancelledError || (error instanceof Error && error.name === 'AbortError')
}

function expectUsage(usage: TokenUsage): void {
  expect(usage.inputTokens).toBeGreaterThanOrEqual(0)
  expect(usage.outputTokens).toBeGreaterThanOrEqual(0)
  expect(usage.totalTokens).toBeGreaterThanOrEqual(0)
}

function expectOutcome(outcome: ModelOutcome | undefined, finishReason: FinishReason): void {
  if (!outcome) return
  expect(outcome.finishReason).toBe(finishReason)
  if (outcome.providerFinishReason !== undefined) {
    expect(typeof outcome.providerFinishReason).toBe('string')
  }
  if (outcome.retryKind !== undefined) {
    expect(['none', 'active', 'deferred']).toContain(outcome.retryKind)
  }
}

/**
 * Shared provider contract for `ModelProvider` implementations.
 *
 * `make()` must return a provider wired to an offline (fake/mock) client whose
 * scripted responses satisfy the requested capabilities: text content for
 * `text`/`text_stream` and a JSON object matching `{ ok: boolean }` for
 * `object`/`object_stream`.
 */
export function modelProviderContract(make: () => ModelProvider, opts: { capabilities: ModelCapability[] }): void {
  const operations = opts.capabilities.filter((capability): capability is OperationCapability => capability in METHOD_BY_CAPABILITY)
  const has = (capability: OperationCapability): boolean => operations.includes(capability)

  describe('modelProviderContract', () => {
    it('reports stable provider identifiers', () => {
      const provider = make()
      expect(typeof provider.id).toBe('string')
      expect(provider.id.length).toBeGreaterThan(0)
      expect(typeof provider.genAiSystem).toBe('string')
      expect(provider.genAiSystem.length).toBeGreaterThan(0)
    })

    it('implements a method for each claimed operation capability', () => {
      const provider = make()
      for (const capability of operations) {
        expect(typeof provider[METHOD_BY_CAPABILITY[capability]]).toBe('function')
      }
    })

    if (has('text')) {
      it('text returns normalized content, usage, finish reason, and outcome shape', async () => {
        const provider = make()
        const response = await provider.text!({
          model: 'contract-model',
          messages: [{ role: 'user', content: 'contract' }],
          signal: signal()
        })

        expect(typeof response.content).toBe('string')
        expectUsage(response.usage)
        expect(FINISH_REASONS).toContain(response.finishReason)
        expectOutcome(response.outcome, response.finishReason)
      })

      it('text rejects an already-aborted signal with a cancellation error', async () => {
        const provider = make()
        await expect(
          provider.text!({
            model: 'contract-model',
            messages: [{ role: 'user', content: 'contract' }],
            signal: abortedSignal()
          })
        ).rejects.toSatisfy(expectAbortRejection)
      })
    }

    if (has('text_stream')) {
      it('textStream yields valid chunk kinds and exactly one trailing finish', async () => {
        const provider = make()
        const chunks: TextStreamChunk[] = []
        for await (const chunk of provider.textStream!({
          model: 'contract-model',
          messages: [{ role: 'user', content: 'contract' }],
          signal: signal()
        })) {
          chunks.push(chunk)
        }

        expect(chunks.length).toBeGreaterThan(0)
        for (const chunk of chunks) {
          expect(['delta', 'tool_call', 'finish']).toContain(chunk.kind)
        }
        const finishes = chunks.filter((chunk) => chunk.kind === 'finish')
        expect(finishes).toHaveLength(1)
        const finish = chunks.at(-1)
        expect(finish?.kind).toBe('finish')
        if (finish?.kind === 'finish') {
          expectUsage(finish.usage)
          expect(FINISH_REASONS).toContain(finish.finishReason)
          expectOutcome(finish.outcome, finish.finishReason)
        }
      })
    }

    if (has('object')) {
      it('object returns the structured object with normalized usage and outcome shape', async () => {
        const provider = make()
        const response = await provider.object!({
          model: 'contract-model',
          messages: [{ role: 'user', content: 'contract' }],
          schema: CONTRACT_SCHEMA as never,
          signal: signal()
        })

        expect(response.object).not.toBeUndefined()
        expectUsage(response.usage)
        expect(FINISH_REASONS).toContain(response.finishReason)
        expectOutcome(response.outcome, response.finishReason)
      })

      it('object rejects an already-aborted signal with a cancellation error', async () => {
        const provider = make()
        await expect(
          provider.object!({
            model: 'contract-model',
            messages: [{ role: 'user', content: 'contract' }],
            schema: CONTRACT_SCHEMA as never,
            signal: abortedSignal()
          })
        ).rejects.toSatisfy(expectAbortRejection)
      })
    }

    if (has('object_stream')) {
      it('objectStream yields valid chunk kinds and a final object', async () => {
        const provider = make()
        const chunks: ObjectStreamChunk[] = []
        for await (const chunk of provider.objectStream!({
          model: 'contract-model',
          messages: [{ role: 'user', content: 'contract' }],
          schema: CONTRACT_SCHEMA as never,
          signal: signal()
        })) {
          chunks.push(chunk)
        }

        expect(chunks.length).toBeGreaterThan(0)
        for (const chunk of chunks) {
          expect(['partial', 'delta', 'tool_call', 'finish']).toContain(chunk.kind)
        }
        const finish = chunks.at(-1)
        expect(finish?.kind).toBe('finish')
        if (finish?.kind === 'finish') {
          expect(finish.object).not.toBeUndefined()
          expectUsage(finish.usage)
          expect(FINISH_REASONS).toContain(finish.finishReason)
          expectOutcome(finish.outcome, finish.finishReason)
        }
      })
    }

    if (has('embeddings')) {
      it('embed returns one embedding per input', async () => {
        const provider = make()
        const response = await provider.embed!({
          model: 'contract-model',
          input: ['alpha', 'beta'],
          signal: signal()
        })

        expect(response.embeddings).toHaveLength(2)
        for (const [index, embedding] of response.embeddings.entries()) {
          expect(embedding.index).toBe(index)
          expect(embedding.vector.length).toBeGreaterThan(0)
        }
        expectUsage(response.usage)
      })
    }

    if (has('rerank')) {
      it('rerank returns scores referencing submitted documents, sorted descending', async () => {
        const provider = make()
        const documents = [
          { id: 'doc-1', text: 'alpha' },
          { id: 'doc-2', text: 'beta' }
        ]
        const response = await provider.rerank!({
          model: 'contract-model',
          query: 'contract',
          documents,
          signal: signal()
        })

        const ids = documents.map((document) => document.id)
        for (const result of response.results) {
          expect(ids).toContain(result.id)
        }
        const scores = response.results.map((result) => result.score)
        expect([...scores].sort((a, b) => b - a)).toEqual(scores)
      })
    }
  })
}
