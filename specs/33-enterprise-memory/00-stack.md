# Stack and dependency evidence

## Runtime baseline

- TypeScript ESM following the existing Harness package layout.
- Node.js `>=24.15.0`, matching the repository engine declaration.
- Bun support verified by a Bun type/import/unit smoke suite; Bun is a supported runtime, not a separate implementation.
- Zod remains the schema dependency in core. No new core runtime dependency is added.

## Vendor packages

| Package | Runtime dependency | Database requirement | Ownership |
| --- | --- | --- | --- |
| `@purista/harness-memory-sqlite` | built-in `node:sqlite` or `bun:sqlite`; optional peer `sqlite-vec` `0.1.9` | local SQLite with FTS5; `sqlite-vec` only when `vector: true` | local schema, FTS5 queries, optional exact vector queries, single-host transactions |
| `@purista/harness-memory-postgres` | `pg` `^8.23.0` | PostgreSQL 16+; pgvector 0.8.x for semantic search | PostgreSQL DDL, transactions, full-text and vector queries |
| `@purista/harness-memory-redis` | `redis` `^6.2.1` | Redis 8+ with Search/vector commands | Redis key layout, Lua/transactional writes, text and vector queries |
| `@purista/harness-memory-nats` | `@nats-io/transport-node`, `@nats-io/jetstream`, and `@nats-io/kv` `3.4.0` | a currently supported NATS Server release, minimum 2.12.6, with JetStream | persistent KV, scoped key enumeration, compare-and-set writes, and lazy TTL visibility; no relevance search |

The repository lockfile pins resolved transitive versions. Vendor packages list `@purista/harness` as a peer dependency and never re-export Harness contracts.

All four packages live in the AI Harness repository. A Harness memory engine imports Harness contracts, runs the Harness contract suite, and follows the Harness release/runtime matrix even when PURISTA exposes a general StateStore for the same database. The PURISTA repository retains framework StateStore packages and contains no Harness memory implementation.

## Existing PURISTA store assessment

| Existing framework package | Harness memory decision | Reason |
| --- | --- | --- |
| `@purista/core` `DefaultStateStore` | no package; use the core Harness in-memory engine | Both are process-local development defaults, but Harness memory requires its own scopes, records, tests, and facade. Wrapping one default in the other adds no capability. |
| `@purista/redis-state-store` | provide the independent Redis memory package above | The official client and connection conventions are reusable evidence, but framework KV state does not provide memory scopes, indexed records, search, TTL/index atomicity, or the Harness engine contract. The memory package does not depend on or wrap the StateStore package. |
| `@purista/nats-state-store` | provide the independent NATS memory package above | JetStream KV can implement scoped persistence, enumeration, CAS, and lazy expiry. It cannot provide text, vector, or hybrid relevance search, so it advertises none of them. The new package uses the current official modular NATS v3 packages instead of the deprecated `nats` v2 package. |
| `@purista/dapr-sdk` state store | no first-party Harness memory package | Dapr state query is alpha and support varies by configured component. A portable Dapr adapter cannot guarantee list, query, TTL, transactions, or indexed-write semantics. Applications use the direct PostgreSQL, Redis, or NATS memory package for the underlying service. |

Physical infrastructure may be shared, but StateStore keys/tables and Harness memory keys/tables use separate versioned namespaces and separate contracts. No dependency points from an AI Harness package to `@purista/core` or a framework StateStore package.

## Container-free database testing

`@purista/harness-memory-postgres` uses `@electric-sql/pglite` `0.5.7` and `@electric-sql/pglite-pgvector` `0.0.8` as package-private development dependencies. A private SQL-executor test seam runs migrations, CRUD, filtering, FTS, pgvector, descriptor, and rollback tests in-process under Node.js and Bun. These packages do not appear in the published adapter dependency graph or public API.

PGlite removes Docker from normal development and pull-request tests, but it is a single-connection WASM PostgreSQL build. It cannot prove pool behavior, network/TLS behavior, multiple database processes, failover, or production planner/index behavior. Release CI therefore runs the same contract once against CI-managed PostgreSQL 16+ with pgvector 0.8.x. A developer does not need Docker; CI may provision the real service by any repository-supported mechanism.

