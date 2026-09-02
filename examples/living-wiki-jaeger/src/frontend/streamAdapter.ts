export type SseState = 'idle' | 'invoking workflow' | 'invoking agent' | 'SSE connected' | 'SSE reconnecting' | 'completed' | 'interrupted' | 'failed' | 'cancelled'

export type RunEvent = {
  type: string
  runId?: string
  outcome?: {
    status?: 'completed' | 'interrupted'
    output?: Record<string, unknown>
    interrupt?: unknown
  }
  error?: { message?: string }
  delta?: string
  value?: Record<string, unknown>
  toolId?: string
  callId?: string
  dropped?: number
  [key: string]: unknown
}

export type ToolIndicator = {
  id: string
  name: string
  status: 'running' | 'done' | 'failed'
  input?: unknown
  output?: unknown
  error?: string
}

export type StreamUpdate =
  | { kind: 'overflow'; dropped: number }
  | { kind: 'tool'; tool: ToolIndicator }
  | { kind: 'answer_delta'; delta: string }
  | { kind: 'finished'; state: SseState; failedMessage?: string }
  | { kind: 'review'; reviewRequest: unknown }
  | { kind: 'artifacts'; artifacts: unknown[] }
  | { kind: 'none' }

export function adaptRunEvent(event: RunEvent): StreamUpdate[] {
  const updates: StreamUpdate[] = []
  if (event.type === 'stream.overflow') updates.push({ kind: 'overflow', dropped: Number(event.dropped ?? 0) })
  if (event.type === 'output.text.delta' && typeof event.delta === 'string') {
    updates.push({ kind: 'answer_delta', delta: event.delta })
  }

  if (event.type === 'tool.started') {
    updates.push({
      kind: 'tool',
      tool: {
        id: String(event.callId ?? event.toolId ?? crypto.randomUUID()),
        name: String(event.toolId ?? 'tool'),
        status: 'running',
        input: event['input']
      }
    })
  }

  if (event.type === 'tool.finished') {
    const failed = Boolean(event.error)
    updates.push({
      kind: 'tool',
      tool: {
        id: String(event.callId ?? event.toolId ?? crypto.randomUUID()),
        name: String(event.toolId ?? 'tool'),
        status: failed ? 'failed' : 'done',
        output: event['output'],
        ...(event.error?.message ? { error: event.error.message } : {})
      }
    })
  }

  const payload = event.outcome?.output ?? event.value
  const reviewRequest = readReviewRequest(payload) ?? readReviewRequest(event)
  if (reviewRequest) updates.push({ kind: 'review', reviewRequest })

  const artifacts = readArtifacts(payload) ?? readArtifacts(event)
  if (artifacts.length > 0) updates.push({ kind: 'artifacts', artifacts })

  if (event.type === 'run.finished') {
    updates.push({
      kind: 'finished',
      state: event.outcome?.status === 'interrupted' ? 'interrupted' : 'completed'
    })
  }

  if (event.type === 'run.failed') {
    updates.push({
      kind: 'finished',
      state: event.error?.message?.toLowerCase().includes('cancel') ? 'cancelled' : 'failed',
      ...(event.error?.message ? { failedMessage: event.error.message } : {})
    })
  }

  return updates.length > 0 ? updates : [{ kind: 'none' }]
}

export function mergeTool(current: ToolIndicator[], incoming: ToolIndicator): ToolIndicator[] {
  const existing = current.find((tool) => tool.id === incoming.id)
  const next = existing ? { ...existing, ...incoming, name: incoming.name || existing.name } : incoming
  return [...current.filter((tool) => tool.id !== incoming.id), next]
}

export function readReviewRequest(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return isReviewRequest(record['reviewRequest']) ? record['reviewRequest'] : undefined
}

export function readArtifacts(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  const artifacts = (value as Record<string, unknown>)['artifacts']
  return Array.isArray(artifacts) ? artifacts : []
}

function isReviewRequest(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && typeof record['runId'] === 'string' && Array.isArray(record['questions'])
}
