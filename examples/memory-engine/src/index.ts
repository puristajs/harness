import { defineAgent, defineHarness, type ModelProvider } from '@purista/harness'
import { sqliteMemoryEngine } from '@purista/harness-memory-sqlite'

const memoryUser = defineAgent('memoryUser', {
  model: 'chat',
  instructions: 'Use the persistent session memory configured by the application.',
  memory: { capabilities: ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search', 'memory.persistent'] },
})

const memoryHarness = defineHarness({ name: 'memoryExample' }).addAgent(memoryUser)
const provider: ModelProvider = {
  id: 'not-called', genAiSystem: 'not-called',
  async text() { return { content: '', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
  async *textStream() { yield { kind: 'finish', content: '', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
}

export function createMemoryExample(file = '.purista/memory-example.sqlite') {
  return memoryHarness.getInstance({
    models: { chat: { provider, model: 'not-called' } },
    memory: sqliteMemoryEngine({ file }),
  })
}

async function main(): Promise<void> {
  const harness = await createMemoryExample()
  const session = await harness.getSession('claim:42', { identity: { tenantId: 'acme', principalId: 'ada' } })
  await session.memory.write('claim-status', { status: 'open' }, { tags: ['claim'], ttlMs: 3_600_000 })
  console.log(await session.memory.read('claim-status'))
  await harness.close()
}

if (import.meta.url === `file://${process.argv[1]}`) void main()
