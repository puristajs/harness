import { z } from 'zod'

export const sharedEntryTypeSchema = z.enum(['FACT', 'OBSERVED', 'FAIL', 'CLAIM', 'PATCH_SUMMARY'])

export const evidenceInputSchema = z.object({
  summary: z.string().min(1).max(240),
  detail: z.string().min(1).max(2000),
  verified: z.boolean(),
  source: z.string().min(1).max(120).optional()
})

export const evidenceRecordSchema = evidenceInputSchema.extend({
  id: z.string().min(1),
  taskId: z.string().min(1),
  workerId: z.string().min(1),
  createdAt: z.string().datetime()
})

export const sharedEntrySchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  workerId: z.string().min(1),
  type: sharedEntryTypeSchema,
  summary: z.string().min(1).max(240),
  evidenceRefs: z.array(z.string().min(1)),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional()
})

export const workerTaskSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1).max(500),
  dependsOn: z.array(z.string().min(1)).default([])
})

export const taskEvidenceRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(1200),
  verified: z.boolean()
})

export const taskEvidencePacketSchema = z.object({
  taskId: z.string().min(1),
  source: z.string().min(1).max(120),
  records: z.array(taskEvidenceRecordSchema).min(1).max(8)
})

export const workerReportSchema = z.object({
  taskId: z.string().min(1),
  workerId: z.string().min(1),
  type: sharedEntryTypeSchema,
  summary: z.string().min(1).max(1000),
  evidence: z.array(evidenceInputSchema).default([])
})

export const workerAgentInputSchema = z.object({
  question: z.string().min(1),
  workerId: z.string().min(1),
  task: workerTaskSchema,
  evidencePacket: taskEvidencePacketSchema,
  sharedDigest: z.string()
})

export const delmWorkflowInputSchema = z.object({
  question: z.string().min(1).max(1000),
  workers: z.number().int().min(1).max(8).default(3),
  tasks: z.array(workerTaskSchema).min(1).max(24)
})

export const delmWorkflowOutputSchema = z.object({
  answer: z.string(),
  admittedEntries: z.array(sharedEntrySchema),
  rejectedReports: z.array(z.object({
    workerId: z.string(),
    taskId: z.string(),
    reason: z.string()
  })),
  queue: z.array(z.object({
    id: z.string(),
    status: z.enum(['pending', 'claimed', 'completed', 'failed']),
    claimedBy: z.string().optional()
  })),
  checkpointCount: z.number().int().nonnegative()
})

export type SharedEntryType = z.infer<typeof sharedEntryTypeSchema>
export type EvidenceInput = z.infer<typeof evidenceInputSchema>
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>
export type SharedEntry = z.infer<typeof sharedEntrySchema>
export type WorkerTask = z.infer<typeof workerTaskSchema>
export type TaskEvidenceRecord = z.infer<typeof taskEvidenceRecordSchema>
export type TaskEvidencePacket = z.infer<typeof taskEvidencePacketSchema>
export type WorkerReport = z.infer<typeof workerReportSchema>
export type WorkerAgentInput = z.infer<typeof workerAgentInputSchema>
export type DelmWorkflowInput = z.infer<typeof delmWorkflowInputSchema>
export type DelmWorkflowInputDraft = z.input<typeof delmWorkflowInputSchema>
export type DelmWorkflowOutput = z.infer<typeof delmWorkflowOutputSchema>
