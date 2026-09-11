import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineAgent, defineHarness, defineWorkflow, JsonLogger, localDurableExecution, type JsonValue, type ModelProvider } from '@purista/harness'
import { openai } from '@purista/harness-openai'
import { createSharedContextStore } from './shared-context.js'
import { createTaskQueue } from './task-queue.js'
import { evidenceForTask } from './incident-data.js'
import { checkoutIncidentInput, checkoutIncidentTasks } from './scenario.js'
import {
  delmWorkflowInputSchema,
  delmWorkflowOutputSchema,
  workerAgentInputSchema,
  workerReportSchema,
  type DelmWorkflowInput,
  type WorkerTask,
} from './schemas.js'

export interface DelmSharedContextHarnessOptions {
  provider?: ModelProvider
  model?: string
  storageRoot?: string
}

export const defaultDelmTasks: WorkerTask[] = checkoutIncidentTasks

const researchWorker = defineAgent('researchWorker', {
  model: 'workerModel',
  input: workerAgentInputSchema,
  output: workerReportSchema,
  instructions: [
    'You are one decentralized worker in a DeLM-inspired workflow.',
    'Use only the supplied evidencePacket and admitted sharedDigest.',
    'Choose report type by task id: logs-investigation=FACT, metrics-scope=OBSERVED, rollback-proposal=PATCH_SUMMARY, timeout-fix=PATCH_SUMMARY.',
    'PATCH_SUMMARY needs concrete verified evidence. Keep unverified evidence marked verified=false.',
    'Keep summary under 220 characters; put details in evidence[].detail.',
  ].join('\n'),
  prompt: input => ({ role: 'user', content: JSON.stringify(input) }),
})

const decentralizedResearch = defineWorkflow('decentralizedResearch', {
  input: delmWorkflowInputSchema,
  output: delmWorkflowOutputSchema,
  agents: [researchWorker],
  agentCalls: { maxCalls: 32, maxParallel: 8 },
  durable: true,
  workspace: true,
  async handler(context) {
    const queue = createTaskQueue(context.input.tasks)
    const shared = createSharedContextStore()
    let round = 0
    while (round < context.input.tasks.length) {
      const assignments = Array.from({ length: context.input.workers }, (_unused, index) => {
        const workerId = `worker-${index + 1}`
        const task = queue.claim(workerId)
        return task ? { workerId, task } : undefined
      }).filter((item): item is { workerId: string; task: WorkerTask } => item !== undefined)
      if (assignments.length === 0) break
      const reports = await Promise.all(assignments.map((assignment, index) => context.agents.researchWorker.run({
        question: context.input.question,
        workerId: assignment.workerId,
        task: assignment.task,
        evidencePacket: evidenceForTask(assignment.task.id),
        sharedDigest: shared.renderDigest({ limit: 8 }),
      }, { callId: `researchRound${round}Worker${index}` })))
      for (const [index, report] of reports.entries()) {
        const assignment = assignments[index]
        if (!assignment) continue
        const result = shared.admit(report)
        context.metrics.counter(result.accepted ? 'delm.shared_context.admitted' : 'delm.shared_context.rejected', 1)
        queue.complete(assignment.task.id, assignment.workerId)
      }
      round += 1
    }
    const snapshot = shared.snapshot()
    await context.step('shared-context-summary', async () => ({
      admitted: snapshot.entries.length,
      rejected: snapshot.rejectedReports.length,
      queue: queue.snapshot(),
    }) as unknown as JsonValue)
    const verifiedPatch = snapshot.entries.find(entry => entry.type === 'PATCH_SUMMARY')
    return delmWorkflowOutputSchema.parse({
      answer: verifiedPatch
        ? `Recommendation: mitigate the checkout outage with ${verifiedPatch.summary}`
        : 'Recommendation: keep investigating; no verified mitigation was admitted.',
      admittedEntries: snapshot.entries,
      rejectedReports: snapshot.rejectedReports,
      queue: queue.snapshot(),
      checkpointCount: 1,
    })
  },
})

const delmHarness = defineHarness({ name: 'delmSharedContextExample', revision: 'v1' })
  .addWorkflow(decentralizedResearch)

export async function createDelmSharedContextHarness(options: DelmSharedContextHarnessOptions = {}) {
  const provider = options.provider ?? openai({ apiKey: requireOpenAiKey() })
  const local = localDurableExecution({
    root: options.storageRoot ?? mkdtempSync(join(tmpdir(), 'purista-delm-shared-context-')),
    exec: false,
  })
  const harness = await delmHarness.getInstance({
    models: { workerModel: { provider, model: options.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-mini' } },
    storage: local.storage,
    sandbox: local.sandbox,
    workspace: local.workspace,
    logger: new JsonLogger({ level: 'error' }),
    telemetry: { contentCaptureMode: 'NO_CONTENT' },
  })
  return { harness, provider, local, close: () => harness.close() }
}

export function defaultDelmInput(overrides: Partial<DelmWorkflowInput> = {}): DelmWorkflowInput {
  return checkoutIncidentInput(overrides)
}

export type DelmSharedContextHarnessResult = Awaited<ReturnType<typeof createDelmSharedContextHarness>>

function loadRootEnv(): void {
  const candidates = [resolve(process.cwd(), '.env.local'), resolve(process.cwd(), '.env'), resolve(process.cwd(), '../..', '.env.local'), resolve(process.cwd(), '../..', '.env')]
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    }
  }
}

function requireOpenAiKey(): string {
  loadRootEnv()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey || apiKey === 'sk-your-key-here') throw new Error('OPENAI_API_KEY is required. Create .env from .env.example in the repository root.')
  return apiKey
}
