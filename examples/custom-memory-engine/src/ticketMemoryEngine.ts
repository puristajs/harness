import type {
  MemoryEngine,
  MemoryEngineContext,
  MemoryListOptions,
  MemoryListResult,
  MemoryRecord,
  MemoryScope,
} from '@purista/harness'

export interface TicketMemoryClient {
  get(scopeKey: string, key: string): Promise<MemoryRecord | undefined>
  put(scopeKey: string, record: MemoryRecord): Promise<void>
  delete(scopeKey: string, key: string): Promise<void>
  list(scopeKey: string): Promise<readonly MemoryRecord[]>
  close?(): Promise<void>
}

export class TicketMemoryEngine implements MemoryEngine<
  readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl']
> {
  public readonly info = {
    id: 'ticket_memory',
    packageName: '@example/harness-memory-ticket',
    version: '1',
  } as const

  public readonly capabilities = [
    'memory.kv',
    'memory.list',
    'memory.delete',
    'memory.ttl',
  ] as const

  public constructor(private readonly client: TicketMemoryClient) {}

  public async get(
    scope: MemoryScope,
    key: string,
    context: MemoryEngineContext,
  ): Promise<MemoryRecord | undefined> {
    context.signal.throwIfAborted()
    const record = await this.client.get(scope.scopeKey, key)
    return record && !isExpired(record) ? record : undefined
  }

  public async put(
    scope: MemoryScope,
    record: MemoryRecord,
    context: MemoryEngineContext,
  ): Promise<void> {
    context.signal.throwIfAborted()
    await this.client.put(scope.scopeKey, record)
  }

  public async delete(
    scope: MemoryScope,
    key: string,
    context: MemoryEngineContext,
  ): Promise<void> {
    context.signal.throwIfAborted()
    await this.client.delete(scope.scopeKey, key)
  }

  public async list(
    scope: MemoryScope,
    options: MemoryListOptions,
    context: MemoryEngineContext,
  ): Promise<MemoryListResult> {
    context.signal.throwIfAborted()
    const records = (await this.client.list(scope.scopeKey))
      .filter(record => !isExpired(record))
      .filter(record => !options.prefix || record.key.startsWith(options.prefix))
      .sort((left, right) => left.key.localeCompare(right.key))
    const start = options.cursor
      ? Math.max(0, records.findIndex(record => record.key === options.cursor) + 1)
      : 0
    const limit = options.limit ?? 100
    const page = records.slice(start, start + limit)
    const cursor = start + limit < records.length ? page.at(-1)?.key : undefined

    return { records: page, ...(cursor ? { cursor } : {}) }
  }

  public async close(): Promise<void> {
    await this.client.close?.()
  }
}

export class InMemoryTicketMemoryClient implements TicketMemoryClient {
  private readonly records = new Map<string, MemoryRecord>()

  public async get(scopeKey: string, key: string): Promise<MemoryRecord | undefined> {
    return this.records.get(`${scopeKey}\u0000${key}`)
  }

  public async put(scopeKey: string, record: MemoryRecord): Promise<void> {
    this.records.set(`${scopeKey}\u0000${record.key}`, record)
  }

  public async delete(scopeKey: string, key: string): Promise<void> {
    this.records.delete(`${scopeKey}\u0000${key}`)
  }

  public async list(scopeKey: string): Promise<readonly MemoryRecord[]> {
    return [...this.records.values()].filter(record => record.scopeKey === scopeKey)
  }
}

function isExpired(record: MemoryRecord): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()
}
