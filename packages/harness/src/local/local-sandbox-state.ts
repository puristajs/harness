import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { HarnessError, OperationCancelledError, SandboxError, SandboxStateLostError } from '../errors/index.js'
import type { SandboxOpenOptions, SandboxScope, SandboxTerminateOptions } from '../sandbox/index.js'
import type { SandboxOwner, SandboxPartition } from '../sandbox/ownership.js'
import type { LocalWorkspaceWriterFence } from './local-workspace.js'
import { sandboxPartitionSchema } from '../sandbox/ownership.js'
import { sandboxScopeKey, validateSandboxOpenOptions, validateSandboxTerminateOptions } from '../sandbox/lifecycle.js'
import { sha256Hex } from './ref-hash.js'

const recordSchema = z.strictObject({
  version: z.literal(1),
  state: z.enum(['creating', 'active', 'terminating', 'terminated']),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workspaceRefHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  restoreRefHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
})
const partitionManifestSchema = z.strictObject({
  version: z.literal(1),
  ownerHash: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().min(1),
  partitions: z.array(sandboxPartitionSchema).min(1)
})
const restoreFenceSchema = z.strictObject({
  version: z.literal(1),
  restoreRefHash: z.string().regex(/^[a-f0-9]{64}$/)
})
type Record = z.infer<typeof recordSchema>
type Binding = { workspaceRef: string; activePath: string; ownerPath: string; restoreId?: string; writerFence: LocalWorkspaceWriterFence }

/** Private attachment authority; never serialized into Harness storage. */
export interface LocalSandboxAttachment {
  readonly scope: SandboxScope
  readonly directory: string
  readonly root: string
  readonly generation: number
  /** Private durable restore epoch; never exposed in public sandbox metadata. */
  readonly restoreFencePath?: string
  readonly restoreRefHash?: string
  readonly writerFence?: LocalWorkspaceWriterFence
}

// The local adapter supports one process at a time per root. Independently
// constructed clients in that process share short operation queues; persisted
// records allow a later process to reopen without adopting arbitrary files.
const pending = new Map<string, Promise<unknown>>()
const attachments = new Map<string, Set<() => Promise<void>>>()

async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  pending.set(key, next)
  try {
    return await next
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new SandboxError('Local sandbox storage is unavailable.', { reason: 'fs_failed' })
  } finally {
    if (pending.get(key) === next) pending.delete(key)
  }
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError('Local sandbox operation was cancelled.', { scope: 'sandbox' })
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new SandboxError('Local sandbox storage is unavailable.', { reason: 'fs_failed' })
  }
}

function lost(scope: SandboxScope): SandboxStateLostError {
  return new SandboxStateLostError('Local sandbox lifecycle state is missing or no longer active.', {
    reason: 'lifecycle_state_missing', lifetime: scope.lifetime, adapter_id: 'local_directory'
  })
}

/** Host-private records and tombstones for the existing local adapter. */
export class LocalSandboxState {
  private readonly root: string
  public constructor(root: string) { this.root = resolve(root, 'sandboxes') }

