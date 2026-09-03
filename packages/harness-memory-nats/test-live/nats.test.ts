import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jetstream } from '@nats-io/jetstream'
import { Kvm } from '@nats-io/kv'
import { connect, type NatsConnection } from '@nats-io/transport-node'
import type { MemoryEngineContext, MemoryScope } from '@purista/harness'
import { natsMemoryEngine } from '../src/index.js'

const server = process.env['NATS_URL']
const bucket = `purista_harness_memory_live_${Date.now()}`
let connection: NatsConnection | undefined

const context = (): MemoryEngineContext => ({
  logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => context().logger },
  telemetry: { span: async (_name, _attrs, fn) => fn({} as never), recordHistogram() {}, recordCounter() {}, currentTraceparent: () => undefined },
  metrics: { counter() {}, histogram() {}, duration: async (_name, _attrs, fn) => fn() },
  contentCaptureMode: 'NO_CONTENT', signal: new AbortController().signal,
})

describe.skipIf(server === undefined)('NATS JetStream KV live contract', () => {
  beforeAll(async () => { connection = await connect({ servers: server }) })
  afterAll(async () => {
    if (connection === undefined) return
    try { await new Kvm(jetstream(connection)).open(bucket).then((kv) => kv.destroy()) } finally { await connection.close() }
  })

  it('persists across engine instances and isolates scoped records', async () => {
    const activeConnection = connection!
    const first = natsMemoryEngine({ connection: activeConnection, bucket, replicas: 1 })
    const scope: MemoryScope = { kind: 'session', scopeKey: 'live/a', sessionId: 'a' }
    await first.put(scope, { scopeKey: scope.scopeKey, key: 'ticket', value: { id: 'T-1' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, context())
    await first.close?.()
    const second = natsMemoryEngine({ connection: activeConnection, bucket, replicas: 1 })
    await expect(second.get(scope, 'ticket', context())).resolves.toMatchObject({ key: 'ticket' })
    await expect(second.get({ ...scope, scopeKey: 'live/b', sessionId: 'b' }, 'ticket', context())).resolves.toBeUndefined()
    await second.close?.()
  })
})
