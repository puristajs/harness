import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { StateError } from '../errors/index.js'
import type { Message, PersistedFinalRunEvent, PersistedFinalRunFinishedPayload, PersistedRunEvent, SessionRecord } from '../models/state.js'
import { canonicalJson } from '../runtime/canonical-json.js'
import type { AcquireRunRequest, CreateRunRequest, FinalizeRunRequest, HarnessStorage, ReplaceCheckpointRequest } from '../storage/types.js'

const session: SessionRecord = {
  id: 'session_1',
  instanceId: '01J00000000000000000000001',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  runCount: 0,
  sandboxBinding: {
    owner: { namespace: 'harness', id: 'session_1', instanceId: '01J00000000000000000000001' },
    relation: 'owned',
    registration: 'pending',
    policyDigest: 'a'.repeat(64),
    disposed: false
  }
}

const pendingSandboxBinding = {
  owner: {
    namespace: 'harness',
    id: session.id,
    instanceId: session.instanceId
  },
  relation: 'owned' as const,
  registration: 'pending' as const,
  policyDigest: 'a'.repeat(64),
  disposed: false
}

const messages: Message[] = [
  { id: '01A', sessionId: session.id, role: 'user', content: 'a', timestamp: '2026-01-01T00:00:00.000Z' },
  { id: '01B', sessionId: session.id, role: 'assistant', content: 'b', timestamp: '2026-01-01T00:00:01.000Z' },
  { id: '01C', sessionId: session.id, role: 'assistant', content: 'c', timestamp: '2026-01-01T00:00:02.000Z' }
]
const [m1, m2, m3] = messages

const run: CreateRunRequest = {
  id: 'run_1',
  sessionId: session.id,
  kind: 'workflow',
  target: 'wf',
  startedAt: '2026-01-01T00:00:00.000Z',
  input: null
}

const event: PersistedRunEvent = {
  id: eventId(run.id, 1, 'run.started'),
  runId: run.id,
  sequence: 1,
  at: '2026-01-01T00:00:00.000Z',
  type: 'run.started',
  payload: { ok: true }
}

function eventId(runId: string, sequence: number, type: PersistedRunEvent['type']): string {
  return `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', runId, sequence, type])).digest('hex')}`
}

function terminalEvent(
  runId: string,
  sequence: number,
  at: string,
  outcome: Readonly<{ status: 'completed' }>
    | Readonly<{ status: 'failed' | 'cancelled'; error: import('../models/state.js').SerializedError }>,
  parent?: Readonly<{ parentRunId: string; parentInvocationId: string }>,
): PersistedFinalRunEvent {
  const type = 'run.finished' as const
  const id = eventId(runId, sequence, type)
  const payload = JSON.parse(canonicalJson({ ...parent, outcome })) as PersistedFinalRunFinishedPayload
  return Object.freeze({ id, sequence, runId, at, type, payload })
}

async function acquisition(
  store: HarnessStorage,
  args: { runId: string; sessionId: string; workerId: string; stepId: string; requestedAttempt?: number },
): Promise<AcquireRunRequest> {
  const current = await store.getRun(args.runId)
  if (!current) throw new Error('Test run is missing.')
  const checkpoint = await store.loadCheckpoint(args.runId, args.stepId)
  const mode = current.revision === 1 && current.attempt === undefined ? 'initial' as const : 'resume' as const
  const expected = Object.freeze({
    revision: current.revision,
    status: current.status as 'running' | 'waiting' | 'interrupted',
    checkpoint: Object.freeze({ stepId: args.stepId, sequence: checkpoint?.sequence ?? null }),
  })
  const tuple = [
    'harness-run-acquisition-v1', mode, args.runId, args.sessionId, args.workerId,
    expected.revision, expected.status, args.stepId, expected.checkpoint.sequence,
    args.requestedAttempt ?? null,
  ] as const
  return Object.freeze({
    mode, runId: args.runId, sessionId: args.sessionId, workerId: args.workerId,
    acquisitionId: `acq_${createHash('sha256').update(canonicalJson(tuple)).digest('hex')}`,
    expected,
    ...(args.requestedAttempt === undefined ? {} : { requestedAttempt: args.requestedAttempt }),
  })
}

