import { defineHarness } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { createSensitiveDataActions, defineGuardrails, parseGuardrailsConfig, type SensitiveDataDetector } from '@purista/harness-guardrails'

/**
 * Fully local, deterministic guardrails example. Replace `FakeModelProvider`
 * with a normal provider addon in an application; rails remain unchanged.
 */
export async function runGuardrailsExample(): Promise<string> {
  const provider = new FakeModelProvider()
  provider.enqueue({ object: 'The safe answer.', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const detector: SensitiveDataDetector = {
    id: 'example-local-detector',
    executionMode: 'local',
    supportedEntities: ['EMAIL_ADDRESS'],
    async inspect({ text }) {
      const start = text.indexOf('[email]')
      return start < 0 ? { findings: [] } : { findings: [{ category: 'EMAIL_ADDRESS', start, end: start + '[email]'.length, score: 1 }] }
    }
  }
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({
      models: [{ type: 'main', engine: 'harness', model: 'assistant' }],
      rails: {
        config: { sensitive_data_detection: { input: { entities: ['EMAIL_ADDRESS'], mask_token: '<MASKED>', score_threshold: 0.6 } } },
        input: { flows: ['remove secret marker', 'mask sensitive data on input'] },
        output: { flows: ['block unsafe output'] }
      }
    }),
    actions: {
      ...createSensitiveDataActions({ detector }),
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
    return await session.agents.support.prompt('Where is [secret] [email]?')
  } finally {
    await session.release()
    await harness.shutdown()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGuardrailsExample().then((answer) => process.stdout.write(`${answer}\n`))
}
