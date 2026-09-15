# Operations runbook requirements

The implementation updates the existing Harness operations runbook and the PURISTA Handbook with these procedures:

1. Inspect effective engine, persistence, multi-instance, TTL, text, vector, hybrid, embedding, and summary capabilities through `harness.inspect()`.
2. Validate database connection and schema without model calls.
3. Run the explicit warmup probe and interpret model/provider/token/cost spans.
4. Diagnose missing FTS5, missing or blocked sqlite-vec, Bun/macOS custom-SQLite requirements, missing pgvector, missing Redis Search, missing JetStream, incompatible NATS bucket/namespace limits, incompatible index dimensions/fingerprint, unavailable model provider method, connection exhaustion, command timeout, query timeout, and cancellation.
5. Reindex through a versioned namespace with count verification, sampled query verification, switch, rollback window, and explicit old-namespace removal.
6. Configure expiry cleanup and verify expired records do not appear before physical cleanup.
7. Investigate summary failures through safe logs, run events, and traces without exposing source messages or summary content.
8. Size SQLite files/exact-vector workloads, PostgreSQL pools, Redis clients, and NATS bucket/replica/byte/key limits; calculate total deployment connections and NATS worst-case enumeration.
9. Back up and restore through SQLite file-safe backup or the database platform, then verify schema/bucket version, descriptor, record count, and applicable sampled scoped searches.
10. Prove tenant/principal isolation with canary records before production rollout.
11. Export SBOM/provenance and review direct dependency license and vulnerability evidence.
12. Roll back application code without changing data only when the prior release shares the same clean contract and descriptor.
13. Verify the SQLite native extension allow-list and `vec_version()` before enabling vectors; disable further extension loading after initialization where supported.
14. Run routine PostgreSQL adapter tests with package-private PGlite, and interpret the mandatory release-only real PostgreSQL/pgvector contract as the evidence for pools, concurrency, planner, network, and production extension behavior.

Every procedure names the command or API, expected success evidence, safe failure metadata, recovery action, and escalation owner. Connection strings, values, identities, vectors, queries, and model content never appear in copied incident evidence.
