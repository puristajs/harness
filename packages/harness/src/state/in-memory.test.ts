import { describe, expect, it } from 'vitest'
import type { Message } from '../models/state.js'
import { InMemoryStateStore } from './in-memory.js'

function message(id: string): Message {
  return { id, sessionId: 's1', role: 'user', content: 'hello', timestamp: new Date().toISOString() }
}

describe('InMemoryStateStore message operations', () => {
  it('reports the actual operation for duplicate ids in replaceMessages', async () => {
    const store = new InMemoryStateStore()

    await expect(store.replaceMessages('s1', [message('m1'), message('m1')])).rejects.toMatchObject({
      code: 'STATE_ERROR',
      meta: { op: 'replaceMessages', reason: 'duplicate_message_id' }
    })
  })

  it('keeps reporting appendMessages for duplicate ids in appendMessages', async () => {
    const store = new InMemoryStateStore()
    await store.appendMessages('s1', [message('m1')])

    await expect(store.appendMessages('s1', [message('m1')])).rejects.toMatchObject({
      code: 'STATE_ERROR',
      meta: { op: 'appendMessages', reason: 'duplicate_message_id' }
    })
  })
})
