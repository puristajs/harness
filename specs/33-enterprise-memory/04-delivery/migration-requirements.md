# Clean-break migration requirements

## Source migration

| Old | New |
| --- | --- |
| omitted memory using `sandboxMemory()` | omitted memory using core `inMemoryMemoryEngine()` composition |
| `.memory(sandboxMemory())` | omit `.memory(...)` or pass `inMemoryMemoryEngine()` explicitly |
| arbitrary `MemoryAdapter` backend | `MemoryEngine` composed by core |
| `ctx.memory.user()` | `ctx.memory.principal()` |
| `userId` | `principalId` |
| `memory.search` | effective `memory.text_search`, `memory.vector_search`, or `memory.hybrid_search` |
| model alias string or profile | `model.<alias>` in the typed memory callback |

The implementation deletes old exports, code, tests, examples, documentation, website text, and skill guidance. It does not ship deprecated aliases, wrappers, overloads, re-exports, environment flags, or dual schemas.

## Data migration

The sandbox-backed file memory is pre-release development data and receives no automatic production migration. The migration guide includes an explicit application script pattern that reads old JSON files and writes through the new facade when a developer chooses to preserve local data.

SQLite, PostgreSQL, Redis, and NATS packages start at schema or namespace version `v1`. Their migration assets do not inspect or mutate unrelated application files/tables/keys/buckets. SQLite memory defaults in documentation to `.purista/memory.sqlite`, separate from HarnessStorage's `.purista/harness.sqlite`; sharing a file is neither automatic nor documented as the normal path. Reindex creates a new namespace, verifies count and sample queries, switches application configuration, and removes the old namespace only through an explicit operator command after rollback expiry.

## Release acceptance

- Public export tests prove removed values are absent.
- Repository stale-text search has no active legacy use outside migration history and this removal table.
- Package READMEs, Harness docs, PURISTA handbook, architecture website, examples, and skills use one API shape.
- Changesets identify the Harness breaking change and the four new engine packages.
- Package tarball inspection proves engine dependencies do not leak into core, PGlite remains test-only, optional sqlite-vec is not installed for base SQLite consumers, and package exports contain no duplicate Harness contracts or test-only executor.
