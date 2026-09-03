# Durable Workspaces

Status: approved v3 implementation specification.

Date: 2026-08-24

## 1. Purpose and boundary

`DurableWorkspace` persists replayable file/workspace state for a durable
workflow. It is separate from:

- `HarnessStorage`, which owns sessions, messages, run lifecycle, durable step
  checkpoints, leases, and waits;
- `Sandbox`, which owns the live filesystem/process/MCP execution boundary;
- `MemoryAdapter`, which owns mutable recall and semantic search;
- application state, which owns business records and decisions.

A managed package may construct both a sandbox and a workspace, but each must
implement and advertise its own contract. A workspace never exposes shell,
process, network, or MCP execution.

## 2. Public configuration

```ts
const harness = defineHarness()
  .storage(storage)
  .sandbox(sandbox)
  .workspace(workspace)
  .requires([
    'storage.checkpoint',
    'storage.workspace_checkpoint',
    'workspace.durable',
    'workspace.checkpoint',
    'workspace.resume'
  ])
  .models(models)
  .workflows(workflows)
  .build()
```

The builder method is `.workspace(DurableWorkspace)`. It is optional and may
be called once. Durable structured execution without files requires only
`HarnessStorage`; adding a durable workspace requires both contracts.

## 3. Contract

```ts
interface DurableWorkspace {
  readonly info: DurableWorkspaceInfo
  readonly capabilities: readonly AdapterCapability[]
  configureHarnessContext?(context: HarnessAdapterContext): void

  startWorkspace(options: WorkspaceStartOptions): Promise<WorkspaceHandle>
  pauseWorkspace(options: WorkspacePauseOptions): Promise<WorkspaceCheckpoint>
  resumeWorkspace(options: WorkspaceResumeOptions): Promise<WorkspaceHandle>
  abortWorkspace(options: WorkspaceAbortOptions): Promise<WorkspaceAbortResult>
  cleanupWorkspace(options: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult>
  inspectWorkspace?(options: WorkspaceInspectionOptions): Promise<WorkspaceInspection>
  close?(): Promise<void>
}
```

The implementation in `packages/harness/src/ports/workspace.ts` is the
authoritative field-level type definition. Public references are opaque IDs;
they are never host paths, credentials, signed URLs, or raw snapshot content.

## 4. Capabilities

Every adapter provides `workspace.durable`. It advertises only guarantees it
actually implements:

| Capability | Guarantee |
| --- | --- |
| `workspace.durable` | Implements the lifecycle contract. |
| `workspace.persistent` | Survives adapter/process restart. |
| `workspace.checkpoint` | Can pause into a replayable checkpoint. |
| `workspace.resume` | Can resume a checkpoint. |
| `workspace.abort` | Can terminally abort active state. |
| `workspace.cleanup` | Can remove retained state idempotently. |
| `workspace.inspect` | Supports content-free operational inspection. |
| `workspace.retention` | Enforces declared retention policy. |
| `workspace.quota` | Enforces declared byte/file quota. |
| `workspace.encrypted_storage` | Encrypts persisted workspace material. |

Harness construction fails synchronously if the adapter metadata is invalid or
required capabilities are absent. Capability names use `workspace.*`; no
legacy capability family is accepted.

## 5. Lifecycle and replay

For a new durable run:

1. Harness creates the authoritative `RunRecord` in `HarnessStorage`.
2. Harness acquires the run/session lease from storage.
3. If a workspace is configured, Harness calls `startWorkspace` with stable
   run, session, workflow, attempt, worker, and idempotency values.
4. After a durable `ctx.step(...)` succeeds, Harness pauses the workspace.
5. Harness commits the step output and returned replay reference together as a
   storage checkpoint.

For a resumed run:

1. Storage returns the latest committed checkpoint and increments the attempt.
2. With a configured workspace, Harness requires the committed workspace and
   checkpoint references before `resumeWorkspace`. A previous attempt without
   recoverable files fails with `SandboxStateLostError`; it never starts empty.
3. `ctx.step(...)` returns already-committed outputs without rerunning their
   callbacks.
