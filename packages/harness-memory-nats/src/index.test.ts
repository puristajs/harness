import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryEngineContract } from '@purista/harness/testing'
import type { MemoryEngineContext, MemoryRecord, MemoryScope } from '@purista/harness'
import type { NatsConnection } from '@nats-io/transport-node'

const fixture = vi.hoisted(() => {
  type Entry = { key: string; value: Uint8Array; revision: number }
  const entries = new Map<string, Entry>()
  const calls = { connect: 0, get: 0, delete: [] as Array<{ key: string; previousSeq?: number }>, drain: 0, close: 0 }
  let revision = 0
  let conflictOnDelete = false
  let status = { history: 1, storage: 'file', replicas: 1, metadata: { 'purista.harness.memory.schema': 'v1' } }
  const toEntry = (entry: Entry) => ({
    bucket: 'purista-harness-memory-v1',
    key: entry.key,
    value: entry.value,
    created: new Date(),
    revision: entry.revision,
    operation: 'PUT' as const,
    length: entry.value.length,
    rawKey: entry.key,
    json: <T>() => JSON.parse(new TextDecoder().decode(entry.value)) as T,
    string: () => new TextDecoder().decode(entry.value),
  })
  const kv = {
    get: async (key: string) => { calls.get += 1; const entry = entries.get(key); return entry === undefined ? null : toEntry(entry) },
    create: async (key: string, value: Uint8Array) => {
      if (entries.has(key)) throw new Error('wrong last sequence')
      entries.set(key, { key, value, revision: ++revision })
      return revision
    },
    update: async (key: string, value: Uint8Array, previousSeq: number) => {
      const entry = entries.get(key)
      if (entry === undefined || entry.revision !== previousSeq) throw new Error('wrong last sequence')
      entries.set(key, { key, value, revision: ++revision })
      return revision
    },
    delete: async (key: string, options?: { previousSeq?: number }) => {
      calls.delete.push({ key, ...(options?.previousSeq === undefined ? {} : { previousSeq: options.previousSeq }) })
      const entry = entries.get(key)
      if (conflictOnDelete || (options?.previousSeq !== undefined && entry?.revision !== options.previousSeq)) throw new Error('wrong last sequence')
      entries.delete(key)
    },
    keys: async function* (pattern: string) {
      const prefix = pattern.slice(0, -1)
      for (const key of entries.keys()) if (key.startsWith(prefix)) yield key
    },
    status: async () => status,
  }
  const connection = {
    info: { jetstream: true },
    drain: async () => { calls.drain += 1 },
    close: async () => { calls.close += 1 },
  }
  return {
    Kvm: class { public constructor(_connection: unknown) {} public async create(_bucket: string, _options: unknown) { return kv } public async open(_bucket: string) { return kv } },
    connect: async () => { calls.connect += 1; return connection },
    jetstream: (value: unknown) => value,
    connection,
    calls,
    entries,
    get conflictOnDelete() { return conflictOnDelete },
    set conflictOnDelete(value: boolean) { conflictOnDelete = value },
    get status() { return status },
    set status(value: typeof status) { status = value },
    reset() {
      entries.clear(); revision = 0; conflictOnDelete = false
      status = { history: 1, storage: 'file', replicas: 1, metadata: { 'purista.harness.memory.schema': 'v1' } }
      calls.connect = 0; calls.get = 0; calls.delete.splice(0); calls.drain = 0; calls.close = 0
    },
  }
})

vi.mock('@nats-io/transport-node', () => ({ connect: fixture.connect }))
vi.mock('@nats-io/jetstream', () => ({ jetstream: fixture.jetstream, StorageType: { File: 'file' } }))
vi.mock('@nats-io/kv', () => ({ Kvm: fixture.Kvm }))

import { natsMemoryEngine } from './index.js'

const scope: MemoryScope = { kind: 'session', scopeKey: 'scope/tenant-a/session-1', sessionId: 'session-1' }
const context = (): MemoryEngineContext => ({
  logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => context().logger },
  telemetry: { span: async (_name, _attrs, fn) => fn({} as never), recordHistogram() {}, recordCounter() {}, currentTraceparent: () => undefined },
  metrics: { counter() {}, histogram() {}, duration: async (_name, _attrs, fn) => fn() },
  contentCaptureMode: 'NO_CONTENT',
  signal: new AbortController().signal,
})
const record = (key: string, expiresAt?: string): MemoryRecord => ({
  scopeKey: scope.scopeKey,
  key,
  value: { key },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...(expiresAt === undefined ? {} : { expiresAt }),
})
const connection = fixture.connection as unknown as NatsConnection

