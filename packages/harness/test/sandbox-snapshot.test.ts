import { describe, expect, it } from 'vitest'

import { SandboxError, SandboxNoExecutorError, SandboxStateLostError } from '../src/errors/index.js'
import { inMemorySandbox, type HibernateCapableSandbox, type ResumeCapableSandbox, type SnapshotCapableSandbox } from '../src/sandbox/index.js'
import { fakeSnapshotSandbox, sandboxSnapshotContract } from '../src/testing/sandboxSnapshot.js'
import { sandboxContract } from '../src/testing/sandboxContract.js'

function scope(runId: string) {
  return { owner: { namespace: 'snapshot-test', id: 'snapshot-owner', instanceId: '01J00000000000000000000000' }, partition: { kind: 'shared' as const }, lifetime: 'run' as const, runId }
}

async function open(sandbox: ReturnType<typeof fakeSnapshotSandbox> | ReturnType<typeof inMemorySandbox>, target: ReturnType<typeof scope>, mode: 'create' | 'attach' = 'create') {
  await sandbox.registerOwner({ owner: target.owner, mode: mode === 'create' ? 'create' : 'attach' })
  return await sandbox.open({ scope: target, mode })
}

describe('fakeSnapshotSandbox', () => {
  sandboxContract(() => fakeSnapshotSandbox(), { executor: 'unavailable' })
  sandboxSnapshotContract(() => fakeSnapshotSandbox())

  it('rejects snapshots and hibernation through a terminated attachment', async () => {
    const sandbox = fakeSnapshotSandbox(); const target = scope('terminated')
    const { session } = await open(sandbox, target)
    await session.write('/workspace/a.txt', 'hello')
    await sandbox.terminate({ scope: target, reason: 'manual' })
    await expect(sandbox.snapshot(session)).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(sandbox.hibernate(session)).rejects.toBeInstanceOf(SandboxStateLostError)
  })

  it('keeps snapshots immutable and hibernation attachment-local', async () => {
    const sandbox = fakeSnapshotSandbox(); const target = scope('retained')
    const { session } = await open(sandbox, target)
    await session.write('/workspace/a.txt', 'original')
    const second = (await open(sandbox, target, 'attach')).session
    const snapshot = await sandbox.hibernate(session)
    await second.write('/workspace/a.txt', 'changed')
    await expect(session.readText('/workspace/a.txt')).rejects.toBeInstanceOf(SandboxError)
    const resumed = await sandbox.resume({ snapshotId: snapshot.snapshotId, scope: scope('resumed') })
    await expect(resumed.readText('/workspace/a.txt')).resolves.toBe('original')
    await expect(second.readText('/workspace/a.txt')).resolves.toBe('changed')
  })

  it('creates opaque snapshot ids and resumes a usable session', async () => {
    const sandbox = fakeSnapshotSandbox(); const session = (await open(sandbox, scope('source'))).session
    await session.write('/workspace/a.txt', 'hello'); const snapshot = await sandbox.snapshot(session)
    expect(snapshot.snapshotId).toMatch(/^snapshot_/); expect(snapshot.metadata?.ownerId).toBe('snapshot-owner')
    const resumed = await sandbox.resume({ snapshotId: snapshot.snapshotId, scope: scope('target') })
    await resumed.write('/workspace/b.txt', 'world')
    await expect(resumed.readText('/workspace/a.txt')).resolves.toBe('hello')
  })

  it('rejects unknown snapshots', async () => {
    await expect(fakeSnapshotSandbox().resume({ snapshotId: 'snapshot_missing', scope: scope('unknown') })).rejects.toBeInstanceOf(SandboxError)
  })
})

describe('regular sandbox adapters', () => {
  it('remain valid without snapshot capabilities', async () => {
    const sandbox = inMemorySandbox(); const session = (await open(sandbox, scope('memory'))).session
    expect('snapshot' in sandbox).toBe(false); expect('resume' in sandbox).toBe(false); expect('hibernate' in sandbox).toBe(false)
    expect(session.executor).toBe('unavailable')
    await expect(session.exec('echo hi')).rejects.toBeInstanceOf(SandboxNoExecutorError)
  })

  it('allows adapters to opt into snapshot, resume, and hibernate independently', () => {
    expect(fakeSnapshotSandbox()).toMatchObject<SnapshotCapableSandbox & ResumeCapableSandbox & HibernateCapableSandbox>({ snapshot: expect.any(Function), resume: expect.any(Function), hibernate: expect.any(Function) })
  })
})
