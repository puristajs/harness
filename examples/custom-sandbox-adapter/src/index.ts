import { defineAgent, defineHarness, defineTool } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { z } from 'zod'

import { TrackedFilesystemSandbox } from './trackedFilesystemSandbox.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

export function createReportHarness() {
  const provider = new FakeModelProvider({ strict: true })
  const sandbox = new TrackedFilesystemSandbox()

  const createReport = defineTool('createReport', {
        description: 'Create and verify one report in the active sandbox.',
        input: z.object({ content: z.string().min(1) }),
        output: z.object({ saved: z.boolean() }),
        requires: { sandbox: ['sandbox.fs'] },
        handler: async (context, input) => {
          await context.sandbox.write('/workspace/report.txt', input.content)
          const saved = await context.sandbox.readText('/workspace/report.txt')
          return { saved: saved === input.content }
        },
      })
  const reporter = defineAgent('reporter', {
        input: z.string().min(1),
        output: z.string().min(1),
        tools: [createReport],
        instructions: 'Use create_report, then return a concise status.',
        prompt: input => ({ role: 'user', content: input }),
      })
  const harness = defineHarness({ name: 'customSandboxExample' }).addAgent(reporter).getInstance({
    model: { provider, model: 'scripted-report-model' },
    sandbox,
  })

  return { harness, provider, sandbox }
}

export async function runCustomSandboxExample() {
  const { harness: harnessPromise, provider, sandbox } = createReportHarness()
  const harness = await harnessPromise
  provider.enqueueText({
    content: '',
    toolCalls: [{
      id: 'create-report-1',
      name: 'createReport',
      arguments: { content: 'Synthetic quarterly report.' },
    }],
    usage,
    finishReason: 'tool_calls',
  })
  provider.enqueueText({ content: 'report ready', usage, finishReason: 'stop' })
  const session = await harness.getSession('report-42')

  try {
    const output = await session.agents.reporter.run('Create the quarterly report.')
    if (output.status !== 'completed') throw new Error('Report agent interrupted.')
    await session.destroy()
    return { output: output.output, operations: { ...sandbox.operations } }
  } finally {
    await harness.close()
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
