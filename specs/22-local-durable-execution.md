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
  sandbox: Sandbox<readonly ['sandbox.fs'] | readonly ['sandbox.fs', 'sandbox.exec', 'sandbox.persistent_fs']>
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
- Every public runtime method runs inside a SQLite transaction.
- `startRun` reuses a non-terminal run with the same `runId`, increments the
  attempt, and returns committed checkpoints ordered by `sequence`.
- A lease blocks other workers until `expiresAt`. A retry by the same worker may
  renew the lease. A retry by another worker may take over only after
  `expiresAt`.
- `release()` deletes only the matching `leaseId`; stale release calls are
  idempotent.
- `commitCheckpoint` requires the active matching lease and is idempotent for
  the same `(runId, stepId, sequence, attempt, output, replay)`. Conflicting
  payloads throw `WorkspaceError{meta.reason:'checkpoint_conflict'}`.
- `finishRun` marks the run terminal, stores terminal output/error, and releases
  active matching leases.
- JSON payloads are serialized once before storage. Non-serializable values are
  rejected before SQLite writes.

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
- `startWorkspace` creates or reuses `active/`.
- `pauseWorkspace` copies `active/` into a new checkpoint directory before the
  runtime checkpoint is committed.
- `resumeWorkspace` restores the requested checkpoint directory into `active/`.
- `abortWorkspace` updates metadata and blocks future resume.
- `cleanupWorkspace` deletes only the addressed workspace directory after
  verifying the real path is inside `<root>/workspaces`.
- `inspectWorkspace` reads metadata and checkpoint summaries only. It never
  returns file content.
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
  `SandboxError{meta.reason:'invalid_path'}`.
- `exec:false` is the default and produces a files-only session with
  `executor:'unavailable'`.
- When `exec` is enabled, the sandbox advertises `sandbox.exec` and
  `sandbox.persistent_fs`. Commands run with `cwd` defaulting to `/workspace`,
  a minimal environment, the configured `env`, timeout enforcement, and optional
  command allow-list.

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
| `harness.runtime.checkpoint` | runtime adapter, run id, step id, sequence, attempt |
| `harness.runtime.finish` | runtime adapter, run id, status |
| `harness.context_checkpoint.write` | adapter, run id, kind, sequence, payload bytes |
| `harness.local_sandbox.open` | sandbox adapter, run id, session id, exec enabled |

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
