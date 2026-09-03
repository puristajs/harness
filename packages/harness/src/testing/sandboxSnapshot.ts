import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { OperationCancelledError, SandboxError, SandboxPermissionDeniedError, SandboxStateLostError } from '../errors/index.js'
import type { DirEntry, FileStat } from '../harness/types.js'
import type { JsonValue } from '../models/json.js'
import { sameHarnessIdentity } from '../identity/index.js'
import { SandboxAdapterCatalog } from '../sandbox/adapter-catalog.js'
import type { HibernateCapableSandbox, ResumeCapableSandbox, Sandbox, SandboxOpenOptions, SandboxOpenResult, SandboxResumeOptions, SandboxSessionBase, SnapshotCapableSandbox, SnapshotResult } from '../sandbox/index.js'
import type { SandboxScope } from '../sandbox/ownership.js'
import { ProcessLocalSandboxLifecycle } from '../sandbox/lifecycle.js'

type SnapshotSandbox = Sandbox<readonly ['sandbox.fs', 'sandbox.snapshot', 'sandbox.resume', 'sandbox.hibernate']> & SnapshotCapableSandbox & ResumeCapableSandbox & HibernateCapableSandbox
type Node = { kind: 'file'; data: Uint8Array; modifiedAt: string } | { kind: 'directory'; modifiedAt: string }
const INSTANCE = '01J00000000000000000000000'

function now(): string { return new Date().toISOString() }
function clone(files: ReadonlyMap<string, Node>): Map<string, Node> {
  return new Map([...files].map(([name, node]) => [name, node.kind === 'file' ? { ...node, data: new Uint8Array(node.data) } : { ...node }]))
}
function absolute(input: string): string {
  if (!input.startsWith('/')) throw new SandboxError('Invalid path', { reason: 'invalid_path' })
  return path.posix.normalize(input)
}

class Session implements SandboxSessionBase {
  public readonly executor = 'unavailable' as const
  private closed = false
  public constructor(
    public readonly owner: SandboxScope['owner'],
    public readonly runId: string | undefined,
    private readonly files = new Map<string, Node>([['/', { kind: 'directory', modifiedAt: now() }]]),
    private readonly assertActive: () => void | Promise<void> = () => {},
    public readonly resumedFromSnapshotId?: string
  ) {}

  public attach(assertActive: () => void | Promise<void>): Session { return new Session(this.owner, this.runId, this.files, assertActive, this.resumedFromSnapshotId) }
  public async snapshot(): Promise<Map<string, Node>> { await this.assertOpen(); return clone(this.files) }
  public async read(file: string): Promise<Uint8Array> {
    await this.assertOpen(); const node = this.files.get(absolute(file))
    if (!node || node.kind !== 'file') throw new SandboxError('File not found', { reason: 'fs_failed' })
    return new Uint8Array(node.data)
  }
  public async readText(file: string): Promise<string> { return new TextDecoder().decode(await this.read(file)) }
  public async write(file: string, data: Uint8Array | string): Promise<void> {
    await this.assertOpen(); const target = absolute(file); this.parents(target)
    this.files.set(target, { kind: 'file', data: typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data), modifiedAt: now() })
  }
  public async remove(file: string, options?: { recursive?: boolean }): Promise<void> {
    await this.assertOpen(); const target = absolute(file)
    if (options?.recursive) for (const name of [...this.files.keys()]) if (name === target || name.startsWith(`${target}/`)) this.files.delete(name)
    else this.files.delete(target)
  }
  public async list(root: string): Promise<DirEntry[]> {
    await this.assertOpen(); const base = absolute(root)
    return [...this.files.entries()].filter(([name]) => name !== base && name.startsWith(base === '/' ? '/' : `${base}/`)).map(([name, node]) => ({ name: name.split('/').at(-1)!, path: name, kind: node.kind, ...(node.kind === 'file' ? { size: node.data.byteLength } : {}) }))
  }
  public async stat(file: string): Promise<FileStat> {
    await this.assertOpen(); const node = this.files.get(absolute(file)); if (!node) throw new SandboxError('Path not found', { reason: 'fs_failed' })
    return { kind: node.kind, size: node.kind === 'file' ? node.data.byteLength : 0, modifiedAt: node.modifiedAt }
  }
  public async exists(file: string): Promise<boolean> { await this.assertOpen(); return this.files.has(absolute(file)) }
  public async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> { for (const [name, data] of files) await this.write(`${absolute(atPath)}/${name.replace(/^\//, '')}`, data) }
  public async close(): Promise<void> { this.closed = true }
  private parents(file: string): void {
    let current = '/'
    for (const part of file.split('/').filter(Boolean).slice(0, -1)) { current = current === '/' ? `/${part}` : `${current}/${part}`; if (!this.files.has(current)) this.files.set(current, { kind: 'directory', modifiedAt: now() }) }
  }
  private async assertOpen(): Promise<void> { await this.assertActive(); if (this.closed) throw new SandboxError('Sandbox session is closed.', { reason: 'session_closed' }) }
}

