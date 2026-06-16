import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDelmSharedContextHarness, defaultDelmInput } from './harness.js'
import { evidenceForTask } from './incident-data.js'
import { formatCheckoutIncidentRun } from './scenario.js'
import { ScriptedDelmProvider } from './scripted-provider.js'
import { createSharedContextStore } from './shared-context.js'
import { createTaskQueue } from './task-queue.js'

describe('DeLM shared-context primitives', () => {
  it('admits compact entries while keeping evidence behind unfold', () => {
    const shared = createSharedContextStore()

    const result = shared.admit({
      taskId: 'logs-investigation',
      workerId: 'worker-1',
      type: 'FACT',
      summary: 'Checkout API logs show payment authorization timeouts.',
      evidence: [{
        summary: 'Located checkout timeout errors.',
        detail: 'Detailed evidence should not appear in the compact digest.',
        verified: true,
        source: 'unit-test'
      }]
    })

    expect(result.accepted).toBe(true)
    const digest = shared.renderDigest()
    expect(digest).toContain('Checkout API logs')
    expect(digest).not.toContain('Detailed evidence should not appear')

    const unfolded = shared.unfold(result.entry?.id ?? '')
    expect(unfolded?.evidence[0]?.detail).toContain('Detailed evidence')
  })

  it('rejects unverified patch summaries and expires coordination claims', () => {
    let now = new Date('2026-06-16T10:00:00.000Z')
    const shared = createSharedContextStore({ now: () => now, claimTtlMs: 10 })

    const rejected = shared.admit({
      taskId: 'rollback-proposal',
      workerId: 'worker-2',
      type: 'PATCH_SUMMARY',
      summary: 'Rollback probably helps.',
      evidence: [{ summary: 'Pending check.', detail: 'No verification was run.', verified: false }]
    })

    expect(rejected.accepted).toBe(false)
    expect(rejected.rejection?.reason).toBe('patch_summary_requires_verified_evidence')

    shared.admit({
      taskId: 'claim-target',
      workerId: 'worker-1',
      type: 'CLAIM',
      summary: 'worker-1 is checking EU checkout metrics.',
      evidence: []
    })
    expect(shared.renderDigest()).toContain('checking EU checkout metrics')
    now = new Date('2026-06-16T10:00:00.011Z')
    expect(shared.renderDigest()).not.toContain('checking EU checkout metrics')
  })

  it('claims tasks once and waits for dependencies', () => {
    const queue = createTaskQueue([
      { id: 'logs', objective: 'Inspect checkout logs.', dependsOn: [] },
      { id: 'timeout', objective: 'Verify timeout mitigation after logs are known.', dependsOn: ['logs'] }
    ])

    const first = queue.claim('worker-1')
    expect(first?.id).toBe('logs')
    expect(queue.claim('worker-2')).toBeUndefined()

    queue.complete('logs', 'worker-1')
    const second = queue.claim('worker-2')
    expect(second?.id).toBe('timeout')
    queue.complete('timeout', 'worker-2')
    expect(queue.snapshot().map((item) => item.status)).toEqual(['completed', 'completed'])
  })
})

describe('DeLM shared-context harness example', () => {
  it('runs parallel worker rounds with admission, rejection, and checkpoints', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'purista-delm-test-'))
    const provider = new ScriptedDelmProvider()
    const example = createDelmSharedContextHarness({ provider, storageRoot })

    try {
      const session = await example.harness.getSession('delm-test')
      const result = await session.workflows.decentralized_research.prompt(defaultDelmInput(), {
        durable: { runId: 'delm-test-run' }
      })

      expect(result.admittedEntries.map((entry) => entry.type)).toEqual(['FACT', 'OBSERVED', 'PATCH_SUMMARY'])
      expect(result.rejectedReports).toEqual([{
        workerId: 'worker-1',
        taskId: 'rollback-proposal',
        reason: 'patch_summary_requires_verified_evidence'
      }])
      expect(result.queue.every((item) => item.status === 'completed')).toBe(true)
      expect(result.answer).toContain('payment authorization timeout')
      expect(result.answer).toContain('1500ms')
      expect(result.checkpointCount).toBe(1)
      expect(provider.requests).toHaveLength(4)
      expect(JSON.stringify(provider.requests[0]?.messages)).toContain('payment_authorization_timeout')
      expect(evidenceForTask('timeout-fix').records.map((record) => record.id)).toEqual(
        expect.arrayContaining(['repro-001', 'repro-002', 'repro-003', 'repro-004'])
      )

      const report = formatCheckoutIncidentRun(result)
      expect(report).toContain('Checkout Incident Investigation')
      expect(report).toContain('Rejected reports:')
      expect(report).toContain('rollback-proposal')
    } finally {
      await example.close()
      rmSync(storageRoot, { recursive: true, force: true })
    }
  })
})
