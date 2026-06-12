import { InMemoryStateStore } from '../state/in-memory.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { FinishRunPatch } from '../ports/state.js'

/** Operation names recorded by {@link FakeStateStore}. */
export type FakeStateStoreOp =
  | 'getSession'
  | 'upsertSession'
  | 'closeSession'
  | 'appendMessages'
  | 'listMessages'
  | 'clearMessages'
  | 'replaceMessages'
  | 'createRun'
  | 'finishRun'
  | 'getRun'
  | 'listRuns'
  | 'appendEvents'
  | 'listEvents'

/** In-memory state store that records every invoked operation for test inspection. */
export class FakeStateStore extends InMemoryStateStore {
  /** Ordered list of operations invoked on this store. */
  public readonly ops: FakeStateStoreOp[] = []

  public override async getSession(id: string): Promise<SessionRecord | undefined> {
    this.ops.push('getSession')
    return super.getSession(id)
  }

  public override async upsertSession(record: SessionRecord): Promise<void> {
    this.ops.push('upsertSession')
    return super.upsertSession(record)
  }

  public override async closeSession(id: string): Promise<void> {
    this.ops.push('closeSession')
    return super.closeSession(id)
  }

  public override async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    this.ops.push('appendMessages')
    return super.appendMessages(sessionId, messages)
  }

  public override async listMessages(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<Message[]> {
    this.ops.push('listMessages')
    return super.listMessages(sessionId, opts)
  }

  public override async clearMessages(sessionId: string): Promise<void> {
    this.ops.push('clearMessages')
    return super.clearMessages(sessionId)
  }

  public override async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    this.ops.push('replaceMessages')
    return super.replaceMessages(sessionId, messages)
  }

  public override async createRun(record: RunRecord): Promise<void> {
    this.ops.push('createRun')
    return super.createRun(record)
  }

  public override async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    this.ops.push('finishRun')
    return super.finishRun(runId, patch)
  }

  public override async getRun(runId: string): Promise<RunRecord | undefined> {
    this.ops.push('getRun')
    return super.getRun(runId)
  }

  public override async listRuns(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<RunRecord[]> {
    this.ops.push('listRuns')
    return super.listRuns(sessionId, opts)
  }

  public override async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    this.ops.push('appendEvents')
    return super.appendEvents(runId, events)
  }

  public override async listEvents(runId: string, opts: { limit?: number; after?: string } = {}): Promise<PersistedRunEvent[]> {
    this.ops.push('listEvents')
    return super.listEvents(runId, opts)
  }

  /** Returns how often the given operation was invoked. */
  public opCount(op: FakeStateStoreOp): number {
    return this.ops.filter((entry) => entry === op).length
  }

  /** Clears the recorded operation log without touching stored data. */
  public resetOps(): void {
    this.ops.length = 0
  }
}
