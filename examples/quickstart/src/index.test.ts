import { describe, expect, it } from 'vitest'
import type { JsonValue, ModelProvider, ObjectRequest, ObjectResponse } from '@purista/harness'
import { createQuickstartHarness } from './index.js'

class ExampleProvider implements ModelProvider {
  readonly id = 'example'
  readonly genAiSystem = 'example'

  async object<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    return {
      object: { answer: 'A harness wires providers, agents, workflows, and sessions behind typed boundaries.' } as unknown as T,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop'
    }
  }
}

describe('quickstart', () => {
  it('runs the typed quickstart workflow with an injected provider', async () => {
    const harness = createQuickstartHarness(new ExampleProvider())
    const session = await harness.getSession('quickstart-test')

    const output = await session.workflows.explain_quickstart.prompt({ topic: 'harnesses' })

    expect(output.answer).toContain('typed boundaries')
    await expect(session.memory.read<{ topic: string }>('last_topic')).resolves.toEqual({ topic: 'harnesses' })
    await harness.shutdown()
  })
})
