# Recoverable Workflows, Feedback, And Operations

## Boundaries

- `HarnessStorage` owns sessions, messages, run records/events, leases,
  deterministic step checkpoints, and external waits.
- `DurableWorkspace` owns resumable filesystem snapshots.
- `Sandbox` owns execution and filesystem access.
- `MemoryEngine` owns scoped application, tenant, principal, session, run, and agent memory records.
- PURISTA's top-level `StateStore` remains ordinary framework application state;
  it is not a Harness adapter.

Do not add separate runtime, checkpoint, external-wait, or workspace-store
builder ports. Harness 3 deliberately exposes `.storage(...)` and optional
`.workspace(...)` only.

## Capabilities

Storage capabilities use the `storage.*` namespace:

- `storage.checkpoint`, `storage.resume`, `storage.retry`
- `storage.external_wait`
- `storage.persistent`, `storage.multi_instance`
- `storage.workspace_checkpoint`, `storage.checkpoint_retention`

Workspace capabilities use `workspace.*`, including `workspace.durable`,
`workspace.persistent`, `workspace.checkpoint`, `workspace.resume`,
`workspace.abort`, `workspace.cleanup`, `workspace.inspect`,
`workspace.retention`, `workspace.quota`, and
`workspace.encrypted_storage`.

Use `.requires(...)` for deployment invariants. In-memory adapters are for
tests/local work; `SqliteHarnessStorage` is persistent but single-host and does
not advertise `storage.multi_instance`.

## Local Node.js And Bun

```ts
import { defineHarness, localDurableExecution } from '@purista/harness'

const local = localDurableExecution({ root: './.harness', exec: false })

const harness = defineHarness({ name: 'report-worker' })
	.storage(local.storage)
	.workspace(local.workspace)
	.sandbox(local.sandbox)
	.requires(['storage.persistent', 'storage.checkpoint', 'storage.resume', 'workspace.persistent'])
	// models, agents, workflows
	.build()
```

The bundle returns exactly `{ storage, sandbox, workspace, close }`. It uses the
runtime's native SQLite support and adds no database dependency. It is for
development, tests, and one trusted process/host—not distributed production.

## Recoverable Workflow Steps

Only workflows support recoverable invocation:

```ts
const result = await session.workflows.report.run(input, {
	durable: { runId: `report:${input.reportId}:v1` },
})

// Inside the workflow handler:
const facts = await ctx.step('collect-facts-v1', () => collectFacts(ctx.input))
const draft = await ctx.step('draft-v1', () => ctx.agents.writer(facts))
```

A committed step returns its JSON output on resume without re-running its body.
Version a step id when its output contract or side-effect semantics change.
Keep external effects idempotent because a crash can occur after an external
commit and before the Harness checkpoint commits.

Run statuses are `running`, `waiting`, `interrupted`, `succeeded`, `failed`,
and `cancelled`. Only waiting/interrupted work is intended to resume; terminal
runs must not be acquired again. Storage must serialize a session, enforce lease
ownership, and atomically commit checkpoints.

## External Waits And Human Review

Inside a durable workflow, register only opaque bounded metadata:

```ts
const signal = await ctx.externalWait.wait({
	waitId: `payment:${ctx.input.paymentId}:review:v1`,
	kind: 'human_review',
	schemaVersion: '1',
	definitionVersion: 'payment-v3',
	deadline: new Date(Date.now() + 86_400_000).toISOString(),
})
```

A pending wait throws `ExternalWaitPendingError`; storage atomically marks the
run waiting and releases its lease. The application persists the review task,
authenticates and authorizes reviewers, binds the decision to an action digest,
and delivers one terminal signal:

```ts
await storage.signalWait({
	waitId,
	eventId: delivery.id,
	outcome: 'approved',
})
```

Then invoke the same workflow with the same durable run id. Signals are
idempotent and return `applied`, `duplicate`, `already_terminal`, or
`not_found`. Do not persist review text, tool payloads, reviewer identities, or
credentials in the wait record.

`ExternalWaitOutcome` is approved/rejected/expired/cancelled; it is distinct
from `ToolApprovalInterrupt` and `ToolApprovalResume`. Validate authorization, current revision,
expiry, and approved action digest only before acquiring a new atomic execution
claim. An existing claim resumes its original execution key and a completed
claim returns its stored receipt; never strand admitted effects with fresh
policy/expiry checks during recovery. The application invokes the domain command
idempotently and stores the execution receipt. Harness owns neither reviewer
CRUD nor the claim/receipt store. A crash between effect, receipt, and checkpoint
must remain safe to replay under that same binding.

## Production Adapters

Implement one shared `HarnessStorage` with transactional run acquisition,
checkpoint, wait, session-lock, retention, and deletion semantics. Do not wrap
a generic key/value state store. Verify it with:

```ts
import { durableWorkspaceContract, harnessStorageContract } from '@purista/harness/testing'

harnessStorageContract(() => createPostgresHarnessStorage(testDatabase))
durableWorkspaceContract(() => createObjectStorageWorkspace(testBucket))
```

Add backend-specific multi-process contention, lease expiry, migration,
encryption, outage, retention, and tenant-isolation tests.

## Observability And Privacy

Storage emits content-free `harness.storage.*` spans and operation/duration
metrics. Workspace emits `harness.workspace.*`. Correlate adapter, operation,
run/session, attempt, sequence, wait kind/outcome, duration, and normalized
errors where defined. Never record prompt text, checkpoint values, files, wait
ids, credentials, or reviewer data.

## Feedback And Readiness

Feedback remains an application-owned record and has an in-memory testing
recorder; core does not provide a production feedback database. Readiness
should fail when required storage/workspace capabilities are absent or a
persistent adapter cannot initialize. Application health checks should test the
configured backend without exposing content.

## Storage Schema Readiness

SQLite storage rejects incompatible schema layouts with
`HarnessConfigError` reason `sqlite_schema_incompatible`; it never silently
rewrites an existing database. Configure a database using the current storage
schema. Keep application business state in application-owned storage.
