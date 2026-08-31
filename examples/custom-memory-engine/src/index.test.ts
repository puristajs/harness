import { expect, it } from 'vitest'

import { createTicketMemoryHarness } from './index.js'
import { InMemoryTicketMemoryClient } from './ticketMemoryEngine.js'

it('uses the custom engine through tenant-bound session memory', async () => {
  const harness = createTicketMemoryHarness(new InMemoryTicketMemoryClient())
  const session = await harness.getSession('ticket-42', {
    identity: { tenantId: 'acme', principalId: 'operator-7' },
  })

  try {
    await session.memory.write('status', 'open')
    await expect(session.memory.read('status')).resolves.toBe('open')
    await expect(session.memory.list()).resolves.toMatchObject({
      records: [expect.objectContaining({ key: 'status', value: 'open' })],
    })
  } finally {
    await session.release()
    await harness.shutdown()
  }
})
