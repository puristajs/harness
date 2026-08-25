import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineHarness, inMemoryHarnessStorage, inMemoryMemoryEngine, inMemorySandbox } from '../src/index.js'

function harness() {
  return defineHarness()
    .storage(inMemoryHarnessStorage())
    .sandbox(inMemorySandbox())
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

  it('binds optional identity exactly before opening a session resource', async () => {
    const value = harness()
    await value.getSession('bound', { tenantId: 'acme', principalId: 'ada' })
    await expect(value.getSession('bound', { tenantId: 'acme' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
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
