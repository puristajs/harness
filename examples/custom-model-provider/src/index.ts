import { defineHarness } from '@purista/harness'
import { z } from 'zod'

import {
  InternalModelProvider,
  type InternalJsonClient,
} from './internalModelProvider.js'

const invoiceInput = z.object({ invoiceId: z.string().min(1) })
const invoiceOutput = z.object({ message: z.string().min(1) })

export function createInvoiceHarness(client: InternalJsonClient) {
  return defineHarness({ name: 'internal-provider-example' })
    .models({
      assistant: {
        provider: new InternalModelProvider(client),
        model: 'internal-json-v1',
        capabilities: ['object'],
      },
    }).agent('invoice_status', {
        model: 'assistant',
        input: invoiceInput,
        output: invoiceOutput,
        instructions: 'Return a concise invoice status matching the output schema.',
      })
    .build()
}

export async function runCustomProviderExample(): Promise<string> {
  const client: InternalJsonClient = {
    async generateJson(request) {
      request.signal.throwIfAborted()
      return {
        value: { message: 'Invoice INV-42 is ready for payment.' },
        inputTokens: 12,
        outputTokens: 8,
        stopReason: 'complete',
      }
    },
  }
  const harness = createInvoiceHarness(client)
  const session = await harness.getSession('custom-provider-example')

  try {
    const result = await session.agents.invoice_status.run({ invoiceId: 'INV-42' })
    if (result.status === 'interrupted') throw new Error(`Invoice lookup interrupted: ${result.interrupt.type}`)
    return result.output.message
  } finally {
    await session.release()
    await harness.shutdown()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCustomProviderExample()
    .then(message => console.log(message))
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
