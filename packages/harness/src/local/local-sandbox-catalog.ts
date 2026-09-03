import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { SandboxError, SandboxStateLostError } from '../errors/index.js'
import { PrivateSandboxCatalog, type PrivateCatalogCallbacks, type PrivateCatalogStorage, type PrivateSandboxCatalogOptions } from '../sandbox/catalog.js'

const LOCK_RETRY_MS = 10
const LOCK_ATTEMPTS = 500

/** Options for the private, durable catalog used by local-directory sandbox adapters. */
export interface LocalSandboxCatalogOptions extends PrivateSandboxCatalogOptions {
  /** Parent directory already owned by the local sandbox adapter. */
  root: string
  /** Adapter-internal cleanup callback; it is never exposed as a generic registry. */
  callbacks?: PrivateCatalogCallbacks
}

/**
 * Private local catalog with crash-atomic journal replacement. A new catalog
 * starts only in a missing catalog directory; an existing directory without its
 * journal is state loss and is never reconstructed by enumerating host files.
 */
export class LocalSandboxCatalog extends PrivateSandboxCatalog {
  public constructor(options: LocalSandboxCatalogOptions) {
    const root = resolve(options.root, 'sandbox-catalog')
    super(new LocalCatalogStorage(root), options)
  }
}

class LocalCatalogStorage implements PrivateCatalogStorage {
  private readonly journalPath: string
  private readonly initializedPath: string
  private readonly lockPath: string

  public constructor(private readonly root: string) {
    this.journalPath = join(root, 'catalog.json')
    this.initializedPath = join(root, 'catalog.initialized')
    this.lockPath = join(root, 'catalog.lock')
  }

  public async read(): Promise<string | undefined> {
    try { return await readFile(this.journalPath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(error)
      try { await stat(this.initializedPath) } catch (markerError) {
        if ((markerError as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw unavailable(markerError)
      }
      throw new SandboxStateLostError('Local sandbox catalog state is missing.', { reason: 'creation_indeterminate', lifetime: 'session' })
    }
  }

  public async write(value: string): Promise<void> {
    const temporary = join(dirname(this.journalPath), `.catalog-${randomUUID()}.tmp`)
    try {
      await mkdir(dirname(this.journalPath), { recursive: true, mode: 0o700 })
      await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, this.journalPath)
      await writeFile(this.initializedPath, '1\n', { encoding: 'utf8', mode: 0o600, flag: 'a' })
    } catch (error) { throw unavailable(error) } finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }

  public async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const token = randomUUID()
    await this.acquire(token)
    try { return await operation() } finally { await this.release(token) }
  }

  private async acquire(token: string): Promise<void> {
    try { await mkdir(this.root, { recursive: true, mode: 0o700 }) } catch (error) { throw unavailable(error) }
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        await writeFile(this.lockPath, JSON.stringify({ pid: process.pid, token }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(error)
        await this.reclaimDeadLock()
        await delay(LOCK_RETRY_MS)
      }
    }
    throw new SandboxError('Local sandbox catalog lock could not be acquired.', { reason: 'fs_failed' })
  }

  private async reclaimDeadLock(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.lockPath, 'utf8'))
      if (typeof value !== 'object' || value === null || !('pid' in value) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return
      try { process.kill(value.pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(this.lockPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(error)
    }
  }

  private async release(token: string): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.lockPath, 'utf8'))
      if (typeof value === 'object' && value !== null && 'token' in value && value.token === token) await rm(this.lockPath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(error)
    }
  }
}

function unavailable(cause: unknown): SandboxError { return new SandboxError('Local sandbox catalog storage is unavailable.', { reason: 'fs_failed' }, cause) }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
