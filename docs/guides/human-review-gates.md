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
the execution claim and receipt around the final idempotent side-effect boundary.

Before a new claim, the application verifies current authorization, expiry,
revision, and the approved action digest. Atomic claim acquisition fixes the
execution key. If that claim already exists, resume the same execution and
return its stored receipt when complete; do not strand an admitted effect by
applying new authorization or expiry checks during recovery. A crash after the
domain effect but before receipt/checkpoint persistence must replay through
the same idempotent command key. The example tests each recovery window.

`ToolApprovalInterrupt` and `ToolApprovalResume` cover approval for one prepared
tool batch. Content rails cannot request approval or create a workflow wait.
See the [decision table](./decisions-and-approval.md) and
[composed agent example](../../examples/guardrails/README.md).

For a complete PURISTA application pattern—including safe queue handling of
`ExternalWaitPendingError`, authorization before a new claim, and observability—see
the official [Human Review Gates handbook page](https://purista.dev/handbook/harness/human-review-gates/).
