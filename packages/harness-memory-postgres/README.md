# `@purista/harness-memory-postgres`

PostgreSQL 16+ and pgvector memory engine for `@purista/harness`. It provides
durable, multi-instance scoped KV, pagination, TTL, PostgreSQL full-text
search, vector search, and hybrid retrieval.

```ts
import { postgresMemoryEngine } from '@purista/harness-memory-postgres'

const memory = postgresMemoryEngine({
  connectionString: process.env.DATABASE_URL!
})
```

Alternatively pass an application-owned `pg` pool. Exactly one connection mode
is required; an injected pool is never closed by the engine. The package lazily
applies its versioned schema and verifies pgvector on first use. The first
vector atomically establishes an immutable embedding descriptor and dimensions;
changing either requires a new schema/database and a deliberate reindex.
