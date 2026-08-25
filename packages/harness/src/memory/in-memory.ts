import type { MemoryEngine, MemoryEngineContext, MemoryListOptions, MemoryListResult, MemoryRecord, MemoryScope } from '../ports/memory.js'

/** Dependency-free, process-local engine used by default and in deterministic tests. */
export function inMemoryMemoryEngine(): MemoryEngine<readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl']> {
  return new InMemoryMemoryEngine()
}

class InMemoryMemoryEngine implements MemoryEngine<readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl']> {
  public readonly info = Object.freeze({ id: 'in_memory_memory', packageName: '@purista/harness' })
  public readonly capabilities = Object.freeze(['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl'] as const)
  private readonly records = new Map<string, MemoryRecord>()

  public async get(scope: MemoryScope, key: string, _context: MemoryEngineContext): Promise<MemoryRecord | undefined> {
    const record = this.records.get(recordKey(scope, key))
    if (!record) return undefined
    if (isExpired(record)) {
      this.records.delete(recordKey(scope, key))
      return undefined
    }
    return record
  }

  public async put(scope: MemoryScope, record: MemoryRecord, _context: MemoryEngineContext): Promise<void> {
    this.records.set(recordKey(scope, record.key), record)
  }

  public async delete(scope: MemoryScope, key: string, _context: MemoryEngineContext): Promise<void> {
    this.records.delete(recordKey(scope, key))
  }

  public async list(scope: MemoryScope, options: MemoryListOptions, _context: MemoryEngineContext): Promise<MemoryListResult> {
    const prefix = options.prefix ?? ''
    const after = options.cursor ? decodeCursor(options.cursor) : undefined
    const candidates = [...this.records.values()]
      .filter((record) => record.scopeKey === scope.scopeKey && record.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key))
    const live: MemoryRecord[] = []
    for (const record of candidates) {
      if (isExpired(record)) {
        this.records.delete(recordKey(scope, record.key))
        continue
      }
      if (after && record.key <= after) continue
      live.push(record)
    }
    const limit = options.limit ?? 20
    const records = live.slice(0, limit)
    const next = live.length > records.length ? encodeCursor(records.at(-1)!.key) : undefined
    return Object.freeze({ records: Object.freeze(records), ...(next ? { cursor: next } : {}) })
  }
}

function recordKey(scope: MemoryScope, key: string): string { return `${scope.scopeKey}\u0000${key}` }
function isExpired(record: MemoryRecord): boolean { return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now() }
function encodeCursor(key: string): string { return Buffer.from(key, 'utf8').toString('base64url') }
function decodeCursor(cursor: string): string | undefined { try { return Buffer.from(cursor, 'base64url').toString('utf8') } catch { return undefined } }