export function harnessStorageContract(make: () => HarnessStorage | Promise<HarnessStorage>): void {
  describe('harnessStorageContract', () => {
    it('getSession returns undefined for unknown id', async () => {
      const store = await make()
      await expect(store.getSession('missing')).resolves.toBeUndefined()
    })

    it('upsertSession and getSession round-trip', async () => {
      const store = await make()
      await expect(store.upsertSession(session, 'create')).resolves.toBe(true)
      await expect(store.getSession(session.id)).resolves.toEqual(session)
    })

    it('selects one insertion winner even when concurrent creation timestamps match', async () => {
      const store = await make()
      const results = await Promise.all([store.upsertSession(session, 'create'), store.upsertSession(session, 'create')])
      expect(results.filter(Boolean)).toHaveLength(1)
      await expect(store.getSession(session.id)).resolves.toEqual(session)
    })

    it('keeps creation identity immutable and rejects conflicting optional dimensions', async () => {
      const store = await make()
      const bound = { ...session, identity: { tenantId: 'tenant', principalId: 'principal' } }
      await store.upsertSession(bound, 'create')
      for (const identity of [undefined, { tenantId: 'other', principalId: 'principal' }, { tenantId: 'tenant' }, { principalId: 'principal' }]) {
        await expect(store.upsertSession({ ...session, ...(identity ? { identity } : {}) }, 'create')).rejects.toMatchObject({
          code: 'STATE_ERROR', meta: { op: 'upsertSession', reason: 'session_identity_mismatch' }
        })
      }
      await expect(store.getSession(session.id)).resolves.toEqual(bound)
    })

    it('allows only the owned sandbox-binding acknowledgement and disposal transitions', async () => {
      const store = await make()
      const pending = { ...session, sandboxBinding: pendingSandboxBinding }
      await store.upsertSession(pending, 'create')

      const registered = {
        ...pending,
        updatedAt: '2026-01-01T00:00:01.000Z',
        sandboxBinding: { ...pendingSandboxBinding, registration: 'registered' as const }
      }
      await expect(store.upsertSession(registered, 'update')).resolves.toBe(false)

      const disposed = {
        ...registered,
        updatedAt: '2026-01-01T00:00:02.000Z',
        sandboxBinding: { ...registered.sandboxBinding, disposed: true }
      }
      await expect(store.upsertSession(disposed, 'update')).resolves.toBe(false)
      await expect(store.upsertSession({
        ...disposed,
        updatedAt: '2026-01-01T00:00:03.000Z',
        sandboxBinding: { ...disposed.sandboxBinding, owner: { ...disposed.sandboxBinding.owner, id: 'other' } }
      }, 'update')).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { op: 'upsertSession', reason: 'session_sandbox_binding_mismatch' }
      })
      await expect(store.upsertSession({
        ...disposed,
        updatedAt: '2026-01-01T00:00:03.000Z',
        sandboxBinding: { ...disposed.sandboxBinding, disposed: false }
      }, 'update')).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { op: 'upsertSession', reason: 'session_sandbox_binding_mismatch' }
      })
    })

    it('updates mutable fields without letting competing creation reset the winning record', async () => {
      const store = await make()
      await store.upsertSession(session, 'create')
      const updated = { ...session, updatedAt: '2026-01-01T00:00:10.000Z', runCount: 2, metadata: { retained: true } }
      await expect(store.upsertSession(updated, 'update')).resolves.toBe(false)
      await expect(store.upsertSession({ ...session, instanceId: 'competing-instance' }, 'create')).resolves.toBe(false)
      await expect(store.upsertSession({ ...session, createdAt: '2026-01-01T00:00:01.000Z' }, 'create')).resolves.toBe(false)
      await expect(store.upsertSession(session, 'update')).resolves.toBe(false)
      await expect(store.getSession(session.id)).resolves.toEqual(updated)
    })

    it('does not expose mutable references to persisted session identity', async () => {
      const store = await make()
      const proposed = { ...session, identity: { tenantId: 'tenant' } }
      await store.upsertSession(proposed, 'create')
      proposed.identity.tenantId = 'changed-through-input'
      const read = await store.getSession(session.id)
      if (read) read.createdAt = 'changed-through-read'
      await expect(store.getSession(session.id)).resolves.toEqual({ ...session, identity: { tenantId: 'tenant' } })
    })

    it('keeps a newly recreated session and its history when an old instance closes', async () => {
      const store = await make()
      await store.upsertSession(session, 'create')
      await store.closeSession(session.id, session.instanceId)
      const recreated = { ...session, instanceId: 'session-instance-2' }
      await store.upsertSession(recreated, 'create')
      await store.appendMessages(session.id, messages)
      await store.closeSession(session.id, session.instanceId)
      await expect(store.getSession(session.id)).resolves.toEqual(recreated)
      await expect(store.listMessages(session.id)).resolves.toEqual(messages)
      await store.closeSession(session.id, recreated.instanceId)
      await expect(store.getSession(session.id)).resolves.toBeUndefined()
      await expect(store.listMessages(session.id)).resolves.toEqual([])
    })

    it('never resurrects a closed record through a late summary update', async () => {
      const store = await make()
      await store.upsertSession(session, 'create')
      await store.closeSession(session.id, session.instanceId)
      const late = { ...session, updatedAt: '2026-01-01T00:00:10.000Z', runCount: 1 }
      await expect(store.upsertSession(late, 'update')).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { reason: 'session_instance_mismatch' }
      })
      await expect(store.getSession(session.id)).resolves.toBeUndefined()
      const fresh = { ...session, instanceId: 'new-instance' }
      await store.upsertSession(fresh, 'create')
      await expect(store.upsertSession(late, 'update')).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { reason: 'session_instance_mismatch' }
      })
      await expect(store.getSession(session.id)).resolves.toEqual(fresh)
    })

    it('never mutates an existing record through repeated creation', async () => {
      const store = await make()
      await store.upsertSession(session, 'create')
      await expect(store.upsertSession({ ...session, runCount: 3, metadata: { unexpected: true } }, 'create')).resolves.toBe(false)
      await expect(store.getSession(session.id)).resolves.toEqual(session)
      await expect(store.upsertSession({ ...session, createdAt: '2026-01-01T00:00:01.000Z' }, 'update')).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { reason: 'session_instance_mismatch' }
      })
      await expect(store.getSession(session.id)).resolves.toEqual(session)
    })

    it('appendMessages preserves order across calls', async () => {
      const store = await make()
      await store.appendMessages(session.id, [m1 as Message])
      await store.appendMessages(session.id, [m2 as Message, m3 as Message])
      await expect(store.listMessages(session.id)).resolves.toEqual(messages)
    })

    it('listMessages honors limit and before cursor', async () => {
      const store = await make()
      await store.appendMessages(session.id, messages)
      await expect(store.listMessages(session.id, { limit: 2 })).resolves.toEqual([m2, m3])
      await expect(store.listMessages(session.id, { before: '01C' })).resolves.toEqual([m1, m2])
    })

    it('clearMessages removes all messages', async () => {
      const store = await make()
      await store.appendMessages(session.id, messages)
      await store.clearMessages(session.id)
      await expect(store.listMessages(session.id)).resolves.toEqual([])
    })

    it('createRun and getRun round-trip', async () => {
      const store = await make()
      await expect(store.createRun(run)).resolves.toEqual({ ...run, status: 'running', revision: 1 })
      await expect(store.getRun(run.id)).resolves.toEqual({ ...run, status: 'running', revision: 1 })
    })

    it('creates every run kind as a recursively frozen authoritative record', async () => {
      const store = await make()
      for (const [index, kind] of (['agent', 'workflow', 'child_task'] as const).entries()) {
        const request: CreateRunRequest = {
          ...run,
          id: `kind-${index}`,
          kind,
          input: { nested: [kind] },
          metadata: { owner: { index } },
        }
        const created = await store.createRun(request)
        expect(created).toMatchObject({ ...request, status: 'running', revision: 1 })
        expect(Object.isFrozen(created)).toBe(true)
        expect(Object.isFrozen(created.input)).toBe(true)
        expect(Object.isFrozen(created.metadata)).toBe(true)
        expect(Object.isFrozen(created.metadata?.['owner'])).toBe(true)
      }
    })

    it('rejects storage-authored and unknown create fields', async () => {
      const store = await make()
      for (const field of ['status', 'revision', 'finishedAt', 'output', 'error', 'approvalReceipt', 'attempt', 'workerId', 'initialStepId', 'unknown']) {
        await expect(store.createRun({ ...run, [field]: field === 'revision' || field === 'attempt' ? 1 : 'invalid' } as unknown as CreateRunRequest))
          .rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' } })
        await expect(store.getRun(run.id)).resolves.toBeUndefined()
      }
    })

    it('rejects undefined and non-canonical creation values without mutation', async () => {
      const store = await make()
      const sparse: unknown[] = []
      sparse.length = 1
      const invalid = [
        { ...run, input: undefined },
        { ...run, metadata: undefined },
        { ...run, input: Number.NaN },
        { ...run, input: sparse },
        { ...run, input: Object.assign(Object.create({ inherited: true }), { own: true }) },
      ]
      for (const request of invalid) {
        await expect(store.createRun(request as unknown as CreateRunRequest)).rejects.toMatchObject({
          code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' },
        })
        await expect(store.getRun(run.id)).resolves.toBeUndefined()
      }
    })

    it('rejects changed immutable creation identity before acquisition', async () => {
      const store = await make()
      for (const [index, kind] of (['agent', 'workflow'] as const).entries()) {
        const request: CreateRunRequest = {
          ...run,
          id: `immutable-run-${index}`,
          kind,
          target: `${kind}-target`,
          input: { prompt: 'original' },
          metadata: { source: 'original' },
        }
        const created = await store.createRun(request)
        const conflicts: CreateRunRequest[] = [
          { ...request, sessionId: 'other-session' },
          { ...request, kind: kind === 'agent' ? 'workflow' : 'agent' },
          { ...request, target: 'other-target' },
          { ...request, startedAt: '2026-01-01T00:00:01.000Z' },
          { ...request, input: { prompt: 'changed' } },
          { ...request, metadata: { source: 'changed' } },
        ]
        for (const conflict of conflicts) {
          await expect(store.createRun(conflict)).rejects.toMatchObject({
            code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' },
          })
          await expect(store.getRun(request.id)).resolves.toEqual(created)
        }
      }
    })

    it('finishRun updates patch fields only', async () => {
      const store = await make()
      await store.createRun(run)
      await store.finishRun(run.id, {
        status: 'succeeded',
        finishedAt: '2026-01-01T00:00:03.000Z',
        output: { ok: true }
      })
      await expect(store.getRun(run.id)).resolves.toMatchObject({
        id: run.id,
        status: 'succeeded',
        finishedAt: '2026-01-01T00:00:03.000Z',
        output: { ok: true }
      })
    })

    it('listRuns sorted descending by startedAt then id', async () => {
      const store = await make()
      await store.createRun(run)
      await store.createRun({ ...run, id: 'run_2', startedAt: '2026-01-01T00:00:05.000Z' })
      await store.createRun({ ...run, id: 'run_3', startedAt: '2026-01-01T00:00:05.000Z' })
      await expect(store.listRuns(session.id)).resolves.toEqual([
        expect.objectContaining({ id: 'run_3' }),
        expect.objectContaining({ id: 'run_2' }),
        expect.objectContaining({ id: 'run_1' })
      ])
    })

    it('appendEvents and listEvents round-trip with after cursor', async () => {
      const store = await make()
      const second = { ...event, id: eventId(run.id, 2, 'run.started'), sequence: 2, payload: { ok: 2 } }
      await store.appendEvents(run.id, [event, second])
      await expect(store.listEvents(run.id)).resolves.toHaveLength(2)
      await expect(store.listEvents(run.id, { after: event.id })).resolves.toEqual([
        expect.objectContaining({ id: second.id })
      ])
    })

    it('requires incoming event batches to be strictly increasing and atomic', async () => {
      const store = await make()
      const second = { ...event, id: eventId(run.id, 2, 'run.started'), sequence: 2, payload: { ok: 2 } }
      const third = { ...event, id: eventId(run.id, 3, 'run.started'), sequence: 3, payload: { ok: 3 } }
      await store.appendEvents(run.id, [event])
      await store.appendEvents(run.id, [event, second])
      await expect(store.listEvents(run.id)).resolves.toEqual([event, second])

      for (const batch of [[third, second], [third, third]]) {
        await expect(store.appendEvents(run.id, batch)).rejects.toMatchObject({
          code: 'STATE_ERROR', meta: { op: 'appendEvents', reason: 'event_sequence_conflict' },
        })
        await expect(store.listEvents(run.id)).resolves.toEqual([event, second])
      }
      const gap = { ...event, id: eventId(run.id, 4, 'run.started'), sequence: 4, payload: { ok: 4 } }
      await expect(store.appendEvents(run.id, [gap])).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { op: 'appendEvents', reason: 'event_sequence_conflict' },
      })
      await expect(store.listEvents(run.id)).resolves.toEqual([event, second])
    })

    it('replaceMessages atomically replaces the history when supported', async () => {
      const store = await make()
      if (!store.replaceMessages) return
      await store.appendMessages(session.id, [m1 as Message])
      await store.replaceMessages(session.id, [m2 as Message, m3 as Message])
      await expect(store.listMessages(session.id)).resolves.toEqual([m2, m3])
    })

    it('getRun returns undefined for an unknown id', async () => {
      const store = await make()
      await expect(store.getRun('missing')).resolves.toBeUndefined()
    })

    it('listRuns honors limit', async () => {
      const store = await make()
      await store.createRun(run)
      await store.createRun({ ...run, id: 'run_2', startedAt: '2026-01-01T00:00:05.000Z' })
      await expect(store.listRuns(session.id, { limit: 1 })).resolves.toEqual([
        expect.objectContaining({ id: 'run_2' })
      ])
    })

    it('listEvents honors limit', async () => {
      const store = await make()
      await store.appendEvents(run.id, [event, { ...event, id: eventId(run.id, 2, event.type), sequence: 2 }])
      await expect(store.listEvents(run.id, { limit: 1 })).resolves.toEqual([
        expect.objectContaining({ id: event.id })
      ])
    })

    it('duplicate message id throws StateError', async () => {
      const store = await make()
      await store.appendMessages(session.id, [m1 as Message])
      await expect(store.appendMessages(session.id, [m1 as Message])).rejects.toBeInstanceOf(StateError)
    })

    it('duplicate message ids in the same append batch throw StateError', async () => {
      const store = await make()
      await expect(store.appendMessages(session.id, [m1 as Message, { ...(m1 as Message) }])).rejects.toBeInstanceOf(StateError)
      await expect(store.listMessages(session.id)).resolves.toEqual([])
    })

    it('uses the authoritative run record for durable attempts and interruption', async () => {
      const store = await make()
      await store.createRun(run)
      const first = await store.acquireRun(await acquisition(store, {
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-1', stepId: 'prepare'
      }))
      expect(first.attempt).toBe(1)
      await first.release()
      await expect(store.getRun(run.id)).resolves.toMatchObject({ status: 'interrupted', attempt: 1 })

      const second = await store.acquireRun(await acquisition(store, {
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-2', stepId: 'prepare'
      }))
      expect(second.attempt).toBe(2)
      await second.release()
      await expect(store.finishRun(run.id, { status: 'succeeded', output: { ok: true } })).rejects.toMatchObject({
        code: 'STATE_ERROR',
        meta: { op: 'finishRun', reason: 'active_lease_requires_finalize' },
      })
      await expect(store.getRun(run.id)).resolves.toMatchObject({ status: 'interrupted', attempt: 2 })
    })

    it('reports missing runs and competing leases with canonical acquisition errors', async () => {
      const store = await make()
      const missingExpected = Object.freeze({
        revision: 1,
        status: 'running' as const,
        checkpoint: Object.freeze({ stepId: 'start', sequence: null }),
      })
      const missingId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'initial', 'missing-run', session.id, 'worker',
        1, 'running', 'start', null, null,
      ])).digest('hex')}`
      await expect(store.acquireRun({
        mode: 'initial', runId: 'missing-run', sessionId: session.id, workerId: 'worker',
        acquisitionId: missingId, expected: missingExpected,
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'run_not_found' } })

      const created = await store.createRun(run)
      await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'same-worker', stepId: 'start',
      }))
      const current = await store.getRun(created.id)
      expect(current).toBeDefined()
      const competingExpected = Object.freeze({
        revision: current!.revision,
        status: current!.status as 'running',
        checkpoint: Object.freeze({ stepId: 'start', sequence: null }),
      })
      const competingId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'resume', created.id, created.sessionId, 'same-worker',
        current!.revision, current!.status, 'start', null, null,
      ])).digest('hex')}`
      await expect(store.acquireRun({
        mode: 'resume', runId: created.id, sessionId: created.sessionId, workerId: 'same-worker',
        acquisitionId: competingId, expected: competingExpected,
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'lease_conflict' } })
    })

    it('rejects resume mode for a pristine never-acquired run', async () => {
      const store = await make()
      const created = await store.createRun(run)
      const expected = Object.freeze({
        revision: created.revision,
        status: created.status as 'running',
        checkpoint: Object.freeze({ stepId: 'start', sequence: null }),
      })
      const acquisitionId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'resume', created.id, created.sessionId, 'worker',
        created.revision, created.status, 'start', null, null,
      ])).digest('hex')}`
      await expect(store.acquireRun({
        mode: 'resume', runId: created.id, sessionId: created.sessionId, workerId: 'worker',
        acquisitionId, expected,
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'acquisition_conflict' } })
      await expect(store.getRun(created.id)).resolves.toEqual(created)
    })

    it('rejects an explicitly undefined requested attempt without mutation', async () => {
      const store = await make()
      const created = await store.createRun(run)
      const expected = Object.freeze({
        revision: created.revision,
        status: created.status as 'running',
        checkpoint: Object.freeze({ stepId: 'start', sequence: null }),
      })
      const acquisitionId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'initial', created.id, created.sessionId, 'worker',
        created.revision, created.status, 'start', null, null,
      ])).digest('hex')}`
      await expect(store.acquireRun({
        mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'worker',
        acquisitionId, expected, requestedAttempt: undefined,
      } as unknown as AcquireRunRequest)).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'acquisition_conflict' },
      })
      await expect(store.getRun(created.id)).resolves.toEqual(created)
    })

    it('replays an exact acquisition response without changing ownership or revision', async () => {
      const store = await make()
      const created = await store.createRun({ ...run, input: { root: true } })
      const request = await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker', stepId: 'start', requestedAttempt: 7,
      })
      const first = await store.acquireRun(request)
      const retry = await store.acquireRun(request)
      expect(retry).toMatchObject({
        runId: first.runId,
        sessionId: first.sessionId,
        workerId: first.workerId,
        acquisitionId: first.acquisitionId,
        leaseId: first.leaseId,
        attempt: 7,
        resumed: false,
        acquiredFrom: first.acquiredFrom,
        run: first.run,
        checkpoints: [],
      })
      expect(Object.isFrozen(retry)).toBe(true)
      expect(Object.isFrozen(retry.run)).toBe(true)
      expect(Object.isFrozen(retry.acquiredFrom)).toBe(true)
      expect(Object.isFrozen(retry.checkpoints)).toBe(true)
      await expect(store.getRun(created.id)).resolves.toEqual(first.run)
      await expect(store.createRun({ ...run, input: { root: true } })).resolves.toEqual(first.run)
    })

    it('rejects changed acquisition bytes and serializes leases across a session', async () => {
      const store = await make()
      const firstRun = await store.createRun(run)
      const firstRequest = await acquisition(store, {
        runId: firstRun.id, sessionId: firstRun.sessionId, workerId: 'worker', stepId: 'start',
      })
      await store.acquireRun(firstRequest)
      await expect(store.acquireRun({ ...firstRequest, requestedAttempt: 2 })).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'acquisition_conflict' },
      })

      const secondRun = await store.createRun({ ...run, id: 'run_2' })
      await expect(store.acquireRun(await acquisition(store, {
        runId: secondRun.id, sessionId: secondRun.sessionId, workerId: 'other-worker', stepId: 'start',
      }))).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'lease_conflict' } })
      await expect(store.getRun(secondRun.id)).resolves.toEqual(secondRun)
    })

    it('rejects stale record revision and selected-checkpoint expectations without mutation', async () => {
      const store = await make()
      const created = await store.createRun({ ...run, input: { root: true } })
      const staleRevisionExpected = Object.freeze({
        revision: created.revision + 1,
        status: 'running' as const,
        checkpoint: Object.freeze({ stepId: 'prepare', sequence: null }),
      })
      const staleRevisionId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'initial', created.id, created.sessionId, 'worker-1',
        staleRevisionExpected.revision, staleRevisionExpected.status, 'prepare', null, null,
      ])).digest('hex')}`
      await expect(store.acquireRun({
        mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'worker-1',
        acquisitionId: staleRevisionId, expected: staleRevisionExpected,
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'acquisition_conflict' } })
      await expect(store.getRun(created.id)).resolves.toEqual(created)

      const first = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'prepare',
      }))
      await store.commitCheckpoint({
        runId: created.id, sessionId: created.sessionId, leaseId: first.leaseId, workerId: first.workerId,
        stepId: 'prepare', input: created.input, attempt: first.attempt, sequence: 1,
      })
      await first.release()
      const beforeStaleCheckpoint = await store.getRun(created.id)
      const staleCheckpointExpected = Object.freeze({
        revision: beforeStaleCheckpoint!.revision,
        status: beforeStaleCheckpoint!.status as 'interrupted',
        checkpoint: Object.freeze({ stepId: 'prepare', sequence: 2 }),
      })
      const staleCheckpointId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'resume', created.id, created.sessionId, 'worker-2',
        staleCheckpointExpected.revision, staleCheckpointExpected.status, 'prepare', 2, null,
      ])).digest('hex')}`
      await expect(store.acquireRun({
        mode: 'resume', runId: created.id, sessionId: created.sessionId, workerId: 'worker-2',
        acquisitionId: staleCheckpointId, expected: staleCheckpointExpected,
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'acquisition_conflict' } })
      await expect(store.getRun(created.id)).resolves.toEqual(beforeStaleCheckpoint)
      await expect(store.loadCheckpoint(created.id, 'prepare')).resolves.toMatchObject({ sequence: 1 })
    })

    it('commits and replays durable step checkpoints', async () => {
      const store = await make()
      await store.createRun(run)
      const lease = await store.acquireRun(await acquisition(store, {
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-1', stepId: 'prepare'
      }))
      await store.commitCheckpoint({
        runId: run.id,
        sessionId: run.sessionId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        stepId: 'prepare',
        input: lease.run.input,
        attempt: lease.attempt,
        sequence: 1,
        output: { prepared: true }
      })
      await store.commitCheckpoint({
        runId: run.id,
        sessionId: run.sessionId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        stepId: 'execute',
        input: lease.run.input,
        attempt: lease.attempt,
        sequence: 2,
        output: { executed: true }
      })
      await expect(store.loadCheckpoint(run.id, 'prepare')).resolves.toMatchObject({
        stepId: 'prepare',
        output: { prepared: true },
      })
      await lease.release()
      const resumed = await store.acquireRun(await acquisition(store, {
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-2', stepId: 'prepare'
      }))
      expect(resumed.resumed).toBe(true)
      expect(resumed.checkpoint?.output).toEqual({ prepared: true })
      expect(resumed.checkpoints.map(row => row.output)).toEqual([{ prepared: true }, { executed: true }])
    })

    it('treats only a byte-equivalent installed checkpoint as an idempotent retry', async () => {
      const store = await make()
      const created = await store.createRun({ ...run, input: { root: true } })
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'prepare',
      }))
      const checkpoint = Object.freeze({
        runId: created.id,
        sessionId: created.sessionId,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        stepId: 'prepare',
        input: created.input,
        attempt: lease.attempt,
        sequence: 1,
        output: { prepared: true },
        metadata: { source: 'test' },
        committedAt: '2026-01-01T00:00:01.000Z',
      })

      await store.commitCheckpoint(checkpoint)
      const installedRevision = (await store.getRun(created.id))!.revision
      await store.commitCheckpoint(checkpoint)
      expect((await store.getRun(created.id))!.revision).toBe(installedRevision)

      const changed = [
        { ...checkpoint, input: { root: false } },
        { ...checkpoint, attempt: checkpoint.attempt + 1 },
        { ...checkpoint, sequence: 2 },
        { ...checkpoint, output: { prepared: false } },
        { ...checkpoint, metadata: { source: 'changed' } },
        { ...checkpoint, committedAt: '2026-01-01T00:00:02.000Z' },
        { ...checkpoint, sessionId: 'other-session' },
        { ...checkpoint, leaseId: 'other-lease' },
        { ...checkpoint, workerId: 'other-worker' },
      ]
      for (const proposal of changed) await expect(store.commitCheckpoint(proposal)).rejects.toBeDefined()
      await expect(store.loadCheckpoint(created.id, checkpoint.stepId)).resolves.toEqual(checkpoint)
      expect((await store.getRun(created.id))!.revision).toBe(installedRevision)
    })

    it('replaces a checkpoint under the active lease and accepts only an exact installed retry', async () => {
      const store = await make()
      const created = await store.createRun(run)
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'approval'
      }))
      await store.commitCheckpoint({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        stepId: 'approval', input: created.input, attempt: lease.attempt, sequence: 1,
        output: { phase: 'pending' }, committedAt: '2026-01-01T00:00:01.000Z'
      })
      const replacement = Object.freeze({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
		stepId: 'approval', input: created.input, attempt: lease.attempt, sequence: 4,
        output: { phase: 'resumed' },
      })
      const request: ReplaceCheckpointRequest = Object.freeze({
        runId: created.id, sessionId: created.sessionId, stepId: 'approval', expectedSequence: 1,
        leaseId: lease.leaseId, workerId: lease.workerId, replacement,
      })

      await store.replaceCheckpoint(request)
      const revision = (await store.getRun(created.id))?.revision
      await store.replaceCheckpoint(request)
      expect((await store.getRun(created.id))?.revision).toBe(revision)
      await expect(store.loadCheckpoint(created.id, 'approval')).resolves.toMatchObject(replacement)
      expect((await store.loadCheckpoint(created.id, 'approval'))?.committedAt).toEqual(expect.any(String))

      await expect(store.replaceCheckpoint({
        ...request,
        replacement: { ...replacement, output: { phase: 'changed' } },
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'replaceCheckpoint', reason: 'checkpoint_conflict' } })
      await expect(store.loadCheckpoint(created.id, 'approval')).resolves.toMatchObject(replacement)
    })

    it('rejects every changed checkpoint replacement identity without mutation', async () => {
      const store = await make()
      const created = await store.createRun({ ...run, input: { root: true } })
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'approval'
      }))
      const current = Object.freeze({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        stepId: 'approval', input: created.input, attempt: lease.attempt, sequence: 1,
        output: { phase: 'pending' }, committedAt: '2026-01-01T00:00:01.000Z'
      })
      await store.commitCheckpoint(current)
      const replacement = { ...current, sequence: 2, output: { phase: 'resumed' }, committedAt: '2026-01-01T00:00:02.000Z' }
      const base: ReplaceCheckpointRequest = {
        runId: created.id, sessionId: created.sessionId, stepId: current.stepId, expectedSequence: 1,
        leaseId: lease.leaseId, workerId: lease.workerId, replacement,
      }
      const changed: ReplaceCheckpointRequest[] = [
        { ...base, runId: 'other-run', replacement: { ...replacement, runId: 'other-run' } },
        { ...base, sessionId: 'other-session', replacement: { ...replacement, sessionId: 'other-session' } },
        { ...base, stepId: 'other-step', replacement: { ...replacement, stepId: 'other-step' } },
        { ...base, leaseId: 'other-lease', replacement: { ...replacement, leaseId: 'other-lease' } },
        { ...base, workerId: 'other-worker', replacement: { ...replacement, workerId: 'other-worker' } },
        { ...base, replacement: { ...replacement, attempt: replacement.attempt + 1 } },
        { ...base, replacement: { ...replacement, input: { root: false } } },
      ]
      for (const request of changed) {
        await expect(store.replaceCheckpoint(request)).rejects.toMatchObject({
          code: 'STATE_ERROR', meta: { op: 'replaceCheckpoint', reason: 'checkpoint_conflict' }
        })
      }
      await expect(store.loadCheckpoint(created.id, current.stepId)).resolves.toEqual(current)
    })

    it('replaces a prior-attempt checkpoint with the newly acquired lease identity', async () => {
      const store = await make()
      const created = await store.createRun({ ...run, input: { root: true } })
      const first = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'approval'
      }))
      await store.commitCheckpoint({
        runId: created.id, sessionId: created.sessionId, leaseId: first.leaseId, workerId: first.workerId,
        stepId: 'approval', input: created.input, attempt: first.attempt, sequence: 1,
        output: { phase: 'pending' }, committedAt: '2026-01-01T00:00:01.000Z'
      })
      await first.release()
      const resumed = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-2', stepId: 'approval'
      }))
      const replacement = Object.freeze({
        runId: created.id, sessionId: created.sessionId, leaseId: resumed.leaseId, workerId: resumed.workerId,
        stepId: 'approval', input: created.input, attempt: resumed.attempt, sequence: 2,
        output: { phase: 'resumed' }, committedAt: '2026-01-01T00:00:02.000Z'
      })

      await store.replaceCheckpoint({
        runId: created.id, sessionId: created.sessionId, stepId: 'approval', expectedSequence: 1,
        leaseId: resumed.leaseId, workerId: resumed.workerId, replacement,
      })

      await expect(store.loadCheckpoint(created.id, 'approval')).resolves.toEqual(replacement)
    })

    it('atomically finalizes an acquired run and accepts an exact terminal retry', async () => {
      const store = await make()
      const created = await store.createRun(run)
      await store.appendEvents(created.id, [event])
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'approval'
      }))
      await store.commitCheckpoint({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        stepId: 'approval', input: created.input, attempt: lease.attempt, sequence: 1, output: { pending: true }
      })
      const at = '2026-01-01T00:00:03.000Z'
      const output = { ok: true }
      const request: FinalizeRunRequest = Object.freeze({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        patch: Object.freeze({ status: 'succeeded', finishedAt: at, output }),
        terminalEvent: terminalEvent(created.id, 2, at, Object.freeze({ status: 'completed' })),
        checkpointDisposition: 'delete-all',
      })

      await store.finalizeRun(request)
      const terminal = await store.getRun(created.id)
      await expect(store.loadCheckpoint(created.id)).resolves.toBeUndefined()
      await expect(store.listEvents(created.id)).resolves.toHaveLength(2)
      await expect(store.listEvents(created.id)).resolves.toEqual([
        event,
        expect.objectContaining({ payload: { outcome: { status: 'completed' } } }),
      ])
      await store.finalizeRun(request)
      await expect(store.getRun(created.id)).resolves.toEqual(terminal)
      await expect(store.createRun(run)).resolves.toEqual(terminal)
      await expect(store.listEvents(created.id)).resolves.toHaveLength(2)

      await expect(store.finalizeRun({
        ...request,
        patch: { status: 'succeeded', finishedAt: at, output: { ok: false } },
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'run_conflict' } })
    })

    it('reports finalizeRun failures with the exact operation and leaves all state intact', async () => {
      const store = await make()
      const created = await store.createRun(run)
      await store.appendEvents(created.id, [event])
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'approval'
      }))
      const checkpoint = Object.freeze({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        stepId: 'approval', input: created.input, attempt: lease.attempt, sequence: 1, output: { pending: true },
        committedAt: '2026-01-01T00:00:01.000Z'
      })
      await store.commitCheckpoint(checkpoint)
      const before = await store.getRun(created.id)
      const at = '2026-01-01T00:00:03.000Z'
      const patch = Object.freeze({ status: 'succeeded' as const, finishedAt: at, output: { ok: true } })
      const mismatched = {
        ...terminalEvent(created.id, 2, at, Object.freeze({ status: 'completed' })),
        payload: { outcome: { status: 'completed', output: { ok: false } } },
      } as PersistedRunEvent

      await expect(store.finalizeRun({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        patch, terminalEvent: mismatched as unknown as PersistedFinalRunEvent, checkpointDisposition: 'delete-all',
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'event_conflict' } })
      await expect(store.getRun(created.id)).resolves.toEqual(before)
      await expect(store.loadCheckpoint(created.id, checkpoint.stepId)).resolves.toEqual(checkpoint)
      await expect(store.listEvents(created.id)).resolves.toEqual([event])

      const correct = terminalEvent(created.id, 2, at, Object.freeze({ status: 'completed' }))
      await expect(store.finalizeRun({
        runId: created.id, sessionId: created.sessionId, leaseId: 'stale-lease', workerId: lease.workerId,
        patch, terminalEvent: correct, checkpointDisposition: 'delete-all',
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'lease_conflict' } })
      await expect(store.getRun(created.id)).resolves.toEqual(before)
      await expect(store.loadCheckpoint(created.id, checkpoint.stepId)).resolves.toEqual(checkpoint)
    })

    it('rejects non-private terminal event projections atomically', async () => {
      const store = await make()
      const created = await store.createRun(run)
      await store.appendEvents(created.id, [event])
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'approval'
      }))
      const checkpoint = Object.freeze({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        stepId: 'approval', input: created.input, attempt: lease.attempt, sequence: 1, output: { pending: true },
        committedAt: '2026-01-01T00:00:01.000Z'
      })
      await store.commitCheckpoint(checkpoint)
      const beforeRun = await store.getRun(created.id)
      const beforeEvents = await store.listEvents(created.id)
      const at = '2026-01-01T00:00:03.000Z'
      const correct = terminalEvent(created.id, 2, at, { status: 'completed' })
      const malformed: PersistedRunEvent[] = [
        { ...correct, payload: { outcome: { status: 'completed', output: { secret: true } } } },
        { ...correct, payload: { outcome: { status: 'completed', runId: created.id } } },
        { ...correct, payload: { outcome: { status: 'interrupted', interrupt: { secret: true } } } },
        { ...correct, payload: { outcome: { status: 'completed' }, unknown: true } },
        { ...correct, payload: { outcome: { status: 'completed' }, eventId: correct.id } },
        { ...correct, payload: { outcome: { status: 'completed' }, parentRunId: 'parent-run' } },
        { ...correct, payload: { outcome: { status: 'completed' }, parentInvocationId: 'parent-call' } },
        { ...correct, payload: { outcome: { status: 'completed' }, parentRunId: '', parentInvocationId: 'parent-call' } },
        { ...correct, at: '2026-01-01T00:00:04.000Z' },
        { ...correct, id: 'event_wrong' },
        { ...correct, id: eventId(created.id, 3, correct.type), sequence: 3 },
        { ...correct, id: eventId(created.id, 2, 'run.started'), type: 'run.started' },
        { ...correct, extra: true } as PersistedRunEvent,
      ]
      const patch = Object.freeze({ status: 'succeeded' as const, finishedAt: at, output: { secret: 'record-only' } })

      for (const terminalEvent of malformed) {
        await expect(store.finalizeRun({
          runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
          patch, terminalEvent: terminalEvent as unknown as PersistedFinalRunEvent, checkpointDisposition: 'delete-all',
        })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'event_conflict' } })
        await expect(store.getRun(created.id)).resolves.toEqual(beforeRun)
        await expect(store.listEvents(created.id)).resolves.toEqual(beforeEvents)
        await expect(store.loadCheckpoint(created.id, checkpoint.stepId)).resolves.toEqual(checkpoint)
      }
    })

    it.each(['failed', 'cancelled'] as const)('matches a strict sanitized %s terminal error', async (status) => {
      const store = await make()
      const created = await store.createRun(run)
      await store.appendEvents(created.id, [event])
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'terminal'
      }))
      const at = '2026-01-01T00:00:03.000Z'
      const error = Object.freeze({
        code: status === 'failed' ? 'TARGET_EXECUTION_ERROR' : 'OPERATION_CANCELLED',
        message: status === 'failed' ? 'Target execution failed.' : 'Execution was cancelled.',
        category: 'execution',
        retriable: false,
        meta: { scope: 'run' },
      })
      const patch = Object.freeze({ status, finishedAt: at, error })
      const changedError = { ...error, message: 'Changed detail.' }

      await expect(store.finalizeRun({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        patch, terminalEvent: terminalEvent(created.id, 2, at, { status, error: changedError }),
        checkpointDisposition: 'delete-all',
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'event_conflict' } })
      await expect(store.getRun(created.id)).resolves.toMatchObject({ status: 'running' })
      await expect(store.listEvents(created.id)).resolves.toEqual([event])

      const request: FinalizeRunRequest = {
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        patch, terminalEvent: terminalEvent(created.id, 2, at, { status, error }), checkpointDisposition: 'delete-all',
      }
      await store.finalizeRun(request)
      await expect(store.getRun(created.id)).resolves.toMatchObject({ status, error })
      await expect(store.listEvents(created.id)).resolves.toEqual([
        event,
        expect.objectContaining({ payload: { outcome: { status, error } } }),
      ])
      await store.finalizeRun(request)

      await expect(store.finalizeRun({
        ...request,
        terminalEvent: { ...request.terminalEvent, payload: { outcome: { status, error }, output: 'forbidden' } },
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'event_conflict' } })
    })

    it('accepts terminal parent correlation only as an exact pair', async () => {
      const store = await make()
      const created = await store.createRun(run)
      await store.appendEvents(created.id, [event])
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker-1', stepId: 'nested'
      }))
      const at = '2026-01-01T00:00:03.000Z'
      const terminal = terminalEvent(created.id, 2, at, { status: 'completed' }, {
        parentRunId: 'parent-run', parentInvocationId: 'parent-invocation',
      })
      await store.finalizeRun({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        patch: { status: 'succeeded', finishedAt: at, output: { ok: true } },
        terminalEvent: terminal, checkpointDisposition: 'delete-all',
      })
      await expect(store.listEvents(created.id)).resolves.toEqual([event, terminal])
    })

    it('persists a strict approval receipt and requires it on an exact terminal retry', async () => {
      const store = await make()
      const request = { ...run, kind: 'agent' as const, target: 'answer-agent' }
      const created = await store.createRun(request)
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker', stepId: 'approval',
      }))
      const receipt = Object.freeze({
        schemaVersion: 1 as const,
        interruptId: 'interrupt-1',
        resumeEventId: 'resume-1',
        decisions: Object.freeze([
          Object.freeze({ approvalId: 'approval-a', approved: true }),
          Object.freeze({ approvalId: 'approval-b', approved: false }),
        ]),
        deploymentRevision: 'deploy-1',
        compiledGraphDigest: `sha256:${'a'.repeat(64)}`,
        sessionIdentityDigest: `sha256:${'b'.repeat(64)}`,
        rootTarget: Object.freeze({ kind: 'agent' as const, id: request.target }),
      })
      const at = '2026-01-01T00:00:03.000Z'
      const finalization: FinalizeRunRequest = {
        runId: created.id,
        sessionId: created.sessionId,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        patch: { status: 'succeeded', finishedAt: at, output: { ok: true }, approvalReceipt: receipt },
        terminalEvent: terminalEvent(created.id, 1, at, { status: 'completed' }),
        checkpointDisposition: 'delete-all',
      }

      await store.finalizeRun(finalization)
      await expect(store.getRun(created.id)).resolves.toMatchObject({ approvalReceipt: receipt })
      await store.finalizeRun(finalization)
      await expect(store.finalizeRun({
        ...finalization,
        patch: { ...finalization.patch, approvalReceipt: { ...receipt, deploymentRevision: 'deploy-2' } },
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'run_conflict' } })
    })

    it('rejects malformed, mismatched, and child-task approval receipts before mutation', async () => {
      const store = await make()
      const request = { ...run, kind: 'workflow' as const, target: 'review-workflow' }
      const created = await store.createRun(request)
      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker', stepId: 'approval',
      }))
      const valid = {
        schemaVersion: 1 as const,
        interruptId: 'interrupt-1',
        resumeEventId: 'resume-1',
        decisions: [{ approvalId: 'approval-a', approved: true }],
        deploymentRevision: 'deploy-1',
        compiledGraphDigest: `sha256:${'a'.repeat(64)}`,
        sessionIdentityDigest: `sha256:${'b'.repeat(64)}`,
        rootTarget: { kind: 'workflow' as const, id: request.target },
      }
      const invalid = [
        { ...valid, schemaVersion: 2 },
        { ...valid, interruptId: 'invalid interrupt' },
        { ...valid, resumeEventId: '' },
        { ...valid, deploymentRevision: '' },
        { ...valid, compiledGraphDigest: 'sha256:invalid' },
        { ...valid, sessionIdentityDigest: `sha256:${'A'.repeat(64)}` },
        { ...valid, rootTarget: { kind: 'agent' as const, id: request.target } },
        { ...valid, rootTarget: { kind: 'workflow' as const, id: 'other-workflow' } },
        { ...valid, decisions: [{ approvalId: 'approval-a', approved: 'yes' }] },
        { ...valid, decisions: [{ approvalId: 'approval-b', approved: true }, { approvalId: 'approval-a', approved: false }] },
        { ...valid, decisions: [{ approvalId: 'approval-a', approved: true }, { approvalId: 'approval-a', approved: false }] },
        { ...valid, unknown: true },
      ]
      const at = '2026-01-01T00:00:03.000Z'
      for (const approvalReceipt of invalid) {
        await expect(store.finalizeRun({
          runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
          patch: { status: 'succeeded', finishedAt: at, output: { ok: true }, approvalReceipt } as never,
          terminalEvent: terminalEvent(created.id, 1, at, { status: 'completed' }), checkpointDisposition: 'delete-all',
        })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'run_conflict' } })
        await expect(store.getRun(created.id)).resolves.toMatchObject({ status: 'running' })
      }

      const childStore = await make()
      const child = await childStore.createRun({ ...run, id: 'child-run', kind: 'child_task', target: 'child-agent' })
      const childLease = await childStore.acquireRun(await acquisition(childStore, {
        runId: child.id, sessionId: child.sessionId, workerId: 'worker', stepId: 'approval',
      }))
      await expect(childStore.finalizeRun({
        runId: child.id, sessionId: child.sessionId, leaseId: childLease.leaseId, workerId: childLease.workerId,
        patch: { status: 'succeeded', finishedAt: at, output: { ok: true }, approvalReceipt: {
          ...valid, rootTarget: { kind: 'agent', id: child.target },
        } } as never,
        terminalEvent: terminalEvent(child.id, 1, at, { status: 'completed' }), checkpointDisposition: 'delete-all',
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finalizeRun', reason: 'run_conflict' } })
      await expect(childStore.getRun(child.id)).resolves.toMatchObject({ status: 'running' })
    })

    it('atomically suspends a run on an external wait and deduplicates signals', async () => {
      const store = await make()
      await store.createRun(run)
      await store.acquireRun(await acquisition(store, {
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-1', stepId: 'review'
      }))
      const request = {
        runId: run.id,
        sessionId: run.sessionId,
        waitId: 'wait-1',
        kind: 'human_review',
        schemaVersion: 'v1',
        definitionVersion: 'v1',
        deadline: '2030-01-01T00:00:00.000Z'
      }
      const beforeWait = await store.getRun(run.id)
      await expect(store.registerWait(request)).resolves.toMatchObject({ created: true })
      await expect(store.getRun(run.id)).resolves.toMatchObject({
        status: 'waiting',
        revision: beforeWait!.revision + 1,
      })
      await expect(store.signalWait({ waitId: request.waitId, eventId: 'event-1', outcome: 'approved' })).resolves.toMatchObject({ kind: 'applied' })
      await expect(store.signalWait({ waitId: request.waitId, eventId: 'event-1', outcome: 'approved' })).resolves.toMatchObject({ kind: 'duplicate' })
    })

    it('rejects wait registration without an active run lease', async () => {
      const store = await make()
      const created = await store.createRun(run)
      const request = {
        runId: created.id,
        sessionId: created.sessionId,
        waitId: 'wait-without-lease',
        kind: 'human_review',
        schemaVersion: 'v1',
        definitionVersion: 'v1',
        deadline: '2030-01-01T00:00:00.000Z',
      }
      await expect(store.registerWait(request)).rejects.toMatchObject({
        code: 'EXTERNAL_WAIT_ERROR', meta: { reason: 'durable_required' },
      })
      await expect(store.getRun(created.id)).resolves.toEqual(created)
      await expect(store.getWait(request.waitId)).resolves.toBeUndefined()

      const lease = await store.acquireRun(await acquisition(store, {
        runId: created.id, sessionId: created.sessionId, workerId: 'worker', stepId: 'wait',
      }))
      await lease.release()
      const interrupted = await store.getRun(created.id)
      await expect(store.registerWait({ ...request, waitId: 'wait-after-release' })).rejects.toMatchObject({
        code: 'EXTERNAL_WAIT_ERROR', meta: { reason: 'durable_required' },
      })
      await expect(store.getRun(created.id)).resolves.toEqual(interrupted)
      await expect(store.getWait('wait-after-release')).resolves.toBeUndefined()
    })
  })
}
