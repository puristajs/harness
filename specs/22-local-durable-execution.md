# Local Durable Execution

Status: approved implementation specification.

Date: 2026-06-12

This specification adds a first-party local persistence bundle for long-running
agent workflows. It builds on [21-durable-workspaces](./21-durable-workspaces.md)
without changing the core port boundaries: `DurableRuntime` owns run leases and
step checkpoints, `DurableWorkspaceStore` owns replayable workspace snapshots,
and `Sandbox` owns live filesystem and optional command execution.

## 1. Outcomes

| ID | Outcome | Owner | Verification |
| --- | --- | --- | --- |
| LDE-01 | A user can enable durable workflow replay with one local-first factory and no external service. | `@purista/harness` | Integration test across a process-style rebuild |
| LDE-02 | The local factory persists runtime state in SQLite and workspace state in a host directory outside any model-visible path. | `@purista/harness` | Filesystem and SQLite adapter tests |
| LDE-03 | Durable workflow code uses a sandbox session bound to the active durable workspace, not the old session sandbox. | `@purista/harness` | Workflow writes a file, commits a step, rebuilds harness, resumes and reads the file |
| LDE-04 | Host execution is disabled by default and, when enabled, is jailed to the durable workspace root. | `@purista/harness` | Path traversal, symlink, cwd, env, timeout, and disabled-exec tests |
| LDE-05 | SQLite runtime and workspace operations emit complete privacy-safe OTel spans, metrics, and persisted events. | `@purista/harness` | In-memory OTel snapshot tests |

## 2. Public API

Core exports the local durable bundle from `@purista/harness`:

```ts
interface LocalDurableExecutionOptions {
  /** Host directory used for SQLite files, active workspaces, and snapshots. */
  root: string
  /** SQLite database file. Default: `${root}/runtime.sqlite`. */
  databaseFile?: string
  /** Reserved for future bundle-level lease policies. Per-run workerId remains in DurableInvokeOptions. */
  workerId?: string
  /** Host command execution policy. Default: `false`. */
  exec?: false | LocalHostExecPolicy
  /** Workspace retention/quota/encryption metadata reported by the store. */
  policy?: Partial<DurableWorkspacePolicy>
  /** Lease takeover window for crashed workers. Default: `120_000`. */
  leaseTtlMs?: number
}

interface LocalHostExecPolicy {
  /** Extra environment variables visible to commands. Defaults to `{}`. */
  env?: Record<string, string>
  /** Allowed host command names. `undefined` means no command allow-list. */
  allowCommands?: readonly string[]
  /** Per-command wall clock timeout. Default: harness `toolTimeoutMs`. */
  timeoutMs?: number
}

interface LocalDurableExecution {
  state: StateStore
  runtime: DurableRuntime
  /**
   * Workspace persistence is independent of exec: files-only mode advertises
   * `['sandbox.fs', 'sandbox.persistent_fs']`; enabling `exec` adds `sandbox.exec`.
   */
  sandbox:
    | Sandbox<readonly ['sandbox.fs', 'sandbox.persistent_fs']>
    | Sandbox<readonly ['sandbox.fs', 'sandbox.exec', 'sandbox.persistent_fs']>
  workspaceStore: DurableWorkspaceStore
  checkpoints: ContextCheckpointStore
  close(): Promise<void>
}

function localDurableExecution(options: LocalDurableExecutionOptions): LocalDurableExecution
function sqliteDurableRuntime(options: SqliteDurableRuntimeOptions): DurableRuntime & { close(): Promise<void> }
function localDirectoryWorkspaceStore(options: LocalDirectoryWorkspaceStoreOptions): DurableWorkspaceStore
function localDirectorySandbox(options: LocalDirectorySandboxOptions): Sandbox
```

Recommended usage:

```ts
const local = localDurableExecution({ root: '.purista/harness', exec: false })

const harness = defineHarness()
  .state(local.state)
  .runtime(local.runtime)
  .sandbox(local.sandbox)
  .workspaceStore(local.workspaceStore)
  .checkpoints(local.checkpoints)
  .requires([
    'runtime.checkpoint',
    'runtime.resume_from_checkpoint',
    'runtime.workspace_checkpoint',
    'workspace_store.durable',
    'workspace_store.checkpoint',
    'workspace_store.resume',
  ])
  .models({ /* ... */ })
  .agents({ /* ... */ })
  .workflows({ /* ... */ })
  .build()
```

