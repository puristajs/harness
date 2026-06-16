import { workerTaskSchema, type WorkerTask } from './schemas.js'

export type TaskStatus = 'pending' | 'claimed' | 'completed' | 'failed'

export interface TaskQueueItem {
  task: WorkerTask
  status: TaskStatus
  claimedBy?: string
  failureReason?: string
}

export interface TaskQueueSnapshotItem {
  id: string
  status: TaskStatus
  claimedBy?: string
}

export interface SharedTaskQueue {
  claim(workerId: string): WorkerTask | undefined
  complete(taskId: string, workerId: string): void
  fail(taskId: string, workerId: string, reason: string): void
  snapshot(): TaskQueueSnapshotItem[]
}

export function createTaskQueue(tasks: readonly WorkerTask[]): SharedTaskQueue {
  return new InMemoryTaskQueue(tasks)
}

class InMemoryTaskQueue implements SharedTaskQueue {
  private readonly items: TaskQueueItem[]

  public constructor(tasks: readonly WorkerTask[]) {
    this.items = tasks.map((task) => ({ task: workerTaskSchema.parse(task), status: 'pending' }))
  }

  public claim(workerId: string): WorkerTask | undefined {
    const completed = new Set(this.items.filter((item) => item.status === 'completed').map((item) => item.task.id))
    const next = this.items.find((item) => item.status === 'pending' && item.task.dependsOn.every((id) => completed.has(id)))
    if (!next) return undefined
    next.status = 'claimed'
    next.claimedBy = workerId
    return next.task
  }

  public complete(taskId: string, workerId: string): void {
    const item = this.requireClaimedBy(taskId, workerId)
    item.status = 'completed'
  }

  public fail(taskId: string, workerId: string, reason: string): void {
    const item = this.requireClaimedBy(taskId, workerId)
    item.status = 'failed'
    item.failureReason = reason
  }

  public snapshot(): TaskQueueSnapshotItem[] {
    return this.items.map((item) => ({
      id: item.task.id,
      status: item.status,
      ...(item.claimedBy ? { claimedBy: item.claimedBy } : {})
    }))
  }

  private requireClaimedBy(taskId: string, workerId: string): TaskQueueItem {
    const item = this.items.find((candidate) => candidate.task.id === taskId)
    if (!item) throw new Error(`Unknown task: ${taskId}`)
    if (item.status !== 'claimed' || item.claimedBy !== workerId) {
      throw new Error(`Task ${taskId} is not claimed by ${workerId}`)
    }
    return item
  }
}
