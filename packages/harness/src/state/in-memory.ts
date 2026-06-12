import { StateError } from '../errors/index.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { FinishRunPatch, StateStore } from '../ports/state.js'

class Mutex {
  private current = Promise.resolve()

  public async lock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.current
    let release: (() => void) | undefined
    this.current = new Promise<void>((resolve) => { release = resolve })
    await prev
    try {
      return await fn()
    } finally {
      release?.()
    }
  }
}

/**
 * In-process state store for local development and tests.
 */
export class InMemoryStateStore implements StateStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly messages = new Map<string, Message[]>()
  private readonly runs = new Map<string, RunRecord>()
  private readonly events = new Map<string, PersistedRunEvent[]>()
  private readonly messageLocks = new Map<string, Mutex>()

  public async getSession(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id)
  }

  public async upsertSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, record)
  }

  public async closeSession(id: string): Promise<void> {
    this.sessions.delete(id)
    this.messages.delete(id)
    this.messageLocks.delete(id)
    for (const [runId, run] of this.runs) {
      if (run.sessionId === id) {
        this.runs.delete(runId)
        this.events.delete(runId)
      }
    }
  }

  public async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    return this.withMessageLock(sessionId, 'appendMessages', async () => {
      const current = this.messages.get(sessionId) ?? []
      const ids = new Set(current.map((msg) => msg.id))
      for (const message of messages) {
        if (ids.has(message.id)) {
          throw new StateError('Duplicate message id.', { op: 'appendMessages', reason: 'duplicate_message_id' })
        }
        ids.add(message.id)
      }
      this.messages.set(sessionId, [...current, ...messages])
    })
  }

  public async listMessages(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<Message[]> {
    let rows = [...(this.messages.get(sessionId) ?? [])]
      .sort((a, b) => a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp.localeCompare(b.timestamp))

    if (opts.before) {
      const beforeIndex = rows.findIndex((row) => row.id === opts.before)
      if (beforeIndex >= 0) {
        rows = rows.slice(0, beforeIndex)
      }
    }

    if (opts.limit !== undefined) {
      rows = rows.slice(Math.max(0, rows.length - opts.limit))
    }

    return rows
  }

  public async clearMessages(sessionId: string): Promise<void> {
    return this.withMessageLock(sessionId, 'clearMessages', async () => {
      this.messages.delete(sessionId)
    })
  }

  public async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    return this.withMessageLock(sessionId, 'replaceMessages', async () => {
      const ids = new Set<string>()
      for (const message of messages) {
        if (ids.has(message.id)) {
          throw new StateError('Duplicate message id.', { op: 'replaceMessages', reason: 'duplicate_message_id' })
        }
        ids.add(message.id)
      }
      // Atomic clear+append under one lock: validate first, then commit so a
      // failure never leaves history partially replaced.
      this.messages.set(sessionId, [...messages])
    })
  }

  public async createRun(record: RunRecord): Promise<void> {
    this.runs.set(record.id, record)
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return
    this.runs.set(runId, { ...run, ...patch })
  }

  public async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId)
  }

  public async listRuns(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<RunRecord[]> {
    let rows = [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => a.startedAt === b.startedAt ? b.id.localeCompare(a.id) : b.startedAt.localeCompare(a.startedAt))

    if (opts.before) {
      const beforeIndex = rows.findIndex((row) => row.id === opts.before)
      if (beforeIndex >= 0) {
        rows = rows.slice(beforeIndex + 1)
      }
    }

    if (opts.limit !== undefined) {
      rows = rows.slice(0, opts.limit)
    }

    return rows
  }

  public async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    const current = this.events.get(runId) ?? []
    this.events.set(runId, [...current, ...events])
  }

  public async listEvents(runId: string, opts: { limit?: number; after?: string } = {}): Promise<PersistedRunEvent[]> {
    let rows = [...(this.events.get(runId) ?? [])]

    if (opts.after) {
      const afterIndex = rows.findIndex((row) => row.id === opts.after)
      if (afterIndex >= 0) {
        rows = rows.slice(afterIndex + 1)
      }
    }

    if (opts.limit !== undefined) {
      rows = rows.slice(0, opts.limit)
    }

    return rows
  }

  public async close(): Promise<void> {
    this.sessions.clear()
    this.messages.clear()
    this.runs.clear()
    this.events.clear()
    this.messageLocks.clear()
  }

  private async withMessageLock<T>(sessionId: string, op: 'appendMessages' | 'clearMessages' | 'replaceMessages', fn: () => Promise<T>): Promise<T> {
    let lock = this.messageLocks.get(sessionId)
    if (!lock) {
      lock = new Mutex()
      this.messageLocks.set(sessionId, lock)
    }

    try {
      return await lock.lock(fn)
    } catch (error) {
      if (error instanceof StateError) throw error
      throw new StateError('State store operation failed.', { op }, error)
    }
  }
}
