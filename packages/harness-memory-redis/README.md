# `@purista/harness-memory-redis`

Redis 8+ Search memory engine for `@purista/harness`. It owns a versioned
record namespace, atomic record/index writes, text search, TTL, and optional
fixed-dimension vector search. It requires the official `redis` package and a
Redis deployment with Search/vector commands.

## Install

```bash
npm install @purista/harness @purista/harness-memory-redis
```

Use an application-owned, versioned namespace. Changing vector dimensions or
index schema requires a new namespace and an explicit reindex; this package
never drops or migrates an existing Redis index automatically.

```ts
import { defineHarness } from '@purista/harness'
import { redisMemoryEngine } from '@purista/harness-memory-redis'

const memory = redisMemoryEngine({
  url: process.env.REDIS_URL!,
  namespace: 'support:memory:v1',
  vector: { dimensions: 1536 }
})

const definition = defineHarness({ name: 'support' }).addAgent(supportAgent)
const harness = await definition.getInstance({ models: { chat: model }, memory })
```

Pass `client` instead of `url` when the application owns the official
node-redis lifecycle. The engine then never connects via a URL or closes that
client. The `url` path lazily imports `redis`; a missing installation fails
with a `HarnessConfigError` explaining the required package and version.
