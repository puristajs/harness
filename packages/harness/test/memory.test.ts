import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineHarness, inMemoryHarnessStorage, inMemoryMemoryEngine, inMemorySandbox } from '../src/index.js'

function harness() {
  return defineHarness()
    .storage(inMemoryHarnessStorage())
    .sandbox(inMemorySandbox(), { authorizeOwner: () => true })
    .memory(inMemoryMemoryEngine())
    .models({ noop: { provider: { id: 'noop', genAiSystem: 'test' }, model: 'noop', capabilities: [] } })
    .tools({})
    .skills({})
    .agents({})
    .workflows({})
    .build()
}

describe('core memory engine', () => {
  it('uses the dependency-free engine when configured and isolates session scopes', async () => {
    const value = harness()
    const one = await value.getSession('one')
    const two = await value.getSession('two')
    await one.memory.write('preference', { locale: 'de-DE' }, { ttlMs: 60_000 })
    await expect(one.memory.read('preference')).resolves.toEqual({ locale: 'de-DE' })
    await expect(two.memory.read('preference')).resolves.toBeUndefined()
  })

  it('does not allocate a sandbox until a session operation needs filesystem access', async () => {
    const sandbox = inMemorySandbox()
    const open = vi.spyOn(sandbox, 'open')
    const value = defineHarness()
      .storage(inMemoryHarnessStorage())
      .sandbox(sandbox)
      .memory(inMemoryMemoryEngine())
      .models({ noop: { provider: { id: 'noop', genAiSystem: 'test' }, model: 'noop', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({ echo: { model: 'noop', input: z.string(), output: z.string(), handler: async (ctx) => ctx.input } })
      .workflows({})
      .build()

    const session = await value.getSession('lazy')
    await session.history.list()
    expect(open).not.toHaveBeenCalled()

    await session.agents.echo.prompt('allocate')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('binds optional identity exactly before opening a session resource', async () => {
    const value = harness()
    await value.getSession('bound', { identity: { tenantId: 'acme', principalId: 'ada' } })
    await expect(value.getSession('bound', { identity: { tenantId: 'acme' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('rejects a different explicit owner for an existing session incarnation', async () => {
    const value = harness()
    const identity = { tenantId: 'acme' }
    await value.getSession('owned', {
      identity,
      sandboxOwner: {
        namespace: 'acme', id: 'conversation-1', instanceId: '01J00000000000000000000002', identity
      }
    })

    await expect(value.getSession('owned', {
      identity,
      sandboxOwner: {
        namespace: 'acme', id: 'conversation-2', instanceId: '01J00000000000000000000003', identity
      }
    })).rejects.toMatchObject({ code: 'SANDBOX_CONFLICT', meta: { reason: 'binding_changed' } })
  })

  it('authorizes a borrowed owner before returning a session facade', async () => {
    const storage = inMemoryHarnessStorage()
    const sandbox = inMemorySandbox()
    const open = vi.spyOn(sandbox, 'open')
    const authorizeOwner = vi.fn(() => false)
    const value = defineHarness()
      .storage(storage)
      .sandbox(sandbox, { authorizeOwner })
      .memory(inMemoryMemoryEngine())
      .models({ noop: { provider: { id: 'noop', genAiSystem: 'test' }, model: 'noop', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({})
      .build()
    const identity = { tenantId: 'acme', principalId: 'ada' }
    const sandboxOwner = {
      namespace: 'acme', id: 'shared-owner', instanceId: '01J00000000000000000000002', identity
    } as const

    await expect(value.getSession('borrowed-session', { identity, sandboxOwner })).rejects.toMatchObject({
      code: 'SANDBOX_PERMISSION_DENIED', meta: { reason: 'owner_not_authorized' }
    })
    expect(authorizeOwner).toHaveBeenCalledTimes(1)
    expect(authorizeOwner).toHaveBeenCalledWith(expect.objectContaining({
      owner: sandboxOwner,
      identity,
      harnessName: expect.any(String),
      sessionId: 'borrowed-session'
    }))
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects concurrent conflicting identities before the losing caller opens a sandbox', async () => {
    const sandbox = inMemorySandbox()
    const open = vi.spyOn(sandbox, 'open')
    const value = defineHarness()
      .sandbox(sandbox)
      .models({ noop: { provider: { id: 'noop', genAiSystem: 'test' }, model: 'noop', capabilities: [] } })
      .build()
    try {
      const outcomes = await Promise.allSettled([
        value.getSession('concurrent-bound', { identity: { tenantId: 'first' } }),
        value.getSession('concurrent-bound', { identity: { tenantId: 'second' } })
      ])
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({
        reason: { code: 'VALIDATION_ERROR', meta: { issues: { reason: 'session_identity_mismatch' } } }
      })
      expect(open).not.toHaveBeenCalled()
    } finally {
      await value.shutdown()
    }
  })

  it('grants sandbox creation only to the stored-session insertion winner across Harness clients', async () => {
    const storage = inMemoryHarnessStorage()
    const sandbox = inMemorySandbox()
    const open = vi.spyOn(sandbox, 'open')
    const make = () => defineHarness()
      .storage(storage)
      .sandbox(sandbox)
      .models({ noop: { provider: { id: 'noop', genAiSystem: 'test' }, model: 'noop', capabilities: [] } })
      .build()
    const first = make()
    const second = make()
    try {
      const outcomes = await Promise.allSettled([
        first.getSession('shared-bound', { identity: { tenantId: 'same' } }),
        second.getSession('shared-bound', { identity: { tenantId: 'same' } })
      ])
      expect(outcomes.filter(result => result.status === 'fulfilled')).not.toHaveLength(0)
      expect(open).not.toHaveBeenCalled()
    } finally {
      await first.shutdown()
      await second.shutdown()
    }
  })

  it('does not transfer creation authority when a record is replaced before the winning read', async () => {
    const storage = inMemoryHarnessStorage()
    const sandbox = inMemorySandbox()
    const open = vi.spyOn(sandbox, 'open')
    const upsert = storage.upsertSession.bind(storage)
    vi.spyOn(storage, 'upsertSession').mockImplementationOnce(async (record, mode) => {
      const inserted = await upsert(record, mode)
      await storage.closeSession(record.id, record.instanceId)
      await upsert({ ...record, instanceId: 'replacement-instance' }, 'create')
      return inserted
    })
    const value = defineHarness().storage(storage).sandbox(sandbox)
      .models({ noop: { provider: { id: 'noop', genAiSystem: 'test' }, model: 'noop', capabilities: [] } })
      .build()
    try {
      await expect(value.getSession('replaced')).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { reason: 'session_instance_mismatch' }
      })
      expect(open).not.toHaveBeenCalled()
      await expect(storage.getSession('replaced')).resolves.toMatchObject({ instanceId: 'replacement-instance' })
    } finally {
      await value.shutdown()
    }
  })

  it('creates a distinct session instance after close without advancing the clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-08-26T12:00:00.000Z')
    const storage = inMemoryHarnessStorage()
    const sandbox = inMemorySandbox()
    const open = vi.spyOn(sandbox, 'open')
    const value = defineHarness().storage(storage).sandbox(sandbox)
      .models({ noop: { provider: { id: 'noop', genAiSystem: 'test' }, model: 'noop', capabilities: [] } })
      .build()
    try {
      const first = await value.getSession('reused')
      const old = await storage.getSession('reused')
      await first.close()
      await value.getSession('reused')
      const fresh = await storage.getSession('reused')
      expect(fresh?.createdAt).toBe(old?.createdAt)
      expect(fresh?.instanceId).not.toBe(old?.instanceId)
      expect(open).not.toHaveBeenCalled()
    } finally {
      await value.shutdown()
      vi.useRealTimers()
    }
  })

  it('does not let a stale Harness client close a newly recreated session', async () => {
    const storage = inMemoryHarnessStorage()
    const sandbox = inMemorySandbox()
    const make = () => defineHarness().storage(storage).sandbox(sandbox)
      .models({ noop: { provider: { id: 'noop', genAiSystem: 'test' }, model: 'noop', capabilities: [] } })
      .build()
    const first = make()
    const second = make()
    try {
      const old = await first.getSession('reused')
      const stale = await second.getSession('reused')
      await old.close()
      const fresh = await first.getSession('reused')
      const record = await storage.getSession('reused')
      await fresh.replaceHistory([{ role: 'user', content: 'new conversation' }])
      await expect(stale.replaceHistory([{ role: 'user', content: 'stale overwrite' }])).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { reason: 'session_instance_changed' }
      })
      await expect(stale.history.list()).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { reason: 'session_instance_changed' } })
      await stale.close()
      await expect(storage.getSession('reused')).resolves.toEqual(record)
      await expect(storage.listMessages('reused')).resolves.toMatchObject([{ content: 'new conversation' }])
    } finally {
      await first.shutdown()
      await second.shutdown()
    }
  })

  it('writes a provenance-bearing summary after a completed configured turn', async () => {
    const provider = {
      id: 'summary-provider', genAiSystem: 'test',
      async object() { return { object: { summary: 'Claim is open.' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' as const } }
    }
    const value = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ summaryModel: { provider, model: 'summary-v1', capabilities: ['object', 'tool_use'] } })
      .memory((model) => ({ engine: inMemoryMemoryEngine(), summary: { model: model.summaryModel, everyTurns: 1, sourceTurns: 2 } }))
      .tools({})
      .skills({})
      .agents({ chat: { model: 'summaryModel', input: z.string(), output: z.object({ summary: z.string() }), instructions: 'Answer.' } })
      .workflows({})
      .build()
    const session = await value.getSession('summary-session')
    await session.agents.chat.prompt('Summarize this claim.')
    await expect(session.memory.read('_harness/conversation-summary')).resolves.toMatchObject({ summary: 'Claim is open.', revision: 'harness.conversation-summary.v1' })
  })
})
