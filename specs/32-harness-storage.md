# Harness Storage Consolidation

Status: approved clean-break implementation specification.

Date: 2026-08-24

This specification replaces the public persistence architecture in
`04-state-queue-stream.md`, `13-public-api.md`, `21-durable-workspaces.md`, and
`22-local-durable-execution.md` wherever those files expose `StateStore`,
`DurableRuntime`, `ContextCheckpointStore`, `DurableExternalWaitAdapter`, or
multiple builder bindings for Harness-owned structured execution data.

There is no compatibility requirement. The affected AI APIs are unreleased.
Legacy names, aliases, forwarding methods, deprecated exports, duplicate
tables, and compatibility shims must be deleted.

## 1. Outcome

An application configures exactly one Harness-owned structured persistence
adapter:

```ts
const storage = sqliteHarnessStorage({ file: '.purista/harness.sqlite' })

const harness = defineHarness({ name: 'support' })
  .storage(storage)
  .models(models)
  .agents(({ agent }) => ({ /* ... */ }))
  .workflows(({ workflow }) => ({ /* ... */ }))
  .build()
```

`HarnessStorage` owns sessions, conversation messages, one authoritative run
record, persisted run events, durable step checkpoints, run/session leases,
and external wait/signal state. These are one transactional consistency
boundary and are never independently configured by an application.

## 2. Boundaries

The following concepts remain separate because their semantics, lifecycle, or
backends differ:

| Concept | Owner | Reason |
| --- | --- | --- |
| PURISTA `StateStore` | `@purista/core` | General application/service key-value state used by AI and non-AI code. It is unchanged by this specification. |
| `HarnessStorage` | `@purista/harness` | Harness conversations and recoverable execution state. |
| `MemoryAdapter` | `@purista/harness` | Optional mutable run/session/agent/user/tenant recall, TTL, and semantic search. |
| `Sandbox` | `@purista/harness` | Active filesystem and process lifecycle. |
| `DurableWorkspace` | `@purista/harness` | Optional durable file snapshots, quotas, retention, and encryption metadata. |
| Review/domain records | Application service | Authorization, reviewer identity, evidence, revisions, expiry, and business invariants. |

The PURISTA `StateStore` MUST NOT be expanded with Harness operations and MUST
NOT be automatically adapted to `HarnessStorage`. Its `getState`, `setState`,
and `removeState` contract does not promise the append ordering, transactions,
leases, compare-and-set, range queries, or idempotent signals required by
Harness execution. A deployment may use the same physical database for both
contracts through separate adapters.

## 3. Public configuration

The Harness builder exposes:

```ts
interface HarnessBuilder<S extends BuilderState = {}> {
  storage(storage: HarnessStorage): HarnessBuilder<S>
  memory(adapter: MemoryAdapter): HarnessBuilder<S>
  sandbox(sandbox?: Sandbox<any>): HarnessBuilder<S>
  workspace(workspace: DurableWorkspace): HarnessBuilder<S>
}
```

The default is `inMemoryHarnessStorage()`. It is process-local and suitable for
tests and development. It does not advertise persistence or multi-instance
coordination.

The following builder methods are removed:

- `.state(...)`
- `.runtime(...)`
- `.checkpoints(...)`
- `.externalWait(...)`
- `.workspaceStore(...)`

`HarnessInspection` reports one `storage` adapter and, when present, separate
`memory`, `sandbox`, and `workspace` adapters. It does not report storage's
internal execution/wait facets as independently configured adapters.

## 4. Storage contract

The supported application-facing type is `HarnessStorage`. Internal operation
groups may be split into focused source files, but the application receives and
passes one object. The adapter guarantees one consistency boundary across its
run lifecycle operations.

The contract covers:

1. Session create/read/update/delete.
2. Ordered message append/list/replace/delete.
3. One run create/read/list/transition model.
4. Ordered event append/list.
5. Durable run acquisition, lease release, and attempt tracking.
6. Durable step checkpoint read/commit.
7. External wait registration/read/signal/cancel bound to a run and session.
8. Idempotent close and Harness adapter-context configuration.