/** Deterministic in-memory fixture for snapshot/resume adapter contracts. */
export function fakeSnapshotSandbox(): SnapshotSandbox {
  let nextSnapshot = 1
  const lifecycle = new ProcessLocalSandboxLifecycle<Session>()
  const catalog = SandboxAdapterCatalog.inMemory(async (resource) => { if (resource.scope) await lifecycle.terminate({ scope: resource.scope, reason: 'manual' }) })
  const snapshots = new Map<string, { owner: SandboxScope['owner']; files: Map<string, Node>; metadata: Record<string, JsonValue> }>()
  const sandbox: SnapshotSandbox = {
    capabilities: ['sandbox.fs', 'sandbox.snapshot', 'sandbox.resume', 'sandbox.hibernate'],
    administration: catalog.administration,
    registerOwner: async (options) => await catalog.registerOwner(options),
    async open(options: SandboxOpenOptions): Promise<SandboxOpenResult<readonly ['sandbox.fs', 'sandbox.snapshot', 'sandbox.resume', 'sandbox.hibernate']>> {
      const opened = await catalog.open(options, async () => await lifecycle.open(options, () => new Session(options.scope.owner, options.scope.lifetime === 'run' ? options.scope.runId : undefined)))
      return { session: opened.session.attach(opened.assertActive), disposition: opened.disposition, liveProcessState: 'not_preserved' }
    },
    async terminate(options) { await catalog.terminate(options, async () => await lifecycle.terminate(options)) },
    async snapshot(session) {
      if (!(session instanceof Session)) throw new SandboxError('Snapshot helper received an unknown session implementation.', { reason: 'invalid_session' })
      const snapshotId = `snapshot_${nextSnapshot++}`
      snapshots.set(snapshotId, { owner: session.owner, files: await session.snapshot(), metadata: { ownerId: session.owner.id, ...(session.runId ? { runId: session.runId } : {}) } })
      return { snapshotId, metadata: snapshots.get(snapshotId)!.metadata }
    },
    async resume(options: SandboxResumeOptions): Promise<SandboxSessionBase> {
      const snapshot = snapshots.get(options.snapshotId)
      if (!snapshot) throw new SandboxError('Snapshot not found.', { reason: 'unknown_snapshot' })
      if (snapshot.owner.namespace !== options.scope.owner.namespace || snapshot.owner.id !== options.scope.owner.id || snapshot.owner.instanceId !== options.scope.owner.instanceId || !sameHarnessIdentity(snapshot.owner.identity, options.scope.owner.identity)) {
        throw new SandboxStateLostError('Snapshot owner is unavailable for this target.', { reason: 'owner_missing', lifetime: options.scope.lifetime })
      }
      const opened = await catalog.open({ scope: options.scope, mode: 'create', ...(options.identity ? { identity: options.identity } : {}), ...(options.signal ? { signal: options.signal } : {}) }, async () =>
        await lifecycle.open({ scope: options.scope, mode: 'create', ...(options.identity ? { identity: options.identity } : {}), ...(options.signal ? { signal: options.signal } : {}) }, () => new Session(options.scope.owner, options.scope.lifetime === 'run' ? options.scope.runId : undefined, clone(snapshot.files), undefined, options.snapshotId)))
      if (opened.session.resumedFromSnapshotId !== options.snapshotId) throw new SandboxError('Snapshot target already contains different state.', { reason: 'snapshot_target_conflict' })
      return opened.session.attach(opened.assertActive)
    },
    async hibernate(session) { const snapshot = await this.snapshot(session); await session.close(); return snapshot }
  }
  return sandbox
}