  public async open(options: SandboxOpenOptions, binding?: Binding): Promise<{
    attachment: LocalSandboxAttachment
    disposition: 'created' | 'attached' | 'restored'
  }> {
    validateSandboxOpenOptions(options)
    cancelled(options.signal)
    const directory = this.directory(options.scope)
    return serial(directory, async () => {
      cancelled(options.signal)
      let record = await this.read(directory)
      if (record?.state === 'terminated' || record?.state === 'terminating') throw lost(options.scope)
      const workspaceRefHash = binding ? sha256Hex(binding.workspaceRef) : undefined
      if (options.mode === 'restore') {
        if (!binding?.restoreId) {
          throw new SandboxStateLostError('Local sandbox has no compatible active workspace binding.', {
            reason: 'durable_workspace_recovery_unavailable', lifetime: options.scope.lifetime, adapter_id: 'local_directory'
          })
        }
        if (!record || record.workspaceRefHash !== workspaceRefHash || !await exists(binding.activePath)) throw lost(options.scope)
        await this.requireWorkspaceOwner(binding, options.scope, false)
        const restoreRefHash = sha256Hex(binding.restoreId)
        if (record.restoreRefHash === restoreRefHash) {
          return { attachment: this.attachment(options.scope, directory, binding.activePath, record), disposition: 'restored' }
        }
        cancelled(options.signal)
        await this.detachAll(directory)
        record = { ...record, state: 'active', generation: record.generation + 1, restoreRefHash }
        await this.write(directory, record)
        return { attachment: this.attachment(options.scope, directory, binding.activePath, record), disposition: 'restored' }
      }
      if (record?.state === 'active') {
        if (record.workspaceRefHash !== workspaceRefHash) throw lost(options.scope)
        if (binding?.restoreId && record.restoreRefHash !== sha256Hex(binding.restoreId)) throw lost(options.scope)
        const root = binding?.activePath ?? join(directory, 'files')
        if (!await exists(root)) throw lost(options.scope)
        if (binding) await this.requireWorkspaceOwner(binding, options.scope, false)
        return { attachment: this.attachment(options.scope, directory, root, record, binding), disposition: 'attached' }
      }
      if (options.mode !== 'create') throw lost(options.scope)
      if (!record) {
        // Neither unmanaged directories nor lost metadata authorize first use.
        if (await exists(directory)) throw lost(options.scope)
      } else if (record.workspaceRefHash !== workspaceRefHash) throw lost(options.scope)
      const root = binding?.activePath ?? join(directory, 'files')
      if (binding) {
        if (record && !await exists(root)) throw lost(options.scope)
        await this.requireWorkspaceOwner(binding, options.scope, true)
      }
      if (!record) {
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        await mkdir(directory, { mode: 0o700 })
        record = {
          version: 1,
          state: 'creating',
          generation: 1,
          ...(workspaceRefHash ? { workspaceRefHash } : {}),
          ...(binding?.restoreId ? { restoreRefHash: sha256Hex(binding.restoreId) } : {})
        }
        await this.write(directory, record)
      }
      cancelled(options.signal)
      await mkdir(join(root, 'workspace'), { recursive: true, mode: 0o700 })
      record = { ...record, state: 'active' }
      await this.write(directory, record)
      return { attachment: this.attachment(options.scope, directory, root, record, binding), disposition: 'created' }
    })
  }

  public register(attachment: LocalSandboxAttachment, close: () => Promise<void>): () => void {
    const clients = attachments.get(attachment.directory) ?? new Set()
    clients.add(close)
    attachments.set(attachment.directory, clients)
    return () => {
      clients.delete(close)
      if (clients.size === 0) attachments.delete(attachment.directory)
    }
  }

  public async use<T>(attachment: LocalSandboxAttachment, operation: () => Promise<T>, holdUntilComplete = true): Promise<T> {
    const releaseWriter = await attachment.writerFence?.enter()
    try {
      const admitted = await serial(attachment.directory, async () => {
        const record = await this.read(attachment.directory)
        if (record?.state !== 'active' || record.generation !== attachment.generation || !await exists(attachment.root)) throw lost(attachment.scope)
        await this.assertRestoreFence(attachment)
        const result = operation()
        // Process admission rechecks its handle before spawn. Teardown must not
        // wait for process exit; filesystem mutations retain the short lock.
        if (holdUntilComplete) await result
        return { result }
      })
      return await admitted.result
    } finally {
      releaseWriter?.()
    }
  }

