import { Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { JsonLogger } from '../logger/index.js'
import { BaseModelProvider } from '../ports/base-model-provider.js'
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  RerankRequest,
  RerankResponse,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  TokenUsage
} from '../ports/model-provider.js'
import type { JsonValue } from '../models/json.js'
import type { RunEvent } from '../harness/defineHarness.js'

import { FakeLogger } from './fakeLogger.js'
import { FakeSandbox } from './fakeSandbox.js'
import { FakeStateStore } from './fakeStateStore.js'
import { loggerContract } from './loggerContract.js'
import { modelProviderContract } from './modelProviderContract.js'
import { recordEvents } from './recordEvents.js'
import { sandboxContract } from './sandboxContract.js'
import { stateStoreContract } from './stateStoreContract.js'

function usage(): TokenUsage {
  return { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
}

/** Minimal provider over `BaseModelProvider` used to validate the provider contract suite. */
class ContractProvider extends BaseModelProvider {
  public constructor() {
    super({ id: 'contract', genAiSystem: 'contract' })
  }

  protected override async doText(req: TextRequest): Promise<TextResponse> {
    req.signal.throwIfAborted()
    return { content: 'ok', usage: usage(), finishReason: 'stop', outcome: { finishReason: 'stop', providerFinishReason: 'stop' } }
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    req.signal.throwIfAborted()
    yield { kind: 'delta', text: 'ok' }
    yield { kind: 'finish', usage: usage(), finishReason: 'stop', outcome: { finishReason: 'stop' } }
  }

  protected override async doObject<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    req.signal.throwIfAborted()
    return { object: { ok: true } as T, usage: usage(), finishReason: 'stop', outcome: { finishReason: 'stop' } }
  }

  protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    req.signal.throwIfAborted()
    yield { kind: 'partial', partial: {} }
    yield { kind: 'finish', object: { ok: true } as T, usage: usage(), finishReason: 'stop', outcome: { finishReason: 'stop' } }
  }

  protected override async doEmbed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    req.signal.throwIfAborted()
    const count = Array.isArray(req.input) ? req.input.length : 1
    return { embeddings: Array.from({ length: count }, (_, index) => ({ index, vector: [0.5] })), usage: usage() }
  }

  protected override async doRerank(req: RerankRequest): Promise<RerankResponse> {
    req.signal.throwIfAborted()
    return { results: req.documents.map((document, index) => ({ id: document.id, index, score: req.documents.length - index })) }
  }
}

stateStoreContract(() => new FakeStateStore())

sandboxContract(() => new FakeSandbox({ executor: 'unavailable' }), { executor: 'unavailable' })

loggerContract(() => new FakeLogger())
loggerContract(() => new JsonLogger({ out: new Writable({ write(_chunk, _encoding, callback) { callback() } }) }))

modelProviderContract(() => new ContractProvider(), {
  capabilities: ['text', 'text_stream', 'object', 'object_stream', 'embeddings', 'rerank']
})

describe('FakeStateStore inspection helpers', () => {
  it('records invoked operations in order', async () => {
    const store = new FakeStateStore()
    await store.upsertSession({ id: 's1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', runCount: 0 })
    await store.getSession('s1')
    expect(store.ops).toEqual(['upsertSession', 'getSession'])
    expect(store.opCount('getSession')).toBe(1)
    store.resetOps()
    expect(store.ops).toEqual([])
  })
})

describe('FakeSandbox executor', () => {
  it('advertises capabilities matching the executor flag', () => {
    expect(new FakeSandbox().capabilities).toEqual(['sandbox.fs', 'sandbox.exec'])
    expect(new FakeSandbox({ executor: 'unavailable' }).capabilities).toEqual(['sandbox.fs'])
  })

  it('default exec echoes deterministically and fails unknown commands', async () => {
    const session = await new FakeSandbox().open({ sessionId: 's1', runId: 'r1' })
    expect(await session.exec('echo hi')).toMatchObject({ stdout: 'hi\n', exitCode: 0 })
    expect(await session.exec('curl example.com')).toMatchObject({ exitCode: 127 })
  })

  it('supports scripted exec handlers and pre-aborted signals', async () => {
    const sandbox = new FakeSandbox({ exec: () => ({ stdout: 'scripted', stderr: '', exitCode: 0, durationSeconds: 0 }) })
    const session = await sandbox.open({ sessionId: 's1', runId: 'r1' })
    expect(await session.exec('anything')).toMatchObject({ stdout: 'scripted' })

    const controller = new AbortController()
    controller.abort()
    await expect(session.exec('echo hi', { signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
  })
})

describe('recordEvents', () => {
  it('collects every event from an async iterable', async () => {
    async function* events(): AsyncIterable<RunEvent> {
      yield { type: 'run.started', runId: 'r1' } as unknown as RunEvent
      yield { type: 'run.finished', runId: 'r1' } as unknown as RunEvent
    }
    const collected = await recordEvents(events())
    expect(collected).toHaveLength(2)
  })
})