afterEach(() => fixture.reset())

memoryEngineContract(() => natsMemoryEngine({ connection }))

describe('natsMemoryEngine', () => {
  it('uses opaque scope/key subjects and preserves canonical records', async () => {
    const engine = natsMemoryEngine({ connection })
    await engine.put(scope, record('customer@example.com'), context())
    const subject = [...fixture.entries.keys()][0]!
    expect(subject).toMatch(/^m\.[a-f0-9]{64}\.[a-f0-9]{64}$/)
    expect(subject).not.toContain('customer@example.com')
    expect(subject).not.toContain(scope.scopeKey)
    await expect(engine.get(scope, 'customer@example.com', context())).resolves.toEqual(record('customer@example.com'))
  })

  it('uses a revision compare-and-set write and exposes only KV capabilities', async () => {
    const engine = natsMemoryEngine({ connection })
    expect(engine.capabilities).toEqual(['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.persistent', 'memory.multi_instance'])
    await engine.put(scope, record('a'), context())
    await engine.put(scope, { ...record('a'), value: { revision: 2 } }, context())
    await expect(engine.get(scope, 'a', context())).resolves.toMatchObject({ value: { revision: 2 } })
  })

  it('lists bounded, sorted logical keys with an opaque last-key-hash cursor', async () => {
    const engine = natsMemoryEngine({ connection })
    await engine.put(scope, record('zeta'), context())
    await engine.put(scope, record('alpha'), context())
    await engine.put(scope, record('middle'), context())
    const first = await engine.list(scope, { limit: 1 }, context())
    expect(first.records.map((entry) => entry.key)).toEqual(['alpha'])
    expect(first.cursor).toBeDefined()
    expect(first.cursor).not.toContain('alpha')
    const second = await engine.list(scope, { limit: 1, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) }, context())
    expect(second.records.map((entry) => entry.key)).toEqual(['middle'])
  })

  it('rejects a namespace over the configured enumeration limit before reading values', async () => {
    const engine = natsMemoryEngine({ connection, maxEnumeratedKeys: 1 })
    await engine.put(scope, record('a'), context())
    await engine.put(scope, record('b'), context())
    fixture.calls.get = 0
    await expect(engine.list(scope, {}, context())).rejects.toMatchObject({ meta: { reason: 'nats_enumeration_limit_exceeded' } })
    expect(fixture.calls.get).toBe(0)
  })

  it('hides expired records and never deletes a concurrent replacement', async () => {
    const engine = natsMemoryEngine({ connection })
    await engine.put(scope, record('expired', '2000-01-01T00:00:00.000Z'), context())
    fixture.conflictOnDelete = true
    await expect(engine.get(scope, 'expired', context())).resolves.toBeUndefined()
    expect(fixture.entries.size).toBe(1)
    expect(fixture.calls.delete.at(-1)?.previousSeq).toBe(1)
  })

  it('validates bucket metadata without recreating incompatible storage', async () => {
    fixture.status = { history: 2, storage: 'file', replicas: 1, metadata: { 'purista.harness.memory.schema': 'v1' } }
    const engine = natsMemoryEngine({ connection })
    await expect(engine.get(scope, 'a', context())).rejects.toMatchObject({ meta: { reason: 'nats_bucket_incompatible' } })
  })

  it('leaves injected connections to the application and drains engine-owned connections', async () => {
    const injected = natsMemoryEngine({ connection })
    await injected.get(scope, 'a', context())
    await injected.close?.()
    expect(fixture.calls.drain).toBe(0)
    expect(fixture.calls.close).toBe(0)

    const owned = natsMemoryEngine({ servers: 'nats://127.0.0.1:4222' })
    await owned.get(scope, 'a', context())
    await owned.close?.()
    expect(fixture.calls.connect).toBe(1)
    expect(fixture.calls.drain).toBe(1)
    expect(fixture.calls.close).toBe(1)
  })

  it('fails closed before NATS I/O when configuration or cancellation is invalid', async () => {
    expect(() => natsMemoryEngine({ servers: '' })).toThrow(/non-empty URL/i)
    const cancelled = new AbortController(); cancelled.abort()
    const engine = natsMemoryEngine({ servers: 'nats://127.0.0.1:4222' })
    await expect(engine.get(scope, 'a', { ...context(), signal: cancelled.signal })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(fixture.calls.connect).toBe(0)
  })
})
