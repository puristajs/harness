import { defineHarness } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { defineGuardrails, parseGuardrailsConfig } from '@purista/harness-guardrails'

/**
 * Fully local, deterministic guardrails example. Replace `FakeModelProvider`
 * with a normal provider addon in an application; rails remain unchanged.
 */
export async function runGuardrailsExample(): Promise<string> {
  const provider = new FakeModelProvider()
  provider.enqueue({ object: 'The safe answer.', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({
      models: [{ type: 'main', engine: 'harness', model: 'assistant' }],
      rails: {
        input: { flows: ['remove secret marker'] },
        output: { flows: ['block unsafe output'] }
      }
    }),
    actions: {
      'remove secret marker': {
        evaluate: ({ value }) => typeof value === 'string' && value.includes('[secret]')
          ? { decision: 'transform', target: 'user_message', value: value.replace('[secret]', '[redacted]') }
          : { decision: 'allow' }
      },
      'block unsafe output': {
        evaluate: ({ value }) => typeof value === 'string' && value.includes('unsafe')
          ? { decision: 'block' }
          : { decision: 'allow' }
      }
    }
  })
  const harness = defineHarness({ name: 'guardrails-example' })
    .telemetry({ contentCaptureMode: 'NO_CONTENT' })
    .models({ assistant: { provider, model: 'fake', capabilities: ['object'] } })
    .agents({ support: rails.attach({ model: 'assistant', instructions: ({ input }) => `Answer safely: ${input}`, builtinTools: false }) })
    .build()

  const session = await harness.getSession('example-session')
  try {
    return await session.agents.support.prompt('Where is [secret]?')
  } finally {
    await session.release()
    await harness.shutdown()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGuardrailsExample().then((answer) => process.stdout.write(`${answer}\n`))
}
