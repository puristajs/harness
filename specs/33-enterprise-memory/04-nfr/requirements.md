# Non-functional requirements

## Security and privacy

- Identity scope is mandatory inside every engine key and query predicate. Tenant/principal filtering precedes ranking.
- Scope keys use length-prefixed canonical encoding and a SHA-256 fingerprint; concatenation with an unescaped separator is forbidden.
- Values, index text, embeddings, summaries, query text, raw keys, tenant ids, principal ids, connection strings, SQL parameters, Redis commands, and credentials are content or sensitive data.
- `NO_CONTENT` emits none of those values. Existing explicit content-capture modes govern only core span capture and never connection credentials or vectors.
- Embeddings are classified as sensitive derived data and follow the source record's retention and deletion.
- The Harness does not authorize tenant/principal access. The application must authenticate and authorize before calling `getSession`.
- All SQL is parameterized. Redis key material is encoded by one owner helper. Dynamic schema, table, and index names pass strict identifier validation.

## Observability

- Core operation spans use existing Harness context, cancellation, error normalization, and content policy.
- Search and summary model calls use existing `ModelHandle` methods. Their standard GenAI spans include provider system, requested model, response model, input/output/cached/reasoning tokens, and cost attributes when the provider returns them.
- The memory parent records operation, engine id, effective mode, scope kind, hit/result count, index enabled, and safe error type. It does not duplicate token or cost metrics.
- Summary success and failure are observable even though summary failure does not reverse the completed run.
- Metrics exclude high-cardinality identity, session, run, key, query, alias, model, and error-message values.

## Performance and capacity

- Default list/search limit is 20 and maximum is 100. Pagination is mandatory for larger reads.
- Embedding writes batch only within one caller operation; core does not maintain an unbounded queue.
- Hybrid fusion accepts at most `min(limit * 3, 300)` candidates from each ranking.
- Summary reads at most 50 complete turns by default and validates a hard maximum of 200.
- Index text maximum is 32000 characters and query text maximum is 8000 characters.
- PostgreSQL uses one bounded pool supplied or created by the adapter. Redis uses one supplied or created client with explicit close ownership.
- SQLite uses one connection and serializes writes in-process; its docs set local/single-host capacity expectations. NATS list operations reject a namespace above `maxEnumeratedKeys` instead of loading an unbounded key set.
- Vendor docs provide index sizing, pool/connection sizing, timeout budgets, cleanup cadence, and capacity warnings. Benchmark evidence records p50, p95, and p99 for write and each search mode at 10k, 100k, and 1m synthetic records; no universal latency SLO is claimed from local benchmarks.
- SQLite benchmark evidence stops at the package's documented local capacity and separately records FTS5 and exact sqlite-vec scaling. NATS evidence records KV latency and enumeration cost at 10k and the configured limit; it does not run or claim search benchmarks.

## Integrity, consistency, and recovery

- Indexed writes are atomic from the reader's perspective.
- Index descriptor initialization is compare-and-set and immutable while records exist in the namespace.
- A descriptor mismatch never triggers silent rebuild, truncation, or downgrade.
- Summary provenance includes exact source ids and digest; history remains unchanged.
- Delete and expiry remove or hide every representation consistently.
- Engine contract tests inject failure between logical write phases and prove rollback/no partial visibility.
- PostgreSQL migrations are forward-only and transactionally applied where PostgreSQL permits. Redis index schema changes use a new versioned namespace.
- SQLite schema migration is forward-only and rejects unknown/newer schemas. NATS uses a versioned bucket name and rejects an existing incompatible bucket configuration without destructive recreation.
- Backup/restore is owned by the database platform. Adapter runbooks define post-restore descriptor and query verification.

## Production readiness

- Readiness checks validate connection, schema version, effective engine capabilities, and configured index descriptor without making a model call.
- Optional `warmupMemory()` performs an explicit embedding and search probe; it is never automatic.
- Liveness does not depend on external model or database calls. Readiness can depend on the configured database when the application chooses strict startup.
- Shutdown closes only clients created by the engine. Injected clients remain caller-owned.
- Rollout supports old application instances only when they use the same clean contract and descriptor. The unreleased legacy contract has no mixed-version guarantee.
- Runbooks cover connection exhaustion, index mismatch, FTS5/sqlite-vec absence, native extension policy, pgvector absence, Redis Search absence, NATS JetStream/bucket/enumeration limits, timeout, cancellation, summary failure, reindex, cleanup, backup, restore, rollback, and incident evidence.

## Runtime and supply chain

- Node.js and Bun execute identical TypeScript output.
- CI tests package imports and core unit tests in both runtimes. Live database contract tests run under Node.js and Bun before release.
- Direct production dependencies are limited to `pg` in PostgreSQL, `redis` in Redis, and the official modular NATS v3 packages in NATS. SQLite has only the optional `sqlite-vec` peer. PGlite and its pgvector extension are PostgreSQL package development dependencies and must be absent from its published dependency graph and tarball runtime surface.
- Lockfile, vulnerability, license, secret scan, SBOM, provenance attestation, package-content inspection, and release signing follow repository policy. sqlite-vec's native platform artifacts receive package-integrity, provenance, platform-matrix, and extension-version evidence before release.
- No downloaded model, sidecar, container base image, or cloud credential is introduced. Native extension code is loaded only by explicit SQLite `vector: true`; otherwise no native addon is loaded.