  public async terminate(options: SandboxTerminateOptions): Promise<void> {
    validateSandboxTerminateOptions(options)
    cancelled(options.signal)
    const directory = this.directory(options.scope)
    await serial(directory, async () => {
      cancelled(options.signal)
      const record = await this.read(directory)
      if (!record) {
        // A termination racing the first opener still closes that logical scope.
        // Existing unmanaged files are never adopted or removed.
        if (await exists(directory)) throw lost(options.scope)
        await mkdir(this.root, { recursive: true, mode: 0o700 })
        await mkdir(directory, { mode: 0o700 })
        await this.write(directory, { version: 1, state: 'terminated', generation: 1 })
        return
      }
      if (record.state === 'terminated') return
      await this.write(directory, { ...record, state: 'terminating' })
      await this.detachAll(directory)
      // DurableWorkspace owns all checkpoint and active-workspace retention.
      if (!record.workspaceRefHash) await rm(join(directory, 'files'), { recursive: true, force: true })
      await this.write(directory, { ...record, state: 'terminated' })
    })
  }

  private directory(scope: SandboxScope): string { return join(this.root, sha256Hex(sandboxScopeKey(scope))) }

  private attachment(scope: SandboxScope, directory: string, root: string, record: Record, binding?: Binding): LocalSandboxAttachment {
    const restoreFencePath = binding ? join(dirname(binding.ownerPath), 'sandbox-restore.json') : undefined
    return {
      scope,
      directory,
      root,
      generation: record.generation,
      ...(restoreFencePath ? { restoreFencePath } : {}),
      ...(record.restoreRefHash ? { restoreRefHash: record.restoreRefHash } : {}),
      ...(binding?.writerFence ? { writerFence: binding.writerFence } : {})
    }
  }

