# Durable human review gates

Harness external waits are a provider-neutral checkpoint-and-signal primitive
for application-owned review processes. In production, configure one
`HarnessStorage` through `.storage(store)`; it supplies conversation, run/event,
lease, checkpoint, and external-wait persistence through one consistency
boundary.
Then invoke a workflow with a stable durable run id.
`ctx.externalWait.wait({ waitId, kind, schemaVersion, definitionVersion,
deadline })` persists only that safe subset. A pending wait throws
`ExternalWaitPendingError`, releases the lease, and leaves the run `waiting`.
After the application delivers one terminal `signalWait({ waitId, eventId,
outcome })`, invoke the same run id to resume. Completed `ctx.step` callbacks
replay instead of running again.

The application—not Harness—owns review CRUD, reviewer authentication,
authorization, decision content, action-digest binding, task revision CAS,
notifications, and the final idempotent domain command. Do not put proposal
text, tool input/output, comments, credentials, or reviewer IDs in the wait
request or telemetry attributes.

Use `InMemoryHarnessStorage` for deterministic unit tests. For local Node.js or
Bun development, `SqliteHarnessStorage` is a zero-dependency, single-host
implementation of the same contract. It is not a distributed production
backend. The adapter has terminal outcomes `approved`, `rejected`, `expired`,
and `cancelled`; duplicate/late event ids return typed no-op results.

See the executable [`durable-human-review` example](../../examples/durable-human-review/README.md)
for application task CAS, action-digest binding, terminal signal delivery, and
the final idempotent side-effect boundary.

For a complete PURISTA application pattern—including safe queue handling of
`ExternalWaitPendingError`, reauthorization on resume, and observability—see
the official [Human Review Gates handbook page](https://purista.dev/handbook/harness/human-review-gates/).
