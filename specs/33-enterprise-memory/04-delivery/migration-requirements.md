# Clean-break delivery requirements

Memory behavior is declared once on each agent and the engine is bound once at
Harness instance creation. The implementation ships only this v4 contract. It
contains no deprecated aliases, compatibility overloads, alternate runtime
configuration route, forwarding export, or automatic data conversion.

The process-local engine remains the zero-configuration baseline. SQLite,
PostgreSQL, Redis, and NATS packages start at schema or namespace version `v1`.
Their assets never inspect or mutate unrelated application files, tables, keys,
or buckets. SQLite memory defaults in documentation to
`.purista/memory.sqlite`, separate from HarnessStorage's
`.purista/harness.sqlite`.

Reindexing creates a new namespace, verifies count and representative queries,
switches explicit application configuration, and removes the old namespace only
through an operator action after the rollback window. No release code scans for
or imports data from an earlier pre-release memory shape.

Release acceptance requires public-export tests, one current API shape across
package READMEs, Harness docs, PURISTA handbook, examples and skills, and
tarball inspection proving that engine dependencies do not leak into core.
PGlite remains test-only and `sqlite-vec` remains optional for base SQLite
consumers.
