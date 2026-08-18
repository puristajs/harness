import { z } from 'zod'
import { expect, it } from 'vitest'
import { defineHarness, defineHarnessModule } from '@purista/harness'
import { openai } from '../src/index.js'

it('can contribute an OpenAI provider through the public static-module API', () => {
  const providerModule = defineHarnessModule<{}>()('openai.provider', {
    register(builder) {
      return builder.models({ primary: { provider: openai({ apiKey: 'test-key' }), model: 'gpt-4.1-mini', capabilities: ['object'] } })
    }
  })
  const harness = defineHarness()
    .use(providerModule)
    .agents({ echo: { model: 'primary', input: z.string(), output: z.string(), instructions: 'Echo.', builtinTools: false, handler: async (ctx) => ctx.input } })
    .build()

  expect(harness.inspect().modules[0]?.contributions).toEqual([{ kind: 'model', ids: ['primary'] }])
})