Every implementation MUST pass `harnessStorageContract` from
`@purista/harness/testing`. There are no partial conversation-only storage
adapters. Differences between in-memory, local persistent, and distributed
implementations are guarantees represented by storage capabilities, not
missing methods.

## 5. One run model

`RunRecord` is the sole run source of truth. It contains ordinary run metadata
and durable attempt/lifecycle metadata. A storage backend MUST NOT create a
second durable-run record or table.

Statuses are:

- `running`: an attempt owns or is acquiring execution;
- `waiting`: execution is safely suspended for an external signal;
- `interrupted`: a durable attempt stopped and the same run may resume;
- `succeeded`: terminal success;
- `failed`: terminal failure;
- `cancelled`: terminal cancellation.

Only `waiting` and `interrupted` may resume. `succeeded`, `failed`, and
`cancelled` reject acquisition. A non-durable execution failure becomes
`failed`; a durable execution failure becomes `interrupted` unless explicitly
terminalized by the caller/runtime policy.

Run transitions, lease changes, and associated wait registration MUST be
transactional when they are part of one operation. There is one terminal/run
transition method; there are no two `finishRun` patch types or union overloads.

## 6. Durable steps and waits

`ctx.step(...)` remains the public durable replay primitive. Its checkpoints
are storage-owned implementation records linked to the authoritative run.

`ctx.externalWait.wait(...)` remains the public provider-neutral suspension
primitive. Application code supplies only:

```ts
{
  waitId: string
  kind: string
  schemaVersion: string
  definitionVersion: string
  deadline: string
}
```

The Harness adds `runId` and `sessionId` before storage. Registering a new wait
atomically marks the run `waiting` and releases its lease. Signalling is
idempotent by `(waitId, eventId)`. A terminal signal does not itself execute
application code; the application enqueues or invokes the same logical run.

Storage operations for waits are not independently injectable. Public signal
operations are available through the configured Harness storage handle or a
small Harness-owned signalling facade returned by the application composition
root; they are not a second adapter.

## 7. Context checkpoint removal

The following are removed:

- `ContextCheckpoint`
- `ContextCheckpointRef`
- `ContextCheckpointQuery`
- `ContextCheckpointStore`
- `ContextCheckpointStoreInfo`
- `ContextCheckpoints`
- `ctx.checkpoints`
- `.checkpoints(...)`
- `harness_context_checkpoints`
- all `context_checkpoint.*` capabilities, spans, metrics, docs, and factories

Use the existing primitive that matches the requirement:

- deterministic replay output: `ctx.step(...)`;
- mutable session/user/tenant recall: `ctx.memory`;
- conversation context: session history;
- business handoff/evidence: application state and typed PURISTA commands.

The Harness does not prescribe application vocabulary such as `summary`,
`handoff`, or `goal_state`.

## 8. Workspace and local execution

The durable workspace port is renamed to `DurableWorkspace` and configured
through `.workspace(...)`. It remains separate from structured storage because
it manages files, snapshots, byte quotas, cleanup, retention, and encryption
metadata.

The local bundle is:

```ts
interface LocalDurableExecution {
  storage: HarnessStorage
  sandbox: LocalDurableSandbox
  workspace: DurableWorkspace
  close(): Promise<void>
}
```

The only primary local storage exports are:

- `InMemoryHarnessStorage`
- `inMemoryHarnessStorage`
- `SqliteHarnessStorage`
- `sqliteHarnessStorage`
- `localDurableExecution`
- `LocalDirectoryWorkspace`
- `localDirectoryWorkspace`
- `localDirectorySandbox`

Delete all legacy state/runtime/checkpoint/wait factories and aliases. The
SQLite schema contains `harness_sessions`, `harness_messages`, `harness_runs`,
`harness_run_events`, `harness_run_checkpoints`, `harness_run_leases`,
`harness_external_waits`, and `harness_external_wait_signals`. It does not
contain `harness_durable_runs` or `harness_context_checkpoints`.