## 3. Runtime Adapter

`sqliteDurableRuntime(...)` persists `DurableRuntime` state in SQLite using a
small internal driver shim:

- Node uses `node:sqlite` `DatabaseSync`. Node's official docs show the
  `node:`-scheme module and synchronous `DatabaseSync`/prepared-statement API
  in current Node 26 docs.
- Bun uses `bun:sqlite` `Database`. Bun's official docs show file-backed
  databases, strict mode, prepared statements, transactions, WAL, and close.
- No external SQLite package is added.
- Runtime detection is dynamic. Import failure throws
  `HarnessConfigError{meta.reason:'sqlite_unavailable'}` with the active runtime
  name and package engine requirement.

Schema tables:

| Table | Purpose |
| --- | --- |
| `harness_durable_runs` | durable run start, status, attempt, input JSON, terminal output/error |
| `harness_durable_checkpoints` | ordered durable step checkpoints and optional replay refs |
| `harness_durable_leases` | run/session ownership with `leaseId`, `workerId`, `expiresAt` |

Rules:

- Schema version is the v1 local schema above. The adapter creates missing
  tables and indexes during construction before returning.
- WAL mode is enabled for file databases. `busy_timeout` is at least `5000ms`.
- Every public runtime method runs inside a SQLite transaction. Transaction
  entry is serialized by an in-process mutex (one open transaction per
  connection); `withSessionLock` is a per-session in-process mutex matching the
  in-memory runtime.
- `startRun` reuses a run with the same `runId` unless its status blocks resume,
  increments the attempt, and returns committed checkpoints ordered by
  `sequence`.
- A lease blocks other workers until `expiresAt`. A retry by the same worker
  renews the lease (upsert on `run_id`). A retry by another worker may take over
  only after `expiresAt`. Expired-lease deletion is scoped to the contested run
  and session; unrelated leases are never deleted by another start.
- Every successful `commitCheckpoint` by the owning lease renews `expiresAt`
  (heartbeat), so runs longer than the lease TTL keep their lease.
- `release()` deletes only the matching `leaseId`; stale release calls are
  idempotent.
- `commitCheckpoint` requires the active matching lease and is idempotent for
  the same `(runId, stepId, sequence, attempt, output, replay)`. Conflicting
  payloads throw `WorkspaceError{meta.reason:'checkpoint_conflict'}`.
- `finishRun` records the terminal status (`succeeded`, `failed`, or
  `cancelled`) with sanitized output/error on the durable run and releases
  active matching leases. Only `succeeded` and `cancelled` block a later
  `startRun` (`DurableTerminalRunError`); a `failed` run remains resumable by a
  retry with the same `runId`.
- JSON payloads are serialized once before storage. Non-serializable values are
  rejected with `DurableStepError` before any SQLite write.
- `SqliteDurableRuntimeOptions.now` optionally injects an epoch-millisecond
  clock (default `Date.now`) so lease TTL behavior is testable without real
  waits.
- `close()` is idempotent.

## 4. Workspace Store

`localDirectoryWorkspaceStore(...)` persists workspace state under:

```text
<root>/
  workspaces/
    <workspaceRef>/
      active/
      checkpoints/
        <checkpointRef>/
      meta.json
```

Rules:

- `workspaceRef` and `checkpointRef` are opaque ids. They are not host paths.
  Refs always match `^workspace_[A-Z0-9]+$` and are validated before any path
  construction; anything else throws
  `WorkspaceError{meta.reason:'invalid_reference'}`.
- `startWorkspace` creates or reuses `active/`.
- `pauseWorkspace` copies `active/` into a new checkpoint directory before the
  runtime checkpoint is committed.
- `resumeWorkspace` restores the requested checkpoint directory into `active/`.
- `abortWorkspace` updates metadata and blocks future resume.
- `cleanupWorkspace` deletes only the addressed workspace directory after
  verifying the real path (symlinks resolved) is inside `<root>/workspaces`.
- `inspectWorkspace` reads metadata and checkpoint summaries only. It never
  returns file content.
