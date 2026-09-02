import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { defineHarness, JsonLogger, localDurableExecution, type JsonValue, type ModelProvider } from '@purista/harness'
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

export function createDelmSharedContextHarness(options: DelmSharedContextHarnessOptions = {}) {
  const provider = options.provider ?? openai({ apiKey: requireOpenAiKey() })
  const local = localDurableExecution({
    root: options.storageRoot ?? mkdtempSync(join(tmpdir(), 'purista-delm-shared-context-')),
    exec: false,
  })
  const harness = defineHarness({ name: 'delm-shared-context-example' })
    .logger(new JsonLogger({ level: 'error' }))
    .telemetry({ contentCaptureMode: 'NO_CONTENT' })
    .storage(local.storage)
    .sandbox(local.sandbox)
    .workspace(local.workspace)
    .requires(['storage.persistent', 'workspace.persistent'])
    .models({
      worker_model: {
        provider,
        model: options.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-mini',
        capabilities: ['object'],
      },
    })
    .agent('research_worker', {
      input: workerAgentInputSchema,
      output: workerReportSchema,
      handler: async (ctx) => {
        const response = await ctx.models.worker_model.object(
          {
            messages: [
              {
                role: 'system',
                content: [
                  'You are one decentralized worker in a DeLM-inspired workflow.',
                  'Use only the supplied evidencePacket and admitted sharedDigest.',
                  'Choose report type by task id: logs-investigation=FACT, metrics-scope=OBSERVED, rollback-proposal=PATCH_SUMMARY, timeout-fix=PATCH_SUMMARY.',
                  'Return one typed report. PATCH_SUMMARY needs concrete verified evidence.',
                  'If evidence is unverified, keep verified=false so the admission gate can reject it.',
                  'Keep summary under 220 characters; put details in evidence[].detail.',
                ].join('\n'),
              },
              { role: 'user', content: JSON.stringify(ctx.input) },
            ],
            schema: z.toJSONSchema(workerReportSchema) as JsonValue,
            schemaName: 'WorkerReport',
          },
          ctx.signal,
          {
            runId: ctx.runId,
            sessionId: ctx.sessionId,
            agentId: 'research_worker',
          },
        )
        return workerReportSchema.parse(response.object)
      },
    })
    .workflow('decentralized_research', {
      input: delmWorkflowInputSchema,
      output: delmWorkflowOutputSchema,
      delegation: {
        agents: ['research_worker'],
        maxChildAgentCalls: 32,
        maxParallelChildAgentCalls: 8,
      },
      handler: async (ctx) => {
        const queue = createTaskQueue(ctx.input.tasks)
        const shared = createSharedContextStore()
        let round = 0

        while (round < ctx.input.tasks.length) {
          const assignments = Array.from({ length: ctx.input.workers }, (_unused, index) => {
            const workerId = `worker-${index + 1}`
            const task = queue.claim(workerId)
            return task ? { workerId, task } : undefined
          }).filter((item): item is { workerId: string; task: WorkerTask } => item !== undefined)

          if (assignments.length === 0) break
          const reports = await Promise.all(
            assignments.map((assignment) =>
              ctx.agents.research_worker({
                question: ctx.input.question,
                workerId: assignment.workerId,
                task: assignment.task,
                evidencePacket: evidenceForTask(assignment.task.id),
                sharedDigest: shared.renderDigest({ limit: 8 }),
              }),
            ),
          )

          for (const [index, report] of reports.entries()) {
            const assignment = assignments[index]
            if (!assignment) continue
            const result = shared.admit(report)
            ctx.metrics.counter(result.accepted ? 'delm.shared_context.admitted' : 'delm.shared_context.rejected', 1)
            queue.complete(assignment.task.id, assignment.workerId)
          }
          round += 1
        }

        const snapshot = shared.snapshot()
        await ctx.step(
          'shared-context-summary',
          async () =>
            ({
              admitted: snapshot.entries.length,
              rejected: snapshot.rejectedReports.length,
              queue: queue.snapshot(),
            }) as unknown as JsonValue,
        )
        const verifiedPatch = snapshot.entries.find((entry) => entry.type === 'PATCH_SUMMARY')
        return delmWorkflowOutputSchema.parse({
          answer: verifiedPatch
            ? `Recommendation: mitigate the checkout outage with ${verifiedPatch.summary}`
            : `Recommendation: keep investigating; no verified mitigation was admitted.`,
          admittedEntries: snapshot.entries,
          rejectedReports: snapshot.rejectedReports,
          queue: queue.snapshot(),
          checkpointCount: 1,
        })
      },
    })
    .build()

  return {
    harness,
    provider,
    local,
    close: async () => {
      await harness.shutdown()
    },
  }
}

export function defaultDelmInput(overrides: Partial<DelmWorkflowInput> = {}): DelmWorkflowInput {
  return checkoutIncidentInput(overrides)
}

export type DelmSharedContextHarnessResult = ReturnType<typeof createDelmSharedContextHarness>

function loadRootEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env.local'),
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../..', '.env.local'),
    resolve(process.cwd(), '../..', '.env'),
  ]

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const raw = trimmed.slice(eq + 1).trim()
      process.env[key] ??= raw.replace(/^['"]|['"]$/g, '')
    }
  }
}

function requireOpenAiKey(): string {
  loadRootEnv()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey || apiKey === 'sk-your-key-here') {
    throw new Error(
      'OPENAI_API_KEY is required. Create .env from .env.example in the repository root. The example defaults to OPENAI_MODEL=gpt-5-mini.',
    )
  }
  return apiKey
}
