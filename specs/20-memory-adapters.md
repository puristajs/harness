# Memory adapters

**Status:** superseded by the approved clean-break specification in
[33-enterprise-memory](./33-enterprise-memory/00-vision.md).

The numbered feature folder is the sole implementation source for:

- core-owned memory orchestration and the `MemoryEngine` vendor extension point;
- zero-config in-memory behavior;
- independent optional `tenantId` and `principalId` session identity;
- application, tenant, principal, session, run, and agent scopes;
- capability-typed `model.<alias>` references for embeddings and summaries;
- text, semantic, and hybrid search;
- SQLite, PostgreSQL, Redis, and NATS engine packages, with optional sqlite-vec and container-free PGlite development tests;
- OpenTelemetry, token and cost attribution, testing, PURISTA integration, migration, documentation, and release gates.

The previous `sandboxMemory()`, `user` scope, external orchestration adapter,
generic `memory.search` capability, and string/profile model configuration are
unreleased legacy design and have no compatibility requirement.
