import { expect, it } from 'vitest'
import { defineAgent, defineHarness } from '@purista/harness'
import { openai, type OpenAiClient } from '../src/index.js'

it('binds the OpenAI provider to a directly composed v4 agent runtime', async () => {
  const requests: unknown[] = []
  const client: OpenAiClient = {
    chat: {
      completions: {
        async create(request) {
          requests.push(request)
          return {
            choices: [{ message: { content: 'bound through v4' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }
        },
      },
    },
    embeddings: {
      async create() {
        throw new Error('Unexpected embeddings request.')
      },
    },
  }
  const provider = openai({ client })
  const assistant = defineAgent('assistant', {
    instructions: 'Answer through the configured OpenAI model.',
  })
  const definition = defineHarness({ name: 'openaiV4Consumer' }).addAgent(assistant)

  expect(definition.catalog.agents.assistant).toBe(assistant)
  expect(definition.requirements.models.primary.capabilities).toContain('text')

  const instance = await definition.getInstance({
    model: { provider, model: 'gpt-4.1-mini' },
  })
  try {
    const session = await instance.getSession('openai-v4-session')
    try {
      await expect(session.agents.assistant.run('Use the provider binding.')).resolves.toMatchObject({
        status: 'completed',
        output: 'bound through v4',
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ model: 'gpt-4.1-mini' })
    } finally {
      await session.release()
    }
  } finally {
    await instance.close()
  }
})
