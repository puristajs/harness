# `@purista/harness-memory-redis`

Redis 8+ Search memory engine for `@purista/harness`. It owns a versioned
record namespace, atomic record/index writes, text search, TTL, and optional
fixed-dimension vector search. It requires the official `redis` package and a
Redis deployment with Search/vector commands.

Use an application-owned, versioned namespace. Changing vector dimensions or
index schema requires a new namespace and an explicit reindex; this package
never drops or migrates an existing Redis index automatically.

```ts
import { redisMemoryEngine } from '@purista/harness-memory-redis'

const memory = redisMemoryEngine({
  url: process.env.REDIS_URL!,
  namespace: 'support:memory:v1',
  vector: { dimensions: 1536 }
})
```

Pass `client` instead of `url` when the application owns the official
node-redis lifecycle. The engine then never connects via a URL or closes that
client. The `url` path lazily imports `redis`; a missing installation fails
with a `HarnessConfigError` explaining the required package and version.
