# Capability inventory

| Capability ID | User-facing outcome | Entry point | Failure behavior | Verification |
| --- | --- | --- | --- | --- |
| CAP-MEM-DX | Configure no memory, an engine, or typed model-backed memory with autocomplete | `defineHarness().memory(...)` | Wrong model capability and statically incompatible engine/model combinations are type errors; unavailable dynamic database capability is a build error | type tests and builder tests |
| CAP-MEM-IDENTITY | Isolate memory and session state for application, tenant, principal, or both | `harness.getSession(id, identity?)` and scoped memory handles | Identity mismatch and missing required dimension fail before runtime I/O | storage and facade contract tests |
| CAP-MEM-ENGINE | Reuse one core orchestration path across database engines | `MemoryEngine` and core composition | Partial or falsely advertised capability fails contract/build validation | engine contract tests |
| CAP-MEM-SEARCH | Retrieve by text, semantic, or hybrid relevance with time and metadata filters | `session.memory.search(query)` | Explicit unavailable mode and index mismatch fail without downgrade | deterministic and live engine tests |
| CAP-MEM-SUMMARY | Maintain an opt-in provenance-bearing conversation summary | `summary: model.<alias>` | Summary failure is visible and does not reverse a completed run | fake model and session integration tests |
| CAP-MEM-OTEL | Attribute memory operations and nested model tokens/cost without content leaks | normal Harness telemetry configuration | Model errors and engine errors preserve parent-child spans and safe metadata | telemetry snapshot tests |
| CAP-MEM-SQLITE | Persist and search memory locally with built-in SQLite; opt into exact vectors only when needed | `sqliteMemoryEngine({ file, vector? })` | Missing FTS5, optional dependency, native-extension support, schema, or vector dimension fails with runtime/platform remediation | Node/Bun schema, restart, FTS5, sqlite-vec, and contract tests |
| CAP-MEM-POSTGRES | Use distributed PostgreSQL persistence, text search, pgvector, TTL filtering, and atomic writes | `postgresMemoryEngine(options)` | Migration, extension, transaction, dimension, and connection failures are actionable | package and live PostgreSQL tests |
| CAP-MEM-REDIS | Use distributed Redis persistence, text/vector search, TTL, and atomic indexed writes | `redisMemoryEngine(options)` | Index, command, transaction, dimension, and connection failures are actionable | package and live Redis tests |
| CAP-MEM-NATS | Reuse a NATS estate for distributed scoped KV memory without claiming relevance search | `natsMemoryEngine(options)` | Missing JetStream, incompatible bucket, enumeration limit, conflict, connection, and cancellation failures are actionable | NATS KV contract, restart, multi-instance, Node/Bun tests |
| CAP-MEM-PURISTA | Reuse PURISTA message identity and configured models in attached agents/workflows | `service.getInstance(..., { ai: { models, memory } })` | Missing required model binding or identity mismatch fails at startup/ingress | PURISTA type and runtime tests |
| CAP-MEM-MIGRATION | Adopt the clean API with no stale names or duplicated docs | migration guide and package exports | Legacy imports and methods fail typecheck | public API, stale-text, docs, skill, and website audits |

## Feature matrix

| End-user feature | Default in-memory | SQLite | SQLite + sqlite-vec | PostgreSQL | Redis | NATS KV |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Read, write, delete JSON memory | yes | yes | yes | yes | yes | yes |
| List with cursor and prefix | yes | yes | yes | yes | yes | yes; bounded O(namespace keys) enumeration |
| TTL visibility | yes | yes | yes | yes | yes | yes |
| Physical expiry cleanup | lazy | lazy/explicit SQL cleanup | lazy/explicit SQL cleanup | query filter plus operator cleanup | native expiry | lazy on access; bucket limits bound untouched expired values |
| Application scope | yes | yes | yes | yes | yes | yes |
| Tenant scope | yes | yes | yes | yes | yes | yes |
| Principal scope | yes | yes | yes | yes | yes | yes |
| Tenant-qualified principal scope | yes | yes | yes | yes | yes | yes |
| Session, run, and agent scope | yes | yes | yes | yes | yes | yes |
| Metadata, tag, and time filters for relevance search | yes | yes | yes | yes | yes | no relevance search |
| Text relevance search | deterministic substring ranking | SQLite FTS5 | SQLite FTS5 | PostgreSQL FTS | Redis Search | no |
| Semantic search | with configured embedding model | no | exact sqlite-vec KNN with configured embedding model | pgvector with configured embedding model | Redis vector index with configured embedding model | no |
| Approximate nearest-neighbor index | no | no | no; exact local search only | HNSW/IVFFlat when configured | Redis vector index when configured | no |
| Hybrid search | core reciprocal-rank fusion | no | core reciprocal-rank fusion | native path when proven, otherwise core fusion | native path when proven, otherwise core fusion | no |
| Automatic string indexing | yes | yes | yes | yes | yes | no |
| Explicit structured-value index text | yes | yes | yes | yes | yes | no |
| Conversation summary refresh | with configured object model | with configured object model | with configured object model | with configured object model | with configured object model | with configured object model |
| Persistent across process restart | no | yes | yes | yes | yes | yes with file-backed JetStream |
| Multi-instance coordination | no | no | no | yes | yes | yes with replicated JetStream |
| Requires a separately running database | no | no | no | yes | yes | yes |
| Required third-party runtime dependency | none | none | `sqlite-vec` optional peer | `pg` | `redis` | official modular NATS v3 packages |
| Node.js | yes | yes | supported platform binaries | yes | yes | yes |
| Bun | yes | yes | yes where native extension loading is supported; macOS needs custom SQLite | yes | yes after package gate | yes after package gate |

The table describes observable features, not database implementation details. A model-backed row is enabled only by typed Harness model configuration.
