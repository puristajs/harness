import { defineAgent, defineHarness, type ModelProvider } from '@purista/harness'

import {
  InMemoryTicketMemoryClient,
  TicketMemoryEngine,
  type TicketMemoryClient,
} from './ticketMemoryEngine.js'

export function createTicketMemoryHarness(client: TicketMemoryClient) {
  const memoryUser = defineAgent('memoryUser', {
    model: 'chat',
    instructions: 'Use the session memory configured by the application.',
    memory: { capabilities: ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl'] },
  })
  const provider: ModelProvider = {
    id: 'not-called', genAiSystem: 'not-called',
    async text() { return { content: '', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
    async *textStream() { yield { kind: 'finish', content: '', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
  }
  return defineHarness({ name: 'customMemoryExample' }).addAgent(memoryUser)
    .getInstance({ models: { chat: { provider, model: 'not-called' } }, memory: new TicketMemoryEngine(client) })
}

export async function runCustomMemoryExample(): Promise<string | undefined> {
  const harness = await createTicketMemoryHarness(new InMemoryTicketMemoryClient())
  const session = await harness.getSession('ticket-42', {
    identity: { tenantId: 'acme', principalId: 'operator-7' },
  })

  try {
    await session.memory.write('status', 'open', { ttlMs: 3_600_000 })
    return await session.memory.read<string>('status')
  } finally {
    await session.release()
    await harness.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCustomMemoryExample()
    .then(status => console.log(status))
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
