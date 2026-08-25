# `@purista/harness-memory-sqlite`

Local durable memory for `@purista/harness`, using the SQLite implementation
built into current Node.js and Bun. It provides scoped KV, pagination, TTL,
and FTS5 text search with no required third-party runtime dependency.

```ts
import { sqliteMemoryEngine } from '@purista/harness-memory-sqlite'

const memory = sqliteMemoryEngine({ file: '.purista/memory.sqlite' })
```

For exact local vector search, install the optional peer and opt in explicitly:

```sh
npm install sqlite-vec@0.1.9
```

```ts
const memory = sqliteMemoryEngine({
  file: '.purista/memory.sqlite',
  vector: true
})
```

The first vector atomically establishes its immutable descriptor and dimensions.
Changing either requires a new database file and an explicit reindex. The
extension is loaded only during engine initialization and then disabled where
the runtime permits it. If the native extension cannot be loaded, the factory
fails with a safe `HarnessConfigError`; it never silently falls back to text
search. Bun on macOS may require an extension-capable custom SQLite build.
