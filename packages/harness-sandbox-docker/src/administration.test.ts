import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OperationCancelledError,
  ValidationError,
  type HarnessAdapterContext,
  type SandboxOwner,
  type SpanAttrs,
  type TelemetryShim
} from '@purista/harness'
import { DockerAdministration } from './administration.js'
import { DockerOwnershipJournal } from './ownership.js'
import { Records } from './records.js'

const roots: string[] = []
const owner = {
  namespace: 'acme', id: 'workspace-a', instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J', identity: { tenantId: 'tenant-a', principalId: 'principal-a' },
} satisfies SandboxOwner

function recordingTelemetry() {
  const spans: Array<{ name: string; attrs: SpanAttrs }> = []
  const metrics: Array<{ name: string; attrs: SpanAttrs }> = []
  const telemetry: TelemetryShim = {
    async span(name, attrs, action) {
      const entry = { name, attrs: { ...attrs } }
      spans.push(entry)
      return await action({ setAttributes: (next: SpanAttrs) => Object.assign(entry.attrs, next) } as never)
    },
    recordHistogram(name, _value, attrs) { metrics.push({ name, attrs: { ...attrs } }) },
    recordCounter(name, _value, attrs) { metrics.push({ name, attrs: { ...attrs } }) },
    currentTraceparent: () => undefined,
  }
  return { spans, metrics, telemetry }
}

function resource(resourceId: string, journal: DockerOwnershipJournal) {
  return {
    summary: {
      resourceId, kind: 'sandbox' as const, owner,
      scope: { owner, partition: { kind: 'shared' as const }, lifetime: 'session' as const },
      state: 'provisioning' as const, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z', pinned: false,
    },
    label: journal.labelFor(owner), containerName: `${resourceId}-container`, volumeName: `${resourceId}-volume`,
  }
}

async function fixture(root?: string) {
  const metadataRoot = root ?? await mkdtemp(join(tmpdir(), 'purista-docker-administration-'))
  if (root === undefined) roots.push(metadataRoot)
  const journal = new DockerOwnershipJournal(new Records(metadataRoot))
  await journal.registerOwner({ owner, mode: 'create' })
  const calls: string[] = []
  const driver = {
    stopContainer: async (name: string) => { calls.push(`stop:${name}`) },
    removeContainer: async (name: string) => { calls.push(`remove-container:${name}`) },
    removeVolume: async (name: string) => { calls.push(`remove-volume:${name}`) },
  }
  return { root: metadataRoot, journal, calls, administration: new DockerAdministration(journal, driver) }
}

