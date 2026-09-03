import { defineHarness } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { z } from 'zod'

import { TrackedFilesystemSandbox } from './trackedFilesystemSandbox.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

export function createReportHarness() {
  const provider = new FakeModelProvider({ strict: true })
  const sandbox = new TrackedFilesystemSandbox()

  const harness = defineHarness({ name: 'custom-sandbox-example' })
    .sandbox(sandbox)
    .models({
      assistant: {
        provider,
        model: 'scripted-report-model',
        capabilities: ['object', 'tool_use'],
      },
    })
    .tool('create_report', {
        description: 'Create and verify one report in the active sandbox.',
        input: z.object({ content: z.string().min(1) }),
        output: z.object({ saved: z.boolean() }),
        handler: async (context, input) => {
          await context.sandbox.write('/workspace/report.txt', input.content)
          const saved = await context.sandbox.readText('/workspace/report.txt')
          return { saved: saved === input.content }
        },
      }).agent('reporter', {
        model: 'assistant',
        input: z.string().min(1),
        output: z.string().min(1),
        tools: ['create_report'],
        instructions: 'Use create_report, then return a concise status.',
      })
    .build()

  return { harness, provider, sandbox }
}

export async function runCustomSandboxExample() {
  const { harness, provider, sandbox } = createReportHarness()
  provider.enqueueObject({
    object: {},
    toolCalls: [{
      id: 'create-report-1',
      name: 'create_report',
      arguments: { content: 'Synthetic quarterly report.' },
    }],
    usage,
    finishReason: 'tool_calls',
  })
  provider.enqueueObject({ object: 'report ready', usage, finishReason: 'stop' })
  const session = await harness.getSession('report-42')

  try {
    const output = await session.agents.reporter.run('Create the quarterly report.')
    if (output.status === 'interrupted') throw new Error(`Report agent interrupted: ${output.interrupt.type}`)
    await session.destroy()
    return { output: output.output, operations: { ...sandbox.operations } }
  } finally {
    await harness.shutdown()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCustomSandboxExample()
    .then(({ output, operations }) => {
      console.log(`${output} (created: ${operations.opened}, terminated: ${operations.terminated})`)
    })
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
