# @purista/harness-memory-nats

Persistent, scoped key/value memory for `@purista/harness` using the official NATS v3 JetStream KV packages.

```ts
import { defineHarness } from '@purista/harness'
import { natsMemoryEngine } from '@purista/harness-memory-nats'

const harness = defineHarness({ name: 'support' })
  .memory(natsMemoryEngine({ servers: 'nats://127.0.0.1:4222' }))
  .build()
```

The engine creates the `purista-harness-memory-v1` bucket by default with file storage, history `1`, and one replica. It stores one canonical memory record per opaque key (`m.<scope hash>.<key hash>`); subjects never contain logical keys, tenant ids, or principal ids.

## Capabilities and limits

It provides persistent multi-instance KV, list, delete, and lazy TTL visibility. It intentionally provides no text, vector, or hybrid search. List operations enumerate one scope, reject a scope over `maxEnumeratedKeys` (default `10000`) before reading values, sort by logical key, and use opaque cursors.

Supply exactly one connection source:

```ts
natsMemoryEngine({
  servers: ['nats://nats-a:4222', 'nats://nats-b:4222'],
  connectionOptions: { user: process.env.NATS_USER, pass: process.env.NATS_PASSWORD },
  replicas: 3,
})
```

Or inject an application-owned connection. Injected connections are never closed by the engine.

```ts
natsMemoryEngine({ connection })
```

JetStream must be enabled. An existing bucket is never recreated; it must retain the v1 metadata, file storage, history `1`, and configured replication factor. All initialization, bucket, bounded-enumeration, malformed-record, cancellation, and lifecycle failures are emitted as safe Harness errors without values, keys, identities, URLs, or credentials.
