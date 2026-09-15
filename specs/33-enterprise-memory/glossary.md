# Glossary

- **HarnessStorage**: authoritative transactional persistence for sessions, conversation history, runs, checkpoints, leases, events, and external waits.
- **MemoryAdapter**: core-owned orchestration layer for mutable recall and retrieval.
- **MemoryEngine**: database-specific persistence and query extension point consumed by core memory orchestration.
- **HarnessIdentity**: optional independent `tenantId` and `principalId` dimensions bound to a session.
- **MemoryScope**: identity plus a lifetime namespace such as application, session, run, or agent.
- **Model reference**: branded, frozen `model.<alias>` configuration value carrying the alias's compile-time capabilities.
- **Index descriptor**: persisted fingerprint of alias, provider, model, dimensions, distance metric, and extractor revision used to reject incompatible vectors.
- **Semantic search**: vector similarity search using an embedding alias configured through Harness.
- **Hybrid search**: combined text and semantic rankings, either engine-native or fused by core reciprocal-rank fusion.
- **Summary refresh**: opt-in model-backed creation of a provenance-bearing summary stored in memory without rewriting conversation history.
- **Principal**: one person or account; it can exist with or without a tenant.
- **Tenant**: one organization, group, company, or isolation domain; it can exist with or without a principal.
- **Application scope**: unqualified namespace used when neither tenant nor principal partitioning is required.
