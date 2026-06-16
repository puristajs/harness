import {
  evidenceRecordSchema,
  sharedEntrySchema,
  workerReportSchema,
  type EvidenceRecord,
  type SharedEntry,
  type SharedEntryType,
  type WorkerReport
} from './schemas.js'

export interface AdmissionResult {
  accepted: boolean
  entry?: SharedEntry
  evidence: EvidenceRecord[]
  rejection?: {
    workerId: string
    taskId: string
    reason: string
  }
}

export interface SharedContextSnapshot {
  entries: SharedEntry[]
  evidence: EvidenceRecord[]
  rejectedReports: Array<{ workerId: string; taskId: string; reason: string }>
}

export interface RenderDigestOptions {
  includeTypes?: readonly SharedEntryType[]
  limit?: number
  now?: Date
}

export interface UnfoldedEntry {
  entry: SharedEntry
  evidence: EvidenceRecord[]
}

export interface SharedContextStore {
  admit(report: WorkerReport): AdmissionResult
  renderDigest(options?: RenderDigestOptions): string
  unfold(entryId: string): UnfoldedEntry | undefined
  snapshot(): SharedContextSnapshot
}

export interface SharedContextStoreOptions {
  now?: () => Date
  claimTtlMs?: number
  maxSummaryChars?: number
}

const defaultClaimTtlMs = 5 * 60 * 1000
const defaultMaxSummaryChars = 240

export function createSharedContextStore(options: SharedContextStoreOptions = {}): SharedContextStore {
  return new InMemorySharedContextStore(options)
}

class InMemorySharedContextStore implements SharedContextStore {
  private readonly entries: SharedEntry[] = []
  private readonly evidence: EvidenceRecord[] = []
  private readonly rejectedReports: Array<{ workerId: string; taskId: string; reason: string }> = []
  private sequence = 0
  private readonly now: () => Date
  private readonly claimTtlMs: number
  private readonly maxSummaryChars: number

  public constructor(options: SharedContextStoreOptions) {
    this.now = options.now ?? (() => new Date())
    this.claimTtlMs = options.claimTtlMs ?? defaultClaimTtlMs
    this.maxSummaryChars = options.maxSummaryChars ?? defaultMaxSummaryChars
  }

  public admit(rawReport: WorkerReport): AdmissionResult {
    const report = workerReportSchema.parse(rawReport)
    const summary = compact(report.summary, this.maxSummaryChars)
    if (!summary) return this.reject(report, 'empty_summary')
    if (report.type === 'PATCH_SUMMARY' && !report.evidence.some((item) => item.verified)) {
      return this.reject(report, 'patch_summary_requires_verified_evidence')
    }

    const createdAtDate = this.now()
    const createdAt = createdAtDate.toISOString()
    const evidence = report.evidence.map((item) => evidenceRecordSchema.parse({
      ...item,
      id: this.nextId('ev'),
      taskId: report.taskId,
      workerId: report.workerId,
      createdAt
    }))
    this.evidence.push(...evidence)

    const expiresAt = report.type === 'CLAIM'
      ? new Date(createdAtDate.getTime() + this.claimTtlMs).toISOString()
      : undefined
    const entry = sharedEntrySchema.parse({
      id: this.nextId('ctx'),
      taskId: report.taskId,
      workerId: report.workerId,
      type: report.type,
      summary,
      evidenceRefs: evidence.map((item) => item.id),
      createdAt,
      ...(expiresAt ? { expiresAt } : {})
    })
    this.entries.push(entry)
    return { accepted: true, entry, evidence }
  }

  public renderDigest(options: RenderDigestOptions = {}): string {
    const now = options.now ?? this.now()
    const include = options.includeTypes ? new Set(options.includeTypes) : undefined
    const limit = options.limit ?? 12
    const entries = this.entries
      .filter((entry) => !include || include.has(entry.type))
      .filter((entry) => !isExpired(entry, now))
      .slice(-limit)

    if (entries.length === 0) return '(no admitted shared context yet)'
    return entries.map((entry) => {
      const evidenceSuffix = entry.evidenceRefs.length > 0 ? ` evidence=${entry.evidenceRefs.length}` : ''
      return `[${entry.workerId}/${entry.type} task=${entry.taskId} id=${entry.id}] ${entry.summary}${evidenceSuffix}`
    }).join('\n')
  }

  public unfold(entryId: string): UnfoldedEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === entryId)
    if (!entry) return undefined
    const evidence = entry.evidenceRefs
      .map((ref) => this.evidence.find((item) => item.id === ref))
      .filter((item): item is EvidenceRecord => item !== undefined)
    return { entry, evidence }
  }

  public snapshot(): SharedContextSnapshot {
    return {
      entries: this.entries.slice(),
      evidence: this.evidence.slice(),
      rejectedReports: this.rejectedReports.slice()
    }
  }

  private reject(report: WorkerReport, reason: string): AdmissionResult {
    const rejection = { workerId: report.workerId, taskId: report.taskId, reason }
    this.rejectedReports.push(rejection)
    return { accepted: false, evidence: [], rejection }
  }

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}_${String(this.sequence).padStart(4, '0')}`
  }
}

function compact(value: string, maxChars: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized.length > maxChars ? normalized.slice(0, maxChars).trimEnd() : normalized
}

function isExpired(entry: SharedEntry, now: Date): boolean {
  return entry.expiresAt !== undefined && new Date(entry.expiresAt).getTime() <= now.getTime()
}