function scope(runId: string): SandboxScope {
  return { owner: { namespace: 'snapshot-contract', id: 'contract-owner', instanceId: INSTANCE }, partition: { kind: 'shared' }, lifetime: 'run', runId }
}
async function registeredOpen(sandbox: SnapshotSandbox, target: SandboxScope) {
  await sandbox.registerOwner({ owner: target.owner, mode: 'create' })
  return await sandbox.open({ scope: target, mode: 'create' })
}

/** Contract tests for adapters that opt into sandbox snapshot/resume support. */
export function sandboxSnapshotContract(make: () => SnapshotSandbox | Promise<SnapshotSandbox>): void {
  describe('sandboxSnapshotContract', () => {
    it('resumes only for the exact owner and preserves target edits', async () => {
      const sandbox = await make(); const sourceScope = scope('source'); const targetScope = scope('target')
      const source = (await registeredOpen(sandbox, sourceScope)).session
      await source.write('/workspace/a.txt', 'snapshot')
      const { snapshotId } = await sandbox.snapshot(source)
      await sandbox.terminate({ scope: sourceScope, reason: 'manual' })
      const [first, second] = await Promise.all([sandbox.resume({ snapshotId, scope: targetScope }), sandbox.resume({ snapshotId, scope: targetScope })])
      await first.write('/workspace/a.txt', 'target edit')
      await expect(second.readText('/workspace/a.txt')).resolves.toBe('target edit')
      await expect(sandbox.open({ scope: targetScope, mode: 'attach' })).resolves.toBeDefined()
      await expect(sandbox.resume({ snapshotId, scope: { ...targetScope, owner: { ...targetScope.owner, id: 'other-owner' } } })).rejects.toBeInstanceOf(SandboxStateLostError)
    })

    it('cancels resume before allocating its target', async () => {
      const sandbox = await make(); const source = (await registeredOpen(sandbox, scope('source'))).session
      await source.write('/workspace/a.txt', 'snapshot'); const { snapshotId } = await sandbox.snapshot(source); const target = scope('cancelled')
      await sandbox.registerOwner({ owner: target.owner, mode: 'create' })
      await expect(sandbox.resume({ snapshotId, scope: target, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(OperationCancelledError)
      await expect(sandbox.open({ scope: target, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
    })

    it('does not let snapshot resume bypass an offboarded tenant actor', async () => {
      const sandbox = await make()
      const owner = { namespace: 'snapshot-contract', id: 'tenant-owner', instanceId: INSTANCE, identity: { tenantId: 'tenant-a' } } as const
      const source = { owner, partition: { kind: 'shared' as const }, lifetime: 'run' as const, runId: 'source' }
      const target = { ...source, runId: 'target' }
      const revokedActor = { tenantId: 'tenant-a', principalId: 'principal-a' } as const
      const retainedActor = { tenantId: 'tenant-a', principalId: 'principal-b' } as const

      await sandbox.registerOwner({ owner, mode: 'create' })
      const session = (await sandbox.open({ scope: source, mode: 'create', identity: revokedActor })).session
      await session.write('/workspace/a.txt', 'snapshot')
      const { snapshotId } = await sandbox.snapshot(session)
      await sandbox.administration.purge({
        selector: { kind: 'principal', namespace: owner.namespace, tenantId: 'tenant-a', principalId: 'principal-a' },
        idempotencyKey: 'offboard-snapshot-principal'
      })

      await expect(sandbox.resume({ snapshotId, scope: target, identity: revokedActor })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
      await expect(sandbox.resume({ snapshotId, scope: target, identity: retainedActor })).resolves.toBeDefined()
    })

    it('rejects unknown snapshots and closes hibernated attachments', async () => {
      const sandbox = await make(); const target = scope('source'); const session = (await registeredOpen(sandbox, target)).session
      await session.write('/workspace/a.txt', 'hello'); const snapshot = await sandbox.hibernate(session)
      await expect(session.readText('/workspace/a.txt')).rejects.toBeInstanceOf(SandboxError)
      await expect(sandbox.resume({ snapshotId: snapshot.snapshotId, scope: scope('target') })).resolves.toBeDefined()
      await expect(sandbox.resume({ snapshotId: 'snapshot_missing', scope: target })).rejects.toBeInstanceOf(SandboxError)
    })
  })
}
