import { memoryEngineContract } from '@purista/harness/testing'

import { InMemoryTicketMemoryClient, TicketMemoryEngine } from './ticketMemoryEngine.js'

memoryEngineContract(
  () => new TicketMemoryEngine(new InMemoryTicketMemoryClient()),
)
