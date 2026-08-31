import { describe, expect, it, vi } from 'vitest'

import { createInvoiceHarness } from './index.js'
import type { InternalJsonClient } from './internalModelProvider.js'

describe('custom model provider example', () => {
  it('runs a typed agent through the application-owned provider', async () => {
    const generateJson = vi.fn<InternalJsonClient['generateJson']>(async request => {
      request.signal.throwIfAborted()
      return {
        value: { message: 'Invoice INV-42 is ready for payment.' },
        inputTokens: 12,
        outputTokens: 8,
        stopReason: 'complete',
      }
    })
    const harness = createInvoiceHarness({ generateJson })
    const session = await harness.getSession('custom-provider-test')

    try {
      await expect(
        session.agents.invoice_status.run({ invoiceId: 'INV-42' }),
      ).resolves.toEqual({ message: 'Invoice INV-42 is ready for payment.' })
      expect(generateJson).toHaveBeenCalledOnce()
      expect(generateJson.mock.calls[0]?.[0].model).toBe('internal-json-v1')
    } finally {
      await session.release()
      await harness.shutdown()
    }
  })
})