describe('DockerAdministration', () => {
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  it('stops a known owner resource before removing its container and volume without exposing engine references', async () => {
    const { journal, calls, administration } = await fixture()
    await journal.trackResource(resource('sandbox-1', journal)); await journal.markActive('sandbox-1')
    const page = await administration.list({ selector: { kind: 'owner', owner } })
    expect(page.items).toEqual([expect.objectContaining({ resourceId: 'sandbox-1', owner })])
    expect(JSON.stringify(page)).not.toContain('sandbox-1-container')
    expect(JSON.stringify(page)).not.toContain('sandbox-1-volume')
    await expect(administration.purge({ selector: { kind: 'owner', owner }, idempotencyKey: 'purge-1' })).resolves.toEqual({ state: 'completed', deletedResources: 1, remainingResources: 0 })
    expect(calls).toEqual(['stop:sandbox-1-container', 'remove-container:sandbox-1-container', 'remove-volume:sandbox-1-volume'])
  })

  it('continues the same bounded purge after restart without repeating confirmed deletion', async () => {
    const first = await fixture()
    await first.journal.trackResource(resource('sandbox-1', first.journal)); await first.journal.markActive('sandbox-1')
    await first.journal.trackResource(resource('sandbox-2', first.journal)); await first.journal.markActive('sandbox-2')
    const failing = new DockerAdministration(first.journal, {
      stopContainer: async (name: string) => { first.calls.push(`stop:${name}`) },
      removeContainer: async (name: string) => { first.calls.push(`remove-container:${name}`) },
      removeVolume: async (name: string) => { first.calls.push(`remove-volume:${name}`); if (name === 'sandbox-2-volume') throw new Error('private engine failure') },
    })
    await expect(failing.purge({ selector: { kind: 'owner', owner }, idempotencyKey: 'purge-1', limit: 2 })).resolves.toEqual({ state: 'cleanup_pending', deletedResources: 1, remainingResources: 1, retryAfterMs: 1_000 })

    const resumedJournal = new DockerOwnershipJournal(new Records(first.root))
    const resumedCalls: string[] = []
    const resumed = new DockerAdministration(resumedJournal, {
      stopContainer: async name => { resumedCalls.push(`stop:${name}`) },
      removeContainer: async name => { resumedCalls.push(`remove-container:${name}`) },
      removeVolume: async name => { resumedCalls.push(`remove-volume:${name}`) },
    })
    await expect(resumed.purge({ selector: { kind: 'owner', owner }, idempotencyKey: 'purge-1', limit: 2 })).resolves.toEqual({ state: 'completed', deletedResources: 2, remainingResources: 0 })
    expect(resumedCalls).toEqual(['remove-volume:sandbox-2-volume'])
  })

  it('holds one durable cleanup claim so overlapping operators cannot repeat engine effects', async () => {
    const { journal } = await fixture()
    await journal.trackResource(resource('sandbox-1', journal)); await journal.markActive('sandbox-1')
    let allowStop!: () => void
    const stopStarted = new Promise<void>(resolve => { allowStop = resolve })
    let stopEntered!: () => void
    const entered = new Promise<void>(resolve => { stopEntered = resolve })
    const firstCalls: string[] = []
    const first = new DockerAdministration(journal, {
      stopContainer: async name => { firstCalls.push(`stop:${name}`); stopEntered(); await stopStarted },
      removeContainer: async name => { firstCalls.push(`remove-container:${name}`) },
      removeVolume: async name => { firstCalls.push(`remove-volume:${name}`) },
    })
    const secondCalls: string[] = []
    const second = new DockerAdministration(journal, {
      stopContainer: async name => { secondCalls.push(`stop:${name}`) },
      removeContainer: async name => { secondCalls.push(`remove-container:${name}`) },
      removeVolume: async name => { secondCalls.push(`remove-volume:${name}`) },
    })
    const firstPurge = first.purge({ selector: { kind: 'owner', owner }, idempotencyKey: 'purge-1' })
    await entered
    await expect(second.purge({ selector: { kind: 'owner', owner }, idempotencyKey: 'purge-1' })).resolves.toEqual({ state: 'cleanup_pending', deletedResources: 0, remainingResources: 1, retryAfterMs: 1_000 })
    expect(secondCalls).toEqual([])
    allowStop()
    await expect(firstPurge).resolves.toEqual({ state: 'completed', deletedResources: 1, remainingResources: 0 })
    expect(firstCalls).toEqual(['stop:sandbox-1-container', 'remove-container:sandbox-1-container', 'remove-volume:sandbox-1-volume'])
  })

  it('returns cleanup pending after a committed barrier is cancelled and preserves private refs', async () => {
    const { journal, calls } = await fixture()
    await journal.trackResource(resource('sandbox-1', journal)); await journal.markActive('sandbox-1')
    const controller = new AbortController()
    const administration = new DockerAdministration(journal, {
      stopContainer: async name => { calls.push(`stop:${name}`); controller.abort() },
      removeContainer: async name => { calls.push(`remove-container:${name}`) },
      removeVolume: async name => { calls.push(`remove-volume:${name}`) },
    })
    await expect(administration.purge({ selector: { kind: 'owner', owner }, idempotencyKey: 'purge-1', signal: controller.signal })).resolves.toEqual({ state: 'cleanup_pending', deletedResources: 0, remainingResources: 1, retryAfterMs: 1_000 })
    await expect(journal.resource('sandbox-1')).resolves.toMatchObject({ summary: { state: 'cleanup_pending' }, containerName: 'sandbox-1-container', volumeName: 'sandbox-1-volume' })
    expect(calls).toEqual(['stop:sandbox-1-container'])
    await expect(journal.assertAttachment(owner)).rejects.toBeInstanceOf(Error)
  })

  it('rejects cancellation before a selector barrier is committed', async () => {
    const { journal, administration } = await fixture()
    await journal.trackResource(resource('sandbox-1', journal))
    await expect(administration.purge({ selector: { kind: 'owner', owner }, idempotencyKey: 'purge-1', signal: AbortSignal.abort() })).rejects.toBeInstanceOf(OperationCancelledError)
    await expect(journal.assertAttachment(owner)).resolves.toBeUndefined()
  })

  it('binds opaque list cursors to the exact selector and rejects a mismatched cursor', async () => {
    const { journal, administration } = await fixture()
    for (const resourceId of ['sandbox-1', 'sandbox-2']) await journal.trackResource(resource(resourceId, journal))
    const first = await administration.list({ selector: { kind: 'owner', owner }, limit: 1 })
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeDefined(); expect(first.nextCursor).not.toContain('sandbox-1')
    await expect(administration.list({ selector: { kind: 'owner', owner }, cursor: first.nextCursor })).resolves.toMatchObject({ items: [expect.objectContaining({ resourceId: 'sandbox-2' })] })
    await expect(administration.list({ selector: { kind: 'tenant', namespace: 'acme', tenantId: 'tenant-a' }, cursor: first.nextCursor })).rejects.toBeInstanceOf(ValidationError)
    await expect(administration.list({ selector: { kind: 'owner', owner }, kind: 'sandbox', cursor: first.nextCursor })).rejects.toBeInstanceOf(ValidationError)
  })

  it('validates a no-op snapshot delete request before accepting it', async () => {
    const { administration } = await fixture()
    await expect(administration.deleteSnapshot({ owner, snapshotId: '' } as never)).rejects.toBeInstanceOf(ValidationError)
  })

  it('emits redacted standard telemetry for public administration operations', async () => {
    const { administration } = await fixture()
    const recorded = recordingTelemetry()
    administration.configureHarnessContext({ telemetry: recorded.telemetry } as HarnessAdapterContext)

    await administration.list({ selector: { kind: 'owner', owner } })

    expect(recorded.spans).toEqual([expect.objectContaining({
      name: 'harness.sandbox.list',
      attrs: expect.objectContaining({
        'harness.sandbox.adapter': 'docker',
        'harness.sandbox.operation': 'list',
        'harness.sandbox.outcome': 'success'
      })
    })])
    expect(recorded.metrics.map(metric => metric.name)).toEqual([
      'harness.sandbox.operations', 'harness.sandbox.operation.duration'
    ])
    expect(JSON.stringify(recorded)).not.toContain('tenant-a')
    expect(JSON.stringify(recorded)).not.toContain('workspace-a')
  })
})