- Idempotency records (`idempotencyKey` → operation kind, run/session identity,
  and result) are persisted in `meta.json`, so replay and `idempotency_conflict`
  detection (spec 21 §9) survive process restarts. Replay applies to every
  durable operation: `startWorkspace`, `pauseWorkspace`, `resumeWorkspace`, and
  `abortWorkspace` only replay a stored result when the request's operation kind
  and run/session identity match the record; a key reused for a different kind or
  identity raises `WorkspaceError{meta.reason:'idempotency_conflict'}`.
- `meta.json` writes are crash-atomic (temp file plus rename).
- When `policy.quota.maxWorkspaceBytes` is configured, `pauseWorkspace` rejects
  oversized checkpoints with `WorkspaceQuotaExceededError`, removes the partial
  checkpoint copy, and emits the `harness.workspace_store.quota.exceeded`
  counter.
- The default local store reports `encryptedAtRest:false` and
  `cleanupMode:'manual_only'`; applications that require encryption or automatic
  cleanup must provide another adapter or explicit policy metadata.

## 5. Sandbox Binding

The local sandbox is a host-directory sandbox whose virtual `/workspace` maps to
the currently active durable workspace directory. It may also mount skills and
memory paths inside the same sandbox root.

The session run-loop must change for durable workflow calls with a workspace
store:

1. Validate `opts.durable`.
2. Acquire the durable runtime lease and start/resume the workspace.
3. Open the sandbox session for the run after the active workspace exists.
4. Build workflow and child-agent memory facades against that sandbox session.
5. Run the workflow.
6. Close the run sandbox after durable finalization/disposal.

Non-durable calls keep the existing session sandbox behavior. Direct agent calls
remain non-durable and use the session sandbox unless later specs add direct
agent durability.

Sandbox filesystem rules:

- All public paths are POSIX absolute paths.
- `/workspace` maps to the durable active directory.
- Reads, writes, removes, lists, stats, mounts, and exec `cwd` resolve through a
  realpath jail. `..`, symlink escapes, and paths outside the sandbox root throw
  `SandboxError{meta.reason:'invalid_path'}`. Write targets whose final path
  component is a symlink (including dangling symlinks) are rejected before any
  write.
- `sessionId` and `runId` used for non-durable sandbox roots must be safe path
  segments (no separators, no `.`/`..`); anything else throws
  `SandboxError{meta.reason:'invalid_path'}`.
- `exec:false` is the default and produces a files-only session with
  `executor:'unavailable'` and capabilities
  `['sandbox.fs', 'sandbox.persistent_fs']` — workspace persistence is
  independent of host execution.
- When `exec` is enabled, the sandbox advertises
  `['sandbox.fs', 'sandbox.exec', 'sandbox.persistent_fs']`. Commands run with
  `cwd` defaulting to `/workspace`, a minimal environment, the configured `env`,
  timeout enforcement (falling back to the harness `toolTimeoutMs`), and the
  optional command allow-list.

Sandbox exec hardening rules:

- Commands never run through a shell. The command line is tokenized (single and
  double quotes group arguments; no expansion, substitution, or redirection) and
  spawned as an argv array.
