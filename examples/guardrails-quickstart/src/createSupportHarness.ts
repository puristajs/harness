import {
  defineAgent,
  defineHarness,
  JsonLogger,
  type Logger,
  type ModelProvider,
} from '@purista/harness'
import { defineGuardrailAction, defineGuardrails } from '@purista/harness-guardrails'
import { openai } from '@purista/harness-openai'
import { z } from 'zod'

const blockInstructionOverride = defineGuardrailAction({
  phase: 'input',
  valueSchema: z.string(),
  mayTransform: false,
  evaluate: ({ value }) =>
    /ignore (all )?previous instructions/i.test(value)
      ? { decision: 'block', reasonCode: 'instruction_override' }
      : { decision: 'allow' },
})

const supportRails = defineGuardrails({
  config: {
    rails: {
      input: { flows: ['block instruction override'] },
    },
  },
  actions: {
    'block instruction override': blockInstructionOverride,
  },
  actionTimeoutMs: 2_000,
})

export interface SupportHarnessOptions {
  logger?: Logger
  model?: string
  provider?: ModelProvider
}

function createOpenAiProvider(): ModelProvider {
  const apiKey = process.env['OPENAI_API_KEY']

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required. Copy .env.example to .env and add your key.')
  }

  return openai({ apiKey })
}

export function createSupportHarness(options: SupportHarnessOptions = {}) {
  const provider = options.provider ?? createOpenAiProvider()
  const answer = defineAgent('answer', {
        model: 'support',
        input: z.string().min(1).max(2_000),
        output: z.string(),
        instructions: 'Answer the support question concisely.',
        prompt: input => ({ role: 'user', content: input }),
        guardrails: supportRails,
      })
  return defineHarness({ name: 'guardrailsQuickstart' }).addAgent(answer).getInstance({
    models: { support: { provider, model: options.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-mini' } },
    logger: options.logger ?? new JsonLogger({ level: 'info' }),
    telemetry: { contentCaptureMode: 'NO_CONTENT' },
  })
}
