import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HarnessConfigError, SandboxConflictError } from '../errors/index.js'
import { localDirectoryWorkspace } from '../local/local-workspace.js'
import { durableWorkspaceContract, inMemoryDurableWorkspace } from '../testing/index.js'
import type { DurableWorkspace } from './workspace.js'
import { validateDurableWorkspace } from './workspace.js'

const sandboxOwner = { namespace: 'workspace-test', id: 'owner', instanceId: '01J00000000000000000000000' } as const
const sandboxPolicyDigest = 'a'.repeat(64)
const sandboxPartitions = [{ kind: 'shared' as const }] as const

describe('inMemoryDurableWorkspace', () => {
  durableWorkspaceContract(() => inMemoryDurableWorkspace())

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts idempotency records once a workspace is cleaned', async () => {
    const signal = new AbortController().signal
    const adapter = inMemoryDurableWorkspace()
    const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', sandboxOwner, sandboxPolicyDigest, attempt: 1, idempotencyKey: 'start', signal })
    await adapter.pauseWorkspace({ handle, sandboxPartitions, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
    await adapter.cleanupWorkspace({ workspaceRef: handle.workspaceRef, reason: 'manual', idempotencyKey: 'cleanup', signal })

    const internals = adapter as unknown as { startKeys: Map<string, unknown>; opResults: Map<string, unknown> }
    expect(internals.startKeys.size).toBe(0)
    // Only the cleanup replay record may remain; start/pause replays are evicted.
    expect([...internals.opResults.keys()]).toEqual(['cleanup'])

    // Cleanup stays idempotent after eviction.
    const again = await adapter.cleanupWorkspace({ workspaceRef: handle.workspaceRef, reason: 'manual', idempotencyKey: 'cleanup-2', signal })
    expect(again.state).toBe('cleaned')
  })

  it('does not expire a paused recovery workspace by elapsed time', async () => {
    vi.useFakeTimers()
    const signal = new AbortController().signal
    const adapter = inMemoryDurableWorkspace()
    const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', sandboxOwner, sandboxPolicyDigest, attempt: 1, idempotencyKey: 'start', signal })
    await adapter.pauseWorkspace({ handle, sandboxPartitions, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
    vi.advanceTimersByTime(86_400_001)
    await expect(adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'resume', signal })).resolves.toMatchObject({ state: 'active' })
  })

  it('lists workspace-owned snapshots and refuses to delete a recovery pin', async () => {
    const signal = new AbortController().signal
    const adapter = inMemoryDurableWorkspace()
    const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', sandboxOwner, sandboxPolicyDigest, attempt: 1, idempotencyKey: 'start', signal })
    const checkpoint = await adapter.pauseWorkspace({ handle, sandboxPartitions, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
    await adapter.pinCheckpoint({ workspaceRef: handle.workspaceRef, checkpointRef: checkpoint.checkpointRef, runId: 'r', idempotencyKey: 'pin', signal })
    await expect(adapter.administration.list({ selector: { kind: 'owner', owner: sandboxOwner }, kind: 'snapshot' })).resolves.toMatchObject({
      items: [expect.objectContaining({ resourceId: checkpoint.checkpointRef, pinned: true })]
    })
    await expect(adapter.administration.deleteSnapshot({ owner: sandboxOwner, snapshotId: checkpoint.checkpointRef, signal })).rejects.toBeInstanceOf(SandboxConflictError)
  })
})

describe('localDirectoryWorkspace', () => {
  durableWorkspaceContract(async () => localDirectoryWorkspace({
    root: await mkdtemp(join(tmpdir(), 'purista-workspace-contract-'))
  }))
})

it('rejects workspaces without durable workspace capability', () => {
  const adapter = inMemoryDurableWorkspace()
  const invalid: DurableWorkspace = {
    ...adapter,
    info: {
      ...adapter.info,
      capabilities: ['workspace.checkpoint']
    },
    capabilities: ['workspace.checkpoint']
  }

  expect(() => validateDurableWorkspace(invalid)).toThrow(HarnessConfigError)
})

it('rejects workspaces with divergent capability declarations', () => {
  const adapter = inMemoryDurableWorkspace()
  const invalid: DurableWorkspace = {
    ...adapter,
    capabilities: [...adapter.info.capabilities, 'workspace.encrypted_storage']
  }

  expect(() => validateDurableWorkspace(invalid)).toThrow(HarnessConfigError)
})