  private async assertRestoreFence(attachment: LocalSandboxAttachment): Promise<void> {
    if (!attachment.restoreFencePath) return
    try {
      const info = await lstat(attachment.restoreFencePath)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Invalid restore fence')
      const fence = restoreFenceSchema.parse(JSON.parse(await readFile(attachment.restoreFencePath, 'utf8')))
      if (attachment.restoreRefHash !== fence.restoreRefHash) throw lost(attachment.scope)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !attachment.restoreRefHash) return
      if (error instanceof SandboxStateLostError) throw error
      throw new SandboxStateLostError('Local sandbox restore fence is invalid or unavailable.', {
        reason: 'lifecycle_state_missing', lifetime: attachment.scope.lifetime, adapter_id: 'local_directory'
      })
    }
  }

  private async requireWorkspaceOwner(binding: Binding, scope: SandboxScope, mayClaim: boolean): Promise<void> {
    // Keep ownership beside the active workspace, outside guest files and
    // checkpoints. A second sandbox root must not adopt the same directory
    // under a different identity or session incarnation.
    const ownerDirectory = dirname(binding.ownerPath)
    const ownerPath = binding.ownerPath
    const scopeHash = sha256Hex(JSON.stringify([scope.owner, scope.lifetime, scope.lifetime === 'run' ? scope.runId : undefined]))
    await serial(ownerPath, async () => {
      try {
        const parent = await lstat(ownerDirectory)
        if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('Invalid workspace directory')
        let createdOwner = false
        if (mayClaim) {
          try {
            await writeFile(ownerPath, scopeHash, { flag: 'wx', mode: 0o600 })
            createdOwner = true
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        }
        const owner = await lstat(ownerPath)
        if (owner.isSymbolicLink() || !owner.isFile()) throw new Error('Invalid workspace owner')
        const storedHash = await readFile(ownerPath, 'utf8')
        if (!/^[a-f0-9]{64}$/.test(storedHash)) throw new Error('Invalid workspace owner')
        if (storedHash !== scopeHash) {
          throw new SandboxError('Local workspace belongs to a different sandbox scope.', { reason: 'invalid_scope' })
        }
        await this.recordWorkspacePartition(ownerDirectory, scope, scopeHash, createdOwner)
      } catch (error) {
        if (error instanceof SandboxError) throw error
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw lost(scope)
        throw new SandboxError('Local workspace sandbox ownership is invalid or unavailable.', { reason: 'lifecycle_metadata_invalid' })
      }
    })
  }

  private async recordWorkspacePartition(ownerDirectory: string, scope: SandboxScope, ownerHash: string, createdOwner: boolean): Promise<void> {
    if (scope.lifetime !== 'run') return
    const path = join(ownerDirectory, 'sandbox-partitions.json')
    let existing: z.infer<typeof partitionManifestSchema> | undefined
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Invalid partition manifest')
      existing = partitionManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!createdOwner) throw new SandboxStateLostError('Local workspace partition membership is missing.', {
        reason: 'lifecycle_state_missing', lifetime: scope.lifetime, adapter_id: 'local_directory'
      })
    }
    if (existing && (existing.ownerHash !== ownerHash || existing.runId !== scope.runId)) {
      throw new SandboxError('Local workspace partition membership is invalid.', { reason: 'invalid_scope' })
    }
    const partitions = canonicalPartitions([...(existing?.partitions ?? []), scope.partition])
    const next = partitionManifestSchema.parse({ version: 1, ownerHash, runId: scope.runId, partitions })
    const temporary = join(ownerDirectory, `.${randomUUID()}.partitions.json`)
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async detachAll(directory: string): Promise<void> {
    const results = await Promise.allSettled([...attachments.get(directory) ?? []].map(close => close()))
    if (results.some(result => result.status === 'rejected')) throw new SandboxError('Local sandbox process cleanup failed.', { reason: 'cleanup_failed' })
  }

  private async read(directory: string): Promise<Record | undefined> {
    try {
      const directoryInfo = await lstat(directory)
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error('Invalid directory')
      const metadata = join(directory, 'lifecycle.json')
      if ((await lstat(metadata)).isSymbolicLink()) throw new Error('Invalid metadata')
      return recordSchema.parse(JSON.parse(await readFile(metadata, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new SandboxError('Local sandbox lifecycle metadata is invalid or unavailable.', { reason: 'lifecycle_metadata_invalid' })
    }
  }

  private async write(directory: string, record: Record): Promise<void> {
    const temporary = join(directory, `.${randomUUID()}.json`)
    try {
      await writeFile(temporary, JSON.stringify(recordSchema.parse(record)), { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(directory, 'lifecycle.json'))
    } catch {
      throw new SandboxError('Local sandbox lifecycle metadata could not be committed.', { reason: 'fs_failed' })
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }
}

function canonicalPartitions(partitions: readonly z.infer<typeof sandboxPartitionSchema>[]): z.infer<typeof sandboxPartitionSchema>[] {
  const unique = new Map<string, z.infer<typeof sandboxPartitionSchema>>()
  for (const partition of partitions) unique.set(JSON.stringify(partition), partition)
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, partition]) => partition)
}

/** Reads the local adapter's private aggregate partition membership manifest. */
export async function readLocalWorkspacePartitionManifest(directory: string, owner: SandboxOwner, runId: string): Promise<readonly SandboxPartition[] | undefined> {
  const path = join(directory, 'sandbox-partitions.json')
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Invalid partition manifest')
    const manifest = partitionManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const expectedOwnerHash = sha256Hex(JSON.stringify([owner, 'run', runId]))
    if (manifest.ownerHash !== expectedOwnerHash || manifest.runId !== runId) throw new Error('Invalid partition manifest')
    return manifest.partitions
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new SandboxStateLostError('Local workspace partition membership is invalid or unavailable.', {
      reason: 'lifecycle_state_missing', lifetime: 'run', adapter_id: 'local_directory'
    })
  }
}

/**
 * Fences every attachment from the superseded active workspace before its
 * committed checkpoint replaces it. The marker is private, content-free, and
 * intentionally retained beside the owner marker rather than inside snapshots.
 */
export async function writeLocalWorkspaceRestoreFence(directory: string, restoreRef: string): Promise<void> {
  const path = join(directory, 'sandbox-restore.json')
  const temporary = join(directory, `.${randomUUID()}.restore.json`)
  try {
    const next = restoreFenceSchema.parse({ version: 1, restoreRefHash: sha256Hex(restoreRef) })
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    if (error instanceof SandboxError) throw error
    throw new SandboxError('Local workspace restore fence could not be committed.', { reason: 'fs_failed' })
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
