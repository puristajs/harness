import type {
  MemoryAdapter,
  MemoryEntry,
  MemoryListOptions,
  MemoryOpenContext,
  MemoryOperationContext,
  MemoryScope,
  MemoryStore,
  MemoryWriteOptions
} from '../../ports/memory.js'
import { StateError } from '../../errors/index.js'
import type { JsonValue } from '../../models/json.js'
import type { HarnessAdapterContext } from '../../ports/harness-context.js'
import type { SandboxSession } from '../../sandbox/index.js'

interface SandboxMemoryMetadata {
  createdAt?: string
  updatedAt?: string
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

/**
 * Creates the built-in memory adapter backed by the current session sandbox.
 *
 * It is intentionally simple and local: session memory is stored below
 * `/memory/session/`, run memory below `/memory/runs/<runId>/`.
 *
 * @example
 * ```ts
 * const harness = defineHarness()
 *   .memory(sandboxMemory())
 *   .models({ fast: model })
 *   .agents(({ agent }) => ({ assistant: agent({ model: 'fast', instructions: 'Help.' }) }))
 *   .build()
 * ```
 */
export function sandboxMemory(): MemoryAdapter {
  return new SandboxMemoryAdapter()
}

class SandboxMemoryAdapter implements MemoryAdapter {
  public readonly info = {
    id: 'sandbox_memory',
    packageName: '@purista/harness',
    capabilities: ['memory.kv', 'memory.list', 'memory.delete', 'memory.run', 'memory.session'] as const
  }

  public readonly capabilities = this.info.capabilities

  public configureHarnessContext(_context: HarnessAdapterContext): void {
    // The sandbox adapter receives runtime context through each `open(...)` call.
  }

  public async open(scope: MemoryScope, ctx: MemoryOpenContext): Promise<MemoryStore> {
    const sandbox = ctx.sandbox
    if (!sandbox) {
      throw new StateError('sandboxMemory requires an active sandbox session.', {
        op: 'memory.get',
        adapter: 'memory',
        memory_provider: this.info.id,
        reason: 'missing_sandbox'
      })
    }

    const root = scopeRoot(scope)
    const metaRoot = scopeMetaRoot(scope)
    return {
      get: async <T = JsonValue>(key: string, op: MemoryOperationContext): Promise<T | undefined> => {
        op.signal.throwIfAborted()
        const path = `${root}/${key}.json`
        if (!(await sandbox.exists(path))) return undefined
        const raw = await sandbox.readText(path)
        try {
          return JSON.parse(raw) as T
        } catch (error) {
          throw new StateError('Stored memory value is not valid JSON.', { op: 'memory.get', reason: 'corrupt_value' }, error)
        }
      },
      set: async (
        key: string,
        value: JsonValue,
        op: MemoryOperationContext & { opts?: MemoryWriteOptions }
      ): Promise<void> => {
        op.signal.throwIfAborted()
        const existing = await readMetadata(sandbox, metaRoot, key)
        const now = new Date().toISOString()
        await sandbox.write(`${root}/${key}.json`, JSON.stringify(value))
        await sandbox.write(`${metaRoot}/${key}.json`, JSON.stringify({
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(op.opts?.tags ? { tags: op.opts.tags } : existing?.tags ? { tags: existing.tags } : {}),
          ...(op.opts?.metadata ? { metadata: op.opts.metadata } : existing?.metadata ? { metadata: existing.metadata } : {})
        }))
      },
      delete: async (key: string, op: MemoryOperationContext): Promise<void> => {
        op.signal.throwIfAborted()
        await sandbox.remove(`${root}/${key}.json`).catch(() => undefined)
        await sandbox.remove(`${metaRoot}/${key}.json`).catch(() => undefined)
      },
      list: async (op: MemoryOperationContext & { opts?: MemoryListOptions }): Promise<MemoryEntry[]> => {
        op.signal.throwIfAborted()
        const entries = await sandbox.list(root).catch(() => [])
        const opts = op.opts ?? {}
        const keys = entries
          .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.json'))
          .map((entry) => entry.name.slice(0, -5))
          .filter((key) => !opts.prefix || key.startsWith(opts.prefix))
          .filter((key) => !opts.cursor || key > opts.cursor)
          .sort()
          .slice(0, opts.limit)
        const out: MemoryEntry[] = []
        for (const key of keys) {
          const metadata = await readMetadata(sandbox, metaRoot, key)
          out.push({ key, ...(metadata ?? {}) })
        }
        return out
      }
    }
  }
}

function scopeRoot(scope: MemoryScope): string {
  if (scope.kind === 'session') return '/memory/session'
  if (scope.kind === 'run' && scope.runId) return `/memory/runs/${scope.runId}`
  throw new StateError('Unsupported sandbox memory scope.', {
    op: 'memory.get',
    adapter: 'memory',
    memory_provider: 'sandbox_memory',
    reason: `unsupported_scope:${scope.kind}`
  })
}

function scopeMetaRoot(scope: MemoryScope): string {
  if (scope.kind === 'session') return '/memory/.meta/session'
  if (scope.kind === 'run' && scope.runId) return `/memory/.meta/runs/${scope.runId}`
  throw new StateError('Unsupported sandbox memory scope.', {
    op: 'memory.list',
    adapter: 'memory',
    memory_provider: 'sandbox_memory',
    reason: `unsupported_scope:${scope.kind}`
  })
}

async function readMetadata(
  sandbox: SandboxSession,
  metaRoot: string,
  key: string
): Promise<SandboxMemoryMetadata | undefined> {
  const path = `${metaRoot}/${key}.json`
  if (!(await sandbox.exists(path).catch(() => false))) return undefined
  try {
    return JSON.parse(await sandbox.readText(path)) as SandboxMemoryMetadata
  } catch {
    return undefined
  }
}
