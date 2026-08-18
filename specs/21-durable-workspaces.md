# Durable Workspaces

Status: approved implementation specification.

Date: 2026-06-05

Source: [puristajs/harness issue #11](https://github.com/puristajs/harness/issues/11).

This specification defines production durable replay workspace support for
`@purista/harness` standalone users and for PURISTA attached agents. It closes
the gap between the existing durable runtime checkpoint port and the existing
sandbox snapshot/resume/hibernate capabilities without merging their
responsibilities.

Mental model:

- `Sandbox` is the live execution boundary. It owns file access, command
  execution, MCP stdio execution, and optional low-level session
  snapshot/resume/hibernate.
- `DurableWorkspaceStore` is the durable replay state boundary. It owns
  workspace/checkpoint references, replay lifecycle, retention, cleanup, quota,
  and encryption metadata. It never exposes file, command, process, or MCP
  execution APIs.
- A managed platform may provide one package that constructs both a `Sandbox`
  and a `DurableWorkspaceStore`, but the harness validates them as separate
  contracts and reports their capabilities separately.

## 1. Ownership Boundary

`@purista/harness` owns the generic durable workspace contract, capability
negotiation, checkpoint-to-workspace references, error taxonomy, telemetry,
contract tests, and reference test doubles.

`@purista/harness` does not own product datasets, experiment records, billing,
tenant quota policy values, UI, prompt version stores, CloudGrid APIs, or
CloudGrid adapter packages. Those remain application or product concerns.

PURISTA consumes this contract through `@purista/core` runtime wiring. PURISTA
does not implement a second durable replay model.

## 2. Outcomes

| ID | Outcome | Owner | Priority | Risk | Verification |
| --- | --- | --- | --- | --- | --- |
| DW-01 | A standalone harness workflow can start, pause, resume, abort, and clean up a durable workspace through one adapter contract. | `@purista/harness` | P0 | High: incorrect lifecycle causes leaked workspaces or lost replay state | Durable workspace contract suite and integration workflow test |
| DW-02 | A runtime checkpoint can reference the durable workspace state used by the step that produced it. | `@purista/harness` | P0 | High: checkpoint/snapshot drift breaks replay | Crash matrix tests for checkpoint and workspace commit ordering |
| DW-03 | Applications can require durable workspace capabilities at build time and can inspect effective adapter guarantees at runtime. | `@purista/harness` | P0 | Medium: false capability claims create production drift | `.requires(...)`, `harness.inspect()`, and type/API tests |
| DW-04 | Retention, encryption, cleanup, and quota behavior is explicit and testable without forcing product policy values into harness core. | `@purista/harness` | P0 | High: data protection, cost, and incident risk | Adapter contract tests, metadata redaction tests, docs |
| DW-05 | Harness errors, logs, spans, metrics, and persisted events describe durable workspace operations without exposing secrets, file contents, prompts, completions, or tool arguments. | `@purista/harness` | P0 | High: data leakage | OTel/log/error tests in all content-capture modes |
| DW-06 | PURISTA and product layers can use durable replay through the harness contract while preserving PURISTA builder/runtime naming, queue behavior, tracing, and logging boundaries. | `@purista/core` | P0 | Medium: integration drift | PURISTA integration spec and downstream docs/skill audits |

## 3. Non-Goals

- No durable workflow engine, scheduler daemon, worker daemon, HTTP API, or
  process supervisor in harness core.
- No Temporal, Kubernetes, CloudGrid, Voyage, or PURISTA-specific adapter in
  harness core.
- No product-owned dataset, prompt-version, eval-result, experiment, or billing
  store in harness core.
- No broad content telemetry. Workspace file content, snapshots, prompts,
  completions, tool inputs, and tool outputs stay excluded from harness
  telemetry by default.
- No guarantee that two independent storage systems provide a distributed
  transaction. The contract defines idempotent consistency and recovery rules.

## 4. Public API Inventory

The source contract is TypeScript declarations exported from
`@purista/harness`; see [13-public-api](./13-public-api.md).

New public symbols:

- `DurableWorkspaceStore`
- `DurableWorkspaceStoreInfo`
- `DurableWorkspacePolicy`
- `WorkspaceStartOptions`
- `WorkspaceHandle`
- `WorkspacePauseOptions`
- `WorkspaceCheckpoint`
- `WorkspaceResumeOptions`
- `WorkspaceAbortOptions`
- `WorkspaceAbortResult`
- `WorkspaceCleanupOptions`
- `WorkspaceCleanupResult`
- `WorkspaceInspectionOptions`
- `WorkspaceInspection`
- `WorkspaceQuotaPolicy`
- `WorkspaceRetentionPolicy`
- `WorkspaceEncryptionInfo`
- `DurableReplayCheckpoint`
- `WorkspaceError`
- `WorkspaceQuotaExceededError`
- `WorkspaceCleanupError`
- `InMemoryDurableWorkspaceStore`
- `inMemoryDurableWorkspaceStore(...)`
- `durableWorkspaceStoreContract(...)`

execution_semantics:

- `DurableWorkspaceStore` methods are asynchronous, idempotent where stated,
  cancellation-aware, and bounded by caller timeouts or `AbortSignal`.
- `defineHarness().workspaceStore(store)` binds one durable workspace store.
- `defineHarness().requires([...])` validates workspace capabilities before
  `.build()` returns.
- `harness.inspect()` reports effective workspace capabilities and policy
  metadata without opening or mutating a workspace.

## 5. Capability Model

`AdapterCapability` gains these values:

| Capability | Meaning |
| --- | --- |
| `workspace_store.durable` | Adapter implements the durable workspace lifecycle contract and exposes opaque workspace/checkpoint references. This capability alone does not guarantee process-restart persistence. |
| `workspace_store.persistent` | Adapter persists workspace/checkpoint state beyond process exit. |
| `workspace_store.checkpoint` | Adapter can produce stable workspace checkpoints. |
| `workspace_store.resume` | Adapter can resume from a committed workspace checkpoint. |
| `workspace_store.abort` | Adapter can mark active or paused workspace state aborted and stop further resumes. |
| `workspace_store.cleanup` | Adapter supports idempotent cleanup/delete with result metadata. |
| `workspace_store.inspect` | Adapter supports non-mutating inspection by workspace or checkpoint reference. |
| `workspace_store.retention` | Adapter exposes effective retention policy and expiry metadata. |
| `workspace_store.quota` | Adapter enforces and reports quota policy. |
| `workspace_store.encrypted_storage` | Adapter encrypts checkpoint payloads, snapshots, files, and metadata at rest according to reported policy. |
| `runtime.workspace_checkpoint` | Runtime checkpoint records can carry durable workspace references. |
| `runtime.checkpoint_retention` | Runtime adapter exposes checkpoint retention and expiry metadata. |
| `runtime.persistent` | Runtime checkpoints, leases, and terminal run state survive process exit. |

Existing `sandbox.snapshot`, `sandbox.resume`, and `sandbox.hibernate`
capabilities continue to describe low-level sandbox session operations. They do
not imply production durable workspace support.

Capability aggregation:

1. Sandbox capabilities come from the configured `Sandbox`.
2. Runtime capabilities come from the configured `DurableRuntimeAdapter`.
3. Workspace capabilities come from the configured `DurableWorkspaceStore`.
4. `.requires(...)` validates the union.
5. A capability missing from every configured adapter fails build with
   `HarnessConfigError{meta.reason:'missing_required_capability'}`.

## 6. Adapter Contract

```ts
interface DurableWorkspaceStore {
  readonly info: DurableWorkspaceStoreInfo
  configureHarnessContext?(context: HarnessAdapterContext): void
  startWorkspace(opts: WorkspaceStartOptions): Promise<WorkspaceHandle>
  pauseWorkspace(opts: WorkspacePauseOptions): Promise<WorkspaceCheckpoint>
  resumeWorkspace(opts: WorkspaceResumeOptions): Promise<WorkspaceHandle>
  abortWorkspace(opts: WorkspaceAbortOptions): Promise<WorkspaceAbortResult>
  cleanupWorkspace(opts: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult>
  inspectWorkspace?(opts: WorkspaceInspectionOptions): Promise<WorkspaceInspection>
}

interface DurableWorkspaceStoreInfo {
  id: string
  packageName: string
  capabilities: readonly AdapterCapability[]
  policy: DurableWorkspacePolicy
}
```

Validation:

- `info.id` matches `/^[a-z][a-z0-9_.-]{1,63}$/`.
- `info.packageName` is non-empty.
- `info.capabilities` contains `workspace_store.durable`.
- The store has no file read/write, command execution, MCP execution, shell,
  process, or live sandbox session methods.
- Capabilities are honest: contract tests fail when advertised behavior is not
  implemented.
- The store must accept `configureHarnessContext(...)` from the harness
  builder and must use the provided logger and telemetry shim for harness-owned
  logs/spans/metrics.

Default store:

- `inMemoryDurableWorkspaceStore()` returns an in-process durable workspace
  store for local development, examples, and hermetic tests.
- The in-memory store advertises `workspace_store.durable`,
  `workspace_store.checkpoint`, `workspace_store.resume`,
  `workspace_store.abort`, `workspace_store.cleanup`,
  `workspace_store.inspect`, `workspace_store.retention`, and
  `workspace_store.quota`.
- The in-memory store MUST NOT advertise `workspace_store.persistent`.
- The in-memory store is not a production persistence guarantee across process
  restarts and must be documented as local/test only.

## 7. Data Shapes

All timestamps are ISO 8601 UTC strings. All references are opaque strings.
Applications must not parse reference internals.

```ts
type WorkspaceLifecycleState =
  | 'active'
  | 'paused'

  | 'aborted'
  | 'cleanup_pending'
  | 'cleaned'

interface WorkspaceStartOptions {
  runId: string
  sessionId: string
  workflowId?: string
  agentId?: string
  workerId?: string
  attempt: number
  idempotencyKey: string
  metadata?: Record<string, JsonValue>
  policy?: Partial<DurableWorkspacePolicy>
  signal?: AbortSignal
}

interface WorkspaceHandle {
  workspaceRef: string
  runId: string
  sessionId: string
  state: 'active'
  startedAt: string
  attempt: number
  metadata?: Record<string, JsonValue>
}

interface WorkspacePauseOptions {
  handle: WorkspaceHandle
  stepId: string
  sequence: number
  attempt: number
  checkpointPayload?: JsonValue
  reason: 'step_completed' | 'manual_pause' | 'timeout' | 'shutdown' | 'retry_boundary'
  idempotencyKey: string
  signal?: AbortSignal
}

interface WorkspaceCheckpoint {
  workspaceRef: string
  checkpointRef: string
  snapshotRef?: string
  runId: string
  sessionId: string
  stepId: string
  sequence: number
  attempt: number
  committedAt: string
  expiresAt?: string
  sizeBytes?: number
  metadata?: Record<string, JsonValue>
}

interface WorkspaceResumeOptions {
  workspaceRef: string
  checkpointRef?: string
  snapshotRef?: string
  runId: string
  sessionId: string
  attempt: number
  idempotencyKey: string
  signal?: AbortSignal
}

interface WorkspaceAbortOptions {
  workspaceRef: string
  runId: string
  sessionId: string
  reason: 'cancelled' | 'failed' | 'superseded' | 'manual_abort'
  idempotencyKey: string
  signal?: AbortSignal
}

interface WorkspaceAbortResult {
  workspaceRef: string
  state: 'aborted'
  abortedAt: string
  cleanupEligibleAt?: string
}

interface WorkspaceCleanupOptions {
  workspaceRef: string
  reason: 'terminal_success' | 'terminal_failure' | 'aborted' | 'expired' | 'orphan' | 'manual'
  idempotencyKey: string
  signal?: AbortSignal
}

interface WorkspaceCleanupResult {
  workspaceRef: string
  state: 'cleaned' | 'cleanup_pending'
  deletedBytes?: number
  deletedFiles?: number
  completedAt?: string
  retryAfterMs?: number
  partial?: boolean
  remainingRefs?: readonly string[]
}

interface WorkspaceInspectionOptions {
  workspaceRef?: string
  checkpointRef?: string
  snapshotRef?: string
  signal?: AbortSignal
}

interface WorkspaceInspection {
  workspaceRef: string
  state: WorkspaceLifecycleState
  checkpoints: readonly WorkspaceCheckpoint[]
  currentCheckpointRef?: string
  retention?: WorkspaceRetentionPolicy
  quota?: WorkspaceQuotaPolicy
  encryption?: WorkspaceEncryptionInfo
  createdAt: string
  updatedAt: string
  expiresAt?: string
  cleanupEligibleAt?: string
  metadata?: Record<string, JsonValue>
}
```

## 8. Durable Replay Checkpoint

`RunCheckpoint` gains optional durable workspace fields through a new
`DurableReplayCheckpoint` shape:

```ts
interface DurableReplayCheckpoint {
  runId: string
  sessionId: string
  workerId?: string
  leaseId?: string
  stepId: string
  sequence: number
  attempt: number
  checkpointRef: string
  workspaceRef?: string
  snapshotRef?: string
  runtimeCheckpointRef?: string
  schemaVersion: 1
  payload?: JsonValue
  payloadSizeBytes?: number
  committedAt: string
  expiresAt?: string
  metadata?: Record<string, JsonValue>
}
```

Rules:

- `checkpointRef` is stable for the same `(runId, stepId, sequence, attempt,
  idempotencyKey)`.
- Repeating a checkpoint commit with the same idempotency key and identical
  payload returns the same references.
- Repeating with the same idempotency key and different payload throws
  `WorkspaceError{meta.reason:'idempotency_conflict'}`.
- Runtime checkpoint payloads must remain JSON-serializable.
- `payloadSizeBytes` is measured after UTF-8 JSON serialization.
- `metadata` is privacy-safe operational metadata only. It must not contain
  prompts, completions, tool inputs, tool outputs, file contents, credentials,
  tokens, raw headers, or attachments.

## 9. Lifecycle Semantics

### Start

- `startWorkspace` creates or returns the active workspace for the supplied
  idempotency key.
- Duplicate `startWorkspace` calls with the same key return the same
  `workspaceRef`.
- Duplicate calls with a different `runId` or `sessionId` for the same key
  throw `WorkspaceError{meta.reason:'idempotency_conflict'}`.
- A start failure has no committed workspace reference visible through
  `inspectWorkspace`.

### Pause

- `pauseWorkspace` creates a workspace checkpoint and returns stable references.
- The store records the lifecycle state as `paused`. Releasing active compute is
  a sandbox responsibility; a sandbox may use `sandbox.hibernate`, but the
  workspace store does not expose hibernate or execution-resource operations.
- A paused workspace remains resumable until `expiresAt` or cleanup.
- A pause failure leaves the prior committed checkpoint as the current replay
  boundary.

### Resume

- `resumeWorkspace` opens an active handle from a committed checkpoint.
- Resuming a cleaned workspace throws `WorkspaceError{meta.reason:'not_found'}`.
- Resuming an aborted workspace throws
  `WorkspaceError{meta.reason:'aborted'}`.
- Resuming an expired workspace throws
  `WorkspaceError{meta.reason:'expired'}`.
- A successful resume does not mutate checkpoint history.

### Abort

- `abortWorkspace` marks the workspace as aborted and blocks future resume.
- Duplicate abort calls return the same terminal state.
- Abort does not delete data. Cleanup controls deletion.

### Cleanup

- `cleanupWorkspace` is idempotent for every reason.
- A fully deleted workspace returns `state:'cleaned'`.
- A partial deletion returns `state:'cleanup_pending'`, `partial:true`,
  `retryAfterMs`, and `remainingRefs`.
- Cleanup must be retryable until it returns `cleaned`.
- Cleanup must not delete unrelated workspace, runtime, memory, or state records.

## 10. Checkpoint And Snapshot Consistency

The harness must not require distributed transactions across independent
runtime and workspace stores. It must enforce deterministic recovery rules:

1. Workspace snapshot/checkpoint data is written first.
2. Runtime checkpoint metadata referencing the workspace checkpoint is committed
   second.
3. If workspace write succeeds and runtime checkpoint commit fails, the
   workspace checkpoint is an orphan. It is visible to `inspectWorkspace` and
   eligible for cleanup with reason `orphan`.
4. If runtime commit succeeds and the caller crashes before returning, a retry
   with the same idempotency key returns the same committed references.
5. A resume uses only the latest runtime checkpoint whose referenced workspace
   checkpoint can be inspected and is not cleaned, aborted, or expired.
6. If runtime checkpoint references a missing workspace checkpoint, resume
   fails with `WorkspaceError{meta.reason:'missing_checkpoint'}` and the caller
   may fall back only when its configured policy permits a fresh ephemeral run.

## 11. Retention

```ts
interface WorkspaceRetentionPolicy {
  activeTtlMs?: number
  pausedTtlMs?: number
  terminalSuccessTtlMs?: number
  terminalFailureTtlMs?: number
  abortedTtlMs?: number
  orphanTtlMs?: number
  maxTtlMs?: number
  cleanupMode: 'adapter_automatic' | 'application_scheduled' | 'manual_only'
}
```

Rules:

- Harness core does not define product retention durations.
- A production adapter that advertises `workspace_store.retention` must report the
  effective retention policy through `info.policy.retention` and
  `WorkspaceInspection.retention`.
- `expiresAt` is computed from the reported policy and the checkpoint state
  transition time.
- An adapter without `workspace_store.retention` must omit `expiresAt` and must not be
  accepted when `.requires(['workspace_store.retention'])` is used.
- Reference in-memory/test adapters use `cleanupMode:'manual_only'` and no
  expiry.

## 12. Encryption And Secret Safety

```ts
interface WorkspaceEncryptionInfo {
  encryptedAtRest: boolean
  keyScope: 'adapter' | 'tenant' | 'project' | 'application'
  rotationSupported: boolean
  metadataEncrypted: boolean
}
```

Rules:

- A production adapter advertising `workspace_store.encrypted_storage` must encrypt
  checkpoint payloads, snapshots, files, and metadata at rest.
- Provider credentials, API keys, OAuth tokens, raw headers, and secret-store
  material must not be persisted by harness core.
- Adapter metadata must use redacted or hashed identifiers for principals,
  tenants, repository paths, file names, and external resource ids when the
  application marks them confidential.
- Key material is never accepted through `WorkspaceStartOptions.metadata`.
- Key rotation behavior is adapter-owned and must be reported through
  `WorkspaceEncryptionInfo.rotationSupported`.

## 13. Quotas

```ts
interface WorkspaceQuotaPolicy {
  maxWorkspaceBytes?: number
  maxWorkspaceFiles?: number
  maxSingleFileBytes?: number
  maxCheckpointPayloadBytes?: number
  maxSnapshotBytes?: number
  maxActiveWorkspaces?: number
  maxPausedWorkspaces?: number
  maxConcurrentResumes?: number
  maxWorkspaceAgeMs?: number
}
```

Rules:

- `WorkspaceQuotaExceededError` is thrown before a write becomes visible.
- If the adapter cannot predict a quota before writing, it rolls back or marks
  the partial checkpoint orphaned and returns
  `WorkspaceQuotaExceededError{meta.partial:true}`.
- Quota metadata includes `quota`, `limit`, `actual`, `workspaceRef`, `runId`,
  and `sessionId` when available.
- Applications that require production quota enforcement use
  `.requires(['workspace_store.quota'])`.

## 14. Errors

New error classes are added to [15-error-catalog](./15-error-catalog.md).

| Class | Code | Retriable | When |
| --- | --- | --- | --- |
| `WorkspaceError` | `WORKSPACE_ERROR` | dynamic | Generic lifecycle, consistency, inspection, or adapter backend failure. |
| `WorkspaceQuotaExceededError` | `WORKSPACE_QUOTA_EXCEEDED` | `false` | A workspace quota would be or was exceeded. |
| `WorkspaceCleanupError` | `WORKSPACE_CLEANUP_ERROR` | `true` | Cleanup failed after the adapter could not complete deletion. |

`WorkspaceError.meta.reason` values:

- `idempotency_conflict`
- `not_found`
- `aborted`
- `expired`
- `missing_checkpoint`
- `backend_failure`
- `unsupported_operation`
- `invalid_reference`
- `checkpoint_conflict`
- `cleanup_pending`

## 15. Observability

Spans are added to [14-otel-conventions](./14-otel-conventions.md). All six
workspace operations use the `harness.workspace.{operation}` span name (the
`workspace_store.*` prefix is used only for the metric and attribute names
listed below, exactly as spec 14 defines them):

- `harness.workspace.start`
- `harness.workspace.pause`
- `harness.workspace.resume`
- `harness.workspace.abort`
- `harness.workspace.cleanup`
- `harness.workspace.inspect`

Metrics:

- `harness.workspace.operation.duration` histogram, unit `s`
- `harness.workspace.operations` counter, unit `1`
- `harness.workspace.bytes` histogram, unit `By`
- `harness.workspace_store.cleanup.failures` counter, unit `1`
- `harness.workspace_store.quota.exceeded` counter, unit `1`

Allowed span/log/metric attributes:

- `harness.workspace.adapter`
- `harness.workspace.operation`
- `harness.workspace.state`
- `harness.workspace.ref_hash`
- `harness.workspace.checkpoint_ref_hash`
- `harness.workspace.persistent` (boolean; store survives process exit)
- `harness.workspace.attempt` (start/pause/resume)
- `harness.workspace.sequence` (pause only)
- `harness.workflow.step_id` (pause only)
- `harness.workspace_store.checkpoint_ref_hash`
- `harness.workspace_store.cleanup.reason`
- `harness.workspace_store.quota`
- `harness.run.id`
- `harness.session.id`
- `harness.workflow.id`
- `harness.agent.id`
- `error.type`

Reference values are hashed before telemetry emission. Raw workspace, snapshot,
and checkpoint references are allowed in return values and persisted checkpoint
records, not in spans, metrics, or logs.

## 16. Runtime Integration

### Implementation status

The durable building blocks are implemented and contract-tested:

- `inMemoryDurableRuntime()` enforces leases, single-owner checkpoint commits,
  and per-step checkpoint storage.
- `createDurableWorkflowContext(runtime, lease, options?).step(id, fn)` provides
  durable replay: a step committed on a prior attempt returns its stored output
  without re-running `fn()` (verified by `durable-steps.test.ts`).
- `inMemoryDurableWorkspaceStore()` honors idempotency/conflict, abort-blocks-
  resume, idempotent cleanup, typed `WorkspaceError`/`WorkspaceQuotaExceededError`,
  retention/expiry, and workspace-scoped cancellation, all exercised by
  `durableWorkspaceStoreContract`.

These primitives are also wired into the session run loop so that a workflow
invoked with the durable opt-in runs durably end to end (the
F-DW-01..03 acceptance criteria). See §16.1.

### 16.1 Session run-loop auto-wiring (locked)

Durable execution is **opt-in per call** and applies to **workflow runs only**
(`session.workflows[id].prompt(...)` / `.stream(...)`). Direct agent runs
(`session.agents[id]...`) are single model loops and are not checkpointed; an
agent gains durability only when invoked from inside a durable workflow handler
through `ctx.step(...)`.

Opt-in is expressed through a new `InvokeOptions.durable` field:

```ts
interface DurableInvokeOptions {
  /** Stable run id. Resumes/retries of the same logical run MUST reuse this value. */
  runId: string
  /** Worker/process id that owns the run lease. Defaults to the harness worker id. */
  workerId?: string
  /** Initial durable step id label recorded on the lease. Defaults to the workflow id. */
  stepId?: string
  /** Optional attempt hint. The runtime may raise it on retry. */
  attempt?: number
  /**
   * Optional per-run retention, encryption, and quota constraints for the
   * durable workspace created by this invocation. The selected workspace
   * store validates and enforces it; this is never an authority grant.
   */
  workspacePolicy?: Partial<DurableWorkspacePolicy>
}

interface InvokeOptions {
  // ...existing fields...
  durable?: DurableInvokeOptions
}
```

`runId` matches `/^[A-Za-z0-9_.:-]{1,200}$/`; an invalid value throws
`ValidationError{where:'invoke_options'}`.

Locked behavior when `opts.durable` is present on a workflow call:

1. **Runtime required.** The configured `.runtime(...)` adapter MUST be an
   executable `DurableRuntime` (it exposes `startRun`/`commitCheckpoint`/
   `finishRun`/`withSessionLock`). If no runtime is configured, or the configured
   runtime is capability-only, the call throws
   `HarnessConfigError{meta.reason:'durable_runtime_required'}` before any run
   record is created.
2. **Stable run id.** The harness uses `opts.durable.runId` as the run id (instead
   of generating a fresh ULID). The same run id is used for the durable runtime
   lease, the `RunRecord`, persisted events, and the run summary.
3. **Lease acquisition before state mutation.** Inside the session serial lock,
   after the synchronous busy check and before `StateStore.createRun`, the
   harness calls `runtime.startRun({ runId, sessionId, workerId, stepId, input,
   attempt })` and holds the returned lease for the duration of the run.
   `worker id` defaults to a stable per-harness-instance id, overridable through
   `opts.durable.workerId`. After the lease is acquired, `StateStore.createRun`
   must be idempotent for the same durable `runId`; existing terminal run
   records for the same durable run are not overwritten.
4. **Durable step injection.** `ctx.step(stepId, fn, options?)` is bound to
   `createDurableWorkflowContext(runtime, lease, ...)`. Committed steps replay
   from stored output on resume; new steps run `fn` with any short
   `options.retry` policy before checkpoint commit, commit a runtime checkpoint,
   and (when a workspace store is configured) link a durable workspace checkpoint.
5. **Workspace lifecycle (only when `.workspaceStore(...)` is configured).**
   - Fresh run (`lease.resumed === false`): `startWorkspace` with idempotency key
     `${runId}:start`.
   - Resume (`lease.resumed === true`) when the last runtime checkpoint carries a
     `replay.workspaceRef`: `resumeWorkspace` from that workspace/checkpoint ref
     with idempotency key `${runId}:${attempt}:resume`. When no workspace link
     exists, the harness re-`startWorkspace`s with the stable start key (which
     returns the existing workspace).
   - Per new step: `pauseWorkspace({ reason:'step_completed', stepId, sequence,
     attempt })` runs **before** the runtime checkpoint commit (§10 ordering:
     workspace state first, runtime checkpoint second). The returned
     `WorkspaceCheckpoint` is recorded on the runtime checkpoint's
     `replay` (`DurableReplayCheckpoint`).
   - Terminal success: `cleanupWorkspace({ reason:'terminal_success' })` **only**
     when `info.policy.retention.cleanupMode === 'adapter_automatic'`. Under
     `application_scheduled` / `manual_only`, the workspace is left intact for the
     application or a scheduled sweep.
   - Cancellation (`OperationCancelledError`): `abortWorkspace({ reason:'cancelled' })`
     so the run is not silently resumed.
   - Non-cancel failure: the workspace is left paused/resumable so a retry with the
     same `runId` can resume; the harness does not abort or clean it up.
6. **Runtime finalization.** On success the harness calls
   `runtime.finishRun(runId, { status:'succeeded', output })`; on cancellation
   `{ status:'cancelled', error }`; on other failure `{ status:'failed', error }`.
   `finishRun` releases the lease. If the run throws before finalization, the
   lease is released in a `finally` block so a retry can re-acquire it.
7. **Failure preservation.** Durable finalization participates in the same
   failure-terminalization discipline as ordinary runs (spec 10 "Errors"): the
   original handler error is preserved by identity and surfaced to the caller;
   runtime/workspace finalization failures are logged and counted, never masking
   the primary error.

`ctx.step(...)` is **always** present on `WorkflowContext`. Without a durable
invocation (no `opts.durable`, or a workflow run without a configured runtime) it
is a transparent pass-through with no checkpointing. Short `options.retry`
policies still apply, so the same workflow body runs durably or ephemerally
depending only on how it is invoked.

**Cross-process restart.** Within a single process / harness instance, resume is
fully supported: a crashed durable run (lease released mid-flight) re-acquires its
lease on the next `prompt(...)` with the same `runId` and replays committed steps.
Resume across an actual process restart additionally requires a `DurableRuntime`
advertising `runtime.persistent` and a `DurableWorkspaceStore` advertising
`workspace_store.persistent`; the bundled `inMemoryDurableRuntime()` /
`inMemoryDurableWorkspaceStore()` are local/test only and reset on process exit
(§6, §18). The first-party local adapters that satisfy this are specified in
[22-local-durable-execution](./22-local-durable-execution.md).

Durable workflow calls with a workspace store MUST use a sandbox session bound
to the active durable workspace. The existing session-level sandbox is valid for
non-durable calls only. Implementations must acquire the durable lease and
start/resume the workspace before opening the run sandbox, then construct
workflow/agent memory facades against that run sandbox. This rule prevents a
runtime checkpoint from referencing workspace state that the executing sandbox
did not actually use.

### Builder ordering

The builder gains `.workspaceStore(adapter)` in the foundation stage after
`.runtime(...)` and before `.requires(...)`.

Ordering:

```text
defineHarness(opts?)
  .telemetry(...)? .logger(...)? .state(...)? .sandbox(...)? .memory(...)?
  .runtime(...)? .workspaceStore(...)? .requires(...)? .defaults(...)?
  .models(...)
  .tools(...)?
  .skills(...)?
  .agents(...)
  .workflows(...)?
  .build()
```

Rules:

- `.workspaceStore(...)` is callable at most once.
- `.workspaceStore(...)` validates `DurableWorkspaceStoreInfo` synchronously when
  possible and throws `HarnessConfigError` on malformed metadata.
- When no workspace store is configured, the harness has no workspace
  capabilities.
- A workflow or custom handler may use durable runtime checkpoints without a
  workspace store. It cannot claim durable workspace replay without both
  `runtime.workspace_checkpoint` and `workspace_store.durable`.
- Direct applications may require durable workspace behavior with:

```ts
defineHarness()
  .runtime(runtime)
  .workspaceStore(workspace)
  .requires([
    'runtime.persistent',
    'runtime.workspace_checkpoint',
    'workspace_store.durable',
    'workspace_store.persistent',
    'workspace_store.checkpoint',
    'workspace_store.resume',
    'workspace_store.cleanup',
    'workspace_store.retention',
    'workspace_store.encrypted_storage',
    'workspace_store.quota',
  ])
```

## 17. Required Policy

Harness core exposes capability facts. Applications choose required/fallback
policy.

Rules:

- Harness direct users express required durable replay with `.requires(...)`.
- Harness core does not silently fall back from durable replay to fresh
  ephemeral execution.
- Application integrations may expose a `required:false` policy when product
  semantics tolerate losing prior workspace state.
- A resume failure never mutates the failed checkpoint.
- Integration fallback to fresh ephemeral must emit one warning log with
  `harness.warning.code:'WORKSPACE_EPHEMERAL_FALLBACK'`.
- The warning may include service, agent, run, and capability names only. It
  must not include workspace refs, checkpoint refs, file paths, prompts,
  completions, tool IO, credentials, tokens, or raw headers.

## 18. Testing

`@purista/harness/testing` adds:

```ts
export class InMemoryDurableWorkspaceStore implements DurableWorkspaceStore
export function inMemoryDurableWorkspaceStore(): DurableWorkspaceStore
export function durableWorkspaceStoreContract(
  make: () => DurableWorkspaceStore | Promise<DurableWorkspaceStore>,
): void
```

Required contract tests:

1. `startWorkspace` idempotency and conflict behavior.
2. `pauseWorkspace` returns stable `workspaceRef`, `checkpointRef`, and optional
   `snapshotRef`.
3. `resumeWorkspace` opens only committed, non-expired, non-aborted,
   non-cleaned checkpoints.
4. `abortWorkspace` blocks resume and is idempotent.
5. `cleanupWorkspace` is idempotent and reports `cleanup_pending` partial
   deletes with retry metadata.
6. `inspectWorkspace` is read-only and returns policy metadata when the adapter
   advertises inspect, retention, encryption, or quota capabilities.
7. Quota failures throw `WorkspaceQuotaExceededError` and expose no partial
   committed checkpoint except an inspectable orphan marked for cleanup.
8. Cancellation throws `OperationCancelledError{meta.scope:'workspace'}`.
9. Backend failures map to `WorkspaceError` or `WorkspaceCleanupError`.
10. Logs, spans, metrics, and errors exclude file content, checkpoint payload
    content, prompts, completions, credentials, raw refs, and raw paths.

Required integration tests:

- durable workflow success with start, pause, runtime checkpoint commit, resume,
  and cleanup;
- crash after workspace checkpoint before runtime commit;
- crash after runtime commit before caller return;
- missing workspace checkpoint at resume;
- build failure when `.requires(...)` names missing workspace capability;
- `harness.inspect()` reports workspace store id, package, capabilities, and
  policy without opening a workspace.

## 19. Documentation

Harness docs must add a durable workspace page or section covering:

- difference between sandbox snapshot/resume and durable workspace replay;
- adapter capabilities and `.requires(...)`;
- standalone harness setup with durable runtime and workspace stores;
- checkpoint/snapshot consistency rules;
- retention, encryption, cleanup, quota, and fallback policy boundaries;
- test adapter and contract suite usage;
- CloudGrid boundary: product storage and UI stay outside harness core.

## 20. E2E Coverage Matrix

| Flow | Entrypoint | Consumer | Success | Failure/Recovery | Verification |
| --- | --- | --- | --- | --- | --- |
| F-DW-01 standalone durable run | `defineHarness().runtime(...).workspaceStore(...).requires(...).workflows(...)` | Direct harness application | Workflow pauses, runtime checkpoint references workspace checkpoint, resume returns final output, cleanup succeeds | Missing capability fails build; cleanup retry leaves `cleanup_pending` then cleans | Harness integration and contract tests |
| F-DW-02 checkpoint crash | Durable workflow step boundary | Runtime adapter | Orphan workspace checkpoint is inspectable and sweepable when runtime commit fails | Resume ignores orphan; cleanup removes it | Crash matrix test |
| F-DW-03 resume failure | `session.workflows[id].prompt(...)` with checkpointed runtime | Direct harness application | Latest valid checkpoint resumes | Missing/expired/aborted workspace checkpoint throws deterministic `WorkspaceError`; app fallback requires explicit policy | Integration test |
| F-DW-04 policy inspection | `harness.inspect()` | PURISTA/CloudGrid/runtime bootstrap | Effective capabilities and policy metadata are visible without mutation | Unsupported inspect omitted; requiring inspect fails build when absent | API test |
| F-DW-05 privacy | workspace lifecycle operations | Operators and telemetry backends | Logs/spans/metrics show hashed refs and operation state | Content and raw refs never emitted in any content-capture mode | OTel/log snapshot tests |

## 21. Migration And Compatibility

- Existing harness users without `.workspaceStore(...)` are unaffected.
- Existing `sandbox.snapshot`, `sandbox.resume`, and `sandbox.hibernate`
  adapters remain valid low-level sandbox adapters.
- Production durable replay users must add `.workspaceStore(adapter)` and explicit
  `.requires(...)` capabilities.
- Existing runtime checkpoints without workspace fields remain valid and resume
  through the existing `DurableRuntimeAdapter` behavior.
- Release notes must state that sandbox snapshot support is not equivalent to
  production durable workspace replay and that process-restart durability
  requires `runtime.persistent` plus `workspace_store.persistent`.

## 22. Drift Controls

Implementation is incomplete until these commands pass in `ai-harness`:

```bash
npm run test -w @purista/harness
npm run test:types -w @purista/harness
npm run lint -w @purista/harness
```

Implementation must also search for stale durable wording:

```bash
rg "sandbox\\.snapshot.*production|durable replay.*sandbox only|time-travel debugging in v1" specs packages README.md
```

Matches must be either removed or explicitly marked as superseded by this spec.

## 23. Self-Audit

Assumptions:

- The current harness already has `DurableRuntimeAdapter` checkpoint support and
  optional sandbox snapshot/resume/hibernate.
- Durable workspace replay is a generic harness capability required by
  standalone harness users and by PURISTA consumers.
- Product-specific policy values and product storage remain outside harness
  core.

No unresolved decisions remain. Interfaces, types, lifecycle states, failure
semantics, consistency rules, data protection, logging, tracing, metrics,
production boundaries, tests, docs, release notes, and migration behavior are
specified for autonomous implementation.