`pg-mem` is not installed. Its own documentation describes an experimental best-effort PostgreSQL emulator, no native extensions, basic indices, and concurrency limitations. It cannot validate pgvector or production transaction/pool behavior, while PGlite executes PostgreSQL and pgvector code in-process.

## Dated primary research

Research was reviewed on 2026-08-25:

- node-postgres documents ESM support and pooled connections: https://node-postgres.com/features/esm and https://node-postgres.com/features/pooling
- Bun documents that `pg` and node-postgres can run under Bun: https://bun.sh/docs/runtime/sql
- pgvector documents exact and approximate nearest-neighbor search, filtering behavior, HNSW, IVFFlat, and iterative scans: https://github.com/pgvector/pgvector
- Redis recommends `node-redis` for Node.js/JavaScript: https://redis.io/docs/latest/develop/clients/nodejs/
- Redis documents vector indexing and querying through the JavaScript client: https://redis.io/docs/latest/develop/clients/nodejs/vecsearch/
- Bun documents broad Node.js API compatibility and the remaining compatibility caveats: https://bun.sh/docs/runtime/nodejs-compat
- Node.js documents `DatabaseSync` extension loading and its explicit `allowExtension` gate: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
- Bun documents built-in SQLite and native extension loading; macOS requires an application-supplied vanilla SQLite library because Apple SQLite disables extension loading: https://bun.sh/docs/runtime/sqlite
- sqlite-vec documents npm/Bun installation and loading with `node:sqlite` and `bun:sqlite`: https://github.com/asg017/sqlite-vec/blob/main/site/getting-started/installation.md and https://alexgarcia.xyz/sqlite-vec/js.html
- PGlite documents in-process Node.js/Bun operation and pgvector support: https://pglite.dev/docs/about and https://pglite.dev/extensions/
- pg-mem documents its best-effort parser, absent native extensions, basic indices, and numeric/timezone limitations: https://github.com/oguimbal/pg-mem
- NATS documents JetStream KV, revisions/CAS, enumeration/watch, TTL, and the Node/Bun transport: https://docs.nats.io/learn/key-value/ and https://github.com/nats-io/nats.js
- NATS security advisory GHSA-8m2x-3m6q-6w8j fixes affected 2.12 releases in 2.12.6 and documents the 2.11.15 backport: https://github.com/nats-io/nats-server/security/advisories/GHSA-8m2x-3m6q-6w8j
- Dapr documents component-specific state capabilities and labels its Query API alpha: https://docs.dapr.io/reference/components-reference/supported-state-stores/ and https://docs.dapr.io/developing-applications/building-blocks/state-management/howto-state-query-api/

## Dependency decisions

- Core does not depend on `pg`, `redis`, an embedding SDK, a vector SDK, a queue library, or a tokenizer.
- SQLite has no required third-party runtime dependency. `sqlite-vec` is an optional peer loaded only when `vector: true`; missing or unsupported native extension loading is an actionable build error, never an automatic text-only downgrade.
- PostgreSQL uses `pg`; no ORM and no pgvector JavaScript wrapper is added. Vectors are finite-number arrays encoded into a parameter value and explicitly cast by parameterized SQL.
- Redis uses the official `redis` package. The adapter does not use Bun's native Redis API because one package must work in both runtimes.
- NATS uses the official v3 modular Node/Bun transport, JetStream, and KV packages. It does not depend on the deprecated `nats` v2 package or `@purista/nats-state-store`.
- No engine package creates model providers. Embeddings and summaries use configured Harness model aliases.
- License, vulnerability, provenance, lockfile, and SBOM checks use the repository release workflow. New package licenses are recorded in package metadata and release evidence.

## Runtime compatibility gate

All memory-engine packages must pass import, configuration, abort, close, and applicable engine-contract smoke tests under the repository's pinned Node.js and Bun versions. A package is not released with Bun support claimed until those commands pass in CI.

SQLite vector support is a separate matrix row from base SQLite support. `vector: true` enables extension loading only for the initialization window, verifies `vec_version()`, and disables further extension loading where the runtime permits. Base SQLite remains supported when native extension loading is unavailable. Bun on macOS reports an actionable `sqlite_vector_extension_unavailable` error with the documented `Database.setCustomSQLite(...)` remediation; it does not claim zero-config vector support on Apple SQLite.
