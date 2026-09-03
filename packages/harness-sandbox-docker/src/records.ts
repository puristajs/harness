import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SandboxStateLostError, type SandboxOwner, type SandboxScope } from '@purista/harness'
import { z } from 'zod'
import { failure } from './options.js'

const recordSchema = z.strictObject({
  version: z.literal(2),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  lifetime: z.enum(['session', 'run']),
  state: z.enum(['creating', 'active', 'terminating', 'terminated']),
  context: z.string().min(1),
  host: z.string().startsWith('unix://'),
  engineId: z.string().min(1),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
})
export type LifecycleRecord = z.infer<typeof recordSchema>
const ownerSchema = z.strictObject({ pid: z.number().int().positive(), token: z.uuid() })
type Owner = z.infer<typeof ownerSchema>
const registeredOwnerSchema = z.strictObject({ version: z.literal(1), owner: z.object({
  namespace: z.string(), id: z.string(), instanceId: z.string(),
  identity: z.object({ tenantId: z.string().optional(), principalId: z.string().optional() }).optional(),
}) })
export interface Ownership { readonly token: string; assert(): Promise<void>; release(): Promise<void> }

export function scopeKey(scope: SandboxScope): string {
  if (!isScope(scope)) throw failure('invalid_scope', 'Docker sandbox scope is invalid.')
  const value = scope
  const partition = value.partition.kind === 'shared'
    ? ['shared']
    : value.partition.kind === 'group'
      ? ['group', value.partition.id]
      : [value.partition.kind, value.partition.harnessName, value.partition.id]
  // Fixed ordering preserves omitted identity dimensions and ignores object insertion order.
  return hash(JSON.stringify([
    value.owner.namespace, value.owner.id, value.owner.instanceId,
    value.owner.identity !== undefined, value.owner.identity?.tenantId ?? null, value.owner.identity?.principalId ?? null,
    ...partition, value.lifetime, value.lifetime === 'run' ? value.runId : null,
  ]))
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function stateLost(lifetime: 'session' | 'run', reason: 'lifecycle_state_missing' | 'provider_missing' | 'durable_workspace_recovery_unavailable'): SandboxStateLostError {
  return new SandboxStateLostError('Docker sandbox state is unavailable; no empty replacement was created.', { reason, lifetime, adapter_id: 'docker' })
}

/** Private host-local state. No raw scope identity is written to disk. */
export class Records {
  private directory: Promise<string> | undefined
  public constructor(private readonly root: string) {}
  private async dir(): Promise<string> {
    this.directory ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const path = join(await realpath(this.root), 'docker-sandbox')
      await mkdir(path, { recursive: true, mode: 0o700 })
      const metadata = await lstat(path)
      if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) throw failure('lifecycle_metadata_invalid')
      return path
    })().catch(() => { this.directory = undefined; throw failure('lifecycle_metadata_unavailable') })
    return await this.directory
  }
  public async key(scope: SandboxScope): Promise<string> { return hash(`${await this.dir()}\0${scopeKey(scope)}`) }
  public async registerOwner(owner: SandboxOwner, mode: 'create' | 'attach'): Promise<'created' | 'existing'> {
    const key = hash(`${await this.dir()}\0owner\0${ownerKey(owner)}`)
    const path = join(await this.dir(), `${key}.owner.json`)
    const current = await this.readJson(path)
    if (current !== undefined) {
      const parsed = registeredOwnerSchema.safeParse(current)
      if (!parsed.success || storedOwnerKey(parsed.data.owner) !== ownerKey(owner)) throw failure('lifecycle_metadata_invalid')
      return 'existing'
    }
    if (mode === 'attach') throw stateLost('session', 'lifecycle_state_missing')
    await this.writeJson(path, { version: 1, owner })
    return 'created'
  }

  /** Adapter-private durable catalog state. The layout is intentionally not public API. */
  public async readJournal(): Promise<unknown | undefined> {
    try {
      return await this.readJson(join(await this.dir(), 'ownership-journal.json'))
    } catch {
      // A corrupt private authority cannot justify provider discovery or a
      // fresh catalog. Surface it as state loss with no raw filesystem detail.
      throw stateLost('session', 'lifecycle_state_missing')
    }
  }

  /** Atomically replaces the adapter-private catalog after its caller holds the catalog lock. */
  public async writeJournal(value: unknown): Promise<void> {
    await this.writeJson(join(await this.dir(), 'ownership-journal.json'), value)
  }

  /**
   * Serializes private catalog transitions across DockerSandbox instances that
   * share this metadata root. The recovery marker means a dead local writer
   * is never mistaken for permission to discover provider resources.
   */
  public async withJournalLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = hash(`${await this.dir()}\0ownership-journal-v1`)
    const ownership = await this.acquire(key, async () => undefined)
    try {
      return await operation()
    } finally {
      await ownership.release()
    }
  }

  /** Holds one private resource-operation lock across an external engine effect. */
  public async withResourceLock<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    const key = hash(`${await this.dir()}\0cleanup\0${resourceId}`)
    const ownership = await this.acquire(key, async () => undefined)
    try {
      return await operation()
    } finally {
      await ownership.release()
    }
  }

  /** Counts only hardened owner registrations when deciding whether a journal can be initialized. */
  public async ownerRegistrationCount(): Promise<number> {
    const directory = await this.dir()
    const entries = await readdir(directory)
    let count = 0
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.owner\.json$/.test(entry)) continue
      const metadata = await lstat(join(directory, entry))
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw failure('lifecycle_metadata_invalid')
      count += 1
    }
    return count
  }
  public async read(key: string): Promise<LifecycleRecord | undefined> {
    const value = await this.readJson(join(await this.dir(), `${key}.json`))
    if (value === undefined) return undefined
    const parsed = recordSchema.safeParse(value)
    if (!parsed.success || parsed.data.key !== key) throw failure('lifecycle_metadata_invalid')
    return parsed.data
  }
  public async write(record: LifecycleRecord): Promise<void> {
    await this.writeJson(join(await this.dir(), `${record.key}.json`), record)
  }
  private async writeJson(path: string, value: unknown): Promise<void> {
    const directory = await this.dir()
    const temporary = join(directory, `.${randomUUID()}`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
      const parent = await open(directory, 'r')
      try { await parent.sync() } finally { await parent.close() }
    } catch {
      throw failure('lifecycle_metadata_unavailable')
    } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }
  private async readJson(path: string): Promise<unknown> {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw failure('lifecycle_metadata_invalid')
      return JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined
      throw failure('lifecycle_metadata_invalid')
    }
  }
  public async acquire(key: string, recover: () => Promise<void>): Promise<Ownership> {
    const directory = await this.dir()
    const path = join(directory, `${key}.owner`)
    const recovery = join(directory, `${key}.recovery`)
    const mine: Owner = { pid: process.pid, token: randomUUID() }
    const readOwner = async (): Promise<Owner | undefined> => {
      const value = await this.readJson(path)
      if (value === undefined) return undefined
      const parsed = ownerSchema.safeParse(value)
      if (!parsed.success) throw failure('ownership_uncertain')
      return parsed.data
    }
    const createOwner = async (): Promise<boolean> => {
      try { await writeFile(path, JSON.stringify(mine), { flag: 'wx', mode: 0o600 }); return true }
      catch (error) { if (hasCode(error, 'EEXIST')) return false; throw failure('ownership_unavailable') }
    }
    if (await exists(recovery)) throw failure('ownership_uncertain')
    if (!(await createOwner())) {
      const old = await readOwner()
      if (!old || processAlive(old.pid)) throw failure('ownership_conflict', 'Another local client owns this sandbox scope. Release it before attaching.')
      try { await mkdir(recovery, { mode: 0o700 }) } catch { throw failure('ownership_conflict') }
      try {
        if ((await readOwner())?.token !== old.token) throw failure('ownership_conflict')
        // A dead host PID alone says nothing about in-container processes.
        await recover()
        await removeOwner(path)
        if (!(await createOwner())) throw failure('ownership_conflict')
      } finally { await rm(recovery, { recursive: true }).catch(() => undefined) }
    } else if (await exists(recovery)) {
      await removeOwner(path)
      throw failure('ownership_conflict')
    }
    return {
      token: mine.token,
      assert: async () => { if ((await readOwner())?.token !== mine.token) throw failure('ownership_lost') },
      release: async () => { if ((await readOwner())?.token === mine.token) await removeOwner(path) },
    }
  }
}

function hasCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if (hasCode(error, 'ENOENT')) return false; throw failure('ownership_unavailable') } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) { return !hasCode(error, 'ESRCH') } }
async function removeOwner(path: string): Promise<void> { try { await rm(path) } catch { throw failure('ownership_unavailable') } }

function isScope(value: unknown): value is SandboxScope {
  if (!value || typeof value !== 'object') return false
  const scope = value as Partial<SandboxScope>
  const scopeKeys = scope.lifetime === 'run' ? ['owner', 'partition', 'lifetime', 'runId'] : ['owner', 'partition', 'lifetime']
  if (Object.keys(scope).length !== scopeKeys.length || !scopeKeys.every(key => Object.hasOwn(scope, key))) return false
  if (!scope.owner || !scope.partition || (scope.lifetime !== 'session' && scope.lifetime !== 'run')) return false
  const owner = scope.owner
  if (!safe(owner.namespace) || !safe(owner.id) || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(owner.instanceId)) return false
  if (owner.identity && (!isIdentity(owner.identity) || !Object.hasOwn(owner, 'identity'))) return false
  if (scope.lifetime === 'run' ? !safe(scope.runId) : Object.hasOwn(scope, 'runId')) return false
  if (scope.partition.kind === 'shared') return Object.keys(scope.partition).length === 1
  if (scope.partition.kind === 'group') return /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(scope.partition.id) && Object.keys(scope.partition).length === 2
  return (scope.partition.kind === 'agent' || scope.partition.kind === 'workflow')
    && safe(scope.partition.harnessName) && safe(scope.partition.id) && Object.keys(scope.partition).length === 3
}

function isIdentity(value: object): boolean {
  const identity = value as { tenantId?: unknown; principalId?: unknown }
  return Object.keys(identity).every(key => key === 'tenantId' || key === 'principalId')
    && (!Object.hasOwn(identity, 'tenantId') || safe(identity.tenantId))
    && (!Object.hasOwn(identity, 'principalId') || safe(identity.principalId))
}

function safe(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).byteLength <= 256 && !/[\u0000-\u001F\u007F-\u009F]/.test(value)
}

function ownerKey(owner: SandboxOwner): string {
  return JSON.stringify([owner.namespace, owner.id, owner.instanceId, owner.identity !== undefined, owner.identity?.tenantId ?? null, owner.identity?.principalId ?? null])
}

function storedOwnerKey(owner: { namespace: string; id: string; instanceId: string; identity?: { tenantId?: string | undefined; principalId?: string | undefined } | undefined }): string {
  return JSON.stringify([owner.namespace, owner.id, owner.instanceId, owner.identity !== undefined, owner.identity?.tenantId ?? null, owner.identity?.principalId ?? null])
}