- When `allowCommands` is configured, unquoted shell metacharacters
  (``; | & < > ` $ ( )`` and newlines) are rejected with
  `SandboxError{meta.reason:'exec_failed'}` so the allow-list cannot be
  bypassed.
- Captured stdout/stderr are capped at 10 MiB each; truncated output ends with a
  truncation marker.
- Aborting the exec signal rejects with
  `OperationCancelledError{meta.scope:'sandbox'}`. A signal-killed process
  (`exitCode === null`) rejects with `SandboxError{meta.reason:'exec_failed'}`
  carrying the terminating signal in the message.

## 6. Context Checkpoints

Long-horizon context compaction is explicit and adapter-backed, not hidden
inside model calls.

Core adds a small `ContextCheckpointStore` port and optional
`.checkpoints(store)` builder method:

```ts
interface ContextCheckpoint {
  runId: string
  sessionId: string
  workflowId?: string
  agentId?: string
  sequence: number
  kind: 'summary' | 'handoff' | 'goal_state'
  payload: JsonValue
  payloadSizeBytes: number
  createdAt: string
  metadata?: Record<string, JsonValue>
}

interface ContextCheckpointStore extends HarnessContextConfigurable, AdapterCapabilities {
  readonly info: ContextCheckpointStoreInfo
  write(checkpoint: ContextCheckpoint, opts?: { signal?: AbortSignal }): Promise<void>
  list(query: ContextCheckpointQuery): Promise<readonly ContextCheckpoint[]>
  read(ref: ContextCheckpointRef): Promise<ContextCheckpoint | undefined>
  delete(ref: ContextCheckpointRef): Promise<void>
  close?(): Promise<void>
}
```

`ContextCheckpointStore.info.capabilities` uses:

- `context_checkpoint.write`
- `context_checkpoint.read`
- `context_checkpoint.list`
- `context_checkpoint.delete`
- `context_checkpoint.persistent`

The first implementation is SQLite-backed and uses the same internal SQLite
driver shim. `localDurableExecution(...)` returns that store as
`checkpoints`. The default harness behavior does not summarize or rewrite
prompts automatically. Users opt in through `ctx.checkpoints.write(...)` or
through future higher-level policies. This avoids fake "memory management" while
giving agents a durable, typed handoff record.

Telemetry emits `harness.context_checkpoint.write|read|list|delete` spans with
hashed refs, counts, sizes, and no raw payload content.

## 7. Observability

The local adapters emit the workspace spans from
[14-otel-conventions](./14-otel-conventions.md) and add:

| Span | Required attributes |
| --- | --- |
| `harness.runtime.start` | runtime adapter, run id, session id, resumed, attempt |
| `harness.runtime.load_checkpoint` | runtime adapter, run id |
| `harness.runtime.checkpoint` | runtime adapter, run id, step id, sequence, attempt |
| `harness.runtime.finish` | runtime adapter, run id, run status (`harness.run.status`) |
| `harness.context_checkpoint.write` | adapter, run id, kind, sequence, ref hash, payload bytes |
| `harness.context_checkpoint.list` | adapter, query attributes, limit, result count |
| `harness.local_sandbox.open` | sandbox adapter, run id, session id, exec enabled, workspace ref hash when bound |

Local sandbox spans use the `harness.local_sandbox.{operation}` span/metric
names with `harness.sandbox.*` attribute keys exactly as defined in
[14-otel-conventions](./14-otel-conventions.md).

Raw file paths, workspace refs, checkpoint refs, prompts, completions, tool
arguments, tool results, and context checkpoint payloads are never emitted in
logs/spans/metrics. Refs and host paths use SHA-256 hashes when operationally
needed.

## 8. Tests

Implementation is incomplete until these tests exist and pass:

- SQLite runtime: fresh run, retry, process-style rebuild, stale lease takeover,
  active lease conflict, checkpoint idempotency, checkpoint conflict, terminal
  run rejection, JSON serialization rejection, cancellation, and close.
- Local workspace store: start/pause/resume/abort/cleanup/inspect,
  idempotency conflicts, missing checkpoints, expired/aborted/cleaned states,
  realpath cleanup guard, and orphan inspection.
- Local sandbox: read/write/list/stat/remove/mount, disabled exec, enabled exec,
  cwd jailing, symlink escape prevention, timeout, command allow-list, and close.
- End-to-end durable workflow: write file in `/workspace`, commit step, rebuild
  local bundle and harness from the same root/database, resume same `runId`, and
  read the file without re-running the prior step.
- OTel/log privacy: every new operation span appears and contains no raw refs,
  host paths, payload content, prompt content, or tool content.
- Type/API: exported local durable and context checkpoint types have IDE-ready
  TSDoc and compile through the public package entry.

## 9. Documentation

Docs must explain the path from simple to advanced usage:

1. In-memory defaults for quickstarts.
2. `localDurableExecution({ root })` for local development and single-host
   production workloads.
3. Explicit `.requires(...)` gates for production capability policy.
4. Security model for host-directory workspaces and disabled-by-default exec.
5. SQLite persistence, lease TTL, cleanup, backup/restore, and migration notes.
6. How PURISTA can run checkpoint writes and cleanup through queues while still
   using the same harness contracts.

## 10. Migration

- This is a minor release because it adds exported APIs and capabilities without
  breaking existing users.
- Existing in-memory durable runtime/workspace APIs remain valid.
- Existing durable workspace specs remain valid but are superseded where this
  spec adds local built-in adapters, context checkpoints, and run-loop sandbox
  binding.
