import { modelProviderContract } from '@purista/harness/testing'

import { InternalModelProvider } from './internalModelProvider.js'

modelProviderContract(
  () => new InternalModelProvider({
    async generateJson(request) {
      request.signal.throwIfAborted()
      return {
        value: { ok: true },
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'complete',
      }
    },
  }),
  { capabilities: ['object'] },
)
