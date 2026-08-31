# `@purista/harness-storage-postgres`

Distributed PostgreSQL storage for sessions, history, runs, events, durable
checkpoints, leases, and external waits in `@purista/harness`.

```ts
import { defineHarness } from '@purista/harness'
import { postgresHarnessStorage } from '@purista/harness-storage-postgres'

const storage = postgresHarnessStorage({
  connectionString: process.env.DATABASE_URL!,
})

const harness = defineHarness({ name: 'worker' })
  .storage(storage)
  .requires(['storage.persistent', 'storage.multi_instance'])
  // models, agents, and workflows
  .build()
```

Pass either `connectionString` or a caller-owned `pg.Pool`, never both. The
adapter closes only pools it creates. It lazily applies its idempotent versioned
migration before the first operation and serializes session work with
transaction-scoped PostgreSQL advisory locks.

Use a separate database role and schema policy with only the DDL/DML permissions
needed by the migration and runtime. Review database backup, encryption,
retention, connection limits, statement timeouts, and tenant-level application
authorization before production deployment. Harness identifiers and stored
JSON are application data; do not expose them through database logs.