4. New steps repeat pause-before-storage-commit ordering.

If workspace pause succeeds but storage commit fails, the unreferenced
workspace checkpoint is an orphan and may be reclaimed by adapter retention.
If storage commit succeeds, the checkpoint is authoritative even if the
process crashes before returning to application code.

Waiting/interrupted runs and an expired running attempt can reacquire ownership
under the storage lease contract. Terminal runs never open or resume a workspace.
Cancellation calls `abortWorkspace`; successful terminal cleanup follows the
adapter retention policy. Cleanup and abort are idempotent. Once the terminal
business outcome is committed, cleanup failure must not change it or replay the
business work: emit a content-free warning and leave cleanup retry to the
adapter/operator.

## 6. Sandbox binding

When a durable workspace is configured, the execution sandbox for that run
must be bound to the active workspace. It must not silently use an unrelated
session sandbox. The binding is released in all terminal, suspended, failed,
and setup-failure paths.

The local implementation maps `/workspace` into the active host directory.
Remote implementations may mount, synchronize, or virtualize the same logical
boundary. The model and tools receive only sandbox paths, never backend paths.

Before Harness uses sandbox `mode: 'restore'`, it resumes the latest committed
workspace and establishes this binding. The sandbox adapter receives restore
intent, not workspace or provider references. A managed addon may return compatible
`{ sandbox, workspace }` ports backed by shared private state, but the ports stay
independently registered and testable. Failed resume/binding never falls back to
an empty sandbox. See spec 34.

## 7. Idempotency and concurrency

- Every mutating request includes a stable idempotency key.
- Repeating the same request returns the same logical result.
- Reusing an idempotency key with different immutable input fails with
  `WorkspaceError{meta.reason:'idempotency_conflict'}`.
- Workspace operations validate run/session ownership.
- A stale run lease cannot commit a storage checkpoint after another attempt
  takes ownership.
- Workspace capabilities do not describe sandbox topology; distributed run
  coordination remains the responsibility of `HarnessStorage` capability
  `storage.multi_instance`, while sandbox compute coordination stays inside the
  Sandbox adapter.

## 8. Security and enterprise controls

Production adapters must document and test:

- tenant/project isolation and authorization of every reference;
- encryption in transit and at rest plus key ownership/rotation;
- retention, legal hold, cleanup retries, and orphan reclamation;
- byte/file quotas and denial behavior;
- path traversal, symlink escape, archive extraction, and race resistance;
- immutable audit identity without file names or content in telemetry;
- regional placement, backup, recovery, and operator access controls.

References in logs, spans, metrics, and errors must be opaque and bounded.
File paths, file contents, snapshots, credentials, tokens, and signed URLs are
forbidden telemetry attributes.

## 9. Telemetry

Each lifecycle operation emits a short content-free span and duration/count
metrics with adapter id, operation, status, run/session correlation, attempt,
and safe byte/count values when available. No span remains open across a human
wait or process restart. Expected lifecycle outcomes such as already-cleaned
or suspended are not errors; backend and invariant failures are errors.

## 10. Testing

Every implementation runs `durableWorkspaceContract`. Additional adapter tests
cover persistence/restart, idempotency conflicts, concurrent ownership,
missing/expired/aborted/cleaned references, retention, quota, encryption
metadata, cleanup retries, orphan inspection, and all relevant traversal and
symlink attacks. Integration tests must prove checkpoint replay with the chosen
`HarnessStorage` and sandbox binding.

The in-memory workspace is for deterministic tests. The local directory
workspace is for development and one-host execution. Neither is a claim of a
distributed enterprise backend.

## 11. PURISTA integration

PURISTA exposes the same contract as `ai.workspace`. An attached agent that
declares a durable workspace must also declare `.setDurability(...)`; service
startup requires `ai.storage`, `ai.workspace`, and all manifest capabilities.
PURISTA's general top-level `StateStore` remains unrelated and unchanged.

See [32-harness-storage](./32-harness-storage.md) for the structured storage and
run lifecycle, and [22-local-durable-execution](./22-local-durable-execution.md)
for the built-in local bundle.
