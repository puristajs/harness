import { defineHarness, inMemorySandbox } from '@purista/harness'

import {
  InMemoryTicketMemoryClient,
  TicketMemoryEngine,
  type TicketMemoryClient,
} from './ticketMemoryEngine.js'

export function createTicketMemoryHarness(client: TicketMemoryClient) {
  return defineHarness({ name: 'custom-memory-example' })
    .sandbox(inMemorySandbox())
    .memory(new TicketMemoryEngine(client))
    .models({
      unused: {
        provider: { id: 'not-called', genAiSystem: 'not-called' },
        model: 'not-called',
        capabilities: [],
      },
    })
    .build()
}

export async function runCustomMemoryExample(): Promise<string | undefined> {
  const harness = createTicketMemoryHarness(new InMemoryTicketMemoryClient())
  const session = await harness.getSession('ticket-42', {
    identity: { tenantId: 'acme', principalId: 'operator-7' },
  })

  try {
    await session.memory.write('status', 'open', { ttlMs: 3_600_000 })
    return await session.memory.read<string>('status')
  } finally {
    await session.release()
    await harness.shutdown()
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
