import { describe, expect, it } from 'vitest'

import { StateError } from '../errors/index.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { HarnessStorage } from '../storage/types.js'

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

const run: RunRecord = {
  id: 'run_1',
  sessionId: session.id,
  kind: 'workflow',
  target: 'wf',
  startedAt: '2026-01-01T00:00:00.000Z',
  status: 'running'
}

const event: PersistedRunEvent = {
  id: '01EVT',
  runId: run.id,
  at: '2026-01-01T00:00:00.000Z',
  type: 'run.started',
  payload: { ok: true }
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
      await store.createRun(run)
      await expect(store.getRun(run.id)).resolves.toEqual(run)
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
      await store.appendEvents(run.id, [event, { ...event, id: '01EVT2', payload: { ok: 2 } }])
      await expect(store.listEvents(run.id)).resolves.toHaveLength(2)
      await expect(store.listEvents(run.id, { after: '01EVT' })).resolves.toEqual([
        expect.objectContaining({ id: '01EVT2' })
      ])
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
      await store.appendEvents(run.id, [event, { ...event, id: '01EVT2' }])
      await expect(store.listEvents(run.id, { limit: 1 })).resolves.toEqual([
        expect.objectContaining({ id: '01EVT' })
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
      const first = await store.acquireRun({
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-1', stepId: 'prepare', input: { value: 1 }
      })
      expect(first.attempt).toBe(1)
      await first.release()
      await expect(store.getRun(run.id)).resolves.toMatchObject({ status: 'interrupted', attempt: 1 })

      const second = await store.acquireRun({
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-2', stepId: 'prepare', input: { value: 1 }
      })
      expect(second.attempt).toBe(2)
      await store.finishRun(run.id, { status: 'succeeded', output: { ok: true } })
      await expect(store.acquireRun({
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-3', stepId: 'prepare', input: { value: 1 }
      })).rejects.toThrow(/terminal/i)
    })

    it('commits and replays durable step checkpoints', async () => {
      const store = await make()
      await store.createRun(run)
      const lease = await store.acquireRun({
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-1', stepId: 'prepare', input: { value: 1 }
      })
      await store.commitCheckpoint({
        runId: run.id,
        sessionId: run.sessionId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        stepId: 'prepare',
        input: lease.start.input,
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
        input: lease.start.input,
        attempt: lease.attempt,
        sequence: 2,
        output: { executed: true }
      })
      await expect(store.loadCheckpoint(run.id, 'prepare')).resolves.toMatchObject({
        stepId: 'prepare',
        output: { prepared: true },
      })
      await lease.release()
      const resumed = await store.acquireRun({
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-2', stepId: 'prepare', input: { value: 1 }
      })
      expect(resumed.resumed).toBe(true)
      expect(resumed.checkpoint?.output).toEqual({ executed: true })
    })

    it('atomically suspends a run on an external wait and deduplicates signals', async () => {
      const store = await make()
      await store.createRun(run)
      await store.acquireRun({
        runId: run.id, sessionId: run.sessionId, workerId: 'worker-1', stepId: 'review', input: null
      })
      const request = {
        runId: run.id,
        sessionId: run.sessionId,
        waitId: 'wait-1',
        kind: 'human_review',
        schemaVersion: 'v1',
        definitionVersion: 'v1',
        deadline: '2030-01-01T00:00:00.000Z'
      }
      await expect(store.registerWait(request)).resolves.toMatchObject({ created: true })
      await expect(store.getRun(run.id)).resolves.toMatchObject({ status: 'waiting' })
      await expect(store.signalWait({ waitId: request.waitId, eventId: 'event-1', outcome: 'approved' })).resolves.toMatchObject({ kind: 'applied' })
      await expect(store.signalWait({ waitId: request.waitId, eventId: 'event-1', outcome: 'approved' })).resolves.toMatchObject({ kind: 'duplicate' })
    })
  })
}
