import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HarnessConfigError } from '../errors/index.js'
import { localDirectoryWorkspace } from '../local/local-workspace.js'
import { durableWorkspaceContract, inMemoryDurableWorkspace } from '../testing/index.js'
import type { DurableWorkspace } from './workspace.js'
import { validateDurableWorkspace } from './workspace.js'

describe('inMemoryDurableWorkspace', () => {
  durableWorkspaceContract(() => inMemoryDurableWorkspace())

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts idempotency records once a workspace is cleaned', async () => {
    const signal = new AbortController().signal
    const adapter = inMemoryDurableWorkspace()
    const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
    await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
    await adapter.cleanupWorkspace({ workspaceRef: handle.workspaceRef, reason: 'manual', idempotencyKey: 'cleanup', signal })

    const internals = adapter as unknown as { startKeys: Map<string, unknown>; opResults: Map<string, unknown> }
    expect(internals.startKeys.size).toBe(0)
    // Only the cleanup replay record may remain; start/pause replays are evicted.
    expect([...internals.opResults.keys()]).toEqual(['cleanup'])

    // Cleanup stays idempotent after eviction.
    const again = await adapter.cleanupWorkspace({ workspaceRef: handle.workspaceRef, reason: 'manual', idempotencyKey: 'cleanup-2', signal })
    expect(again.state).toBe('cleaned')
  })

  it('resume of an expired workspace reports expired', async () => {
    vi.useFakeTimers()
    const signal = new AbortController().signal
    const adapter = inMemoryDurableWorkspace()
    const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
    await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
    vi.advanceTimersByTime(86_400_001)
    await expect(adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'resume', signal })).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'expired' }
    })
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
