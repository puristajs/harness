# Naming and implementation conventions

## Public names

- Identity: `HarnessIdentity`, `tenantId`, `principalId`.
- Lifetime: `MemoryScopeKind`, `application`, `tenant`, `principal`, `session`, `run`, `agent`.
- Core extension point: `MemoryEngine`.
- Core composition result: `MemoryAdapter`.
- Engine-package factories: `sqliteMemoryEngine`, `postgresMemoryEngine`, `redisMemoryEngine`, and `natsMemoryEngine`.
- Local factory: `inMemoryMemoryEngine`.
- Typed configuration helper: singular `model`, producing `model.<alias>` symbolic references.
- Optional features: `embedding` and `summary`; no `profile`, provider id, strategy id, or duplicate alias string.

`user`, `userId`, `sandboxMemory`, `memory.search`, and arbitrary adapter-owned orchestration are removed from the revised public memory contract. There are no aliases or compatibility re-exports.

## Builder conventions

The builder supports exactly these forms:

```ts
defineHarness().models(models).memory(engine)

defineHarness().models(models).memory(({ model }) => ({
  engine,
  embedding: model.embeddingAlias,
  summary: model.summaryAlias,
}))
```

The callback is required only when a memory feature references a model alias. A plain configuration object is not accepted because it would force strings or untyped handles. Duplicate `.memory(...)` calls fail with the existing duplicate-adapter error pattern.

## Default conventions

- Omitted `.memory(...)`: `inMemoryMemoryEngine()` composed by core.
- Plain engine: key/value, list, delete, TTL, and engine-native text search only.
- `sqliteMemoryEngine({ file })`: durable local KV, list, TTL, and FTS5 with no third-party runtime dependency. `vector` defaults to `false`.
- `sqliteMemoryEngine({ file, vector: true })`: additionally requires `sqlite-vec` `0.1.9` and enables exact vector search. The option is explicit because it loads native extension code.
- `natsMemoryEngine({ servers })`: defaults the bucket to `purista-harness-memory-v1`, creates it when absent, and supports KV/list/delete/lazy TTL only. It never advertises text, semantic, or hybrid search.
- `embedding` omitted: no embedding calls and no semantic index.
- `summary` omitted: no summary calls.
- `embedding: model.<alias>`: dimensions initialize atomically from the first successful vector. An advanced `{ model, dimensions }` form pins and validates dimensions before engine write.
- Search mode omitted: `hybrid` when text and semantic search are effective, `semantic` when only semantic search is effective, and `text` when only text search is effective.
- Hybrid fusion: core reciprocal-rank fusion with constant `60`, unless the engine advertises native hybrid search.
- String writes are indexed when an indexing capability is effective. Structured JSON is not indexed without `index: { text }`.
- Summary refresh runs synchronously after each configured turn interval. The default interval is 20 completed user/assistant turns and the source window is the latest 50 complete turns. Summary failure does not change the already completed run; it emits a failed summary span, metric, structured error log, and diagnostic run event.

## Type conventions

- `model.<alias>` is a frozen branded data reference, never an active model handle.
- `MemoryEngine<Capabilities>` preserves each factory's readonly literal capability tuple. The memory configuration type accepts `embedding` only when that tuple contains `memory.vector_search`; a base SQLite or NATS engine therefore rejects embedding configuration at typecheck. Custom engines with widened/dynamic capabilities are also validated during Harness build.
- `embedding` accepts only a reference whose alias includes `embeddings`.
- `summary` accepts only a reference whose alias includes `object`.
- Literal model maps flow through the existing `const` builder generic.
- Public boundaries use closed TypeScript interfaces and `JsonValue`; `any`, `Record<string, unknown>`, and duplicated vendor representations are forbidden at public and persistence boundaries.
- Vendor packages import owner types from `@purista/harness` and export only their own engine options, factory, and package-specific diagnostics.
- The PostgreSQL package's PGlite executor is test-private. It is not exported, re-exported, or accepted by the public factory.
- Engine packages do not import PURISTA StateStore packages and do not re-export Harness helpers or contracts.

## Error and logging conventions

All configuration failures use `HarnessConfigError`; operation validation uses `ValidationError`; unavailable capability uses `ModelCapabilityError`; engine/database failures normalize to `StateError`; cancellation uses `OperationCancelledError`. Errors include safe `reason`, engine id, operation, and remediation metadata. Logs never contain connection strings, credentials, raw keys, values, queries, vectors, summaries, tenant ids, or principal ids.

SQLite uses `sqlite_vector_dependency_missing`, `sqlite_vector_extension_unavailable`, `sqlite_fts_unavailable`, and `sqlite_schema_incompatible` reasons. The first includes `npm install sqlite-vec@0.1.9`; the second identifies the unsupported runtime/platform and, for Bun on macOS, the `Database.setCustomSQLite(...)` requirement. NATS uses `nats_jetstream_unavailable`, `nats_bucket_incompatible`, and `nats_enumeration_limit_exceeded`. These failures are safe structured errors and logs, not raw driver messages.

## Testing conventions

The existing fake model provider supplies deterministic embeddings, structured summaries, token usage, provider/model metadata, errors, timeouts, and cancellation. `fakeMemoryEngine` and `memoryEngineContract` live under `@purista/harness/testing`. Production packages contain no fake, mock, stub, placeholder, or no-op runtime path.
