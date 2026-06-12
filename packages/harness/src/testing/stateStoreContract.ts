import { describe, expect, it } from 'vitest'

import { StateError } from '../errors/index.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { StateStore } from '../ports/state.js'

const session: SessionRecord = {
  id: 'session_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  runCount: 0
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

export function stateStoreContract(make: () => StateStore | Promise<StateStore>): void {
  describe('stateStoreContract', () => {
    it('getSession returns undefined for unknown id', async () => {
      const store = await make()
      await expect(store.getSession('missing')).resolves.toBeUndefined()
    })

    it('upsertSession and getSession round-trip', async () => {
      const store = await make()
      await store.upsertSession(session)
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
  })
}