SQLite is local/single-host only. It advertises persistence but not
multi-instance coordination. In-memory storage advertises neither. A future
production adapter must pass the same contract suite and advertise its exact
distributed guarantees.

## 9. PURISTA integration

PURISTA keeps its existing top-level `stateStore` runtime option unchanged.
Harness configuration becomes:

```ts
type AgentRuntimeOptions<Models> = {
  models: AgentRuntimeModelBindings<Models>
  storage?: HarnessStorage
  memory?: MemoryAdapter
  sandbox?: Sandbox<any>
  workspace?: DurableWorkspace
  onSuspended?: (notice: AgentSuspendedNotice) => Promise<unknown> | unknown
  logger?: PuristaLogger
  telemetry?: TelemetryOptions
  governance?: GovernanceConfig<any>
}
```

Remove `ai.stateStore`, `ai.runtime`, `ai.externalWait`, `ai.workspaceStore`,
and `ai.durableWorkflows`. Core passes one `ai.storage` to `.storage(...)`.

Durability is declared on `AgentQueueBuilder`, never as a deployment boolean:

```ts
.setDurability({
  mode: 'required',
  runIdPath: ['reviewRunId']
})
```

`runIdPath` resolves a non-empty application-owned stable identifier from the
validated payload. PURISTA namespaces it by service version and agent. Queue
retries and later approval-triggered enqueues with the same identifier reuse
the same Harness run even when the queue job id changes. A durable workspace
policy implies required durability. Startup fails when required storage or
workspace guarantees are absent.

PURISTA review/domain records remain ordinary application state and commands.
They are never stored in `HarnessStorage` except for the bounded opaque wait
reference.

## 10. Observability

Existing model/tool/guardrail semantic-convention spans and token accounting
remain unchanged. Storage operations emit content-free short spans and metrics
under `harness.storage.*` with operation, adapter id, persistence scope, run
status, attempt, and safe correlation identifiers. They never include prompts,
messages, inputs, outputs, checkpoint payloads, wait content, reviewer identity,
file paths, or credentials.

Expected enforcement decisions and waiting transitions do not mark spans as
errors. Storage failures do. No span remains open while a workflow waits for a
human or external system.

Remove `harness.runtime.*` and `harness.context_checkpoint.*` storage operation
names after their `harness.storage.*` replacements are tested and documented.

## 11. Testing and drift gates

Implementation is incomplete until all of the following pass:

1. Public API/type tests prove `.storage(...)`/`.workspace(...)` and prove every
   removed symbol/method is absent.
2. `harnessStorageContract` passes for in-memory and SQLite implementations.
3. SQLite rebuild tests prove history, one run record, attempt increments,
   checkpoint replay, wait suspension/signal/resume, lease takeover, and
   idempotent close.
4. Schema inspection proves forbidden legacy tables are not created.
5. Failure tests prove durable errors become resumable `interrupted` runs and
   terminal statuses cannot resume.
6. PURISTA tests prove top-level `stateStore` remains unchanged, `ai.storage`
   wiring works, stable payload-derived run ids survive new queue job ids, and
   missing required capabilities fail startup.
7. Examples compile and exercise standalone and PURISTA durable review paths.
8. Harness docs, README, package inventory, public website, Handbook, and
   canonical skills use only the new names and explain the four data concepts.
9. Repository-wide searches contain no legacy public identifiers except this
   specification's explicit removal lists and historical migration evidence.
10. Harness/PURISTA builds, type tests, unit/integration tests, documentation
    link checks, `audit:skills`, and `audit:knowledge` pass.

## 12. Release

This is an unreleased clean break. No runtime compatibility migration, alias,
or deprecation period is provided. Development SQLite databases from the old
branch schema are disposable; the new adapter rejects an incompatible schema
version with a safe remediation telling the developer to recreate the local
database. Production data migration is not applicable because SQLite is not a
supported production multi-instance backend and the affected API has not been
released.
