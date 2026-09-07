# Enterprise memory orchestration

## Outcome

PURISTA applications gain durable, searchable AI memory without a second model-provider abstraction or a generic database wrapper. `@purista/harness` owns identity scoping, validation, model orchestration, search fusion, summary refresh, telemetry, errors, and the public facade. Vendor packages own only database-specific persistence and query execution.

The default path requires no memory configuration. The Harness creates a dependency-free process-local engine. An application changes only the engine for local SQLite, distributed PostgreSQL, Redis, or NATS KV. Embedding and summarization are opt-in because they create model calls and cost; SQLite native vector loading is separately explicit.

## User-facing API

```ts
const assistant = defineAgent('assistant', {
  model: 'assistant',
  instructions: 'Help the customer.',
  memory: {
    capabilities: [
      'memory.kv',
      'memory.text_search',
      'memory.vector_search',
      'memory.hybrid_search',
      'memory.persistent',
    ],
    embedding: { model: 'memoryEmbedding' },
    summary: { model: 'memorySummary' },
  },
})

const definition = defineHarness({ name: 'support' }).addAgent(assistant)
const runtime = await definition.getInstance({
  models: {
    assistant: { provider, model: 'chat-model' },
    memoryEmbedding: { provider, model: 'embedding-model' },
    memorySummary: { provider, model: 'summary-model' },
  },
  memory: postgresMemoryEngine({ connectionString: process.env.DATABASE_URL! }),
})

const session = await runtime.getSession('conversation-42', {
  identity: { tenantId: 'acme', principalId: 'person-7' },
})

await session.memory.write('preferred_locale', 'de-DE')
await session.memory.write('case', { id: 'CASE-42' }, { index: { text: 'Support case CASE-42' } })
const matches = await session.memory.search({ text: 'Which support case is active?' })
```

`getInstance({ memory: postgresMemoryEngine(...) })` is the minimal production
binding when an agent declares persistent memory without model-backed features.
The binding is omitted for tests, local development, and graphs whose declared
memory requirements fit the process-local default.

Local durable use is `sqliteMemoryEngine({ file: '.purista/memory.sqlite' })`. Adding `vector: true` opts into the separately installed `sqlite-vec` peer and exact local vector search. `natsMemoryEngine(...)` is a distributed KV-only choice for existing NATS installations and intentionally has no relevance-search capability.

## Product boundaries

- `HarnessStorage` remains the transactional source for sessions, messages, runs, events, checkpoints, leases, and external waits.
- `MemoryAdapter` remains mutable recall and retrieval; it does not become the execution store, review database, audit archive, authorization service, or analytics warehouse.
- PURISTA `StateStore` remains the framework-standard application state component for AI and non-AI business state.
- Tenant and principal values scope data. They do not authenticate or authorize a caller.
- Full administrative search, legal hold, audit export, and approval work queues remain application or storage-product concerns. This scope adds no speculative query language for them.

## Success criteria

- Definitions infer exact memory model aliases and capabilities; missing aliases
  are type errors at instance creation and incompatible providers fail before
  runtime resources start.
- Missing runtime provider methods, index incompatibility, identity mismatch, and engine capability mismatch fail before unsafe database work.
- Tenant filtering occurs inside the engine query before ranking.
- Every model call made for memory uses the normal provider adapter, span conventions, token usage, and cost attribution path.
- Node.js and Bun run the same public packages and contract suite.
- No compatibility aliases, legacy `user` scope, forwarding exports, strategy package, scheduler, worker, or hidden background model calls are introduced.

## Source discipline

This folder is the single source of truth for the clean-break memory revision. Parent spec `../20-memory-adapters.md` points here and does not duplicate these contracts. The implementation plan must cite anchored sections from this folder.

Requirement traceability is keyed by requirement ID, capability ID, path ID,
acceptance ID, verification method, owner, priority, and risk in
`00-traceability.yaml` and the implementation tickets.
