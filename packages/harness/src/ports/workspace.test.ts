import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HarnessConfigError } from '../errors/index.js'
import { localDirectoryWorkspaceStore } from '../local/local-workspace.js'
import { durableWorkspaceStoreContract, inMemoryDurableWorkspaceStore } from '../testing/index.js'
import type { DurableWorkspaceStore } from './workspace.js'
import { validateDurableWorkspaceStore } from './workspace.js'

describe('inMemoryDurableWorkspaceStore', () => {
  durableWorkspaceStoreContract(() => inMemoryDurableWorkspaceStore())

  afterEach(() => {
    vi.useRealTimers()
  })

  it('evicts idempotency records once a workspace is cleaned', async () => {
    const signal = new AbortController().signal
    const adapter = inMemoryDurableWorkspaceStore()
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
    const adapter = inMemoryDurableWorkspaceStore()
    const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
    await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
    vi.advanceTimersByTime(86_400_001)
    await expect(adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'resume', signal })).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'expired' }
    })
  })
})

describe('localDirectoryWorkspaceStore', () => {
  durableWorkspaceStoreContract(async () => localDirectoryWorkspaceStore({
    root: await mkdtemp(join(tmpdir(), 'purista-workspace-contract-'))
  }))
})

it('rejects workspace stores without durable workspace capability', () => {
  const adapter = inMemoryDurableWorkspaceStore()
  const invalid: DurableWorkspaceStore = {
    ...adapter,
    info: {
      ...adapter.info,
      capabilities: ['workspace_store.checkpoint']
    },
    capabilities: ['workspace_store.checkpoint']
  }

  expect(() => validateDurableWorkspaceStore(invalid)).toThrow(HarnessConfigError)
})

it('rejects workspace stores with divergent capability declarations', () => {
  const adapter = inMemoryDurableWorkspaceStore()
  const invalid: DurableWorkspaceStore = {
    ...adapter,
    capabilities: [...adapter.info.capabilities, 'workspace_store.encrypted_storage']
  }

  expect(() => validateDurableWorkspaceStore(invalid)).toThrow(HarnessConfigError)
})
