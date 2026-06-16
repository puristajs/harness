import type { JsonValue, ModelProvider, ObjectRequest, ObjectResponse } from '@purista/harness'
import { workerAgentInputSchema, workerReportSchema, type WorkerAgentInput, type WorkerReport } from './schemas.js'

export class ScriptedDelmProvider implements ModelProvider {
  public readonly id = 'scripted-delm'
  public readonly genAiSystem = 'example'
  public readonly requests: ObjectRequest[] = []

  public async object<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.requests.push(req)
    const input = parseWorkerInput(req)
    const report = workerReportSchema.parse(buildReport(input))
    return {
      object: report as unknown as T,
      usage: { inputTokens: 42, outputTokens: 18, totalTokens: 60 },
      finishReason: 'stop'
    }
  }
}

function parseWorkerInput(req: ObjectRequest): WorkerAgentInput {
  const lastUser = [...req.messages].reverse().find((message) => message.role === 'user')
  if (!lastUser || typeof lastUser.content !== 'string') {
    throw new Error('ScriptedDelmProvider expected a JSON user message.')
  }
  return workerAgentInputSchema.parse(JSON.parse(lastUser.content))
}

function buildReport(input: WorkerAgentInput): WorkerReport {
  if (input.task.id === 'rollback-proposal') {
    const record = input.evidencePacket.records[0]
    return {
      taskId: input.task.id,
      workerId: input.workerId,
      type: 'PATCH_SUMMARY',
      summary: 'Roll back the 14:00 checkout deployment immediately.',
      evidence: [{
        summary: record?.title ?? 'Rollback was proposed without verified evidence.',
        detail: record?.content ?? 'Rollback was proposed before checking the reproduction.',
        verified: record?.verified ?? false,
        source: input.evidencePacket.source
      }]
    }
  }
  if (input.task.id === 'timeout-fix') {
    const passed = input.evidencePacket.records.find((record) => record.id === 'repro-002')
    const failed = input.evidencePacket.records.find((record) => record.id === 'repro-001')
    return {
      taskId: input.task.id,
      workerId: input.workerId,
      type: 'PATCH_SUMMARY',
      summary: 'increase the payment authorization timeout from 800ms to 1500ms, then monitor EU checkout recovery.',
      evidence: [{
        summary: 'Checkout reproduction passed with 1500ms timeout.',
        detail: [failed?.content, passed?.content].filter(Boolean).join(' '),
        verified: Boolean(passed?.verified),
        source: input.evidencePacket.source
      }]
    }
  }
  if (input.task.id === 'metrics-scope') {
    const record = input.evidencePacket.records[0]
    return {
      taskId: input.task.id,
      workerId: input.workerId,
      type: 'OBSERVED',
      summary: 'Checkout failures are concentrated in EU card authorization; US and wallet flows remain normal.',
      evidence: [{
        summary: record?.title ?? 'EU authorization failure rate spiked after deploy.',
        detail: record?.content ?? 'Metrics show EU card authorization failures rose after deploy.',
        verified: record?.verified ?? false,
        source: input.evidencePacket.source
      }]
    }
  }
  const record = input.evidencePacket.records[0]
  return {
    taskId: input.task.id,
    workerId: input.workerId,
    type: 'FACT',
    summary: 'Logs show payment_authorization_timeout errors began after the 14:00 checkout deploy.',
    evidence: [{
      summary: record?.title ?? 'Timeout error appears in checkout API logs.',
      detail: [
        record?.content ?? 'Checkout logs show payment authorization timeout errors.',
        `Question: ${input.question}. Prior digest visible to this worker: ${input.sharedDigest}`
      ].join(' '),
      verified: record?.verified ?? false,
      source: input.evidencePacket.source
    }]
  }
}
