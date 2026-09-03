# Local Durable Execution

Status: approved v3 implementation specification.

Date: 2026-08-24

## 1. Outcome

Core provides a zero-third-party-runtime-dependency local bundle for tests,
development, and single-host Node.js/Bun deployments:

```ts
const local = localDurableExecution({ root: '.purista/local' })

const harness = defineHarness()
  .storage(local.storage)
  .sandbox(local.sandbox)
  .workspace(local.workspace)
  .models(models)
  .workflows(workflows)
  .build()
```

It combines one native SQLite `HarnessStorage`, one host-directory
`DurableWorkspace`, and one workspace-bound local sandbox. It does not create
parallel persistence ports or adapt a generic key/value store.

## 2. Public API

```ts
interface LocalDurableExecutionOptions {
  root: string
  databaseFile?: string
  workerId?: string
  exec?: false | LocalHostExecPolicy
  policy?: Partial<DurableWorkspacePolicy>
  leaseTtlMs?: number
}

interface LocalDurableExecution {
  storage: HarnessStorage
  sandbox: LocalDurableSandbox
  workspace: DurableWorkspace
  close(): Promise<void>
}

function localDurableExecution(options: LocalDurableExecutionOptions): LocalDurableExecution
function sqliteHarnessStorage(options: SqliteHarnessStorageOptions): HarnessStorage & { close(): Promise<void> }
function localDirectoryWorkspace(options: LocalDirectoryWorkspaceOptions): DurableWorkspace
function localDirectorySandbox(options: LocalDirectorySandboxOptions): LocalDurableSandbox
```

Primary class exports are `SqliteHarnessStorage` and
`LocalDirectoryWorkspace`. The removed v2 factories and aliases are not
exported. `close()` is idempotent.

## 3. Runtime support and dependencies

SQLite uses only the runtime's built-in driver:

- Node.js `node:sqlite` on the package's supported Node engine;
- Bun `bun:sqlite` when running under Bun.

No SQLite npm package is a dependency or optional dependency. If the runtime
driver is unavailable, construction throws `HarnessConfigError` with reason
`sqlite_unavailable` and a message naming the supported runtime requirement.
The error must not suggest installing a hidden package.

The default database is `${root}/runtime.sqlite`. Parent directories are
created. SQLite uses WAL mode, foreign keys, a bounded busy timeout, and
`BEGIN IMMEDIATE` for multi-record lifecycle transactions.

## 4. Canonical schema

The database contains only:

- `harness_sessions`
- `harness_messages`
- `harness_runs`
- `harness_run_events`
- `harness_run_checkpoints`
- `harness_run_leases`
- `harness_external_waits`
- `harness_external_wait_signals`

`harness_runs` is the sole run source of truth. The adapter must not create a
second durable-run table or a general context-checkpoint table. On startup it
detects the incompatible v2 schema and throws
`HarnessConfigError{meta.reason:'sqlite_schema_incompatible'}` with remediation
to create a fresh development database. There is no silent migration or
partial compatibility path.

## 5. Storage semantics

`SqliteHarnessStorage` implements the complete `HarnessStorage` contract:

- ordered, atomic message/event writes and cursor pagination;
- atomic history replacement;
- authoritative run transitions and attempt increments;
- one active run and session lease per storage boundary;
- lease expiry/takeover and checkpoint heartbeats;
- deterministic step checkpoint idempotency;
- transactional wait registration that marks the run `waiting` and releases
  its lease;
- idempotent external signals keyed by `(waitId, eventId)`;
- session deletion that removes all owned history, runs, events, checkpoints,
  leases, waits, and signal deduplication rows.

It advertises persistence and local durable capabilities, but not
`storage.multi_instance`. SQLite locking protects processes sharing one local
database file; this is not a supported distributed/multi-host topology.

## 6. Local workspace layout

All local workspace material stays below the resolved `root`:

```text
root/
  runtime.sqlite
  active/<opaque-workspace-ref>/
  checkpoints/<opaque-checkpoint-ref>/
```

References are opaque validated identifiers. Every operation resolves and
realpath-checks the target against its expected root. Traversal, absolute-path
injection, symlink escape, special files, and cross-run/session ownership
mismatch fail closed. Cleanup never accepts a broad root, unresolved glob, or
caller-controlled host path.

Pause creates a replayable checkpoint before Harness commits its reference to
storage. Resume reconstructs or rebinds the active directory. Abort and cleanup
are idempotent and never delete outside the validated workspace roots.

## 7. Sandbox and execution policy

The default sandbox provides files and bounded text search only. Host command execution is disabled unless
`exec` is explicitly configured. Enabling it must:

- restrict `cwd` to the active workspace;
- reject traversal and symlink escape;
- use an allowlist/denylist policy with deny taking precedence;
- apply timeout, output, environment, and process limits;
- avoid inheriting secrets or an unrestricted host environment;
- report `sandbox.exec` only when execution is actually enabled.

The bundle shares a coordinator between sandbox and workspace so a durable run
cannot accidentally access a different session's directory. Binding is
released on success, suspension, interruption, cancellation, and setup error.
The private binding claims the active workspace for the full sandbox scope,
including session incarnation and exact optional identity. Its content-free
owner marker stays outside guest files and checkpoints. Missing/mismatched
ownership fails closed, including when another metadata root targets the same
active workspace.

Sandbox lifecycle metadata is separate from SQLite and durable checkpoints.
The host-directory adapter supports one active process per root; in-process
clients serialize lifecycle changes. Detach invalidates handles and stops owned
processes; termination must not wait behind a long-running command. Failed
process cleanup remains retryable and cannot report successful detach early.

## 8. Telemetry and logging

Storage operations emit `harness.storage.*` spans and metrics. Workspace and
sandbox operations keep their own operation families. Signals include safe
operation, status, adapter, attempt, duration, and bounded counts. They never
include prompts, messages, checkpoint payloads, wait content, file paths,
command arguments/output, environment values, credentials, or reviewer data.

Driver absence, incompatible schema, lease conflict, checkpoint conflict,
path rejection, quota denial, and cleanup failure produce typed errors and
structured content-free logs with remediation where actionable.

## 9. Verification

Required tests cover Node and Bun type/build compatibility where CI supports
both, plus:

- `harnessStorageContract` against fresh SQLite databases;
- `durableWorkspaceContract` against temporary local roots;
- process-style close/reopen and replay with the same run id;
- attempt increment, stale lease rejection, expiry takeover, and session
  serialization;
- wait/signal/retry recovery and signal deduplication;
- schema inspection and explicit v2-schema rejection;
- all traversal/symlink/cleanup guards;
- files-and-bounded-search default and explicit execution policy;
- idempotent close and cleanup;
- content-free OTel snapshots.

Temporary test resources must be isolated. Production documentation must state
that local SQLite is for one host and that distributed deployments require a
separate `HarnessStorage` implementation advertising and proving
`storage.multi_instance`.
