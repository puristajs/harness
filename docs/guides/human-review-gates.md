# Durable human review gates

Harness external waits are a provider-neutral checkpoint-and-signal primitive
for application-owned review processes. Configure `.runtime(...)` and
`.externalWait(...)`, then invoke a workflow with a stable durable run id.
`ctx.externalWait.wait({ waitId, kind, schemaVersion, definitionVersion,
deadline })` persists only that safe subset. A pending wait throws
`ExternalWaitPendingError`, releases the lease, and leaves the run `waiting`.
After the application delivers one terminal `signal({ waitId, eventId,
outcome })`, invoke the same run id to resume. Completed `ctx.step` callbacks
replay instead of running again.

The application—not Harness—owns review CRUD, reviewer authentication,
authorization, decision content, action-digest binding, task revision CAS,
notifications, and the final idempotent domain command. Do not put proposal
text, tool input/output, comments, credentials, or reviewer IDs in the wait
request or telemetry attributes.

Use `inMemoryExternalWait()` for deterministic tests and
`localDurableExecution().externalWait` for SQLite-backed Node.js/Bun local
execution. The adapter has terminal outcomes `approved`, `rejected`, `expired`,
and `cancelled`; duplicate/late event ids return typed no-op results.

See the executable [`durable-human-review` example](../../examples/durable-human-review/README.md)
for application task CAS, action-digest binding, terminal signal delivery, and
the final idempotent side-effect boundary.

For a complete PURISTA application pattern—including safe queue handling of
`ExternalWaitPendingError`, reauthorization on resume, and observability—see
the official [Human Review Gates handbook page](https://purista.dev/handbook/harness/guide/human-review-gates/).
